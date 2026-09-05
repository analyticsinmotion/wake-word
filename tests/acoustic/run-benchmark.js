#!/usr/bin/env node
'use strict';

/**
 * Acoustic benchmark: feed WAV recordings through the same sherpa-onnx
 * keyword spotter the extension runs and measure false rejection rate,
 * false acceptance rate, and detection latency. See README.md alongside.
 *
 *   node tests/acoustic/run-benchmark.js [--model-dir <path>] [--threshold <n>]
 *                                        [--phrases <a,b,c>] [--fixtures <dir>] [--verbose]
 *
 * The spotter and its keyword list are built exactly as engine/audio-engine.js
 * builds them, using the engine's own dependencies and lib modules, so the
 * numbers describe the model and threshold that ship. What is not here is
 * the microphone path: no decibri, no VAD gate, no DC removal, high-pass,
 * or AGC. Audio goes straight from the file into the spotter in 100 ms
 * chunks, so this measures the spotter alone.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./lib/benchmark-core');

const engineDir = path.join(__dirname, '..', '..', 'engine');

/** Load one of the engine's dependencies, with a message that says how to fix a missing tree. */
function requireEngineDependency(name) {
  try {
    return require(path.join(engineDir, 'node_modules', name));
  } catch (err) {
    throw new Error(
      `Cannot load ${name} from engine/node_modules (${err.message}). ` +
        'Run "cd engine && npm install" first.'
    );
  }
}

const { modelPath } = require(path.join(engineDir, 'lib', 'model-path'));
const { buildKeywordSpec } = require(path.join(engineDir, 'lib', 'keywords'));
const { clampKeywordThreshold } = require(path.join(engineDir, 'lib', 'control'));

