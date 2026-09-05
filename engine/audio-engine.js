'use strict';

/**
 * audio-engine.js — child process script for cross-platform wake word detection.
 *
 * Runs under system Node.js (not the Electron runtime) so that native addons
 * load against the correct Node.js ABI.
 *
 * Audio is captured with decibri under Silero VAD: the sherpa-onnx keyword
 * spotter only sees audio while speech is present, so an idle editor does not
 * run the transducer.
 *
 * Protocol (stdout):
 *   READY                        — KWS loaded, mic open, listening
 *   DETECTED:<phrase>             — keyword detected (phrase lowercase)
 *   RELEASED                     — microphone closed, safe to take the device
 *   ERROR:<msg>                  — fatal error
 *   DEBUG:<msg>                  — diagnostic info
 *
 * The keyword spotter applies its own threshold and returns no usable score,
 * so DETECTED carries no confidence value. The parser still accepts the
 * `|<conf>` suffix the Windows engine sends.
 *
 * Config: read from stdin as a single JSON line then stdin is closed.
 *   { phrases: [{phrase: string, label: string}],
 *     threshold: number,
 *     modelDir: string,
 *     debugMode: boolean,
 *     audioDevice: string }     "" for the system default, otherwise a
 *                               device index or a name substring
 *
 * Stop: close stdin or send "stop\n" on stdin.
 *
 * Self-test: `node audio-engine.js --self-test` loads every dependency and
 * exits without opening the microphone. CI runs it on each platform.
 */

// Resolve modules relative to this script's own node_modules,
// not the caller's working directory.
const path = require('path');
const Module = require('module');
const engineDir = path.dirname(__filename);
const _resolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  try {
    return _resolveFilename.call(this, request, parent, isMain, options);
  } catch (e) {
    // Try resolving from engine dir as fallback
    const enginePath = path.join(engineDir, 'node_modules', request);
    try {
      return _resolveFilename.call(this, enginePath, parent, isMain, options);
    } catch {
      // ignore, rethrow original
    }
    throw e;
  }
};

// Prepend engine/node_modules to search path
require.main.paths.unshift(path.join(engineDir, 'node_modules'));

// Pure logic lives in ./lib so it can be unit tested without a microphone.
// These are relative requires and so bypass the resolver hook above.
const { modelPath } = require('./lib/model-path');
const { VadGate } = require('./lib/vad-gate');
const { buildKeywordSpec } = require('./lib/keywords');
const {
  drainLines,
  parseControlLine,
  clampKeywordThreshold,
  withAudioDevice,
} = require('./lib/control');
const { micErrorMessage } = require('./lib/mic-errors');

let mic = null;
let kws = null;
let kwsStream = null;
let stopping = false;

function out(msg) {
  process.stdout.write(msg + '\n');
}

function debug(msg) {
  out('DEBUG:' + msg);
}

function fatal(msg) {
  out('ERROR:' + msg);
  process.exit(1);
}

/**
 * Exit once stdout has actually flushed.
 *
 * process.stdout is an asynchronous pipe on POSIX, so process.exit() straight
 * after a write can truncate it. Both RELEASED and the self-test result are
 * read by something on the other end of that pipe, so neither may be lost.
 * The timer is the backstop for a pipe that never drains.
 */
function exitWhenFlushed(code) {
  let exited = false;
  const finish = () => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  try {
    process.stdout.write('', finish);
  } catch {
    finish();
    return;
  }
  setTimeout(finish, 2000);
}

/**
 * Load every dependency the engine needs and report what resolved.
 *
 * The extension ships engine/node_modules to users, and a break there does not
 * show up in the source tree: v0.4.0 shipped a MODULE_NOT_FOUND and v0.5.0 a
 * dead engine dependency. CI runs this on every platform so a missing module
 * or a native ABI mismatch fails the build instead of the install.
 */
function runSelfTest() {
  try {
    const { Microphone } = require('decibri');
    const sherpa = require('sherpa-onnx');
    const { SentencePieceProcessor } = require('sentencepiece-js');

    if (typeof Microphone !== 'function') {
      throw new Error('decibri did not export a Microphone constructor');
    }
    if (typeof sherpa.createKws !== 'function') {
      throw new Error('sherpa-onnx did not export createKws');
    }
    if (typeof SentencePieceProcessor !== 'function') {
      throw new Error('sentencepiece-js did not export a SentencePieceProcessor constructor');
    }

    out('SELF-TEST:OK');
    out('SELF-TEST:platform=' + process.platform + '-' + process.arch);
    out('SELF-TEST:node=' + process.versions.node + ' abi=' + process.versions.modules);
    out('SELF-TEST:decibri=loaded');
    out('SELF-TEST:sherpa-onnx=loaded');
    out('SELF-TEST:sentencepiece-js=loaded');
    exitWhenFlushed(0);
  } catch (err) {
    out('SELF-TEST:FAIL:' + err.message);
    exitWhenFlushed(1);
  }
}

