import * as vscode from "vscode";
import { SpeechEngine, WakePhrase } from "./speechEngine";

let statusBarItem: vscode.StatusBarItem;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let speechEngine: SpeechEngine;
let isActive = false;
let isStarting = false;

// ── Default routes ──────────────────────────────────────────

const DEFAULT_ROUTES: WakePhrase[] = [
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
    phrase: "computer",
    command: "workbench.action.terminal.focus",
  },
];

// ── Activation ──────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  speechEngine = new SpeechEngine();

  // Wire up events from the speech engine
  speechEngine.on("detected", (phrase: WakePhrase) => {
    onWakeWordDetected(phrase);
  });

  speechEngine.on("started", () => {
    isActive = true;
    setStatusBar("listening");
  });

  speechEngine.on("paused", () => {
    setStatusBar("handed-off");
  });

  speechEngine.on("stopped", () => {
    isActive = false;
    setStatusBar("off");
  });

  speechEngine.on("error", (err: Error) => {
    console.error("[Wake Word]", err);
    vscode.window.showErrorMessage(`Wake Word error: ${err.message}`);
    isActive = false;
    setStatusBar("error");
  });

  // Status bar indicator
  statusBarItem = vscode.window.createStatusBarItem(
    "wakeWord.status",
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.name = "Wake Word Status";
  statusBarItem.command = "wakeWord.toggle";
  setStatusBar("off");
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("wakeWord.enable", () =>
      handleConsentThenStart(context)
    ),
    vscode.commands.registerCommand("wakeWord.disable", () => stopListening()),
    vscode.commands.registerCommand("wakeWord.toggle", () => {
      if (isActive || speechEngine.isPaused) {
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

  // Auto-start if configured (deferred to let VS Code finish initialising)
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
      if (e.affectsConfiguration("wakeWord.routes")) {
        if (isActive) {
          stopListening();
          handleConsentThenStart(context);
        }
      }
    })
  );
}

export function deactivate() {
  stopListening();
  speechEngine.dispose();
}

// ── Consent ─────────────────────────────────────────────────

const CONSENT_KEY = "wakeWord.userConsented";

async function handleConsentThenStart(
  context: vscode.ExtensionContext
): Promise<void> {
  if (isActive || isStarting) {
    return;
  }

  const hasConsented = context.globalState.get<boolean>(CONSENT_KEY, false);

  if (hasConsented) {
    startListening();
    return;
  }

  isStarting = true;

  const choice = await vscode.window.showWarningMessage(
    "Wake Word uses your microphone to listen for wake phrases " +
      "whenever VS Code is open. All audio is processed locally on " +
      "your machine using Windows built-in speech recognition. " +
      "Nothing is recorded or transmitted.\n\n" +
      "When a wake phrase is detected, the microphone is released " +
      "so the target assistant can use it. Wake word listening " +
      "resumes automatically after a cooldown period.\n\n" +
      "You can disable this at any time from the status bar.",
    { modal: true },
    "Allow Microphone Listening",
    "Not Now"
  );

  isStarting = false;

  if (choice === "Allow Microphone Listening") {
    await context.globalState.update(CONSENT_KEY, true);
    startListening();
  } else {
    setStatusBar("off");
  }
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

  speechEngine.start(routes);
}

function stopListening() {
  clearResumeTimer();
  speechEngine.stop();
  isActive = false;
  setStatusBar("off");
}

// ── Route configuration ─────────────────────────────────────

function buildRoutes(config: vscode.WorkspaceConfiguration): WakePhrase[] {
  const userRoutes = config.get<WakePhrase[]>("routes", []);

  const validRoutes = userRoutes.filter(
    (r) => r.phrase?.trim() && r.label?.trim() && r.command?.trim()
  );

  if (validRoutes.length > 0) {
    return validRoutes;
  }

  return DEFAULT_ROUTES;
}

// ── Wake word triggered ─────────────────────────────────────

async function onWakeWordDetected(phrase: WakePhrase) {
  const config = vscode.workspace.getConfiguration("wakeWord");
  const showNotification = config.get<boolean>(
    "showNotificationOnDetection",
    true
  );
  const cooldownSeconds = config.get<number>("cooldownSeconds", 30);

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
  } catch (err: any) {
    console.error(
      `[Wake Word] Failed to execute command "${phrase.command}":`,
      err
    );
    vscode.window.showErrorMessage(
      `Wake Word: Could not execute "${phrase.command}" -- ${err.message}`
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

  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    resumeListening();
  }, seconds * 1000);
}

function resumeListening() {
  clearResumeTimer();
  speechEngine.resume();
}

function clearResumeTimer() {
  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
}

// ── Status bar ──────────────────────────────────────────────

function setStatusBar(state: "off" | "listening" | "handed-off" | "error") {
  switch (state) {
    case "off":
      statusBarItem.text = "$(mic-off) Wake: Off";
      statusBarItem.tooltip = "Click to enable wake word listening";
      statusBarItem.backgroundColor = undefined;
      break;
    case "listening":
      statusBarItem.text = "$(mic) Wake: Listening";
      statusBarItem.tooltip =
        "Listening for wake words... Click to disable";
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
    case "error":
      statusBarItem.text = "$(error) Wake: Error";
      statusBarItem.tooltip = "Wake word encountered an error. Click to retry.";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      break;
  }
}
