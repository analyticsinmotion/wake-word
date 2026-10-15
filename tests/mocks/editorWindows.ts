import { vi } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import type { EngineRestart, WakePhrase } from "../../src/speechEngineInterface";
import type { InstalledExtension } from "../../src/wakeWordCore";
import { createLogChannel } from "./logChannel";

/**
 * Editor windows for the tests of how windows share the microphone.
 *
 * Each window is the extension activated in a module graph of its own, as
 * each editor window runs it in an extension host of its own: its own
 * `vscode` module, stubbed, its own engine, and the real lock module, bound
 * to the window's extension host PID, on a storage directory the windows
 * share, as windows of one editor share their global storage.
 *
 * The engine is a stand-in that keeps SherpaEngine's state machine: the
 * child that loads the model and opens the microphone, the PAUSED and
 * RELEASED acknowledgements and their 500 ms timeouts, a resume sent behind
 * a pause, a restart after a crash that a pause calls off, and a crash while
 * paused that is not restarted. It opens and closes a microphone the windows
 * share, after delays that stand for the model load, the device opening, and
 * the device closing, and the microphone records every moment two windows
 * have it at once.
 */

/** The one microphone every window's engine opens. */
export class Microphone {
  /** Windows whose engine has the microphone open, or is opening it. */
  readonly holders = new Set<string>();
  /** Each time a window opened it while another window had it. */
  readonly overlaps: string[] = [];
  opens = 0;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  open(window: string): void {
    const others = [...this.holders].filter((holder) => holder !== window);
    if (others.length > 0) {
      this.overlaps.push(`${window} opened the microphone at ${this.clock()} while ${others.join(", ")} had it open`);
    }
    this.holders.add(window);
    this.opens++;
  }

  close(window: string): void {
    this.holders.delete(window);
  }
}

/** How long the stand-in engine's child takes for each step, in milliseconds. */
export interface EngineTiming {
  /** The model load, from a start until the microphone begins to open. */
  load(): number;
  /** Opening the microphone, until READY. */
  open(): number;
  /** Closing it for a pause, until PAUSED. At 500 or more the child is killed at 500. */
  pause(): number;
  /** Closing it for a stop, until RELEASED. At 500 or more the child is killed at 500. */
  release(): number;
}

const PAUSE_TIMEOUT_MS = 500;
const RELEASE_TIMEOUT_MS = 500;
const RETRY_DELAYS_MS = [2000, 5000, 10000];

interface Child {
  /** The child is opening the microphone or has it open. */
  holds: boolean;
  alive: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Wait {
  promise: Promise<void>;
  settle: () => void;
}

function wait(): Wait {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => (settle = resolve));
  return { promise, settle };
}

/** SherpaEngine's state machine over a stand-in child. See the module comment. */
export class StandInEngine extends EventEmitter {
  isListening = false;
  isPaused = false;
  isStarting = false;
  restarting: EngineRestart | null = null;
  /** The routes of each start. */
  readonly starts: WakePhrase[][] = [];
  resumes = 0;
  stops = 0;

  private phrases: WakePhrase[] = [];
  private child: Child | null = null;
  private childReady = false;
  private childPaused = false;
  /** A resume reached the child while it was still closing for a pause. */
  private resumeBehindPause = false;
  private pauseWait: Wait | null = null;
  private releaseWait: Wait | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private hasListened = false;

  constructor(
    readonly window: string,
    private readonly mic: Microphone,
    private readonly timing: EngineTiming
  ) {
    super();
  }

  start(phrases: WakePhrase[]): Promise<void> {
    if (this.isListening) {
      return Promise.resolve();
    }
    this.restarting = null;
    this.isStarting = true;
    this.starts.push(phrases);
    this.phrases = phrases;
    this.launch();
    return Promise.resolve();
  }

