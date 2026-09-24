/**
 * A stand-in for the `LogOutputChannel` the extension writes to, for tests
 * that drive activate(). Lines at info, warning, and error go to `logs`, and
 * debug and trace lines to `details`, each only while the level would show
 * them and marked with it, as the editor's channel does: `[warning] ...`.
 * setLevel() changes the level the way Developer: Set Log Level does, and
 * fires the channel's change event.
 */

/** `vscode.LogLevel`, whose values the API fixes. */
export const LEVEL = { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 } as const;

export interface LogChannelStub {
  channel: unknown;
  logs: string[];
  details: string[];
  setLevel(level: number): void;
}

export function createLogChannel(logs: string[] = [], level: number = LEVEL.Info): LogChannelStub {
  const details: string[] = [];
  const listeners: Array<(level: number) => void> = [];
  let current = level;
  const at = (min: number, into: string[], name: string) => (line: string) => {
    if (current !== LEVEL.Off && current <= min) {
      into.push(`[${name}] ${line}`);
    }
  };
  const channel = {
    name: "Wake Word",
    get logLevel() {
      return current;
    },
    onDidChangeLogLevel: (listener: (level: number) => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
    trace: at(LEVEL.Trace, details, "trace"),
    debug: at(LEVEL.Debug, details, "debug"),
    info: at(LEVEL.Info, logs, "info"),
    warn: at(LEVEL.Warning, logs, "warning"),
    error: at(LEVEL.Error, logs, "error"),
    appendLine: at(LEVEL.Info, logs, "info"),
    show: () => undefined,
    dispose: () => undefined,
  };
  return {
    channel,
    logs,
    details,
    setLevel(level: number) {
      current = level;
      for (const listener of listeners) {
        listener(level);
      }
    },
  };
}
