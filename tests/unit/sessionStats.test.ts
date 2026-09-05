import { describe, expect, it } from "vitest";
import {
  createSessionStats,
  formatSessionStats,
  recordDetection,
  sessionDurationMinutes,
} from "../../src/wakeWordCore";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

describe("createSessionStats", () => {
  it("starts every counter at zero", () => {
    const stats = createSessionStats(T0);
    expect(stats.detections).toBe(0);
    expect(stats.detectionsByPhrase.size).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.engineStarts).toBe(0);
    expect(stats.cooldowns).toBe(0);
  });

  it("stamps the creation time", () => {
    expect(createSessionStats(T0).startedAt).toBe(T0);
  });

  it("defaults the creation time to now", () => {
    const before = Date.now();
    const stats = createSessionStats();
    expect(stats.startedAt).toBeGreaterThanOrEqual(before);
    expect(stats.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it("gives each session its own phrase map", () => {
    const a = createSessionStats(T0);
    const b = createSessionStats(T0);
    recordDetection(a, "Claude");
    expect(b.detectionsByPhrase.size).toBe(0);
  });
});

describe("recordDetection", () => {
  it("increments the total and the per-phrase count", () => {
    const stats = createSessionStats(T0);
    recordDetection(stats, "Claude");
    expect(stats.detections).toBe(1);
    expect(stats.detectionsByPhrase.get("Claude")).toBe(1);
  });

  it("keeps a separate count per phrase", () => {
    const stats = createSessionStats(T0);
    recordDetection(stats, "Claude");
    recordDetection(stats, "Copilot");
    recordDetection(stats, "Claude");
    expect(stats.detections).toBe(3);
    expect(stats.detectionsByPhrase.get("Claude")).toBe(2);
    expect(stats.detectionsByPhrase.get("Copilot")).toBe(1);
  });

  it("leaves the other counters alone", () => {
    const stats = createSessionStats(T0);
    recordDetection(stats, "Claude");
    expect(stats.errors).toBe(0);
    expect(stats.engineStarts).toBe(0);
    expect(stats.cooldowns).toBe(0);
  });
});

describe("sessionDurationMinutes", () => {
  it("reports whole minutes", () => {
    expect(sessionDurationMinutes(createSessionStats(T0), T0 + 342 * MINUTE)).toBe(342);
  });

  it("rounds to the nearest minute", () => {
    const stats = createSessionStats(T0);
    expect(sessionDurationMinutes(stats, T0 + 342 * MINUTE + 29_000)).toBe(342);
    expect(sessionDurationMinutes(stats, T0 + 342 * MINUTE + 31_000)).toBe(343);
  });

  it("is zero for a session shorter than half a minute", () => {
    expect(sessionDurationMinutes(createSessionStats(T0), T0 + 20_000)).toBe(0);
  });

  it("never goes negative when the clock steps backwards", () => {
    expect(sessionDurationMinutes(createSessionStats(T0), T0 - 5 * MINUTE)).toBe(0);
  });

  it("defaults to now", () => {
    expect(sessionDurationMinutes(createSessionStats(Date.now()))).toBe(0);
  });
});

describe("formatSessionStats", () => {
  it("renders a session with nothing in it and no phrase breakdown", () => {
    expect(formatSessionStats(createSessionStats(T0), T0)).toBe(
      "Session: 0min, 0 detections, 0 errors, 0 engine starts, 0 cooldowns"
    );
  });

  it("renders several phrases, most detected first", () => {
    const stats = createSessionStats(T0);
    for (let i = 0; i < 2; i++) recordDetection(stats, "Terminal");
    for (let i = 0; i < 8; i++) recordDetection(stats, "Claude");
    for (let i = 0; i < 4; i++) recordDetection(stats, "Copilot");
    stats.engineStarts = 17;
    stats.cooldowns = 14;
    expect(formatSessionStats(stats, T0 + 342 * MINUTE)).toBe(
      "Session: 342min, 14 detections (Claude: 8, Copilot: 4, Terminal: 2), " +
        "0 errors, 17 engine starts, 14 cooldowns"
    );
  });

  it("keeps first-heard order for phrases with equal counts", () => {
    const stats = createSessionStats(T0);
    recordDetection(stats, "Terminal");
    recordDetection(stats, "Claude");
    expect(formatSessionStats(stats, T0)).toContain("(Terminal: 1, Claude: 1)");
  });

  it("uses the singular for a count of one", () => {
    const stats = createSessionStats(T0);
    recordDetection(stats, "Claude");
    stats.errors = 1;
    stats.engineStarts = 1;
    stats.cooldowns = 1;
    expect(formatSessionStats(stats, T0 + MINUTE)).toBe(
      "Session: 1min, 1 detection (Claude: 1), 1 error, 1 engine start, 1 cooldown"
    );
  });

  it("counts errors and engine starts independently of detections", () => {
    const stats = createSessionStats(T0);
    stats.errors = 2;
    stats.engineStarts = 3;
    expect(formatSessionStats(stats, T0)).toBe(
      "Session: 0min, 0 detections, 2 errors, 3 engine starts, 0 cooldowns"
    );
  });

  it("is a single log line", () => {
    const stats = createSessionStats(T0);
    recordDetection(stats, "Claude");
    recordDetection(stats, "Copilot");
    expect(formatSessionStats(stats, T0)).not.toContain("\n");
  });

  it("defaults the end time to now", () => {
    expect(formatSessionStats(createSessionStats(Date.now()))).toMatch(/^Session: 0min, /);
  });
});
