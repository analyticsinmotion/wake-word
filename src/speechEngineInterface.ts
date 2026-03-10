export interface WakePhrase {
  label: string;
  phrase: string | string[];
  command: string;
  cooldownSeconds?: number;
}

export interface ISpeechEngine {
  start(phrases: WakePhrase[], threshold: number, debugMode: boolean): void;
  stop(): void;
  pause(): void;
  resume(): void;
  dispose(): void;
  on(event: "detected", cb: (phrase: WakePhrase, confidence: number) => void): this;
  on(event: "started" | "stopped" | "paused", cb: () => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  on(event: "warning", cb: (msg: string) => void): this;
  on(event: "debug", cb: (info: string) => void): this;
  readonly isListening: boolean;
  readonly isPaused: boolean;
}
