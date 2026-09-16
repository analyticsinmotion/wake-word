'use strict';

const { clampKeywordThreshold } = require('./control');

/** SentencePiece marks a word boundary with U+2581 LOWER ONE EIGHTH BLOCK. */
const WORD_BOUNDARY = '▁';

/**
 * Reverse a SentencePiece piece list back to plain text.
 *
 * sherpa-onnx reports a spotted keyword in this decoded form, so the same
 * function has to produce the lookup key when the keyword list is built:
 * encode the phrase, decode the pieces, and the round trip is what the spotter
 * will hand back on a hit.
 */
function decodePieces(tokens) {
  return tokens
    .map((t) => (t.startsWith(WORD_BOUNDARY) ? ' ' + t.slice(1) : t))
    .join('')
    .trim();
}

/**
 * Build the sherpa-onnx keyword list and the decoded-to-spoken lookup map.
 *
 * @param {Array<{phrase: string|string[], label?: string}>} phrases
 * @param {(text: string) => string[]} encodePieces SentencePiece encoder
 * @param {number} [threshold] the `wakeWord.confidenceThreshold` setting,
 *   written as every line's trigger threshold. Clamped here as well, so a
 *   missing or unusable value gives the default rather than a line
 *   sherpa-onnx cannot parse.
 * @returns {{
 *   phraseMap: Object<string, string>,
 *   keywordLines: string[],
 *   keywords: string,
 *   details: Array<{phrase: string, tokens: string, decoded: string}>
 * }}
 *
 * Non-string and blank phrases are skipped rather than thrown on:
 * `wakeWord.routes` is user-edited JSON and a bad entry must not take the
 * engine down before the microphone ever opens.
 */
function buildKeywordSpec(phrases, encodePieces, threshold) {
  const trigger = clampKeywordThreshold(threshold);
  const phraseMap = {};
  const keywordLines = [];
  const details = [];

  for (const p of phrases || []) {
    if (!p) {
      continue;
    }
    const raw = Array.isArray(p.phrase) ? p.phrase : [p.phrase];
    for (const r of raw) {
      if (typeof r !== 'string') {
        continue;
      }
      const upper = r.toUpperCase().trim();
      if (upper.length === 0) {
        continue;
      }
      const tokens = encodePieces(upper);
      const tokenStr = tokens.join(' ');
      const decoded = decodePieces(tokens);
      if (decoded) {
        phraseMap[decoded] = r.toLowerCase().trim();
        // Keyword boost and trigger threshold for the sherpa-onnx spotter.
        //
        // :3.0  Boost score. Multiplies the likelihood of this keyword's
        //       token sequence during decoding, biasing the spotter toward
        //       the configured phrases over other interpretations. Range
        //       is any positive float. Default without a boost is 1.0.
        //       Higher values improve detection of uncommon words (such as
        //       proper nouns not well represented in the training data)
        //       at the cost of increased false positive risk.
        //
        // #<threshold>  Per-phrase trigger threshold, from the user's
        //       confidenceThreshold setting. The minimum acoustic
        //       probability (0 to 1) the decoded sequence must reach
        //       before the spotter reports a detection. Lower values
        //       make detection easier. The default is 0.05. A per-phrase
        //       threshold replaces the global keywordsThreshold for that
        //       phrase, so this is where the setting takes effect.
        //
        // The boost and the 0.05 default were tested against the default
        // routes on Windows with the gigaspeech 3.3M model. Without
        // boosting, uncommon words in the default phrases were not
        // reliably detected.
        keywordLines.push(`${tokenStr} :3.0 #${trigger}`);
        details.push({ phrase: r, tokens: tokenStr, decoded });
      }
    }
  }

  return {
    phraseMap,
    keywordLines,
    keywords: keywordLines.join('\n'),
    details,
  };
}

module.exports = { WORD_BOUNDARY, decodePieces, buildKeywordSpec };
