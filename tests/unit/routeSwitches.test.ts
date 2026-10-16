import { describe, expect, it } from "vitest";
import {
  DiagnosticsInput,
  InstalledExtension,
  RouteSwitches,
  applyRouteSwitches,
  checkRouteAvailability,
  checkSwitchedOffCommands,
  commandSources,
  createSessionStats,
  formatDiagnostics,
  formatEveryRouteSwitchedOff,
  formatNothingToListenFor,
  planAvailabilityReport,
  planRouteSwitchWrite,
  planSwitchReport,
  resolveRoutes,
  routeKey,
  routeSwitchItems,
  routeSwitchScope,
  updateRoutesSwitchedOff,
} from "../../src/wakeWordCore";
import { buildKeywordSpec } from "../../src/keywords";
import { DEFAULT_ROUTES } from "../../src/extension";
import type { WakePhrase } from "../../src/speechEngineInterface";

/**
 * Switching routes off, as pure logic: which routes a value of
 * wakeWord.routesSwitchedOff switches off, what the switch command writes and
 * where, what its list shows, what is logged, and the Show Diagnostics lines.
 */

const WORKBENCH = ["workbench.action.chat.open", "workbench.action.terminal.focus", "workbench.action.quickOpen"];

const CLAUDE_CODE: InstalledExtension = {
  id: "anthropic.claude-code",
  packageJSON: {
    activationEvents: ["onStartupFinished"],
    contributes: { commands: [{ command: "claude-vscode.focus", title: "Focus" }] },
  },
};

const SEARCH: WakePhrase = { label: "Search", phrase: "search files", command: "workbench.action.quickOpen" };
const NOTES: WakePhrase = { label: "Notes", phrase: ["open notes", "take a note"], command: "example.notes" };

/** The routes a configuration with no wakeWord.routes resolves to: the defaults themselves. */
function defaults(): WakePhrase[] {
  return resolveRoutes([], DEFAULT_ROUTES);
}

function labels(routes: readonly { label: string }[]): string[] {
  return routes.map((route) => route.label);
}

/** A stand-in tokeniser: one piece per word. */
function pieces(text: string): string[] {
  return text.split(" ").map((word) => "▁" + word);
}

describe("applyRouteSwitches", () => {
  it("switches a default route off by its label and leaves the other defaults as they are", () => {
    const routes = defaults();
    const switches = applyRouteSwitches(routes, ["Terminal"]);
    expect(labels(switches.on)).toEqual(["Claude", "Chat"]);
    expect(labels(switches.off)).toEqual(["Terminal"]);
    // The routes are the default route objects themselves, which is how the
    // availability check knows them for defaults.
    expect(switches.on[0]).toBe(DEFAULT_ROUTES[0]);
    expect(switches.off[0].route).toBe(DEFAULT_ROUTES[2]);
    expect(switches.unmatched).toEqual([]);
  });

  it("switches a route from wakeWord.routes off the same way", () => {
    const switches = applyRouteSwitches([SEARCH, NOTES], ["Notes"]);
    expect(labels(switches.on)).toEqual(["Search"]);
    expect(labels(switches.off)).toEqual(["Notes"]);
  });

  it("leaves every route on, as the same objects in the same order, when nothing is switched off", () => {
    const routes = defaults();
    for (const value of [undefined, null, [], [""], ["  "], [42, null, {}], {}, 7]) {
      const switches = applyRouteSwitches(routes, value);
      expect(switches.on).toEqual(routes);
      switches.on.forEach((route, index) => expect(route).toBe(routes[index]));
      expect(switches.off).toEqual([]);
      expect(switches.unmatched).toEqual([]);
    }
  });

  it("matches a label whatever its case and the spaces around it", () => {
    const switches = applyRouteSwitches(defaults(), ["  terminal ", "CHAT"]);
    expect(labels(switches.on)).toEqual(["Claude"]);
    expect(labels(switches.off)).toEqual(["Chat", "Terminal"]);
  });

  it("reads one label on its own as a list of one", () => {
    // settings.json is not validated against the schema.
    expect(labels(applyRouteSwitches(defaults(), "Terminal").off)).toEqual(["Terminal"]);
  });

  it("switches every route that has the label off, since labels are not unique", () => {
    const again: WakePhrase = { label: "Search", phrase: "find a file", command: "workbench.action.quickOpen" };
    const switches = applyRouteSwitches([SEARCH, NOTES, again], ["search"]);
    expect(switches.off.map((switched) => switched.route)).toEqual([SEARCH, again]);
    expect(labels(switches.on)).toEqual(["Notes"]);
  });

  it("switches every route off when every label is named", () => {
    const switches = applyRouteSwitches(defaults(), ["Claude", "Chat", "Terminal"]);
    expect(switches.on).toEqual([]);
    expect(labels(switches.off)).toEqual(["Claude", "Chat", "Terminal"]);
  });

  it("lists each label that names no route once, as written but trimmed, and switches nothing off for it", () => {
    const switches = applyRouteSwitches(defaults(), [" Termnal", "termnal", "Chat", "Notes"]);
    expect(switches.unmatched).toEqual(["Termnal", "Notes"]);
    expect(labels(switches.off)).toEqual(["Chat"]);
  });
});

