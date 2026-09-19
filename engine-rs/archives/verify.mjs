#!/usr/bin/env node
/**
 * Checks a sherpa-onnx static library archive built without the
 * text-to-speech components, against the official archive for the same
 * release and target.
 *
 *   node engine-rs/archives/verify.mjs placeholders --lib-dir <dir>
 *       Check the three placeholder libraries in a staged lib directory.
 *
 *   node engine-rs/archives/verify.mjs archive --archive <file> --unpacked <dir>
 *       --reference <file> --reference-unpacked <dir> [--built-with <file>] [--summary <file>]
 *       Check a packed archive, unpacked into <dir>, against the official
 *       archive, unpacked into its own directory. --built-with names a file
 *       of lines saying what built the archive, repeated in the report. With
 *       --summary, append a Markdown report to that file (the job summary in
 *       CI).
 *
 * The archive must satisfy the sherpa-onnx-sys build script unmodified. That
 * script unpacks <name>.tar.bz2, expects <name>/lib inside it, and links the
 * libraries in LINK_LIST by name. So the checks are:
 *
 *   - the layout: one top-level directory named after the archive, holding
 *     lib/ and nothing else, with the same library files as the official
 *     archive except NOT_BUILT;
 *   - every library in LINK_LIST is present, is a static library for the
 *     target's object format and machine, and every member is an object file
 *     this script can read;
 *   - the PLACEHOLDERS define and reference no symbol at all, so linking them
 *     adds nothing;
 *   - every other library has a symbol index, the C API defines the functions
 *     the engine calls and every SherpaOnnx function the official C API
 *     defines;
 *   - no symbol from the excluded components appears in any library, defined
 *     or referenced: neither a name matching EXCLUDED_NAME nor any name the
 *     official archive's copies of the PLACEHOLDERS define that none of its
 *     other libraries define;
 *   - the libraries in LINK_LIST need no name from the toolchain that links
 *     them that the official archive's do not (see externalNames());
 *   - Windows: no member asks for the dynamic or the debug C runtime, and the
 *     C++ members declare the static release runtime the engine links;
 *   - macOS: no member requires a newer macOS than MACOS_DEPLOYMENT_TARGET;
 *   - Linux: every library is compiled for the std::string ABI of the ONNX
 *     Runtime the archive carries (see CXX11_ABI_NAME), and by a compiler
 *     generation that the official archive's copy of the library records.
 *
 * It also reports the archive's size and SHA-256 beside the official one's.
 * Exits 1 when any check fails.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { forEachMember, readArchive, readObject } from './objects.mjs';

/** The static libraries the sherpa-onnx-sys build script links, in its order. */
export const LINK_LIST = [
  'sherpa-onnx-c-api',
  'sherpa-onnx-core',
  'kaldi-decoder-core',
  'sherpa-onnx-kaldifst-core',
  'sherpa-onnx-fstfar',
  'sherpa-onnx-fst',
  'kaldi-native-fbank-core',
  'kissfft-float',
  'piper_phonemize',
  'espeak-ng',
  'ucd',
  'onnxruntime',
  'ssentencepiece_core',
];

/**
 * The libraries in LINK_LIST that only a text-to-speech build produces. The
 * archive carries each as a library with no symbols. build.sh makes them.
 */
export const PLACEHOLDERS = ['espeak-ng', 'piper_phonemize', 'ucd'];

/**
 * Libraries the official archives carry that this build does not produce and
 * the link list does not name: portaudio is built only for the demo programs.
 */
const NOT_BUILT = ['sherpa-onnx-portaudio_static'];

/** The C API functions the engine reaches through the sherpa-onnx crate. */
const ENGINE_FUNCTIONS = [
  'SherpaOnnxCreateKeywordSpotter',
  'SherpaOnnxDestroyKeywordSpotter',
  'SherpaOnnxCreateKeywordStream',
  'SherpaOnnxIsKeywordStreamReady',
  'SherpaOnnxDecodeKeywordStream',
  'SherpaOnnxResetKeywordStream',
  'SherpaOnnxGetKeywordResult',
  'SherpaOnnxDestroyKeywordResult',
  'SherpaOnnxOnlineStreamAcceptWaveform',
  'SherpaOnnxDestroyOnlineStream',
  'SherpaOnnxGetVersionStr',
];

