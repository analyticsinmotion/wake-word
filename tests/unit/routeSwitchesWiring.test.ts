import { afterEach, describe, expect, it } from "vitest";
import { buildKeywordSpec } from "../../src/keywords";
import type { WakePhrase } from "../../src/speechEngineInterface";
import { InstalledExtension, formatEveryRouteSwitchedOff } from "../../src/wakeWordCore";
import { Memento, Session, World, endSessions, settle, startSession } from "../mocks/extensionSession";

/**
 * Switching routes on and off in the extension host, driven through
 * activate() with tests/mocks/extensionSession.ts: the switch command and
 * what it writes, and where; a change to wakeWord.routesSwitchedOff made by
 * hand; what the engine is started with; every route switched off; a label
 * that names no route; a route switched off whose command is missing as well;
 * the phrase checks; an extension change; and Calibrate.
 */

const SETTING = "routesSwitchedOff";
const USER = 1;
const WORKSPACE = 2;
const TOLD_KEY = "wakeWord.setAsideNotified";

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

const SEARCH: WakePhrase = { label: "Search", phrase: "search files", command: "workbench.action.quickOpen" };
const COMMANDS: WakePhrase = { label: "Commands", phrase: "open commands", command: "workbench.action.showCommands" };

/** Claude Code installed and started: every default route's command is registered. */
function withClaudeCode(): World {
  return { registered: [...WORKBENCH, "claude-vscode.focus"], installed: [CLAUDE_CODE] };
}

function withoutClaudeCode(): World {
  return { registered: [...WORKBENCH], installed: [] };
}

function labels(routes: readonly WakePhrase[] | undefined): string[] {
  return (routes ?? []).map((route) => route.label);
}

/** The phrases the keyword lines built from these routes listen for. */
function listenedPhrases(routes: readonly WakePhrase[] | undefined): string[] {
  const spec = buildKeywordSpec(routes ?? [], (text) => text.split(" ").map((word) => "▁" + word), 0.05);
  return Object.values(spec.phraseMap);
}

/** Answer the switch command's list by checking only these labels. */
function check(session: Session, ...on: string[]): void {
  session.choose = (items) => items.filter((item) => on.includes(item.label));
}

function logged(session: Session, text: string): boolean {
  return session.logs.some((line) => line.includes(text));
}

/** The Show Diagnostics report's lines, without the level marks. */
async function diagnostics(session: Session): Promise<string[]> {
  const before = session.logs.length;
  await session.run("wakeWord.diagnostics");
  return session.logs.slice(before).map((line) => line.replace(/^\[\w+\] /, ""));
}

afterEach(() => {
  endSessions();
});

describe("the switch command", () => {
  it("switches a default route off and on again, and writes nothing but the switches", async () => {
    const session = await startSession({ world: withClaudeCode() });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();

    // You uncheck Terminal.
    check(session, "Claude", "Chat");
    await session.run("wakeWord.switchRoutes");
    expect(session.writes).toEqual([{ key: SETTING, value: ["Terminal"], target: USER }]);
    expect(labels(engine.startedWith.at(-1))).toEqual(["Claude", "Chat"]);
    expect(listenedPhrases(engine.startedWith.at(-1))).toEqual(["hey claude", "hey chat", "open chat"]);
    expect(logged(session, "Route switches changed: restarting listening")).toBe(true);
    expect(logged(session, 'Route "Terminal" switched off (wakeWord.routesSwitchedOff)')).toBe(true);
    expect(logged(session, "Starting: 2 routes, 1 switched off, threshold=0.05")).toBe(true);

    // You check it again: the value is removed from the user settings.
    engine.ready();
    check(session, "Claude", "Chat", "Terminal");
    await session.run("wakeWord.switchRoutes");
    expect(session.writes.at(-1)).toEqual({ key: SETTING, value: undefined, target: USER });
    expect(labels(engine.startedWith.at(-1))).toEqual(["Claude", "Chat", "Terminal"]);
    expect(logged(session, 'Route "Terminal" switched on again.')).toBe(true);

    // The default routes were never copied into the settings.
    expect(session.writes.every((write) => write.key === SETTING)).toBe(true);
    expect(session.scopes.user).toEqual({ enableOnStartup: false, showNotificationOnDetection: false });
  });

  it("lists one entry per route with its phrases, checked when it is on, and says where the choice is saved", async () => {
    const session = await startSession({ world: withClaudeCode(), scopes: { user: { [SETTING]: ["chat"] } } });
    await session.run("wakeWord.switchRoutes");

    const [shown] = session.quickPicks;
    expect(shown.options).toMatchObject({
      title: "Wake Word: Switch Routes On or Off",
      placeHolder: "Check the routes to listen for. Saved in the user settings.",
      canPickMany: true,
    });
    expect(shown.items.map(({ label, description, picked }) => ({ label, description, picked }))).toEqual([
      { label: "Claude", description: '"hey claude"', picked: true },
      { label: "Chat", description: '"hey chat", "open chat"', picked: false },
      { label: "Terminal", description: '"hey computer", "open terminal"', picked: true },
    ]);
    // Closed without a choice: nothing is written.
    expect(session.writes).toEqual([]);
  });

  it("writes nothing when the choice leaves the routes as they are", async () => {
    const session = await startSession({ world: withClaudeCode(), scopes: { user: { [SETTING]: ["Chat"] } } });
    check(session, "Claude", "Terminal");
    await session.run("wakeWord.switchRoutes");
    expect(session.writes).toEqual([]);
  });

  it("says when a route is listened for once its command is available", async () => {
    const session = await startSession({ world: withoutClaudeCode() });
    await session.run("wakeWord.switchRoutes");
    expect(session.quickPicks[0].items[0].detail).toBe(
      "Listened for once its command is available: claude-vscode.focus needs Claude Code " +
        "(anthropic.claude-code), which is not installed or is disabled."
    );
  });
});