describe("a route switched off contributes no keyword lines", () => {
  it("leaves its phrases out of the lines and the phrase map", () => {
    const switches = applyRouteSwitches(defaults(), ["Terminal"]);
    const listened = checkRouteAvailability(switches.on, DEFAULT_ROUTES, commandSources(WORKBENCH, [CLAUDE_CODE]))
      .listened;
    const spec = buildKeywordSpec(listened, pieces, 0.05);
    expect(Object.values(spec.phraseMap)).toEqual(["hey claude", "hey chat", "open chat"]);
    expect(spec.keywordLines).toEqual([
      "▁HEY ▁CLAUDE :3.0 #0.05",
      "▁HEY ▁CHAT :3.0 #0.05",
      "▁OPEN ▁CHAT :3.0 #0.05",
    ]);
  });
});

describe("checkSwitchedOffCommands", () => {
  it("marks a route switched off whose command is missing as well, and only that one", () => {
    const switches = applyRouteSwitches(defaults(), ["Claude", "Terminal"]);
    const checked = checkSwitchedOffCommands(switches.off, DEFAULT_ROUTES, commandSources(WORKBENCH, []));
    expect(checked[0].commandMissing?.command).toBe("claude-vscode.focus");
    expect(checked[0].commandMissing?.reason).toBe("action-missing");
    expect(checked[1].commandMissing).toBeUndefined();
  });

  it("marks nothing when the commands could not be read", () => {
    const switches = applyRouteSwitches(defaults(), ["Claude"]);
    expect(checkSwitchedOffCommands(switches.off, DEFAULT_ROUTES, null)[0].commandMissing).toBeUndefined();
  });
});

describe("routeSwitchScope", () => {
  it("writes the workspace settings when they set the value, since they override the user settings", () => {
    expect(routeSwitchScope({ workspaceValue: ["Chat"] })).toBe("workspace");
    expect(routeSwitchScope({ workspaceValue: [] })).toBe("workspace");
  });

  it("writes the user settings otherwise, and never adds a value to the workspace settings", () => {
    expect(routeSwitchScope({ workspaceValue: undefined })).toBe("user");
    expect(routeSwitchScope({})).toBe("user");
    expect(routeSwitchScope(undefined)).toBe("user");
  });
});

describe("updateRoutesSwitchedOff", () => {
  const routes = defaults();

  it("adds the label of a route switched off", () => {
    expect(updateRoutesSwitchedOff(undefined, routes, new Set(["claude", "chat"]))).toEqual(["Terminal"]);
  });

  it("removes every entry that names a route switched on, whatever its case", () => {
    expect(updateRoutesSwitchedOff([" terminal", "Chat"], routes, new Set(["claude", "terminal"]))).toEqual(["Chat"]);
  });

  it("keeps an entry that already names a route switched off as it is written, without adding another", () => {
    expect(updateRoutesSwitchedOff(["terminal"], routes, new Set(["claude", "chat"]))).toEqual(["terminal"]);
  });

  it("keeps the labels that name no route here, and anything that is not a label, in their order", () => {
    // The setting can name a route that only another workspace defines.
    expect(updateRoutesSwitchedOff(["Notes", 42, "Chat", ""], routes, new Set(["claude", "chat"]))).toEqual([
      "Notes",
      42,
      "",
      "Terminal",
    ]);
  });

  it("turns one label on its own into a list", () => {
    expect(updateRoutesSwitchedOff("Chat", routes, new Set(["claude", "terminal"]))).toEqual(["Chat"]);
  });

  it("adds a label shared by two routes once", () => {
    const again: WakePhrase = { label: "search", phrase: "find a file", command: "workbench.action.quickOpen" };
    expect(updateRoutesSwitchedOff([], [SEARCH, again, NOTES], new Set(["notes"]))).toEqual(["Search"]);
  });
});

