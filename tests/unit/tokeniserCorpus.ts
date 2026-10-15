import { createHash } from "crypto";

/**
 * The corpus the tokeniser's pieces are pinned over: inputs made of the
 * letters A to Z, the apostrophe, the hyphen, and the space, in six
 * categories. Every input is generated from the model's token table and piece
 * scores by a fixed procedure, so the corpus is the same on every run and on
 * every platform, and tokeniser.test.ts checks a digest of each category's
 * inputs as well as of their pieces.
 *
 *   tokens         every token of the table without its boundary marker,
 *                  alone and after "HEY"
 *   strings        every string of one to four characters over the alphabet
 *   piece-words    words made of one to four of the model's pieces
 *   piece-phrases  phrases of one to four such words
 *   repeats        runs of one to four repeated letters, with occasional
 *                  spaces, apostrophes and hyphens
 *   near-ties      words whose two best splits score the same, or within
 *                  NEAR_TIE_MARGIN, alone and after "HEY"
 */

/** The model as the corpus reads it. */
export interface CorpusModel {
  /** Every token of tokens.txt, in order. */
  tokens: readonly string[];
  /** The score of every piece the tokeniser can use, keyed by its text. */
  scores: ReadonlyMap<string, number>;
}

export interface CorpusCategory {
  name: string;
  inputs: Iterable<string>;
}

const BOUNDARY = "▁";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** The characters every input is made of. */
export const CORPUS_ALPHABET = LETTERS + "'- ";
const SEPARATORS = [" ", "'", "-"];

export const PIECE_WORDS = 40_000;
export const PIECE_PHRASES = 40_000;
export const REPEATS = 20_000;
export const NEAR_TIE_WORDS = 1_000;
/** The widest gap between the two best splits of a near-tie word. */
export const NEAR_TIE_MARGIN = 1e-5;
const NEAR_TIE_ATTEMPTS = 200_000;

/**
 * A linear congruential generator over 32 bits, with the constants from
 * Numerical Recipes. Each call returns a number in [0, 1) from the high bits
 * of the state, which are the well-mixed ones.
 */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)];
}

/** The pieces' texts without the boundary marker, in token table order. */
function pieceTexts(model: CorpusModel): string[] {
  return model.tokens.filter((token) => model.scores.has(token)).map((token) => token.replace(BOUNDARY, ""));
}

