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
npm run benchmark          # Acoustic benchmark over tests/acoustic/fixtures (manual; needs the sherpa model)

node engine/audio-engine.js --self-test   # Load the engine dependency tree and exit

# Native engine packaging (after `cargo build --release` in engine-rs/)
node engine-rs/scripts/stage.mjs --target win32-x64             # Engine, ONNX Runtime, Silero model into bin/
npx vsce package --target win32-x64 -o ww.vsix                  # Package with bin/ included
node scripts/verify-vsix.mjs --target win32-x64 --vsix ww.vsix --extract-to <dir>   # Check the package, run its self-test
```

`--self-test` requires `engine/node_modules` (`cd engine && npm install`). It
opens no microphone and needs no model, so it is safe to run anywhere. CI runs
it on all four platforms.

Run `npm run lint`, `npm run compile`, and `npm test` before committing. All
three must pass cleanly.

Press F5 in VS Code to launch the Extension Development Host for manual testing.

## Project Structure

```text
wake-word/
  src/
    extension.ts              # VS Code extension entry point, commands, status bar, consent flow, diagnostics
    speechEngineInterface.ts  # ISpeechEngine interface (implemented by SherpaEngine)
    sherpaEngine.ts           # SherpaEngine: audio-engine.js child process under system Node.js, every platform; model download
    keywords.ts               # Keyword lines (pieces, boost, threshold), the decoded-to-phrase map, unspottable phrases skipped
    tokeniser.ts              # SentencePiece tokenising in a worker thread; the model's token table
    tarExtract.ts             # Model archive extraction: gzip via zlib, a minimal ustar reader, path traversal guard
    wakeWordCore.ts           # Pure logic shared by the host and the engine: protocol, handoff order, phrase checks, diagnostics, session stats
    lockFile.ts               # PID lock in globalStorage so only one editor window listens
  engine/
    audio-engine.js           # Child process: decibri VAD-gated mic capture + sherpa-onnx keyword spotting
    package.json              # Engine dependencies (decibri 5.7.0, sherpa-onnx 1.13.8, sentencepiece-js 1.1.0)
  engine/lib/          # Pure engine logic, unit tested without a microphone
    model-path.js      # Forward-slash model paths for the sherpa-onnx WASM VFS
    vad-gate.js        # Pre-roll ring buffer and VAD gate state machine
    capture.js         # CaptureSession: microphone open, pause, resume, stop, and VAD gating
    spotter.js         # Keyword spotter wrapper: feed, segment reset, fresh stream after a pause
    samples.js         # decibri float32 chunk to a clamped Float32Array, read in place
    keywords.js        # SentencePiece piece decoding and the keyword list (boost and threshold per line) / lookup map
    control.js         # stdin line draining, config and command parsing, threshold clamp
    mic-errors.js      # decibri error codes to user-facing messages
  engine-rs/           # Rust implementation of the engine child process. Not run by the extension; see below
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
    engine/            # JavaScript tests for engine/lib
    mocks/vscode.ts    # Stub for the `vscode` module, wired up in vitest.config.mts
    mocks/childProcess.ts  # MockChildProcess: drives the engine state machine without a real process
    acoustic/          # Acoustic benchmark: FRR, FAR, and latency over WAV recordings (manual, not CI)
      run-benchmark.js       # Drives the sherpa-onnx spotter over fixtures/positive and fixtures/negative
      lib/benchmark-core.js  # WAV parsing, fixture naming, statistics, report; unit tested
      fixtures/              # positive/<phrase>-<nn>.wav and negative/*.wav; only silence-10s.wav is committed
  scripts/
    check-readme.js    # Lint-time check: blocks vsce-restricted SVGs in README.md
    verify-vsix.mjs    # CI: checks a platform .vsix's contents and runs the packaged engine's self-test
    fetch-model.mjs    # CI: downloads, verifies and extracts the keyword spotting model for tests
  eslint.config.mjs    # ESLint 10 flat config. Pins the ESLint 8 rule set; see the comments in the file
  dist/                # Compiled JS output (do not edit)
  .github/
    dependabot.yml     # Dependency updates for / and /engine (sentencepiece-js grouped across both) and /engine-rs
    actions/engine-rs/action.yml  # Builds and stages the native engine for one target; used by both workflows
    workflows/
      ci.yml           # CI: lint, compile, test with the model, engine deps, binary prune, engine self-test, native engine, .vsix package and check, drive script
      release.yml      # CI: native engine, build and check .vsix, drive script, publish to Marketplace and Open VSX
      engine-archives.yml  # Manual: the sherpa-onnx archives without text-to-speech for the four targets, checked and uploaded