describe("planRouteSwitchWrite", () => {
  const routes = defaults();
  const allOn = new Set(["claude", "chat", "terminal"]);

  it("writes nothing when the choice leaves the setting as it is", () => {
    expect(planRouteSwitchWrite(undefined, routes, allOn)).toBeNull();
    expect(planRouteSwitchWrite({ globalValue: [] }, routes, allOn)).toBeNull();
    expect(planRouteSwitchWrite({ globalValue: ["Terminal"] }, routes, new Set(["claude", "chat"]))).toBeNull();
    expect(planRouteSwitchWrite({ globalValue: ["Notes"] }, routes, allOn)).toBeNull();
  });

  it("writes the user settings, and removes the value there once nothing is switched off", () => {
    expect(planRouteSwitchWrite({ globalValue: undefined }, routes, new Set(["claude", "chat"]))).toEqual({
      scope: "user",
      value: ["Terminal"],
    });
    expect(planRouteSwitchWrite({ globalValue: ["Terminal"] }, routes, allOn)).toEqual({
      scope: "user",
      value: undefined,
    });
  });

  it("edits the workspace value when there is one, leaving the user value alone", () => {
    expect(
      planRouteSwitchWrite({ globalValue: ["Terminal"], workspaceValue: ["Chat"] }, routes, new Set(["claude"]))
    ).toEqual({ scope: "workspace", value: ["Chat", "Terminal"] });
  });

  it("keeps an empty list in the workspace settings, which overrides the user settings", () => {
    expect(planRouteSwitchWrite({ globalValue: ["Terminal"], workspaceValue: ["Chat"] }, routes, allOn)).toEqual({
      scope: "workspace",
      value: [],
    });
  });

  it("writes a label on its own as a list when the choice changes it", () => {
    expect(planRouteSwitchWrite({ globalValue: "Chat" }, routes, new Set(["claude"]))).toEqual({
      scope: "user",
      value: ["Chat", "Terminal"],
    });
  });
});

describe("routeSwitchItems", () => {
  it("lists one entry per route with its phrases, checked when it is switched on", () => {
    const routes = defaults();
    const items = routeSwitchItems(routes, applyRouteSwitches(routes, ["terminal"]), []);
    expect(items).toEqual([
      { key: "claude", label: "Claude", description: '"hey claude"', picked: true },
      { key: "chat", label: "Chat", description: '"hey chat", "open chat"', picked: true },
      { key: "terminal", label: "Terminal", description: '"hey computer", "open terminal"', picked: false },
    ]);
  });

  it("lists routes that share a label as one entry, and says they are switched together", () => {
    const again: WakePhrase = { label: "search ", phrase: ["find a file", "search files"], command: "x.find" };
    const items = routeSwitchItems([SEARCH, NOTES, again], applyRouteSwitches([SEARCH, NOTES, again], []), []);
    expect(items.map((item) => item.label)).toEqual(["Search", "Notes"]);
    expect(items[0].description).toBe('"search files", "find a file"');
    expect(items[0].detail).toBe("2 routes have this label, and are switched on and off together.");
  });

  it("says when a route is listened for once its command is available, switched on or off", () => {
    const routes = defaults();
    const setAside = checkRouteAvailability(routes, DEFAULT_ROUTES, commandSources(WORKBENCH, [])).setAside;
    for (const off of [[], ["Claude"]]) {
      const [claude] = routeSwitchItems(routes, applyRouteSwitches(routes, off), setAside);
      expect(claude.detail).toBe(
        "Listened for once its command is available: claude-vscode.focus needs Claude Code " +
          "(anthropic.claude-code), which is not installed or is disabled."
      );
      expect(claude.picked).toBe(off.length === 0);
    }
  });
});

describe("routeKey", () => {
  it("trims a label and puts it in lower case", () => {
    expect(routeKey("  Hey Terminal ")).toBe("hey terminal");
  });
});

