import { vi } from "vitest";
import { EventEmitter } from "events";
import type { WakePhrase } from "../../src/speechEngineInterface";
import type { InstalledExtension } from "../../src/wakeWordCore";
import { createLogChannel } from "./logChannel";

/**
 * One editor session of the extension, for tests that drive activate(): the
 * `vscode` module stubbed for the session, a fake engine in place of
 * SherpaEngine, and a fake listener lock. No child process, no file, and no
 * real editor: what is checked is what extension.ts hands the engine, what it
 * logs and tells the user, and what it writes to the settings.
 *
 * Settings are kept per scope, as the editor keeps them. A read gives the
 * workspace value over the user value, a write goes to the scope it names
 * and is reported to the extension as a change, and every write is recorded.
 *
 * Each session loads the modules afresh, which is what an editor restart does
 * to the extension's module state.
 */

/** What is installed and registered in the editor. */
export interface World {
  registered: string[];
  installed: InstalledExtension[];
}

/**
 * The `wakeWord` settings by scope, without the `wakeWord.` prefix.
 * `workspace` is null when no workspace is open.
 */
export interface Scopes {
  user: Record<string, unknown>;
  workspace: Record<string, unknown> | null;
}

/** One call to `WorkspaceConfiguration.update()`. */
export interface SettingsWrite {
  key: string;
  value: unknown;
  /** `vscode.ConfigurationTarget`, as the extension passed it. */
  target: unknown;
}

/** One quick pick shown: its items and options, as the extension passed them. */
export interface QuickPickShown {
  items: Array<{ label: string; description?: string; detail?: string; picked?: boolean }>;
  options: { title?: string; placeHolder?: string; canPickMany?: boolean } | undefined;
}

/** A stand-in for SherpaEngine with its state machine reduced to the flags the extension reads. */
export class FakeEngine extends EventEmitter {
  isListening = false;
  isPaused = false;
  isStarting = false;
  restarting = null;
  /** The routes each start was given, in order. */
  startedWith: WakePhrase[][] = [];
  /** The threshold each start was given, in order. */
  thresholds: number[] = [];
  resumes = 0;
  stops = 0;

  start(phrases: WakePhrase[], threshold: number): Promise<void> {
    this.startedWith.push(phrases);
    this.thresholds.push(threshold);
    this.isStarting = true;
    return Promise.resolve();
  }

  /** The engine reports READY. */
  ready(): void {
    this.isListening = true;
    this.isPaused = false;
    this.isStarting = false;
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
    if (this.isPaused) {
      this.isStarting = true;
    }
  }

  stop(): Promise<void> {
    this.stops++;
    const was = this.isListening || this.isPaused;
    this.isListening = false;
    this.isPaused = false;
    this.isStarting = false;
    if (was) {
      this.emit("stopped");
    }
    return Promise.resolve();
  }

  setDebugMode(): void {
    // The verbose log is not under test here.
  }

  dispose(): void {
    void this.stop();
    this.removeAllListeners();
  }
}

/** The extension's global state, which the editor keeps across sessions. Consent is given. */
export class Memento {
  readonly values = new Map<string, unknown>([["wakeWord.userConsented", true]]);
  readonly updated: string[] = [];
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
  setKeysForSync(): void {
    throw new Error("the extension keeps its global state on this machine");
  }
}

export interface SessionOptions {
  /** The user and workspace settings. Nothing starts on its own unless `enableOnStartup` is set. */
  scopes?: Partial<Scopes>;
  world: World;
  memento?: Memento;
  /** `vscode.env.remoteName`: set for a remote window. */
  remoteName?: string;
}

