'use strict';

/**
 * Pre-roll ring buffer and VAD gate state machine.
 *
 * decibri emits 'data' for a chunk *before* it scores that chunk, so the chunk
 * that trips the speech detector arrives while the gate is still closed. Chunks
 * are therefore held in a short pre-roll ring and flushed into the keyword
 * spotter when 'speech' fires. Without the pre-roll the onset of the phrase,
 * the syllable that carries the start of the wake word, never reaches the
 * spotter and detection collapses.
 *
 * The gate holds no audio knowledge: a "chunk" is whatever the caller pushes.
 */
class VadGate {
  /**
   * @param {number} maxPrerollChunks how many chunks of lead-in to retain
   */
  constructor(maxPrerollChunks) {
    const max = Number(maxPrerollChunks);
    this.maxPrerollChunks = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
    this._preroll = [];
    this._speaking = false;
  }

  /** True while the VAD reports speech. */
  get speaking() {
    return this._speaking;
  }

  /** How many chunks are currently held as lead-in. */
  get prerollLength() {
    return this._preroll.length;
  }

  /**
   * Accept one captured chunk.
   *
   * @returns {Array} chunks to feed the spotter now, in arrival order.
   *   While speaking that is the chunk itself; while silent it is empty and
   *   the chunk is retained as pre-roll.
   */
  push(chunk) {
    if (this._speaking) {
      return [chunk];
    }
    if (this.maxPrerollChunks > 0) {
      this._preroll.push(chunk);
      if (this._preroll.length > this.maxPrerollChunks) {
        this._preroll.shift();
      }
    }
    return [];
  }

  /**
   * The VAD reported speech.
   *
   * @returns {Array} the retained pre-roll, oldest first. The ring is emptied,
   *   so a second call before any silence returns nothing.
   */
  speechStarted() {
    this._speaking = true;
    const flushed = this._preroll;
    this._preroll = [];
    return flushed;
  }

  /** The VAD reported silence. Any lead-in captured since is discarded. */
  speechEnded() {
    this._speaking = false;
    this._preroll = [];
  }

  /** Return to the initial state. */
  reset() {
    this._speaking = false;
    this._preroll = [];
  }
}

module.exports = { VadGate };
