import { describe, expect, it } from "vitest";
import {
  ListenSettingsAction,
  ListenSettingsChange,
  ListeningState,
  decideListenSettingsChange,
  describeListenSettingsChange,
  formatListenSettingsChange,
} from "../../src/wakeWordCore";

/** The state the extension is in, with everything off unless named. */
function state(over: Partial<ListeningState> = {}): ListeningState {
  return {
    listening: false,
    starting: false,
    paused: false,
    cooldown: false,
    manualPause: false,
    ...over,
  };
}

const ROUTES: ListenSettingsChange = { routes: true, threshold: false };
const THRESHOLD: ListenSettingsChange = { routes: false, threshold: true };
const BOTH: ListenSettingsChange = { routes: true, threshold: true };
const NEITHER: ListenSettingsChange = { routes: false, threshold: false };

/** Every combination of the five state flags. */
function allStates(): ListeningState[] {
  const states: ListeningState[] = [];
  for (let bits = 0; bits < 32; bits++) {
    states.push(
      state({
        listening: (bits & 1) !== 0,
        starting: (bits & 2) !== 0,
        paused: (bits & 4) !== 0,
        cooldown: (bits & 8) !== 0,
        manualPause: (bits & 16) !== 0,
      })
    );
  }
  return states;
}

describe("decideListenSettingsChange", () => {
  it("does nothing when neither setting changed", () => {
    // A change to the cooldown, the confirmation mode, or any other setting
    // reaches the handler as well, and the engine is not restarted for it.
    for (const s of allStates()) {
      expect(decideListenSettingsChange(NEITHER, s)).toBe("none");
    }
  });

  it("treats a threshold change exactly as a routes change, in every state", () => {
    for (const s of allStates()) {
      const routes = decideListenSettingsChange(ROUTES, s);
      expect(decideListenSettingsChange(THRESHOLD, s)).toBe(routes);
      expect(decideListenSettingsChange(BOTH, s)).toBe(routes);
    }
  });

  // One test per row of the states the extension can be in.

  it("Off: nothing now, so the next start reads the new value", () => {
    expect(decideListenSettingsChange(THRESHOLD, state())).toBe("none");
  });

  it("Listening: restarts with the new value", () => {
    expect(decideListenSettingsChange(THRESHOLD, state({ listening: true }))).toBe("restart");
  });

  it("Timer cooldown: holds the change for the resume", () => {
    expect(
      decideListenSettingsChange(THRESHOLD, state({ paused: true, cooldown: true }))
    ).toBe("apply-on-resume");
  });

  it("Manual handoff pause: holds the change for the user's resume", () => {
    expect(
      decideListenSettingsChange(THRESHOLD, state({ paused: true, manualPause: true }))
    ).toBe("apply-on-resume");
  });

  it("Paused for focus loss: holds the change for regaining focus", () => {
    expect(decideListenSettingsChange(THRESHOLD, state({ paused: true }))).toBe("apply-on-resume");
  });

  it("Cooldown with no paused engine: still holds the change", () => {
    // The child can die during a cooldown, which leaves the countdown
    // running with nothing to resume. The countdown still ends in a start.
    expect(decideListenSettingsChange(THRESHOLD, state({ cooldown: true }))).toBe("apply-on-resume");
  });

  it("Calibrating on a listening engine: restarts, which ends the run", () => {
    // A calibration run listens on the engine, so the state here is
    // Listening. The restart stops the engine, which settles the run.
    expect(decideListenSettingsChange(THRESHOLD, state({ listening: true }))).toBe("restart");
  });

  it("Calibrating from a handoff, engine not up yet: holds the change", () => {
    // Calibrate starts the engine itself and clears the countdown, so a
    // paused engine is all that is left of the handoff. The run restores it,
    // and the resume after it applies the change.
    expect(decideListenSettingsChange(THRESHOLD, state({ paused: true }))).toBe("apply-on-resume");
  });

  it("Another window holds the lock: nothing now, as when off", () => {
    // Standing by is Off with a lock watcher running: the takeover goes
    // through a start, which reads the settings.
    expect(decideListenSettingsChange(THRESHOLD, state())).toBe("none");
  });

  it("Confirmation mode holding a first hearing: restarts", () => {
    // The engine keeps listening while a first hearing is held, so this is
    // the Listening row. The restart drops the hold with it.
    expect(decideListenSettingsChange(THRESHOLD, state({ listening: true }))).toBe("restart");
  });

  it("Starting: holds the change until the engine reports READY", () => {
    // The settings were read before the start, so the engine coming up has
    // the old ones and would keep them until something else restarted it.
    expect(decideListenSettingsChange(THRESHOLD, state({ starting: true }))).toBe(
      "apply-when-started"
    );
  });

  it("Starting out of a pause: the start wins over the pause", () => {
    // A resume through startListening() leaves the engine paused until
    // READY. Holding for the resume would hold for one that has happened.
    expect(
      decideListenSettingsChange(THRESHOLD, state({ starting: true, paused: true }))
    ).toBe("apply-when-started");
    expect(
      decideListenSettingsChange(THRESHOLD, state({ starting: true, paused: true, manualPause: true }))
    ).toBe("apply-when-started");
  });

  it("never restarts an engine that is not holding the microphone", () => {
    // The rule the whole decision exists for: a paused engine is paused for
    // a handoff, and a handoff means an assistant has the microphone. Only
    // an engine that already holds it may be restarted where it stands.
    for (const change of [ROUTES, THRESHOLD, BOTH]) {
      for (const s of allStates()) {
        if (!s.listening) {
          expect(decideListenSettingsChange(change, s)).not.toBe("restart");
        }
      }
    }
  });

  it("returns one of the four actions for every state", () => {
    const actions: ListenSettingsAction[] = ["none", "restart", "apply-on-resume", "apply-when-started"];
    for (const change of [NEITHER, ROUTES, THRESHOLD, BOTH]) {
      for (const s of allStates()) {
        expect(actions).toContain(decideListenSettingsChange(change, s));
      }
    }
  });
});

describe("describeListenSettingsChange", () => {
  it("names the setting that changed", () => {
    expect(describeListenSettingsChange(ROUTES)).toBe("Routes");
    expect(describeListenSettingsChange(THRESHOLD)).toBe("Confidence threshold");
    expect(describeListenSettingsChange(BOTH)).toBe("Routes and confidence threshold");
  });
});

describe("formatListenSettingsChange", () => {
  it("says nothing about a change that is not acted on", () => {
    expect(formatListenSettingsChange(THRESHOLD, "none")).toBeNull();
    expect(formatListenSettingsChange(NEITHER, "none")).toBeNull();
  });

  it("names the setting and the restart", () => {
    expect(formatListenSettingsChange(THRESHOLD, "restart")).toBe(
      "Confidence threshold changed: restarting listening"
    );
    expect(formatListenSettingsChange(ROUTES, "restart")).toBe("Routes changed: restarting listening");
  });

  it("says when a held change will be applied", () => {
    expect(formatListenSettingsChange(ROUTES, "apply-on-resume")).toBe(
      "Routes changed while listening was paused: applied when listening resumes"
    );
    expect(formatListenSettingsChange(THRESHOLD, "apply-when-started")).toBe(
      "Confidence threshold changed while the engine was starting: applied as soon as it is listening"
    );
  });

  it("names both settings when both changed", () => {
    expect(formatListenSettingsChange(BOTH, "apply-on-resume")).toBe(
      "Routes and confidence threshold changed while listening was paused: applied when listening resumes"
    );
  });
});
