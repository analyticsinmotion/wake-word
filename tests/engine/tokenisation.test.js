import { describe, expect, it } from 'vitest';
import {
  WORD_BOUNDARY,
  buildKeywordSpec,
  decodePieces,
} from '../../engine/lib/keywords.js';

const B = WORD_BOUNDARY;

/**
 * A stand-in for SentencePieceProcessor.encodePieces that splits on spaces,
 * marks each word boundary the way the real BPE model does, and breaks longer
 * words into two pieces. The round trip (encode, then decode the pieces) is
 * what has to agree with the string sherpa-onnx reports on a hit, so the shape
 * of the pieces matters more than the exact vocabulary.
 *
 *   "HEY CLAUDE" -> ["<B>HE", "Y", "<B>CL", "AUDE"]
 */
function fakeEncodePieces(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => {
      const head = B + word.slice(0, 2);
      const tail = word.slice(2);
      return tail ? [head, tail] : [head];
    });
}

describe('decodePieces', () => {
  it('turns the boundary marker back into a space', () => {
    expect(decodePieces([B + 'HEY', B + 'CLAUDE'])).toBe('HEY CLAUDE');
  });

  it('joins sub-word pieces without a space', () => {
    expect(decodePieces([B + 'CL', 'AU', 'DE'])).toBe('CLAUDE');
  });

  it('trims the leading boundary of the first piece', () => {
    expect(decodePieces([B + 'COMPUTER'])).toBe('COMPUTER');
  });

  it('returns an empty string for no pieces', () => {
    expect(decodePieces([])).toBe('');
  });

  it('handles pieces with no boundary marker at all', () => {
    expect(decodePieces(['HE', 'Y'])).toBe('HEY');
  });

  it('round-trips a multi-word phrase through the fake tokeniser', () => {
    expect(decodePieces(fakeEncodePieces('HEY CLAUDE'))).toBe('HEY CLAUDE');
    expect(decodePieces(fakeEncodePieces('COMPUTER'))).toBe('COMPUTER');
    expect(decodePieces(fakeEncodePieces('  HEY   COPILOT  '))).toBe('HEY COPILOT');
  });
});

describe('buildKeywordSpec', () => {
  it('maps the decoded keyword back to the spoken phrase', () => {
    const spec = buildKeywordSpec(
      [{ phrase: 'Hey Claude', label: 'Claude' }],
      fakeEncodePieces
    );
    // sherpa-onnx reports the decoded form; the map turns it back into what
    // the routing table matches on.
    expect(spec.phraseMap['HEY CLAUDE']).toBe('hey claude');
  });

  it('emits one keyword line per phrase', () => {
    const spec = buildKeywordSpec(
      [
        { phrase: 'hey claude', label: 'Claude' },
        { phrase: 'computer', label: 'Terminal' },
      ],
      fakeEncodePieces
    );
    expect(spec.keywordLines).toHaveLength(2);
    expect(spec.keywords.split('\n')).toHaveLength(2);
  });

  it('expands an alias array into one line each', () => {
    const spec = buildKeywordSpec(
      [{ phrase: ['hey claude', 'open claude'], label: 'Claude' }],
      fakeEncodePieces
    );
    expect(spec.keywordLines).toHaveLength(2);
    expect(spec.phraseMap['HEY CLAUDE']).toBe('hey claude');
    expect(spec.phraseMap['OPEN CLAUDE']).toBe('open claude');
  });

  it('tokenises the uppercased phrase but maps back to lowercase', () => {
    const spec = buildKeywordSpec(
      [{ phrase: '  Hey CLAUDE  ', label: 'Claude' }],
      fakeEncodePieces
    );
    expect(Object.keys(spec.phraseMap)).toEqual(['HEY CLAUDE']);
    expect(spec.phraseMap['HEY CLAUDE']).toBe('hey claude');
  });

  it('writes keyword lines as space-separated pieces', () => {
    const spec = buildKeywordSpec([{ phrase: 'hey', label: 'X' }], fakeEncodePieces);
    expect(spec.keywordLines).toEqual([B + 'HE Y']);
    expect(spec.keywords).toBe(B + 'HE Y');
  });

  it('separates keyword lines with a newline, as sherpa-onnx expects', () => {
    const spec = buildKeywordSpec(
      [
        { phrase: 'hey', label: 'A' },
        { phrase: 'yo', label: 'B' },
      ],
      fakeEncodePieces
    );
    expect(spec.keywords).toBe(B + 'HE Y' + '\n' + B + 'YO');
  });

  it('skips blank phrases', () => {
    const spec = buildKeywordSpec(
      [{ phrase: ['hey claude', '', '   '], label: 'Claude' }],
      fakeEncodePieces
    );
    expect(spec.keywordLines).toHaveLength(1);
  });

  it('skips non-string phrases instead of throwing', () => {
    const spec = buildKeywordSpec(
      [{ phrase: ['hey claude', 42, null], label: 'Claude' }, null, undefined],
      fakeEncodePieces
    );
    expect(spec.keywordLines).toHaveLength(1);
    expect(spec.phraseMap['HEY CLAUDE']).toBe('hey claude');
  });

  it('returns an empty spec for no phrases, which the engine reports as fatal', () => {
    for (const input of [[], null, undefined]) {
      const spec = buildKeywordSpec(input, fakeEncodePieces);
      expect(spec.keywordLines).toHaveLength(0);
      expect(spec.keywords).toBe('');
      expect(spec.phraseMap).toEqual({});
    }
  });

  it('reports the tokenisation of each phrase for the debug log', () => {
    const spec = buildKeywordSpec(
      [{ phrase: 'hey claude', label: 'Claude' }],
      fakeEncodePieces
    );
    expect(spec.details).toEqual([
      {
        phrase: 'hey claude',
        tokens: spec.keywordLines[0],
        decoded: 'HEY CLAUDE',
      },
    ]);
  });

  it('drops a phrase whose tokenisation decodes to nothing', () => {
    const spec = buildKeywordSpec([{ phrase: 'hey claude', label: 'Claude' }], () => []);
    expect(spec.keywordLines).toHaveLength(0);
  });

  it('collapses case-different duplicates onto one map entry', () => {
    // Two routes listening for the same words still produce two keyword lines
    // (harmless: sherpa-onnx accepts the repeat) but only one lookup key, so
    // the first route configured is the one that fires.
    const spec = buildKeywordSpec(
      [
        { phrase: 'hey claude', label: 'Claude' },
        { phrase: 'HEY CLAUDE', label: 'Claude Again' },
      ],
      fakeEncodePieces
    );
    expect(Object.keys(spec.phraseMap)).toEqual(['HEY CLAUDE']);
    expect(spec.phraseMap['HEY CLAUDE']).toBe('hey claude');
    expect(spec.keywordLines).toHaveLength(2);
  });

  it('keeps every decoded key reachable from the spotter output', () => {
    const spec = buildKeywordSpec(
      [
        { phrase: 'hey claude', label: 'Claude' },
        { phrase: 'hey copilot', label: 'Copilot' },
        { phrase: 'computer', label: 'Terminal' },
      ],
      fakeEncodePieces
    );
    for (const line of spec.keywordLines) {
      const decoded = decodePieces(line.split(' '));
      expect(spec.phraseMap[decoded]).toBeDefined();
    }
  });
});
