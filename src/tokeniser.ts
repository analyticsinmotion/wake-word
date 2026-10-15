import { readFile } from "fs/promises";
import * as path from "path";

/**
 * The pieces of the keyword model for a wake phrase, worked out on the
 * extension host from the model's own files.
 *
 * The model directory holds the spotter's token table, tokens.txt, and
 * bpe.model, which despite its name is a SentencePiece Unigram model: it
 * lists the same pieces in the same order, each with a score, the piece's log
 * probability. The pieces of a text are its most probable split into pieces,
 * the split whose scores have the highest sum, found with the Viterbi
 * algorithm (Kudo, "Subword Regularization: Improving Neural Network
 * Translation Models with Multiple Subword Candidates", ACL 2018, section
 * 3.2). Only the pieces made of the letters A to Z, the apostrophe, the
 * hyphen, and the boundary marker take part; the special tokens never do.
 *
 * Reading the two files is the only asynchronous step. Parsing and encoding
 * are synchronous, and the parsed model is kept for each model directory, so
 * a later start or settings change does not read the files again.
 */

/** The SentencePiece model inside the model directory. */
export const TOKENISER_MODEL_FILE = "bpe.model";
/** The spotter's token table inside the model directory. */
export const TOKENS_FILE = "tokens.txt";

/** A word boundary, as the pieces mark it: U+2581 LOWER ONE EIGHTH BLOCK. */
const BOUNDARY = "\u2581";

/** The tokeniser for one model. */
export interface Tokeniser {
  /** Every token in the model's token table, in order. */
  readonly vocabulary: ReadonlySet<string>;
  /** The score of every piece the tokeniser uses, in token table order. */
  readonly scores: ReadonlyMap<string, number>;
  /**
   * The pieces of a text of the letters A to Z, apostrophes, hyphens, and
   * spaces between words, or null when no split into pieces covers it.
   * Leading, trailing, and repeated spaces separate nothing.
   */
  encode(text: string): string[] | null;
}

// -- Reading the model ----------------------------------------------------

/**
 * How bpe.model holds its pieces, in protocol buffer terms (the wire format
 * is described at https://protobuf.dev/programming-guides/encoding/). Each
 * piece is a length-delimited record of field 1 at the top level of the
 * file, in token table order. Inside it, field 1 is the piece's text in
 * UTF-8, field 2 its score as a 32-bit float, and field 3, which only the
 * special tokens carry, the kind of token it is. The file's other top-level
 * records hold its training settings and its text normalisation, which the
 * tokeniser does not use: phrases are cleaned up by Wake Word's own rules
 * before they reach it (cleanUpPhrase() in wakeWordCore.ts).
 */
const PIECE_FIELD = 1;
const PIECE_TEXT_FIELD = 1;
const PIECE_SCORE_FIELD = 2;
const PIECE_KIND_FIELD = 3;

const VARINT = 0;
const FIXED64 = 1;
const LENGTH_DELIMITED = 2;
const FIXED32 = 5;

interface WireRecord {
  field: number;
  wireType: number;
  /** A varint's value; unused for the other wire types. */
  value: number;
  /** Where the value's bytes start and end in the buffer. */
  start: number;
  end: number;
}

/** A base-128 varint at `offset`: its value and the offset after it. */
function readVarint(bytes: Uint8Array, offset: number, end: number): [number, number] {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    if (offset >= end) {
      throw new Error("a varint runs past the end of its record");
    }
    const byte = bytes[offset++];
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) {
      return [value, offset];
    }
    scale *= 128;
  }
  throw new Error("a varint is longer than ten bytes");
}

/** The records of the message between `start` and `end`, in order. */
function* wireRecords(bytes: Uint8Array, start: number, end: number): Generator<WireRecord> {
  let offset = start;
  while (offset < end) {
    let tag: number;
    [tag, offset] = readVarint(bytes, offset, end);
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    let value = 0;
    let valueStart = offset;
    switch (wireType) {
      case VARINT:
        [value, offset] = readVarint(bytes, offset, end);
        break;
      case FIXED64:
        offset += 8;
        break;
      case LENGTH_DELIMITED: {
        let length: number;
        [length, offset] = readVarint(bytes, offset, end);
        valueStart = offset;
        offset += length;
        break;
      }
      case FIXED32:
        offset += 4;
        break;
      default:
        throw new Error(`field ${field} has wire type ${wireType}, which the tokeniser does not read`);
    }
    if (offset > end) {
      throw new Error(`field ${field} runs past the end of its record`);
    }
    yield { field, wireType, value, start: valueStart, end: offset };
  }
}

