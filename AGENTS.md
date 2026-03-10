# Wake Word - VS Code Extension

## Commands

```bash
npm install                # Install dependencies
npm run compile            # Build TypeScript to dist/
npm run watch              # Build in watch mode
npm run lint               # Run ESLint + SVG check on README.md. Do not use --fix.
npm run package            # Build .vsix package
```

Run `npm run lint` and `npm run compile` before committing. Both must pass cleanly.

Press F5 in VS Code to launch the Extension Development Host for manual testing.

## Project Structure

```text
wake-word/
  src/
    extension.ts              # VS Code extension entry point, commands, status bar, consent flow
    speechEngineInterface.ts  # ISpeechEngine interface (implemented by both engines)
    windowsSpeechEngine.ts    # WindowsSpeechEngine — spawns PowerShell, Windows System.Speech
    sherpaEngine.ts           # SherpaEngine — spawns audio-engine.js under system Node.js
  engine/
    audio-engine.js           # Child process: micstream mic capture + sherpa-onnx keyword spotting
    package.json              # Engine dependencies (micstream, sherpa-onnx, sentencepiece-js)
  scripts/
    check-readme.js    # Lint-time check: blocks vsce-restricted SVGs in README.md
  dist/                # Compiled JS output (do not edit)
  .github/workflows/
    release.yml        # CI: build .vsix, publish to Marketplace and Open VSX
```

`extension.ts` owns all VS Code API interactions. Both engines implement `ISpeechEngine` — `windowsSpeechEngine.ts` for Windows, `sherpaEngine.ts` for cross-platform. `audio-engine.js` runs under system Node.js (not Electron) so native audio addons load correctly. Keep this separation clean.

## Architecture

The extension selects a speech engine via `createEngine()` and wires it with `wireEngine()`. Both engines communicate via stdout using four protocols: `READY`, `DETECTED:<phrase>|<confidence>`, `ERROR:<message>`, and `DEBUG:<info>`. The extension reads stdout, matches phrases, and fires VS Code commands. All events are logged to a dedicated "Wake Word" output channel.

**WindowsSpeechEngine** spawns a PowerShell process using `System.Speech.Recognition` with a synchronous `Recognize()` polling loop. No model downloads; the engine ships with Windows.

**SherpaEngine** spawns `engine/audio-engine.js` under system Node.js. The child uses `@analyticsinmotion/micstream` for mic capture and `sherpa-onnx` for keyword spotting. Config is sent as a JSON line to stdin. System Node.js is required because Electron cannot load native addons at the correct ABI.

On wake word detection, the engine process is killed to release the microphone (handoff), then respawned after a cooldown. This ensures only one thing uses the mic at a time.

**IMPORTANT**: The PowerShell process must use Windows PowerShell (`System32\WindowsPowerShell\v1.0\powershell.exe`), not PowerShell Core (`pwsh`). `System.Speech` is not available in PowerShell Core.

## Conventions

- TypeScript strict mode is enabled.
- Zero runtime npm dependencies. Do not add any.
- All speech processing must remain local. No network calls for audio or recognition.
- Use single-quoted strings in generated PowerShell to prevent injection. Never use double-quoted strings for user-provided phrases.
- Keep the extension under the `analytics-in-motion` publisher namespace.

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

No test framework is configured yet. When adding tests, use a framework compatible with the VS Code extension testing API.

Manual testing checklist:

1. F5 to launch Extension Development Host
2. Consent dialog appears on first run
3. Status bar shows "Wake: Listening" after consent; engine indicator shows active engine (Windows/Sherpa)
4. Say a wake phrase, confirm detection notification appears
5. Status bar transitions to countdown (`Wake: 30s → Wake: 29s → ...`) during handoff
6. Status bar returns to "Wake: Listening" after cooldown; target command fired correctly
7. Toggle, enable, disable, and reset consent commands all work
8. Output panel shows "Wake Word" channel with timestamped logs
9. Change `wakeWord.engine` in Settings while listening — engine restarts immediately, engine indicator updates
10. Change `wakeWord.engine` during cooldown — countdown continues, new engine starts when it expires

## Boundaries

**NEVER** add runtime npm dependencies. The extension must remain zero-dependency.

**NEVER** send audio data over the network. All recognition is local.

**NEVER** use PowerShell double-quoted strings for user-provided content (injection risk).

**NEVER** add `darwin-x64` as a CI build target. Intel Mac (pre-2020) is excluded: the `macos-13` GitHub Actions runner has uncertain long-term availability, and `@analyticsinmotion/micstream` darwin-x64 pre-built binaries are unconfirmed. Revisit only if a darwin-x64 user files an issue with confirmed binary support.

**NEVER** modify the ATTRIBUTION.md protocol frontmatter without explicit instruction.

## Attribution

This repository participates in the AI Attribution Protocol. See ATTRIBUTION.md for reciprocity guidelines.