  pause(): Promise<void> {
    if (!this.isListening) {
      if (this.retryTimer) {
        this.clearRetry();
        this.restarting = null;
        this.isPaused = true;
        this.emit("paused");
      }
      return this.pauseWait?.promise ?? this.releaseWait?.promise ?? Promise.resolve();
    }
    this.isPaused = true;
    this.isListening = false;
    this.clearRetry();
    const child = this.child as Child;
    this.childPaused = true;
    this.resumeBehindPause = false;
    this.pauseWait = wait();
    const promise = this.pauseWait.promise;
    const delay = this.timing.pause();
    if (delay >= PAUSE_TIMEOUT_MS) {
      child.timer = setTimeout(() => {
        child.timer = null;
        // No PAUSED in time: the child is killed. A resume sent behind the
        // pause went to it, so a new child is started for that resume.
        const resume = this.resumeBehindPause;
        this.kill(child);
        if (resume && this.isPaused) {
          this.isStarting = true;
          this.launch();
        }
      }, PAUSE_TIMEOUT_MS);
    } else {
      child.timer = setTimeout(() => {
        child.timer = null;
        if (this.child !== child) {
          return;
        }
        child.holds = false;
        this.mic.close(this.window);
        this.takePauseWait()?.();
        if (this.resumeBehindPause) {
          this.resumeBehindPause = false;
          this.openMicrophone(child);
        }
      }, delay);
    }
    this.emit("paused");
    return promise;
  }

  resume(): void {
    if (!this.isPaused || this.phrases.length === 0) {
      return;
    }
    const child = this.child;
    if (child && !this.childPaused) {
      return;
    }
    this.retryCount = 0;
    this.isStarting = true;
    this.resumes++;
    if (child) {
      this.childPaused = false;
      if (this.pauseWait) {
        this.resumeBehindPause = true;
      } else {
        this.openMicrophone(child);
      }
      return;
    }
    this.launch();
  }

  stop(): Promise<void> {
    this.stops++;
    this.clearRetry();
    this.retryCount = 0;
    this.restarting = null;
    this.isStarting = false;
    this.hasListened = false;
    if (this.childReady && this.child) {
      this.releaseThenKill(this.child);
    } else {
      this.kill();
    }
    const released = this.releaseWait?.promise ?? Promise.resolve();
    if (this.isListening || this.isPaused) {
      this.isPaused = false;
      this.isListening = false;
      this.emit("stopped");
    }
    return released;
  }

  setDebugMode(): void {
    // The stand-in has no verbose log.
  }

  dispose(): void {
    this.clearRetry();
    this.kill();
    void this.stop();
    this.removeAllListeners();
  }

  /** The engine hears a route's phrase: a detection, if it is listening. */
  hear(label: string): boolean {
    const route = this.phrases.find((phrase) => phrase.label === label);
    if (!this.isListening || !route) {
      return false;
    }
    this.emit("detected", route, undefined);
    return true;
  }

  /**
   * The child ends on its own, as a crash does: restarted unless it was
   * paused, or leaving after a stop, whose exit no longer reaches the engine.
   */
  crash(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    const wasPaused = this.childPaused;
    const leaving = this.releaseWait !== null;
    this.kill(child);
    if (leaving) {
      return;
    }
    this.isListening = false;
    if (wasPaused) {
      return;
    }
    this.scheduleRestart();
  }

  /**
   * The child reports a fatal error, as a microphone that cannot open does:
   * reported once before the engine has listened, restarted after.
   */
  error(message: string): void {
    const child = this.child;
    if (!child) {
      return;
    }
    if (this.releaseWait !== null) {
      this.kill(child);
      return;
    }
    const wasPaused = this.childPaused;
    this.isListening = false;
    this.kill(child);
    if (wasPaused) {
      this.emit("warning", `Speech engine error while paused: ${message}. The next resume starts it again.`);
      return;
    }
    if (!this.hasListened) {
      this.fail(message);
      return;
    }
    this.scheduleRestart();
  }

  /** Whether this engine's child has the microphone open or is opening it. */
  holdsMicrophone(): boolean {
    return Boolean(this.child?.holds);
  }

