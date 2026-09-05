export interface WakePhrase {
  label: string;
  phrase: string | string[];
  command: string;
  cooldownSeconds?: number;
  /**
   * How listening resumes after this route fires. `timer` (the default)
   * resumes after the cooldown; `manual` waits for the user to resume from
   * the status bar or the Enable command. See resolveHandoff().
   */
  handoff?: "timer" | "manual";
}

export interface ISpeechEngine {
  start(phrases: WakePhrase[], threshold: number, debugMode: boolean): void | Promise<void>;
  stop(): void;
  pause(): void;
  resume(): void;
  dispose(): void;
  /**
   * `confidence` is absent when the engine has no meaningful score to give.
   * The sherpa-onnx keyword spotter applies its own threshold and returns
   * nothing usable, so it omits the value rather than inventing a 1.0.
   */
  on(event: "detected", cb: (phrase: WakePhrase, confidence?: number) => void): this;
  on(event: "started" | "stopped" | "paused", cb: () => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  on(event: "warning", cb: (msg: string) => void): this;
  on(event: "debug", cb: (info: string) => void): this;
  readonly isListening: boolean;
  readonly isPaused: boolean;
}
