# Wake Word - VS Code Extension

## Commands

```bash
npm install                # Install dependencies
npm run compile            # Build TypeScript to dist/
npm run watch              # Build in watch mode
npm run lint               # Run ESLint (flat config, eslint.config.mjs) + SVG check on README.md. Do not use --fix.
npm test                   # Run the unit test suite once (vitest)
npm run test:watch         # Run the unit tests in watch mode
npm run package            # Build .vsix package
npm run benchmark          # Acoustic benchmark over tests/acoustic/fixtures (manual; needs `npm run compile`, sherpa-onnx installed with --no-save, and the speech model)

# Engine packaging (after `cargo build --release` in engine-rs/)
node engine-rs/scripts/stage.mjs --target win32-x64             # Engine, ONNX Runtime, Silero model into bin/
npx vsce package --target win32-x64 -o ww.vsix                  # Package with bin/ included
node scripts/verify-vsix.mjs --target win32-x64 --vsix ww.vsix --extract-to <dir>   # Check the package, run its self-test
bin/wake-word-engine --self-test                                # What the binary found, without opening a microphone
```

`--self-test` opens no microphone and loads no keyword spotting model, so it is
safe to run anywhere; it does load the voice activity model, which is what makes
it report a missing inference runtime. CI runs it on all four platforms, from
the unpacked package.

Run `npm run lint`, `npm run compile`, and `npm test` before committing. All
three must pass cleanly.

Press F5 in VS Code to launch the Extension Development Host for manual testing.

## Project Structure

```text
wake-word/
  src/
    extension.ts              # VS Code extension entry point, commands, status bar, consent flow, diagnostics
    speechEngineInterface.ts  # ISpeechEngine interface (implemented by SherpaEngine)
    sherpaEngine.ts           # SherpaEngine: the engine child process (the binary in bin/), every platform; model download
    keywords.ts               # Keyword lines (pieces, boost, threshold), the decoded-to-phrase map, unspottable phrases skipped
    tokeniser.ts              # SentencePiece tokenising in a worker thread; the model's token table
    tarExtract.ts             # Model archive extraction: gzip via zlib, a minimal ustar reader, path traversal guard
    wakeWordCore.ts           # Pure logic shared by the host and the engine: protocol, handoff order, phrase checks, diagnostics, session stats
    lockFile.ts               # PID lock in globalStorage so only one editor window listens
  engine-rs/           # The engine child process, in Rust, built into bin/; see below
    src/main.rs        # Argument handling, the self-test, the stdin reader, signals, the event loop
    src/protocol.rs    # Chunk-safe line splitting, control-line parsing, the stdout vocabulary
    src/config.rs      # The config JSON shape, threshold clamp, audio device resolution, the decoded-to-phrase map
    .cargo/config.toml # Static C runtime on Windows, which the sherpa-onnx static libraries are built against
    src/lifecycle.rs   # The state machine and the capture session
    src/capture.rs     # decibri microphone and Silero setup, the capture loop, the capture and preparation threads
    src/hysteresis.rs  # Speech and silence transitions from the speech probability
    src/gate.rs        # Pre-roll ring buffer and VAD gate
    src/samples.rs     # The [-1, 1] sample clamp
    src/spotter.rs     # sherpa-onnx spotter configuration, decode loop, stream resets, the keyword line check, preparation
    src/mic_errors.rs  # decibri error codes to user-facing messages
    src/assets.rs      # Where ONNX Runtime and the Silero model are looked for
    scripts/drive-protocol.mjs  # Pipes commands into the built binary and asserts the answers; --no-microphone for CI
    scripts/pinned-inputs.mjs   # Size and SHA-256 of the sherpa-onnx archives and the runtime files the release build downloads
    scripts/prebuilt.mjs        # Fetches and checks the sherpa-onnx archive before the build, and the unpacked copy after it
    scripts/stage.mjs           # Puts the binary, ONNX Runtime, the Silero model and their notices into bin/; signs on macOS
    scripts/download.mjs        # Downloading and digest checks shared by those scripts
    archives/build.sh           # Builds the sherpa-onnx libraries without text-to-speech for one target and adds the placeholder libraries
    archives/verify.mjs         # Checks an archive built that way against the official one; archives/objects.mjs reads the libraries
  bin/                 # Staged by engine-rs/scripts/stage.mjs for packaging; gitignored, shipped in the .vsix
  tests/
    unit/              # TypeScript tests for the extension host code
    mocks/vscode.ts    # Stub for the `vscode` module, wired up in vitest.config.mts
    mocks/childProcess.ts  # MockChildProcess: drives the engine state machine without a real process
    acoustic/          # Acoustic benchmark: FRR, FAR, and latency over WAV recordings (manual, not CI)
      README.md              # How to record the fixtures and run the benchmark
      run-benchmark.js       # Drives the sherpa-onnx spotter over fixtures/positive and fixtures/negative
      benchmarkCore.test.js  # Tests for lib/benchmark-core.js
      modelPath.test.js      # Tests for lib/model-path.js
      lib/benchmark-core.js  # WAV parsing, fixture naming, statistics, report; unit tested
      lib/model-path.js      # Forward-slash model paths for the sherpa-onnx package's WASM VFS; unit tested
      fixtures/              # positive/<phrase>-<nn>.wav and negative/*.wav; only silence-10s.wav is committed
  scripts/
    check-readme.js    # Lint-time check: blocks vsce-restricted SVGs in README.md
    verify-vsix.mjs    # CI: checks a platform .vsix's contents and runs the packaged engine's self-test
    fetch-model.mjs    # CI: downloads, verifies and extracts the keyword spotting model for tests
  eslint.config.mjs    # ESLint 10 flat config. Pins the ESLint 8 rule set; see the comments in the file
  dist/                # Compiled JS output (do not edit)
  .github/
    dependabot.yml     # Dependency updates for / and /engine-rs
    actions/engine-rs/action.yml  # Builds and stages the engine for one target; used by both workflows
    workflows/
      ci.yml           # CI: lint, compile, test with the model, engine build, .vsix package and check, drive script
      release.yml      # CI: engine build, build and check .vsix, drive script, publish to Marketplace and Open VSX
      engine-archives.yml  # Manual: the sherpa-onnx archives without text-to-speech for the four targets, checked and uploaded
```

`extension.ts` owns all VS Code API interactions. `sherpaEngine.ts` implements `ISpeechEngine` on every platform. The engine is a child process, the binary in `bin/`, never code in the extension host. Keep this separation clean.

`wakeWordCore.ts` holds the pure logic the extension host and the engine share: phrase normalisation, route validation, the stdout protocol parser, the debounce guard, the confirmation check, the threshold clamp, the handoff order (`releaseThenFire()`), the phrase quality and collision checks, and the diagnostics report. It imports nothing from `vscode`, so it is directly unit testable. Put shared pure logic there rather than inline in `extension.ts`.

## Architecture

The extension builds its speech engine with `createEngine()`, which returns a `SherpaEngine` on every platform, and wires it with `wireEngine()`. The engine's child communicates via stdout: `READY`, `DETECTED:<phrase>|<confidence>` (the confidence suffix is optional, and the child never sends it), `PAUSED`, `RELEASED`, `ERROR:<message>`, and `DEBUG:<info>`. After its config line the child also reads commands on stdin: `pause`, `resume`, and `stop`. The extension reads stdout, matches phrases, and fires VS Code commands. All events are logged to a dedicated "Wake Word" output channel.

