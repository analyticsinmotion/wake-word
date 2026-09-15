import { describe, expect, it } from "vitest";
import {
  COMMON_WORDS,
  SHORT_PHRASE_LENGTH,
  detectPhraseCollisions,
  formatPhraseChecks,
  formatPhraseChecksSummary,
  phraseChecksKey,
  validatePhraseQuality,
} from "../../src/wakeWordCore";
import { DEFAULT_ROUTES } from "../../src/extension";
import type { WakePhrase } from "../../src/speechEngineInterface";

function route(label: string, phrase: WakePhrase["phrase"], command = "workbench.action.quickOpen"): WakePhrase {
  return { label, phrase, command };
}

function warningsFor(phrase: WakePhrase["phrase"]): string[] {
  return validatePhraseQuality([route("Test", phrase)]).map((w) => w.warning);
}

describe("validatePhraseQuality", () => {
  it("warns about a single word", () => {
    const warnings = validatePhraseQuality([route("Search", "search")]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].label).toBe("Search");
    expect(warnings[0].phrase).toBe("search");
    expect(warnings[0].warning).toBe(
      '"search" is a single word. Single words cause more false positives. ' +
        'Consider a two-word phrase like "hey search".'
    );
  });

  it("does not warn about a two-word phrase", () => {
    expect(validatePhraseQuality([route("Search", "search files")])).toEqual([]);
  });

  it("warns about a very short phrase", () => {
    // Two words, so only the length is a problem.
    expect(warningsFor("x y")).toEqual([
      '"x y" is very short (3 characters). Short phrases are harder to detect reliably.',
    ]);
  });

  it("does not count a phrase of exactly the minimum length as short", () => {
    expect(SHORT_PHRASE_LENGTH).toBe(4);
    expect(warningsFor("x yz")).toEqual([]);
  });

  it("warns about a common word on its own", () => {
    const warnings = warningsFor("stop");
    expect(warnings).toContain(
      '"stop" is a very common word and will likely trigger frequently by accident.'
    );
  });

  it("does not warn about a common word inside a two-word phrase", () => {
    expect(warningsFor("stop listening")).toEqual([]);
    expect(warningsFor("hey computer")).toEqual([]);
    expect(warningsFor("open terminal")).toEqual([]);
  });

  it("gives one phrase every warning that applies to it", () => {
    const warnings = warningsFor("hi");
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/single word/);
    expect(warnings[1]).toMatch(/very short \(2 characters\)/);
    expect(warnings[2]).toMatch(/very common word/);
  });

  it("checks each alias of a route on its own", () => {
    const warnings = validatePhraseQuality([route("Claude", ["hey claude", "claude", "go"])]);
    expect(warnings.map((w) => w.phrase)).toEqual(["claude", "go", "go", "go"]);
    expect(warnings.every((w) => w.label === "Claude")).toBe(true);
  });

  it("skips empty and non-string aliases, as the engine does", () => {
    expect(warningsFor(["", "   ", "hey claude"])).toEqual([]);
    expect(warningsFor([42 as unknown as string, "hey claude"])).toEqual([]);
    expect(warningsFor("")).toEqual([]);
  });

  it("checks the phrase as the engine hears it: lowercased and trimmed", () => {
    const warnings = validatePhraseQuality([route("Stop", "  STOP  ")]);
    expect(warnings[0].phrase).toBe("stop");
    expect(warnings.map((w) => w.warning)).toContain(
      '"stop" is a very common word and will likely trigger frequently by accident.'
    );
  });

  it("counts words separated by any run of whitespace", () => {
    expect(warningsFor("hey   claude")).toEqual([]);
  });

  it("does not suggest \"hey hey\" for a bare \"hey\"", () => {
    expect(warningsFor("hey")[0]).toContain('"hey computer"');
  });

  it("covers the common words the extension warns about", () => {
    for (const word of ["yes", "no", "ok", "okay", "hello", "hi", "hey", "stop", "start", "go",
      "run", "open", "close", "the", "a", "an", "is", "it", "on", "off"]) {
      expect(COMMON_WORDS.has(word)).toBe(true);
    }
  });

  it("finds nothing wrong with the default routes", () => {
    expect(validatePhraseQuality(DEFAULT_ROUTES)).toEqual([]);
  });

  it("returns nothing for no routes", () => {
    expect(validatePhraseQuality([])).toEqual([]);
  });
});

