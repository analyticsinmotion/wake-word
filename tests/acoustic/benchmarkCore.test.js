import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  CHUNK_SAMPLES,
  DEFAULT_PHRASES,
  MODEL_FILES,
  SAMPLE_RATE,
  checkFormat,
  chunks,
  encodeWav,
  expectedPhrase,
  formatFileLine,
  formatReport,
  hasModelFiles,
  median,
  modelDirCandidates,
  parseArgs,
  parseWav,
  percentile,
  resolveKeywords,
  summarize,
} from './lib/benchmark-core.js';

/** A one second ramp so sample order is checkable after a round trip. */
function ramp(n = SAMPLE_RATE) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = ((i % 200) - 100) * 100;
  }
  return out;
}

describe('encodeWav and parseWav', () => {
  it('round-trips 16-bit mono PCM', () => {
    const wav = parseWav(encodeWav(ramp(), SAMPLE_RATE));
    expect(wav.sampleRate).toBe(SAMPLE_RATE);
    expect(wav.channels).toBe(1);
    expect(wav.samples).toHaveLength(SAMPLE_RATE);
    expect(wav.samples[0]).toBeCloseTo(-10000 / 32768, 6);
    expect(wav.samples[100]).toBe(0);
  });

  it('writes a plain 44 byte header', () => {
    const buf = encodeWav(new Int16Array(10), 16000);
    expect(buf).toHaveLength(44 + 20);
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.readUInt32LE(4)).toBe(36 + 20);
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buf.readUInt16LE(20)).toBe(1);
    expect(buf.readUInt16LE(22)).toBe(1);
    expect(buf.readUInt32LE(24)).toBe(16000);
    expect(buf.readUInt32LE(28)).toBe(32000);
    expect(buf.readUInt16LE(32)).toBe(2);
    expect(buf.readUInt16LE(34)).toBe(16);
    expect(buf.toString('ascii', 36, 40)).toBe('data');
    expect(buf.readUInt32LE(40)).toBe(20);
  });

  it('scales and clips Float32 input', () => {
    const wav = parseWav(encodeWav(new Float32Array([0, 0.5, 1, -1, 2, -2]), SAMPLE_RATE));
    expect(wav.samples[0]).toBe(0);
    expect(wav.samples[1]).toBeCloseTo(0.5, 3);
    expect(wav.samples[2]).toBeCloseTo(1, 3);
    expect(wav.samples[3]).toBeCloseTo(-1, 3);
    expect(wav.samples[4]).toBeCloseTo(1, 3);
    expect(wav.samples[5]).toBeCloseTo(-1, 3);
  });

  it('encodes ten seconds of silence as all zeros', () => {
    const wav = parseWav(encodeWav(new Int16Array(SAMPLE_RATE * 10), SAMPLE_RATE));
    expect(wav.samples).toHaveLength(SAMPLE_RATE * 10);
    expect(wav.samples.every((s) => s === 0)).toBe(true);
  });

  it('skips chunks before the data chunk, including odd-sized ones', () => {
    // RIFF, fmt, a 5 byte LIST chunk (so a pad byte follows), then data.
    const pcm = encodeWav(new Int16Array([1000, -1000]), SAMPLE_RATE);
    const fmtChunk = pcm.subarray(12, 36);
    const dataChunk = pcm.subarray(36);
    const list = Buffer.alloc(8 + 5 + 1);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(5, 4);
    list.write('abcde', 8, 'ascii');
    const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmtChunk, list, dataChunk]);
    const header = Buffer.alloc(8);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(body.length, 4);
    const wav = parseWav(Buffer.concat([header, body]));
    expect(Array.from(wav.samples).map((s) => Math.round(s * 32768))).toEqual([1000, -1000]);
  });

  it('averages stereo down to mono', () => {
    const buf = encodeWav(new Int16Array([1000, 3000, -2000, 2000]), SAMPLE_RATE);
    buf.writeUInt16LE(2, 22); // channels
    buf.writeUInt32LE(SAMPLE_RATE * 4, 28);
    buf.writeUInt16LE(4, 32);
    const wav = parseWav(buf);
    expect(wav.channels).toBe(2);
    expect(Array.from(wav.samples).map((s) => Math.round(s * 32768))).toEqual([2000, 0]);
  });

  it('accepts WAVE_FORMAT_EXTENSIBLE with 16-bit samples', () => {
    const buf = encodeWav(new Int16Array([123]), SAMPLE_RATE);
    buf.writeUInt16LE(0xfffe, 20);
    expect(parseWav(buf).samples).toHaveLength(1);
  });

  it('truncates a data chunk that runs past the end of the file', () => {
    const buf = encodeWav(new Int16Array([1, 2, 3, 4]), SAMPLE_RATE);
    buf.writeUInt32LE(1000, 40);
    expect(parseWav(buf).samples).toHaveLength(4);
  });

  it('rejects files that are not RIFF/WAVE', () => {
    expect(() => parseWav(Buffer.from('not a wav file at all'))).toThrow(/not a RIFF\/WAVE/);
    expect(() => parseWav(Buffer.alloc(4))).toThrow(/not a RIFF\/WAVE/);
  });

  it('rejects sample widths other than 16 bits', () => {
    const buf = encodeWav(new Int16Array([1]), SAMPLE_RATE);
    buf.writeUInt16LE(8, 34);
    expect(() => parseWav(buf)).toThrow(/8-bit samples/);
  });

  it('rejects compressed formats', () => {
    const buf = encodeWav(new Int16Array([1]), SAMPLE_RATE);
    buf.writeUInt16LE(3, 20); // IEEE float
    expect(() => parseWav(buf)).toThrow(/format tag 3/);
  });

  it('rejects a file with no data chunk', () => {
    const buf = encodeWav(new Int16Array([1]), SAMPLE_RATE).subarray(0, 36);
    expect(() => parseWav(buf)).toThrow(/no data chunk/);
  });

  it('rejects a non-Buffer', () => {
    expect(() => parseWav('RIFF....WAVE')).toThrow(TypeError);
  });
});

