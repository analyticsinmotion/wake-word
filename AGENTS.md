# Wake Word - VS Code Extension

## Commands

```bash
npm install                # Install dependencies
npm run compile            # Build TypeScript to dist/
npm run watch              # Build in watch mode
npm run lint               # Run ESLint + SVG check on README.md. Do not use --fix.
npm test                   # Run the unit test suite once (vitest)
npm run test:watch         # Run the unit tests in watch mode
npm run package            # Build .vsix package

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
    extension.ts              # VS Code extension entry point, commands, status bar, consent flow
    speechEngineInterface.ts  # ISpeechEngine interface (implemented by both engines)
    windowsSpeechEngine.ts    # WindowsSpeechEngine: PowerShell child process using Windows System.Speech
    sherpaEngine.ts           # SherpaEngine: audio-engine.js child process under system Node.js
    wakeWordCore.ts           # Pure logic shared by the host and both engines, incl. session stats
    lockFile.ts               # PID lock in globalStorage so only one editor window listens
  engine/
    audio-engine.js           # Child process: decibri VAD-gated mic capture + sherpa-onnx keyword spotting
    package.json              # Engine dependencies (decibri 5.7.0, sherpa-onnx 1.13.6, sentencepiece-js 1.1.0)
  engine/lib/          # Pure engine logic, unit tested without a microphone
    model-path.js      # Forward-slash model paths for the sherpa-onnx WASM VFS
    vad-gate.js        # Pre-roll ring buffer and VAD gate state machine
    keywords.js        # BPE piece decoding and the keyword list / lookup map
    control.js         # stdin line draining, config parsing, threshold clamp
    mic-errors.js      # decibri error codes to user-facing messages
  tests/
    unit/              # TypeScript tests for the extension host code
    engine/            # JavaScript tests for engine/lib
    mocks/vscode.ts    # Stub for the `vscode` module, wired up in vitest.config.mts
    mocks/childProcess.ts  # MockChildProcess: drives the engine state machine without a real process
  scripts/
    check-readme.js    # Lint-time check: blocks vsce-restricted SVGs in README.md
  dist/                # Compiled JS output (do not edit)
  .github/
    dependabot.yml     # Dependency updates for both / and /engine
    workflows/
      ci.yml           # CI: lint, compile, test, engine deps, binary prune, engine self-test, .vsix package
      release.yml      # CI: build .vsix, publish to Marketplace and Open VSX
```

`extension.ts` owns all VS Code API interactions. Both engines implement `ISpeechEngine`: `windowsSpeechEngine.ts` (Windows) and `sherpaEngine.ts` (cross-platform). `audio-engine.js` runs under system Node.js (not Electron) so native audio addons load correctly. Keep this separation clean.

`wakeWordCore.ts` holds the logic both engines and the extension host share: phrase normalisation, route validation, the stdout protocol parser, the debounce guard, engine selection, and the threshold clamp. It imports nothing from `vscode`, so it is directly unit testable. Put shared pure logic there rather than duplicating it per engine. `engine/lib/` is the same idea for the child process.

## Architecture

The extension selects a speech engine via `createEngine()` and wires it with `wireEngine()`. Both engines communicate via stdout: `READY`, `DETECTED:<phrase>|<confidence>` (the confidence suffix is optional), `RELEASED`, `ERROR:<message>`, and `DEBUG:<info>`. The extension reads stdout, matches phrases, and fires VS Code commands. All events are logged to a dedicated "Wake Word" output channel.

Only the Windows engine produces a real confidence score. sherpa-onnx's keyword spotter applies its own threshold and returns nothing usable, so `audio-engine.js` sends `DETECTED:<phrase>` with no suffix and `SherpaEngine` emits the detection with no confidence. Do not reintroduce a placeholder score: a fixed `confidence: 1.00` in the log made the two engines look comparable when they are not.

**WindowsSpeechEngine** spawns a PowerShell process using `System.Speech.Recognition` with a synchronous `Recognize()` polling loop. No model downloads; the engine ships with Windows.

**SherpaEngine** spawns `engine/audio-engine.js` under system Node.js. The child uses `decibri` (5.7.0) for mic capture and `sherpa-onnx` for keyword spotting. Config is sent as a JSON line to stdin. System Node.js is required because Electron cannot load native addons at the correct ABI.

