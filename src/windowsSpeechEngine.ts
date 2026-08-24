import { EventEmitter } from "events";
import { spawn, ChildProcess } from "child_process";
import { ISpeechEngine, WakePhrase } from "./speechEngineInterface";
import {
  clampThreshold,
  matchRoute,
  normalizePhrases,
  parseEngineLine,
  parsePowerShellError,
  splitLines,
} from "./wakeWordCore";

/**
 * Speech recognition engine for Windows wake word detection.
 *
 * Uses the built-in System.Speech.Recognition engine via a PowerShell
 * child process. No API keys, no model downloads, no system dependencies
 * beyond what ships with Windows.
 *
 * The engine uses a constrained grammar built from the configured
 * wake phrases for accurate matching.
 */
export class WindowsSpeechEngine extends EventEmitter implements ISpeechEngine {
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

  get isListening(): boolean {
    return this._isListening;
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  start(phrases: WakePhrase[], confidenceThreshold = 0.3, debugMode = false): void {
    if (this._isListening) {
      return;
    }

    // Clean up any orphaned process from a previous session
    this.killProcess();

    this._killedIntentionally = false;
    this.currentPhrases = phrases;
    const safeThreshold = clampThreshold(confidenceThreshold);
    this.currentThreshold = safeThreshold;
    this.currentDebugMode = debugMode;
    const phraseStrings = phrases.flatMap((p) => normalizePhrases(p.phrase));
    const script = this.buildScript(phraseStrings, safeThreshold, debugMode);
    const encoded = Buffer.from(script, "utf16le").toString("base64");

    const psPath = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const psArgs = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
    this.emit("debug", `Spawning: ${psPath} (args: ${psArgs.length}, encoded len: ${encoded.length}, SystemRoot: ${process.env.SystemRoot})`);

    this.process = spawn(psPath, psArgs,
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdoutBuffer = "";
    let stderrBuffer = "";

    this.process.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const split = splitLines(stdoutBuffer);
      stdoutBuffer = split.rest;

      for (const line of split.lines) {
        // A malformed DETECTED line defaults to confidence 0 so it can never
        // clear the configured threshold.
        const event = parseEngineLine(line, 0);
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
            // System.Speech returns a real score, so it is reported as given.
            this.emit("detected", match, event.confidence);
          }
        }
        // This engine never sends RELEASED: process exit is the release.
      }
    });

    // Buffer stderr — PowerShell sends CLIXML in multiple chunks,
    // so we wait for process exit to parse the complete message.
    this.process.stderr?.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();
    });

    this.process.on("error", (err) => {
      this._isListening = false;
      this._isPaused = false;
      this.process = null;
      this.emit(
        "error",
        new Error("Failed to start speech engine: " + err.message)
      );
    });

    this.process.on("exit", (code) => {
      const wasListening = this._isListening;
      this._isListening = false;
      this.process = null;

      this.emit("debug", `Process exited: code=${code}, killed=${this._killedIntentionally}, stderr=${JSON.stringify(stderrBuffer.trim())}`);

      // Ignore intentional kills (stop/pause)
      if (this._killedIntentionally) {
        if (wasListening && !this._isPaused) {
          this.emit("stopped");
        }
        return;
      }

      // Non-zero exit = crash. Retry or report error.
      if (code !== 0) {
        const stderrMsg = stderrBuffer.trim() ? parsePowerShellError(stderrBuffer) : "";
        const msg = stderrMsg || `exit code ${code}`;

        if (this.retryCount < WindowsSpeechEngine.MAX_RETRIES) {
          const delay = WindowsSpeechEngine.RETRY_DELAYS[this.retryCount];
          this.retryCount++;
          this.emit("warning", `Speech engine crashed: ${msg}. Retrying in ${delay / 1000}s (attempt ${this.retryCount}/${WindowsSpeechEngine.MAX_RETRIES})...`);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.start(this.currentPhrases, this.currentThreshold, this.currentDebugMode);
          }, delay);
          return;
        }

        this.emit("error", new Error(`${msg} (failed after ${WindowsSpeechEngine.MAX_RETRIES} retries)`));
        return;
      }

      // Clean exit (code 0) while listening = unexpected stop
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

    // Don't clear _isPaused here — start() will clear it via the
    // "started" event when the engine is actually ready. If start()
    // fails, we remain in the paused state.
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

  /**
   * Kill the speech process, which is what releases the microphone.
   *
   * There is no RELEASED message to wait for here, and none is needed:
   * System.Speech holds the capture device for the lifetime of the PowerShell
   * process and Windows reclaims it when that process dies. Exit is the
   * acknowledgement, so the exit is logged rather than assumed.
   */
  private killProcess(): void {
    if (this.process) {
      const proc = this.process;
      this._killedIntentionally = true;
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners();
      proc.once("exit", () => {
        this.emit("debug", "Mic release: speech process exited");
      });
      try {
        proc.kill();
      } catch {
        // Process may have already exited
      }
      this.process = null;
    }
  }

  private buildScript(phrases: string[], confidenceThreshold: number, debugMode: boolean): string {
    const escaped = phrases.map((p) => "'" + p.replace(/'/g, "''") + "'");

    return `
try {
    [Console]::Out.WriteLine("DEBUG:loading speech engine...")
    [Console]::Out.Flush()
    Add-Type -AssemblyName System.Speech

    $phrases = @(${escaped.join(", ")})
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    $engine.SetInputToDefaultAudioDevice()

    $choices = New-Object System.Speech.Recognition.Choices
    foreach ($p in $phrases) { $choices.Add($p) }
    $grammar = New-Object System.Speech.Recognition.Grammar(
        (New-Object System.Speech.Recognition.GrammarBuilder($choices))
    )
    $engine.LoadGrammar($grammar)

    [Console]::Out.WriteLine("READY")
    [Console]::Out.Flush()

    [Console]::Out.WriteLine("DEBUG:entering sync recognize loop")
    [Console]::Out.Flush()
    while ($true) {
        $result = $engine.Recognize([TimeSpan]::FromSeconds(5))
        if ($result -ne $null) {${debugMode ? `
            [Console]::Out.WriteLine("DEBUG:" + $result.Text + "|" + $result.Confidence)
            [Console]::Out.Flush()` : ""}
            if ($result.Confidence -ge ${confidenceThreshold}) {
                [Console]::Out.WriteLine("DETECTED:" + $result.Text.ToLower() + "|" + $result.Confidence)
                [Console]::Out.Flush()
            }
        }
    }
} catch {
    [Console]::Out.WriteLine("ERROR:" + $_.Exception.Message)
    [Console]::Out.Flush()
    exit 1
}
`;
  }
}