/**
 * Symbol names of the excluded components: the espeak-ng C API, the piper
 * namespace in any mangling, and the ucd functions. "espeak" counts only at
 * the start of a word, and case matters, so that "Speaker" in the speaker
 * embedding functions, and the messages that name them, do not match.
 */
const EXCLUDED_NAME = /(^|[^A-Za-z])espeak|piper|^_?ucd_/;

/**
 * Names that do not have C linkage: Itanium and Microsoft C++ names, and the
 * constant-pool names MSVC generates. Which of these a library defines
 * depends on the compiler version as much as on the source, so they are left
 * out of the comparison with the official archive, which was built by
 * another compiler; EXCLUDED_NAME covers the C++ names of the excluded
 * components.
 */
const NOT_C_NAME = /^(_{1,2}Z|\?|__real@|__xmm@|__ymm@|__zmm@|__mask@)/;

/** The engine's macOS deployment target; no object may require a newer one. */
const MACOS_DEPLOYMENT_TARGET = '11.0';

/**
 * Linker directives that select a C or C++ runtime other than the static
 * release one: the DLL runtimes and every debug runtime.
 */
const OTHER_RUNTIME = /\/DEFAULTLIB:"?(msvcrtd?|msvcprtd?|libcmtd|libcpmtd|ucrtd?|vcruntimed?)(\.lib)?"?(\s|$)|RuntimeLibrary=(?!MT_StaticRelease)/i;

/** Each target, by the suffix of its archive name. */
const PLATFORMS = [
  { suffix: '-win-x64-static-MT-Release-lib', format: 'coff', machine: 0x8664, label: 'COFF x86-64' },
  { suffix: '-osx-arm64-static-lib', format: 'macho', machine: 0x0100000c, label: 'Mach-O arm64' },
  { suffix: '-linux-x64-static-lib', format: 'elf', machine: 62, label: 'ELF x86-64' },
  { suffix: '-linux-aarch64-static-lib', format: 'elf', machine: 183, label: 'ELF AArch64' },
];

function platformOf(stem) {
  const platform = PLATFORMS.find((p) => stem.endsWith(p.suffix));
  if (!platform) throw new Error(`${stem} is not the name of an archive for a known target`);
  return platform;
}

/** The file name of a static library on this platform. */
function libraryFile(platform, name) {
  return platform.format === 'coff' ? `${name}.lib` : `lib${name}.a`;
}

/** The library name a static library file carries. */
function libraryName(platform, file) {
  return platform.format === 'coff' ? file.replace(/\.lib$/, '') : file.replace(/^lib/, '').replace(/\.a$/, '');
}

/** The symbol name a C function has in this platform's objects. */
function cSymbol(platform, name) {
  return platform.format === 'macho' ? `_${name}` : name;
}

/** Compare dotted version strings numerically. */
function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Everything the checks need from one static library: its index, and per
 * member the format, machine, global symbols, and platform details.
 */
export function inspectLibrary(file) {
  const archive = readArchive(file);
  const members = [];
  forEachMember(file, archive, (member, data) => {
    members.push({ name: member.name, ...readObject(data) });
  });
  return { index: archive.index, variant: archive.variant, members, bytes: statSync(file).size };
}

/**
 * The names the libraries in LINK_LIST reference and none of them defines:
 * what the toolchain and system libraries that link the engine must provide.
 * A name the official archive's libraries do not need fails the check, for
 * either of two reasons:
 *
 *   - A static library links only with a toolchain at least as new as the one
 *     that compiled it, because a newer compiler emits calls to runtime and
 *     standard library helpers that older runtime libraries do not define.
 *   - On Linux, libraries compiled with a different std::string ABI
 *     (_GLIBCXX_USE_CXX11_ABI) from the ONNX Runtime the archive carries
 *     reference the other ABI's standard library members. Their template
 *     internals with the same names and different layouts then meet in one
 *     link, and the executable links but corrupts memory at run time.
 */
function externalNames(libraries) {
  const defined = new Set();
  const referenced = new Set();
  for (const [library, contents] of libraries) {
    if (!LINK_LIST.includes(library)) continue;
    for (const member of contents.members) {
      for (const symbol of member.symbols) (symbol.defined ? defined : referenced).add(symbol.name);
    }
  }
  return new Set([...referenced].filter((name) => !defined.has(name)));
}