```

`extension.ts` owns all VS Code API interactions. `sherpaEngine.ts` implements `ISpeechEngine` on every platform. `audio-engine.js` runs under system Node.js (not Electron) so native audio addons load correctly. Keep this separation clean.

`wakeWordCore.ts` holds the pure logic the extension host and the engine share: phrase normalisation, route validation, the stdout protocol parser, the debounce guard, the confirmation check, the threshold clamp, the handoff order (`releaseThenFire()`), the phrase quality and collision checks, and the diagnostics report. It imports nothing from `vscode`, so it is directly unit testable. Put shared pure logic there rather than inline in `extension.ts`. `engine/lib/` is the same idea for the child process.

## Architecture

The extension builds its speech engine with `createEngine()`, which returns a `SherpaEngine` on every platform, and wires it with `wireEngine()`. The engine's child communicates via stdout: `READY`, `DETECTED:<phrase>|<confidence>` (the confidence suffix is optional, and the child never sends it), `PAUSED`, `RELEASED`, `ERROR:<message>`, and `DEBUG:<info>`. After its config line the child also reads commands on stdin: `pause`, `resume`, and `stop`. The extension reads stdout, matches phrases, and fires VS Code commands. All events are logged to a dedicated "Wake Word" output channel.

sherpa-onnx's keyword spotter applies its own threshold and returns no usable score, so `audio-engine.js` sends `DETECTED:<phrase>` with no suffix and `SherpaEngine` emits the detection with no confidence. Do not reintroduce a placeholder score: a fixed `confidence: 1.00` in the log looked like a real score when it was not. `formatConfidence()` and the calibration averages still handle a score, and render nothing without one.

**Keyword boost and trigger threshold.** `buildKeywordSpec()` ends every keyword line with the fields `:3.0 #<threshold>`, after the pieces, for example `▁HE Y ▁C LA U DE :3.0 #0.05`. It exists twice with the same behaviour: `src/keywords.ts` builds the lines the host sends in the config line, and `engine/lib/keywords.js` builds the lines `audio-engine.js` loads from `phrases`. sherpa-onnx parses the two fields off the line: `:3.0` is the boost score, which biases decoding toward that phrase's token sequence (1.0 when absent), and `#<threshold>` is the phrase's own trigger threshold. The fields are not part of the keyword the spotter reports on a hit, so `phraseMap` keys and the `details` tokens stay bare pieces.

`wakeWord.confidenceThreshold` is that `#` value. A per-phrase threshold replaces the global `keywordsThreshold` for its phrase, and every line carries one, so the global value (still passed, with the same number) decides nothing; the setting only takes effect through the keyword lines. This was confirmed against the real model with the archive's test WAVs: a line threshold of 0.9 detected nothing whether the global value was 0.05 or 0.9, and 0.05 detected every phrase at a global 0.9. The value is clamped with the same bounds everywhere it is used: `clampThreshold()` in `wakeWordCore.ts` on the host, in `SherpaEngine.start()` and again inside the host's `buildKeywordSpec()`, and `clampKeywordThreshold()` in `engine/lib/control.js`, in `audio-engine.js` and inside its `buildKeywordSpec()`, so a missing or unusable value writes the default instead of a line sherpa-onnx cannot parse. The range is 0.01 to 0.9 and the default 0.05 (`MIN_THRESHOLD` and `DEFAULT_THRESHOLD`; `control.js` repeats the numbers, and the package.json schema must match). The boost and the 0.05 default were tested on Windows with the gigaspeech 3.3M model: before 0.13.2 the lines had no fields and the default was 0.3, and uncommon words such as "claude" in the default phrases were not reliably detected. A user who set 0.3 explicitly keeps it. The acoustic benchmark builds its list with the same function, and its `--threshold` has the same range and default.

**Default routes.** `DEFAULT_ROUTES` in `extension.ts` has three: Claude (`"hey claude"`, `claude-vscode.focus`, manual handoff), Chat (`"hey chat"` and `"open chat"`, `workbench.action.chat.open`), and Terminal (`"hey computer"` and `"open terminal"`, `workbench.action.terminal.focus`). The chat route was "Copilot" / `"hey copilot"` before 0.13.2; it was renamed because `workbench.action.chat.open` opens the editor's generic chat panel, whichever chat extension is active. `tests/acoustic/lib/benchmark-core.js` carries a copy of the phrases, pinned by `tests/unit/benchmarkConstants.test.ts`. The README's custom route example uses `chatgpt.newCodexPanel` for a Codex route; that command ID is documentation reference only and is not a default route.

**Retired Windows engine.** Before 0.13.0 Windows ran `WindowsSpeechEngine`, System.Speech in a script child process that ended on every handoff, selected by the `wakeWord.engine` setting. 0.13.0 removed both. A value left in settings.json is still readable through `getConfiguration()`, and `retiredEngineNotice()` turns `"windows"` into one info line at activation. The engine indicator status bar item now always reads `Sherpa` and runs **Show Diagnostics** when clicked; it is kept for 0.13.0 only so Windows users can see the switch, and should be removed in 0.14.0.

**SherpaEngine** spawns `engine/audio-engine.js` under system Node.js. The child uses `decibri` (5.7.0) for mic capture and `sherpa-onnx` for keyword spotting. Config is sent as a JSON line to stdin. System Node.js is required because Electron cannot load native addons at the correct ABI, and Node.js 22 or later is the documented requirement on every platform; a spawn that fails with ENOENT reports `NODE_NOT_FOUND_MESSAGE`, which says so and links to nodejs.org, because Windows needed no Node.js before 0.13.0. `findSystemNode()` caches the executable it finds for the session, because the lookup spawns `where node` or `which node` synchronously on the extension host thread. The `wakeWord.nodePath` override and the bare `node` fallback are never cached, and a spawn that fails with ENOENT calls `clearNodePathCache()` so the next start looks again. The child and the lookup are both started with `windowsHide: true`, so Windows gives neither console program a window. Model extraction starts no process at all (see below).

The config line carries `audioDevice`, the `wakeWord.audioDevice` setting, which `engine/lib/control.js` resolves to decibri's `device` option: a digit-only string is a device index, anything else a case-insensitive name substring, and empty means the system default (the key is omitted). A lookup failure is reported by `engine/lib/mic-errors.js` with the value and the setting named. The extension builds a new `SherpaEngine` when the setting changes, as it does for `wakeWord.nodePath`.

