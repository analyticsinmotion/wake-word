import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { EngineRestart, WakePhrase, ISpeechEngine } from "./speechEngineInterface";
import {
  MODEL_NAME,
  MODEL_SHA256,
  SherpaEngine,
  listInputDevices,
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
  MicrophoneUse,
  PendingConfirmation,
  RouteAvailability,
  SessionStats,
  StatusBarState,
  StatusFacts,
  checkRouteAvailability,
  clampThreshold,
  commandSources,
  createSessionStats,
  decideFocusLoss,
  decideListenSettingsChange,
  deriveStatus,
  describeStatus,
  describeThreshold,
  describeWindow,
  detectPhraseCollisions,
  evaluateConfirmation,
  filterValidRoutes,
  formatCalibrationReport,
  formatConfidence,
  formatDiagnostics,
  formatListenSettingsChange,
  formatPhraseChecks,
  formatPhraseChecksSummary,
  formatRestart,
  formatSessionStats,
  isVerboseLogLevel,
  issueReportText,
  issueReportUrl,
  logLevelName,
  needsListenerLock,
  phraseChecksKey,
  planAvailabilityReport,
  recordDetection,
  redactHome,
  releaseThenFire,
  resolveHandoff,
  resolveRoutes,
  setAsideKey,
  shouldDebounce,
  statusBarView,
  terminalHandsOverToggle,
  validatePhraseQuality,
} from "./wakeWordCore";
import { describeLock, lockCheckDelay, lockFilePath, readLock, releaseLock, tryAcquireLock } from "./lockFile";

let statusBarItem: vscode.StatusBarItem;
/**
 * The "Wake Word" output channel. A log channel, so the editor's own log
 * levels apply to it: Developer: Set Log Level sets it to Debug or Trace for
 * the verbose log. See applyVerboseLog().
 */
let outputChannel: vscode.LogOutputChannel;
/** The verbose log is on: the channel's level is Debug or Trace. */
let verboseLog = false;
/** Replaced by `~` in every line written to the log. */
let homeDir = "";
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let countdownRemaining = 0;
let speechEngine: ISpeechEngine;
let isStarting = false;
let isDevMode = false;
/**
 * Listening waits for this window to be focused: wakeWord.pauseOnFocusLoss
 * paused it, or kept it from starting, while the window was not focused.
 * Focus resumes it. See pauseForFocus().
 */
let isPausedByFocus = false;
/** Whether this window has focus, as the editor last said. */
let windowFocused = true;
let lastDetectionTime = 0;
let lockPath = "";
/** Set while this window stands by for another window's lock: see startLockWatcher(). */
let lockWatchTimer: ReturnType<typeof setTimeout> | null = null;
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
/**
 * A start or a resume is in flight: speechEngine.start() or resume() has
 * been called, or a resume is reading the commands first, and there is no
 * `started` yet. Calibrate starts the engine itself and does not set it.
 */
let engineStarting = false;
let calibration: CalibrationRun | null = null;
/** Advanced by each detection's handoff and by cancelPendingHandoff(). */
let handoffGeneration = 0;
/**
 * A detection's handoff is releasing the microphone and running the route's
 * command. The only thing that shows the handoff in the status bar before
 * its cooldown or manual pause begins.
 */
let handingOff = false;
/** The engine's message when it failed and was not restarted; null otherwise. */
let engineFailure: string | null = null;
/**
 * Where this extension runs in a remote window: UI, on the machine the window
 * is shown on, as the manifest asks, unless `remote.extensionKind` overrides
 * it. Undefined only where the editor does not say.
 */
