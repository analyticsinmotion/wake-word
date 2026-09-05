'use strict';

/**
 * Pure logic for the acoustic benchmark: WAV parsing, fixture naming, the
 * FRR, FAR, and latency arithmetic, and the report. Nothing here loads a
 * model or touches the engine's dependencies, so it is unit tested under
 * vitest the same way engine/lib is. run-benchmark.js is the part that
 * drives sherpa-onnx.
 */

const path = require('path');

/** The keyword spotter's input format. Recordings must match. */
const SAMPLE_RATE = 16000;

/**
 * Samples per chunk fed to the spotter: 100 ms, decibri's default
 * framesPerBuffer, so the spotter sees the same chunking as production.
 */
const CHUNK_SAMPLES = 1600;

/**
 * Phrases of the extension's default routes. extension.ts is TypeScript and
 * cannot be required from a plain Node script; tests/unit/benchmarkConstants
 * keeps this list in step with DEFAULT_ROUTES.
 */
const DEFAULT_PHRASES = ['hey claude', 'hey copilot', 'hey computer'];

/**
 * The model directory the extension downloads, and the files it needs.
 * Mirrors MODEL_NAME and MODEL_FILES in src/sherpaEngine.ts; the same test
 * checks these two against those.
 */
const MODEL_NAME = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
const MODEL_FILES = [
  'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'tokens.txt',
  'bpe.model',
];

/** Editors whose global storage is searched for a downloaded model. */
const EDITOR_DIRS = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium'];

// -- WAV ----------------------------------------------------------------

/**
 * Parse a RIFF/WAVE buffer into Float32 samples in [-1, 1].
 *
 * Walks the chunk list rather than assuming a 44 byte header: recorders
 * commonly write LIST or fact chunks before the data. Only 16-bit PCM is
 * accepted (format tag 1, or WAVE_FORMAT_EXTENSIBLE with 16-bit samples,
 * which some Windows recorders write for plain PCM). Multi-channel audio
 * is averaged down to mono. A final chunk that runs past the end of the
 * file, which a recorder killed mid-write leaves behind, is truncated
 * rather than rejected.
 *
 * @param {Buffer} buf
 * @returns {{ sampleRate: number, channels: number, samples: Float32Array }}
 */
function parseWav(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('parseWav expects a Buffer');
  }
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a RIFF/WAVE file');
  }

  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buf.length);

    if (id === 'fmt ') {
      if (end - start < 16) {
        throw new Error('fmt chunk is too short');
      }
      fmt = {
        format: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bitsPerSample: buf.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(start, end);
    }

    // Chunks are word aligned: an odd-sized chunk is followed by a pad byte.
    offset = start + size + (size % 2);
  }

  if (!fmt) {
    throw new Error('no fmt chunk');
  }
  if (!data) {
    throw new Error('no data chunk');
  }
  if (fmt.format !== 1 && fmt.format !== 0xfffe) {
    throw new Error(`unsupported WAV format tag ${fmt.format}; the benchmark needs 16-bit PCM`);
  }
  if (fmt.bitsPerSample !== 16) {
    throw new Error(`${fmt.bitsPerSample}-bit samples; the benchmark needs 16-bit PCM`);
  }
  if (fmt.channels < 1) {
    throw new Error('fmt chunk reports no channels');
  }

  const frameBytes = 2 * fmt.channels;
  const frames = Math.floor(data.length / frameBytes);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      sum += data.readInt16LE(i * frameBytes + c * 2);
    }
    samples[i] = sum / fmt.channels / 32768;
  }

  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
}

/**
 * Encode mono 16-bit PCM as a WAV buffer with a plain 44 byte header.
 *
 * Accepts Int16 samples as given, or Float32 in [-1, 1], which are clipped
 * and scaled. Used to write the silence fixture and to round-trip parseWav
 * in the tests.
 *
 * @param {Int16Array | Float32Array} samples
 * @param {number} sampleRate
 * @returns {Buffer}
 */
function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  const isFloat = samples instanceof Float32Array;
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i];
    if (isFloat) {
      v = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
    }
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

/**
 * Check a parsed recording against what the spotter expects. Returns a
 * list of problems; an empty list means the file is usable. A stereo file
 * is usable (parseWav averaged it) but is reported so the reader knows the
 * benchmark did not hear what the recorder heard.
 */
function checkFormat(wav) {
  const problems = [];
  if (wav.sampleRate !== SAMPLE_RATE) {
    problems.push(`${wav.sampleRate} Hz; the benchmark needs ${SAMPLE_RATE} Hz`);
  }
  if (wav.samples.length === 0) {
    problems.push('no audio samples');
  }
  return problems;
}

/** Split samples into spotter-sized chunks. The last one may be short. */
function* chunks(samples, size = CHUNK_SAMPLES) {
  for (let i = 0; i < samples.length; i += size) {
    yield samples.subarray(i, Math.min(i + size, samples.length));
  }
}

// -- Fixtures -----------------------------------------------------------

