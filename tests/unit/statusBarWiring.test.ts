import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "events";
import type { InstalledExtension } from "../../src/wakeWordCore";
import { LEVEL, createLogChannel } from "../mocks/logChannel";
import type { EngineRestart, WakePhrase } from "../../src/speechEngineInterface";

/**
 * What the status bar shows while the extension runs, driven through
 * activate() with the `vscode` module stubbed per session, a fake engine in
 * place of SherpaEngine, and a fake listener lock: the start, a pause for
 * focus, a handoff, a restart after the engine stopped, a failure, a
 * cancelled download, and a Calibrate run put back. Also the remote-window
 * availability rule and the editor's name, which reach the engine from here.
 *
 * After every step the fake engine says whether its microphone is open, and
 * the status bar is checked against it: Listening only while it is.
 */

interface FakeEngine extends EventEmitter {
  isListening: boolean;
  isPaused: boolean;
  isStarting: boolean;
  restarting: EngineRestart | null;
  args: unknown[];
  startedWith: WakePhrase[][];
  /** The debug mode each start was given. */
  startedDebug: boolean[];
  /** Every setDebugMode() call, in order. */
  debugModes: boolean[];
  resumes: number;
  stops: number;
  /** Hold the next pause until release() is called, as the child's PAUSED would. */
  holdPause: boolean;
  release(): void;
  ready(): void;
  crash(reason: string, attempt?: number): void;
  fail(message: string): void;
  cancel(): void;
}

const engines = vi.hoisted(() => [] as FakeEngine[]);
/** What the engine's device listing answers, per test. */
const deviceListing = vi.hoisted(() => ({
  answer: { kind: "listed", devices: [] } as unknown,
}));
const lock = vi.hoisted(() => ({ held: false }));

vi.mock("../../src/sherpaEngine", async () => {
  const { EventEmitter } = await import("events");
  class Engine extends EventEmitter {
    isListening = false;
    isPaused = false;
    isStarting = false;
    restarting: EngineRestart | null = null;
    startedWith: WakePhrase[][] = [];
    startedDebug: boolean[] = [];
    resumes = 0;
    stops = 0;
    /** Every setDebugMode() call, in order. */
    debugModes: boolean[] = [];
    holdPause = false;
    args: unknown[];
    private released: (() => void) | null = null;
    constructor(...args: unknown[]) {
      super();
      this.args = args;
      engines.push(this as unknown as FakeEngine);
    }
    start(phrases: WakePhrase[], _threshold: number, debugMode: boolean): Promise<void> {
      this.startedWith.push(phrases);
      this.startedDebug.push(debugMode);
      this.isStarting = true;
      this.restarting = null;
      return Promise.resolve();
    }
    ready(): void {
      this.isListening = true;
      this.isPaused = false;
      this.isStarting = false;
      this.restarting = null;
      this.emit("started");
    }
    pause(): Promise<void> {
      if (!this.isListening) {
        return Promise.resolve();
      }
      this.isListening = false;
      this.isPaused = true;
      this.emit("paused");
      return this.holdPause ? new Promise<void>((resolve) => (this.released = resolve)) : Promise.resolve();
    }
    release(): void {
      this.released?.();
      this.released = null;
    }
    resume(): void {
      this.resumes++;
      if (this.isPaused) {
        this.isStarting = true;
      }
    }
    stop(): void {
      this.stops++;
      const was = this.isListening || this.isPaused;
      this.isListening = false;
      this.isPaused = false;
      this.isStarting = false;
      this.restarting = null;
      if (was) {
        this.emit("stopped");
      }
    }
    crash(reason: string, attempt = 1): void {
      this.isListening = false;
      this.isStarting = false;
      this.restarting = { attempt, attempts: 3, delayMs: 2000, reason };
      this.emit("restarting", this.restarting);
    }
    fail(message: string): void {
      this.isListening = false;
      this.isStarting = false;
      this.restarting = null;
      this.emit("error", new Error(message));
    }
    cancel(): void {
      this.isStarting = false;
      this.emit("cancelled");
    }
    setDebugMode(on: boolean): void {
      this.debugModes.push(on);
    }
    dispose(): void {
      this.stop();
      this.removeAllListeners();
    }
  }
  return {
    SherpaEngine: Engine,
    MODEL_NAME: "model",
    MODEL_SHA256: "0".repeat(64),
    modelStatus: () => ({ dir: "model", versionFile: "version.txt", present: true }),
    nativeEnginePath: () => "wake-word-engine",
    probeNativeEngine: () => Promise.resolve("self-test OK"),
    listInputDevices: () => Promise.resolve(deviceListing.answer),
  };
});

