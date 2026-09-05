'use strict';

/**
 * Split a stdin chunk into every complete line it contains, returning the
 * trailing partial line so the caller can carry it into the next chunk.
 *
 * Node delivers stdin in chunks, not lines: a chunk can hold several commands
 * or none at all. Handling only the first line of a chunk loses the rest, and
 * a lost "stop" leaves the child running with the microphone open.
 */
function drainLines(buffer) {
  const lines = [];
  let rest = String(buffer == null ? '' : buffer);
  let nl = rest.indexOf('\n');

  while (nl !== -1) {
    lines.push(rest.substring(0, nl));
    rest = rest.substring(nl + 1);
    nl = rest.indexOf('\n');
  }

  return { lines, rest };
}

/**
 * Parse one line read from stdin.
 *
 * The extension sends a single JSON config line on start and the literal
 * "stop" when it wants the microphone released.
 *
 * @returns {{kind: 'stop'}
 *   | {kind: 'empty'}
 *   | {kind: 'config', config: object}
 *   | {kind: 'invalid', message: string}}
 */
function parseControlLine(line) {
  const trimmed = String(line == null ? '' : line).trim();

  if (trimmed === 'stop') {
    return { kind: 'stop' };
  }
  if (trimmed.length === 0) {
    return { kind: 'empty' };
  }

  try {
    return { kind: 'config', config: JSON.parse(trimmed) };
  } catch (e) {
    return { kind: 'invalid', message: 'Invalid config JSON: ' + e.message };
  }
}

/**
 * Clamp the keyword-spotting threshold into the range sherpa-onnx accepts.
 * Zero, NaN, and missing values fall back to 0.25.
 */
function clampKeywordThreshold(threshold) {
  return Math.max(0.1, Math.min(0.9, threshold || 0.25));
}

/**
 * Resolve the `wakeWord.audioDevice` setting into decibri's `device` option.
 *
 * decibri accepts a device index (number) or a case-insensitive substring of
 * the device name (string). The setting is a string, so a value that is
 * nothing but digits is taken as an index and anything else as a name. Only
 * a pure digit string counts: parseInt would read "2nd mic" as index 2 and
 * silently open the wrong device. Empty, blank, and non-string values mean
 * the system default, which is what decibri does when the option is absent.
 *
 * @returns {number | string | undefined}
 */
function resolveAudioDevice(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : trimmed;
}

/**
 * Copy the microphone options with `device` set when a device was chosen,
 * and without the key at all when it was not, so decibri falls back to the
 * system default rather than being handed `device: undefined`.
 */
function withAudioDevice(options, value) {
  const out = Object.assign({}, options);
  const device = resolveAudioDevice(value);
  if (device !== undefined) {
    out.device = device;
  }
  return out;
}

module.exports = {
  drainLines,
  parseControlLine,
  clampKeywordThreshold,
  resolveAudioDevice,
  withAudioDevice,
};