**Tokenising in the host.** After `ensureModel()`, and before it spawns, `SherpaEngine.start()` tokenises the routes' phrases: `tokenise()` in `tokeniser.ts` encodes each upper-cased phrase with the model's `bpe.model`, `readVocabulary()` reads its `tokens.txt`, and `buildKeywordSpec()` in `keywords.ts` builds the keyword lines and the decoded-to-phrase map. The config line carries them as `keywordLines` and `phraseMap` beside `phrases`. `audio-engine.js` ignores both and tokenises `phrases` itself; the Rust engine reads only them. A phrase with a piece `tokens.txt` lacks (a digit, an accented letter, punctuation other than the apostrophe and the hyphen) cannot be spotted: the native library ends the process on such a piece, and the WASM build fails its model load. So it is skipped with a `warning` that names it and the piece, left out of the lines and the map, and taken out of `phrases` by `configPhrases()`, so `audio-engine.js` never sees it either and one bad route does not stop the engine. Only when no phrase is left does `start()` emit `No valid phrases to detect`, without spawning; a tokeniser that fails is `Could not tokenise the wake phrases: <reason>`, also without spawning. A stop or a newer start during the tokenising abandons the start, as during the model check. `bpe.model` is a SentencePiece Unigram model despite its name: pieces come from a best-path search over piece scores, so only a SentencePiece implementation gives the pieces the spotter expects.

**The tokeniser runs in a worker thread.** `sentencepiece-js` is SentencePiece compiled to WebAssembly, and the JavaScript that loads its module adds to `process`, on every load, an `uncaughtException` listener that rethrows and an `unhandledRejection` listener that throws. A listener that throws from `uncaughtException` is fatal to Node, so on the extension host's own thread any other extension's stray error would crash the extension host for every extension in the window; each load would also keep its 16 MB heap reachable. A worker has a `process` object of its own, so the listeners and the heap go when the worker ends. Never load `sentencepiece-js` on the extension host's thread; `tests/unit/tokeniser.test.ts` checks that the host thread's listeners are untouched. The worker's source is a string started with `eval: true`, so it runs the same under vitest and from `dist/`, and a worker that has not answered within `TOKENISE_TIMEOUT_MS` (30 s) is stopped. `sentencepiece-js` is the extension's one runtime dependency, pinned exactly to the engine's version. `.vscodeignore` excludes `node_modules/**` and lets `node_modules/sentencepiece-js/**` back in: without that line the package builds without it and the host fails to start the engine. The `app-root-path` package it declares is never loaded by it and is not shipped.

`decibri` runs with Silero VAD enabled and `audio-engine.js` only feeds audio to the keyword spotter while speech is present, so an idle editor does not run the transducer. decibri emits `'data'` for a chunk *before* it scores that chunk, so the handler holds chunks in a 500 ms pre-roll ring and flushes them when `'speech'` fires; drop the pre-roll and the onset of the wake phrase never reaches the spotter. The `'data'` listener is also what keeps the capture stream pumping, so it must stay unconditional. Capture is conditioned with `dcRemoval`, an 80 Hz `highpass`, and `agc: -18`, and delivered as `dtype: 'float32'`. decibri 5 renamed the old `format` option to `dtype` and silently ignores `format`, so a `format: 'float32'` would still deliver Int16 bytes. `engine/lib/samples.js` reads each chunk in place as a `Float32Array` and clamps it to [-1, 1]: AGC can overshoot full scale, and float32, unlike int16, does not clamp. The microphone is opened with `Microphone.open()`, decibri's async factory, so the Silero model load runs on the native thread pool instead of blocking the event loop. In debug mode the engine emits `DEBUG:overruns: <n>` whenever decibri's `overrunCount` has changed, checked every 30 seconds; a rising count means the decode loop is falling behind capture.

**Persistent engine process.** On wake word detection the microphone is released (handoff) and taken back after the cooldown, so only one thing uses the mic at a time. The sherpa child is not torn down for this. `SherpaEngine.pause()` writes `pause`; the child's `CaptureSession` (`engine/lib/capture.js`) closes the microphone, resets the VAD gate, replaces the spotter's stream, and prints `PAUSED`, with every model still loaded. `resume()` writes `resume`, and the child opens a new microphone and prints `READY`, which the engine handles exactly like the first one. The pause is acknowledged, not assumed: `pauseChild()` force-kills a child that has not said `PAUSED` within 500 ms, and the next `resume()` starts a new child, as it does when the paused child has died. A child that crashes while paused (`childPaused`) is not retried, because the retry would reopen the microphone during the handoff; a crash while resuming is retried like a crash during a start. `stop()` sends `stop` to a child that has said READY (listening, paused, or resuming) and `releaseThenKill()` waits for `RELEASED`, capped at 500 ms; a child still loading, which reads no commands until the load finishes, is force-killed, and so is every child `dispose()` finds. Both acknowledgements go through `createLineReader()` in `wakeWordCore.ts`, so a verb split across stdout chunks still counts. A settings change during a handoff replaces the paused child through `start()`: routes via `routesChangedWhilePaused`, node path and audio device via a new engine.

Commands can reach the child while `Microphone.open()` is in flight. `CaptureSession` has acknowledged a pause or stop that lands then already, so it closes whatever that open produces. Every microphone event handler is bound to its own microphone and does nothing once that microphone is closed, because decibri can deliver a flushed tail of `data`, and `speech` with it, after `stop()` returns.

