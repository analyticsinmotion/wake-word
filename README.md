<!-- markdownlint-disable MD033 MD041 -->

<h1 align="center">
  <br>
  <img src="icon.png" width="96" height="96" alt="Wake Word icon">
  <br>
  Wake Word
</h1>
<h3 align="center">Voice Activation for VS Code</h3>

<!-- badges: start -->
<div align="center">
  <table>
    <tr>
      <td><strong>Meta</strong></td>
      <td>
        <a href="https://marketplace.visualstudio.com/items?itemName=analytics-in-motion.wake-word"><img src="https://img.shields.io/visual-studio-marketplace/v/analytics-in-motion.wake-word?label=Marketplace&color=blue" alt="VS Code Marketplace version"></a>&nbsp;
        <a href="https://open-vsx.org/extension/analytics-in-motion/wake-word"><img src="https://img.shields.io/open-vsx/v/analytics-in-motion/wake-word?label=Open%20VSX&color=blue" alt="Open VSX version"></a>&nbsp;
        <a href="https://marketplace.visualstudio.com/items?itemName=analytics-in-motion.wake-word"><img src="https://img.shields.io/visual-studio-marketplace/i/analytics-in-motion.wake-word?label=Installs&color=blue" alt="VS Code Marketplace installs"></a>&nbsp;
        <a href="https://github.com/analyticsinmotion/wake-word/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License"></a>&nbsp;
        <a href="https://github.com/analyticsinmotion"><img src="https://raw.githubusercontent.com/analyticsinmotion/.github/main/assets/images/analytics-in-motion-github-badge-rounded.svg" alt="Analytics in Motion"></a>
      </td>
    </tr>
  </table>
</div>
<!-- badges: end -->

Say a wake phrase and the right AI assistant opens -- no clicking required.

Say **"Hey Claude"** and Claude opens. Say **"Hey Copilot"** and Copilot opens. Say **"Computer"** and the terminal focuses. The extension handles the routing, pauses its own mic so the assistant can use it, then resumes listening when the voice session ends.

**Zero config. No API keys. No accounts. No downloads. No system dependencies.** Install and go.

All audio processing happens locally on your machine using Windows built-in speech recognition. Nothing is recorded or transmitted.

## How It Works

1. Install the extension -- that's it, no other setup
2. When VS Code opens, the extension starts listening on your microphone via Windows speech recognition
3. The extension matches recognised words against your configured wake phrases using prefix matching
4. If a phrase is detected with sufficient confidence, the extension **releases the mic** and fires the mapped command
5. The target assistant (Claude, Copilot, etc.) takes over the microphone with no contention
6. After a configurable cooldown, wake word listening resumes automatically

## Installation

### VS Code

Install directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=analytics-in-motion.wake-word).

Or from the command line:

```bash
code --install-extension analytics-in-motion.wake-word
```

### Cursor, Windsurf, and other VS Code forks

**Option A: Open VSX Registry** -- Search for "Wake Word" in the extensions panel.

**Option B: Manual .vsix install** -- Download the latest `.vsix` from [GitHub Releases](https://github.com/analyticsinmotion/wake-word/releases). Open Extensions, click the three-dot menu, select "Install from VSIX".

### Prerequisites

Windows 10 or later. The extension uses Windows built-in `System.Speech.Recognition` engine which ships with all modern Windows installations. No additional software is required.

macOS and Linux support is planned for a future release.

## First Run Consent

The first time the extension tries to listen, a modal dialog explains exactly what happens: continuous microphone use, fully local processing. You must click "Allow Microphone Listening" to proceed.

If you decline, auto-start is disabled. You can re-enable any time via the status bar or command palette. Reset the consent prompt with **Wake Word: Reset Microphone Consent**.

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

The speech engine uses Windows built-in dictation with prefix matching against your configured phrases.

### The handoff

When a wake phrase is detected:

1. The extension **immediately kills** the speech engine process, releasing the mic
2. The target VS Code command fires (opening the assistant)
3. The assistant's voice mode takes over the microphone with no contention
4. After `wakeWord.cooldownSeconds` (default: 30), wake word listening resumes
5. Status bar shows "Wake: Active" during handoff, then returns to "Wake: Listening"

This ensures only one thing uses the mic at a time.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `wakeWord.routes` | `[]` | Wake phrase routing table. Uses defaults if empty. |
| `wakeWord.cooldownSeconds` | `30` | Seconds to pause after handoff before resuming |
| `wakeWord.enableOnStartup` | `true` | Start listening when VS Code opens |
| `wakeWord.showNotificationOnDetection` | `true` | Show notification when wake phrase is heard |

## Commands

- **Wake Word: Enable Listening** -- start the detector
- **Wake Word: Disable Listening** -- stop the detector
- **Wake Word: Toggle Listening** -- toggle on/off (also via status bar click)
- **Wake Word: Reset Microphone Consent** -- clear consent and re-prompt

## Common command IDs

Useful values for the `command` field in your routes:

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

The extension spawns a background PowerShell process that uses `System.Speech.Recognition.SpeechRecognitionEngine` to listen for wake phrases. This is the same speech engine built into Windows that powers Cortana and Windows Speech Recognition.

The process flow:

1. Extension builds a dictation-based recognition loop with prefix matching for the configured wake phrases
2. The recognition script is passed to PowerShell via an encoded command
3. PowerShell loads `System.Speech`, sets up a dictation grammar, and calls `Recognize()` in a loop
4. Recognised text is matched against wake phrase prefixes; a match writes to stdout
5. The extension reads stdout and fires the corresponding VS Code command
6. On pause (handoff), the PowerShell process is killed to release the microphone
7. On resume, a new PowerShell process starts

Zero runtime npm dependencies. Zero model downloads. The speech engine ships with Windows.

## Privacy

All speech recognition runs locally via Windows built-in `System.Speech.Recognition`. No audio data leaves your machine. The microphone stream is processed in memory by the Windows speech engine and never written to disk.

## Platform Support

| Platform | Status |
| --- | --- |
| Windows 10/11 | Supported |
| macOS | Planned |
| Linux | Planned |

## Compatibility

| Editor | Install method |
| --- | --- |
| VS Code | Marketplace or `code --install-extension analytics-in-motion.wake-word` |
| Cursor | Open VSX or .vsix from GitHub Releases |
| Windsurf | Open VSX or .vsix from GitHub Releases |
| Other VS Code forks | .vsix from GitHub Releases |

## License

Apache 2.0
