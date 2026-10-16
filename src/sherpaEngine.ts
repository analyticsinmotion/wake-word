import { EventEmitter } from "events";
import { spawn, ChildProcess, execFile } from "child_process";
import { accessSync, chmodSync, constants, existsSync } from "fs";
import * as path from "path";
import { buildKeywordSpec, skippedPhraseWarning } from "./keywords";
import { EngineRestart, ISpeechEngine, WakePhrase } from "./speechEngineInterface";
import { KWS_MODEL, checkModel, modelDirectory, modelProblemMessage } from "./speechModel";
import { Tokeniser, loadTokeniser } from "./tokeniser";
import {
  DEFAULT_THRESHOLD,
  DeviceListing,
  clampThreshold,
  createLineReader,
  matchRoute,
  parseDeviceListing,
  parseEngineLine,
} from "./wakeWordCore";

/**
 * Speech recognition engine using sherpa-onnx keyword spotting, on every
 * platform.
 *
 * Spawns the engine as a child process: the native binary packaged in bin/,
 * which finds ONNX Runtime and the voice activity model beside itself and
 * needs nothing installed. The keyword spotting model is packaged too, under
 * models/, and its files are checked before the first start of a session
 * (see speechModel.ts), so a start needs no network access.
 *
 * Before spawning, the phrases are cleaned up and tokenised here (see
 * keywords.ts and tokeniser.ts), and the config line carries the finished
 * keyword lines and the decoded-to-spoken phrase map. A phrase the model
 * cannot spell is left out with a warning.
 *
 * The child lives across handoffs. pause() tells it to close the microphone
 * and resume() to reopen it, so the models load once per start instead of
 * once per wake phrase. The process ends on stop(), dispose(), a crash, or a
 * pause the child does not acknowledge in time.
 *
 * A child that fails is restarted only when a restart can help. Before the
 * engine has listened in this session, a failure is one of configuration or
 * environment: no microphone, a device name that matches nothing, microphone
 * permission, a missing inference runtime, a model that does not load. The
 * same child would fail the same way seconds later, so its ERROR is reported
 * once and nothing is restarted. Once the engine has listened, a failure is
 * the microphone going away under it, such as a device unplugged, and a new
 * child opens whatever device is there now, so it is restarted after a
 * backoff, and only when the restarts run out is the child's last message
 * reported. A child that ends without an ERROR line, a crash, is restarted in
 * either case.
 *
 * The verbose log, `detail` events, follows setDebugMode() at once: the host's
 * own detail stops or starts, and a running child is told with `debug on` or
 * `debug off`, so it is neither restarted nor reloaded.
 *
 * Supports Windows, macOS, and Linux.
 */
export class SherpaEngine extends EventEmitter implements ISpeechEngine {
  private process: ChildProcess | null = null;
  private currentPhrases: WakePhrase[] = [];
  private _isListening = false;
  private _isPaused = false;
  private _isStarting = false;
  private _killedIntentionally = false;
  private currentThreshold = DEFAULT_THRESHOLD;
  private currentDebugMode = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The restart in progress after the child stopped on its own, or null. */
  private restartState: EngineRestart | null = null;
  /**
   * A child has said READY since the last stop() or final failure: the
   * engine has listened in this session. An ERROR before that is reported
   * once; after it, the child is restarted. See the class comment.
   */
  private hasListened = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Settles the promise stop() returned, while the leaving child's RELEASED
   * is awaited. Every way that wait can end goes through settleRelease(),
   * from resetChildState(), so an awaited stop cannot hang.
   */
  private releaseSettled: (() => void) | null = null;
  /** The promise stop() returned, while that wait is open. */
  private releaseAcknowledged: Promise<void> | null = null;
  /**
   * Advanced by every start() and stop(). start() awaits the model check
   * before it spawns, and a stop that lands in that window finds no child
   * to kill; the generation is how the start notices afterwards that it
   * has been overtaken and must not spawn.
   */
  private startGeneration = 0;

  // What is known about the current child. resetChildState() clears all of
  // it whenever the child changes.