**Awaited handoff.** `pause()` returns a promise. Listening ends synchronously: `paused` is emitted and any `DETECTED` the child still prints is ignored. The promise settles once the microphone is known to be closed: `PAUSED` arrived, the 500 ms timeout force-killed the child, or the child went some other way (a crash, `stop()`, `dispose()`, a `start()` that replaces it). Every one of those goes through `settlePause()`, reached from `resetChildState()`, so an awaited pause cannot hang, and it never rejects. A second `pause()` while one is waiting returns the same promise. `onWakeWordDetected()` runs the handoff through `releaseThenFire()`: pause, then check the handoff is still current, then `executeCommand`, so the command that hands the microphone to an assistant runs strictly after the release. The currency check is a generation counter. `cancelPendingHandoff()` advances it in `startListening()`, `stopListening()`, `resumeListening()`, and `runCalibration()`, and a Disable or Enable during the release, which settles the release early, therefore abandons the handoff ("Handoff abandoned" in the log) instead of firing the command and starting a cooldown that would turn listening back on. A `wakeWord.nodePath` or `wakeWord.audioDevice` change during the release does not abandon it: disposing the old engine settles the release, the command fires, and the new engine starts when the cooldown ends, as for a change made during a cooldown.

**Timing metrics.** In debug mode (`isDevMode`, the Extension Development Host) the child logs `Timing: modules-load`, `bpe-load`, `tokenise`, `model-load`, and `mic-open` when it starts and `resume-mic-open` on each resume; `SherpaEngine` logs `bpe-load` (from starting the tokeniser worker until the model has loaded in it) and `tokenise` (from then until the keyword lines are built) before it spawns, so both appear twice at each start, and `start-to-ready` (from the `start()` call), `pause-to-ack`, and `resume-to-ready`; `onWakeWordDetected()` logs `detect-to-release`, once the pause has settled, and `detect-to-command`, measured until the command's promise settles. They are ordinary info lines in the output channel. Nothing is timed outside debug mode.

**Handoff modes.** Each route's `handoff` field, resolved by `resolveHandoff()` in `wakeWordCore.ts`, decides how listening comes back after the route fires. `timer`, the default and the only behaviour before 0.11.0, is the cooldown countdown above. `manual` calls `enterManualPause()`: no timer, the status bar shows `Wake: Paused`, and the `isManuallyPaused` flag makes the status bar click and the Enable command call `resumeListening()` instead of stopping or starting. The Enable command also resumes early during a timer cooldown: before 0.13.0 it called `startListening()` there, which reopened the microphone while the countdown kept running and left the status bar on the countdown. `stopListening()`, `resumeListening()`, and `startCountdown()` clear the flag. An engine rebuild during a manual pause builds the new engine but does not start it; the user's resume does. A `wakeWord.routes` change during any handoff pause sets `routesChangedWhilePaused`, and `resumeListening()` then goes through `startListening()` rather than `resume()`, which would replay the old phrases. Regaining focus after a `pauseOnFocusLoss` pause resumes through `resumeListening()` as well, so a route change made while the window was unfocused is applied there too. Anything other than the exact string `manual` is `timer`, because settings.json is not validated against the schema. The default Claude route is manual; Chat and Terminal are timer.

**Calibration.** `wakeWord.calibrate` runs `runCalibration()`. It records what the extension is doing (`capturePriorState()`), starts the engine if it is not listening and waits for `started`, then keeps a `CalibrationRun` in module state for `CALIBRATION_DURATION_MS` (15 s). `onWakeWordDetected()` checks that state right after the debounce guard and, while a run is active, records the detection and returns without firing a route or applying confirmation mode. `formatCalibrationReport()` in `wakeWordCore.ts` renders the log lines and the notification text. Afterwards `restorePriorState()` puts things back: listening stays listening, an interrupted cooldown restarts its remaining seconds through `startCountdown()` (which, unlike `scheduleResume()`, does not count a cooldown), a manual handoff stays paused, and Off stops the engine and releases the listener lock. A run ends on its timer, on the notification's Cancel, on a status bar click, on `stopListening()` or an engine rebuild (outcome `stopped`: nothing is reported or restored), or on an engine error. Calibration refuses to run without consent and while another window holds the lock. It starts the engine through `ISpeechEngine.start()` directly, not `startListening()`, so the "Starting:" log line is not written for a calibration start.

The engine cancels a pending crash-backoff retry in `stop()`, `pause()`, and `start()`. `stop()` is the privacy case (Disable must disable); `pause()` during backoff leaves the engine paused with no process so `resume()` restarts it; `start()` during backoff supersedes the retry rather than letting it fire into the fresh child. `stop()` also kills the child before its state guard: between spawn and `READY` the engine is neither listening nor paused, and an early return there left the child to finish starting and open the microphone after a Disable.

**Multi-window coordination.** Every editor window runs its own extension host and each one activates this extension, so without coordination three windows meant three engine processes on one microphone. `lockFile.ts` implements a PID lock at `<globalStorage>/wake-word.lock`. `startListening()` takes the lock before starting the engine; a window that cannot take it shows "Wake: Other window" and polls every `LOCK_CHECK_INTERVAL_MS` (10 s) until the holder's PID is gone or the file is removed, then starts. The lock is held across pause and cooldown, released by `stopListening()` (Disable, toggle off, consent reset, deactivate), and taken over when its PID is dead or the file is corrupt. Creation uses the `wx` flag so windows that start at the same moment cannot both win. `describeLock()` renders the lock state for diagnostics. Known limits: different editor products have separate global storage and do not see each other's lock; a window stuck in the error state keeps the lock until listening is disabled there or it closes; PID reuse after a crash can make a stale lock read as live until that process exits.

**Session statistics.** `extension.ts` keeps a `SessionStats` record (defined in `wakeWordCore.ts`): detections per route label, errors, engine starts, cooldowns, and a start time. `formatSessionStats()` renders it as one log line, written on deactivate and before an engine rebuild resets the counters, and included in the diagnostics report. No storage, no network.

