import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import * as os from "os";
import * as path from "path";
import { gzipSync } from "zlib";
import { extractTar, extractTarGz, resolveTarEntryPath } from "../../src/tarExtract";

/**
 * These tests write to a fresh directory under the system temp directory and
 * delete it afterwards. Extraction is file creation: a mocked `fs` would check
 * the calls rather than where the files land, and CI runs this file on
 * Windows, macOS, and Linux, whose path rules differ.
 */

interface EntryOptions {
  /** The ustar prefix field, which holds the start of a path over 100 bytes. */
  prefix?: string;
  /** The 8 bytes of magic and version. POSIX ustar unless given. */
  magic?: string;
  /** The raw 12-byte size field, in place of the data length in octal. */
  sizeField?: string;
}

/** One tar entry: a header, then the data padded to whole 512-byte blocks. */
function makeTarEntry(
  name: string,
  data: Buffer = Buffer.alloc(0),
  typeflag = "0",
  options: EntryOptions = {}
): Buffer {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`Test entry name over 100 bytes: ${name}`);
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "latin1"); // mode
  header.write("0000000\0", 108, "latin1"); // uid
  header.write("0000000\0", 116, "latin1"); // gid
  header.write(options.sizeField ?? (data.length.toString(8).padStart(11, "0") + "\0"), 124, "latin1");
  header.write("00000000000\0", 136, "latin1"); // mtime
  header.write(typeflag, 156, "latin1");
  header.write(options.magic ?? "ustar\u000000", 257, "latin1");
  if (options.prefix) {
    header.write(options.prefix, 345, "utf8");
  }
  // The checksum is summed with its own field read as spaces.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

/** The two zero blocks that end an archive. */
function makeTarEnd(): Buffer {
  return Buffer.alloc(1024);
}

function archive(...entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, makeTarEnd()]);
}

