import { describe, expect, it } from "vitest";
import {
  InstalledExtension,
  RouteAvailability,
  SetAsideRoute,
  checkRouteAvailability,
  commandProvider,
  commandSources,
  commandStatus,
  declaredCommands,
  describeMissingCommand,
  formatNothingToListenFor,
  formatSetAsideNotification,
  manifestCommands,
  planAvailabilityReport,
  resolveRoutes,
  setAsideKey,
} from "../../src/wakeWordCore";
import { buildKeywordSpec } from "../../src/keywords";
import { DEFAULT_ROUTES } from "../../src/extension";
import type { WakePhrase } from "../../src/speechEngineInterface";

/** The editor's own commands behind the Chat and Terminal default routes. */
const WORKBENCH = ["workbench.action.chat.open", "workbench.action.terminal.focus"];

/** The manifest fields the check reads from the extension behind the Claude route. */
const CLAUDE_CODE: InstalledExtension = {
  id: "anthropic.claude-code",
  packageJSON: {
    activationEvents: ["onStartupFinished"],
    contributes: { commands: [{ command: "claude-vscode.focus", title: "Focus" }] },
  },
};

const SEARCH: WakePhrase = { label: "Search", phrase: "search files", command: "example.search" };

function sources(registered: string[], extensions: InstalledExtension[] = []) {
  return commandSources(registered, extensions);
}

function defaults(): WakePhrase[] {
  return resolveRoutes([], DEFAULT_ROUTES);
}

/** What is checked with no Claude Code installed: the Claude route set aside. */
function withoutClaudeCode(): RouteAvailability {
  return checkRouteAvailability(defaults(), DEFAULT_ROUTES, sources(WORKBENCH));
}

function labels(routes: readonly { label: string }[]): string[] {
  return routes.map((r) => r.label);
}

describe("manifestCommands", () => {
  it("reads every contributed command", () => {
    expect(
      manifestCommands({
        contributes: { commands: [{ command: "example.one", title: "One" }, { command: "example.two" }] },
      })
    ).toEqual(["example.one", "example.two"]);
  });

  it("reads a contributed command given as a single object", () => {
    expect(manifestCommands({ contributes: { commands: { command: "example.one", title: "One" } } })).toEqual([
      "example.one",
    ]);
  });

  it("reads the commands named by onCommand activation events", () => {
    // Running such a command starts the extension, which then registers it,
    // whether or not the manifest also lists it under contributes.
    expect(
      manifestCommands({ activationEvents: ["onStartupFinished", "onCommand:example.hidden", "onCommand:"] })
    ).toEqual(["example.hidden"]);
  });

  it("reads both, contributed commands first", () => {
    expect(
      manifestCommands({
        activationEvents: ["onCommand:example.hidden"],
        contributes: { commands: [{ command: "example.one" }] },
      })
    ).toEqual(["example.one", "example.hidden"]);
  });

  it("skips anything malformed rather than throwing", () => {
    // Another publisher's manifest: nothing about its shape is guaranteed.
    for (const manifest of [undefined, null, 42, "text", [], {}, { contributes: "x" }, { contributes: [] }]) {
      expect(manifestCommands(manifest)).toEqual([]);
    }
    expect(
      manifestCommands({
        activationEvents: "onCommand:example.one",
        contributes: { commands: [null, 1, "example.two", { command: 5 }, { command: "" }, { title: "No id" }] },
      })
    ).toEqual([]);
    expect(manifestCommands({ activationEvents: [null, 7, { event: "onCommand:x" }] })).toEqual([]);
  });
});

describe("declaredCommands", () => {
  it("maps each declared command to the extension that declares it", () => {
    const declared = declaredCommands([
      CLAUDE_CODE,
      { id: "example.tools", packageJSON: { activationEvents: ["onCommand:example.search"] } },
    ]);
    expect(declared.get("claude-vscode.focus")).toBe("anthropic.claude-code");
    expect(declared.get("example.search")).toBe("example.tools");
    expect(declared.has("workbench.action.chat.open")).toBe(false);
  });

  it("keeps the first extension that declares a command", () => {
    const declared = declaredCommands([
      { id: "example.first", packageJSON: { contributes: { commands: [{ command: "example.shared" }] } } },
      { id: "example.second", packageJSON: { contributes: { commands: [{ command: "example.shared" }] } } },
    ]);
    expect(declared.get("example.shared")).toBe("example.first");
  });
});