interface ModelPiece {
  text: string;
  score: number;
  /** Field 3 where the piece carries it. */
  kind: number | undefined;
}

/** Every piece of a bpe.model, in order. */
function readPieces(model: Buffer): ModelPiece[] {
  const pieces: ModelPiece[] = [];
  for (const record of wireRecords(model, 0, model.length)) {
    if (record.field !== PIECE_FIELD) {
      continue;
    }
    if (record.wireType !== LENGTH_DELIMITED) {
      throw new Error(`piece ${pieces.length} is not a length-delimited record`);
    }
    let text: string | undefined;
    let score: number | undefined;
    let kind: number | undefined;
    for (const inner of wireRecords(model, record.start, record.end)) {
      if (inner.field === PIECE_TEXT_FIELD && inner.wireType === LENGTH_DELIMITED) {
        text = model.toString("utf8", inner.start, inner.end);
      } else if (inner.field === PIECE_SCORE_FIELD && inner.wireType === FIXED32) {
        score = model.readFloatLE(inner.start);
      } else if (inner.field === PIECE_KIND_FIELD && inner.wireType === VARINT) {
        kind = inner.value;
      }
    }
    if (text === undefined || score === undefined) {
      throw new Error(`piece ${pieces.length} has no ${text === undefined ? "text" : "score"}`);
    }
    pieces.push({ text, score, kind });
  }
  return pieces;
}

/**
 * The tokens of a tokens.txt, in order: one `<token> <id>` pair per line, the
 * id after the last space, the same reading as the engine's. Lines without a
 * space are skipped. The ids must count up from 0 in line order, which is
 * the order of the model's pieces.
 */
export function parseTokenTable(tokensTxt: string): string[] {
  const tokens: string[] = [];
  for (const raw of tokensTxt.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const space = line.lastIndexOf(" ");
    if (space === -1) {
      continue;
    }
    const id = line.slice(space + 1);
    if (id !== String(tokens.length)) {
      throw new Error(`line ${tokens.length + 1} has id "${id}", not ${tokens.length}`);
    }
    tokens.push(line.slice(0, space));
  }
  return tokens;
}

/**
 * Whether the tokeniser may use a piece: the letters A to Z, the apostrophe,
 * and the hyphen, with the boundary marker at most in front. The boundary
 * marker alone is one.
 */