**Phrase confirmation.** `wakeWord.confirmationMode` (off by default) makes `onWakeWordDetected()` hold the first hearing of a phrase instead of firing. `evaluateConfirmation()` in `wakeWordCore.ts` makes the decision; the extension keeps the engine listening, shows `Wake: Confirm "<label>"` in the status bar, and starts a `CONFIRMATION_WINDOW_MS` (5 s) timer. The same label heard again inside the window fires the route as normal. A different label replaces the hold and restarts the timer. The timer expiring drops the hold and puts the status bar back to Listening, provided the engine is still listening. The debounce guard runs before the confirmation check so an engine re-firing on one utterance cannot confirm itself, which also means the second utterance has to land between `DETECTION_DEBOUNCE_MS` (3 s) and 5 s after the first. `clearConfirmation()` drops the hold in `stopListening()`, the focus-loss pause, `resumeListening()`, and the engine rebuild handler. Session statistics count a detection only once it fires.

**Phrase checks.** `startListening()` calls `reportPhraseChecks()` once it holds the lock, just before the engine starts. `validatePhraseQuality()` warns about a single word, a phrase under `SHORT_PHRASE_LENGTH` (4) characters, and a word from `COMMON_WORDS` on its own; one phrase can draw all three. `detectPhraseCollisions()` flags the same phrase on two routes (only the first can fire: `matchRoute()` takes the first match) and a phrase contained in another route's phrase, by plain substring. Routes are compared by position, not label, and aliases on one route are never compared with each other. Both work on normalised phrases, so they skip what the engine skips. `formatPhraseChecks()` renders one warn line each and a single notification points at them. The report is repeated only when `phraseChecksKey()` (each route's label and normalised phrases) differs from the last one reported, so resumes, restarts, and lock takeovers stay quiet, and so does editing a command or cooldown. Nothing is ever blocked.

**Diagnostics.** `wakeWord.diagnostics` runs `runDiagnostics()`, which gathers the report and hands it to `formatDiagnostics()` in `wakeWordCore.ts`. It resolves the engine's Node.js with `findSystemNode()` and runs `probeNodeVersion()` (`node --version`, 5 s timeout, never rejects), checks the model with `modelStatus()` without downloading, reads the lock with `readLock()`/`describeLock()`, and describes the extension's state with `describeState()`. `formatDiagnostics()` notes an engine Node.js older than `MIN_ENGINE_NODE_MAJOR` (22) and passes every line through `redactHome()`, which replaces the home directory with `~` (whole path segments only; case-insensitive on Windows), because the report is meant to be pasted into a public issue. The lines are logged, and the notification offers Show Log or Copy to Clipboard. No audio and no network.

**Rust engine (`engine-rs/`).** `engine-rs/` is a Rust implementation of the engine child process, a native binary that needs no system Node.js and no native addon ABI matching. It speaks the same stdin and stdout protocol, parses the same config line, runs the same lifecycle state machine, including a `pause` or `stop` that lands while the model is loading or the microphone is opening, and writes `DETECTED:<phrase>` for the configured phrases. It captures audio through the `decibri` crate (pinned `=6.3.0`, features `capture`, `vad`, `gain`, `ort-load-dynamic`) with the Node engine's options and error messages, and gates it with decibri's Silero VAD at a 0.5 threshold; the capture loop scores each chunk before gating it, so the chunk that trips the detector is not stranded behind the gate. ONNX Runtime (1.28 or later) and `silero_vad.onnx` are loaded at run time for the VAD, from `ortLibraryPath` and `vadModelPath` in the config, the `ORT_DYLIB_PATH` and `WAKE_WORD_VAD_MODEL` environment variables, or files beside the executable; `--self-test` reports which it found, and the version the linked sherpa-onnx library reports, without opening a microphone or loading a model. **`engine/audio-engine.js` under system Node.js is the engine the extension runs.** Nothing in `src/` spawns the binary. CI builds it and every platform `.vsix` carries it in `bin/`, beside ONNX Runtime and `silero_vad.onnx`, where it finds both with no configuration (see Boundaries for how it is built and checked); `engine-rs/**`, the source, is excluded from the `.vsix` by `.vscodeignore`, and `engine-rs/target/` and `bin/` are gitignored. Do not change `engine/` to suit the Rust engine: the two are kept side by side. `engine-rs/README.md` has the protocol, the build commands, and how to point a local build at ONNX Runtime and the models.

Keyword spotting in the Rust engine is the `sherpa-onnx` crate, pinned `=1.13.8` to match the Node engine's `sherpa-onnx` package and bumped with it, with the `static` feature: the crate's build script downloads prebuilt static libraries for the target into `engine-rs/target/sherpa-onnx-prebuilt/`, and they carry their own ONNX Runtime, which is linked into the executable and is separate from the one decibri loads for the VAD. On Windows those libraries use the static C runtime, so `engine-rs/.cargo/config.toml` sets `+crt-static`; build from inside `engine-rs/` or that file is not read. `spotter_config()` in `spotter.rs` mirrors the `createKws()` call field for field and a unit test pins every value, `modeling_unit` and `bpe_vocab` included, although the keyword spotter uses neither: it creates a spotter with `bpe_vocab` naming an empty file or no file, so the engine does not require `bpe.model`. The engine has no tokeniser. It takes `keywordLines` and `phraseMap` from the config line, refuses a config without either (`Startup error:`) or with no lines (`No valid phrases to detect`) before anything loads, and passes the lines in memory. Before the model loads, `check_keyword_lines()` checks every line the way the library parses it: each word, split where C's `isspace()` splits, must be a token in `tokens.txt` or a `:` or `#` field whose number `std::stof` can read. The library does not report a bad line as an error: it ends the process on an unknown token (exit -1, with the reason only on stderr), and a field it cannot read throws a C++ exception across the FFI boundary that aborts the process. A NUL cannot pass the bindings' C string, a line break would make one entry two lines, and a line with no pieces names no keyword. The engine refuses each of these as `Failed to load KWS model:`, naming the phrase or the line. The extension already leaves unspottable phrases out; the check is there for any line that arrives anyway. The stream is reset after a detection and at the end of each speech segment, and replaced on `pause`.

