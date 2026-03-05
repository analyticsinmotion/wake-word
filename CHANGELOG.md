<!-- markdownlint-disable MD024 -->
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
<!-- Add new features here -->

### Changed
<!-- Add changed behavior here -->

### Fixed
<!-- Add bug fixes here -->

### Removed
<!-- Add removals/deprecations here -->

---

## [0.2.0] - 2026-03-05

### Added

- Configurable confidence threshold (`wakeWord.confidenceThreshold`) — adjustable from 0.1 to 0.9 with safe clamping.
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