async function main(config) {
  const { phrases, threshold, modelDir, debugMode, audioDevice } = config;

  if (debugMode) debug('audio-engine starting, modelDir=' + modelDir);

  // Load sentencepiece for BPE tokenisation
  const { SentencePieceProcessor } = require('sentencepiece-js');
  const sherpa = require('sherpa-onnx');
  const { Microphone } = require('decibri');

  // Tokenise each phrase and build a lookup map: DECODED_UPPER → phrase string
  const sp = new SentencePieceProcessor();
  await sp.load(modelPath(modelDir, 'bpe.model'));

  // Build keyword string (one BPE-tokenised phrase per line) and reverse map
  // ("HEY CLAUDE" -> "hey claude").
  const spec = buildKeywordSpec(phrases, (text) => sp.encodePieces(text));
  const phraseMap = spec.phraseMap;

  if (debugMode) {
    for (const d of spec.details) {
      debug('phrase: ' + d.phrase + ' -> tokens: ' + d.tokens + ' -> decoded: ' + d.decoded);
    }
  }

  if (spec.keywordLines.length === 0) {
    fatal('No valid phrases to detect');
    return;
  }

  const keywords = spec.keywords;

  // Create KWS instance
  if (debugMode) debug('loading sherpa-onnx KWS model...');
  try {
    kws = sherpa.createKws({
      featConfig: { samplingRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: modelPath(modelDir, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          decoder: modelPath(modelDir, 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          joiner:  modelPath(modelDir, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        },
        tokens: modelPath(modelDir, 'tokens.txt'),
        provider: 'cpu',
        numThreads: 1,
        modelingUnit: 'bpe',
        bpeVocab: modelPath(modelDir, 'bpe.model'),
        debug: 0,
      },
      maxActivePaths: 4,
      numTrailingBlanks: 1,
      keywordsScore: 1.0,
      keywordsThreshold: clampKeywordThreshold(threshold),
      keywords,
    });
  } catch (err) {
    fatal('Failed to load KWS model: ' + err.message);
    return;
  }

  kwsStream = kws.createStream();

  // Open microphone.
  //
  //   vad: 'silero'  — gates the keyword spotter so the ONNX decode loop only
  //                    runs while someone is speaking. The extension listens
  //                    all day; without this the transducer decodes silence.
  //   dcRemoval      — strips a constant offset some capture hardware adds.
  //   highpass: 80   — removes rumble below the voice band.
  //   agc: -18       — drives quiet input up toward a consistent level, which
  //                    is what the KWS threshold is calibrated against.
  //
  // Conditioning runs dcRemoval -> highpass -> agc on the delivered audio.
  // VAD reads the pre-conditioning signal, so the two are independent.
  //
  // Microphone.open() is decibri's async factory. The constructor loads the
  // Silero model inline and blocks the event loop for the duration; the
  // factory does the same work on the native thread pool and rejects with
  // the same error classes, so the catch below is unchanged.
  //
  // `device` is added only when wakeWord.audioDevice names one: a device
  // index or a case-insensitive name substring. Absent, decibri opens the
  // system default input. See lib/control.js.
  const micOptions = withAudioDevice(
    {
      sampleRate: 16000,
      channels: 1,
      vad: 'silero',
      dcRemoval: true,
      highpass: 80,
      agc: -18,
    },
    audioDevice
  );
  if (debugMode) {
    debug(
      'opening microphone' +
        (micOptions.device === undefined ? '' : ' (device: ' + JSON.stringify(micOptions.device) + ')') +
        '...'
    );
  }
  try {
    mic = await Microphone.open(micOptions);
  } catch (err) {
    fatal(micErrorMessage(err, 'Failed to open microphone', audioDevice));
    return;
  }

  // A stop that arrived while the open was in flight found no microphone to
  // close and has already sent RELEASED. Close this one now rather than hold
  // the device until the process exits.
  if (stopping) {
    try { mic.stop(); } catch { /* ignore */ }
    mic = null;
    return;
  }

  mic.on('error', (err) => {
    fatal(micErrorMessage(err, 'Microphone error', audioDevice));
  });

  // VAD gating.
  //
  // decibri emits 'data' for a chunk *before* it scores that chunk, so the
  // chunk that trips the detector reaches this handler while the gate is still
  // closed. Chunks are therefore held in a short pre-roll ring and flushed
  // into the spotter when 'speech' fires. Without the pre-roll the onset of
  // the phrase, the syllable that carries the start of the wake word, never
  // reaches the spotter and detection collapses. See lib/vad-gate.js.
  const PREROLL_CHUNKS = 5; // 5 x 100 ms at decibri's default framesPerBuffer
  const gate = new VadGate(PREROLL_CHUNKS);

  // Push one Float32 chunk into the spotter and drain whatever it enables.
  function feed(floats) {
    if (stopping || !kws || !kwsStream) return;

    kwsStream.acceptWaveform(16000, floats);

    while (kws.isReady(kwsStream)) {
      kws.decode(kwsStream);
      const result = kws.getResult(kwsStream);
      if (result.keyword !== '') {
        const decodedKey = result.keyword.trim();
        const phrase = phraseMap[decodedKey];
        if (phrase) {
          if (debugMode) debug('KWS result: ' + JSON.stringify(result));
          // No confidence suffix: the spotter has already applied the
          // threshold and the score it returns is not a usable confidence.
          // Reporting a fixed 1.0 made these lines look comparable to the
          // Windows engine's real scores when they never were.
          out('DETECTED:' + phrase);
        } else {
          if (debugMode) debug('Unmatched KWS result: ' + JSON.stringify(result));
        }
        kws.reset(kwsStream);
      }
    }
  }

  mic.on('speech', () => {
    if (stopping) return;
    const held = gate.prerollLength;
    if (debugMode) debug('VAD: speech (' + held + ' pre-roll chunks)');
    for (const floats of gate.speechStarted()) {
      feed(floats);
    }
  });

  mic.on('silence', () => {
    gate.speechEnded();
    if (debugMode) debug('VAD: silence');
    // Decode each speech segment independently. Without the reset the spotter
    // sees the two sides of a gap spliced together and can spot a phrase that
    // was never said in one breath.
    if (!stopping && kws && kwsStream) {
      try { kws.reset(kwsStream); } catch { /* ignore */ }
    }
  });

  // Required even while gating: decibri only pumps the capture stream — and
  // therefore only produces VAD scores — while a 'data' listener drains it.
  mic.on('data', (chunk) => {
    if (stopping || !kws || !kwsStream) return;

    // chunk is Int16 little-endian PCM — convert to Float32 in [-1, 1]
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
    const floats = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      floats[i] = samples[i] / 32768.0;
    }

    // While silent the gate retains the chunk as pre-roll and returns nothing,
    // so the decode is skipped entirely.
    for (const ready of gate.push(floats)) {
      feed(ready);
    }
  });

  // Debug only: decibri's overrunCount is the number of capture chunks it has
  // dropped because the consumer fell behind the stream, so a rising figure
  // means the decode loop cannot keep up with the microphone. Reported only
  // when it changes, so a session with no overruns produces no output, and
  // unref'd so the timer never holds the process open on its own.
  if (debugMode) {
    let reported = 0;
    setInterval(() => {
      if (stopping || !mic) return;
      const count = mic.overrunCount;
      if (count !== reported) {
        debug('overruns: ' + count);
        reported = count;
      }
    }, 30000).unref();
  }

  out('READY');
  if (debugMode) debug('mic open, VAD-gated, listening for: ' + Object.values(phraseMap).join(', '));
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (mic) {
    try { mic.stop(); } catch { /* ignore */ }
    mic = null;
  }

  // The capture device is closed. Say so before doing anything else: the
  // extension waits for RELEASED before firing the command that takes the
  // microphone over, rather than killing this process and trusting the OS to
  // have reclaimed the device by then.
  out('RELEASED');

  if (kwsStream) {
    try { kwsStream.free(); } catch { /* ignore */ }
    kwsStream = null;
  }
  if (kws) {
    try { kws.free(); } catch { /* ignore */ }
    kws = null;
  }
  exitWhenFlushed(0);
}

// --self-test loads the dependency tree and exits. It must run before the
// stdin wiring below, which would otherwise hold the process open waiting for
// a config line that CI never sends.
if (process.argv.includes('--self-test')) {
  runSelfTest();
  return;
}

// Read config from stdin (single JSON line)
let stdinBuf = '';
process.stdin.setEncoding('utf8');

// Node delivers stdin in chunks, not lines, so every complete line in the
// chunk has to be handled. Taking only the first line dropped the rest: a
// "stop" that arrived behind another line was never seen and the child kept
// running with the microphone open.
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  const drained = drainLines(stdinBuf);
  stdinBuf = drained.rest;

  for (const line of drained.lines) {
    const control = parseControlLine(line);
    if (control.kind === 'stop') {
      shutdown();
      return;
    }
    if (control.kind === 'empty') {
      continue;
    }
    if (control.kind === 'invalid') {
      fatal(control.message);
      return;
    }
    main(control.config).catch((err) => fatal('Startup error: ' + err.message));
  }
});

process.stdin.on('end', () => {
  // stdin closed without a stop command — shut down cleanly
  shutdown();
});

process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
