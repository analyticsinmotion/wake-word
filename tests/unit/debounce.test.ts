import { describe, expect, it } from "vitest";
import { DETECTION_DEBOUNCE_MS, shouldDebounce } from "../../src/wakeWordCore";

describe("shouldDebounce", () => {
  it("uses a 3 second window by default", () => {
    expect(DETECTION_DEBOUNCE_MS).toBe(3000);
  });

  it("never suppresses the first detection", () => {
    // lastDetectionTime is 0 until something is detected, and Date.now() is
    // always far past the window.
    expect(shouldDebounce(Date.now(), 0)).toBe(false);
  });

  it("suppresses a repeat inside the window", () => {
    expect(shouldDebounce(1_000_000, 999_000)).toBe(true);
  });

  it("suppresses an immediate repeat", () => {
    expect(shouldDebounce(1_000_000, 1_000_000)).toBe(true);
  });

  it("allows a detection after the window", () => {
    expect(shouldDebounce(1_003_001, 1_000_000)).toBe(false);
  });

  it("allows a detection exactly on the boundary", () => {
    // The guard is `now - last < window`, so a gap of exactly the window
    // passes through.
    expect(shouldDebounce(1_003_000, 1_000_000)).toBe(false);
  });

  it("suppresses one millisecond before the boundary", () => {
    expect(shouldDebounce(1_002_999, 1_000_000)).toBe(true);
  });

  it("clears the guard when the timestamp is reset to 0", () => {
    // resumeListening() and stopListening() reset lastDetectionTime to 0 so
    // the phrase can fire again the moment listening comes back.
    expect(shouldDebounce(1_000_500, 1_000_000)).toBe(true);
    expect(shouldDebounce(1_000_500, 0)).toBe(false);
  });

  it("honours a custom window", () => {
    expect(shouldDebounce(1_005_000, 1_000_000, 10_000)).toBe(true);
    expect(shouldDebounce(1_005_000, 1_000_000, 1_000)).toBe(false);
  });

  it("suppresses while the wall clock is behind the last detection", () => {
    // Documented behaviour, not an accident: a backwards clock step makes the
    // delta negative, which reads as "inside the window". Detections stay
    // suppressed until the clock passes the recorded time again. The guard is
    // cleared on pause and resume, so this cannot latch for longer than one
    // cooldown.
    expect(shouldDebounce(1_000_000, 2_000_000)).toBe(true);
    expect(shouldDebounce(2_000_001, 2_000_000)).toBe(true);
  });

  it("models a full detect, cooldown, detect cycle", () => {
    let last = 0;
    const accept = (now: number): boolean => {
      if (shouldDebounce(now, last)) {
        return false;
      }
      last = now;
      return true;
    };

    expect(accept(10_000)).toBe(true); // first wake phrase
    expect(accept(10_500)).toBe(false); // engine repeats the same detection
    expect(accept(12_999)).toBe(false); // still inside the window
    expect(accept(13_000)).toBe(true); // window elapsed
  });
});
