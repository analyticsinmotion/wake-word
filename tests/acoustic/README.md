# Acoustic Benchmark

Measures false rejection rate (FRR), false acceptance rate (FAR), and
detection latency for the Wake Word keyword spotter, using the same
sherpa-onnx model, keyword list, and threshold the extension runs.

This is the framework and a starter fixture. The numbers only mean
something once real recordings are in `fixtures/`. It is a manual tool,
not a CI step.

## What it measures

- **FRR** (false rejection rate): of the recordings that contain a wake
  phrase, the share where the spotter did not fire that phrase. Reported
  per phrase and overall. A recording where a different phrase fired
  counts as a miss and is also listed as "wrong phrase".
- **FAR** (false acceptance rate): of the recordings that contain no wake
  phrase, the share where anything fired. Also reported as false triggers
  per hour of negative audio, which is the figure that matters for an
  extension that listens all day.
- **Latency**: on each positive recording that was detected, the seconds
  of audio the spotter had consumed when it fired, minus the spotter's own
  timestamp for the last token of the phrase. That is how long after you
  stop speaking the detection lands. The spotter's timestamps are only
  absolute up to the first hit in a clip (its clock restarts at the reset
  that follows each hit), so a clip whose first hit is a different phrase
  contributes nothing here, and the `n` in the report says how many clips
  did. A positive clip holds one phrase, so this is the normal case. If no
  clip contributes, the report falls back to time from the start of the
  clip and says so.

What it does not include: the microphone path. The extension captures
audio with decibri under a voice activity gate and conditions it (DC
removal, an 80 Hz high-pass, and AGC) before the spotter sees it. The
benchmark feeds the file straight into the spotter in 100 ms chunks, the
same chunk size decibri delivers. So these numbers describe the model and
threshold alone; the gate and conditioning in a live session can move
them in either direction.

## Adding recordings

Place `.wav` files in the two fixture directories:

- `fixtures/positive/`: recordings in which you say one wake phrase.
  Name each file `<phrase>-<nn>.wav`, for example `hey-claude-01.wav`.
  Everything before the trailing take number, with hyphens read as
  spaces, is the phrase the spotter is expected to fire. A recording of
  a phrase that is not one of the default routes is fine: the phrase is
  added to the keyword list automatically.

- `fixtures/negative/`: recordings that must not trigger anything.
  Conversation, typing, music, room noise, a podcast, silence. Any file
  name.

Recording requirements:

- 16 kHz sample rate, mono, 16-bit PCM WAV. A stereo file is averaged to
  mono with a note; any other sample rate is rejected, so convert first.
- 2 to 5 seconds per positive clip, with the phrase near the start.
  10 to 30 seconds per negative clip.
- Record in your normal working environment, not a sound booth, with
  the microphone you actually use.
- At least three takes of each phrase, at different distances and
  speaking levels. Ten per phrase gives FRR a resolution of 10%.

Whether to commit recordings is a separate decision. A 3 second clip is
about 100 KB and a 30 second one about 1 MB, so a dozen clips fit in the
repository without trouble. For now only the framework and the generated
`fixtures/negative/silence-10s.wav` are committed; real recordings are
local until decided otherwise.

## Running the benchmark

```bash
npm run benchmark
# or
node tests/acoustic/run-benchmark.js [--model-dir <path>] [--threshold <n>]
                                     [--phrases <a,b,c>] [--fixtures <dir>] [--verbose]
```

The script needs `engine/node_modules` (`cd engine && npm install`) and
the keyword spotting model. Without `--model-dir` it looks in each
editor's global storage for the copy the extension downloads when the
sherpa engine runs, so the simplest way to get the model is to set
`wakeWord.engine` to `sherpa` once and let the extension fetch it. To use
a copy elsewhere, extract the tarball named in `src/sherpaEngine.ts` and
pass its directory.

- `--threshold` is the keyword threshold, 0.1 to 0.9, default 0.3, the
  same default as `wakeWord.confidenceThreshold`. Run the benchmark at
  several values to see how FRR and FAR trade off.
- `--phrases` replaces the keyword list. By default it is the default
  routes' phrases plus every phrase a positive fixture names, and the
  report prints it, because FAR depends on what was loaded.
- `--verbose` prints one line per file showing what fired and when.

With no recordings the script reports that and exits 0, so it is safe to
run before any are added.

## Output

```text
=== Acoustic Benchmark ===
Model:      sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
Threshold:  0.3
Keywords:   hey claude, hey copilot, hey computer
Fixtures:   tests/acoustic/fixtures

Positive (FRR):
  hey claude:    8/10 detected (FRR: 20%)
  hey computer:  10/10 detected (FRR: 0%)
  hey copilot:   9/10 detected (FRR: 10%)
  all:           27/30 detected (FRR: 10%)

Negative (FAR):
  0/5 files with a false trigger (FAR: 0%)
  0 false triggers in 120.0s of audio (0.00 per hour)

Latency (from the end of the phrase):
  Mean: 0.45s  Median: 0.42s  P95: 0.68s  (n=27)
```

## Layout

```text
tests/acoustic/
  README.md              this file
  run-benchmark.js       drives the sherpa-onnx spotter over the fixtures
  lib/benchmark-core.js  WAV parsing, fixture naming, statistics, report
  benchmarkCore.test.js  unit tests for the pure module (run by npm test)
  fixtures/
    positive/            <phrase>-<nn>.wav
    negative/            anything that must not trigger; silence-10s.wav is committed
```

`benchmark-core.js` has no dependency on the engine and is covered by
`npm test`. `tests/unit/benchmarkConstants.test.ts` checks that its copy
of the default phrases and the model file list match the extension's, so
a change to either fails the suite until the benchmark follows.
