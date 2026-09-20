#!/usr/bin/env node
/**
 * Check that a platform .vsix carries a working engine, then unpack it and run
 * the engine's self-test from the unpacked package.
 *
 *   node scripts/verify-vsix.mjs --target <target> --vsix <file> --extract-to <dir>
 *
 * A package can build without error and still not run: a .vscodeignore line
 * that drops a file, a runtime library for the wrong architecture, a binary
 * that lost its executable bit or its signature, or one that needs a newer C
 * library than the systems it is meant for. None of those fails a build, so
 * each is checked here, on the artifact itself:
 *
 *   - the extension, the Node engine, and the sentencepiece-js package the
 *     extension host loads are present;
 *   - the engine binary is present, is built for the target's architecture,
 *     and on macOS and Linux is stored executable;
 *   - ONNX Runtime and the Silero model are present beside it, byte for byte
 *     the pinned files, with their license notices;
 *   - Windows: the binary imports no C runtime DLL, because it links the
 *     static runtime the sherpa-onnx libraries are built against, and does not
 *     import ONNX Runtime, which it loads by path; no Visual C++ runtime
 *     library is packaged, and the ones the packaged libraries import are the
 *     ones the installation notes require;
 *   - Linux: neither the binary nor ONNX Runtime needs a newer glibc or
 *     libstdc++ than LINUX_FLOOR, and the binary exports no ONNX Runtime
 *     symbol for the loaded library to bind to;
 *   - macOS: neither needs a newer macOS than MACOS_FLOOR, and both carry a
 *     valid signature;
 *   - the self-test, run from the unpacked package with nothing in the
 *     environment pointing elsewhere, reports OK, the pinned sherpa-onnx
 *     version, and ONNX Runtime and the Silero model as loaded from the files
 *     beside the binary. The self-test exits 0 when either file is missing,
 *     so its exit code alone proves nothing.
 *
 * The package is unpacked into <dir>, with file modes restored as the editor
 * restores them on install, so later steps can drive the packaged binary.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import {
  engineFileName,
  PACKAGE_DIR,
  RUNTIME_FILES,
  SHERPA_ONNX,
  TARGETS,
} from '../engine-rs/scripts/pinned-inputs.mjs';

/**
 * The oldest Linux the engine supports: glibc 2.28 and the libstdc++ of GCC 8,
 * the same floor the editor itself has on Linux. The binary is built against
 * that glibc so that it runs on every distribution the editor runs on.
 */
export const LINUX_FLOOR = { GLIBC: '2.28', GLIBCXX: '3.4.25', CXXABI: '1.3.11', GCC: '7.0.0' };

/**
 * A Visual C++ runtime library, by file name. These are not part of Windows:
 * a library that imports one loads only where the redistributable has been
 * installed, unless the file is beside the executable.
 */
export const VC_RUNTIME_LIBRARY = /^(vcruntime|msvcp|concrt|vccorlib|vcomp|vcamp)\d+[a-z0-9_]*\.dll$/i;

/**
 * The Visual C++ runtime libraries the packaged Windows files import, lower
 * case and sorted. The extension does not ship them: the installation notes
 * name the Microsoft Visual C++ Redistributable as a requirement on Windows,
 * and this list is what that requirement has to cover. An ONNX Runtime bump
 * that changes it fails the package check here rather than on a machine
 * without the redistributable, where no check of ours runs.
 */
export const WINDOWS_VC_RUNTIME = [
  'msvcp140.dll',
  'msvcp140_1.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
];

/** The oldest macOS the engine runs on, set by the ONNX Runtime build it ships. */
export const MACOS_FLOOR = '14.0';

const EXPECTED = {
  'win32-x64': { format: 'PE', machine: 0x8664, platform: 'windows-x86_64' },
  'darwin-arm64': { format: 'Mach-O', machine: 0x0100000c, platform: 'macos-aarch64' },
  'linux-x64': { format: 'ELF', machine: 62, platform: 'linux-x86_64' },
  'linux-arm64': { format: 'ELF', machine: 183, platform: 'linux-aarch64' },
};

// ── Zip ──────────────────────────────────────────────────────────────────

