import { describe, expect, it } from "vitest";
import { matchRoute, normalizePhrases } from "../../src/wakeWordCore";
import type { WakePhrase } from "../../src/speechEngineInterface";

describe("normalizePhrases", () => {
  it("wraps a single string in an array", () => {
    expect(normalizePhrases("hey claude")).toEqual(["hey claude"]);
  });

  it("lowercases and trims a single string", () => {
    expect(normalizePhrases("  Hey CLAUDE  ")).toEqual(["hey claude"]);
  });

  it("normalises every entry of an array", () => {
    expect(normalizePhrases([" Hey Claude ", "OPEN Claude"])).toEqual([
      "hey claude",
      "open claude",
    ]);
  });

  it("drops empty strings", () => {
    expect(normalizePhrases(["hey claude", ""])).toEqual(["hey claude"]);
  });

  it("drops whitespace-only strings", () => {
    expect(normalizePhrases(["hey claude", "   ", "\t\n"])).toEqual(["hey claude"]);
  });

  it("returns an empty array when nothing survives", () => {
    expect(normalizePhrases(["", "  "])).toEqual([]);
    expect(normalizePhrases("")).toEqual([]);
    expect(normalizePhrases([])).toEqual([]);
  });

  it("does not collapse inner whitespace", () => {
    expect(normalizePhrases(" hey   claude ")).toEqual(["hey   claude"]);
  });

  // wakeWord.routes is user-edited JSON and VS Code does not enforce the
  // contributed schema, so a non-string in the array must not throw during
  // activation. Before the guard this raised "p.toLowerCase is not a function".
  it("skips non-string entries instead of throwing", () => {
    const mixed = ["hey claude", 42, null, undefined, { phrase: "x" }, true];
    expect(() => normalizePhrases(mixed)).not.toThrow();
    expect(normalizePhrases(mixed)).toEqual(["hey claude"]);
  });

  it("returns an empty array for a non-string scalar", () => {
    expect(normalizePhrases(42)).toEqual([]);
    expect(normalizePhrases(null)).toEqual([]);
    expect(normalizePhrases(undefined)).toEqual([]);
  });
});

describe("matchRoute", () => {
  const routes: WakePhrase[] = [
    { label: "Claude", phrase: "hey claude", command: "claude-vscode.focus" },
    {
      label: "Copilot",
      phrase: ["hey copilot", "Open Copilot"],
      command: "workbench.action.chat.open",
    },
    { label: "Terminal", phrase: "computer", command: "workbench.action.terminal.focus" },
  ];

  it("matches a single-phrase route", () => {
    expect(matchRoute(routes, "hey claude")?.label).toBe("Claude");
  });

  it("matches case insensitively", () => {
    expect(matchRoute(routes, "HEY Claude")?.label).toBe("Claude");
  });

  it("matches an alias inside a phrase array", () => {
    expect(matchRoute(routes, "open copilot")?.label).toBe("Copilot");
  });

  it("selects the correct route out of several", () => {
    expect(matchRoute(routes, "computer")?.label).toBe("Terminal");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchRoute(routes, "hey siri")).toBeUndefined();
  });

  it("returns undefined for an empty routing table", () => {
    expect(matchRoute([], "hey claude")).toBeUndefined();
  });

  it("returns undefined for an empty detected phrase", () => {
    expect(matchRoute(routes, "")).toBeUndefined();
    expect(matchRoute(routes, "   ")).toBeUndefined();
  });

  it("requires a whole-phrase match, not a substring", () => {
    expect(matchRoute(routes, "hey")).toBeUndefined();
    expect(matchRoute(routes, "hey claude please")).toBeUndefined();
  });
});
