import { describe, expect, it } from 'vitest';
import { VadGate } from '../../engine/lib/vad-gate.js';

/**
 * decibri emits 'data' for a chunk before it scores that chunk, so the chunk
 * that trips the speech detector arrives while the gate is still closed. If
 * that lead-in is dropped, the onset of the wake phrase never reaches the
 * keyword spotter and detection collapses. These tests pin the ordering and
 * the ring size.
 */
describe('VadGate pre-roll ring', () => {
  it('starts closed and empty', () => {
    const gate = new VadGate(5);
    expect(gate.speaking).toBe(false);
    expect(gate.prerollLength).toBe(0);
  });

  it('holds chunks instead of feeding them while silent', () => {
    const gate = new VadGate(5);
    expect(gate.push('a')).toEqual([]);
    expect(gate.push('b')).toEqual([]);
    expect(gate.prerollLength).toBe(2);
  });

  it('holds at most N chunks', () => {
    const gate = new VadGate(5);
    for (const c of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      gate.push(c);
    }
    expect(gate.prerollLength).toBe(5);
  });

  it('drops the oldest chunk once the ring is full', () => {
    const gate = new VadGate(3);
    ['a', 'b', 'c', 'd'].forEach((c) => gate.push(c));
    expect(gate.speechStarted()).toEqual(['b', 'c', 'd']);
  });

  it('flushes the pre-roll in arrival order', () => {
    const gate = new VadGate(5);
    ['a', 'b', 'c'].forEach((c) => gate.push(c));
    expect(gate.speechStarted()).toEqual(['a', 'b', 'c']);
  });

  it('empties the ring on flush', () => {
    const gate = new VadGate(5);
    ['a', 'b'].forEach((c) => gate.push(c));
    gate.speechStarted();
    expect(gate.prerollLength).toBe(0);
    expect(gate.speechStarted()).toEqual([]);
  });

  it('feeds chunks straight through once speaking', () => {
    const gate = new VadGate(5);
    gate.speechStarted();
    expect(gate.push('x')).toEqual(['x']);
    expect(gate.push('y')).toEqual(['y']);
    expect(gate.prerollLength).toBe(0);
  });

  it('discards the pre-roll on silence', () => {
    const gate = new VadGate(5);
    ['a', 'b'].forEach((c) => gate.push(c));
    gate.speechEnded();
    expect(gate.prerollLength).toBe(0);
    expect(gate.speaking).toBe(false);
  });

  it('buffers again after silence', () => {
    const gate = new VadGate(5);
    gate.speechStarted();
    gate.speechEnded();
    expect(gate.push('a')).toEqual([]);
    expect(gate.prerollLength).toBe(1);
  });

  it('survives repeated speech and silence cycles', () => {
    const gate = new VadGate(2);
    const fed = [];
    const drive = (events) => {
      for (const e of events) {
        if (e === 'speech') {
          fed.push(...gate.speechStarted());
        } else if (e === 'silence') {
          gate.speechEnded();
        } else {
          fed.push(...gate.push(e));
        }
      }
    };

    // Two utterances separated by silence, each with lead-in chunks that the
    // VAD only scores after they have been delivered.
    drive(['s1', 's2', 'speech', 'w1', 'w2', 'silence']);
    drive(['q1', 'q2', 'q3', 'speech', 'w3', 'silence']);

    // The second utterance had three chunks of lead-in, so the 2-chunk ring
    // evicted 'q1'. Everything else reaches the spotter in arrival order.
    expect(fed).toEqual(['s1', 's2', 'w1', 'w2', 'q2', 'q3', 'w3']);
  });

  it('delivers the chunk that tripped the detector before anything captured later', () => {
    // This is the ordering the pre-roll exists for: the onset chunk was
    // already handed to the data handler before 'speech' fired.
    const gate = new VadGate(5);
    const fed = [];
    fed.push(...gate.push('onset'));
    fed.push(...gate.speechStarted());
    fed.push(...gate.push('rest'));
    expect(fed).toEqual(['onset', 'rest']);
  });

  it('never feeds a chunk twice', () => {
    const gate = new VadGate(5);
    const fed = [];
    fed.push(...gate.push('a'));
    fed.push(...gate.speechStarted());
    fed.push(...gate.speechStarted());
    fed.push(...gate.push('b'));
    expect(fed).toEqual(['a', 'b']);
  });

  it('preserves chunk identity, not a copy', () => {
    const gate = new VadGate(5);
    const chunk = new Float32Array([0.1, 0.2]);
    gate.push(chunk);
    expect(gate.speechStarted()[0]).toBe(chunk);
  });

  it('treats a zero or invalid ring size as no pre-roll', () => {
    for (const size of [0, -1, NaN, undefined, null, 'five']) {
      const gate = new VadGate(size);
      expect(gate.push('a')).toEqual([]);
      expect(gate.prerollLength).toBe(0);
      expect(gate.speechStarted()).toEqual([]);
    }
  });

  it('resets to the initial state', () => {
    const gate = new VadGate(5);
    gate.push('a');
    gate.speechStarted();
    gate.push('b');
    gate.reset();
    expect(gate.speaking).toBe(false);
    expect(gate.prerollLength).toBe(0);
  });
});
