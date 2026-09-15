import { describe, expect, it } from 'vitest';
import { toSpotterSamples } from '../../engine/lib/samples.js';

/** A Buffer of float32 little-endian samples, as decibri delivers with dtype 'float32'. */
function float32Chunk(values) {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

/** The same bytes, placed so the Buffer starts one byte into its ArrayBuffer. */
function misaligned(values) {
  const source = float32Chunk(values);
  const backing = new ArrayBuffer(source.length + 1);
  const buf = Buffer.from(backing, 1, source.length);
  source.copy(buf);
  return buf;
}

describe('toSpotterSamples', () => {
  it('reads float32 little-endian bytes as samples', () => {
    const samples = toSpotterSamples(float32Chunk([0, 0.5, -0.25, 1, -1]));
    expect(samples).toBeInstanceOf(Float32Array);
    expect(Array.from(samples)).toEqual([0, 0.5, -0.25, 1, -1]);
  });

  it('reads the chunk in place instead of copying it', () => {
    const chunk = float32Chunk([0.1, 0.2, 0.3]);
    const samples = toSpotterSamples(chunk);
    expect(samples.buffer).toBe(chunk.buffer);
    expect(samples.byteOffset).toBe(chunk.byteOffset);
    expect(samples.length).toBe(3);
  });

  it('copies a chunk that does not start on a 4-byte boundary', () => {
    // new Float32Array(buffer, 1) throws a RangeError; the copy avoids it.
    const chunk = misaligned([0.5, -0.5]);
    expect(chunk.byteOffset % 4).not.toBe(0);
    const samples = toSpotterSamples(chunk);
    expect(Array.from(samples)).toEqual([0.5, -0.5]);
    expect(samples.buffer).not.toBe(chunk.buffer);
  });

  it('clamps samples AGC drove above full scale', () => {
    const samples = toSpotterSamples(float32Chunk([1.5, -2, 1.0000001, -7]));
    expect(Array.from(samples)).toEqual([1, -1, 1, -1]);
  });

  it('clamps a misaligned chunk as well', () => {
    expect(Array.from(toSpotterSamples(misaligned([3, -3, 0.25])))).toEqual([1, -1, 0.25]);
  });

  it('clamps infinities to full scale and turns NaN into silence', () => {
    const samples = toSpotterSamples(float32Chunk([Infinity, -Infinity, NaN]));
    expect(Array.from(samples)).toEqual([1, -1, 0]);
  });

  it('leaves in-range samples exactly as delivered', () => {
    const values = [0.123, -0.999, 0.000001, -0.5];
    const expected = Array.from(new Float32Array(values));
    expect(Array.from(toSpotterSamples(float32Chunk(values)))).toEqual(expected);
  });

  it('ignores a trailing partial sample', () => {
    const chunk = Buffer.concat([float32Chunk([0.5, 0.25]), Buffer.from([1, 2, 3])]);
    expect(Array.from(toSpotterSamples(chunk))).toEqual([0.5, 0.25]);
  });

  it('handles an empty chunk', () => {
    expect(toSpotterSamples(Buffer.alloc(0))).toHaveLength(0);
  });
});
