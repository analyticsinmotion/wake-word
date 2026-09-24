import { describe, expect, it } from "vitest";
import {
  StatusBarState,
  StatusFacts,
  deriveStatus,
  describeStatus,
  formatRestart,
  statusBarView,
} from "../../src/wakeWordCore";

/**
 * The status bar, as pure logic: what each state shows, and which state the
 * extension's facts lead to. The rule under test is that the status bar says
 * the microphone is listening only when the engine says it is, and says it was
 * handed to an assistant only when a detection handed it over.
 */

/** One of every state, with the payloads the tests look for. */
const EVERY_STATE: StatusBarState[] = [
  { kind: "off" },
  { kind: "starting" },
  { kind: "listening" },
  { kind: "confirming", label: "Claude" },
  { kind: "calibrating" },
  { kind: "handed-off" },
  { kind: "cooldown", seconds: 29 },
  { kind: "paused" },
  { kind: "focus-paused" },
  { kind: "restarting", attempt: 2, attempts: 3 },
  { kind: "error", message: "No microphone found. Check your audio device settings." },
  { kind: "other-window" },
  { kind: "no-commands" },
];

const LISTENING_STATES = new Set(["listening", "confirming", "calibrating"]);
const HANDOFF_STATES = new Set(["handed-off", "cooldown", "paused"]);

describe("statusBarView", () => {
  it("covers every state once", () => {
    expect(new Set(EVERY_STATE.map((state) => state.kind)).size).toBe(EVERY_STATE.length);
    expect(EVERY_STATE).toHaveLength(13);
  });

  it("uses only icons known to be drawn by editors built on older VS Code releases", () => {
    // An icon newer than the editor's VS Code release is drawn as nothing, so
    // check a new one against an older editor before adding it here. mic-off,
    // for one, is recent enough to be missing.
    const known = new Set([
      "mic",
      "mic-filled",
      "circle-slash",
      "loading",
      "question",
      "pulse",
      "clock",
      "debug-pause",
      "sync",
      "error",
    ]);
    for (const state of EVERY_STATE) {
      const icons = [...statusBarView(state).text.matchAll(/\$\(([a-z-]+)(?:~[a-z]+)?\)/g)].map((match) => match[1]);
      expect(icons, state.kind).toHaveLength(1);
      expect(known.has(icons[0]), `${state.kind}: ${icons[0]}`).toBe(true);
    }
  });

  it.each([
    ["off", "$(circle-slash) Wake: Off", null, true],
    ["starting", "$(loading~spin) Wake: Starting", null, false],
    ["listening", "$(mic) Wake: Listening", null, true],
    ["confirming", '$(question) Wake: Confirm "Claude"', null, false],
    ["calibrating", "$(pulse) Wake: Calibrating", null, false],
    ["handed-off", "$(mic-filled) Wake: Active", "warning", false],
    ["cooldown", "$(clock) Wake: 29s", "warning", false],
    ["paused", "$(debug-pause) Wake: Paused", "warning", false],
    ["focus-paused", "$(circle-slash) Wake: Unfocused", null, true],
    ["restarting", "$(sync~spin) Wake: Restarting", "warning", false],
    ["error", "$(error) Wake: Error", "error", false],
    ["other-window", "$(circle-slash) Wake: Other window", null, false],
    ["no-commands", "$(circle-slash) Wake: No commands", null, true],
  ])("shows %s as %s", (kind, text, background, settingsLink) => {
    const view = statusBarView(EVERY_STATE.find((state) => state.kind === kind) as StatusBarState);
    expect(view.text).toBe(text);
    expect(view.background).toBe(background);
    expect(view.settingsLink).toBe(settingsLink);
    expect(view.tooltip.length).toBeGreaterThan(0);
  });

  it("says Listening only in the states that have the microphone open", () => {
    for (const state of EVERY_STATE) {
      const { text, tooltip } = statusBarView(state);
      if (/Listening\b/.test(text) || /^Listening for wake/.test(tooltip)) {
        expect(LISTENING_STATES.has(state.kind), state.kind).toBe(true);
      }
    }
    expect(statusBarView({ kind: "listening" }).text).toBe("$(mic) Wake: Listening");
  });

  it("says the microphone was handed off only in the handoff states", () => {
    for (const state of EVERY_STATE) {
      const { tooltip } = statusBarView(state);
      expect(/handed (off )?to assistant/.test(tooltip), state.kind).toBe(HANDOFF_STATES.has(state.kind));
    }
  });

  it("says a focus pause is a pause for focus that resumes on focus", () => {
    const { tooltip } = statusBarView({ kind: "focus-paused" });
    expect(tooltip).toContain("paused while this window is not focused");
    expect(tooltip).toContain("resumes when it is focused again");
  });

  it("says a restart is a restart, with the attempt, and that the microphone is closed", () => {
    const { tooltip } = statusBarView({ kind: "restarting", attempt: 2, attempts: 3 });
    expect(tooltip).toContain("The speech engine stopped and is being restarted (attempt 2 of 3)");
    expect(tooltip).toContain("The microphone is closed");
  });

  it("says a start has not opened the microphone yet", () => {
    expect(statusBarView({ kind: "starting" }).tooltip).toContain("Wake phrases are not heard until");
  });

  it("carries the engine's message in the error tooltip", () => {
    const message = "No microphone found. Check your audio device settings.";
    expect(statusBarView({ kind: "error", message }).tooltip).toContain(message);
  });

  it("never puts a route label or an engine message in a tooltip that carries the settings link", () => {
    // A settings link needs trusted markdown, in which text that is not the
    // extension's own could run commands.
    const label = "[x](command:workbench.action.quit)";
    const withUserText: StatusBarState[] = [
      { kind: "confirming", label },
      { kind: "error", message: label },
    ];
    for (const state of withUserText) {
      expect(statusBarView(state).settingsLink, state.kind).toBe(false);
    }
    for (const state of EVERY_STATE.filter((s) => statusBarView(s).settingsLink)) {
      expect("label" in state || "message" in state, state.kind).toBe(false);
    }
  });

  it("describes every state for Show Diagnostics", () => {
    const described = EVERY_STATE.map(describeStatus);
    expect(new Set(described).size).toBe(EVERY_STATE.length);
    expect(describeStatus({ kind: "focus-paused" })).toBe("paused while the window is unfocused");
    expect(describeStatus({ kind: "restarting", attempt: 1, attempts: 3 })).toBe(
      "restarting after the speech engine stopped (attempt 1 of 3)"
    );
    expect(describeStatus({ kind: "error", message: "No microphone found." })).toBe("error: No microphone found.");
  });
});