describe("commandStatus", () => {
  it("counts a registered command as available", () => {
    expect(commandStatus("workbench.action.chat.open", sources(WORKBENCH))).toBe("registered");
  });

  it("counts a command declared by an installed extension that has not registered it yet as available", () => {
    // The extension has not started, so getCommands() does not list its
    // commands; running one would start it first. This is the case a check
    // on registered commands alone gets wrong.
    expect(commandStatus("claude-vscode.focus", sources(WORKBENCH, [CLAUDE_CODE]))).toBe("declared");
  });

  it("prefers registered when a command is both registered and declared", () => {
    expect(commandStatus("claude-vscode.focus", sources(["claude-vscode.focus"], [CLAUDE_CODE]))).toBe(
      "registered"
    );
  });

  it("counts a command in neither as missing", () => {
    expect(commandStatus("claude-vscode.focus", sources(WORKBENCH))).toBe("missing");
    expect(commandStatus("example.search", sources(WORKBENCH, [CLAUDE_CODE]))).toBe("missing");
  });

  it("compares command IDs exactly, as the editor does", () => {
    expect(commandStatus("Claude-vscode.focus", sources(WORKBENCH, [CLAUDE_CODE]))).toBe("missing");
    expect(commandStatus(" claude-vscode.focus", sources(["claude-vscode.focus"]))).toBe("missing");
  });
});

describe("commandProvider", () => {
  it("names Claude Code for its commands, and whether it is installed", () => {
    expect(commandProvider("claude-vscode.focus", new Set())).toEqual({
      kind: "extension",
      id: "anthropic.claude-code",
      name: "Claude Code",
      installed: false,
    });
    expect(commandProvider("claude-vscode.focus", sources([], [CLAUDE_CODE]).installed)).toMatchObject({
      installed: true,
    });
  });

  it("matches the installed extension whatever the case of its identifier", () => {
    const installed = sources([], [{ id: "Anthropic.Claude-Code", packageJSON: {} }]).installed;
    expect(commandProvider("claude-vscode.focus", installed)).toMatchObject({ installed: true });
  });

  it("names the editor for its own commands", () => {
    expect(commandProvider("workbench.action.chat.open", new Set())).toEqual({ kind: "editor" });
  });

  it("names nothing for any other command", () => {
    expect(commandProvider("example.search", new Set())).toEqual({ kind: "unknown" });
    expect(commandProvider("claude-vscode-other.focus", new Set())).toEqual({ kind: "unknown" });
  });
});

