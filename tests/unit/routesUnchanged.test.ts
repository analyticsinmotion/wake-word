import { afterEach, describe, expect, it } from "vitest";
import { WORD_BOUNDARY, buildKeywordSpec } from "../../src/keywords";
import { loadTokeniser } from "../../src/tokeniser";
import type { WakePhrase } from "../../src/speechEngineInterface";
import type { InstalledExtension } from "../../src/wakeWordCore";
import { Scopes, World, endSessions, startSession } from "../mocks/extensionSession";

/**
 * Configurations that switch no route off, driven through activate(): what
 * the engine is started with, the keyword lines built from it, the start's
 * log lines and notifications, and the Show Diagnostics report, each pinned
 * in full, with wakeWord.routesSwitchedOff absent and set to an empty list.
 * A configuration that switches nothing off gives exactly these, whatever
 * the setting does for the routes it does switch off.
 *
 * Lines that depend on the machine the tests run on are rewritten first: the
 * platform, the Node.js version, and the session's length.
 */

const MODEL_DIR = process.env.WAKE_WORD_MODEL_DIR;

const CLAUDE_CODE: InstalledExtension = {
  id: "anthropic.claude-code",
  packageJSON: {
    activationEvents: ["onStartupFinished"],
    contributes: { commands: [{ command: "claude-vscode.focus", title: "Focus" }] },
  },
};

const WORKBENCH = [
  "workbench.action.chat.open",
  "workbench.action.terminal.focus",
  "workbench.action.quickOpen",
  "workbench.action.showCommands",
];

const CUSTOM_ROUTES: unknown[] = [
  {
    label: "Claude",
    phrase: ["hey claude", "open claude"],
    command: "claude-vscode.focus",
    handoff: "manual",
    confidenceThreshold: 0.03,
  },
  { label: "Search", phrase: "search files", command: "workbench.action.quickOpen", cooldownSeconds: 10 },
  { label: "Notes", phrase: ["Open, Notes!", "what’s next"], command: "example.notes" },
  { label: "", phrase: "nameless", command: "workbench.action.showCommands" },
  { label: "Commands", phrase: ["route 66", "open commands"], command: "workbench.action.showCommands" },
];

const WARNING_ROUTES: unknown[] = [
  { label: "Claude", phrase: "hey claude", command: "claude-vscode.focus" },
  { label: "Short", phrase: "claude", command: "workbench.action.quickOpen" },
  { label: "Stop", phrase: ["stop", "Hey!"], command: "workbench.action.terminal.focus" },
  { label: "Again", phrase: "hey claude", command: "workbench.action.showCommands" },
];

interface Configuration {
  name: string;
  world: World;
  scopes: Partial<Scopes>;
  remoteName?: string;
}

const WITH_CLAUDE_CODE: World = { registered: [...WORKBENCH, "claude-vscode.focus"], installed: [CLAUDE_CODE] };

const CONFIGURATIONS: Configuration[] = [
  { name: "the default routes with Claude Code", world: WITH_CLAUDE_CODE, scopes: {} },
  { name: "the default routes without Claude Code", world: { registered: WORKBENCH, installed: [] }, scopes: {} },
  {
    name: "the default routes before Claude Code has started",
    world: { registered: WORKBENCH, installed: [CLAUDE_CODE] },
    scopes: {},
  },
  {
    name: "the default routes in a remote window",
    world: { registered: WORKBENCH, installed: [] },
    scopes: {},
    remoteName: "wsl",
  },
  {
    name: "custom routes and a threshold",
    world: WITH_CLAUDE_CODE,
    scopes: { user: { routes: CUSTOM_ROUTES, confidenceThreshold: 0.3 } },
  },
  { name: "custom routes with phrase warnings", world: WITH_CLAUDE_CODE, scopes: { user: { routes: WARNING_ROUTES } } },
  {
    name: "routes in the workspace settings over the user settings",
    world: WITH_CLAUDE_CODE,
    scopes: { user: { routes: WARNING_ROUTES }, workspace: { routes: CUSTOM_ROUTES.slice(0, 2) } },
  },
];

