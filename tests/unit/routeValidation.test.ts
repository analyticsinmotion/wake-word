import { describe, expect, it } from "vitest";
import {
  filterValidRoutes,
  isValidRoute,
  resolveRoutes,
} from "../../src/wakeWordCore";
import { DEFAULT_ROUTES } from "../../src/extension";
import type { WakePhrase } from "../../src/speechEngineInterface";

const claude: WakePhrase = {
  label: "Claude",
  phrase: "hey claude",
  command: "claude-vscode.focus",
};

describe("isValidRoute", () => {
  it("accepts a complete route", () => {
    expect(isValidRoute(claude)).toBe(true);
  });

  it("accepts a route with an alias array", () => {
    expect(isValidRoute({ ...claude, phrase: ["hey claude", "open claude"] })).toBe(true);
  });

  it("rejects a route with no phrase", () => {
    expect(isValidRoute({ ...claude, phrase: "" })).toBe(false);
    expect(isValidRoute({ ...claude, phrase: "   " })).toBe(false);
    expect(isValidRoute({ ...claude, phrase: [] })).toBe(false);
    expect(isValidRoute({ ...claude, phrase: ["", "  "] })).toBe(false);
  });

  it("rejects a route with a missing label", () => {
    expect(isValidRoute({ ...claude, label: "" })).toBe(false);
    expect(isValidRoute({ ...claude, label: "  " })).toBe(false);
  });

  it("rejects a route with a missing command", () => {
    expect(isValidRoute({ ...claude, command: "" })).toBe(false);
    expect(isValidRoute({ ...claude, command: "  " })).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(isValidRoute(undefined)).toBe(false);
    expect(isValidRoute(null)).toBe(false);
  });

  it("accepts a route whose alias array is only partly usable", () => {
    // The unusable alias is discarded later by normalizePhrases; the route
    // itself still has something to listen for.
    expect(isValidRoute({ ...claude, phrase: ["hey claude", ""] })).toBe(true);
  });

  // Settings JSON is not schema-enforced, so a wrong-typed field reaches here.
  it("does not throw on wrong-typed fields", () => {
    const bad = { label: 7, phrase: 42, command: null } as unknown as WakePhrase;
    expect(() => isValidRoute(bad)).not.toThrow();
    expect(isValidRoute(bad)).toBe(false);
  });
});

describe("filterValidRoutes", () => {
  it("keeps only usable routes and preserves order", () => {
    const routes = [
      { label: "A", phrase: "alpha", command: "cmd.a" },
      { label: "", phrase: "beta", command: "cmd.b" },
      { label: "C", phrase: "", command: "cmd.c" },
      { label: "D", phrase: "delta", command: "" },
      { label: "E", phrase: "echo", command: "cmd.e" },
    ];
    expect(filterValidRoutes(routes).map((r) => r.label)).toEqual(["A", "E"]);
  });

  it("returns an empty array for an empty input", () => {
    expect(filterValidRoutes([])).toEqual([]);
  });

  it("returns an empty array for a non-array input", () => {
    expect(filterValidRoutes(undefined as unknown as WakePhrase[])).toEqual([]);
  });
});

describe("resolveRoutes", () => {
  it("uses the user routes when at least one is valid", () => {
    const user = [
      { label: "", phrase: "beta", command: "cmd.b" },
      { label: "E", phrase: "echo", command: "cmd.e" },
    ];
    expect(resolveRoutes(user, DEFAULT_ROUTES).map((r) => r.label)).toEqual(["E"]);
  });

  it("falls back to the defaults when there are no user routes", () => {
    expect(resolveRoutes([], DEFAULT_ROUTES)).toEqual(DEFAULT_ROUTES);
  });

  it("falls back to the defaults when every user route is unusable", () => {
    const user = [
      { label: "", phrase: "", command: "" },
      { label: "X", phrase: "  ", command: "cmd.x" },
    ];
    expect(resolveRoutes(user, DEFAULT_ROUTES)).toEqual(DEFAULT_ROUTES);
  });

  it("returns a copy of the defaults so callers cannot mutate them", () => {
    const resolved = resolveRoutes([], DEFAULT_ROUTES);
    expect(resolved).not.toBe(DEFAULT_ROUTES);
    resolved.pop();
    expect(DEFAULT_ROUTES).toHaveLength(3);
  });
});

describe("DEFAULT_ROUTES", () => {
  it("ships only usable routes", () => {
    expect(DEFAULT_ROUTES.length).toBeGreaterThan(0);
    for (const route of DEFAULT_ROUTES) {
      expect(isValidRoute(route)).toBe(true);
    }
  });

  it("has no duplicate phrases across routes", () => {
    const seen = new Set<string>();
    for (const route of DEFAULT_ROUTES) {
      const phrases = Array.isArray(route.phrase) ? route.phrase : [route.phrase];
      for (const p of phrases) {
        const key = p.toLowerCase().trim();
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});
