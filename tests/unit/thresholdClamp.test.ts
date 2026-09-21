import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTES } from "../../src/extension";
import type { WakePhrase } from "../../src/speechEngineInterface";
import {
  DEFAULT_THRESHOLD,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  clampThreshold,
  describeThreshold,
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

describe("the settings schema", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
  );
  const properties = manifest.contributes.configuration.properties;
  const global = properties["wakeWord.confidenceThreshold"];
  const route = properties["wakeWord.routes"].items.properties.confidenceThreshold;

  it("states the same bounds for the global threshold as clampThreshold enforces", () => {
    expect(global.type).toBe("number");
    expect(global.minimum).toBe(MIN_THRESHOLD);
    expect(global.maximum).toBe(MAX_THRESHOLD);
    expect(global.default).toBe(DEFAULT_THRESHOLD);
  });

  it("accepts confidenceThreshold on a route, with the same bounds", () => {
    expect(route.type).toBe("number");
    expect(route.minimum).toBe(MIN_THRESHOLD);
    expect(route.maximum).toBe(MAX_THRESHOLD);
  });

  it("describes the route field as an override of the global setting", () => {
    expect(route.description).toMatch(/wakeWord\.confidenceThreshold/);
    expect(route.description).toMatch(/0\.01 to 0\.9/);
  });

  it("leaves the route field optional, so routes without one use the global value", () => {
    expect(manifest.contributes.configuration.properties["wakeWord.routes"].items.required).toEqual([
      "label",
      "phrase",
      "command",
    ]);
  });

  it("sets no confidenceThreshold on the shipped default routes", () => {
    expect(properties["wakeWord.routes"].default).toEqual([]);
    for (const route of DEFAULT_ROUTES) {
      expect(route.confidenceThreshold).toBeUndefined();
    }
  });
});

describe("describeThreshold", () => {
  const route = (confidenceThreshold?: number): WakePhrase => ({
    label: "Route",
    phrase: "hey claude",
    command: "noop",
    ...(confidenceThreshold === undefined ? {} : { confidenceThreshold }),
  });

  it("is the global value alone when no route sets its own", () => {
    expect(describeThreshold(0.05, [route(), route()])).toBe("0.05");
    expect(describeThreshold(0.05, [])).toBe("0.05");
  });

  it("counts the routes that replace it", () => {
    expect(describeThreshold(0.05, [route(0.02), route()])).toBe("0.05 (overridden by 1 route)");
    expect(describeThreshold(0.05, [route(0.02), route(0.4), route()])).toBe(
      "0.05 (overridden by 2 routes)"
    );
  });
});