  /**
   * The child has said READY at least once, so it is past the model load and
   * reads its commands promptly.
   */
  private childReady = false;
  /**
   * The child has been told to pause and not yet told to resume: it is alive
   * with the microphone closed at the engine's request. A crash in this state
   * is not retried, because a retry would reopen the microphone in the middle
   * of a handoff.
   */
  private childPaused = false;
  /** Force kills a child that has not said PAUSED in time. */
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Settles the promise pause() returned, while PAUSED is awaited. Every way
   * that wait can end goes through settlePause(), or, for a stop() that
   * lands during it, through the release that takes it over, so an awaited
   * pause cannot hang.
   */
  private pauseSettled: (() => void) | null = null;
  /** The promise pause() returned, while that wait is open. */
  private pauseAcknowledged: Promise<void> | null = null;
  /** When "pause" was sent, while PAUSED is awaited. Debug timing only. */
  private pauseSentAt = 0;
  /** When "resume" was sent, while READY is awaited; 0 otherwise. */
  private resumeSentAt = 0;

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
   * How long to wait for the child's PAUSED before force killing it. The same
   * device close as RELEASED, capped for the same reason: a wedged child must
   * not hold the microphone through a handoff. It is also the longest the
   * extension waits before firing a route's command. The next resume starts
   * a new child in place of a killed one.
   */
  private static readonly PAUSE_TIMEOUT_MS = 500;

  /**
   * `audioDevice` is the `wakeWord.audioDevice` setting: empty for the
   * system default, otherwise a device index or a case-insensitive name
   * substring. It is fixed for the life of the engine; the extension builds
   * a new engine when the setting changes.
   *
   * `editorName` is the editor's own name, `vscode.env.appName`. The child
   * names it in a message about microphone permission, which the operating
   * system grants to the editor that started it.
   */
  constructor(
    private readonly audioDevice: string = "",
    private readonly editorName: string = ""
  ) {
    super();
  }

