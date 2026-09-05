import * as vscode from "vscode";
import * as os from "os";
import { WakePhrase, ISpeechEngine } from "./speechEngineInterface";
import { WindowsSpeechEngine } from "./windowsSpeechEngine";
import { SherpaEngine } from "./sherpaEngine";
import {
  DETECTION_DEBOUNCE_MS,
  SessionStats,
  clampThreshold,
  createSessionStats,
  formatConfidence,
  formatSessionStats,
  recordDetection,
  resolveRoutes,
  selectEngineKind,
  shouldDebounce,
} from "./wakeWordCore";
import {
  LOCK_CHECK_INTERVAL_MS,
  lockFilePath,
  releaseLock,
  tryAcquireLock,
} from "./lockFile";

let statusBarItem: vscode.StatusBarItem;
let engineBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let countdownRemaining = 0;
let speechEngine: ISpeechEngine;
let isStarting = false;
let isDevMode = false;
let isPausedByFocus = false;
let lastDetectionTime = 0;
let lockPath = "";
let lockWatchTimer: ReturnType<typeof setInterval> | null = null;
let sessionStats: SessionStats = createSessionStats();
let warnedDeviceIgnored = false;

// ── Default routes ──────────────────────────────────────────

export const DEFAULT_ROUTES: WakePhrase[] = [
  {
    label: "Claude",
    phrase: "hey claude",
    command: "claude-vscode.focus",
  },
  {
    label: "Copilot",
    phrase: "hey copilot",
    command: "workbench.action.chat.open",
  },
  {
    label: "Terminal",
    // "Hey Computer", not "Computer": a single common English word triggers
    // on ordinary speech far too readily for an always-listening extension.
    phrase: "hey computer",
    command: "workbench.action.terminal.focus",
  },
];

// ── Engine factory ───────────────────────────────────────────

function createEngine(context: vscode.ExtensionContext): ISpeechEngine {
  const config = vscode.workspace.getConfiguration("wakeWord");
  const nodePath = config.get<string>("nodePath", "");
  const engineOverride = config.get<string>("engine", "auto");

  if (selectEngineKind(engineOverride, os.platform()) === "windows") {
    return new WindowsSpeechEngine();
  }
  return new SherpaEngine(context, nodePath, readAudioDevice(config));
}

/**
 * The configured microphone, trimmed, always as a string.
 *
 * The schema says string, but settings.json is not validated against it, so
 * a bare number is accepted and rendered as its digits; the child reads a
 * digit-only string as a device index.
 */
function readAudioDevice(config: vscode.WorkspaceConfiguration): string {
  const value = config.get<unknown>("audioDevice", "");
  return value === undefined || value === null ? "" : String(value).trim();
}

// ── Engine wiring ────────────────────────────────────────────

function wireEngine(engine: ISpeechEngine): void {
  engine.on("detected", (phrase: WakePhrase, confidence?: number) => {
    onWakeWordDetected(phrase, confidence);
  });
  engine.on("started", () => {
    sessionStats.engineStarts++;
    setStatusBar("listening");
  });
  engine.on("paused", () => setStatusBar("handed-off"));
  engine.on("stopped", () => setStatusBar("off"));
  engine.on("debug", (info: string) => log("info", info));
  engine.on("warning", (msg: string) => log("warn", msg));
  engine.on("error", (err: Error) => {
    sessionStats.errors++;
    log("error", err.message);
    vscode.window.showErrorMessage(`Wake Word error: ${err.message}`, "Show Log").then((choice) => {
      if (choice === "Show Log") {
        outputChannel.show();
      }
    });
    setStatusBar("error");
  });
}