describe("the setting edited by hand", () => {
  it("switches a route from wakeWord.routes off", async () => {
    const session = await startSession({
      world: withClaudeCode(),
      scopes: { user: { routes: [SEARCH, COMMANDS], [SETTING]: ["Commands"] } },
    });
    await session.run("wakeWord.enable");
    expect(labels(session.engine().startedWith[0])).toEqual(["Search"]);
    expect(listenedPhrases(session.engine().startedWith[0])).toEqual(["search files"]);
  });

  it("takes effect while listening, as a change to the routes does", async () => {
    const session = await startSession({ world: withClaudeCode() });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();

    session.set(SETTING, ["claude"]);
    await session.changeSettings(`wakeWord.${SETTING}`);
    expect(engine.stops).toBeGreaterThan(0);
    expect(labels(engine.startedWith.at(-1))).toEqual(["Chat", "Terminal"]);
    expect(logged(session, "Route switches changed: restarting listening")).toBe(true);
  });

  it("holds a change made during a manual handoff until the resume, and never takes the microphone back", async () => {
    const session = await startSession({ world: withClaudeCode() });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();
    // "Hey Claude": the microphone is released and the manual handoff waits.
    engine.emit("detected", engine.startedWith[0][0]);
    await settle();
    expect(session.status.text).toBe("$(debug-pause) Wake: Paused");

    session.set(SETTING, ["Chat"]);
    await session.changeSettings(`wakeWord.${SETTING}`);
    expect(engine.startedWith).toHaveLength(1);
    expect(engine.resumes).toBe(0);
    expect(engine.isPaused).toBe(true);
    expect(logged(session, "Route switches changed while listening was paused: applied when listening resumes")).toBe(
      true
    );

    // You resume: a full start, without the Chat route.
    await session.run("wakeWord.toggle");
    expect(engine.resumes).toBe(0);
    expect(labels(engine.startedWith.at(-1))).toEqual(["Claude", "Terminal"]);
  });
});

