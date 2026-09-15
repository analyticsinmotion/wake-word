import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureSession, OVERRUN_CHECK_MS } from '../../engine/lib/capture.js';

/**
 * The audio engine's microphone lifecycle, driven with a fake decibri
 * Microphone and a fake spotter. Opens are deferred so a test decides when
 * each one completes, which is how the pause and stop that land during
 * Microphone.open() are exercised.
 */

class FakeMic extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.stopped = 0;
    this.overrunCount = 0;
  }

  stop() {
    this.stopped++;
  }

  /** One float32 chunk holding a single sample. */
  chunk(value) {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(value, 0);
    this.emit('data', buf);
  }
}

function harness({ debug = false } = {}) {
  const sent = [];
  const logged = [];
  const failures = [];
  const opens = [];
  const mics = [];
  let clock = 1000;
  const spotter = {
    fed: [],
    segments: 0,
    resets: 0,
    accept(samples) {
      this.fed.push(samples[0]);
    },
    endSegment() {
      this.segments++;
    },
    reset() {
      this.resets++;
    },
  };

  const session = new CaptureSession({
    openMicrophone: (options) =>
      new Promise((resolve, reject) => {
        opens.push({
          options,
          resolve: (elapsed = 0) => {
            clock += elapsed;
            const mic = new FakeMic(mics.length + 1);
            mics.push(mic);
            resolve(mic);
            return mic;
          },
          reject,
        });
      }),
    micOptions: { sampleRate: 16000, dtype: 'float32' },
    spotter,
    send: (line) => sent.push(line),
    fail: (err, prefix) => failures.push(prefix + ': ' + err.message),
    debug: debug ? (msg) => logged.push(msg) : null,
    now: () => clock,
    prerollChunks: 2,
  });

  /** Complete the most recent open and let the session's continuation run. */
  async function completeOpen(elapsed) {
    const mic = opens[opens.length - 1].resolve(elapsed);
    await Promise.resolve();
    await Promise.resolve();
    return mic;
  }

  return { session, sent, logged, failures, opens, mics, spotter, completeOpen };
}

async function listening(h) {
  const started = h.session.start();
  const mic = await h.completeOpen();
  await started;
  return mic;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CaptureSession start', () => {
  it('opens the microphone with the options given and says READY once it is open', async () => {
    const h = harness();
    const started = h.session.start();
    expect(h.opens).toHaveLength(1);
    expect(h.opens[0].options).toEqual({ sampleRate: 16000, dtype: 'float32' });
    expect(h.sent).toEqual([]);
    expect(h.session.listening).toBe(false);

    await h.completeOpen();
    await started;
    expect(h.sent).toEqual(['READY']);
    expect(h.session.listening).toBe(true);
  });

  it('does not open twice or say READY twice when asked again', async () => {
    const h = harness();
    await listening(h);
    await h.session.start();
    await h.session.resume();
    expect(h.opens).toHaveLength(1);
    expect(h.sent).toEqual(['READY']);
  });

  it('reports a failed open and says nothing else', async () => {
    const h = harness();
    const started = h.session.start();
    h.opens[0].reject(new Error('no device'));
    await started;
    expect(h.failures).toEqual(['Failed to open microphone: no device']);
    expect(h.sent).toEqual([]);
    expect(h.session.listening).toBe(false);
  });
});