describe("planSwitchReport", () => {
  const routes = defaults();

  it("says which routes are switched off at the first start of a session", () => {
    expect(planSwitchReport(applyRouteSwitches(routes, ["Terminal"]), null)).toEqual([
      {
        level: "info",
        text: 'Route "Terminal" switched off (wakeWord.routesSwitchedOff): Wake Word listens for the routes switched on.',
      },
    ]);
  });

  it("says nothing when nothing is switched off, or nothing changed since the last start", () => {
    expect(planSwitchReport(applyRouteSwitches(routes, []), null)).toEqual([]);
    const off = applyRouteSwitches(routes, ["Terminal"]);
    expect(planSwitchReport(applyRouteSwitches(routes, ["terminal"]), off)).toEqual([]);
  });

  it("says when a route is switched on again", () => {
    const off = applyRouteSwitches(routes, ["Terminal"]);
    expect(planSwitchReport(applyRouteSwitches(routes, []), off)).toEqual([
      { level: "info", text: 'Route "Terminal" switched on again.' },
    ]);
  });

  it("does not call a route removed from the settings switched on again", () => {
    const previous = applyRouteSwitches([SEARCH, NOTES], ["Notes"]);
    expect(planSwitchReport(applyRouteSwitches([SEARCH], []), previous)).toEqual([]);
  });

  it("names a label that matches no route once, not at every start", () => {
    const first = applyRouteSwitches(routes, ["Termnal"]);
    expect(planSwitchReport(first, null)).toEqual([
      {
        level: "info",
        text:
          'wakeWord.routesSwitchedOff names "Termnal", which matches no route\'s label. ' +
          "It is kept, and switches off a route given that label.",
      },
    ]);
    expect(planSwitchReport(applyRouteSwitches(routes, ["Termnal"]), first)).toEqual([]);
  });

  it("says the microphone stays closed, at every start while every route is switched off", () => {
    const all = applyRouteSwitches(routes, ["Claude", "Chat", "Terminal"]);
    const line = {
      level: "info",
      text:
        "Every route is switched off (wakeWord.routesSwitchedOff), so the microphone stays closed. " +
        "Listening starts once a route is switched on.",
    };
    expect(planSwitchReport(all, null)).toContainEqual(line);
    expect(planSwitchReport(applyRouteSwitches(routes, ["Claude", "Chat", "Terminal"]), all)).toEqual([line]);
  });
});

describe("formatEveryRouteSwitchedOff", () => {
  it("says the microphone stays closed and how to listen again", () => {
    expect(formatEveryRouteSwitchedOff()).toBe(
      "Wake Word keeps the microphone closed: every route is switched off. Switch a route on to listen for its phrases."
    );
  });
});

describe("routes switched off and set aside at once", () => {
  const routes = defaults();
  const noClaudeCode = commandSources(WORKBENCH, []);

  it("never sets aside a route that is switched off, so the user is not told about its command", () => {
    const switches = applyRouteSwitches(routes, ["Claude"]);
    const availability = checkRouteAvailability(switches.on, DEFAULT_ROUTES, noClaudeCode);
    expect(availability.setAside).toEqual([]);
    const report = planAvailabilityReport(availability, null, [["Claude", "claude-vscode.focus", "action-missing"]], false, 1);
    expect(report.notification).toBeNull();
    expect(report.lines).toEqual([]);
    // What the user was told is cleared, so switching the route on tells them again.
    expect(report.told).toEqual([]);
  });

  it("says that the other routes are switched off when the ones switched on all lack a command", () => {
    const switches = applyRouteSwitches(routes, ["Chat", "Terminal"]);
    const availability = checkRouteAvailability(switches.on, DEFAULT_ROUTES, noClaudeCode);
    const report = planAvailabilityReport(availability, null, undefined, true, switches.off.length);
    expect(report.notification).toBe(formatNothingToListenFor(availability.setAside, 2));
    expect(report.notification).toBe(
      "Wake Word keeps the microphone closed: the routes switched on need commands that are missing from " +
        'this editor, and the other routes are switched off. "Claude": claude-vscode.focus needs Claude Code ' +
        "(anthropic.claude-code), which is not installed or is disabled. Listening starts once a route's " +
        "command is available, or another route is switched on."
    );
    expect(report.lines.at(-1)?.text).toBe(
      "The routes switched on need commands that are missing from this editor, and the other routes are " +
        "switched off, so the microphone stays closed. Listening starts once a route's command is available, " +
        "or another route is switched on."
    );
  });
});

