#!/usr/bin/env node
/**
 * Put the keyword spotting model the package carries where the tests and the
 * engine's drive script read it, for the workflow steps that need the model.
 *
 *   node scripts/fetch-model.mjs --print-sha
 *       Print sha256=<digest> of the model's pinned files, for a cache key.
 *   node scripts/fetch-model.mjs --dir <dir>
 *       Check each of the model's files in models/ against its pinned size
 *       and SHA-256, copy them into <dir>/<model name>, and print that
 *       directory as model-dir=<path>.
 *
 * The model, its files, and their digests are read from dist/speechModel.js,
 * so run `npm run compile` first. The files are the repository's own, the
 * ones the package carries, so nothing is downloaded and what the tests load
 * is exactly what the extension ships.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** KWS_MODEL and MODELS_DIR as src/speechModel.ts defines them. */
async function bundledModel() {
  const compiled = path.join(REPO_DIR, 'dist', 'speechModel.js');
  if (!existsSync(compiled)) {
    throw new Error(`${compiled} does not exist; run "npm run compile" first`);
  }
  const { KWS_MODEL, MODELS_DIR } = await import(pathToFileURL(compiled).href);
  return { model: KWS_MODEL, dir: path.join(REPO_DIR, MODELS_DIR, KWS_MODEL.name) };
}

async function main() {
  const { model, dir } = await bundledModel();
  if (process.argv.includes('--print-sha')) {
    const pins = model.files.map((file) => `${file.name} ${file.bytes} ${file.sha256}\n`).join('');
    console.log(`sha256=${createHash('sha256').update(pins).digest('hex')}`);
    return;
  }
  const index = process.argv.indexOf('--dir');
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error('usage: fetch-model.mjs --print-sha | --dir <dir>');
  }
  const modelDir = path.join(path.resolve(process.argv[index + 1]), model.name);
  mkdirSync(modelDir, { recursive: true });

  for (const file of model.files) {
    const source = path.join(dir, file.name);
    const content = readFileSync(source);
    const digest = createHash('sha256').update(content).digest('hex');
    if (content.length !== file.bytes || digest !== file.sha256) {
      throw new Error(
        `${source} is not the pinned file: ${content.length} bytes, SHA-256 ${digest}; ` +
          `expected ${file.bytes} bytes, SHA-256 ${file.sha256}`
      );
    }
    writeFileSync(path.join(modelDir, file.name), content);
  }
  console.log(`${model.name}: ${model.files.length} files checked against their pinned digests`);
  console.log(`model-dir=${modelDir}`);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