export interface Session {
  extension: typeof import("../../src/extension");
  /** Output channel lines at info, warning, and error, each marked with its level. */
  logs: string[];
  warnings: string[];
  infos: string[];
  errors: string[];
  executed: string[];
  status: { text: string; tooltip: unknown };
  /** The listener lock: whether this window holds it, and how often it gave it up. */
  lock: { held: boolean; releases: number };
  memento: Memento;
  scopes: Scopes;
  writes: SettingsWrite[];
  quickPicks: QuickPickShown[];
  /** Answers the next quick pick: the items picked, or undefined to cancel. */
  choose: ((items: QuickPickShown["items"]) => QuickPickShown["items"] | undefined) | null;
  /** The button a notification with buttons answers with. */
  answer: string | undefined;
  run(command: string): Promise<unknown>;
  /** Change a setting in one scope without telling the extension; see changeSettings(). */
  set(key: string, value: unknown, scope?: keyof Scopes): void;
  /** Tell the extension that these settings changed, by their full names. */
  changeSettings(...keys: string[]): Promise<void>;
  extensionsChanged(): Promise<void>;
  engine(): FakeEngine;
  /** The tooltip as text, whether it is a string or trusted markdown. */
  tooltip(): string;
  end(): void;
}

const open: Session[] = [];

