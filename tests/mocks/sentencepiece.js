'use strict';

/**
 * A stand-in for sentencepiece-js, which the tokeniser worker in
 * src/tokeniser.ts loads in its place during tests/unit/tokeniser.test.ts.
 *
 * What load() does depends on the name of the directory holding the model
 * file it is given, so a test picks a behaviour by picking a directory. The
 * file itself is never read.
 *
 *   hang      never settles, and keeps the worker alive
 *   fail      rejects, naming the file
 *   exit      ends the worker thread with exit code 3
 *   throw     throws from a timer and never settles
 *   hooks     adds the listeners the real package adds to `process`, which
 *             throw, and then loads
 *   garbled   loads, then encodes every text to a number
 *   empty     loads, then encodes every text to no pieces, as the real
 *             package does with a file that is not a model
 *   anything else loads
 *
 * encodePieces() splits on spaces and marks each word boundary.
 */

const path = require('path');

class SentencePieceProcessor {
  load(modelFile) {
    this.mode = path.basename(path.dirname(modelFile));
    switch (this.mode) {
      case 'hang':
        return new Promise(() => {
          setInterval(() => {}, 1000);
        });
      case 'fail':
        return Promise.reject(new Error('cannot read ' + modelFile));
      case 'exit':
        process.exit(3);
        return new Promise(() => {});
      case 'throw':
        setTimeout(() => {
          throw new Error('stray error in the tokeniser');
        }, 0);
        return new Promise(() => {});
      case 'hooks':
        process.on('uncaughtException', (err) => {
          throw err;
        });
        process.on('unhandledRejection', (reason) => {
          throw reason;
        });
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
  }

  encodePieces(text) {
    if (this.mode === 'garbled') {
      return 42;
    }
    if (this.mode === 'empty') {
      return [];
    }
    return text
      .split(' ')
      .filter(Boolean)
      .map((word) => '▁' + word);
  }
}

module.exports = { SentencePieceProcessor };