describe("checkRouteAvailability", () => {
  it("listens for a route whose extension is installed but has not started yet", () => {
    // Claude Code and this extension both activate on onStartupFinished, in
    // no fixed order, so at the first check Claude Code's commands are often
    // not registered yet. The Claude route works all the same.
    const availability = checkRouteAvailability(defaults(), DEFAULT_ROUTES, sources(WORKBENCH, [CLAUDE_CODE]));
    expect(labels(availability.listened)).toEqual(["Claude", "Chat", "Terminal"]);
    expect(availability.setAside).toEqual([]);
    expect(availability.declaredOnly).toEqual([
      { label: "Claude", command: "claude-vscode.focus", extension: "anthropic.claude-code" },
    ]);
  });

  it("listens for routes whose commands are registered", () => {
    const availability = checkRouteAvailability(
      defaults(),
      DEFAULT_ROUTES,
      sources([...WORKBENCH, "claude-vscode.focus"], [CLAUDE_CODE])
    );
    expect(labels(availability.listened)).toEqual(["Claude", "Chat", "Terminal"]);
    expect(availability.declaredOnly).toEqual([]);
  });

  it("sets aside a route whose command is missing, and records why", () => {
    const availability = withoutClaudeCode();
    expect(labels(availability.listened)).toEqual(["Chat", "Terminal"]);
    expect(availability.setAside).toEqual([
      {
        route: DEFAULT_ROUTES[0],
        label: "Claude",
        isDefault: true,
        command: "claude-vscode.focus",
        reason: "action-missing",
        provider: { kind: "extension", id: "anthropic.claude-code", name: "Claude Code", installed: false },
      },
    ]);
  });

  it("marks a route from the settings as not a default, even when it matches one", () => {
    const own: WakePhrase = { ...DEFAULT_ROUTES[0] };
    const availability = checkRouteAvailability([own, SEARCH], DEFAULT_ROUTES, sources(WORKBENCH));
    expect(availability.setAside.map((r) => [r.label, r.isDefault, r.provider.kind])).toEqual([
      ["Claude", false, "extension"],
      ["Search", false, "unknown"],
    ]);
  });

  it("keeps the configured order in both lists", () => {
    const routes: WakePhrase[] = [
      { label: "A", phrase: "alpha one", command: "example.a" },
      { label: "B", phrase: "bravo one", command: "workbench.action.chat.open" },
      { label: "C", phrase: "charlie one", command: "example.c" },
      { label: "D", phrase: "delta one", command: "workbench.action.terminal.focus" },
    ];
    const availability = checkRouteAvailability(routes, DEFAULT_ROUTES, sources(WORKBENCH));
    expect(labels(availability.listened)).toEqual(["B", "D"]);
    expect(labels(availability.setAside)).toEqual(["A", "C"]);
  });

  it("records the reason apart from the route, which it leaves as configured", () => {
    // The reason is a value of its own on a separate record. Nothing is
    // written onto the route, so no other way of switching a route off can
    // be confused with a missing command.
    const route: WakePhrase = { label: "Search", phrase: "search files", command: "example.search", handoff: "manual" };
    const before = JSON.stringify(route);
    const [setAside] = checkRouteAvailability([route], DEFAULT_ROUTES, sources(WORKBENCH)).setAside;
    expect(setAside.reason).toBe("action-missing");
    expect(setAside.route).toBe(route);
    expect(JSON.stringify(route)).toBe(before);
  });

  it("says when the providing extension is installed but lacks the command", () => {
    const routes: WakePhrase[] = [{ label: "Claude", phrase: "hey claude", command: "claude-vscode.fokus" }];
    const [setAside] = checkRouteAvailability(routes, DEFAULT_ROUTES, sources(WORKBENCH, [CLAUDE_CODE])).setAside;
    expect(setAside.provider).toMatchObject({ kind: "extension", installed: true });
    expect(describeMissingCommand(setAside)).toBe(
      "Claude Code (anthropic.claude-code) is installed but does not provide claude-vscode.fokus"
    );
  });

  it("listens for every route when the commands could not be read", () => {
    const availability = checkRouteAvailability([...defaults(), SEARCH], DEFAULT_ROUTES, null);
    expect(labels(availability.listened)).toEqual(["Claude", "Chat", "Terminal", "Search"]);
    expect(availability.setAside).toEqual([]);
  });
});

describe("a route set aside contributes no keyword lines", () => {
  // One piece per word, so a phrase's lines are easy to recognise.
  const encode = (text: string): string[] => text.split(/\s+/).map((word) => `▁${word}`);

  it("leaves the set-aside route's phrases out of the lines and the phrase map", () => {
    const spec = buildKeywordSpec(withoutClaudeCode().listened, encode, 0.05);
    expect(spec.keywordLines.some((line) => line.includes("▁CLAUDE"))).toBe(false);
    expect(Object.values(spec.phraseMap)).toEqual(["hey chat", "open chat", "hey computer", "open terminal"]);
  });

  it("includes them once the command is available", () => {
    const availability = checkRouteAvailability(defaults(), DEFAULT_ROUTES, sources(WORKBENCH, [CLAUDE_CODE]));
    const spec = buildKeywordSpec(availability.listened, encode, 0.05);
    expect(spec.keywordLines[0]).toBe("▁HEY ▁CLAUDE :3.0 #0.05");
    expect(Object.values(spec.phraseMap)).toContain("hey claude");
  });
});

describe("setAsideKey", () => {
  const search = checkRouteAvailability([SEARCH], DEFAULT_ROUTES, sources(WORKBENCH)).setAside;
  const claude = withoutClaudeCode().setAside;

  it("is empty when nothing is set aside", () => {
    expect(setAsideKey([])).toBe("");
  });

  it("does not depend on the order of the routes", () => {
    expect(setAsideKey([...claude, ...search])).toBe(setAsideKey([...search, ...claude]));
  });

  it("changes when the routes set aside change", () => {
    expect(setAsideKey(claude)).not.toBe(setAsideKey([...claude, ...search]));
    const renamed = checkRouteAvailability([{ ...SEARCH, label: "Find" }], DEFAULT_ROUTES, sources(WORKBENCH));
    expect(setAsideKey(renamed.setAside)).not.toBe(setAsideKey(search));
  });
});

