'use strict';

/**
 * audio-engine.js: child process script for cross-platform wake word detection.
 *
 * Runs under system Node.js (not the Electron runtime) so that native addons
 * load against the correct Node.js ABI.
 *
 * Audio is captured with decibri under Silero VAD: the sherpa-onnx keyword
 * spotter only sees audio while speech is present, so an idle editor does not
 * run the transducer.
 *
 * The process lives across handoffs. The models load once; a pause closes
 * the microphone and a resume reopens it, so listening comes back without
 * reloading anything.
 *
 * Protocol (stdout):
 *   READY                        KWS loaded, mic open, listening
 *   DETECTED:<phrase>            keyword detected (phrase lowercase)
 *   PAUSED                       microphone closed, models still loaded
 *   RELEASED                     microphone closed for good, process exiting
 *   ERROR:<msg>                  fatal error
 *   DEBUG:<msg>                  diagnostic info
 *
 * The keyword spotter applies its own threshold and returns no usable score,
 * so DETECTED carries no confidence value. The parser still accepts the
 * `|<conf>` suffix the Windows engine sends.
 *
 * Config: read from stdin as a single JSON line. stdin then stays open for
 * commands.
 *   { phrases: [{phrase: string, label: string}],
 *     threshold: number,
 *     modelDir: string,
 *     debugMode: boolean,
 *     audioDevice: string }     "" for the system default, otherwise a
 *                               device index or a name substring
 *
 * Commands (stdin, one per line):
 *   pause    close the microphone, keep the models loaded; answered by PAUSED
 *   resume   reopen the microphone; answered by READY
 *   stop     close everything and exit; answered by RELEASED. Closing stdin
 *            does the same.
 *
 * In debug mode each startup phase and each reopen of the microphone is timed
 * as a `DEBUG:Timing: <phase> <n>ms` line.
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
const { buildKeywordSpec } = require('./lib/keywords');
const {
  drainLines,
  parseControlLine,
  clampKeywordThreshold,
  withAudioDevice,
} = require('./lib/control');
const { micErrorMessage } = require('./lib/mic-errors');
const { createSpotter } = require('./lib/spotter');
const { CaptureSession } = require('./lib/capture');

/** The microphone lifecycle, once the models have loaded. See lib/capture.js. */
let session = null;
/** The keyword spotter, once loaded. See lib/spotter.js. */
let spotter = null;
let stopping = false;
/**
 * Whether the microphone should be open. A pause that arrives while the
 * models are still loading clears it, so the microphone is not opened until a
 * resume. The extension only pauses an engine that has said READY, so this
 * is defensive.
 */
