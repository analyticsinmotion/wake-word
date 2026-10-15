import * as path from "path";
import { readFile } from "fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ROUTES } from "../../src/extension";
import { WORD_BOUNDARY, buildKeywordSpec, decodePieces, skippedPhraseWarning } from "../../src/keywords";
import { Tokeniser, loadTokeniser, parseTokenTable, parseTokeniser } from "../../src/tokeniser";
import { CategoryDigest, buildCorpus, digestCategory } from "./tokeniserCorpus";

/**
 * The tokeniser: reading bpe.model and tokens.txt, the search for the best
 * split, and the loader's cache. The models here are built in memory, and
 * readFile is wrapped so that a test can hand the loader files that are not
 * on disk. With WAKE_WORD_MODEL_DIR naming the extracted keyword spotting
 * model, the tests at the end check its pieces: a pinned table, the default
 * routes' keyword lines, and a digest of every input of the corpus in
 * tokeniserCorpus.ts. They are skipped without it.
 */

const fakeFiles = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (file: string, encoding?: BufferEncoding) => {
      const content = fakeFiles.get(String(file));
      if (content === undefined) {
        return actual.readFile(file, encoding);
      }
      return encoding ? content.toString(encoding) : content;
    }),
  };
});

const B = WORD_BOUNDARY;
const MODEL_DIR = process.env.WAKE_WORD_MODEL_DIR;

// -- Models built in memory ------------------------------------------------

function varint(value: number): number[] {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value % 0x80) | 0x80);
    value = Math.floor(value / 0x80);
  }
  bytes.push(value);
  return bytes;
}

function tag(field: number, wireType: number): number[] {
  return varint(field * 8 + wireType);
}

function lengthDelimited(field: number, payload: readonly number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}

function float32(field: number, value: number): number[] {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(value);
  return [...tag(field, 5), ...bytes];
}

interface Piece {
  text: string;
  score?: number;
  kind?: number;
  /** Other bytes inside the piece's record. */
  extra?: number[];
}

function pieceRecord({ text, score, kind, extra = [] }: Piece): number[] {
  return lengthDelimited(1, [
    ...lengthDelimited(1, [...Buffer.from(text, "utf8")]),
    ...(score === undefined ? [] : float32(2, score)),
    ...(kind === undefined ? [] : [...tag(3, 0), ...varint(kind)]),
    ...extra,
  ]);
}

/** A bpe.model with these pieces, and two records of other fields after them. */
function modelFile(pieces: readonly Piece[]): Buffer {
  const settings = lengthDelimited(2, [...lengthDelimited(1, [...Buffer.from("settings")]), ...tag(4, 0), ...varint(500)]);
  const normaliser = lengthDelimited(3, lengthDelimited(1, [...Buffer.from("nmt_nfkc")]));
  return Buffer.from([...pieces.flatMap(pieceRecord), ...settings, ...normaliser]);
}

function tokenTable(pieces: readonly Piece[]): string {
  return pieces.map((piece, id) => `${piece.text} ${id}\n`).join("");
}

/** The special tokens every model here starts with, as the keyword model's do. */
const SPECIAL: Piece[] = [
  { text: "<blk>", score: 0, kind: 4 },
  { text: "<sos/eos>", score: 0, kind: 4 },
  { text: "<unk>", score: 0, kind: 2 },
];

function tokeniserFor(pieces: readonly Piece[]): Tokeniser {
  const all = [...SPECIAL, ...pieces];
  return parseTokeniser(modelFile(all), tokenTable(all));
}

// -- The search -------------------------------------------------------------

