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
 *   DETECTED:<phrase>|<conf>     — keyword detected (phrase lowercase, conf 0–1)
 *   ERROR:<msg>                  — fatal error
 *   DEBUG:<msg>                  — diagnostic info
 *
 * Config: read from stdin as a single JSON line then stdin is closed.
 *   { phrases: [{phrase: string, label: string}],
 *     threshold: number,
 *     modelDir: string,
 *     debugMode: boolean }
 *
 * Stop: close stdin or send "stop\n" on stdin.
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

/**
 * Build a path into the model directory that the WASM engines can open.
 *
 * sherpa-onnx is an Emscripten build. Its config validator resolves any path
 * that does not start with '/' against the WASM working directory, so a
 * Windows absolute path like C:\Users\... is never found: createKws() logs
 * "does not exist" / "Errors in config!", still returns a handle, and the
 * unusable spotter then dies with "null function or function signature
 * mismatch" on first use. Forward slashes resolve on every platform, and
 * VS Code's globalStorageUri.fsPath hands us backslashes on Windows.
 */
function modelPath(modelDir, name) {
  return path.join(modelDir, name).replace(/\\/g, '/');
}

function fatal(msg) {
  out('ERROR:' + msg);
  process.exit(1);
}

async function main(config) {
  const { phrases, threshold, modelDir, debugMode } = config;

  if (debugMode) debug('audio-engine starting, modelDir=' + modelDir);

  // Load sentencepiece for BPE tokenisation
  const { SentencePieceProcessor } = require('sentencepiece-js');
  const sherpa = require('sherpa-onnx');
  const { Microphone } = require('decibri');

  // Tokenise each phrase and build a lookup map: DECODED_UPPER → phrase string
  const sp = new SentencePieceProcessor();
  await sp.load(modelPath(modelDir, 'bpe.model'));

  // Build keyword string (one BPE-tokenised phrase per line) and reverse map
  const phraseMap = {}; // "HEY CLAUDE" → "hey claude"
  const keywordLines = [];

  for (const p of phrases) {
    const raw = Array.isArray(p.phrase) ? p.phrase : [p.phrase];
    for (const r of raw) {
      const upper = r.toUpperCase().trim();
      const tokens = sp.encodePieces(upper);
      const tokenStr = tokens.join(' ');
      const decoded = tokens.map(t => t.startsWith('\u2581') ? ' ' + t.slice(1) : t).join('').trim();
      if (decoded) {
        phraseMap[decoded] = r.toLowerCase().trim();
        keywordLines.push(tokenStr);
        if (debugMode) debug('phrase: ' + r + ' -> tokens: ' + tokenStr + ' -> decoded: ' + decoded);
      }
    }
  }

  if (keywordLines.length === 0) {
    fatal('No valid phrases to detect');
    return;
  }

  const keywords = keywordLines.join('\n');

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
      keywordsThreshold: Math.max(0.1, Math.min(0.9, threshold || 0.25)),
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
  if (debugMode) debug('opening microphone...');
  try {
    mic = new Microphone({
      sampleRate: 16000,
      channels: 1,
      vad: 'silero',
      dcRemoval: true,
      highpass: 80,
      agc: -18,
    });
  } catch (err) {
    fatal(micErrorMessage(err, 'Failed to open microphone'));
    return;
  }

  mic.on('error', (err) => {
    fatal(micErrorMessage(err, 'Microphone error'));
  });

  // VAD gating.
  //
  // decibri emits 'data' for a chunk *before* it scores that chunk, so the
  // chunk that trips the detector reaches this handler while `speaking` is
  // still false. Chunks are therefore held in a short pre-roll ring and
  // flushed into the spotter when 'speech' fires. Without the pre-roll the
  // onset of the phrase — the syllable that carries the start of the wake
  // word — never reaches the spotter and detection collapses.
  const PREROLL_CHUNKS = 5; // 5 x 100 ms at decibri's default framesPerBuffer
  const preroll = [];
  let speaking = false;

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
          out('DETECTED:' + phrase + '|1.0');
        } else {
          if (debugMode) debug('Unmatched KWS result: ' + JSON.stringify(result));
        }
        kws.reset(kwsStream);
      }
    }
  }

  mic.on('speech', () => {
    if (stopping) return;
    speaking = true;
    if (debugMode) debug('VAD: speech (' + preroll.length + ' pre-roll chunks)');
    for (const floats of preroll) {
      feed(floats);
    }
    preroll.length = 0;
  });

  mic.on('silence', () => {
    speaking = false;
    preroll.length = 0;
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

    if (!speaking) {
      // Silence: hold the chunk for the pre-roll and skip the decode entirely.
      preroll.push(floats);
      if (preroll.length > PREROLL_CHUNKS) preroll.shift();
      return;
    }

    feed(floats);
  });

  out('READY');
  if (debugMode) debug('mic open, VAD-gated, listening for: ' + Object.values(phraseMap).join(', '));
}

/**
 * Map decibri's typed errors to something a user can act on.
 *
 * decibri 5.x raises DecibriError subclasses (DeviceError, OrtError,
 * OrtPathError) each carrying a stable `code`. Anything unrecognised falls
 * back to the raw message under the caller's prefix.
 */
function micErrorMessage(err, fallbackPrefix) {
  const code = err && err.code;
  const message = (err && err.message) || String(err);

  switch (code) {
    case 'NO_MICROPHONE_FOUND':
    case 'MICROPHONE_NOT_FOUND':
      return 'No microphone found. Check your audio device settings.';
    case 'NOT_AN_INPUT_DEVICE':
      return 'The selected audio device is not a microphone. Check your audio device settings.';
    case 'PERMISSION_DENIED':
      return 'Microphone access denied. Enable microphone access for VS Code in your system privacy settings.';
    case 'DEVICE_FAILED':
      return 'The microphone stopped responding: ' + message;
    case 'ORT_INIT_FAILED':
    case 'ORT_LOAD_FAILED':
    case 'ORT_SESSION_BUILD_FAILED':
    case 'ORT_INFERENCE_FAILED':
    case 'VAD_MODEL_LOAD_FAILED':
      return 'Failed to start voice activity detection: ' + message;
    default:
      return fallbackPrefix + ': ' + message;
  }
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (mic) {
    try { mic.stop(); } catch { /* ignore */ }
    mic = null;
  }
  if (kwsStream) {
    try { kwsStream.free(); } catch { /* ignore */ }
    kwsStream = null;
  }
  if (kws) {
    try { kws.free(); } catch { /* ignore */ }
    kws = null;
  }
  process.exit(0);
}

// Read config from stdin (single JSON line)
let stdinBuf = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  const nl = stdinBuf.indexOf('\n');
  if (nl !== -1) {
    const line = stdinBuf.substring(0, nl).trim();
    stdinBuf = stdinBuf.substring(nl + 1);
    if (line === 'stop') {
      shutdown();
      return;
    }
    if (!line) return;
    let config;
    try {
      config = JSON.parse(line);
    } catch (e) {
      fatal('Invalid config JSON: ' + e.message);
      return;
    }
    main(config).catch((err) => fatal('Startup error: ' + err.message));
  }
});

process.stdin.on('end', () => {
  // stdin closed without a stop command — shut down cleanly
  shutdown();
});

process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