/** No fact set: what an idle extension knows. */
const IDLE: StatusFacts = {
  listening: false,
  calibrating: false,
  confirming: null,
  handingOff: false,
  cooldownSeconds: null,
  manualPause: false,
  focusPaused: false,
  restarting: null,
  starting: false,
  error: null,
  standingBy: false,
  waitingForCommands: false,
};

/** Every combination of the facts, each either unset or set to a value. */
function everyCombination(): StatusFacts[] {
  const settings: Array<[keyof StatusFacts, StatusFacts[keyof StatusFacts]]> = [
    ["listening", true],
    ["calibrating", true],
    ["confirming", "Claude"],
    ["handingOff", true],
    ["cooldownSeconds", 12],
    ["manualPause", true],
    ["focusPaused", true],
    ["restarting", { attempt: 1, attempts: 3 }],
    ["starting", true],
    ["error", "No microphone found."],
    ["standingBy", true],
    ["waitingForCommands", true],
  ];
  const all: StatusFacts[] = [];
  for (let mask = 0; mask < 1 << settings.length; mask++) {
    const facts: StatusFacts = { ...IDLE };
    settings.forEach(([key, value], bit) => {
      if (mask & (1 << bit)) {
        (facts as unknown as Record<string, unknown>)[key] = value;
      }
    });
    all.push(facts);
  }
  return all;
}

