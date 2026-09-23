import * as vscode from "vscode";
import * as os from "os";
import { WakePhrase, ISpeechEngine } from "./speechEngineInterface";
import {
  MODEL_NAME,
  MODEL_SHA256,
  SherpaEngine,
  modelStatus,
  nativeEnginePath,
  probeNativeEngine,
} from "./sherpaEngine";
import {
  CALIBRATION_DURATION_MS,
  CONFIRMATION_WINDOW_MS,
  DEFAULT_THRESHOLD,
  DETECTION_DEBOUNCE_MS,
  CalibrationDetection,
  CommandSources,
  ListenSettingsChange,
  ListeningState,
  PendingConfirmation,
  RouteAvailability,
  SessionStats,
  checkRouteAvailability,
  clampThreshold,
  commandSources,
  createSessionStats,
  decideListenSettingsChange,
  describeThreshold,
  detectPhraseCollisions,
  evaluateConfirmation,
  filterValidRoutes,
  formatCalibrationReport,
  formatConfidence,
  formatConfirmationStatus,
  formatDiagnostics,
  formatListenSettingsChange,
  formatPhraseChecks,
  formatPhraseChecksSummary,
  formatSessionStats,
  phraseChecksKey,
  planAvailabilityReport,
  recordDetection,
  releaseThenFire,
  resolveHandoff,
  resolveRoutes,
  setAsideKey,
  shouldDebounce,
  validatePhraseQuality,
} from "./wakeWordCore";
import {
  LOCK_CHECK_INTERVAL_MS,
  describeLock,
  lockFilePath,
  readLock,
  releaseLock,
  tryAcquireLock,
} from "./lockFile";

let statusBarItem: vscode.StatusBarItem;
let statusBarState: StatusBarState = "off";
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
let pendingConfirmation: PendingConfirmation | null = null;
let confirmationTimer: ReturnType<typeof setTimeout> | null = null;
let isManuallyPaused = false;
/**
 * A change to the routes or the threshold that arrived while the engine was
 * paused. The resume then goes through a full start; see resumeListening().
 */
let listenSettingsChangedWhilePaused = false;
/**
 * The same, for a change that arrived while a start was in flight. That
 * engine was given the settings as they were when the start began, so
 * listening restarts as soon as it reports READY.
 */
let listenSettingsChangedWhileStarting = false;
/** A start is in flight: speechEngine.start() has been called, no `started` yet. */
let engineStarting = false;
let calibration: CalibrationRun | null = null;
/** Advanced by each detection's handoff and by cancelPendingHandoff(). */
let handoffGeneration = 0;
/** phraseChecksKey() of the routes whose phrase checks were last reported. */
let lastPhraseChecksKey = "";
/** The extension's global state: where the set-aside routes the user was told about are kept. */
let extensionState: vscode.Memento | null = null;
/**
 * setAsideKey() of the check whose routes the engine was last started with,
 * or, while waiting for a command, of the check that found none. A resume
 * replays the engine's routes, so it compares a fresh check with this, and
 * so does an extension change.
 */
let appliedSetAsideKey: string | null = null;
/** The last check reported this session; null before the first. */
let reportedAvailability: RouteAvailability | null = null;
/**
 * None of the routes' commands was available at the last start, so no
 * engine was started and the microphone is closed. An extension change or a
 * routes change starts listening again. See startListening().
 */
let waitingForCommands = false;
/**
 * Advanced by every start, resume, stop, and calibration run. A start or a
 * resume reads the editor's commands, which takes a round trip, and
 * compares this afterwards: if it moved, something else has decided what
 * listening does since, and the earlier one stands down.
 */
let listenRequest = 0;

/** Global state key for the set-aside routes the user was last told about. */
const TOLD_SET_ASIDE_KEY = "wakeWord.setAsideNotified";

/** How long Calibrate waits for an engine it had to start before giving up. */
const CALIBRATION_START_TIMEOUT_MS = 30_000;