let extensionKind: vscode.ExtensionKind | undefined;
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
  // The editor's own name, for a message about microphone permission, which
  // the operating system grants to the editor that started the engine.
  const engine = new SherpaEngine(context, readAudioDevice(config), vscode.env.appName);
  engine.setDebugMode(verboseLog);
  return engine;
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
    engineFailure = null;
    // A start or a resume cannot be paused until the engine is listening, so
    // one the window lost focus during is paused now, and so is a restart
    // the engine finished by itself.
    if (calibration === null && waitsForFocus()) {
      // A routes or threshold change waiting for this start is applied when
      // listening resumes instead.
      if (listenSettingsChangedWhileStarting) {
        listenSettingsChangedWhileStarting = false;
        listenSettingsChangedWhilePaused = true;
      }
      pauseForFocus("Paused: the window lost focus while listening was starting");
      return;
    }
    refreshStatusBar();
    calibration?.onEngineStarted?.();
    applyListenSettingsChangedWhileStarting(context);
  });
  // Whoever paused the engine has already recorded why: a detection's
  // handoff, the window losing focus, or Calibrate putting a handoff back.
  engine.on("paused", () => {
    // A pause calls off a restart still waiting to begin. A start or a
    // resume the restart was finishing is then over: the engine is paused,
    // and no `started` will come to end the wait for it.
    if (!engine.isStarting && !engine.restarting) {
      engineStarting = false;
    }
    refreshStatusBar();
  });
  engine.on("stopped", () => {
    engineStarting = false;
    refreshStatusBar();
  });
  engine.on("cancelled", () => {
    log("info", "Model download cancelled: listening is off. Enable listening to download the speech model again.");
    stopListening();
  });
  // The engine stopped on its own and is being brought back: logged, and
  // shown in the status bar, but not raised as an error, because it may
  // recover. The error event follows if it does not.
  engine.on("restarting", (restart: EngineRestart) => {
    log("warn", formatRestart(restart));
    refreshStatusBar();
  });
  engine.on("debug", (info: string) => log("info", info));
  engine.on("detail", (info: string) => logDetail(info));
  engine.on("warning", (msg: string) => log("warn", msg));
  engine.on("error", (err: Error) => {
    sessionStats.errors++;
    engineStarting = false;
    engineFailure = err.message;
    log("error", err.message);
    vscode.window.showErrorMessage(`Wake Word error: ${err.message}`, "Show Log").then((choice) => {
      if (choice === "Show Log") {
        outputChannel.show();
      }
    });
    refreshStatusBar();
    calibration?.finish("error");
    // An engine that failed has no microphone. A window that is not focused
    // gives the lock up, so the focused one can listen; a focused one gives
    // it up when it loses focus.
    if (waitsForFocus()) {
      releaseLockWhenClosed(speechEngine.pause());
    }
  });
}

// ── Activation ──────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  isDevMode = context.extensionMode === vscode.ExtensionMode.Development;
  console.log("[Wake Word] Activating, devMode:", isDevMode);

  homeDir = os.homedir();
  outputChannel = vscode.window.createOutputChannel("Wake Word", { log: true });
  context.subscriptions.push(outputChannel);
  verboseLog = isVerboseLogLevel(outputChannel.logLevel);
  // A level the user set earlier can arrive just after the channel is made,
  // so this is where the verbose log first goes on as well as later.
  context.subscriptions.push(outputChannel.onDidChangeLogLevel(() => applyVerboseLog()));

  // Shared by every window of this editor, which is what lets them agree on
  // who holds the microphone. See lockFile.ts.
  lockPath = lockFilePath(context.globalStorageUri.fsPath);
  sessionStats = createSessionStats();
  extensionState = context.globalState;
  extensionKind = context.extension?.extensionKind;
  // With wakeWord.pauseOnFocusLoss on, only a focused window listens.
  windowFocused = vscode.window.state.focused;

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

  refreshStatusBar();
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
      } else if (listeningWanted()) {
        // Listening, handed off, paused, starting, restarting, or waiting
        // for focus or for the other window's lock: a click turns it off, as
        // each of those tooltips says.
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
        // A start or a restart under way was on its way to listening, and
        // the new engine takes its place.
        const wasListening = speechEngine.isListening || engineStarting || Boolean(speechEngine.restarting);
        // Whatever the old engine was doing, it is about to be disposed of.
        // A routes or threshold change in the same event needs nothing of
        // its own: every path out of here ends in a start, which reads the
        // settings again.
        engineStarting = false;
        const cooldownActive = countdownTimer !== null;
        const manualActive = isManuallyPaused;
        // A window waiting for focus goes on waiting with the new engine,
        // and starts it when it is focused. The old engine, paused, closed
        // its microphone with the pause.
        isPausedByFocus = isPausedByFocus && !wasListening;
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
        if (e.affectsConfiguration("wakeWord.pauseOnFocusLoss")) {
          applyFocusSetting();
        }
        refreshStatusBar();
        return;
      }

      if (e.affectsConfiguration("wakeWord.pauseOnFocusLoss")) {
        applyFocusSetting();
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

  // With wakeWord.pauseOnFocusLoss on, listening follows focus: the window
  // that loses focus pauses and releases the listener lock, and the window
  // that gains it takes the lock and listens.
  context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => onWindowFocusChanged(state.focused)));
}

