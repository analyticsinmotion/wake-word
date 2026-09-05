import { EventEmitter } from "events";

/**
 * Stand-in for the ChildProcess that `child_process.spawn()` returns, so the
 * engine state machines can be driven without a real process.
 *
 * The streams are plain EventEmitters rather than Node Readable/Writable
 * instances. The engines only ever call on(), once(), removeAllListeners(),
 * write(), end(), and read `writable`, and a synchronous 'data' emission lets
 * a test say exactly when a line arrives instead of waiting on stream
 * internals. Tests mock `spawn` to hand one of these back and then drive it:
 * `sendLine("READY")`, `simulateExit(1)`, and so on.
 */
export class MockWritable extends EventEmitter {
  writable = true;
  /** Everything written, in order, as strings. */
  readonly chunks: string[] = [];

  write(chunk: string | Buffer): boolean {
    if (!this.writable) {
      // Node reports a write after end as an 'error' event, not a throw.
      this.emit("error", new Error("write after end"));
      return false;
    }
    this.chunks.push(chunk.toString());
    return true;
  }

  end(): void {
    this.writable = false;
  }
}

export class MockReadable extends EventEmitter {
  push(chunk: string | Buffer): void {
    this.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

export class MockChildProcess extends EventEmitter {
  readonly stdin = new MockWritable();
  readonly stdout = new MockReadable();
  readonly stderr = new MockReadable();
  readonly pid: number;
  killed = false;
  exitCode: number | null = null;

  constructor(pid = 4242) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** The child prints one complete protocol line. */
  sendLine(line: string): void {
    this.stdout.push(line + "\n");
  }

  /** The child prints an arbitrary chunk: part of a line, or several lines. */
  sendRaw(text: string): void {
    this.stdout.push(text);
  }

  sendStderr(text: string): void {
    this.stderr.push(text);
  }

  /** The child exits. `code` is null when it died from a signal. */
  simulateExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }

  /** spawn() itself failed, for example ENOENT for the node executable. */
  simulateError(err: Error): void {
    this.emit("error", err);
  }

  /** Every complete line written to stdin so far. */
  get stdinLines(): string[] {
    return this.stdin.chunks
      .join("")
      .split("\n")
      .filter((line) => line.length > 0);
  }
}
