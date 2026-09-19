/**
 * Readers for static libraries and the object files inside them. Node.js 22
 * or later; no dependencies.
 *
 * Archives: the Unix ar format in its GNU and BSD variants, and the variant
 * the Microsoft librarian writes. Objects: 64-bit little-endian ELF, 64-bit
 * Mach-O, and COFF, including the big-object COFF format large C++ sources
 * compile to.
 *
 * Only what the archive checks need is read: each library's symbol index, and
 * for each member its machine, its global symbols, and the details that tie
 * it to a platform (COFF linker directives, the Mach-O minimum OS version, the
 * compiler identification ELF records in .comment).
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const MEMBER_HEADER_SIZE = 60;

/** The class ID of a big-object COFF header (ANON_OBJECT_HEADER_BIGOBJ). */
const BIGOBJ_CLASS_ID = Buffer.from('c7a1bad1eebaa94baf20faf66aa4dcb8', 'hex');

/** The class ID of an object compiled for link-time code generation (/GL). */
const LTCG_CLASS_ID = Buffer.from('38feb30ca5d9ab4dac9bd6b6222653c2', 'hex');

/** COFF machine types a COFF object header may carry. */
const COFF_MACHINES = new Set([0x0, 0x14c, 0x1c4, 0x8664, 0xa641, 0xa64e, 0xaa64]);

function readAt(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const count = readSync(fd, buffer, done, length - done, offset + done);
    if (count === 0) throw new Error(`unexpected end of file at byte ${offset + done}`);
    done += count;
  }
  return buffer;
}

function cString(buffer, start) {
  const end = buffer.indexOf(0, start);
  return buffer.toString('latin1', start, end === -1 ? buffer.length : end);
}

// ── Archives ─────────────────────────────────────────────────────────────

/** Names in a System V symbol table: a count, one offset per name, the names. */
function sysvIndex(data, wide) {
  const width = wide ? 8 : 4;
  const count = wide ? Number(data.readBigUInt64BE(0)) : data.readUInt32BE(0);
  const names = [];
  let at = width + count * width;
  for (let i = 0; i < count; i++) {
    const name = cString(data, at);
    names.push(name);
    at += name.length + 1;
  }
  return names;
}

/** Names in a BSD symbol table: ranlib entries, then their string table. */
function bsdIndex(data, wide) {
  const read = (at) => (wide ? Number(data.readBigUInt64LE(at)) : data.readUInt32LE(at));
  const width = wide ? 8 : 4;
  const entryBytes = read(0);
  const strings = width + entryBytes + width;
  const names = [];
  for (let at = width; at < width + entryBytes; at += 2 * width) {
    names.push(cString(data, strings + read(at)));
  }
  return names;
}

/**
 * The symbol index and members of an ar archive.
 *
 * Returns { variant, index, members }. `variant` is 'gnu', 'bsd', or 'coff'
 * (the Microsoft librarian's, whose first linker member has the System V
 * layout). `index` lists the names in the archive's symbol table, or is null
 * when the archive has none. `members` is [{ name, offset, size }] for every
 * member other than the symbol tables and the long-name table; `offset` is
 * where its data starts in the file.
 */
export function readArchive(path) {
  const fd = openSync(path, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    const magic = readAt(fd, 0, Math.min(8, fileSize)).toString('latin1');
    if (magic === '!<thin>\n') throw new Error('a thin archive, which holds no member data');
    if (magic !== '!<arch>\n') throw new Error('not an ar archive');

    let variant = 'gnu';
    let index = null;
    let longNames = null;
    let linkerMembers = 0;
    const members = [];
    let offset = 8;
    while (offset + MEMBER_HEADER_SIZE <= fileSize) {
      const header = readAt(fd, offset, MEMBER_HEADER_SIZE);
      if (header.toString('latin1', 58, 60) !== '`\n') {
        throw new Error(`no member header at byte ${offset}`);
      }
      const size = Number(header.toString('latin1', 48, 58).trim());
      let name = header.toString('latin1', 0, 16).trimEnd();
      let dataOffset = offset + MEMBER_HEADER_SIZE;
      let dataSize = size;
      const next = dataOffset + size + (size % 2);

      if (name.startsWith('#1/')) {
        // BSD: the name is stored at the start of the data.
        const nameLength = Number(name.slice(3));
        name = readAt(fd, dataOffset, nameLength).toString('latin1').replace(/\0+$/, '');
        dataOffset += nameLength;
        dataSize -= nameLength;
      }

      if (name === '/') {
        // GNU has one; the Microsoft librarian writes a second in its own
        // layout, listing the same symbols.
        linkerMembers += 1;
        if (linkerMembers === 1) index = sysvIndex(readAt(fd, dataOffset, dataSize), false);
        else variant = 'coff';
      } else if (name === '/SYM64/') {
        index = sysvIndex(readAt(fd, dataOffset, dataSize), true);
      } else if (name === '//') {
        longNames = readAt(fd, dataOffset, dataSize).toString('latin1');
      } else if (name.startsWith('__.SYMDEF')) {
        variant = 'bsd';
        index = bsdIndex(readAt(fd, dataOffset, dataSize), name.startsWith('__.SYMDEF_64'));
      } else if (name === '/<ECSYMBOLS>/' || name === '/<HYBRIDMAP>/') {
        // Arm64EC tables: no members of their own.
      } else {
        if (/^\/\d+$/.test(name)) {
          if (longNames === null) throw new Error(`member ${name} refers to a missing long-name table`);
          // GNU ends each long name with "/\n", the Microsoft librarian with NUL.
          const start = Number(name.slice(1));
          let end = start;
          while (end < longNames.length && longNames[end] !== '\n' && longNames[end] !== '\0') end++;
          name = longNames.slice(start, end);
        }
        members.push({ name: name.replace(/\/$/, ''), offset: dataOffset, size: dataSize });
      }
      offset = next;
    }
    return { variant, index, members };
  } finally {
    closeSync(fd);
  }
}