vi.mock("../../src/lockFile", () => ({
  LOCK_CHECK_INTERVAL_MS: 10_000,
  lockFilePath: (dir: string) => `${dir}/wake-word.lock`,
  tryAcquireLock: () => {
    lock.held = true;
    return true;
  },
  releaseLock: () => {
    lock.held = false;
  },
  readLock: () => ({ kind: "absent" }),
  describeLock: () => "free (no window is listening)",
}));

const WORKBENCH = ["workbench.action.chat.open", "workbench.action.terminal.focus", "workbench.action.quickOpen"];
const CLAUDE_CODE: InstalledExtension = {
  id: "anthropic.claude-code",
  packageJSON: { contributes: { commands: [{ command: "claude-vscode.focus", title: "Focus" }] } },
};
const TERMINAL: WakePhrase = {
  label: "Terminal",
  phrase: "hey computer",
  command: "workbench.action.terminal.focus",
  cooldownSeconds: 30,
};

const world = {
  registered: [] as string[],
  installed: [] as InstalledExtension[],
};

interface Session {
  extension: typeof import("../../src/extension");
  vscode: typeof import("vscode");
  logs: string[];
  errors: string[];
  warnings: string[];
  /** Lines written at the debug level: the verbose log. */
  details: string[];
  /** What was put on the clipboard. */
  clipboard: string[];
  /** Pages opened in the browser. */
  opened: string[];
  /** Information messages shown. */
  infos: string[];
  /** The button the next information message with buttons is answered with. */
  answer: string | undefined;
  status: { text: string; tooltip: unknown; backgroundColor: unknown };
  run(command: string): Promise<unknown>;
  /** Change the output channel's log level, as Developer: Set Log Level does. */
  logLevel(level: number): Promise<void>;
  focus(focused: boolean): Promise<void>;
  changeSettings(...keys: string[]): Promise<void>;
  /** Change a setting's value; changeSettings() then reports the change. */
  set(key: string, value: unknown): void;
  engine(): FakeEngine;
  /** The tooltip as text, whether it is a string or trusted markdown. */
  tooltip(): string;
}

