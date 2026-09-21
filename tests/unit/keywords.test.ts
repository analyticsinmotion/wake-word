import { describe, expect, it } from "vitest";
import {
  WORD_BOUNDARY,
  buildKeywordSpec,
  decodePieces,
  keywordTexts,
  parseVocabulary,
  skippedPhraseWarning,
} from "../../src/keywords";

const B = WORD_BOUNDARY;

/** The boost score and default trigger threshold a keyword line ends with. */
const SUFFIX = " :3.0 #0.05";

/**
 * Drop the ':' boost and '#' threshold fields from a keyword line, as
 * sherpa-onnx does when it parses the list, leaving the pieces.
 */
function linePieces(line: string): string[] {
  return line.split(" ").filter((t) => !t.startsWith(":") && !t.startsWith("#"));
}

/**
 * A stand-in for SentencePiece's encodePieces that splits on spaces, marks
 * each word boundary the way the real model does, and breaks longer words
 * into two pieces. The round trip (encode, then decode the pieces) is what has
 * to agree with the string sherpa-onnx reports on a hit, so the shape of the
 * pieces matters more than the exact vocabulary.
 *
 *   "HEY CLAUDE" -> ["<B>HE", "Y", "<B>CL", "AUDE"]
 */
function fakeEncodePieces(text: string): string[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => {
      const head = B + word.slice(0, 2);
      const tail = word.slice(2);
      return tail ? [head, tail] : [head];
    });
}

/** Every piece fakeEncodePieces() produces for these texts. */
function vocabularyFor(...texts: string[]): Set<string> {
  return new Set(texts.flatMap((text) => fakeEncodePieces(text.toUpperCase())));
}

describe("decodePieces", () => {
  it("turns the boundary marker back into a space", () => {
    expect(decodePieces([B + "HEY", B + "CLAUDE"])).toBe("HEY CLAUDE");
  });

  it("joins sub-word pieces without a space", () => {
    expect(decodePieces([B + "CL", "AU", "DE"])).toBe("CLAUDE");
  });

  it("trims the leading boundary of the first piece", () => {
    expect(decodePieces([B + "COMPUTER"])).toBe("COMPUTER");
  });

  it("returns an empty string for no pieces", () => {
    expect(decodePieces([])).toBe("");
  });

  it("handles pieces with no boundary marker at all", () => {
    expect(decodePieces(["HE", "Y"])).toBe("HEY");
  });

  it("replaces only a leading boundary marker", () => {
    expect(decodePieces([B + "A" + B + "B"])).toBe("A" + B + "B");
  });

  it("round-trips a multi-word phrase through the fake tokeniser", () => {
    expect(decodePieces(fakeEncodePieces("HEY CLAUDE"))).toBe("HEY CLAUDE");
    expect(decodePieces(fakeEncodePieces("COMPUTER"))).toBe("COMPUTER");
    expect(decodePieces(fakeEncodePieces("  OPEN   TERMINAL  "))).toBe("OPEN TERMINAL");
  });
});