describe("every route switched off", () => {
  it("opens no microphone, says so, and starts listening once you switch a route on", async () => {
    const session = await startSession({
      world: withClaudeCode(),
      scopes: { user: { [SETTING]: ["Claude", "Chat", "Terminal"] } },
    });
    await session.run("wakeWord.enable");
    expect(session.engine().startedWith).toEqual([]);
    expect(session.lock.held).toBe(false);
    expect(session.status.text).toBe("$(circle-slash) Wake: Routes off");
    // Enable is a request to listen, so the reason is shown.
    expect(session.infos).toEqual([formatEveryRouteSwitchedOff()]);
    expect(session.warnings).toEqual([]);
    expect(logged(session, "Every route is switched off (wakeWord.routesSwitchedOff), so the microphone stays closed.")).toBe(
      true
    );

    // A click on the status bar opens the list, and you check Chat.
    check(session, "Chat");
    await session.run("wakeWord.toggle");
    expect(session.quickPicks).toHaveLength(1);
    expect(session.scopes.user[SETTING]).toEqual(["Claude", "Terminal"]);
    expect(labels(session.engine().startedWith[0])).toEqual(["Chat"]);
    expect(
      logged(session, "Route switches changed while every route was switched off: checking the routes again")
    ).toBe(true);
  });

  it("opens the list from the notification's button", async () => {
    const session = await startSession({
      world: withClaudeCode(),
      scopes: { user: { [SETTING]: ["Claude", "Chat", "Terminal"] } },
    });
    session.answer = "Switch Routes On or Off";
    await session.run("wakeWord.enable");
    await settle();
    expect(session.quickPicks).toHaveLength(1);
  });

  it("stops listening and releases the lock when the last route is switched off, without a notification", async () => {
    const session = await startSession({ world: withClaudeCode() });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();
    expect(session.lock.held).toBe(true);

    session.set(SETTING, ["Claude", "Chat", "Terminal"]);
    await session.changeSettings(`wakeWord.${SETTING}`);
    expect(engine.isListening).toBe(false);
    expect(engine.startedWith).toHaveLength(1);
    expect(session.lock.held).toBe(false);
    expect(session.status.text).toBe("$(circle-slash) Wake: Routes off");
    expect(session.infos).toEqual([]);
  });

  it("shows the state in Show Diagnostics", async () => {
    const session = await startSession({
      world: withClaudeCode(),
      scopes: { user: { [SETTING]: ["Claude", "Chat", "Terminal"] } },
    });
    await session.run("wakeWord.enable");
    const report = await diagnostics(session);
    expect(report).toContain("State: waiting: every route is switched off");
    expect(report).toContain("Routes: 3 (defaults)");
    expect(report).toContain("Switched off: 3 routes (wakeWord.routesSwitchedOff, in the user settings)");
  });

  it("says Calibrate listens for the routes switched on, and starts nothing", async () => {
    const session = await startSession({
      world: withClaudeCode(),
      scopes: { user: { [SETTING]: ["Claude", "Chat", "Terminal"] } },
    });
    await session.run("wakeWord.calibrate");
    expect(session.warnings).toEqual([
      "Wake Word: Calibrate listens for the routes that are switched on, and every route is switched off.",
    ]);
    expect(session.engine().startedWith).toEqual([]);
  });
});

describe("a label that names no route", () => {
  it("is logged once, listed in Show Diagnostics, and kept when the command writes", async () => {
    const session = await startSession({ world: withClaudeCode(), scopes: { user: { [SETTING]: ["Termnal"] } } });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    expect(labels(engine.startedWith[0])).toEqual(["Claude", "Chat", "Terminal"]);
    const line =
      'wakeWord.routesSwitchedOff names "Termnal", which matches no route\'s label. ' +
      "It is kept, and switches off a route given that label.";
    expect(session.logs.filter((entry) => entry.includes(line))).toHaveLength(1);
    engine.ready();

    // A restart for another reason does not repeat it.
    session.set("confidenceThreshold", 0.1);
    await session.changeSettings("wakeWord.confidenceThreshold");
    engine.ready();
    expect(session.logs.filter((entry) => entry.includes(line))).toHaveLength(1);

    const report = await diagnostics(session);
    expect(report).toContain("Switched off: none (wakeWord.routesSwitchedOff, in the user settings)");
    expect(report).toContain('  "Termnal": matches no route\'s label');

    check(session, "Claude", "Terminal");
    await session.run("wakeWord.switchRoutes");
    expect(session.writes).toEqual([{ key: SETTING, value: ["Termnal", "Chat"], target: USER }]);
  });
});

describe("the setting in more than one scope", () => {
  it("reads the workspace value over the user value, as the editor does", async () => {
    const session = await startSession({
      world: withClaudeCode(),
      scopes: { user: { [SETTING]: ["Terminal"] }, workspace: { [SETTING]: ["Chat"] } },
    });
    await session.run("wakeWord.enable");
    expect(labels(session.engine().startedWith[0])).toEqual(["Claude", "Terminal"]);
    expect(await diagnostics(session)).toContain(
      "Switched off: 1 route (wakeWord.routesSwitchedOff, in the workspace settings)"
    );
  });

  it("writes the workspace settings when they set the value, and leaves the user value alone", async () => {
    const session = await startSession({
      world: withClaudeCode(),
      scopes: { user: { [SETTING]: ["Terminal"] }, workspace: { [SETTING]: ["Chat"] } },
    });
    check(session, "Terminal");
    await session.run("wakeWord.switchRoutes");
    expect(session.quickPicks[0].options?.placeHolder).toBe(
      "Check the routes to listen for. Saved in the workspace settings."
    );
    expect(session.writes).toEqual([{ key: SETTING, value: ["Chat", "Claude"], target: WORKSPACE }]);
    expect(session.scopes.user[SETTING]).toEqual(["Terminal"]);

    // Switching every route on again keeps an empty list there, which goes
    // on overriding the user value in this workspace.
    check(session, "Claude", "Chat", "Terminal");
    await session.run("wakeWord.switchRoutes");
    expect(session.writes.at(-1)).toEqual({ key: SETTING, value: [], target: WORKSPACE });
    expect(session.scopes.user[SETTING]).toEqual(["Terminal"]);
  });

  it("writes the user settings when only they set the value, and adds nothing to the workspace settings", async () => {
    const session = await startSession({
      world: withClaudeCode(),
      scopes: { user: { [SETTING]: ["Terminal"] }, workspace: {} },
    });
    check(session, "Claude", "Chat", "Terminal");
    await session.run("wakeWord.switchRoutes");
    expect(session.writes).toEqual([{ key: SETTING, value: undefined, target: USER }]);
    expect(session.scopes.workspace).toEqual({});
  });
});

