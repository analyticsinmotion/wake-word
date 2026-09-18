# wake-word-engine

A Rust implementation of `engine/audio-engine.js`: the child process the Wake
Word extension talks to over stdin and stdout.

**The extension does not run this binary.** `engine/audio-engine.js` under
system Node.js is the engine that runs. Nothing in `src/` spawns this binary
and nothing in the packaged `.vsix` contains it.

## What it does

It speaks the whole protocol, opens a real microphone through the
[decibri](https://crates.io/crates/decibri) crate, and gates the captured audio
with Silero voice activity detection. No keyword spotter is attached, so it
never writes a `DETECTED:` line: audio that passes the gate goes to a counter,
which in debug mode reports each speech segment's length.

The Node engine needs a system Node.js 22 or later on the user's machine, plus
npm packages with native addons shipped inside the `.vsix`. A native binary
removes the Node.js prerequisite and the ABI matching that goes with it.

### Capture

Every microphone is opened with the options the Node engine uses:

| Option | Value |
| --- | --- |
| sample rate | 16 kHz; decibri opens the device at its native rate and resamples |
| channels | 1; decibri averages the device's channels |
| samples | `f32`, the only format decibri's Rust API delivers |
| DC removal | on |
| highpass | 80 Hz |
| AGC | -18 dBFS |
| device | `audioDevice` from the config: an index, a name substring, or the system default |

The capture loop reads 100 ms chunks (1600 samples). For each one it scores
decibri's detector feed with Silero, clamps the delivered samples to [-1, 1]
(AGC can drive them past full scale and float32 does not saturate), and then
applies the speech and silence transitions: speech on the first chunk scoring
0.5 or more, silence after 300 ms below it, counted in samples. While silent,
chunks wait in a 5-chunk (500 ms) pre-roll ring; on speech the ring is flushed
oldest first, ahead of the chunk that crossed the threshold, and chunks pass
straight through until silence.

decibri's detector feed is the resampled mono signal before DC removal, the
highpass, and AGC, so conditioning does not change what the detector hears.

On Windows, decibri names each input by its endpoint name alone, such as
`Microphone` or `Microphone Array`, without the device description Windows
Settings shows in brackets after it. Two devices can therefore share a name,
and a name substring cannot tell them apart; select such a device by index.

Capture errors are reported with the messages `engine/lib/mic-errors.js` uses,
switching on decibri's stable error codes, and naming `wakeWord.audioDevice`
when the user chose a device. A stream that fails while running, such as a
device that is unplugged, is fatal: `ERROR:` and exit 1, so the extension
restarts the engine.

## Building

```bash
cd engine-rs
cargo build --release          # target/release/wake-word-engine[.exe]
cargo test                     # unit tests; no microphone, no ONNX Runtime
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

Building on Linux needs the ALSA development package (`libasound2-dev` on
Debian and Ubuntu), which the audio backend links against.

## ONNX Runtime and the Silero model

decibri is built with its `ort-load-dynamic` feature, so neither ONNX Runtime
nor the voice activity model is compiled into the binary. Both are found at
run time, and the microphone cannot open without them.

**ONNX Runtime 1.28 or later**, found by decibri in this order:

1. `ortLibraryPath` in the config line;
2. the `ORT_DYLIB_PATH` environment variable;
3. `onnxruntime.dll`, `libonnxruntime.dylib`, or `libonnxruntime.so` in the
   directory that holds the executable;
4. the same name through the system loader. On Windows the loader finds the
   copy in System32 first, which is not a compatible build, and decibri
   refuses it.

**The Silero model** (`silero_vad.onnx`, Silero VAD v6.2), found in this order:

1. `vadModelPath` in the config line;
2. the `WAKE_WORD_VAD_MODEL` environment variable;
3. `silero_vad.onnx` in the directory that holds the executable.

For local development, the decibri npm package the Node engine installs
carries both files: the model in `engine/node_modules/decibri/models/` and, on
Windows, ONNX Runtime in the platform package under
`engine/node_modules/@decibri/`. Point the environment at them:

```bash
# from the repository root, after `cd engine && npm install`
export ORT_DYLIB_PATH="$PWD/engine/node_modules/@decibri/decibri-win32-x64-msvc/onnxruntime.dll"
export WAKE_WORD_VAD_MODEL="$PWD/engine/node_modules/decibri/models/silero_vad.onnx"
```

On macOS and Linux, use an ONNX Runtime 1.28 build from the ONNX Runtime
releases, or copy both files next to the built binary instead of setting the
variables.

`--self-test` shows what was found:

```text
SELF-TEST:OK
SELF-TEST:platform=<os>-<arch>
SELF-TEST:version=<crate version>
SELF-TEST:decibri=<decibri version>
SELF-TEST:ort=<library path, or "not found">
SELF-TEST:vad-model=<model path, or "not found">
```

It initialises ONNX Runtime and loads the model the way a microphone open
does, but opens no microphone, so it is safe to run anywhere. Neither file
being present is reported as `not found` with exit 0. A library or model that
is present but unusable is `SELF-TEST:FAIL:<message>` with exit 1.

## Driving the binary

```bash
node scripts/drive-protocol.mjs            # add --bin <path> to drive another build
```

The script pipes commands into the built binary over a real pipe and asserts
the lines and exit codes that come back. Scenarios that reach `READY` open the
default microphone, so they need one, plus ONNX Runtime and the model; the
script reads the self-test first and skips them, saying why, when either file
is missing.

To watch the voice activity detection, run the binary in debug mode and speak.
`cat` keeps stdin open after the config line, because the engine shuts down
when stdin closes; type `stop` and press Enter to end it:

```bash
{ printf '{"phrases":[{"phrase":"hey claude"}],"debugMode":true}\n'; cat; } | ./target/release/wake-word-engine
```

```text
DEBUG:wake-word-engine starting, modelDir=
DEBUG:voice activity model=<path>, ONNX Runtime=<path>
DEBUG:opening microphone...
DEBUG:Timing: mic-open 160ms
READY
DEBUG:VAD: speech (5 pre-roll chunks)
DEBUG:VAD: silence
DEBUG:segment: 14 chunks, 1400 ms passed the gate
```

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
the system default. `vadModelPath` and `ortLibraryPath` are described above;
the extension does not send them.

Every line after the config is a command:

| Command | Answer |
| --- | --- |
| `pause` | close the microphone, keep everything else loaded: `PAUSED` |
| `resume` | reopen the microphone: `READY` |
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
| --- | --- |
| `READY` | microphone open and listening; answers both the start and a resume |
| `DETECTED:<phrase>` | a wake phrase was heard; never written by this binary |
| `PAUSED` | microphone closed, everything else still loaded |
| `RELEASED` | microphone closed for good, the process is exiting |
| `ERROR:<msg>` | fatal; the process exits 1 |
| `DEBUG:<msg>` | diagnostics, only when `debugMode` is true |
| `SELF-TEST:<line>` | `--self-test` only |

`DETECTED` carries no confidence suffix: the keyword spotter applies its own
threshold and returns no usable score. The extension's parser accepts an
optional `|<conf>` suffix, and nothing sends one.

In debug mode the microphone opens are timed as `DEBUG:Timing: mic-open <n>ms`
and `DEBUG:Timing: resume-mic-open <n>ms`. Each includes loading the Silero
model, which happens on every open. Debug mode also reports each speech and
silence transition, each segment's length, and, every 30 seconds, decibri's
overrun count when it has changed since the last report: a rising count means
the capture loop is falling behind the microphone.

### Shutdown

`stop`, stdin reaching EOF, SIGTERM, and SIGINT all close the microphone,
answer `RELEASED`, and exit 0. On Windows the console control handler stands in
for the signals; a child spawned by the extension host has no console, so
`stop` and stdin EOF are the paths that matter there. A fatal error exits 1.

stdout is flushed before the process exits. `RELEASED` and `ERROR:` are both
read by something on the other end of the pipe, and the extension waits up to
500 ms for `RELEASED` before it kills the child, so neither line may be lost.

## Layout

```text
engine-rs/
  Cargo.toml
  Cargo.lock
  src/
    main.rs        argument handling, the self-test, the stdin reader, signals, the event loop
    protocol.rs    chunk-safe line splitting, control-line parsing, stdout lines
    config.rs      the config JSON shape and its defaults
    lifecycle.rs   the state machine and the capture session
    capture.rs     decibri microphone and Silero setup, the capture loop, the capture thread
    hysteresis.rs  speech and silence transitions from the speech probability
    gate.rs        the pre-roll ring and the gate
    samples.rs     the [-1, 1] sample clamp
    mic_errors.rs  decibri error codes to user-facing messages
    assets.rs      where ONNX Runtime and the Silero model are looked for
  scripts/
    drive-protocol.mjs   pipes commands into the built binary and asserts the answers
```

The state machine holds no threads of its own and reacts only to events, so
every case can be driven from a test, including the ones that need an open to
still be in flight. Each microphone runs on a thread of its own: the thread
opens it, reports back through the same channel the stdin reader and the
signal handler use, and then runs the capture loop until the microphone is
closed. Everything a microphone reports carries the id of the open that
produced it, and the state machine ignores reports from a microphone it has
closed. Closing a microphone waits for its thread to finish, so nothing from a
closed microphone reaches the downstream consumer.

## Dependencies

| Crate | Why |
| --- | --- |
| `decibri` `=6.3.0` | microphone capture, conditioning, device selection, Silero voice activity detection, and the typed errors. Built without default features, with `capture`, `vad`, `gain`, and `ort-load-dynamic` |
| `serde_json` | the config line |

The config line is read out of a `serde_json::Value` field by field rather than
deserialised into a struct, because the Node engine coerces rather than
rejects, and a derived struct would turn a phrase of the wrong type into a
fatal parse error instead of skipping it.

decibri is pinned to an exact version and bumped deliberately. `gain` provides
the AGC stage. decibri's default feature set would also build playback, the
denoise stage, and echo cancellation, none of which the engine uses.
