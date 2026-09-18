import { readFile } from "fs/promises";
import * as path from "path";
import { Worker } from "worker_threads";
import { parseVocabulary } from "./keywords";

/**
 * The model files the keyword lines are built from: the SentencePiece model
 * that turns a phrase into pieces, and the token table the spotter looks
 * every piece up in.
 *
 * Tokenising runs in a worker thread, never on the extension host's own
 * thread. sentencepiece-js is SentencePiece compiled to WebAssembly, and the
 * JavaScript that loads its module treats whatever process loads it as its
 * own: every load adds an `uncaughtException` listener that rethrows and an
 * `unhandledRejection` listener that throws. Every extension shares the
 * extension host, and a listener that throws from `uncaughtException` ends
 * the process, so one stray error in any extension would take them all down.
 * The listeners also keep each load's 16 MB WebAssembly heap reachable. A
 * worker has a `process` object of its own, so the listeners attach to that
 * one and go, heap and all, when the worker ends.
 */

/** The SentencePiece model inside the model directory. */
export const TOKENISER_MODEL_FILE = "bpe.model";
/** The spotter's token table inside the model directory. */
export const TOKENS_FILE = "tokens.txt";

/**
 * How long the worker may take before it is stopped. Loading the model and
 * tokenising a few phrases takes tens of milliseconds; the cap is there so a
 * worker that never answers cannot leave a start waiting for ever.
 */
export const TOKENISE_TIMEOUT_MS = 30_000;

/**
 * The worker's source, evaluated as it stands. It loads the model, encodes
 * every text in order, and posts either the pieces and the time the model
 * finished loading, or the reason it could not. Plain JavaScript, because
 * nothing compiles it.
 *
 * sentencepiece-js ignores the status of its own model load, and a file that
 * is not a SentencePiece model then encodes every text to nothing, which
 * would read as phrases with no pieces. Every model encodes the letter A, so
 * the worker checks that first and reports the file instead.
 */
const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("worker_threads");
const { SentencePieceProcessor } = require(workerData.moduleFile);
const processor = new SentencePieceProcessor();
processor
  .load(workerData.modelFile)
  .then(() => {
    if (processor.encodePieces("A").length === 0) {
      throw new Error(workerData.modelFile + " is not a SentencePiece model the tokeniser can load");
    }
    const loadedAt = Date.now();
    const pieces = workerData.texts.map((text) => processor.encodePieces(text));
    parentPort.postMessage({ pieces, loadedAt });
  })
  .catch((error) => {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  });
`;

/** What the worker found. */
export interface Tokenised {
  /** The pieces for each text, in the order the texts were given. */
  pieces: string[][];
  /** When the model had loaded and encoding began, as a Date.now() time. */
  loadedAt: number;
}

export interface TokeniseOptions {
  /** The sentencepiece-js entry point. Tests substitute a stand-in. */
  moduleFile?: string;
  timeoutMs?: number;
}

function isTokenised(message: unknown, count: number): message is Tokenised {
  if (!message || typeof message !== "object") {
    return false;
  }
  const { pieces, loadedAt } = message as Record<string, unknown>;
  return (
    typeof loadedAt === "number" &&
    Array.isArray(pieces) &&
    pieces.length === count &&
    pieces.every((list) => Array.isArray(list) && list.every((piece) => typeof piece === "string"))
  );
}

function describeFailure(message: unknown): string {
  if (message && typeof message === "object" && typeof (message as { error?: unknown }).error === "string") {
    return (message as { error: string }).error;
  }
  return "the tokeniser returned something other than pieces";
}

/**
 * Encode each text into the pieces of the model in `modelDir`, in a worker
 * thread. Rejects with the reason when the model cannot be loaded, the worker
 * fails, or it does not answer within the timeout.
 */
export async function tokenise(
  modelDir: string,
  texts: readonly string[],
  options: TokeniseOptions = {}
): Promise<Tokenised> {
  const moduleFile = options.moduleFile ?? require.resolve("sentencepiece-js");
  const timeoutMs = options.timeoutMs ?? TOKENISE_TIMEOUT_MS;
  const modelFile = path.join(modelDir, TOKENISER_MODEL_FILE);

  return new Promise<Tokenised>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { moduleFile, modelFile, texts: [...texts] },
    });
    let settled = false;
    // Every caller of finish() is an event or the timer below, so the timer
    // exists by the time it is cleared.
    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`the tokeniser did not answer within ${timeoutMs / 1000}s`))),
      timeoutMs
    );

    worker.on("message", (message: unknown) =>
      finish(() =>
        isTokenised(message, texts.length) ? resolve(message) : reject(new Error(describeFailure(message)))
      )
    );
    worker.on("error", (err: Error) => finish(() => reject(err)));
    worker.on("exit", (code: number) =>
      finish(() => reject(new Error(`the tokeniser stopped before it answered (exit code ${code})`)))
    );
  });
}

/** Every token in the model's token table. */
export async function readVocabulary(modelDir: string): Promise<Set<string>> {
  return parseVocabulary(await readFile(path.join(modelDir, TOKENS_FILE), "utf8"));
}