/** The entries of a zip archive, from its central directory. */
export function zipEntries(zip) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip archive: no end of central directory');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const externalAttributes = zip.readUInt32LE(offset + 38);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, size, mode: externalAttributes >>> 16, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's content. */
export function zipRead(zip, entry) {
  const local = entry.localOffset;
  if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  const content = entry.method === 0 ? data : entry.method === 8 ? inflateRawSync(data) : null;
  if (!content) throw new Error(`${entry.name} uses unsupported compression method ${entry.method}`);
  if (content.length !== entry.size) throw new Error(`${entry.name} inflated to the wrong size`);
  return content;
}

// ── Executable formats ───────────────────────────────────────────────────

/** Machine type and imported DLL names of a PE image. */
export function peInfo(image) {
  if (image.toString('latin1', 0, 2) !== 'MZ') throw new Error('not a PE image');
  const pe = image.readUInt32LE(0x3c);
  if (image.readUInt32LE(pe) !== 0x00004550) throw new Error('no PE signature');
  const machine = image.readUInt16LE(pe + 4);
  const sectionCount = image.readUInt16LE(pe + 6);
  const optionalSize = image.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const is64 = image.readUInt16LE(optional) === 0x20b;
  const directories = optional + (is64 ? 112 : 96);
  const importRva = image.readUInt32LE(directories + 8);
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = optional + optionalSize + i * 40;
    sections.push({
      rva: image.readUInt32LE(at + 12),
      size: Math.max(image.readUInt32LE(at + 8), image.readUInt32LE(at + 16)),
      raw: image.readUInt32LE(at + 20),
    });
  }
  const fileOffset = (rva) => {
    const section = sections.find((s) => rva >= s.rva && rva < s.rva + s.size);
    if (!section) throw new Error(`RVA ${rva} is in no section`);
    return rva - section.rva + section.raw;
  };
  const imports = [];
  if (importRva) {
    for (let at = fileOffset(importRva); ; at += 20) {
      const nameRva = image.readUInt32LE(at + 12);
      if (nameRva === 0) break;
      const start = fileOffset(nameRva);
      imports.push(image.toString('latin1', start, image.indexOf(0, start)));
    }
  }
  return { format: 'PE', machine, imports };
}

/**
 * Machine type, required symbol versions, and defined dynamic symbols of a
 * 64-bit little-endian ELF image.
 */
export function elfInfo(image) {
  if (image.readUInt32BE(0) !== 0x7f454c46) throw new Error('not an ELF image');
  if (image[4] !== 2 || image[5] !== 1) throw new Error('not a 64-bit little-endian ELF image');
  const machine = image.readUInt16LE(18);
  const sectionOffset = Number(image.readBigUInt64LE(40));
  const sectionSize = image.readUInt16LE(58);
  const sectionCount = image.readUInt16LE(60);
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionOffset + i * sectionSize;
    sections.push({
      type: image.readUInt32LE(at + 4),
      offset: Number(image.readBigUInt64LE(at + 24)),
      size: Number(image.readBigUInt64LE(at + 32)),
      link: image.readUInt32LE(at + 40),
      info: image.readUInt32LE(at + 44),
    });
  }
  const string = (section, at) => {
    const start = section.offset + at;
    return image.toString('latin1', start, image.indexOf(0, start));
  };

  const versions = [];
  const verneed = sections.find((s) => s.type === 0x6ffffffe);
  if (verneed) {
    const strings = sections[verneed.link];
    let need = verneed.offset;
    for (let i = 0; i < verneed.info; i++) {
      const library = string(strings, image.readUInt32LE(need + 4));
      let aux = need + image.readUInt32LE(need + 8);
      for (let j = 0; j < image.readUInt16LE(need + 2); j++) {
        versions.push({ library, version: string(strings, image.readUInt32LE(aux + 8)) });
        aux += image.readUInt32LE(aux + 12);
      }
      need += image.readUInt32LE(need + 12);
    }
  }

  const exported = [];
  const dynsym = sections.find((s) => s.type === 11);
  if (dynsym) {
    const strings = sections[dynsym.link];
    for (let at = dynsym.offset + 24; at < dynsym.offset + dynsym.size; at += 24) {
      const name = string(strings, image.readUInt32LE(at));
      if (image.readUInt16LE(at + 6) !== 0 && name) exported.push(name);
    }
  }
  return { format: 'ELF', machine, versions, exported };
}

