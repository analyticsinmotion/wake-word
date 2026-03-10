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

Say **"Hey Claude"** and Claude opens. Say **"Hey Copilot"** and Copilot opens. Say **"Computer"** and the terminal focuses. The extension handles the routing, pauses its own mic so the assistant can use it, then resumes listening when the voice session ends.

**Zero config. No API keys. No accounts. No system dependencies.** Install and go.

All audio processing happens locally on your machine. Nothing is recorded or transmitted.

## How It Works

1. Install the extension. On Windows, that's all. On macOS/Linux, a local speech model (~17MB) is downloaded on first use and cached.
2. When your editor opens, the extension starts listening on your microphone
3. The speech engine matches recognised speech against your configured wake phrases
4. If a phrase is detected with sufficient confidence, the extension **releases the mic** and fires the mapped command
5. The target assistant (Claude, Copilot, etc.) takes over the microphone with no contention
6. After a configurable cooldown, wake word listening resumes automatically

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

| Platform | Requirement |
| --- | --- |
| Windows 10/11 | No additional software. Uses built-in `System.Speech.Recognition` |
| macOS | Node.js 18+ (for the speech engine child process) |
| Linux | Node.js 18+ (for the speech engine child process) |

On macOS and Linux a local speech model (~17MB) is downloaded on first use and cached. If Node.js is installed via nvm or fnm and not on VS Code's PATH, set `wakeWord.nodePath` to the full path of your `node` executable.

## First Run Consent

The first time the extension tries to listen, a modal dialog explains exactly what happens: continuous microphone use, fully local processing. You must click "Allow Microphone Listening" to proceed.

If you decline, listening does not start. You can enable it any time via the status bar or command palette, which will re-prompt for consent. Reset the consent prompt with **Wake Word: Reset Microphone Consent**.

## Wake Phrase Routing

The core feature. Each spoken phrase maps to a VS Code command.

### Default routes

These work out of the box with no configuration:

| You say | What opens | Command |
| --- | --- | --- |
| "Hey Copilot" | GitHub Copilot Chat | `workbench.action.chat.open` |
| "Hey Claude" | Claude Code | `claude-vscode.focus` |
| "Computer" | Terminal | `workbench.action.terminal.focus` |

### Custom routes

Add your own phrases in `settings.json`. Any spoken English phrase works:

