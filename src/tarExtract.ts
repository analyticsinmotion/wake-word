import { mkdirSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import { gunzip } from "zlib";

/**
 * Speech model extraction, in JavaScript.
 *
 * The model ships as a gzip-compressed tar archive. Node.js reads gzip itself
 * and the tar layer is a sequence of 512-byte headers, so no system `tar` is
 * needed on any platform. Before 0.13.1 the model was a bzip2 archive
 * unpacked by the system `tar`, and whether that could read bzip2 depended on
 * how it had been built.
 *
 * Deliberately minimal: regular files and directories from a POSIX ustar
 * archive, which is what the pinned model archive holds. Any other entry type
 * is refused rather than skipped. Links are never wanted, and a pax or GNU
 * long-name record renames the entry that follows it: skipping one would put
 * that entry in the wrong place without a word.
 */

const gunzipAsync = promisify(gunzip);

const BLOCK = 512;

interface TarEntry {
  name: string;
  type: "file" | "directory";
  /** File contents; empty for a directory. */
  data: Buffer;
}

/**
 * Unpack the gzip-compressed tar archive at `tarGzPath` into `destDir`.
 *
 * The archive is decompressed into memory in one piece (about 20 MB for the
 * model) on the thread pool, then written out by extractTar().
 */
export async function extractTarGz(tarGzPath: string, destDir: string): Promise<void> {
  const tar = await gunzipAsync(await readFile(tarGzPath));
  extractTar(tar, destDir);
}

/**
 * Write the regular files and directories of an uncompressed tar archive
 * under `destDir`.
 *
 * The whole archive is read, and every entry's destination checked, before
 * anything is written, so an archive with a bad header or an entry outside
 * `destDir` throws having written nothing. File modes and times are not
 * restored.
 */
export function extractTar(tar: Buffer, destDir: string): void {
  const planned = readTarEntries(tar).map((entry) => ({
    ...entry,
    target: resolveTarEntryPath(destDir, entry.name),
  }));

  for (const entry of planned) {
    if (entry.type === "directory") {
      mkdirSync(entry.target, { recursive: true });
    } else {
      // Archives need not carry an entry for every parent directory.
      mkdirSync(path.dirname(entry.target), { recursive: true });
      writeFileSync(entry.target, entry.data);
    }
  }
}

/**
 * Where an entry called `name` belongs under `destDir`. Throws for a name
 * that resolves anywhere else.
 *
 * The model archive has passed its SHA-256 check before it gets here, so this
 * is the second line of defence: `../x`, an absolute path, and on Windows
 * `..\x`, `C:\x`, `D:x`, or a UNC path must not write outside the
 * destination. `pathImpl` is the path flavour to apply, so tests can check
 * the Windows and POSIX rules on any machine.
 */
export function resolveTarEntryPath(
  destDir: string,
  name: string,
  pathImpl: path.PlatformPath = path
): string {
  const root = pathImpl.resolve(destDir);
  const target = pathImpl.resolve(root, name);
  const inside = root.endsWith(pathImpl.sep) ? root : root + pathImpl.sep;
  if (target !== root && !target.startsWith(inside)) {
    throw new Error(`Tar path traversal blocked: ${name}`);
  }
  return target;
}

/** Parse every entry up to the end-of-archive block. */
function readTarEntries(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // tar ends an archive with two all-zero blocks, often followed by more
    // zero padding. The first one is the end.
    if (header.every((byte) => byte === 0)) {
      break;
    }
    if (!checksumMatches(header)) {
      throw new Error(`Invalid tar header at byte ${offset}: checksum mismatch`);
    }

    let name = textField(header, 0, 100);
    // ustar stores a path longer than 100 bytes as a prefix and a name, split
    // at a slash. The model archive stores its three int8 model files this
    // way. GNU tar's header starts with the same "ustar" but keeps other data
    // in those bytes, so only the exact POSIX magic counts.
    if (header.toString("latin1", 257, 263) === "ustar\0") {
      const prefix = textField(header, 345, 155);
      if (prefix) {
        name = prefix + "/" + name;
      }
    }
    if (!name) {
      throw new Error(`Invalid tar header at byte ${offset}: no name`);
    }

    const size = octalField(header, 124, 12);
    if (Number.isNaN(size)) {
      throw new Error(`Invalid tar header for ${name}: unreadable size`);
    }
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length) {
      throw new Error(`Truncated tar archive: ${name} is cut short`);
    }

    const typeflag = header[156];
    if (typeflag === 0x30 || typeflag === 0) {
      // "0", or NUL from tars that predate type flags.
      entries.push({ name, type: "file", data: tar.subarray(dataStart, dataStart + size) });
    } else if (typeflag === 0x35) {
      // "5"
      entries.push({ name, type: "directory", data: Buffer.alloc(0) });
    } else {
      throw new Error(`Unsupported tar entry type "${String.fromCharCode(typeflag)}" for ${name}`);
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }

  return entries;
}

/** A header text field, up to its first NUL. */
function textField(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return (end === -1 ? bytes : bytes.subarray(0, end)).toString("utf8");
}

/**
 * A header number: octal digits, padded with spaces or NULs. NaN for anything
 * else, including the base-256 form tar uses for sizes over 8 GB.
 */
function octalField(header: Buffer, start: number, length: number): number {
  const text = textField(header, start, length).trim();
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : NaN;
}

/**
 * The stored checksum is the sum of the header's 512 bytes with the checksum
 * field itself counted as spaces. Early tars summed signed bytes, so either
 * sum is accepted, as other readers do.
 */
function checksumMatches(header: Buffer): boolean {
  const stored = octalField(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}