sherpa-onnx's keyword spotter applies its own threshold and returns no usable score, so the engine sends `DETECTED:<phrase>` with no suffix and `SherpaEngine` emits the detection with no confidence. Do not reintroduce a placeholder score: a fixed `confidence: 1.00` in the log looked like a real score when it was not. `formatConfidence()` and the calibration averages still handle a score, and render nothing without one.

**Keyword boost and trigger threshold.** `buildKeywordSpec()` ends every keyword line with the fields `:3.0 #<threshold>`, after the pieces, for example `▁HE Y ▁C LA U DE :3.0 #0.05`. `src/keywords.ts` builds the lines, and the host sends them in the config line. sherpa-onnx parses the two fields off the line: `:3.0` is the boost score, which biases decoding toward that phrase's token sequence (1.0 when absent), and `#<threshold>` is the phrase's own trigger threshold. The fields are not part of the keyword the spotter reports on a hit, so `phraseMap` keys and the `details` tokens stay bare pieces.

`wakeWord.confidenceThreshold` is that `#` value. A per-phrase threshold replaces the global `keywordsThreshold` for its phrase, and every line carries one, so the global value (still passed, with the same number) decides nothing; the setting only takes effect through the keyword lines. This was confirmed against the real model with the archive's test WAVs: a line threshold of 0.9 detected nothing whether the global value was 0.05 or 0.9, and 0.05 detected every phrase at a global 0.9. A route may carry a `confidenceThreshold` of its own, and then every line built from that route, aliases included, ends with that value instead of the global one; `buildKeywordSpec()` reads it from the route, so nothing else in the host or the engine has to know the value came from a route. The value is clamped with the same bounds everywhere it is used: `clampThreshold()` in `wakeWordCore.ts`, called in `SherpaEngine.start()` and again inside `buildKeywordSpec()`, once for the global value and once per route with the clamped global value as the fallback, and `clamp_threshold()` in the engine's `config.rs`, so a missing or unusable value writes the global value or the default instead of a line sherpa-onnx cannot parse. The range is 0.01 to 0.9 and the default 0.05 (`MIN_THRESHOLD` and `DEFAULT_THRESHOLD`; `config.rs` repeats the numbers, and the package.json schema must match). The boost and the 0.05 default were tested on Windows with the gigaspeech 3.3M model: before 0.13.2 the lines had no fields and the default was 0.3, and uncommon words such as "claude" in the default phrases were not reliably detected. A user who set 0.3 explicitly keeps it. A change to the setting reaches a running engine: see Settings changes below. The acoustic benchmark builds its list with the same function, and its `--threshold` has the same range and default. `formatDiagnostics()` prints a route's own threshold beside that route, and nothing for a route without one, so a pasted report shows which phrases were listening at which value; `describeThreshold()` gives the `Starting:` and `Calibration: starting` log lines the global value and a count of the routes that replace it, since neither line can name one value for every phrase.

**Default routes.** `DEFAULT_ROUTES` in `extension.ts` has three: Claude (`"hey claude"`, `claude-vscode.focus`, manual handoff), Chat (`"hey chat"` and `"open chat"`, `workbench.action.chat.open`), and Terminal (`"hey computer"` and `"open terminal"`, `workbench.action.terminal.focus`). None of them sets a `confidenceThreshold`, so all three listen at the global value; giving one its own is a tuning decision to make on measurement, not a default. The chat route was "Copilot" / `"hey copilot"` before 0.13.2; it was renamed because `workbench.action.chat.open` opens the editor's generic chat panel, whichever chat extension is active. `tests/acoustic/lib/benchmark-core.js` carries a copy of the phrases, pinned by `tests/unit/benchmarkConstants.test.ts`. The README's custom route example uses `chatgpt.newCodexPanel` for a Codex route; that command ID is documentation reference only and is not a default route.

**SherpaEngine** spawns `bin/wake-word-engine` (`.exe` on Windows) from the installed extension, with no arguments, and sends its config as a JSON line on stdin. Before it spawns, `prepareNativeEngine()` checks that the file exists and, on macOS and Linux, that it is executable, setting mode 755 when it is not: the package records the mode and the editor restores it on install, but an extension unpacked another way can lose it. A binary that is missing, cannot be made executable, or fails to spawn is reported with its path. The binary needs nothing installed: it finds ONNX Runtime and the voice activity model beside itself (see the engine below). The child is started with `windowsHide: true`, so Windows gives the console program no window of its own. Model extraction starts no process at all (see below).

The config line carries `audioDevice`, the `wakeWord.audioDevice` setting, which the engine's `config.rs` resolves to decibri's device selector: a digit-only string is a device index, anything else a case-insensitive name substring, and empty means the system default. A lookup failure is reported by the engine's `mic_errors.rs` with the value and the setting named. The extension builds a new `SherpaEngine` when the setting changes.

**Tokenising in the host.** After `ensureModel()`, and before it spawns, `SherpaEngine.start()` tokenises the routes' phrases: `tokenise()` in `tokeniser.ts` encodes each upper-cased phrase with the model's `bpe.model`, `readVocabulary()` reads its `tokens.txt`, and `buildKeywordSpec()` in `keywords.ts` builds the keyword lines and the decoded-to-phrase map. The config line carries them as `keywordLines` and `phraseMap`; the engine has no tokeniser and reads nothing else to decide what it listens for. A phrase with a piece `tokens.txt` lacks (a digit, an accented letter, punctuation other than the apostrophe and the hyphen) cannot be spotted, because the sherpa-onnx library ends the process on such a piece. So it is skipped with a `warning` that names it and the piece and left out of the lines and the map, so one bad route does not stop the engine. Only when no phrase is left does `start()` emit `No valid phrases to detect`, without spawning; a tokeniser that fails is `Could not tokenise the wake phrases: <reason>`, also without spawning. A stop or a newer start during the tokenising abandons the start, as during the model check. `bpe.model` is a SentencePiece Unigram model despite its name: pieces come from a best-path search over piece scores, so only a SentencePiece implementation gives the pieces the spotter expects.

**The tokeniser runs in a worker thread.** `sentencepiece-js` is SentencePiece compiled to WebAssembly, and the JavaScript that loads its module adds to `process`, on every load, an `uncaughtException` listener that rethrows and an `unhandledRejection` listener that throws. A listener that throws from `uncaughtException` is fatal to Node, so on the extension host's own thread any other extension's stray error would crash the extension host for every extension in the window; each load would also keep its 16 MB heap reachable. A worker has a `process` object of its own, so the listeners and the heap go when the worker ends. Never load `sentencepiece-js` on the extension host's thread; `tests/unit/tokeniser.test.ts` checks that the host thread's listeners are untouched. The worker's source is a string started with `eval: true`, so it runs the same under vitest and from `dist/`, and a worker that has not answered within `TOKENISE_TIMEOUT_MS` (30 s) is stopped. `sentencepiece-js` is the extension's one runtime dependency, pinned exactly to the engine's version. `.vscodeignore` excludes `node_modules/**` and lets `node_modules/sentencepiece-js/**` back in: without that line the package builds without it and the host fails to start the engine. The `app-root-path` package it declares is never loaded by it and is not shipped.

