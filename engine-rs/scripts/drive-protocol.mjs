#!/usr/bin/env node
/**
 * Drive the built wake-word-engine binary over a real pipe and assert the
 * protocol it speaks.
 *
 * The Rust unit tests drive the state machine directly, which is where the
 * awkward cases are pinned. This script checks the other half: that a real
 * process, reading a real pipe, splits chunks the same way, answers in the
 * same order, flushes its last line before exiting, and exits with the right
 * code. Those are the parts a unit test cannot see.
 *
 *   node engine-rs/scripts/drive-protocol.mjs [--bin <path>]
 *
 * A scenario that needs `microphone` opens the default microphone, so it needs
 * one, plus ONNX Runtime and the Silero model where the engine looks for them:
 * ORT_DYLIB_PATH and WAKE_WORD_VAD_MODEL, or both files beside the binary. One
 * that needs `ort` builds the voice activity detector but fails before a
 * microphone opens. One that needs `model` loads the keyword spotting model,
 * which WAKE_WORD_MODEL_DIR must point at: the extracted
 * sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01 directory. Everything
 * that gets as far as a microphone needs the model too, because the spotter
 * loads first. The script reads the engine's self-test first and skips, saying
 * why, any scenario whose prerequisite is missing.
 *
 * Exits 0 when every scenario that ran passed, 1 otherwise.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.dirname(HERE);
const EXE = process.platform === 'win32' ? 'wake-word-engine.exe' : 'wake-word-engine';

/** How long a single line or a process exit may take before the run fails. */
const TIMEOUT_MS = 10000;

/** An ONNX Runtime path that cannot exist, for the failure scenarios. */
const MISSING_ORT = path.join(ENGINE_DIR, 'no-such-dir', 'onnxruntime-missing');

/** A model directory that cannot exist. */
const MISSING_MODEL_DIR = path.join(ENGINE_DIR, 'no-such-dir', 'model');

/** The files the engine loads from the model directory. */
const MODEL_FILES = [
  'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
  'tokens.txt',
];

/**
 * The keyword lines and phrase map the extension builds for the phrases in
 * config(), at the threshold config() sends: the model's SentencePiece pieces
 * for each upper-cased phrase, then the boost and the threshold.
 */
const KEYWORD_LINES = [
  '▁HE Y ▁C LA U DE :3.0 #0.05',
  '▁O P EN ▁C LA U DE :3.0 #0.05',
  '▁HE Y ▁CHA T :3.0 #0.05',
];
const PHRASE_MAP = {
  'HEY CLAUDE': 'hey claude',
  'OPEN CLAUDE': 'open claude',
  'HEY CHAT': 'hey chat',
};

/** The keyword spotting model, when WAKE_WORD_MODEL_DIR names a complete one. */
const MODEL_DIR = (() => {
  const dir = process.env.WAKE_WORD_MODEL_DIR;
  if (!dir || !MODEL_FILES.every((file) => existsSync(path.join(dir, file)))) {
    return null;
  }
  return path.resolve(dir);
})();

function resolveBinary() {
  const flag = process.argv.indexOf('--bin');
  if (flag !== -1 && process.argv[flag + 1]) {
    return path.resolve(process.argv[flag + 1]);
  }
  for (const profile of ['release', 'debug']) {
    const candidate = path.join(ENGINE_DIR, 'target', profile, EXE);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`no engine binary found; run "cargo build --release" in ${ENGINE_DIR}`);
}

function config(overrides = {}) {
  return JSON.stringify({
    phrases: [
      { phrase: ['hey claude', 'open claude'], label: 'Claude' },
      { phrase: 'hey chat', label: 'Chat' },
    ],
    threshold: 0.05,
    modelDir: MODEL_DIR ?? MISSING_MODEL_DIR,
    debugMode: false,
    audioDevice: '',
    keywordLines: KEYWORD_LINES,
    phraseMap: PHRASE_MAP,
    ...overrides,
  });
}

/** A running engine, with its stdout split into lines as they arrive. */
class Engine {
  constructor(binary, args = [], env = {}) {
    this.lines = [];
    this.stderr = '';
    this.exitCode = null;
    this.waiters = [];
    this.buffer = '';
    // How many lines waitFor() has already accounted for. READY answers both
    // the start and every resume, so a wait has to look past the ones already
    // seen or it matches an old line and the next command is written early.
    this.consumed = 0;

    this.child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#absorb(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => (this.stderr += chunk));
    // A write that lands after the engine has exited is expected in the
    // scenarios that end with a stop; it must not take this script down.
    this.child.stdin.on('error', () => {});
    this.exited = new Promise((resolve) => {
      this.child.on('close', (code) => {
        this.exitCode = code;
        resolve(code);
      });
    });
  }

