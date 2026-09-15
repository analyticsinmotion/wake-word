import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { MockChildProcess } from "../mocks/childProcess";

/**
 * Engine lifecycle under a mock child process.
 *
 * These are the paths that were only ever checked by hand: start, stop,
 * pause, resume, the crash and retry backoff, the retry-timer cancellation
 * that stop() and pause() must perform (the D2 fix), the pause and resume
 * commands that keep one child alive across handoffs, and the PAUSED and
 * RELEASED handshakes with their timeouts. `spawn` is replaced with a factory for
 * MockChildProcess, `fs` says the model is already downloaded, and the timers
 * are faked so a ten second backoff costs nothing.
 *
 * setImmediate is left real on purpose: `start()` is async because of the
 * model check, and one real macrotask turn is the simplest way to let its
 * promise chain settle after a faked timer has fired.
 */

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mocks.spawn,
  execSync: mocks.execSync,
}));

vi.mock("fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { SherpaEngine, clearNodePathCache } from "../../src/sherpaEngine";
import { WakePhrase } from "../../src/speechEngineInterface";
import { releaseThenFire } from "../../src/wakeWordCore";

const ROUTES: WakePhrase[] = [
  { label: "Claude", phrase: "hey claude", command: "claude-vscode.focus" },
  {
    label: "Terminal",
    phrase: ["hey computer", "open terminal"],
    command: "workbench.action.terminal.focus",
    cooldownSeconds: 10,
  },
];

const NODE = "/fake/bin/node";
const RELEASE_TIMEOUT_MS = 500;
const PAUSE_TIMEOUT_MS = 500;
const RETRY_DELAYS_MS = [2000, 5000, 10000];

let spawned: MockChildProcess[] = [];

function latest(): MockChildProcess {
  const proc = spawned[spawned.length - 1];
  if (!proc) {
    throw new Error("nothing has been spawned");
  }
  return proc;
}

interface Captured {
  started: number;
  stopped: number;
  paused: number;
  detected: Array<{ phrase: WakePhrase; confidence: number | undefined }>;
  warnings: string[];
  errors: Error[];
  debug: string[];
}

/** Subscribe to everything. An unhandled 'error' would throw inside the engine. */
function capture(engine: SherpaEngine): Captured {
  const c: Captured = {
    started: 0,
    stopped: 0,
    paused: 0,
    detected: [],
    warnings: [],
    errors: [],
    debug: [],
  };
  engine.on("started", () => c.started++);
  engine.on("stopped", () => c.stopped++);
  engine.on("paused", () => c.paused++);
  engine.on("detected", (phrase, confidence) => c.detected.push({ phrase, confidence }));
  engine.on("warning", (msg) => c.warnings.push(msg));
  engine.on("error", (err) => c.errors.push(err));
  engine.on("debug", (info) => c.debug.push(info));
  return c;
}

function makeEngine(audioDevice = ""): { engine: SherpaEngine; events: Captured } {
  const context = {
    globalStorageUri: { fsPath: "/fake/storage" },
  } as unknown as vscode.ExtensionContext;
  const engine = new SherpaEngine(context, NODE, audioDevice);
  return { engine, events: capture(engine) };
}

/** One real macrotask turn: lets start()'s promise chain settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function startAndReady(engine: SherpaEngine): Promise<MockChildProcess> {
  await engine.start(ROUTES, 0.3, false);
  const proc = latest();
  proc.sendLine("READY");
  return proc;
}

/** Crash the current child and let the retry timer fire, if one is armed. */
async function crashAndRetry(delayMs: number): Promise<void> {
  latest().simulateExit(1);
  await vi.advanceTimersByTimeAsync(delayMs);
  await flush();
}

function configLine(proc: MockChildProcess): Record<string, unknown> {
  return JSON.parse(proc.stdinLines[0]);
}

/** Every command written to the child after its config line. */
function commands(proc: MockChildProcess): string[] {
  return proc.stdinLines.slice(1);
}

/** Start, report READY, pause, and acknowledge the pause. */
async function pausedEngine(engine: SherpaEngine): Promise<MockChildProcess> {
  const proc = await startAndReady(engine);
  engine.pause();
  proc.sendLine("PAUSED");
  return proc;
}

beforeEach(() => {
  clearNodePathCache();
  spawned = [];
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(() => {
    const proc = new MockChildProcess(1000 + spawned.length);
    spawned.push(proc);
    return proc;
  });
  mocks.execSync.mockReset();
  // The model is already on disk: every file exists and the version matches.
  mocks.existsSync.mockReset();
  mocks.existsSync.mockReturnValue(true);
  mocks.readFileSync.mockReset();
  mocks.readFileSync.mockReturnValue("1");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── start ───────────────────────────────────────────────────

describe("start", () => {
  it("spawns the engine script under the configured node executable", async () => {
    const { engine } = makeEngine();
    await engine.start(ROUTES, 0.3, false);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toBe(NODE);
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/audio-engine\.js$/);
    // windowsHide: without it Windows can give the console child a window.
    expect(options).toEqual({ stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    expect(mocks.execSync).not.toHaveBeenCalled();
  });

  it("sends the config as one JSON line on stdin and keeps stdin open", async () => {
    const { engine } = makeEngine();
    await engine.start(ROUTES, 0.3, true);
    const proc = latest();
    expect(proc.stdinLines).toHaveLength(1);
    const config = configLine(proc);
    // Only phrase and label cross the boundary: the child never sees a
    // command ID or a cooldown.
    expect(config.phrases).toEqual([
      { phrase: "hey claude", label: "Claude" },
      { phrase: ["hey computer", "open terminal"], label: "Terminal" },
    ]);
    expect(config.threshold).toBe(0.3);
    expect(config.modelDir).toMatch(/sherpa-onnx/);
    expect(config.debugMode).toBe(true);
    expect(proc.stdin.writable).toBe(true);
  });

  it("sends an empty audioDevice by default", async () => {
    const { engine } = makeEngine();
    await engine.start(ROUTES, 0.3, false);
    expect(configLine(latest()).audioDevice).toBe("");
  });

  it("passes the configured audio device to the child", async () => {
    const { engine } = makeEngine("Blue Yeti");
    await engine.start(ROUTES, 0.3, false);
    expect(configLine(latest()).audioDevice).toBe("Blue Yeti");
  });

  it("clamps the threshold before sending it", async () => {
    const { engine } = makeEngine();
    await engine.start(ROUTES, 5, false);
    expect(configLine(latest()).threshold).toBe(0.9);
  });

  it("is not listening until the child reports READY", async () => {
    const { engine, events } = makeEngine();
    await engine.start(ROUTES, 0.3, false);
    expect(engine.isListening).toBe(false);
    expect(events.started).toBe(0);

    latest().sendLine("READY");
    expect(engine.isListening).toBe(true);
    expect(engine.isPaused).toBe(false);
    expect(events.started).toBe(1);
  });

  it("is a no-op while already listening", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    await engine.start(ROUTES, 0.3, false);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(events.started).toBe(1);
    expect(latest().killed).toBe(false);
  });

  it("replaces a child that has not yet reported READY", async () => {
    const { engine } = makeEngine();
    await engine.start(ROUTES, 0.3, false);
    const first = latest();
    await engine.start(ROUTES, 0.3, false);
    expect(first.killed).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("lets a second start supersede one still checking the model", async () => {
    // Two starts in flight used to mean two children: the first spawned
    // after its check, then the second spawned over it and lost the handle.
    const { engine } = makeEngine();
    const first = engine.start(ROUTES, 0.3, false);
    const second = engine.start(ROUTES, 0.5, false);
    await Promise.all([first, second]);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(configLine(latest()).threshold).toBe(0.5);
  });

  it("reports a missing node executable as a nodePath problem", async () => {
    const { engine, events } = makeEngine();
    await engine.start(ROUTES, 0.3, false);
    latest().simulateError(new Error("spawn /fake/bin/node ENOENT"));
    expect(events.errors).toHaveLength(1);
    expect(events.errors[0].message).toMatch(/wakeWord\.nodePath/);
    // Windows needed no Node.js before 0.13.0, so the message says what changed.
    expect(events.errors[0].message).toContain("requires Node.js 22 or later on all platforms");
    expect(events.errors[0].message).toContain("https://nodejs.org/");
    expect(engine.isListening).toBe(false);
  });

  it("looks Node.js up again after the cached executable fails to spawn", async () => {
    const context = {
      globalStorageUri: { fsPath: "/fake/storage" },
    } as unknown as vscode.ExtensionContext;
    const engine = new SherpaEngine(context);
    const events = capture(engine);
    mocks.execSync.mockReturnValue("/usr/bin/node\n");

    await engine.start(ROUTES, 0.3, false);
    await engine.start(ROUTES, 0.3, false);
    expect(mocks.execSync).toHaveBeenCalledTimes(1);

    latest().simulateError(new Error("spawn /usr/bin/node ENOENT"));
    expect(events.errors[0].message).toMatch(/wakeWord\.nodePath/);
    await engine.start(ROUTES, 0.3, false);
    expect(mocks.execSync).toHaveBeenCalledTimes(2);
  });

  it("reports any other spawn failure with its message", async () => {
    const { engine, events } = makeEngine();
    await engine.start(ROUTES, 0.3, false);
    latest().simulateError(new Error("EACCES"));
    expect(events.errors[0].message).toBe("Failed to start audio engine: EACCES");
  });

  it("reports the model being unavailable without spawning", async () => {
    // Model files missing and the download path is not something a unit
    // test can exercise, so ensureModel's failure surfaces as an error.
    mocks.existsSync.mockReturnValue(false);
    const { engine, events } = makeEngine();
    await engine.start(ROUTES, 0.3, false);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(events.errors).toHaveLength(1);
    expect(events.errors[0].message).toMatch(/^Model unavailable: /);
  });
});

// ── stdout protocol ─────────────────────────────────────────

describe("stdout protocol", () => {
  it("emits a detection for a configured phrase, with no confidence", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().sendLine("DETECTED:hey claude");
    expect(events.detected).toHaveLength(1);
    expect(events.detected[0].phrase.label).toBe("Claude");
    expect(events.detected[0].confidence).toBeUndefined();
  });

  it("matches a phrase alias", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().sendLine("DETECTED:open terminal");
    expect(events.detected[0].phrase.label).toBe("Terminal");
  });

  it("ignores a phrase that is not configured", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().sendLine("DETECTED:hello world");
    expect(events.detected).toHaveLength(0);
  });

  it("reassembles lines split across chunks", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    const proc = latest();
    proc.sendRaw("DETEC");
    proc.sendRaw("TED:hey claude\nDEB");
    expect(events.detected).toHaveLength(1);
    proc.sendRaw("UG:half a line\n");
    expect(events.debug).toContain("half a line");
  });

  it("handles several lines in one chunk", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().sendRaw("DETECTED:hey claude\nDETECTED:hey computer\n");
    expect(events.detected.map((d) => d.phrase.label)).toEqual(["Claude", "Terminal"]);
  });

  it("forwards ERROR lines as error events", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().sendLine("ERROR:Failed to open microphone: boom");
    expect(events.errors[0].message).toBe("Failed to open microphone: boom");
  });

  it("forwards DEBUG lines and stderr as debug events", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().sendLine("DEBUG:VAD: speech");
    latest().sendStderr("  warning from a dependency \n");
    expect(events.debug).toContain("VAD: speech");
    expect(events.debug).toContain("stderr: warning from a dependency");
  });

  it("ignores output that is not part of the protocol", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().sendLine("");
    latest().sendLine("some stray console.log");
    expect(events.detected).toHaveLength(0);
    expect(events.errors).toHaveLength(0);
    expect(engine.isListening).toBe(true);
  });
});

