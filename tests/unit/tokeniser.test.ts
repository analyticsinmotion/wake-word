import { readFileSync } from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTES } from "../../src/extension";
import { buildKeywordSpec, decodePieces, keywordTexts } from "../../src/keywords";
import { readVocabulary, tokenise } from "../../src/tokeniser";

/**
 * The tokeniser runs in a worker thread. These tests start real workers:
 * against a stand-in for sentencepiece-js (tests/mocks/sentencepiece.js),
 * whose behaviour is chosen by the name of the model directory, and against
 * the real package. No model file is read unless WAKE_WORD_MODEL_DIR names the
 * extracted keyword spotting model, which the pinned-table tests at the end
 * need and are skipped without.
 */

const STAND_IN = path.join(__dirname, "..", "mocks", "sentencepiece.js");
const MODEL_DIR = process.env.WAKE_WORD_MODEL_DIR;

/** A model directory for the stand-in; only its name matters. */
function standInDir(mode: string): string {
  return path.join(__dirname, "no-such-model", mode);
}

function listenerCounts(): { uncaughtException: number; unhandledRejection: number } {
  return {
    uncaughtException: process.listenerCount("uncaughtException"),
    unhandledRejection: process.listenerCount("unhandledRejection"),
  };
}

describe("tokenise", () => {
  it("encodes every text, in order, in a worker", async () => {
    const before = Date.now();
    const result = await tokenise(standInDir("ok"), ["HEY CLAUDE", "OPEN CHAT"], {
      moduleFile: STAND_IN,
    });
    expect(result.pieces).toEqual([
      ["▁HEY", "▁CLAUDE"],
      ["▁OPEN", "▁CHAT"],
    ]);
    expect(result.loadedAt).toBeGreaterThanOrEqual(before);
    expect(result.loadedAt).toBeLessThanOrEqual(Date.now());
  });

  it("answers with no pieces for no texts", async () => {
    const result = await tokenise(standInDir("ok"), [], { moduleFile: STAND_IN });
    expect(result.pieces).toEqual([]);
  });

  it("rejects with the reason when the model cannot be loaded", async () => {
    await expect(
      tokenise(standInDir("fail"), ["HEY"], { moduleFile: STAND_IN })
    ).rejects.toThrow(/^cannot read .*bpe\.model$/);
  });

  it("rejects when the tokeniser package cannot be found", async () => {
    const missing = path.join(__dirname, "no-such-package.js");
    await expect(
      tokenise(standInDir("ok"), ["HEY"], { moduleFile: missing })
    ).rejects.toThrow(/Cannot find module/);
  });

  it("rejects when the worker stops without answering", async () => {
    await expect(
      tokenise(standInDir("exit"), ["HEY"], { moduleFile: STAND_IN })
    ).rejects.toThrow("the tokeniser stopped before it answered (exit code 3)");
  });

  it("rejects with an error thrown inside the worker", async () => {
    await expect(
      tokenise(standInDir("throw"), ["HEY"], { moduleFile: STAND_IN })
    ).rejects.toThrow("stray error in the tokeniser");
  });

  it("rejects a model file that encodes nothing, naming it", async () => {
    // The real package ignores the status of its model load and then encodes
    // every text to no pieces, which would otherwise read as phrases the
    // model cannot spell.
    await expect(
      tokenise(standInDir("empty"), ["HEY"], { moduleFile: STAND_IN })
    ).rejects.toThrow(/empty[\\/]bpe\.model is not a SentencePiece model the tokeniser can load$/);
  });

  it("rejects an answer that is not a list of pieces for each text", async () => {
    await expect(
      tokenise(standInDir("garbled"), ["HEY"], { moduleFile: STAND_IN })
    ).rejects.toThrow("the tokeniser returned something other than pieces");
  });

  it("stops a worker that does not answer in time", async () => {
    await expect(
      tokenise(standInDir("hang"), ["HEY"], { moduleFile: STAND_IN, timeoutMs: 200 })
    ).rejects.toThrow("the tokeniser did not answer within 0.2s");
  });

  it("keeps the process listeners the tokeniser adds inside the worker", async () => {
    // The real package's glue adds listeners that throw. Here they belong to
    // the worker's process object; this thread's are untouched.
    const before = listenerCounts();
    const result = await tokenise(standInDir("hooks"), ["HEY"], { moduleFile: STAND_IN });
    expect(result.pieces).toEqual([["▁HEY"]]);
    expect(listenerCounts()).toEqual(before);
  });

  it("loads the real sentencepiece-js without touching this thread's listeners", async () => {
    // No model at this path: the package loads, builds its WebAssembly
    // module, and then fails to read the file.
    const before = listenerCounts();
    await expect(tokenise(standInDir("real"), ["HEY"])).rejects.toThrow(/bpe\.model/);
    expect(listenerCounts()).toEqual(before);
  });
});