const sessions: Session[] = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function startSession(
  settings: Record<string, unknown> = {},
  remoteName?: string,
  logLevel: number = LEVEL.Info
): Promise<Session> {
  vi.resetModules();
  const vscode = await import("vscode");
  vscode.env.remoteName = remoteName;
  const logs: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const disposable = { dispose: () => undefined };
  const status = { text: "", tooltip: undefined as unknown, backgroundColor: undefined as unknown };
  const values: Record<string, unknown> = {
    enableOnStartup: false,
    showNotificationOnDetection: false,
    ...settings,
  };
  const configuration = {
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
    has: (key: string) => key in values,
    inspect: () => undefined,
    update: () => Promise.resolve(),
  };
  let onWindowState: (state: { focused: boolean }) => void = () => undefined;
  let focused = true;
  let onConfiguration: (event: { affectsConfiguration: (key: string) => boolean }) => void = () => undefined;

  const logChannel = createLogChannel(logs, logLevel);
  const clipboard: string[] = [];
  const opened: string[] = [];
  const infos: string[] = [];
  vi.spyOn(vscode.window, "createOutputChannel").mockReturnValue(logChannel.channel as never);
  vi.spyOn(vscode.env.clipboard, "writeText").mockImplementation(((text: string) => {
    clipboard.push(text);
    return Promise.resolve();
  }) as never);
  vi.spyOn(vscode.env, "openExternal").mockImplementation(((target: { toString(): string }) => {
    opened.push(target.toString());
    return Promise.resolve(true);
  }) as never);
  vi.spyOn(vscode.window, "createStatusBarItem").mockReturnValue({
    ...disposable,
    show: () => undefined,
    set text(value: string) {
      status.text = value;
    },
    get text() {
      return status.text;
    },
    set tooltip(value: unknown) {
      status.tooltip = value;
    },
    get tooltip() {
      return status.tooltip;
    },
    set backgroundColor(value: unknown) {
      status.backgroundColor = value;
    },
    get backgroundColor() {
      return status.backgroundColor;
    },
  } as never);
  vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(((message: string) => {
    warnings.push(message);
    return Promise.resolve(undefined);
  }) as never);
  vi.spyOn(vscode.window, "showInformationMessage").mockImplementation(((message: string, ...buttons: string[]) => {
    infos.push(message);
    return Promise.resolve(buttons.length > 0 ? session.answer : undefined);
  }) as never);
  vi.spyOn(vscode.window, "showErrorMessage").mockImplementation(((message: string) => {
    errors.push(message);
    return Promise.resolve(undefined);
  }) as never);
  vi.spyOn(vscode.window, "withProgress").mockImplementation(((
    _options: unknown,
    task: (progress: unknown, token: unknown) => Promise<unknown>
  ) =>
    task(
      { report: () => undefined },
      { isCancellationRequested: false, onCancellationRequested: () => disposable }
    )) as never);
  vi.spyOn(vscode.window, "onDidChangeWindowState").mockImplementation(((listener: typeof onWindowState) => {
    onWindowState = listener;
    return disposable;
  }) as never);
  vi.spyOn(vscode.window, "state", "get").mockImplementation(() => ({ focused }) as never);
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(configuration as never);
  vi.spyOn(vscode.workspace, "onDidChangeConfiguration").mockImplementation(((listener: typeof onConfiguration) => {
    onConfiguration = listener;
    return disposable;
  }) as never);
  vi.spyOn(vscode.commands, "registerCommand").mockImplementation(((id: string, handler: () => unknown) => {
    handlers.set(id, handler);
    return disposable;
  }) as never);
  vi.spyOn(vscode.commands, "executeCommand").mockImplementation((() => Promise.resolve(undefined)) as never);
  vi.spyOn(vscode.commands, "getCommands").mockImplementation((() => Promise.resolve([...world.registered])) as never);
  vi.spyOn(vscode.extensions, "all", "get").mockImplementation(() => world.installed as never);
  vi.spyOn(vscode.extensions, "onDidChange").mockReturnValue(disposable as never);

  const extension = await import("../../src/extension");
  extension.activate({
    extensionMode: vscode.ExtensionMode.Production,
    subscriptions: [],
    globalStorageUri: { fsPath: "storage" },
    extensionPath: "extension",
    globalState: {
      get: (key: string, fallback?: unknown) => (key === "wakeWord.userConsented" ? true : fallback),
      update: () => Promise.resolve(),
      keys: () => [],
      setKeysForSync: () => undefined,
    },
    extension: {
      packageJSON: { version: "0.0.0-test", bugs: { url: "https://github.com/analyticsinmotion/wake-word/issues" } },
      extensionKind: vscode.ExtensionKind.UI,
    },
  } as never);

  const session: Session = {
    extension,
    vscode,
    logs,
    errors,
    warnings,
    details: logChannel.details,
    clipboard,
    opened,
    infos,
    answer: undefined,
    status,
    async run(command) {
      const result = await handlers.get(command)?.();
      await settle();
      return result;
    },
    async logLevel(level) {
      logChannel.setLevel(level);
      await settle();
    },
    async focus(to) {
      focused = to;
      onWindowState({ focused: to });
      await settle();
    },
    async changeSettings(...keys) {
      Object.assign(values, {});
      onConfiguration({ affectsConfiguration: (key: string) => keys.includes(key) });
      await settle();
    },
    set(key, value) {
      values[key] = value;
    },
    engine: () => engines[engines.length - 1],
    tooltip() {
      const tooltip = status.tooltip as { value?: string } | string | undefined;
      return typeof tooltip === "string" ? tooltip : tooltip?.value ?? "";
    },
  };
  sessions.push(session);
  return session;
}

