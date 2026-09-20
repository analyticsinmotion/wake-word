#!/usr/bin/env node
/**
 * Put the engine and the files it loads at run time into the directory the
 * extension package ships them from.
 *
 *   node engine-rs/scripts/stage.mjs --target <target> [--binary <path>] [--out <dir>]
 *
 * <target> is the extension's package target: win32-x64, darwin-arm64,
 * linux-x64, or linux-arm64. The binary defaults to
 * engine-rs/target/release/wake-word-engine[.exe], and the directory to bin/
 * at the repository root, which is emptied first. It ends up holding:
 *
 *   wake-word-engine[.exe]     the engine, executable on macOS and Linux
 *   onnxruntime.dll            ONNX Runtime for the voice activity detector;
 *   libonnxruntime.dylib       one of these three, for the target
 *   libonnxruntime.so
 *   silero_vad.onnx            the voice activity model
 *   ONNXRUNTIME-NOTICES.md     the license notices those two files carry
 *   SILERO-VAD-NOTICES.md
 *   msvcp140.dll, msvcp140_1.dll, vcruntime140.dll, vcruntime140_1.dll
 *                              Windows only: the Visual C++ runtime libraries
 *   VC-RUNTIME-NOTICES.md      onnxruntime.dll imports, and their notice
 *
 * The engine looks for ONNX Runtime and the model in the directory that holds
 * the executable, so this layout needs no configuration. Each runtime file is
 * taken from its npm package, and both the package and the file are checked
 * against scripts/pinned-inputs.mjs first. The Visual C++ runtime libraries are
 * unpacked from Microsoft's redistributable installer, which is checked the
 * same way, as is each library; that step uses Windows' own expand.exe, so a
 * Windows target is staged on Windows. On macOS the binary is given an
 * ad-hoc signature, without which it will not run on Apple silicon, and the
 * signature is verified.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { checkBuffer, checkIntegrity, downloadBuffer, downloadFile } from './download.mjs';
import {
  C_RUNTIME,
  engineFileName,
  npmTarballUrl,
  PACKAGE_DIR,
  RUNTIME_FILES,
  TARGETS,
} from './pinned-inputs.mjs';

const ENGINE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_DIR = path.dirname(ENGINE_DIR);

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * The regular files in an uncompressed tar archive, by name. npm tarballs are
 * ustar; pax extended headers carry nothing the files below depend on and are
 * skipped with their data.
 */
