import { describe, expect, it } from 'vitest';
import { createSpotter } from '../../engine/lib/spotter.js';

/**
 * A stand-in for the sherpa-onnx keyword spotter. `script` is the keyword
 * each decode step returns, in order ('' for nothing); every accepted chunk
 * makes one decode step ready.
 */
function fakeKws(script = []) {
  const kws = {
    streams: [],
    resets: 0,
    freed: false,
    createStream() {
      const stream = {
        id: kws.streams.length + 1,
        accepted: [],
        pending: 0,
        freed: false,
        acceptWaveform(rate, samples) {
          if (stream.freed) throw new Error('stream used after free');
          stream.accepted.push({ rate, samples });
          stream.pending++;
        },
        free() {
          stream.freed = true;
        },
      };
      kws.streams.push(stream);
      return stream;
    },
    isReady(stream) {
      return stream.pending > 0;
    },
    decode(stream) {
      stream.pending--;
    },
    getResult() {
      return { keyword: script.length > 0 ? script.shift() : '' };
    },
    reset() {
      kws.resets++;
    },
    free() {
      kws.freed = true;
    },
  };
  return kws;
}

function makeSpotter(script, debug = null) {
  const kws = fakeKws(script);
  const sent = [];
  const logged = [];
  const spotter = createSpotter({
    kws,
    phraseMap: { 'HEY CLAUDE': 'hey claude' },
    send: (line) => sent.push(line),
    debug: debug ? (msg) => logged.push(msg) : null,
  });
  return { kws, spotter, sent, logged };
}

describe('createSpotter', () => {
  it('feeds audio to the stream at 16 kHz', () => {
    const { kws, spotter } = makeSpotter();
    const samples = new Float32Array([0.1, 0.2]);
    spotter.accept(samples);
    expect(kws.streams[0].accepted).toEqual([{ rate: 16000, samples }]);
  });

  it('reports a configured keyword as DETECTED with no confidence, then resets', () => {
    const { kws, spotter, sent } = makeSpotter([' HEY CLAUDE ']);
    spotter.accept(new Float32Array(1));
    expect(sent).toEqual(['DETECTED:hey claude']);
    expect(kws.resets).toBe(1);
  });

  it('ignores a keyword that maps to no phrase but still resets', () => {
    const { kws, spotter, sent, logged } = makeSpotter(['HELLO'], true);
    spotter.accept(new Float32Array(1));
    expect(sent).toEqual([]);
    expect(kws.resets).toBe(1);
    expect(logged[0]).toMatch(/^Unmatched KWS result: /);
  });

  it('says nothing when a decode step completes no keyword', () => {
    const { kws, spotter, sent } = makeSpotter(['']);
    spotter.accept(new Float32Array(1));
    expect(sent).toEqual([]);
    expect(kws.resets).toBe(0);
  });

  it('resets the stream at the end of a speech segment', () => {
    const { kws, spotter } = makeSpotter();
    spotter.endSegment();
    expect(kws.resets).toBe(1);
    expect(kws.streams).toHaveLength(1);
  });

  it('replaces the stream on reset so nothing from before a pause is decoded after it', () => {
    const { kws, spotter } = makeSpotter();
    spotter.accept(new Float32Array(1));
    const before = kws.streams[0];
    spotter.reset();
    expect(before.freed).toBe(true);
    expect(kws.streams).toHaveLength(2);
    spotter.accept(new Float32Array(1));
    expect(kws.streams[1].accepted).toHaveLength(1);
    expect(kws.freed).toBe(false);
  });

  it('frees the stream and the spotter once, and ignores audio afterwards', () => {
    const { kws, spotter } = makeSpotter();
    spotter.free();
    spotter.free();
    expect(kws.streams[0].freed).toBe(true);
    expect(kws.freed).toBe(true);
    expect(() => spotter.accept(new Float32Array(1))).not.toThrow();
    expect(() => spotter.endSegment()).not.toThrow();
  });
});