/** Let every promise chain started so far run to its end. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function startSession(options: SessionOptions): Promise<Session> {
  const engines: FakeEngine[] = [];
  vi.resetModules();
  vi.doMock("../../src/sherpaEngine", () => ({
    SherpaEngine: class extends FakeEngine {
      constructor() {
        super();
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
  const lock = { held: false, releases: 0 };
  vi.doMock("../../src/lockFile", () => ({
    lockCheckDelay: () => 10_000,
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

  const vscode = await import("vscode");
  vscode.env.remoteName = options.remoteName;
  const scopes: Scopes = {
    user: { enableOnStartup: false, showNotificationOnDetection: false, ...options.scopes?.user },
    workspace: options.scopes?.workspace === undefined ? null : options.scopes.workspace,
  };
  const memento = options.memento ?? new Memento();
  const logs: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const executed: string[] = [];
  const writes: SettingsWrite[] = [];
  const quickPicks: QuickPickShown[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const disposable = { dispose: () => undefined };
  const status = { text: "", tooltip: undefined as unknown };
  const answers: Pick<Session, "choose" | "answer"> = { choose: null, answer: undefined };
  let onConfiguration: (event: { affectsConfiguration: (key: string) => boolean }) => void = () => undefined;
  let onExtensions: () => void = () => undefined;

  const fire = (keys: readonly string[]): void => {
    onConfiguration({
      affectsConfiguration: (section: string) => keys.some((key) => key === section || key.startsWith(section + ".")),
    });
  };
  const configuration = {
    get: (key: string, fallback?: unknown) => {
      if (scopes.workspace && key in scopes.workspace) {
        return scopes.workspace[key];
      }
      return key in scopes.user ? scopes.user[key] : fallback;
    },
    has: (key: string) => key in scopes.user || (scopes.workspace !== null && key in scopes.workspace),
    inspect: (key: string) => ({
      key: `wakeWord.${key}`,
      globalValue: scopes.user[key],
      workspaceValue: scopes.workspace?.[key],
    }),
    update: (key: string, value: unknown, target: unknown) => {
      writes.push({ key, value, target });
      let scope: Record<string, unknown>;
      if (target === vscode.ConfigurationTarget.Global || target === true) {
        scope = scopes.user;
      } else if (target === vscode.ConfigurationTarget.Workspace || target === false) {
        if (!scopes.workspace) {
          return Promise.reject(new Error("Unable to write to Workspace Settings because no workspace is opened."));
        }
        scope = scopes.workspace;
      } else {
        return Promise.reject(new Error(`unexpected configuration target ${String(target)}`));
      }
      if (value === undefined) {
        delete scope[key];
      } else {
        scope[key] = value;
      }
      fire([`wakeWord.${key}`]);
      return Promise.resolve();
    },
  };

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
  const message =
    (into: string[]) =>
    (text: string, ...buttons: unknown[]): Promise<string | undefined> => {
      into.push(text);
      const named = buttons.filter((button) => typeof button === "string");
      return Promise.resolve(named.includes(answers.answer) ? answers.answer : undefined);
    };
  vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(message(warnings) as never);
  vi.spyOn(vscode.window, "showInformationMessage").mockImplementation(message(infos) as never);
  vi.spyOn(vscode.window, "showErrorMessage").mockImplementation(message(errors) as never);
  vi.spyOn(vscode.window, "showQuickPick").mockImplementation(((
    items: QuickPickShown["items"] | Promise<QuickPickShown["items"]>,
    pickOptions: QuickPickShown["options"]
  ) =>
    Promise.resolve(items).then((list) => {
      quickPicks.push({ items: list, options: pickOptions });
      const choose = answers.choose;
      answers.choose = null;
      return choose ? choose(list) : undefined;
    })) as never);
  vi.spyOn(vscode.window, "withProgress").mockImplementation(((
    _options: unknown,
    task: (progress: unknown, token: unknown) => Promise<unknown>
  ) =>
    task(
      { report: () => undefined },
      { isCancellationRequested: false, onCancellationRequested: () => disposable }
    )) as never);
  vi.spyOn(vscode.window, "onDidChangeWindowState").mockReturnValue(disposable as never);
  vi.spyOn(vscode.window, "state", "get").mockImplementation(() => ({ focused: true }) as never);
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(configuration as never);
  vi.spyOn(vscode.workspace, "onDidChangeConfiguration").mockImplementation(((listener: typeof onConfiguration) => {
    onConfiguration = listener;
    return disposable;
  }) as never);
  vi.spyOn(vscode.commands, "registerCommand").mockImplementation(((id: string, handler: () => unknown) => {
    handlers.set(id, handler);
    return disposable;
  }) as never);
  vi.spyOn(vscode.commands, "executeCommand").mockImplementation(((id: string) => {
    executed.push(id);
    return Promise.resolve(undefined);
  }) as never);
  vi.spyOn(vscode.commands, "getCommands").mockImplementation((() =>
    Promise.resolve([...options.world.registered])) as never);
  vi.spyOn(vscode.extensions, "all", "get").mockImplementation(() => options.world.installed as never);
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
    extension: { packageJSON: { version: "0.0.0-test" }, extensionKind: vscode.ExtensionKind.UI },
  } as never);

  let ended = false;
  const session: Session = {
    extension,
    logs,
    warnings,
    infos,
    errors,
    executed,
    status,
    lock,
    memento,
    scopes,
    writes,
    quickPicks,
    get choose() {
      return answers.choose;
    },
    set choose(value) {
      answers.choose = value;
    },
    get answer() {
      return answers.answer;
    },
    set answer(value) {
      answers.answer = value;
    },
    async run(command) {
      const result = await handlers.get(command)?.();
      await settle();
      return result;
    },
    set(key, value, scope = "user") {
      const target = scope === "workspace" ? scopes.workspace : scopes.user;
      if (!target) {
        throw new Error("no workspace is open");
      }
      if (value === undefined) {
        delete target[key];
      } else {
        target[key] = value;
      }
    },
    async changeSettings(...keys) {
      fire(keys);
      await settle();
    },
    async extensionsChanged() {
      onExtensions();
      await settle();
    },
    engine: () => engines[engines.length - 1],
    tooltip() {
      const tooltip = status.tooltip as { value?: string } | string | undefined;
      return typeof tooltip === "string" ? tooltip : tooltip?.value ?? "";
    },
    end() {
      if (!ended) {
        ended = true;
        extension.deactivate();
      }
    },
  };
  open.push(session);
  return session;
}

/** End every session a test started and forget the module mocks. */
export function endSessions(): void {
  for (const session of open.splice(0)) {
    session.end();
  }
  vi.doUnmock("../../src/sherpaEngine");
  vi.doUnmock("../../src/lockFile");
  vi.restoreAllMocks();
}