describe('checkFormat', () => {
  it('passes a 16 kHz clip', () => {
    expect(checkFormat(parseWav(encodeWav(ramp(), SAMPLE_RATE)))).toEqual([]);
  });

  it('names the sample rate when it is wrong', () => {
    const problems = checkFormat(parseWav(encodeWav(ramp(), 44100)));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/44100 Hz; the benchmark needs 16000 Hz/);
  });

  it('reports an empty clip', () => {
    expect(checkFormat(parseWav(encodeWav(new Int16Array(0), SAMPLE_RATE)))).toEqual(['no audio samples']);
  });
});

describe('chunks', () => {
  it('yields 100 ms chunks and a short tail', () => {
    const samples = new Float32Array(CHUNK_SAMPLES * 2 + 7);
    const sizes = [...chunks(samples)].map((c) => c.length);
    expect(CHUNK_SAMPLES).toBe(1600);
    expect(sizes).toEqual([1600, 1600, 7]);
  });

  it('yields views over the original samples', () => {
    const samples = new Float32Array(10).fill(0.25);
    const [first] = [...chunks(samples, 4)];
    expect(first.buffer).toBe(samples.buffer);
    expect(first[0]).toBe(0.25);
  });

  it('yields nothing for an empty clip', () => {
    expect([...chunks(new Float32Array(0))]).toEqual([]);
  });
});

describe('expectedPhrase', () => {
  it('drops the take number and joins the words', () => {
    expect(expectedPhrase('hey-claude-01.wav')).toBe('hey claude');
    expect(expectedPhrase('hey-computer-12.wav')).toBe('hey computer');
  });

  it('accepts a name with no take number', () => {
    expect(expectedPhrase('computer.wav')).toBe('computer');
  });

  it('accepts underscores and a full path', () => {
    expect(expectedPhrase(path.join('fixtures', 'positive', 'open_terminal_3.WAV'))).toBe('open terminal');
  });

  it('lower-cases the result', () => {
    expect(expectedPhrase('Hey-Claude-01.wav')).toBe('hey claude');
  });

  it('keeps a number that is part of the phrase, not a take suffix', () => {
    expect(expectedPhrase('take-5-01.wav')).toBe('take 5');
  });
});

