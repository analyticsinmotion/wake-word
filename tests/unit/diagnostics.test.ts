import { describe, expect, it } from "vitest";
import {
  DiagnosticsInput,
  MIN_ENGINE_NODE_MAJOR,
  createSessionStats,
  formatDiagnostics,
  nodeVersionNote,
  recordDetection,
  redactHome,
} from "../../src/wakeWordCore";
import { describeLock } from "../../src/lockFile";
import type { WakePhrase } from "../../src/speechEngineInterface";

const ROUTES: WakePhrase[] = [
  { label: "Claude", phrase: "hey claude", command: "claude-vscode.focus", handoff: "manual", cooldownSeconds: 60 },
  {
    label: "Terminal",
    phrase: ["hey computer", "Open Terminal"],
    command: "workbench.action.terminal.focus",
    cooldownSeconds: 10,
  },
  { label: "Copilot", phrase: "hey copilot", command: "workbench.action.chat.open" },
];

const STARTED = Date.UTC(2026, 8, 15, 9, 0, 0);

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  const stats = createSessionStats(STARTED);
  recordDetection(stats, "Claude");
  stats.engineStarts = 2;
  return {
    extensionVersion: "0.13.0",
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.26200",
    editorName: "Visual Studio Code",
    vscodeVersion: "1.104.0",
    hostNodeVersion: "v22.19.0",
    engineNodePath: "C:\\Program Files\\nodejs\\node.exe",
    engineNodeVersion: "v22.18.0",
    state: "listening",
    isListening: true,
    isPaused: false,
    modelName: "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
    modelDir:
      "C:\\Users\\Ann\\AppData\\Roaming\\Code\\User\\globalStorage\\analytics-in-motion.wake-word\\sherpa-onnx\\sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
    modelPresent: true,
    modelSha256: "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a",
    audioDevice: "",
    threshold: 0.3,
    cooldownSeconds: 30,
    confirmationMode: false,
    pauseOnFocusLoss: true,
    enableOnStartup: true,
    routes: ROUTES,
    usingDefaultRoutes: false,
    phraseChecks: [],
    lock: "held by this window (pid 4242, since 2026-09-15T09:00:00.000Z)",
    sessionStats: stats,
    now: STARTED + 12 * 60_000,
    homeDir: "C:\\Users\\Ann",
    ...overrides,
  };
}