// ── Activation ──────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  isDevMode = context.extensionMode === vscode.ExtensionMode.Development;
  console.log("[Wake Word] Activating, devMode:", isDevMode);

  outputChannel = vscode.window.createOutputChannel("Wake Word");
  context.subscriptions.push(outputChannel);

  // Shared by every window of this editor, which is what lets them agree on
  // who holds the microphone. See lockFile.ts.
  lockPath = lockFilePath(context.globalStorageUri.fsPath);
  sessionStats = createSessionStats();

  speechEngine = createEngine(context);
  wireEngine(speechEngine);

  // Status bar indicators
  statusBarItem = vscode.window.createStatusBarItem(
    "wakeWord.status",
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.name = "Wake Word Status";
  statusBarItem.command = "wakeWord.toggle";
  context.subscriptions.push(statusBarItem);

  engineBarItem = vscode.window.createStatusBarItem(
    "wakeWord.engine",
    vscode.StatusBarAlignment.Right,
    99
  );
  engineBarItem.name = "Wake Word Engine";
  engineBarItem.tooltip = "Active speech engine. Click to change.";
  context.subscriptions.push(engineBarItem);
  context.subscriptions.push(
    vscode.commands.registerCommand("wakeWord.openEngineSetting", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "wakeWord.engine");
    })
  );
  engineBarItem.command = "wakeWord.openEngineSetting";

  // Both items created — safe to call setStatusBar now
  setStatusBar("off");
  statusBarItem.show();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("wakeWord.enable", () =>
      handleConsentThenStart(context)
    ),
    vscode.commands.registerCommand("wakeWord.disable", () => stopListening()),
    vscode.commands.registerCommand("wakeWord.toggle", () => {
      if (speechEngine.isListening || speechEngine.isPaused) {
        stopListening();
      } else {
        handleConsentThenStart(context);
      }
    }),
    vscode.commands.registerCommand("wakeWord.resetConsent", async () => {
      await context.globalState.update(CONSENT_KEY, undefined);
      stopListening();
      vscode.window.showInformationMessage(
        "Wake Word consent has been reset. You will be prompted again next time."
      );
    })
  );

  // Auto-start if configured (deferred to let VS Code finish initialising).
  // If another window already holds the listener lock, startListening()
  // stands this window down and watches for its turn.
  const config = vscode.workspace.getConfiguration("wakeWord");
  const autoStart = config.get<boolean>("enableOnStartup", true);
  if (autoStart) {
    setTimeout(() => {
      handleConsentThenStart(context);
    }, 1000);
  }

  // Re-init when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      const engineChanged =
        e.affectsConfiguration("wakeWord.engine") ||
        e.affectsConfiguration("wakeWord.nodePath") ||
        e.affectsConfiguration("wakeWord.audioDevice");

      if (engineChanged) {
        const wasListening = speechEngine.isListening;
        const cooldownActive = countdownTimer !== null;
        isPausedByFocus = false;
        lastDetectionTime = 0;
        warnedDeviceIgnored = false;
        speechEngine.dispose();
        speechEngine = createEngine(context);
        wireEngine(speechEngine);
        log("info", "Engine switched due to settings change");
        // The counters describe one engine's run. Write them out before
        // they are reset for the new one.
        logSessionStats();
        sessionStats = createSessionStats();
        updateEngineIndicator(cooldownActive);
        if (cooldownActive) {
          log("info", "Engine switched during cooldown — will start when cooldown expires");
        } else if (wasListening) {
          startListening();
        }
        return;
      }

      if (e.affectsConfiguration("wakeWord.routes") && speechEngine.isListening) {
        stopListening();
        handleConsentThenStart(context);
      }
    })
  );

  // Pause when VS Code loses focus (opt-in)
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      const config = vscode.workspace.getConfiguration("wakeWord");
      if (!config.get<boolean>("pauseOnFocusLoss", false)) {
        return;
      }

      if (!state.focused && speechEngine.isListening) {
        isPausedByFocus = true;
        speechEngine.pause();
        log("info", "Paused: window lost focus");
      } else if (state.focused && isPausedByFocus) {
        isPausedByFocus = false;
        speechEngine.resume();
        log("info", "Resumed: window regained focus");
      }
    })
  );
}

export function deactivate() {
  if (speechEngine) {
    logSessionStats();
    // stopListening() also stops the lock watcher and releases the lock, so
    // a window that closes hands the microphone to the next one.
    stopListening();
    speechEngine.dispose();
  }
}

// ── Consent ─────────────────────────────────────────────────

const CONSENT_KEY = "wakeWord.userConsented";