  private launch(): void {
    if (this.isListening) {
      return;
    }
    this.clearRetry();
    this.kill();
    const child: Child = { holds: false, alive: true, timer: null };
    this.child = child;
    child.timer = setTimeout(() => this.openMicrophone(child), this.timing.load());
  }

  private openMicrophone(child: Child): void {
    child.timer = null;
    if (this.child !== child || !child.alive) {
      return;
    }
    child.holds = true;
    this.mic.open(this.window);
    child.timer = setTimeout(() => this.ready(child), this.timing.open());
  }

  private ready(child: Child): void {
    child.timer = null;
    if (this.child !== child) {
      return;
    }
    this.childReady = true;
    this.isListening = true;
    this.isPaused = false;
    this.isStarting = false;
    this.restarting = null;
    this.hasListened = true;
    this.retryCount = 0;
    this.emit("started");
  }

  /** stop() on a child that has said READY: it closes the microphone, says RELEASED, and is killed. */
  private releaseThenKill(child: Child): void {
    const pauseSettled = this.takePauseWait();
    this.childReady = false;
    this.childPaused = false;
    this.resumeBehindPause = false;
    this.takeReleaseWait()?.();
    const release = wait();
    this.releaseWait = {
      promise: release.promise,
      settle: () => {
        release.settle();
        pauseSettled?.();
      },
    };
    if (child.timer) {
      clearTimeout(child.timer);
    }
    child.timer = setTimeout(() => this.kill(child), Math.min(this.timing.release(), RELEASE_TIMEOUT_MS));
  }

  /** Kill a child, the current one unless told otherwise: its microphone closes with it. */
  private kill(target: Child | null = this.child): void {
    if (!target) {
      return;
    }
    if (target.timer) {
      clearTimeout(target.timer);
      target.timer = null;
    }
    target.alive = false;
    if (target.holds) {
      target.holds = false;
      this.mic.close(this.window);
    }
    if (this.child === target) {
      this.child = null;
      this.childReady = false;
      this.childPaused = false;
      this.resumeBehindPause = false;
      this.takePauseWait()?.();
      this.takeReleaseWait()?.();
    }
  }