function listWavs(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => /\.wav$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * Find the model: the --model-dir given, otherwise the first editor global
 * storage directory that holds every model file.
 */
function resolveModelDir(explicit) {
  const exists = (p) => fs.existsSync(p);
  if (explicit) {
    if (!core.hasModelFiles(explicit, exists)) {
      throw new Error(
        `--model-dir ${explicit} does not contain the model files (${core.MODEL_FILES.join(', ')}).`
      );
    }
    return explicit;
  }
  const candidates = core.modelDirCandidates({ platform: process.platform, env: process.env, home: os.homedir() });
  const found = candidates.find((dir) => core.hasModelFiles(dir, exists));
  if (!found) {
    throw new Error(
      'No downloaded model found. Looked in:\n' +
        candidates.map((c) => `  ${c}`).join('\n') +
        '\nEither run the extension with wakeWord.engine set to "sherpa" once so it downloads the model, ' +
        'or pass --model-dir <path> pointing at an extracted copy of ' +
        core.MODEL_NAME +
        '.tar.bz2 (the URL is in src/sherpaEngine.ts).'
    );
  }
  return found;
}

function readFixture(file) {
  const wav = core.parseWav(fs.readFileSync(file));
  const problems = core.checkFormat(wav);
  if (problems.length > 0) {
    throw new Error(`${path.basename(file)}: ${problems.join('; ')}`);
  }
  if (wav.channels > 1) {
    console.warn(`  note: ${path.basename(file)} has ${wav.channels} channels, averaged to mono`);
  }
  return wav;
}

/**
 * Build the keyword spotter the way audio-engine.js does: tokenise each
 * phrase with sentencepiece, hand the token lines to sherpa-onnx, and keep
 * the decoded-to-spoken map so a hit can be named.
 */
async function createSpotter(modelDir, keywords, threshold) {
  const { SentencePieceProcessor } = requireEngineDependency('sentencepiece-js');
  const sherpa = requireEngineDependency('sherpa-onnx');

  const sp = new SentencePieceProcessor();
  await sp.load(modelPath(modelDir, 'bpe.model'));

  const spec = buildKeywordSpec(
    keywords.map((phrase) => ({ phrase, label: phrase })),
    (text) => sp.encodePieces(text)
  );
  if (spec.keywordLines.length === 0) {
    throw new Error('No usable keywords');
  }

  const kws = sherpa.createKws({
    featConfig: { samplingRate: core.SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: modelPath(modelDir, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        decoder: modelPath(modelDir, 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        joiner: modelPath(modelDir, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
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
    keywordsThreshold: threshold,
    keywords: spec.keywords,
  });

  return {
    kws,
    phraseMap: spec.phraseMap,
    version: sherpa.version,
    free() {
      try {
        kws.free();
      } catch {
        // already gone
      }
    },
  };
}

/**
 * The spotter's timestamp for the last keyword token, if it gave one.
 *
 * The timestamps are seconds from the start of the stream only until the
 * first reset: after a reset the spotter's clock restarts from roughly the
 * reset point, and the result's `start_time` is always 0, so a hit after a
 * reset has no usable end time and reports null. A positive clip holds one
 * phrase, so its first hit is the normal case.
 */
function phraseEndOf(result, resets) {
  if (resets > 0) {
    return null;
  }
  const stamps = Array.isArray(result.timestamps) ? result.timestamps.filter((t) => Number.isFinite(t)) : [];
  return stamps.length > 0 ? Math.max(...stamps) : null;
}

/**
 * Run one clip through a fresh stream and return every hit with the
 * seconds of audio consumed when it fired.
 */
function runClip(spotter, samples) {
  const { kws, phraseMap } = spotter;
  const stream = kws.createStream();
  const detections = [];
  let consumed = 0;
  let resets = 0;

  const drain = () => {
    while (kws.isReady(stream)) {
      kws.decode(stream);
      const result = kws.getResult(stream);
      if (result.keyword !== '') {
        const decoded = result.keyword.trim();
        detections.push({
          phrase: phraseMap[decoded] || null,
          raw: decoded,
          position: consumed / core.SAMPLE_RATE,
          phraseEnd: phraseEndOf(result, resets),
        });
        // As in the engine: one hit per utterance, then start clean.
        kws.reset(stream);
        resets++;
      }
    }
  };

  for (const chunk of core.chunks(samples)) {
    stream.acceptWaveform(core.SAMPLE_RATE, chunk);
    consumed += chunk.length;
    drain();
  }
  // Let the streaming model decode the tail of the clip.
  stream.inputFinished();
  drain();
  stream.free();

  return detections;
}

async function main() {
  const opts = core.parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(core.USAGE);
    return;
  }

  const fixturesDir = opts.fixturesDir || path.join(__dirname, 'fixtures');
  const positiveFiles = listWavs(path.join(fixturesDir, 'positive'));
  const negativeFiles = listWavs(path.join(fixturesDir, 'negative'));

  if (positiveFiles.length + negativeFiles.length === 0) {
    console.log(`No recordings found under ${fixturesDir}.`);
    console.log('Add .wav files to positive/ and negative/ as described in tests/acoustic/README.md.');
    return;
  }

  // Read everything first so a bad recording fails before the model loads.
  const positives = positiveFiles.map((file) => ({
    file,
    expected: core.expectedPhrase(file),
    wav: readFixture(file),
  }));
  const negatives = negativeFiles.map((file) => ({ file, wav: readFixture(file) }));

  const modelDir = resolveModelDir(opts.modelDir);
  const keywords = core.resolveKeywords(
    core.DEFAULT_PHRASES,
    positives.map((p) => p.expected),
    opts.phrases
  );
  const threshold = clampKeywordThreshold(opts.threshold === null ? 0.3 : opts.threshold);

  console.log(`Loading ${path.basename(modelDir)}...`);
  const spotter = await createSpotter(modelDir, keywords, threshold);
  console.log(`sherpa-onnx ${spotter.version}, ${positives.length} positive, ${negatives.length} negative`);

  const positiveResults = positives.map((p) => ({
    file: p.file,
    expected: p.expected,
    seconds: p.wav.samples.length / core.SAMPLE_RATE,
    detections: runClip(spotter, p.wav.samples),
  }));
  const negativeResults = negatives.map((n) => ({
    file: n.file,
    seconds: n.wav.samples.length / core.SAMPLE_RATE,
    detections: runClip(spotter, n.wav.samples),
  }));
  spotter.free();

  if (opts.verbose) {
    console.log('');
    for (const r of positiveResults) {
      console.log(core.formatFileLine('positive', r));
    }
    for (const r of negativeResults) {
      console.log(core.formatFileLine('negative', r));
    }
  }

  const summary = core.summarize(positiveResults, negativeResults);
  console.log('');
  console.log(
    core
      .formatReport(summary, {
        modelName: path.basename(modelDir),
        threshold,
        keywords,
        fixturesDir: displayPath(fixturesDir),
      })
      .join('\n')
  );
}

/** A path relative to the working directory when it is inside it, otherwise as given. */
function displayPath(dir) {
  const rel = path.relative(process.cwd(), dir);
  if (rel === '') {
    return '.';
  }
  return rel.startsWith('..') || path.isAbsolute(rel) ? dir : rel;
}

main().catch((err) => {
  console.error('Benchmark error:', err.message);
  process.exit(1);
});