/**
 * Call `visit(member, data)` for each member of the archive at `path`, with
 * the member's bytes. Only one member is held in memory at a time.
 */
export function forEachMember(path, archive, visit) {
  const fd = openSync(path, 'r');
  try {
    for (const member of archive.members) {
      visit(member, readAt(fd, member.offset, member.size));
    }
  } finally {
    closeSync(fd);
  }
}

// ── Objects ──────────────────────────────────────────────────────────────

/**
 * What an object file was built for and the global symbols it defines or
 * references.
 *
 * Returns { format, machine, symbols: [{ name, defined }] } plus, per format:
 * COFF `directives` (the linker directives in its .drectve sections), Mach-O
 * `platform` and `minos` (from its build-version load command), ELF `type`
 * and `comments` (the strings in its .comment section). An object this
 * reader cannot take symbols from has format 'ltcg', 'import', 'bitcode',
 * 'fat', 'anonymous', or 'unknown', and no symbols.
 */
export function readObject(data) {
  if (data.length >= 4 && data.readUInt32BE(0) === 0x7f454c46) return readElf(data);
  if (data.length >= 4 && data.readUInt32LE(0) === 0xfeedfacf) return readMacho(data);
  if (data.length >= 4 && data.readUInt32BE(0) === 0xcafebabe) return { format: 'fat', symbols: [] };
  if (data.length >= 4 && (data.readUInt32BE(0) === 0x4243c0de || data.readUInt32LE(0) === 0x0b17c0de)) {
    return { format: 'bitcode', symbols: [] };
  }
  if (data.length >= 20 && data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 0xffff) {
    const version = data.readUInt16LE(4);
    if (version === 0) return { format: 'import', machine: data.readUInt16LE(6), symbols: [] };
    if (data.length >= 56 && version >= 2 && data.subarray(12, 28).equals(BIGOBJ_CLASS_ID)) {
      return readCoff(data, true);
    }
    if (data.length >= 28 && data.subarray(12, 28).equals(LTCG_CLASS_ID)) {
      return { format: 'ltcg', machine: data.readUInt16LE(6), symbols: [] };
    }
    return { format: 'anonymous', symbols: [] };
  }
  if (data.length >= 20 && COFF_MACHINES.has(data.readUInt16LE(0))) return readCoff(data, false);
  return { format: 'unknown', symbols: [] };
}

/** A COFF object, in the regular or the big-object layout. */
function readCoff(data, bigobj) {
  const machine = data.readUInt16LE(bigobj ? 6 : 0);
  const sectionCount = bigobj ? data.readUInt32LE(44) : data.readUInt16LE(2);
  const symbolTable = data.readUInt32LE(bigobj ? 48 : 8);
  const symbolCount = data.readUInt32LE(bigobj ? 52 : 12);
  const sectionTable = bigobj ? 56 : 20 + data.readUInt16LE(16);
  const symbolSize = bigobj ? 20 : 18;
  const strings = symbolTable + symbolCount * symbolSize;

  const symbolName = (at) => {
    if (data.readUInt32LE(at) === 0) return cString(data, strings + data.readUInt32LE(at + 4));
    const end = data.subarray(at, at + 8).indexOf(0);
    return data.toString('latin1', at, end === -1 ? at + 8 : at + end);
  };

  const symbols = [];
  for (let i = 0; i < symbolCount; ) {
    const at = symbolTable + i * symbolSize;
    const value = data.readUInt32LE(at + 8);
    const section = bigobj ? data.readInt32LE(at + 12) : data.readInt16LE(at + 12);
    const storageClass = data[at + (bigobj ? 18 : 16)];
    const auxiliary = data[at + (bigobj ? 19 : 17)];
    if (storageClass === 2) {
      // IMAGE_SYM_CLASS_EXTERNAL: undefined when it has neither a section
      // nor a value; a value without a section is a common symbol.
      symbols.push({ name: symbolName(at), defined: section !== 0 || value !== 0 });
    } else if (storageClass === 105) {
      // IMAGE_SYM_CLASS_WEAK_EXTERNAL: a name with a fallback symbol it
      // resolves to when nothing else defines it, so it counts as defined.
      symbols.push({ name: symbolName(at), defined: true });
    }
    i += 1 + auxiliary;
  }

  let directives = '';
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionTable + i * 40;
    if (data.toString('latin1', at, at + 8) === '.drectve') {
      const size = data.readUInt32LE(at + 16);
      const start = data.readUInt32LE(at + 20);
      directives += `${data.toString('latin1', start, start + size)} `;
    }
  }
  return { format: 'coff', machine, symbols, directives };
}

