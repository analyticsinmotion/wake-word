import { describe, expect, it } from 'vitest';
import { micErrorMessage } from '../../engine/lib/mic-errors.js';

describe('micErrorMessage', () => {
  it('reports a missing microphone', () => {
    for (const code of ['NO_MICROPHONE_FOUND', 'MICROPHONE_NOT_FOUND']) {
      expect(micErrorMessage({ code, message: 'raw' }, 'prefix')).toBe(
        'No microphone found. Check your audio device settings.'
      );
    }
  });

  it('reports an output device selected as input', () => {
    expect(micErrorMessage({ code: 'NOT_AN_INPUT_DEVICE' }, 'prefix')).toBe(
      'The selected audio device is not a microphone. Check your audio device settings.'
    );
  });

  it('points at system privacy settings when access is denied', () => {
    expect(micErrorMessage({ code: 'PERMISSION_DENIED' }, 'prefix')).toBe(
      'Microphone access denied. Enable microphone access for VS Code in your system privacy settings.'
    );
  });

  it('keeps the underlying message for a device failure', () => {
    expect(
      micErrorMessage({ code: 'DEVICE_FAILED', message: 'stream closed' }, 'prefix')
    ).toBe('The microphone stopped responding: stream closed');
  });

  it('groups the onnxruntime and VAD load failures under one message', () => {
    const codes = [
      'ORT_INIT_FAILED',
      'ORT_LOAD_FAILED',
      'ORT_SESSION_BUILD_FAILED',
      'ORT_INFERENCE_FAILED',
      'VAD_MODEL_LOAD_FAILED',
    ];
    for (const code of codes) {
      expect(micErrorMessage({ code, message: 'silero.onnx missing' }, 'prefix')).toBe(
        'Failed to start voice activity detection: silero.onnx missing'
      );
    }
  });

  it('falls back to the caller prefix for an unknown code', () => {
    expect(
      micErrorMessage({ code: 'SOMETHING_NEW', message: 'boom' }, 'Microphone error')
    ).toBe('Microphone error: boom');
  });

  it('falls back for a plain Error with no code', () => {
    expect(micErrorMessage(new Error('boom'), 'Failed to open microphone')).toBe(
      'Failed to open microphone: boom'
    );
  });

  it('does not throw on a non-error value', () => {
    expect(micErrorMessage('just a string', 'prefix')).toBe('prefix: just a string');
    expect(micErrorMessage(null, 'prefix')).toBe('prefix: null');
    expect(micErrorMessage(undefined, 'prefix')).toBe('prefix: undefined');
  });

  it('never returns an empty message', () => {
    const inputs = [null, undefined, {}, new Error(''), { code: 'PERMISSION_DENIED' }];
    for (const input of inputs) {
      expect(micErrorMessage(input, 'prefix').length).toBeGreaterThan(0);
    }
  });
});

/**
 * With wakeWord.audioDevice set, a lookup failure has to name the setting and
 * the value. "No microphone found" is the wrong diagnosis on a machine with
 * three microphones where the name simply matched none of them.
 */
describe('micErrorMessage with a configured device', () => {
  const notFound = { code: 'MICROPHONE_NOT_FOUND', message: 'No microphone found matching "Blue Yeti"' };

  it('names the device that matched nothing', () => {
    expect(micErrorMessage(notFound, 'Failed to open microphone', 'Blue Yeti')).toBe(
      'No microphone matching "Blue Yeti" was found. ' +
        'Check wakeWord.audioDevice against the input devices on this machine.'
    );
  });

  it('keeps the generic message when no device was configured', () => {
    const generic = 'No microphone found. Check your audio device settings.';
    expect(micErrorMessage(notFound, 'prefix')).toBe(generic);
    expect(micErrorMessage(notFound, 'prefix', '')).toBe(generic);
    expect(micErrorMessage(notFound, 'prefix', '   ')).toBe(generic);
    expect(micErrorMessage(notFound, 'prefix', null)).toBe(generic);
  });

  it('names an index that is past the end of the device list', () => {
    // decibri's JS wrapper raises a plain RangeError here, with no code.
    const err = new RangeError(
      'device index out of range. Call Microphone.devices() to list available devices'
    );
    expect(micErrorMessage(err, 'Failed to open microphone', '7')).toBe(
      'Microphone index 7 is out of range. ' +
        'Check wakeWord.audioDevice against the input devices on this machine.'
    );
  });

  it('falls back to the prefix for an out-of-range index when no device was configured', () => {
    const err = new RangeError('device index out of range. Call Microphone.devices()');
    expect(micErrorMessage(err, 'Failed to open microphone')).toBe(
      'Failed to open microphone: device index out of range. Call Microphone.devices()'
    );
  });

  it('explains a name that matches more than one device', () => {
    expect(micErrorMessage({ code: 'MULTIPLE_DEVICES_MATCH' }, 'prefix', 'Mic')).toBe(
      'More than one microphone matches "Mic". ' +
        'Use a longer name or the device index in wakeWord.audioDevice.'
    );
  });

  it('still explains an ambiguous match with no device recorded', () => {
    expect(micErrorMessage({ code: 'MULTIPLE_DEVICES_MATCH' }, 'prefix')).toContain(
      'the requested name'
    );
  });

  it('names a device that is not an input', () => {
    expect(micErrorMessage({ code: 'NOT_AN_INPUT_DEVICE' }, 'prefix', 'Speakers')).toBe(
      'The audio device "Speakers" is not a microphone. Check wakeWord.audioDevice.'
    );
  });

  it('does not blame the device for a machine with no microphone at all', () => {
    expect(micErrorMessage({ code: 'NO_MICROPHONE_FOUND' }, 'prefix', 'USB')).toBe(
      'No microphone found. Check your audio device settings.'
    );
  });

  it('ignores the device for errors unrelated to selection', () => {
    expect(micErrorMessage({ code: 'PERMISSION_DENIED' }, 'prefix', 'USB')).toBe(
      'Microphone access denied. Enable microphone access for VS Code in your system privacy settings.'
    );
    expect(
      micErrorMessage({ code: 'DEVICE_FAILED', message: 'stream closed' }, 'prefix', 'USB')
    ).toBe('The microphone stopped responding: stream closed');
    expect(micErrorMessage({ code: 'SOMETHING_NEW', message: 'boom' }, 'prefix', 'USB')).toBe(
      'prefix: boom'
    );
  });

  it('trims and stringifies whatever the setting held', () => {
    expect(micErrorMessage(notFound, 'prefix', '  Blue Yeti ')).toContain('"Blue Yeti"');
    expect(micErrorMessage(notFound, 'prefix', 1)).toContain('"1"');
  });
});