describe("the search for the best split", () => {
  const simple = tokeniserFor([
    { text: B, score: -3 },
    { text: "A", score: -2 },
    { text: "B", score: -2 },
    { text: "AB", score: -3 },
    { text: B + "A", score: -2.5 },
    { text: "'", score: -1 },
  ]);

  it("splits a word into the pieces whose scores have the highest sum", () => {
    // "▁A B" scores -4.5, "▁ AB" -6, and "▁ A B" -7.
    expect(simple.encode("AB")).toEqual([B + "A", "B"]);
    expect(simple.encode("BA")).toEqual([B, "B", "A"]);
  });

  it("starts every word with the boundary marker", () => {
    expect(simple.encode("A B")).toEqual([B + "A", B, "B"]);
    expect(simple.encode("'A")).toEqual([B, "'", "A"]);
  });

  it("reads leading, trailing, and repeated spaces as nothing", () => {
    expect(simple.encode("  A   B ")).toEqual(simple.encode("A B"));
    expect(simple.encode("")).toEqual([]);
    expect(simple.encode("   ")).toEqual([]);
  });

  it("gives null when no split covers the text", () => {
    expect(simple.encode("C")).toBeNull();
    expect(simple.encode("A C")).toBeNull();
    expect(simple.encode("a")).toBeNull();
  });

  it("never uses a special token or a piece of other characters", () => {
    const other = tokeniserFor([
      { text: B, score: -1 },
      { text: "A", score: -1 },
      { text: "\u00c9", score: -0.1 },
      { text: "a", score: -0.1 },
    ]);
    expect(other.encode("<unk>")).toBeNull();
    expect(other.encode("\u00c9")).toBeNull();
    expect(other.encode("a")).toBeNull();
    expect([...other.scores.keys()]).toEqual([B, "A"]);
  });

  it("keeps the earlier start on an exact tie, which has the longer last piece", () => {
    // "▁ XX" and "▁ X X" both score -5.
    const tied = tokeniserFor([
      { text: B, score: -1 },
      { text: "X", score: -2 },
      { text: "XX", score: -4 },
    ]);
    expect(tied.encode("XX")).toEqual([B, "XX"]);
  });

  it("keeps each position's score rounded to a 32-bit float, over the whole text", () => {
    // "▁ L LL" and "▁ LL L" have the same sum, and on its own the tie goes to
    // the earlier start. After "W" the sums are near 2^24, where a 32-bit
    // float holds only even integers: the rounded score kept after "▁ L" is
    // lower than the one kept after "▁ LL", and "LL L" wins.
    const rounding = tokeniserFor([
      { text: B, score: -1 },
      { text: "L", score: -3 },
      { text: "LL", score: -5 },
      { text: B + "W", score: -16777215 },
    ]);
    expect(rounding.encode("LLL")).toEqual([B, "L", "LL"]);
    expect(rounding.encode("W LLL")).toEqual([B + "W", B, "LL", "L"]);
  });

  it("compares a candidate with the rounded score kept, not the sum it was rounded from", () => {
    // Summed exactly, "▁ X Y" (-2^24 - 3.5) beats "▁ XY" (-2^24 - 5). Kept
    // rounded, "▁ X" is -2^24 - 4, and "▁ X Y" comes to -2^24 - 4.5, which is
    // not greater than the -2^24 - 4 kept for "▁ XY", rounded up from -2^24 - 5.
    const kept = tokeniserFor([
      { text: B, score: -16777216 },
      { text: "X", score: -3 },
      { text: "Y", score: -0.5 },
      { text: "XY", score: -5 },
    ]);
    expect(kept.encode("XY")).toEqual([B, "XY"]);
  });
});

// -- Reading the files ------------------------------------------------------