/** CPU type and minimum macOS of a thin 64-bit Mach-O image. */
export function machoInfo(image) {
  if (image.readUInt32LE(0) !== 0xfeedfacf) throw new Error('not a thin 64-bit Mach-O image');
  const machine = image.readUInt32LE(4);
  const commandCount = image.readUInt32LE(16);
  let minimum = null;
  let signed = false;
  for (let i = 0, at = 32; i < commandCount; i++) {
    const command = image.readUInt32LE(at);
    if (command === 0x32) {
      const version = image.readUInt32LE(at + 12);
      minimum = `${version >>> 16}.${(version >>> 8) & 0xff}`;
    } else if (command === 0x24 && minimum === null) {
      const version = image.readUInt32LE(at + 8);
      minimum = `${version >>> 16}.${(version >>> 8) & 0xff}`;
    } else if (command === 0x1d) {
      signed = true;
    }
    at += image.readUInt32LE(at + 4);
  }
  return { format: 'Mach-O', machine, minimum, signed };
}

export function binaryInfo(image) {
  if (image.toString('latin1', 0, 2) === 'MZ') return peInfo(image);
  if (image.readUInt32BE(0) === 0x7f454c46) return elfInfo(image);
  return machoInfo(image);
}

/** Compare dotted version strings numerically. */
export function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The newest version of each floored family an ELF image requires, and the
 * requirements that are newer than the floor.
 */
export function linuxRequirements(info, floor = LINUX_FLOOR) {
  const newest = {};
  const tooNew = [];
  for (const { library, version } of info.versions) {
    const match = /^(GLIBC|GLIBCXX|CXXABI|GCC)_([\d.]+)$/.exec(version);
    if (!match) continue;
    const [, family, number] = match;
    if (!newest[family] || compareVersions(number, newest[family]) > 0) newest[family] = number;
    if (compareVersions(number, floor[family]) > 0) tooNew.push(`${version} from ${library}`);
  }
  return { newest, tooNew };
}

/**
 * Dynamic symbols a loaded ONNX Runtime could bind to instead of its own: its
 * C API entry points and anything in its namespace.
 */
export function onnxRuntimeExports(info) {
  return info.exported.filter((name) => /onnx/i.test(name) || /^Ort[A-Z]/.test(name));
}

// ── Checks ───────────────────────────────────────────────────────────────

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

class Report {
  constructor() {
    this.failures = [];
  }
  ok(message) {
    console.log(`ok    ${message}`);
  }
  fail(message) {
    this.failures.push(message);
    console.log(`FAIL  ${message}`);
  }
  check(condition, message, detail = '') {
    if (condition) this.ok(message);
    else this.fail(detail ? `${message}: ${detail}` : message);
  }
}

function checkArchitecture(report, label, info, expected) {
  const hex = (value) => `0x${value.toString(16)}`;
  report.check(
    info.format === expected.format && info.machine === expected.machine,
    `${label} is ${expected.format} for ${expected.platform}`,
    `found ${info.format} machine ${hex(info.machine)}`
  );
}

