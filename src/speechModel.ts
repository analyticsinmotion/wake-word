import { createHash } from "crypto";
import { readFile, rmdir, stat, unlink } from "fs/promises";
import * as path from "path";

/**
 * The keyword spotting model, which ships inside the extension package.
 *
 * The model's files are kept in the repository under models/, and the package
 * carries them at the same path, so the engine and the tokeniser read them
 * from the installed extension: listening needs no download and no network
 * access. Everything that names the model's files or their place reads them
 * from here: the engine's start, Show Diagnostics, the package check in
 * scripts/verify-vsix.mjs, and the copy scripts/fetch-model.mjs makes for the
 * tests. Another model would be another SpeechModel, with its files in a
 * directory of its own under models/.
 *
 * Each file is pinned by size and SHA-256. scripts/verify-vsix.mjs fails a
 * package whose copy of a file differs, and checkModel() checks the installed
 * copies before the first start of a session, so a damaged installation is
 * reported by the name of the file instead of reaching the native library,
 * which can end the engine's process on a model it cannot read.
 *
 * Nothing here imports `vscode`, so the scripts can load the compiled module.
 */

/** The directory of the extension that holds one directory per model. */
export const MODELS_DIR = "models";

/** A file of a model, as the package carries it. */
export interface ModelFile {
  /** Its name inside the model's directory. */
  readonly name: string;
  readonly bytes: number;
  /** SHA-256 of the file, in lower-case hex. */
  readonly sha256: string;
}

/** A model the package carries: a directory under MODELS_DIR, and its files. */
export interface SpeechModel {
  /** The directory's name, which is the name the model's publisher gives it. */
  readonly name: string;
  readonly files: readonly ModelFile[];
}

/**
 * The sherpa-onnx English keyword spotting model from the k2-fsa project: a
 * streaming Zipformer transducer of about 3.3 million parameters, published
 * under the Apache License 2.0. The engine loads the three int8 networks and
 * tokens.txt, and the tokeniser reads bpe.model and tokens.txt. Each file is
 * byte for byte the publisher's.
 */
export const KWS_MODEL: SpeechModel = {
  name: "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
  files: [
    {
      name: "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      bytes: 4_807_159,
      sha256: "1e721676515bcd42a186979733981213c66c80db680e1cc582dfedf3be76e678",
    },
    {
      name: "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      bytes: 277_985,
      sha256: "e40ff43297abe815e8898494c17e71bba2152d9d40fa3eb803f75d0f7533329a",
    },
    {
      name: "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      bytes: 163_380,
      sha256: "eae9da0c7e1e6c6a3f4cc42d167899c388f6c6701b94cb96320e4f55df79624c",
    },
    {
      name: "tokens.txt",
      bytes: 5_006,
      sha256: "fd2ded4050a55d2b1578870ba8697d02371980217806b7558bd0a5cc60f3ba53",
    },
    {
      name: "bpe.model",
      bytes: 244_837,
      sha256: "c8a2a0129c4ab8e463164c142f82d25649661b122c8cd0b7aab5c9e80b90ad24",
    },
  ],
};

/** Where `model` is in the extension whose root directory is `extensionRoot`. */
export function modelDirectory(extensionRoot: string, model: SpeechModel = KWS_MODEL): string {
  return path.join(extensionRoot, MODELS_DIR, model.name);
}

// -- Checking the installed files --------------------------------------------

/** The first file of a model that is missing, cannot be read, or is not the file pinned. */
export type ModelProblem =
  | { readonly kind: "missing"; readonly file: string }
  | { readonly kind: "unreadable"; readonly file: string; readonly reason: string }
  | { readonly kind: "changed"; readonly file: string };

async function inspectModel(dir: string, model: SpeechModel): Promise<ModelProblem | null> {
  for (const pinned of model.files) {
    const file = path.join(dir, pinned.name);
    let content: Buffer;
    try {
      content = await readFile(file);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { kind: "missing", file };
      }
      return { kind: "unreadable", file, reason: err instanceof Error ? err.message : String(err) };
    }
    if (content.length !== pinned.bytes || createHash("sha256").update(content).digest("hex") !== pinned.sha256) {
      return { kind: "changed", file };
    }
  }
  return null;
}