The engine only feeds audio to the keyword spotter while speech is present, so an idle editor does not run the transducer. Chunks wait in a 500 ms pre-roll ring while the detector reports silence and are flushed when speech starts; drop the pre-roll and the onset of the wake phrase never reaches the spotter. Capture is conditioned with DC removal, an 80 Hz high-pass, and AGC targeting -18 dBFS, and delivered as float32, which `samples.rs` clamps to [-1, 1]: AGC can overshoot full scale, and float32, unlike int16, does not saturate. In debug mode the engine emits `DEBUG:overruns: <n>` whenever decibri's overrun count has changed, checked every 30 seconds; a rising count means the decode loop is falling behind capture.

**Persistent engine process.** On wake word detection the microphone is released (handoff) and taken back after the cooldown, so only one thing uses the mic at a time. The sherpa child is not torn down for this. `SherpaEngine.pause()` writes `pause`; the child's capture session (`lifecycle.rs`) closes the microphone, resets the VAD gate, replaces the spotter's stream, and prints `PAUSED`, with every model still loaded. `resume()` writes `resume`, and the child opens a new microphone and prints `READY`, which the engine handles exactly like the first one. The pause is acknowledged, not assumed: `pauseChild()` force-kills a child that has not said `PAUSED` within 500 ms, and the next `resume()` starts a new child, as it does when the paused child has died. A child that crashes while paused (`childPaused`) is not retried, because the retry would reopen the microphone during the handoff; a crash while resuming is retried like a crash during a start. `stop()` sends `stop` to a child that has said READY (listening, paused, or resuming) and `releaseThenKill()` waits for `RELEASED`, capped at 500 ms; a child still loading, which reads no commands until the load finishes, is force-killed, and so is every child `dispose()` finds. Both acknowledgements go through `createLineReader()` in `wakeWordCore.ts`, so a verb split across stdout chunks still counts. A settings change during a handoff replaces the paused child through `start()`: the routes or the threshold via `listenSettingsChangedWhilePaused`, the audio device via a new engine.

Commands can reach the child while the microphone is still opening. The capture session has acknowledged a pause or stop that lands then already, so it closes whatever that open produces, and every report from a microphone it has closed is dropped by its id.

**Awaited handoff.** `pause()` returns a promise. Listening ends synchronously: `paused` is emitted and any `DETECTED` the child still prints is ignored. The promise settles once the microphone is known to be closed: `PAUSED` arrived, the 500 ms timeout force-killed the child, or the child went some other way (a crash, `stop()`, `dispose()`, a `start()` that replaces it). Every one of those goes through `settlePause()`, reached from `resetChildState()`, so an awaited pause cannot hang, and it never rejects. A second `pause()` while one is waiting returns the same promise. `onWakeWordDetected()` runs the handoff through `releaseThenFire()`: pause, then check the handoff is still current, then `executeCommand`, so the command that hands the microphone to an assistant runs strictly after the release. The currency check is a generation counter. `cancelPendingHandoff()` advances it in `startListening()`, `stopListening()`, `resumeListening()`, and `runCalibration()`, and a Disable or Enable during the release, which settles the release early, therefore abandons the handoff ("Handoff abandoned" in the log) instead of firing the command and starting a cooldown that would turn listening back on. A `wakeWord.audioDevice` change during the release does not abandon it: disposing the old engine settles the release, the command fires, and the new engine starts when the cooldown ends, as for a change made during a cooldown.

**Timing metrics.** In debug mode (`isDevMode`, the Extension Development Host) the child logs `Timing: model-load` and `mic-open` when it starts and `resume-mic-open` on each resume; `SherpaEngine` logs `bpe-load` (from starting the tokeniser worker until the model has loaded in it) and `tokenise` (from then until the keyword lines are built) before it spawns, and `start-to-ready` (from the `start()` call), `pause-to-ack`, and `resume-to-ready`; `onWakeWordDetected()` logs `detect-to-release`, once the pause has settled, and `detect-to-command`, measured until the command's promise settles. They are ordinary info lines in the output channel. Nothing is timed outside debug mode.

**Handoff modes.** Each route's `handoff` field, resolved by `resolveHandoff()` in `wakeWordCore.ts`, decides how listening comes back after the route fires. `timer`, the default and the only behaviour before 0.11.0, is the cooldown countdown above. `manual` calls `enterManualPause()`: no timer, the status bar shows `Wake: Paused`, and the `isManuallyPaused` flag makes the status bar click and the Enable command call `resumeListening()` instead of stopping or starting. The Enable command also resumes early during a timer cooldown: before 0.13.0 it called `startListening()` there, which reopened the microphone while the countdown kept running and left the status bar on the countdown. `stopListening()`, `resumeListening()`, and `startCountdown()` clear the flag. An engine rebuild during a manual pause builds the new engine but does not start it; the user's resume does. A `wakeWord.routes` or `wakeWord.confidenceThreshold` change during any handoff pause sets `listenSettingsChangedWhilePaused`, and `resumeListening()` then goes through `startListening()` rather than `resume()`, which would replay the settings the child was paused with. Regaining focus after a `pauseOnFocusLoss` pause resumes through `resumeListening()` as well, so a change made while the window was unfocused is applied there too. See Settings changes below. Anything other than the exact string `manual` is `timer`, because settings.json is not validated against the schema. The default Claude route is manual; Chat and Terminal are timer.

**Settings changes.** `onDidChangeConfiguration` acts on three settings; every other one is read where it is used and needs nothing here. `wakeWord.audioDevice` rebuilds the engine, which is built with the microphone it listens on: the branch disposes of the old engine, settles a calibration run, writes the session counters out, and starts the new engine only if the old one was listening, so a rebuild during a cooldown or a manual handoff waits for the resume. Because every path out of it ends in a start, which reads the settings again, a routes or threshold change in the same event needs nothing of its own and the branch returns.

`wakeWord.routes` and `wakeWord.confidenceThreshold` are the settings a running engine cannot pick up on its own: `startListening()` reads both and sends them in the config line, as `keywordLines` and `threshold`. They are handled identically, by `decideListenSettingsChange()` in `wakeWordCore.ts`, which takes what changed and what the extension is doing and returns one of four actions: `restart` while the engine is listening, which is `stopListening()` then `startListening()`; `apply-on-resume` while it is paused, for a cooldown, a manual handoff, or a focus-loss pause, which sets `listenSettingsChangedWhilePaused`; `apply-when-started` while a start is in flight (`engineStarting`), which sets `listenSettingsChangedWhileStarting` and is consumed by the `started` handler; and `none` when the extension is off, in the error state, or standing by while another window listens, since the next start reads the settings itself. The rule the decision exists for is that no paused state may restart the engine, because paused means a handoff and a handoff means an assistant has the microphone; the tests assert that over every combination of the state flags. A start in flight is checked before the paused flags, because a resume through `startListening()` leaves the engine paused until READY and the resume that would have consumed a deferral has already happened. The `apply-when-started` case is what makes the Settings editor's several writes for one edited number end at the value the user typed: each write restarts, the last one wins, and the cost is one model load per write. `formatListenSettingsChange()` writes the log line, which names the settings that changed and when the change will be applied.