let workDir: string;
let dest: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "wake-word-tar-"));
  dest = path.join(workDir, "dest");
  mkdirSync(dest);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("extractTar", () => {
  it("extracts a regular file", () => {
    extractTar(archive(makeTarEntry("hello.txt", Buffer.from("hello"))), dest);
    expect(readFileSync(path.join(dest, "hello.txt"), "utf8")).toBe("hello");
  });

  it("creates directories, including empty ones", () => {
    extractTar(archive(makeTarEntry("model/", undefined, "5"), makeTarEntry("model/test_wavs/", undefined, "5")), dest);
    expect(statSync(path.join(dest, "model", "test_wavs")).isDirectory()).toBe(true);
    expect(readdirSync(path.join(dest, "model", "test_wavs"))).toEqual([]);
  });

  it("extracts several files in sequence, whatever their size in blocks", () => {
    const empty = Buffer.alloc(0);
    const oneBlock = Buffer.alloc(512, 1);
    const threeBlocks = Buffer.alloc(1300, 2);
    extractTar(
      archive(
        makeTarEntry("model/", undefined, "5"),
        makeTarEntry("model/empty.txt", empty),
        makeTarEntry("model/one-block.bin", oneBlock),
        makeTarEntry("model/three-blocks.bin", threeBlocks),
        makeTarEntry("model/tokens.txt", Buffer.from("tokens"))
      ),
      dest
    );
    const model = path.join(dest, "model");
    expect(readFileSync(path.join(model, "empty.txt"))).toEqual(empty);
    expect(readFileSync(path.join(model, "one-block.bin"))).toEqual(oneBlock);
    expect(readFileSync(path.join(model, "three-blocks.bin"))).toEqual(threeBlocks);
    expect(readFileSync(path.join(model, "tokens.txt"), "utf8")).toBe("tokens");
  });

  it("creates parent directories that have no entry of their own", () => {
    extractTar(archive(makeTarEntry("model/test_wavs/trans.txt", Buffer.from("t"))), dest);
    expect(readFileSync(path.join(dest, "model", "test_wavs", "trans.txt"), "utf8")).toBe("t");
  });

  it("reads a NUL type flag as a regular file", () => {
    extractTar(archive(makeTarEntry("old.txt", Buffer.from("v7"), "\0")), dest);
    expect(readFileSync(path.join(dest, "old.txt"), "utf8")).toBe("v7");
  });

  it("joins the ustar prefix to the name, as the model archive stores its int8 model files", () => {
    // 102 bytes as one path: too long for the 100-byte name field.
    const dir = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
    const file = "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
    extractTar(archive(makeTarEntry(file, Buffer.from("onnx"), "0", { prefix: dir })), dest);
    expect(readFileSync(path.join(dest, dir, file), "utf8")).toBe("onnx");
    expect(existsSync(path.join(dest, file))).toBe(false);
  });

  it("reads the prefix field only from a POSIX ustar header", () => {
    // GNU tar's header also begins "ustar" but keeps other data in those bytes.
    const gnu = makeTarEntry("a.txt", Buffer.from("a"), "0", { prefix: "junk", magic: "ustar  \0" });
    extractTar(archive(gnu), dest);
    expect(readdirSync(dest)).toEqual(["a.txt"]);
  });

  it("blocks path traversal and writes nothing", () => {
    const tar = archive(makeTarEntry("safe.txt", Buffer.from("ok")), makeTarEntry("../malicious", Buffer.from("bad")));
    expect(() => extractTar(tar, dest)).toThrow("Tar path traversal blocked: ../malicious");
    expect(existsSync(path.join(workDir, "malicious"))).toBe(false);
    // Every destination is checked before the first file is written.
    expect(readdirSync(dest)).toEqual([]);
  });

  it("blocks path traversal through the ustar prefix", () => {
    const tar = archive(makeTarEntry("malicious", Buffer.from("bad"), "0", { prefix: ".." }));
    expect(() => extractTar(tar, dest)).toThrow("Tar path traversal blocked: ../malicious");
    expect(existsSync(path.join(workDir, "malicious"))).toBe(false);
  });

  it("extracts nothing from an empty archive", () => {
    extractTar(makeTarEnd(), dest);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("stops at the first zero block", () => {
    const tar = Buffer.concat([archive(makeTarEntry("a.txt", Buffer.from("a"))), makeTarEntry("after.txt", Buffer.from("b"))]);
    extractTar(tar, dest);
    expect(readdirSync(dest)).toEqual(["a.txt"]);
  });

  it("rejects a header whose checksum does not match", () => {
    const entry = makeTarEntry("a.txt", Buffer.from("a"));
    entry[0] = "b".charCodeAt(0); // renamed after the checksum was computed
    expect(() => extractTar(archive(entry), dest)).toThrow(/checksum mismatch/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("rejects a size that is not octal", () => {
    const entry = makeTarEntry("a.txt", Buffer.from("a"), "0", { sizeField: "00000000009\0" });
    expect(() => extractTar(archive(entry), dest)).toThrow("Invalid tar header for a.txt: unreadable size");
  });

  it("rejects an entry whose data is cut short", () => {
    const entry = makeTarEntry("model.onnx", Buffer.alloc(2000, 7));
    expect(() => extractTar(entry.subarray(0, 1024), dest)).toThrow(/Truncated tar archive/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("refuses links and long-name records instead of skipping them", () => {
    // Hard link, symbolic link, pax extended header, GNU long name.
    for (const typeflag of ["1", "2", "x", "L"]) {
      const tar = archive(makeTarEntry("a.txt", Buffer.from("a")), makeTarEntry("entry", Buffer.from("x"), typeflag));
      expect(() => extractTar(tar, dest)).toThrow(`Unsupported tar entry type "${typeflag}" for entry`);
    }
    expect(readdirSync(dest)).toEqual([]);
  });
});

describe("resolveTarEntryPath", () => {
  it("resolves a name under the destination", () => {
    expect(resolveTarEntryPath("/store/sherpa-onnx", "model/tokens.txt", path.posix)).toBe(
      "/store/sherpa-onnx/model/tokens.txt"
    );
    expect(resolveTarEntryPath("C:\\store\\sherpa-onnx", "model/tokens.txt", path.win32)).toBe(
      "C:\\store\\sherpa-onnx\\model\\tokens.txt"
    );
  });

  it("allows the destination itself, and .. that stays inside it", () => {
    expect(resolveTarEntryPath("/store", "./", path.posix)).toBe("/store");
    expect(resolveTarEntryPath("/store", "model/../tokens.txt", path.posix)).toBe("/store/tokens.txt");
  });

  it("blocks .. that leaves the destination", () => {
    for (const name of ["..", "../malicious", "model/../../malicious"]) {
      expect(() => resolveTarEntryPath("/store/sherpa-onnx", name, path.posix)).toThrow(/traversal blocked/);
      expect(() => resolveTarEntryPath("C:\\store\\sherpa-onnx", name, path.win32)).toThrow(/traversal blocked/);
    }
  });

  it("blocks a sibling whose name starts with the destination's name", () => {
    // A bare string prefix check would let /store/sherpa-onnx-evil through.
    expect(() => resolveTarEntryPath("/store/sherpa-onnx", "../sherpa-onnx-evil/x", path.posix)).toThrow(
      /traversal blocked/
    );
  });

  it("blocks absolute paths", () => {
    expect(() => resolveTarEntryPath("/store", "/etc/passwd", path.posix)).toThrow(/traversal blocked/);
    for (const name of ["C:\\Windows\\evil.dll", "D:evil", "\\evil", "\\\\server\\share\\evil", "/etc/passwd"]) {
      expect(() => resolveTarEntryPath("C:\\store", name, path.win32)).toThrow(/traversal blocked/);
    }
  });

  it("treats a backslash as a separator on Windows only", () => {
    expect(() => resolveTarEntryPath("C:\\store\\sherpa-onnx", "..\\malicious", path.win32)).toThrow(
      /traversal blocked/
    );
    // On macOS and Linux a backslash is an ordinary character in a file name.
    expect(resolveTarEntryPath("/store/sherpa-onnx", "..\\malicious", path.posix)).toBe(
      "/store/sherpa-onnx/..\\malicious"
    );
  });

  it("accepts a destination with a trailing separator or at a root", () => {
    expect(resolveTarEntryPath("/store/", "a", path.posix)).toBe("/store/a");
    expect(resolveTarEntryPath("/", "a", path.posix)).toBe("/a");
    expect(resolveTarEntryPath("C:\\", "a", path.win32)).toBe("C:\\a");
  });

  it("applies this platform's path rules by default", () => {
    expect(resolveTarEntryPath(dest, "model/tokens.txt")).toBe(path.join(dest, "model", "tokens.txt"));
  });
});

describe("extractTarGz", () => {
  it("decompresses and extracts a .tar.gz file", async () => {
    const file = path.join(workDir, "model.tar.gz");
    const tar = archive(makeTarEntry("model/", undefined, "5"), makeTarEntry("model/tokens.txt", Buffer.from("tokens")));
    writeFileSync(file, gzipSync(tar));
    await extractTarGz(file, dest);
    expect(readFileSync(path.join(dest, "model", "tokens.txt"), "utf8")).toBe("tokens");
  });

  it("rejects a file that is not gzip-compressed", async () => {
    const file = path.join(workDir, "model.tar.gz");
    writeFileSync(file, archive(makeTarEntry("a.txt", Buffer.from("a"))));
    await expect(extractTarGz(file, dest)).rejects.toThrow(/incorrect header check/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("rejects a truncated gzip stream", async () => {
    const file = path.join(workDir, "model.tar.gz");
    const gz = gzipSync(archive(makeTarEntry("model.onnx", Buffer.alloc(4096, 3))));
    writeFileSync(file, gz.subarray(0, gz.length - 12));
    await expect(extractTarGz(file, dest)).rejects.toThrow(/unexpected end of file/);
    expect(readdirSync(dest)).toEqual([]);
  });
});