/** The check of each model directory, made once per session while it passes. */
const checks = new Map<string, Promise<ModelProblem | null>>();

/**
 * Check every file of `model` in `dir` against its pinned size and SHA-256.
 * Resolves to the first problem, or to null when every file is the one the
 * package was built with, and never rejects.
 *
 * The files, about 5.5 MB, are read on the first call for a directory, and a
 * directory that passes is not read again in the session. A check that finds
 * a problem is not kept, so the next call looks again.
 */
export function checkModel(dir: string, model: SpeechModel = KWS_MODEL): Promise<ModelProblem | null> {
  let entry = checks.get(dir);
  if (!entry) {
    const checking = inspectModel(dir, model);
    checks.set(dir, checking);
    void checking.then((problem) => {
      if (problem && checks.get(dir) === checking) {
        checks.delete(dir);
      }
    });
    entry = checking;
  }
  return entry;
}

/** The error a start reports for `problem`: the file, what is wrong with it, and what to do. */
export function modelProblemMessage(problem: ModelProblem): string {
  switch (problem.kind) {
    case "missing":
      return (
        `The speech model is missing from this installation: ${problem.file} does not exist. ` +
        "Reinstall the Wake Word extension."
      );
    case "unreadable":
      return (
        `The speech model in this installation cannot be read: ${problem.file}: ${problem.reason}. ` +
        "Reinstall the Wake Word extension."
      );
    case "changed":
      return (
        `The speech model in this installation is damaged: ${problem.file} is not the file ` +
        "the extension was packaged with. Reinstall the Wake Word extension."
      );
  }
}

/** What the check found, for Show Diagnostics' `Model:` line. */
export function describeModelCheck(problem: ModelProblem | null): string {
  if (!problem) {
    return "bundled, every file matches its pinned SHA-256";
  }
  const name = path.basename(problem.file);
  switch (problem.kind) {
    case "missing":
      return `bundled, ${name} is missing`;
    case "unreadable":
      return `bundled, ${name} cannot be read`;
    case "changed":
      return `bundled, ${name} does not match its pinned SHA-256`;
  }
}

// -- The copy in global storage ----------------------------------------------

/** Where an earlier version of the extension downloaded the model, in its global storage. */
const DOWNLOAD_DIR = "sherpa-onnx";
/** The model that download held, by its archive's directory name. */
const DOWNLOADED_MODEL = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
/** Every file the downloaded archive held, as extracted under DOWNLOADED_MODEL. */
const DOWNLOADED_FILES = [
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

/** What removeDownloadedModel() removed. */
export interface RemovedModel {
  files: number;
  bytes: number;
}

/**
 * Remove the copy of the model that an earlier version of the extension
 * downloaded into `storagePath`, its global storage. Nothing reads that copy:
 * the model the package carries is the one listening uses.
 *
 * Only the files that download wrote are removed, each by name: the files of
 * the archive, the version marker beside them, and an archive left by a
 * download that did not finish. Their directories go only once they are
 * empty, so a file put there by anything else stays, and so does everything
 * else in global storage, the listener lock included. A file that cannot be
 * removed now, such as one open in a window still running an earlier
 * version, is left for a later session. Never rejects.
 */
export async function removeDownloadedModel(storagePath: string): Promise<RemovedModel> {
  const root = path.join(storagePath, DOWNLOAD_DIR);
  const dir = path.join(root, DOWNLOADED_MODEL);
  const files = [
    ...DOWNLOADED_FILES.map((name) => path.join(dir, ...name.split("/"))),
    path.join(root, "version.txt"),
    path.join(root, `${DOWNLOADED_MODEL}.tar.gz`),
  ];
  const removed: RemovedModel = { files: 0, bytes: 0 };
  for (const file of files) {
    try {
      const { size } = await stat(file);
      await unlink(file);
      removed.files++;
      removed.bytes += size;
    } catch {
      // Not there, or in use: nothing to remove now.
    }
  }
  for (const emptied of [path.join(dir, "test_wavs"), dir, root]) {
    try {
      await rmdir(emptied);
    } catch {
      // Not there, or it holds something this did not write.
    }
  }
  return removed;
}