A change during a calibration run reaches the engine the way any change does: the run is listening, so the engine restarts and `stopListening()` settles the run as `stopped`, which reports nothing and restores nothing. A change that lands while Calibrate is still starting its engine is held if that engine is paused (Calibrate starts it directly, so `engineStarting` is not set) and otherwise waits for the next start.

**Calibration.** `wakeWord.calibrate` runs `runCalibration()`. It records what the extension is doing (`capturePriorState()`), starts the engine if it is not listening and waits for `started`, then keeps a `CalibrationRun` in module state for `CALIBRATION_DURATION_MS` (15 s). `onWakeWordDetected()` checks that state right after the debounce guard and, while a run is active, records the detection and returns without firing a route or applying confirmation mode. `formatCalibrationReport()` in `wakeWordCore.ts` renders the log lines and the notification text. Afterwards `restorePriorState()` puts things back: listening stays listening, an interrupted cooldown restarts its remaining seconds through `startCountdown()` (which, unlike `scheduleResume()`, does not count a cooldown), a manual handoff stays paused, and Off stops the engine and releases the listener lock. A run ends on its timer, on the notification's Cancel, on a status bar click, on `stopListening()` or an engine rebuild (outcome `stopped`: nothing is reported or restored), or on an engine error. Calibration refuses to run without consent and while another window holds the lock. It starts the engine through `ISpeechEngine.start()` directly, not `startListening()`, so the "Starting:" log line is not written for a calibration start.

The engine cancels a pending crash-backoff retry in `stop()`, `pause()`, and `start()`. `stop()` is the privacy case (Disable must disable); `pause()` during backoff leaves the engine paused with no process so `resume()` restarts it; `start()` during backoff supersedes the retry rather than letting it fire into the fresh child. `stop()` also kills the child before its state guard: between spawn and `READY` the engine is neither listening nor paused, and an early return there left the child to finish starting and open the microphone after a Disable.

**Multi-window coordination.** Every editor window runs its own extension host and each one activates this extension, so without coordination three windows meant three engine processes on one microphone. `lockFile.ts` implements a PID lock at `<globalStorage>/wake-word.lock`. `startListening()` takes the lock before starting the engine; a window that cannot take it shows "Wake: Other window" and polls every `LOCK_CHECK_INTERVAL_MS` (10 s) until the holder's PID is gone or the file is removed, then starts. The lock is held across pause and cooldown, released by `stopListening()` (Disable, toggle off, consent reset, deactivate), and taken over when its PID is dead or the file is corrupt. Creation uses the `wx` flag so windows that start at the same moment cannot both win. `describeLock()` renders the lock state for diagnostics. Known limits: different editor products have separate global storage and do not see each other's lock; a window stuck in the error state keeps the lock until listening is disabled there or it closes; PID reuse after a crash can make a stale lock read as live until that process exits.

**Session statistics.** `extension.ts` keeps a `SessionStats` record (defined in `wakeWordCore.ts`): detections per route label, errors, engine starts, cooldowns, and a start time. `formatSessionStats()` renders it as one log line, written on deactivate and before an engine rebuild resets the counters, and included in the diagnostics report. No storage, no network.

**Phrase confirmation.** `wakeWord.confirmationMode` (off by default) makes `onWakeWordDetected()` hold the first hearing of a phrase instead of firing. `evaluateConfirmation()` in `wakeWordCore.ts` makes the decision; the extension keeps the engine listening, shows `Wake: Confirm "<label>"` in the status bar, and starts a `CONFIRMATION_WINDOW_MS` (5 s) timer. The same label heard again inside the window fires the route as normal. A different label replaces the hold and restarts the timer. The timer expiring drops the hold and puts the status bar back to Listening, provided the engine is still listening. The debounce guard runs before the confirmation check so an engine re-firing on one utterance cannot confirm itself, which also means the second utterance has to land between `DETECTION_DEBOUNCE_MS` (3 s) and 5 s after the first. `clearConfirmation()` drops the hold in `stopListening()`, the focus-loss pause, `resumeListening()`, and the engine rebuild handler. Session statistics count a detection only once it fires.

**Phrase checks.** `startListening()` calls `reportPhraseChecks()` once it holds the lock, just before the engine starts. `validatePhraseQuality()` warns about a single word, a phrase under `SHORT_PHRASE_LENGTH` (4) characters, and a word from `COMMON_WORDS` on its own; one phrase can draw all three. `detectPhraseCollisions()` flags the same phrase on two routes (only the first can fire: `matchRoute()` takes the first match) and a phrase contained in another route's phrase, by plain substring. Routes are compared by position, not label, and aliases on one route are never compared with each other. Both work on normalised phrases, so they skip what the engine skips. `formatPhraseChecks()` renders one warn line each and a single notification points at them. The report is repeated only when `phraseChecksKey()` (each route's label and normalised phrases) differs from the last one reported, so resumes, restarts, and lock takeovers stay quiet, and so does editing a command or cooldown. Nothing is ever blocked.

**Diagnostics.** `wakeWord.diagnostics` runs `runDiagnostics()`, which gathers the report and hands it to `formatDiagnostics()` in `wakeWordCore.ts`. It runs the packaged binary's self-test with `probeNativeEngine()` (5 s timeout, never rejects; the `Engine binary:` line carries what it printed, or `missing`), checks the model with `modelStatus()` without downloading, reads the lock with `readLock()`/`describeLock()`, and describes the extension's state with `describeState()`. `formatDiagnostics()` passes every line through `redactHome()`, which replaces the home directory with `~` (whole path segments only; case-insensitive on Windows), because the report is meant to be pasted into a public issue. The lines are logged, and the notification offers Show Log or Copy to Clipboard. No audio and no network.

**The engine (`engine-rs/`).** `engine-rs/` is the engine child process, a Rust binary that needs nothing installed on the user's machine. It handles a `pause` or `stop` that lands while the model is loading or the microphone is opening, and writes `DETECTED:<phrase>` for the configured phrases. It captures audio through the `decibri` crate (pinned `=6.3.0`, features `capture`, `vad`, `gain`, `ort-load-dynamic`) and gates it with decibri's Silero VAD at a 0.5 threshold; the capture loop scores each chunk before gating it, so the chunk that trips the detector is not stranded behind the gate. ONNX Runtime (1.28 or later) and `silero_vad.onnx` are loaded at run time for the VAD, from `ortLibraryPath` and `vadModelPath` in the config, the `ORT_DYLIB_PATH` and `WAKE_WORD_VAD_MODEL` environment variables, or files beside the executable; `--self-test` reports which it found, and the version the linked sherpa-onnx library reports, without opening a microphone and without loading the keyword spotting model. It does load the voice activity model, which is why the self-test fails on a machine missing the inference runtime's own dependencies. CI builds the binary and every platform `.vsix` carries it in `bin/`, beside ONNX Runtime and `silero_vad.onnx`, where it finds both with no configuration (see Boundaries for how it is built and checked); `engine-rs/**`, the source, is excluded from the `.vsix` by `.vscodeignore`, and `engine-rs/target/` and `bin/` are gitignored. `engine-rs/README.md` has the protocol, the build commands, and how to point a local build at ONNX Runtime and the models.

