import { EventEmitter } from "events";
import { spawn, ChildProcess, execSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, createWriteStream, writeFileSync, readFileSync, unlinkSync } from "fs";
import * as path from "path";
import * as https from "https";
import { pipeline } from "stream/promises";
import * as vscode from "vscode";
import { ISpeechEngine, WakePhrase } from "./speechEngineInterface";
import {
  clampThreshold,
  matchRoute,
  parseEngineLine,
  splitLines,
} from "./wakeWordCore";

/**
 * Cross-platform speech recognition engine using sherpa-onnx keyword spotting.
 *
 * Spawns audio-engine.js as a child process under system Node.js (not Electron),
 * so that native addons (decibri) load against the correct Node.js ABI.
 * sherpa-onnx (WASM) and sentencepiece-js (WASM) are also loaded in the child.
 *
 * Supports Windows, macOS, and Linux.
 */
export class SherpaEngine extends EventEmitter implements ISpeechEngine {
  private process: ChildProcess | null = null;
  private currentPhrases: WakePhrase[] = [];
  private _isListening = false;
  private _isPaused = false;
  private _killedIntentionally = false;
  private currentThreshold = 0.3;
  private currentDebugMode = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Advanced by every start() and stop(). start() awaits the model check
   * before it spawns, and a stop that lands in that window finds no child
   * to kill; the generation is how the start notices afterwards that it
   * has been overtaken and must not spawn.
   */
  private startGeneration = 0;
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAYS = [2000, 5000, 10000];
  /**
   * How long to wait for the child's RELEASED before force killing it.
   *
   * mic.stop() is a device close, not a network call: half a second is
   * generous. The cap exists so a wedged child cannot hold the microphone
   * open, not because the acknowledgement is expected to be slow.
   */
  private static readonly RELEASE_TIMEOUT_MS = 500;