/**
 * A stand-in for the tokeniser's encode(): each word a boundary piece of its
 * first two letters and a piece of the rest. Which routes reach the keyword
 * lines is what is under test, not the pieces.
 */
function standInPieces(text: string): string[] {
  return text
    .split(" ")
    .filter(Boolean)
    .flatMap((word) => (word.length > 2 ? [WORD_BOUNDARY + word.slice(0, 2), word.slice(2)] : [WORD_BOUNDARY + word]));
}

/** A line with what depends on the machine running the tests rewritten. */
function machineFree(line: string): string {
  return line
    .replace(/OS: \S+ \S+, VS Code/, "OS: <platform>, VS Code")
    .replace(/Platform: .*/, "Platform: <platform>")
    .replace(/Node\.js \(extension host\): .*/, "Node.js (extension host): <version>")
    .replace(/Session: \d+min/, "Session: <n>min");
}

interface Outcome {
  labels: string[];
  threshold: number;
  keywordLines: string[];
  startLog: string[];
  warnings: string[];
  diagnostics: string[];
}

/** Start listening with a configuration, then run Show Diagnostics, and record what came of it. */
async function outcome(configuration: Configuration, extraUser: Record<string, unknown> = {}): Promise<Outcome> {
  const session = await startSession({
    world: configuration.world,
    scopes: {
      user: { ...configuration.scopes.user, ...extraUser },
      workspace: configuration.scopes.workspace,
    },
    remoteName: configuration.remoteName,
  });
  await session.run("wakeWord.enable");
  const engine = session.engine();
  const routes = engine.startedWith[0];
  const threshold = engine.thresholds[0];
  const startLog = session.logs.map(machineFree);
  const warnings = [...session.warnings];
  engine.ready();
  const before = session.logs.length;
  await session.run("wakeWord.diagnostics");
  const report = session.logs.slice(before).map(machineFree);
  return {
    labels: routes.map((route) => route.label),
    threshold,
    keywordLines: buildKeywordSpec(routes, standInPieces, threshold).keywordLines,
    startLog,
    warnings,
    diagnostics: report.slice(
      report.indexOf("[info] === Wake Word Diagnostics ==="),
      report.indexOf("[info] === End Diagnostics ===") + 1
    ),
  };
}

/** The keyword lines the real tokeniser builds for the routes a configuration starts the engine with. */
async function modelKeywordLines(configuration: Configuration, extraUser: Record<string, unknown> = {}): Promise<string[]> {
  const session = await startSession({
    world: configuration.world,
    scopes: {
      user: { ...configuration.scopes.user, ...extraUser },
      workspace: configuration.scopes.workspace,
    },
    remoteName: configuration.remoteName,
  });
  await session.run("wakeWord.enable");
  const engine = session.engine();
  const tokeniser = await loadTokeniser(MODEL_DIR as string);
  return buildKeywordSpec(
    engine.startedWith[0] as WakePhrase[],
    (text) => tokeniser.encode(text),
    engine.thresholds[0],
    tokeniser.vocabulary
  ).keywordLines;
}

afterEach(() => {
  endSessions();
});