async function handleConsentThenStart(
  context: vscode.ExtensionContext
): Promise<void> {
  if (speechEngine.isListening || isStarting) {
    return;
  }

  const hasConsented = context.globalState.get<boolean>(CONSENT_KEY, false);

  if (hasConsented) {
    startListening();
    return;
  }

  isStarting = true;

  try {
    const choice = await vscode.window.showWarningMessage(
      "Wake Word uses your microphone to listen for wake phrases " +
        "whenever the editor is open. All audio is processed locally on " +
        "your machine. Nothing is recorded or transmitted.\n\n" +
        "When a wake phrase is detected, the microphone is released " +
        "so the target assistant can use it. Wake word listening " +
        "resumes automatically after a cooldown period.\n\n" +
        "You can disable this at any time from the status bar.",
      { modal: true },
      "Allow Microphone Listening",
      "Not Now"
    );

    if (choice === "Allow Microphone Listening") {
      await context.globalState.update(CONSENT_KEY, true);
      startListening();
    } else {
      setStatusBar("off");
    }
  } finally {
    isStarting = false;
  }
}

// ── Logging ──────────────────────────────────────────────────

function log(level: "info" | "warn" | "error", message: string) {
  const timestamp = new Date().toISOString().substring(11, 23);
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  outputChannel.appendLine(line);
  if (isDevMode) {
    console.log("[Wake Word]", line);
  }
}

function logSessionStats(): void {
  log("info", formatSessionStats(sessionStats));
}

// ── Core logic ──────────────────────────────────────────────

function startListening() {
  const config = vscode.workspace.getConfiguration("wakeWord");
  const routes = buildRoutes(config);

  if (routes.length === 0) {
    vscode.window.showWarningMessage(
      "Wake Word: No wake phrases configured. Add phrases in settings."
    );
    return;
  }

  // Only one window listens at a time. The lock is held for the whole
  // session, cooldowns included, and re-acquiring one we already hold is a
  // no-op, so calling this on every start is safe.
  if (!acquireListenerLock()) {
    log("info", "Another editor window is listening. This window will take over if it stops.");
    setStatusBar("other-window");
    startLockWatcher();
    return;
  }
  stopLockWatcher();

  const threshold = clampThreshold(config.get<number>("confidenceThreshold", 0.3));
  const audioDevice = readAudioDevice(config);
  const deviceNote = audioDevice ? `, device="${audioDevice}"` : "";
  log("info", `Starting: ${routes.length} routes, threshold=${threshold}, devMode=${isDevMode}${deviceNote}`);
  log("info", `OS: ${process.platform} ${process.arch}, VS Code: ${vscode.version}`);

  if (audioDevice && !(speechEngine instanceof SherpaEngine) && !warnedDeviceIgnored) {
    warnedDeviceIgnored = true;
    log(
      "warn",
      "wakeWord.audioDevice is set, but the Windows engine always uses the system " +
        "default microphone. Set wakeWord.engine to \"sherpa\" to choose a device."
    );
  }

  speechEngine.start(routes, threshold, isDevMode);
}

function stopListening() {
  clearResumeTimer();
  stopLockWatcher();
  isPausedByFocus = false;
  lastDetectionTime = 0;
  speechEngine.stop();
  releaseLock(lockPath);
  setStatusBar("off");
}

// ── Multi-window coordination ───────────────────────────────

/**
 * Take the listener lock, or report that another window holds it.
 *
 * A storage directory that cannot be written is not a reason to stay
 * silent: log it and listen without coordination, which is what every
 * version before this one did.
 */
