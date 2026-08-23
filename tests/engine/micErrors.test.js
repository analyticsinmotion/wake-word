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