const PINNED: Record<string, Outcome> = {
  "the default routes with Claude Code": {
    labels: ["Claude", "Chat", "Terminal"],
    threshold: 0.05,
    keywordLines: [
      "▁HE Y ▁CL AUDE :3.0 #0.05",
      "▁HE Y ▁CH AT :3.0 #0.05",
      "▁OP EN ▁CH AT :3.0 #0.05",
      "▁HE Y ▁CO MPUTER :3.0 #0.05",
      "▁OP EN ▁TE RMINAL :3.0 #0.05",
    ],
    startLog: [
      "[info] Starting: 3 routes, threshold=0.05, verbose log=off",
      "[info] OS: <platform>, VS Code: 0.0.0-test (Test Editor), window: local",
    ],
    warnings: [],
    diagnostics: [
      "[info] === Wake Word Diagnostics ===",
      "[info] Version: 0.0.0-test",
      "[info] Platform: <platform>",
      "[info] VS Code: 0.0.0-test (Test Editor)",
      "[info] Window: local",
      "[info] Node.js (extension host): <version>",
      "[info] Engine: sherpa-onnx",
      "[info] Engine binary: wake-word-engine (self-test OK)",
      "[info] State: listening",
      "[info] Listening: true",
      "[info] Paused: false",
      "[info] Model: model (downloaded)",
      "[info] Model dir: model",
      "[info] Model SHA-256: 0000000000000000...",
      "[info] Audio device: (system default)",
      "[info] Input devices: none found",
      "[info] Threshold: 0.05",
      "[info] Cooldown: 30s",
      "[info] Confirmation mode: off",
      "[info] Pause on focus loss: on",
      "[info] Enable on startup: off",
      "[info] Log level: info",
      "[info] Toggle shortcut in the terminal: sent to the shell (wakeWord.toggle is not in terminal.integrated.commandsToSkipShell)",
      "[info] Routes: 3 (defaults)",
      '[info]   "Claude" [hey claude] -> claude-vscode.focus (manual)',
      '[info]   "Chat" [hey chat, open chat] -> workbench.action.chat.open (timer)',
      '[info]   "Terminal" [hey computer, open terminal] -> workbench.action.terminal.focus (timer)',
      "[info] Set aside: none",
      "[info] Phrase checks: no warnings",
      "[info] Lock: free (no window is listening)",
      "[info] Session: <n>min, 0 detections, 0 errors, 1 engine start, 0 cooldowns",
      "[info] === End Diagnostics ===",
    ],
  },
  "the default routes without Claude Code": {
    labels: ["Chat", "Terminal"],
    threshold: 0.05,
    keywordLines: [
      "▁HE Y ▁CH AT :3.0 #0.05",
      "▁OP EN ▁CH AT :3.0 #0.05",
      "▁HE Y ▁CO MPUTER :3.0 #0.05",
      "▁OP EN ▁TE RMINAL :3.0 #0.05",
    ],
    startLog: [
      '[warning] Route "Claude" set aside: claude-vscode.focus needs Claude Code (anthropic.claude-code), which is not installed or is disabled. Its phrases are not listened for until the command is available.',
      "[info] Starting: 2 routes, 1 set aside, threshold=0.05, verbose log=off",
      "[info] OS: <platform>, VS Code: 0.0.0-test (Test Editor), window: local",
    ],
    warnings: [
      'Wake Word is not listening for "Claude": claude-vscode.focus needs Claude Code (anthropic.claude-code), which is not installed or is disabled. It comes back once the command is available.',
    ],
    diagnostics: [
      "[info] === Wake Word Diagnostics ===",
      "[info] Version: 0.0.0-test",
      "[info] Platform: <platform>",
      "[info] VS Code: 0.0.0-test (Test Editor)",
      "[info] Window: local",
      "[info] Node.js (extension host): <version>",
      "[info] Engine: sherpa-onnx",
      "[info] Engine binary: wake-word-engine (self-test OK)",
      "[info] State: listening",
      "[info] Listening: true",
      "[info] Paused: false",
      "[info] Model: model (downloaded)",
      "[info] Model dir: model",
      "[info] Model SHA-256: 0000000000000000...",
      "[info] Audio device: (system default)",
      "[info] Input devices: none found",
      "[info] Threshold: 0.05",
      "[info] Cooldown: 30s",
      "[info] Confirmation mode: off",
      "[info] Pause on focus loss: on",
      "[info] Enable on startup: off",
      "[info] Log level: info",
      "[info] Toggle shortcut in the terminal: sent to the shell (wakeWord.toggle is not in terminal.integrated.commandsToSkipShell)",
      "[info] Routes: 3 (defaults)",
      '[info]   "Chat" [hey chat, open chat] -> workbench.action.chat.open (timer)',
      '[info]   "Terminal" [hey computer, open terminal] -> workbench.action.terminal.focus (timer)',
      "[info] Set aside: 1 route, not listened for",
      '[info]   "Claude" [hey claude] -> claude-vscode.focus (manual): action-missing, claude-vscode.focus needs Claude Code (anthropic.claude-code), which is not installed or is disabled',
      "[info] Phrase checks: no warnings",
      "[info] Lock: free (no window is listening)",
      "[info] Session: <n>min, 0 detections, 0 errors, 1 engine start, 0 cooldowns",
      "[info] === End Diagnostics ===",
    ],
  },
  "the default routes before Claude Code has started": {
    labels: ["Claude", "Chat", "Terminal"],
    threshold: 0.05,
    keywordLines: [
      "▁HE Y ▁CL AUDE :3.0 #0.05",
      "▁HE Y ▁CH AT :3.0 #0.05",
      "▁OP EN ▁CH AT :3.0 #0.05",
      "▁HE Y ▁CO MPUTER :3.0 #0.05",
      "▁OP EN ▁TE RMINAL :3.0 #0.05",
    ],
    startLog: [
      '[info] Route "Claude": claude-vscode.focus is not registered yet, but anthropic.claude-code declares it, so the route is listened for.',
      "[info] Starting: 3 routes, threshold=0.05, verbose log=off",
      "[info] OS: <platform>, VS Code: 0.0.0-test (Test Editor), window: local",
    ],
    warnings: [],
    diagnostics: [
      "[info] === Wake Word Diagnostics ===",
      "[info] Version: 0.0.0-test",
      "[info] Platform: <platform>",
      "[info] VS Code: 0.0.0-test (Test Editor)",
      "[info] Window: local",
      "[info] Node.js (extension host): <version>",
      "[info] Engine: sherpa-onnx",
      "[info] Engine binary: wake-word-engine (self-test OK)",
      "[info] State: listening",
      "[info] Listening: true",
      "[info] Paused: false",
      "[info] Model: model (downloaded)",
      "[info] Model dir: model",
      "[info] Model SHA-256: 0000000000000000...",
      "[info] Audio device: (system default)",
      "[info] Input devices: none found",
      "[info] Threshold: 0.05",
      "[info] Cooldown: 30s",
      "[info] Confirmation mode: off",
      "[info] Pause on focus loss: on",
      "[info] Enable on startup: off",
      "[info] Log level: info",
      "[info] Toggle shortcut in the terminal: sent to the shell (wakeWord.toggle is not in terminal.integrated.commandsToSkipShell)",
      "[info] Routes: 3 (defaults)",
      '[info]   "Claude" [hey claude] -> claude-vscode.focus (manual)',
      '[info]   "Chat" [hey chat, open chat] -> workbench.action.chat.open (timer)',
      '[info]   "Terminal" [hey computer, open terminal] -> workbench.action.terminal.focus (timer)',
      "[info] Set aside: none",
      "[info] Phrase checks: no warnings",
      "[info] Lock: free (no window is listening)",
      "[info] Session: <n>min, 0 detections, 0 errors, 1 engine start, 0 cooldowns",
      "[info] === End Diagnostics ===",
    ],
  },
  "the default routes in a remote window": {
    labels: ["Claude", "Chat", "Terminal"],
    threshold: 0.05,
    keywordLines: [
      "▁HE Y ▁CL AUDE :3.0 #0.05",
      "▁HE Y ▁CH AT :3.0 #0.05",
      "▁OP EN ▁CH AT :3.0 #0.05",
      "▁HE Y ▁CO MPUTER :3.0 #0.05",
      "▁OP EN ▁TE RMINAL :3.0 #0.05",
    ],
    startLog: [
      '[info] Route "Claude": claude-vscode.focus is not registered yet. This is a remote window (wsl), and extensions on the remote host cannot be checked from here, so the route is listened for.',
      "[info] Starting: 3 routes, threshold=0.05, verbose log=off",
      "[info] OS: <platform>, VS Code: 0.0.0-test (Test Editor), window: remote (wsl); Wake Word runs on the local machine",
    ],
    warnings: [],
    diagnostics: [
      "[info] === Wake Word Diagnostics ===",
      "[info] Version: 0.0.0-test",
      "[info] Platform: <platform>",
      "[info] VS Code: 0.0.0-test (Test Editor)",
      "[info] Window: remote (wsl); Wake Word runs on the local machine",
      "[info] Node.js (extension host): <version>",
      "[info] Engine: sherpa-onnx",
      "[info] Engine binary: wake-word-engine (self-test OK)",
      "[info] State: listening",
      "[info] Listening: true",
      "[info] Paused: false",
      "[info] Model: model (downloaded)",
      "[info] Model dir: model",
      "[info] Model SHA-256: 0000000000000000...",
      "[info] Audio device: (system default)",
      "[info] Input devices: none found",
      "[info] Threshold: 0.05",
      "[info] Cooldown: 30s",
      "[info] Confirmation mode: off",
      "[info] Pause on focus loss: on",
      "[info] Enable on startup: off",
      "[info] Log level: info",
      "[info] Toggle shortcut in the terminal: sent to the shell (wakeWord.toggle is not in terminal.integrated.commandsToSkipShell)",
      "[info] Routes: 3 (defaults)",
      '[info]   "Claude" [hey claude] -> claude-vscode.focus (manual): not verified, remote window (wsl): its command may be on the remote host',
      '[info]   "Chat" [hey chat, open chat] -> workbench.action.chat.open (timer)',
      '[info]   "Terminal" [hey computer, open terminal] -> workbench.action.terminal.focus (timer)',
      "[info] Set aside: none",
      "[info] Phrase checks: no warnings",
      "[info] Lock: free (no window is listening)",
      "[info] Session: <n>min, 0 detections, 0 errors, 1 engine start, 0 cooldowns",
      "[info] === End Diagnostics ===",
    ],
  },
  "custom routes and a threshold": {
    labels: ["Claude", "Search", "Commands"],
    threshold: 0.3,
    keywordLines: [
      "▁HE Y ▁CL AUDE :3.0 #0.03",
      "▁OP EN ▁CL AUDE :3.0 #0.03",
      "▁SE ARCH ▁FI LES :3.0 #0.3",
      "▁OP EN ▁CO MMANDS :3.0 #0.3",
    ],
    startLog: [
      '[warning] Route "Notes" set aside: no installed extension provides example.notes. Its phrases are not listened for until the command is available.',
      "[info] Starting: 3 routes, 1 set aside, threshold=0.3 (overridden by 1 route), verbose log=off",
      "[info] OS: <platform>, VS Code: 0.0.0-test (Test Editor), window: local",
    ],
    warnings: [
      'Wake Word is not listening for "Notes": no installed extension provides example.notes. It comes back once the command is available.',
    ],
    diagnostics: [
      "[info] === Wake Word Diagnostics ===",
      "[info] Version: 0.0.0-test",
      "[info] Platform: <platform>",
      "[info] VS Code: 0.0.0-test (Test Editor)",
      "[info] Window: local",
      "[info] Node.js (extension host): <version>",
      "[info] Engine: sherpa-onnx",
      "[info] Engine binary: wake-word-engine (self-test OK)",
      "[info] State: listening",
      "[info] Listening: true",
      "[info] Paused: false",
      "[info] Model: model (downloaded)",
      "[info] Model dir: model",
      "[info] Model SHA-256: 0000000000000000...",
      "[info] Audio device: (system default)",
      "[info] Input devices: none found",
      "[info] Threshold: 0.3",
      "[info] Cooldown: 30s",
      "[info] Confirmation mode: off",
      "[info] Pause on focus loss: on",
      "[info] Enable on startup: off",
      "[info] Log level: info",
      "[info] Toggle shortcut in the terminal: sent to the shell (wakeWord.toggle is not in terminal.integrated.commandsToSkipShell)",
      "[info] Routes: 4",
      '[info]   "Claude" [hey claude, open claude] -> claude-vscode.focus (manual, threshold 0.03)',
      '[info]   "Search" [search files] -> workbench.action.quickOpen (timer, 10s)',
      '[info]   "Commands" [route 66, open commands] -> workbench.action.showCommands (timer)',
      "[info] Set aside: 1 route, not listened for",
      '[info]   "Notes" [open, notes!, what’s next] -> example.notes (timer): action-missing, no installed extension provides example.notes',
      "[info] Phrase checks: no warnings",
      "[info] Lock: free (no window is listening)",
      "[info] Session: <n>min, 0 detections, 0 errors, 1 engine start, 0 cooldowns",
      "[info] === End Diagnostics ===",
    ],
  },
  "custom routes with phrase warnings": {
    labels: ["Claude", "Short", "Stop", "Again"],
    threshold: 0.05,
    keywordLines: [
      "▁HE Y ▁CL AUDE :3.0 #0.05",
      "▁CL AUDE :3.0 #0.05",
      "▁ST OP :3.0 #0.05",
      "▁HE Y :3.0 #0.05",
      "▁HE Y ▁CL AUDE :3.0 #0.05",
    ],
    startLog: [
      "[info] Starting: 4 routes, threshold=0.05, verbose log=off",
      "[info] OS: <platform>, VS Code: 0.0.0-test (Test Editor), window: local",
      '[warning] Phrase warning (Short): "claude" is a single word. Single words cause more false positives. Consider a two-word phrase like "hey claude".',
      '[warning] Phrase warning (Stop): "stop" is a single word. Single words cause more false positives. Consider a two-word phrase like "hey stop".',
      '[warning] Phrase warning (Stop): "stop" is a very common word and will likely trigger frequently by accident.',
      '[warning] Phrase warning (Stop): "hey!" is a single word. Single words cause more false positives. Consider a two-word phrase like "hey computer".',
      '[warning] Phrase warning (Stop): "hey!" is very short (3 characters). Short phrases are harder to detect reliably.',
      '[warning] Phrase warning (Stop): "hey!" is a very common word and will likely trigger frequently by accident.',
      '[warning] Phrase collision: "claude" (Short) is contained within "hey claude" (Claude). The shorter phrase may trigger when the longer one is spoken.',
      '[warning] Phrase collision: "hey!" (Stop) is contained within "hey claude" (Claude). The shorter phrase may trigger when the longer one is spoken.',
      '[warning] Phrase collision: "Claude" and "Again" both use "hey claude". Only "Claude" can fire: a detection goes to the first matching route.',
      '[warning] Phrase collision: "claude" (Short) is contained within "hey claude" (Again). The shorter phrase may trigger when the longer one is spoken.',
      '[warning] Phrase collision: "hey!" (Stop) is contained within "hey claude" (Again). The shorter phrase may trigger when the longer one is spoken.',
    ],
    warnings: [
      "Wake Word: 11 phrase warnings found. Check the output channel for details.",
    ],
    diagnostics: [
      "[info] === Wake Word Diagnostics ===",
      "[info] Version: 0.0.0-test",
      "[info] Platform: <platform>",
      "[info] VS Code: 0.0.0-test (Test Editor)",
      "[info] Window: local",
      "[info] Node.js (extension host): <version>",
      "[info] Engine: sherpa-onnx",
      "[info] Engine binary: wake-word-engine (self-test OK)",
      "[info] State: listening",
      "[info] Listening: true",
      "[info] Paused: false",
      "[info] Model: model (downloaded)",
      "[info] Model dir: model",
      "[info] Model SHA-256: 0000000000000000...",
      "[info] Audio device: (system default)",
      "[info] Input devices: none found",
      "[info] Threshold: 0.05",
      "[info] Cooldown: 30s",
      "[info] Confirmation mode: off",
      "[info] Pause on focus loss: on",
      "[info] Enable on startup: off",
      "[info] Log level: info",
      "[info] Toggle shortcut in the terminal: sent to the shell (wakeWord.toggle is not in terminal.integrated.commandsToSkipShell)",
      "[info] Routes: 4",
      '[info]   "Claude" [hey claude] -> claude-vscode.focus (timer)',
      '[info]   "Short" [claude] -> workbench.action.quickOpen (timer)',
      '[info]   "Stop" [stop, hey!] -> workbench.action.terminal.focus (timer)',
      '[info]   "Again" [hey claude] -> workbench.action.showCommands (timer)',
      "[info] Set aside: none",
      "[info] Phrase checks: 11 warnings",
      '[info]   Phrase warning (Short): "claude" is a single word. Single words cause more false positives. Consider a two-word phrase like "hey claude".',
      '[info]   Phrase warning (Stop): "stop" is a single word. Single words cause more false positives. Consider a two-word phrase like "hey stop".',
      '[info]   Phrase warning (Stop): "stop" is a very common word and will likely trigger frequently by accident.',
      '[info]   Phrase warning (Stop): "hey!" is a single word. Single words cause more false positives. Consider a two-word phrase like "hey computer".',
      '[info]   Phrase warning (Stop): "hey!" is very short (3 characters). Short phrases are harder to detect reliably.',
      '[info]   Phrase warning (Stop): "hey!" is a very common word and will likely trigger frequently by accident.',
      '[info]   Phrase collision: "claude" (Short) is contained within "hey claude" (Claude). The shorter phrase may trigger when the longer one is spoken.',
      '[info]   Phrase collision: "hey!" (Stop) is contained within "hey claude" (Claude). The shorter phrase may trigger when the longer one is spoken.',
      '[info]   Phrase collision: "Claude" and "Again" both use "hey claude". Only "Claude" can fire: a detection goes to the first matching route.',
      '[info]   Phrase collision: "claude" (Short) is contained within "hey claude" (Again). The shorter phrase may trigger when the longer one is spoken.',
      '[info]   Phrase collision: "hey!" (Stop) is contained within "hey claude" (Again). The shorter phrase may trigger when the longer one is spoken.',
      "[info] Lock: free (no window is listening)",
      "[info] Session: <n>min, 0 detections, 0 errors, 1 engine start, 0 cooldowns",
      "[info] === End Diagnostics ===",
    ],
  },
  "routes in the workspace settings over the user settings": {
    labels: ["Claude", "Search"],
    threshold: 0.05,
    keywordLines: [
      "▁HE Y ▁CL AUDE :3.0 #0.03",
      "▁OP EN ▁CL AUDE :3.0 #0.03",
      "▁SE ARCH ▁FI LES :3.0 #0.05",
    ],
    startLog: [
      "[info] Starting: 2 routes, threshold=0.05 (overridden by 1 route), verbose log=off",
      "[info] OS: <platform>, VS Code: 0.0.0-test (Test Editor), window: local",
    ],
    warnings: [],
    diagnostics: [
      "[info] === Wake Word Diagnostics ===",
      "[info] Version: 0.0.0-test",
      "[info] Platform: <platform>",
      "[info] VS Code: 0.0.0-test (Test Editor)",
      "[info] Window: local",
      "[info] Node.js (extension host): <version>",
      "[info] Engine: sherpa-onnx",
      "[info] Engine binary: wake-word-engine (self-test OK)",
      "[info] State: listening",
      "[info] Listening: true",
      "[info] Paused: false",
      "[info] Model: model (downloaded)",
      "[info] Model dir: model",
      "[info] Model SHA-256: 0000000000000000...",
      "[info] Audio device: (system default)",
      "[info] Input devices: none found",
      "[info] Threshold: 0.05",
      "[info] Cooldown: 30s",
      "[info] Confirmation mode: off",
      "[info] Pause on focus loss: on",
      "[info] Enable on startup: off",
      "[info] Log level: info",
      "[info] Toggle shortcut in the terminal: sent to the shell (wakeWord.toggle is not in terminal.integrated.commandsToSkipShell)",
      "[info] Routes: 2",
      '[info]   "Claude" [hey claude, open claude] -> claude-vscode.focus (manual, threshold 0.03)',
      '[info]   "Search" [search files] -> workbench.action.quickOpen (timer, 10s)',
      "[info] Set aside: none",
      "[info] Phrase checks: no warnings",
      "[info] Lock: free (no window is listening)",
      "[info] Session: <n>min, 0 detections, 0 errors, 1 engine start, 0 cooldowns",
      "[info] === End Diagnostics ===",
    ],
  },
};

