import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLD,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  clampThreshold,
} from "../../src/wakeWordCore";

describe("clampThreshold", () => {
  it("passes an in-range value through", () => {
    expect(clampThreshold(0.5)).toBe(0.5);
  });

  it("clamps below the minimum", () => {
    expect(clampThreshold(-5)).toBe(MIN_THRESHOLD);
    expect(clampThreshold(0.001)).toBe(MIN_THRESHOLD);
  });

  it("clamps above the maximum", () => {
    expect(clampThreshold(5)).toBe(MAX_THRESHOLD);
    expect(clampThreshold(0.95)).toBe(MAX_THRESHOLD);
  });

  it("keeps the range bounds themselves", () => {
    expect(clampThreshold(MIN_THRESHOLD)).toBe(MIN_THRESHOLD);
    expect(clampThreshold(MAX_THRESHOLD)).toBe(MAX_THRESHOLD);
  });

  it("allows the range 0.01 to 0.9, the settings schema's bounds", () => {
    expect(MIN_THRESHOLD).toBe(0.01);
    expect(MAX_THRESHOLD).toBe(0.9);
    expect(clampThreshold(0.01)).toBe(0.01);
    expect(clampThreshold(0.05)).toBe(0.05);
  });

  it("falls back to the default for values that are not usable numbers", () => {
    expect(DEFAULT_THRESHOLD).toBe(0.05);
    expect(clampThreshold(undefined)).toBe(0.05);
    expect(clampThreshold(null)).toBe(0.05);
    expect(clampThreshold(NaN)).toBe(0.05);
    expect(clampThreshold("not a number")).toBe(0.05);
    expect(clampThreshold(0)).toBe(0.05);
  });

  it("coerces a numeric string", () => {
    expect(clampThreshold("0.6")).toBe(0.6);
  });

  it("honours a caller-supplied fallback", () => {
    expect(clampThreshold(undefined, 0.25)).toBe(0.25);
  });

  it("never returns a value outside the settings range", () => {
    const inputs = [-1, 0, 0.001, 0.01, 0.05, 0.3, 0.9, 1, 100, NaN, "x", null, undefined];
    for (const input of inputs) {
      const result = clampThreshold(input);
      expect(result).toBeGreaterThanOrEqual(MIN_THRESHOLD);
      expect(result).toBeLessThanOrEqual(MAX_THRESHOLD);
    }
  });
});
