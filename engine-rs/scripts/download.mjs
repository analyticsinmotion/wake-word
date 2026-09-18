/**
 * Downloading and checking the files the engine's release build depends on.
 * Node.js 22 or later; no dependencies.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, renameSync, rmSync, statSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** How many times a failed download is attempted before the build fails. */
const ATTEMPTS = 3;

/** The SHA-256 of a file, as lower-case hex. */
export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** The SHA-256 of a buffer, as lower-case hex. */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Throw unless the file at `path` has the pinned size and SHA-256. The size is
 * checked first, so a truncated download is named as such.
 */
export async function checkFile(path, { bytes, sha256: expected }, label = path) {
  const size = statSync(path).size;
  if (size !== bytes) {
    throw new Error(`${label} is ${size} bytes, expected ${bytes}`);
  }
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new Error(`${label} has SHA-256 ${actual}, expected ${expected}`);
  }
}

/** Throw unless the buffer has the pinned size and SHA-256. */
export function checkBuffer(buffer, { bytes, sha256: expected }, label) {
  if (buffer.length !== bytes) {
    throw new Error(`${label} is ${buffer.length} bytes, expected ${bytes}`);
  }
  const actual = sha256(buffer);
  if (actual !== expected) {
    throw new Error(`${label} has SHA-256 ${actual}, expected ${expected}`);
  }
}

/**
 * Throw unless the buffer matches an npm integrity value (`sha512-<base64>`),
 * the form the registry publishes for every tarball.
 */
export function checkIntegrity(buffer, integrity, label) {
  const [algorithm, expected] = integrity.split('-', 2);
  const actual = createHash(algorithm).update(buffer).digest('base64');
  if (actual !== expected) {
    throw new Error(`${label} has integrity ${algorithm}-${actual}, expected ${integrity}`);
  }
}

async function fetchOk(url) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      // fetch follows redirects; GitHub release assets redirect to a CDN.
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) {
        console.log(`Download attempt ${attempt} failed (${error.message}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Download `url` to `path` and check it against the pinned size and SHA-256
 * before it takes that name. A download that does not match is deleted and
 * the error thrown, so nothing unverified is left where a later step or a
 * cache would pick it up.
 */
export async function downloadFile(url, path, pin) {
  const partial = `${path}.part`;
  rmSync(partial, { force: true });
  console.log(`Downloading ${url}`);
  const response = await fetchOk(url);
  let received = 0;
  const count = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), count, createWriteStream(partial));
  try {
    await checkFile(partial, pin, url);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  renameSync(partial, path);
  console.log(`Downloaded ${received} bytes, SHA-256 ${pin.sha256}`);
}

/** Download `url` into memory. For the small packages; archives go to disk. */
export async function downloadBuffer(url) {
  console.log(`Downloading ${url}`);
  const response = await fetchOk(url);
  return Buffer.from(await response.arrayBuffer());
}
