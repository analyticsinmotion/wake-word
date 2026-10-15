import { describe, expect, it } from "vitest";
import {
  WORD_BOUNDARY,
  buildKeywordSpec,
  decodePieces,
  skippedPhraseWarning,
} from "../../src/keywords";
import { cleanUpPhrase } from "../../src/wakeWordCore";

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
 * A stand-in for the tokeniser's encode() that splits on spaces, marks each
 * word boundary the way the real model does, and breaks longer words
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
        [{ phrase: ["hey claude", "Route sixty"] }],
        fakeEncodePieces,
        0.05,
        vocabularyFor("hey claude", "route")
      );
      expect(spec.keywordLines).toEqual([B + "HE Y " + B + "CL AUDE" + SUFFIX]);
      expect(spec.phraseMap).toEqual({ "HEY CLAUDE": "hey claude" });
      expect(spec.details.map((d) => d.phrase)).toEqual(["hey claude"]);
      expect(spec.skipped).toEqual([{ phrase: "Route sixty", piece: B + "SI" }]);
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
        text === "HEY-CLAUDE" ? [B + "HEY", B + "CLAUDE"] : fakeEncodePieces(text);
      const phrases = [{ phrase: "hey claude" }, { phrase: "hey-claude" }];
      expect(buildKeywordSpec(phrases, encode).phraseMap).toEqual({ "HEY CLAUDE": "hey-claude" });

      const spec = buildKeywordSpec(phrases, encode, 0.05, vocabularyFor("hey claude"));
      expect(spec.phraseMap).toEqual({ "HEY CLAUDE": "hey claude" });
      expect(spec.keywordLines).toHaveLength(1);
      expect(spec.skipped).toEqual([{ phrase: "hey-claude", piece: B + "HEY" }]);
    });

    it("skips nothing for its pieces when no table is given", () => {
      const spec = buildKeywordSpec([{ phrase: "route sixty" }], fakeEncodePieces);
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

describe("cleanUpPhrase", () => {
  const text = (phrase: string) => cleanUpPhrase(phrase);

  it("upper-cases the phrase", () => {
    expect(text("hey claude")).toEqual({ text: "HEY CLAUDE" });
    expect(text("stra\u00dfe")).toEqual({ text: "STRASSE" });
    expect(text("\ufb01ne")).toEqual({ text: "FINE" });
  });

  it("removes accents, composed or not", () => {
    expect(text("Zo\u00eb")).toEqual({ text: "ZOE" });
    expect(text("ZOE\u0308")).toEqual({ text: "ZOE" });
    expect(text("caf\u00e9 cr\u00e8me br\u00fbl\u00e9e")).toEqual({ text: "CAFE CREME BRULEE" });
    expect(text("\u0141ukasz")).toEqual({ unusable: "\u0141" });
  });

  it("folds full-width and other compatibility forms to their plain letters", () => {
    expect(text("\uff48\uff45\uff59\u3000\uff43\uff4c\uff41\uff55\uff44\uff45")).toEqual({ text: "HEY CLAUDE" });
    expect(text("\u2160 hey")).toEqual({ text: "I HEY" });
    expect(text("hey\uff0c claude\uff01")).toEqual({ text: "HEY CLAUDE" });
  });

  it("reads the curly apostrophes as an apostrophe", () => {
    expect(text("what\u2019s up")).toEqual({ text: "WHAT'S UP" });
    expect(text("\u2018n\u2019")).toEqual({ text: "'N'" });
    expect(text("don't stop")).toEqual({ text: "DON'T STOP" });
  });

  it("reads . , ! ? : ; as a space", () => {
    expect(text("Hey, Claude!")).toEqual({ text: "HEY CLAUDE" });
    expect(text("open: chat; now.")).toEqual({ text: "OPEN CHAT NOW" });
    expect(text("hey?claude")).toEqual({ text: "HEY CLAUDE" });
  });

  it("reads any white space as a space, collapses runs, and trims", () => {
    expect(text("  hey\t\tclaude\r\n")).toEqual({ text: "HEY CLAUDE" });
    expect(text("hey\u00a0claude\u3000now")).toEqual({ text: "HEY CLAUDE NOW" });
  });

  it("keeps apostrophes and hyphens", () => {
    expect(text("well-known rock 'n' roll")).toEqual({ text: "WELL-KNOWN ROCK 'N' ROLL" });
  });

  it("names the first run of characters a phrase cannot use", () => {
    expect(text("route 66")).toEqual({ unusable: "66" });
    expect(text("hey 2nd claude")).toEqual({ unusable: "2" });
    expect(text("<blk>")).toEqual({ unusable: "<" });
    expect(text("hey_claude")).toEqual({ unusable: "_" });
    expect(text("hey/claude")).toEqual({ unusable: "/" });
    expect(text("\u043f\u0440\u0438\u0432\u0435\u0442")).toEqual({
      unusable: "\u041f\u0420\u0418\u0412\u0415\u0422",
    });
    expect(text("hey\u200bclaude")).toEqual({ unusable: "\u200b" });
  });

  it("has nothing to give for punctuation alone", () => {
    expect(text("?!")).toEqual({ unusable: "" });
    expect(text(" . , ")).toEqual({ unusable: "" });
  });
});

describe("buildKeywordSpec and the clean-up rules", () => {
  it("tokenises the cleaned-up text and keeps the phrase as configured", () => {
    const seen: string[] = [];
    const spec = buildKeywordSpec([{ phrase: "Hey, Claude!" }, { phrase: "what\u2019s up" }], (text) => {
      seen.push(text);
      return fakeEncodePieces(text);
    });
    expect(seen).toEqual(["HEY CLAUDE", "WHAT'S UP"]);
    expect(spec.phraseMap).toEqual({ "HEY CLAUDE": "hey, claude!", "WHAT'S UP": "what\u2019s up" });
    expect(spec.details.map((d) => d.phrase)).toEqual(["Hey, Claude!", "what\u2019s up"]);
  });

  it("gives phrases that differ only in case, punctuation, and accents the same line", () => {
    const lines = (phrase: string) => buildKeywordSpec([{ phrase }], fakeEncodePieces).keywordLines;
    expect(lines("Hey, Claude!")).toEqual(lines("hey claude"));
    expect(lines("what\u2019s up")).toEqual(lines("what's up"));
    expect(lines("Zo\u00eb")).toEqual(lines("zoe"));
  });

  it("sets aside a phrase the rules refuse without asking the encoder", () => {
    const seen: string[] = [];
    const spec = buildKeywordSpec([{ phrase: ["route 66", "<unk>", "?!", "hey claude"] }], (text) => {
      seen.push(text);
      return fakeEncodePieces(text);
    });
    expect(seen).toEqual(["HEY CLAUDE"]);
    expect(spec.skipped).toEqual([
      { phrase: "route 66", piece: "66" },
      { phrase: "<unk>", piece: "<" },
      { phrase: "?!", piece: "" },
    ]);
    expect(spec.keywordLines).toHaveLength(1);
  });

  it("sets aside a phrase the encoder has no split for", () => {
    const spec = buildKeywordSpec([{ phrase: "hey claude" }], () => null);
    expect(spec.keywordLines).toEqual([]);
    expect(spec.skipped).toEqual([{ phrase: "hey claude", piece: "HEY CLAUDE" }]);
  });
});

describe("skippedPhraseWarning", () => {
  it("names the phrase and the piece and says what the model can spell", () => {
    expect(skippedPhraseWarning({ phrase: "route 66", piece: "66" })).toBe(
      'Phrase "route 66" skipped: "66" is not in the speech model\'s vocabulary. ' +
        "Phrases can use the letters A to Z, apostrophes, and hyphens; write numbers as words."
    );
  });

  it("says so when a phrase is punctuation alone", () => {
    expect(skippedPhraseWarning({ phrase: "?!", piece: "" })).toBe(
      'Phrase "?!" skipped: it has no words, only punctuation. ' +
        "Phrases can use the letters A to Z, apostrophes, and hyphens; write numbers as words."
    );
  });

  it("writes a character that cannot be seen as its code point", () => {
    expect(skippedPhraseWarning({ phrase: "hey\u200bclaude", piece: "\u200b" })).toMatch(
      /^Phrase "hey.claude" skipped: "U\+200B" is not in the speech model's vocabulary\. /
    );
  });
});