const MODEL_PINNED: Record<string, string[]> = {
  "the default routes with Claude Code": [
    "▁HE Y ▁C LA U DE :3.0 #0.05",
    "▁HE Y ▁CHA T :3.0 #0.05",
    "▁O P EN ▁CHA T :3.0 #0.05",
    "▁HE Y ▁COMP U TER :3.0 #0.05",
    "▁O P EN ▁ TER M IN AL :3.0 #0.05",
  ],
  "the default routes without Claude Code": [
    "▁HE Y ▁CHA T :3.0 #0.05",
    "▁O P EN ▁CHA T :3.0 #0.05",
    "▁HE Y ▁COMP U TER :3.0 #0.05",
    "▁O P EN ▁ TER M IN AL :3.0 #0.05",
  ],
  "the default routes before Claude Code has started": [
    "▁HE Y ▁C LA U DE :3.0 #0.05",
    "▁HE Y ▁CHA T :3.0 #0.05",
    "▁O P EN ▁CHA T :3.0 #0.05",
    "▁HE Y ▁COMP U TER :3.0 #0.05",
    "▁O P EN ▁ TER M IN AL :3.0 #0.05",
  ],
  "the default routes in a remote window": [
    "▁HE Y ▁C LA U DE :3.0 #0.05",
    "▁HE Y ▁CHA T :3.0 #0.05",
    "▁O P EN ▁CHA T :3.0 #0.05",
    "▁HE Y ▁COMP U TER :3.0 #0.05",
    "▁O P EN ▁ TER M IN AL :3.0 #0.05",
  ],
  "custom routes and a threshold": [
    "▁HE Y ▁C LA U DE :3.0 #0.03",
    "▁O P EN ▁C LA U DE :3.0 #0.03",
    "▁SE AR CH ▁FI LES :3.0 #0.3",
    "▁O P EN ▁COM MAN D S :3.0 #0.3",
  ],
  "custom routes with phrase warnings": [
    "▁HE Y ▁C LA U DE :3.0 #0.05",
    "▁C LA U DE :3.0 #0.05",
    "▁ST O P :3.0 #0.05",
    "▁HE Y :3.0 #0.05",
    "▁HE Y ▁C LA U DE :3.0 #0.05",
  ],
  "routes in the workspace settings over the user settings": [
    "▁HE Y ▁C LA U DE :3.0 #0.03",
    "▁O P EN ▁C LA U DE :3.0 #0.03",
    "▁SE AR CH ▁FI LES :3.0 #0.05",
  ],
};

describe("a configuration that switches no route off", () => {
  for (const configuration of CONFIGURATIONS) {
    it(`gives the pinned outcome without the setting: ${configuration.name}`, async () => {
      expect(await outcome(configuration)).toEqual(PINNED[configuration.name]);
    });

    it(`gives the pinned outcome with the setting an empty list: ${configuration.name}`, async () => {
      expect(await outcome(configuration, { routesSwitchedOff: [] })).toEqual(PINNED[configuration.name]);
    });
  }
});

describe.runIf(MODEL_DIR)("a configuration that switches no route off, with the keyword spotting model", () => {
  for (const configuration of CONFIGURATIONS) {
    it(`gives the pinned keyword lines: ${configuration.name}`, async () => {
      expect(await modelKeywordLines(configuration)).toEqual(MODEL_PINNED[configuration.name]);
      expect(await modelKeywordLines(configuration, { routesSwitchedOff: [] })).toEqual(
        MODEL_PINNED[configuration.name]
      );
    });
  }
});