describe("describeMissingCommand", () => {
  it("names the extension to install for a default route's command", () => {
    expect(describeMissingCommand(withoutClaudeCode().setAside[0])).toBe(
      "claude-vscode.focus needs Claude Code (anthropic.claude-code), which is not installed or is disabled"
    );
  });

  it("says an editor command is not in this editor", () => {
    const availability = checkRouteAvailability(defaults(), DEFAULT_ROUTES, sources([], [CLAUDE_CODE]));
    expect(availability.setAside.map(describeMissingCommand)).toEqual([
      "workbench.action.chat.open is not available in this editor",
      "workbench.action.terminal.focus is not available in this editor",
    ]);
  });

  it("names the command and says no installed extension provides it", () => {
    const [setAside] = checkRouteAvailability([SEARCH], DEFAULT_ROUTES, sources(WORKBENCH)).setAside;
    expect(describeMissingCommand(setAside)).toBe("no installed extension provides example.search");
  });
});

describe("planAvailabilityReport", () => {
  const CLAUDE_TOLD = [["Claude", "claude-vscode.focus", "action-missing"]];
  const withClaudeCode = (): RouteAvailability =>
    checkRouteAvailability(defaults(), DEFAULT_ROUTES, sources([...WORKBENCH, "claude-vscode.focus"], [CLAUDE_CODE]));

  it("logs a route newly set aside and tells the user once, naming the route, its command, and the extension", () => {
    const report = planAvailabilityReport(withoutClaudeCode(), null, undefined, false);
    expect(report.lines).toEqual([
      {
        level: "warn",
        text:
          'Route "Claude" set aside: claude-vscode.focus needs Claude Code (anthropic.claude-code), ' +
          "which is not installed or is disabled. Its phrases are not listened for until the command is available.",
      },
    ]);
    expect(report.notification).toBe(
      'Wake Word is not listening for "Claude": claude-vscode.focus needs Claude Code (anthropic.claude-code), ' +
        "which is not installed or is disabled. It comes back once the command is available."
    );
    expect(report.told).toEqual(CLAUDE_TOLD);
  });

  it("does not tell the user again after a restart when the set is unchanged, but logs it for the new session", () => {
    const report = planAvailabilityReport(withoutClaudeCode(), null, CLAUDE_TOLD, false);
    expect(report.notification).toBeNull();
    expect(report.lines).toHaveLength(1);
    expect(report.told).toBeNull();
  });

  it("says nothing on a later check this session when nothing changed", () => {
    const first = withoutClaudeCode();
    const report = planAvailabilityReport(withoutClaudeCode(), first, CLAUDE_TOLD, false);
    expect(report).toEqual({ lines: [], notification: null, told: null });
  });

  it("logs a route that comes back, with no notification, and forgets that the user was told", () => {
    const report = planAvailabilityReport(withClaudeCode(), withoutClaudeCode(), CLAUDE_TOLD, false);
    expect(report.lines).toEqual([
      { level: "info", text: 'Route "Claude" is back: claude-vscode.focus is available again.' },
    ]);
    expect(report.notification).toBeNull();
    expect(report.told).toEqual([]);
  });

  it("tells the user again if a route that came back is set aside again", () => {
    const report = planAvailabilityReport(withoutClaudeCode(), withClaudeCode(), [], false);
    expect(report.notification).not.toBeNull();
  });

  it("does not call a route removed from the settings back", () => {
    const onlyChat = checkRouteAvailability([DEFAULT_ROUTES[1]], DEFAULT_ROUTES, sources(WORKBENCH));
    const report = planAvailabilityReport(onlyChat, withoutClaudeCode(), CLAUDE_TOLD, false);
    expect(report.lines).toEqual([]);
    expect(report.told).toEqual([]);
  });

  it("names only the routes the user has not been told about", () => {
    const availability = checkRouteAvailability([...defaults(), SEARCH], DEFAULT_ROUTES, sources(WORKBENCH));
    const report = planAvailabilityReport(availability, null, CLAUDE_TOLD, false);
    expect(report.notification).toBe(
      'Wake Word is not listening for "Search": no installed extension provides example.search. ' +
        "It comes back once the command is available."
    );
    expect(report.told).toEqual([...CLAUDE_TOLD, ["Search", "example.search", "action-missing"]]);
  });

  it("names every route newly set aside in one notification", () => {
    const availability = checkRouteAvailability([...defaults(), SEARCH], DEFAULT_ROUTES, sources(WORKBENCH));
    expect(planAvailabilityReport(availability, null, [], false).notification).toBe(
      "Wake Word is not listening for 2 routes whose commands are missing. " +
        '"Claude": claude-vscode.focus needs Claude Code (anthropic.claude-code), which is not installed or is disabled. ' +
        '"Search": no installed extension provides example.search. ' +
        "They come back once their commands are available."
    );
  });

  it("compares with what the user was told whatever its order", () => {
    const availability = checkRouteAvailability([...defaults(), SEARCH], DEFAULT_ROUTES, sources(WORKBENCH));
    const told = [["Search", "example.search", "action-missing"], ...CLAUDE_TOLD];
    const report = planAvailabilityReport(availability, null, told, false);
    expect(report.notification).toBeNull();
    expect(report.told).toBeNull();
  });

  it("treats a remembered value it cannot read as nothing told", () => {
    for (const told of [undefined, null, "Claude", 7, {}, [["Claude"]], [[1, 2, 3]], [["Claude", "x"]]]) {
      expect(planAvailabilityReport(withoutClaudeCode(), null, told, false).notification).not.toBeNull();
    }
  });

  it("logs a route counted as available only because an extension declares its command", () => {
    const availability = checkRouteAvailability(defaults(), DEFAULT_ROUTES, sources(WORKBENCH, [CLAUDE_CODE]));
    expect(planAvailabilityReport(availability, null, [], false)).toEqual({
      lines: [
        {
          level: "info",
          text:
            'Route "Claude": claude-vscode.focus is not registered yet, but anthropic.claude-code declares it, ' +
            "so the route is listened for.",
        },
      ],
      notification: null,
      told: null,
    });
  });

  it("logs a route counted as available through a declaration once, not at every check", () => {
    // An extension change and the start it leads to both check the commands.
    const declared = (): RouteAvailability =>
      checkRouteAvailability(defaults(), DEFAULT_ROUTES, sources(WORKBENCH, [CLAUDE_CODE]));
    expect(planAvailabilityReport(declared(), declared(), [], false).lines).toEqual([]);
    expect(planAvailabilityReport(declared(), withClaudeCode(), [], false).lines).toHaveLength(1);
  });

  describe("when every route is set aside", () => {
    const nothing = (): RouteAvailability =>
      checkRouteAvailability([DEFAULT_ROUTES[0], SEARCH], DEFAULT_ROUTES, sources(WORKBENCH));
    const told = [...CLAUDE_TOLD, ["Search", "example.search", "action-missing"]];

    it("says plainly that nothing can be listened for, and names every route", () => {
      const report = planAvailabilityReport(nothing(), null, undefined, false);
      expect(report.notification).toBe(
        "Wake Word is not listening: none of the routes' commands are available in this editor. " +
          '"Claude": claude-vscode.focus needs Claude Code (anthropic.claude-code), which is not installed or is disabled. ' +
          '"Search": no installed extension provides example.search. ' +
          "Listening starts once a route's command is available."
      );
      expect(report.lines.at(-1)).toEqual({
        level: "warn",
        text:
          "Not listening: none of the routes' commands are available in this editor. " +
          "Listening starts once a route's command is available.",
      });
    });

    it("does not repeat the notification on every start", () => {
      expect(planAvailabilityReport(nothing(), null, told, false).notification).toBeNull();
    });

    it("repeats it when the user asks to listen", () => {
      expect(planAvailabilityReport(nothing(), nothing(), told, true).notification).toBe(
        formatNothingToListenFor(nothing().setAside)
      );
    });
  });

  it("only raises the explicit notification when nothing can be listened for", () => {
    // With some routes listened for, the request does something visible:
    // listening starts. The routes set aside are in the log and diagnostics.
    expect(planAvailabilityReport(withoutClaudeCode(), null, CLAUDE_TOLD, true).notification).toBeNull();
  });
});

describe("formatSetAsideNotification", () => {
  it("renders one route with the extension to install", () => {
    const setAside: SetAsideRoute[] = withoutClaudeCode().setAside;
    expect(formatSetAsideNotification(setAside)).toContain("needs Claude Code (anthropic.claude-code)");
  });
});
