'use strict';

const path = require('path');

/**
 * Build a path into the model directory that the sherpa-onnx package can open.
 *
 * The package is an Emscripten build. Its config validator resolves any path
 * that does not start with '/' against the WASM working directory, so a
 * Windows absolute path like C:\Users\... is never found: createKws() logs
 * "does not exist" / "Errors in config!", still returns a handle, and the
 * unusable spotter then dies with "null function or function signature
 * mismatch" on first use. Forward slashes resolve on every platform, and the
 * model directory comes from the editor's global storage, which is spelled
 * with backslashes on Windows.
 *
 * Separators are rewritten before joining, and the join is the POSIX one, so
 * the result is identical whichever platform the benchmark runs on.
 */
function modelPath(modelDir, name) {
  const posixDir = String(modelDir == null ? '' : modelDir).split('\\').join('/');
  const posixName = String(name == null ? '' : name).split('\\').join('/');
  return path.posix.join(posixDir, posixName);
}

module.exports = { modelPath };
