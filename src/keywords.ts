import { clampThreshold } from "./wakeWordCore";

/**
 * Keyword lines for the sherpa-onnx keyword spotter, and the way back from
 * what it reports to the phrase the user configured.
 *
 * The spotter does not take plain text: each phrase reaches it as the
 * SentencePiece pieces for the upper-cased phrase, followed by two fields the
 * spotter parses off the end of the line:
 *
 *   ▁HE Y ▁C LA U DE :3.0 #0.05
 *
 *   :3.0  Boost score. Multiplies the likelihood of this keyword's piece
 *         sequence during decoding, biasing the spotter toward the configured
 *         phrases over other readings of the same audio. 1.0 when absent.
 *         Higher values help words the model saw little of in training, such
 *         as proper nouns, at the cost of more false triggers.
 *
 *   #<threshold>  Per-phrase trigger threshold: the acoustic probability, 0
 *         to 1, the decoded sequence must reach before the spotter reports
 *         it. It replaces the spotter's global threshold for that phrase, and
 *         every line carries one, so this is where the setting takes effect.
 *         The value is the route's own `confidenceThreshold` where it has
 *         one, otherwise the global wakeWord.confidenceThreshold setting.
 *
 * The boost and the 0.05 default were tested against the default routes on
 * Windows with the gigaspeech 3.3M model. Without boosting, uncommon words in
 * the default phrases were not reliably detected.
 *
 * The pieces come from the model's `bpe.model`. Despite the name it is a
 * SentencePiece Unigram model, not a BPE one: pieces are chosen by a best-path
 * search over piece scores, not by merge rules, so only a SentencePiece
 * implementation produces the pieces the spotter expects.
 */

/** SentencePiece marks a word boundary with U+2581 LOWER ONE EIGHTH BLOCK. */
export const WORD_BOUNDARY = "▁";

/** The boost score written on every keyword line. */
export const BOOST_SCORE = "3.0";

/**
 * A route as the keyword builder reads it: the phrase or aliases, and the
 * route's own trigger threshold if it set one. Both are `unknown` because
 * they come from user-edited JSON; buildKeywordSpec() skips what it cannot
 * use rather than throwing.
 */
export interface PhraseSource {
  phrase?: unknown;
  confidenceThreshold?: unknown;
}

/** How one phrase was tokenised, for the debug log. */
export interface KeywordDetail {
  /** The phrase as configured. */
  phrase: string;
  /** Its pieces, space separated, without the boost and threshold fields. */
  tokens: string;
  /** What the spotter reports when it hears the phrase. */
  decoded: string;
}

/** A phrase left out because the spotter could not take it. */
export interface SkippedPhrase {
  /** The phrase as configured. */
  phrase: string;
  /** The first of its pieces that is not in the model's token table. */
  piece: string;
}

export interface KeywordSpec {
  /**
   * Decoded keyword to the phrase as configured, lower-cased and trimmed.
   *
   * A plain object, as in the engine, so phrases that decode alike follow
   * JavaScript's object semantics: the later phrase takes the entry, and the
   * entry keeps the place the first one gave it.
   */
  phraseMap: Record<string, string>;
  /** One line per usable phrase, pieces then the boost and the threshold. */
  keywordLines: string[];
  /** The lines as the spotter takes them, newline separated. */
  keywords: string;
  details: KeywordDetail[];
  /** Phrases dropped because a piece is not in the token table. */
  skipped: SkippedPhrase[];
}

/**
 * Every phrase string the keyword builder uses, with the text it tokenises:
 * upper-cased and trimmed. Non-string and blank phrases are left out. Each
 * one carries its route's `confidenceThreshold` as configured, so every
 * alias of a route gets that route's threshold.
 */
function* phraseStrings(
  phrases: readonly (PhraseSource | null | undefined)[] | null | undefined
): Generator<{ phrase: string; text: string; threshold: unknown }> {
  for (const p of phrases || []) {
    if (!p) {
      continue;
    }
    const raw = Array.isArray(p.phrase) ? p.phrase : [p.phrase];
    for (const r of raw) {
      if (typeof r !== "string") {
        continue;
      }
      const text = r.toUpperCase().trim();
      if (text.length === 0) {
        continue;
      }
      yield { phrase: r, text, threshold: p.confidenceThreshold };
    }
  }
}