  #absorb(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      this.lines.push(this.buffer.slice(0, newline).replace(/\r$/, ''));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter();
    }
  }

  write(text) {
    this.child.stdin.write(text);
  }

  closeStdin() {
    this.child.stdin.end();
  }

  /** Resolve once a line equal to `line` has been printed after the ones already consumed. */
  async waitFor(line) {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const found = this.lines.indexOf(line, this.consumed);
      if (found !== -1) {
        this.consumed = found + 1;
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for "${line}"; saw ${JSON.stringify(this.lines)}`);
      }
      await Promise.race([
        new Promise((resolve) => this.waiters.push(resolve)),
        new Promise((resolve) => setTimeout(resolve, 50)),
      ]);
    }
  }

  async waitForExit() {
    const guard = setTimeout(() => this.child.kill(), TIMEOUT_MS);
    const code = await this.exited;
    clearTimeout(guard);
    return code;
  }
}

/**
 * Timing numbers vary run to run; the shape of the line does not. Lines about
 * voice activity and detections depend on what the microphone hears, so they
 * are dropped.
 */
function normalise(lines) {
  return lines
    .filter((line) => !/^DEBUG:(VAD: |KWS result: |Unmatched KWS result: |overruns: )/.test(line))
    .filter((line) => !line.startsWith('DETECTED:'))
    .map((line) => line.replace(/ \d+ms$/, ' <n>ms'));
}

/** Check each line against the pattern at the same position. */
function matchShapes(lines, shapes) {
  if (lines.length !== shapes.length) {
    return `expected ${shapes.length} lines, got ${JSON.stringify(lines)}`;
  }
  const wrong = shapes.findIndex((shape, index) => !shape.test(lines[index]));
  return wrong === -1 ? null : `line ${wrong + 1} was ${lines[wrong]}`;
}

/** Expect exactly one line, starting with `prefix`. */
function oneLineStartingWith(prefix) {
  return (lines) => {
    if (lines.length !== 1) return `expected one line, got ${JSON.stringify(lines)}`;
    return lines[0].startsWith(prefix) ? null : `line was ${lines[0]}`;
  };
}

const scenarios = [
  {
    name: 'self-test prints seven lines and exits 0',
    args: ['--self-test'],
    async drive() {},
    expect: (lines) =>
      matchShapes(lines, [
        /^SELF-TEST:OK$/,
        /^SELF-TEST:platform=\w+-\w+$/,
        /^SELF-TEST:version=\d+\.\d+\.\d+$/,
        /^SELF-TEST:decibri=\d+\.\d+\.\d+$/,
        /^SELF-TEST:sherpa-onnx=\d+\.\d+\.\d+$/,
        /^SELF-TEST:ort=.+$/,
        /^SELF-TEST:vad-model=.+$/,
      ]),
    exit: 0,
  },
  {
    name: 'self-test fails on an ONNX Runtime path that does not exist',
    args: ['--self-test'],
    env: { ORT_DYLIB_PATH: MISSING_ORT },
    async drive() {},
    expect: oneLineStartingWith('SELF-TEST:FAIL:Failed to start voice activity detection: '),
    exit: 1,
  },
  {
    name: 'config, pause, resume, stop',
    needs: ['model', 'microphone'],
    async drive(engine) {
      engine.write(config() + '\n');
      await engine.waitFor('READY');
      engine.write('pause\n');
      await engine.waitFor('PAUSED');
      engine.write('resume\n');
      await engine.waitFor('READY');
      engine.write('stop\n');
    },
    lines: ['READY', 'PAUSED', 'READY', 'RELEASED'],
    exit: 0,
  },
  {
    name: 'a stop behind other commands in one chunk is not lost',
    async drive(engine) {
      // One write, four lines. The pause lands before the engine is ready, so
      // nothing is opened; the stop is the last line of the same chunk and
      // must still be seen.
      engine.write(config() + '\npause\nresume\nstop\n');
    },
    lines: ['PAUSED', 'RELEASED'],
    exit: 0,
  },
  {
    name: 'a stop during an in-flight open closes the microphone it produces',
    needs: ['model', 'microphone'],
    async drive(engine) {
      engine.write(config({ debugMode: true }) + '\n');
      await engine.waitFor('READY');
      // One chunk: the pause closes the microphone, the resume starts a new
      // open, and the stop arrives while that open is still in flight.
      engine.write('pause\nresume\nstop\n');
    },
    expect: (lines) => {
      const protocolLines = lines.filter((line) => !line.startsWith('DEBUG:'));
      const expected = ['READY', 'PAUSED', 'RELEASED'];
      if (protocolLines.join('|') !== expected.join('|')) {
        return `expected ${expected.join(', ')}, got ${protocolLines.join(', ')}`;
      }
      const closed = 'DEBUG:closed a microphone that arrived after a pause or a stop';
      if (!lines.includes(closed)) {
        return `the microphone that arrived after the stop was not closed: ${JSON.stringify(lines)}`;
      }
      return null;
    },
    exit: 0,
  },
  {
    name: 'a config line split across three chunks is reassembled',
    needs: ['model', 'microphone'],
    async drive(engine) {
      const line = config();
      const first = line.slice(0, 20);
      const second = line.slice(20, 45);
      const third = line.slice(45);
      engine.write(first);
      await new Promise((resolve) => setTimeout(resolve, 30));
      engine.write(second);
      await new Promise((resolve) => setTimeout(resolve, 30));
      engine.write(third + '\n');
      await engine.waitFor('READY');
      // A command split across two chunks as well.
      engine.write('sto');
      await new Promise((resolve) => setTimeout(resolve, 30));
      engine.write('p\n');
    },
    lines: ['READY', 'RELEASED'],
    exit: 0,
  },
  {
    name: 'blank lines and CRLF are tolerated',
    needs: ['model', 'microphone'],
    async drive(engine) {
      engine.write('\n\r\n   \n');
      engine.write(config() + '\r\n');
      await engine.waitFor('READY');
      engine.write('pause\r\nresume\r\n');
      await engine.waitFor('PAUSED');
      await engine.waitFor('READY');
      engine.write('stop\r\n');
    },
    lines: ['READY', 'PAUSED', 'READY', 'RELEASED'],
    exit: 0,
  },
  {
    name: 'closing stdin releases and exits 0',
    needs: ['model', 'microphone'],
    async drive(engine) {
      engine.write(config() + '\n');
      await engine.waitFor('READY');
      engine.closeStdin();
    },
    lines: ['READY', 'RELEASED'],
    exit: 0,
  },
  {
    name: 'a malformed config line is fatal',
    async drive(engine) {
      engine.write('{ not json\n');
    },
    expect: oneLineStartingWith('ERROR:Invalid config JSON: '),
    exit: 1,
  },
  {
    name: 'an unknown command is fatal',
    needs: ['model', 'microphone'],
    async drive(engine) {
      engine.write(config() + '\n');
      await engine.waitFor('READY');
      engine.write('paws\n');
    },
    expect: (lines) => {
      if (lines[0] !== 'READY') return `first line was ${lines[0]}`;
      if (!lines[1] || !lines[1].startsWith('ERROR:Invalid config JSON: ')) {
        return `second line was ${lines[1]}`;
      }
      return null;
    },
    exit: 1,
  },
  {
    name: 'a config with no keyword lines is fatal',
    async drive(engine) {
      engine.write(config({ keywordLines: [] }) + '\n');
    },
    lines: ['ERROR:No valid phrases to detect'],
    exit: 1,
  },
  {
    name: 'a config without keywordLines is a startup error',
    async drive(engine) {
      engine.write(config({ keywordLines: undefined }) + '\n');
    },
    lines: [
      'ERROR:Startup error: the config has no keywordLines, and the engine does not tokenise phrases itself',
    ],
    exit: 1,
  },
  {
    name: 'a config without phraseMap is a startup error',
    async drive(engine) {
      engine.write(config({ phraseMap: undefined }) + '\n');
    },
    lines: ['ERROR:Startup error: the config has no phraseMap, so no detection could be reported'],
    exit: 1,
  },
  {
    name: 'a model directory without the transducer says which file is missing',
    needs: ['model'],
    async drive(engine) {
      // The token table alone: it is there to read, and the model load fails.
      const partial = mkdtempSync(path.join(os.tmpdir(), 'wake-word-partial-model-'));
      try {
        copyFileSync(path.join(MODEL_DIR, 'tokens.txt'), path.join(partial, 'tokens.txt'));
        engine.write(config({ modelDir: partial }) + '\n');
        await engine.waitForExit();
      } finally {
        rmSync(partial, { recursive: true, force: true });
      }
    },
    expect: (lines) => {
      if (lines.length !== 1) return `expected one line, got ${JSON.stringify(lines)}`;
      const ok =
        lines[0].startsWith('ERROR:Failed to load KWS model: ') &&
        lines[0].endsWith('encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx does not exist');
      return ok ? null : `line was ${lines[0]}`;
    },
    exit: 1,
  },
  {
    name: 'a phrase the model has no pieces for is refused by name instead of ending the process',
    needs: ['model'],
    async drive(engine) {
      engine.write(
        config({
          keywordLines: [KEYWORD_LINES[0], '▁RO U TE ▁ 66 :3.0 #0.05'],
          phraseMap: { 'HEY CLAUDE': 'hey claude', 'ROUTE 66': 'route 66' },
        }) + '\n'
      );
    },
    lines: [
      'ERROR:Failed to load KWS model: the phrase "route 66" cannot be spotted: ' +
        '"66" is not in the model\'s vocabulary',
    ],
    exit: 1,
  },
  {
    name: 'a keyword line with a NUL character is refused instead of ending the process',
    needs: ['model'],
    async drive(engine) {
      engine.write(config({ keywordLines: ['▁HE Y\u0000 ▁C LA U DE :3.0 #0.05'] }) + '\n');
    },
    lines: [
      'ERROR:Failed to load KWS model: a keyword line contains a NUL character: ' +
        '"▁HE Y\\0 ▁C LA U DE :3.0 #0.05"',
    ],
    exit: 1,
  },
  {
    name: 'a boost the library cannot read is refused instead of ending the process',
    needs: ['model'],
    async drive(engine) {
      engine.write(config({ keywordLines: ['▁HE Y ▁C LA U DE :x #0.05'] }) + '\n');
    },
    lines: [
      'ERROR:Failed to load KWS model: a keyword line has a boost or threshold that is not a number: ' +
        '":x" in "▁HE Y ▁C LA U DE :x #0.05"',
    ],
    exit: 1,
  },
  {
    name: 'a pause during the model load is answered at once and the microphone stays closed',
    needs: ['model'],
    async drive(engine) {
      engine.write(config({ debugMode: true }) + '\npause\n');
      await engine.waitFor('PAUSED');
      await engine.waitFor(
        'DEBUG:models loaded; paused before the microphone opened, waiting for resume'
      );
      engine.write('stop\n');
    },
    expect: (lines) => {
      const protocolLines = lines.filter((line) => !line.startsWith('DEBUG:'));
      if (protocolLines.join('|') !== 'PAUSED|RELEASED') {
        return `expected PAUSED, RELEASED, got ${protocolLines.join(', ')}`;
      }
      return lines.some((line) => line.startsWith('DEBUG:opening microphone'))
        ? 'the microphone was opened'
        : null;
    },
    exit: 0,
  },
  {
    name: 'a stop during the model load is answered at once',
    needs: ['model'],
    async drive(engine) {
      engine.write(config() + '\nstop\n');
    },
    lines: ['RELEASED'],
    exit: 0,
  },
  {
    name: 'an ONNX Runtime that cannot be loaded is reported before any microphone opens',
    needs: ['model'],
    env: { ORT_DYLIB_PATH: MISSING_ORT },
    async drive(engine) {
      engine.write(config() + '\n');
    },
    expect: oneLineStartingWith(
      'ERROR:Failed to start voice activity detection: decibri: failed to load ONNX Runtime'
    ),
    exit: 1,
  },
  {
    name: 'a Silero model that does not exist is reported',
    needs: ['model', 'ort'],
    async drive(engine) {
      const vadModelPath = path.join(ENGINE_DIR, 'no-such-dir', 'silero_vad.onnx');
      engine.write(config({ vadModelPath }) + '\n');
    },
    expect: oneLineStartingWith(
      'ERROR:Failed to start voice activity detection: Failed to load Silero VAD model from '
    ),
    exit: 1,
  },
  {
    name: 'a device name that matches no microphone names the setting',
    needs: ['model', 'microphone'],
    async drive(engine) {
      engine.write(config({ audioDevice: 'No Microphone Has This Name 7f3a' }) + '\n');
    },
    lines: [
      'ERROR:No microphone matching "No Microphone Has This Name 7f3a" was found. ' +
        'Check wakeWord.audioDevice against the input devices on this machine.',
    ],
    exit: 1,
  },
  {
    name: 'a device index past the end of the list names the setting',
    needs: ['model', 'microphone'],
    async drive(engine) {
      engine.write(config({ audioDevice: '999' }) + '\n');
    },
    lines: [
      'ERROR:Microphone index 999 is out of range. ' +
        'Check wakeWord.audioDevice against the input devices on this machine.',
    ],
    exit: 1,
  },
  {
    name: 'SIGTERM releases and exits 0',
    needs: ['model', 'microphone'],
    skip: process.platform === 'win32' ? 'Windows has no POSIX signals' : null,
    async drive(engine) {
      engine.write(config() + '\n');
      await engine.waitFor('READY');
      engine.child.kill('SIGTERM');
    },
    lines: ['READY', 'RELEASED'],
    exit: 0,
  },
  {
    name: 'SIGINT releases and exits 0',
    needs: ['model', 'microphone'],
    skip: process.platform === 'win32' ? 'Windows has no POSIX signals' : null,
    async drive(engine) {
      engine.write(config() + '\n');
      await engine.waitFor('READY');
      engine.child.kill('SIGINT');
    },
    lines: ['READY', 'RELEASED'],
    exit: 0,
  },
  {
    name: 'debug mode reports every phase',
    needs: ['model', 'microphone'],
    async drive(engine) {
      engine.write(config({ debugMode: true }) + '\n');
      await engine.waitFor('READY');
      engine.write('pause\n');
      await engine.waitFor('PAUSED');
      engine.write('resume\n');
      await engine.waitFor('READY');
      engine.write('stop\n');
    },
    expect: (lines) =>
      matchShapes(lines, [
        /^DEBUG:wake-word-engine starting, modelDir=.+$/,
        /^DEBUG:loading sherpa-onnx KWS model\.\.\.$/,
        /^DEBUG:Timing: model-load <n>ms$/,
        /^DEBUG:voice activity model=.+, ONNX Runtime=.+$/,
        /^DEBUG:opening microphone\.\.\.$/,
        /^DEBUG:Timing: mic-open <n>ms$/,
        /^READY$/,
        /^DEBUG:mic open, VAD-gated, listening for: hey claude, open claude, hey chat$/,
        /^PAUSED$/,
        /^DEBUG:Timing: resume-mic-open <n>ms$/,
        /^READY$/,
        /^RELEASED$/,
      ]),
    exit: 0,
  },
];

/**
 * Read the self-test to learn whether ONNX Runtime and the Silero model can be
 * found, and the environment for the keyword spotting model. Returns the
 * reason each kind of scenario cannot run, or null.
 */
async function prerequisites(binary) {
  const engine = new Engine(binary, ['--self-test']);
  await engine.waitForExit();
  const value = (key) => {
    const prefix = `SELF-TEST:${key}=`;
    const line = engine.lines.find((candidate) => candidate.startsWith(prefix));
    return line ? line.slice(prefix.length) : 'not found';
  };
  const ort = value('ort') === 'not found' ? 'no ONNX Runtime found' : null;
  const vadModel = value('vad-model') === 'not found' ? 'no Silero model found' : null;
  const model = MODEL_DIR ? null : 'no keyword spotting model: set WAKE_WORD_MODEL_DIR';
  return { ort, microphone: ort ?? vadModel, model };
}

async function runScenario(binary, scenario) {
  const engine = new Engine(binary, scenario.args ?? [], scenario.env ?? {});
  try {
    await scenario.drive(engine);
  } catch (err) {
    engine.child.kill();
    await engine.waitForExit();
    return `driving failed: ${err.message}`;
  }

  const code = await engine.waitForExit();
  const lines = normalise(engine.lines);

  if (scenario.expect) {
    const failure = scenario.expect(lines);
    if (failure) return failure;
  } else if (lines.join('|') !== scenario.lines.join('|')) {
    return `expected [${scenario.lines.join(', ')}], got [${lines.join(', ')}]`;
  }

  if (code !== scenario.exit) {
    return `expected exit ${scenario.exit}, got ${code}`;
  }
  if (engine.stderr.trim().length > 0) {
    return `unexpected stderr: ${engine.stderr.trim()}`;
  }
  return null;
}

async function main() {
  const binary = resolveBinary();
  console.log(`Driving ${binary}\n`);
  const missing = await prerequisites(binary);

  let failed = 0;
  let skipped = 0;
  for (const scenario of scenarios) {
    const needs = scenario.needs ?? [];
    const skip = scenario.skip ?? needs.map((need) => missing[need]).find(Boolean) ?? null;
    if (skip) {
      skipped++;
      console.log(`skip  ${scenario.name} (${skip})`);
      continue;
    }
    const failure = await runScenario(binary, scenario);
    if (failure) {
      failed++;
      console.log(`FAIL  ${scenario.name}\n      ${failure}`);
    } else {
      console.log(`ok    ${scenario.name}`);
    }
  }

  const run = scenarios.length - skipped;
  const passed = run - failed;
  const tail = skipped > 0 ? `, ${skipped} skipped` : '';
  console.log(`\n${passed}/${run} scenarios passed${tail}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