describe("deriveStatus", () => {
  const combinations = everyCombination();

  it("checks all 4,096 combinations of the facts", () => {
    expect(combinations).toHaveLength(4096);
  });

  it("says the microphone is listening exactly when the engine is listening", () => {
    for (const facts of combinations) {
      expect(LISTENING_STATES.has(deriveStatus(facts).kind)).toBe(facts.listening);
    }
  });

  it("shows a handoff state only with the fact a detection's handoff sets", () => {
    for (const facts of combinations) {
      const { kind } = deriveStatus(facts);
      if (kind === "handed-off") {
        expect(facts.handingOff).toBe(true);
      }
      if (kind === "cooldown") {
        expect(facts.cooldownSeconds).not.toBeNull();
      }
      if (kind === "paused") {
        expect(facts.manualPause).toBe(true);
      }
    }
  });

  it("shows the focus pause, a restart, a start, and an error only when each is so", () => {
    for (const facts of combinations) {
      const { kind } = deriveStatus(facts);
      expect(kind === "focus-paused" ? facts.focusPaused : true).toBe(true);
      expect(kind === "restarting" ? facts.restarting !== null : true).toBe(true);
      expect(kind === "starting" ? facts.starting : true).toBe(true);
      expect(kind === "error" ? facts.error !== null : true).toBe(true);
      expect(kind === "other-window" ? facts.standingBy : true).toBe(true);
      expect(kind === "no-commands" ? facts.waitingForCommands : true).toBe(true);
    }
  });

  it.each([
    [{}, "off"],
    [{ listening: true }, "listening"],
    [{ listening: true, confirming: "Chat" }, "confirming"],
    [{ listening: true, calibrating: true }, "calibrating"],
    [{ handingOff: true }, "handed-off"],
    [{ cooldownSeconds: 12 }, "cooldown"],
    [{ manualPause: true }, "paused"],
    [{ focusPaused: true }, "focus-paused"],
    [{ restarting: { attempt: 1, attempts: 3 } }, "restarting"],
    [{ starting: true }, "starting"],
    [{ error: "No microphone found." }, "error"],
    [{ standingBy: true }, "other-window"],
    [{ waitingForCommands: true }, "no-commands"],
  ] as Array<[Partial<StatusFacts>, string]>)("shows %o as %s", (facts, kind) => {
    expect(deriveStatus({ ...IDLE, ...facts }).kind).toBe(kind);
  });

  it("never shows a pause for focus as a handoff", () => {
    expect(deriveStatus({ ...IDLE, focusPaused: true }).kind).toBe("focus-paused");
  });

  it("never shows Listening while the engine is being restarted", () => {
    expect(deriveStatus({ ...IDLE, restarting: { attempt: 2, attempts: 3 } })).toEqual({
      kind: "restarting",
      attempt: 2,
      attempts: 3,
    });
  });

  it("shows a restart over the start it runs, and a new start over an earlier error", () => {
    expect(deriveStatus({ ...IDLE, restarting: { attempt: 1, attempts: 3 }, starting: true }).kind).toBe("restarting");
    expect(deriveStatus({ ...IDLE, starting: true, error: "No microphone found." }).kind).toBe("starting");
  });

  it("drops a held first hearing from view once the engine stops listening", () => {
    expect(deriveStatus({ ...IDLE, confirming: "Chat", restarting: { attempt: 1, attempts: 3 } }).kind).toBe(
      "restarting"
    );
  });
});

describe("formatRestart", () => {
  it("names the reason, the delay, and the attempt", () => {
    expect(
      formatRestart({
        attempt: 1,
        attempts: 3,
        delayMs: 2000,
        reason: "The microphone stopped responding: decibri: audio device error: device unplugged",
      })
    ).toBe(
      "Speech engine stopped: The microphone stopped responding: decibri: audio device error: device unplugged. " +
        "Restarting in 2s (attempt 1 of 3)."
    );
  });

  it("does not double the full stop of a message that ends with one", () => {
    expect(
      formatRestart({ attempt: 2, attempts: 3, delayMs: 5000, reason: "No microphone found. Check your audio device settings." })
    ).toBe(
      "Speech engine stopped: No microphone found. Check your audio device settings. Restarting in 5s (attempt 2 of 3)."
    );
  });
});