describe("parseTokeniser", () => {
  const pieces: Piece[] = [...SPECIAL, { text: B, score: -1 }, { text: "A", score: -2 }];

  function refusal(model: Buffer, table = tokenTable(pieces)): string {
    try {
      parseTokeniser(model, table);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("the model was accepted");
  }

  it("reads every token and the score of every piece it can use", () => {
    const tokeniser = parseTokeniser(modelFile(pieces), tokenTable(pieces));
    expect([...tokeniser.vocabulary]).toEqual(["<blk>", "<sos/eos>", "<unk>", B, "A"]);
    expect([...tokeniser.scores]).toEqual([
      [B, -1],
      ["A", -2],
    ]);
  });

  it("reads 32-bit float scores exactly", () => {
    const tokeniser = tokeniserFor([{ text: B, score: -4.62416410446167 }]);
    expect(tokeniser.scores.get(B)).toBe(Math.fround(-4.62416410446167));
  });

  it("skips fields it does not use, inside a piece and around the pieces", () => {
    const withExtra = [...SPECIAL, { text: B, score: -1, extra: [...tag(9, 0), ...varint(7)] }];
    expect(parseTokeniser(modelFile(withExtra), tokenTable(withExtra)).encode("")).toEqual([]);
  });

  it("refuses a model with a piece count other than the token table's", () => {
    expect(refusal(modelFile(pieces), tokenTable([...pieces, { text: "B" }]))).toBe(
      "bpe.model does not match tokens.txt: it has 5 pieces and the token table 6 tokens"
    );
  });

  it("refuses a model whose pieces are not the tokens, in order", () => {
    const swapped = [...SPECIAL, { text: "A" }, { text: B }];
    expect(refusal(modelFile(pieces), tokenTable(swapped))).toBe(
      `bpe.model does not match tokens.txt: piece 3 is "${B}", token 3 "A"`
    );
  });

  it("refuses a piece it would use that is marked as a special token", () => {
    const marked = [...SPECIAL, { text: "A", score: -1, kind: 4 }];
    expect(refusal(modelFile(marked), tokenTable(marked))).toBe(
      'bpe.model: piece 3, "A", is marked as a special token'
    );
  });

  it("refuses a piece it would use whose score is not a number", () => {
    for (const score of [NaN, -Infinity]) {
      const broken = [...SPECIAL, { text: "A", score }];
      expect(refusal(modelFile(broken), tokenTable(broken))).toBe(
        `bpe.model: piece 3, "A", has the score ${score}`
      );
    }
  });

  it("refuses a piece with no score", () => {
    const unscored = [...SPECIAL, { text: "A" }];
    expect(refusal(modelFile(unscored), tokenTable(unscored))).toBe("bpe.model: piece 3 has no score");
  });

  it("refuses a model that is cut short", () => {
    const whole = modelFile(pieces);
    expect(refusal(whole.subarray(0, 20))).toMatch(/^bpe\.model: .* runs past the end of its record$/);
  });

  it("refuses a record of a wire type it does not read", () => {
    const group = Buffer.concat([modelFile(pieces), Buffer.from(tag(4, 3))]);
    expect(refusal(group)).toBe("bpe.model: field 4 has wire type 3, which the tokeniser does not read");
  });

  it("refuses a token table whose ids do not count up from 0", () => {
    expect(refusal(modelFile(pieces), "<blk> 0\n<sos/eos> 2\n")).toBe('tokens.txt: line 2 has id "2", not 1');
  });
});

describe("parseTokenTable", () => {
  it("reads the tokens in order, each before the id after its last space", () => {
    expect(parseTokenTable(`<blk> 0\n<unk> 1\r\nS 2\n${B}THE 3\n' 4\n${B} 5\nA B 6\n`)).toEqual([
      "<blk>",
      "<unk>",
      "S",
      B + "THE",
      "'",
      B,
      "A B",
    ]);
  });

  it("skips lines with no id", () => {
    expect(parseTokenTable("\nA 0\nnoid\n")).toEqual(["A"]);
  });
});

// -- Loading ----------------------------------------------------------------

describe("loadTokeniser", () => {
  const pieces: Piece[] = [...SPECIAL, { text: B, score: -1 }, { text: "A", score: -2 }];

  function provide(dir: string, table = tokenTable(pieces)): void {
    fakeFiles.set(path.join(dir, "bpe.model"), modelFile(pieces));
    fakeFiles.set(path.join(dir, "tokens.txt"), Buffer.from(table, "utf8"));
  }

  function readsOf(dir: string): string[] {
    return vi
      .mocked(readFile)
      .mock.calls.map(([file]) => String(file))
      .filter((file) => file.startsWith(dir));
  }

  beforeEach(() => {
    vi.mocked(readFile).mockClear();
  });

  it("reads a model directory's two files once and keeps the tokeniser", async () => {
    const dir = path.join(__dirname, "no-such-model", "kept");
    provide(dir);
    const first = await loadTokeniser(dir);
    const second = await loadTokeniser(dir);
    expect(second).toBe(first);
    expect(readsOf(dir).sort()).toEqual([path.join(dir, "bpe.model"), path.join(dir, "tokens.txt")]);
    expect(first.encode("A")).toEqual([B, "A"]);
  });

  it("reads the files again after a load that failed", async () => {
    const dir = path.join(__dirname, "no-such-model", "later");
    await expect(loadTokeniser(dir)).rejects.toThrow(/ENOENT/);
    provide(dir);
    await expect(loadTokeniser(dir)).resolves.toBeDefined();
    expect(readsOf(dir)).toHaveLength(4);
  });

  it("names the model directory and what is wrong with it", async () => {
    const dir = path.join(__dirname, "no-such-model", "mismatched");
    provide(dir, tokenTable([...pieces, { text: "B" }]));
    await expect(loadTokeniser(dir)).rejects.toThrow(
      `the model in ${dir} cannot be used: bpe.model does not match tokens.txt: ` +
        "it has 5 pieces and the token table 6 tokens"
    );
  });
});

// -- The keyword spotting model ---------------------------------------------

/** The pieces of each phrase, as the keyword lines are built from them. */
const REFERENCE_PIECES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["HEY CLAUDE", ["▁HE", "Y", "▁C", "LA", "U", "DE"]],
  ["HEY CHAT", ["▁HE", "Y", "▁CHA", "T"]],
  ["OPEN CHAT", ["▁O", "P", "EN", "▁CHA", "T"]],
  ["HEY COMPUTER", ["▁HE", "Y", "▁COMP", "U", "TER"]],
  ["OPEN TERMINAL", ["▁O", "P", "EN", "▁", "TER", "M", "IN", "AL"]],
  ["OPEN CLAUDE", ["▁O", "P", "EN", "▁C", "LA", "U", "DE"]],
  ["HELLO WORLD", ["▁HE", "LL", "O", "▁WORLD"]],
  ["HAPPY NEW YEAR", ["▁HA", "PP", "Y", "▁NEW", "▁YEAR"]],
  ["MERRY CHRISTMAS", ["▁ME", "R", "RY", "▁", "CH", "R", "IST", "MA", "S"]],
  ["LIGHT UP", ["▁", "L", "IGHT", "▁UP"]],
  ["LOVELY CHILD", ["▁LOVE", "LY", "▁CHI", "L", "D"]],
  ["DON'T STOP", ["▁DON", "'", "T", "▁ST", "O", "P"]],
];