The config line carries `audioDevice`, the `wakeWord.audioDevice` setting, which `engine/lib/control.js` resolves to decibri's `device` option: a digit-only string is a device index, anything else a case-insensitive name substring, and empty means the system default (the key is omitted). A lookup failure is reported by `engine/lib/mic-errors.js` with the value and the setting named. The extension builds a new `SherpaEngine` when the setting changes, as it does for `wakeWord.nodePath`. The Windows engine ignores the setting: `System.Speech` is bound to the default input device.

`decibri` runs with Silero VAD enabled and `audio-engine.js` only feeds audio to the keyword spotter while speech is present, so an idle editor does not run the transducer. decibri emits `'data'` for a chunk *before* it scores that chunk, so the handler holds chunks in a 500 ms pre-roll ring and flushes them when `'speech'` fires; drop the pre-roll and the onset of the wake phrase never reaches the spotter. The `'data'` listener is also what keeps the capture stream pumping, so it must stay unconditional. Capture is conditioned with `dcRemoval`, an 80 Hz `highpass`, and `agc: -18`. The microphone is opened with `Microphone.open()`, decibri's async factory, so the Silero model load runs on the native thread pool instead of blocking the event loop. In debug mode the engine emits `DEBUG:overruns: <n>` whenever decibri's `overrunCount` has changed, checked every 30 seconds; a rising count means the decode loop is falling behind capture.

On wake word detection the microphone is released and the engine process torn down (handoff), then respawned after a cooldown, so only one thing uses the mic at a time. The release is acknowledged, not assumed: `audio-engine.js` sends `RELEASED` once `mic.stop()` has returned and `SherpaEngine.releaseThenKill()` waits for that line before force-killing, capped at 500 ms. `forceKill()` is the unacknowledged path, used by `start()` and `stop()`. The Windows engine has no `RELEASED`, and needs none: System.Speech holds the capture device for the lifetime of the PowerShell process, so process exit is the confirmation.

`pause()` stays synchronous and the target command still fires as soon as it returns; the release completes underneath within the timeout. Ordering the command strictly after `RELEASED` is a handoff policy change and should be designed separately.

Both engines cancel a pending crash-backoff retry in `stop()`, `pause()`, and `start()`. `stop()` is the privacy case (Disable must disable); `pause()` during backoff leaves the engine paused with no process so `resume()` restarts it; `start()` during backoff supersedes the retry rather than letting it fire into the fresh child. `stop()` also kills the child before its state guard: between spawn and `READY` the engine is neither listening nor paused, and an early return there left the child to finish starting and open the microphone after a Disable.

**Multi-window coordination.** Every editor window runs its own extension host and each one activates this extension, so without coordination three windows meant three engine processes on one microphone. `lockFile.ts` implements a PID lock at `<globalStorage>/wake-word.lock`. `startListening()` takes the lock before starting the engine; a window that cannot take it shows "Wake: Other window" and polls every `LOCK_CHECK_INTERVAL_MS` (10 s) until the holder's PID is gone or the file is removed, then starts. The lock is held across pause and cooldown, released by `stopListening()` (Disable, toggle off, consent reset, deactivate), and taken over when its PID is dead or the file is corrupt. Creation uses the `wx` flag so windows that start at the same moment cannot both win. Known limits: different editor products have separate global storage and do not see each other's lock; a window stuck in the error state keeps the lock until listening is disabled there or it closes; PID reuse after a crash can make a stale lock read as live until that process exits.

**Session statistics.** `extension.ts` keeps a `SessionStats` record (defined in `wakeWordCore.ts`): detections per route label, errors, engine starts, cooldowns, and a start time. `formatSessionStats()` renders it as one log line, written on deactivate and before an engine switch resets the counters. No storage, no network.

The model download verifies the tarball against the pinned `MODEL_SHA256` in `sherpaEngine.ts` before extraction, and follows at most `MAX_REDIRECTS` (5) hops. Changing `MODEL_URL` or `MODEL_VERSION` means recomputing that digest; the command to do so is in the constant's comment.

**IMPORTANT**: The PowerShell process must use Windows PowerShell (`System32\WindowsPowerShell\v1.0\powershell.exe`), not PowerShell Core (`pwsh`). `System.Speech` is not available in PowerShell Core.

## Conventions

