import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "events";
import type { InstalledExtension } from "../../src/wakeWordCore";
import type { WakePhrase } from "../../src/speechEngineInterface";

/**
 * The extension host's side of route availability, driven through
 * activate() with the `vscode` module stubbed per session, a fake engine in
 * place of SherpaEngine, and a fake listener lock. No child process, no file,
 * and no real editor: what is checked is what extension.ts hands the engine,
 * what it tells the user, what it stores, and when it restarts.
 *
 * Each session loads the modules afresh, which is what an editor restart
 * does to the extension's module state; the global state memento is passed
 * from one session to the next, as the editor keeps it.
 */

interface FakeEngine extends EventEmitter {
  isListening: boolean;
  isPaused: boolean;
  startedWith: WakePhrase[][];
  resumes: number;
  stops: number;
  /** The child reports READY. */
  ready(): void;
}

const engines = vi.hoisted(() => [] as FakeEngine[]);
const lock = vi.hoisted(() => ({ held: false, releases: 0 }));

vi.mock("../../src/sherpaEngine", async () => {
  const { EventEmitter } = await import("events");
  class Engine extends EventEmitter {
    isListening = false;
    isPaused = false;
    startedWith: WakePhrase[][] = [];
    resumes = 0;
    stops = 0;
    constructor() {
      super();
      engines.push(this as unknown as FakeEngine);
    }
    start(phrases: WakePhrase[]): Promise<void> {
      this.startedWith.push(phrases);
      return Promise.resolve();
    }
    ready(): void {
      this.isListening = true;
      this.isPaused = false;
      this.emit("started");
    }
    pause(): Promise<void> {
      if (this.isListening) {
        this.isListening = false;
        this.isPaused = true;
        this.emit("paused");
      }
      return Promise.resolve();
    }
    resume(): void {
      this.resumes++;
    }
    stop(): void {
      this.stops++;
      const was = this.isListening || this.isPaused;
      this.isListening = false;
      this.isPaused = false;
      if (was) {
        this.emit("stopped");
      }
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
    lock.releases++;
  },
  readLock: () => ({ kind: "absent" }),
  describeLock: () => "free (no window is listening)",
}));

const CONSENT_KEY = "wakeWord.userConsented";
const TOLD_KEY = "wakeWord.setAsideNotified";
const WORKBENCH = ["workbench.action.chat.open", "workbench.action.terminal.focus", "workbench.action.quickOpen"];

const CLAUDE_CODE: InstalledExtension = {
  id: "anthropic.claude-code",
  packageJSON: {
    activationEvents: ["onStartupFinished"],
    contributes: { commands: [{ command: "claude-vscode.focus", title: "Focus" }] },
  },
};

const SEARCH: WakePhrase = { label: "Search", phrase: "search files", command: "example.search" };
const SEARCH_EXTENSION: InstalledExtension = {
  id: "example.search-tools",
  packageJSON: { contributes: { commands: [{ command: "example.search", title: "Search" }] } },
};

/** What is installed and registered in the editor. Shared by every session, as a machine is. */
const world = {
  registered: [] as string[],
  installed: [] as InstalledExtension[],
  /** Replaces getCommands() for one test that holds its answer back. */
  getCommands: null as null | (() => Promise<string[]>),
};

/** The extension's global state, kept across sessions as the editor keeps it. */
class Memento {
  readonly values = new Map<string, unknown>([[CONSENT_KEY, true]]);
  readonly updated: string[] = [];
  readonly synced: string[][] = [];
  get(key: string, fallback?: unknown): unknown {
    return this.values.has(key) ? this.values.get(key) : fallback;
  }
  update(key: string, value: unknown): Promise<void> {
    this.updated.push(key);
    this.values.set(key, value);
    return Promise.resolve();
  }
  keys(): string[] {
    return [...this.values.keys()];
  }
  setKeysForSync(keys: readonly string[]): void {
    this.synced.push([...keys]);
  }
}

interface Session {
  extension: typeof import("../../src/extension");
  logs: string[];
  warnings: string[];
  executed: string[];
  status: { text: string };
  /** Every write to the user's settings, of which there must be none. */
  settingsWrites: ReturnType<typeof vi.fn>;
  run(command: string): Promise<unknown>;
  extensionsChanged(): Promise<void>;
  engine(): FakeEngine;
}

const sessions: Session[] = [];