describe("formatDiagnostics", () => {
  it("renders the full report", () => {
    expect(formatDiagnostics(input())).toEqual([
      "=== Wake Word Diagnostics ===",
      "Version: 0.13.0",
      "Platform: win32 x64 (10.0.26200)",
      "VS Code: 1.104.0 (Visual Studio Code)",
      "Node.js (extension host): v22.19.0",
      "Node.js (engine): C:\\Program Files\\nodejs\\node.exe (v22.18.0)",
      "Engine: sherpa-onnx",
      "State: listening",
      "Listening: true",
      "Paused: false",
      "Model: sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01 (downloaded)",
      "Model dir: ~\\AppData\\Roaming\\Code\\User\\globalStorage\\analytics-in-motion.wake-word\\sherpa-onnx\\sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
      "Model SHA-256: f170013b4716e41b...",
      "Audio device: (system default)",
      "Threshold: 0.3",
      "Cooldown: 30s",
      "Confirmation mode: off",
      "Pause on focus loss: on",
      "Enable on startup: on",
      "Routes: 3",
      '  "Claude" [hey claude] -> claude-vscode.focus (manual)',
      '  "Terminal" [hey computer, open terminal] -> workbench.action.terminal.focus (timer, 10s)',
      '  "Copilot" [hey copilot] -> workbench.action.chat.open (timer)',
      "Phrase checks: no warnings",
      "Lock: held by this window (pid 4242, since 2026-09-15T09:00:00.000Z)",
      "Session: 12min, 1 detection (Claude: 1), 0 errors, 2 engine starts, 0 cooldowns",
      "=== End Diagnostics ===",
    ]);
  });

  it("marks the built-in routes", () => {
    expect(formatDiagnostics(input({ usingDefaultRoutes: true }))).toContain("Routes: 3 (defaults)");
  });

  it("names a configured audio device and a missing model", () => {
    const lines = formatDiagnostics(input({ audioDevice: "USB", modelPresent: false }));
    expect(lines).toContain("Audio device: USB");
    expect(lines).toContain("Model: sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01 (not downloaded)");
  });

  it("lists phrase check lines under a count", () => {
    const lines = formatDiagnostics(
      input({ phraseChecks: ["Phrase warning (Go): one", "Phrase collision: two"] })
    );
    const at = lines.indexOf("Phrase checks: 2 warnings");
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 3)).toEqual(["  Phrase warning (Go): one", "  Phrase collision: two"]);
  });

  it("flags an engine Node.js older than the supported version", () => {
    expect(formatDiagnostics(input({ engineNodeVersion: "v20.11.1" }))).toContain(
      "Node.js (engine): C:\\Program Files\\nodejs\\node.exe (v20.11.1) (Wake Word requires 22 or later)"
    );
  });

  it("reports a Node.js that could not be run as given", () => {
    const lines = formatDiagnostics(input({ engineNodePath: "node", engineNodeVersion: "could not run: spawn node ENOENT" }));
    expect(lines).toContain("Node.js (engine): node (could not run: spawn node ENOENT)");
  });

  it("reports the engine binary and its self-test, with the home directory redacted", () => {
    const lines = formatDiagnostics(
      input({
        homeDir: "/home/ann",
        engineBinaryPath: "/home/ann/.vscode/extensions/wake-word/bin/wake-word-engine",
        engineBinaryStatus:
          "self-test OK, sherpa-onnx=1.13.8, ort=/home/ann/.vscode/extensions/wake-word/bin/libonnxruntime.so",
      })
    );
    const at = lines.indexOf("Engine: sherpa-onnx");
    expect(lines[at + 1]).toBe(
      "Engine binary: ~/.vscode/extensions/wake-word/bin/wake-word-engine " +
        "(self-test OK, sherpa-onnx=1.13.8, ort=~/.vscode/extensions/wake-word/bin/libonnxruntime.so)"
    );
  });

  it("leaves the engine binary line out when it is not given one", () => {
    expect(formatDiagnostics(input()).some((line) => line.startsWith("Engine binary:"))).toBe(false);
  });

  it("reports the settings it is given", () => {
    const lines = formatDiagnostics(
      input({ threshold: 0.5, cooldownSeconds: 45, confirmationMode: true, pauseOnFocusLoss: false, enableOnStartup: false })
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        "Threshold: 0.5",
        "Cooldown: 45s",
        "Confirmation mode: on",
        "Pause on focus loss: off",
        "Enable on startup: off",
      ])
    );
  });

  it("redacts the home directory from every line, ignoring case on Windows", () => {
    const lines = formatDiagnostics(
      input({
        engineNodePath: "c:\\users\\ann\\AppData\\Local\\fnm\\node.exe",
        audioDevice: "C:\\Users\\Ann",
      })
    );
    expect(lines).toContain("Node.js (engine): ~\\AppData\\Local\\fnm\\node.exe (v22.18.0)");
    expect(lines).toContain("Audio device: ~");
    expect(lines.join("\n")).not.toMatch(/ann/i);
  });

  it("redacts case-sensitively elsewhere", () => {
    const lines = formatDiagnostics(
      input({
        platform: "linux",
        homeDir: "/home/ann",
        engineNodePath: "/home/ann/.nvm/versions/node/v22.18.0/bin/node",
        modelDir: "/home/ann/.config/Code/User/globalStorage/x",
      })
    );
    expect(lines).toContain("Node.js (engine): ~/.nvm/versions/node/v22.18.0/bin/node (v22.18.0)");
    expect(lines).toContain("Model dir: ~/.config/Code/User/globalStorage/x");
  });
});

