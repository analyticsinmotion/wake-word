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
    sherpaEngine.ts           # SherpaEngine: audio-engine.js child process under system Node.js, every platform
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
    keywords.js        # BPE piece decoding and the keyword list / lookup map
    control.js         # stdin line draining, config and command parsing, threshold clamp
    mic-errors.js      # decibri error codes to user-facing messages
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
  eslint.config.mjs    # ESLint 10 flat config. Pins the ESLint 8 rule set; see the comments in the file
  dist/                # Compiled JS output (do not edit)
  .github/
    dependabot.yml     # Dependency updates for both / and /engine
    workflows/
      ci.yml           # CI: lint, compile, test, engine deps, binary prune, engine self-test, .vsix package
      release.yml      # CI: build .vsix, publish to Marketplace and Open VSX
```

`extension.ts` owns all VS Code API interactions. `sherpaEngine.ts` implements `ISpeechEngine` on every platform. `audio-engine.js` runs under system Node.js (not Electron) so native audio addons load correctly. Keep this separation clean.

`wakeWordCore.ts` holds the pure logic the extension host and the engine share: phrase normalisation, route validation, the stdout protocol parser, the debounce guard, the confirmation check, the threshold clamp, the handoff order (`releaseThenFire()`), the phrase quality and collision checks, and the diagnostics report. It imports nothing from `vscode`, so it is directly unit testable. Put shared pure logic there rather than inline in `extension.ts`. `engine/lib/` is the same idea for the child process.

## Architecture

The extension builds its speech engine with `createEngine()`, which returns a `SherpaEngine` on every platform, and wires it with `wireEngine()`. The engine's child communicates via stdout: `READY`, `DETECTED:<phrase>|<confidence>` (the confidence suffix is optional, and the child never sends it), `PAUSED`, `RELEASED`, `ERROR:<message>`, and `DEBUG:<info>`. After its config line the child also reads commands on stdin: `pause`, `resume`, and `stop`. The extension reads stdout, matches phrases, and fires VS Code commands. All events are logged to a dedicated "Wake Word" output channel.

sherpa-onnx's keyword spotter applies its own threshold and returns no usable score, so `audio-engine.js` sends `DETECTED:<phrase>` with no suffix and `SherpaEngine` emits the detection with no confidence. Do not reintroduce a placeholder score: a fixed `confidence: 1.00` in the log looked like a real score when it was not. `formatConfidence()` and the calibration averages still handle a score, and render nothing without one.

**Retired Windows engine.** Before 0.13.0 Windows ran `WindowsSpeechEngine`, System.Speech in a script child process that ended on every handoff, selected by the `wakeWord.engine` setting. 0.13.0 removed both. A value left in settings.json is still readable through `getConfiguration()`, and `retiredEngineNotice()` turns `"windows"` into one info line at activation. The engine indicator status bar item now always reads `Sherpa` and runs **Show Diagnostics** when clicked; it is kept for 0.13.0 only so Windows users can see the switch, and should be removed in 0.14.0.

**SherpaEngine** spawns `engine/audio-engine.js` under system Node.js. The child uses `decibri` (5.7.0) for mic capture and `sherpa-onnx` for keyword spotting. Config is sent as a JSON line to stdin. System Node.js is required because Electron cannot load native addons at the correct ABI, and Node.js 22 or later is the documented requirement on every platform; a spawn that fails with ENOENT reports `NODE_NOT_FOUND_MESSAGE`, which says so and links to nodejs.org, because Windows needed no Node.js before 0.13.0. `findSystemNode()` caches the executable it finds for the session, because the lookup spawns `where node` or `which node` synchronously on the extension host thread. The `wakeWord.nodePath` override and the bare `node` fallback are never cached, and a spawn that fails with ENOENT calls `clearNodePathCache()` so the next start looks again. The child, the lookup, and model extraction are all started with `windowsHide: true`, so Windows gives none of these console programs a window.

The config line carries `audioDevice`, the `wakeWord.audioDevice` setting, which `engine/lib/control.js` resolves to decibri's `device` option: a digit-only string is a device index, anything else a case-insensitive name substring, and empty means the system default (the key is omitted). A lookup failure is reported by `engine/lib/mic-errors.js` with the value and the setting named. The extension builds a new `SherpaEngine` when the setting changes, as it does for `wakeWord.nodePath`.

`decibri` runs with Silero VAD enabled and `audio-engine.js` only feeds audio to the keyword spotter while speech is present, so an idle editor does not run the transducer. decibri emits `'data'` for a chunk *before* it scores that chunk, so the handler holds chunks in a 500 ms pre-roll ring and flushes them when `'speech'` fires; drop the pre-roll and the onset of the wake phrase never reaches the spotter. The `'data'` listener is also what keeps the capture stream pumping, so it must stay unconditional. Capture is conditioned with `dcRemoval`, an 80 Hz `highpass`, and `agc: -18`, and delivered as `dtype: 'float32'`. decibri 5 renamed the old `format` option to `dtype` and silently ignores `format`, so a `format: 'float32'` would still deliver Int16 bytes. `engine/lib/samples.js` reads each chunk in place as a `Float32Array` and clamps it to [-1, 1]: AGC can overshoot full scale, and float32, unlike int16, does not clamp. The microphone is opened with `Microphone.open()`, decibri's async factory, so the Silero model load runs on the native thread pool instead of blocking the event loop. In debug mode the engine emits `DEBUG:overruns: <n>` whenever decibri's `overrunCount` has changed, checked every 30 seconds; a rising count means the decode loop is falling behind capture.

**Persistent engine process.** On wake word detection the microphone is released (handoff) and taken back after the cooldown, so only one thing uses the mic at a time. The sherpa child is not torn down for this. `SherpaEngine.pause()` writes `pause`; the child's `CaptureSession` (`engine/lib/capture.js`) closes the microphone, resets the VAD gate, replaces the spotter's stream, and prints `PAUSED`, with every model still loaded. `resume()` writes `resume`, and the child opens a new microphone and prints `READY`, which the engine handles exactly like the first one. The pause is acknowledged, not assumed: `pauseChild()` force-kills a child that has not said `PAUSED` within 500 ms, and the next `resume()` starts a new child, as it does when the paused child has died. A child that crashes while paused (`childPaused`) is not retried, because the retry would reopen the microphone during the handoff; a crash while resuming is retried like a crash during a start. `stop()` sends `stop` to a child that has said READY (listening, paused, or resuming) and `releaseThenKill()` waits for `RELEASED`, capped at 500 ms; a child still loading, which reads no commands until the load finishes, is force-killed, and so is every child `dispose()` finds. Both acknowledgements go through `createLineReader()` in `wakeWordCore.ts`, so a verb split across stdout chunks still counts. A settings change during a handoff replaces the paused child through `start()`: routes via `routesChangedWhilePaused`, node path and audio device via a new engine.

Commands can reach the child while `Microphone.open()` is in flight. `CaptureSession` has acknowledged a pause or stop that lands then already, so it closes whatever that open produces. Every microphone event handler is bound to its own microphone and does nothing once that microphone is closed, because decibri can deliver a flushed tail of `data`, and `speech` with it, after `stop()` returns.

**Awaited handoff.** `pause()` returns a promise. Listening ends synchronously: `paused` is emitted and any `DETECTED` the child still prints is ignored. The promise settles once the microphone is known to be closed: `PAUSED` arrived, the 500 ms timeout force-killed the child, or the child went some other way (a crash, `stop()`, `dispose()`, a `start()` that replaces it). Every one of those goes through `settlePause()`, reached from `resetChildState()`, so an awaited pause cannot hang, and it never rejects. A second `pause()` while one is waiting returns the same promise. `onWakeWordDetected()` runs the handoff through `releaseThenFire()`: pause, then check the handoff is still current, then `executeCommand`, so the command that hands the microphone to an assistant runs strictly after the release. The currency check is a generation counter. `cancelPendingHandoff()` advances it in `startListening()`, `stopListening()`, `resumeListening()`, and `runCalibration()`, and a Disable or Enable during the release, which settles the release early, therefore abandons the handoff ("Handoff abandoned" in the log) instead of firing the command and starting a cooldown that would turn listening back on. A `wakeWord.nodePath` or `wakeWord.audioDevice` change during the release does not abandon it: disposing the old engine settles the release, the command fires, and the new engine starts when the cooldown ends, as for a change made during a cooldown.

**Timing metrics.** In debug mode (`isDevMode`, the Extension Development Host) the child logs `Timing: modules-load`, `bpe-load`, `tokenise`, `model-load`, and `mic-open` when it starts and `resume-mic-open` on each resume; `SherpaEngine` logs `start-to-ready` (from the `start()` call), `pause-to-ack`, and `resume-to-ready`; `onWakeWordDetected()` logs `detect-to-release`, once the pause has settled, and `detect-to-command`, measured until the command's promise settles. They are ordinary info lines in the output channel. Nothing is timed outside debug mode.

**Handoff modes.** Each route's `handoff` field, resolved by `resolveHandoff()` in `wakeWordCore.ts`, decides how listening comes back after the route fires. `timer`, the default and the only behaviour before 0.11.0, is the cooldown countdown above. `manual` calls `enterManualPause()`: no timer, the status bar shows `Wake: Paused`, and the `isManuallyPaused` flag makes the status bar click and the Enable command call `resumeListening()` instead of stopping or starting. The Enable command also resumes early during a timer cooldown: before 0.13.0 it called `startListening()` there, which reopened the microphone while the countdown kept running and left the status bar on the countdown. `stopListening()`, `resumeListening()`, and `startCountdown()` clear the flag. An engine rebuild during a manual pause builds the new engine but does not start it; the user's resume does. A `wakeWord.routes` change during any handoff pause sets `routesChangedWhilePaused`, and `resumeListening()` then goes through `startListening()` rather than `resume()`, which would replay the old phrases. Regaining focus after a `pauseOnFocusLoss` pause resumes through `resumeListening()` as well, so a route change made while the window was unfocused is applied there too. Anything other than the exact string `manual` is `timer`, because settings.json is not validated against the schema. The default Claude route is manual; Copilot and Terminal are timer.

**Calibration.** `wakeWord.calibrate` runs `runCalibration()`. It records what the extension is doing (`capturePriorState()`), starts the engine if it is not listening and waits for `started`, then keeps a `CalibrationRun` in module state for `CALIBRATION_DURATION_MS` (15 s). `onWakeWordDetected()` checks that state right after the debounce guard and, while a run is active, records the detection and returns without firing a route or applying confirmation mode. `formatCalibrationReport()` in `wakeWordCore.ts` renders the log lines and the notification text. Afterwards `restorePriorState()` puts things back: listening stays listening, an interrupted cooldown restarts its remaining seconds through `startCountdown()` (which, unlike `scheduleResume()`, does not count a cooldown), a manual handoff stays paused, and Off stops the engine and releases the listener lock. A run ends on its timer, on the notification's Cancel, on a status bar click, on `stopListening()` or an engine rebuild (outcome `stopped`: nothing is reported or restored), or on an engine error. Calibration refuses to run without consent and while another window holds the lock. It starts the engine through `ISpeechEngine.start()` directly, not `startListening()`, so the "Starting:" log line is not written for a calibration start.

The engine cancels a pending crash-backoff retry in `stop()`, `pause()`, and `start()`. `stop()` is the privacy case (Disable must disable); `pause()` during backoff leaves the engine paused with no process so `resume()` restarts it; `start()` during backoff supersedes the retry rather than letting it fire into the fresh child. `stop()` also kills the child before its state guard: between spawn and `READY` the engine is neither listening nor paused, and an early return there left the child to finish starting and open the microphone after a Disable.

**Multi-window coordination.** Every editor window runs its own extension host and each one activates this extension, so without coordination three windows meant three engine processes on one microphone. `lockFile.ts` implements a PID lock at `<globalStorage>/wake-word.lock`. `startListening()` takes the lock before starting the engine; a window that cannot take it shows "Wake: Other window" and polls every `LOCK_CHECK_INTERVAL_MS` (10 s) until the holder's PID is gone or the file is removed, then starts. The lock is held across pause and cooldown, released by `stopListening()` (Disable, toggle off, consent reset, deactivate), and taken over when its PID is dead or the file is corrupt. Creation uses the `wx` flag so windows that start at the same moment cannot both win. `describeLock()` renders the lock state for diagnostics. Known limits: different editor products have separate global storage and do not see each other's lock; a window stuck in the error state keeps the lock until listening is disabled there or it closes; PID reuse after a crash can make a stale lock read as live until that process exits.

**Session statistics.** `extension.ts` keeps a `SessionStats` record (defined in `wakeWordCore.ts`): detections per route label, errors, engine starts, cooldowns, and a start time. `formatSessionStats()` renders it as one log line, written on deactivate and before an engine rebuild resets the counters, and included in the diagnostics report. No storage, no network.

**Phrase confirmation.** `wakeWord.confirmationMode` (off by default) makes `onWakeWordDetected()` hold the first hearing of a phrase instead of firing. `evaluateConfirmation()` in `wakeWordCore.ts` makes the decision; the extension keeps the engine listening, shows `Wake: Confirm "<label>"` in the status bar, and starts a `CONFIRMATION_WINDOW_MS` (5 s) timer. The same label heard again inside the window fires the route as normal. A different label replaces the hold and restarts the timer. The timer expiring drops the hold and puts the status bar back to Listening, provided the engine is still listening. The debounce guard runs before the confirmation check so an engine re-firing on one utterance cannot confirm itself, which also means the second utterance has to land between `DETECTION_DEBOUNCE_MS` (3 s) and 5 s after the first. `clearConfirmation()` drops the hold in `stopListening()`, the focus-loss pause, `resumeListening()`, and the engine rebuild handler. Session statistics count a detection only once it fires.

**Phrase checks.** `startListening()` calls `reportPhraseChecks()` once it holds the lock, just before the engine starts. `validatePhraseQuality()` warns about a single word, a phrase under `SHORT_PHRASE_LENGTH` (4) characters, and a word from `COMMON_WORDS` on its own; one phrase can draw all three. `detectPhraseCollisions()` flags the same phrase on two routes (only the first can fire: `matchRoute()` takes the first match) and a phrase contained in another route's phrase, by plain substring. Routes are compared by position, not label, and aliases on one route are never compared with each other. Both work on normalised phrases, so they skip what the engine skips. `formatPhraseChecks()` renders one warn line each and a single notification points at them. The report is repeated only when `phraseChecksKey()` (each route's label and normalised phrases) differs from the last one reported, so resumes, restarts, and lock takeovers stay quiet, and so does editing a command or cooldown. Nothing is ever blocked.

**Diagnostics.** `wakeWord.diagnostics` runs `runDiagnostics()`, which gathers the report and hands it to `formatDiagnostics()` in `wakeWordCore.ts`. It resolves the engine's Node.js with `findSystemNode()` and runs `probeNodeVersion()` (`node --version`, 5 s timeout, never rejects), checks the model with `modelStatus()` without downloading, reads the lock with `readLock()`/`describeLock()`, and describes the extension's state with `describeState()`. `formatDiagnostics()` notes an engine Node.js older than `MIN_ENGINE_NODE_MAJOR` (22) and passes every line through `redactHome()`, which replaces the home directory with `~` (whole path segments only; case-insensitive on Windows), because the report is meant to be pasted into a public issue. The lines are logged, and the notification offers Show Log or Copy to Clipboard. No audio and no network.

**Open Settings.** `wakeWord.openSettings` opens the Settings editor filtered to `wakeWord`. The Off and Listening status bar tooltips are trusted `MarkdownString`s ending in a command link to it; the status bar click itself stays the toggle.

The model download verifies the tarball against the pinned `MODEL_SHA256` in `sherpaEngine.ts` before extraction, and follows at most `MAX_REDIRECTS` (5) hops. Changing `MODEL_URL` or `MODEL_VERSION` means recomputing that digest; the command to do so is in the constant's comment. Extraction runs `tar -xjf` through `execFileSync` with the arguments from `modelExtractCommand()`: on Windows that is `%SystemRoot%\System32\tar.exe` by full path whenever it exists, because a GNU tar earlier on PATH (Git for Windows, MSYS2) hands bzip2 to an external `bzip2` program and fails when that is not on PATH. The tarball is bzip2, so the tar found has to read bzip2 itself; whether the System32 tar of every Windows 10 build does is not verified (checklist item 23).

## Conventions

- TypeScript strict mode is enabled.
- Zero runtime npm dependencies. Do not add any.
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
- Tag releases as `vX.Y.Z`. Creating a GitHub release triggers the CI workflow.

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
10. Set `wakeWord.audioDevice` to part of a connected microphone's name. Confirm the engine restarts and the "Starting:" log line names the device. Set it to a name that matches nothing and confirm the error notification names that value.
11. Change `wakeWord.audioDevice` after a few detections and confirm a "Session:" line with per-phrase counts appears in the output channel. The same line is written on deactivate, which in the Extension Development Host shows in the debug console.
12. Run **Wake Word: Open Settings** from the command palette, then from the link in the status bar tooltip. Both open the Settings editor filtered to `wakeWord`.
13. Enable `wakeWord.confirmationMode`. Say a wake phrase once: the status bar shows `Wake: Confirm "<label>"`, nothing fires, and after 5 s it returns to Listening. Say it, pause about three seconds, say it again: the second hearing fires the route and the log shows the "heard once" and "confirmed" lines. Disable the setting and confirm a single hearing fires immediately again.
14. With the default routes, say "Hey Claude". After the handoff the status bar shows `Wake: Paused` with no countdown and stays there. Click it: listening resumes and the log shows "Resumed: user resumed after manual handoff". Repeat, and this time run **Wake Word: Enable Listening** instead of clicking. Then run **Wake Word: Disable Listening** while paused and confirm the status bar goes to Off.
15. Say "Hey Computer" (a timer route) and confirm the countdown behaviour from step 5 is unchanged. Add `"handoff": "manual"` to a custom route and confirm it pauses like step 14. While paused, add a new route in settings: the log shows "Routes changed during a handoff", nothing starts, and after the resume the "Starting:" line counts the new route and its phrase works.
16. Run **Wake Word: Calibrate** while listening. The status bar shows `Wake: Calibrating` and the progress notification counts detections as you say phrases; no route fires. After 15 s the notification summarises and the output channel has the per-detection lines, the per-phrase summary, and the status bar is back on Listening. Run it again after **Disable Listening**: the engine starts, the run completes, and the status bar returns to Off. Run it during a cooldown: the countdown stops, and after the run it resumes from the seconds it had left.
17. Say "Hey Computer" and wait out the cooldown. Listening returns within a fraction of a second of the countdown ending; the output channel shows `Timing: resume-mic-open` and `Timing: resume-to-ready` and no new `Spawning:` line. Say it again to confirm detection works after the resume.
18. Say "Hey Claude" (manual handoff) and click **Wake: Paused**. The resume is as quick as in step 17, again with no `Spawning:` line.
19. During a cooldown, end the engine's `node` child process from the operating system. The log shows "Engine process exited while paused" and nothing restarts. When the cooldown ends the log shows "Resume: no engine process to resume, starting a new one" and a `Spawning:` line, and listening returns after the model loads.
20. In the Extension Development Host, check the output channel after a start, a detection, and a resume for every timing line: `modules-load`, `bpe-load`, `tokenise`, `model-load`, `mic-open`, `start-to-ready`, `detect-to-release`, `detect-to-command`, `pause-to-ack`, `resume-mic-open`, and `resume-to-ready`. Note the start and resume figures.
21. Run **Wake Word: Disable Listening** while the engine is listening. The log shows "Mic release: acknowledged by engine" and the `node` child exits. Repeat while paused after a handoff.
22. Enable `wakeWord.pauseOnFocusLoss`, focus another application, add a route to `wakeWord.routes` in settings.json with another editor, and focus the window again. The log shows "Routes changed during a handoff", "Resumed: window regained focus", and a "Starting:" line that counts the new route.
23. On Windows, with no model in global storage: enable listening. The model downloads and extracts (no "Could not extract the speech model" error), no console window appears for the `node` child, and phrases are detected. Repeat on a Windows 10 machine: the System32 `tar.exe` there must be able to read the bzip2 tarball.
24. Say a wake phrase and confirm the output channel shows "Mic release: acknowledged by engine (paused)" and, in debug mode, `Timing: detect-to-release`, before the target command's effect (the assistant opening) and before `Timing: detect-to-command`.
25. Run **Wake Word: Show Diagnostics**. The output channel has the report from "=== Wake Word Diagnostics ===" to "=== End Diagnostics ===", with the engine's Node.js version, the model marked downloaded, and `~` in place of your home directory. Choose **Copy to Clipboard** and paste: the same lines. Run it again and choose **Show Log**.
26. Add a route with the single-word phrase `"search"`. When listening restarts, the output channel shows a `Phrase warning (<label>)` line and one "phrase warning found" notification appears. Disable and enable listening: no second notification. Change the phrase to `"stop"`: the notification appears again, counting two warnings.
27. Add two routes with the phrases `"hey claude"` and `"claude"`. The output channel shows a "Phrase collision" line naming both.
28. Put `"wakeWord.engine": "windows"` in settings.json and reload the window. The output channel shows the retired engine line, and listening works.
29. Say "Hey Computer" and, during the countdown, run **Wake Word: Enable Listening**. The log shows "Resumed: user resumed during the cooldown", the countdown disappears, and the status bar shows "Wake: Listening".
30. Set `wakeWord.nodePath` to a path that does not exist. The error notification says Wake Word requires Node.js 22 or later on all platforms and names `wakeWord.nodePath`.

## Boundaries

**NEVER** add runtime npm dependencies. The extension must remain zero-dependency.

**NEVER** send audio data over the network. All recognition is local.

**NEVER** add `darwin-x64` as a CI build target. Intel Mac (pre-2020) is excluded: the `macos-13` GitHub Actions runner has uncertain long-term availability, and `decibri` darwin-x64 pre-built binaries are unconfirmed. Revisit only if a darwin-x64 user files an issue with confirmed binary support.

CI and release build four targets: `win32-x64`, `darwin-arm64`, `linux-x64`, and `linux-arm64`. Linux ARM64 runs on the `ubuntu-24.04-arm` runner label, not a variant of `ubuntu-latest`, which is x64; `decibri` ships a `linux-arm64-gnu` pre-built binary.

Both workflows run on Node 22. After the engine install, each job deletes any `@decibri` platform package that does not match its build target and fails unless exactly one remains, so a `.vsix` never ships another platform's native binary. npm already installs only the package whose `os`/`cpu` fields match the runner; the step turns that into an assertion.

**NEVER** ship a model download without a verified digest. The tarball is fetched over redirects to a CDN and loaded straight into the keyword spotter.

**NEVER** put audio, or an unredacted home directory, in the diagnostics report. It is written to be pasted into a public issue.

**NEVER** modify the ATTRIBUTION.md protocol frontmatter without explicit instruction.

**NEVER** add `Co-Authored-By` or any AI attribution lines to commit messages.

**NEVER** run `git commit`, `git push`, or publish to any branch. The user always commits and pushes manually.

## Attribution

This repository participates in the AI Attribution Protocol. See ATTRIBUTION.md for reciprocity guidelines.
