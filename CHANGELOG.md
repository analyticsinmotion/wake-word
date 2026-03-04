# Changelog

## 0.1.0

- Initial release
- Zero-config wake word detection: no API keys, no accounts, no system dependencies
- Local speech recognition via Windows built-in `System.Speech.Recognition` engine
- Multi-phrase routing: map any spoken English phrase to any VS Code command
- Default routes for "Hey Claude", "Hey Copilot", and "Computer" out of the box
- Mic handoff: pauses wake word listening and releases the mic when an assistant is triggered
- Automatic resume after configurable cooldown period
- First-run consent flow with clear microphone usage disclosure
- Status bar indicator with listening state
- Auto-start on VS Code launch (after consent)
- Windows 10/11 supported; macOS and Linux planned for a future release
- Published to VS Code Marketplace and Open VSX Registry
