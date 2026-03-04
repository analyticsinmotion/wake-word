import { EventEmitter } from "events";
import { spawn, ChildProcess } from "child_process";
import * as os from "os";

export interface WakePhrase {
  label: string;
  phrase: string;
  command: string;
}

/**
 * Speech recognition engine for wake word detection.
 *
 * On Windows, uses the built-in System.Speech.Recognition engine
 * via a PowerShell child process. No API keys, no model downloads,
 * no system dependencies beyond what ships with Windows.
 *
 * The engine uses a dictation grammar and matches recognised text
 * against the configured wake phrases using prefix matching.
 */
export class SpeechEngine extends EventEmitter {
  private process: ChildProcess | null = null;
  private currentPhrases: WakePhrase[] = [];
  private _isListening = false;
  private _isPaused = false;
  private _killedIntentionally = false;

  get isListening(): boolean {
    return this._isListening;
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  start(phrases: WakePhrase[]): void {
    if (this._isListening) {
      return;
    }

    // Clean up any orphaned process from a previous session
    this.killProcess();

    if (os.platform() !== "win32") {
      this.emit(
        "error",
        new Error(
          "Wake Word currently supports Windows only. " +
            "macOS and Linux support is planned for a future release."
        )
      );
      return;
    }

    this._killedIntentionally = false;
    this.currentPhrases = phrases;
    const phraseStrings = phrases.map((p) => p.phrase.toLowerCase().trim());
    const script = this.buildScript(phraseStrings);
    const encoded = Buffer.from(script, "utf16le").toString("base64");

    this.process = spawn(
      `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );

    let stdoutBuffer = "";
    let stderrBuffer = "";

    this.process.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === "READY") {
          this._isListening = true;
          this._isPaused = false;
          this.emit("started");
        } else if (trimmed.startsWith("DETECTED:")) {
          const detected = trimmed.substring(9).toLowerCase().trim();
          const match = phrases.find(
            (p) => p.phrase.toLowerCase().trim() === detected
          );
          if (match) {
            this.emit("detected", match);
          }
        }
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

    this.process.on("exit", () => {
      const wasListening = this._isListening;
      this._isListening = false;
      this.process = null;

      // Ignore stderr from intentional kills (stop/pause)
      if (!this._killedIntentionally && stderrBuffer.trim()) {
        const msg = this.parseStderr(stderrBuffer);
        this.emit("error", new Error(msg));
        return;
      }

      // Only emit stopped if we were actively listening (not paused)
      if (wasListening && !this._isPaused) {
        this.emit("stopped");
      }
    });
  }

  stop(): void {
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
    this.start(this.currentPhrases);
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  private parseStderr(raw: string): string {
    // Extract error text from PowerShell CLIXML wrapper
    const match = raw.match(/<S S="Error">(.+?)<\/S>/s);
    if (match) {
      return match[1].replace(/_x000D_/g, "").replace(/&#xA;/g, " ").trim();
    }

    // Fall back to raw text, stripping the CLIXML header
    return raw.replace(/#< CLIXML\s*/g, "").trim() || "Unknown speech engine error";
  }

  private killProcess(): void {
    if (this.process) {
      this._killedIntentionally = true;
      try {
        this.process.kill();
      } catch {
        // Process may have already exited
      }
      this.process = null;
    }
  }

  private buildScript(phrases: string[]): string {
    const escaped = phrases.map((p) => "'" + p.replace(/'/g, "''") + "'");

    return `
Add-Type -AssemblyName System.Speech

try {
    $phrases = @(${escaped.join(", ")})

    # Pre-compute a 2-char prefix from the main keyword in each phrase.
    # "hey claude" -> keyword "claude" -> prefix "cl"
    # "hey copilot" -> keyword "copilot" -> prefix "co"
    # Matching: any recognized word starting with the prefix triggers.
    $phrasePrefix = @{}
    foreach ($p in $phrases) {
        # Pick the longest word as the keyword (skips filler like "hey")
        $keyword = ($p -split '\\s+') | Sort-Object Length -Descending | Select-Object -First 1
        $phrasePrefix[$p] = $keyword.ToLower().Substring(0, [Math]::Min(2, $keyword.Length))
    }

    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $engine.SetInputToDefaultAudioDevice()

    [Console]::Out.WriteLine("READY")
    [Console]::Out.Flush()

    while ($true) {
        try {
            $result = $engine.Recognize([TimeSpan]::FromSeconds(5))
            if ($result -ne $null -and $result.Confidence -ge 0.3) {
                $text = $result.Text.ToLower()
                $recWords = $text -split '\\s+'
                $found = $false
                foreach ($p in $phrases) {
                    $prefix = $phrasePrefix[$p]
                    if ($prefix -eq $null) { continue }
                    foreach ($rw in $recWords) {
                        if ($rw.StartsWith($prefix)) {
                            [Console]::Out.WriteLine("DETECTED:" + $p)
                            [Console]::Out.Flush()
                            $found = $true
                            break
                        }
                    }
                    if ($found) { break }
                }
            }
        } catch [System.OperationCanceledException] {
            break
        } catch {
            # Timeout or no match, continue listening
        }
    }

    $engine.Dispose()
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [Console]::Error.Flush()
    exit 1
}
`;
  }
}
