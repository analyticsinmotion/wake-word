import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_WINDOW_MS,
  DETECTION_DEBOUNCE_MS,
  PendingConfirmation,
  evaluateConfirmation,
  formatConfirmationStatus,
  shouldDebounce,
} from "../../src/wakeWordCore";

const T0 = 1_700_000_000_000;

describe("evaluateConfirmation", () => {
  it("uses a 5 second window by default", () => {
    expect(CONFIRMATION_WINDOW_MS).toBe(5000);
  });

  describe("when confirmation mode is off", () => {
    it("fires the first detection immediately", () => {
      expect(evaluateConfirmation(false, null, "Claude", T0)).toEqual({
        confirmed: true,
        pending: null,
      });
    });

    it("fires and discards a hold left over from when the mode was on", () => {
      // The setting can be turned off while a first hearing is held.
      const pending: PendingConfirmation = { phrase: "Claude", time: T0 };
      expect(evaluateConfirmation(false, pending, "Copilot", T0 + 1000)).toEqual({
        confirmed: true,
        pending: null,
      });
    });
  });

  describe("when confirmation mode is on", () => {
    it("holds the first detection instead of firing", () => {
      expect(evaluateConfirmation(true, null, "Claude", T0)).toEqual({
        confirmed: false,
        pending: { phrase: "Claude", time: T0 },
      });
    });

    it("fires on the same phrase inside the window and clears the hold", () => {
      const first = evaluateConfirmation(true, null, "Claude", T0);
      expect(evaluateConfirmation(true, first.pending, "Claude", T0 + 4000)).toEqual({
        confirmed: true,
        pending: null,
      });
    });

    it("fires on the same phrase exactly at the window boundary", () => {
      const pending: PendingConfirmation = { phrase: "Claude", time: T0 };
      const result = evaluateConfirmation(true, pending, "Claude", T0 + CONFIRMATION_WINDOW_MS);
      expect(result.confirmed).toBe(true);
    });

    it("treats the same phrase after the window as a new first detection", () => {
      const pending: PendingConfirmation = { phrase: "Claude", time: T0 };
      const late = T0 + CONFIRMATION_WINDOW_MS + 1;
      expect(evaluateConfirmation(true, pending, "Claude", late)).toEqual({
        confirmed: false,
        pending: { phrase: "Claude", time: late },
      });
    });

    it("replaces the hold when a different phrase is heard", () => {
      const pending: PendingConfirmation = { phrase: "Claude", time: T0 };
      expect(evaluateConfirmation(true, pending, "Copilot", T0 + 1000)).toEqual({
        confirmed: false,
        pending: { phrase: "Copilot", time: T0 + 1000 },
      });
    });

    it("does not let the original phrase confirm after a different one replaced it", () => {
      let pending = evaluateConfirmation(true, null, "Claude", T0).pending;
      pending = evaluateConfirmation(true, pending, "Copilot", T0 + 1000).pending;
      // Still inside the original window, but that phrase is no longer held.
      const result = evaluateConfirmation(true, pending, "Claude", T0 + 2000);
      expect(result.confirmed).toBe(false);
      expect(result.pending).toEqual({ phrase: "Claude", time: T0 + 2000 });
    });

    it("confirms the replacement phrase inside its own window", () => {
      let pending = evaluateConfirmation(true, null, "Claude", T0).pending;
      pending = evaluateConfirmation(true, pending, "Copilot", T0 + 1000).pending;
      expect(evaluateConfirmation(true, pending, "Copilot", T0 + 5000).confirmed).toBe(true);
    });

    it("starts over after the hold is cleared", () => {
      // stopListening(), the focus-loss pause, an engine switch, and
      // resumeListening() all drop the held detection. Modelled here as the
      // caller passing null, which is exactly what they do.
      const first = evaluateConfirmation(true, null, "Claude", T0);
      expect(first.confirmed).toBe(false);
      const afterClear = evaluateConfirmation(true, null, "Claude", T0 + 1000);
      expect(afterClear).toEqual({
        confirmed: false,
        pending: { phrase: "Claude", time: T0 + 1000 },
      });
    });

    it("confirms from a hold stamped in the future", () => {
      // A backwards clock step makes the delta negative, which reads as
      // "inside the window". Documented rather than fixed: the wall-clock
      // timer in the extension drops the hold regardless.
      const pending: PendingConfirmation = { phrase: "Claude", time: T0 + 10_000 };
      expect(evaluateConfirmation(true, pending, "Claude", T0).confirmed).toBe(true);
    });

    it("honours a custom window", () => {
      const pending: PendingConfirmation = { phrase: "Claude", time: T0 };
      expect(evaluateConfirmation(true, pending, "Claude", T0 + 1500, 1000).confirmed).toBe(false);
      expect(evaluateConfirmation(true, pending, "Claude", T0 + 1500, 2000).confirmed).toBe(true);
    });
  });

  it("models the full detect, debounce, confirm cycle", () => {
    // The extension runs the debounce guard first and only then the
    // confirmation check, so the engine repeating one utterance cannot
    // confirm itself. The second utterance has to land after the debounce
    // window and inside the confirmation window.
    let last = 0;
    let pending: PendingConfirmation | null = null;
    const hear = (now: number): "debounced" | "held" | "fired" => {
      if (shouldDebounce(now, last)) {
        return "debounced";
      }
      last = now;
      const result = evaluateConfirmation(true, pending, "Claude", now);
      pending = result.pending;
      return result.confirmed ? "fired" : "held";
    };

    expect(hear(T0)).toBe("held"); // first utterance
    expect(hear(T0 + 500)).toBe("debounced"); // engine repeats the same detection
    expect(hear(T0 + DETECTION_DEBOUNCE_MS - 1)).toBe("debounced");
    expect(hear(T0 + DETECTION_DEBOUNCE_MS + 500)).toBe("fired"); // second utterance
    expect(pending).toBeNull();
  });
});

describe("formatConfirmationStatus", () => {
  it("names the held phrase with the question icon", () => {
    expect(formatConfirmationStatus("Claude")).toBe('$(question) Wake: Confirm "Claude"');
  });

  it("renders the label verbatim", () => {
    expect(formatConfirmationStatus("Hey Computer")).toBe(
      '$(question) Wake: Confirm "Hey Computer"'
    );
  });
});
