'use strict';

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
function buildKeywordSpec(phrases, encodePieces) {
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
        keywordLines.push(tokenStr);
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
