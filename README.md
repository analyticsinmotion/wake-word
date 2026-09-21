<!-- markdownlint-disable MD033 MD041 -->

<h1 align="center">
  <br>
  <img src="icon.png" width="96" height="96" alt="Wake Word icon">
  <br>
  Wake Word
</h1>
<h3 align="center">Voice Activation for Code Editors</h3>

<!-- badges: start -->
<!--
<div align="center">
  <table>
    <tr>
      <td><strong>Meta</strong></td>
      <td>
        <a href="https://marketplace.visualstudio.com/items?itemName=analytics-in-motion.wake-word"><img src="https://img.shields.io/visual-studio-marketplace/v/analytics-in-motion.wake-word?label=Marketplace&color=blue" alt="VS Code Marketplace version"></a>&nbsp;
        <a href="https://open-vsx.org/extension/analytics-in-motion/wake-word"><img src="https://img.shields.io/open-vsx/v/analytics-in-motion/wake-word?label=Open%20VSX&color=blue" alt="Open VSX version"></a>&nbsp;
        <a href="https://marketplace.visualstudio.com/items?itemName=analytics-in-motion.wake-word"><img src="https://img.shields.io/visual-studio-marketplace/i/analytics-in-motion.wake-word?label=Marketplace%20Installs&color=blue" alt="VS Code Marketplace installs"></a>&nbsp;
        <a href="https://open-vsx.org/extension/analytics-in-motion/wake-word"><img src="https://img.shields.io/open-vsx/dt/analytics-in-motion/wake-word?label=Open%20VSX%20Installs&color=blue" alt="Open VSX installs"></a>&nbsp;
        <a href="https://github.com/analyticsinmotion/wake-word/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License"></a>&nbsp;
      </td>
    </tr>
  </table>
</div>
-->
<!-- badges: end -->

<!-- badges: start -->
<!--
<div align="center">
  <table>
    <tr>
      <td><strong>Meta</strong></td>
      <td>
        <a href="https://github.com/analyticsinmotion/wake-word/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License"></a>&nbsp;
        <a href="https://github.com/analyticsinmotion"><img src="https://github.com/user-attachments/assets/616c530f-cf2a-4f26-8f6c-7397be513847" alt="Analytics in Motion" width="137" height="20"></a>
      </td>
    </tr>
    <tr>
      <td><strong>Microsoft Marketplace</strong></td>
      <td>
        <a href="https://marketplace.visualstudio.com/items?itemName=analytics-in-motion.wake-word"><img src="https://img.shields.io/visual-studio-marketplace/v/analytics-in-motion.wake-word?label=Version&color=blue" alt="VS Code Marketplace version"></a>&nbsp;
        <a href="https://marketplace.visualstudio.com/items?itemName=analytics-in-motion.wake-word"><img src="https://img.shields.io/visual-studio-marketplace/i/analytics-in-motion.wake-word?label=Installs&color=blue" alt="VS Code Marketplace installs"></a>&nbsp;
      </td>
    </tr>
    <tr>
      <td><strong>Open VSX Registry</strong></td>
      <td>
        <a href="https://open-vsx.org/extension/analytics-in-motion/wake-word"><img src="https://img.shields.io/open-vsx/v/analytics-in-motion/wake-word?label=Version&color=blue" alt="Open VSX version"></a>&nbsp;
        <a href="https://open-vsx.org/extension/analytics-in-motion/wake-word"><img src="https://img.shields.io/open-vsx/dt/analytics-in-motion/wake-word?label=Installs&color=blue" alt="Open VSX installs"></a>&nbsp;
      </td>
    </tr>
  </table>
</div>
-->
<!-- badges: end -->