/**
 * libstdc++ has two ABIs for std::string, and _GLIBCXX_USE_CXX11_ABI selects
 * one when an object is compiled. A name of the C++11 ABI carries the
 * std::__cxx11 namespace (St7__cxx11) or the cxx11 ABI tag (B5cxx11). A
 * member function of the earlier ABI's std::string or std::basic_string is
 * named through the Ss or Sb substitution, which the C++11 ABI's names never
 * use. "cxx11" alone is no marker: a mangled name runs an identifier into
 * the length of the next one, so __gnu_cxx::__enable_if contains it
 * (9__gnu_cxx11__enable_if) under either ABI.
 */
const CXX11_ABI_NAME = /St7__cxx11|B5cxx11/;
const PRE_CXX11_ABI_NAME = /^_ZNK?S[sb]/;

/** How many of a library's members name each std::string ABI. */
function stringAbi(library) {
  const names = (member, pattern) => member.symbols.some((s) => pattern.test(s.name));
  return {
    cxx11: library.members.filter((m) => names(m, CXX11_ABI_NAME)).length,
    preCxx11: library.members.filter((m) => names(m, PRE_CXX11_ABI_NAME)).length,
  };
}

/**
 * The compiler generations a library's members record in .comment, such as
 * "GCC 11" for "GCC: (GNU) 11.2.1 20220127 (Red Hat 11.2.1-9)". A string of
 * another form stands for itself.
 */
function compilerGenerations(library) {
  const generations = new Set();
  for (const member of library.members) {
    for (const comment of member.comments ?? []) {
      const gcc = /^GCC: \([^)]*\) (\d+)\./.exec(comment);
      generations.add(gcc ? `GCC ${gcc[1]}` : comment);
    }
  }
  return generations;
}

/** Each .comment string of the members, with the number that record it. */
function compilerCounts(members) {
  const counts = new Map();
  for (const member of members) {
    for (const comment of member.comments ?? []) counts.set(comment, (counts.get(comment) ?? 0) + 1);
  }
  return [...counts].map(([comment, count]) => `${comment} (${count})`).join('; ') || 'none';
}

// ── Checks ───────────────────────────────────────────────────────────────

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

class Report {
  constructor({ quiet = false } = {}) {
    this.quiet = quiet;
    this.failures = [];
    this.lines = [];
  }
  ok(message) {
    if (!this.quiet) console.log(`ok    ${message}`);
    this.lines.push(`- ok: ${message}`);
  }
  fail(message) {
    this.failures.push(message);
    if (!this.quiet) console.log(`FAIL  ${message}`);
    this.lines.push(`- **FAIL**: ${message}`);
  }
  check(condition, message, detail = '') {
    if (condition) this.ok(message);
    else this.fail(detail ? `${message}: ${detail}` : message);
  }
  /** A line of the report that is a fact about the archive, not a check. */
  note(message) {
    if (!this.quiet) console.log(`      ${message}`);
    this.lines.push(`- ${message}`);
  }
}

/** A short list for a message, with a count of any left out. */
function sample(names, limit = 5) {
  const list = [...names];
  return list.length <= limit ? list.join(', ') : `${list.slice(0, limit).join(', ')} and ${list.length - limit} more`;
}

/** Every member is an object file for the target. */
function checkMembers(report, platform, name, library) {
  const wrong = library.members.filter((m) => m.format !== platform.format || m.machine !== platform.machine);
  report.check(
    library.members.length > 0 && wrong.length === 0,
    `${name}: ${library.members.length} member(s), every one a ${platform.label} object`,
    wrong.length
      ? `${sample(wrong.map((m) => `${m.name} (${m.format}${m.machine === undefined ? '' : ` 0x${m.machine.toString(16)}`})`))}`
      : 'no members'
  );
}

