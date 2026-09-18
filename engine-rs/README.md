# wake-word-engine

A Rust implementation of `engine/audio-engine.js`: the child process the Wake
Word extension talks to over stdin and stdout.

**The extension does not run this binary.** `engine/audio-engine.js` under
system Node.js is the engine that runs. Nothing in `src/` spawns this binary
and nothing in the packaged `.vsix` contains it.

## What it does

It speaks the whole protocol, opens a real microphone through the
[decibri](https://crates.io/crates/decibri) crate, gates the captured audio
with Silero voice activity detection, and feeds what passes the gate to a
[sherpa-onnx](https://crates.io/crates/sherpa-onnx) keyword spotter. When the
spotter hears a configured phrase the engine writes `DETECTED:<phrase>`. The
model files, the keyword line syntax, the boost, and the thresholds are the
Node engine's.

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
0.5 or more, and silence once the score has stayed below it for 300 ms after
the first quiet chunk arrived, which with 100 ms chunks is the fourth quiet
chunk. That is when decibri's Node.js microphone declares it, and all four
chunks reach the spotter as the tail of the segment. While silent, chunks wait
in a pre-roll ring; on speech the ring is flushed oldest first, ahead of the
chunk that crossed the threshold, and chunks pass straight through until
silence. The ring holds four chunks, so with the chunk that crossed the
threshold the spotter is handed 500 ms of lead-in, the same five chunks the
Node engine hands its spotter.

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

### Keyword spotting

The spotter is sherpa-onnx's streaming transducer, configured as the Node
engine configures it:

| Field | Value |
| --- | --- |
| feature sample rate, dimension | 16000, 80 |
| encoder, decoder, joiner | the three `*-epoch-12-avg-2-chunk-16-left-64.int8.onnx` files in `modelDir` |
| tokens | `tokens.txt` |
| provider, threads | `cpu`, 1 |
| modeling unit, BPE vocabulary | `bpe`, `bpe.model` |
| max active paths | 4 |
| trailing blanks | 1 |
| keywords score | 1.0 |
| keywords threshold | the clamped `threshold` from the config |
| keywords | passed in memory, never written to a file |

The spotter does not take plain text. Each phrase reaches it as one line: the
tokeniser's pieces for the upper-cased phrase, then a boost score and the
phrase's own trigger threshold, for example `▁HE Y ▁C LA U DE :3.0 #0.05`. The
boost is always 3.0 and the threshold is the clamped `threshold` from the
config. A per-phrase threshold replaces the spotter-wide one, so the lines are
where `wakeWord.confidenceThreshold` takes effect. The spotter reports a hit as
the decoded text of the pieces (`HEY CLAUDE`), and the engine maps that back to
the phrase as configured, lower-cased, before writing `DETECTED:`.

The pieces come from the model's own SentencePiece file, `bpe.model`, read by
the [sentencepiece-rust](https://crates.io/crates/sentencepiece-rust) crate.
Despite its name the file is a Unigram model with the `nmt_nfkc` normaliser, so
pieces are chosen by a best-path search over piece scores, and full-width and
ligature forms fold to plain letters first. The pieces must be the ones the
Node engine's tokeniser produces, because a different piece sequence is a
different keyword. They are, except for text with the same letter three times
running where the doubled letter is itself a piece (`LLL`, `PPP`, `FFF`): there
two segmentations score exactly the same, floating-point rounding decides, and
builds of SentencePiece disagree with each other.

The spotter's stream, its decoding state, is restarted in three places:

- after a detection, so one utterance is reported once;
- at the end of each speech segment, so audio from either side of a silence is
  never joined into a phrase nobody said in one breath;
- on `pause`, where the stream is replaced rather than reset. A reset leaves
  audio the stream has accepted and not yet decoded in place, and it would be
  decoded ahead of whatever is heard after the resume.

The spotter decodes in steps of 320 ms of audio, counted from the first sample
it is given, and reports a keyword once a step has covered the phrase's last
piece and the blank after it. Audio still undecoded when a segment ends is cut
off from the phrase by the reset. How much audio follows a phrase before the
segment ends, and how much precedes it, therefore decides whether a phrase said
on its own is detected, which is why the silence holdoff and the lead-in above
match the Node engine's exactly.

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

The first build for a target downloads sherpa-onnx's prebuilt static libraries
for it: the `sherpa-onnx-sys` build script fetches
`sherpa-onnx-v1.13.8-<target>-static-lib.tar.bz2` from the sherpa-onnx release
of the same version and unpacks it under `target/sherpa-onnx-prebuilt/`, where
later builds find it. The Windows x64 archive is 123 MB and unpacks to about
1 GB; the Linux and macOS archives are about 22 MB. Two environment variables
change where the libraries come from:

- `SHERPA_ONNX_ARCHIVE_DIR`: a directory that already holds the archive, for a
  build with no network access;
- `SHERPA_ONNX_LIB_DIR`: an already unpacked `lib` directory, which skips the
  archive altogether.

Two builds that share a target directory, such as a terminal build and an
editor's background check, can both start the download and one then fails with
"The system cannot find the file specified". Run the build again once the
other has finished unpacking.

On Windows the prebuilt libraries are compiled against the static C runtime, so
`.cargo/config.toml` builds the engine with `+crt-static`. Cargo reads that
file only when it is run from this directory, and a `RUSTFLAGS` environment
variable replaces those flags rather than adding to them.

Some tokeniser tests need the real model and are ignored by default. To run
them, point `WAKE_WORD_MODEL_DIR` at the model directory described below:

```bash
WAKE_WORD_MODEL_DIR=<path> cargo test -- --ignored
```

## The keyword spotting model

`modelDir` in the config line is the extracted
`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` directory. The engine
reads five files from it: the three int8 networks, `tokens.txt`, and
`bpe.model`. The extension downloads and verifies the archive (`MODEL_URL` and
`MODEL_SHA256` in `src/sherpaEngine.ts`) the first time listening is enabled,
so for local development the directory is already in the editor's global
storage once the extension has run:

| Platform | Location |
| --- | --- |
| Windows | `%APPDATA%\Code\User\globalStorage\analytics-in-motion.wake-word\sherpa-onnx\` |
| macOS | `~/Library/Application Support/Code/User/globalStorage/analytics-in-motion.wake-word/sherpa-onnx/` |
| Linux | `~/.config/Code/User/globalStorage/analytics-in-motion.wake-word/sherpa-onnx/` |

Otherwise download the archive from `MODEL_URL`, check it against
`MODEL_SHA256`, and extract it anywhere.

## ONNX Runtime and the Silero model

Two copies of ONNX Runtime are in play, and they do not interact. The keyword
spotter's is part of the sherpa-onnx static libraries and is linked into the
executable. The voice activity detector's is separate: decibri is built with
its `ort-load-dynamic` feature, so neither that ONNX Runtime nor the voice
activity model is compiled into the binary. Both are found at run time, and
the microphone cannot open without them.

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
SELF-TEST:sherpa-onnx=<version the linked sherpa-onnx library reports>
SELF-TEST:ort=<library path, or "not found">
SELF-TEST:vad-model=<model path, or "not found">
```

It initialises ONNX Runtime and loads the Silero model the way a microphone
open does, but opens no microphone and loads no keyword spotting model, so it
is safe to run anywhere. Neither file being present is reported as `not found`
with exit 0. A library or model that is present but unusable is
`SELF-TEST:FAIL:<message>` with exit 1.

## Driving the binary

```bash
node scripts/drive-protocol.mjs            # add --bin <path> to drive another build
```

The script pipes commands into the built binary over a real pipe and asserts
the lines and exit codes that come back. Scenarios that load the keyword
spotting model need `WAKE_WORD_MODEL_DIR` to point at it. Scenarios that reach
`READY` also open the default microphone, so they need one, plus ONNX Runtime
and the Silero model; the script reads the self-test first and skips, saying
why, whatever cannot run.

To watch it work, run the binary in debug mode and say the phrase. `cat` keeps
stdin open after the config line, because the engine shuts down when stdin
closes; type `stop` and press Enter to end it:

```bash
{ printf '{"phrases":[{"phrase":"hey computer"}],"modelDir":"<path>","debugMode":true}\n'; cat; } | ./target/release/wake-word-engine
```

```text
DEBUG:wake-word-engine starting, modelDir=<path>
DEBUG:Timing: bpe-load 2ms
DEBUG:Timing: tokenise 0ms
DEBUG:phrase: hey computer -> tokens: ▁HE Y ▁COMP U TER -> decoded: HEY COMPUTER
DEBUG:loading sherpa-onnx KWS model...
DEBUG:Timing: model-load 450ms
DEBUG:voice activity model=<path>, ONNX Runtime=<path>
DEBUG:opening microphone...
DEBUG:Timing: mic-open 160ms
READY
DEBUG:mic open, VAD-gated, listening for: hey computer
DEBUG:VAD: speech (5 pre-roll chunks)
DEBUG:KWS result: {"start_time":0.00, "keyword": "HEY COMPUTER", ...}
DETECTED:hey computer
DEBUG:VAD: silence
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
with no usable phrase at all is fatal, which is decided once the phrases have
been tokenised. `modelDir` is the keyword spotting model directory described
above. `audioDevice` is a device index when it
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
| `DETECTED:<phrase>` | a wake phrase was heard; the phrase is as configured, lower-cased |
| `PAUSED` | microphone closed, everything else still loaded |
| `RELEASED` | microphone closed for good, the process is exiting |
| `ERROR:<msg>` | fatal; the process exits 1 |
| `DEBUG:<msg>` | diagnostics, only when `debugMode` is true |
| `SELF-TEST:<line>` | `--self-test` only |

`DETECTED` carries no confidence suffix: the keyword spotter applies its own
threshold and returns no usable score. The extension's parser accepts an
optional `|<conf>` suffix, and nothing sends one.

In debug mode each startup phase is timed as a `DEBUG:Timing: <phase> <n>ms`
line: `bpe-load` for the tokeniser model, `tokenise` for building the keyword
lines, `model-load` for the transducer, and `mic-open` for the microphone; each
reopen after a pause is `resume-mic-open`. The microphone figures include
loading the Silero model, which happens on every open. Debug mode also reports
how each phrase was tokenised, each speech and silence transition, the
spotter's full result for each detection, and, every 30 seconds, decibri's
overrun count when it has changed since the last report: a rising count means
the capture loop, keyword spotting included, is falling behind the microphone.

A failure before the microphone opens is one of three lines. `ERROR:Startup
error: <detail>` means the tokeniser model could not be read. `ERROR:No valid
phrases to detect` means no phrase survived tokenising. `ERROR:Failed to load
KWS model: <detail>` means a model file is missing or sherpa-onnx refused the
configuration, in which case the library's own explanation is on stderr.

### Shutdown

`stop`, stdin reaching EOF, SIGTERM, and SIGINT all close the microphone,
answer `RELEASED`, and exit 0. On Windows the console control handler stands in
for the signals; a child spawned by the extension host has no console, so
`stop` and stdin EOF are the paths that matter there. A fatal error exits 1.

stdout is flushed before the process exits. `RELEASED` and `ERROR:` are both
read by something on the other end of the pipe, and the extension waits up to
500 ms for `RELEASED` before it kills the child, so neither line may be lost.

A `pause` or a `stop` that arrives while the model is still loading is answered
at once; the load runs on its own thread. After a `stop` the engine lets a load
that is in flight finish, for up to three seconds, before it exits, because
exiting underneath the model loader can crash the process on its way out. The
load is told to stop at its next step, and `RELEASED` has been written by then.

## Layout

```text
engine-rs/
  Cargo.toml
  Cargo.lock
  .cargo/config.toml   links the static C runtime on Windows, as the sherpa-onnx libraries require
  src/
    main.rs        argument handling, the self-test, the stdin reader, signals, the event loop
    protocol.rs    chunk-safe line splitting, control-line parsing, stdout lines
    config.rs      the config JSON shape and its defaults
    lifecycle.rs   the state machine and the capture session
    capture.rs     decibri microphone and Silero setup, the capture loop, the capture and preparation threads
    hysteresis.rs  speech and silence transitions from the speech probability
    gate.rs        the pre-roll ring and the gate
    samples.rs     the [-1, 1] sample clamp
    keywords.rs    keyword lines (pieces, boost, threshold) and the decoded-to-phrase lookup
    tokeniser.rs   the SentencePiece tokeniser over the model's bpe.model
    spotter.rs     the sherpa-onnx spotter configuration, the decode loop, the stream resets, preparation
    mic_errors.rs  decibri error codes to user-facing messages
    assets.rs      where ONNX Runtime and the Silero model are looked for
  scripts/
    drive-protocol.mjs   pipes commands into the built binary and asserts the answers
```

The state machine holds no threads of its own and reacts only to events, so
every case can be driven from a test, including the ones that need an open to
still be in flight. The tokeniser and the transducer load on one thread, and
each microphone runs on a thread of its own: the thread opens it, reports back
through the same channel the stdin reader and the signal handler use, and then
runs the capture loop, keyword spotting included, until the microphone is
closed. Everything a microphone reports, a detection included, carries the id
of the open that produced it, and the state machine ignores reports from a
microphone it has closed. Closing a microphone waits for its thread to finish,
so nothing from a closed microphone reaches the spotter, and the spotter's
stream can be replaced safely once a pause has closed the microphone.

## Dependencies

| Crate | Why |
| --- | --- |
| `decibri` `=6.3.0` | microphone capture, conditioning, device selection, Silero voice activity detection, and the typed errors. Built without default features, with `capture`, `vad`, `gain`, and `ort-load-dynamic` |
| `sherpa-onnx` `=1.13.8` | the keyword spotter. The same release as the Node engine's `sherpa-onnx` package, so the model and its configuration carry over. Built with `static`, which links the C library and its own ONNX Runtime into the executable |
| `sentencepiece-rust` `=0.1.1` | tokenises the wake phrases with the model's `bpe.model`. Pure Rust, no dependencies of its own |
| `serde_json` | the config line |

The config line is read out of a `serde_json::Value` field by field rather than
deserialised into a struct, because the Node engine coerces rather than
rejects, and a derived struct would turn a phrase of the wrong type into a
fatal parse error instead of skipping it.

decibri is pinned to an exact version and bumped deliberately. `gain` provides
the AGC stage. decibri's default feature set would also build playback, the
denoise stage, and echo cancellation, none of which the engine uses.

sherpa-onnx is pinned to the release the Node engine uses and the two are
bumped together; a unit test fails if the library that was linked reports a
different version from the one `Cargo.toml` pins. The tokeniser is pure Rust
because the SentencePiece C++ library carries its own copy of protobuf, and so
does the ONNX Runtime inside the sherpa-onnx static libraries: one executable
cannot link both.