/** The status bar's claim about the microphone matches the engine's. */
function expectTruthful(session: Session): void {
  const listening = /Wake: (Listening|Confirm|Calibrating)/.test(session.status.text);
  expect(listening, session.status.text).toBe(session.engine().isListening);
}

beforeEach(() => {
  engines.length = 0;
  lock.held = false;
  world.registered = [...WORKBENCH, "claude-vscode.focus"];
  world.installed = [CLAUDE_CODE];
  deviceListing.answer = { kind: "listed", devices: [] };
});

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.extension.deactivate();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the status bar", () => {
  it("shows Starting from the start until the engine is listening", async () => {
    const session = await startSession();
    expect(session.status.text).toBe("$(circle-slash) Wake: Off");

    await session.run("wakeWord.enable");
    expect(session.status.text).toBe("$(loading~spin) Wake: Starting");
    expect(session.tooltip()).toContain("Wake phrases are not heard until the status bar says Listening");
    expectTruthful(session);

    session.engine().ready();
    expect(session.status.text).toBe("$(mic) Wake: Listening");
    expectTruthful(session);
  });

  it("does nothing on a second Enable while a start is under way", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    await session.run("wakeWord.enable");
    expect(session.engine().startedWith).toHaveLength(1);
  });

  it("stops listening on a click while it is starting", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    await session.run("wakeWord.toggle");
    expect(session.engine().stops).toBeGreaterThan(0);
    expect(session.status.text).toBe("$(circle-slash) Wake: Off");
    expect(lock.held).toBe(false);
  });

  it("shows a pause for focus as a pause for focus, not a handoff, and Starting then Listening when focus returns", async () => {
    const session = await startSession({ pauseOnFocusLoss: true });
    await session.run("wakeWord.enable");
    session.engine().ready();

    await session.focus(false);
    expect(session.engine().isPaused).toBe(true);
    expect(session.status.text).toBe("$(circle-slash) Wake: Unfocused");
    expect(session.tooltip()).toContain("paused while this window is not focused");
    expect(session.tooltip()).not.toContain("handed");
    expect(session.status.backgroundColor).toBeUndefined();
    expectTruthful(session);

    await session.focus(true);
    expect(session.engine().resumes).toBe(1);
    expect(session.status.text).toBe("$(loading~spin) Wake: Starting");
    session.engine().ready();
    expect(session.status.text).toBe("$(mic) Wake: Listening");
  });

  it("shows Restarting while the engine is brought back after it stopped, and Listening once it is", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    session.engine().ready();

    session.engine().crash("The microphone stopped responding: device unplugged");
    expect(session.status.text).toBe("$(sync~spin) Wake: Restarting");
    expect(session.tooltip()).toContain("attempt 1 of 3");
    expect(session.errors).toEqual([]);
    expect(
      session.logs.some((line) =>
        line.endsWith(
          "[warning] Speech engine stopped: The microphone stopped responding: device unplugged. " +
            "Restarting in 2s (attempt 1 of 3)."
        )
      )
    ).toBe(true);
    expectTruthful(session);

    session.engine().ready();
    expect(session.status.text).toBe("$(mic) Wake: Listening");
  });

  it("turns listening off on a click while it is restarting", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    session.engine().ready();
    session.engine().crash("exit code 1");
    await session.run("wakeWord.toggle");
    expect(session.status.text).toBe("$(circle-slash) Wake: Off");
    expect(session.engine().restarting).toBeNull();
  });

  it("reports a failure once, with the engine's message in the tooltip, and a click tries again", async () => {
    const message = 'No microphone matching "Desk Mic" was found. Check wakeWord.audioDevice.';
    const session = await startSession();
    await session.run("wakeWord.enable");
    session.engine().fail(message);

    expect(session.errors).toEqual([`Wake Word error: ${message}`]);
    expect(session.status.text).toBe("$(error) Wake: Error");
    expect(session.tooltip()).toContain(message);
    expectTruthful(session);

    await session.run("wakeWord.toggle");
    expect(session.engine().startedWith).toHaveLength(2);
    expect(session.status.text).toBe("$(loading~spin) Wake: Starting");
  });

  it("turns listening off with a log line, and no error, when the model download is cancelled", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    session.engine().cancel();

    expect(session.status.text).toBe("$(circle-slash) Wake: Off");
    expect(session.errors).toEqual([]);
    expect(lock.held).toBe(false);
    expect(
      session.logs.some((line) =>
        line.includes("Model download cancelled: listening is off. Enable listening to download the speech model again.")
      )
    ).toBe(true);
  });

  it("shows the handoff while the microphone is released, then the cooldown", async () => {
    const session = await startSession({ routes: [TERMINAL] });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();
    engine.holdPause = true;

    engine.emit("detected", engine.startedWith[0][0]);
    await settle();
    expect(session.status.text).toBe("$(mic-filled) Wake: Active");
    expectTruthful(session);

    engine.release();
    await settle();
    expect(session.status.text).toBe("$(clock) Wake: 30s");
    expect(session.tooltip()).toContain("handed off to assistant");
  });

  it("applies a routes change that arrives while a cooldown's resume is under way once the engine is listening", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const session = await startSession({ routes: [TERMINAL] });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();
    engine.emit("detected", engine.startedWith[0][0]);
    await settle();

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(engine.resumes).toBe(1);
    expect(session.status.text).toBe("$(loading~spin) Wake: Starting");

    await session.changeSettings("wakeWord.routes");
    expect(
      session.logs.some((line) =>
        line.includes("Routes changed while the engine was starting: applied as soon as it is listening")
      )
    ).toBe(true);
    engine.ready();
    await settle();
    expect(engine.stops).toBeGreaterThan(0);
    expect(engine.startedWith).toHaveLength(2);
  });

  it("puts a focus pause back as a focus pause after Calibrate, not as a handoff", async () => {
    const session = await startSession({ pauseOnFocusLoss: true });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();
    await session.focus(false);
    expect(session.status.text).toBe("$(circle-slash) Wake: Unfocused");

    const calibrating = session.run("wakeWord.calibrate");
    await settle();
    expect(session.status.text).toBe("$(loading~spin) Wake: Starting");
    engine.ready();
    await settle();
    expect(session.status.text).toBe("$(pulse) Wake: Calibrating");

    await session.run("wakeWord.toggle");
    await calibrating;
    expect(session.status.text).toBe("$(circle-slash) Wake: Unfocused");
    expectTruthful(session);
  });

  it("ends a focus pause when focus returns, even if pauseOnFocusLoss was turned off meanwhile", async () => {
    const session = await startSession({ pauseOnFocusLoss: true });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();
    await session.focus(false);
    expect(engine.isPaused).toBe(true);

    // Turned off from another window while this one is not focused.
    session.set("pauseOnFocusLoss", false);
    await session.changeSettings("wakeWord.pauseOnFocusLoss");
    expect(session.status.text).toBe("$(circle-slash) Wake: Unfocused");

    await session.focus(true);
    expect(session.logs.some((line) => line.includes("Resumed: window regained focus"))).toBe(true);
    expect(engine.resumes).toBe(1);
    expect(session.status.text).toBe("$(loading~spin) Wake: Starting");
    engine.ready();
    expect(session.status.text).toBe("$(mic) Wake: Listening");
    expectTruthful(session);
  });

  it("does not resume under a Calibrate run when focus returns, and listens once the run ends", async () => {
    const session = await startSession({ pauseOnFocusLoss: true });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();
    await session.focus(false);

    const calibrating = session.run("wakeWord.calibrate");
    await settle();
    engine.ready();
    await settle();
    expect(session.status.text).toBe("$(pulse) Wake: Calibrating");
    const starts = engine.startedWith.length;
    const resumes = engine.resumes;

    // The run keeps the microphone: nothing is started or resumed under it.
    await session.focus(true);
    expect(engine.startedWith).toHaveLength(starts);
    expect(engine.resumes).toBe(resumes);
    expect(session.status.text).toBe("$(pulse) Wake: Calibrating");

    await session.run("wakeWord.toggle");
    await calibrating;
    expect(engine.isListening).toBe(true);
    expect(session.status.text).toBe("$(mic) Wake: Listening");
    expect(session.logs.some((line) => line.includes("the focus pause no longer applies"))).toBe(true);
    expectTruthful(session);

    // That pause is over, so losing focus again pauses afresh.
    await session.focus(false);
    expect(session.status.text).toBe("$(circle-slash) Wake: Unfocused");
  });

  it("pauses for focus after a Calibrate run that ends while the window is not focused", async () => {
    const session = await startSession({ pauseOnFocusLoss: true });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();

    const calibrating = session.run("wakeWord.calibrate");
    await settle();
    expect(session.status.text).toBe("$(pulse) Wake: Calibrating");
    await session.focus(false);
    // The run keeps the microphone until it ends.
    expect(engine.isListening).toBe(true);
    expect(session.status.text).toBe("$(pulse) Wake: Calibrating");

    await session.run("wakeWord.toggle");
    await calibrating;
    expect(engine.isPaused).toBe(true);
    expect(session.status.text).toBe("$(circle-slash) Wake: Unfocused");
    expectTruthful(session);

    await session.focus(true);
    expect(session.status.text).toBe("$(loading~spin) Wake: Starting");
  });

  it("starts the new engine when the microphone setting changes during a start", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    const first = session.engine();
    expect(session.status.text).toBe("$(loading~spin) Wake: Starting");

    await session.changeSettings("wakeWord.audioDevice");
    expect(engines).toHaveLength(2);
    expect(first.stops).toBeGreaterThan(0);
    expect(session.engine().startedWith).toHaveLength(1);
    expect(session.status.text).toBe("$(loading~spin) Wake: Starting");
  });

  it("says in Show Diagnostics what the status bar says", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    session.engine().ready();
    session.engine().crash("exit code 1", 2);
    await session.run("wakeWord.diagnostics");
    expect(session.logs.some((line) => line.endsWith("State: restarting after the speech engine stopped (attempt 2 of 3)"))).toBe(
      true
    );
  });
});

