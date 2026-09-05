import * as vscode from "vscode";
import * as os from "os";
import { WakePhrase, ISpeechEngine } from "./speechEngineInterface";
import { WindowsSpeechEngine } from "./windowsSpeechEngine";
import { SherpaEngine } from "./sherpaEngine";
import {
  CALIBRATION_DURATION_MS,
  CONFIRMATION_WINDOW_MS,
  DETECTION_DEBOUNCE_MS,
  CalibrationDetection,
  PendingConfirmation,
  SessionStats,
  clampThreshold,
  createSessionStats,
  evaluateConfirmation,
  formatCalibrationReport,
  formatConfidence,
  formatConfirmationStatus,
  formatSessionStats,
  recordDetection,
  resolveHandoff,
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
let pendingConfirmation: PendingConfirmation | null = null;
let confirmationTimer: ReturnType<typeof setTimeout> | null = null;
let isManuallyPaused = false;
let routesChangedWhilePaused = false;
let calibration: CalibrationRun | null = null;

/** How long Calibrate waits for an engine it had to start before giving up. */
const CALIBRATION_START_TIMEOUT_MS = 30_000;

type CalibrationOutcome = "completed" | "cancelled" | "stopped" | "error" | "start-timeout";

/** A Calibrate run in progress. See runCalibration(). */
interface CalibrationRun {
  detections: CalibrationDetection[];
  /** Epoch ms at which the listening window opened; 0 while the engine is still starting. */
  startedAt: number;
  /** Settle the run. Safe to call more than once; the first outcome wins. */
  finish: (outcome: CalibrationOutcome) => void;
  /** Set while the run waits for an engine it started to report READY. */
  onEngineStarted: (() => void) | null;
  /** Progress hook, called after each detection is recorded. */
  onDetection: (() => void) | null;
}

// ── Default routes ──────────────────────────────────────────

export const DEFAULT_ROUTES: WakePhrase[] = [
  {
    label: "Claude",
    phrase: "hey claude",
    command: "claude-vscode.focus",
    // Voice sessions with an assistant run well past the 30 second cooldown,
    // so listening waits for the user to resume rather than restarting under
    // the assistant and competing for the microphone.
    handoff: "manual",
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
    calibration?.onEngineStarted?.();
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
    calibration?.finish("error");
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
      if (calibration) {
        // The status bar reads "Click to cancel" during a run.
        calibration.finish("cancelled");
      } else if (isManuallyPaused) {
        resumeFromManualHandoff();
      } else if (speechEngine.isListening || speechEngine.isPaused) {
        stopListening();
      } else {
        handleConsentThenStart(context);
      }
    }),
    vscode.commands.registerCommand("wakeWord.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "wakeWord");
    }),
    vscode.commands.registerCommand("wakeWord.calibrate", () => runCalibration(context)),
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
        // A calibration run cannot outlive its engine. Settled here it
        // reports nothing and restores nothing; the switch below decides
        // what the new engine does.
        calibration?.finish("stopped");
        const wasListening = speechEngine.isListening;
        const cooldownActive = countdownTimer !== null;
        const manualActive = isManuallyPaused;
        isPausedByFocus = false;
        lastDetectionTime = 0;
        warnedDeviceIgnored = false;
        clearConfirmation();
        speechEngine.dispose();
        speechEngine = createEngine(context);
        wireEngine(speechEngine);
        log("info", "Engine switched due to settings change");
        // The counters describe one engine's run. Write them out before
        // they are reset for the new one.
        logSessionStats();
        sessionStats = createSessionStats();
        updateEngineIndicator(cooldownActive || manualActive);
        if (cooldownActive) {
          log("info", "Engine switched during cooldown: the new engine starts when the cooldown expires");
        } else if (manualActive) {
          log("info", "Engine switched during a manual handoff: the new engine starts when you resume");
        } else if (wasListening) {
          startListening();
        }
        return;
      }

      if (e.affectsConfiguration("wakeWord.routes")) {
        if (speechEngine.isListening) {
          stopListening();
          handleConsentThenStart(context);
        } else if (speechEngine.isPaused || countdownTimer !== null || isManuallyPaused) {
          // The engine is paused for a handoff and must not take the
          // microphone back now. The resume does a full start so the new
          // routes are used; resume() alone would replay the old ones.
          routesChangedWhilePaused = true;
          log("info", "Routes changed during a handoff: applied when listening resumes");
        }
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

      // A calibration run keeps the microphone: it ends on its own timer.
      if (!state.focused && speechEngine.isListening && !calibration) {
        isPausedByFocus = true;
        clearConfirmation();
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
  // After a manual handoff, Enable is the resume the status bar promises.
  if (isManuallyPaused) {
    resumeFromManualHandoff();
    return;
  }
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
        "resumes after a cooldown, or when you resume it from the status bar.\n\n" +
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
  calibration?.finish("stopped");
  clearResumeTimer();
  clearConfirmation();
  stopLockWatcher();
  isPausedByFocus = false;
  isManuallyPaused = false;
  routesChangedWhilePaused = false;
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

  // A calibration run records what was heard and acts on none of it. The
  // debounce above still applies, so the run shows what a session would.
  if (calibration) {
    const time = calibration.startedAt ? now - calibration.startedAt : 0;
    calibration.detections.push({ label: phrase.label, confidence, time });
    log(
      "info",
      `Calibration: heard "${phrase.label}"${formatConfidence(confidence)} at ${(time / 1000).toFixed(1)}s`
    );
    calibration.onDetection?.();
    return;
  }

  // With confirmationMode on, the first hearing is held and the engine keeps
  // listening for a second one. The debounce above runs first, so the engine
  // repeating a single utterance cannot confirm it.
  const config = vscode.workspace.getConfiguration("wakeWord");
  const wasPending = pendingConfirmation !== null;
  const confirmation = evaluateConfirmation(
    config.get<boolean>("confirmationMode", false),
    pendingConfirmation,
    phrase.label,
    now
  );
  pendingConfirmation = confirmation.pending;
  if (!confirmation.confirmed) {
    beginConfirmationWait(phrase.label, confidence);
    return;
  }
  clearConfirmationTimer();
  if (wasPending) {
    log("info", `Confirmation: "${phrase.label}" confirmed`);
  }

  recordDetection(sessionStats, phrase.label);

  // Only the Windows engine supplies a score; formatConfidence renders
  // nothing when there is none to show.
  log("info", `Detected: "${phrase.label}"${formatConfidence(confidence)}`);

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

  // Hand off: resume on the route's timer, or wait for the user.
  if (resolveHandoff(phrase.handoff) === "manual") {
    enterManualPause();
    log("info", "Manual handoff: waiting for the user to resume");
  } else {
    scheduleResume(cooldownSeconds);
  }
}

// ── Phrase confirmation ─────────────────────────────────────

/**
 * Hold a first hearing and show it in the status bar. The engine is not
 * paused: it has to hear the phrase again. If the window passes with no
 * second hearing the hold is dropped and the status bar returns to Listening.
 */
function beginConfirmationWait(label: string, confidence?: number): void {
  clearConfirmationTimer();
  log(
    "info",
    `Confirmation: heard "${label}" once${formatConfidence(confidence)}, waiting for a second detection`
  );
  statusBarItem.text = formatConfirmationStatus(label);
  statusBarItem.tooltip =
    `Heard "${label}". Say it again within ${CONFIRMATION_WINDOW_MS / 1000} seconds to confirm.`;
  statusBarItem.backgroundColor = undefined;
  confirmationTimer = setTimeout(() => {
    confirmationTimer = null;
    pendingConfirmation = null;
    log("info", `Confirmation: "${label}" expired, resuming`);
    // Only put Listening back if that is still the state underneath. An
    // error during the wait has already set the bar itself.
    if (speechEngine.isListening) {
      setStatusBar("listening");
    }
  }, CONFIRMATION_WINDOW_MS);
}

function clearConfirmationTimer(): void {
  if (confirmationTimer) {
    clearTimeout(confirmationTimer);
    confirmationTimer = null;
  }
}

/**
 * Forget a held first hearing. Called wherever listening stops, pauses,
 * resumes, or changes engine, so a phrase heard before one of those cannot
 * be confirmed by one heard after it.
 */
function clearConfirmation(): void {
  clearConfirmationTimer();
  pendingConfirmation = null;
}

// ── Pause / Resume management ───────────────────────────────

function scheduleResume(seconds: number) {
  sessionStats.cooldowns++;
  startCountdown(seconds);
  log("info", `Cooldown: ${seconds}s`);
}

/**
 * Run the status bar countdown and resume when it reaches zero. Separate
 * from scheduleResume() so a cooldown that Calibrate interrupted can pick
 * up its remaining seconds without counting as a second cooldown.
 */
function startCountdown(seconds: number) {
  clearResumeTimer();
  isManuallyPaused = false;
  countdownRemaining = seconds;

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
}

/**
 * Hold the handoff until the user resumes. No timer: the status bar shows
 * Paused, and a click on it or the Enable command calls resumeListening().
 * Routes with `handoff: "manual"` use this so a long voice session with an
 * assistant is never interrupted by the engine restarting under it.
 */
function enterManualPause(): void {
  clearResumeTimer();
  isManuallyPaused = true;
  setStatusBar("paused");
}

function resumeFromManualHandoff(): void {
  log("info", "Resumed: user resumed after manual handoff");
  resumeListening();
}

function resumeListening() {
  clearResumeTimer();
  clearConfirmation();
  isManuallyPaused = false;
  lastDetectionTime = 0;
  // resume() replays the phrases the engine was paused with. After a route
  // change that is the wrong list, so go through a full start instead.
  if (speechEngine.isPaused && !routesChangedWhilePaused) {
    speechEngine.resume();
  } else {
    routesChangedWhilePaused = false;
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

// ── Calibration ───────────────────────────────────────────────

type PriorState =
  | { kind: "listening" }
  | { kind: "cooldown"; remaining: number }
  | { kind: "manual" }
  | { kind: "focus-paused" }
  | { kind: "off" };

/** What the extension was doing when Calibrate was run, so it can be put back. */
function capturePriorState(): PriorState {
  if (speechEngine.isListening) {
    return { kind: "listening" };
  }
  if (countdownTimer !== null) {
    return { kind: "cooldown", remaining: countdownRemaining };
  }
  if (isManuallyPaused) {
    return { kind: "manual" };
  }
  if (isPausedByFocus) {
    return { kind: "focus-paused" };
  }
  return { kind: "off" };
}

/**
 * Listen for CALIBRATION_DURATION_MS and report every detection instead of
 * acting on it, so a user can see what the engine hears with their
 * microphone, their room, and their threshold, without any route firing.
 *
 * The engine is started if it is not already listening, and the state it
 * was in is put back afterwards: listening stays listening, an interrupted
 * cooldown picks up where it left off, a manual handoff stays paused, and
 * Off goes back to Off with the listener lock released. Detections still
 * pass the debounce guard, so the run shows what a real session would.
 * Confirmation mode is not applied: the point is to see every hearing.
 *
 * A run ends on its timer, on the notification's Cancel, on a status bar
 * click, when listening is disabled or the engine is switched (nothing is
 * restored then: those have settled the state themselves), or when the
 * engine reports an error.
 */
async function runCalibration(context: vscode.ExtensionContext): Promise<void> {
  if (calibration) {
    vscode.window.showInformationMessage("Wake Word: Calibration is already running.");
    return;
  }
  if (!context.globalState.get<boolean>(CONSENT_KEY, false)) {
    vscode.window.showWarningMessage(
      "Wake Word: Calibration uses the microphone. Run Wake Word: Enable Listening first to allow that."
    );
    return;
  }
  // A window standing by for another one has no microphone to calibrate with.
  if (lockWatchTimer !== null || !acquireListenerLock()) {
    vscode.window.showWarningMessage(
      "Wake Word: Another editor window is listening, so this one has no microphone to calibrate with. " +
        "Run Calibrate from that window, or disable listening there first."
    );
    return;
  }

  const config = vscode.workspace.getConfiguration("wakeWord");
  const routes = buildRoutes(config);
  if (routes.length === 0) {
    vscode.window.showWarningMessage(
      "Wake Word: No wake phrases configured. Add phrases in settings."
    );
    return;
  }
  const threshold = clampThreshold(config.get<number>("confidenceThreshold", 0.3));
  const seconds = CALIBRATION_DURATION_MS / 1000;

  const prior = capturePriorState();
  clearResumeTimer();
  clearConfirmation();
  isManuallyPaused = false;
  log("info", `Calibration: starting (${seconds}s, threshold=${threshold}, was ${prior.kind})`);

  const run: CalibrationRun = {
    detections: [],
    startedAt: 0,
    finish: () => undefined,
    onEngineStarted: null,
    onDetection: null,
  };
  calibration = run;

  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Wake Word: Calibrating",
      cancellable: true,
    },
    (progress, token) =>
      new Promise<CalibrationOutcome>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        run.finish = (result) => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          calibration = null;
          // A promise settles once, so a later outcome is ignored.
          resolve(result);
        };
        token.onCancellationRequested(() => run.finish("cancelled"));
        run.onDetection = () => {
          const count = run.detections.length;
          const last = run.detections[count - 1];
          progress.report({
            message: `Heard "${last.label}" (${count} detection${count === 1 ? "" : "s"})`,
          });
        };

        const openWindow = () => {
          run.startedAt = Date.now();
          setStatusBar("calibrating");
          progress.report({ message: `Say your wake phrases now (${seconds} seconds)` });
          timer = setTimeout(() => run.finish("completed"), CALIBRATION_DURATION_MS);
        };

        if (prior.kind === "listening") {
          openWindow();
          return;
        }

        // The window opens once the engine reports READY, so a slow start,
        // a model download on a first run included, does not eat into it.
        progress.report({ message: "Starting the speech engine..." });
        run.onEngineStarted = () => {
          run.onEngineStarted = null;
          if (timer) {
            clearTimeout(timer);
          }
          openWindow();
        };
        timer = setTimeout(() => run.finish("start-timeout"), CALIBRATION_START_TIMEOUT_MS);
        Promise.resolve(speechEngine.start(routes, threshold, isDevMode)).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log("error", `Calibration: the engine failed to start: ${message}`);
          run.finish("error");
        });
      })
  );

  reportCalibration(run, outcome);
  restorePriorState(prior, outcome);
}