export function deactivate() {
  if (speechEngine) {
    logSessionStats();
    // stopListening() stops the lock watcher and releases the lock once the
    // engine has closed its microphone, which dispose() does at once by
    // killing the engine's child. The extension host is going away, so the
    // lock is released here, not left for a promise: a window that closes
    // hands the microphone to the next one.
    stopListening();
    speechEngine.dispose();
    releaseLock(lockPath);
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
  // Already listening, or on the way: a second start would begin the model
  // load again.
  if (speechEngine.isListening || isStarting || engineStarting || speechEngine.isStarting) {
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
        "in the editor window you are using. All audio is processed locally on " +
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
      refreshStatusBar();
    }
  } finally {
    isStarting = false;
  }
}

// ── Logging ──────────────────────────────────────────────────

/**
 * Write a line to the output channel, which adds the time and the level. The
 * home directory is replaced by `~`, as in Show Diagnostics, because a log is
 * pasted into an issue as often as the report is.
 */
function log(level: "info" | "warn" | "error", message: string) {
  const line = redactHome(message, homeDir, process.platform === "win32");
  outputChannel[level](line);
  if (isDevMode) {
    console.log("[Wake Word]", `[${level}] ${line}`);
  }
}

/**
 * A line for the verbose log, written at the debug level: shown only while
 * the channel's level is Debug or Trace.
 */
function logDetail(message: string) {
  const line = redactHome(message, homeDir, process.platform === "win32");
  outputChannel.debug(line);
  if (isDevMode) {
    console.log("[Wake Word]", `[debug] ${line}`);
  }
}

/**
 * Follow the output channel's log level. At Debug or Trace the verbose log is
 * on: the extension writes its detail, and the engine is told to send its
 * own, which a running engine takes up at once, with no restart and without
 * touching the microphone. Changing the level back turns both off.
 *
 * Nothing in the verbose log is audio or a transcript: the engine reports
 * which configured phrase it matched and what its detectors did, never what
 * was said.
 */
function applyVerboseLog(): void {
  const on = isVerboseLogLevel(outputChannel.logLevel);
  if (on === verboseLog) {
    return;
  }
  verboseLog = on;
  speechEngine?.setDebugMode(on);
  log("info", `Verbose log ${on ? "on" : "off"} (log level: ${logLevelName(outputChannel.logLevel)})`);
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
  if (consentWithdrawn()) {
    return;
  }
  waitingForCommands = false;
  // This start decides afresh what the status bar says: a failure before it
  // is behind it, and the engine is marked as starting only once it is asked
  // to start, below.
  engineFailure = null;
  engineStarting = false;

  const config = vscode.workspace.getConfiguration("wakeWord");
  const routes = buildRoutes(config);

  if (routes.length === 0) {
    vscode.window.showWarningMessage(
      "Wake Word: No wake phrases configured. Add phrases in settings."
    );
    refreshStatusBar();
    return;
  }

  // When listening follows focus, a window that is not focused does not
  // take the microphone: it waits for focus. Editor windows restored at
  // startup all start listening, and only the focused one goes on.
  if (waitsForFocus()) {
    pauseForFocus("Not listening while this window is not focused: listening starts when it is focused");
    return;
  }
  isPausedByFocus = false;

  // Only one window listens at a time: see lockFile.ts. Re-acquiring a lock
  // this window already holds is a no-op, so calling this on every start is
  // safe.
  if (!acquireListenerLock()) {
    standBy();
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
      `verbose log=${verboseLog ? "on" : "off"}${deviceNote}`
  );
  log(
    "info",
    `OS: ${process.platform} ${process.arch}, VS Code: ${vscode.version} (${vscode.env.appName}), ` +
      `window: ${currentWindow()}`
  );
  reportPhraseChecks(listened);

  engineStarting = true;
  void speechEngine.start(listened, threshold, verboseLog);
  refreshStatusBar();
}

