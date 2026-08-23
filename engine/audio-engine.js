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

// Pure logic lives in ./lib so it can be unit tested without a microphone.
// These are relative requires and so bypass the resolver hook above.
const { modelPath } = require('./lib/model-path');
const { VadGate } = require('./lib/vad-gate');
const { buildKeywordSpec } = require('./lib/keywords');
const { drainLines, parseControlLine, clampKeywordThreshold } = require('./lib/control');
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