/**
 * The distinct texts buildKeywordSpec() asks its encoder for, in the order it
 * first asks, so they can be tokenised ahead of it in one batch.
 */
export function keywordTexts(
  phrases: readonly (PhraseSource | null | undefined)[] | null | undefined
): string[] {
  const texts = new Set<string>();
  for (const { text } of phraseStrings(phrases)) {
    texts.add(text);
  }
  return [...texts];
}

/**
 * Reverse a SentencePiece piece list back to plain text.
 *
 * sherpa-onnx reports a spotted keyword in this decoded form, so the same
 * function has to produce the lookup key when the keyword list is built:
 * encode the phrase, decode the pieces, and the round trip is what the spotter
 * will hand back on a hit.
 */
export function decodePieces(tokens: readonly string[]): string {
  return tokens
    .map((t) => (t.startsWith(WORD_BOUNDARY) ? " " + t.slice(1) : t))
    .join("")
    .trim();
}

/**
 * Build the sherpa-onnx keyword list and the decoded-to-spoken lookup map.
 *
 * `encodePieces` is the SentencePiece encoder. `threshold` is the global
 * wakeWord.confidenceThreshold setting, written as the trigger threshold of
 * every line whose route did not set a `confidenceThreshold` of its own. Both
 * values go through the same clamp, the route's falling back to the global
 * one, so a missing or unusable value gives a threshold in range rather than
 * a line sherpa-onnx cannot parse.
 *
 * Non-string and blank phrases are skipped rather than thrown on:
 * wakeWord.routes is user-edited JSON and a bad entry must not take the engine
 * down before the microphone ever opens. For the same reason, when
 * `vocabulary` is given, a phrase with a piece that is not in it is skipped
 * and listed in `skipped`: the spotter looks every piece up in the model's
 * token table, and the native library ends the process on one it does not
 * have. An empty result is for the caller to refuse.
 */
export function buildKeywordSpec(
  phrases: readonly (PhraseSource | null | undefined)[] | null | undefined,
  encodePieces: (text: string) => string[],
  threshold?: unknown,
  vocabulary?: ReadonlySet<string>
): KeywordSpec {
  const globalTrigger = clampThreshold(threshold);
  const phraseMap: Record<string, string> = {};
  const keywordLines: string[] = [];
  const details: KeywordDetail[] = [];
  const skipped: SkippedPhrase[] = [];

  for (const { phrase, text, threshold: routeThreshold } of phraseStrings(phrases)) {
    const tokens = encodePieces(text);
    const tokenStr = tokens.join(" ");
    const decoded = decodePieces(tokens);
    if (decoded) {
      const unknown = vocabulary ? tokens.find((piece) => !vocabulary.has(piece)) : undefined;
      if (unknown !== undefined) {
        skipped.push({ phrase, piece: unknown });
        continue;
      }
      phraseMap[decoded] = phrase.toLowerCase().trim();
      const trigger = clampThreshold(routeThreshold, globalTrigger);
      keywordLines.push(`${tokenStr} :${BOOST_SCORE} #${trigger}`);
      details.push({ phrase, tokens: tokenStr, decoded });
    }
  }

  return {
    phraseMap,
    keywordLines,
    keywords: keywordLines.join("\n"),
    details,
    skipped,
  };
}

/**
 * The log line for a phrase left out of the keyword lines. The model's pieces
 * spell the letters A to Z, the apostrophe, and the hyphen; digits, accented
 * letters, and other punctuation are not in its token table.
 */
export function skippedPhraseWarning(skipped: SkippedPhrase): string {
  return (
    `Phrase "${skipped.phrase}" skipped: "${skipped.piece}" is not in the speech model's vocabulary. ` +
    "Phrases can use the letters A to Z, apostrophes, and hyphens; write numbers as words."
  );
}

/**
 * The tokens of a model's `tokens.txt`: one `<token> <id>` pair per line.
 * The same reading as the Rust engine's, so the two agree on what a
 * spottable phrase is.
 */
export function parseVocabulary(tokensTxt: string): Set<string> {
  const vocabulary = new Set<string>();
  for (const raw of tokensTxt.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const space = line.lastIndexOf(" ");
    if (space !== -1) {
      vocabulary.add(line.slice(0, space));
    }
  }
  return vocabulary;
}
