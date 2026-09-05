import { describe, expect, it } from 'vitest';
import {
  clampKeywordThreshold,
  drainLines,
  parseControlLine,
  resolveAudioDevice,
  withAudioDevice,
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
    expect(result.config.audioDevice).toBeUndefined();
  });

  it('passes audioDevice through from the config line as sent', () => {
    const line = JSON.stringify({
      phrases: [{ phrase: 'hey claude', label: 'Claude' }],
      threshold: 0.3,
      modelDir: 'x',
      debugMode: false,
      audioDevice: 'Blue Yeti',
    });
    expect(parseControlLine(line).config.audioDevice).toBe('Blue Yeti');
  });

  it('passes a numeric-string audioDevice through untouched', () => {
    // Index resolution is resolveAudioDevice's job, not the parser's.
    const line = JSON.stringify({ audioDevice: '1' });
    expect(parseControlLine(line).config.audioDevice).toBe('1');
  });
});

/**
 * wakeWord.audioDevice is a string setting; decibri's `device` option is a
 * number (index) or a string (case-insensitive name substring).
 */
describe('resolveAudioDevice', () => {
  it('means the system default when empty or blank', () => {
    expect(resolveAudioDevice('')).toBeUndefined();
    expect(resolveAudioDevice('   ')).toBeUndefined();
    expect(resolveAudioDevice('\t\n')).toBeUndefined();
  });

  it('means the system default when absent or not a string', () => {
    expect(resolveAudioDevice(undefined)).toBeUndefined();
    expect(resolveAudioDevice(null)).toBeUndefined();
    expect(resolveAudioDevice(false)).toBeUndefined();
    expect(resolveAudioDevice({})).toBeUndefined();
    expect(resolveAudioDevice([])).toBeUndefined();
  });

  it('passes a name substring through as a string', () => {
    expect(resolveAudioDevice('USB')).toBe('USB');
    expect(resolveAudioDevice('Blue Yeti')).toBe('Blue Yeti');
  });

  it('keeps the case as typed and leaves the matching to decibri', () => {
    expect(resolveAudioDevice('usb')).toBe('usb');
  });

  it('trims surrounding whitespace from a name', () => {
    expect(resolveAudioDevice('  Blue Yeti  ')).toBe('Blue Yeti');
  });

  it('parses a digit-only string as a device index', () => {
    expect(resolveAudioDevice('0')).toBe(0);
    expect(resolveAudioDevice('1')).toBe(1);
    expect(resolveAudioDevice(' 12 ')).toBe(12);
  });

  it('does not read a name that merely starts with digits as an index', () => {
    // parseInt would turn "2nd mic" into index 2 and open the wrong device.
    expect(resolveAudioDevice('2nd mic')).toBe('2nd mic');
    expect(resolveAudioDevice('1 USB')).toBe('1 USB');
    expect(resolveAudioDevice('3.5mm jack')).toBe('3.5mm jack');
  });

  it('accepts a non-negative integer that arrived as a number', () => {
    // settings.json is not schema-validated, so a bare number can reach the
    // child if the extension ever stops coercing it.
    expect(resolveAudioDevice(0)).toBe(0);
    expect(resolveAudioDevice(2)).toBe(2);
  });

  it('rejects a negative, fractional, or non-finite number', () => {
    expect(resolveAudioDevice(-1)).toBeUndefined();
    expect(resolveAudioDevice(1.5)).toBeUndefined();
    expect(resolveAudioDevice(NaN)).toBeUndefined();
    expect(resolveAudioDevice(Infinity)).toBeUndefined();
  });
});

describe('withAudioDevice', () => {
  const base = Object.freeze({
    sampleRate: 16000,
    channels: 1,
    vad: 'silero',
    dcRemoval: true,
    highpass: 80,
    agc: -18,
  });

  it('omits the device key entirely when no device is configured', () => {
    for (const none of ['', '   ', undefined, null]) {
      const options = withAudioDevice(base, none);
      expect(options).toEqual(base);
      expect('device' in options).toBe(false);
    }
  });

  it('adds a name substring as device', () => {
    expect(withAudioDevice(base, 'USB')).toEqual({ ...base, device: 'USB' });
  });

  it('adds a digit-only string as a numeric index', () => {
    expect(withAudioDevice(base, '1')).toEqual({ ...base, device: 1 });
  });

  it('keeps the conditioning chain intact alongside the device', () => {
    const options = withAudioDevice(base, 'Blue Yeti');
    expect(options.vad).toBe('silero');
    expect(options.dcRemoval).toBe(true);
    expect(options.highpass).toBe(80);
    expect(options.agc).toBe(-18);
    expect(options.sampleRate).toBe(16000);
    expect(options.channels).toBe(1);
  });

  it('does not mutate the options it was given', () => {
    const input = { ...base };
    withAudioDevice(input, 'USB');
    expect(input).toEqual(base);
    expect('device' in input).toBe(false);
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