  /**
   * `audioDevice` is the `wakeWord.audioDevice` setting: empty for the
   * system default, otherwise a device index or a case-insensitive name
   * substring. It is fixed for the life of the engine; the extension builds
   * a new engine when the setting changes, as it does for `nodePath`.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly nodePathOverride: string = "",
    private readonly audioDevice: string = ""
  ) {
    super();
  }

  get isListening(): boolean {
    return this._isListening;
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  async start(phrases: WakePhrase[], confidenceThreshold = 0.3, debugMode = false): Promise<void> {
    if (this._isListening) {
      return;
    }

    // A start supersedes any retry still scheduled from a crash. Left armed,
    // it would fire into the fresh child below: a no-op if READY has arrived
    // by then, otherwise a needless kill and respawn mid model load.
    this.clearRetryTimer();
    this.forceKill();
    const generation = ++this.startGeneration;

    this._killedIntentionally = false;
    this.currentPhrases = phrases;
    const safeThreshold = clampThreshold(confidenceThreshold);
    this.currentThreshold = safeThreshold;
    this.currentDebugMode = debugMode;

    // Ensure model is downloaded
    let modelDir: string;
    try {
      modelDir = await ensureModel(this.context, debugMode ? (msg: string) => this.emit("debug", msg) : undefined);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("error", new Error("Model unavailable: " + message));
      return;
    }

    // A stop() or a newer start() landed while the check above was in
    // flight. Neither found a child to deal with, because there was none
    // yet, so this start has to be the one that stands down: spawning now
    // would reopen the microphone after a Disable, or put two children on
    // it after a second start.
    if (generation !== this.startGeneration) {
      this.emit("debug", "Start abandoned: stopped during the model check");
      return;
    }

    const nodePath = findSystemNode(this.nodePathOverride);
    const engineScript = path.join(path.dirname(__dirname), "engine", "audio-engine.js");
    this.emit("debug", `Spawning: ${nodePath} ${engineScript}`);

    this.process = spawn(nodePath, [engineScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // A write to a child that has already exited surfaces EPIPE as an 'error'
    // event on the stream, not as a thrown exception, so the try/catch around
    // each write does not cover it. Without a listener that event takes the
    // extension host down, and the release path deliberately writes to a child
    // that is on its way out.
    this.process.stdin?.on("error", () => {
      /* child is gone; nothing left to say to it */
    });

    // Send config as JSON line then leave stdin open (child reads more commands)
    const config = {
      phrases: phrases.map((p) => ({
        phrase: p.phrase,
        label: p.label,
      })),
      threshold: safeThreshold,
      modelDir,
      debugMode,
      audioDevice: this.audioDevice,
    };
    this.process.stdin?.write(JSON.stringify(config) + "\n");

    let stdoutBuffer = "";

    this.process.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const split = splitLines(stdoutBuffer);
      stdoutBuffer = split.rest;

      for (const line of split.lines) {
        const event = parseEngineLine(line);
        if (!event) {
          continue;
        }

        if (event.type === "ready") {
          this._isListening = true;
          this._isPaused = false;
          this.retryCount = 0;
          this.emit("started");
        } else if (event.type === "debug") {
          this.emit("debug", event.message);
        } else if (event.type === "error") {
          this.emit("error", new Error(event.message));
        } else if (event.type === "detected") {
          const match = matchRoute(phrases, event.phrase);
          if (match) {
            // No confidence: the keyword spotter applied its own threshold
            // and returns no usable score. Reporting one anyway put a
            // meaningless "confidence: 1.00" in every log line.
            this.emit("detected", match, undefined);
          }
        }
        // RELEASED is only of interest while a release is in flight, and
        // releaseThenKill() installs its own listener for it.
      }
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.emit("debug", "stderr: " + data.toString().trim());
    });

    this.process.on("error", (err) => {
      this._isListening = false;
      this._isPaused = false;
      this.process = null;

      if (err.message.includes("ENOENT") || err.message.includes("not found")) {
        this.emit(
          "error",
          new Error(
            "Could not find Node.js. Set `wakeWord.nodePath` in Settings to " +
              "the full path to your node executable."
          )
        );
      } else {
        this.emit("error", new Error("Failed to start audio engine: " + err.message));
      }
    });

    this.process.on("exit", (code) => {
      const wasListening = this._isListening;
      this._isListening = false;
      this.process = null;

      this.emit("debug", `Process exited: code=${code}, killed=${this._killedIntentionally}`);

      if (this._killedIntentionally) {
        if (wasListening && !this._isPaused) {
          this.emit("stopped");
        }
        return;
      }

      if (code !== 0) {
        const msg = `exit code ${code}`;
        if (this.retryCount < SherpaEngine.MAX_RETRIES) {
          const delay = SherpaEngine.RETRY_DELAYS[this.retryCount];
          this.retryCount++;
          this.emit(
            "warning",
            `Audio engine crashed: ${msg}. Retrying in ${delay / 1000}s ` +
              `(attempt ${this.retryCount}/${SherpaEngine.MAX_RETRIES})...`
          );
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.start(this.currentPhrases, this.currentThreshold, this.currentDebugMode);
          }, delay);
          return;
        }

        this.emit("error", new Error(`${msg} (failed after ${SherpaEngine.MAX_RETRIES} retries)`));
        return;
      }

      if (wasListening && !this._isPaused) {
        this.emit("stopped");
      }
    });
  }

  stop(): void {
    // Cancel any pending retry first, before the state guard below.
    //
    // During crash backoff both _isListening and _isPaused are false while a
    // retry timer is armed, so the guard is true. Returning there left the
    // timer running: "Disable Listening" set the status bar to Off and the
    // timer then called start() and reopened the microphone. For an
    // always-listening extension, a disable command that does not disable is
    // a privacy defect, so this runs unconditionally.
    this.clearRetryTimer();
    this.retryCount = 0;
    // Likewise a start() still awaiting the model check: see startGeneration.
    this.startGeneration++;

    // Kill whatever child exists before the state guard, for the same
    // reason. A child that has been spawned but has not yet said READY is
    // neither listening nor paused, and returning early left it to finish
    // loading, open the microphone, and report READY to a stopped engine:
    // Disable, Reset Consent, and an engine switch during that window all
    // ended with the microphone open.
    this.forceKill();

    if (!this._isListening && !this._isPaused) {
      return;
    }

    this._isPaused = false;
    this._isListening = false;
    this.emit("stopped");
  }

  pause(): void {
    if (!this._isListening) {
      // Not listening, but a crash-backoff retry may still be armed. A pause
      // must stop that retry reopening the microphone, and must leave the
      // engine resumable, so it becomes a paused engine with no process.
      if (this.retryTimer) {
        this.clearRetryTimer();
        this._isPaused = true;
        this.emit("paused");
      }
      return;
    }

    this._isPaused = true;
    this.clearRetryTimer();
    this.releaseThenKill();
    this._isListening = false;
    this.emit("paused");
  }

  resume(): void {
    if (!this._isPaused || this.currentPhrases.length === 0) {
      return;
    }

    this.retryCount = 0;
    this.start(this.currentPhrases, this.currentThreshold, this.currentDebugMode);
  }

  dispose(): void {
    this.clearRetryTimer();
    this.clearReleaseTimer();
    this.stop();
    this.removeAllListeners();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  /**
   * Ask the child to close the microphone and wait until it says it has.
   *
   * The extension fires the target command immediately after pause() returns,
   * and that command exists to hand the microphone to something else. The
   * previous behaviour killed the child and assumed the OS had torn the
   * capture device down by the time anything else asked for it, which was
   * only ever usually true. The child now prints RELEASED once mic.stop() has
   * returned, so wait for that line and force kill on a timeout so a wedged
   * child cannot hold the device open indefinitely.
   *
   * pause() stays synchronous: the command fires as soon as it returns and
   * the release completes within the timeout underneath. Ordering the command
   * strictly after RELEASED is a handoff policy change, not this one.
   */
  private releaseThenKill(): void {
    const proc = this.process;
    if (!proc) {
      return;
    }

    this._killedIntentionally = true;
    this.clearReleaseTimer();

    // Take stdout over for the duration: the normal handler must not emit a
    // detection from a process that is already shutting down.
    proc.stdout?.removeAllListeners("data");
    proc.stderr?.removeAllListeners("data");

    let settled = false;
    const finish = (reason: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      this.clearReleaseTimer();
      this.emit("debug", `Mic release: ${reason}`);
      this.forceKill(proc);
    };

    proc.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (parseEngineLine(line)?.type === "released") {
          finish("acknowledged by engine");
          return;
        }
      }
    });

    this.releaseTimer = setTimeout(
      () => finish(`no acknowledgement after ${SherpaEngine.RELEASE_TIMEOUT_MS}ms, forcing`),
      SherpaEngine.RELEASE_TIMEOUT_MS
    );

    if (!this.writeStop(proc)) {
      finish("stdin already closed");
    }
  }

  /**
   * Send the stop command. Returns false when the child is already gone.
   */
  private writeStop(proc: ChildProcess): boolean {
    const stdin = proc.stdin;
    if (!stdin || !stdin.writable || proc.exitCode !== null) {
      return false;
    }
    try {
      stdin.write("stop\n");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Tear the child down now, without waiting for an acknowledgement.
   *
   * `target` defaults to the current child. releaseThenKill() passes the
   * process it captured, because the exit handler may already have cleared
   * `this.process` by the time the acknowledgement or the timeout lands.
   */
  private forceKill(target: ChildProcess | null = this.process): void {
    const proc = target;
    if (!proc) {
      return;
    }

    this._killedIntentionally = true;
    this.clearReleaseTimer();
    proc.stdout?.removeAllListeners();
    proc.stderr?.removeAllListeners();
    // Ask for a clean release first even here: a child that acts on it closes
    // the device itself rather than leaving the OS to reclaim it.
    this.writeStop(proc);
    try {
      proc.stdin?.end();
    } catch {
      // Process may have already exited
    }
    proc.removeAllListeners();
    try {
      proc.kill();
    } catch {
      // Process may have already exited
    }
    if (this.process === proc) {
      this.process = null;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Locate the system Node.js executable.
 *
 * Resolution order:
 *   1. wakeWord.nodePath user setting (highest priority)
 *   2. `where node` / `which node` shell command
 *   3. Well-known install paths per platform
 *   4. Bare 'node' as last resort
 */
export function findSystemNode(override?: string): string {
  if (override) return override;

  try {
    const cmd = process.platform === "win32" ? "where node" : "which node";
    const result = execSync(cmd, { encoding: "utf8" }).trim().split("\n")[0].trim();
    if (result) return result;
  } catch {
    // fall through
  }

  const wellKnown =
    process.platform === "win32"
      ? ["C:\\Program Files\\nodejs\\node.exe"]
      : process.platform === "darwin"
      ? ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
      : ["/usr/bin/node", "/usr/local/bin/node"];

  for (const p of wellKnown) {
    if (existsSync(p)) return p;
  }

  return "node";
}

// ── Model management ─────────────────────────────────────────

const MODEL_VERSION = "1";
/** Exported for tests/acoustic, which carries its own copy and checks it against this. */
export const MODEL_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/" +
  MODEL_NAME + ".tar.bz2";

/**
 * SHA-256 of the model tarball at MODEL_URL (17,626,723 bytes).
 *
 * The download follows HTTP redirects to a CDN host and the result is fed
 * straight into the keyword spotter, so nothing but this digest stands
 * between a hijacked redirect and a model of someone else's choosing loading
 * on the user's machine. Recompute and update this whenever MODEL_URL or
 * MODEL_VERSION changes:
 *
 *   curl -L -o model.tar.bz2 "<MODEL_URL>"
 *   shasum -a 256 model.tar.bz2      # certutil -hashfile model.tar.bz2 SHA256
 */
export const MODEL_SHA256 =
  "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a";

/**
 * Redirect hops the model download will follow before giving up.
 *
 * GitHub answers a release asset with one 302 to a CDN host, so at least one
 * hop is required. The cap stops a redirect loop from recursing until the
 * extension host runs out of stack.
 */
export const MAX_REDIRECTS = 5;

export const MODEL_FILES = [
  "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "tokens.txt",
  "bpe.model",
];

/**
 * True when an HTTP response is a redirect the downloader should follow.
 *
 * GitHub release assets answer with a 302 to a CDN host, so the model
 * download has to follow at least one hop to reach the tarball.
 */
export function shouldFollowRedirect(
  statusCode: number | undefined,
  location: string | undefined
): boolean {
  return (
    statusCode !== undefined &&
    statusCode >= 300 &&
    statusCode < 400 &&
    typeof location === "string" &&
    location.length > 0
  );
}

/** True once the downloader has followed as many redirects as it will. */
export function redirectLimitExceeded(hops: number, max: number = MAX_REDIRECTS): boolean {
  return hops >= max;
}

/**
 * Throw unless the downloaded tarball matches the expected digest.
 *
 * Runs before extraction, so a tampered or truncated download never reaches
 * `tar` and never reaches the keyword spotter. The message carries a prefix
 * of each digest: enough to tell a corrupted download from a substituted one
 * in a bug report, without a wall of hex in a notification.
 */
export function verifyModelHash(actual: string, expected: string = MODEL_SHA256): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      "Model integrity check failed. Expected SHA-256 " +
        `${expected.substring(0, 16)}..., got ${actual.substring(0, 16)}...: ` +
        "the download may be corrupted or tampered with."
    );
  }
}

/**
 * Ensure the KWS model is downloaded to globalStorage.
 * Returns the path to the model directory.
 */
export async function ensureModel(
  context: vscode.ExtensionContext,
  debugLog?: (msg: string) => void
): Promise<string> {
  const storageUri = context.globalStorageUri;
  const modelDir = path.join(storageUri.fsPath, "sherpa-onnx", MODEL_NAME);
  const versionFile = path.join(storageUri.fsPath, "sherpa-onnx", "version.txt");

  // Check if model is already present and version matches
  const allFilesPresent = MODEL_FILES.every((f) => existsSync(path.join(modelDir, f)));
  let versionMatch = false;
  if (allFilesPresent && existsSync(versionFile)) {
    try {
      versionMatch = readFileSync(versionFile, "utf8").trim() === MODEL_VERSION;
    } catch {
      versionMatch = false;
    }
  }

  if (allFilesPresent && versionMatch) {
    debugLog?.("Model already present at " + modelDir);
    return modelDir;
  }

  // Model missing or outdated — download
  return downloadModel(context, modelDir, versionFile, debugLog);
}

async function downloadModel(
  context: vscode.ExtensionContext,
  modelDir: string,
  versionFile: string,
  debugLog?: (msg: string) => void
): Promise<string> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Wake Word: Downloading speech model (~17MB)...",
      cancellable: false,
    },
    async (progress) => {
      const storageDir = path.dirname(modelDir);
      mkdirSync(storageDir, { recursive: true });

      debugLog?.("Downloading model from " + MODEL_URL);
      progress.report({ message: "Connecting..." });

      const tarballPath = path.join(storageDir, MODEL_NAME + ".tar.bz2");

      // Download tarball (following redirects — GitHub releases return 302 → CDN)
      await new Promise<void>((resolve, reject) => {
        const file = createWriteStream(tarballPath);

        function get(url: string, hops = 0): void {
          https.get(url, (res) => {
            if (shouldFollowRedirect(res.statusCode, res.headers.location)) {
              if (redirectLimitExceeded(hops)) {
                res.resume();
                reject(
                  new Error(`Too many redirects (over ${MAX_REDIRECTS}) downloading model`)
                );
                return;
              }
              get(res.headers.location as string, hops + 1);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode} downloading model`));
              return;
            }
            const total = parseInt(res.headers["content-length"] || "0", 10);
            let received = 0;
            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              if (total > 0) {
                progress.report({
                  message: `${Math.round((received / total) * 100)}%`,
                  increment: (chunk.length / total) * 100,
                });
              }
            });
            pipeline(res, file).then(resolve).catch(reject);
          }).on("error", reject);
        }

        get(MODEL_URL);
      });

      // Verify before extraction. The download followed redirects to a CDN
      // host and the files inside are loaded straight into the keyword
      // spotter, so a bad tarball must never reach `tar`.
      progress.report({ message: "Verifying..." });
      const actualHash = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
      debugLog?.("Model SHA-256: " + actualHash);
      try {
        verifyModelHash(actualHash);
      } catch (err) {
        // Leaving a rejected tarball on disk would have the next attempt
        // resume against a file that is already known bad.
        try {
          unlinkSync(tarballPath);
        } catch {
          // non-fatal
        }
        throw err;
      }

      progress.report({ message: "Extracting..." });
      debugLog?.("Extracting " + tarballPath);

      // The tarball's entries are all under a single MODEL_NAME directory, so
      // this lands on modelDir directly.
      // Use system tar (available on macOS and Linux where SherpaEngine is used)
      execSync(`tar -xjf "${tarballPath}" -C "${storageDir}"`);

      // Write version file
      writeFileSync(versionFile, MODEL_VERSION, "utf8");

      // Clean up tarball
      try {
        unlinkSync(tarballPath);
      } catch {
        // non-fatal
      }

      debugLog?.("Model ready at " + modelDir);
      return modelDir;
    }
  );
}