Keyword spotting is the `sherpa-onnx` crate, pinned `=1.13.8`, with the `static` feature: the crate's build script unpacks prebuilt static libraries for the target into `engine-rs/target/sherpa-onnx-prebuilt/` (the release build hands it the pinned archives described below), and they carry their own ONNX Runtime, which is linked into the executable and is separate from the one decibri loads for the VAD. On Windows those libraries use the static C runtime, so `engine-rs/.cargo/config.toml` sets `+crt-static`; build from inside `engine-rs/` or that file is not read. `spotter_config()` in `spotter.rs` is pinned field for field by a unit test, `modeling_unit` and `bpe_vocab` included, although the keyword spotter uses neither: it creates a spotter with `bpe_vocab` naming an empty file or no file, so the engine does not require `bpe.model`. The engine has no tokeniser. It takes `keywordLines` and `phraseMap` from the config line, refuses a config without either (`Startup error:`) or with no lines (`No valid phrases to detect`) before anything loads, and passes the lines in memory. Before the model loads, `check_keyword_lines()` checks every line the way the library parses it: each word, split where C's `isspace()` splits, must be a token in `tokens.txt` or a `:` or `#` field whose number `std::stof` can read. The library does not report a bad line as an error: it ends the process on an unknown token (exit -1, with the reason only on stderr), and a field it cannot read throws a C++ exception across the FFI boundary that aborts the process. A NUL cannot pass the bindings' C string, a line break would make one entry two lines, and a line with no pieces names no keyword. The engine refuses each of these as `Failed to load KWS model:`, naming the phrase or the line. The extension already leaves unspottable phrases out; the check is there for any line that arrives anyway. The stream is reset after a detection and at the end of each speech segment, and replaced on `pause`.

**Archives without text-to-speech.** The official sherpa-onnx archives also carry the text-to-speech components, which the engine never calls. `.github/workflows/engine-archives.yml`, run by hand with an upstream release tag, builds the same libraries for the four targets with `SHERPA_ONNX_ENABLE_TTS=OFF` (`engine-rs/archives/build.sh`), under the official archives' names and `<name>/lib` layout so that the `sherpa-onnx-sys` build script uses them unmodified, and uploads each one after `engine-rs/archives/verify.mjs` has checked it against the official archive for the same release and target. The build script links `espeak-ng`, `piper_phonemize` and `ucd` by name and a build without text-to-speech does not produce them, so each archive carries them as libraries holding one empty object file; the link list has no whole-archive modifier, so nothing is linked from them. Otherwise the build matches the official archives: the static C runtime on Windows, a universal build thinned to arm64 for macOS 11.0, and Linux inside the engine's `manylinux_2_28` image, compiled by GCC 11 (`gcc-toolset-11`, which `build.sh` installs there) for the `std::string` ABI of the ONNX Runtime the archive carries: pre-C++11 on x64, C++11 on aarch64. `pinned-inputs.mjs` pins the archives it built for sherpa-onnx 1.13.8, hosted on this repository's `sherpa-onnx-v1.13.8` release: `prebuilt.mjs` downloads them from there, and `SHERPA_ONNX_ARCHIVE_DIR` hands them to the build script, whose own download is the official archive. `engine-rs/archives/README.md` says how to run it and what it checks. A target directory keeps linking the libraries its last `sherpa-onnx-sys` build used: the build script runs again only when `SHERPA_ONNX_ARCHIVE_DIR` or `SHERPA_ONNX_LIB_DIR` changes, and the libraries are copied into that crate's build output. Deleting `engine-rs/target/sherpa-onnx-prebuilt/` alone does not change what the next build links; to switch archives, also run `cargo clean -p sherpa-onnx-sys`, or build with an empty `CARGO_TARGET_DIR`.

