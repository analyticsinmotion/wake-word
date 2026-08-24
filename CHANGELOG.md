<!-- markdownlint-disable MD024 -->
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- Automated unit test suite (vitest, `npm test`) covering phrase
  normalisation, route validation, the engine stdout protocol parser, the
  detection debounce guard, engine selection, the confidence threshold
  clamp, PowerShell CLIXML error extraction, Node.js executable
  resolution, model download redirect handling, the sherpa-onnx model
  path normalisation, the VAD pre-roll ring buffer, stdin config
  parsing, and BPE keyword tokenisation. The suite needs no microphone,
  no child process, no network, and no VS Code API, and runs on all
  three platforms in CI.

- `audio-engine.js --self-test` loads decibri, sherpa-onnx, and
  sentencepiece-js and exits without opening the microphone. CI runs it
  on every platform, so a missing module or a native ABI mismatch in the
  shipped engine tree fails the build instead of the user's install.

### Changed

- Extracted the logic shared by the extension host and both engines into
  `src/wakeWordCore.ts`, and the pure logic of the audio engine child
  process into `engine/lib/`. Phrase normalisation and stdout protocol
  parsing were previously duplicated per engine and drifting; both now
  have one implementation.

- Upgraded `decibri` from 1.0.0 to 5.7.0 with VAD-gated keyword spotting.
  Audio is now only fed to the keyword spotter while speech is present,
  so an idle editor no longer runs the transducer. Audio conditioning
  (DC removal, 80 Hz high-pass, AGC at -18 dBFS) improves detection
  reliability. decibri 5.x is a Rust/cpal rewrite of the 1.0.0
  C++/PortAudio package; the platform binary ships as a per-platform
  optional dependency, which increases the `.vsix` size.
- Microphone failures now map decibri's typed error codes to actionable
  messages: no microphone found, access denied, device stopped
  responding, and VAD model load failures are each reported distinctly
  instead of as one opaque string.
- Added a PR and push CI workflow running lint, compile, and the engine
  dependency install. Nothing validated pull requests before this.
- Added Dependabot configuration covering both the root and `engine/`
  dependency trees. `engine/` is the only tree that reaches end users
  and previously had no coverage at all.
- CI now runs lint, compile, and the engine dependency install on all
  three platforms (Windows, macOS, Linux) instead of Ubuntu only. The
  matrix mirrors release.yml so a platform-specific break surfaces on
  the pull request rather than at publish time.
- The default terminal wake phrase is now "Hey Computer" rather than
  "Computer". A single common English word is spoken far too often in
  ordinary conversation to sit behind an always-listening microphone.
  Customised routes in `settings.json` are unaffected; the defaults only
  apply when `wakeWord.routes` is empty.
- The sherpa engine no longer reports a confidence for its detections.
  Its keyword spotter applies its own threshold and returns no usable
  score, so every detection was logged as "confidence: 1.00", which made
  the two engines' logs look comparable when they never were. Windows
  Speech detections continue to show their real scores.
- CI and release now build for Linux ARM64 as well, bringing both
  matrices to four targets: win32-x64, darwin-arm64, linux-x64, and
  linux-arm64. decibri already ships a linux-arm64 pre-built binary.
- CI now packages the `.vsix` on every platform. The source tree passing
  is not evidence the artifact builds: packaging has failed twice, once
  reaching users as a dead v0.4.0 release.

### Fixed

- The audio engine child process now handles every complete line in a
  stdin chunk instead of only the first. Node delivers stdin in chunks,
  not lines, so a `stop` command arriving behind any other line was
  silently dropped and the child kept running with the microphone open.
- Phrase normalisation and route validation no longer throw on a
  non-string phrase. `wakeWord.routes` is user-edited JSON and VS Code
  does not enforce the contributed schema, so a number or `null` in a
  phrase array raised `p.toLowerCase is not a function` and took the
  extension down during activation. Bad entries are now discarded.