describe("the engine's context", () => {
  it("gives the engine the editor's name", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    expect(session.engine().args[2]).toBe("Test Editor");
  });

  it("names the editor and the window in the start's log line", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    expect(session.logs.some((line) => /OS: \w+ \w+, VS Code: 0\.0\.0-test \(Test Editor\), window: local$/.test(line))).toBe(
      true
    );
  });
});

describe("a remote window", () => {
  it("listens for a route whose command may be on the remote host, which this host cannot see", async () => {
    // Claude Code runs on the remote host: it is not among this host's
    // extensions, and it has not registered its command yet.
    world.registered = [...WORKBENCH];
    world.installed = [];
    const session = await startSession({}, "wsl");
    await session.run("wakeWord.enable");

    expect(session.engine().startedWith[0].map((route) => route.label)).toEqual(["Claude", "Chat", "Terminal"]);
    expect(session.warnings).toEqual([]);
    expect(
      session.logs.some((line) =>
        line.includes(
          'Route "Claude": claude-vscode.focus is not registered yet. This is a remote window (wsl), and extensions ' +
            "on the remote host cannot be checked from here, so the route is listened for."
        )
      )
    ).toBe(true);
    expect(session.logs.some((line) => line.endsWith("window: remote (wsl); Wake Word runs on the local machine"))).toBe(
      true
    );
  });

  it("still sets aside an editor command that is missing, which every host can see", async () => {
    world.registered = [...WORKBENCH];
    const route: WakePhrase = { label: "Nothing", phrase: "open nothing", command: "workbench.action.nothing" };
    const session = await startSession({ routes: [TERMINAL, route] }, "ssh-remote");
    await session.run("wakeWord.enable");
    expect(session.engine().startedWith[0].map((r) => r.label)).toEqual(["Terminal"]);
    expect(session.warnings).toHaveLength(1);
  });

  it("shows the window and the unverified route in Show Diagnostics", async () => {
    world.registered = [...WORKBENCH];
    world.installed = [];
    const session = await startSession({}, "dev-container");
    await session.run("wakeWord.diagnostics");
    expect(session.logs.some((line) => line.endsWith("Window: remote (dev-container); Wake Word runs on the local machine"))).toBe(
      true
    );
    expect(
      session.logs.some((line) =>
        line.endsWith(
          '"Claude" [hey claude] -> claude-vscode.focus (manual): not verified, remote window (dev-container): ' +
            "its command may be on the remote host"
        )
      )
    ).toBe(true);
    expect(session.logs.some((line) => line.endsWith("Set aside: none"))).toBe(true);
  });
});