type CalibrationOutcome = "completed" | "cancelled" | "stopped" | "error" | "start-timeout" | "no-commands";

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
    // The command comes from the Claude Code extension. Where that is not
    // installed, the route is set aside: see checkRouteAvailability().
  },
  {
    // The command opens the editor's generic chat panel, whichever chat
    // extension is active, so neither the label nor the phrase names one.
    label: "Chat",
    phrase: ["hey chat", "open chat"],
    command: "workbench.action.chat.open",
  },
  {
    label: "Terminal",
    // "Hey Computer", not "Computer": a single common English word triggers
    // on ordinary speech far too readily for an always-listening extension.
    phrase: ["hey computer", "open terminal"],
    command: "workbench.action.terminal.focus",
  },
];

// ── Engine factory ───────────────────────────────────────────

/**
 * Build the speech engine. Every platform runs the sherpa-onnx engine:
 * decibri for capture and a keyword spotter, in the packaged engine's child
 * process.
 */
function createEngine(context: vscode.ExtensionContext): ISpeechEngine {
  const config = vscode.workspace.getConfiguration("wakeWord");
  return new SherpaEngine(context, readAudioDevice(config));
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

function wireEngine(engine: ISpeechEngine, context: vscode.ExtensionContext): void {
  engine.on("detected", (phrase: WakePhrase, confidence?: number) => {
    onWakeWordDetected(phrase, confidence);
  });
  engine.on("started", () => {
    sessionStats.engineStarts++;
    engineStarting = false;
    setStatusBar("listening");
    calibration?.onEngineStarted?.();
    applyListenSettingsChangedWhileStarting(context);
  });
  engine.on("paused", () => setStatusBar("handed-off"));
  engine.on("stopped", () => {
    engineStarting = false;
    setStatusBar("off");
  });
  engine.on("debug", (info: string) => log("info", info));
  engine.on("warning", (msg: string) => log("warn", msg));
  engine.on("error", (err: Error) => {
    sessionStats.errors++;
    engineStarting = false;
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
  extensionState = context.globalState;

  speechEngine = createEngine(context);
  wireEngine(speechEngine, context);

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    "wakeWord.status",
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.name = "Wake Word Status";
  statusBarItem.command = "wakeWord.toggle";
  context.subscriptions.push(statusBarItem);

  setStatusBar("off");
  statusBarItem.show();

  // Register commands. Enable and a click that enables are the user asking
  // to listen, so they are told why when nothing can be listened for.
  context.subscriptions.push(
    vscode.commands.registerCommand("wakeWord.enable", () =>
      handleConsentThenStart(context, true)
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
        return handleConsentThenStart(context, true);
      }
    }),
    vscode.commands.registerCommand("wakeWord.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "wakeWord");
    }),
    vscode.commands.registerCommand("wakeWord.calibrate", () => runCalibration(context)),
    vscode.commands.registerCommand("wakeWord.diagnostics", () => runDiagnostics(context)),
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
      void handleConsentThenStart(context);
    }, 1000);
  }

  // Re-init when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      // The engine is built with the microphone it listens on, so a change
      // to that setting needs a new one.
      const engineChanged = e.affectsConfiguration("wakeWord.audioDevice");

      if (engineChanged) {
        // A calibration run cannot outlive its engine. Settled here it
        // reports nothing and restores nothing; the rebuild below decides
        // what the new engine does.
        calibration?.finish("stopped");
        const wasListening = speechEngine.isListening;
        // Whatever the old engine was doing, it is about to be disposed of.
        // A routes or threshold change in the same event needs nothing of
        // its own: every path out of here ends in a start, which reads the
        // settings again.
        engineStarting = false;
        const cooldownActive = countdownTimer !== null;
        const manualActive = isManuallyPaused;
        isPausedByFocus = false;
        lastDetectionTime = 0;
        clearConfirmation();
        speechEngine.dispose();
        speechEngine = createEngine(context);
        wireEngine(speechEngine, context);
        log("info", "Engine rebuilt due to settings change");
        // The counters describe one engine's run. Write them out before
        // they are reset for the new one.
        logSessionStats();
        sessionStats = createSessionStats();
        if (cooldownActive) {
          log("info", "Engine rebuilt during cooldown: the new engine starts when the cooldown expires");
        } else if (manualActive) {
          log("info", "Engine rebuilt during a manual handoff: the new engine starts when you resume");
        } else if (wasListening) {
          void startListening();
        }
        return;
      }

      // The routes and the threshold are read at the start and sent in the
      // engine's config line, so a running engine has the old ones. What
      // that means here depends on what the extension is doing: see
      // decideListenSettingsChange().
      applyListenSettingsChange(context, {
        routes: e.affectsConfiguration("wakeWord.routes"),
        threshold: e.affectsConfiguration("wakeWord.confidenceThreshold"),
        availability: false,
      });
    })
  );

  // An extension installed, removed, enabled, or disabled can bring a
  // route's command in or take it away.
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => {
      void onExtensionsChanged(context);
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
        log("info", "Resumed: window regained focus");
        // resumeListening(), not resume(): a routes change made while the
        // window was unfocused has to be applied, and resume() would bring
        // the engine back with the old phrases.
        void resumeListening();
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

/**
 * Start listening, asking for consent first if it has not been given.
 * `explicit` is set when the user asked, from Enable or the status bar: see
 * startListening().
 */
async function handleConsentThenStart(
  context: vscode.ExtensionContext,
  explicit = false
): Promise<void> {
  // After a manual handoff, Enable is the resume the status bar promises.
  if (isManuallyPaused) {
    resumeFromManualHandoff();
    return;
  }
  // During a cooldown, Enable resumes early. A plain start here reopened the
  // microphone but left the countdown running, which kept overwriting the
  // status bar and, when it expired, left it on the last second.
  if (countdownTimer !== null) {
    log("info", "Resumed: user resumed during the cooldown");
    void resumeListening();
    return;
  }
  if (speechEngine.isListening || isStarting) {
    return;
  }

  const hasConsented = context.globalState.get<boolean>(CONSENT_KEY, false);

  if (hasConsented) {
    await startListening(explicit);
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
      await startListening(explicit);
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

/**
 * Start listening for the routes whose commands are available.
 *
 * The editor's commands are read first, which is the one wait in a start.
 * Everything after it, from reading the settings to starting the engine,
 * runs without another, so a stop, a settings change, or another start
 * cannot land in the middle; one that lands during the wait supersedes this
 * start, which then stands down.
 *
 * `explicit` is set when the user asked to listen. If no route's command is
 * available, they are then told so even if they were told before.
 */
async function startListening(explicit = false): Promise<void> {
  cancelPendingHandoff();
  const request = ++listenRequest;
  const sources = await readCommandSources();
  if (request !== listenRequest) {
    return;
  }
  waitingForCommands = false;

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

  const availability = checkRouteAvailability(routes, DEFAULT_ROUTES, sources);
  reportAvailability(availability, explicit);
  // The settings this start carries are the ones just read, so a change
  // still waiting on a start or a resume is spent, and a change that arrives
  // before the engine says READY is what the next one is for.
  listenSettingsChangedWhilePaused = false;
  listenSettingsChangedWhileStarting = false;
  appliedSetAsideKey = setAsideKey(availability.setAside);

  if (availability.listened.length === 0) {
    waitForCommands();
    return;
  }

  const listened = availability.listened;
  const threshold = clampThreshold(config.get<number>("confidenceThreshold", DEFAULT_THRESHOLD));
  const audioDevice = readAudioDevice(config);
  const deviceNote = audioDevice ? `, device="${audioDevice}"` : "";
  const setAsideNote = availability.setAside.length > 0 ? `, ${availability.setAside.length} set aside` : "";
  log(
    "info",
    `Starting: ${listened.length} routes${setAsideNote}, threshold=${describeThreshold(threshold, listened)}, ` +
      `devMode=${isDevMode}${deviceNote}`
  );
  log("info", `OS: ${process.platform} ${process.arch}, VS Code: ${vscode.version}`);
  reportPhraseChecks(listened);

  engineStarting = true;
  speechEngine.start(listened, threshold, isDevMode);
}

/**
 * No route's command is available, so there is nothing to listen for. Stop
 * the engine, which only matters for a paused one left from a handoff, give
 * the listener lock up so another window can listen, and wait: an extension
 * change or a routes change starts listening again, through
 * decideListenSettingsChange(), and so does Enable or a status bar click.
 */
function waitForCommands(): void {
  speechEngine.stop();
  releaseLock(lockPath);
  waitingForCommands = true;
  setStatusBar("no-commands");
}

/**
 * Restart listening so the engine picks up settings it was not started
 * with. The engine ignores a start while it is listening, so it is stopped
 * first, exactly as a Disable then an Enable would, and the start goes
 * through the consent check for the same reason: consent can have been
 * withdrawn in another window since this one began listening.
 */
function restartListening(context: vscode.ExtensionContext): void {
  stopListening();
  void handleConsentThenStart(context);
}

/** What the extension is doing, for decideListenSettingsChange(). */
function listeningState(): ListeningState {
  return {
    listening: speechEngine.isListening,
    starting: engineStarting,
    paused: speechEngine.isPaused,
    cooldown: countdownTimer !== null,
    manualPause: isManuallyPaused,
    waiting: waitingForCommands,
  };
}

/**
 * Act on a change to what the engine listens for: the routes, the
 * threshold, or which routes' commands are available. What that means
 * depends on what the extension is doing: see decideListenSettingsChange().
 */
function applyListenSettingsChange(
  context: vscode.ExtensionContext,
  change: ListenSettingsChange,
  state: ListeningState = listeningState()
): void {
  const action = decideListenSettingsChange(change, state);
  const line = formatListenSettingsChange(change, action);
  if (line) {
    log("info", line);
  }
  switch (action) {
    case "restart":
      restartListening(context);
      break;
    case "apply-on-resume":
      // The engine is paused and must not take the microphone back now:
      // a handoff means an assistant has it. The resume does a full
      // start; resume() alone would replay the settings it was paused
      // with.
      listenSettingsChangedWhilePaused = true;
      break;
    case "apply-when-started":
      listenSettingsChangedWhileStarting = true;
      break;
    case "start":
      void handleConsentThenStart(context);
      break;
    case "none":
      break;
  }
}

/**
 * Apply a routes or threshold change that arrived while the engine was
 * starting. Called when it reports READY, which is the first moment a
 * restart costs no more than a reload of the model: the engine holds the
 * microphone, so nothing is taken from a handoff.
 *
 * A calibration run is listening on this engine and its window is already
 * open, so the change waits for the next start rather than cutting the run
 * short.
 */
function applyListenSettingsChangedWhileStarting(context: vscode.ExtensionContext): void {
  if (!listenSettingsChangedWhileStarting) {
    return;
  }
  listenSettingsChangedWhileStarting = false;
  if (calibration) {
    log("info", "Settings changed during a calibration run: applied at the next start");
    return;
  }
  restartListening(context);
}

function stopListening() {
  calibration?.finish("stopped");
  cancelPendingHandoff();
  // A start or a resume still reading the commands stands down: see
  // listenRequest.
  listenRequest++;
  clearResumeTimer();
  clearConfirmation();
  stopLockWatcher();
  isPausedByFocus = false;
  isManuallyPaused = false;
  listenSettingsChangedWhilePaused = false;
  listenSettingsChangedWhileStarting = false;
  engineStarting = false;
  waitingForCommands = false;
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
    void startListening();
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

/** Phrase quality warnings and collisions for these routes, as log lines. */
function checkPhrases(routes: readonly WakePhrase[]): string[] {
  return formatPhraseChecks(validatePhraseQuality(routes), detectPhraseCollisions(routes));
}

/**
 * Log the phrase checks for these routes and show one notification pointing
 * at them. Called on every start, but reports only when the phrases differ
 * from the ones last checked: once per session, and again after the routes
 * change, not on every resume, restart, or lock takeover.
 */
function reportPhraseChecks(routes: readonly WakePhrase[]): void {
  const key = phraseChecksKey(routes);
  if (key === lastPhraseChecksKey) {
    return;
  }
  lastPhraseChecksKey = key;

  const lines = checkPhrases(routes);
  if (lines.length === 0) {
    return;
  }
  for (const line of lines) {
    log("warn", line);
  }
  vscode.window.showWarningMessage(formatPhraseChecksSummary(lines.length), "Show Log").then((choice) => {
    if (choice === "Show Log") {
      outputChannel.show();
    }
  });
}

// ── Route availability ──────────────────────────────────────

/**
 * The commands this editor has: the ones registered, and the ones declared
 * by installed, enabled extensions, which covers the commands of extensions
 * that have not started yet. See checkRouteAvailability().
 *
 * Null when the list cannot be read. Every route is then listened for,
 * rather than setting aside routes that may work.
 */
async function readCommandSources(): Promise<CommandSources | null> {
  try {
    const registered = await vscode.commands.getCommands();
    return commandSources(registered, vscode.extensions.all);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log("warn", `Could not read the editor's commands (${message}): every route is listened for`);
    return null;
  }
}

/** Check the configured routes' commands. */
async function checkConfiguredRoutes(): Promise<RouteAvailability> {
  const sources = await readCommandSources();
  return checkRouteAvailability(buildRoutes(vscode.workspace.getConfiguration("wakeWord")), DEFAULT_ROUTES, sources);
}

/**
 * Log what changed in the routes set aside since the last check this
 * session, and tell the user about a route newly set aside: once, and not
 * again while it stays set aside, restarts included. What they were told
 * is kept in global state, which stays on this machine. Settings would
 * carry it to other machines through Settings Sync, where the command may
 * be there. See planAvailabilityReport().
 */
function reportAvailability(availability: RouteAvailability, explicit: boolean): void {
  const report = planAvailabilityReport(
    availability,
    reportedAvailability,
    extensionState?.get(TOLD_SET_ASIDE_KEY),
    explicit
  );
  reportedAvailability = availability;
  for (const line of report.lines) {
    log(line.level, line.text);
  }
  if (report.told) {
    void extensionState?.update(TOLD_SET_ASIDE_KEY, report.told);
  }
  if (report.notification) {
    vscode.window.showWarningMessage(report.notification, "Show Log").then((choice) => {
      if (choice === "Show Log") {
        outputChannel.show();
      }
    });
  }
}

/**
 * An extension was installed, removed, enabled, or disabled. Check the
 * routes' commands again, and if that changes which routes are listened
 * for, apply it as a routes change is applied: a restart while listening,
 * held for the resume during a handoff, held for READY during a start, and
 * a start while waiting for a command. Off, or standing by for another
 * window, there is nothing to do: the next start checks for itself.
 */
async function onExtensionsChanged(context: vscode.ExtensionContext): Promise<void> {
  const change: ListenSettingsChange = { routes: false, threshold: false, availability: true };
  if (decideListenSettingsChange(change, listeningState()) === "none") {
    return;
  }
  const availability = await checkConfiguredRoutes();
  // The state can have moved while the commands were read.
  const state = listeningState();
  change.availability = setAsideKey(availability.setAside) !== appliedSetAsideKey;
  if (decideListenSettingsChange(change, state) === "none") {
    return;
  }
  reportAvailability(availability, false);
  applyListenSettingsChange(context, change, state);
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

  // The engine supplies no score today; formatConfidence renders nothing
  // when there is none to show.
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

  // Release the microphone, wait until the engine confirms it is closed,
  // then fire the target command, so the assistant never asks for the
  // microphone while this extension still holds it. The engine keeps its
  // process and models loaded for the resume. If listening is stopped or
  // started while the release is under way, the handoff is abandoned.
  const handoff = ++handoffGeneration;
  const outcome = await releaseThenFire(
    async () => {
      await speechEngine.pause();
      if (isDevMode) {
        log("info", `Timing: detect-to-release ${Date.now() - now}ms`);
      }
    },
    () => handoff === handoffGeneration,
    () => vscode.commands.executeCommand(phrase.command)
  );

  if (outcome.kind === "superseded") {
    log(
      "info",
      `Handoff abandoned: listening changed while the microphone was being released, so "${phrase.command}" was not run`
    );
    return;
  }
  if (outcome.kind === "failed") {
    console.error(
      `[Wake Word] Failed to execute command "${phrase.command}":`,
      outcome.error
    );
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    vscode.window.showErrorMessage(
      `Wake Word: Could not execute "${phrase.command}" -- ${message}`
    );
    void resumeListening();
    return;
  }
  if (isDevMode) {
    log("info", `Timing: detect-to-command ${Date.now() - now}ms`);
  }

  // Hand off: resume on the route's timer, or wait for the user.
  if (resolveHandoff(phrase.handoff) === "manual") {
    enterManualPause();
    log("info", "Manual handoff: waiting for the user to resume");
  } else {
    scheduleResume(cooldownSeconds);
  }
}

/**
 * Abandon a handoff still waiting for the microphone release, so it fires
 * nothing when the release settles. Called wherever listening is stopped,
 * started, or resumed, and by Calibrate.
 */
function cancelPendingHandoff(): void {
  handoffGeneration++;
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
      void resumeListening();
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
  void resumeListening();
}

async function resumeListening(): Promise<void> {
  cancelPendingHandoff();
  const request = ++listenRequest;
  clearResumeTimer();
  clearConfirmation();
  isManuallyPaused = false;
  lastDetectionTime = 0;
  // resume() replays the routes and the threshold the engine was paused
  // with. After a change to either those are the wrong settings, so go
  // through a full start instead. The same goes for which routes are set
  // aside, which can change during a pause with no extension changing, when
  // a command is registered late, so the commands are checked first.
  if (speechEngine.isPaused && !listenSettingsChangedWhilePaused) {
    const availability = await checkConfiguredRoutes();
    if (request !== listenRequest) {
      return;
    }
    if (
      speechEngine.isPaused &&
      !listenSettingsChangedWhilePaused &&
      setAsideKey(availability.setAside) === appliedSetAsideKey
    ) {
      speechEngine.resume();
      return;
    }
  }
  await startListening();
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
  | { kind: "waiting" }
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
  if (waitingForCommands) {
    return { kind: "waiting" };
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
 * click, when listening is disabled or the engine is rebuilt (nothing is
 * restored then: those have settled the state themselves), or when the
 * engine reports an error. A run that starts the engine starts it for the
 * routes whose commands are available, and ends before it starts if there
 * are none.
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
  const threshold = clampThreshold(config.get<number>("confidenceThreshold", DEFAULT_THRESHOLD));
  const seconds = CALIBRATION_DURATION_MS / 1000;

  const prior = capturePriorState();
  // A handoff still releasing the microphone would fire its command and
  // start a cooldown in the middle of the run, and a start or a resume still
  // reading the commands would start the engine beside the run's own start.
  cancelPendingHandoff();
  listenRequest++;
  clearResumeTimer();
  clearConfirmation();
  isManuallyPaused = false;
  log(
    "info",
    `Calibration: starting (${seconds}s, threshold=${describeThreshold(threshold, routes)}, was ${prior.kind})`
  );

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
        void startCalibrationEngine(run, routes, threshold);
      })
  );

  reportCalibration(run, outcome);
  restorePriorState(prior, outcome);
}

/**
 * Start the engine for a calibration run, for the routes whose commands are
 * available, as a start for listening does. The engine keeps those routes
 * after the run and a resume replays them, so a route set aside must not
 * reach it here either. With nothing to listen for, the run ends without
 * starting anything, and the user is told why: they asked for the run.
 */
async function startCalibrationEngine(
  run: CalibrationRun,
  routes: WakePhrase[],
  threshold: number
): Promise<void> {
  const sources = await readCommandSources();
  if (calibration !== run) {
    // Cancelled, or listening was disabled, while the commands were read.
    return;
  }
  const availability = checkRouteAvailability(routes, DEFAULT_ROUTES, sources);
  reportAvailability(availability, true);
  if (availability.listened.length === 0) {
    run.finish("no-commands");
    return;
  }
  appliedSetAsideKey = setAsideKey(availability.setAside);
  try {
    await speechEngine.start(availability.listened, threshold, isDevMode);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", `Calibration: the engine failed to start: ${message}`);
    run.finish("error");
  }
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
  if (outcome === "no-commands") {
    // The routes and the reason were logged, and shown, by the check.
    log("warn", "Calibration: not started, because none of the routes' commands are available");
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
    case "waiting":
      // Listening was waiting for a route's command. A start checks the
      // commands again and either listens or goes back to waiting.
      speechEngine.stop();
      void startListening();
      break;
    case "off":
      speechEngine.stop();
      releaseLock(lockPath);
      setStatusBar("off");
      break;
  }
}

// ── Diagnostics ─────────────────────────────────────────────

/** What the extension is doing, in words, for Show Diagnostics. */
function describeState(): string {
  if (calibration) {
    return "calibrating";
  }
  if (lockWatchTimer !== null) {
    return "standing by: another window is listening";
  }
  if (statusBarState === "error") {
    return "error (see the error lines earlier in this channel)";
  }
  if (speechEngine.isListening) {
    return pendingConfirmation
      ? `listening, waiting to confirm "${pendingConfirmation.phrase}"`
      : "listening";
  }
  if (countdownTimer !== null) {
    return `handed off, resuming in ${countdownRemaining}s`;
  }
  if (isManuallyPaused) {
    return "handed off, waiting for you to resume";
  }
  if (isPausedByFocus) {
    return "paused while the window is unfocused";
  }
  if (speechEngine.isPaused) {
    return "paused";
  }
  if (waitingForCommands) {
    return "waiting: none of the routes' commands are available";
  }
  return "not listening";
}

/**
 * Write a diagnostics report to the output channel and offer to show it or
 * copy it for an issue. Local only: it reads settings, state, and files the
 * extension owns, and runs the engine's self-test. No audio, no network, and
 * the home directory is redacted from every line.
 */
async function runDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("wakeWord");
  const engineBinaryPath = nativeEnginePath(context.extensionPath);
  const engineBinaryStatus = await probeNativeEngine(engineBinaryPath);
  // Checked now, whatever the extension is doing: the report says which
  // routes a start would listen for, and why the others are set aside.
  const availability = await checkConfiguredRoutes();
  const model = modelStatus(context.globalStorageUri.fsPath);

  const lines = formatDiagnostics({
    extensionVersion: String(context.extension.packageJSON.version),
    platform: os.platform(),
    arch: os.arch(),
    osRelease: os.release(),
    editorName: vscode.env.appName,
    vscodeVersion: vscode.version,
    hostNodeVersion: process.version,
    engineBinaryPath,
    engineBinaryStatus,
    state: describeState(),
    isListening: speechEngine.isListening,
    isPaused: speechEngine.isPaused,
    modelName: MODEL_NAME,
    modelDir: model.dir,
    modelPresent: model.present,
    modelSha256: MODEL_SHA256,
    audioDevice: readAudioDevice(config),
    threshold: clampThreshold(config.get<number>("confidenceThreshold", DEFAULT_THRESHOLD)),
    cooldownSeconds: config.get<number>("cooldownSeconds", 30),
    confirmationMode: config.get<boolean>("confirmationMode", false),
    pauseOnFocusLoss: config.get<boolean>("pauseOnFocusLoss", false),
    enableOnStartup: config.get<boolean>("enableOnStartup", true),
    routes: availability.listened,
    setAside: availability.setAside,
    usingDefaultRoutes: filterValidRoutes(config.get<WakePhrase[]>("routes", [])).length === 0,
    phraseChecks: checkPhrases(availability.listened),
    lock: describeLock(readLock(lockPath)),
    sessionStats,
    now: Date.now(),
    homeDir: os.homedir(),
  });

  for (const line of lines) {
    log("info", line);
  }

  const choice = await vscode.window.showInformationMessage(
    "Wake Word diagnostics written to the output channel.",
    "Show Log",
    "Copy to Clipboard"
  );
  if (choice === "Show Log") {
    outputChannel.show();
  } else if (choice === "Copy to Clipboard") {
    await vscode.env.clipboard.writeText(lines.join("\n"));
    vscode.window.showInformationMessage("Wake Word: Diagnostics copied to the clipboard.");
  }
}

// ── Status bar ──────────────────────────────────────────────

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
  | "other-window"
  | "no-commands";

function setStatusBar(state: StatusBarState) {
  statusBarState = state;
  switch (state) {
    case "off":
      statusBarItem.text = "$(mic-off) Wake: Off";
      statusBarItem.tooltip = tooltipWithSettingsLink("Click to enable wake word listening.");
      statusBarItem.backgroundColor = undefined;
      break;
    case "listening":
      statusBarItem.text = "$(mic) Wake: Listening";
      statusBarItem.tooltip = tooltipWithSettingsLink(
        "Listening for wake words. Click to disable."
      );
      statusBarItem.backgroundColor = undefined;
      break;
    case "handed-off":
      statusBarItem.text = "$(mic-filled) Wake: Active";
      statusBarItem.tooltip =
        "Mic handed off to assistant. Will resume listening automatically.";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      break;
    case "paused":
      statusBarItem.text = "$(debug-pause) Wake: Paused";
      statusBarItem.tooltip = "Mic handed to assistant. Click to resume listening.";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      break;
    case "calibrating":
      statusBarItem.text = "$(pulse) Wake: Calibrating";
      statusBarItem.tooltip =
        "Listening for wake phrases without acting on them. Click to cancel.";
      statusBarItem.backgroundColor = undefined;
      break;
    case "error":
      statusBarItem.text = "$(error) Wake: Error";
      statusBarItem.tooltip = "Wake word encountered an error. Click to retry.";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      break;
    case "other-window":
      statusBarItem.text = "$(mic-off) Wake: Other window";
      statusBarItem.tooltip =
        "Another editor window is already listening. Only one instance listens " +
        "at a time. This window takes over automatically when that one stops.";
      statusBarItem.backgroundColor = undefined;
      break;
    case "no-commands":
      // Route labels and commands are the user's text and never go in this
      // trusted tooltip; the notification and Show Diagnostics name them.
      statusBarItem.text = "$(mic-off) Wake: No commands";
      statusBarItem.tooltip = tooltipWithSettingsLink(
        "None of the routes' commands are available in this editor, so the microphone is off. " +
          "Listening starts once one is available. Click to check again."
      );
      statusBarItem.backgroundColor = undefined;
      break;
  }
}
