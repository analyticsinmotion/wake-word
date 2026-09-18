# wake-word-engine

A Rust rewrite of `engine/audio-engine.js`: the child process the Wake Word
extension talks to over stdin and stdout.

**This binary is not wired into the extension.** `engine/audio-engine.js` under
system Node.js is still the engine that runs, and it is unchanged. Nothing in
`src/` spawns this binary and nothing in the packaged `.vsix` contains it.

## What it is for

The Node engine needs a system Node.js 22 or later on the user's machine, plus
three npm packages with native addons shipped inside the `.vsix`. A single
static binary removes the Node.js prerequisite and the ABI matching that goes
with it. The migration runs in relays:

| Relay | Adds |
|---|---|
| 1 (this one) | the protocol, the config parser, the lifecycle state machine |
| 2 | decibri microphone capture, the VAD gate, the device error messages |
| 3 | sherpa-onnx keyword spotting and BPE tokenisation |
| later | packaging, CI, and the switchover in `src/sherpaEngine.ts` |

So this relay opens no microphone, loads no model, and never writes a
`DETECTED:` line. What it does do is speak the whole protocol and get the
lifecycle right, including the cases that are easy to lose: a command split
across two stdin chunks, a `stop` sitting behind another command in one chunk,
and a `pause` or `stop` that arrives while the capture device is still opening.
A placeholder capture device with a short artificial open delay stands in for
the microphone, so those in-flight cases are real rather than theoretical.

## Building

```bash
cd engine-rs
cargo build --release          # target/release/wake-word-engine[.exe]
cargo test                     # unit tests
cargo clippy -- -D warnings
cargo fmt --check
```

Then drive the built binary over a real pipe:

```bash
node scripts/drive-protocol.mjs            # add --bin <path> to drive another build
./target/release/wake-word-engine --self-test
```

`--self-test` opens nothing and needs no model, so it is safe to run anywhere.
It prints three lines and exits 0:

```text
SELF-TEST:OK
SELF-TEST:platform=<os>-<arch>
SELF-TEST:version=<crate version>
```

Relays 2 and 3 add the decibri and sherpa-onnx load checks to it, which is what
CI runs on each platform.

## The protocol

Identical to the Node engine's. The extension's side of it lives in
`src/sherpaEngine.ts` and `src/wakeWordCore.ts`.

### stdin

The first line is a JSON config object. Every field is optional:

```json
{
  "phrases": [{ "phrase": "hey claude", "label": "Claude" }],
  "threshold": 0.05,
  "modelDir": "<path>",
  "debugMode": false,
  "audioDevice": ""
}
```

`phrase` is a string or an array of aliases. `label` is never read by the
engine. `threshold` is clamped to 0.01 to 0.9, defaulting to 0.05, and a phrase
that is not a string or is blank is skipped rather than being fatal: the routes
are user-edited JSON and one bad entry must not take the engine down. A config
with no usable phrase at all is fatal. `audioDevice` is a device index when it
is nothing but digits, otherwise a case-insensitive name substring; empty means
the system default.

Every line after the config is a command:

| Command | Answer |
|---|---|
| `pause` | close the capture device, keep everything else loaded: `PAUSED` |
| `resume` | reopen the capture device: `READY` |
| `stop` | close everything, answer `RELEASED`, exit 0 |

Blank lines are ignored. Surrounding whitespace, `\r` included, is trimmed, so
a parent writing CRLF is handled. Anything else is fatal:
`ERROR:Invalid config JSON: <detail>`, exit 1.

stdin is delivered in chunks, not lines. One chunk can carry several commands
or half of one, and both are handled: a line is held until its newline arrives
and every complete line in a chunk is acted on, so a `stop` behind another
command is never dropped.

### stdout

| Line | When |
|---|---|
| `READY` | capture open and listening; answers both the start and a resume |
| `DETECTED:<phrase>` | a wake phrase was heard (Relay 3; never written here) |
| `PAUSED` | capture closed, everything else still loaded |
| `RELEASED` | capture closed for good, the process is exiting |
| `ERROR:<msg>` | fatal; the process exits 1 |
| `DEBUG:<msg>` | diagnostics, only when `debugMode` is true |
| `SELF-TEST:<line>` | `--self-test` only |

`DETECTED` carries no confidence suffix: the keyword spotter applies its own
threshold and returns no usable score. The extension's parser accepts an
optional `|<conf>` suffix, and nothing sends one.

In debug mode each phase is timed as `DEBUG:Timing: <phase> <n>ms`. The phases
here are `prepare` (the placeholder that Relay 3 replaces with the module, BPE,
tokenisation and model loads), `mic-open`, and `resume-mic-open`.

### Shutdown

`stop`, stdin reaching EOF, SIGTERM, and SIGINT all close capture, answer
`RELEASED`, and exit 0. On Windows the console control handler stands in for
the signals; a child spawned by the extension host has no console, so `stop`
and stdin EOF are the paths that matter there. A fatal error exits 1.

stdout is flushed before the process exits. `RELEASED` and `ERROR:` are both
read by something on the other end of the pipe, and the extension waits up to
500 ms for `RELEASED` before it kills the child, so neither line may be lost.

## Layout

```text
engine-rs/
  Cargo.toml
  Cargo.lock
  src/
    main.rs        argument handling, the stdin reader, signals, the event loop
    protocol.rs    chunk-safe line splitting, control-line parsing, stdout lines
    config.rs      the config JSON shape and its defaults
    lifecycle.rs   the state machine and the capture session
  scripts/
    drive-protocol.mjs   pipes commands into the built binary and asserts the answers
```

The state machine holds no threads of its own and reacts only to events, so
every case can be driven from a test, including the ones that need an open to
still be in flight. The slow steps run on short-lived threads and report back
through the same channel the stdin reader and the signal handler use.

## Dependencies

`serde_json` only. The config line is read out of a `serde_json::Value` field
by field rather than deserialised into a struct, because the Node engine
coerces rather than rejects, and a derived struct would turn a phrase of the
wrong type into a fatal parse error instead of skipping it. decibri and
sherpa-onnx arrive in Relays 2 and 3.