describe("readVocabulary", () => {
  it("rejects when the token table cannot be read", async () => {
    await expect(readVocabulary(standInDir("ok"))).rejects.toThrow(/tokens\.txt/);
  });
});

describe("the sentencepiece-js dependency", () => {
  it("is pinned to the version the Node engine pins, so both tokenise alike", () => {
    const manifest = (dir: string) =>
      JSON.parse(readFileSync(path.join(__dirname, "..", "..", dir, "package.json"), "utf8"));
    const host = manifest(".").dependencies["sentencepiece-js"];
    expect(host).toMatch(/^\d+\.\d+\.\d+$/);
    expect(host).toBe(manifest("engine").dependencies["sentencepiece-js"]);
  });
});

/**
 * The pieces sentencepiece-js 1.1.0 produces from the model's bpe.model for
 * each upper-cased phrase. The Node engine builds its keyword lines from
 * exactly these, and the Rust engine was checked against the same table.
 */
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
  // Normalisation: full-width letters fold to the vocabulary's letters, a
  // ligature unfolds to lower-case letters the vocabulary lacks, and a
  // combining accent composes.
  ["ＨＥＹ\u3000ＣＬＡＵＤＥ", ["▁HE", "Y", "▁C", "LA", "U", "DE"]],
  ["ﬁNE", ["▁", "fi", "NE"]],
  ["CAFE\u0301", ["▁CA", "F", "É"]],
  // Outside the vocabulary: returned as itself, runs merged.
  ["ROUTE 66", ["▁RO", "U", "TE", "▁", "66"]],
  ["ПРИВЕТ", ["▁", "ПРИВЕТ"]],
];

/** The default routes' keyword lines at the default threshold. */
const DEFAULT_KEYWORD_LINES = [
  "▁HE Y ▁C LA U DE :3.0 #0.05",
  "▁HE Y ▁CHA T :3.0 #0.05",
  "▁O P EN ▁CHA T :3.0 #0.05",
  "▁HE Y ▁COMP U TER :3.0 #0.05",
  "▁O P EN ▁ TER M IN AL :3.0 #0.05",
];

describe.runIf(MODEL_DIR)("with the keyword spotting model", () => {
  const modelDir = MODEL_DIR as string;

  it("gives the pieces in the pinned table", async () => {
    const texts = REFERENCE_PIECES.map(([text]) => text);
    const result = await tokenise(modelDir, texts);
    expect(result.pieces).toEqual(REFERENCE_PIECES.map(([, pieces]) => pieces));
  });

  it("builds the default routes' keyword lines and phrase map", async () => {
    const texts = keywordTexts(DEFAULT_ROUTES);
    const [result, vocabulary] = await Promise.all([tokenise(modelDir, texts), readVocabulary(modelDir)]);
    const pieces = new Map(texts.map((text, i) => [text, result.pieces[i]]));
    const spec = buildKeywordSpec(DEFAULT_ROUTES, (text) => pieces.get(text) ?? [], 0.05, vocabulary);
    expect(spec.keywordLines).toEqual(DEFAULT_KEYWORD_LINES);
    expect(spec.phraseMap).toEqual({
      "HEY CLAUDE": "hey claude",
      "HEY CHAT": "hey chat",
      "OPEN CHAT": "open chat",
      "HEY COMPUTER": "hey computer",
      "OPEN TERMINAL": "open terminal",
    });
    expect(spec.skipped).toEqual([]);
  });

  it("skips a phrase the token table cannot spell and names the piece", async () => {
    const phrases = [{ phrase: ["hey claude", "route 66", "café"] }];
    const texts = keywordTexts(phrases);
    const [result, vocabulary] = await Promise.all([tokenise(modelDir, texts), readVocabulary(modelDir)]);
    const pieces = new Map(texts.map((text, i) => [text, result.pieces[i]]));
    const spec = buildKeywordSpec(phrases, (text) => pieces.get(text) ?? [], 0.05, vocabulary);
    expect(spec.keywordLines).toEqual([DEFAULT_KEYWORD_LINES[0]]);
    expect(spec.skipped).toEqual([
      { phrase: "route 66", piece: "66" },
      { phrase: "café", piece: "É" },
    ]);
  });

  it("decodes every pinned piece list back to the normalised text", async () => {
    const cases: Array<[string, string]> = [
      ["HEY CLAUDE", "HEY CLAUDE"],
      ["  OPEN   TERMINAL ", "OPEN TERMINAL"],
      ["ＨＥＹ\u3000ＣＬＡＵＤＥ", "HEY CLAUDE"],
      ["ROUTE 66", "ROUTE 66"],
    ];
    const result = await tokenise(modelDir, cases.map(([text]) => text));
    expect(result.pieces.map((p) => decodePieces(p))).toEqual(cases.map(([, decoded]) => decoded));
  });

  it("loads the model without touching this thread's listeners", async () => {
    const before = listenerCounts();
    await tokenise(modelDir, ["HEY"]);
    expect(listenerCounts()).toEqual(before);
  });
});