/**
 * No route's command is available, so there is nothing to listen for. Stop
 * the engine, which only matters for a paused one left from a handoff, give
 * the listener lock up so another window can listen, and wait: an extension
 * change or a routes change starts listening again, through
 * decideListenSettingsChange(), and so does Enable or a status bar click.
 */
function waitForCommands(): void {
  releaseLockWhenClosed(speechEngine.stop());
  waitingForCommands = true;
  refreshStatusBar();
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

/**
 * What the extension is doing, for decideListenSettingsChange(). A restart
 * after the engine stopped on its own counts as a start in flight: the
 * restart brings back the settings the engine was started with, so a change
 * that arrives meanwhile is applied once it is listening again.
 */
function listeningState(): ListeningState {
  return {
    listening: speechEngine.isListening,
    starting: engineStarting || Boolean(speechEngine.restarting),
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
  engineFailure = null;
  waitingForCommands = false;
  lastDetectionTime = 0;
  releaseLockWhenClosed(speechEngine.stop());
  refreshStatusBar();
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
 * Another window holds the lock: show it, and take the lock when that window
 * releases it. See startLockWatcher().
 */
function standBy(): void {
  log(
    "info",
    pausesOnFocusLoss()
      ? "Another editor window has the microphone. This window listens as soon as that window releases it."
      : "Another editor window is listening. This window will take over if it stops."
  );
  startLockWatcher();
  refreshStatusBar();
}

/**
 * While another window holds the lock, check whether it has released it or
 * gone: closed, or crashed and left a lock naming a dead process. Either way
 * this window takes over, through resumeListening(), which resumes a paused
 * engine or starts one.
 *
 * How often depends on wakeWord.pauseOnFocusLoss: see lockCheckDelay(). With
 * it on, this window is focused, and the window that lost focus releases the
 * lock moments after it pauses. The time waited is counted from the delays
 * themselves rather than the clock.
 */
function startLockWatcher(): void {
  if (lockWatchTimer) {
    return;
  }
  let waited = 0;
  const scheduleCheck = (): void => {
    const delay = lockCheckDelay(waited, pausesOnFocusLoss());
    waited += delay;
    lockWatchTimer = setTimeout(() => {
      lockWatchTimer = null;
      if (!acquireListenerLock()) {
        scheduleCheck();
        return;
      }
      log(
        "info",
        pausesOnFocusLoss()
          ? "The other window has released the microphone. Taking over."
          : "The listening window has stopped. Taking over."
      );
      void resumeListening();
    }, delay);
  };
  scheduleCheck();
}

function stopLockWatcher(): void {
  if (lockWatchTimer) {
    clearTimeout(lockWatchTimer);
    lockWatchTimer = null;
  }
}

/**
 * What this window's engine and handoff are doing, for needsListenerLock()
 * and decideFocusLoss().
 */
function microphoneUse(): MicrophoneUse {
  return {
    calibrating: calibration !== null,
    handoff: handingOff || countdownTimer !== null || isManuallyPaused,
    listening: speechEngine.isListening,
    restarting: Boolean(speechEngine.restarting),
    starting: engineStarting || Boolean(speechEngine.isStarting),
  };
}

/**
 * Give the listener lock up once `closed`, the engine's promise that its
 * microphone is closed, settles, unless the window needs the lock again by
 * then: a start or a resume may have begun meanwhile. A window that takes
 * the lock can then never find this window's microphone still open.
 */
function releaseLockWhenClosed(closed: Promise<void>): void {
  void closed.then(() => {
    if (!needsListenerLock(microphoneUse())) {
      releaseLock(lockPath);
    }
  });
}

// ── Window focus ────────────────────────────────────────────

/** Whether listening follows focus: wakeWord.pauseOnFocusLoss, on by default. */
function pausesOnFocusLoss(): boolean {
  return vscode.workspace.getConfiguration("wakeWord").get<boolean>("pauseOnFocusLoss", true);
}

/** Listening waits for this window to be focused. */
function waitsForFocus(): boolean {
  return !windowFocused && pausesOnFocusLoss();
}

/**
 * The window gained or lost focus.
 *
 * Gaining it ends a pause for focus, even if the setting was turned off
 * meanwhile: nothing else would end it, and the status bar says it resumes
 * on focus. The resume takes the listener lock first, and stands by if the
 * window that lost focus has not released it yet.
 *
 * Losing it, with the setting on, closes this window's microphone and
 * releases the lock: see decideFocusLoss(). Moving between the editor, the
 * terminal, and panels inside the window, an assistant's panel included,
 * does not change the window's focus; another application or another editor
 * window does, and so does a dialog of the operating system's own.
 *
 * A calibration run keeps the microphone whatever the focus does: it ends
 * on its own timer, and then settles a pause for focus itself.
 */
function onWindowFocusChanged(focused: boolean): void {
  windowFocused = focused;
  if (calibration) {
    return;
  }
  if (focused) {
    if (isPausedByFocus) {
      isPausedByFocus = false;
      log("info", "Resumed: window regained focus");
      // resumeListening(), not resume(): a routes change made while the
      // window was unfocused has to be applied, and resume() would bring
      // the engine back with the old phrases.
      void resumeListening();
    }
    return;
  }
  if (pausesOnFocusLoss()) {
    onFocusLost("Paused: window lost focus");
  }
}

/** This window is not focused and listening follows focus. */
function onFocusLost(message: string): void {
  switch (decideFocusLoss(microphoneUse(), lockWatchTimer !== null)) {
    case "keep":
      // A handoff keeps the lock until it ends, and its end checks focus:
      // see resumeListening(). A calibration run settles focus when it ends.
      return;
    case "pause-when-started":
      // Paused by the started handler, once the engine is listening.
      return;
    case "pause":
    case "stand-down":
      pauseForFocus(message);
      return;
    case "release":
      // An engine that failed, or one that is off: nothing has the
      // microphone, or will have it once a stop in flight is done.
      releaseLockWhenClosed(speechEngine.pause());
      return;
  }
}

/**
 * wakeWord.pauseOnFocusLoss changed. A window standing by checks the lock at
 * the new setting's pace. Turned on in a window that is not focused, it acts
 * as the window losing focus now. Turned off, a window waiting for focus
 * goes on waiting until it is focused, as its status bar says.
 */
function applyFocusSetting(): void {
  if (lockWatchTimer !== null) {
    stopLockWatcher();
    startLockWatcher();
  }
  if (calibration === null && waitsForFocus()) {
    onFocusLost("Paused: this window is not focused, and listening now follows focus");
  }
}

/**
 * Listening waits for focus: the window is not focused and
 * wakeWord.pauseOnFocusLoss is on. The engine pauses if it is listening, and
 * also calls off a restart still waiting to begin; the listener lock is
 * released once the microphone is closed, so the focused window can take
 * it; and a window standing by for the lock stops, since it would not use
 * it. Focus ends the wait: see onWindowFocusChanged().
 */
function pauseForFocus(message: string): void {
  // Recorded before the pause, so the status bar the pause refreshes says
  // why: a pause for focus, not a handoff.
  isPausedByFocus = true;
  stopLockWatcher();
  clearConfirmation();
  releaseLockWhenClosed(speechEngine.pause());
  log("info", message);
  refreshStatusBar();
}

/**
 * Microphone consent was reset, in this window or another one, since this
 * window began listening. Listening stops instead of starting or resuming,
 * and Enable asks again.
 */
function consentWithdrawn(): boolean {
  if (extensionState?.get<boolean>(CONSENT_KEY, false)) {
    return false;
  }
  log("info", "Listening is off: microphone consent was reset. Enable listening to be asked again.");
  stopListening();
  return true;
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
 *
 * In a remote window `vscode.extensions.all` lists only the extensions that
 * run where this one does, on the local machine, so the remote's name goes
 * with the sources: a command the remote host may provide is not judged
 * missing. See commandStatus().
 */
async function readCommandSources(): Promise<CommandSources | null> {
  try {
    const registered = await vscode.commands.getCommands();
    return commandSources(registered, vscode.extensions.all, vscode.env.remoteName ?? null);
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
  // Recorded before the pause, so the status bar the pause refreshes shows
  // the handoff.
  handingOff = true;
  const outcome = await releaseThenFire(
    async () => {
      await speechEngine.pause();
      if (verboseLog) {
        logDetail(`Timing: detect-to-release ${Date.now() - now}ms`);
      }
    },
    () => handoff === handoffGeneration,
    () => vscode.commands.executeCommand(phrase.command)
  );

  if (outcome.kind === "superseded") {
    // Whatever overtook the handoff has already set the state it shows.
    log(
      "info",
      `Handoff abandoned: listening changed while the microphone was being released, so "${phrase.command}" was not run`
    );
    return;
  }
  handingOff = false;
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
  if (verboseLog) {
    logDetail(`Timing: detect-to-command ${Date.now() - now}ms`);
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
  handingOff = false;
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
  refreshStatusBar();
  confirmationTimer = setTimeout(() => {
    confirmationTimer = null;
    pendingConfirmation = null;
    log("info", `Confirmation: "${label}" expired, resuming`);
    // Whatever the state underneath is now, listening or an error during
    // the wait, is what the status bar shows.
    refreshStatusBar();
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

  countdownTimer = setInterval(() => {
    countdownRemaining--;

    if (countdownRemaining <= 0) {
      clearResumeTimer();
      // A window that is not focused leaves the microphone to the focused
      // one: see resumeListening().
      log("info", waitsForFocus() ? "Cooldown expired" : "Resumed: cooldown expired");
      void resumeListening();
    } else {
      refreshStatusBar();
    }
  }, 1000);
  refreshStatusBar();
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
  refreshStatusBar();
}

function resumeFromManualHandoff(): void {
  log("info", "Resumed: user resumed after manual handoff");
  void resumeListening();
}

/**
 * Bring listening back: at the end of a cooldown or a manual handoff, when
 * the window regains focus, and when the other window releases the lock.
 *
 * A window that is not focused, when listening follows focus, waits for
 * focus instead: the end of a handoff in a window the user has left leaves
 * the microphone to the focused window. A pause for focus released the lock,
 * so it is taken again first, and if another window has it, this one stands
 * by with its engine still paused.
 */
async function resumeListening(): Promise<void> {
  cancelPendingHandoff();
  const request = ++listenRequest;
  clearResumeTimer();
  clearConfirmation();
  isManuallyPaused = false;
  isPausedByFocus = false;
  lastDetectionTime = 0;
  engineFailure = null;
  if (consentWithdrawn()) {
    return;
  }
  if (waitsForFocus()) {
    pauseForFocus("Not resuming while this window is not focused: listening resumes when it is focused");
    return;
  }
  if (!acquireListenerLock()) {
    standBy();
    return;
  }
  stopLockWatcher();
  // From here until the engine says READY, listening is on its way back:
  // the status bar says so, and a settings change that arrives meanwhile
  // waits for READY, since the resume that would have applied it has begun.
  engineStarting = true;
  refreshStatusBar();
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
    // The window can have lost focus while the commands were read, and the
    // engine is still paused: it stays so.
    if (waitsForFocus()) {
      engineStarting = false;
      pauseForFocus("Paused: window lost focus");
      return;
    }
    if (
      speechEngine.isPaused &&
      !listenSettingsChangedWhilePaused &&
      !listenSettingsChangedWhileStarting &&
      setAsideKey(availability.setAside) === appliedSetAsideKey
    ) {
      speechEngine.resume();
      refreshStatusBar();
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

/**
 * What the extension was doing when Calibrate was run, so it can be put back.
 * A start or a restart under way counts as listening: that is where it was
 * going.
 */
function capturePriorState(): PriorState {
  if (speechEngine.isListening || engineStarting || speechEngine.restarting) {
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
  // The run starts the engine itself, if it has to: a start or resume it
  // overtook is no longer in flight, and an earlier failure is behind it.
  engineStarting = false;
  engineFailure = null;
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
          refreshStatusBar();
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
          refreshStatusBar();
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
        refreshStatusBar();
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
    await speechEngine.start(availability.listened, threshold, verboseLog);
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
    case "focus-paused":
      // The run ignored focus, so settle it now as the focus handler would
      // have: a pause for focus if the window is unfocused and the setting
      // is on, and listening otherwise. isPausedByFocus is as the run found
      // it: nothing clears it during a run.
      if (waitsForFocus()) {
        pauseForFocus("Paused: the window is not focused");
      } else {
        if (isPausedByFocus) {
          isPausedByFocus = false;
          log("info", "Resumed: after calibration, the focus pause no longer applies");
        }
        refreshStatusBar();
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
    case "waiting":
      // Listening was waiting for a route's command. A start checks the
      // commands again and either listens or goes back to waiting.
      speechEngine.stop();
      void startListening();
      break;
    case "off":
      releaseLockWhenClosed(speechEngine.stop());
      refreshStatusBar();
      break;
  }
}

// ── Diagnostics ─────────────────────────────────────────────

/**
 * What the extension is doing, in words, for Show Diagnostics: the state the
 * status bar shows, so the report and the status bar never disagree.
 */
function describeState(): string {
  return describeStatus(currentStatus());
}

/** Local or remote, and where this extension runs. See describeWindow(). */
function currentWindow(): string {
  return describeWindow(
    vscode.env.remoteName,
    extensionKind !== vscode.ExtensionKind.Workspace,
    vscode.env.uiKind === vscode.UIKind.Web
  );
}

/**
 * The names a device may carry that belong to the person: the login name and
 * the home directory's last segment. See redactDeviceName().
 */
function accountNames(): string[] {
  const names = new Set<string>([path.basename(homeDir)]);
  try {
    names.add(os.userInfo().username);
  } catch {
    // No user record, as in some containers: the home directory still counts.
  }
  return [...names].filter((name) => name.length > 0);
}

/**
 * Write a diagnostics report to the output channel and offer to show it, copy
 * it, or take it to a new issue. Local only: it reads settings, state, and
 * files the extension owns, runs the engine's self-test, and asks the engine
 * for the input devices, which opens no microphone. No audio, no network,
 * the home directory redacted from every line, and personal names from device
 * names.
 */
async function runDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("wakeWord");
  const terminal = vscode.workspace.getConfiguration("terminal.integrated");
  const engineBinaryPath = nativeEnginePath(context.extensionPath);
  const [engineBinaryStatus, devices] = await Promise.all([
    probeNativeEngine(engineBinaryPath),
    listInputDevices(engineBinaryPath),
  ]);
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
    window: currentWindow(),
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
    devices,
    accountNames: accountNames(),
    logLevel: logLevelName(outputChannel.logLevel),
    verboseLog,
    terminalShortcut: terminalHandsOverToggle(
      terminal.get<unknown>("commandsToSkipShell"),
      terminal.get<unknown>("sendKeybindingsToShell")
    ),
    threshold: clampThreshold(config.get<number>("confidenceThreshold", DEFAULT_THRESHOLD)),
    cooldownSeconds: config.get<number>("cooldownSeconds", 30),
    confirmationMode: config.get<boolean>("confirmationMode", false),
    pauseOnFocusLoss: pausesOnFocusLoss(),
    enableOnStartup: config.get<boolean>("enableOnStartup", true),
    routes: availability.listened,
    unverified: availability.unverified,
    setAside: availability.setAside,
    usingDefaultRoutes: filterValidRoutes(config.get<WakePhrase[]>("routes", [])).length === 0,
    phraseChecks: checkPhrases(availability.listened),
    lock: describeLock(readLock(lockPath)),
    sessionStats,
    now: Date.now(),
    homeDir,
  });

  for (const line of lines) {
    log("info", line);
  }

  const choice = await vscode.window.showInformationMessage(
    "Wake Word diagnostics written to the output channel.",
    "Show Log",
    "Copy to Clipboard",
    "Report Issue"
  );
  if (choice === "Show Log") {
    outputChannel.show();
  } else if (choice === "Copy to Clipboard") {
    await vscode.env.clipboard.writeText(lines.join("\n"));
    vscode.window.showInformationMessage("Wake Word: Diagnostics copied to the clipboard.");
  } else if (choice === "Report Issue") {
    await reportIssue(context, lines);
  }
}

/**
 * Take the diagnostics report to a new issue on the extension's repository:
 * put it on the clipboard and open the new-issue page in the browser. Nothing
 * is sent from here. The page opens with fixed text asking for the report,
 * and the user pastes it, reads and edits it, and submits it, or does not.
 */
async function reportIssue(context: vscode.ExtensionContext, lines: readonly string[]): Promise<void> {
  const bugs = (context.extension.packageJSON as { bugs?: { url?: unknown } }).bugs;
  const url = issueReportUrl(bugs?.url);
  await vscode.env.clipboard.writeText(issueReportText(lines));
  const opened = url ? await vscode.env.openExternal(vscode.Uri.parse(url)) : false;
  vscode.window.showInformationMessage(
    opened
      ? "Wake Word: The diagnostics report is on your clipboard. Paste it into the new issue and read it before you submit."
      : "Wake Word: The diagnostics report is on your clipboard. The issue page was not opened."
  );
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

/**
 * What the extension knows now, for deriveStatus(). Every status bar state is
 * derived from these, never set directly, so the status bar cannot say more
 * than they do: it says Listening only while the engine says it is, and
 * shows a handoff only while a detection's handoff is under way.
 */
function statusFacts(): StatusFacts {
  const calibrationOpen = calibration !== null && calibration.startedAt !== 0;
  return {
    listening: speechEngine.isListening,
    calibrating: calibrationOpen,
    confirming: pendingConfirmation?.phrase ?? null,
    handingOff,
    cooldownSeconds: countdownTimer !== null ? countdownRemaining : null,
    manualPause: isManuallyPaused,
    focusPaused: isPausedByFocus,
    restarting: speechEngine.restarting ?? null,
    // A calibration run waiting for its engine is a start as well.
    starting: engineStarting || Boolean(speechEngine.isStarting) || (calibration !== null && !calibrationOpen),
    error: engineFailure,
    standingBy: lockWatchTimer !== null ? { followsFocus: pausesOnFocusLoss() } : null,
    waitingForCommands,
  };
}

function currentStatus(): StatusBarState {
  return deriveStatus(statusFacts());
}

/** Show the state the facts give. Called after anything they are made of changes. */
function refreshStatusBar(): void {
  if (!statusBarItem) {
    return;
  }
  const view = statusBarView(currentStatus());
  statusBarItem.text = view.text;
  // Only the extension's own text goes into a trusted tooltip: a state that
  // carries a route label or an engine message has no settings link.
  statusBarItem.tooltip = view.settingsLink ? tooltipWithSettingsLink(view.tooltip) : view.tooltip;
  statusBarItem.backgroundColor = view.background
    ? new vscode.ThemeColor(`statusBarItem.${view.background}Background`)
    : undefined;
}

/**
 * Listening is on or on its way: listening, handed off, paused for focus,
 * starting, or restarting, or, when listening follows focus, waiting for the
 * window that lost focus to release the microphone. A status bar click then
 * turns it off, as each of those tooltips says.
 */
function listeningWanted(): boolean {
  return (
    speechEngine.isListening ||
    speechEngine.isPaused ||
    engineStarting ||
    Boolean(speechEngine.isStarting) ||
    Boolean(speechEngine.restarting) ||
    isPausedByFocus ||
    (lockWatchTimer !== null && pausesOnFocusLoss())
  );
}