<!-- badges: start -->
<div align="center">
  <table>
    <tr>
      <td><strong>Meta</strong></td>
      <td>
        <a href="https://github.com/analyticsinmotion/wake-word/releases"><img src="https://img.shields.io/github/v/release/analyticsinmotion/wake-word?label=Version&color=blue" alt="Version"></a>&nbsp;
        <a href="https://github.com/analyticsinmotion/wake-word/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License"></a>&nbsp;
        <a href="https://wakeword.io/"><img src="https://img.shields.io/badge/Website-wakeword.io-blue" alt="wakeword.io"></a>&nbsp;
        <a href="https://github.com/analyticsinmotion"><img src="https://github.com/user-attachments/assets/616c530f-cf2a-4f26-8f6c-7397be513847" alt="Analytics in Motion" width="137" height="20"></a>
      </td>
    </tr>
    <tr>
      <td><strong>Registries</strong></td>
      <td>
        <a href="https://marketplace.visualstudio.com/items?itemName=analytics-in-motion.wake-word"><img src="https://img.shields.io/badge/Visual_Studio_Marketplace-blue" alt="Visual Studio Marketplace"></a>&nbsp;
        <a href="https://open-vsx.org/extension/analytics-in-motion/wake-word"><img src="https://img.shields.io/badge/Open_VSX_Registry-C160EF" alt="Open VSX Registry"></a>
      </td>
    </tr>
  </table>
</div>
<!-- badges: end -->

Say a wake phrase and the right AI assistant opens -- no clicking required.

Say **"Hey Claude"** and Claude opens. Say **"Hey Chat"** and the chat panel opens. Say **"Hey Computer"** and the terminal focuses. The extension handles the routing, pauses its own mic so the assistant can use it, then resumes listening when the voice session ends.

**Zero config. No API keys. No accounts. Nothing to install alongside it.** Install and go.

All audio processing happens locally on your machine. Nothing is recorded or transmitted.

https://github.com/user-attachments/assets/fb007095-5c4c-4927-aaa6-fa76550d7cb2

## How It Works

1. Install the extension. A local speech model (~17MB) is downloaded on first use and cached.
2. When your editor opens, the extension starts listening on your microphone
3. Audio is processed locally -- through voice activity detection and keyword spotting -- and matched against your configured wake phrases
4. If a phrase is detected, the extension **releases the mic**, waits for the speech engine to confirm it is closed, and then fires the mapped command
5. The assistant the route opens takes over the microphone with no contention
6. Wake word listening resumes after a configurable cooldown, or, for routes set to manual handoff, when you click the status bar

## Installation

### VS Code

Install directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=analytics-in-motion.wake-word).

Or from the command line (VS Code only):

```bash
code --install-extension analytics-in-motion.wake-word
```

### Cursor, Windsurf, and other VS Code forks

**Option A: Open VSX Registry** -- Search for "Wake Word" in the extensions panel.