describe("a route switched off whose command is missing as well", () => {
  it("is never set aside: the user is not told about its command, and Show Diagnostics says both", async () => {
    const memento = new Memento();
    const session = await startSession({
      world: withoutClaudeCode(),
      memento,
      scopes: { user: { [SETTING]: ["Claude"] } },
    });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    expect(labels(engine.startedWith[0])).toEqual(["Chat", "Terminal"]);
    expect(session.warnings).toEqual([]);
    expect(logged(session, "set aside")).toBe(false);
    expect(memento.updated).not.toContain(TOLD_KEY);
    expect(logged(session, "Starting: 2 routes, 1 switched off, threshold=0.05")).toBe(true);
    engine.ready();

    const report = await diagnostics(session);
    expect(report).toContain("Set aside: none");
    expect(report).toContain(
      '  "Claude" [hey claude] -> claude-vscode.focus (manual): its command is missing as well, ' +
        "claude-vscode.focus needs Claude Code (anthropic.claude-code), which is not installed or is disabled"
    );

    // Switched on, it is set aside, and the user is told once.
    check(session, "Claude", "Chat", "Terminal");
    await session.run("wakeWord.switchRoutes");
    expect(labels(engine.startedWith.at(-1))).toEqual(["Chat", "Terminal"]);
    expect(session.warnings).toHaveLength(1);
    expect(session.warnings[0]).toContain('Wake Word is not listening for "Claude"');
    expect(memento.get(TOLD_KEY)).toEqual([["Claude", "claude-vscode.focus", "action-missing"]]);
  });

  it("does not restart listening when an extension brings its command in", async () => {
    const world = withoutClaudeCode();
    const session = await startSession({ world, scopes: { user: { [SETTING]: ["Claude"] } } });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();

    world.installed = [CLAUDE_CODE];
    await session.extensionsChanged();
    expect(engine.startedWith).toHaveLength(1);
    expect(engine.stops).toBe(0);
  });

  it("says the other routes are switched off when the ones switched on all lack a command", async () => {
    const session = await startSession({
      world: withoutClaudeCode(),
      scopes: { user: { [SETTING]: ["Chat", "Terminal"] } },
    });
    await session.run("wakeWord.enable");
    expect(session.engine().startedWith).toEqual([]);
    expect(session.status.text).toBe("$(circle-slash) Wake: No commands");
    expect(session.warnings).toHaveLength(1);
    expect(session.warnings[0]).toMatch(
      /^Wake Word keeps the microphone closed: the routes switched on need commands that are missing from this editor, and the other routes are switched off\./
    );
  });
});

describe("the phrase checks", () => {
  it("leave out a route switched off, and include it again once it is switched on", async () => {
    const routes: WakePhrase[] = [
      { label: "Claude", phrase: "hey claude", command: "claude-vscode.focus" },
      { label: "Short", phrase: "claude", command: "workbench.action.quickOpen" },
    ];
    const session = await startSession({ world: withClaudeCode(), scopes: { user: { routes, [SETTING]: ["Short"] } } });
    await session.run("wakeWord.enable");
    const engine = session.engine();
    engine.ready();
    expect(logged(session, "Phrase")).toBe(false);
    expect(session.warnings).toEqual([]);
    expect(await diagnostics(session)).toContain("Phrase checks: no warnings");

    check(session, "Claude", "Short");
    await session.run("wakeWord.switchRoutes");
    expect(logged(session, 'Phrase collision: "claude" (Short) is contained within "hey claude" (Claude)')).toBe(true);
    expect(session.warnings).toEqual(["Wake Word: 2 phrase warnings found. Check the output channel for details."]);
  });
});

describe("Calibrate", () => {
  it("starts the engine for the routes switched on only", async () => {
    const session = await startSession({ world: withClaudeCode(), scopes: { user: { [SETTING]: ["Terminal"] } } });
    const running = session.run("wakeWord.calibrate");
    await settle();
    expect(labels(session.engine().startedWith[0])).toEqual(["Claude", "Chat"]);
    expect(logged(session, "Calibration: starting (15s, threshold=0.05, was off)")).toBe(true);
    // A click cancels the run.
    await session.run("wakeWord.toggle");
    await running;
  });
});
