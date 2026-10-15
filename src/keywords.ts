import { clampThreshold, cleanUpPhrase } from "./wakeWordCore";

/**
 * Keyword lines for the sherpa-onnx keyword spotter, and the way back from
 * what it reports to the phrase the user configured.
 *
 * The spotter does not take plain text: each phrase reaches it as the
 * model's pieces for the phrase as cleanUpPhrase() leaves it, followed by two
 * fields the spotter parses off the end of the line:
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
 * search over piece scores, not by merge rules. tokeniser.ts reads the scores
 * and runs that search.
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
  /**
   * What stopped it: the first run of characters cleanUpPhrase() does not
   * allow, or a piece that is not in the model's token table. Empty for a
   * phrase of punctuation alone.
   */
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
  /** Phrases dropped because the model's pieces cannot spell them. */
  skipped: SkippedPhrase[];
}

/**
 * Every phrase string the keyword builder uses. Non-string and blank phrases
 * are left out. Each one carries its route's `confidenceThreshold` as
 * configured, so every alias of a route gets that route's threshold.
 */
function* phraseStrings(
  phrases: readonly (PhraseSource | null | undefined)[] | null | undefined
): Generator<{ phrase: string; threshold: unknown }> {
  for (const p of phrases || []) {
    if (!p) {
      continue;
    }
    const raw = Array.isArray(p.phrase) ? p.phrase : [p.phrase];
    for (const r of raw) {
      if (typeof r !== "string" || r.trim().length === 0) {
        continue;
      }
      yield { phrase: r, threshold: p.confidenceThreshold };
    }
  }
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
 * Each phrase is cleaned up by cleanUpPhrase(), and `encodePieces`, the
 * tokeniser, turns the result into pieces, or null when no split into pieces
 * covers it. `threshold` is the global wakeWord.confidenceThreshold setting,
 * written as the trigger threshold of every line whose route did not set a
 * `confidenceThreshold` of its own. Both values go through the same clamp,
 * the route's falling back to the global one, so a missing or unusable value
 * gives a threshold in range rather than a line sherpa-onnx cannot parse.
 *
 * Non-string and blank phrases are skipped rather than thrown on:
 * wakeWord.routes is user-edited JSON and a bad entry must not take the engine
 * down before the microphone ever opens. For the same reason a phrase the
 * clean-up rules refuse, a phrase the tokeniser cannot split, and, when
 * `vocabulary` is given, a phrase with a piece that is not in it are skipped
 * and listed in `skipped`: the spotter looks every piece up in the model's
 * token table, and the native library ends the process on one it does not
 * have. An empty result is for the caller to refuse.
 *
 * The phrase as configured stays the phrase's identity: it is what `skipped`
 * and `details` name, and the phrase map's values are it, lower-cased and
 * trimmed, which is how a detection is matched back to its route.
 */
export function buildKeywordSpec(
  phrases: readonly (PhraseSource | null | undefined)[] | null | undefined,
  encodePieces: (text: string) => readonly string[] | null,
  threshold?: unknown,
  vocabulary?: ReadonlySet<string>
): KeywordSpec {
  const globalTrigger = clampThreshold(threshold);
  const phraseMap: Record<string, string> = {};
  const keywordLines: string[] = [];
  const details: KeywordDetail[] = [];
  const skipped: SkippedPhrase[] = [];

  for (const { phrase, threshold: routeThreshold } of phraseStrings(phrases)) {
    const cleaned = cleanUpPhrase(phrase);
    if ("unusable" in cleaned) {
      skipped.push({ phrase, piece: cleaned.unusable });
      continue;
    }
    const tokens = encodePieces(cleaned.text);
    if (tokens === null) {
      skipped.push({ phrase, piece: cleaned.text });
      continue;
    }
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
 * Characters as a message shows them: a control character, a format
 * character such as a zero-width space, a separator, or a mark is written as
 * its code point, U+XXXX, since it would not be seen between quotes.
 */
function visible(text: string): string {
  return [...text]
    .map((character) =>
      /[\p{C}\p{Z}\p{M}]/u.test(character)
        ? "U+" + (character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")
        : character
    )
    .join("");
}

/**
 * The log line for a phrase left out of the keyword lines. The model's pieces
 * spell the letters A to Z, the apostrophe, and the hyphen; digits, letters
 * of other alphabets, and other symbols are not in its token table.
 */
export function skippedPhraseWarning(skipped: SkippedPhrase): string {
  const reason = skipped.piece
    ? `"${visible(skipped.piece)}" is not in the speech model's vocabulary`
    : "it has no words, only punctuation";
  return (
    `Phrase "${skipped.phrase}" skipped: ${reason}. ` +
    "Phrases can use the letters A to Z, apostrophes, and hyphens; write numbers as words."
  );
}