```json
{
  "wakeWord.routes": [
    {
      "label": "Copilot",
      "phrase": "hey copilot",
      "command": "workbench.action.chat.open"
    },
    {
      "label": "Claude",
      "phrase": "hey claude",
      "command": "claude-vscode.focus"
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

The speech engine uses a constrained grammar built from your configured phrases for accurate matching.

### Phrase aliases

The `phrase` field accepts a string or an array of strings. Use arrays to map multiple trigger phrases to the same command:

```json
{
  "label": "Claude",
  "phrase": ["hey claude", "open claude"],
  "command": "claude-vscode.focus"
}
```

### Per-route cooldown

Override the global cooldown for individual routes with `cooldownSeconds`:

```json
{
  "label": "Terminal",
  "phrase": "computer",
  "command": "workbench.action.terminal.focus",
  "cooldownSeconds": 10
}
```

### The handoff

When a wake phrase is detected:

1. The extension **immediately kills** the speech engine process, releasing the mic
2. The target VS Code command fires (opening the assistant)
3. The assistant's voice mode takes over the microphone with no contention
4. After `wakeWord.cooldownSeconds` (default: 30), wake word listening resumes
5. Status bar shows a live countdown (`Wake: 30s → Wake: 29s → ...`) during handoff, then returns to "Wake: Listening"

This ensures only one thing uses the mic at a time.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `wakeWord.routes` | `[]` | Wake phrase routing table. Uses defaults if empty. |
| `wakeWord.cooldownSeconds` | `30` | Seconds to pause after handoff before resuming |
| `wakeWord.enableOnStartup` | `true` | Start listening when the editor opens |
| `wakeWord.showNotificationOnDetection` | `true` | Show notification when wake phrase is heard |
| `wakeWord.pauseOnFocusLoss` | `false` | Pause listening when the editor loses focus, resume on regain |
| `wakeWord.confidenceThreshold` | `0.3` | Minimum confidence score (0.1–0.9) for wake phrase detection |
| `wakeWord.engine` | `auto` | Speech engine: `auto` (platform default), `windows` (System.Speech), or `sherpa` (cross-platform) |
| `wakeWord.nodePath` | `""` | Path to Node.js executable. Leave empty to auto-detect. Set this if the engine cannot find Node.js (macOS/Linux with nvm or fnm). |

## Commands

- **Wake Word: Enable Listening** -- start the detector
- **Wake Word: Disable Listening** -- stop the detector
- **Wake Word: Toggle Listening** -- toggle on/off (also via status bar click)
- **Wake Word: Reset Microphone Consent** -- clear consent and re-prompt

## Common command IDs

Useful values for the `command` field in your routes. Command IDs listed are for VS Code. Cursor and other editors may use different IDs for the same features.

| Assistant / Feature | Command ID |
| --- | --- |
| GitHub Copilot Chat | `workbench.action.chat.open` |
| Claude Code | `claude-vscode.focus` |
| VS Code Speech dictation | `workbench.action.editorDictation.start` |
| Command Palette | `workbench.action.showCommands` |
| Focus Terminal | `workbench.action.terminal.focus` |
| Quick Open | `workbench.action.quickOpen` |
| Toggle Sidebar | `workbench.action.toggleSidebarVisibility` |
| New File | `workbench.action.files.newUntitledFile` |

## How It Works (Technical)

The extension selects a speech engine based on platform (or the `wakeWord.engine` setting) and spawns it as a background child process. Both engines communicate via stdout using the same protocol: `READY`, `DETECTED:<phrase>|<confidence>`, `ERROR:<message>`, `DEBUG:<info>`.

### Windows engine (default on Windows)

Spawns a PowerShell process using `System.Speech.Recognition.SpeechRecognitionEngine`, the same engine built into Windows. A constrained grammar is built from your configured phrases and passed via encoded command. Zero model downloads; the speech engine ships with Windows.

### Sherpa engine (default on macOS/Linux, optional on Windows)

Spawns `audio-engine.js` under **system Node.js** (not Electron). The child process uses `@analyticsinmotion/micstream` (PortAudio) for mic capture and `sherpa-onnx` for keyword spotting. Running under system Node.js is required because Electron's Node.js runtime cannot load native audio addons. A local speech model (~17MB) is downloaded to VS Code's global storage on first use and cached.

### Shared flow

1. Extension builds phrase list and spawns the engine process
2. Engine writes `READY` when the mic is open
3. Each detection above the confidence threshold is written to stdout as `DETECTED:<phrase>|<confidence>`
4. The extension reads stdout and fires the corresponding command
5. On handoff, the engine process is killed to release the microphone
6. After the cooldown countdown, a new engine process starts

Zero runtime npm dependencies in the extension host. All native dependencies are isolated in the `engine/` child process.

## Troubleshooting

| Problem | Solution |
| --- | --- |
| Engine starts but never detects phrases | Try lowering `wakeWord.confidenceThreshold` (e.g. `0.2`). Speak clearly and close to your microphone. |
| Too many false positives | Raise `wakeWord.confidenceThreshold` (e.g. `0.5` or higher). Use longer, more distinctive wake phrases. |
| "Failed to start speech engine" | Ensure your microphone is connected and not in use by another application. Check your system sound settings. |
| Status bar shows "Wake: Error" | Click the status bar item to retry. Check the Output panel for details. If the error persists, try **Wake Word: Reset Microphone Consent** and re-enable. |
| Extension keeps restarting | The engine retries up to 3 times on crash with increasing delays. If it fails after 3 retries, check that your audio device is working. |
| "Could not find Node.js" (macOS/Linux) | Set `wakeWord.nodePath` to the full path of your `node` executable (e.g. `/opt/homebrew/bin/node`). Common when using nvm or fnm. |
| Microphone access denied (macOS) | Open System Settings → Privacy & Security → Microphone and enable access for VS Code (or your editor). |
| Model download fails | Check your internet connection. The model is ~17MB downloaded from GitHub. If behind a proxy, ensure HTTPS traffic to `github.com` is allowed. |

## Privacy

All speech recognition runs locally on your machine. No audio data ever leaves your device. On Windows, speech is processed by the built-in `System.Speech.Recognition` engine in memory. On macOS and Linux, a local `sherpa-onnx` model processes audio in the engine child process. Nothing is recorded, stored, or transmitted.

## Platform Support

| Platform | Status | Engine |
| --- | --- | --- |
| Windows 10/11 | Supported | Windows built-in System.Speech |
| macOS | Supported | sherpa-onnx (requires Node.js 18+) |
| Linux | Supported | sherpa-onnx (requires Node.js 18+) |

## Compatibility

| Editor | Install method |
| --- | --- |
| VS Code | Marketplace or `code --install-extension analytics-in-motion.wake-word` |
| Cursor | Open VSX or .vsix from GitHub Releases |
| Windsurf | Open VSX or .vsix from GitHub Releases |
| Other VS Code forks | .vsix from GitHub Releases |

## License

Apache 2.0