function main() {
  const target = option('--target');
  const vsix = option('--vsix');
  const extractTo = option('--extract-to');
  if (!TARGETS.includes(target) || !vsix || !extractTo) {
    throw new Error('usage: verify-vsix.mjs --target <target> --vsix <file> --extract-to <dir>');
  }
  const expected = EXPECTED[target];
  const exe = engineFileName(target);
  const ort = RUNTIME_FILES.onnxRuntime[target].library;
  const report = new Report();

  const zip = readFileSync(vsix);
  const entries = new Map(zipEntries(zip).map((entry) => [entry.name, entry]));
  const packaged = (file) => `extension/${PACKAGE_DIR}/${file}`;
  console.log(`${path.basename(vsix)}: ${zip.length} bytes, ${entries.size} entries\n`);

  for (const required of [
    'extension/package.json',
    'extension/dist/extension.js',
    'extension/engine/audio-engine.js',
    'extension/node_modules/sentencepiece-js/package.json',
    'extension/node_modules/sentencepiece-js/dist/index.js',
  ]) {
    report.check(entries.has(required), `${required} is packaged`);
  }

  // The engine binary.
  const engineEntry = entries.get(packaged(exe));
  report.check(Boolean(engineEntry), `${packaged(exe)} is packaged`);
  let engine = null;
  if (engineEntry) {
    engine = binaryInfo(zipRead(zip, engineEntry));
    checkArchitecture(report, exe, engine, expected);
    if (!target.startsWith('win32-')) {
      report.check(
        (engineEntry.mode & 0o111) === 0o111,
        `${exe} is stored executable`,
        `mode ${(engineEntry.mode & 0o7777).toString(8)}`
      );
    }
  }

  // The runtime files, byte for byte.
  let ortInfo = null;
  for (const file of [ort, RUNTIME_FILES.onnxRuntimeNotices, ...RUNTIME_FILES.model.files]) {
    const entry = entries.get(packaged(file.to));
    if (!entry) {
      report.fail(`${packaged(file.to)} is packaged`);
      continue;
    }
    const content = zipRead(zip, entry);
    const digest = createHash('sha256').update(content).digest('hex');
    report.check(
      digest === file.sha256,
      `${packaged(file.to)} is the pinned file (${file.bytes} bytes)`,
      `SHA-256 ${digest}, expected ${file.sha256}`
    );
    if (file === ort) {
      ortInfo = binaryInfo(content);
      checkArchitecture(report, ort.to, ortInfo, expected);
    }
  }

  // The Visual C++ runtime on Windows. It is not part of Windows and is not
  // packaged: the installation notes name the redistributable as a
  // requirement instead. Two things keep that requirement true. A copy in
  // this directory would be loaded in preference to the installed one and
  // would never be serviced, so none may be packaged; and the requirement
  // describes what the packaged libraries import, so a change to that fails
  // here rather than on a machine without the redistributable.
  if (target.startsWith('win32-')) {
    const shipped = [...entries.keys()]
      .filter((name) => name.startsWith(`extension/${PACKAGE_DIR}/`))
      .map((name) => name.slice(name.lastIndexOf('/') + 1))
      .filter((name) => VC_RUNTIME_LIBRARY.test(name));
    report.check(
      shipped.length === 0,
      'no Visual C++ runtime library is packaged',
      `packaged: ${shipped.join(', ')}`
    );
    const imported = [
      ...new Set(
        [engine, ortInfo]
          .filter((info) => info?.format === 'PE')
          .flatMap((info) => info.imports)
          .filter((library) => VC_RUNTIME_LIBRARY.test(library))
          .map((library) => library.toLowerCase())
      ),
    ].sort();
    report.check(
      imported.join(' ') === WINDOWS_VC_RUNTIME.join(' '),
      `the packaged files import the Visual C++ runtime the installation notes require (${imported.join(', ')})`,
      `expected ${WINDOWS_VC_RUNTIME.join(', ')}`
    );
  }

  // Platform checks on the binaries as packaged.
  if (engine?.format === 'PE') {
    const runtimes = engine.imports.filter((name) =>
      /^(vcruntime\d*|msvcp\d*|ucrtbase|api-ms-win-crt-.*)\.dll$/i.test(name)
    );
    report.check(
      runtimes.length === 0,
      `${exe} links the C runtime statically (imports: ${engine.imports.join(', ')})`,
      `imports ${runtimes.join(', ')}`
    );
    report.check(
      !engine.imports.some((name) => /^onnxruntime\.dll$/i.test(name)),
      `${exe} does not import ONNX Runtime`
    );
  }
  if (engine?.format === 'ELF') {
    for (const [label, info] of [[exe, engine], [ort.to, ortInfo]]) {
      if (!info) continue;
      const { newest, tooNew } = linuxRequirements(info);
      const summary = Object.entries(newest).map(([family, version]) => `${family}_${version}`).join(', ');
      report.check(
        tooNew.length === 0,
        `${label} needs nothing newer than glibc ${LINUX_FLOOR.GLIBC} and GLIBCXX ${LINUX_FLOOR.GLIBCXX} (newest: ${summary})`,
        `needs ${tooNew.join(', ')}`
      );
    }
    const leaked = onnxRuntimeExports(engine);
    report.check(
      leaked.length === 0,
      `${exe} exports no ONNX Runtime symbol (${engine.exported.length} dynamic symbols defined)`,
      leaked.slice(0, 20).join(', ')
    );
  }
  if (engine?.format === 'Mach-O') {
    for (const [label, info] of [[exe, engine], [ort.to, ortInfo]]) {
      if (!info) continue;
      report.check(
        info.minimum !== null && compareVersions(info.minimum, MACOS_FLOOR) <= 0,
        `${label} needs nothing newer than macOS ${MACOS_FLOOR} (minimum ${info.minimum})`
      );
      report.check(info.signed, `${label} carries a code signature`);
    }
  }

  // Unpack, restoring the modes the package records, as the editor does.
  rmSync(extractTo, { recursive: true, force: true });
  for (const entry of entries.values()) {
    if (entry.name.endsWith('/')) continue;
    const destination = path.join(extractTo, ...entry.name.split('/'));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, zipRead(zip, entry));
    if (process.platform !== 'win32' && entry.mode & 0o777) {
      chmodSync(destination, entry.mode & 0o777);
    }
  }
  const binDir = path.join(extractTo, 'extension', PACKAGE_DIR);
  const binary = path.join(binDir, exe);
  console.log(`\nUnpacked into ${extractTo}`);

  if (engine?.format === 'Mach-O') {
    for (const file of [binary, path.join(binDir, ort.to)]) {
      const result = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', file], {
        encoding: 'utf8',
      });
      report.check(
        result.status === 0,
        `codesign verifies ${path.basename(file)} as unpacked`,
        (result.stderr || result.error?.message || '').trim()
      );
    }
  }

  // The self-test, from the unpacked package.
  if (engineEntry) {
    const env = { ...process.env };
    delete env.ORT_DYLIB_PATH;
    delete env.WAKE_WORD_VAD_MODEL;
    const result = spawnSync(binary, ['--self-test'], { encoding: 'utf8', env, timeout: 30000 });
    const lines = (result.stdout ?? '').split(/\r?\n/).filter(Boolean);
    console.log(`\n${binary} --self-test\n${lines.map((line) => `  ${line}`).join('\n')}`);
    if (result.stderr?.trim()) console.log(`  stderr: ${result.stderr.trim()}`);
    const value = (key) =>
      lines.find((line) => line.startsWith(`SELF-TEST:${key}=`))?.slice(`SELF-TEST:${key}=`.length);
    const samePath = (reported, file) => {
      try {
        return realpathSync.native(reported) === realpathSync.native(file);
      } catch {
        return false;
      }
    };
    report.check(result.status === 0, 'the self-test exits 0', `status ${result.status ?? result.error?.message}`);
    report.check(lines[0] === 'SELF-TEST:OK', 'the self-test reports OK', lines[0] ?? 'no output');
    report.check(
      value('platform') === expected.platform,
      `the self-test runs on ${expected.platform}`,
      `platform=${value('platform')}`
    );
    report.check(
      value('sherpa-onnx') === SHERPA_ONNX.version,
      `the linked sherpa-onnx library is ${SHERPA_ONNX.version}`,
      `sherpa-onnx=${value('sherpa-onnx')}`
    );
    report.check(
      samePath(value('ort') ?? '', path.join(binDir, ort.to)),
      `ONNX Runtime loaded from beside the packaged binary`,
      `ort=${value('ort')}`
    );
    report.check(
      samePath(value('vad-model') ?? '', path.join(binDir, 'silero_vad.onnx')),
      `the Silero model loaded from beside the packaged binary`,
      `vad-model=${value('vad-model')}`
    );
  }

  console.log('\nPackaged engine files:');
  for (const entry of entries.values()) {
    if (entry.name.startsWith(`extension/${PACKAGE_DIR}/`)) {
      console.log(`  ${entry.name}  ${entry.size} bytes  mode ${(entry.mode & 0o7777).toString(8)}`);
    }
  }
  console.log(`\n${path.basename(vsix)}: ${statSync(vsix).size} bytes`);

  if (report.failures.length > 0) {
    console.log(`\n${report.failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nEvery check passed');
}

// The parsers above are exported for checking them against known files; the
// checks run only when this file is the script being run.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
