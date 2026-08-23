import { EventEmitter } from "events";
import { spawn, ChildProcess, execSync } from "child_process";
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
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAYS = [2000, 5000, 10000];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly nodePathOverride: string = ""
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

    this.killProcess();

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

    const nodePath = findSystemNode(this.nodePathOverride);
    const engineScript = path.join(path.dirname(__dirname), "engine", "audio-engine.js");
    this.emit("debug", `Spawning: ${nodePath} ${engineScript}`);

    this.process = spawn(nodePath, [engineScript], {
      stdio: ["pipe", "pipe", "pipe"],
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
    };
    this.process.stdin?.write(JSON.stringify(config) + "\n");

    let stdoutBuffer = "";

    this.process.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const split = splitLines(stdoutBuffer);
      stdoutBuffer = split.rest;

      for (const line of split.lines) {
        // audio-engine.js always reports 1.0: the keyword spotter has already
        // applied the threshold, so a missing score means "accepted".
        const event = parseEngineLine(line, 1.0);
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
        } else {
          const match = matchRoute(phrases, event.phrase);
          if (match) {
            this.emit("detected", match, event.confidence);
          }
        }
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

    if (!this._isListening && !this._isPaused) {
      return;
    }

    this._isPaused = false;
    this.killProcess();
    this._isListening = false;
    this.emit("stopped");
  }

  pause(): void {
    if (!this._isListening) {
      return;
    }

    this._isPaused = true;
    this.clearRetryTimer();
    this.killProcess();
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
    this.stop();
    this.removeAllListeners();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private killProcess(): void {
    if (this.process) {
      this._killedIntentionally = true;
      this.process.stdout?.removeAllListeners();
      this.process.stderr?.removeAllListeners();
      // Send stop command before killing so the mic is released cleanly
      try {
        this.process.stdin?.write("stop\n");
        this.process.stdin?.end();
      } catch {
        // Process may have already exited
      }
      this.process.removeAllListeners();
      try {
        this.process.kill();
      } catch {
        // Process may have already exited
      }
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
const MODEL_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/" +
  MODEL_NAME + ".tar.bz2";

const MODEL_FILES = [
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

        function get(url: string): void {
          https.get(url, (res) => {
            if (shouldFollowRedirect(res.statusCode, res.headers.location)) {
              get(res.headers.location as string);
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

      progress.report({ message: "Extracting..." });
      debugLog?.("Extracting " + tarballPath);

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