function reportCalibration(run: CalibrationRun, outcome: CalibrationOutcome): void {
  if (outcome === "start-timeout") {
    log(
      "warn",
      `Calibration: the engine did not start within ${CALIBRATION_START_TIMEOUT_MS / 1000}s. ` +
        "Check the lines above for the reason and try again."
    );
    vscode.window.showWarningMessage(
      "Wake Word: Calibration could not start the speech engine. Check the Wake Word output channel."
    );
    return;
  }
  if (outcome === "error") {
    // The error itself was logged and shown by the engine's error handler.
    log("warn", "Calibration: stopped by an engine error");
    return;
  }
  if (outcome === "stopped") {
    log("info", "Calibration: cancelled because listening was disabled or the engine changed");
    return;
  }
  if (run.startedAt === 0) {
    log("info", "Calibration: cancelled before the engine started");
    return;
  }

  const elapsed = outcome === "completed" ? CALIBRATION_DURATION_MS : Date.now() - run.startedAt;
  const report = formatCalibrationReport(run.detections, elapsed);
  for (const line of report.lines) {
    log("info", line);
  }
  vscode.window.showInformationMessage(report.summary, "Show Log").then((choice) => {
    if (choice === "Show Log") {
      outputChannel.show();
    }
  });
}

/**
 * Put the extension back where Calibrate found it. Skipped when listening
 * was disabled during the run or the engine failed: those have already
 * settled the state and the status bar themselves.
 */
