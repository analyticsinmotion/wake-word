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

**Zero config. No API keys. No accounts.** The only prerequisite is Node.js 22 or later. Install and go.

All audio processing happens locally on your machine. Nothing is recorded or transmitted.

https://github.com/user-attachments/assets/fb007095-5c4c-4927-aaa6-fa76550d7cb2

## How It Works

1. Install the extension. A local speech model (~17MB) is downloaded on first use and cached.
2. When your editor opens, the extension starts listening on your microphone
3. Audio is processed locally -- through voice activity detection and keyword spotting -- and matched against your configured wake phrases
4. If a phrase is detected, the extension **releases the mic**, waits for the speech engine to confirm it is closed, and then fires the mapped command
5. The target assistant (Claude, Copilot, etc.) takes over the microphone with no contention
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

Wake Word needs **Node.js 22 or later** (LTS) on every platform: Windows 10/11, macOS, and Linux. The speech engine runs as a child process under it. Download it from [nodejs.org](https://nodejs.org/).

A local speech model (~17MB) is downloaded on first use and cached. If Node.js is installed via nvm, fnm, or another version manager and is not on your editor's PATH, set `wakeWord.nodePath` to the full path of your `node` executable.

**Upgrading on Windows from 0.12 or earlier:** Windows used to run the built-in System.Speech engine, which needed no Node.js. That engine has been retired, and Windows now runs the same engine as macOS and Linux. Install Node.js 22 or later if you do not have it. A `wakeWord.engine` entry left in your settings has no effect and can be removed.

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

Add your own phrases in `settings.json`. Any spoken English phrase works:

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

Detection of uncommon words varies. The speech model works best with common English words, so a phrase built on a product name or other unusual word, such as "hey codex", may be missed more often than the default phrases. If one is, run **Wake Word: Calibrate** to see what is heard, lower `wakeWord.confidenceThreshold`, or add an alias made of common words.

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

Warnings never block a phrase. They are shown once per session, and again when you change your routes' phrases. **Wake Word: Show Diagnostics** lists them as well.

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

1. The extension asks the speech engine to close the microphone and waits for it to
   confirm. The engine keeps its process running with the speech model loaded, so
   listening comes back without reloading it. A process that has not confirmed within
   500 ms is stopped, which closes the microphone as well
2. Only then does the target VS Code command fire (opening the assistant)
3. The assistant's voice mode takes over the microphone with no contention
4. After `wakeWord.cooldownSeconds` (default: 30), wake word listening resumes. A route with `handoff: "manual"` waits for you instead. Running **Wake Word: Enable Listening** during a cooldown resumes early
5. Status bar shows a live countdown (`Wake: 30s → Wake: 29s → ...`) during handoff, then returns to "Wake: Listening". A manual route shows "Wake: Paused" instead, with no countdown

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
| `wakeWord.nodePath` | `""` | Path to Node.js executable. Leave empty to auto-detect. Set this if the engine cannot find Node.js (common with nvm or fnm). |
| `wakeWord.audioDevice` | `""` | Microphone to use: a case-insensitive substring of the device name (e.g. `"USB"`) or a device index. Empty for the system default. |

### Choosing a microphone

`wakeWord.audioDevice` selects the input device. Use any case-insensitive substring of the device name as it appears in your system sound settings, or the device's index number:

```json
{
  "wakeWord.audioDevice": "Blue Yeti"
}
```

Changing it restarts the engine. If the value matches no device, or more than one, the error notification says so and names the value.

### Calibrating

**Wake Word: Calibrate** listens for 15 seconds and logs every wake phrase it hears, with the time, without firing any route. Say each of your phrases a few times at your normal distance, then open the Wake Word output channel: the summary counts the detections of each phrase. No detections means the microphone, the room, or the threshold needs attention; a phrase heard only some of the times you said it is on the edge. The keyword spotter applies the threshold itself and reports no confidence score, so the summary has counts only. Whatever the extension was doing before, listening, a cooldown, or a manual pause, is put back afterwards.

## Commands

- **Wake Word: Enable Listening** -- start the detector
- **Wake Word: Disable Listening** -- stop the detector
- **Wake Word: Toggle Listening** -- toggle on/off (also via status bar click)
- **Wake Word: Reset Microphone Consent** -- clear consent and re-prompt
- **Wake Word: Open Settings** -- open the Settings editor filtered to Wake Word (also linked from the status bar tooltip)
- **Wake Word: Calibrate** -- listen for 15 seconds and log what is heard without firing any route (see [Calibrating](#calibrating))
- **Wake Word: Show Diagnostics** -- write the versions, platform, Node.js, model, audio device, settings, routes, phrase warnings, and engine state to the output channel, with an option to copy them for a bug report. Your home directory is replaced with `~`, and no audio is included. Also opened by clicking the engine indicator in the status bar

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

The extension runs one speech engine on every platform. It spawns `audio-engine.js` as a background child process under **system Node.js** (not Electron). The child uses `decibri` for mic capture and `sherpa-onnx` for keyword spotting. Running under system Node.js is required because Electron's Node.js runtime cannot load native audio addons. A local speech model (~17MB) is downloaded to VS Code's global storage on first use, checked against a pinned SHA-256 digest, and cached. The process is started once and kept across handoffs: a handoff closes only the microphone, and the model stays loaded for the resume.

The engine talks to the extension over stdout: `READY`, `DETECTED:<phrase>`, `PAUSED`, `RELEASED`, `ERROR:<message>`, and `DEBUG:<info>`. It takes `pause`, `resume`, and `stop` commands on stdin, and answers `PAUSED` once it has closed the microphone for a handoff, `READY` once it has reopened it, and `RELEASED` once it has closed it for good.

Captured audio passes through voice activity detection (Silero VAD) before it reaches the keyword spotter, so the spotter only runs while someone is speaking and an idle editor does not decode silence. decibri also conditions the signal on the way through: DC offset removal, an 80 Hz high-pass to drop rumble below the voice band, and automatic gain control targeting -18 dBFS so the confidence threshold sees a consistent level.

### Flow

1. The extension builds the phrase list and spawns the engine process
2. The engine writes `READY` when the mic is open
3. Each detection is written to stdout as `DETECTED:<phrase>`
4. The extension reads stdout and matches the phrase to its route
5. On handoff, the extension sends `pause` and waits for `PAUSED`, for at most 500 ms before it stops the process; the engine keeps its process and model loaded
6. The route's command fires
7. After the cooldown, or when you resume a manual route, the engine reopens the microphone

Zero runtime npm dependencies in the extension host. All native dependencies are isolated in the `engine/` child process.

## Troubleshooting

| Problem | Solution |
| --- | --- |
| Reporting a problem | Run **Wake Word: Show Diagnostics**, choose **Copy to Clipboard**, and paste the report into your issue. It has no audio, and your home directory is replaced with `~`. |
| Engine starts but never detects phrases | Run **Wake Word: Calibrate** to see what the engine hears. Try lowering `wakeWord.confidenceThreshold` (e.g. `0.02`). Speak clearly and close to your microphone. |
| Some phrases detect better than others | The keyword spotter uses an open-vocabulary model that works best with common English words. Proper nouns and unusual words may need a lower confidence threshold: try lowering `wakeWord.confidenceThreshold` (e.g. `0.02`). The default phrases are tuned for reliable detection at the default of `0.05`. For a custom phrase that is still missed, run **Wake Word: Calibrate** and try an alias made of common words. |
| Too many false positives | Enable `wakeWord.confirmationMode`, which requires the phrase twice within 5 seconds: say it, pause about three seconds, say it again. The status bar shows `Wake: Confirm` between the two. Also try raising `wakeWord.confidenceThreshold` (e.g. `0.1` to `0.3`) and using longer, more distinctive wake phrases. |
| "Phrase warning" notification | One of your phrases is a single word, very short, a common word, or clashes with another route's phrase. The output channel says which and why. See [Phrase warnings](#phrase-warnings). |
| Listening does not resume after a wake phrase | The route uses `handoff: "manual"`, which the default Claude route does. Click **Wake: Paused** in the status bar or run **Wake Word: Enable Listening**. Set `handoff` to `"timer"` on that route to resume after the cooldown instead. |
| "Failed to start audio engine" | Ensure your microphone is connected and not in use by another application. Check your system sound settings. |
| Status bar shows "Wake: Error" | Click the status bar item to retry. Check the Output panel for details. If the error persists, try **Wake Word: Reset Microphone Consent** and re-enable. |
| Extension keeps restarting | The engine retries up to 3 times on crash with increasing delays. If it fails after 3 retries, check that your audio device is working. |
| "Could not find Node.js" | Install Node.js 22 or later from [nodejs.org](https://nodejs.org/). If it is already installed, set `wakeWord.nodePath` to the full path of your `node` executable (e.g. `/opt/homebrew/bin/node` or `C:\Program Files\nodejs\node.exe`). Common when using nvm or fnm. |
| Microphone access denied (Windows) | Open Settings → Privacy & security → Microphone and turn on **Microphone access** and **Let desktop apps access your microphone**. |
| Microphone access denied (macOS) | Open System Settings → Privacy & Security → Microphone and enable access for VS Code (or your editor). |
| Model download fails | Check your internet connection. The model is ~17MB downloaded from GitHub. If behind a proxy, ensure HTTPS traffic to `github.com` is allowed. |
| High CPU while idle | The engine gates keyword spotting on voice activity detection, so a quiet room should cost close to nothing. Sustained CPU with no one speaking usually means a noisy input: check the correct microphone is selected and lower its input gain. |
| Status bar shows "Wake: Other window" | Another window of the same editor is listening. Only one listens at a time, and this window takes over automatically when that one stops. To move listening here now, disable it in the other window. |
| Wrong microphone is used | Set `wakeWord.audioDevice` to part of the device's name (e.g. `"USB"`) or its index. |
| "No microphone matching ... was found" | The `wakeWord.audioDevice` value did not match any input device. Compare it with the device names in your system sound settings, or clear it to use the default. |

## Privacy

All speech recognition runs locally on your machine. No audio data ever leaves your device. A local `sherpa-onnx` model processes audio in memory in the engine child process. Nothing is recorded, stored, or transmitted. The only network request the extension makes is the one-time download of the speech model from GitHub.

## Platform Support

| Platform | Status | Engine |
| --- | --- | --- |
| Windows 10/11 | Supported | sherpa-onnx (requires Node.js 22 or later) |
| macOS | Supported | sherpa-onnx (requires Node.js 22 or later) |
| Linux | Supported | sherpa-onnx (requires Node.js 22 or later) |

## Compatibility

| Editor | Install method |
| --- | --- |
| VS Code | Marketplace or `code --install-extension analytics-in-motion.wake-word` |
| Cursor | Open VSX or .vsix from GitHub Releases |
| Windsurf | Open VSX or .vsix from GitHub Releases |
| Other VS Code forks | .vsix from GitHub Releases |

## License

Apache 2.0