function tarFiles(tar) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const start = offset + 512;
    if (type === '0') {
      files.set(prefix ? `${prefix}/${name}` : name, tar.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Download a pinned npm package and return its files by name. */
async function fetchPackage({ package: pkg, version, tarball }) {
  const url = npmTarballUrl(pkg, version);
  const archive = await downloadBuffer(url);
  checkIntegrity(archive, tarball, `${pkg}@${version}`);
  return tarFiles(gunzipSync(archive));
}

/** Check one file from a package against its pin and write it into `out`. */
function place(files, file, out, label) {
  const content = files.get(file.from);
  if (!content) {
    throw new Error(`${label} has no ${file.from}`);
  }
  checkBuffer(content, file, `${label} ${file.from}`);
  writeFileSync(path.join(out, file.to), content);
  console.log(`${file.to}: ${file.bytes} bytes, SHA-256 ${file.sha256} (${label})`);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}`);
  }
}

/**
 * Where each cabinet file embedded in `image` starts and ends. A cabinet
 * begins with the signature MSCF, four reserved zero bytes, its own length,
 * and further down its format version, 1.3.
 */
function embeddedCabinets(image) {
  const cabinets = [];
  for (let at = image.indexOf('MSCF'); at !== -1; at = image.indexOf('MSCF', at + 4)) {
    if (at + 36 > image.length) break;
    const length = image.readUInt32LE(at + 8);
    const plausible =
      image.readUInt32LE(at + 4) === 0 &&
      image.readUInt8(at + 24) === 3 &&
      image.readUInt8(at + 25) === 1 &&
      length >= 36 &&
      at + length <= image.length;
    if (plausible) {
      cabinets.push(image.subarray(at, at + length));
    }
  }
  return cabinets;
}

/**
 * Unpack the Visual C++ runtime libraries from Microsoft's redistributable
 * installer into `out`, with their notice.
 *
 * The installer is not run. It is an executable with cabinet files attached,
 * and the one that holds the x64 runtime is itself inside the largest of
 * them, so every cabinet found is expanded, and then every cabinet among the
 * files that produced. Which cabinet a library came out of decides nothing:
 * each library is checked against its pinned digest before it is kept.
 */
async function stageCRuntime(target, out) {
  const runtime = C_RUNTIME[target];
  if (!runtime) return;
  if (process.platform !== 'win32') {
    throw new Error(`the ${target} C runtime libraries are unpacked with expand.exe, so stage ${target} on Windows`);
  }
  // By full path: under Git Bash, which the workflows run their steps in, a
  // bare `expand` is the coreutils program that turns tabs into spaces.
  const expand = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'expand.exe');
  const work = mkdtempSync(path.join(os.tmpdir(), 'wake-word-c-runtime-'));
  try {
    const installer = path.join(work, 'installer.exe');
    await downloadFile(runtime.installer.url, installer, runtime.installer);

    const found = new Map();
    const unpack = (cabinet, depth) => {
      const dir = mkdtempSync(path.join(work, 'cabinet-'));
      const file = `${dir}.cab`;
      writeFileSync(file, cabinet);
      const result = spawnSync(expand, ['-F:*', file, dir], { encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(`expand.exe exited ${result.status ?? result.signal}: ${result.stdout}${result.stderr}`);
      }
      for (const name of readdirSync(dir)) {
        const content = readFileSync(path.join(dir, name));
        found.set(name, content);
        if (depth === 0 && content.toString('latin1', 0, 4) === 'MSCF') {
          unpack(content, 1);
        }
      }
    };
    for (const cabinet of embeddedCabinets(readFileSync(installer))) {
      unpack(cabinet, 0);
    }

    const label = `Visual C++ Redistributable ${runtime.version}`;
    for (const file of runtime.files) {
      place(found, file, out, label);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  copyFileSync(path.join(ENGINE_DIR, runtime.notices.from), path.join(out, runtime.notices.to));
  console.log(`${runtime.notices.to}: copied from ${runtime.notices.from}`);
}

async function main() {
  const target = option('--target');
  if (!TARGETS.includes(target)) {
    throw new Error(`unknown target "${target}"; expected one of ${TARGETS.join(', ')}`);
  }
  const exe = engineFileName(target);
  const binary = path.resolve(option('--binary') ?? path.join(ENGINE_DIR, 'target', 'release', exe));
  const out = path.resolve(option('--out') ?? path.join(REPO_DIR, PACKAGE_DIR));
  if (!existsSync(binary)) {
    throw new Error(`${binary} does not exist; build the engine first`);
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const staged = path.join(out, exe);
  copyFileSync(binary, staged);
  if (!target.startsWith('win32-')) {
    chmodSync(staged, 0o755);
  }
  console.log(`${exe}: copied from ${binary}`);

  const ort = RUNTIME_FILES.onnxRuntime[target];
  const ortLabel = `${ort.package}@${ort.version}`;
  const ortFiles = await fetchPackage(ort);
  place(ortFiles, ort.library, out, ortLabel);
  place(ortFiles, RUNTIME_FILES.onnxRuntimeNotices, out, ortLabel);

  const model = RUNTIME_FILES.model;
  const modelLabel = `${model.package}@${model.version}`;
  const modelFiles = await fetchPackage(model);
  for (const file of model.files) {
    place(modelFiles, file, out, modelLabel);
  }

  await stageCRuntime(target, out);

  if (target.startsWith('darwin-')) {
    // The linker signs its output ad hoc, and stripping can leave that
    // signature stale. Signing again after every change to the file, and
    // verifying, means the binary that ships is one macOS will run.
    run('codesign', ['--force', '--sign', '-', staged]);
    run('codesign', ['--verify', '--strict', '--verbose=2', staged]);
  }

  console.log(`Staged the engine for ${target} in ${out}`);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