function restorePriorState(prior: PriorState, outcome: CalibrationOutcome): void {
  if (outcome === "stopped" || outcome === "error") {
    return;
  }
  lastDetectionTime = 0;
  switch (prior.kind) {
    case "listening":
      if (speechEngine.isListening) {
        setStatusBar("listening");
      }
      break;
    case "cooldown":
      speechEngine.pause();
      startCountdown(prior.remaining);
      log("info", `Calibration: cooldown resumed with ${prior.remaining}s left`);
      break;
    case "manual":
      speechEngine.pause();
      enterManualPause();
      break;
    case "focus-paused":
      speechEngine.pause();
      break;
    case "off":
      speechEngine.stop();
      releaseLock(lockPath);
      setStatusBar("off");
      break;
  }
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

/**
 * Tooltip that ends with a link to the extension's settings, so the status
 * bar is a way into configuring wake phrases as well as toggling them.
 * Command links in a tooltip only work when the markdown is trusted; the
 * text here is ours, never the user's.
 */
function tooltipWithSettingsLink(text: string): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(
    `${text}\n\n[Open Settings](command:wakeWord.openSettings "Wake Word: Open Settings") ` +
      "to change wake phrases and routes."
  );
  tooltip.isTrusted = true;
  return tooltip;
}

type StatusBarState =
  | "off"
  | "listening"
  | "handed-off"
  | "paused"
  | "calibrating"
  | "error"
  | "other-window";

function setStatusBar(state: StatusBarState) {
  switch (state) {
    case "off":
      statusBarItem.text = "$(mic-off) Wake: Off";
      statusBarItem.tooltip = tooltipWithSettingsLink("Click to enable wake word listening.");
      statusBarItem.backgroundColor = undefined;
      updateEngineIndicator(false);
      break;
    case "listening":
      statusBarItem.text = "$(mic) Wake: Listening";
      statusBarItem.tooltip = tooltipWithSettingsLink(
        "Listening for wake words. Click to disable."
      );
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
    case "paused":
      statusBarItem.text = "$(debug-pause) Wake: Paused";
      statusBarItem.tooltip = "Mic handed to assistant. Click to resume listening.";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      updateEngineIndicator(true);
      break;
    case "calibrating":
      statusBarItem.text = "$(pulse) Wake: Calibrating";
      statusBarItem.tooltip =
        "Listening for wake phrases without acting on them. Click to cancel.";
      statusBarItem.backgroundColor = undefined;
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