describe('CaptureSession VAD gating', () => {
  it('holds audio while silent and flushes the pre-roll into the spotter on speech', async () => {
    const h = harness();
    const mic = await listening(h);
    mic.chunk(0.125);
    mic.chunk(0.25);
    mic.chunk(0.375);
    expect(h.spotter.fed).toEqual([]);

    mic.emit('speech');
    // The ring holds two chunks, oldest first; 0.125 was evicted.
    expect(h.spotter.fed).toEqual([0.25, 0.375]);
    mic.chunk(0.5);
    expect(h.spotter.fed).toEqual([0.25, 0.375, 0.5]);
  });

  it('converts and clamps each chunk before the spotter sees it', async () => {
    const h = harness();
    const mic = await listening(h);
    mic.emit('speech');
    mic.chunk(3);
    mic.chunk(-3);
    expect(h.spotter.fed).toEqual([1, -1]);
  });

  it('ends the spotter segment on silence and gates again', async () => {
    const h = harness();
    const mic = await listening(h);
    mic.emit('speech');
    mic.chunk(0.5);
    mic.emit('silence');
    expect(h.spotter.segments).toBe(1);
    mic.chunk(0.75);
    expect(h.spotter.fed).toEqual([0.5]);
  });

  it('logs VAD transitions in debug mode only', async () => {
    const quiet = harness();
    const quietMic = await listening(quiet);
    quietMic.emit('speech');
    quietMic.emit('silence');
    expect(quiet.logged).toEqual([]);

    const h = harness({ debug: true });
    const mic = await listening(h);
    mic.chunk(0.1);
    mic.emit('speech');
    mic.emit('silence');
    expect(h.logged).toContain('VAD: speech (1 pre-roll chunks)');
    expect(h.logged).toContain('VAD: silence');
  });
});

describe('CaptureSession pause and resume', () => {
  it('closes the microphone, resets the spotter, and says PAUSED', async () => {
    const h = harness();
    const mic = await listening(h);
    h.session.pause();
    expect(mic.stopped).toBe(1);
    expect(h.spotter.resets).toBe(1);
    expect(h.sent).toEqual(['READY', 'PAUSED']);
    expect(h.session.listening).toBe(false);
  });

  it('ignores anything the closed microphone still emits', async () => {
    // decibri can flush a tail of 'data', and 'speech' with it, after stop().
    const h = harness();
    const mic = await listening(h);
    mic.emit('speech');
    mic.chunk(0.125);
    h.session.pause();
    mic.chunk(0.875);
    mic.emit('speech');
    mic.emit('silence');
    expect(h.spotter.fed).toEqual([0.125]);
    expect(h.spotter.segments).toBe(0);
  });

  it('ignores an error from the closed microphone without throwing', async () => {
    const h = harness();
    const mic = await listening(h);
    h.session.pause();
    expect(() => mic.emit('error', new Error('late'))).not.toThrow();
    expect(h.failures).toEqual([]);
  });

  it('reopens a new microphone on resume and says READY again', async () => {
    const h = harness();
    await listening(h);
    h.session.pause();
    const resumed = h.session.resume();
    expect(h.opens).toHaveLength(2);
    const mic = await h.completeOpen();
    await resumed;
    expect(h.sent).toEqual(['READY', 'PAUSED', 'READY']);
    expect(mic.id).toBe(2);
    expect(h.session.listening).toBe(true);
  });

  it('starts the new microphone with an empty pre-roll and a closed gate', async () => {
    const h = harness();
    const first = await listening(h);
    first.chunk(0.125);
    first.emit('speech');
    first.chunk(0.25);
    h.session.pause();

    const resumed = h.session.resume();
    const second = await h.completeOpen();
    await resumed;
    second.chunk(0.375);
    expect(h.spotter.fed).toEqual([0.125, 0.25]);
    second.emit('speech');
    expect(h.spotter.fed).toEqual([0.125, 0.25, 0.375]);
  });

  it('survives repeated pause and resume cycles', async () => {
    const h = harness();
    await listening(h);
    for (let i = 0; i < 3; i++) {
      h.session.pause();
      const resumed = h.session.resume();
      await h.completeOpen();
      await resumed;
    }
    expect(h.sent).toEqual(['READY', 'PAUSED', 'READY', 'PAUSED', 'READY', 'PAUSED', 'READY']);
    expect(h.mics.slice(0, 3).map((m) => m.stopped)).toEqual([1, 1, 1]);
    expect(h.mics[3].stopped).toBe(0);
  });

  it('says PAUSED even when nothing is open', () => {
    const h = harness();
    h.session.pause();
    expect(h.sent).toEqual(['PAUSED']);
  });

  it('closes the microphone an in-flight open produces when a pause lands first', async () => {
    const h = harness();
    const started = h.session.start();
    h.session.pause();
    expect(h.sent).toEqual(['PAUSED']);

    const mic = await h.completeOpen();
    await started;
    expect(mic.stopped).toBe(1);
    expect(h.sent).toEqual(['PAUSED']);
    expect(h.session.listening).toBe(false);
  });

  it('keeps the microphone when a pause and a resume both land during one open', async () => {
    const h = harness();
    const started = h.session.start();
    h.session.pause();
    await h.session.resume();
    expect(h.opens).toHaveLength(1);

    const mic = await h.completeOpen();
    await started;
    expect(mic.stopped).toBe(0);
    expect(h.sent).toEqual(['PAUSED', 'READY']);
  });

  it('does not report an open that failed after a pause', async () => {
    const h = harness();
    const started = h.session.start();
    h.session.pause();
    h.opens[0].reject(new Error('gone'));
    await started;
    expect(h.failures).toEqual([]);
  });
});