- Model paths are now built with a POSIX join after separator rewriting,
  so the path handed to the sherpa-onnx WASM engines is identical on
  every platform rather than depending on the host separator.
- `stop()` now cancels pending retry timers in both engines. Previously,
  disabling listening during crash backoff left the retry timer running
  and it reopened the microphone after the user explicitly disabled it.
- Removed the `docs/` directory (703 KB, including a 560 KB demo video)
  and the `.claude/` directory from the published `.vsix` via
  `.vscodeignore`.
- Fixed `package-lock.json` version drift; the lockfile root version was
  never regenerated for the 0.5.1 bump.
- Microphone release is now acknowledged rather than assumed. The audio
  engine sends `RELEASED` once `mic.stop()` has returned, and the
  extension waits for that line before force-killing the child, up to
  500 ms. Previously the process was killed and the capture device was
  assumed torn down by the time the target assistant asked for it, which
  was only ever usually true. On Windows there is no `RELEASED`:
  System.Speech holds the device for the lifetime of the PowerShell
  process, so process exit is the confirmation and it is now logged.
- A write to an audio engine child that had already exited could take
  the extension host down. EPIPE arrives as an `error` event on the
  stream rather than a thrown exception, so the existing `try`/`catch`
  around each write never covered it and nothing listened for it.

### Security

- Upgraded `@vscode/vsce` from 2.32.0 to 3.9.2 and `ovsx` from 0.8.4 to
  1.1.1, clearing the `markdown-it`/`linkify-it` advisory chain that
  could only be reached through a major bump. Both now require Node 20,
  which CI and release already pin.
- Cleared all 14 remaining npm audit advisories in the root dev
  dependency tree (`brace-expansion`, `follow-redirects`, `form-data`,
  `js-yaml`, `qs`, `tmp`, `undici`, `uuid`). `npm audit` now reports 0
  vulnerabilities. These are build and publish tooling only and never
  shipped to users, but they run with `VSCE_PAT` and `OVSX_PAT` in
  scope during a release.
- The downloaded speech model is now verified against a pinned SHA-256
  digest before extraction, and a rejected tarball is deleted rather
  than left on disk. The download follows HTTP redirects to a CDN host
  and its contents are loaded straight into the keyword spotter, so
  nothing previously stood between a hijacked redirect and a model of
  someone else's choosing running on the user's machine.
- The model download now follows at most 5 redirect hops. A redirect
  loop previously recursed until the extension host ran out of stack.

---

## [0.5.1] - 2026-03-30

### Changed

- Migrated audio capture dependency from deprecated `@analyticsinmotion/micstream` to `decibri` (v1.0.0). The package was renamed; the API is identical with no functional changes.

### Security

