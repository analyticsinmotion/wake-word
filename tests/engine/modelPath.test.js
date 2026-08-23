import { describe, expect, it } from 'vitest';
import { modelPath } from '../../engine/lib/model-path.js';

/**
 * D14. sherpa-onnx is an Emscripten build: a path that does not start with '/'
 * is resolved against the WASM working directory, so a Windows absolute path
 * with backslashes is never found. createKws() then returns a handle that dies
 * with "null function or function signature mismatch" on first use, which is
 * why the failure did not look like a path problem.
 */
describe('modelPath', () => {
  it('converts a Windows absolute path to forward slashes', () => {
    expect(modelPath('C:\\Users\\foo\\bar', 'tokens.txt')).toBe(
      'C:/Users/foo/bar/tokens.txt'
    );
  });

  it('leaves a POSIX absolute path alone', () => {
    expect(modelPath('/home/foo/bar', 'tokens.txt')).toBe('/home/foo/bar/tokens.txt');
  });

  it('normalises mixed separators', () => {
    expect(modelPath('C:\\Users/foo\\bar', 'tokens.txt')).toBe(
      'C:/Users/foo/bar/tokens.txt'
    );
  });

  it('handles a trailing separator', () => {
    expect(modelPath('C:\\Users\\foo\\', 'tokens.txt')).toBe('C:/Users/foo/tokens.txt');
    expect(modelPath('/home/foo/', 'tokens.txt')).toBe('/home/foo/tokens.txt');
  });

  it('handles an empty model directory', () => {
    expect(modelPath('', 'tokens.txt')).toBe('tokens.txt');
  });

  it('never emits a backslash, whatever the input', () => {
    const inputs = [
      'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage',
      '\\\\server\\share\\models',
      '/Users/me/Library/Application Support/Code',
      'relative\\dir',
      'relative/dir',
    ];
    for (const dir of inputs) {
      expect(modelPath(dir, 'bpe.model')).not.toContain('\\');
    }
  });

  it('produces the same result for the same logical path either way round', () => {
    expect(modelPath('C:\\models\\kws', 'encoder.onnx')).toBe(
      modelPath('C:/models/kws', 'encoder.onnx')
    );
  });

  it('covers every model file the engine opens', () => {
    const files = [
      'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      'tokens.txt',
      'bpe.model',
    ];
    const dir = 'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\sherpa-onnx';
    for (const f of files) {
      const p = modelPath(dir, f);
      expect(p).not.toContain('\\');
      expect(p.endsWith('/' + f)).toBe(true);
    }
  });
});
