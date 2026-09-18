#!/usr/bin/env node
/**
 * Download the keyword spotting model the extension downloads, verify it, and
 * extract it, for tests that need the real model.
 *
 *   node scripts/fetch-model.mjs --print-sha
 *       Print sha256=<digest> of the pinned archive, for a cache key.
 *   node scripts/fetch-model.mjs --dir <dir>
 *       Put the archive in <dir> (downloading it if it is not there), check
 *       it against MODEL_SHA256, extract it there, and print the model
 *       directory as model-dir=<path>.
 *
 * The URL, the digest, and the directory name are read from
 * src/sherpaEngine.ts, and extraction is the extension's own, from
 * dist/tarExtract.js, so run `npm run compile` first. What the tests load is
 * then exactly what the extension installs.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkFile, downloadFile } from '../engine-rs/scripts/download.mjs';

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** MODEL_NAME, MODEL_URL, and MODEL_SHA256 as src/sherpaEngine.ts defines them. */
function modelConstants() {
  const source = readFileSync(path.join(REPO_DIR, 'src', 'sherpaEngine.ts'), 'utf8');
  const name = /export const MODEL_NAME = "([^"]+)";/.exec(source)?.[1];
  const url = /export const MODEL_URL =\s*"([^"]+)"\s*\+\s*MODEL_NAME\s*\+\s*"([^"]+)";/.exec(source);
  const sha256 = /export const MODEL_SHA256 =\s*"([0-9a-f]{64})";/.exec(source)?.[1];
  const bytes = /SHA-256 of the model archive at MODEL_URL \(([\d,]+) bytes\)/.exec(source)?.[1];
  if (!name || !url || !sha256 || !bytes) {
    throw new Error(
      'could not read MODEL_NAME, MODEL_URL, MODEL_SHA256, and the archive size from ' +
        'src/sherpaEngine.ts; update this script to match it'
    );
  }
  return {
    name,
    url: url[1] + name + url[2],
    pin: { sha256, bytes: Number(bytes.replaceAll(',', '')) },
  };
}

async function main() {
  const model = modelConstants();
  if (process.argv.includes('--print-sha')) {
    console.log(`sha256=${model.pin.sha256}`);
    return;
  }
  const index = process.argv.indexOf('--dir');
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error('usage: fetch-model.mjs --print-sha | --dir <dir>');
  }
  const dir = path.resolve(process.argv[index + 1]);
  mkdirSync(dir, { recursive: true });

  const archive = path.join(dir, `${model.name}.tar.gz`);
  if (existsSync(archive)) {
    await checkFile(archive, model.pin, archive);
    console.log(`${path.basename(archive)}: cached copy verified`);
  } else {
    await downloadFile(model.url, archive, model.pin);
  }

  const extractor = path.join(REPO_DIR, 'dist', 'tarExtract.js');
  if (!existsSync(extractor)) {
    throw new Error(`${extractor} does not exist; run "npm run compile" first`);
  }
  const { extractTarGz } = await import(pathToFileURL(extractor).href);
  const modelDir = path.join(dir, model.name);
  rmSync(modelDir, { recursive: true, force: true });
  await extractTarGz(archive, dir);
  console.log(`model-dir=${modelDir}`);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
