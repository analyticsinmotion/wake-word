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

**Zero config. No API keys. No accounts.** Install and go. On Windows it needs the Visual C++ Redistributable, which most machines already have.

All audio processing happens locally on your machine. Nothing is recorded or transmitted.

https://github.com/user-attachments/assets/fb007095-5c4c-4927-aaa6-fa76550d7cb2

## How It Works

1. Install the extension. A local speech model (~17MB) is downloaded on first use and cached. The download can be cancelled from its notification, and one that receives nothing for 30 seconds stops and says so.
2. When your editor opens, the extension starts listening on your microphone
3. Audio is processed locally -- through voice activity detection and keyword spotting -- and matched against your configured wake phrases
4. If a phrase is detected, the extension **releases the mic**, waits for the speech engine to confirm it is closed, and then fires the mapped command
5. The assistant the route opens takes over the microphone with no contention
6. Wake word listening resumes after a configurable cooldown, or, for routes set to manual handoff, when you click the status bar or press the toggle shortcut

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

The Claude route uses manual handoff (see [Handoff mode](#handoff-mode)): after it fires, listening stays paused until you click **Wake: Paused** in the status bar or press the toggle shortcut. The other two resume after the cooldown.

The Claude route needs the Claude Code extension. Without it, that route is set aside and the other two still work: see [Routes whose command is not available](#routes-whose-command-is-not-available).

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

### Routes whose command is not available

When listening starts, Wake Word checks that each route's command exists in your editor. A route whose command is not available, such as the default Claude route when Claude Code is not installed, is not listened for. A notification names the route, its command, and the extension to install. It appears once, not every time the editor starts, and **Wake Word: Show Diagnostics** lists these routes under "Set aside".

A command counts as available as soon as an installed extension provides it, even before that extension has started. Install or enable the extension a route needs and the route is listened for again, without restarting the editor. If none of your routes' commands are available, the microphone is not opened, and the status bar shows **Wake: No commands** until one is.

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
- `"manual"`: listening stays paused until you click the status bar, press the toggle shortcut, or run **Wake Word: Enable Listening**. Use this for assistants whose voice sessions run longer than the cooldown, so Wake Word does not restart under them and compete for the microphone.

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

### Remote windows

Wake Word works in remote windows: SSH, WSL, dev containers, and Codespaces opened in the desktop editor. It runs on your own machine, beside your microphone, and the commands it runs reach extensions on the remote side, such as Claude Code installed there. It does not run in the editor in a web browser, which cannot run its speech engine.

If you installed Wake Word from a remote window before version 0.16.0, it was installed on the remote host. After updating, open Wake Word in the Extensions view and choose **Install Locally**.

### Status bar

| Status bar | Meaning |
| --- | --- |
| Wake: Starting | Loading the speech model and opening the microphone. Wake phrases are not heard yet |
| Wake: Listening | Listening for wake phrases |
| Wake: Confirm | Confirmation mode heard a phrase once, and is waiting to hear it again |
| Wake: Active, Wake: 30s, Wake: Paused | A wake phrase handed the microphone to the assistant it opened |
| Wake: Unfocused | Paused while the window is not focused (`wakeWord.pauseOnFocusLoss`). Focusing the window resumes it |
| Wake: Restarting | The speech engine stopped and is being restarted |
| Wake: Calibrating | A **Wake Word: Calibrate** run is listening |
| Wake: Error | Listening stopped; the tooltip says why. Click to try again |
| Wake: Off | Not listening. Click, or press the toggle shortcut, to start |
| Wake: Other window | Another window of the same editor is listening |
| Wake: No commands | None of the routes' commands are available in this editor |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `wakeWord.routes` | `[]` | Wake phrase routing table. Uses defaults if empty. |
| `wakeWord.cooldownSeconds` | `30` | Seconds to pause after handoff before resuming. Routes with `handoff: "manual"` wait for you instead |
| `wakeWord.enableOnStartup` | `true` | Start listening when the editor opens |
| `wakeWord.showNotificationOnDetection` | `true` | Show notification when wake phrase is heard |
| `wakeWord.pauseOnFocusLoss` | `false` | Pause listening when the editor loses focus, and resume when it is focused again. The status bar shows `Wake: Unfocused` meanwhile |
| `wakeWord.confidenceThreshold` | `0.05` | Trigger threshold (0.01 to 0.9) for wake phrase detection. Lower detects more easily, higher gives fewer false positives |
| `wakeWord.confirmationMode` | `false` | Require the wake phrase twice within 5 seconds before triggering. Reduces false positives in noisy environments. |
| `wakeWord.audioDevice` | `""` | Microphone to use: a case-insensitive substring of the device name (e.g. `"USB"`) or a device index. Empty for the system default. |

### Choosing a microphone

`wakeWord.audioDevice` selects the input device. Use any case-insensitive substring of the device name as it appears in your system sound settings, or the device's index number:

```json
{
  "wakeWord.audioDevice": "Headset"
}
```

Changing it restarts the engine. If the value matches no device, or more than one, the error notification says so and names the value. **Wake Word: Show Diagnostics** lists your input devices with their names and index numbers.

## Commands

Every command is in the Command Palette under **Wake Word**. Toggle Listening also has a shortcut, **Shift+Alt+W** (**Ctrl+Cmd+W** on macOS), which works from the editor, the terminal, and an assistant's panel, and from a foot pedal that sends a key combination. Change it in Keyboard Shortcuts.

| Command | What it does |
| --- | --- |
| Wake Word: Enable Listening | Start listening, or resume after a handoff |
| Wake Word: Disable Listening | Stop listening and release the microphone |
| Wake Word: Toggle Listening | The status bar click: turn listening off or on, or resume after a manual handoff |
| Wake Word: Calibrate | Listen for 15 seconds and report each phrase heard, without running any route |
| Wake Word: Show Diagnostics | Write a report to the Wake Word output channel, with Show Log, Copy to Clipboard, and Report Issue |
| Wake Word: Open Settings | Open the Settings editor at Wake Word's settings |
| Wake Word: Reset Microphone Consent | Forget the consent given, so the next start asks again |

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

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The status bar shows **Wake: Error** | Hover over it for the reason, or open the **Wake Word** output channel. Fix what it names, then click the status bar to try again |
| Nothing is heard | Run **Wake Word: Show Diagnostics**: it lists your input devices and marks the one in use. Choose another with `wakeWord.audioDevice`, then run **Wake Word: Calibrate** to see what is heard |
| macOS: nothing is heard | Allow your editor in System Settings > Privacy & Security > Microphone, then quit and reopen it |
| Windows: nothing is heard | In Settings > Privacy & security > Microphone, turn on microphone access and "Let desktop apps access your microphone" |
| Windows: **Wake: Error** as soon as listening starts | Install the [Microsoft Visual C++ Redistributable (x64)](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist), then enable listening again |
| A Bluetooth headset sounds worse while listening | Keeping its microphone open switches the headset to its lower-quality call mode. Set `wakeWord.audioDevice` to your computer's built-in microphone |
| A remote window (SSH, WSL, dev container) | Wake Word runs on your own machine, beside the microphone. If it was installed on the remote host, open it in the Extensions view and choose **Install Locally** |
| The shortcut does nothing in the terminal | Add `wakeWord.toggle` to `terminal.integrated.commandsToSkipShell` in your settings |
| Reporting a problem | Run **Developer: Set Log Level**, choose **Wake Word**, then **Debug**, and repeat what went wrong: the output channel now shows the engine's detail. Then run **Wake Word: Show Diagnostics** and choose **Report Issue**: the report is copied and a new issue opens for you to paste it into, check, and submit |

The log and the report never contain audio or anything you said, and device names that look like a person's are shortened in the report.

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