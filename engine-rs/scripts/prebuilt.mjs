#!/usr/bin/env node
/**
 * The sherpa-onnx prebuilt static libraries, checked on the way into the build
 * and again after it.
 *
 * The engine links the archives scripts/pinned-inputs.mjs pins: the
 * sherpa-onnx release built without the text-to-speech components, hosted on
 * this repository's releases, from where this script downloads them. The
 * sherpa-onnx-sys build script unpacks one archive per target under
 * target/sherpa-onnx-prebuilt/, with no digest check, and left to itself it
 * downloads the official archive from the sherpa-onnx release. Pointing
 * SHERPA_ONNX_ARCHIVE_DIR at a directory holding the archive makes it copy
 * that file instead, so the build links exactly the file this script verified.
 *
 *   node engine-rs/scripts/prebuilt.mjs name  --target <target>
 *       Print name=<archive> and sha256=<digest> lines, for a cache key.
 *   node engine-rs/scripts/prebuilt.mjs fetch --target <target> --dir <dir>
 *       Put the archive in <dir>, downloading it if it is not there, and fail
 *       unless it matches its pinned size and SHA-256.
 *   node engine-rs/scripts/prebuilt.mjs check --target <target> [--target-dir <dir>]
 *       After the build, fail unless the archive the build script unpacked
 *       matches too. The build script uses an already unpacked directory
 *       without looking at the archive, so this is what proves that the
 *       libraries linked came from the verified file. <dir> defaults to
 *       CARGO_TARGET_DIR, then engine-rs/target.
 *
 * <target> is the extension's package target: win32-x64, darwin-arm64,
 * linux-x64, or linux-arm64. Exits 1 on any mismatch.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { checkFile, downloadFile } from './download.mjs';
import { SHERPA_ONNX, sherpaOnnxArchiveUrl, TARGETS } from './pinned-inputs.mjs';

const ENGINE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** The sherpa-onnx-sys version Cargo.lock resolves. */
function lockedSysVersion() {
  const lock = readFileSync(path.join(ENGINE_DIR, 'Cargo.lock'), 'utf8');
  const match = /name = "sherpa-onnx-sys"\r?\nversion = "([^"]+)"/.exec(lock);
  if (!match) {
    throw new Error('Cargo.lock has no sherpa-onnx-sys package');
  }
  return match[1];
}

function archiveFor(target) {
  if (!TARGETS.includes(target)) {
    throw new Error(`unknown target "${target}"; expected one of ${TARGETS.join(', ')}`);
  }
  const locked = lockedSysVersion();
  if (locked !== SHERPA_ONNX.version) {
    throw new Error(
      `Cargo.lock builds sherpa-onnx-sys ${locked}, but the archive digests in ` +
        `scripts/pinned-inputs.mjs are for ${SHERPA_ONNX.version}. Pin the new ` +
        'archives before building with it.'
    );
  }
  return SHERPA_ONNX.archives[target];
}

async function fetchArchive(archive, dir) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, archive.name);
  if (existsSync(file)) {
    // A copy restored from a cache is checked like a fresh download. A
    // mismatch fails rather than downloading again: the cache is written only
    // after a verified download, so a bad copy there means something has gone
    // wrong that someone needs to look at.
    await checkFile(file, archive, file);
    console.log(`${archive.name}: cached copy verified, SHA-256 ${archive.sha256}`);
    return;
  }
  await downloadFile(sherpaOnnxArchiveUrl(archive.name), file, archive);
}

async function checkUnpacked(archive, targetDir) {
  const file = path.join(targetDir, 'sherpa-onnx-prebuilt', archive.name);
  if (!existsSync(file)) {
    throw new Error(
      `${file} does not exist, so the libraries the build linked cannot be traced ` +
        'to a verified archive. Build from a clean target directory with ' +
        'SHERPA_ONNX_ARCHIVE_DIR set.'
    );
  }
  await checkFile(file, archive, file);
  console.log(`${archive.name}: the archive the build unpacked is verified, SHA-256 ${archive.sha256}`);
}

async function main() {
  const [command] = process.argv.slice(2);
  const target = option('--target');
  const archive = archiveFor(target);

  switch (command) {
    case 'name':
      console.log(`name=${archive.name}`);
      console.log(`sha256=${archive.sha256}`);
      break;
    case 'fetch': {
      const dir = option('--dir');
      if (!dir) throw new Error('fetch needs --dir <dir>');
      await fetchArchive(archive, path.resolve(dir));
      break;
    }
    case 'check': {
      const targetDir =
        option('--target-dir') ?? process.env.CARGO_TARGET_DIR ?? path.join(ENGINE_DIR, 'target');
      await checkUnpacked(archive, path.resolve(targetDir));
      break;
    }
    default:
      throw new Error(`unknown command "${command}"; expected name, fetch, or check`);
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
