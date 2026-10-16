import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KWS_MODEL,
  MODELS_DIR,
  checkModel,
  describeModelCheck,
  modelDirectory,
  modelProblemMessage,
  removeDownloadedModel,
} from "../../src/speechModel";

/**
 * The model the package carries: its files in models/ against their pins,
 * the check a start makes and when it is made again, what a start and Show
 * Diagnostics say about a file that is missing or changed, the removal of a
 * copy an earlier version downloaded into global storage, and that nothing
 * in the extension can make a network request. The checks run on real files,
 * in fresh directories under the system temp directory.
 */

const REPO = path.join(__dirname, "..", "..");
const BUNDLED = modelDirectory(REPO);

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-word-model-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of the bundled model in a fresh directory, to damage. */
function copyOfModel(): string {
  const dir = path.join(tempDir(), KWS_MODEL.name);
  fs.mkdirSync(dir);
  for (const file of KWS_MODEL.files) {
    fs.copyFileSync(path.join(BUNDLED, file.name), path.join(dir, file.name));
  }
  return dir;
}

describe("the bundled model", () => {
  it("is under models/ in the extension, in a directory named after the model", () => {
    expect(MODELS_DIR).toBe("models");
    expect(modelDirectory("/ext")).toBe(
      path.join("/ext", "models", "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01")
    );
  });

  it("is the three int8 networks and tokens.txt the engine loads, and bpe.model the tokeniser reads", () => {
    expect(KWS_MODEL.files.map((file) => file.name)).toEqual([
      "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      "tokens.txt",
      "bpe.model",
    ]);
  });

  it("is in the repository with each file the one pinned, so no checkout has changed one", () => {
    for (const file of KWS_MODEL.files) {
      const content = fs.readFileSync(path.join(BUNDLED, file.name));
      expect(content.length, file.name).toBe(file.bytes);
      expect(createHash("sha256").update(content).digest("hex"), file.name).toBe(file.sha256);
    }
  });

  it("holds nothing but those files", () => {
    expect(fs.readdirSync(BUNDLED).sort()).toEqual(KWS_MODEL.files.map((file) => file.name).sort());
  });

  it("passes the check a start makes", async () => {
    expect(await checkModel(BUNDLED)).toBeNull();
  });
});

describe("the check of the model's files", () => {
  it("names a file that is missing", async () => {
    const dir = copyOfModel();
    fs.unlinkSync(path.join(dir, "tokens.txt"));
    expect(await checkModel(dir)).toEqual({ kind: "missing", file: path.join(dir, "tokens.txt") });
  });

  it("finds every file missing from a directory that does not exist", async () => {
    const dir = path.join(tempDir(), "no-such-model");
    expect(await checkModel(dir)).toEqual({ kind: "missing", file: path.join(dir, KWS_MODEL.files[0].name) });
  });

  it("names a file whose content is not the file pinned", async () => {
    const dir = copyOfModel();
    const encoder = path.join(dir, KWS_MODEL.files[0].name);
    const content = fs.readFileSync(encoder);
    content[content.length >> 1] ^= 0xff;
    fs.writeFileSync(encoder, content);
    expect(await checkModel(dir)).toEqual({ kind: "changed", file: encoder });
  });

  it("names a file of another size", async () => {
    const dir = copyOfModel();
    const tokens = path.join(dir, "tokens.txt");
    // The line endings a text conversion on checkout would write.
    fs.writeFileSync(tokens, fs.readFileSync(tokens, "latin1").replace(/\n/g, "\r\n"), "latin1");
    expect(await checkModel(dir)).toEqual({ kind: "changed", file: tokens });
  });

  it("names a file that cannot be read, with the reason", async () => {
    const dir = copyOfModel();
    const bpe = path.join(dir, "bpe.model");
    fs.unlinkSync(bpe);
    fs.mkdirSync(bpe);
    const problem = await checkModel(dir);
    expect(problem).toMatchObject({ kind: "unreadable", file: bpe });
    expect(problem?.kind === "unreadable" && problem.reason).toBeTruthy();
  });

  it("reads a directory that passed only once in a session", async () => {
    const dir = copyOfModel();
    expect(await checkModel(dir)).toBeNull();
    fs.unlinkSync(path.join(dir, "bpe.model"));
    expect(await checkModel(dir)).toBeNull();
  });

  it("looks again after a check that found a problem", async () => {
    const dir = copyOfModel();
    const tokens = path.join(dir, "tokens.txt");
    const saved = fs.readFileSync(tokens);
    fs.unlinkSync(tokens);
    expect(await checkModel(dir)).toMatchObject({ kind: "missing" });
    fs.writeFileSync(tokens, saved);
    expect(await checkModel(dir)).toBeNull();
  });
});

