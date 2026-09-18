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
 * Exits 0 when every scenario passes, 1 otherwise.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.dirname(HERE);
const EXE = process.platform === 'win32' ? 'wake-word-engine.exe' : 'wake-word-engine';

/** How long a single line or a process exit may take before the run fails. */
const TIMEOUT_MS = 10000;

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
    modelDir: '/models',
    debugMode: false,
    audioDevice: '',
    ...overrides,
  });
}

/** A running engine, with its stdout split into lines as they arrive. */
class Engine {
  constructor(binary, args = []) {
    this.lines = [];
    this.stderr = '';
    this.exitCode = null;
    this.waiters = [];
    this.buffer = '';
    // How many lines waitFor() has already accounted for. READY answers both
    // the start and every resume, so a wait has to look past the ones already
    // seen or it matches an old line and the next command is written early.
    this.consumed = 0;

    this.child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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

/** Timing numbers vary run to run; the shape of the line does not. */
function normalise(lines) {
  return lines.map((line) => line.replace(/ \d+ms$/, ' <n>ms'));
}

const scenarios = [
  {
    name: 'self-test prints three lines and exits 0',
    args: ['--self-test'],
    async drive() {},
    expect: (lines) => {
      if (lines.length !== 3) return `expected 3 lines, got ${lines.length}`;
      if (lines[0] !== 'SELF-TEST:OK') return `first line was ${lines[0]}`;
      if (!/^SELF-TEST:platform=\w+-\w+$/.test(lines[1])) return `second line was ${lines[1]}`;
      if (!/^SELF-TEST:version=\d+\.\d+\.\d+$/.test(lines[2])) return `third line was ${lines[2]}`;
      return null;
    },
    exit: 0,
  },
  {
    name: 'config, pause, resume, stop',
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
    name: 'a stop during an in-flight open closes the device it produces',
    async drive(engine) {
      engine.write(config({ debugMode: true }) + '\n');
      await engine.waitFor('READY');
      // One chunk: the pause closes the device, the resume starts a new open,
      // and the stop arrives while that open is still in flight.
      engine.write('pause\nresume\nstop\n');
    },
    expect: (lines) => {
      const protocolLines = lines.filter((line) => !line.startsWith('DEBUG:'));
      const expected = ['READY', 'PAUSED', 'RELEASED'];
      if (protocolLines.join('|') !== expected.join('|')) {
        return `expected ${expected.join(', ')}, got ${protocolLines.join(', ')}`;
      }
      const closed = 'DEBUG:closed a capture device that arrived after a pause or a stop';
      if (!lines.includes(closed)) {
        return `the device that arrived after the stop was not closed: ${JSON.stringify(lines)}`;
      }
      return null;
    },
    exit: 0,
  },
  {
    name: 'a config line split across three chunks is reassembled',
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
    expect: (lines) => {
      if (lines.length !== 1) return `expected one line, got ${JSON.stringify(lines)}`;
      if (!lines[0].startsWith('ERROR:Invalid config JSON: ')) return `line was ${lines[0]}`;
      return null;
    },
    exit: 1,
  },
  {
    name: 'an unknown command is fatal',
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
    name: 'a config with no usable phrase is fatal',
    async drive(engine) {
      engine.write(JSON.stringify({ phrases: [{ phrase: 42 }, { phrase: '  ' }] }) + '\n');
    },
    lines: ['ERROR:No valid phrases to detect'],
    exit: 1,
  },
  {
    name: 'SIGTERM releases and exits 0',
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
    async drive(engine) {
      engine.write(config({ debugMode: true, audioDevice: 'Blue Yeti' }) + '\n');
      await engine.waitFor('READY');
      engine.write('stop\n');
    },
    lines: [
      'DEBUG:wake-word-engine starting, modelDir=/models',
      'DEBUG:Timing: prepare <n>ms',
      'DEBUG:opening capture device (device: "Blue Yeti")...',
      'DEBUG:Timing: mic-open <n>ms',
      'READY',
      'RELEASED',
    ],
    exit: 0,
  },
];

async function runScenario(binary, scenario) {
  const engine = new Engine(binary, scenario.args ?? []);
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

  let failed = 0;
  let skipped = 0;
  for (const scenario of scenarios) {
    if (scenario.skip) {
      skipped++;
      console.log(`skip  ${scenario.name} (${scenario.skip})`);
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