/** Show Diagnostics with the default routes, Claude Code missing, and these switches. */
function diagnostics(switchedOff: unknown, overrides: Partial<DiagnosticsInput> = {}): string[] {
  const sources = commandSources(WORKBENCH, []);
  const switches: RouteSwitches = applyRouteSwitches(defaults(), switchedOff);
  const availability = checkRouteAvailability(switches.on, DEFAULT_ROUTES, sources);
  return formatDiagnostics({
    extensionVersion: "0.18.0",
    platform: "linux",
    arch: "x64",
    osRelease: "6.8.0",
    editorName: "Visual Studio Code",
    vscodeVersion: "1.104.0",
    window: "local",
    hostNodeVersion: "v22.19.0",
    engineBinaryPath: "/ext/bin/wake-word-engine",
    engineBinaryStatus: "self-test OK",
    state: "listening",
    isListening: true,
    isPaused: false,
    modelName: "model",
    modelDir: "/model",
    modelPresent: true,
    modelSha256: "0".repeat(64),
    audioDevice: "",
    devices: { kind: "listed", devices: [] },
    accountNames: [],
    logLevel: "info",
    verboseLog: false,
    terminalShortcut: true,
    threshold: 0.05,
    cooldownSeconds: 30,
    confirmationMode: false,
    pauseOnFocusLoss: true,
    enableOnStartup: true,
    routes: availability.listened,
    unverified: availability.unverified,
    setAside: availability.setAside,
    switchedOff: checkSwitchedOffCommands(switches.off, DEFAULT_ROUTES, sources),
    unmatchedSwitches: switches.unmatched,
    usingDefaultRoutes: true,
    phraseChecks: [],
    lock: "free",
    sessionStats: createSessionStats(0),
    now: 0,
    homeDir: "/home/ann",
    ...overrides,
  });
}

/** The report's lines from `Routes:` to the line before `Phrase checks:`. */
function routeLines(lines: string[]): string[] {
  return lines.slice(
    lines.findIndex((line) => line.startsWith("Routes:")),
    lines.findIndex((line) => line.startsWith("Phrase checks:"))
  );
}

describe("Show Diagnostics with routes switched off", () => {
  it("lists the routes switched off apart from the ones set aside, and says where the setting is", () => {
    expect(routeLines(diagnostics(["Terminal"], { switchesScope: "user" }))).toEqual([
      "Routes: 3 (defaults)",
      '  "Chat" [hey chat, open chat] -> workbench.action.chat.open (timer)',
      "Set aside: 1 route, not listened for",
      '  "Claude" [hey claude] -> claude-vscode.focus (manual): action-missing, claude-vscode.focus needs ' +
        "Claude Code (anthropic.claude-code), which is not installed or is disabled",
      "Switched off: 1 route (wakeWord.routesSwitchedOff, in the user settings)",
      '  "Terminal" [hey computer, open terminal] -> workbench.action.terminal.focus (timer)',
    ]);
  });

  it("lists a route that is switched off and whose command is missing under switched off, saying both", () => {
    expect(routeLines(diagnostics(["Claude"], { switchesScope: "workspace" }))).toEqual([
      "Routes: 3 (defaults)",
      '  "Chat" [hey chat, open chat] -> workbench.action.chat.open (timer)',
      '  "Terminal" [hey computer, open terminal] -> workbench.action.terminal.focus (timer)',
      "Set aside: none",
      "Switched off: 1 route (wakeWord.routesSwitchedOff, in the workspace settings)",
      '  "Claude" [hey claude] -> claude-vscode.focus (manual): its command is missing as well, ' +
        "claude-vscode.focus needs Claude Code (anthropic.claude-code), which is not installed or is disabled",
    ]);
  });

  it("names a label that matches no route, even when nothing is switched off", () => {
    expect(routeLines(diagnostics(["Termnal"], { switchesScope: "user" })).slice(-2)).toEqual([
      "Switched off: none (wakeWord.routesSwitchedOff, in the user settings)",
      '  "Termnal": matches no route\'s label',
    ]);
  });

  it("adds nothing to the report when nothing is switched off and every label matches", () => {
    for (const value of [undefined, []]) {
      const lines = diagnostics(value);
      expect(lines.some((line) => line.startsWith("Switched off"))).toBe(false);
      expect(lines).toEqual(diagnostics(undefined, { switchedOff: undefined, unmatchedSwitches: undefined }));
    }
  });
});