/** The default routes' keyword lines at the default threshold. */
const DEFAULT_KEYWORD_LINES = [
  "▁HE Y ▁C LA U DE :3.0 #0.05",
  "▁HE Y ▁CHA T :3.0 #0.05",
  "▁O P EN ▁CHA T :3.0 #0.05",
  "▁HE Y ▁COMP U TER :3.0 #0.05",
  "▁O P EN ▁ TER M IN AL :3.0 #0.05",
];

/**
 * Each category of the corpus: its number of inputs, a digest of the inputs,
 * and a digest of their pieces (see digestCategory()). A change to the pieces
 * of any one input changes its category's digest.
 */
const CORPUS_DIGESTS: Record<string, CategoryDigest> = {
  tokens: {
    count: 994,
    inputs: "3669d209b4624087cb8c6279cfe85598e5f486e8ed8ac464b531322f865d121c",
    pieces: "4935e4e90a34597a897ef4ab23d4feab7839bd71d2929aba67b1ed89de4f72d5",
  },
  strings: {
    count: 732_540,
    inputs: "38c73a255be51829cb98b4ac97e362d62454d7aab0355895d4330b034bca0bc5",
    pieces: "69e53ed87083c8a5e2fbcc10c8729804290ac7448c168bcd3f903db613fc51ae",
  },
  "piece-words": {
    count: 40_000,
    inputs: "027eadf2c0526fd8d4961ed3fb385bc7f9a53121fab0c78cc9c1ec66127f274b",
    pieces: "71eaa1155c8e2b53c9943a7f70f01cfecdf174202af03071facdefe32e919d75",
  },
  "piece-phrases": {
    count: 40_000,
    inputs: "d26b439c186180d47266babf7c9c8deb92d73d0d5a8f35b6736c0b5488d6f299",
    pieces: "d2cdeb4e588b829ae9b77b61170c6fcf3e424a5b4b2c4370c285c3c0b7e5e18f",
  },
  repeats: {
    count: 20_000,
    inputs: "0424b922b72ad44a9a99dbc6c8995b7bbbd1b619bcaca4ee21dc1a21a227f786",
    pieces: "bf144ded94acd8864b693c4407b690b18b6ae65fdb73fe7ececd8f961f4ab1bf",
  },
  "near-ties": {
    count: 2_000,
    inputs: "b596a9a0614071509af8e6ea06560b95eccf047e2ccbeba83852b16e5c96d2da",
    pieces: "3e4bf78488ed19b761e9b1cbe85ed3001dc852b274133e35bf822e8994c006e6",
  },
};