**Option B: Manual .vsix install** -- Download the latest `.vsix` from [GitHub Releases](https://github.com/analyticsinmotion/wake-word/releases). Open Extensions, click the three-dot menu, select "Install from VSIX".

### Prerequisites

The speech engine is packaged with the extension, so there is no runtime to install. A local speech model (~17MB) is downloaded on first use and cached. [Platform Support](#platform-support) lists what each platform needs.

**Windows needs the Microsoft Visual C++ Redistributable (x64)**, which most machines already have. Without it, listening fails to start and the status bar shows `Wake: Error`: install `VC_redist.x64.exe` from [Microsoft's latest supported downloads page](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist) and enable listening again.

## First Run Consent

The first time the extension tries to listen, a modal dialog explains exactly what happens: continuous microphone use, fully local processing. You must click "Allow Microphone Listening" to proceed.

If you decline, listening does not start. You can enable it any time via the status bar or command palette, which will re-prompt for consent. Reset the consent prompt with **Wake Word: Reset Microphone Consent**.

## Wake Phrase Routing

The core feature. Each spoken phrase maps to a VS Code command.

### Default routes

These work out of the box with no configuration:

| You say | What opens | Command |
| --- | --- | --- |
| "Hey Claude" | Claude Code | `claude-vscode.focus` |
| "Hey Chat" or "Open Chat" | The editor's chat panel | `workbench.action.chat.open` |
| "Hey Computer" or "Open Terminal" | Terminal | `workbench.action.terminal.focus` |

The Claude route uses manual handoff (see [Handoff mode](#handoff-mode)): after it fires, listening stays paused until you click **Wake: Paused** in the status bar. The other two resume after the cooldown.

### Custom routes

Add your own phrases in `settings.json`. Any spoken English phrase works. Routes are a list of objects, so the Settings editor links out to JSON rather than showing a form:

```json
{
  "wakeWord.routes": [
    {
      "label": "Claude",
      "phrase": "hey claude",
      "command": "claude-vscode.focus"
    },
    {
      "label": "Codex",
      "phrase": "hey codex",
      "command": "chatgpt.newCodexPanel"
    },
    {
      "label": "Search",
      "phrase": "search files",
      "command": "workbench.action.quickOpen"
    },
    {
      "label": "Commands",
      "phrase": "open commands",
      "command": "workbench.action.showCommands"
    }
  ]
}
```

The speech engine listens only for the phrases in your routes, so speech that matches none of them never fires anything.

Detection of uncommon words varies. The speech model works best with common English words, so a phrase built on a product name or other unusual word, such as "hey codex", may be missed more often than the default phrases. If one is, give that route a lower `confidenceThreshold`, lower `wakeWord.confidenceThreshold` for every phrase, or add an alias made of common words.

### Phrase aliases

The `phrase` field accepts a string or an array of strings. Use arrays to map multiple trigger phrases to the same command:

```json
{
  "label": "Claude",
  "phrase": ["hey claude", "open claude"],
  "command": "claude-vscode.focus"
}
```

### Phrase warnings

When listening starts, Wake Word checks your phrases. Anything likely to detect poorly is written to the Wake Word output channel, with one notification pointing at it:

- A single word, such as `"search"`. Single words cause more false positives than a two-word phrase such as `"hey search"`.
- A phrase shorter than four characters.
- A common word on its own, such as `"stop"`, `"okay"`, or `"hello"`.
- The same phrase on two routes. Only the first of those routes can fire.
- A phrase contained in another route's phrase, such as `"claude"` and `"hey claude"`. The shorter one may trigger when the longer one is spoken. Aliases on the same route are not compared, because they run the same command.

Warnings never block a phrase. They are shown once per session, and again when you change your routes' phrases.

### Per-route cooldown

Override the global cooldown for individual routes with `cooldownSeconds`:

```json
{
  "label": "Terminal",
  "phrase": "hey computer",
  "command": "workbench.action.terminal.focus",
  "cooldownSeconds": 10
}
```

### Per-route threshold

Override the global trigger threshold for one route with `confidenceThreshold`. Lower detects more easily, at the cost of more false triggers. Use it for a phrase the speech model finds hard, without making your other phrases trigger more readily:

```json
{
  "label": "Claude",
  "phrase": "hey claude",
  "command": "claude-vscode.focus",
  "confidenceThreshold": 0.03
}
```

The range is 0.01 to 0.9, the same as `wakeWord.confidenceThreshold`. It applies to every phrase on the route, and a route without it uses the global setting.

### Handoff mode

`handoff` chooses how listening comes back after a route fires:

- `"timer"` (default): listening resumes after `cooldownSeconds`.
- `"manual"`: listening stays paused until you click the status bar or run **Wake Word: Enable Listening**. Use this for assistants whose voice sessions run longer than the cooldown, so Wake Word does not restart under them and compete for the microphone.

```json
{
  "label": "Claude",
  "phrase": "hey claude",
  "command": "claude-vscode.focus",
  "handoff": "manual"
}
```

The status bar shows **Wake: Paused** while a manual route waits. The default Claude route uses manual handoff.

### The handoff

When a wake phrase is detected:

1. The extension asks the speech engine to close the microphone and waits for it to confirm. The engine keeps its process running with the speech model loaded, so listening comes back without reloading it. A process that has not confirmed within 500 ms is stopped, which closes the microphone as well
2. Only then does the target VS Code command fire (opening the assistant)
3. The assistant's voice mode takes over the microphone with no contention
4. After `wakeWord.cooldownSeconds` (default: 30), wake word listening resumes. A route with `handoff: "manual"` waits for you instead. Running **Wake Word: Enable Listening** during a cooldown resumes early
5. Status bar shows a live countdown (`Wake: 30s` → `Wake: 29s` → ...) during handoff, then returns to "Wake: Listening". A manual route shows "Wake: Paused" instead, with no countdown

This ensures only one thing uses the mic at a time.

### Multiple windows

If you have more than one editor window open, only one listens at a time. The first window to start listening takes a lock; the others show **Wake: Other window** in the status bar and stand by. When the listening window closes, crashes, or has listening disabled, a standing-by window takes over within about ten seconds. The lock is held through the cooldown after a detection, so a second window never opens the microphone while an assistant has it.

The lock lives in the extension's global storage, which windows of the same editor share. Windows of different editor products do not see each other's lock.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `wakeWord.routes` | `[]` | Wake phrase routing table. Uses defaults if empty. |
| `wakeWord.cooldownSeconds` | `30` | Seconds to pause after handoff before resuming. Routes with `handoff: "manual"` wait for you instead |
| `wakeWord.enableOnStartup` | `true` | Start listening when the editor opens |
| `wakeWord.showNotificationOnDetection` | `true` | Show notification when wake phrase is heard |
| `wakeWord.pauseOnFocusLoss` | `false` | Pause listening when the editor loses focus, resume on regain |
| `wakeWord.confidenceThreshold` | `0.05` | Trigger threshold (0.01 to 0.9) for wake phrase detection. Lower detects more easily, higher gives fewer false positives |
| `wakeWord.confirmationMode` | `false` | Require the wake phrase twice within 5 seconds before triggering. Reduces false positives in noisy environments. |
| `wakeWord.audioDevice` | `""` | Microphone to use: a case-insensitive substring of the device name (e.g. `"USB"`) or a device index. Empty for the system default. |

### Choosing a microphone

`wakeWord.audioDevice` selects the input device. Use any case-insensitive substring of the device name as it appears in your system sound settings, or the device's index number:

```json
{
  "wakeWord.audioDevice": "Blue Yeti"
}
```

Changing it restarts the engine. If the value matches no device, or more than one, the error notification says so and names the value.

## Common command IDs

Useful values for the `command` field in your routes. Command IDs listed are for VS Code. Cursor and other editors may use different IDs for the same features.

| Assistant / Feature | Command ID |
| --- | --- |
| The editor's chat panel | `workbench.action.chat.open` |
| Claude Code | `claude-vscode.focus` |
| VS Code Speech dictation | `workbench.action.editorDictation.start` |
| Command Palette | `workbench.action.showCommands` |
| Focus Terminal | `workbench.action.terminal.focus` |
| Quick Open | `workbench.action.quickOpen` |
| Toggle Sidebar | `workbench.action.toggleSidebarVisibility` |
| New File | `workbench.action.files.newUntitledFile` |

## Privacy

All speech recognition runs locally on your machine. No audio data ever leaves your device. A local `sherpa-onnx` model processes audio in memory in the engine child process. Nothing is recorded, stored, or transmitted. The only network request the extension makes is the one-time download of the speech model from GitHub.

## Dependencies

The speech engine is built on two open source projects, both packaged with the extension.

| Project | What it does | Links |
| --- | --- | --- |
| decibri | Microphone capture, signal conditioning, and voice activity detection | [GitHub](https://github.com/decibri/decibri) / [decibri.com](https://decibri.com) |
| sherpa-onnx | Open-vocabulary keyword spotting | [GitHub](https://github.com/k2-fsa/sherpa-onnx) |

The extension host has one runtime npm dependency, `sentencepiece-js`, which turns each wake phrase into the speech model's word pieces. All native code runs in the engine child process.

## Platform Support

| Platform | Status | Engine | Needs |
| --- | --- | --- | --- |
| Windows 10/11 (x64) | Supported | sherpa-onnx | Visual C++ Redistributable |
| macOS 14+ (Apple silicon) | Supported | sherpa-onnx | nothing |
| Linux (x64, ARM64) | Supported | sherpa-onnx | glibc 2.28+, ALSA |

## Compatibility

| Editor | Install method |
| --- | --- |
| VS Code | Marketplace or `code --install-extension analytics-in-motion.wake-word` |
| Cursor | Open VSX or .vsix from GitHub Releases |
| Windsurf | Open VSX or .vsix from GitHub Releases |
| Other VS Code forks | .vsix from GitHub Releases |

## License

Apache 2.0