/** A placeholder defines and references nothing. */
function checkPlaceholder(report, platform, name, library) {
  checkMembers(report, platform, name, library);
  const indexed = library.index?.length ?? 0;
  const symbols = library.members.flatMap((m) => m.symbols.map((s) => s.name));
  report.check(
    indexed === 0 && symbols.length === 0,
    `${name}: no symbols (index ${library.index === null ? 'absent' : 'empty'}, no member defines or references any)`,
    `${indexed} indexed, ${symbols.length} in members: ${sample(symbols)}`
  );
  const directives = library.members.map((m) => m.directives ?? '').join('').trim();
  if (platform.format === 'coff') {
    report.check(directives === '', `${name}: no linker directives`, directives);
  }
}

function placeholdersCommand() {
  const libDir = option('--lib-dir');
  if (!libDir) throw new Error('placeholders needs --lib-dir <dir>');
  const platform = platformOf(path.basename(path.dirname(path.resolve(libDir))));
  const report = new Report();
  for (const name of PLACEHOLDERS) {
    const file = path.join(libDir, libraryFile(platform, name));
    if (!existsSync(file)) {
      report.fail(`${libraryFile(platform, name)} is missing`);
      continue;
    }
    let library;
    try {
      library = inspectLibrary(file);
    } catch (error) {
      report.fail(`${libraryFile(platform, name)} cannot be read as a static library: ${error.message}`);
      continue;
    }
    checkPlaceholder(report, platform, libraryFile(platform, name), library);
  }
  return report;
}

/** The single top-level directory, its lib/ directory, and lib's files. */
function checkLayout(report, root, stem) {
  const top = readdirSync(root);
  report.check(top.length === 1 && top[0] === stem, `the archive holds one directory, ${stem}/`, `found ${sample(top)}`);
  const base = path.join(root, stem);
  if (!existsSync(base) || !lstatSync(base).isDirectory()) return null;
  const inside = readdirSync(base);
  report.check(inside.length === 1 && inside[0] === 'lib', `${stem}/ holds lib/ and nothing else`, `found ${sample(inside)}`);
  const libDir = path.join(base, 'lib');
  if (!existsSync(libDir)) return null;
  const files = readdirSync(libDir).sort();
  const irregular = files.filter((f) => !lstatSync(path.join(libDir, f)).isFile());
  report.check(irregular.length === 0, `lib/ holds regular files only (${files.length})`, `not regular files: ${sample(irregular)}`);
  return { libDir, files };
}