let captureWanted = true;

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
    if (typeof Microphone.open !== 'function') {
      throw new Error('decibri did not export Microphone.open');
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
  const timed = (phase, since) => {
    if (debugMode) debug('Timing: ' + phase + ' ' + (Date.now() - since) + 'ms');
  };

  if (debugMode) debug('audio-engine starting, modelDir=' + modelDir);

  // sherpa-onnx instantiates its WASM module as it loads.
  let since = Date.now();
  const { SentencePieceProcessor } = require('sentencepiece-js');
  const sherpa = require('sherpa-onnx');
  const { Microphone } = require('decibri');
  timed('modules-load', since);

  // Load sentencepiece for BPE tokenisation
  since = Date.now();
  const sp = new SentencePieceProcessor();
  await sp.load(modelPath(modelDir, 'bpe.model'));
  timed('bpe-load', since);

  // A stop during the load has already said RELEASED and the process is on
  // its way out. Loading the transducer now would only hold that exit up.
  if (stopping) return;

  // Build keyword string (one BPE-tokenised phrase per line) and reverse map
  // ("HEY CLAUDE" -> "hey claude").
  since = Date.now();
  const spec = buildKeywordSpec(phrases, (text) => sp.encodePieces(text));
  timed('tokenise', since);
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

  // Create KWS instance
  if (debugMode) debug('loading sherpa-onnx KWS model...');
  let kws;
  since = Date.now();
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
      keywords: spec.keywords,
    });
  } catch (err) {
    fatal('Failed to load KWS model: ' + err.message);
    return;
  }
  timed('model-load', since);

  spotter = createSpotter({ kws, phraseMap, send: out, debug: debugMode ? debug : null });

  // Microphone options.
  //
  //   vad: 'silero'   gates the keyword spotter so the ONNX decode loop only
  //                   runs while someone is speaking. The extension listens
  //                   all day; without this the transducer decodes silence.
  //   dcRemoval       strips a constant offset some capture hardware adds.
  //   highpass: 80    removes rumble below the voice band.
  //   agc: -18        drives quiet input up toward a consistent level, which
  //                   is what the KWS threshold is calibrated against.
  //   dtype: float32  delivers the samples the spotter takes, so a chunk is
  //                   read in place rather than converted from Int16. AGC can
  //                   overshoot full scale and float32 does not clamp the way
  //                   int16 did, so lib/samples.js clamps.
  //
  // Conditioning runs dcRemoval -> highpass -> agc on the delivered audio.
  // VAD reads the pre-conditioning signal, so the two are independent.
  //
  // Microphone.open() is decibri's async factory. The constructor loads the
  // Silero model inline and blocks the event loop for the duration; the
  // factory does the same work on the native thread pool and rejects with
  // the same error classes. It runs again on every resume.
  //
  // `device` is added only when wakeWord.audioDevice names one: a device
  // index or a case-insensitive name substring. Absent, decibri opens the
  // system default input. See lib/control.js.
  const micOptions = withAudioDevice(
    {
      sampleRate: 16000,
      channels: 1,
      dtype: 'float32',
      vad: 'silero',
      dcRemoval: true,
      highpass: 80,
      agc: -18,
    },
    audioDevice
  );

  session = new CaptureSession({
    openMicrophone: (options) => Microphone.open(options),
    micOptions,
    spotter,
    send: out,
    fail: (err, prefix) => fatal(micErrorMessage(err, prefix, audioDevice)),
    debug: debugMode ? debug : null,
  });

  if (!captureWanted) {
    if (debugMode) debug('models loaded; paused before the microphone opened, waiting for resume');
    return;
  }

  if (debugMode) {
    debug(
      'opening microphone' +
        (micOptions.device === undefined ? '' : ' (device: ' + JSON.stringify(micOptions.device) + ')') +
        '...'
    );
  }
  await session.start();
  if (debugMode && session.listening) {
    debug('mic open, VAD-gated, listening for: ' + Object.values(phraseMap).join(', '));
  }
}

/** "pause": close the microphone and keep everything else. */
function pauseCapture() {
  if (stopping) return;
  captureWanted = false;
  if (session) {
    session.pause();
  } else {
    // Still loading, so nothing is open. main() leaves the microphone closed.
    out('PAUSED');
  }
}

/** "resume": reopen the microphone. */
function resumeCapture() {
  if (stopping) return;
  captureWanted = true;
  // Still loading: main() opens the microphone once the models are in.
  if (session) {
    session.resume().catch((err) => fatal('Resume error: ' + err.message));
  }
}

function shutdown() {
  if (stopping) return;
  stopping = true;

  // Close the capture device and say so before anything else: the extension
  // waits for RELEASED before it kills this process, rather than killing it
  // and trusting the OS to have reclaimed the device by then.
  if (session) {
    session.stop();
  } else {
    out('RELEASED');
  }

  if (spotter) {
    spotter.free();
    spotter = null;
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

// Read config, then commands, from stdin
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
    switch (control.kind) {
      case 'stop':
        shutdown();
        return;
      case 'pause':
        pauseCapture();
        break;
      case 'resume':
        resumeCapture();
        break;
      case 'empty':
        break;
      case 'invalid':
        fatal(control.message);
        return;
      default:
        main(control.config).catch((err) => fatal('Startup error: ' + err.message));
    }
  }
});

process.stdin.on('end', () => {
  // stdin closed without a stop command: shut down cleanly
  shutdown();
});

process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