// ── stop ────────────────────────────────────────────────────

describe("stop", () => {
  it("asks a listening child to release, reports stopped, and kills it on RELEASED", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.stop();
    expect(engine.isListening).toBe(false);
    expect(engine.isPaused).toBe(false);
    expect(events.stopped).toBe(1);
    expect(commands(proc)).toEqual(["stop"]);
    // Not killed yet: the child gets the chance to close the device itself.
    expect(proc.killed).toBe(false);

    proc.sendLine("RELEASED");
    expect(proc.killed).toBe(true);
    expect(proc.stdin.writable).toBe(false);
    expect(events.debug).toContain("Mic release: acknowledged by engine");
  });

  it("is a no-op when nothing is running", () => {
    const { engine, events } = makeEngine();
    expect(() => engine.stop()).not.toThrow();
    expect(events.stopped).toBe(0);
  });

  it("does not treat the exit of a child it killed as a crash", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.stop();
    proc.simulateExit(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    await flush();
    expect(events.warnings).toHaveLength(0);
    expect(events.errors).toHaveLength(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("kills a child that has not yet reported READY", async () => {
    // Nothing was listening, so there is no transition to report, but the
    // child must not be left to finish starting: before this was fixed a
    // Disable during the model load ended with the microphone open.
    const { engine, events } = makeEngine();
    await engine.start(ROUTES, 0.3, false);
    const proc = latest();
    engine.stop();
    expect(proc.killed).toBe(true);
    expect(proc.stdin.writable).toBe(false);
    expect(events.stopped).toBe(0);
  });

  it("ignores a READY from a child it killed before READY", async () => {
    const { engine, events } = makeEngine();
    await engine.start(ROUTES, 0.3, false);
    const proc = latest();
    engine.stop();
    proc.sendLine("READY");
    expect(engine.isListening).toBe(false);
    expect(events.started).toBe(0);
  });

  it("abandons a start that is still checking the model", async () => {
    // start() awaits the model check before it spawns. A stop that lands in
    // that window finds no child to kill and, before this was fixed, the
    // spawn then went ahead anyway: Disable during a first-run model
    // download ended with the engine listening and the status bar on Off.
    const { engine, events } = makeEngine();
    const starting = engine.start(ROUTES, 0.3, false);
    engine.stop();
    await starting;
    await flush();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(engine.isListening).toBe(false);
    expect(engine.isPaused).toBe(false);
    expect(events.debug).toContain("Start abandoned: stopped during the model check");
  });

  it("leaves the engine startable after an abandoned start", async () => {
    const { engine, events } = makeEngine();
    const starting = engine.start(ROUTES, 0.3, false);
    engine.stop();
    await starting;
    await startAndReady(engine);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(engine.isListening).toBe(true);
    expect(events.started).toBe(1);
  });
});

// ── stop and the RELEASED handshake ─────────────────────────

describe("stop and the RELEASED handshake", () => {
  it("force-kills the child when no RELEASED arrives within the timeout", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.stop();
    await vi.advanceTimersByTimeAsync(RELEASE_TIMEOUT_MS - 1);
    expect(proc.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.killed).toBe(true);
    expect(events.debug).toContain(
      `Mic release: no acknowledgement after ${RELEASE_TIMEOUT_MS}ms, forcing`
    );
  });

  it("sees a RELEASED split across two chunks", async () => {
    // Searching each chunk on its own missed this and left the release to
    // run out its timeout.
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.stop();
    proc.sendRaw("RELEA");
    expect(proc.killed).toBe(false);
    proc.sendRaw("SED\n");
    expect(proc.killed).toBe(true);
    expect(events.debug).toContain("Mic release: acknowledged by engine");
  });

  it("sees a RELEASED that arrives behind a DEBUG line in one chunk", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.stop();
    proc.sendRaw("DEBUG:closing microphone\nRELEASED\n");
    expect(proc.killed).toBe(true);
    expect(events.debug).toContain("Mic release: acknowledged by engine");
  });

  it("does not force-kill a second time after an acknowledged release", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.stop();
    proc.sendLine("RELEASED");
    await vi.advanceTimersByTimeAsync(RELEASE_TIMEOUT_MS * 2);
    expect(events.debug.filter((d) => d.startsWith("Mic release:"))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets nothing else a releasing child prints reach the engine", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.stop();
    proc.sendLine("DETECTED:hey claude");
    proc.sendLine("READY");
    proc.sendLine("ERROR:late failure");
    proc.sendLine("DEBUG:late output");
    expect(events.detected).toHaveLength(0);
    expect(events.started).toBe(1);
    expect(events.errors).toHaveLength(0);
    expect(events.debug).not.toContain("late output");
    expect(engine.isListening).toBe(false);
  });

  it("releases a paused child the same way", async () => {
    const { engine, events } = makeEngine();
    const proc = await pausedEngine(engine);
    engine.stop();
    expect(engine.isPaused).toBe(false);
    expect(events.stopped).toBe(1);
    expect(commands(proc)).toEqual(["pause", "stop"]);
    expect(proc.killed).toBe(false);
    proc.sendLine("RELEASED");
    expect(proc.killed).toBe(true);
  });

  it("releases a child still reopening the microphone after a resume", async () => {
    const { engine, events } = makeEngine();
    const proc = await pausedEngine(engine);
    engine.resume();
    engine.stop();
    expect(events.stopped).toBe(1);
    expect(commands(proc)).toEqual(["pause", "resume", "stop"]);
    proc.sendLine("READY");
    expect(engine.isListening).toBe(false);
    proc.sendLine("RELEASED");
    expect(proc.killed).toBe(true);
  });

  it("force-kills at once when stdin is already closed", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    proc.stdin.end();
    engine.stop();
    expect(proc.killed).toBe(true);
    expect(events.debug).toContain("Mic release: stdin already closed");
  });

  it("does not report stopped a second time when the released child exits", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.stop();
    proc.sendLine("RELEASED");
    proc.simulateExit(0);
    expect(events.stopped).toBe(1);
  });

  it("kills a releasing child at once when stop() is called again", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    engine.stop();
    engine.stop();
    expect(proc.killed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a start() kill a releasing child rather than run two", async () => {
    const { engine } = makeEngine();
    const first = await startAndReady(engine);
    engine.stop();
    await engine.start(ROUTES, 0.3, false);
    expect(first.killed).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    // The first child's release timer went with it.
    await vi.advanceTimersByTimeAsync(RELEASE_TIMEOUT_MS);
    expect(latest().killed).toBe(false);
  });
});