async function archiveCommand() {
  const archiveFile = option('--archive');
  const unpacked = option('--unpacked');
  const referenceFile = option('--reference');
  const referenceUnpacked = option('--reference-unpacked');
  const builtWith = option('--built-with');
  const summary = option('--summary');
  if (!archiveFile || !unpacked || !referenceFile || !referenceUnpacked) {
    throw new Error('archive needs --archive, --unpacked, --reference, and --reference-unpacked');
  }
  const name = path.basename(archiveFile);
  if (!name.endsWith('.tar.bz2')) throw new Error(`${name} is not a .tar.bz2 archive`);
  const stem = name.slice(0, -'.tar.bz2'.length);
  if (path.basename(referenceFile) !== name) {
    throw new Error(`the reference archive is ${path.basename(referenceFile)}, expected the official ${name}`);
  }
  const platform = platformOf(stem);
  const report = new Report();

  console.log(`${name} (${platform.label})\n`);
  report.lines.push('#### Layout');
  const ours = checkLayout(report, unpacked, stem);
  const reference = checkLayout(new Report({ quiet: true }), referenceUnpacked, stem);
  if (!ours || !reference) {
    report.fail('the archive or the official archive does not have the expected layout');
    return finish(report, summary, { name, builtWith });
  }

  const referenceNames = reference.files.map((f) => libraryName(platform, f));
  const ourNames = ours.files.map((f) => libraryName(platform, f));
  const missing = referenceNames.filter((n) => !ourNames.includes(n) && !NOT_BUILT.includes(n));
  const extra = ourNames.filter((n) => !referenceNames.includes(n));
  const notBuilt = referenceNames.filter((n) => NOT_BUILT.includes(n) && !ourNames.includes(n));
  report.check(
    missing.length === 0 && extra.length === 0,
    `the same library files as the official archive${notBuilt.length ? `, less ${sample(notBuilt.map((n) => libraryFile(platform, n)))}, which is not built` : ''}`,
    `${missing.length ? `missing ${sample(missing)}` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `not in the official archive: ${sample(extra)}` : ''}`
  );
  const absent = LINK_LIST.filter((n) => !ours.files.includes(libraryFile(platform, n)));
  report.check(absent.length === 0, `every library the link list names is present (${LINK_LIST.length})`, `missing ${sample(absent)}`);
  if (absent.length) return finish(report, summary, { name, builtWith });

  console.log('\nReading the libraries...');
  const libraries = new Map();
  const unreadable = [];
  for (const file of ours.files) {
    try {
      libraries.set(libraryName(platform, file), inspectLibrary(path.join(ours.libDir, file)));
    } catch (error) {
      unreadable.push(`${file} (${error.message})`);
    }
  }
  report.check(unreadable.length === 0, 'every file in lib/ is a static library this script can read', sample(unreadable));
  if (unreadable.length) return finish(report, summary, { name, builtWith });
  const referenceLibraries = new Map();
  for (const file of reference.files) {
    try {
      referenceLibraries.set(libraryName(platform, file), inspectLibrary(path.join(reference.libDir, file)));
    } catch (error) {
      throw new Error(`the official archive's ${file} cannot be read: ${error.message}`, { cause: error });
    }
  }

  report.lines.push('', '#### Placeholder libraries');
  for (const library of PLACEHOLDERS) checkPlaceholder(report, platform, libraryFile(platform, library), libraries.get(library));

  report.lines.push('', '#### Libraries the keyword spotter links');
  for (const [library, contents] of libraries) {
    if (PLACEHOLDERS.includes(library)) continue;
    checkMembers(report, platform, libraryFile(platform, library), contents);
    report.check(
      (contents.index?.length ?? 0) > 0,
      `${libraryFile(platform, library)}: a symbol index with ${contents.index?.length ?? 0} entries`
    );
  }
  const cApi = libraries.get('sherpa-onnx-c-api');
  const cApiDefines = new Set(cApi.members.flatMap((m) => m.symbols.filter((s) => s.defined).map((s) => s.name)));
  const notDefined = ENGINE_FUNCTIONS.filter((f) => !cApiDefines.has(cSymbol(platform, f)));
  report.check(
    notDefined.length === 0,
    `the C API defines the ${ENGINE_FUNCTIONS.length} functions the engine calls`,
    `missing ${sample(notDefined)}`
  );
  const prefix = cSymbol(platform, 'SherpaOnnx');
  const officialApi = new Set(
    referenceLibraries
      .get('sherpa-onnx-c-api')
      .members.flatMap((m) => m.symbols.filter((s) => s.defined && s.name.startsWith(prefix)).map((s) => s.name))
  );
  const lostApi = [...officialApi].filter((f) => !cApiDefines.has(f));
  report.check(
    lostApi.length === 0,
    `the C API defines all ${officialApi.size} SherpaOnnx functions the official C API defines`,
    `missing ${sample(lostApi)}`
  );

  report.lines.push('', '#### The excluded components');
  const seen = new Map();
  for (const [library, contents] of libraries) {
    for (const member of contents.members) {
      for (const symbol of member.symbols) {
        if (!seen.has(symbol.name)) seen.set(symbol.name, `${libraryFile(platform, library)}(${member.name})`);
      }
    }
    for (const symbol of contents.index ?? []) {
      if (!seen.has(symbol)) seen.set(symbol, `${libraryFile(platform, library)} index`);
    }
  }
  const byPattern = [...seen.keys()].filter((s) => EXCLUDED_NAME.test(s));
  report.check(
    byPattern.length === 0,
    `no symbol name matches ${EXCLUDED_NAME} in any library, defined or referenced (${seen.size} names read)`,
    sample(byPattern.map((s) => `${s} in ${seen.get(s)}`))
  );
  const otherDefinitions = new Set();
  for (const [library, contents] of referenceLibraries) {
    if (PLACEHOLDERS.includes(library)) continue;
    for (const member of contents.members) for (const s of member.symbols) if (s.defined) otherDefinitions.add(s.name);
  }
  const excluded = new Set();
  for (const library of PLACEHOLDERS) {
    const contents = referenceLibraries.get(library);
    if (!contents) continue;
    for (const member of contents.members) {
      for (const s of member.symbols) {
        if (s.defined && !NOT_C_NAME.test(s.name) && !otherDefinitions.has(s.name)) excluded.add(s.name);
      }
    }
  }
  const byName = [...seen.keys()].filter((s) => excluded.has(s));
  report.check(
    excluded.size > 0 && byName.length === 0,
    `none of the ${excluded.size} C names that only the official ${PLACEHOLDERS.map((n) => libraryFile(platform, n)).join(', ')} define appears in any library`,
    excluded.size === 0 ? 'the official archive defines no such names, so there is nothing to compare' : sample(byName.map((s) => `${s} in ${seen.get(s)}`))
  );

  report.lines.push('', '#### What the linking toolchain must provide');
  const needed = externalNames(libraries);
  const officialNeeded = externalNames(referenceLibraries);
  const newNames = [...needed].filter((name) => !officialNeeded.has(name)).sort();
  if (newNames.length) {
    console.log(`\nNames the linking toolchain must provide that the official archive does not need:\n  ${newNames.join('\n  ')}\n`);
  }
  report.check(
    newNames.length === 0,
    `the linked libraries leave no name to the linking toolchain that the official archive's do not (${needed.size} names, official ${officialNeeded.size})`,
    `${newNames.length} name(s): ${sample(newNames, 10)}`
  );

  const allMembers = [...libraries.values()].flatMap((l) => l.members);
  if (platform.format === 'coff') {
    report.lines.push('', '#### C runtime');
    const other = allMembers.filter((m) => OTHER_RUNTIME.test(m.directives ?? ''));
    report.check(other.length === 0, 'no member asks for the DLL or a debug C runtime', sample(other.map((m) => m.name)));
    const staticRelease = allMembers.filter((m) => /RuntimeLibrary=MT_StaticRelease/.test(m.directives ?? ''));
    report.check(
      staticRelease.length > 0,
      `${staticRelease.length} C++ member(s) declare RuntimeLibrary=MT_StaticRelease, the static release runtime`
    );
  }
  if (platform.format === 'macho') {
    report.lines.push('', '#### Deployment target');
    const tooNew = allMembers.filter((m) => !m.minos || compareVersions(m.minos, MACOS_DEPLOYMENT_TARGET) > 0);
    const notMacos = allMembers.filter((m) => m.platform !== 1);
    report.check(
      tooNew.length === 0 && notMacos.length === 0,
      `every member is built for macOS ${MACOS_DEPLOYMENT_TARGET} or earlier`,
      sample([...tooNew, ...notMacos].map((m) => `${m.name} (platform ${m.platform}, minimum ${m.minos})`))
    );
  }
  if (platform.format === 'elf') {
    report.lines.push('', '#### Compiler and C++ standard library ABI');
    // The ONNX Runtime is upstream's prebuilt one, so its std::string ABI is
    // the one every library compiled for the archive has to share: libraries
    // of both ABIs link into one executable and corrupt memory at run time.
    const runtimeFile = libraryFile(platform, 'onnxruntime');
    const runtime = stringAbi(libraries.get('onnxruntime'));
    const runtimeAbi = runtime.cxx11 > 0 === runtime.preCxx11 > 0 ? null : runtime.cxx11 > 0 ? 'C++11' : 'pre-C++11';
    report.check(
      runtimeAbi !== null,
      `${runtimeFile} names one std::string ABI${runtimeAbi ? `, the ${runtimeAbi} one` : ''}`,
      `${runtime.cxx11} member(s) name the C++11 ABI and ${runtime.preCxx11} the pre-C++11 one`
    );
    if (runtimeAbi !== null) {
      const otherAbi = [...libraries]
        .map(([library, contents]) => ({ library, members: stringAbi(contents)[runtimeAbi === 'C++11' ? 'preCxx11' : 'cxx11'] }))
        .filter((l) => l.members > 0);
      report.check(
        otherAbi.length === 0,
        `every library is compiled for the ${runtimeAbi} std::string ABI, as ${runtimeFile} is`,
        `compiled for the ${runtimeAbi === 'C++11' ? 'pre-C++11' : 'C++11'} ABI: ${sample(otherAbi.map((l) => `${libraryFile(platform, l.library)} (${l.members} member(s))`))}`
      );
    }
    // Another compiler generation generates different floating-point code for
    // the libraries that compute the features and decode the model's output,
    // which changes what the keyword spotter detects, and it need not leave a
    // name behind for the linking toolchain check to find.
    const generations = new Set();
    const otherCompiler = [];
    for (const [library, contents] of libraries) {
      const official = referenceLibraries.get(library);
      if (!official || PLACEHOLDERS.includes(library)) continue;
      const allowed = compilerGenerations(official);
      // Nothing to compare with when the official copy records no compiler.
      if (allowed.size === 0) continue;
      const recorded = compilerGenerations(contents);
      for (const generation of recorded) generations.add(generation);
      const unknown = [...recorded].filter((generation) => !allowed.has(generation));
      if (unknown.length) {
        otherCompiler.push(`${libraryFile(platform, library)} (${unknown.join(', ')}; official ${[...allowed].join(', ')})`);
      }
    }
    report.check(
      otherCompiler.length === 0,
      `every library records a compiler generation that the official archive's copy of it records (${[...generations].sort().join(', ') || 'none recorded'})`,
      sample(otherCompiler)
    );
    report.note(`compilers this archive's members record: ${compilerCounts(allMembers)}`);
    report.note(`compilers the official archive's members record: ${compilerCounts([...referenceLibraries.values()].flatMap((l) => l.members))}`);
  }

  const sizes = {
    archive: statSync(archiveFile).size,
    reference: statSync(referenceFile).size,
    sha256: await sha256File(archiveFile),
    referenceSha256: await sha256File(referenceFile),
    libraries: ours.files.map((file) => {
      const library = libraryName(platform, file);
      return {
        file,
        bytes: libraries.get(library).bytes,
        reference: referenceLibraries.get(library)?.bytes,
        kind: PLACEHOLDERS.includes(library) ? 'placeholder' : LINK_LIST.includes(library) ? 'linked' : 'not linked',
      };
    }),
  };
  return finish(report, summary, { name, sizes, builtWith });
}