function isCandidate(text: string): boolean {
  return /^\u2581?[A-Z'-]*$/.test(text) && text.length > 0;
}

// -- Searching for the best split ------------------------------------------

/** Each character a candidate piece can hold, numbered for the trie. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ'-" + BOUNDARY;

function alphabetIndex(code: number): number {
  if (code >= 65 && code <= 90) {
    return code - 65;
  }
  return ALPHABET.indexOf(String.fromCharCode(code), 26);
}

/** A trie of the candidate pieces: a node per prefix, with the score of the piece that ends there. */
interface TrieNode {
  children: Array<TrieNode | undefined>;
  score: number | undefined;
}

function trieNode(): TrieNode {
  return { children: new Array<TrieNode | undefined>(ALPHABET.length), score: undefined };
}

/**
 * The search, exactly. A text's words, each with the boundary marker in
 * front, are joined into one string, and every position in it keeps the best
 * split of the text before it: that split's score and where its last piece
 * starts. Positions are visited from the start, and every candidate piece
 * that starts at a reachable position extends that position's split to where
 * the piece ends:
 *
 * - the candidate's score is the start's score plus the piece's score, in
 *   double precision, which holds the sum of two 32-bit floats exactly;
 * - it replaces the split kept at the end only when it is greater than the
 *   score kept there, so of two equal candidates the one from the earlier
 *   start, with the longer last piece, stays;
 * - the score kept is the candidate's, rounded to a 32-bit float.
 *
 * The rounding is why the whole text is one search: the score kept at a word
 * boundary carries the words before it, and splits whose sums are equal, as
 * a run of a letter whose doubled form is a piece gives, are told apart by
 * how the sums before them were rounded.
 */
function search(root: TrieNode, text: string): string[] | null {
  const words = text.split(" ").filter((word) => word.length > 0);
  if (words.length === 0) {
    return [];
  }
  const joined = BOUNDARY + words.join(BOUNDARY);
  const length = joined.length;
  const best = new Float64Array(length + 1).fill(-Infinity);
  const lastStart = new Int32Array(length + 1).fill(-1);
  best[0] = 0;
  for (let start = 0; start < length; start++) {
    const before = best[start];
    if (before === -Infinity) {
      continue;
    }
    let node: TrieNode | undefined = root;
    for (let end = start; end < length && node; end++) {
      const index = alphabetIndex(joined.charCodeAt(end));
      node = index === -1 ? undefined : node.children[index];
      if (node?.score === undefined) {
        continue;
      }
      const score = before + node.score;
      if (score > best[end + 1]) {
        best[end + 1] = Math.fround(score);
        lastStart[end + 1] = start;
      }
    }
  }
  if (lastStart[length] === -1) {
    return null;
  }
  const pieces: string[] = [];
  for (let end = length; end > 0; end = lastStart[end]) {
    pieces.push(joined.slice(lastStart[end], end));
  }
  return pieces.reverse();
}

/** What `read` returns; what it throws is rethrown with the file's name in front. */
function readingFile<T>(file: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * The tokeniser for a model's bpe.model and tokens.txt. Throws, saying why,
 * when either file cannot be read as described above, when the model's
 * pieces are not the token table's tokens in the same order, or when a piece
 * the tokeniser would use is marked as a special token or has a score that is
 * not a number.
 */
export function parseTokeniser(model: Buffer, tokensTxt: string): Tokeniser {
  const tokens = readingFile(TOKENS_FILE, () => parseTokenTable(tokensTxt));
  const pieces = readingFile(TOKENISER_MODEL_FILE, () => readPieces(model));
  const mismatch = `${TOKENISER_MODEL_FILE} does not match ${TOKENS_FILE}`;
  if (pieces.length !== tokens.length) {
    throw new Error(`${mismatch}: it has ${pieces.length} pieces and the token table ${tokens.length} tokens`);
  }
  const root = trieNode();
  const scores = new Map<string, number>();
  pieces.forEach((piece, id) => {
    const named = `piece ${id}, ${JSON.stringify(piece.text)}`;
    if (piece.text !== tokens[id]) {
      throw new Error(
        `${mismatch}: piece ${id} is ${JSON.stringify(piece.text)}, token ${id} ${JSON.stringify(tokens[id])}`
      );
    }
    if (!isCandidate(piece.text)) {
      return;
    }
    if (piece.kind !== undefined) {
      throw new Error(`${TOKENISER_MODEL_FILE}: ${named}, is marked as a special token`);
    }
    if (!Number.isFinite(piece.score)) {
      throw new Error(`${TOKENISER_MODEL_FILE}: ${named}, has the score ${piece.score}`);
    }
    let node = root;
    for (const character of piece.text) {
      const index = alphabetIndex(character.charCodeAt(0));
      node = node.children[index] ??= trieNode();
    }
    node.score = piece.score;
    scores.set(piece.text, piece.score);
  });
  return { vocabulary: new Set(tokens), scores, encode: (text) => search(root, text) };
}

// -- Loading ----------------------------------------------------------------

/** The tokeniser for each model directory, read once. */
const loaded = new Map<string, Promise<Tokeniser>>();

async function readTokeniser(modelDir: string): Promise<Tokeniser> {
  const modelFile = path.join(modelDir, TOKENISER_MODEL_FILE);
  const tokensFile = path.join(modelDir, TOKENS_FILE);
  const [model, tokensTxt] = await Promise.all([readFile(modelFile), readFile(tokensFile, "utf8")]);
  try {
    return parseTokeniser(model, tokensTxt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`the model in ${modelDir} cannot be used: ${reason}`, { cause: error });
  }
}

/**
 * The tokeniser for the model in `modelDir`. The files are read and parsed
 * on the first call for a directory, and the result is kept for every later
 * one; a load that fails is not kept, so the next call reads the files again.
 */
export function loadTokeniser(modelDir: string): Promise<Tokeniser> {
  let entry = loaded.get(modelDir);
  if (!entry) {
    const reading = readTokeniser(modelDir);
    loaded.set(modelDir, reading);
    reading.catch(() => {
      if (loaded.get(modelDir) === reading) {
        loaded.delete(modelDir);
      }
    });
    entry = reading;
  }
  return entry;
}