**Archives without text-to-speech.** The official sherpa-onnx archives also carry the text-to-speech components, which the engine never calls. `.github/workflows/engine-archives.yml`, run by hand with an upstream release tag, builds the same libraries for the four targets with `SHERPA_ONNX_ENABLE_TTS=OFF` (`engine-rs/archives/build.sh`), under the official archives' names and `<name>/lib` layout so that the `sherpa-onnx-sys` build script uses them unmodified, and uploads each one after `engine-rs/archives/verify.mjs` has checked it against the official archive for the same release and target. The build script links `espeak-ng`, `piper_phonemize` and `ucd` by name and a build without text-to-speech does not produce them, so each archive carries them as libraries holding one empty object file; the link list has no whole-archive modifier, so nothing is linked from them. Otherwise the build matches the official archives: the static C runtime on Windows, a universal build thinned to arm64 for macOS 11.0, and Linux inside the engine's `manylinux_2_28` image. The engine builds against whichever archives `pinned-inputs.mjs` pins. `engine-rs/archives/README.md` says how to run it and what it checks.

On Windows the native library opens the model files through APIs limited to 260-character paths. A model directory whose encoder path is longer is refused with `transducer encoder: '<path>' does not exist` on stderr, although the engine's own check finds the file; the Node engine reads the model through Node.js and has no such limit.

Two timing details decide whether a phrase said on its own is detected, and both are pinned by tests because they are easy to break. The spotter decodes in 320 ms steps counted from the first sample it is given, and reports a keyword only once a step has covered the phrase's end; audio still undecoded when the segment ends is cut off by the reset. So (1) the silence holdoff in `hysteresis.rs` runs from the arrival of the first quiet chunk, its end, not its start: decibri's Node.js microphone starts its 300 ms timer after delivering that chunk, and on a live microphone the fourth quiet chunk always arrives before the timer fires, so four quiet chunks reach the spotter before the reset. Counting from the chunk's start ends every segment 100 ms sooner and loses a large share of isolated phrases. (2) The lead-in handed to the spotter when speech starts is five chunks counting the chunk that trips the detector, so the ring holds four; one chunk more or less moves every decode step. With both as they are, the Rust engine opens and closes its gate on the same chunks as the Node engine and hands its spotter the same samples.

In debug mode the Rust engine times `model-load` (the keyword line check and the transducer), `mic-open`, and `resume-mic-open`; the host times the tokenising, and there is no `modules-load` phase. `cargo test` needs no model and no microphone. `engine-rs/scripts/drive-protocol.mjs` drives the built binary over a real pipe, with `WAKE_WORD_MODEL_DIR` pointing at the extracted model for the scenarios that load it.

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
- Tag releases as `vX.Y.Z`. Publishing a GitHub release with such a tag runs `release.yml`, which builds, checks, and publishes the extension. A release whose tag does not start with `v`, such as the speech model's `model-v1` or one that hosts engine archives, runs nothing.

## Testing