On Windows the native library opens the model files through C runtime calls that refuse a path of 260 characters or more: it reports `transducer encoder: '<path>' does not exist` on stderr, although the engine's own check finds the file (a 259-character path loads and a 260-character one does not). The model is in the user's global storage, so a long account name or a redirected profile is enough. `library_model_dir()` in `spotter.rs` therefore canonicalises the model directory before it goes into the spotter configuration, which on Windows yields the verbatim form starting `\\?\`, exempt from the limit; a directory that cannot be canonicalised, and every directory on other platforms, is passed as given. Paths of 260 to 1,000 characters, with and without non-ASCII characters and forward slashes, load this way, and the drive script loads the model from a path over 300 characters on every platform. The fix is in the engine, not the host, because the limit belongs to the library: the host passes the model directory as the editor's global storage spells it. A short (8.3) path also loads but exists only where the volume generates short names, and a link at a short path would give the host a second location to manage.

Three timing details decide whether a phrase said on its own is detected, and each is pinned by tests because they are easy to break. The spotter decodes in 320 ms steps counted from the first sample it is given, and reports a keyword only once a step has covered the phrase's last piece and the blank after it. So (1) `Spotter::end_segment` finishes that decoding before it resets the stream: it feeds the stream `SEGMENT_FLUSH_MS` of silence, 1,600 ms as sixteen chunks, and drains it, so the step covering the end of the phrase is decoded rather than discarded, and a phrase the search is still resolving has audio after it to settle on. Measured over 1,448 phrase opportunities in 92 minutes of synthesised speech: 67.5% of them detected with no flush, 80.3% at 320 ms, which is the first step, 81.6% at 1,600 ms, and no more at 2,400 ms, 3,200 ms or 4,800 ms; "hey claude", the longest piece sequence of the default phrases, went from 25.8% to 60.2%, and the further steps beyond the first are worth 1.2 points, every one of them a phrase heard in noise. The one false positive in the 14 minutes of speech that contains no phrase is the same clip at every length, including no flush, and the median delay from the end of speech to the detection went from 352 ms to 380 ms. The flush belongs to the segment end alone: a pause replaces the stream instead, because a detection from audio heard before the microphone was handed over must not arrive after it, and a segment end that lands after a pause therefore flushes a stream that has heard nothing. (2) The silence holdoff in `hysteresis.rs` runs from the arrival of the first quiet chunk, its end, not its start, which with 100 ms chunks puts four quiet chunks into the spotter before the reset. (3) The lead-in handed to the spotter when speech starts is five chunks counting the chunk that trips the detector, so the ring holds four. Both (2) and (3) move every decode step, and before the flush existed each was worth several points; with it, one chunk either way is worth 0.4 points or less on that clip set, and what the tail now decides is how soon a detection is reported: a segment that ends one chunk sooner reports its phrase about 40 ms sooner at the same detection rate.

In debug mode the engine times `model-load` (the keyword line check and the transducer), `mic-open`, and `resume-mic-open`; the host times the tokenising. `cargo test` needs no model and no microphone. `engine-rs/scripts/drive-protocol.mjs` drives the built binary over a real pipe, with `WAKE_WORD_MODEL_DIR` pointing at the extracted model for the scenarios that load it.

**Open Settings.** `wakeWord.openSettings` opens the Settings editor filtered to `wakeWord`. The Off and Listening status bar tooltips are trusted `MarkdownString`s ending in a command link to it; the status bar click itself stays the toggle.

The model download verifies the archive against the pinned `MODEL_SHA256` in `sherpaEngine.ts` before extraction, and follows at most `MAX_REDIRECTS` (5) hops. Changing `MODEL_URL` or `MODEL_VERSION` means recomputing that digest; the command to do so is in the constant's comment. `MODEL_URL` is the `model-v1` release of this repository: sherpa-onnx publishes the model only as `.tar.bz2`, and the release carries it repacked as `.tar.gz` with every file byte-identical, so `MODEL_VERSION` stayed `1`. Extraction is JavaScript, in `tarExtract.ts`, and runs no system `tar` on any platform. `extractTarGz()` decompresses the archive in memory with Node.js's zlib and `extractTar()` reads the ustar headers: regular files and directories only, with the ustar prefix field joined to the name (the archive stores its three int8 model files that way, because their paths are over 100 bytes) and every header checksum checked. Any other entry type, links and pax or GNU long-name records included, is refused rather than skipped, because a skipped long-name record would put the next file in the wrong place. `resolveTarEntryPath()` blocks an entry that would land outside the destination (`..`, an absolute path, and on Windows a backslash, drive, or UNC path), and every entry is checked before the first file is written. `downloadModel()` removes `version.txt` before extracting and writes it again after, so a failed extraction is never taken for a complete model. Replacing the archive means checking it against that reader: a tar that writes pax headers or GNU long names produces an archive it refuses.

## Conventions

- TypeScript strict mode is enabled.
- One runtime npm dependency: `sentencepiece-js`, pinned exactly, WebAssembly only, loaded only in the tokeniser's worker thread (see above). Do not add others.
- All speech processing must remain local. No network calls for audio or recognition.
- Keep the extension under the `analytics-in-motion` publisher namespace.
- Avoid em dashes. Rewrite sentences to use a colon, semicolon, or separate sentence instead.

## Changelog

Update CHANGELOG.md in [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.

Sections: Added, Changed, Fixed, Deprecated, Removed, Security.

Use semantic versioning bumps. Commit changelog updates as `docs(changelog): update for vX.Y.Z`.

## Git Workflow

- `main` branch is what's published to the Marketplace. Keep it release-ready.
- Develop on feature branches, merge to `main` for releases.
- Commit message format: `type(scope): description` (e.g. `fix(engine): settle an awaited pause when the child exits`).
- Tag releases as `vX.Y.Z`. Publishing a GitHub release with such a tag runs `release.yml`, which builds, checks, and publishes the extension. A release whose tag does not start with `v`, such as the speech model's `model-v1` or `sherpa-onnx-v1.13.8`, which hosts the engine archives, runs nothing.

## Testing

Automated tests run under [vitest](https://vitest.dev) with `npm test`. They
cover pure logic and the engine state machine: no microphone, no real child
processes, no network, and no VS Code API. `vitest.config.mts` aliases the
`vscode` module to `tests/mocks/vscode.ts` so src modules that import it can
still be loaded, and that stub throws if a test actually calls into the API.

- `tests/unit/` is TypeScript and imports from `src/`.
- `tests/acoustic/` is JavaScript and covers the benchmark's own modules.
- The engine's own tests are Rust, run by `cargo test` in `engine-rs/`.

`tests/unit/engineLifecycle.test.ts` drives `SherpaEngine` end to end with
`child_process.spawn` mocked to return a `MockChildProcess`
(`tests/mocks/childProcess.ts`), `fs` mocked so the model reads as already
downloaded, and timers faked. The mock's `sendLine()`, `simulateExit()`, and
`simulateError()` stand in for the child, so start/stop/pause/resume, the
pause and resume commands on one child, the `PAUSED` and `RELEASED`
handshakes and their timeouts (verbs split across chunks included), the
promise `pause()` returns and every way it settles, a handoff driven through
`releaseThenFire()` that fires the command only after `PAUSED`, the
crash and retry backoff and its suppression while paused, the retry
cancellation in `stop()` and `pause()`, and the debug timing lines are all
asserted rather than checked by hand. The child's side of the same lifecycle
is covered by `lifecycle.rs` and `capture.rs` in `engine-rs/`, over fake
devices whose opens each test completes by hand, so a pause or stop that
lands during an open is asserted there.
`tests/unit/lockFile.test.ts` does the same for the multi-window lock with
an in-memory `fs` that honours the `wx` flag.
`tests/unit/handoffOrder.test.ts` pins the order `releaseThenFire()` imposes,
`tests/unit/phraseQuality.test.ts` the phrase warnings, collisions, and when
they are reported again, `tests/unit/listenSettings.test.ts` what a routes or
threshold change does in each state the extension can be in, including that no
paused state restarts the engine, and `tests/unit/diagnostics.test.ts` the
diagnostics report, home directory redaction, and `describeLock()`.
`tests/unit/tarExtract.test.ts` builds tar archives in memory and extracts
them into a fresh directory under the system temp directory, the one place
the suite writes real files: ustar prefixes, directories, block padding,
checksums, truncation, refused entry types, gzip errors, and path traversal.
`resolveTarEntryPath()` is checked under both the Windows and the POSIX path
rules, whichever platform runs the suite.
`tests/unit/keywords.test.ts` pins the host's keyword lines, phrase map,
per-route thresholds, and skipped phrases with a stand-in encoder, and
`tests/unit/thresholdClamp.test.ts` pins the clamp, the log line, and the
package.json bounds for both the global setting and a route's own value. `tests/unit/tokeniser.test.ts` starts
real worker threads: against a stand-in for `sentencepiece-js`
(`tests/mocks/sentencepiece.js`, whose behaviour the model directory's name
chooses) for the failure paths, and against the real package to check that
its process listeners stay in the worker. With `WAKE_WORD_MODEL_DIR` pointing
at the extracted model it also checks the pieces against a pinned table and
the default routes' keyword lines; without it those tests are skipped.
`engineLifecycle.test.ts` mocks the tokeniser module.

Anything that needs a real microphone, a live child process, or the extension
host still has to be checked by hand, except the protocol scenarios
`engine-rs/scripts/drive-protocol.mjs` drives against the built binary over a
real pipe. Add a test for pure logic first; if that is not possible, extract
the logic into `wakeWordCore.ts`, or into a module of its own in the engine,
and then test it.

`tests/acoustic/benchmarkCore.test.js` covers the benchmark's pure module,
and `tests/unit/benchmarkConstants.test.ts` pins that module's copies of the
default phrases and the model file list to `DEFAULT_ROUTES` and
`sherpaEngine.ts`. `tests/acoustic/modelPath.test.js` covers the path helper
the benchmark hands to the sherpa-onnx package. The benchmark itself
(`npm run benchmark`) needs `npm run compile`, the sherpa-onnx package
installed with `--no-save`, the speech model, and real recordings;
`tests/acoustic/README.md` says how to add them. It builds its keyword lines
with the extension's own `buildKeywordSpec()`, so it measures the lines that
ship. It is a manual tool, not a CI step, and `tests/**` is excluded from the
`.vsix`.

Manual testing checklist:

1. F5 to launch Extension Development Host
2. Consent dialog appears on first run
3. Status bar shows "Wake: Listening" after consent
4. Say a wake phrase, confirm detection notification appears
5. Status bar transitions to countdown (`Wake: 30s → Wake: 29s → ...`) during handoff
6. Status bar returns to "Wake: Listening" after cooldown; target command fired correctly
7. Toggle, enable, disable, and reset consent commands all work
8. Output panel shows "Wake Word" channel with timestamped logs
9. Open a second window. Its status bar shows "Wake: Other window" and the first keeps listening. Close the first window; within about 10 s the second shows "Wake: Listening".
10. Set `wakeWord.audioDevice` to part of a connected microphone's name. Confirm the engine restarts and the "Starting:" log line names the device. Set it to a name that matches nothing and confirm the error notification names that value. On Windows, decibri names inputs by endpoint name alone (`Microphone`, `Microphone Array`), not by the device description Windows Settings shows in brackets, so use a name decibri reports, or an index where two inputs share a name.
11. Change `wakeWord.audioDevice` after a few detections and confirm a "Session:" line with per-phrase counts appears in the output channel. The same line is written on deactivate, which in the Extension Development Host shows in the debug console.
12. Run **Wake Word: Open Settings** from the command palette, then from the link in the status bar tooltip. Both open the Settings editor filtered to `wakeWord`.
13. Enable `wakeWord.confirmationMode`. Say a wake phrase once: the status bar shows `Wake: Confirm "<label>"`, nothing fires, and after 5 s it returns to Listening. Say it, pause about three seconds, say it again: the second hearing fires the route and the log shows the "heard once" and "confirmed" lines. Disable the setting and confirm a single hearing fires immediately again.
14. With the default routes, say "Hey Claude". After the handoff the status bar shows `Wake: Paused` with no countdown and stays there. Click it: listening resumes and the log shows "Resumed: user resumed after manual handoff". Repeat, and this time run **Wake Word: Enable Listening** instead of clicking. Then run **Wake Word: Disable Listening** while paused and confirm the status bar goes to Off.
15. Say "Hey Computer" (a timer route) and confirm the countdown behaviour from step 5 is unchanged. Add `"handoff": "manual"` to a custom route and confirm it pauses like step 14. While paused, add a new route in settings: the log shows "Routes changed while listening was paused", nothing starts, and after the resume the "Starting:" line counts the new route and its phrase works.
16. Run **Wake Word: Calibrate** while listening. The status bar shows `Wake: Calibrating` and the progress notification counts detections as you say phrases; no route fires. After 15 s the notification summarises and the output channel has the per-detection lines, the per-phrase summary, and the status bar is back on Listening. Run it again after **Disable Listening**: the engine starts, the run completes, and the status bar returns to Off. Run it during a cooldown: the countdown stops, and after the run it resumes from the seconds it had left.
17. Say "Hey Computer" and wait out the cooldown. Listening returns within a fraction of a second of the countdown ending; the output channel shows `Timing: resume-mic-open` and `Timing: resume-to-ready` and no new `Spawning:` line. Say it again to confirm detection works after the resume.
18. Say "Hey Claude" (manual handoff) and click **Wake: Paused**. The resume is as quick as in step 17, again with no `Spawning:` line.
19. During a cooldown, end the engine's child process (`wake-word-engine`) from the operating system. The log shows "Engine process exited while paused" and nothing restarts. When the cooldown ends the log shows "Resume: no engine process to resume, starting a new one" and a `Spawning:` line, and listening returns after the model loads.
20. In the Extension Development Host, check the output channel after a start, a detection, and a resume for every timing line: `bpe-load`, `tokenise`, `model-load`, `mic-open`, `start-to-ready`, `detect-to-release`, `detect-to-command`, `pause-to-ack`, `resume-mic-open`, and `resume-to-ready`. `bpe-load` and `tokenise` are the host's and come before the `Spawning:` line, which names `bin/wake-word-engine`. Note the start and resume figures.
21. Run **Wake Word: Disable Listening** while the engine is listening. The log shows "Mic release: acknowledged by engine" and the `wake-word-engine` child exits. Repeat while paused after a handoff.
22. Enable `wakeWord.pauseOnFocusLoss`, focus another application, add a route to `wakeWord.routes` in settings.json with another editor, and focus the window again. The log shows "Routes changed while listening was paused", "Resumed: window regained focus", and a "Starting:" line that counts the new route.
23. On Windows, with no model in global storage: enable listening. The model downloads and extracts (no "Could not extract the speech model" error), no console window appears for the engine's child process, and phrases are detected. Repeat on a Windows 10 machine when one is available.
24. Say a wake phrase and confirm the output channel shows "Mic release: acknowledged by engine (paused)" and, in debug mode, `Timing: detect-to-release`, before the target command's effect (the assistant opening) and before `Timing: detect-to-command`.
25. Run **Wake Word: Show Diagnostics**. The output channel has the report from "=== Wake Word Diagnostics ===" to "=== End Diagnostics ===", with an `Engine binary:` line that ends in `self-test OK` and names `ort=` and `vad-model=` files in the extension's `bin/`, the model marked downloaded, and `~` in place of your home directory. There is no `Node.js (engine)` line. Choose **Copy to Clipboard** and paste: the same lines. Run it again and choose **Show Log**.
26. Add a route with the single-word phrase `"search"`. When listening restarts, the output channel shows a `Phrase warning (<label>)` line and one "phrase warning found" notification appears. Disable and enable listening: no second notification. Change the phrase to `"stop"`: the notification appears again, counting two warnings.
27. Add two routes with the phrases `"hey claude"` and `"claude"`. The output channel shows a "Phrase collision" line naming both.
28. Say "Hey Computer" and, during the countdown, run **Wake Word: Enable Listening**. The log shows "Resumed: user resumed during the cooldown", the countdown disappears, and the status bar shows "Wake: Listening".
29. With a model already downloaded by an earlier version, install the current one and enable listening: no download notification appears, and in debug mode the log shows "Model already present". Then delete the `sherpa-onnx` folder from global storage and enable listening on macOS or Linux: the model downloads, extracts, and phrases are detected.
30. With the default routes, say each default phrase a few times: "Hey Claude", "Hey Chat", "Open Chat", "Hey Computer", and "Open Terminal". Each fires its route (the chat panel opens for both chat phrases, the terminal focuses for both terminal phrases). Then talk normally for a few minutes, including sentences with "chat", "computer", and "terminal" in them, and note any false triggers. Repeat on macOS or Linux.
31. Add a route with the phrase `"route 66"` beside the defaults and enable listening. The output channel shows one `Phrase "route 66" skipped: "66" is not in the speech model's vocabulary` warning, no error notification appears, and the default phrases are detected. Then make it the only route: the error notification says "No valid phrases to detect".
32. In the debug console of the window that launched the Extension Development Host, evaluate `process.listenerCount('uncaughtException')` and `process.listenerCount('unhandledRejection')`. Disable and enable listening three times and evaluate them again: both numbers are unchanged, because the tokeniser's listeners stay in its worker thread.
33. Download a platform `.vsix` from a CI run and install it with **Extensions: Install from VSIX...**. In the installed extension's folder, `bin/` holds `wake-word-engine` (executable on macOS and Linux), the ONNX Runtime library, `silero_vad.onnx`, and the two notices, and `bin/wake-word-engine --self-test` prints `SELF-TEST:OK` with `ort=` and `vad-model=` naming files in that `bin/`. Do this on Windows, on macOS, and on a Linux older than the runner (for example Ubuntu 22.04 or a RHEL 8 derivative).
34. On a machine with nothing but the editor installed, install a platform `.vsix` and enable listening: the `Spawning:` line names `bin/wake-word-engine`, phrases are detected, and pause and resume work. On Windows, do this on an account whose global storage path makes the model's file paths longer than 260 characters. Then rename `bin/wake-word-engine` in the installed extension and enable listening: the error notification names that path.
35. On a Windows installation without the Microsoft Visual C++ Redistributable (a fresh Windows 10 or 11), install the `win32-x64` `.vsix` and enable listening. Record the error the extension shows and the output channel line, because neither names the redistributable, and check the README's Prerequisites note against them. `bin\wake-word-engine.exe --self-test` shows the same failure without the editor. Install the redistributable and confirm listening then works.
36. While listening, change `wakeWord.confidenceThreshold` in settings. The log shows "Confidence threshold changed: restarting listening" and a "Starting:" line with the new value, and a phrase is still detected. Say "Hey Claude" and, while it is paused, change the setting again: the log shows "Confidence threshold changed while listening was paused", nothing restarts, and the resume writes a "Starting:" line with the new value. Repeat during a timer cooldown. Finally change it with listening off and confirm nothing happens until the next enable. Edit the number in the Settings editor rather than settings.json for one of these: each write the editor makes restarts listening, and the value the engine ends up with is the one left in the box.

## Boundaries

**NEVER** add runtime npm dependencies beyond `sentencepiece-js`, and never load it on the extension host's own thread.

**NEVER** send audio data over the network. All recognition is local.

**NEVER** add `darwin-x64` as a CI build target. Intel Mac (pre-2020) is excluded: the `macos-13` GitHub Actions runner has uncertain long-term availability, and `decibri` darwin-x64 support is unconfirmed. Revisit only if a darwin-x64 user files an issue.

CI and release build four targets: `win32-x64`, `darwin-arm64`, `linux-x64`, and `linux-arm64`. Linux ARM64 runs on the `ubuntu-24.04-arm` runner label, not a variant of `ubuntu-latest`, which is x64. Each engine is built on its own target's runner, so nothing is cross-compiled.

Both workflows run on Node 22 and build the engine on each target's own runner through `.github/actions/engine-rs`, then package, then run `scripts/verify-vsix.mjs` and the drive script against the unpacked `.vsix`; the release does this before anything is uploaded or published. The rules that keep that artifact runnable:

- **NEVER** set `RUSTFLAGS` for the engine build or build it from outside `engine-rs/`: either loses `+crt-static` on Windows. The Windows build passes `-D linker-messages`, so LNK4098 (two C runtimes) fails it.
- **NEVER** build the Linux engine directly on the runner. It is built inside `quay.io/pypa/manylinux_2_28_*` so it needs nothing newer than glibc 2.28 and GLIBCXX 3.4.25, the editor's own Linux floor; `verify-vsix.mjs` fails a binary or ONNX Runtime that needs more.
- **NEVER** let the sherpa-onnx build script download its own archive, which is the official one with the text-to-speech components. `SHERPA_ONNX_ARCHIVE_DIR` points it at the archive `prebuilt.mjs` verified, and `prebuilt.mjs check` verifies the copy it unpacked. Bumping sherpa-onnx means building its archives with `engine-archives.yml`, publishing them on a `sherpa-onnx-v<version>` release, and pinning them in `engine-rs/scripts/pinned-inputs.mjs`; bumping the runtime files means new entries there too. `prebuilt.mjs` refuses a `Cargo.lock` version with no pinned archives.
- **NEVER** add a `.vscodeignore` line that matches `bin/`. `verify-vsix.mjs` fails a package without the engine, its runtime files, or `node_modules/sentencepiece-js`.
- The self-test exits 0 when ONNX Runtime or the Silero model is missing. Check what it reports, as `verify-vsix.mjs` does, never only its exit code.
- The runtime files set floors of their own: the macOS ONNX Runtime needs macOS 14.0. The Windows one imports the Visual C++ runtime (`msvcp140.dll`, `msvcp140_1.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`), which is not part of Windows. Those libraries are **not** packaged: the Microsoft Visual C++ Redistributable is a requirement on Windows, stated in the README. **NEVER** start shipping them beside the binary. A copy there is resolved before the installed one, so it, and not the serviced copy, is what every user would load, and it would only change when this repository re-pinned it. `verify-vsix.mjs` fails a package that carries one. The same check pins the list above against the imports of the packaged files, so an ONNX Runtime bump that needs another library fails the package rather than a user's machine, and the README is revisited with the pin. Every CI runner has the redistributable, so no CI check shows what a machine without it does. The engine binary itself links the C runtime statically and imports none of them, which `verify-vsix.mjs` also checks.
- CI has no microphone: the drive script runs with `--no-microphone`, which skips the scenarios that open one.
- `engine-archives.yml` builds Linux in a dated `manylinux_2_28` image, so its archives keep the engine's floors. Its runner images and that container image are pinned, and `build.sh` fixes the version of the Linux toolset it installs: a static library links only with a toolchain at least as new as the one that compiled it. Windows builds on `windows-2022` (MSVC 14.44), because objects from the Visual Studio 2026 toolset on `windows-latest` call standard library helpers that the 14.44 runtime library lacks. The engine may be linked with the same toolset or a newer one. `LINK_LIST` and `PLACEHOLDERS` in `engine-rs/archives/verify.mjs`, and `PLACEHOLDERS` in `build.sh`, follow the `sherpa-onnx-sys` build script's link list: check them whenever sherpa-onnx is bumped.
- **NEVER** compile the Linux archives with the image's default toolset, and never add or remove `-D_GLIBCXX_USE_CXX11_ABI=0` in `build.sh` for an architecture without reading the ONNX Runtime in that architecture's official archive. The libraries are linked into one executable with upstream's prebuilt ONNX Runtime, so they must match its compiler generation (GCC 11) and its `std::string` ABI, and the ABI differs by architecture: pre-C++11 on x64, hence the flag, and C++11 on aarch64, hence no flag. Libraries of the other ABI link without a message, and the engine then aborts with a corrupted heap whenever it loads the keyword spotting model; the self-test does not load that model, so it and `verify-vsix.mjs` still pass. A newer GCC changes what the keyword spotter detects. `verify.mjs` fails any archive whose libraries need a name from the linking toolchain that the official archive's do not, and a Linux archive whose libraries use another `std::string` ABI than its ONNX Runtime or record another compiler generation than the official archive's.

**NEVER** ship a model download without a verified digest. The tarball is fetched over redirects to a CDN and loaded straight into the keyword spotter.

**NEVER** put audio, or an unredacted home directory, in the diagnostics report. It is written to be pasted into a public issue.

**NEVER** modify the ATTRIBUTION.md protocol frontmatter without explicit instruction.

**NEVER** add `Co-Authored-By` or any AI attribution lines to commit messages.

**NEVER** run `git commit`, `git push`, or publish to any branch. The user always commits and pushes manually.

## Attribution

This repository participates in the AI Attribution Protocol. See ATTRIBUTION.md for reciprocity guidelines.