describe("buildKeywordSpec", () => {
  it("writes keyword lines as space-separated pieces with the boost and threshold", () => {
    const spec = buildKeywordSpec([{ phrase: "hey" }], fakeEncodePieces, 0.05);
    expect(spec.keywordLines).toEqual([B + "HE Y :3.0 #0.05"]);
    expect(spec.keywords).toBe(B + "HE Y :3.0 #0.05");
  });

  it("writes the threshold it is given as the trigger threshold", () => {
    for (const threshold of [0.01, 0.2, 0.35, 0.9]) {
      const spec = buildKeywordSpec([{ phrase: "hey" }], fakeEncodePieces, threshold);
      expect(spec.keywordLines).toEqual([B + "HE Y :3.0 #" + threshold]);
    }
  });

  it("clamps the threshold into the setting range before writing it", () => {
    const line = (threshold: unknown) =>
      buildKeywordSpec([{ phrase: "hey" }], fakeEncodePieces, threshold).keywordLines[0];
    expect(line(0.001)).toBe(B + "HE Y :3.0 #0.01");
    expect(line(-1)).toBe(B + "HE Y :3.0 #0.01");
    expect(line(5)).toBe(B + "HE Y :3.0 #0.9");
  });

  it("writes the default threshold when none or an unusable one is given", () => {
    for (const threshold of [undefined, null, NaN, 0, "not a number"]) {
      const spec = buildKeywordSpec([{ phrase: "hey" }], fakeEncodePieces, threshold);
      expect(spec.keywordLines).toEqual([B + "HE Y" + SUFFIX]);
    }
  });

  it("ends every keyword line with the boost score and trigger threshold", () => {
    const spec = buildKeywordSpec(
      [
        { phrase: "hey claude" },
        { phrase: ["hey chat", "open chat"] },
        { phrase: ["hey computer", "open terminal"] },
      ],
      fakeEncodePieces,
      0.05
    );
    expect(spec.keywordLines).toHaveLength(5);
    for (const line of spec.keywordLines) {
      expect(line.endsWith(SUFFIX)).toBe(true);
      expect(line.slice(0, -SUFFIX.length)).not.toMatch(/[:#]/);
    }
  });

  it("separates keyword lines with a newline, as sherpa-onnx expects", () => {
    const spec = buildKeywordSpec([{ phrase: "hey" }, { phrase: "yo" }], fakeEncodePieces);
    expect(spec.keywords).toBe(B + "HE Y" + SUFFIX + "\n" + B + "YO" + SUFFIX);
  });

  it("emits one keyword line per phrase", () => {
    const spec = buildKeywordSpec(
      [{ phrase: "hey claude" }, { phrase: "computer" }],
      fakeEncodePieces
    );
    expect(spec.keywordLines).toHaveLength(2);
    expect(spec.keywords.split("\n")).toHaveLength(2);
  });

  it("expands an alias array into one line each", () => {
    const spec = buildKeywordSpec([{ phrase: ["hey claude", "open claude"] }], fakeEncodePieces);
    expect(spec.keywordLines).toHaveLength(2);
    expect(spec.phraseMap["HEY CLAUDE"]).toBe("hey claude");
    expect(spec.phraseMap["OPEN CLAUDE"]).toBe("open claude");
  });

  it("tokenises the upper-cased, trimmed phrase and maps back to lower case", () => {
    const seen: string[] = [];
    const spec = buildKeywordSpec([{ phrase: "  Hey CLAUDE  " }], (text) => {
      seen.push(text);
      return fakeEncodePieces(text);
    });
    expect(seen).toEqual(["HEY CLAUDE"]);
    expect(Object.keys(spec.phraseMap)).toEqual(["HEY CLAUDE"]);
    expect(spec.phraseMap["HEY CLAUDE"]).toBe("hey claude");
  });

  it("maps every line's decoded pieces back to its phrase", () => {
    const configured = ["hey claude", "hey chat", "open chat", "hey computer", "open terminal"];
    const spec = buildKeywordSpec(
      configured.map((phrase) => ({ phrase })),
      fakeEncodePieces
    );
    expect(spec.keywordLines).toHaveLength(configured.length);
    spec.keywordLines.forEach((line, i) => {
      expect(spec.phraseMap[decodePieces(linePieces(line))]).toBe(configured[i]);
    });
  });

  it("keeps the boost and threshold out of the debug tokens and the lookup key", () => {
    const spec = buildKeywordSpec([{ phrase: "hey chat" }], fakeEncodePieces);
    expect(spec.details).toEqual([
      { phrase: "hey chat", tokens: B + "HE Y " + B + "CH AT", decoded: "HEY CHAT" },
    ]);
    expect(Object.keys(spec.phraseMap)).toEqual(["HEY CHAT"]);
  });

  it("skips blank phrases", () => {
    const spec = buildKeywordSpec(
      [{ phrase: ["hey claude", "", "   ", "\t\r\n", "\ufeff"] }],
      fakeEncodePieces
    );
    expect(spec.keywordLines).toHaveLength(1);
    expect(Object.keys(spec.phraseMap)).toEqual(["HEY CLAUDE"]);
  });

  it("skips non-string phrases and empty routes instead of throwing", () => {
    const spec = buildKeywordSpec(
      [
        { phrase: ["hey claude", 42, null, { nested: true }] },
        { phrase: 7 },
        {},
        null,
        undefined,
      ],
      fakeEncodePieces
    );
    expect(spec.keywordLines).toHaveLength(1);
    expect(spec.phraseMap).toEqual({ "HEY CLAUDE": "hey claude" });
  });

  it("returns an empty spec for no usable phrase, for the caller to refuse", () => {
    for (const input of [[], null, undefined, [{ phrase: ["", 42] }]]) {
      const spec = buildKeywordSpec(input, fakeEncodePieces);
      expect(spec.keywordLines).toEqual([]);
      expect(spec.keywords).toBe("");
      expect(spec.phraseMap).toEqual({});
      expect(spec.details).toEqual([]);
      expect(spec.skipped).toEqual([]);
    }
  });

  it("drops a phrase whose pieces decode to nothing", () => {
    const spec = buildKeywordSpec([{ phrase: "hey claude" }], () => []);
    expect(spec.keywordLines).toHaveLength(0);
    expect(spec.phraseMap).toEqual({});
  });

  it("follows JavaScript object semantics when two phrases decode alike", () => {
    // Both lines are kept (sherpa-onnx accepts the repeat) but there is one
    // lookup key: the later phrase takes the value and the key keeps the
    // place the first one gave it.
    const spec = buildKeywordSpec(
      [{ phrase: "hey claude" }, { phrase: "open chat" }, { phrase: "HEY  CLAUDE" }],
      fakeEncodePieces
    );
    expect(spec.keywordLines).toHaveLength(3);
    expect(Object.keys(spec.phraseMap)).toEqual(["HEY CLAUDE", "OPEN CHAT"]);
    expect(Object.values(spec.phraseMap)).toEqual(["hey  claude", "open chat"]);
  });

  it("serialises the map in the order the engine reads it", () => {
    const spec = buildKeywordSpec(
      [{ phrase: "open chat" }, { phrase: "hey claude" }],
      fakeEncodePieces
    );
    expect(JSON.stringify(spec.phraseMap)).toBe('{"OPEN CHAT":"open chat","HEY CLAUDE":"hey claude"}');
  });

  describe("with the model's token table", () => {
    it("keeps a phrase whose pieces are all in the table", () => {
      const spec = buildKeywordSpec(
        [{ phrase: "hey claude" }],
        fakeEncodePieces,
        0.05,
        vocabularyFor("hey claude")
      );
      expect(spec.keywordLines).toEqual([B + "HE Y " + B + "CL AUDE" + SUFFIX]);
      expect(spec.skipped).toEqual([]);
    });

    it("skips a phrase with an unknown piece and names the phrase and the piece", () => {
      const spec = buildKeywordSpec(
        [{ phrase: ["hey claude", "Route 66"] }],
        fakeEncodePieces,
        0.05,
        vocabularyFor("hey claude", "route")
      );
      expect(spec.keywordLines).toEqual([B + "HE Y " + B + "CL AUDE" + SUFFIX]);
      expect(spec.phraseMap).toEqual({ "HEY CLAUDE": "hey claude" });
      expect(spec.details.map((d) => d.phrase)).toEqual(["hey claude"]);
      expect(spec.skipped).toEqual([{ phrase: "Route 66", piece: B + "66" }]);
    });

    it("skips every phrase when none of them can be spotted", () => {
      const spec = buildKeywordSpec(
        [{ phrase: "route 66" }, { phrase: ["café", "7"] }],
        fakeEncodePieces,
        0.05,
        vocabularyFor("route")
      );
      expect(spec.keywordLines).toEqual([]);
      expect(spec.phraseMap).toEqual({});
      expect(spec.skipped.map((s) => s.phrase)).toEqual(["route 66", "café", "7"]);
    });

    it("does not let a skipped phrase take the map entry of one that decodes alike", () => {
      // Pieces the table lacks that decode to the same text: without the
      // table, the later phrase would take the entry.
      const encode = (text: string) =>
        text === "HEY CLAUDE." ? [B + "HEY", B + "CLAUDE"] : fakeEncodePieces(text);
      const phrases = [{ phrase: "hey claude" }, { phrase: "hey claude." }];
      expect(buildKeywordSpec(phrases, encode).phraseMap).toEqual({ "HEY CLAUDE": "hey claude." });

      const spec = buildKeywordSpec(phrases, encode, 0.05, vocabularyFor("hey claude"));
      expect(spec.phraseMap).toEqual({ "HEY CLAUDE": "hey claude" });
      expect(spec.keywordLines).toHaveLength(1);
      expect(spec.skipped).toEqual([{ phrase: "hey claude.", piece: B + "HEY" }]);
    });

    it("skips nothing when no table is given", () => {
      const spec = buildKeywordSpec([{ phrase: "route 66" }], fakeEncodePieces);
      expect(spec.keywordLines).toHaveLength(1);
      expect(spec.skipped).toEqual([]);
    });
  });

  describe("with a route's own threshold", () => {
    it("writes the route's threshold on its line instead of the global one", () => {
      const spec = buildKeywordSpec(
        [{ phrase: "hey claude", confidenceThreshold: 0.03 }],
        fakeEncodePieces,
        0.05
      );
      expect(spec.keywordLines).toEqual([B + "HE Y " + B + "CL AUDE :3.0 #0.03"]);
    });

    it("writes the global threshold for a route that has none", () => {
      const spec = buildKeywordSpec([{ phrase: "hey claude" }], fakeEncodePieces, 0.2);
      expect(spec.keywordLines).toEqual([B + "HE Y " + B + "CL AUDE :3.0 #0.2"]);
    });

    it("gives every alias of a route the route's threshold", () => {
      const spec = buildKeywordSpec(
        [{ phrase: ["hey chat", "open chat"], confidenceThreshold: 0.4 }],
        fakeEncodePieces,
        0.05
      );
      expect(spec.keywordLines).toEqual([
        B + "HE Y " + B + "CH AT :3.0 #0.4",
        B + "OP EN " + B + "CH AT :3.0 #0.4",
      ]);
    });

    it("gives each route its own threshold in one spec", () => {
      const spec = buildKeywordSpec(
        [
          { phrase: "hey claude", confidenceThreshold: 0.02 },
          { phrase: "hey chat" },
          { phrase: "hey computer", confidenceThreshold: 0.5 },
        ],
        fakeEncodePieces,
        0.05
      );
      expect(spec.keywordLines.map((line) => line.slice(line.indexOf("#")))).toEqual([
        "#0.02",
        "#0.05",
        "#0.5",
      ]);
    });

    it("clamps a route's threshold into the setting range", () => {
      const line = (confidenceThreshold: unknown) =>
        buildKeywordSpec([{ phrase: "hey", confidenceThreshold }], fakeEncodePieces, 0.05)
          .keywordLines[0];
      expect(line(0.001)).toBe(B + "HE Y :3.0 #0.01");
      expect(line(-1)).toBe(B + "HE Y :3.0 #0.01");
      expect(line(5)).toBe(B + "HE Y :3.0 #0.9");
      expect(line("0.6")).toBe(B + "HE Y :3.0 #0.6");
    });

    it("falls back to the global threshold for an unusable route value", () => {
      for (const confidenceThreshold of [undefined, null, NaN, 0, "not a number", {}]) {
        const spec = buildKeywordSpec(
          [{ phrase: "hey", confidenceThreshold }],
          fakeEncodePieces,
          0.2
        );
        expect(spec.keywordLines).toEqual([B + "HE Y :3.0 #0.2"]);
      }
    });

    it("clamps the global fallback before a route falls back to it", () => {
      const spec = buildKeywordSpec(
        [{ phrase: "hey", confidenceThreshold: "nonsense" }],
        fakeEncodePieces,
        5
      );
      expect(spec.keywordLines).toEqual([B + "HE Y :3.0 #0.9"]);
    });

    it("keeps the route's threshold out of the debug tokens and the lookup key", () => {
      const spec = buildKeywordSpec(
        [{ phrase: "hey chat", confidenceThreshold: 0.03 }],
        fakeEncodePieces
      );
      expect(spec.details).toEqual([
        { phrase: "hey chat", tokens: B + "HE Y " + B + "CH AT", decoded: "HEY CHAT" },
      ]);
      expect(Object.keys(spec.phraseMap)).toEqual(["HEY CHAT"]);
    });
  });
});

describe("keywordTexts", () => {
  it("lists every text buildKeywordSpec asks its encoder for, once each, in order", () => {
    const phrases = [
      { phrase: ["  Hey Claude", "open chat", 42, ""] },
      null,
      { phrase: "HEY CLAUDE" },
      { phrase: "route 66" },
    ];
    const asked: string[] = [];
    buildKeywordSpec(phrases, (text) => {
      asked.push(text);
      return fakeEncodePieces(text);
    });
    expect(keywordTexts(phrases)).toEqual(["HEY CLAUDE", "OPEN CHAT", "ROUTE 66"]);
    expect([...new Set(asked)]).toEqual(keywordTexts(phrases));
  });

  it("is empty for no usable phrase", () => {
    expect(keywordTexts([])).toEqual([]);
    expect(keywordTexts(null)).toEqual([]);
    expect(keywordTexts([{ phrase: ["  ", 1] }])).toEqual([]);
  });
});

describe("parseVocabulary", () => {
  it("reads one token per line, before the id", () => {
    const vocabulary = parseVocabulary(`<blk> 0\n<unk> 2\r\nS 3\n${B}THE 5\n' 13\n${B} 20\n`);
    expect([...vocabulary].sort()).toEqual(["'", "<blk>", "<unk>", "S", B, B + "THE"].sort());
    expect(vocabulary.has("3")).toBe(false);
  });

  it("ignores lines with no id", () => {
    expect([...parseVocabulary("\nA 1\nnoid\n")]).toEqual(["A"]);
  });
});

describe("skippedPhraseWarning", () => {
  it("names the phrase and the piece and says what the model can spell", () => {
    expect(skippedPhraseWarning({ phrase: "route 66", piece: "66" })).toBe(
      'Phrase "route 66" skipped: "66" is not in the speech model\'s vocabulary. ' +
        "Phrases can use the letters A to Z, apostrophes, and hyphens; write numbers as words."
    );
  });
});
