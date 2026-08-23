'use strict';

/**
 * Map decibri's typed errors to something a user can act on.
 *
 * decibri 5.x raises DecibriError subclasses (DeviceError, OrtError,
 * OrtPathError) each carrying a stable `code`. Anything unrecognised falls
 * back to the raw message under the caller's prefix.
 */
function micErrorMessage(err, fallbackPrefix) {
  const code = err && err.code;
  const message = (err && err.message) || String(err);

  switch (code) {
    case 'NO_MICROPHONE_FOUND':
    case 'MICROPHONE_NOT_FOUND':
      return 'No microphone found. Check your audio device settings.';
    case 'NOT_AN_INPUT_DEVICE':
      return 'The selected audio device is not a microphone. Check your audio device settings.';
    case 'PERMISSION_DENIED':
      return 'Microphone access denied. Enable microphone access for VS Code in your system privacy settings.';
    case 'DEVICE_FAILED':
      return 'The microphone stopped responding: ' + message;
    case 'ORT_INIT_FAILED':
    case 'ORT_LOAD_FAILED':
    case 'ORT_SESSION_BUILD_FAILED':
    case 'ORT_INFERENCE_FAILED':
    case 'VAD_MODEL_LOAD_FAILED':
      return 'Failed to start voice activity detection: ' + message;
    default:
      return fallbackPrefix + ': ' + message;
  }
}

module.exports = { micErrorMessage };