function* tokenInputs(model: CorpusModel): Generator<string> {
  for (const token of model.tokens) {
    const text = token.startsWith(BOUNDARY) ? token.slice(1) : token;
    // The special tokens are made of other characters, and are left out.
    if (/^[A-Z'-]*$/.test(text)) {
      yield text;
      yield "HEY " + text;
    }
  }
}

function* allStrings(): Generator<string> {
  for (let length = 1; length <= 4; length++) {
    const digits = new Array<number>(length).fill(0);
    for (;;) {
      yield digits.map((d) => CORPUS_ALPHABET[d]).join("");
      let position = length - 1;
      while (position >= 0 && digits[position] === CORPUS_ALPHABET.length - 1) {
        digits[position] = 0;
        position--;
      }
      if (position < 0) {
        break;
      }
      digits[position]++;
    }
  }
}

/** A word of one to four pieces; a draw that spells nothing is drawn again. */
function pieceWord(next: () => number, pieces: readonly string[]): string {
  for (;;) {
    const count = 1 + Math.floor(next() * 4);
    let word = "";
    for (let i = 0; i < count; i++) {
      word += pick(next, pieces);
    }
    if (word.length > 0) {
      return word;
    }
  }
}

function* pieceWords(model: CorpusModel): Generator<string> {
  const next = generator(1);
  const pieces = pieceTexts(model);
  for (let i = 0; i < PIECE_WORDS; i++) {
    yield pieceWord(next, pieces);
  }
}

function* piecePhrases(model: CorpusModel): Generator<string> {
  const next = generator(2);
  const pieces = pieceTexts(model);
  for (let i = 0; i < PIECE_PHRASES; i++) {
    const count = 1 + Math.floor(next() * 4);
    const words: string[] = [];
    for (let w = 0; w < count; w++) {
      words.push(pieceWord(next, pieces));
    }
    yield words.join(" ");
  }
}

/**
 * Letters whose doubled form is a piece. A run of three or more of one of
 * them has splits that use the same pieces in a different order, which score
 * exactly the same.
 */
function tieLetters(model: CorpusModel): string[] {
  return [...LETTERS].filter((letter) => model.scores.has(letter + letter));
}

function* repeats(model: CorpusModel): Generator<string> {
  const next = generator(3);
  const tying = tieLetters(model);
  const letters = [...LETTERS];
  for (let i = 0; i < REPEATS; i++) {
    let text = next() < 0.05 ? pick(next, SEPARATORS) : "";
    const runs = 1 + Math.floor(next() * 5);
    for (let r = 0; r < runs; r++) {
      if (r > 0 && next() < 0.25) {
        text += pick(next, SEPARATORS);
      }
      const letter = next() < 0.5 && tying.length > 0 ? pick(next, tying) : pick(next, letters);
      text += letter.repeat(1 + Math.floor(next() * 4));
    }
    if (next() < 0.05) {
      text += pick(next, SEPARATORS);
    }
    yield text;
  }
}

/**
 * The scores of the two best splits of `word` with a boundary marker in
 * front, summed exactly: -Infinity where there is no second split.
 */
function twoBestSplits(word: string, scores: ReadonlyMap<string, number>, longest: number): [number, number] {
  const text = BOUNDARY + word;
  const best: Array<[number, number]> = Array.from({ length: text.length + 1 }, () => [-Infinity, -Infinity]);
  best[0] = [0, -Infinity];
  for (let start = 0; start < text.length; start++) {
    const [first, second] = best[start];
    if (first === -Infinity) {
      continue;
    }
    for (let end = start + 1; end <= Math.min(text.length, start + longest); end++) {
      const score = scores.get(text.slice(start, end));
      if (score === undefined) {
        continue;
      }
      const cell = best[end];
      for (const value of [first + score, second + score]) {
        if (value > cell[0]) {
          cell[1] = cell[0];
          cell[0] = value;
        } else if (value > cell[1]) {
          cell[1] = value;
        }
      }
    }
  }
  return best[text.length];
}

/**
 * Words whose two best splits tie or nearly tie: a piece, a run of three to
 * six of a letter whose doubled form is a piece, and another piece, kept when
 * the gap between the two best splits is at most NEAR_TIE_MARGIN.
 */
export function nearTieWords(model: CorpusModel): string[] {
  const next = generator(5);
  const pieces = pieceTexts(model);
  const tying = tieLetters(model);
  const longest = Math.max(...[...model.scores.keys()].map((piece) => piece.length));
  const found = new Set<string>();
  for (let attempt = 0; attempt < NEAR_TIE_ATTEMPTS && found.size < NEAR_TIE_WORDS && tying.length > 0; attempt++) {
    const word = pick(next, pieces) + pick(next, tying).repeat(3 + Math.floor(next() * 4)) + pick(next, pieces);
    if (found.has(word)) {
      continue;
    }
    const [first, second] = twoBestSplits(word, model.scores, longest);
    if (second !== -Infinity && first - second <= NEAR_TIE_MARGIN) {
      found.add(word);
    }
  }
  return [...found];
}

function* nearTies(model: CorpusModel): Generator<string> {
  for (const word of nearTieWords(model)) {
    yield word;
    yield "HEY " + word;
  }
}

export function buildCorpus(model: CorpusModel): CorpusCategory[] {
  return [
    { name: "tokens", inputs: { [Symbol.iterator]: () => tokenInputs(model) } },
    { name: "strings", inputs: { [Symbol.iterator]: () => allStrings() } },
    { name: "piece-words", inputs: { [Symbol.iterator]: () => pieceWords(model) } },
    { name: "piece-phrases", inputs: { [Symbol.iterator]: () => piecePhrases(model) } },
    { name: "repeats", inputs: { [Symbol.iterator]: () => repeats(model) } },
    { name: "near-ties", inputs: { [Symbol.iterator]: () => nearTies(model) } },
  ];
}

/** What a category's digests are made of. */
export interface CategoryDigest {
  count: number;
  /** SHA-256 of every input, each followed by a line feed, in order. */
  inputs: string;
  /**
   * SHA-256 of every input followed by a tab, its pieces separated by single
   * spaces, and a line feed, in order. An input with no split has "-" for its
   * pieces.
   */
  pieces: string;
}

export function digestCategory(
  inputs: Iterable<string>,
  encode: (text: string) => readonly string[] | null
): CategoryDigest {
  const inputHash = createHash("sha256");
  const pieceHash = createHash("sha256");
  let count = 0;
  for (const input of inputs) {
    const pieces = encode(input);
    inputHash.update(input + "\n", "utf8");
    pieceHash.update(input + "\t" + (pieces === null ? "-" : pieces.join(" ")) + "\n", "utf8");
    count++;
  }
  return { count, inputs: inputHash.digest("hex"), pieces: pieceHash.digest("hex") };
}