- Bumped `undici` from 7.22.0 to 7.24.1 — fixes 6 CVEs including 3 high-severity WebSocket and HTTP vulnerabilities (PR #8).
- Bumped `flatted` from 3.3.4 to 3.4.2 — security patch for devDependency (PR #9).
- Bumped `picomatch` from 4.0.3 to 4.0.4 — security patch for devDependency (PR #10).

---

## [0.5.0] - 2026-03-10

### Fixed

- Native engine dependencies (`sherpa-onnx`, `decibri`, `sentencepiece-js`) are now correctly bundled in the published `.vsix`. The v0.4.0 CI build omitted `engine/node_modules` because it was gitignored and never installed in CI. SherpaEngine failed with MODULE_NOT_FOUND on all platforms. Fixed by adding `cd engine && npm install` to each CI job before packaging.
- Duplicate wake phrase detections within 3 seconds are now suppressed. A buffered `DETECTED` message could arrive on stdout after the engine process was killed, causing a second command to fire.

### Changed

- Release CI now produces platform-specific `.vsix` files (`win32-x64`, `darwin-arm64`, `linux-x64`), each containing the correct native audio binaries for that platform.

---

## [0.4.0] - 2026-03-10

### Added

- **Cross-platform speech engine** (SherpaEngine) using sherpa-onnx keyword spotting. Supports Windows, macOS, and Linux. Runs as a child process under system Node.js so native audio addons load against the correct Node.js ABI, with no Electron conflicts.
- **Cross-platform microphone capture** via `decibri` (PortAudio). This resolves a fundamental blocker: VS Code's Electron runtime cannot load native audio addons, so there was previously no way to capture microphone audio on macOS or Linux. Running decibri under system Node.js in the engine child process bypasses this entirely.
- `wakeWord.engine` setting to select the speech engine: `auto` (platform default), `windows` (Windows System.Speech), or `sherpa` (sherpa-onnx, cross-platform). Defaults to `auto`.
- `wakeWord.nodePath` setting to override the Node.js executable path used by SherpaEngine. Useful when Node.js is installed via nvm, fnm, or a non-standard location not on VS Code's PATH.
- Engine indicator in the status bar showing the active engine (`Windows` or `Sherpa`) while listening. Click the indicator to open engine settings.
- Changing `wakeWord.engine` or `wakeWord.nodePath` in Settings now takes effect immediately; the engine restarts without reloading the window.
- Status bar countdown during cooldown: after a wake phrase fires, the status bar shows a live second-by-second countdown (`Wake: 30s → Wake: 29s → ...`) instead of a static "Wake: Active" message. Gives clear feedback on how long until listening resumes.

### Changed

- Countdown uses a clock icon (`$(clock)`) rather than the spinning sync icon. The spinning icon reset its CSS animation every second when the status bar text was updated, causing a visible jerk. The clock icon is static and appropriate for a timed countdown.
- Documentation updated to be editor-neutral: "VS Code" replaced with "your editor" or "the editor" in settings descriptions, README subheading, and How It Works section. The extension works in Cursor, Windsurf, and other VS Code forks. The docs now reflect that. Technical content (platform requirements, command IDs, architecture) is unchanged.
- Both engines now implement a shared `ISpeechEngine` interface, enabling clean engine switching and shared event handling.

### Fixed

- Switching the speech engine during an active cooldown no longer cancels the countdown or breaks subsequent detection. The countdown continues normally; the new engine starts when it expires.
- Model download now follows HTTP redirects. GitHub release URLs return `302 → CDN`. Downloads previously failed silently on first install.

---

## [0.3.0] - 2026-03-06

### Added

- Dedicated "Wake Word" output channel in the Output panel for all logging (debug, warnings, errors, detections).
- Startup diagnostics logged automatically: route count, threshold, OS, VS Code version.
- "Show Log" action on error toasts that opens the output channel directly.
- Dual logging: output channel always, debug console when running via F5 (dev mode).
- Pause on focus loss (`wakeWord.pauseOnFocusLoss`): pauses listening when VS Code loses focus, resumes on regain. Off by default.
- Phrase aliases: `phrase` field now accepts a string or array of strings, mapping multiple trigger phrases to one command.
- Per-route cooldown: optional `cooldownSeconds` on each route entry, overrides the global setting.
- SVG guard in `npm run lint` that catches blocked SVG references in README.md before commit.

### Changed

- Speech engine protocol: `DETECTED:<phrase>` now includes confidence as `DETECTED:<phrase>|<confidence>`.
- `npm run lint` now also runs `scripts/check-readme.js` to catch vsce-blocked SVGs.

---

## [0.2.1] - 2026-03-06

### Fixed

- Consent flow now uses `try-finally` to ensure `isStarting` flag is always reset, even if the dialog throws.
- Removed duplicate `isActive` state tracking in favour of `speechEngine.isListening`.
- `pause()` now clears pending retry timers to prevent unexpected restarts during mic handoff.
- `resume()` resets the retry counter so a fresh session gets the full 3 retries.
- `killProcess()` now removes all process listeners before nulling the reference, preventing listener accumulation across crash/retry cycles.

---

## [0.2.0] - 2026-03-05

### Added

- Configurable confidence threshold (`wakeWord.confidenceThreshold`), adjustable from 0.1 to 0.9 with safe clamping.
- Automatic retry with exponential backoff when the speech engine crashes (up to 3 retries at 2s, 5s, 10s delays).
- Non-Windows activation guard: commands register as stubs with an informational message on macOS/Linux.
- Troubleshooting section in README with common problems and solutions.
- `npm run lint` step added to the release CI workflow.

### Changed

- Speech engine switched from async `RecognizeAsync()` to synchronous `Recognize()` polling loop. The async approach crashed with exit code 2 when spawned from the VS Code extension host.
- Error reporting from the PowerShell script now uses stdout (`ERROR:` prefix) instead of stderr to avoid PowerShell CLIXML wrapping issues.

### Fixed

- Grammar construction: each wake phrase is now added individually to `Choices` via a `foreach` loop instead of passing the array directly. The previous approach created a sequence grammar (all phrases as one utterance) instead of alternatives.
- `deactivate()` no longer crashes on non-Windows platforms where `speechEngine` is not initialized.

---

## [0.1.1] - 2026-03-05

### Added

- AGENTS.md with project conventions, commands, architecture, and boundaries for AI coding agents.
- ESLint configuration (.eslintrc.json) with TypeScript support.
- CHANGELOG now follows Keep a Changelog format with semantic versioning.

### Changed

- Updated extension display name to "Wake Word".
- Updated extension description to "Voice control for VS Code with customizable wake word. Fully local, zero config."
- Updated extension icon to fill the full 128x128 frame with dark background.
- Bumped `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` from ^6.18.0 to ^8.56.1.
- Activation event changed from `onStartup` to `onStartupFinished` for deferred loading.
- Auto-start now deferred by 1 second to allow VS Code to finish initialising.
- Consent dialog no longer disables `enableOnStartup` when dismissed.
- Configuration change listener now only restarts the engine when `wakeWord.routes` changes, not all settings.

### Fixed

- PowerShell injection vulnerability: switched from double-quoted to single-quoted strings for user-provided phrases in generated PowerShell script.
- `executeCommand` is now properly awaited with correct error handling for async failures.
- Removed premature `isActive = true` assignment in `resumeListening()` -- state is now set by the "started" event handler.
- Removed duplicate `setStatusBar("handed-off")` call on wake word detection.
- Added concurrency guard (`isStarting` flag) to prevent multiple consent dialogs.
- `stop()` no longer emits "stopped" when already stopped.
- `resume()` no longer clears paused state prematurely -- defers to "started" event.
- Added `dispose()` method to SpeechEngine for proper event listener cleanup on deactivation.
- Added route validation to filter out entries with empty phrase, label, or command.
- Fixed unnecessary escape character warnings in PowerShell split patterns.
- Fixed `catch (err: any)` to use `catch (err: unknown)` with proper type narrowing.
- Buffered stderr to handle PowerShell CLIXML chunked output, parsed on process exit.
- Added `_killedIntentionally` flag to suppress spurious error messages from intentional process kills.
- Removed dead `customText` parameter from `setStatusBar()`.

---

## [0.1.0] - 2026-03-04

### Added

- Initial release.
- Zero-config wake word detection: no API keys, no accounts, no model downloads.
- Local speech recognition via Windows built-in `System.Speech.Recognition` engine.
- Multi-phrase routing: map any spoken English phrase to any VS Code command.
- Default routes for "Hey Claude", "Hey Copilot", and "Computer" out of the box.
- Mic handoff: pauses wake word listening and releases the mic when an assistant is triggered.
- Automatic resume after configurable cooldown period.
- First-run consent flow with clear microphone usage disclosure.
- Status bar indicator with listening state.
- Auto-start on VS Code launch (after consent).
- Windows 10/11 supported; macOS and Linux planned for a future release.
- Published to VS Code Marketplace and Open VSX Registry.

---