describe.runIf(MODEL_DIR)("with the keyword spotting model", () => {
  const modelDir = MODEL_DIR as string;
  const spec = async (phrases: Array<{ phrase: unknown; confidenceThreshold?: unknown }>) => {
    const tokeniser = await loadTokeniser(modelDir);
    return buildKeywordSpec(phrases, (text) => tokeniser.encode(text), 0.05, tokeniser.vocabulary);
  };

  it("reads the model's 500 tokens and the 497 pieces of letters, apostrophes, and hyphens", async () => {
    const tokeniser = await loadTokeniser(modelDir);
    expect(tokeniser.vocabulary.size).toBe(500);
    expect(tokeniser.scores.size).toBe(497);
  });

  it("gives the pieces in the pinned table", async () => {
    const tokeniser = await loadTokeniser(modelDir);
    for (const [text, pieces] of REFERENCE_PIECES) {
      expect(tokeniser.encode(text), text).toEqual(pieces);
      expect(decodePieces(pieces)).toBe(text);
    }
  });

  it("builds the default routes' keyword lines and phrase map", async () => {
    const built = await spec(DEFAULT_ROUTES);
    expect(built.keywordLines).toEqual(DEFAULT_KEYWORD_LINES);
    expect(built.phraseMap).toEqual({
      "HEY CLAUDE": "hey claude",
      "HEY CHAT": "hey chat",
      "OPEN CHAT": "open chat",
      "HEY COMPUTER": "hey computer",
      "OPEN TERMINAL": "open terminal",
    });
    expect(built.skipped).toEqual([]);
  });

  it("gives a phrase the keyword line of its cleaned-up text and keeps the phrase as configured", async () => {
    const pairs: Array<[string, string]> = [
      ["Hey, Claude!", "hey claude"],
      ["what\u2019s up", "what's up"],
      ["what\u2018s up", "what's up"],
      ["Zo\u00eb", "zoe"],
      ["CAFE\u0301", "cafe"],
      ["  open:   chat; ", "open chat"],
      ["hey\tclaude", "hey claude"],
    ];
    for (const [configured, plain] of pairs) {
      const cleaned = await spec([{ phrase: configured }]);
      const reference = await spec([{ phrase: plain }]);
      expect(cleaned.keywordLines, configured).toEqual(reference.keywordLines);
      expect(cleaned.keywordLines, configured).toHaveLength(1);
      expect(Object.values(cleaned.phraseMap), configured).toEqual([configured.toLowerCase().trim()]);
    }
  });

  it("sets aside a phrase with other characters and says which", async () => {
    const built = await spec([
      { phrase: ["hey claude", "route 66", "<blk>", "<unk>", "<sos/eos>", "\u043f\u0440\u0438", "?!"] },
    ]);
    expect(built.keywordLines).toEqual([DEFAULT_KEYWORD_LINES[0]]);
    expect(built.skipped).toEqual([
      { phrase: "route 66", piece: "66" },
      { phrase: "<blk>", piece: "<" },
      { phrase: "<unk>", piece: "<" },
      { phrase: "<sos/eos>", piece: "<" },
      { phrase: "\u043f\u0440\u0438", piece: "\u041f\u0420\u0418" },
      { phrase: "?!", piece: "" },
    ]);
    expect(skippedPhraseWarning(built.skipped[0])).toBe(
      'Phrase "route 66" skipped: "66" is not in the speech model\'s vocabulary. ' +
        "Phrases can use the letters A to Z, apostrophes, and hyphens; write numbers as words."
    );
  });

  it("gives the pinned pieces for every input of each category of the corpus", async () => {
    const tokeniser = await loadTokeniser(modelDir);
    const corpus = buildCorpus({ tokens: [...tokeniser.vocabulary], scores: tokeniser.scores });
    const digests: Record<string, CategoryDigest> = {};
    for (const category of corpus) {
      digests[category.name] = digestCategory(category.inputs, (text) => tokeniser.encode(text));
    }
    expect(digests).toEqual(CORPUS_DIGESTS);
  }, 120_000);
});
