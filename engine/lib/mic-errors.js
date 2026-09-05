'use strict';

const SETTING = 'wakeWord.audioDevice';

/**
 * Map decibri's typed errors to something a user can act on.
 *
 * decibri 5.x raises DecibriError subclasses (DeviceError, OrtError,
 * OrtPathError) each carrying a stable `code`. Anything unrecognised falls
 * back to the raw message under the caller's prefix.
 *
 * `device` is the value of `wakeWord.audioDevice` when the user configured
 * one. A lookup failure then names the setting and the value: "no microphone
 * found" is the wrong diagnosis on a machine with three microphones where the
 * name simply did not match any of them.
 */
function micErrorMessage(err, fallbackPrefix, device) {
  const code = err && err.code;
  const message = (err && err.message) || String(err);
  const chosen = device === undefined || device === null ? '' : String(device).trim();

  // An index past the end of the device list is a plain RangeError from
  // decibri's JS wrapper, with no code to switch on.
  if (chosen && typeof message === 'string' && message.startsWith('device index out of range')) {
    return (
      'Microphone index ' + chosen + ' is out of range. ' +
      'Check ' + SETTING + ' against the input devices on this machine.'
    );
  }

  switch (code) {
    case 'MICROPHONE_NOT_FOUND':
      if (chosen) {
        return (
          'No microphone matching "' + chosen + '" was found. ' +
          'Check ' + SETTING + ' against the input devices on this machine.'
        );
      }
      return 'No microphone found. Check your audio device settings.';
    case 'NO_MICROPHONE_FOUND':
      return 'No microphone found. Check your audio device settings.';
    case 'MULTIPLE_DEVICES_MATCH':
      return (
        'More than one microphone matches "' + (chosen || 'the requested name') + '". ' +
        'Use a longer name or the device index in ' + SETTING + '.'
      );
    case 'NOT_AN_INPUT_DEVICE':
      if (chosen) {
        return 'The audio device "' + chosen + '" is not a microphone. Check ' + SETTING + '.';
      }
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