describe("what a start and Show Diagnostics say about the model", () => {
  const file = path.join("/ext", "models", KWS_MODEL.name, "tokens.txt");

  it("tells a start which file is missing, and to reinstall", () => {
    expect(modelProblemMessage({ kind: "missing", file })).toBe(
      `The speech model is missing from this installation: ${file} does not exist. ` +
        "Reinstall the Wake Word extension."
    );
  });

  it("tells a start which file cannot be read, and why", () => {
    expect(modelProblemMessage({ kind: "unreadable", file, reason: "EACCES: permission denied" })).toBe(
      `The speech model in this installation cannot be read: ${file}: EACCES: permission denied. ` +
        "Reinstall the Wake Word extension."
    );
  });

  it("tells a start which file is damaged", () => {
    expect(modelProblemMessage({ kind: "changed", file })).toBe(
      `The speech model in this installation is damaged: ${file} is not the file ` +
        "the extension was packaged with. Reinstall the Wake Word extension."
    );
  });

  it("sums the check up for the Model line of Show Diagnostics", () => {
    expect(describeModelCheck(null)).toBe("bundled, every file matches its pinned SHA-256");
    expect(describeModelCheck({ kind: "missing", file })).toBe("bundled, tokens.txt is missing");
    expect(describeModelCheck({ kind: "unreadable", file, reason: "EACCES" })).toBe(
      "bundled, tokens.txt cannot be read"
    );
    expect(describeModelCheck({ kind: "changed", file })).toBe(
      "bundled, tokens.txt does not match its pinned SHA-256"
    );
  });
});

describe("the copy an earlier version downloaded into global storage", () => {
  /** Every file that download extracted, under sherpa-onnx/<model name>/. */
  const DOWNLOADED = [
    "README.md",
    "bpe.model",
    "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
    "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
    "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "joiner-epoch-12-avg-2-chunk-16-left-64.onnx",
    "keywords.txt",
    "keywords_raw.txt",
    "test_wavs/0.wav",
    "test_wavs/1.wav",
    "test_wavs/test_keywords.txt",
    "test_wavs/trans.txt",
    "tokens.txt",
  ];

  /** Write the layout that download left in `storage`; returns the bytes written. */
  function downloadedCopy(storage: string, options: { archive?: boolean } = {}): number {
    const root = path.join(storage, "sherpa-onnx");
    const dir = path.join(root, KWS_MODEL.name);
    fs.mkdirSync(path.join(dir, "test_wavs"), { recursive: true });
    let bytes = 0;
    const write = (file: string, content: string): void => {
      fs.writeFileSync(file, content);
      bytes += Buffer.byteLength(content);
    };
    DOWNLOADED.forEach((name, i) => write(path.join(dir, ...name.split("/")), "x".repeat(10 + i)));
    write(path.join(root, "version.txt"), "1");
    if (options.archive) {
      write(path.join(root, `${KWS_MODEL.name}.tar.gz`), "partial archive");
    }
    return bytes;
  }

  it("is removed file by file, with the directories it leaves empty", async () => {
    const storage = tempDir();
    const bytes = downloadedCopy(storage);
    fs.writeFileSync(path.join(storage, "wake-word.lock"), "1234");

    expect(await removeDownloadedModel(storage)).toEqual({ files: DOWNLOADED.length + 1, bytes });
    expect(fs.readdirSync(storage)).toEqual(["wake-word.lock"]);
  });

  it("takes an archive a download left unfinished with it", async () => {
    const storage = tempDir();
    const bytes = downloadedCopy(storage, { archive: true });

    expect(await removeDownloadedModel(storage)).toEqual({ files: DOWNLOADED.length + 2, bytes });
    expect(fs.existsSync(path.join(storage, "sherpa-onnx"))).toBe(false);
  });

  it("keeps a file it did not write, and the directories that hold it", async () => {
    const storage = tempDir();
    downloadedCopy(storage);
    const root = path.join(storage, "sherpa-onnx");
    const kept = path.join(root, KWS_MODEL.name, "notes.txt");
    fs.writeFileSync(kept, "mine");
    fs.writeFileSync(path.join(root, "other.bin"), "mine too");

    await removeDownloadedModel(storage);
    expect(fs.readdirSync(root).sort()).toEqual(["other.bin", KWS_MODEL.name]);
    expect(fs.readdirSync(path.join(root, KWS_MODEL.name))).toEqual(["notes.txt"]);
  });

  it("removes what is there of a copy that was never finished", async () => {
    const storage = tempDir();
    const dir = path.join(storage, "sherpa-onnx", KWS_MODEL.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tokens.txt"), "half");

    expect(await removeDownloadedModel(storage)).toEqual({ files: 1, bytes: 4 });
    expect(fs.readdirSync(storage)).toEqual([]);
  });

  it("changes nothing where there is no downloaded copy", async () => {
    const storage = tempDir();
    fs.writeFileSync(path.join(storage, "wake-word.lock"), "1234");
    expect(await removeDownloadedModel(storage)).toEqual({ files: 0, bytes: 0 });
    expect(fs.readdirSync(storage)).toEqual(["wake-word.lock"]);
    expect(await removeDownloadedModel(path.join(storage, "not-created-yet"))).toEqual({ files: 0, bytes: 0 });
  });
});

describe("network access", () => {
  /** Node modules that open network connections, with or without the node: prefix. */
  const NETWORK_MODULES = new Set(["dgram", "dns", "http", "http2", "https", "net", "tls", "undici"]);

  it("is none: no module of the extension imports a network module or calls fetch", () => {
    const src = path.join(REPO, "src");
    for (const name of fs.readdirSync(src).filter((file) => file.endsWith(".ts"))) {
      const text = fs.readFileSync(path.join(src, name), "utf8");
      const imported = [...text.matchAll(/\bfrom\s+"([^"]+)"|\brequire\(\s*"([^"]+)"\s*\)|\bimport\(\s*"([^"]+)"\s*\)/g)]
        .map((match) => (match[1] ?? match[2] ?? match[3]).replace(/^node:/, ""))
        .filter((module) => NETWORK_MODULES.has(module));
      expect(imported, name).toEqual([]);
      expect(/\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\bEventSource\b/.test(text), name).toBe(false);
    }
  });
});
