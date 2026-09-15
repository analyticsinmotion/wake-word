'use strict';

/**
 * Turn one decibri capture chunk into the Float32Array the keyword spotter
 * takes.
 *
 * The microphone is opened with `dtype: 'float32'`, so a chunk is a Buffer of
 * 32-bit little-endian floats. Every build target is little-endian, so the
 * samples are read in place: a Float32Array over the chunk's own memory, with
 * no Int16 round trip and no allocation per chunk. A view needs the chunk to
 * start on a 4-byte boundary of its ArrayBuffer. decibri hands over a fresh
 * buffer per chunk, so it does; a chunk that does not is copied rather than
 * rejected.
 *
 * Samples are clamped to [-1, 1] in place, and NaN becomes silence. AGC can
 * drive captured samples above full scale. The int16 format clamped them on
 * the way out, and decibri documents that a float32 consumer running without
 * its limiter should clamp its own output.
 *
 * The chunk is modified. The caller owns it: nothing else reads decibri's
 * 'data' events in the engine.
 *
 * @param {Buffer} chunk
 * @returns {Float32Array}
 */
function toSpotterSamples(chunk) {
  const count = Math.floor(chunk.byteLength / 4);
  let samples;
  if (chunk.byteOffset % 4 === 0) {
    samples = new Float32Array(chunk.buffer, chunk.byteOffset, count);
  } else {
    samples = new Float32Array(count);
    new Uint8Array(samples.buffer).set(new Uint8Array(chunk.buffer, chunk.byteOffset, count * 4));
  }

  for (let i = 0; i < count; i++) {
    const s = samples[i];
    if (s > 1) {
      samples[i] = 1;
    } else if (s < -1) {
      samples[i] = -1;
    } else if (s !== s) {
      samples[i] = 0;
    }
  }
  return samples;
}

module.exports = { toSpotterSamples };