describe("detectPhraseCollisions", () => {
  it("detects the same phrase on two routes", () => {
    const collisions = detectPhraseCollisions([
      route("Claude", "hey claude"),
      route("Chat", "hey claude"),
    ]);
    expect(collisions).toEqual([
      {
        routeA: "Claude",
        phraseA: "hey claude",
        routeB: "Chat",
        phraseB: "hey claude",
        reason:
          '"Claude" and "Chat" both use "hey claude". ' +
          'Only "Claude" can fire: a detection goes to the first matching route.',
      },
    ]);
  });

  it("detects a shorter phrase contained in a longer one on a later route", () => {
    const collisions = detectPhraseCollisions([
      route("Claude", "claude"),
      route("Chat", "hey claude"),
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ routeA: "Claude", phraseA: "claude", routeB: "Chat", phraseB: "hey claude" });
    expect(collisions[0].reason).toBe(
      '"claude" (Claude) is contained within "hey claude" (Chat). ' +
        "The shorter phrase may trigger when the longer one is spoken."
    );
  });

  it("detects a longer phrase that contains a shorter one on a later route", () => {
    const collisions = detectPhraseCollisions([
      route("Chat", "hey claude"),
      route("Claude", "claude"),
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ routeA: "Chat", phraseA: "hey claude", routeB: "Claude", phraseB: "claude" });
    expect(collisions[0].reason).toBe(
      '"claude" (Claude) is contained within "hey claude" (Chat). ' +
        "The shorter phrase may trigger when the longer one is spoken."
    );
  });

  it("does not flag the same phrase repeated as an alias on one route", () => {
    expect(detectPhraseCollisions([route("Claude", ["hey claude", "hey claude"])])).toEqual([]);
  });

  it("does not flag one alias contained in another on the same route", () => {
    // Whichever is heard, the same command runs.
    expect(detectPhraseCollisions([route("Claude", ["hey claude", "claude"])])).toEqual([]);
  });

  it("finds nothing between unrelated phrases", () => {
    expect(
      detectPhraseCollisions([
        route("Search", "search files"),
        route("Commands", "open commands"),
      ])
    ).toEqual([]);
    expect(detectPhraseCollisions(DEFAULT_ROUTES)).toEqual([]);
  });

  it("compares without regard to case or surrounding whitespace", () => {
    const collisions = detectPhraseCollisions([
      route("Claude", "Hey Claude"),
      route("Chat", "  hey CLAUDE "),
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].phraseA).toBe("hey claude");
    expect(collisions[0].phraseB).toBe("hey claude");
  });

  it("tells routes apart by position, not by label", () => {
    const collisions = detectPhraseCollisions([
      route("Claude", "hey claude", "claude-vscode.focus"),
      route("Claude", "hey claude", "workbench.action.chat.open"),
    ]);
    expect(collisions).toHaveLength(1);
  });

  it("reports each clashing pair once", () => {
    const collisions = detectPhraseCollisions([
      route("A", "hey claude"),
      route("B", "hey claude"),
      route("C", "hey claude"),
    ]);
    expect(collisions.map((c) => [c.routeA, c.routeB])).toEqual([
      ["A", "B"],
      ["A", "C"],
      ["B", "C"],
    ]);
  });

  it("checks every alias against the other routes", () => {
    const collisions = detectPhraseCollisions([
      route("Claude", ["hey claude", "open claude"]),
      route("Terminal", ["open terminal", "open claude"]),
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].phraseA).toBe("open claude");
  });
});

describe("phraseChecksKey", () => {
  it("ignores what the checks do not depend on", () => {
    const a = [route("Search", "search files", "workbench.action.quickOpen")];
    const b = [{ ...route("Search", "search files", "workbench.action.showCommands"), cooldownSeconds: 10, handoff: "manual" as const }];
    expect(phraseChecksKey(b)).toBe(phraseChecksKey(a));
  });

  it("ignores case and surrounding whitespace in phrases", () => {
    expect(phraseChecksKey([route("Search", "  Search Files")])).toBe(
      phraseChecksKey([route("Search", "search files")])
    );
  });

  it("changes when a phrase, an alias, or a label changes", () => {
    const base = phraseChecksKey([route("Search", "search files")]);
    expect(phraseChecksKey([route("Search", "find files")])).not.toBe(base);
    expect(phraseChecksKey([route("Search", ["search files", "find"])])).not.toBe(base);
    expect(phraseChecksKey([route("Find", "search files")])).not.toBe(base);
    expect(phraseChecksKey([route("Search", "search files"), route("Go", "go")])).not.toBe(base);
  });
});

describe("formatPhraseChecks", () => {
  it("renders warnings first, then collisions, one line each", () => {
    const routes = [route("Go", "go"), route("Chat", "hey go")];
    const lines = formatPhraseChecks(validatePhraseQuality(routes), detectPhraseCollisions(routes));
    expect(lines).toEqual([
      'Phrase warning (Go): "go" is a single word. Single words cause more false positives. Consider a two-word phrase like "hey go".',
      'Phrase warning (Go): "go" is very short (2 characters). Short phrases are harder to detect reliably.',
      'Phrase warning (Go): "go" is a very common word and will likely trigger frequently by accident.',
      'Phrase collision: "go" (Go) is contained within "hey go" (Chat). The shorter phrase may trigger when the longer one is spoken.',
    ]);
  });

  it("renders nothing when nothing was found", () => {
    expect(formatPhraseChecks([], [])).toEqual([]);
  });
});

describe("formatPhraseChecksSummary", () => {
  it("counts the warnings for the notification", () => {
    expect(formatPhraseChecksSummary(1)).toBe(
      "Wake Word: 1 phrase warning found. Check the output channel for details."
    );
    expect(formatPhraseChecksSummary(4)).toBe(
      "Wake Word: 4 phrase warnings found. Check the output channel for details."
    );
  });
});