/**
 * Print the outcome, append the job summary, and exit 1 on any failure. The
 * summary always has every check's result; the sizes and digests only once
 * the checks got far enough to measure them.
 */
function finish(report, summary, { name, sizes, builtWith } = {}) {
  let change = 0;
  let percent = '';
  if (sizes) {
    change = sizes.archive - sizes.reference;
    percent = ((100 * change) / sizes.reference).toFixed(1);
    console.log(`\n${name}: ${sizes.archive} bytes, SHA-256 ${sizes.sha256}`);
    console.log(`official:  ${sizes.reference} bytes, SHA-256 ${sizes.referenceSha256}`);
    console.log(`difference: ${change} bytes (${percent}%)`);
  }
  if (summary && name) {
    const lines = [`### ${name}`, ''];
    if (sizes) {
      lines.push(
        '| | Bytes | SHA-256 |',
        '|---|---:|---|',
        `| This archive | ${sizes.archive.toLocaleString('en-US')} | \`${sizes.sha256}\` |`,
        `| Official archive | ${sizes.reference.toLocaleString('en-US')} | \`${sizes.referenceSha256}\` |`,
        `| Difference | ${change.toLocaleString('en-US')} (${percent}%) | |`,
        ''
      );
    }
    if (builtWith && existsSync(builtWith)) {
      const built = readFileSync(builtWith, 'utf8').trim().split(/\r?\n/);
      lines.push('Built with:', '', ...built.map((l) => `- ${l}`), '');
    }
    if (sizes) {
      lines.push(
        '| Library | Kind | Bytes | Official bytes |',
        '|---|---|---:|---:|',
        ...sizes.libraries.map(
          (l) =>
            `| \`${l.file}\` | ${l.kind} | ${l.bytes.toLocaleString('en-US')} | ${l.reference === undefined ? '' : l.reference.toLocaleString('en-US')} |`
        ),
        ''
      );
    }
    lines.push(...report.lines, '');
    appendFileSync(summary, `${lines.join('\n')}\n`);
  }
  if (report.failures.length > 0) {
    console.log(`\n${report.failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nEvery check passed');
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command === 'placeholders') {
    finish(placeholdersCommand());
  } else if (command === 'archive') {
    await archiveCommand();
  } else {
    throw new Error(`unknown command "${command}"; expected placeholders or archive`);
  }
}

// The helpers above are exported for checking them against known files; the
// checks run only when this file is the script being run.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