describe('CaptureSession stop', () => {
  it('closes the microphone and says RELEASED', async () => {
    const h = harness();
    const mic = await listening(h);
    h.session.stop();
    expect(mic.stopped).toBe(1);
    expect(h.sent).toEqual(['READY', 'RELEASED']);
  });

  it('says RELEASED once and ignores every command after it', async () => {
    const h = harness();
    await listening(h);
    h.session.stop();
    h.session.stop();
    h.session.pause();
    await h.session.resume();
    await h.session.start();
    expect(h.sent).toEqual(['READY', 'RELEASED']);
    expect(h.opens).toHaveLength(1);
  });

  it('releases a paused session', async () => {
    const h = harness();
    await listening(h);
    h.session.pause();
    h.session.stop();
    expect(h.sent).toEqual(['READY', 'PAUSED', 'RELEASED']);
  });

  it('closes the microphone an in-flight open produces when a stop lands first', async () => {
    const h = harness();
    const started = h.session.start();
    h.session.stop();
    expect(h.sent).toEqual(['RELEASED']);
    const mic = await h.completeOpen();
    await started;
    expect(mic.stopped).toBe(1);
    expect(h.sent).toEqual(['RELEASED']);
  });

  it('does not report an open that failed after a stop', async () => {
    const h = harness();
    const started = h.session.start();
    h.session.stop();
    h.opens[0].reject(new Error('gone'));
    await started;
    expect(h.failures).toEqual([]);
  });
});

describe('CaptureSession errors', () => {
  it('reports an error from the open microphone', async () => {
    const h = harness();
    const mic = await listening(h);
    mic.emit('error', new Error('device lost'));
    expect(h.failures).toEqual(['Microphone error: device lost']);
  });
});

describe('CaptureSession debug timing and overruns', () => {
  it('times the first open and each reopen', async () => {
    const h = harness({ debug: true });
    const started = h.session.start();
    await h.completeOpen(87);
    await started;
    h.session.pause();
    const resumed = h.session.resume();
    await h.completeOpen(34);
    await resumed;
    expect(h.logged.filter((l) => l.startsWith('Timing:'))).toEqual([
      'Timing: mic-open 87ms',
      'Timing: resume-mic-open 34ms',
    ]);
  });

  it('logs no timing outside debug mode', async () => {
    const h = harness();
    await listening(h);
    expect(h.logged).toEqual([]);
  });

  it('reports a changed overrun count on its check interval', async () => {
    const h = harness({ debug: true });
    const mic = await listening(h);
    vi.advanceTimersByTime(OVERRUN_CHECK_MS);
    expect(h.logged.filter((l) => l.startsWith('overruns'))).toEqual([]);
    mic.overrunCount = 3;
    vi.advanceTimersByTime(OVERRUN_CHECK_MS);
    vi.advanceTimersByTime(OVERRUN_CHECK_MS);
    expect(h.logged.filter((l) => l.startsWith('overruns'))).toEqual(['overruns: 3']);
  });

  it('stops checking a closed microphone', async () => {
    const h = harness({ debug: true });
    const mic = await listening(h);
    h.session.pause();
    expect(vi.getTimerCount()).toBe(0);
    mic.overrunCount = 5;
    vi.advanceTimersByTime(OVERRUN_CHECK_MS * 2);
    expect(h.logged.filter((l) => l.startsWith('overruns'))).toEqual([]);
  });

  it('starts no overrun timer outside debug mode', async () => {
    const h = harness();
    await listening(h);
    expect(vi.getTimerCount()).toBe(0);
  });
});