  get isListening(): boolean {
    return this._isListening;
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  get isStarting(): boolean {
    return this._isStarting;
  }

  get restarting(): EngineRestart | null {
    return this.restartState;
  }

  /**
   * Turn the verbose log on or off. A child already running is told, and one
   * started later is configured with it.
   */
  setDebugMode(on: boolean): void {
    if (on === this.currentDebugMode) {
      return;
    }
    this.currentDebugMode = on;
    if (this.process) {
      this.writeCommand(this.process, on ? "debug on" : "debug off");
    }
  }

  /** A line for the verbose log, dropped while it is off. */
  private detail(message: string): void {
    if (this.currentDebugMode) {
      this.emit("detail", message);
    }
  }

  /**
   * Start listening. A start supersedes a restart still pending from a
   * crash: it carries the phrases, threshold, and debug mode to use now.
   */
  async start(phrases: WakePhrase[], confidenceThreshold = DEFAULT_THRESHOLD, debugMode = false): Promise<void> {
    if (this._isListening) {
      return;
    }
    this.restartState = null;
    this._isStarting = true;
    return this.launch(phrases, confidenceThreshold, debugMode);
  }

  /**
   * Check the model, tokenise the phrases, and spawn a child. Used by start()
   * and by everything that brings the engine back on its own: a restart after
   * a crash, and a resume whose child has gone.
   */
  private async launch(phrases: WakePhrase[], confidenceThreshold: number, debugMode: boolean): Promise<void> {
    if (this._isListening) {
      return;
    }
    const startedAt = Date.now();

    // A start supersedes any retry still scheduled from a crash. Left armed,
    // it would fire into the fresh child below: a no-op if READY has arrived
    // by then, otherwise a needless kill and respawn mid model load.
    this.clearRetryTimer();
    // A paused child is replaced as well: a start carries the phrases,
    // threshold, and debug mode to use, and after a settings change those
    // are not the ones that child was given.
    this.forceKill();
    const generation = ++this.startGeneration;

    this._killedIntentionally = false;
    this.currentPhrases = phrases;
    const safeThreshold = clampThreshold(confidenceThreshold);
    this.currentThreshold = safeThreshold;
    this.currentDebugMode = debugMode;

    // The model ships in the package, beside bin/. Its files are read and
    // checked against their pinned digests on the first start of a session,
    // and the result is kept while they pass: see checkModel().
    const modelDir = modelDirectory(path.dirname(__dirname));
    const checkingSince = Date.now();
    const modelProblem = await checkModel(modelDir);

    // A stop() or a newer start() landed while the check above was in
    // flight. Neither found a child to deal with, because there was none
    // yet, so this start has to be the one that stands down: spawning now
    // would reopen the microphone after a Disable, or put two children on
    // it after a second start. Whatever the check found is no longer this
    // start's to report.
    if (generation !== this.startGeneration) {
      this.emit("debug", "Start abandoned: stopped during the model check");
      return;
    }
    if (modelProblem) {
      this.fail(new Error(modelProblemMessage(modelProblem)));
      return;
    }
    if (this.currentDebugMode) {
      this.detail(`Model: ${modelDir}, ${KWS_MODEL.files.length} files checked against their pinned SHA-256`);
      this.detail(`Timing: model-check ${Math.max(0, Date.now() - checkingSince)}ms`);
    }

    // Reading the tokeniser's model is the one wait here; it happens once
    // per model directory, and the cleaning up and tokenising after it are
    // synchronous.
    const loadingSince = Date.now();
    let tokeniser: Tokeniser;
    try {
      tokeniser = await loadTokeniser(modelDir);
    } catch (err: unknown) {
      if (generation === this.startGeneration) {
        const message = err instanceof Error ? err.message : String(err);
        this.fail(new Error("Could not tokenise the wake phrases: " + message));
      } else {
        this.emit("debug", "Start abandoned: stopped while the tokeniser loaded");
      }
      return;
    }
    // The same race as the model check, over the tokeniser's load.
    if (generation !== this.startGeneration) {
      this.emit("debug", "Start abandoned: stopped while the tokeniser loaded");
      return;
    }

    const tokenisingSince = Date.now();
    const spec = buildKeywordSpec(phrases, (text) => tokeniser.encode(text), safeThreshold, tokeniser.vocabulary);
    if (this.currentDebugMode) {
      this.detail(`Timing: bpe-load ${Math.max(0, tokenisingSince - loadingSince)}ms`);
      this.detail(`Timing: tokenise ${Math.max(0, Date.now() - tokenisingSince)}ms`);
      for (const d of spec.details) {
        this.detail(`phrase: ${d.phrase} -> tokens: ${d.tokens} -> decoded: ${d.decoded}`);
      }
    }
    for (const skipped of spec.skipped) {
      this.emit("warning", skippedPhraseWarning(skipped));
    }
    if (spec.keywordLines.length === 0) {
      this.fail(new Error("No valid phrases to detect"));
      return;
    }

    // The binary takes no arguments: it reads its config on stdin and finds
    // ONNX Runtime and the voice activity model beside itself.
    const binary = nativeEnginePath(path.dirname(__dirname));
    // A packaged binary that is absent or cannot be run is reported by name.
    // Left to the spawn, it would surface as ENOENT or EACCES with nothing to
    // say which file was meant.
    const problem = prepareNativeEngine(binary);
    if (problem) {
      this.fail(new Error(problem));
      return;
    }
    this.emit("debug", `Spawning: ${binary}`);

    this.resetChildState();
    // windowsHide: the child is a console program. Without it Windows can
    // give it a console window of its own for as long as it runs.
    const proc = spawn(binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = proc;

    // A write to a child that has already exited surfaces EPIPE as an 'error'
    // event on the stream, not as a thrown exception, so the try/catch around
    // each write does not cover it. Without a listener that event takes the
    // extension host down, and the release path deliberately writes to a child
    // that is on its way out.
    proc.stdin?.on("error", () => {
      /* child is gone; nothing left to say to it */
    });

    // Send config as JSON line then leave stdin open (child reads more commands).
    // The debug mode is read now, not when the start began: the verbose log
    // can have been switched while the model was checked and the tokeniser
    // loaded.
    const config = {
      threshold: safeThreshold,
      modelDir,
      debugMode: this.currentDebugMode,
      audioDevice: this.audioDevice,
      editorName: this.editorName,
      keywordLines: spec.keywordLines,
      phraseMap: spec.phraseMap,
    };
    proc.stdin?.write(JSON.stringify(config) + "\n");

    proc.stdout?.on(
      "data",
      createLineReader((line) => {
        if (this.process === proc) {
          this.handleLine(line, phrases, startedAt);
        }
      })
    );

    proc.stderr?.on("data", (data: Buffer) => {
      this.emit("debug", "stderr: " + data.toString().trim());
    });

    proc.on("error", (err) => {
      if (this.process !== proc) {
        return;
      }
      // A process that never started cannot close later: its listeners go
      // now, so a late event from it is not taken for a crash.
      proc.removeAllListeners("close");
      this._isListening = false;
      this._isPaused = false;
      this.process = null;
      this.resetChildState();

      // The binary was there a moment ago, checked by prepareNativeEngine():
      // say which file would not start, and why.
      this.fail(new Error(`Failed to start the speech engine at ${binary}: ${err.message}`));
    });

    // 'close', not 'exit': Node can report the exit before the last of the
    // child's stdout has been read, and a child that failed prints its ERROR
    // line just before it exits. 'close' comes once stdout has ended, so an
    // ERROR line, if there was one, has been handled by then.
    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.process !== proc) {
        return;
      }
      const wasListening = this._isListening;
      const wasStarting = this._isStarting || this.restartState !== null;
      const wasPaused = this.childPaused;
      this._isListening = false;
      this.process = null;
      this.resetChildState();

      const ended = signal ? `signal ${signal}` : `exit code ${code}`;
      this.emit("debug", `Process exited: ${ended}, killed=${this._killedIntentionally}`);

      if (this._killedIntentionally) {
        if (wasListening && !this._isPaused) {
          this.emit("stopped");
        }
        return;
      }

      // The child died while paused for a handoff. A retry now would reopen
      // the microphone the handoff gave away, so the engine stays paused with
      // no process and resume() starts a new one.
      if (wasPaused) {
        this.emit("debug", "Engine process exited while paused: the next resume starts a new one");
        return;
      }

      // It ended without an ERROR line: a crash, which is restarted whether
      // or not the engine had listened. See the class comment.
      if (code !== 0) {
        this.scheduleRestart(null, ended);
        return;
      }

      // It exited cleanly without being asked to, as it does on a signal from
      // outside. Nothing is restarted and nothing is starting any more.
      this._isStarting = false;
      this.restartState = null;
      if ((wasListening || wasStarting) && !this._isPaused) {
        this.emit("stopped");
      }
    });
  }

  /**
   * Give up and report why, once: a start that cannot go ahead, a child that
   * failed before the engine had listened, or restarts that ran out. The
   * engine is left stopped, and the next start begins a new session with the
   * full number of restarts.
   */
  private fail(error: Error): void {
    this._isStarting = false;
    this.restartState = null;
    this.hasListened = false;
    this.retryCount = 0;
    this.emit("error", error);
  }

  /**
   * The child printed ERROR, which it does only for a fatal error, just
   * before it exits 1.
   *
   * The child is killed at once, so nothing it holds outlives the line and
   * its exit is not taken for a crash. Whether it is then restarted depends
   * on whether the engine has listened in this session: see the class
   * comment. A child paused for a handoff is not restarted, for the reason a
   * crash while paused is not.
   */
  private onChildError(proc: ChildProcess, message: string): void {
    const wasPaused = this.childPaused;
    this._isListening = false;
    this.forceKill(proc);

    if (wasPaused) {
      this.emit("warning", `Speech engine error while paused: ${message}. The next resume starts it again.`);
      return;
    }
    if (!this.hasListened) {
      this.fail(new Error(message));
      return;
    }
    this.scheduleRestart(message, "exit code 1");
  }

  /**
   * The child stopped on its own: restart it after the next backoff delay,
   * or give up once MAX_RETRIES restarts have been made since it last said
   * READY.
   *
   * `message` is the child's ERROR text, or null when it ended without one;
   * `ended` is how the process ended. Giving up reports the child's own
   * message where there was one, which says what is wrong, and otherwise
   * that the engine kept stopping.
   */
  private scheduleRestart(message: string | null, ended: string): void {
    if (this.retryCount >= SherpaEngine.MAX_RETRIES) {
      this.fail(
        new Error(
          message ??
            `The speech engine stopped unexpectedly (${ended}) and did not recover after ` +
              `${SherpaEngine.MAX_RETRIES} restarts.`
        )
      );
      return;
    }
    const delayMs = SherpaEngine.RETRY_DELAYS[this.retryCount];
    this.retryCount++;
    this._isStarting = false;
    this.restartState = {
      attempt: this.retryCount,
      attempts: SherpaEngine.MAX_RETRIES,
      delayMs,
      reason: message ?? ended,
    };
    this.emit("restarting", this.restartState);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.launch(this.currentPhrases, this.currentThreshold, this.currentDebugMode);
    }, delayMs);
  }

  /** Act on one line of the current child's stdout. */
  private handleLine(line: string, phrases: WakePhrase[], startedAt: number): void {
    const event = parseEngineLine(line);
    if (!event) {
      return;
    }

    switch (event.type) {
      case "ready":
        // The same READY answers a start and a resume.
        this.detail(
          this.resumeSentAt
            ? `Timing: resume-to-ready ${Date.now() - this.resumeSentAt}ms`
            : `Timing: start-to-ready ${Date.now() - startedAt}ms`
        );
        this.resumeSentAt = 0;
        this.childReady = true;
        this._isListening = true;
        this._isPaused = false;
        this._isStarting = false;
        this.restartState = null;
        this.hasListened = true;
        this.retryCount = 0;
        this.emit("started");
        break;
      case "paused":
        // Only a pause this engine is waiting on counts.
        if (this.pauseSettled) {
          this.emit("debug", "Mic release: acknowledged by engine (paused)");
          this.detail(`Timing: pause-to-ack ${Date.now() - this.pauseSentAt}ms`);
          this.pauseSentAt = 0;
          this.settlePause();
        }
        break;
      case "debug":
        // Sent only while the child's debug mode is on; one already on its
        // way when the verbose log was switched off is dropped here.
        this.detail(event.message);
        break;
      case "error":
        if (this.process) {
          this.onChildError(this.process, event.message);
        }
        break;
      case "detected":
        // Listening ended when pause() was called. A detection the child made
        // before the pause command reached it does not count.
        if (this._isListening) {
          const match = matchRoute(phrases, event.phrase);
          if (match) {
            // No confidence: the keyword spotter applied its own threshold
            // and returns no usable score. Reporting one anyway put a
            // meaningless "confidence: 1.00" in every log line.
            this.emit("detected", match, undefined);
          }
        }
        break;
      // RELEASED is only of interest while a release is in flight, and
      // releaseThenKill() reads it itself.
    }
  }

  /**
   * Stop listening and release the microphone for good.
   *
   * The returned promise settles once the microphone is known to be closed:
   * the child has said RELEASED, or it did not say so within
   * RELEASE_TIMEOUT_MS and has been killed, or it has gone some other way
   * (a start() or dispose() that kills it). A child still loading is killed
   * at once, and with no child the promise settles at once. It never
   * rejects. The extension gives the listener lock up only once it settles,
   * so no other window opens the microphone while this one still has it.
   */
  stop(): Promise<void> {
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
    this.restartState = null;
    this._isStarting = false;
    // The session ends here: an error in the next one is judged afresh.
    this.hasListened = false;
    // Likewise a start() still awaiting the model check: see startGeneration.
    this.startGeneration++;

    // Deal with whatever child exists before the state guard, for the same
    // reason. A child that has been spawned but has not yet said READY is
    // neither listening nor paused, and returning early left it to finish
    // loading, open the microphone, and report READY to a stopped engine:
    // Disable, Reset Consent, and an engine switch during that window all
    // ended with the microphone open. That child may still be inside the
    // model load, where it reads no commands, so it is killed outright. A
    // child that has said READY, listening or paused, reads its commands, so
    // it is asked to close the microphone and given RELEASE_TIMEOUT_MS to
    // say so.
    if (this.childReady) {
      this.releaseThenKill();
    } else {
      this.forceKill();
    }
    const released = this.releaseAcknowledged ?? Promise.resolve();

    if (!this._isListening && !this._isPaused) {
      return released;
    }

    this._isPaused = false;
    this._isListening = false;
    this.emit("stopped");
    return released;
  }

  /**
   * Release the microphone for a handoff.
   *
   * Listening ends at once: `paused` is emitted before this returns, and
   * nothing the child prints from here counts as a detection. The returned
   * promise settles once the microphone is known to be closed: the child has
   * said PAUSED, or it did not say so within PAUSE_TIMEOUT_MS and has been
   * killed, or a stop() has released it, or it has gone some other way (a
   * crash, dispose(), a start() that replaces it). It never rejects. The
   * extension awaits it before firing the route's command, so the command
   * that hands the microphone to an assistant runs after the release instead
   * of racing it.
   *
   * An engine that is not listening has nothing to pause. Its promise
   * settles when a pause or a stop still in flight has closed the
   * microphone, and at once when none is. A start or a resume under way is
   * not paused: that engine listens once its child says READY.
   */
  pause(): Promise<void> {
    if (!this._isListening) {
      // Not listening, but a crash-backoff retry may still be armed. A pause
      // must stop that retry reopening the microphone, and must leave the
      // engine resumable, so it becomes a paused engine with no process.
      if (this.retryTimer) {
        this.clearRetryTimer();
        this.restartState = null;
        this._isPaused = true;
        this.emit("paused");
      }
      // A pause or a stop already waiting on the child settles when that
      // one does.
      return this.pauseAcknowledged ?? this.releaseAcknowledged ?? Promise.resolve();
    }

    this._isPaused = true;
    this._isListening = false;
    this.clearRetryTimer();
    const released = this.pauseChild();
    this.emit("paused");
    return released;
  }

  resume(): void {
    if (!this._isPaused || this.currentPhrases.length === 0) {
      return;
    }

    const proc = this.process;
    // A child already on its way to READY, from a start or an earlier
    // resume, needs nothing more.
    if (proc && !this.childPaused) {
      return;
    }

    this.retryCount = 0;
    this._isStarting = true;

    // The usual case: the paused child is alive with its models loaded and
    // only the microphone has to reopen. Its READY sets the engine listening,
    // as after a start. This is sent even while the PAUSED is still on its
    // way: the child handles its commands in order.
    if (proc && this.writeCommand(proc, "resume")) {
      this.childPaused = false;
      this.resumeSentAt = Date.now();
      return;
    }

    // Nothing to resume: the child crashed or was killed during the pause,
    // or the pause came during crash backoff. Start a new one. The engine
    // stays paused until it says READY, so a start that fails leaves the
    // engine paused rather than half listening.
    if (proc) {
      this.forceKill(proc);
    }
    this.emit("debug", "Resume: no engine process to resume, starting a new one");
    void this.launch(this.currentPhrases, this.currentThreshold, this.currentDebugMode);
  }

  dispose(): void {
    this.clearRetryTimer();
    // The engine is being discarded and nothing will be left to hear
    // RELEASED, so the child is killed now instead of being left to a
    // release and its timer.
    this.forceKill();
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
   * End the wait for PAUSED, however it ended: cancel the timeout and settle
   * the promise pause() returned. Safe to call when nothing is waiting.
   */
  private settlePause(): void {
    this.takePauseWait()?.();
  }

  /**
   * End the wait for PAUSED without settling it: cancel the timeout and hand
   * back what settles the promise pause() returned, or null when nothing is
   * waiting.
   */
  private takePauseWait(): (() => void) | null {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    const settle = this.pauseSettled;
    this.pauseSettled = null;
    this.pauseAcknowledged = null;
    return settle;
  }

  /**
   * End the wait for RELEASED, however it ended, and settle the promise
   * stop() returned. Safe to call when nothing is waiting.
   */
  private settleRelease(): void {
    const settle = this.releaseSettled;
    this.releaseSettled = null;
    this.releaseAcknowledged = null;
    settle?.();
  }

  /**
   * Forget everything known about the current child, timers included. A
   * pause or a stop still waiting on that child settles here: whatever
   * replaced or removed the child has closed its microphone.
   */
  private resetChildState(): void {
    this.settlePause();
    this.settleRelease();
    this.childReady = false;
    this.childPaused = false;
    this.pauseSentAt = 0;
    this.resumeSentAt = 0;
  }

  /**
   * Ask the child to close the microphone, keep everything else loaded, and
   * say PAUSED. Returns the promise pause() hands back.
   *
   * The extension waits on that promise before it fires the target command,
   * and that command exists to hand the microphone to something else, so the
   * wait is capped: a child that has not said PAUSED within PAUSE_TIMEOUT_MS
   * is killed, which closes the device just as surely, and the promise
   * settles then.
   */
  private pauseChild(): Promise<void> {
    const proc = this.process;
    if (!proc) {
      return Promise.resolve();
    }

    this.childPaused = true;
    this.resumeSentAt = 0;
    if (!this.writeCommand(proc, "pause")) {
      this.emit("debug", "Mic release: stdin already closed");
      this.forceKill(proc);
      return Promise.resolve();
    }

    this.settlePause();
    const acknowledged = new Promise<void>((resolve) => {
      this.pauseSettled = resolve;
    });
    this.pauseAcknowledged = acknowledged;
    this.pauseSentAt = Date.now();
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      const resumeRequested = this.resumeSentAt !== 0;
      this.emit(
        "debug",
        `Mic release: no acknowledgement after ${SherpaEngine.PAUSE_TIMEOUT_MS}ms, forcing`
      );
      this.forceKill(proc);
      // forceKill() settled the wait through resetChildState(), since this
      // child is the current one. Settle again in case it was not.
      this.settlePause();
      // A resume sent behind the unanswered pause went to the child just
      // killed. Start a new one so that resume still happens.
      if (resumeRequested && this._isPaused) {
        this.emit("debug", "Resume: the engine did not pause in time, starting a new one");
        this.retryCount = 0;
        this._isStarting = true;
        void this.launch(this.currentPhrases, this.currentThreshold, this.currentDebugMode);
      }
    }, SherpaEngine.PAUSE_TIMEOUT_MS);
    return acknowledged;
  }

  /**
   * Ask the child to close the microphone for good, wait until it says it
   * has, and kill it. Used by stop().
   *
   * The child prints RELEASED once mic.stop() has returned. The line goes
   * through the same reassembly as everything else the child prints, so a
   * RELEASED split across two chunks, or behind other output in one, still
   * counts. A child that says nothing within RELEASE_TIMEOUT_MS is killed
   * anyway, so a wedged child cannot hold the device open indefinitely.
   *
   * From here the child is leaving: nothing else it prints, and neither its
   * exit nor its errors, reaches the engine. It stays in `this.process` until
   * it is killed, so a start() in the meantime kills it at once instead of
   * running a second child next to it.
   */
  private releaseThenKill(): void {
    const proc = this.process;
    if (!proc) {
      return;
    }

    this._killedIntentionally = true;
    this.clearReleaseTimer();
    // A pause still waiting for this child's PAUSED ends with the release
    // instead: the child closes its microphone for the stop, and until it
    // has, the pause's promise must not say the microphone is closed.
    const pauseSettled = this.takePauseWait();
    this.resetChildState();
    // Settled by forceKill(), through resetChildState(), whichever way the
    // wait ends: RELEASED, the timeout, or a start() or dispose() that kills
    // this child first.
    this.releaseAcknowledged = new Promise<void>((resolve) => {
      this.releaseSettled = () => {
        resolve();
        pauseSettled?.();
      };
    });

    proc.stdout?.removeAllListeners("data");
    proc.stderr?.removeAllListeners("data");
    proc.removeAllListeners("exit");
    proc.removeAllListeners("close");
    proc.removeAllListeners("error");
    proc.on("error", () => {
      /* the child is going away */
    });

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

    proc.stdout?.on(
      "data",
      createLineReader((line) => {
        if (parseEngineLine(line)?.type === "released") {
          finish("acknowledged by engine");
        }
      })
    );

    this.releaseTimer = setTimeout(
      () => finish(`no acknowledgement after ${SherpaEngine.RELEASE_TIMEOUT_MS}ms, forcing`),
      SherpaEngine.RELEASE_TIMEOUT_MS
    );

    if (!this.writeCommand(proc, "stop")) {
      finish("stdin already closed");
    }
  }

  /**
   * Send one command line. Returns false when the child is already gone.
   */
  private writeCommand(
    proc: ChildProcess,
    command: "pause" | "resume" | "stop" | "debug on" | "debug off"
  ): boolean {
    const stdin = proc.stdin;
    if (!stdin || !stdin.writable || proc.exitCode !== null) {
      return false;
    }
    try {
      stdin.write(command + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Tear the child down now, without waiting for an acknowledgement.
   *
   * `target` defaults to the current child. The release and pause timeouts
   * pass the child they were waiting on; while either is pending that child
   * is still the current one, because every path that replaces the child
   * comes through here first and cancels them.
   */
  private forceKill(target: ChildProcess | null = this.process): void {
    const proc = target;
    if (!proc) {
      return;
    }

    this._killedIntentionally = true;
    if (this.process === proc) {
      this.clearReleaseTimer();
      this.resetChildState();
      this.process = null;
    }
    proc.stdout?.removeAllListeners();
    proc.stderr?.removeAllListeners();
    // Ask for a clean release first even here: a child that acts on it closes
    // the device itself rather than leaving the OS to reclaim it.
    this.writeCommand(proc, "stop");
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
  }
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Where the packaged engine binary is, given the extension's root directory.
 * It needs no arguments and no paths: it looks for ONNX Runtime and the voice
 * activity model in the directory that holds it.
 */
export function nativeEnginePath(extensionRoot: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(extensionRoot, "bin", platform === "win32" ? "wake-word-engine.exe" : "wake-word-engine");
}

/**
 * Make sure the engine binary can be spawned. Returns what is wrong with it,
 * naming the path, or null.
 *
 * On macOS and Linux the package records the binary as executable and the
 * editor restores that when it installs the extension, but an extension
 * unpacked some other way can lose the mode, so it is set again here when it
 * is missing. Windows has no such mode.
 */
export function prepareNativeEngine(binary: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!existsSync(binary)) {
    return (
      `The speech engine is missing from this installation: ${binary} does not exist. ` +
      "Reinstall the Wake Word extension for this platform."
    );
  }
  if (platform === "win32") {
    return null;
  }
  try {
    accessSync(binary, constants.X_OK);
    return null;
  } catch {
    // Not executable: fall through and set the mode.
  }
  try {
    chmodSync(binary, 0o755);
    return null;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return `The speech engine at ${binary} is not executable and could not be made executable: ${detail}`;
  }
}

/**
 * The engine binary's self-test, for Show Diagnostics: its `SELF-TEST:` lines
 * on one line, or why it could not run. The self-test opens no microphone and
 * loads no keyword spotting model; it does load the voice activity model,
 * which is what makes it report a missing inference runtime. Never rejects,
 * and gives up after `timeoutMs`.
 */
export function probeNativeEngine(binary: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    if (!existsSync(binary)) {
      resolve("missing");
      return;
    }
    execFile(binary, ["--self-test"], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      const lines = String(stdout)
        .split(/\r?\n/)
        .filter((line) => line.startsWith("SELF-TEST:"))
        .map((line) => line.slice("SELF-TEST:".length));
      if (lines.length > 0) {
        resolve(`self-test ${lines.join(", ")}`);
      } else {
        resolve(err ? `could not run: ${err.message}` : "self-test printed nothing");
      }
    });
  });
}

/**
 * The input devices, from the packaged binary's `--list-devices`, for Show
 * Diagnostics. Listing opens no microphone. Never rejects: a binary that is
 * missing, fails, or has not answered within `timeoutMs` gives a `failed`
 * listing that says why.
 */
export function listInputDevices(binary: string, timeoutMs = 5000): Promise<DeviceListing> {
  return new Promise((resolve) => {
    if (!existsSync(binary)) {
      resolve({ kind: "failed", reason: "the speech engine is missing from this installation" });
      return;
    }
    execFile(binary, ["--list-devices"], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(parseDeviceListing(String(stdout), err ? `the engine could not list them: ${err.message}` : undefined));
    });
  });
}
