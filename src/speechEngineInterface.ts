export interface WakePhrase {
  label: string;
  phrase: string | string[];
  command: string;
  cooldownSeconds?: number;
  /**
   * Trigger threshold for this route's phrases, in place of the global
   * `wakeWord.confidenceThreshold`. Same range and meaning: lower detects
   * more easily. It is clamped by clampThreshold(), which falls back to the
   * global value when this one is missing or unusable.
   */
  confidenceThreshold?: number;
  /**
   * How listening resumes after this route fires. `timer` (the default)
   * resumes after the cooldown; `manual` waits for the user to resume from
   * the status bar or the Enable command. See resolveHandoff().
   */
  handoff?: "timer" | "manual";
}

/**
 * A restart after the engine stopped on its own while it was listening, or on
 * its way back to listening. The microphone is closed until the restarted
 * engine says it is listening again.
 */
export interface EngineRestart {
  /** Which restart this is, counting from 1. */
  attempt: number;
  /** How many restarts are made before the engine gives up. */
  attempts: number;
  /** How long until this restart begins. */
  delayMs: number;
  /** Why the engine stopped: its own message, or how the process ended. */
  reason: string;
}

export interface ISpeechEngine {
  start(phrases: WakePhrase[], threshold: number, debugMode: boolean): void | Promise<void>;
  stop(): void;
  /**
   * Stop listening at once and release the microphone. The promise settles
   * once the microphone is known to be closed, whether the engine confirmed
   * it or forced it, and never rejects. The extension awaits it before
   * firing a route's command.
   */
  pause(): Promise<void>;
  resume(): void;
  dispose(): void;
  /**
   * `confidence` is absent when the engine has no meaningful score to give.
   * The sherpa-onnx keyword spotter applies its own threshold and returns
   * nothing usable, so it omits the value rather than inventing a 1.0.
   */
  on(event: "detected", cb: (phrase: WakePhrase, confidence?: number) => void): this;
  /**
   * `cancelled`: the user cancelled the start, from the model download's
   * progress notification. Nothing failed, so no error follows.
   */
  on(event: "started" | "stopped" | "paused" | "cancelled", cb: () => void): this;
  /** The engine stopped on its own and a restart is scheduled. */
  on(event: "restarting", cb: (restart: EngineRestart) => void): this;
  /**
   * The engine could not start, or stopped and could not be restarted. It is
   * reported once and the engine is left stopped.
   */
  on(event: "error", cb: (err: Error) => void): this;
  on(event: "warning", cb: (msg: string) => void): this;
  on(event: "debug", cb: (info: string) => void): this;
  readonly isListening: boolean;
  readonly isPaused: boolean;
  /**
   * A start or a resume the extension asked for is under way: the model check,
   * a download, the tokenising, the model load, or the microphone opening. It
   * ends when the engine says it is listening, fails, or is stopped.
   */
  readonly isStarting: boolean;
  /** The restart in progress after the engine stopped on its own, or null. */
  readonly restarting: EngineRestart | null;
}