function acquireListenerLock(): boolean {
  try {
    return tryAcquireLock(lockPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log("warn", `Could not write the listener lock (${message}). Listening without multi-window coordination.`);
    return true;
  }
}

/**
 * While another window holds the lock, check every LOCK_CHECK_INTERVAL_MS
 * whether it has gone: closed cleanly and released, or crashed and left a
 * lock naming a dead process. Either way this window takes over.
 */
function startLockWatcher(): void {
  if (lockWatchTimer) {
    return;
  }
  lockWatchTimer = setInterval(() => {
    if (!acquireListenerLock()) {
      return;
    }
    stopLockWatcher();
    log("info", "The listening window has stopped. Taking over.");
    startListening();
  }, LOCK_CHECK_INTERVAL_MS);
}

function stopLockWatcher(): void {
  if (lockWatchTimer) {
    clearInterval(lockWatchTimer);
    lockWatchTimer = null;
  }
}

// ── Route configuration ─────────────────────────────────────

function buildRoutes(config: vscode.WorkspaceConfiguration): WakePhrase[] {
  const userRoutes = config.get<WakePhrase[]>("routes", []);
  return resolveRoutes(userRoutes, DEFAULT_ROUTES);
}

// ── Wake word triggered ─────────────────────────────────────

async function onWakeWordDetected(phrase: WakePhrase, confidence?: number) {
  const now = Date.now();
  if (shouldDebounce(now, lastDetectionTime, DETECTION_DEBOUNCE_MS)) {
    log("info", `Debounced duplicate detection: ${phrase.label}`);
    return;
  }
  lastDetectionTime = now;
  recordDetection(sessionStats, phrase.label);

  // Only the Windows engine supplies a score; formatConfidence renders
  // nothing when there is none to show.
  log("info", `Detected: "${phrase.label}"${formatConfidence(confidence)}`);

  const config = vscode.workspace.getConfiguration("wakeWord");
  const showNotification = config.get<boolean>(
    "showNotificationOnDetection",
    true
  );
  const globalCooldown = config.get<number>("cooldownSeconds", 30);
  const cooldownSeconds = phrase.cooldownSeconds ?? globalCooldown;

  if (showNotification) {
    vscode.window.showInformationMessage(
      `"${phrase.label}" detected -- handing off...`
    );
  }

  // Pause: kill the speech engine process to release the mic
  speechEngine.pause();

  // Fire the target command
  try {
    await vscode.commands.executeCommand(phrase.command);
  } catch (err: unknown) {
    console.error(
      `[Wake Word] Failed to execute command "${phrase.command}":`,
      err
    );
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(
      `Wake Word: Could not execute "${phrase.command}" -- ${message}`
    );
    resumeListening();
    return;
  }

  // Schedule resume after cooldown
  scheduleResume(cooldownSeconds);
}

// ── Pause / Resume management ───────────────────────────────

function scheduleResume(seconds: number) {
  clearResumeTimer();
  countdownRemaining = seconds;
  sessionStats.cooldowns++;

  statusBarItem.text = `$(clock) Wake: ${countdownRemaining}s`;
  statusBarItem.tooltip = "Mic handed off to assistant. Resuming soon.";
  statusBarItem.backgroundColor = new vscode.ThemeColor(
    "statusBarItem.warningBackground"
  );

  countdownTimer = setInterval(() => {
    countdownRemaining--;

    if (countdownRemaining <= 0) {
      clearResumeTimer();
      resumeListening();
      log("info", "Resumed: cooldown expired");
    } else {
      statusBarItem.text = `$(clock) Wake: ${countdownRemaining}s`;
    }
  }, 1000);

  log("info", `Cooldown: ${seconds}s`);
}

function resumeListening() {
  clearResumeTimer();
  lastDetectionTime = 0;
  if (speechEngine.isPaused) {
    speechEngine.resume();
  } else {
    startListening();
  }
}

function clearResumeTimer() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  countdownRemaining = 0;
}

// ── Status bar ──────────────────────────────────────────────

function updateEngineIndicator(visible: boolean): void {
  if (!visible) {
    engineBarItem.hide();
    return;
  }
  const label = speechEngine instanceof SherpaEngine ? "Sherpa" : "Windows";
  engineBarItem.text = `$(gear) ${label}`;
  engineBarItem.show();
}

function setStatusBar(state: "off" | "listening" | "handed-off" | "error" | "other-window") {
  switch (state) {
    case "off":
      statusBarItem.text = "$(mic-off) Wake: Off";
      statusBarItem.tooltip = "Click to enable wake word listening";
      statusBarItem.backgroundColor = undefined;
      updateEngineIndicator(false);
      break;
    case "listening":
      statusBarItem.text = "$(mic) Wake: Listening";
      statusBarItem.tooltip =
        "Listening for wake words... Click to disable";
      statusBarItem.backgroundColor = undefined;
      updateEngineIndicator(true);
      break;
    case "handed-off":
      statusBarItem.text = "$(mic-filled) Wake: Active";
      statusBarItem.tooltip =
        "Mic handed off to assistant. Will resume listening automatically.";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      updateEngineIndicator(true);
      break;
    case "error":
      statusBarItem.text = "$(error) Wake: Error";
      statusBarItem.tooltip = "Wake word encountered an error. Click to retry.";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      updateEngineIndicator(false);
      break;
    case "other-window":
      statusBarItem.text = "$(mic-off) Wake: Other window";
      statusBarItem.tooltip =
        "Another editor window is already listening. Only one instance listens " +
        "at a time. This window takes over automatically when that one stops.";
      statusBarItem.backgroundColor = undefined;
      updateEngineIndicator(false);
      break;
  }
}
