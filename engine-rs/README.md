# wake-word-engine

A Rust implementation of `engine/audio-engine.js`: the child process the Wake
Word extension talks to over stdin and stdout.

**The extension does not run this binary.** `engine/audio-engine.js` under
system Node.js is the engine that runs. Nothing in `src/` spawns this binary.
Each platform `.vsix` carries it, built in CI, in `bin/` with the files it
loads at run time; see [Release builds](#release-builds).

## What it does

It speaks the whole protocol, opens a real microphone through the
[decibri](https://crates.io/crates/decibri) crate, gates the captured audio
with Silero voice activity detection, and feeds what passes the gate to a
[sherpa-onnx](https://crates.io/crates/sherpa-onnx) keyword spotter. When the
spotter hears a configured phrase the engine writes `DETECTED:<phrase>`. The
model files, the keyword line syntax, the boost, and the thresholds are the
Node engine's. The engine has no tokeniser: the extension tokenises the wake
phrases and sends the finished keyword lines in the config line.

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
| `modeling_unit`, `bpe_vocab` | `bpe`, `bpe.model`, as the Node engine passes them; the keyword spotter uses neither and does not check that the file exists |
| max active paths | 4 |
| trailing blanks | 1 |
| keywords score | 1.0 |
| keywords threshold | the clamped `threshold` from the config |
| keywords | `keywordLines` from the config, passed in memory, never written to a file |

The spotter does not take plain text. Each phrase reaches it as one keyword
line: the SentencePiece pieces for the upper-cased phrase, then a boost score
and the phrase's own trigger threshold, for example
`▁HE Y ▁C LA U DE :3.0 #0.05`. The extension builds the lines, with a boost of
3.0 and the clamped `wakeWord.confidenceThreshold` as every line's threshold.
A per-phrase threshold replaces the spotter-wide one, so the lines are where
that setting takes effect. The spotter reports a hit as the decoded text of the
pieces (`HEY CLAUDE`), and the engine maps that back through `phraseMap` to the
phrase as configured, lower-cased, before writing `DETECTED:`.

The pieces come from the model's SentencePiece file, `bpe.model`, which the
extension reads with the same tokeniser the Node engine uses. Despite its name
the file is a Unigram model with the `nmt_nfkc` normaliser: pieces are chosen
by a best-path search over piece scores, not by merge rules, and full-width and
ligature forms fold to plain letters first.

Before the model loads, the engine checks every keyword line against the
model's `tokens.txt`. The library does not report a bad line as an error: a
word it cannot find in the token table (a digit or an accented letter, which
SentencePiece returns as itself) makes it end the process, and so does a boost
or threshold it cannot read as a number, with nothing written for the extension
to show. The engine refuses such a line first, as a fatal
`Failed to load KWS model:` error that names the phrase or the line, and it
refuses a line with a NUL character, a line break, or no pieces in the same
way. The extension leaves such phrases out before they reach the engine; the
check is there for any line that arrives anyway.

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
for it: the `sherpa-onnx-sys` build script fetches the official
`sherpa-onnx-v1.13.8-<target>-static-lib.tar.bz2` from the sherpa-onnx release
of the same version and unpacks it under `target/sherpa-onnx-prebuilt/`, where
later builds find it. The Windows x64 archive is 123 MB and unpacks to about
1 GB; the Linux and macOS archives are about 22 MB. Two environment variables
change where the libraries come from:

- `SHERPA_ONNX_ARCHIVE_DIR`: a directory that already holds the archive, for a
  build with no network access or against another archive of the same name;
- `SHERPA_ONNX_LIB_DIR`: an already unpacked `lib` directory, which skips the
  archive altogether.

The release build links different archives: the same sherpa-onnx release built
without the text-to-speech components, pinned in `scripts/pinned-inputs.mjs`
(see [Release builds](#release-builds)). To build against those locally:

```bash
# from the repository root
node engine-rs/scripts/prebuilt.mjs fetch --target win32-x64 --dir <dir>   # or darwin-arm64, linux-x64, linux-arm64
cd engine-rs
SHERPA_ONNX_ARCHIVE_DIR=<dir> cargo build --release
```

A target directory keeps linking the libraries its last `sherpa-onnx-sys`
build used. The build script runs again only when `SHERPA_ONNX_ARCHIVE_DIR` or
`SHERPA_ONNX_LIB_DIR` changes, and the libraries are copied into that crate's
build output, so deleting `target/sherpa-onnx-prebuilt/` alone does not change
what the next build links; nor does a new `SHERPA_ONNX_ARCHIVE_DIR` while the
unpacked copy is there. To switch archives, delete that directory and run
`cargo clean -p sherpa-onnx-sys`, or build with an empty `CARGO_TARGET_DIR`.

Two builds that share a target directory, such as a terminal build and an
editor's background check, can both start the download and one then fails with
"The system cannot find the file specified". Run the build again once the
other has finished unpacking.

On Windows the prebuilt libraries are compiled against the static C runtime, so
`.cargo/config.toml` builds the engine with `+crt-static`. Cargo reads that
file only when it is run from this directory, and a `RUSTFLAGS` environment
variable replaces those flags rather than adding to them.

## Release builds

CI and the release workflow build the engine on each package target's own
runner, with no cross-compilation, through `.github/actions/engine-rs`, then
package it and check the package. Every input is pinned in
`scripts/pinned-inputs.mjs` by size and SHA-256 and checked before it is
used; a mismatch fails the build.

| Target | Runner | Build |
| --- | --- | --- |
| `win32-x64` | `windows-latest` | `cargo rustc --release -- -D linker-messages`, so a linker warning such as LNK4098 fails it |
| `darwin-arm64` | `macos-latest` | `cargo rustc --release`, deployment target macOS 11.0 |
| `linux-x64` | `ubuntu-latest` | inside `quay.io/pypa/manylinux_2_28_x86_64` |
| `linux-arm64` | `ubuntu-24.04-arm` | inside `quay.io/pypa/manylinux_2_28_aarch64` |

**The sherpa-onnx libraries.** The release build links sherpa-onnx 1.13.8
built without the text-to-speech components, which the engine never calls: one
archive per target, under the official archive's name and layout, built by
`.github/workflows/engine-archives.yml` (see `archives/README.md`) and hosted
on this repository's `sherpa-onnx-v1.13.8` release. `scripts/prebuilt.mjs
fetch` downloads the target's archive from there, or takes it from the
workflow cache, and checks it. `SHERPA_ONNX_ARCHIVE_DIR` makes the build
script copy that file instead of downloading the official one, and
`scripts/prebuilt.mjs check` then checks the copy the build script unpacked,
because the build script uses an unpacked directory without looking at the
archive. `prebuilt.mjs` refuses to run when `Cargo.lock` resolves a
sherpa-onnx-sys version that has no pinned archives.

**The Linux floor.** The Linux binary is built against glibc 2.28 and GCC 8's
libstdc++ (GLIBCXX 3.4.25), the same floor the editor has on Linux, so it runs
on every distribution the editor supports. A binary linked on the runner would
take the runner's newer symbol versions instead. The sherpa-onnx libraries are
compiled in the same image family, by GCC 11 against glibc 2.28, and the ONNX
Runtime they carry by GCC 11 against an older glibc; the image's compiler
links the libstdc++ symbols newer than GCC 8 that they use into the binary.
The runtime needs `libasound.so.2`, the ALSA library, which desktop
distributions install.

**The runtime files.** `scripts/stage.mjs` copies the binary into `bin/` at
the repository root, which `.vscodeignore` ships, and adds the files it loads
from beside itself. Both come from decibri's npm packages, version 5.7.0,
checked against the registry's integrity value and then file by file:

| File | From | Notes |
| --- | --- | --- |
| `onnxruntime.dll`, `libonnxruntime.dylib`, or `libonnxruntime.so` | `@decibri/decibri-<platform>` | ONNX Runtime 1.28.1 |
| `silero_vad.onnx` | `decibri` | Silero VAD v6.2 |
| `ONNXRUNTIME-NOTICES.md`, `SILERO-VAD-NOTICES.md` | the same packages | the license notices those files carry |

The Linux packages also carry `libonnxruntime_providers_shared.so`. ONNX
Runtime loads it only to register an execution provider other than the CPU,
and `libonnxruntime.so` does not list it as a dependency, so it is not
shipped.

Each ONNX Runtime build sets a floor of its own. The macOS library needs
macOS 14.0. The Windows library links the dynamic Visual C++ runtime
(`vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll`), which is not part
of Windows itself; the engine binary links the static runtime and needs none
of it.

On macOS, `stage.mjs` signs the binary ad hoc after copying it, because Apple
silicon runs no unsigned code and stripping can leave the linker's signature
stale, and verifies the signature.

**The package check.** After `vsce package`, `scripts/verify-vsix.mjs` at the
repository root reads the `.vsix` and fails unless:

- the extension, the Node engine, and `node_modules/sentencepiece-js` are in it;
- `bin/` holds the engine for the target's architecture, stored executable on
  macOS and Linux, and the pinned runtime files and notices;
- on Windows the engine imports no C runtime DLL and does not import ONNX
  Runtime; on Linux neither the engine nor ONNX Runtime needs anything newer
  than glibc 2.28 or GLIBCXX 3.4.25, and the engine exports no ONNX Runtime
  symbol; on macOS neither needs anything newer than macOS 14.0, and both pass
  `codesign --verify` once unpacked;
- the engine's self-test, run from the unpacked package with no environment
  variables pointing elsewhere, reports `OK`, the pinned sherpa-onnx version,
  and ONNX Runtime and the Silero model as loaded from beside the binary. The
  self-test exits 0 when either file is missing, so its exit code is not
  enough.

The workflows then run `scripts/drive-protocol.mjs --no-microphone` against
the unpacked binary, with the keyword spotting model downloaded and checked
by `scripts/fetch-model.mjs` at the repository root. The scenarios that open
a microphone are skipped. The rest include loading the spotter and then a
Silero session in one process, which puts both ONNX Runtimes in it. On Linux
the workflow also fails if `nm -D --defined-only` finds a symbol matching
`ort` or `onnx` in the engine. An exported symbol could be bound by the loaded
ONNX Runtime in place of its own.

## The keyword spotting model

`modelDir` in the config line is the extracted
`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` directory. The engine
reads four files from it: the three int8 networks and `tokens.txt`. The
directory also holds `bpe.model`, the SentencePiece model the extension
tokenises the phrases with. The extension downloads and verifies the archive (`MODEL_URL` and
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
carries both files: the model in `engine/node_modules/decibri/models/` and
ONNX Runtime in the platform package under `engine/node_modules/@decibri/`.
Point the environment at them:

```bash
# from the repository root, after `cd engine && npm install`
export ORT_DYLIB_PATH="$PWD/engine/node_modules/@decibri/decibri-win32-x64-msvc/onnxruntime.dll"
export WAKE_WORD_VAD_MODEL="$PWD/engine/node_modules/decibri/models/silero_vad.onnx"
```

Or lay the binary out as the `.vsix` does, with both files beside it, which
needs no variables:

```bash
# from the repository root, after `cargo build --release` in engine-rs/
node engine-rs/scripts/stage.mjs --target win32-x64   # or darwin-arm64, linux-x64, linux-arm64
bin/wake-word-engine.exe --self-test
```

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
spotting model need `WAKE_WORD_MODEL_DIR` to point at it. Scenarios that load
the Silero model need ONNX Runtime and the model, and scenarios that reach
`READY` also open the default microphone, so they need one;
`--no-microphone` skips those on a machine without one. The script reads the
self-test first and skips, saying why, whatever cannot run.

To watch it work, run the binary in debug mode and say the phrase. `cat` keeps
stdin open after the config line, because the engine shuts down when stdin
closes; type `stop` and press Enter to end it:

```bash
{ printf '{"keywordLines":["▁HE Y ▁COMP U TER :3.0 #0.05"],"phraseMap":{"HEY COMPUTER":"hey computer"},"modelDir":"<path>","debugMode":true}\n'; cat; } | ./target/release/wake-word-engine
```

```text
DEBUG:wake-word-engine starting, modelDir=<path>
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

The first line is a JSON config object:

```json
{
  "phrases": [{ "phrase": "hey claude", "label": "Claude" }],
  "threshold": 0.05,
  "modelDir": "<path>",
  "debugMode": false,
  "audioDevice": "",
  "keywordLines": ["▁HE Y ▁C LA U DE :3.0 #0.05"],
  "phraseMap": { "HEY CLAUDE": "hey claude" }
}
```

`keywordLines` and `phraseMap` are required; every other field is optional.
The extension tokenises the phrases: `keywordLines` holds one keyword line per
phrase, and `phraseMap` maps the decoded text of each line's pieces, which is
what the spotter reports on a hit, to the phrase as configured, lower-cased.
Entries that are not strings are ignored. Without `keywordLines` the engine
answers `ERROR:Startup error: ...`, with an empty array
`ERROR:No valid phrases to detect`, and without `phraseMap` entries
`ERROR:Startup error: ...`, all before anything loads. The extension leaves out
a phrase whose pieces are not all in the model's token table, with a warning,
so one bad route does not take the engine down; the engine's own check, above,
catches any such line that arrives anyway.

`phrases` is there for engines that tokenise for themselves; this one does not
read it. `threshold` is clamped to 0.01 to 0.9, defaulting to 0.05, and passed
as the spotter-wide threshold; each line carries its own. `modelDir` is the
keyword spotting model directory described above. `audioDevice` is a device
index when it is nothing but digits, otherwise a case-insensitive name
substring; empty means the system default. `vadModelPath` and `ortLibraryPath`
are described above; the extension does not send them.

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
line: `model-load` for checking the keyword lines and loading the transducer,
and `mic-open` for the microphone; each reopen after a pause is
`resume-mic-open`. The extension times the tokenising itself. The microphone
figures include loading the Silero model, which happens on every open. Debug
mode also reports each speech and silence transition, the spotter's full
result for each detection, and, every 30 seconds, decibri's overrun count when
it has changed since the last report: a rising count means the capture loop,
keyword spotting included, is falling behind the microphone.

A failure before the microphone opens is one of three lines. `ERROR:Startup
error: <detail>` means the config has no `keywordLines` or no `phraseMap`.
`ERROR:No valid phrases to detect` means `keywordLines` is empty.
`ERROR:Failed to load KWS model: <detail>` means a model file is missing, a
keyword line is one the spotter cannot take (the detail names the phrase or the
line), or sherpa-onnx refused the configuration, in which case the library's
own explanation is on stderr.

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
    config.rs      the config JSON shape, its defaults, and the decoded-to-phrase map
    lifecycle.rs   the state machine and the capture session
    capture.rs     decibri microphone and Silero setup, the capture loop, the capture and preparation threads
    hysteresis.rs  speech and silence transitions from the speech probability
    gate.rs        the pre-roll ring and the gate
    samples.rs     the [-1, 1] sample clamp
    spotter.rs     the sherpa-onnx spotter configuration, the decode loop, the stream resets, the keyword line check, preparation
    mic_errors.rs  decibri error codes to user-facing messages
    assets.rs      where ONNX Runtime and the Silero model are looked for
  scripts/
    drive-protocol.mjs   pipes commands into the built binary and asserts the answers
    pinned-inputs.mjs    the size and SHA-256 of everything the release build downloads
    prebuilt.mjs         fetches and checks the sherpa-onnx archive, before and after the build
    stage.mjs            puts the binary and its runtime files into bin/ for packaging
    download.mjs         downloading and digest checks, shared by the scripts above
```

The state machine holds no threads of its own and reacts only to events, so
every case can be driven from a test, including the ones that need an open to
still be in flight. The transducer loads on one thread, and each microphone
runs on a thread of its own: the thread opens it, reports back
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
| `serde_json` | the config line |

The config line is read out of a `serde_json::Value` field by field rather than
deserialised into a struct, because the Node engine coerces rather than
rejects, and a derived struct would turn a value of the wrong type into a
fatal parse error instead of ignoring it.

decibri is pinned to an exact version and bumped deliberately. `gain` provides
the AGC stage. decibri's default feature set would also build playback, the
denoise stage, and echo cancellation, none of which the engine uses.

sherpa-onnx is pinned to the release the Node engine uses and the two are
bumped together; a unit test fails if the library that was linked reports a
different version from the one `Cargo.toml` pins.