/**
 * The phrase a positive fixture is expected to contain, from its name:
 * `hey-claude-01.wav` is "hey claude". A trailing take number is optional,
 * hyphens and underscores are word separators, and the result is lower
 * case, which is what the extension normalises phrases to.
 */
function expectedPhrase(filename) {
  const base = path.basename(filename).replace(/\.wav$/i, '');
  return base
    .replace(/[-_]\d+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The keyword list to load into the spotter.
 *
 * With an explicit override, exactly that. Otherwise the default routes'
 * phrases plus every phrase a positive fixture names, so a recording of a
 * phrase outside the defaults is still measured. The list is printed in
 * the report because FAR depends on what was loaded.
 */
function resolveKeywords(defaults, fixturePhrases, override) {
  const source = override && override.length > 0 ? override : [...defaults, ...fixturePhrases];
  const seen = new Set();
  const out = [];
  for (const raw of source) {
    const phrase = String(raw == null ? '' : raw)
      .trim()
      .toLowerCase();
    if (phrase.length > 0 && !seen.has(phrase)) {
      seen.add(phrase);
      out.push(phrase);
    }
  }
  return out;
}

// -- Model location -----------------------------------------------------

/**
 * Where the extension may have put the model on this machine: one
 * candidate per editor, under that editor's global storage for this
 * extension. The first candidate holding every model file wins.
 */
function modelDirCandidates({ platform, env, home }) {
  let base;
  if (platform === 'win32') {
    base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support');
  } else {
    base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  }
  return EDITOR_DIRS.map((editor) =>
    path.join(base, editor, 'User', 'globalStorage', 'analytics-in-motion.wake-word', 'sherpa-onnx', MODEL_NAME)
  );
}

/** True when every model file is present under `dir`. */
function hasModelFiles(dir, exists) {
  return MODEL_FILES.every((f) => exists(path.join(dir, f)));
}

// -- Arguments ----------------------------------------------------------

const USAGE = [
  'Usage: node tests/acoustic/run-benchmark.js [options]',
  '',
  '  --model-dir <path>   Model directory. Default: search each editor\'s global storage.',
  '  --threshold <n>      Keyword threshold, 0.1 to 0.9. Default: 0.3.',
  '  --phrases <list>     Comma-separated keyword list. Default: the default routes',
  '                       plus every phrase a positive fixture names.',
  '  --fixtures <dir>     Fixture root with positive/ and negative/. Default: tests/acoustic/fixtures.',
  '  --verbose            Print one line per file.',
  '  --help               This text.',
].join('\n');

/** Parse the command line. Throws on an unknown flag or a missing value. */
function parseArgs(argv) {
  const opts = {
    modelDir: null,
    threshold: null,
    phrases: null,
    fixturesDir: null,
    verbose: false,
    help: false,
  };
  const takeValue = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--model-dir':
        opts.modelDir = takeValue(i, arg);
        i++;
        break;
      case '--threshold': {
        const raw = takeValue(i, arg);
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          throw new Error(`--threshold must be a number, got "${raw}"`);
        }
        opts.threshold = value;
        i++;
        break;
      }
      case '--phrases':
        opts.phrases = takeValue(i, arg)
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        i++;
        break;
      case '--fixtures':
        opts.fixturesDir = takeValue(i, arg);
        i++;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument "${arg}"\n${USAGE}`);
    }
  }
  return opts;
}

// -- Statistics ---------------------------------------------------------

function mean(values) {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Nearest-rank percentile of a list. `p` in [0, 100]. */
function percentile(values, p) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Turn per-file results into the benchmark's numbers.
 *
 * `positives` entries: { file, expected, seconds, detections }
 * `negatives` entries: { file, seconds, detections }
 * Each detection: { phrase, position, phraseEnd } where `position` is the
 * seconds of audio the spotter had consumed when it fired and `phraseEnd`
 * is the spotter's timestamp for the last keyword token, or null.
 *
 * A positive counts as detected when its expected phrase fires at least
 * once; a file where only some other phrase fires is a miss and is also
 * counted under `wrong`. FRR is misses over positives. A negative counts
 * as a false trigger when anything fires; FAR is those files over all
 * negatives, and the per-hour rate is every firing over the audio length.
 * Latency is measured on the first hit of the expected phrase per positive
 * file. Hits that carry a phrase end time contribute `position - phraseEnd`,
 * the delay between the phrase ending and the spotter firing, and the count
 * says how many did. When no hit carries one the report falls back to the
 * position from the start of the clip over every hit, and says so.
 */
function summarize(positives, negatives) {
  const byPhrase = new Map();
  const latencies = [];

  for (const p of positives) {
    const entry = byPhrase.get(p.expected) || { phrase: p.expected, total: 0, detected: 0, wrong: 0 };
    entry.total++;
    const hit = p.detections.find((d) => d.phrase === p.expected);
    if (hit) {
      entry.detected++;
      latencies.push(hit);
    } else if (p.detections.length > 0) {
      entry.wrong++;
    }
    byPhrase.set(p.expected, entry);
  }

  const positive = [...byPhrase.values()]
    .sort((a, b) => a.phrase.localeCompare(b.phrase))
    .map((e) => ({ ...e, frr: e.total === 0 ? null : (e.total - e.detected) / e.total }));
  const totalPositive = positives.length;
  const totalDetected = positive.reduce((n, e) => n + e.detected, 0);

  const negativeSeconds = negatives.reduce((n, f) => n + f.seconds, 0);
  const filesWithFalseTriggers = negatives.filter((f) => f.detections.length > 0).length;
  const falseTriggers = negatives.reduce((n, f) => n + f.detections.length, 0);

  const timed = latencies.filter((d) => typeof d.phraseEnd === 'number' && Number.isFinite(d.phraseEnd));
  const basis = timed.length > 0 ? 'phrase-end' : 'clip-start';
  const values =
    basis === 'phrase-end' ? timed.map((d) => d.position - d.phraseEnd) : latencies.map((d) => d.position);

  return {
    positive,
    positiveTotals: {
      total: totalPositive,
      detected: totalDetected,
      frr: totalPositive === 0 ? null : (totalPositive - totalDetected) / totalPositive,
    },
    negative: {
      files: negatives.length,
      filesWithFalseTriggers,
      falseTriggers,
      seconds: negativeSeconds,
      far: negatives.length === 0 ? null : filesWithFalseTriggers / negatives.length,
      perHour: negativeSeconds === 0 ? null : falseTriggers / (negativeSeconds / 3600),
    },
    latency: {
      count: values.length,
      basis,
      mean: mean(values),
      median: median(values),
      p95: percentile(values, 95),
    },
  };
}

// -- Report -------------------------------------------------------------

function pct(fraction) {
  return fraction === null ? 'n/a' : `${Math.round(fraction * 100)}%`;
}

function secs(value) {
  return value === null ? 'n/a' : `${value.toFixed(2)}s`;
}

/**
 * Render the summary as the lines the script prints.
 *
 * `meta`: { modelName, threshold, keywords, fixturesDir }
 */
function formatReport(summary, meta) {
  const lines = [
    '=== Acoustic Benchmark ===',
    `Model:      ${meta.modelName}`,
    `Threshold:  ${meta.threshold}`,
    `Keywords:   ${meta.keywords.join(', ')}`,
    `Fixtures:   ${meta.fixturesDir}`,
    '',
    'Positive (FRR):',
  ];

  if (summary.positive.length === 0) {
    lines.push('  no positive recordings');
  } else {
    const width = Math.max(...summary.positive.map((e) => e.phrase.length)) + 1;
    for (const e of summary.positive) {
      const wrong = e.wrong > 0 ? `, wrong phrase: ${e.wrong}` : '';
      lines.push(
        `  ${(e.phrase + ':').padEnd(width + 1)} ${e.detected}/${e.total} detected (FRR: ${pct(e.frr)}${wrong})`
      );
    }
    if (summary.positive.length > 1) {
      const t = summary.positiveTotals;
      lines.push(`  ${'all:'.padEnd(width + 1)} ${t.detected}/${t.total} detected (FRR: ${pct(t.frr)})`);
    }
  }

  lines.push('', 'Negative (FAR):');
  const n = summary.negative;
  if (n.files === 0) {
    lines.push('  no negative recordings');
  } else {
    lines.push(`  ${n.filesWithFalseTriggers}/${n.files} files with a false trigger (FAR: ${pct(n.far)})`);
    lines.push(
      `  ${n.falseTriggers} false trigger${n.falseTriggers === 1 ? '' : 's'} in ${n.seconds.toFixed(1)}s of audio` +
        (n.perHour === null ? '' : ` (${n.perHour.toFixed(2)} per hour)`)
    );
  }

  const l = summary.latency;
  const basis = l.basis === 'phrase-end' ? 'from the end of the phrase' : 'from the start of the clip';
  lines.push('', `Latency (${basis}):`);
  if (l.count === 0) {
    lines.push('  no detections to measure');
  } else {
    lines.push(`  Mean: ${secs(l.mean)}  Median: ${secs(l.median)}  P95: ${secs(l.p95)}  (n=${l.count})`);
  }

  return lines;
}

/** One line per file for --verbose. */
function formatFileLine(kind, result) {
  const fired = result.detections.length === 0
    ? 'nothing'
    : result.detections.map((d) => `${d.phrase || `?${d.raw || ''}`}@${d.position.toFixed(2)}s`).join(' ');
  const expected = kind === 'positive' ? ` expected "${result.expected}",` : '';
  return `  [${kind}] ${path.basename(result.file)} (${result.seconds.toFixed(1)}s):${expected} fired ${fired}`;
}

module.exports = {
  SAMPLE_RATE,
  CHUNK_SAMPLES,
  DEFAULT_PHRASES,
  MODEL_NAME,
  MODEL_FILES,
  EDITOR_DIRS,
  USAGE,
  parseWav,
  encodeWav,
  checkFormat,
  chunks,
  expectedPhrase,
  resolveKeywords,
  modelDirCandidates,
  hasModelFiles,
  parseArgs,
  mean,
  median,
  percentile,
  summarize,
  formatReport,
  formatFileLine,
};
