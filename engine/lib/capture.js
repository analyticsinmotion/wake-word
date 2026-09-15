'use strict';

const { VadGate } = require('./vad-gate');
const { toSpotterSamples } = require('./samples');

/** Pre-roll ring size: 5 x 100 ms at decibri's default framesPerBuffer. */
const PREROLL_CHUNKS = 5;

/** How often debug mode checks decibri's overrun counter. */
const OVERRUN_CHECK_MS = 30000;

function stopQuietly(mic) {
  try {
    mic.stop();
  } catch {
    // ignore
  }
}

/**
 * The microphone side of the audio engine: open, pause, resume, and stop,
 * with the VAD gate between capture and the keyword spotter.
 *
 * The process and the spotter outlive a pause. `pause()` closes the
 * microphone, resets the gate and the spotter, and says PAUSED; `resume()`
 * opens a new microphone and says READY; `stop()` closes the microphone for
 * good and says RELEASED, after which the caller frees the spotter and exits.
 *
 * Commands can land while `Microphone.open()` is still in flight. A pause or
 * a stop found no microphone to close and has been acknowledged already, so
 * the microphone that open produces is closed as soon as it arrives instead
 * of being held.
 *
 * Every event handler is bound to the microphone it was attached to and does
 * nothing once that microphone is no longer the current one. decibri can
 * deliver a flushed tail of 'data', and with it 'speech', after `stop()`
 * returns; none of that may reach a spotter that has been reset for the next
 * session. The listeners stay attached, so a late 'error' still has one.
 */
class CaptureSession {
  /**
   * @param {object} options
   * @param {(options: object) => Promise<object>} options.openMicrophone  decibri's Microphone.open
   * @param {object} options.micOptions
   * @param {{accept(samples: Float32Array): void, endSegment(): void, reset(): void}} options.spotter
   * @param {(line: string) => void} options.send  writes one protocol line
   * @param {(err: Error, prefix: string) => void} options.fail  reports a fatal microphone error
   * @param {((msg: string) => void) | null} [options.debug]  debug mode only
   * @param {() => number} [options.now]
   * @param {number} [options.prerollChunks]
   */
  constructor(options) {
    this._openMicrophone = options.openMicrophone;
    this._micOptions = options.micOptions;
    this._spotter = options.spotter;
    this._send = options.send;
    this._fail = options.fail;
    this._debug = options.debug || null;
    this._now = options.now || Date.now;
    this._prerollChunks =
      options.prerollChunks === undefined ? PREROLL_CHUNKS : options.prerollChunks;

    this._mic = null;
    this._gate = null;
    this._overrunTimer = null;
    this._opening = false;
    // Capture is wanted: start() and resume() set it, pause() and stop() clear it.
    this._wanted = false;
    this._stopped = false;
  }

  /** True while a microphone is open and feeding the gate. */
  get listening() {
    return this._mic !== null;
  }

  /** Open the microphone and say READY. */
  start() {
    return this._capture('mic-open');
  }

  /** Reopen the microphone after a pause and say READY. */
  resume() {
    return this._capture('resume-mic-open');
  }

  /**
   * Close the microphone and say PAUSED. The gate and the spotter are reset,
   * so nothing heard before the pause can complete a phrase after it. Says
   * PAUSED even when nothing was open: the acknowledgement is what the
   * extension waits for.
   */
  pause() {
    if (this._stopped) {
      return;
    }
    this._wanted = false;
    this._close();
    this._spotter.reset();
    this._send('PAUSED');
  }

  /** Close the microphone for good and say RELEASED. */
  stop() {
    if (this._stopped) {
      return;
    }
    this._stopped = true;
    this._wanted = false;
    this._close();
    this._send('RELEASED');
  }

  async _capture(label) {
    if (this._stopped) {
      return;
    }
    this._wanted = true;
    // Already open, or an open is in flight that will say READY itself.
    if (this._mic || this._opening) {
      return;
    }

    this._opening = true;
    const began = this._now();
    let mic;
    try {
      mic = await this._openMicrophone(this._micOptions);
    } catch (err) {
      this._opening = false;
      // A pause or stop during the open has been acknowledged, and the next
      // resume tries again; the failure changes nothing now.
      if (this._wanted && !this._stopped) {
        this._fail(err, 'Failed to open microphone');
      }
      return;
    }
    this._opening = false;

    if (!this._wanted || this._stopped) {
      stopQuietly(mic);
      return;
    }

    this._attach(mic);
    if (this._debug) {
      this._debug('Timing: ' + label + ' ' + (this._now() - began) + 'ms');
    }
    this._send('READY');
  }

  _attach(mic) {
    const gate = new VadGate(this._prerollChunks);
    const current = () => this._mic === mic;
    this._mic = mic;
    this._gate = gate;

    mic.on('error', (err) => {
      if (current()) {
        this._fail(err, 'Microphone error');
      }
    });

    // decibri emits 'data' for a chunk *before* it scores that chunk, so the
    // chunk that trips the detector arrives while the gate is still closed.
    // The gate holds it as pre-roll and flushes it here. See lib/vad-gate.js.
    mic.on('speech', () => {
      if (!current()) {
        return;
      }
      if (this._debug) {
        this._debug('VAD: speech (' + gate.prerollLength + ' pre-roll chunks)');
      }
      for (const samples of gate.speechStarted()) {
        this._spotter.accept(samples);
      }
    });

    mic.on('silence', () => {
      if (!current()) {
        return;
      }
      gate.speechEnded();
      if (this._debug) {
        this._debug('VAD: silence');
      }
      this._spotter.endSegment();
    });

    // Required even while gating: decibri only pumps the capture stream, and
    // therefore only produces VAD scores, while a 'data' listener drains it.
    mic.on('data', (chunk) => {
      if (!current()) {
        return;
      }
      // While silent the gate retains the chunk as pre-roll and returns
      // nothing, so the decode is skipped entirely.
      for (const samples of gate.push(toSpotterSamples(chunk))) {
        this._spotter.accept(samples);
      }
    });

    // Debug only: decibri's overrunCount is the number of capture chunks it
    // has dropped because the consumer fell behind, so a rising figure means
    // the decode loop cannot keep up. Reported only when it changes, and
    // unref'd so the timer never holds the process open on its own. Each
    // microphone counts from zero, so each gets its own timer.
    if (this._debug) {
      let reported = 0;
      const timer = setInterval(() => {
        if (!current()) {
          return;
        }
        const count = mic.overrunCount;
        if (count !== reported) {
          this._debug('overruns: ' + count);
          reported = count;
        }
      }, OVERRUN_CHECK_MS);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
      this._overrunTimer = timer;
    }
  }

  _close() {
    const mic = this._mic;
    // Cleared before stop(): anything the microphone emits from here on,
    // including during stop() itself, belongs to a closed session.
    this._mic = null;
    if (this._overrunTimer) {
      clearInterval(this._overrunTimer);
      this._overrunTimer = null;
    }
    if (this._gate) {
      this._gate.reset();
      this._gate = null;
    }
    if (mic) {
      stopQuietly(mic);
    }
  }
}

module.exports = { CaptureSession, PREROLL_CHUNKS, OVERRUN_CHECK_MS };
