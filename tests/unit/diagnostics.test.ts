import { describe, expect, it } from "vitest";
import {
  DiagnosticsInput,
  SetAsideRoute,
  createSessionStats,
  describeWindow,
  formatDiagnostics,
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
  { label: "Chat", phrase: "hey chat", command: "workbench.action.chat.open" },
];

const STARTED = Date.UTC(2026, 8, 15, 9, 0, 0);

const ENGINE_BINARY =
  "C:\\Users\\Ann\\.vscode\\extensions\\analytics-in-motion.wake-word\\bin\\wake-word-engine.exe";

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  const stats = createSessionStats(STARTED);
  recordDetection(stats, "Claude");
  stats.engineStarts = 2;
  return {
    extensionVersion: "0.14.0",
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.26200",
    editorName: "Visual Studio Code",
    vscodeVersion: "1.104.0",
    window: "local",
    hostNodeVersion: "v22.19.0",
    engineBinaryPath: ENGINE_BINARY,
    engineBinaryStatus: "self-test OK, sherpa-onnx=1.13.8",
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
    setAside: [],
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
      "Version: 0.14.0",
      "Platform: win32 x64 (10.0.26200)",
      "VS Code: 1.104.0 (Visual Studio Code)",
      "Window: local",
      "Node.js (extension host): v22.19.0",
      "Engine: sherpa-onnx",
      "Engine binary: ~\\.vscode\\extensions\\analytics-in-motion.wake-word\\bin\\wake-word-engine.exe " +
        "(self-test OK, sherpa-onnx=1.13.8)",
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
      '  "Chat" [hey chat] -> workbench.action.chat.open (timer)',
      "Set aside: none",
      "Phrase checks: no warnings",
      "Lock: held by this window (pid 4242, since 2026-09-15T09:00:00.000Z)",
      "Session: 12min, 1 detection (Claude: 1), 0 errors, 2 engine starts, 0 cooldowns",
      "=== End Diagnostics ===",
    ]);
  });

  it("lists a route set aside apart from the ones listened for, with its status and reason", () => {
    const setAside: SetAsideRoute = {
      route: ROUTES[0],
      label: "Claude",
      isDefault: true,
      command: "claude-vscode.focus",
      reason: "action-missing",
      provider: { kind: "extension", id: "anthropic.claude-code", name: "Claude Code", installed: false },
    };
    const lines = formatDiagnostics(input({ routes: ROUTES.slice(1), setAside: [setAside], usingDefaultRoutes: true }));
    const at = lines.indexOf("Routes: 3 (defaults)");
    expect(lines.slice(at, at + 5)).toEqual([
      "Routes: 3 (defaults)",
      '  "Terminal" [hey computer, open terminal] -> workbench.action.terminal.focus (timer, 10s)',
      '  "Chat" [hey chat] -> workbench.action.chat.open (timer)',
      "Set aside: 1 route, not listened for",
      '  "Claude" [hey claude] -> claude-vscode.focus (manual): action-missing, ' +
        "claude-vscode.focus needs Claude Code (anthropic.claude-code), which is not installed or is disabled",
    ]);
  });

  it("counts several routes set aside, whatever provides their commands", () => {
    const search: WakePhrase = { label: "Search", phrase: "search files", command: "example.search" };
    const setAside: SetAsideRoute[] = [
      {
        route: search,
        label: "Search",
        isDefault: false,
        command: "example.search",
        reason: "action-missing",
        provider: { kind: "unknown" },
      },
      {
        route: ROUTES[2],
        label: "Chat",
        isDefault: false,
        command: "workbench.action.chat.open",
        reason: "action-missing",
        provider: { kind: "editor" },
      },
    ];
    const lines = formatDiagnostics(input({ routes: ROUTES.slice(0, 2), setAside }));
    expect(lines).toContain("Routes: 4");
    const at = lines.indexOf("Set aside: 2 routes, not listened for");
    expect(lines.slice(at + 1, at + 3)).toEqual([
      '  "Search" [search files] -> example.search (timer): action-missing, no installed extension provides example.search',
      '  "Chat" [hey chat] -> workbench.action.chat.open (timer): action-missing, ' +
        "workbench.action.chat.open is not available in this editor",
    ]);
  });

  it("shows a route's own threshold, and nothing for the routes without one", () => {
    const routes: WakePhrase[] = [
      { ...ROUTES[0], confidenceThreshold: 0.03 },
      ROUTES[1],
      { ...ROUTES[2], confidenceThreshold: 0.5 },
    ];
    const lines = formatDiagnostics(input({ routes }));
    expect(lines).toContain('  "Claude" [hey claude] -> claude-vscode.focus (manual, threshold 0.03)');
    expect(lines).toContain(
      '  "Terminal" [hey computer, open terminal] -> workbench.action.terminal.focus (timer, 10s)'
    );
    expect(lines).toContain(
      '  "Chat" [hey chat] -> workbench.action.chat.open (timer, threshold 0.5)'
    );
  });

  it("shows the threshold a route's keyword lines will carry, clamped", () => {
    const routes = [
      { ...ROUTES[0], confidenceThreshold: 5 },
      { ...ROUTES[2], confidenceThreshold: "nonsense" as unknown as number },
    ];
    const lines = formatDiagnostics(input({ routes, threshold: 0.3 }));
    expect(lines).toContain('  "Claude" [hey claude] -> claude-vscode.focus (manual, threshold 0.9)');
    expect(lines).toContain('  "Chat" [hey chat] -> workbench.action.chat.open (timer, threshold 0.3)');
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

  it("reports an engine binary that is not there", () => {
    const lines = formatDiagnostics(input({ engineBinaryStatus: "missing" }));
    expect(lines.some((line) => line.endsWith("wake-word-engine.exe (missing)"))).toBe(true);
  });

  it("reports an engine binary that could not be run, with the reason", () => {
    const lines = formatDiagnostics(input({ engineBinaryStatus: "could not run: spawn EACCES" }));
    expect(lines.some((line) => line.endsWith("(could not run: spawn EACCES)"))).toBe(true);
  });

  it("reports the engine binary and its self-test, with the home directory redacted", () => {
    const lines = formatDiagnostics(
      input({
        platform: "linux",
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
        engineBinaryPath: "c:\\users\\ann\\.vscode\\extensions\\wake-word\\bin\\wake-word-engine.exe",
        audioDevice: "C:\\Users\\Ann",
      })
    );
    expect(lines).toContain(
      "Engine binary: ~\\.vscode\\extensions\\wake-word\\bin\\wake-word-engine.exe " +
        "(self-test OK, sherpa-onnx=1.13.8)"
    );
    expect(lines).toContain("Audio device: ~");
    expect(lines.join("\n")).not.toMatch(/ann/i);
  });

  it("redacts case-sensitively elsewhere", () => {
    const lines = formatDiagnostics(
      input({
        platform: "linux",
        homeDir: "/home/ann",
        engineBinaryPath: "/home/ann/.vscode/extensions/wake-word/bin/wake-word-engine",
        modelDir: "/home/ann/.config/Code/User/globalStorage/x",
      })
    );
    expect(lines).toContain(
      "Engine binary: ~/.vscode/extensions/wake-word/bin/wake-word-engine (self-test OK, sherpa-onnx=1.13.8)"
    );
    expect(lines).toContain("Model dir: ~/.config/Code/User/globalStorage/x");
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
    expect(redactHome("/opt/wake-word/bin", "/", false)).toBe("/opt/wake-word/bin");
    expect(redactHome("C:\\wake-word.exe", "C:\\", true)).toBe("C:\\wake-word.exe");
    expect(redactHome("/opt/wake-word/bin", "", false)).toBe("/opt/wake-word/bin");
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

describe("describeWindow", () => {
  it("says a local window is local", () => {
    expect(describeWindow(undefined, true, false)).toBe("local");
  });

  it("names the remote and says Wake Word runs on the local machine, beside the microphone", () => {
    expect(describeWindow("wsl", true, false)).toBe("remote (wsl); Wake Word runs on the local machine");
    expect(describeWindow("ssh-remote", true, false)).toBe("remote (ssh-remote); Wake Word runs on the local machine");
  });

  it("says so when Wake Word has been made to run on the remote host", () => {
    // Only the editor's remote.extensionKind setting can do this.
    expect(describeWindow("dev-container", false, false)).toBe(
      "remote (dev-container); Wake Word runs on the remote host, away from the local microphone"
    );
  });

  it("says when the window is in a browser", () => {
    expect(describeWindow("codespaces", false, true)).toBe(
      "remote (codespaces), in a browser; Wake Word runs on the remote host, away from the local microphone"
    );
    expect(describeWindow(undefined, true, true)).toBe("local, in a browser");
  });
});

describe("formatDiagnostics in a remote window", () => {
  it("names the window, and marks a route whose command could not be checked there", () => {
    const lines = formatDiagnostics(
      input({
        window: "remote (wsl); Wake Word runs on the local machine",
        unverified: [{ label: "Claude", command: "claude-vscode.focus", remote: "wsl" }],
      })
    );
    expect(lines).toContain("Window: remote (wsl); Wake Word runs on the local machine");
    expect(lines).toContain(
      '  "Claude" [hey claude] -> claude-vscode.focus (manual): not verified, remote window (wsl): ' +
        "its command may be on the remote host"
    );
    expect(lines).toContain('  "Chat" [hey chat] -> workbench.action.chat.open (timer)');
  });
});
