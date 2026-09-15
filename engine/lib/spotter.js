'use strict';

/**
 * The keyword spotter as the capture path sees it: accept audio, end a speech
 * segment, start over after a pause, and free.
 *
 * `kws` is a sherpa-onnx keyword spotter (createKws). It holds the loaded
 * model and is kept for the life of the process; only its stream, the
 * decoding state for the audio fed so far, is replaced.
 *
 * @param {object} options
 * @param {object} options.kws           sherpa-onnx keyword spotter
 * @param {Object<string, string>} options.phraseMap  decoded keyword -> phrase
 * @param {(line: string) => void} options.send       writes one protocol line
 * @param {((msg: string) => void) | null} [options.debug]  debug mode only
 * @param {number} [options.sampleRate]
 */
function createSpotter({ kws, phraseMap, send, debug = null, sampleRate = 16000 }) {
  let stream = kws.createStream();

  function freeStream() {
    if (stream) {
      try {
        stream.free();
      } catch {
        // already gone
      }
      stream = null;
    }
  }

  return {
    /** Feed one chunk and report every keyword it completes. */
    accept(samples) {
      if (!stream) {
        return;
      }
      stream.acceptWaveform(sampleRate, samples);

      while (kws.isReady(stream)) {
        kws.decode(stream);
        const result = kws.getResult(stream);
        if (result.keyword !== '') {
          const phrase = phraseMap[result.keyword.trim()];
          if (phrase) {
            if (debug) debug('KWS result: ' + JSON.stringify(result));
            // No confidence suffix: the spotter has already applied the
            // threshold and the score it returns is not a usable confidence.
            // Reporting a fixed 1.0 made these lines look like real scores
            // when they never were.
            send('DETECTED:' + phrase);
          } else if (debug) {
            debug('Unmatched KWS result: ' + JSON.stringify(result));
          }
          kws.reset(stream);
        }
      }
    },

    /**
     * The VAD reported silence. Decode each speech segment independently:
     * without the reset the spotter sees the two sides of a gap spliced
     * together and can spot a phrase that was never said in one breath.
     */
    endSegment() {
      if (stream) {
        try {
          kws.reset(stream);
        } catch {
          // ignore
        }
      }
    },

    /**
     * Listening paused. Replace the stream rather than reset it: a reset
     * starts a new hypothesis search but leaves audio the stream has
     * accepted and not yet decoded in place, and that audio would be
     * decoded ahead of whatever is heard after the resume. A fresh stream
     * holds nothing from before the pause. The model stays loaded.
     */
    reset() {
      freeStream();
      stream = kws.createStream();
    },

    /** Release the stream and the spotter. Safe to call more than once. */
    free() {
      freeStream();
      if (kws) {
        try {
          kws.free();
        } catch {
          // ignore
        }
        kws = null;
      }
    },
  };
}

module.exports = { createSpotter };