// ── pause: the child stays alive ────────────────────────────

describe("pause", () => {
  it("sends pause on stdin, reports paused, and leaves the child running", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.pause();
    expect(engine.isPaused).toBe(true);
    expect(engine.isListening).toBe(false);
    expect(events.paused).toBe(1);
    expect(commands(proc)).toEqual(["pause"]);
    expect(proc.killed).toBe(false);
    expect(proc.stdin.writable).toBe(true);
  });

  it("clears the pause timeout when PAUSED arrives", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.pause();
    proc.sendLine("PAUSED");
    expect(events.debug).toContain("Mic release: acknowledged by engine (paused)");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS * 4);
    expect(proc.killed).toBe(false);
  });

  it("sees a PAUSED split across two chunks", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.pause();
    proc.sendRaw("PAU");
    proc.sendRaw("SED\n");
    expect(events.debug).toContain("Mic release: acknowledged by engine (paused)");
    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS * 2);
    expect(proc.killed).toBe(false);
  });

  it("sees a PAUSED that arrives behind other output in one chunk", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.pause();
    proc.sendRaw("DEBUG:VAD: silence\nPAUSED\n");
    expect(events.debug).toContain("VAD: silence");
    expect(events.debug).toContain("Mic release: acknowledged by engine (paused)");
  });

  it("force-kills a child that does not say PAUSED within the timeout", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.pause();
    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS - 1);
    expect(proc.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.killed).toBe(true);
    expect(events.debug).toContain(
      `Mic release: no acknowledgement after ${PAUSE_TIMEOUT_MS}ms, forcing`
    );
    // Still paused, and nothing restarts behind the handoff.
    expect(engine.isPaused).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("ignores a PAUSED it is not waiting for", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    proc.sendLine("PAUSED");
    expect(engine.isListening).toBe(true);
    expect(events.debug.filter((d) => d.startsWith("Mic release:"))).toHaveLength(0);
  });

  it("does not emit a detection from a child that has been asked to pause", async () => {
    // The extension's own guard against repeats is shouldDebounce(), tested
    // in debounce.test.ts. This is the engine's half: once pause() has
    // returned, nothing the child still prints counts as a detection.
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.pause();
    proc.sendLine("DETECTED:hey claude");
    proc.sendLine("PAUSED");
    proc.sendLine("DETECTED:hey claude");
    expect(events.detected).toHaveLength(0);
  });

  it("force-kills at once when stdin is already closed", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    proc.stdin.end();
    engine.pause();
    expect(proc.killed).toBe(true);
    expect(engine.isPaused).toBe(true);
    expect(events.debug).toContain("Mic release: stdin already closed");
  });

  it("is a no-op when nothing is listening and no retry is pending", () => {
    const { engine, events } = makeEngine();
    engine.pause();
    expect(engine.isPaused).toBe(false);
    expect(events.paused).toBe(0);
  });

  it("is a no-op while already paused", async () => {
    const { engine, events } = makeEngine();
    const proc = await pausedEngine(engine);
    engine.pause();
    expect(commands(proc)).toEqual(["pause"]);
    expect(events.paused).toBe(1);
  });

  it("does not retry a child that crashes while paused", async () => {
    // A retry would reopen the microphone the handoff gave away.
    const { engine, events } = makeEngine();
    const proc = await pausedEngine(engine);
    proc.simulateExit(1);
    expect(events.warnings).toHaveLength(0);
    expect(events.errors).toHaveLength(0);
    expect(engine.isPaused).toBe(true);
    expect(events.debug).toContain(
      "Engine process exited while paused: the next resume starts a new one"
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a child that crashes before it says PAUSED", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    engine.pause();
    proc.simulateExit(1);
    expect(events.warnings).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("does not report stopped when a paused child exits cleanly", async () => {
    const { engine, events } = makeEngine();
    const proc = await pausedEngine(engine);
    proc.simulateExit(0);
    expect(events.stopped).toBe(0);
    expect(engine.isPaused).toBe(true);
  });
});

// ── pause: the acknowledgement a handoff awaits ─────────────

describe("pause acknowledgement", () => {
  /** Whether a promise has settled, read after a flush. */
  function track(promise: Promise<void>): () => boolean {
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    return () => settled;
  }

  it("settles only once the child says PAUSED", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    const settled = track(engine.pause());
    await flush();
    expect(settled()).toBe(false);
    proc.sendLine("PAUSED");
    await flush();
    expect(settled()).toBe(true);
    expect(proc.killed).toBe(false);
  });

  it("settles when the pause times out and the child is killed", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    const settled = track(engine.pause());
    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS - 1);
    await flush();
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(settled()).toBe(true);
    expect(proc.killed).toBe(true);
  });

  it("settles at once when stdin is already closed", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    proc.stdin.end();
    const settled = track(engine.pause());
    await flush();
    expect(settled()).toBe(true);
    expect(proc.killed).toBe(true);
  });

  it("settles at once when nothing is listening", async () => {
    const { engine } = makeEngine();
    const settled = track(engine.pause());
    await flush();
    expect(settled()).toBe(true);
  });

  it("settles at once for a pause during crash backoff", async () => {
    const { engine } = makeEngine();
    await startAndReady(engine);
    latest().simulateExit(1);
    const settled = track(engine.pause());
    await flush();
    expect(settled()).toBe(true);
    expect(engine.isPaused).toBe(true);
  });

  it("settles when the child exits before saying PAUSED", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    const settled = track(engine.pause());
    proc.simulateExit(1);
    await flush();
    expect(settled()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles when stop() lands during the wait", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    const settled = track(engine.pause());
    engine.stop();
    await flush();
    expect(settled()).toBe(true);
    expect(commands(proc)).toEqual(["pause", "stop"]);
  });

  it("settles when dispose() lands during the wait", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    const settled = track(engine.pause());
    engine.dispose();
    await flush();
    expect(settled()).toBe(true);
    expect(proc.killed).toBe(true);
  });

  it("settles when a start() replaces the child during the wait", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    const settled = track(engine.pause());
    await engine.start(ROUTES, 0.3, false);
    await flush();
    expect(settled()).toBe(true);
    expect(proc.killed).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("gives a second pause() during the wait the same acknowledgement", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    const first = track(engine.pause());
    const second = track(engine.pause());
    await flush();
    expect(first()).toBe(false);
    expect(second()).toBe(false);
    expect(commands(proc)).toEqual(["pause"]);
    expect(events.paused).toBe(1);
    proc.sendLine("PAUSED");
    await flush();
    expect(first()).toBe(true);
    expect(second()).toBe(true);
  });

  it("fires a route's command only after the child says PAUSED", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    const order: string[] = [];
    engine.on("debug", (info) => {
      if (info.startsWith("Mic release:")) {
        order.push(info);
      }
    });
    const executeCommand = vi.fn(async (id: string) => {
      order.push(`command ${id}`);
    });

    const handoff = releaseThenFire(
      () => engine.pause(),
      () => true,
      () => executeCommand("claude-vscode.focus")
    );
    await flush();
    expect(executeCommand).not.toHaveBeenCalled();

    proc.sendLine("PAUSED");
    await expect(handoff).resolves.toEqual({ kind: "fired" });
    expect(order).toEqual([
      "Mic release: acknowledged by engine (paused)",
      "command claude-vscode.focus",
    ]);
  });

  it("fires the command after the timeout when the child never says PAUSED", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    const order: string[] = [];
    engine.on("debug", (info) => {
      if (info.startsWith("Mic release:")) {
        order.push(info);
      }
    });
    const executeCommand = vi.fn(async (id: string) => {
      order.push(`command ${id}`);
    });

    const handoff = releaseThenFire(
      () => engine.pause(),
      () => true,
      () => executeCommand("workbench.action.terminal.focus")
    );
    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS - 1);
    await flush();
    expect(executeCommand).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(handoff).resolves.toEqual({ kind: "fired" });
    expect(proc.killed).toBe(true);
    expect(order).toEqual([
      `Mic release: no acknowledgement after ${PAUSE_TIMEOUT_MS}ms, forcing`,
      "command workbench.action.terminal.focus",
    ]);
  });

  it("fires nothing when listening is disabled during the release", async () => {
    // The extension abandons the handoff, then stops the engine: the stop
    // settles the release early, and the command must not run after it.
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    let generation = 0;
    const current = ++generation;
    const executeCommand = vi.fn(async () => undefined);

    const handoff = releaseThenFire(
      () => engine.pause(),
      () => current === generation,
      () => executeCommand()
    );
    generation++;
    engine.stop();

    await expect(handoff).resolves.toEqual({ kind: "superseded" });
    expect(executeCommand).not.toHaveBeenCalled();
    expect(commands(proc)).toEqual(["pause", "stop"]);
  });
});