describe('resolveKeywords', () => {
  it('unions the defaults with the fixture phrases, in that order, without duplicates', () => {
    expect(resolveKeywords(DEFAULT_PHRASES, ['hey claude', 'computer', 'computer'], null)).toEqual([
      'hey claude',
      'hey copilot',
      'hey computer',
      'computer',
    ]);
  });

  it('uses an explicit list verbatim, normalised', () => {
    expect(resolveKeywords(DEFAULT_PHRASES, ['hey claude'], [' Open Terminal ', 'hey claude'])).toEqual([
      'open terminal',
      'hey claude',
    ]);
  });

  it('treats an empty override as no override', () => {
    expect(resolveKeywords(DEFAULT_PHRASES, [], [])).toEqual(DEFAULT_PHRASES);
  });

  it('drops blanks and non-strings', () => {
    expect(resolveKeywords(['a', '', null, undefined, '  '], [])).toEqual(['a']);
  });
});

describe('modelDirCandidates', () => {
  it('uses APPDATA on Windows', () => {
    const dirs = modelDirCandidates({ platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, home: 'C:\\Users\\me' });
    expect(dirs[0]).toBe(
      path.join('C:\\Users\\me\\AppData\\Roaming', 'Code', 'User', 'globalStorage', 'analytics-in-motion.wake-word', 'sherpa-onnx', 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01')
    );
  });

  it('falls back to AppData/Roaming under home when APPDATA is unset', () => {
    const dirs = modelDirCandidates({ platform: 'win32', env: {}, home: 'C:\\Users\\me' });
    expect(dirs[0].startsWith(path.join('C:\\Users\\me', 'AppData', 'Roaming', 'Code'))).toBe(true);
  });

  it('uses Application Support on macOS', () => {
    const dirs = modelDirCandidates({ platform: 'darwin', env: {}, home: '/Users/me' });
    expect(dirs[0].startsWith(path.join('/Users/me', 'Library', 'Application Support', 'Code'))).toBe(true);
  });

  it('uses XDG_CONFIG_HOME, then ~/.config, on Linux', () => {
    expect(modelDirCandidates({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/me' })[0].startsWith(path.join('/xdg', 'Code'))).toBe(true);
    expect(modelDirCandidates({ platform: 'linux', env: {}, home: '/home/me' })[0].startsWith(path.join('/home/me', '.config', 'Code'))).toBe(true);
  });

  it('lists one candidate per editor', () => {
    const dirs = modelDirCandidates({ platform: 'linux', env: {}, home: os.homedir() });
    expect(dirs.length).toBeGreaterThanOrEqual(4);
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe('hasModelFiles', () => {
  it('is true only when every model file exists', () => {
    const present = new Set(MODEL_FILES.map((f) => path.join('/m', f)));
    expect(hasModelFiles('/m', (p) => present.has(p))).toBe(true);
    present.delete(path.join('/m', 'bpe.model'));
    expect(hasModelFiles('/m', (p) => present.has(p))).toBe(false);
  });
});

describe('parseArgs', () => {
  it('defaults everything', () => {
    expect(parseArgs([])).toEqual({
      modelDir: null,
      threshold: null,
      phrases: null,
      fixturesDir: null,
      verbose: false,
      help: false,
    });
  });

  it('reads every option', () => {
    const opts = parseArgs([
      '--model-dir', '/m',
      '--threshold', '0.45',
      '--phrases', 'hey claude, open terminal,,',
      '--fixtures', '/f',
      '--verbose',
    ]);
    expect(opts.modelDir).toBe('/m');
    expect(opts.threshold).toBe(0.45);
    expect(opts.phrases).toEqual(['hey claude', 'open terminal']);
    expect(opts.fixturesDir).toBe('/f');
    expect(opts.verbose).toBe(true);
  });

  it('recognises --help and -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['--model-dir'])).toThrow(/--model-dir needs a value/);
    expect(() => parseArgs(['--threshold', '--verbose'])).toThrow(/--threshold needs a value/);
  });

  it('rejects a non-numeric threshold', () => {
    expect(() => parseArgs(['--threshold', 'high'])).toThrow(/must be a number/);
  });

  it('rejects an unknown flag and shows usage', () => {
    expect(() => parseArgs(['--loud'])).toThrow(/unknown argument "--loud"[\s\S]*Usage:/);
  });
});

describe('median and percentile', () => {
  it('handle empty input', () => {
    expect(median([])).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });

  it('take the middle value or the mean of the two middle values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('use nearest rank for percentiles', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 95)).toBe(10);
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile([7], 95)).toBe(7);
  });
});

/** Build a positive result: `hits` is the phrase fired, or null for none. */
function positive(expected, hits, position = 1.5, phraseEnd = 1.2) {
  const detections = hits === null ? [] : [{ phrase: hits, raw: hits.toUpperCase(), position, phraseEnd }];
  return { file: `${expected.replace(/ /g, '-')}-01.wav`, expected, seconds: 3, detections };
}

function negative(file, seconds, firings = 0) {
  const detections = [];
  for (let i = 0; i < firings; i++) {
    detections.push({ phrase: 'hey claude', raw: 'HEY CLAUDE', position: i + 1, phraseEnd: i + 0.8 });
  }
  return { file, seconds, detections };
}

describe('summarize', () => {
  it('counts hits, misses, and wrong-phrase firings per phrase', () => {
    const summary = summarize(
      [
        positive('hey claude', 'hey claude'),
        positive('hey claude', null),
        positive('hey claude', 'hey computer'),
        positive('hey computer', 'hey computer'),
      ],
      []
    );
    expect(summary.positive).toEqual([
      { phrase: 'hey claude', total: 3, detected: 1, wrong: 1, frr: 2 / 3 },
      { phrase: 'hey computer', total: 1, detected: 1, wrong: 0, frr: 0 },
    ]);
    expect(summary.positiveTotals).toEqual({ total: 4, detected: 2, frr: 0.5 });
  });

  it('counts a positive as detected when the expected phrase fires alongside another', () => {
    const p = positive('hey claude', 'hey computer');
    p.detections.push({ phrase: 'hey claude', raw: 'HEY CLAUDE', position: 2.2, phraseEnd: 2.0 });
    const summary = summarize([p], []);
    expect(summary.positive[0]).toMatchObject({ detected: 1, wrong: 0 });
  });

  it('reports FAR by file and false triggers per hour', () => {
    const summary = summarize([], [negative('a.wav', 1800), negative('b.wav', 1800, 3), negative('c.wav', 3600)]);
    expect(summary.negative).toEqual({
      files: 3,
      filesWithFalseTriggers: 1,
      falseTriggers: 3,
      seconds: 7200,
      far: 1 / 3,
      perHour: 1.5,
    });
  });

  it('gives null rates when there is nothing to measure', () => {
    const summary = summarize([], []);
    expect(summary.positiveTotals.frr).toBeNull();
    expect(summary.negative.far).toBeNull();
    expect(summary.negative.perHour).toBeNull();
    expect(summary.latency).toEqual({ count: 0, basis: 'clip-start', mean: null, median: null, p95: null });
  });

  it('measures latency from the end of the phrase when the spotter timestamps every hit', () => {
    const summary = summarize(
      [
        positive('hey claude', 'hey claude', 1.5, 1.2),
        positive('hey claude', 'hey claude', 2.0, 1.5),
        positive('hey claude', 'hey claude', 3.1, 2.4),
      ],
      []
    );
    expect(summary.latency.basis).toBe('phrase-end');
    expect(summary.latency.count).toBe(3);
    expect(summary.latency.mean).toBeCloseTo(0.5, 6);
    expect(summary.latency.median).toBeCloseTo(0.5, 6);
    expect(summary.latency.p95).toBeCloseTo(0.7, 6);
  });

  it('measures only the hits that carry a phrase end time, and counts them', () => {
    // A hit after a reset has no usable timestamps (see run-benchmark.js),
    // so it is left out rather than allowed to drag the figure.
    const summary = summarize(
      [positive('hey claude', 'hey claude', 1.5, 1.2), positive('hey claude', 'hey claude', 2.0, null)],
      []
    );
    expect(summary.latency.basis).toBe('phrase-end');
    expect(summary.latency.count).toBe(1);
    expect(summary.latency.mean).toBeCloseTo(0.3, 6);
  });

  it('falls back to clip-start positions over every hit when none has a timestamp', () => {
    const summary = summarize(
      [positive('hey claude', 'hey claude', 1.5, null), positive('hey claude', 'hey claude', 2.0, null)],
      []
    );
    expect(summary.latency.basis).toBe('clip-start');
    expect(summary.latency.count).toBe(2);
    expect(summary.latency.mean).toBeCloseTo(1.75, 6);
  });

  it('measures latency on the first hit of the expected phrase only', () => {
    const p = positive('hey claude', 'hey computer', 0.9, 0.7);
    p.detections.push({ phrase: 'hey claude', raw: 'HEY CLAUDE', position: 2.2, phraseEnd: 2.0 });
    const summary = summarize([p], []);
    expect(summary.latency.count).toBe(1);
    expect(summary.latency.mean).toBeCloseTo(0.2, 6);
  });
});

describe('formatReport', () => {
  const meta = {
    modelName: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
    threshold: 0.3,
    keywords: ['hey claude', 'hey copilot', 'hey computer'],
    fixturesDir: 'tests/acoustic/fixtures',
  };

  it('renders the full layout', () => {
    const summary = summarize(
      [
        positive('hey claude', 'hey claude', 1.5, 1.2),
        positive('hey claude', null),
        positive('hey computer', 'hey computer', 1.7, 1.3),
        positive('hey copilot', 'hey computer'),
      ],
      [negative('silence-10s.wav', 10), negative('talk.wav', 30, 1)]
    );
    expect(formatReport(summary, meta)).toEqual([
      '=== Acoustic Benchmark ===',
      'Model:      sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
      'Threshold:  0.3',
      'Keywords:   hey claude, hey copilot, hey computer',
      'Fixtures:   tests/acoustic/fixtures',
      '',
      'Positive (FRR):',
      '  hey claude:    1/2 detected (FRR: 50%)',
      '  hey computer:  1/1 detected (FRR: 0%)',
      '  hey copilot:   0/1 detected (FRR: 100%, wrong phrase: 1)',
      '  all:           2/4 detected (FRR: 50%)',
      '',
      'Negative (FAR):',
      '  1/2 files with a false trigger (FAR: 50%)',
      '  1 false trigger in 40.0s of audio (90.00 per hour)',
      '',
      'Latency (from the end of the phrase):',
      '  Mean: 0.35s  Median: 0.35s  P95: 0.40s  (n=2)',
    ]);
  });

  it('says when a side has no recordings', () => {
    const lines = formatReport(summarize([], []), meta);
    expect(lines).toContain('  no positive recordings');
    expect(lines).toContain('  no negative recordings');
    expect(lines).toContain('  no detections to measure');
    expect(lines).toContain('Latency (from the start of the clip):');
  });

  it('omits the all line for a single phrase', () => {
    const lines = formatReport(summarize([positive('hey claude', 'hey claude')], []), meta);
    expect(lines.some((l) => l.trim().startsWith('all:'))).toBe(false);
  });
});

describe('formatFileLine', () => {
  it('names what fired and when', () => {
    const line = formatFileLine('positive', positive('hey claude', 'hey claude', 1.234, 1));
    expect(line).toBe('  [positive] hey-claude-01.wav (3.0s): expected "hey claude", fired hey claude@1.23s');
  });

  it('says nothing fired', () => {
    expect(formatFileLine('negative', negative('silence-10s.wav', 10))).toBe(
      '  [negative] silence-10s.wav (10.0s): fired nothing'
    );
  });

  it('shows the raw keyword when it did not map to a phrase', () => {
    const r = { file: 'x.wav', seconds: 2, detections: [{ phrase: null, raw: 'HEY X', position: 1, phraseEnd: 0.8 }] };
    expect(formatFileLine('negative', r)).toContain('fired ?HEY X@1.00s');
  });
});
