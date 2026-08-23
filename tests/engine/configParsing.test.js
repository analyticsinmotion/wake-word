import { describe, expect, it } from 'vitest';
import {
  clampKeywordThreshold,
  drainLines,
  parseControlLine,
} from '../../engine/lib/control.js';

/**
 * Node delivers stdin in chunks, not lines. The reader used to handle only the
 * first line of a chunk, so a "stop" that arrived behind anything else was
 * silently dropped and the child kept running with the microphone open.
 */
describe('drainLines', () => {
  it('returns a single complete line', () => {
    expect(drainLines('stop\n')).toEqual({ lines: ['stop'], rest: '' });
  });

  it('returns every complete line in one chunk', () => {
    expect(drainLines('\nstop\n')).toEqual({ lines: ['', 'stop'], rest: '' });
  });

  it('returns a config line and a stop that arrived together', () => {
    expect(drainLines('{"a":1}\nstop\n').lines).toEqual(['{"a":1}', 'stop']);
  });

  it('keeps a trailing partial line for the next chunk', () => {
    expect(drainLines('stop\n{"a":')).toEqual({ lines: ['stop'], rest: '{"a":' });
  });

  it('keeps everything when the chunk holds no newline', () => {
    expect(drainLines('{"a":')).toEqual({ lines: [], rest: '{"a":' });
  });

  it('reassembles a config line split across chunks', () => {
    const first = drainLines('{"threshold":0');
    const second = drainLines(first.rest + '.3}\n');
    expect(second.lines).toEqual(['{"threshold":0.3}']);
    expect(parseControlLine(second.lines[0]).config.threshold).toBe(0.3);
  });

  it('handles an empty chunk', () => {
    expect(drainLines('')).toEqual({ lines: [], rest: '' });
    expect(drainLines(null)).toEqual({ lines: [], rest: '' });
  });
});

describe('parseControlLine', () => {
  it('parses the config JSON the extension sends on start', () => {
    const line = JSON.stringify({
      phrases: [{ phrase: 'hey claude', label: 'Claude' }],
      threshold: 0.3,
      modelDir: 'C:\\Users\\me\\models',
      debugMode: false,
    });
    const result = parseControlLine(line);
    expect(result.kind).toBe('config');
    expect(result.config.phrases).toEqual([{ phrase: 'hey claude', label: 'Claude' }]);
    expect(result.config.threshold).toBe(0.3);
    expect(result.config.modelDir).toBe('C:\\Users\\me\\models');
    expect(result.config.debugMode).toBe(false);
  });

  it('keeps an alias array intact', () => {
    const line = JSON.stringify({
      phrases: [{ phrase: ['hey claude', 'open claude'], label: 'Claude' }],
    });
    expect(parseControlLine(line).config.phrases[0].phrase).toEqual([
      'hey claude',
      'open claude',
    ]);
  });

  it('recognises the stop command', () => {
    expect(parseControlLine('stop')).toEqual({ kind: 'stop' });
  });

  it('recognises the stop command with surrounding whitespace', () => {
    expect(parseControlLine('  stop\r')).toEqual({ kind: 'stop' });
  });

  it('ignores a blank line', () => {
    expect(parseControlLine('')).toEqual({ kind: 'empty' });
    expect(parseControlLine('   ')).toEqual({ kind: 'empty' });
    expect(parseControlLine('\r')).toEqual({ kind: 'empty' });
  });

  it('ignores a missing line rather than throwing', () => {
    expect(parseControlLine(null)).toEqual({ kind: 'empty' });
    expect(parseControlLine(undefined)).toEqual({ kind: 'empty' });
  });

  it('reports malformed JSON instead of throwing', () => {
    const result = parseControlLine('{ not json');
    expect(result.kind).toBe('invalid');
    expect(result.message).toMatch(/^Invalid config JSON: /);
  });

  it('reports a truncated JSON line', () => {
    expect(parseControlLine('{"phrases":[{"phrase":"hey').kind).toBe('invalid');
  });

  it('leaves absent fields undefined for the caller to default', () => {
    const result = parseControlLine('{}');
    expect(result.kind).toBe('config');
    expect(result.config.phrases).toBeUndefined();
    expect(result.config.threshold).toBeUndefined();
    expect(result.config.modelDir).toBeUndefined();
  });
});

describe('clampKeywordThreshold', () => {
  it('passes an in-range value through', () => {
    expect(clampKeywordThreshold(0.3)).toBe(0.3);
    expect(clampKeywordThreshold(0.5)).toBe(0.5);
  });

  it('clamps to the range sherpa-onnx accepts', () => {
    expect(clampKeywordThreshold(0.01)).toBe(0.1);
    expect(clampKeywordThreshold(-1)).toBe(0.1);
    expect(clampKeywordThreshold(0.95)).toBe(0.9);
    expect(clampKeywordThreshold(100)).toBe(0.9);
  });

  it('keeps the bounds themselves', () => {
    expect(clampKeywordThreshold(0.1)).toBe(0.1);
    expect(clampKeywordThreshold(0.9)).toBe(0.9);
  });

  it('defaults when the value is missing or unusable', () => {
    expect(clampKeywordThreshold(undefined)).toBe(0.25);
    expect(clampKeywordThreshold(null)).toBe(0.25);
    expect(clampKeywordThreshold(NaN)).toBe(0.25);
    expect(clampKeywordThreshold(0)).toBe(0.25);
  });

  it('never returns a value outside the accepted range', () => {
    for (const input of [-1, 0, 0.1, 0.25, 0.9, 1, 99, NaN, undefined, null]) {
      const result = clampKeywordThreshold(input);
      expect(result).toBeGreaterThanOrEqual(0.1);
      expect(result).toBeLessThanOrEqual(0.9);
    }
  });
});