  /** Restart after the next backoff delay, or give up once the restarts have run out. */
  private scheduleRestart(): void {
    if (this.retryCount >= RETRY_DELAYS_MS.length) {
      this.fail("The speech engine stopped unexpectedly and did not recover");
      return;
    }
    const delayMs = RETRY_DELAYS_MS[this.retryCount];
    this.retryCount++;
    this.isStarting = false;
    this.restarting = { attempt: this.retryCount, attempts: RETRY_DELAYS_MS.length, delayMs, reason: "exit code 1" };
    this.emit("restarting", this.restarting);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.launch();
    }, delayMs);
  }

  private fail(message: string): void {
    this.isStarting = false;
    this.restarting = null;
    this.hasListened = false;
    this.retryCount = 0;
    this.emit("error", new Error(message));
  }

  private takePauseWait(): (() => void) | null {
    const pending = this.pauseWait;
    this.pauseWait = null;
    return pending ? pending.settle : null;
  }

  private takeReleaseWait(): (() => void) | null {
    const pending = this.releaseWait;
    this.releaseWait = null;
    return pending ? pending.settle : null;
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

/** What every window of one editor shares. */
export interface Editor {
  /** The global storage directory, where the listener lock is. */
  storage: string;
  mic: Microphone;
  /** Extension host PIDs that are running. */
  live: Set<number>;
  timing: EngineTiming;
  /** Commands registered in every window. */
  registered: string[];
  installed: InstalledExtension[];
  /** The extension's global state, shared by the windows as the editor shares it. */
  globalState: Map<string, unknown>;
}

export interface EditorWindow {
  readonly id: string;
  readonly pid: number;
  readonly logs: string[];
  readonly errors: string[];
  readonly executed: string[];
  readonly engines: StandInEngine[];
  /** The status bar's text. */
  status(): string;
  /** The status bar's tooltip, as text. */
  tooltip(): string;
  isFocused(): boolean;
  isOpen(): boolean;
  /** The editor tells this window it gained or lost focus. */
  focus(focused: boolean): void;
  /** Run one of the extension's commands, as the palette or a click does. */
  run(command: string): Promise<unknown>;
  /** Set a setting's value; changeSettings() then reports the change. */
  set(key: string, value: unknown): void;
  changeSettings(...keys: string[]): void;
  engine(): StandInEngine;
  /** This window's engine hears a route's phrase. */
  hear(label: string): boolean;
  holdsMicrophone(): boolean;
  /** The window closes: the extension deactivates and its host exits. */
  close(): void;
  /**
   * The extension host dies without deactivating: its timers stop, its
   * engine's child sees its stdin close, which it treats as a stop, and
   * exits, and a lock it held stays behind naming a process that is gone.
   */
  crash(): Promise<void>;
}

let handles: Array<() => void> = [];

/**
 * Open a window of `editor`: activate the extension in a module graph of its
 * own, with the lock bound to `pid`, and the window focused or not.
 */
export async function openWindow(
  editor: Editor,
  id: string,
  pid: number,
  options: { settings?: Record<string, unknown>; focused?: boolean } = {}
): Promise<EditorWindow> {
  const engines: StandInEngine[] = [];
  const isAlive = (candidate: number) => editor.live.has(candidate);

  vi.resetModules();
  vi.doMock("../../src/sherpaEngine", () => ({
    SherpaEngine: class extends StandInEngine {
      constructor() {
        super(id, editor.mic, editor.timing);
        engines.push(this);
      }
    },
    MODEL_NAME: "model",
    MODEL_SHA256: "0".repeat(64),
    modelStatus: () => ({ dir: "model", versionFile: "version.txt", present: true }),
    nativeEnginePath: () => "wake-word-engine",
    probeNativeEngine: () => Promise.resolve("self-test OK"),
    listInputDevices: () => Promise.resolve({ kind: "listed", devices: [] }),
  }));
  vi.doMock("../../src/lockFile", async () => {
    const real = await vi.importActual<typeof import("../../src/lockFile")>("../../src/lockFile");
    return {
      ...real,
      tryAcquireLock: (lockPath: string) => real.tryAcquireLock(lockPath, { ownPid: pid, isAlive }),
      releaseLock: (lockPath: string) => real.releaseLock(lockPath, pid),
      describeLock: (state: Parameters<typeof real.describeLock>[0]) => real.describeLock(state, pid, isAlive),
    };
  });

  const vscode = await import("vscode");
  const logs: string[] = [];
  const errors: string[] = [];
  const executed: string[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const disposable = { dispose: () => undefined };
  const status = { text: "", tooltip: undefined as unknown };
  const values: Record<string, unknown> = {
    enableOnStartup: false,
    showNotificationOnDetection: false,
    ...options.settings,
  };
  const configuration = {
    get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
    has: (key: string) => key in values,
    inspect: () => undefined,
    update: () => Promise.resolve(),
  };
  let focused = options.focused ?? true;
  let open = true;
  let onWindowState: (state: { focused: boolean }) => void = () => undefined;
  let onConfiguration: (event: { affectsConfiguration: (key: string) => boolean }) => void = () => undefined;

  const logChannel = createLogChannel(logs);
  vi.spyOn(vscode.window, "createOutputChannel").mockReturnValue(logChannel.channel as never);
  vi.spyOn(vscode.window, "createStatusBarItem").mockReturnValue({
    ...disposable,
    show: () => undefined,
    get text() {
      return status.text;
    },
    set text(value: string) {
      status.text = value;
    },
    get tooltip() {
      return status.tooltip;
    },
    set tooltip(value: unknown) {
      status.tooltip = value;
    },
    backgroundColor: undefined,
  } as never);
  vi.spyOn(vscode.window, "showWarningMessage").mockImplementation((() => Promise.resolve(undefined)) as never);
  vi.spyOn(vscode.window, "showInformationMessage").mockImplementation((() => Promise.resolve(undefined)) as never);
  vi.spyOn(vscode.window, "showErrorMessage").mockImplementation(((message: string) => {
    errors.push(message);
    return Promise.resolve(undefined);
  }) as never);
  vi.spyOn(vscode.window, "withProgress").mockImplementation(((
    _options: unknown,
    task: (progress: unknown, token: unknown) => Promise<unknown>
  ) => task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => disposable })) as never);
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
  vi.spyOn(vscode.commands, "registerCommand").mockImplementation(((command: string, handler: () => unknown) => {
    handlers.set(command, handler);
    return disposable;
  }) as never);
  vi.spyOn(vscode.commands, "executeCommand").mockImplementation(((command: string) => {
    executed.push(command);
    return Promise.resolve(undefined);
  }) as never);
  vi.spyOn(vscode.commands, "getCommands").mockImplementation((() => Promise.resolve([...editor.registered])) as never);
  vi.spyOn(vscode.extensions, "all", "get").mockImplementation(() => editor.installed as never);
  vi.spyOn(vscode.extensions, "onDidChange").mockReturnValue(disposable as never);

  const extension = await import("../../src/extension");
  editor.live.add(pid);
  extension.activate({
    extensionMode: vscode.ExtensionMode.Production,
    subscriptions: [],
    globalStorageUri: { fsPath: editor.storage },
    extensionPath: "extension",
    globalState: {
      get: (key: string, fallback?: unknown) => (editor.globalState.has(key) ? editor.globalState.get(key) : fallback),
      update: (key: string, value: unknown) => {
        editor.globalState.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...editor.globalState.keys()],
      setKeysForSync: () => undefined,
    },
    extension: { packageJSON: { version: "0.0.0-test" }, extensionKind: vscode.ExtensionKind.UI },
  } as never);

  const end = (): void => {
    if (!open) {
      return;
    }
    open = false;
    extension.deactivate();
    editor.live.delete(pid);
  };
  handles.push(end);
  const lockPath = path.join(editor.storage, "wake-word.lock");

  const crash = async (): Promise<void> => {
    if (!open) {
      return;
    }
    // Deactivating stops everything of the extension that would run on, its
    // timers and its engine, as the death of its host does. What a crash
    // does not do is release the lock, so a lock this window held is put
    // back once deactivation has finished releasing it.
    const held = readLockText(lockPath);
    end();
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (held !== null && JSON.parse(held).pid === pid) {
      try {
        fs.writeFileSync(lockPath, held, { flag: "wx" });
      } catch {
        // Another window took the lock meanwhile: it is that window's now.
      }
    }
  };

  return {
    id,
    pid,
    logs,
    errors,
    executed,
    engines,
    status: () => status.text,
    tooltip() {
      const tooltip = status.tooltip as { value?: string } | string | undefined;
      return typeof tooltip === "string" ? tooltip : tooltip?.value ?? "";
    },
    isFocused: () => focused,
    isOpen: () => open,
    focus(to) {
      if (!open || focused === to) {
        return;
      }
      focused = to;
      onWindowState({ focused: to });
    },
    run(command) {
      return Promise.resolve(handlers.get(command)?.());
    },
    set(key, value) {
      values[key] = value;
    },
    changeSettings(...keys) {
      onConfiguration({ affectsConfiguration: (key: string) => keys.includes(key) });
    },
    engine: () => engines[engines.length - 1],
    hear: (label) => open && engines[engines.length - 1].hear(label),
    holdsMicrophone: () => engines.some((engine) => engine.holdsMicrophone()),
    close: end,
    crash,
  };
}

function readLockText(lockPath: string): string | null {
  try {
    return fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
}

/** Close every window a test opened and forget the module mocks. */
export function closeAllWindows(): void {
  for (const close of handles.splice(0)) {
    close();
  }
  handles = [];
  vi.doUnmock("../../src/sherpaEngine");
  vi.doUnmock("../../src/lockFile");
}