describe("the verbose log", () => {
  it("is off at the default log level, and the engine is started without its detail", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    expect(session.engine().debugModes).toEqual([false]);
    expect(session.engine().startedDebug).toEqual([false]);
    expect(session.logs.some((line) => line.includes("verbose log=off"))).toBe(true);
  });

  it("is on from the start when the level is already Debug", async () => {
    const session = await startSession({}, undefined, LEVEL.Debug);
    await session.run("wakeWord.enable");
    expect(session.engine().debugModes).toEqual([true]);
    expect(session.engine().startedDebug).toEqual([true]);
    expect(session.logs.some((line) => line.includes("verbose log=on"))).toBe(true);
  });

  it("follows Developer: Set Log Level while listening, without a restart", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    session.engine().ready();
    const engine = session.engine();

    await session.logLevel(LEVEL.Debug);
    expect(engine.debugModes).toEqual([false, true]);
    expect(session.logs.at(-1)).toBe("[info] Verbose log on (log level: debug)");

    await session.logLevel(LEVEL.Trace);
    expect(engine.debugModes).toEqual([false, true]);

    await session.logLevel(LEVEL.Info);
    expect(engine.debugModes).toEqual([false, true, false]);
    expect(session.logs.at(-1)).toBe("[info] Verbose log off (log level: info)");

    expect(engines).toHaveLength(1);
    expect(engine.startedWith).toHaveLength(1);
    expect(engine.stops).toBe(0);
    expect(session.status.text).toBe("$(mic) Wake: Listening");
  });

  it("follows the level during a handoff too, without taking the microphone back", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    session.engine().ready();
    await session.engine().pause();
    const before = { resumes: session.engine().resumes, starts: session.engine().startedWith.length };
    await session.logLevel(LEVEL.Debug);
    expect(session.engine().debugModes).toEqual([false, true]);
    expect(session.engine().resumes).toBe(before.resumes);
    expect(session.engine().startedWith).toHaveLength(before.starts);
  });

  it("writes the engine's detail at the debug level, only while the level shows it", async () => {
    const session = await startSession();
    await session.run("wakeWord.enable");
    session.engine().emit("detail", "VAD: speech (5 pre-roll chunks)");
    expect(session.details).toEqual([]);

    await session.logLevel(LEVEL.Debug);
    session.engine().emit("detail", "VAD: speech (5 pre-roll chunks)");
    expect(session.details).toEqual(["[debug] VAD: speech (5 pre-roll chunks)"]);
    expect(session.logs.some((line) => line.includes("VAD:"))).toBe(false);
  });

  it("keeps the home directory out of the log", async () => {
    const os = await import("os");
    const session = await startSession({}, undefined, LEVEL.Debug);
    await session.run("wakeWord.enable");
    session.engine().emit("debug", `Spawning: ${os.homedir()}/bin/wake-word-engine`);
    session.engine().emit("detail", `Model already present at ${os.homedir()}/model`);
    expect(session.logs).toContain("[info] Spawning: ~/bin/wake-word-engine");
    expect(session.details).toContain("[debug] Model already present at ~/model");
  });
});