- TypeScript strict mode is enabled.
- Zero runtime npm dependencies. Do not add any.
- All speech processing must remain local. No network calls for audio or recognition.
- Use single-quoted strings in generated PowerShell to prevent injection. Never use double-quoted strings for user-provided phrases.
- Keep the extension under the `analytics-in-motion` publisher namespace.
- Avoid em dashes. Rewrite sentences to use a colon, semicolon, or separate sentence instead.

## Changelog

Update CHANGELOG.md in [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.

Sections: Added, Changed, Fixed, Deprecated, Security.

Use semantic versioning bumps. Commit changelog updates as `docs(changelog): update for vX.Y.Z`.

## Git Workflow

- `main` branch is what's published to the Marketplace. Keep it release-ready.
- Develop on feature branches, merge to `main` for releases.
- Commit message format: `type(scope): description` (e.g. `fix(speech): escape single quotes in phrases`).
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
crash and retry backoff, the retry cancellation in `stop()` and `pause()`,
and the `RELEASED` timeout are all asserted rather than checked by hand.
`tests/unit/lockFile.test.ts` does the same for the multi-window lock with
an in-memory `fs` that honours the `wx` flag.

Anything that needs a real microphone, a live child process, or the extension
host still has to be checked by hand. Add a test for pure logic first; if that
is not possible, extract the logic into `wakeWordCore.ts` or `engine/lib/` and
then test it.

Manual testing checklist:

1. F5 to launch Extension Development Host
2. Consent dialog appears on first run
3. Status bar shows "Wake: Listening" after consent; engine indicator shows active engine (Windows/Sherpa)
4. Say a wake phrase, confirm detection notification appears
5. Status bar transitions to countdown (`Wake: 30s → Wake: 29s → ...`) during handoff
6. Status bar returns to "Wake: Listening" after cooldown; target command fired correctly
7. Toggle, enable, disable, and reset consent commands all work
8. Output panel shows "Wake Word" channel with timestamped logs
9. Change `wakeWord.engine` in Settings while listening. Confirm engine restarts immediately and engine indicator updates.
10. Change `wakeWord.engine` during cooldown. Confirm countdown continues and the new engine starts when it expires.
11. Open a second window. Its status bar shows "Wake: Other window" and the first keeps listening. Close the first window; within about 10 s the second shows "Wake: Listening".
12. With the sherpa engine, set `wakeWord.audioDevice` to part of a connected microphone's name. Confirm the engine restarts and the "Starting:" log line names the device. Set it to a name that matches nothing and confirm the error notification names that value.
13. Switch `wakeWord.engine` after a few detections and confirm a "Session:" line with per-phrase counts appears in the output channel. The same line is written on deactivate, which in the Extension Development Host shows in the debug console.

## Boundaries

**NEVER** add runtime npm dependencies. The extension must remain zero-dependency.

**NEVER** send audio data over the network. All recognition is local.

**NEVER** use PowerShell double-quoted strings for user-provided content (injection risk).

**NEVER** add `darwin-x64` as a CI build target. Intel Mac (pre-2020) is excluded: the `macos-13` GitHub Actions runner has uncertain long-term availability, and `decibri` darwin-x64 pre-built binaries are unconfirmed. Revisit only if a darwin-x64 user files an issue with confirmed binary support.

CI and release build four targets: `win32-x64`, `darwin-arm64`, `linux-x64`, and `linux-arm64`. Linux ARM64 runs on the `ubuntu-24.04-arm` runner label, not a variant of `ubuntu-latest`, which is x64; `decibri` ships a `linux-arm64-gnu` pre-built binary.

Both workflows run on Node 22. After the engine install, each job deletes any `@decibri` platform package that does not match its build target and fails unless exactly one remains, so a `.vsix` never ships another platform's native binary. npm already installs only the package whose `os`/`cpu` fields match the runner; the step turns that into an assertion.

**NEVER** ship a model download without a verified digest. The tarball is fetched over redirects to a CDN and loaded straight into the keyword spotter.

**NEVER** modify the ATTRIBUTION.md protocol frontmatter without explicit instruction.

**NEVER** add `Co-Authored-By` or any AI attribution lines to commit messages.

**NEVER** run `git commit`, `git push`, or publish to any branch. The user always commits and pushes manually.

## Attribution

This repository participates in the AI Attribution Protocol. See ATTRIBUTION.md for reciprocity guidelines.
