'use strict';

/**
 * audio-engine.js — child process script for cross-platform wake word detection.
 *
 * Runs under system Node.js (not the Electron runtime) so that native addons
 * load against the correct Node.js ABI.
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
  const Decibri = require('decibri');

  // Tokenise each phrase and build a lookup map: DECODED_UPPER → phrase string
  const sp = new SentencePieceProcessor();
  await sp.load(path.join(modelDir, 'bpe.model'));

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
          encoder: path.join(modelDir, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          decoder: path.join(modelDir, 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          joiner:  path.join(modelDir, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        },
        tokens: path.join(modelDir, 'tokens.txt'),
        provider: 'cpu',
        numThreads: 1,
        modelingUnit: 'bpe',
        bpeVocab: path.join(modelDir, 'bpe.model'),
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

  // Open microphone
  if (debugMode) debug('opening microphone...');
  try {
    mic = new Decibri({ sampleRate: 16000, channels: 1 });
  } catch (err) {
    fatal('Failed to open microphone: ' + err.message);
    return;
  }

  mic.on('error', (err) => {
    fatal('Microphone error: ' + err.message);
  });

  mic.on('data', (chunk) => {
    if (stopping || !kws || !kwsStream) return;

    // chunk is Int16 little-endian PCM — convert to Float32 in [-1, 1]
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
    const floats = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      floats[i] = samples[i] / 32768.0;
    }

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
  });

  out('READY');
  if (debugMode) debug('mic open, listening for: ' + Object.values(phraseMap).join(', '));
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