describe("Show Diagnostics and reporting an issue", () => {
  const LISTED = {
    kind: "listed",
    devices: [
      { index: 0, name: "Microphone Array", id: "wasapi:{a}", isDefault: true, channels: 2, sampleRate: 48000 },
      { index: 1, name: "Ann's Headphones", id: "wasapi:{b}", isDefault: false, channels: 1, sampleRate: 16000 },
    ],
  };

  it("lists the input devices, the default marked and a person's name taken out", async () => {
    deviceListing.answer = LISTED;
    const session = await startSession({ audioDevice: "" });
    await session.run("wakeWord.diagnostics");
    const at = session.logs.findIndex((line) => line.includes("Input devices: 2"));
    expect(at).toBeGreaterThan(0);
    expect(session.logs[at + 1]).toBe("[info]   0: Microphone Array, 2 ch, 48000 Hz (system default, selected)");
    expect(session.logs[at + 2]).toBe("[info]   1: <name>'s Headphones, 1 ch, 16000 Hz");
    expect(session.logs.join("\n")).not.toContain("wasapi:");
    expect(session.logs.some((line) => line.endsWith("Log level: info"))).toBe(true);
  });

  it("still writes the whole report when the devices cannot be listed", async () => {
    deviceListing.answer = { kind: "failed", reason: "Could not list the input devices: no audio server" };
    const session = await startSession();
    await session.run("wakeWord.diagnostics");
    expect(
      session.logs.some((line) =>
        line.endsWith("Input devices: could not be listed (Could not list the input devices: no audio server)")
      )
    ).toBe(true);
    expect(session.logs.at(-1)).toBe("[info] === End Diagnostics ===");
  });

  it("says whether the terminal hands the toggle shortcut over", async () => {
    const handed = await startSession({ commandsToSkipShell: ["wakeWord.toggle"] });
    await handed.run("wakeWord.diagnostics");
    expect(handed.logs.some((line) => line.endsWith("Toggle shortcut in the terminal: handled by Wake Word"))).toBe(true);

    const replaced = await startSession({ commandsToSkipShell: ["other.command"] });
    await replaced.run("wakeWord.diagnostics");
    expect(replaced.logs.some((line) => line.includes("Toggle shortcut in the terminal: sent to the shell"))).toBe(true);
  });

  it("takes the report to a new issue: on the clipboard, and a page with fixed text, sending nothing", async () => {
    deviceListing.answer = LISTED;
    const session = await startSession();
    session.answer = "Report Issue";
    await session.run("wakeWord.diagnostics");

    expect(session.clipboard).toHaveLength(1);
    expect(session.clipboard[0].startsWith("```text\n=== Wake Word Diagnostics ===\n")).toBe(true);
    expect(session.clipboard[0].endsWith("=== End Diagnostics ===\n```\n")).toBe(true);
    expect(session.clipboard[0]).toContain("<name>'s Headphones");
    expect(session.clipboard[0]).not.toContain("Ann's");

    expect(session.opened).toHaveLength(1);
    const url = new URL(session.opened[0]);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/analyticsinmotion/wake-word/issues/new");
    expect([...url.searchParams.keys()]).toEqual(["body"]);
    expect(url.searchParams.get("body")).not.toMatch(/Diagnostics ===|Microphone|Headphones|Version:/);
    expect(session.infos.at(-1)).toBe(
      "Wake Word: The diagnostics report is on your clipboard. Paste it into the new issue and read it before you submit."
    );
  });

  it("copies the report as it is for Copy to Clipboard, and opens nothing", async () => {
    const session = await startSession();
    session.answer = "Copy to Clipboard";
    await session.run("wakeWord.diagnostics");
    expect(session.clipboard).toHaveLength(1);
    expect(session.clipboard[0].startsWith("=== Wake Word Diagnostics ===\n")).toBe(true);
    expect(session.opened).toEqual([]);
  });
});