/** Let every promise chain started so far run to its end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function labels(routes: readonly WakePhrase[] | undefined): string[] {
  return (routes ?? []).map((route) => route.label);
}

async function startSession(memento: Memento, settings: Record<string, unknown> = {}): Promise<Session> {
  vi.resetModules();
  const vscode = await import("vscode");
  const logs: string[] = [];
  const warnings: string[] = [];
  const executed: string[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const disposable = { dispose: () => undefined };
  const status = { text: "", tooltip: undefined as unknown, backgroundColor: undefined as unknown, command: "", name: "" };
  const values: Record<string, unknown> = {
    enableOnStartup: false,
    showNotificationOnDetection: false,
    ...settings,
  };
  const settingsWrites = vi.fn(() => Promise.resolve());
  const configuration = {
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
    has: (key: string) => key in values,
    inspect: () => undefined,
    update: settingsWrites,
  };
  let onExtensions: () => void = () => undefined;

  vi.spyOn(vscode.window, "createOutputChannel").mockReturnValue({
    appendLine: (line: string) => logs.push(line),
    show: () => undefined,
    dispose: () => undefined,
  } as never);
  vi.spyOn(vscode.window, "createStatusBarItem").mockReturnValue({
    ...disposable,
    show: () => undefined,
    get text() {
      return status.text;
    },
    set text(value: string) {
      status.text = value;
    },
  } as never);
  vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(((message: string) => {
    warnings.push(message);
    return Promise.resolve(undefined);
  }) as never);
  vi.spyOn(vscode.window, "showInformationMessage").mockImplementation((() => Promise.resolve(undefined)) as never);
  vi.spyOn(vscode.window, "showErrorMessage").mockImplementation((() => Promise.resolve(undefined)) as never);
  vi.spyOn(vscode.window, "onDidChangeWindowState").mockReturnValue(disposable as never);
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(configuration as never);
  vi.spyOn(vscode.workspace, "onDidChangeConfiguration").mockReturnValue(disposable as never);
  vi.spyOn(vscode.commands, "registerCommand").mockImplementation(((id: string, handler: () => unknown) => {
    handlers.set(id, handler);
    return disposable;
  }) as never);
  vi.spyOn(vscode.commands, "executeCommand").mockImplementation(((id: string) => {
    executed.push(id);
    return Promise.resolve(undefined);
  }) as never);
  vi.spyOn(vscode.commands, "getCommands").mockImplementation((() =>
    world.getCommands ? world.getCommands() : Promise.resolve([...world.registered])) as never);
  vi.spyOn(vscode.extensions, "all", "get").mockImplementation(() => world.installed as never);
  vi.spyOn(vscode.extensions, "onDidChange").mockImplementation(((listener: () => void) => {
    onExtensions = listener;
    return disposable;
  }) as never);

  const extension = await import("../../src/extension");
  extension.activate({
    extensionMode: vscode.ExtensionMode.Production,
    subscriptions: [],
    globalStorageUri: { fsPath: "storage" },
    extensionPath: "extension",
    globalState: memento,
    extension: { packageJSON: { version: "0.0.0-test" } },
  } as never);

  const session: Session = {
    extension,
    logs,
    warnings,
    executed,
    status,
    settingsWrites,
    async run(command) {
      const result = await handlers.get(command)?.();
      await settle();
      return result;
    },
    async extensionsChanged() {
      onExtensions();
      await settle();
    },
    engine: () => engines[engines.length - 1],
  };
  sessions.push(session);
  return session;
}

beforeEach(() => {
  engines.length = 0;
  lock.held = false;
  lock.releases = 0;
  world.registered = [...WORKBENCH];
  world.installed = [];
  world.getCommands = null;
});

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.extension.deactivate();
    expect(session.settingsWrites).not.toHaveBeenCalled();
  }
  vi.restoreAllMocks();
});

describe("route availability in the extension host", () => {
  it("listens for the Claude route when Claude Code is installed but has not registered its commands yet", async () => {
    world.installed = [CLAUDE_CODE];
    const session = await startSession(new Memento());
    await session.run("wakeWord.enable");

    expect(labels(session.engine().startedWith[0])).toEqual(["Claude", "Chat", "Terminal"]);
    expect(session.warnings).toEqual([]);
    expect(session.logs.some((line) => line.includes('Route "Claude": claude-vscode.focus is not registered yet'))).toBe(
      true
    );
  });

  it("sets the Claude route aside without Claude Code, and tells the user once, not again after a restart", async () => {
    const memento = new Memento();
    const first = await startSession(memento);
    await first.run("wakeWord.enable");

    expect(labels(first.engine().startedWith[0])).toEqual(["Chat", "Terminal"]);
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toContain('"Claude"');
    expect(first.warnings[0]).toContain("claude-vscode.focus");
    expect(first.warnings[0]).toContain("Claude Code (anthropic.claude-code)");
    expect(first.logs.some((line) => line.includes("Starting: 2 routes, 1 set aside"))).toBe(true);
    first.extension.deactivate();
    sessions.splice(sessions.indexOf(first), 1);

    const second = await startSession(memento);
    await second.run("wakeWord.enable");
    expect(labels(second.engine().startedWith[0])).toEqual(["Chat", "Terminal"]);
    expect(second.warnings).toEqual([]);
    // The new session's log still says why.
    expect(second.logs.some((line) => line.includes('Route "Claude" set aside'))).toBe(true);
  });

  it("remembers what the user was told in global state, on this machine only, and never in settings", async () => {
    const memento = new Memento();
    const session = await startSession(memento);
    await session.run("wakeWord.enable");

    expect(memento.get(TOLD_KEY)).toEqual([["Claude", "claude-vscode.focus", "action-missing"]]);
    expect(new Set(memento.updated)).toEqual(new Set([TOLD_KEY]));
    expect(memento.synced).toEqual([]);
    expect(session.settingsWrites).not.toHaveBeenCalled();
  });

  it("brings the route back without a restart when Claude Code is installed", async () => {
    const session = await startSession(new Memento());
    await session.run("wakeWord.enable");
    session.engine().ready();

    world.installed = [CLAUDE_CODE];
    await session.extensionsChanged();

    // Stopped and started again, as for a routes change, with the Claude
    // route in; Claude Code has not registered its commands at this point.
    expect(session.engine().stops).toBeGreaterThan(0);
    expect(labels(session.engine().startedWith.at(-1))).toEqual(["Claude", "Chat", "Terminal"]);
    expect(session.logs.some((line) => line.includes('Route "Claude" is back'))).toBe(true);
    expect(session.logs.some((line) => line.includes("Command availability changed: restarting listening"))).toBe(
      true
    );
    expect(session.warnings).toHaveLength(1);
  });

  it("does nothing when an extension change leaves the routes as they are", async () => {
    world.installed = [CLAUDE_CODE];
    const session = await startSession(new Memento());
    await session.run("wakeWord.enable");
    session.engine().ready();

    world.installed = [CLAUDE_CODE, SEARCH_EXTENSION];
    await session.extensionsChanged();

    expect(session.engine().startedWith).toHaveLength(1);
    expect(session.engine().stops).toBe(0);
  });

  it("does not interrupt a manual handoff when a route is set aside, and applies it at the resume", async () => {
    world.registered = [...WORKBENCH, "claude-vscode.focus"];
    world.installed = [CLAUDE_CODE];
    const session = await startSession(new Memento());
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();

    // "Hey Claude": the microphone is released, the command runs, and the
    // manual handoff waits for the user.
    engine.emit("detected", engine.startedWith[0][0]);
    await settle();
    expect(session.executed).toEqual(["claude-vscode.focus"]);
    expect(session.status.text).toContain("Wake: Paused");

    world.registered = [...WORKBENCH];
    world.installed = [];
    await session.extensionsChanged();

    // Told at once, but the engine is left paused: no start, no resume.
    expect(session.warnings).toHaveLength(1);
    expect(engine.startedWith).toHaveLength(1);
    expect(engine.resumes).toBe(0);
    expect(engine.isPaused).toBe(true);
    expect(session.status.text).toContain("Wake: Paused");
    expect(
      session.logs.some((line) =>
        line.includes("Command availability changed while listening was paused: applied when listening resumes")
      )
    ).toBe(true);

    await session.run("wakeWord.toggle");
    expect(engine.resumes).toBe(0);
    expect(labels(engine.startedWith.at(-1))).toEqual(["Chat", "Terminal"]);
  });

  it("resumes the paused engine as it was when nothing changed during the handoff", async () => {
    world.registered = [...WORKBENCH, "claude-vscode.focus"];
    world.installed = [CLAUDE_CODE];
    const session = await startSession(new Memento());
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();
    engine.emit("detected", engine.startedWith[0][0]);
    await settle();

    await session.run("wakeWord.toggle");
    expect(engine.resumes).toBe(1);
    expect(engine.startedWith).toHaveLength(1);
  });

  it("checks the commands at the resume, for a command registered during the handoff with no extension change", async () => {
    const terminal: WakePhrase = { ...engineRoute("Terminal"), handoff: "manual" };
    const session = await startSession(new Memento(), { routes: [terminal, SEARCH] });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    expect(labels(engine.startedWith[0])).toEqual(["Terminal"]);
    engine.ready();
    engine.emit("detected", engine.startedWith[0][0]);
    await settle();

    world.registered = [...WORKBENCH, "example.search"];
    await session.run("wakeWord.toggle");
    expect(engine.resumes).toBe(0);
    expect(labels(engine.startedWith.at(-1))).toEqual(["Terminal", "Search"]);
  });

  it("opens no microphone when every route is set aside, says so, and starts once a command appears", async () => {
    const session = await startSession(new Memento(), { routes: [SEARCH] });
    await session.run("wakeWord.enable");

    expect(session.engine().startedWith).toEqual([]);
    expect(session.warnings).toHaveLength(1);
    expect(session.warnings[0]).toMatch(/^Wake Word is not listening: none of the routes' commands are available/);
    expect(session.warnings[0]).toContain("no installed extension provides example.search");
    expect(session.status.text).toBe("$(circle-slash) Wake: No commands");
    expect(lock.held).toBe(false);

    // Asking again says so again: the request would otherwise do nothing.
    await session.run("wakeWord.enable");
    expect(session.warnings).toHaveLength(2);

    world.installed = [SEARCH_EXTENSION];
    await session.extensionsChanged();
    expect(labels(session.engine().startedWith[0])).toEqual(["Search"]);
    expect(
      session.logs.some((line) =>
        line.includes("Command availability changed while waiting for a route's command: checking the routes again")
      )
    ).toBe(true);
  });

  it("does not repeat the every-route message on a start nobody asked for", async () => {
    const memento = new Memento();
    const first = await startSession(memento, { routes: [SEARCH] });
    await first.run("wakeWord.enable");
    expect(first.warnings).toHaveLength(1);
    first.extension.deactivate();
    sessions.splice(sessions.indexOf(first), 1);

    // The next editor start listens on its own, from enableOnStartup.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const second = await startSession(memento, { routes: [SEARCH], enableOnStartup: true });
      vi.advanceTimersByTime(1000);
      vi.useRealTimers();
      await settle();
      expect(second.warnings).toEqual([]);
      expect(second.status.text).toBe("$(circle-slash) Wake: No commands");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks phrases only for the routes listened for", async () => {
    const routes: WakePhrase[] = [
      { label: "Claude", phrase: "hey claude", command: "claude-vscode.focus" },
      { label: "Short", phrase: "claude", command: "workbench.action.quickOpen" },
    ];
    const session = await startSession(new Memento(), { routes });
    await session.run("wakeWord.enable");
    session.engine().ready();
    expect(session.logs.some((line) => line.includes("Phrase collision"))).toBe(false);

    world.installed = [CLAUDE_CODE];
    await session.extensionsChanged();
    expect(
      session.logs.some((line) =>
        line.includes('Phrase collision: "claude" (Short) is contained within "hey claude" (Claude)')
      )
    ).toBe(true);
  });

  it("opens no microphone when listening is disabled while the commands are being read", async () => {
    let answer: (commands: string[]) => void = () => undefined;
    world.getCommands = () => new Promise((resolve) => (answer = resolve));
    const session = await startSession(new Memento());

    const enabling = session.run("wakeWord.enable");
    await settle();
    await session.run("wakeWord.disable");
    answer([...WORKBENCH]);
    await enabling;

    expect(session.engine().startedWith).toEqual([]);
    expect(lock.held).toBe(false);
    expect(session.status.text).toBe("$(circle-slash) Wake: Off");
  });

  it("lists the routes set aside in Show Diagnostics", async () => {
    const session = await startSession(new Memento());
    await session.run("wakeWord.diagnostics");
    const at = session.logs.findIndex((line) => line.endsWith("Set aside: 1 route, not listened for"));
    expect(at).toBeGreaterThan(0);
    expect(session.logs[at + 1]).toContain(
      '"Claude" [hey claude] -> claude-vscode.focus (manual): action-missing, ' +
        "claude-vscode.focus needs Claude Code (anthropic.claude-code), which is not installed or is disabled"
    );
    expect(session.logs.some((line) => line.endsWith("Routes: 3 (defaults)"))).toBe(true);
  });
});

/** A default route by label, copied so a test can change it. */
function engineRoute(label: string): WakePhrase {
  const route = [
    { label: "Chat", phrase: ["hey chat", "open chat"], command: "workbench.action.chat.open" },
    { label: "Terminal", phrase: ["hey computer", "open terminal"], command: "workbench.action.terminal.focus" },
  ].find((r) => r.label === label);
  if (!route) {
    throw new Error(`no route ${label}`);
  }
  return { ...route };
}
