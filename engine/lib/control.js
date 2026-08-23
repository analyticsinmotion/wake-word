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

module.exports = { drainLines, parseControlLine, clampKeywordThreshold };