Automated tests run under [vitest](https://vitest.dev) with `npm test`. They
cover pure logic and the engine state machine: no microphone, no real child
processes, no network, and no VS Code API. `vitest.config.mts` aliases the
`vscode` module to `tests/mocks/vscode.ts` so src modules that import it can
still be loaded, and that stub throws if a test actually calls into the API.

- `tests/unit/` is TypeScript and imports from `src/`.
- `tests/engine/` is JavaScript and imports from `engine/lib/`.

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
asserted rather than checked by hand. `tests/engine/capture.test.js` covers
the child's side, `CaptureSession`, with a fake microphone whose opens each
test completes by hand, so a pause or stop that lands during
`Microphone.open()` is asserted too.
`tests/unit/lockFile.test.ts` does the same for the multi-window lock with
an in-memory `fs` that honours the `wx` flag.
`tests/unit/handoffOrder.test.ts` pins the order `releaseThenFire()` imposes
and the retired engine notice, `tests/unit/phraseQuality.test.ts` the phrase
warnings, collisions, and when they are reported again, and
`tests/unit/diagnostics.test.ts` the diagnostics report, home directory
redaction, and `describeLock()`.
`tests/unit/tarExtract.test.ts` builds tar archives in memory and extracts
them into a fresh directory under the system temp directory, the one place
the suite writes real files: ustar prefixes, directories, block padding,
checksums, truncation, refused entry types, gzip errors, and path traversal.
`resolveTarEntryPath()` is checked under both the Windows and the POSIX path
rules, whichever platform runs the suite.
`tests/unit/keywords.test.ts` pins the host's keyword lines, phrase map, and
skipped phrases with a stand-in encoder. `tests/unit/tokeniser.test.ts` starts
real worker threads: against a stand-in for `sentencepiece-js`
(`tests/mocks/sentencepiece.js`, whose behaviour the model directory's name
chooses) for the failure paths, and against the real package to check that
its process listeners stay in the worker. With `WAKE_WORD_MODEL_DIR` pointing
at the extracted model it also checks the pieces against a pinned table and
the default routes' keyword lines; without it those tests are skipped.
`engineLifecycle.test.ts` mocks the tokeniser module.

Anything that needs a real microphone, a live child process, or the extension
host still has to be checked by hand. Add a test for pure logic first; if that
is not possible, extract the logic into `wakeWordCore.ts` or `engine/lib/` and
then test it.

`tests/acoustic/benchmarkCore.test.js` covers the benchmark's pure module,
and `tests/unit/benchmarkConstants.test.ts` pins that module's copies of the
default phrases and the model file list to `DEFAULT_ROUTES` and
`sherpaEngine.ts`. The benchmark itself (`npm run benchmark`) needs the
sherpa model and real recordings; `tests/acoustic/README.md` says how to add
them. It is a manual tool, not a CI step, and `tests/**` is excluded from the
`.vsix`.

Manual testing checklist:

1. F5 to launch Extension Development Host
2. Consent dialog appears on first run
3. Status bar shows "Wake: Listening" after consent; the engine indicator shows `Sherpa` on every platform, and clicking it runs **Wake Word: Show Diagnostics**
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
15. Say "Hey Computer" (a timer route) and confirm the countdown behaviour from step 5 is unchanged. Add `"handoff": "manual"` to a custom route and confirm it pauses like step 14. While paused, add a new route in settings: the log shows "Routes changed during a handoff", nothing starts, and after the resume the "Starting:" line counts the new route and its phrase works.
16. Run **Wake Word: Calibrate** while listening. The status bar shows `Wake: Calibrating` and the progress notification counts detections as you say phrases; no route fires. After 15 s the notification summarises and the output channel has the per-detection lines, the per-phrase summary, and the status bar is back on Listening. Run it again after **Disable Listening**: the engine starts, the run completes, and the status bar returns to Off. Run it during a cooldown: the countdown stops, and after the run it resumes from the seconds it had left.
17. Say "Hey Computer" and wait out the cooldown. Listening returns within a fraction of a second of the countdown ending; the output channel shows `Timing: resume-mic-open` and `Timing: resume-to-ready` and no new `Spawning:` line. Say it again to confirm detection works after the resume.
18. Say "Hey Claude" (manual handoff) and click **Wake: Paused**. The resume is as quick as in step 17, again with no `Spawning:` line.
19. During a cooldown, end the engine's `node` child process from the operating system. The log shows "Engine process exited while paused" and nothing restarts. When the cooldown ends the log shows "Resume: no engine process to resume, starting a new one" and a `Spawning:` line, and listening returns after the model loads.
20. In the Extension Development Host, check the output channel after a start, a detection, and a resume for every timing line: `modules-load`, `bpe-load`, `tokenise`, `model-load`, `mic-open`, `start-to-ready`, `detect-to-release`, `detect-to-command`, `pause-to-ack`, `resume-mic-open`, and `resume-to-ready`. `bpe-load` and `tokenise` appear twice: the host's before the `Spawning:` line, the engine's after it. Note the start and resume figures.
21. Run **Wake Word: Disable Listening** while the engine is listening. The log shows "Mic release: acknowledged by engine" and the `node` child exits. Repeat while paused after a handoff.
22. Enable `wakeWord.pauseOnFocusLoss`, focus another application, add a route to `wakeWord.routes` in settings.json with another editor, and focus the window again. The log shows "Routes changed during a handoff", "Resumed: window regained focus", and a "Starting:" line that counts the new route.
23. On Windows, with no model in global storage: enable listening. The model downloads and extracts (no "Could not extract the speech model" error), no console window appears for the `node` child, and phrases are detected. Repeat on a Windows 10 machine when one is available.
24. Say a wake phrase and confirm the output channel shows "Mic release: acknowledged by engine (paused)" and, in debug mode, `Timing: detect-to-release`, before the target command's effect (the assistant opening) and before `Timing: detect-to-command`.
25. Run **Wake Word: Show Diagnostics**. The output channel has the report from "=== Wake Word Diagnostics ===" to "=== End Diagnostics ===", with the engine's Node.js version, the model marked downloaded, and `~` in place of your home directory. Choose **Copy to Clipboard** and paste: the same lines. Run it again and choose **Show Log**.
26. Add a route with the single-word phrase `"search"`. When listening restarts, the output channel shows a `Phrase warning (<label>)` line and one "phrase warning found" notification appears. Disable and enable listening: no second notification. Change the phrase to `"stop"`: the notification appears again, counting two warnings.
27. Add two routes with the phrases `"hey claude"` and `"claude"`. The output channel shows a "Phrase collision" line naming both.
28. Put `"wakeWord.engine": "windows"` in settings.json and reload the window. The output channel shows the retired engine line, and listening works.
29. Say "Hey Computer" and, during the countdown, run **Wake Word: Enable Listening**. The log shows "Resumed: user resumed during the cooldown", the countdown disappears, and the status bar shows "Wake: Listening".
30. Set `wakeWord.nodePath` to a path that does not exist. The error notification says Wake Word requires Node.js 22 or later on all platforms and names `wakeWord.nodePath`.
31. With a model already downloaded by 0.13.0, install 0.13.1 and enable listening: no download notification appears, and in debug mode the log shows "Model already present". Then delete the `sherpa-onnx` folder from global storage and enable listening on macOS or Linux: the model downloads, extracts, and phrases are detected.
32. With the default routes, say each default phrase a few times: "Hey Claude", "Hey Chat", "Open Chat", "Hey Computer", and "Open Terminal". Each fires its route (the chat panel opens for both chat phrases, the terminal focuses for both terminal phrases). Then talk normally for a few minutes, including sentences with "chat", "computer", and "terminal" in them, and note any false triggers. Repeat on macOS or Linux.
33. Add a route with the phrase `"route 66"` beside the defaults and enable listening. The output channel shows one `Phrase "route 66" skipped: "66" is not in the speech model's vocabulary` warning, no error notification appears, and the default phrases are detected. Then make it the only route: the error notification says "No valid phrases to detect".
34. In the debug console of the window that launched the Extension Development Host, evaluate `process.listenerCount('uncaughtException')` and `process.listenerCount('unhandledRejection')`. Disable and enable listening three times and evaluate them again: both numbers are unchanged, because the tokeniser's listeners stay in its worker thread.
35. Download a platform `.vsix` from a CI run and install it with **Extensions: Install from VSIX...**. In the installed extension's folder, `bin/` holds `wake-word-engine` (executable on macOS and Linux), the ONNX Runtime library, `silero_vad.onnx`, and the two notices, and `bin/wake-word-engine --self-test` prints `SELF-TEST:OK` with `ort=` and `vad-model=` naming files in that `bin/`. Do this on Windows, on macOS, and on a Linux older than the runner (for example Ubuntu 22.04 or a RHEL 8 derivative).

## Boundaries

**NEVER** add runtime npm dependencies beyond `sentencepiece-js`, and never load it on the extension host's own thread.

**NEVER** send audio data over the network. All recognition is local.

**NEVER** add `darwin-x64` as a CI build target. Intel Mac (pre-2020) is excluded: the `macos-13` GitHub Actions runner has uncertain long-term availability, and `decibri` darwin-x64 pre-built binaries are unconfirmed. Revisit only if a darwin-x64 user files an issue with confirmed binary support.

CI and release build four targets: `win32-x64`, `darwin-arm64`, `linux-x64`, and `linux-arm64`. Linux ARM64 runs on the `ubuntu-24.04-arm` runner label, not a variant of `ubuntu-latest`, which is x64; `decibri` ships a `linux-arm64-gnu` pre-built binary.

Both workflows run on Node 22. After the engine install, each job deletes any `@decibri` platform package that does not match its build target and fails unless exactly one remains, so a `.vsix` never ships another platform's native binary. npm already installs only the package whose `os`/`cpu` fields match the runner; the step turns that into an assertion.

Both workflows build the native engine on each target's own runner through `.github/actions/engine-rs`, then package, then run `scripts/verify-vsix.mjs` and the drive script against the unpacked `.vsix`; the release does this before anything is uploaded or published. The rules that keep that artifact runnable:

- **NEVER** set `RUSTFLAGS` for the engine build or build it from outside `engine-rs/`: either loses `+crt-static` on Windows. The Windows build passes `-D linker-messages`, so LNK4098 (two C runtimes) fails it.
- **NEVER** build the Linux engine directly on the runner. It is built inside `quay.io/pypa/manylinux_2_28_*` so it needs nothing newer than glibc 2.28 and GLIBCXX 3.4.25, the editor's own Linux floor; `verify-vsix.mjs` fails a binary or ONNX Runtime that needs more. Today's Node engine needs glibc 2.34 through decibri's addon.
- **NEVER** let the sherpa-onnx build script download its own archive. `SHERPA_ONNX_ARCHIVE_DIR` points it at the archive `prebuilt.mjs` verified, and `prebuilt.mjs check` verifies the copy it unpacked. Bumping sherpa-onnx or the runtime files means new entries in `engine-rs/scripts/pinned-inputs.mjs`; `prebuilt.mjs` refuses a `Cargo.lock` version with no pinned archives.
- **NEVER** add a `.vscodeignore` line that matches `bin/`. `verify-vsix.mjs` fails a package without the engine, its runtime files, or `node_modules/sentencepiece-js`.
- The self-test exits 0 when ONNX Runtime or the Silero model is missing. Check what it reports, as `verify-vsix.mjs` does, never only its exit code.
- The runtime files set floors of their own: the macOS ONNX Runtime needs macOS 14.0, and the Windows one imports the Visual C++ runtime (`vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll`), which CI runners have and a fresh Windows install may not. The Node engine loads the same files.
- CI has no microphone: the drive script runs with `--no-microphone`, which skips the scenarios that open one.
- `engine-archives.yml` builds Linux in a dated `manylinux_2_28` image, so its archives keep the engine's floors. Its runner images and that container image are pinned: a static library links only with a toolchain at least as new as the one that compiled it. Windows builds on `windows-2022` (MSVC 14.44), because objects from the Visual Studio 2026 toolset on `windows-latest` call standard library helpers that the 14.44 runtime library lacks. The engine may be linked with the same toolset or a newer one. `LINK_LIST` and `PLACEHOLDERS` in `engine-rs/archives/verify.mjs`, and `PLACEHOLDERS` in `build.sh`, follow the `sherpa-onnx-sys` build script's link list: check them whenever sherpa-onnx is bumped.

**NEVER** ship a model download without a verified digest. The tarball is fetched over redirects to a CDN and loaded straight into the keyword spotter.

**NEVER** put audio, or an unredacted home directory, in the diagnostics report. It is written to be pasted into a public issue.

**NEVER** modify the ATTRIBUTION.md protocol frontmatter without explicit instruction.

**NEVER** add `Co-Authored-By` or any AI attribution lines to commit messages.

**NEVER** run `git commit`, `git push`, or publish to any branch. The user always commits and pushes manually.

## Attribution

This repository participates in the AI Attribution Protocol. See ATTRIBUTION.md for reciprocity guidelines.