describe("nodeVersionNote", () => {
  it("says nothing for a supported version", () => {
    expect(MIN_ENGINE_NODE_MAJOR).toBe(22);
    expect(nodeVersionNote("v22.0.0")).toBe("");
    expect(nodeVersionNote("v24.3.1")).toBe("");
  });

  it("notes an older version", () => {
    expect(nodeVersionNote("v18.19.0")).toBe(" (Wake Word requires 22 or later)");
    expect(nodeVersionNote("20.11.1")).toBe(" (Wake Word requires 22 or later)");
  });

  it("says nothing about text that is not a version", () => {
    expect(nodeVersionNote("could not run: spawn node ENOENT")).toBe("");
    expect(nodeVersionNote("")).toBe("");
  });
});

describe("redactHome", () => {
  it("replaces the home directory at the start of a path", () => {
    expect(redactHome("/home/ann/.config", "/home/ann", false)).toBe("~/.config");
  });

  it("replaces a line that is only the home directory", () => {
    expect(redactHome("/home/ann", "/home/ann", false)).toBe("~");
  });

  it("replaces every occurrence", () => {
    expect(redactHome("a=/home/ann/x b=/home/ann/y", "/home/ann", false)).toBe("a=~/x b=~/y");
  });

  it("matches whole path segments only", () => {
    expect(redactHome("/home/anna/x", "/home/ann", false)).toBe("/home/anna/x");
  });

  it("tolerates a trailing separator on the home directory", () => {
    expect(redactHome("C:\\Users\\Ann\\x", "C:\\Users\\Ann\\", true)).toBe("~\\x");
  });

  it("honours case sensitivity", () => {
    expect(redactHome("C:\\USERS\\ANN\\x", "C:\\Users\\Ann", true)).toBe("~\\x");
    expect(redactHome("/HOME/ANN/x", "/home/ann", false)).toBe("/HOME/ANN/x");
  });

  it("escapes characters that mean something in a pattern", () => {
    expect(redactHome("C:\\Users\\a.b (x)+\\y", "C:\\Users\\a.b (x)+", true)).toBe("~\\y");
    expect(redactHome("C:\\Users\\aXb (x)+\\y", "C:\\Users\\a.b (x)+", true)).toBe("C:\\Users\\aXb (x)+\\y");
  });

  it("leaves text alone for a root, drive-only, or empty home", () => {
    expect(redactHome("/usr/bin/node", "/", false)).toBe("/usr/bin/node");
    expect(redactHome("C:\\node.exe", "C:\\", true)).toBe("C:\\node.exe");
    expect(redactHome("/usr/bin/node", "", false)).toBe("/usr/bin/node");
  });
});

describe("describeLock", () => {
  const alive = () => true;
  const dead = () => false;

  it("describes a free lock", () => {
    expect(describeLock({ kind: "absent" }, 1, alive)).toBe("free (no window is listening)");
  });

  it("describes an unreadable lock", () => {
    expect(describeLock({ kind: "corrupt" }, 1, alive)).toBe(
      "unreadable (the next window to start listening takes it over)"
    );
  });

  it("describes a lock this window holds", () => {
    const state = { kind: "held" as const, lock: { pid: 7, startedAt: "2026-09-15T09:00:00.000Z" } };
    expect(describeLock(state, 7, dead)).toBe("held by this window (pid 7, since 2026-09-15T09:00:00.000Z)");
  });

  it("describes a lock another running window holds", () => {
    const state = { kind: "held" as const, lock: { pid: 8, startedAt: "" } };
    expect(describeLock(state, 7, alive)).toBe("held by another window (pid 8)");
  });

  it("describes a lock left by a process that is gone", () => {
    const state = { kind: "held" as const, lock: { pid: 8, startedAt: "2026-09-15T09:00:00.000Z" } };
    expect(describeLock(state, 7, dead)).toBe(
      "stale (pid 8 is not running; the next window to start listening takes it over)"
    );
  });
});
