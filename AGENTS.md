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
    extension.ts       # VS Code extension entry point, commands, status bar, consent flow
    speechEngine.ts    # SpeechEngine class, spawns PowerShell, manages mic lifecycle
  scripts/
    check-readme.js    # Lint-time check: blocks vsce-restricted SVGs in README.md
  dist/                # Compiled JS output (do not edit)
  .github/workflows/
    release.yml        # CI: build .vsix, publish to Marketplace and Open VSX
```

Two source files. `extension.ts` owns all VS Code API interactions. `speechEngine.ts` owns the PowerShell child process and speech recognition. Keep this separation clean.

## Architecture

The extension spawns a background PowerShell process using Windows `System.Speech.Recognition` with a synchronous `Recognize()` polling loop. The process communicates via stdout using four protocols: `READY`, `DETECTED:<phrase>|<confidence>`, `ERROR:<message>`, and `DEBUG:<info>`. The extension reads stdout, matches phrases, and fires VS Code commands. All events are logged to a dedicated "Wake Word" output channel.

On wake word detection, the PowerShell process is killed to release the microphone (handoff), then respawned after a cooldown. This ensures only one thing uses the mic at a time.

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
3. Status bar shows "Wake: Listening" after consent
4. Say a wake phrase, confirm detection notification appears
5. Status bar transitions to "Wake: Active" during handoff
6. Status bar returns to "Wake: Listening" after cooldown
7. Toggle, enable, disable, and reset consent commands all work
8. Output panel shows "Wake Word" channel with timestamped logs

## Boundaries

**NEVER** add runtime npm dependencies. The extension must remain zero-dependency.

**NEVER** send audio data over the network. All recognition is local.

**NEVER** use PowerShell double-quoted strings for user-provided content (injection risk).

**NEVER** modify the ATTRIBUTION.md protocol frontmatter without explicit instruction.

## Attribution

This repository participates in the AI Attribution Protocol. See ATTRIBUTION.md for reciprocity guidelines.