/** A 64-bit little-endian ELF object. */
function readElf(data) {
  if (data[4] !== 2 || data[5] !== 1) return { format: 'unknown', symbols: [] };
  const type = data.readUInt16LE(16);
  const machine = data.readUInt16LE(18);
  const sectionTable = Number(data.readBigUInt64LE(40));
  const entrySize = data.readUInt16LE(58);
  let sectionCount = data.readUInt16LE(60);
  let namesIndex = data.readUInt16LE(62);
  // With 0xff00 or more sections the real counts are in section 0.
  if (sectionCount === 0 && sectionTable !== 0) sectionCount = Number(data.readBigUInt64LE(sectionTable + 32));
  if (namesIndex === 0xffff) namesIndex = data.readUInt32LE(sectionTable + 40);

  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionTable + i * entrySize;
    sections.push({
      name: data.readUInt32LE(at),
      type: data.readUInt32LE(at + 4),
      offset: Number(data.readBigUInt64LE(at + 24)),
      size: Number(data.readBigUInt64LE(at + 32)),
      link: data.readUInt32LE(at + 40),
    });
  }

  const symbols = [];
  for (const table of sections.filter((section) => section.type === 2)) {
    const strings = sections[table.link];
    for (let at = table.offset + 24; at < table.offset + table.size; at += 24) {
      const binding = data[at + 4] >> 4;
      // STB_GLOBAL, STB_WEAK, STB_GNU_UNIQUE
      if (binding !== 1 && binding !== 2 && binding !== 10) continue;
      symbols.push({
        name: cString(data, strings.offset + data.readUInt32LE(at)),
        defined: data.readUInt16LE(at + 6) !== 0,
      });
    }
  }

  const names = sections[namesIndex];
  const comment = names && sections.find((section) => cString(data, names.offset + section.name) === '.comment');
  const comments = comment
    ? data.toString('latin1', comment.offset, comment.offset + comment.size).split('\0').filter(Boolean)
    : [];
  return { format: 'elf', type, machine, symbols, comments };
}

/** A dotted version from Mach-O's packed xxxx.yy.zz form. */
function machoVersion(packed) {
  const patch = packed & 0xff;
  return `${packed >>> 16}.${(packed >>> 8) & 0xff}${patch ? `.${patch}` : ''}`;
}

/** A thin 64-bit Mach-O object. */
function readMacho(data) {
  const machine = data.readUInt32LE(4);
  const commandCount = data.readUInt32LE(16);
  let symtab = null;
  let platform = null;
  let minos = null;
  for (let i = 0, at = 32; i < commandCount; i++) {
    const command = data.readUInt32LE(at);
    if (command === 0x2) {
      // LC_SYMTAB
      symtab = {
        offset: data.readUInt32LE(at + 8),
        count: data.readUInt32LE(at + 12),
        strings: data.readUInt32LE(at + 16),
      };
    } else if (command === 0x32) {
      // LC_BUILD_VERSION
      platform = data.readUInt32LE(at + 8);
      minos = machoVersion(data.readUInt32LE(at + 12));
    } else if (command === 0x24 && minos === null) {
      // LC_VERSION_MIN_MACOSX
      platform = 1;
      minos = machoVersion(data.readUInt32LE(at + 8));
    }
    at += data.readUInt32LE(at + 4);
  }

  const symbols = [];
  if (symtab) {
    for (let i = 0; i < symtab.count; i++) {
      const at = symtab.offset + i * 16;
      const type = data[at + 4];
      // Skip debugging entries (N_STAB) and symbols that are not external.
      if (type & 0xe0 || !(type & 0x01)) continue;
      // N_UNDF with a value is a common symbol, which counts as defined.
      const defined = (type & 0x0e) !== 0 || data.readBigUInt64LE(at + 8) !== 0n;
      symbols.push({ name: cString(data, symtab.strings + data.readUInt32LE(at)), defined });
    }
  }
  return { format: 'macho', machine, symbols, platform, minos };
}