// ── resume ──────────────────────────────────────────────────

describe("resume", () => {
  it("sends resume to the paused child instead of spawning a new one", async () => {
    const { engine } = makeEngine();
    const proc = await pausedEngine(engine);
    engine.resume();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(commands(proc)).toEqual(["pause", "resume"]);
    expect(proc.killed).toBe(false);
  });

  it("remains paused until the child reports READY, then listens on the same child", async () => {
    const { engine, events } = makeEngine();
    const proc = await pausedEngine(engine);
    engine.resume();
    expect(engine.isPaused).toBe(true);
    expect(engine.isListening).toBe(false);

    proc.sendLine("READY");
    expect(engine.isListening).toBe(true);
    expect(engine.isPaused).toBe(false);
    expect(events.started).toBe(2);
    expect(latest()).toBe(proc);

    proc.sendLine("DETECTED:hey computer");
    expect(events.detected.map((d) => d.phrase.label)).toEqual(["Terminal"]);
  });

  it("works when the resume goes out before PAUSED has come back", async () => {
    // A command that fails fast has the extension resume straight after pause().
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    engine.pause();
    engine.resume();
    expect(commands(proc)).toEqual(["pause", "resume"]);
    proc.sendLine("PAUSED");
    proc.sendLine("READY");
    expect(engine.isListening).toBe(true);
    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS * 2);
    expect(proc.killed).toBe(false);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps one child through rapid pause and resume cycles", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    const expected: string[] = [];
    for (let i = 0; i < 5; i++) {
      engine.pause();
      proc.sendLine("PAUSED");
      engine.resume();
      proc.sendLine("READY");
      expected.push("pause", "resume");
    }
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(proc.killed).toBe(false);
    expect(commands(proc)).toEqual(expected);
    expect(events.paused).toBe(5);
    expect(events.started).toBe(6);
    expect(engine.isListening).toBe(true);
  });

  it("sends resume once while READY is still on its way", async () => {
    const { engine } = makeEngine();
    const proc = await pausedEngine(engine);
    engine.resume();
    engine.resume();
    await flush();
    expect(commands(proc)).toEqual(["pause", "resume"]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("starts a new child with the same config when the paused one has died", async () => {
    const { engine, events } = makeEngine();
    const first = await pausedEngine(engine);
    first.simulateExit(1);
    engine.resume();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(configLine(latest())).toEqual(configLine(first));
    expect(events.debug).toContain("Resume: no engine process to resume, starting a new one");

    latest().sendLine("READY");
    expect(engine.isListening).toBe(true);
    expect(engine.isPaused).toBe(false);
  });

  it("starts a new child after the pause timeout killed the old one", async () => {
    const { engine } = makeEngine();
    const first = await startAndReady(engine);
    engine.pause();
    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS);
    expect(first.killed).toBe(true);
    engine.resume();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(latest()).not.toBe(first);
  });

  it("starts a new child at once when a resume was waiting behind a pause that timed out", async () => {
    const { engine, events } = makeEngine();
    const first = await startAndReady(engine);
    engine.pause();
    engine.resume();
    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS);
    await flush();
    expect(first.killed).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(events.debug).toContain("Resume: the engine did not pause in time, starting a new one");
    latest().sendLine("READY");
    expect(engine.isListening).toBe(true);
  });

  it("starts a new child when the paused child's stdin has closed", async () => {
    const { engine } = makeEngine();
    const first = await pausedEngine(engine);
    first.stdin.end();
    engine.resume();
    await flush();
    expect(first.killed).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("retries a child that crashes while reopening the microphone", async () => {
    // Unlike a crash while paused: the extension has asked to listen again.
    const { engine, events } = makeEngine();
    const proc = await pausedEngine(engine);
    engine.resume();
    proc.simulateExit(1);
    expect(events.warnings[0]).toMatch(/Retrying in 2s \(attempt 1\/3\)/);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("is a no-op unless paused", async () => {
    const { engine } = makeEngine();
    engine.resume();
    await flush();
    expect(mocks.spawn).not.toHaveBeenCalled();

    const proc = await startAndReady(engine);
    engine.resume();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(commands(proc)).toEqual([]);
  });
});

// ── start while paused: a settings change during a handoff ──

describe("start while paused", () => {
  it("replaces the paused child with one carrying the new routes and threshold", async () => {
    // After a routes change resumeListening() goes through start(), because
    // resume() would bring the paused child back with the old phrases.
    const { engine, events } = makeEngine();
    const old = await pausedEngine(engine);
    const routes: WakePhrase[] = [
      ...ROUTES,
      { label: "Search", phrase: "search files", command: "workbench.action.quickOpen" },
    ];
    await engine.start(routes, 0.5, false);
    expect(old.killed).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    const config = configLine(latest());
    expect(config.phrases).toContainEqual({ phrase: "search files", label: "Search" });
    expect(config.threshold).toBe(0.5);
    expect(engine.isPaused).toBe(true);

    latest().sendLine("READY");
    expect(engine.isPaused).toBe(false);
    latest().sendLine("DETECTED:search files");
    expect(events.detected.map((d) => d.phrase.label)).toEqual(["Search"]);
  });

  it("does not send a resume to the replacement while it is starting", async () => {
    const { engine } = makeEngine();
    await pausedEngine(engine);
    await engine.start(ROUTES, 0.3, false);
    engine.resume();
    await flush();
    expect(commands(latest())).toEqual([]);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("retries a replacement that crashes before READY", async () => {
    const { engine, events } = makeEngine();
    await pausedEngine(engine);
    await engine.start(ROUTES, 0.3, false);
    latest().simulateExit(1);
    expect(events.warnings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(3);
  });
});

// ── debug timing ────────────────────────────────────────────

describe("debug timing", () => {
  it("logs start-to-ready, pause-to-ack, and resume-to-ready in debug mode", async () => {
    const { engine, events } = makeEngine();
    await engine.start(ROUTES, 0.3, true);
    const proc = latest();
    proc.sendLine("READY");
    engine.pause();
    proc.sendLine("PAUSED");
    engine.resume();
    proc.sendLine("READY");
    const timing = events.debug.filter((d) => d.startsWith("Timing:"));
    expect(timing).toHaveLength(3);
    expect(timing[0]).toMatch(/^Timing: start-to-ready \d+ms$/);
    expect(timing[1]).toMatch(/^Timing: pause-to-ack \d+ms$/);
    expect(timing[2]).toMatch(/^Timing: resume-to-ready \d+ms$/);
  });

  it("logs no timing outside debug mode", async () => {
    const { engine, events } = makeEngine();
    const proc = await pausedEngine(engine);
    engine.resume();
    proc.sendLine("READY");
    expect(events.debug.filter((d) => d.startsWith("Timing:"))).toEqual([]);
  });

  it("forwards the child's own timing lines", async () => {
    const { engine, events } = makeEngine();
    const proc = await startAndReady(engine);
    proc.sendLine("DEBUG:Timing: model-load 487ms");
    expect(events.debug).toContain("Timing: model-load 487ms");
  });
});

// ── crash and retry ─────────────────────────────────────────

describe("crash and retry", () => {
  it("warns and retries after the first backoff delay", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().simulateExit(1);

    expect(engine.isListening).toBe(false);
    expect(events.warnings).toHaveLength(1);
    expect(events.warnings[0]).toMatch(/exit code 1\. Retrying in 2s \(attempt 1\/3\)/);
    expect(events.errors).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] - 1);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("escalates the delay on each consecutive crash", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    await crashAndRetry(RETRY_DELAYS_MS[0]);
    await crashAndRetry(RETRY_DELAYS_MS[1]);
    await crashAndRetry(RETRY_DELAYS_MS[2]);
    expect(events.warnings.map((w) => w.match(/Retrying in (\d+)s \(attempt (\d)\/3\)/)?.slice(1))).toEqual([
      ["2", "1"],
      ["5", "2"],
      ["10", "3"],
    ]);
    expect(mocks.spawn).toHaveBeenCalledTimes(4);
  });

  it("gives up with an error after three retries", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    await crashAndRetry(RETRY_DELAYS_MS[0]);
    await crashAndRetry(RETRY_DELAYS_MS[1]);
    await crashAndRetry(RETRY_DELAYS_MS[2]);
    latest().simulateExit(1);

    expect(events.errors).toHaveLength(1);
    expect(events.errors[0].message).toBe("exit code 1 (failed after 3 retries)");
    expect(events.warnings).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(4);
    expect(engine.isListening).toBe(false);
  });

  it("resets the retry budget once a child reports READY", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    await crashAndRetry(RETRY_DELAYS_MS[0]);
    latest().sendLine("READY");
    expect(engine.isListening).toBe(true);

    latest().simulateExit(1);
    expect(events.warnings[1]).toMatch(/Retrying in 2s \(attempt 1\/3\)/);
  });

  it("treats a clean exit while listening as a stop, not a crash", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().simulateExit(0);
    expect(events.stopped).toBe(1);
    expect(events.warnings).toHaveLength(0);
    expect(engine.isListening).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("retries a crash that happens before READY", async () => {
    const { engine, events } = makeEngine();
    await engine.start(ROUTES, 0.3, false);
    latest().simulateExit(1);
    expect(events.warnings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });
});

// ── the D2 fix: nothing may restart the microphone after stop() ──

describe("stop during crash backoff", () => {
  it("cancels the pending retry so nothing reopens the microphone", async () => {
    const { engine } = makeEngine();
    await startAndReady(engine);
    latest().simulateExit(1);

    engine.stop();
    expect(engine.isListening).toBe(false);
    expect(engine.isPaused).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("does not report a phantom stop for an engine that was not running", async () => {
    // The crash already took the engine out of the listening state. The
    // extension sets its own status bar on Disable, so no event is owed.
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().simulateExit(1);
    engine.stop();
    expect(events.stopped).toBe(0);
  });

  it("leaves the engine startable with a fresh retry budget", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    await crashAndRetry(RETRY_DELAYS_MS[0]);
    latest().simulateExit(1);
    expect(events.warnings[1]).toMatch(/attempt 2\/3/);

    engine.stop();
    await engine.start(ROUTES, 0.3, false);
    latest().sendLine("READY");
    expect(engine.isListening).toBe(true);

    latest().simulateExit(1);
    expect(events.warnings[2]).toMatch(/attempt 1\/3/);
  });
});

describe("pause during crash backoff", () => {
  it("cancels the pending retry and leaves the engine paused", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().simulateExit(1);

    engine.pause();
    expect(engine.isPaused).toBe(true);
    expect(engine.isListening).toBe(false);
    expect(events.paused).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("can be resumed, which starts a fresh child", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().simulateExit(1);
    engine.pause();

    engine.resume();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    latest().sendLine("READY");
    expect(engine.isListening).toBe(true);
    expect(events.started).toBe(2);
  });

  it("can be stopped, which reports stopped and clears the pause", async () => {
    const { engine, events } = makeEngine();
    await startAndReady(engine);
    latest().simulateExit(1);
    engine.pause();

    engine.stop();
    expect(engine.isPaused).toBe(false);
    expect(events.stopped).toBe(1);
  });
});

describe("start during crash backoff", () => {
  it("supersedes the pending retry rather than stacking a second start", async () => {
    const { engine } = makeEngine();
    await startAndReady(engine);
    latest().simulateExit(1);

    await engine.start(ROUTES, 0.3, false);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    const manual = latest();

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(manual.killed).toBe(false);
  });
});

// ── dispose ─────────────────────────────────────────────────

describe("dispose", () => {
  it("kills the child and drops every listener", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    engine.dispose();
    expect(proc.killed).toBe(true);
    expect(engine.isListening).toBe(false);
    for (const event of ["detected", "started", "stopped", "paused", "error", "warning", "debug"]) {
      expect(engine.listenerCount(event)).toBe(0);
    }
  });

  it("cancels a pending retry", async () => {
    const { engine } = makeEngine();
    await startAndReady(engine);
    latest().simulateExit(1);
    engine.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("cancels an unacknowledged pause and kills the child now", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    engine.pause();
    engine.dispose();
    expect(proc.killed).toBe(true);
    // The pause timer is gone with the child: nothing left to fire.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS);
  });

  it("kills a paused child at once", async () => {
    // An engine switch or a wakeWord.audioDevice change during a handoff
    // disposes the paused engine; its child must not outlive it.
    const { engine } = makeEngine();
    const proc = await pausedEngine(engine);
    engine.dispose();
    expect(proc.killed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills a listening child at once rather than waiting for RELEASED", async () => {
    const { engine } = makeEngine();
    const proc = await startAndReady(engine);
    engine.dispose();
    expect(proc.killed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills a child that has not yet reported READY", async () => {
    // An engine switch during the model load disposes the old engine. The
    // old child must die with it rather than open the microphone next to
    // the new engine's child.
    const { engine } = makeEngine();
    await engine.start(ROUTES, 0.3, false);
    const proc = latest();
    engine.dispose();
    expect(proc.killed).toBe(true);
    proc.sendLine("READY");
    expect(engine.isListening).toBe(false);
  });
});
