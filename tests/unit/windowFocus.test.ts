import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Editor, EditorWindow, EngineTiming, Microphone, closeAllWindows, openWindow } from "../mocks/editorWindows";
import { lockFilePath, readLock } from "../../src/lockFile";
import { MicrophoneUse, decideFocusLoss, needsListenerLock } from "../../src/wakeWordCore";

/**
 * The focused window listens: with wakeWord.pauseOnFocusLoss on, a window
 * that loses focus pauses and gives the listener lock up once its microphone
 * is closed, and the window that gains focus takes the lock and listens.
 *
 * The rule a window follows when it loses focus is pure logic, checked over
 * every combination of what it can be doing. The rest drives windows of one
 * editor through activate(), each in a module graph of its own, with the real
 * lock module on a storage directory they share and a stand-in engine that
 * opens a microphone they share (tests/mocks/editorWindows.ts). Fake timers
 * stand for the engine's delays: a 1,000 ms model load, 100 ms to open the
 * microphone, and 20 ms to close it. After every step the microphone is
 * checked: no two windows ever have it open at once.
 */

const LISTENING = "$(mic) Wake: Listening";
const STARTING = "$(loading~spin) Wake: Starting";
const UNFOCUSED = "$(circle-slash) Wake: Unfocused";
const OTHER_WINDOW = "$(circle-slash) Wake: Other window";
const OFF = "$(circle-slash) Wake: Off";
const PAUSED = "$(debug-pause) Wake: Paused";

const LOAD_MS = 1_000;
const OPEN_MS = 100;
const CLOSE_MS = 20;
const TIMING: EngineTiming = {
  load: () => LOAD_MS,
  open: () => OPEN_MS,
  pause: () => CLOSE_MS,
  release: () => CLOSE_MS,
};

const TERMINAL = {
  label: "Terminal",
  phrase: "hey computer",
  command: "workbench.action.terminal.focus",
  cooldownSeconds: 30,
};
const CLAUDE = { label: "Claude", phrase: "hey claude", command: "claude-vscode.focus", handoff: "manual" };
const ROUTES = { routes: [TERMINAL, CLAUDE] };

let editor: Editor;
let storage: string;
let pid = 40_000;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Let `ms` of the engine's and the extension's time pass. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

function lockHolder(): number | null {
  const state = readLock(lockFilePath(storage));
  return state.kind === "held" ? state.lock.pid : null;
}

/** Open a window and run Enable in it, as listening on startup does. */
async function window(id: string, focused: boolean, settings: Record<string, unknown> = ROUTES): Promise<EditorWindow> {
  const opened = await openWindow(editor, id, ++pid, { settings, focused });
  await opened.run("wakeWord.enable");
  await settle();
  return opened;
}

/**
 * Two windows with their engines loaded: A listening and focused, B paused
 * for focus with its model loaded, as after the user has used both.
 */
async function twoWarmWindows(settings: Record<string, unknown> = ROUTES): Promise<[EditorWindow, EditorWindow]> {
  const a = await window("A", true, settings);
  const b = await window("B", false, settings);
  await advance(LOAD_MS + OPEN_MS);
  await switchFocus(a, b);
  await switchFocus(b, a);
  expect(a.status()).toBe(LISTENING);
  expect(b.status()).toBe(UNFOCUSED);
  return [a, b];
}

/**
 * Focus moves from one window to the other, in the order the operating
 * system usually reports it, and the engines are given the time they need.
 */
async function switchFocus(from: EditorWindow, to: EditorWindow): Promise<void> {
  from.focus(false);
  to.focus(true);
  await advance(LOAD_MS + OPEN_MS + 500);
}

/** Nothing listens in a window that is not focused, and at most one window has the microphone. */
function expectSettled(...windows: EditorWindow[]): void {
  expect(editor.mic.overlaps).toEqual([]);
  for (const w of windows) {
    if (!w.isFocused()) {
      expect(w.holdsMicrophone(), `${w.id} is not focused`).toBe(false);
      expect(w.engine().isListening, `${w.id} is not focused`).toBe(false);
    }
  }
  expect(editor.mic.holders.size).toBeLessThanOrEqual(1);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "wake-word-focus-"));
  editor = {
    storage,
    mic: new Microphone(),
    live: new Set(),
    timing: TIMING,
    registered: ["workbench.action.terminal.focus", "workbench.action.chat.open", "claude-vscode.focus"],
    installed: [],
    globalState: new Map<string, unknown>([["wakeWord.userConsented", true]]),
  };
});

afterEach(() => {
  closeAllWindows();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(storage, { recursive: true, force: true });
});

// ── the rule ────────────────────────────────────────────────

describe("the rule a window follows when it loses focus", () => {
  const KEYS: Array<keyof MicrophoneUse> = ["calibrating", "handoff", "listening", "restarting", "starting"];

  function every(): Array<{ use: MicrophoneUse; standingBy: boolean }> {
    const all: Array<{ use: MicrophoneUse; standingBy: boolean }> = [];
    for (let mask = 0; mask < 1 << (KEYS.length + 1); mask++) {
      const use = Object.fromEntries(KEYS.map((key, bit) => [key, Boolean(mask & (1 << bit))])) as unknown as MicrophoneUse;
      all.push({ use, standingBy: Boolean(mask & (1 << KEYS.length)) });
    }
    return all;
  }

  it("checks all 64 combinations of what the window can be doing", () => {
    expect(every()).toHaveLength(64);
  });

  it("keeps the lock through a handoff and a calibration run, whatever else is so", () => {
    for (const { use, standingBy } of every()) {
      const action = decideFocusLoss(use, standingBy);
      expect(action === "keep", JSON.stringify({ use, standingBy })).toBe(use.handoff || use.calibrating);
    }
  });

  it("pauses an engine that has the microphone or will open it by itself, and otherwise lets the lock go", () => {
    for (const { use, standingBy } of every()) {
      if (use.handoff || use.calibrating) {
        continue;
      }
      const expected =
        use.listening || use.restarting
          ? "pause"
          : use.starting
            ? "pause-when-started"
            : standingBy
              ? "stand-down"
              : "release";
      expect(decideFocusLoss(use, standingBy), JSON.stringify({ use, standingBy })).toBe(expected);
    }
  });

  it("needs the lock exactly while the engine has or may open the microphone, or a handoff or a run uses it", () => {
    for (const { use } of every()) {
      expect(needsListenerLock(use)).toBe(KEYS.some((key) => use[key]));
    }
  });
});

// ── one window ──────────────────────────────────────────────

describe("one window", () => {
  it("pauses when it loses focus, and releases the lock only once the microphone is closed", async () => {
    const a = await window("A", true);
    await advance(LOAD_MS + OPEN_MS);
    expect(a.status()).toBe(LISTENING);
    expect(lockHolder()).toBe(a.pid);

    a.focus(false);
    expect(a.status()).toBe(UNFOCUSED);
    expect(a.engine().isPaused).toBe(true);
    // The engine is still closing the microphone: the lock stays.
    expect(a.holdsMicrophone()).toBe(true);
    expect(lockHolder()).toBe(a.pid);

    await advance(CLOSE_MS);
    expect(a.holdsMicrophone()).toBe(false);
    expect(lockHolder()).toBeNull();
    expect(a.logs).toContain("[info] Paused: window lost focus");
    expectSettled(a);
  });

  it("takes the lock back and resumes the paused engine when it is focused again, without a new start", async () => {
    const a = await window("A", true);
    await advance(LOAD_MS + OPEN_MS);
    a.focus(false);
    await advance(CLOSE_MS);

    a.focus(true);
    await settle();
    expect(lockHolder()).toBe(a.pid);
    expect(a.status()).toBe(STARTING);
    await advance(OPEN_MS);
    expect(a.status()).toBe(LISTENING);
    expect(a.engine().starts).toHaveLength(1);
    expect(a.engine().resumes).toBe(1);
    expect(a.logs).toContain("[info] Resumed: window regained focus");
  });

  it("does not start the engine in a window that is not focused, and starts it on focus", async () => {
    const b = await window("B", false);
    expect(b.status()).toBe(UNFOCUSED);
    expect(b.engines[0].starts).toHaveLength(0);
    expect(lockHolder()).toBeNull();
    expect(b.logs).toContain(
      "[info] Not listening while this window is not focused: listening starts when it is focused"
    );

    b.focus(true);
    await settle();
    expect(b.status()).toBe(STARTING);
    await advance(LOAD_MS + OPEN_MS);
    expect(b.status()).toBe(LISTENING);
    expect(lockHolder()).toBe(b.pid);
  });

  it("pauses a start the window lost focus during as soon as the engine is listening, keeping the lock until then", async () => {
    const a = await window("A", true);
    await advance(LOAD_MS / 2);
    a.focus(false);
    // A start cannot be paused before the engine listens: it keeps the lock.
    expect(a.status()).toBe(STARTING);
    expect(lockHolder()).toBe(a.pid);

    await advance(LOAD_MS / 2 + OPEN_MS);
    expect(a.engine().isPaused).toBe(true);
    expect(a.status()).toBe(UNFOCUSED);
    expect(a.logs).toContain("[info] Paused: the window lost focus while listening was starting");
    await advance(CLOSE_MS);
    expect(lockHolder()).toBeNull();
    expectSettled(a);
  });

  it("calls off a restart after a crash when the window loses focus, and starts again on focus", async () => {
    const a = await window("A", true);
    await advance(LOAD_MS + OPEN_MS);
    a.engine().crash();
    expect(a.engine().restarting).not.toBeNull();

    a.focus(false);
    expect(a.engine().restarting).toBeNull();
    expect(a.engine().isPaused).toBe(true);
    await settle();
    expect(lockHolder()).toBeNull();
    // The restart would have come after 2 s: nothing opens the microphone.
    await advance(3_000);
    expect(a.holdsMicrophone()).toBe(false);

    a.focus(true);
    await advance(LOAD_MS + OPEN_MS);
    expect(a.status()).toBe(LISTENING);
  });

  it("gives the lock up when the engine fails while the window is not focused", async () => {
    const a = await window("A", true);
    await advance(LOAD_MS / 2);
    a.focus(false);
    // The microphone cannot be opened: an error before the engine listened.
    await advance(LOAD_MS / 2);
    a.engine().error("No microphone found");
    await settle();
    expect(a.status()).toBe("$(error) Wake: Error");
    expect(lockHolder()).toBeNull();
  });

  it("keeps listening when it loses focus with wakeWord.pauseOnFocusLoss off, as before", async () => {
    const a = await window("A", true, { ...ROUTES, pauseOnFocusLoss: false });
    await advance(LOAD_MS + OPEN_MS);
    a.focus(false);
    await advance(1_000);
    expect(a.status()).toBe(LISTENING);
    expect(a.holdsMicrophone()).toBe(true);
    expect(lockHolder()).toBe(a.pid);
  });

  it("starts listening in a window that is not focused with the setting off, as before", async () => {
    const b = await window("B", false, { ...ROUTES, pauseOnFocusLoss: false });
    await advance(LOAD_MS + OPEN_MS);
    expect(b.status()).toBe(LISTENING);
    expect(lockHolder()).toBe(b.pid);
  });

  it("turns listening off from Unfocused on a click, as its tooltip says", async () => {
    const b = await window("B", false);
    expect(b.status()).toBe(UNFOCUSED);
    expect(b.tooltip()).toContain("Click to disable listening");
    await b.run("wakeWord.toggle");
    await settle();
    expect(b.status()).toBe(OFF);
    b.focus(true);
    await advance(LOAD_MS + OPEN_MS);
    expect(b.status()).toBe(OFF);
    expect(b.engine().starts).toHaveLength(0);
  });

  it("goes on waiting for focus with a new engine when the microphone setting changes meanwhile", async () => {
    const a = await window("A", true);
    await advance(LOAD_MS + OPEN_MS);
    a.focus(false);
    await advance(CLOSE_MS);

    a.set("audioDevice", "1");
    a.changeSettings("wakeWord.audioDevice");
    await settle();
    expect(a.engines).toHaveLength(2);
    expect(a.status()).toBe(UNFOCUSED);
    expect(a.engine().starts).toHaveLength(0);

    a.focus(true);
    await advance(LOAD_MS + OPEN_MS);
    expect(a.engine().starts).toHaveLength(1);
    expect(a.status()).toBe(LISTENING);
  });
});

// ── two windows ─────────────────────────────────────────────

describe("two windows of one editor", () => {
  it("listens only in the focused window as focus moves between them", async () => {
    const [a, b] = await twoWarmWindows();
    for (let i = 0; i < 3; i++) {
      await switchFocus(a, b);
      expect(b.status()).toBe(LISTENING);
      expect(a.status()).toBe(UNFOCUSED);
      expect(lockHolder()).toBe(b.pid);
      expectSettled(a, b);
      await switchFocus(b, a);
      expect(a.status()).toBe(LISTENING);
      expect(b.status()).toBe(UNFOCUSED);
      expect(lockHolder()).toBe(a.pid);
      expectSettled(a, b);
    }
    // The second window's engine was started once and resumed since.
    expect(b.engine().starts).toHaveLength(1);
    expect(b.engine().resumes).toBeGreaterThanOrEqual(3);
  });

  // Every order in which the two windows can hear of one change of focus,
  // and the engine's acknowledgement of the pause, which can only follow
  // the window's own loss of focus.
  const ORDERS: Array<Array<"blur" | "focus" | "ack">> = [
    ["blur", "ack", "focus"],
    ["blur", "focus", "ack"],
    ["focus", "blur", "ack"],
  ];

  it.each(ORDERS)("hands the microphone over when the events arrive as %s, %s, %s", async (...order) => {
    const [a, b] = await twoWarmWindows();
    const seen = new Set<string>();
    for (const step of order) {
      if (step === "blur") {
        a.focus(false);
      } else if (step === "focus") {
        b.focus(true);
      } else {
        await advance(CLOSE_MS);
      }
      await settle();
      seen.add(b.status());
      expect(editor.mic.overlaps).toEqual([]);
    }
    await advance(500);
    expect(b.status()).toBe(LISTENING);
    expect(a.status()).toBe(UNFOCUSED);
    expect(lockHolder()).toBe(b.pid);
    // The focused window waits for the other one's lock while it has not
    // been released, and shows that it does.
    if (order.indexOf("focus") < order.indexOf("ack")) {
      expect(seen.has(OTHER_WINDOW)).toBe(true);
    }
    expectSettled(a, b);
  });

  it("waits for a pause the engine does not acknowledge, until its 500 ms timeout has killed the child", async () => {
    editor.timing = { ...TIMING, pause: () => 10_000 };
    const [a, b] = await twoWarmWindows();
    b.focus(true);
    a.focus(false);
    await advance(400);
    expect(a.holdsMicrophone()).toBe(true);
    expect(b.status()).toBe(OTHER_WINDOW);
    expect(b.tooltip()).toContain("This window listens as soon as that one releases it");
    await advance(100);
    expect(a.holdsMicrophone()).toBe(false);
    await advance(LOAD_MS + OPEN_MS);
    expect(b.status()).toBe(LISTENING);
    expectSettled(a, b);
  });

  it("ends with nothing listening after focus moves quickly there and back", async () => {
    const [a, b] = await twoWarmWindows();
    a.focus(false);
    b.focus(true);
    b.focus(false);
    a.focus(true);
    await advance(CLOSE_MS);
    b.focus(true);
    a.focus(false);
    a.focus(true);
    b.focus(false);
    await advance(1_000);
    expect(a.status()).toBe(LISTENING);
    expect(b.status()).toBe(UNFOCUSED);
    expectSettled(a, b);
  });

  it("listens in neither window while another application has focus", async () => {
    const [a, b] = await twoWarmWindows();
    a.focus(false);
    await advance(1_000);
    expect(a.status()).toBe(UNFOCUSED);
    expect(b.status()).toBe(UNFOCUSED);
    expect(editor.mic.holders.size).toBe(0);
    expect(lockHolder()).toBeNull();

    b.focus(true);
    await advance(OPEN_MS);
    expect(b.status()).toBe(LISTENING);
    expectSettled(a, b);
  });

  it("hands over when the window with the lock closes, whichever of the two the editor tells first", async () => {
    for (const closeFirst of [true, false]) {
      const [a, b] = await twoWarmWindows();
      if (closeFirst) {
        a.close();
        b.focus(true);
      } else {
        b.focus(true);
        await advance(300);
        expect(b.status()).toBe(OTHER_WINDOW);
        a.close();
      }
      await advance(1_000);
      expect(b.status()).toBe(LISTENING);
      expect(lockHolder()).toBe(b.pid);
      expectSettled(b);
      closeAllWindows();
      editor.mic = new Microphone();
    }
  });

  it("takes over the lock of a window whose extension host crashed while it held it", async () => {
    const [a, b] = await twoWarmWindows();
    await a.crash();
    // The crashed window's lock is still there, naming a process that is gone.
    expect(lockHolder()).toBe(a.pid);
    b.focus(true);
    await advance(1_000);
    expect(b.status()).toBe(LISTENING);
    expect(lockHolder()).toBe(b.pid);
    expectSettled(b);
  });

  it("opens no microphone in the other window during a cooldown, and hands over when it ends", async () => {
    const [a, b] = await twoWarmWindows();
    expect(a.hear("Terminal")).toBe(true);
    await advance(CLOSE_MS);
    expect(a.status()).toBe("$(clock) Wake: 30s");
    expect(a.executed).toContain("workbench.action.terminal.focus");

    a.focus(false);
    b.focus(true);
    await advance(5_000);
    // The handoff keeps the lock: the focused window waits.
    expect(lockHolder()).toBe(a.pid);
    expect(b.status()).toBe(OTHER_WINDOW);
    expect(b.holdsMicrophone()).toBe(false);
    expect(a.status()).toBe("$(clock) Wake: 25s");

    // The cooldown ends in a window that is not focused: it waits for focus,
    // without starting to resume first, and the focused window listens.
    await advance(25_000);
    expect(a.logs).toContain("[info] Cooldown expired");
    expect(a.logs).toContain(
      "[info] Not resuming while this window is not focused: listening resumes when it is focused"
    );
    expect(a.engine().resumes).toBe(1);
    expect(a.status()).toBe(UNFOCUSED);
    expect(a.holdsMicrophone()).toBe(false);
    await advance(1_000 + OPEN_MS);
    expect(b.status()).toBe(LISTENING);
    expectSettled(a, b);
  });

  it("opens no microphone in the other window during a manual handoff, whatever focus does", async () => {
    const [a, b] = await twoWarmWindows();
    expect(a.hear("Claude")).toBe(true);
    await advance(CLOSE_MS);
    expect(a.status()).toBe(PAUSED);

    for (let i = 0; i < 3; i++) {
      a.focus(false);
      b.focus(true);
      await advance(5_000);
      expect(b.status()).toBe(OTHER_WINDOW);
      expect(b.holdsMicrophone()).toBe(false);
      b.focus(false);
      a.focus(true);
      await advance(5_000);
      // Focus does not end a manual handoff.
      expect(a.status()).toBe(PAUSED);
      expect(a.holdsMicrophone()).toBe(false);
    }
    expect(lockHolder()).toBe(a.pid);

    // The user resumes in the window that handed over, then moves on.
    await a.run("wakeWord.toggle");
    await advance(OPEN_MS);
    expect(a.status()).toBe(LISTENING);
    await switchFocus(a, b);
    expect(b.status()).toBe(LISTENING);
    expectSettled(a, b);
  });

  it("hands over when a window in a manual handoff closes", async () => {
    const [a, b] = await twoWarmWindows();
    a.hear("Claude");
    await advance(CLOSE_MS);
    a.focus(false);
    b.focus(true);
    await advance(5_000);
    expect(b.status()).toBe(OTHER_WINDOW);
    a.close();
    await advance(1_000 + OPEN_MS);
    expect(b.status()).toBe(LISTENING);
    expectSettled(b);
  });

  it("lets the focused window listen when a window whose engine failed loses focus", async () => {
    // The engine fails before it has listened, in the focused window: it
    // keeps the lock while it is focused, and gives it up when it is not.
    const a = await window("A", true);
    const b = await window("B", false);
    await advance(LOAD_MS / 2);
    a.engine().error("No microphone found");
    await settle();
    expect(a.status()).toBe("$(error) Wake: Error");
    expect(lockHolder()).toBe(a.pid);

    a.focus(false);
    b.focus(true);
    await advance(500 + LOAD_MS + OPEN_MS);
    expect(b.status()).toBe(LISTENING);
    expect(a.status()).toBe("$(error) Wake: Error");
    expectSettled(a, b);
  });

  it("lets the focused window listen when a window whose resume turned into a restart loses focus", async () => {
    // The cooldown ends and the window resumes; its engine's child dies while
    // it reopens the microphone, and a restart is waiting to begin when the
    // window loses focus. The pause calls the restart off, so the resume it
    // was finishing is over, and the lock goes.
    const [a, b] = await twoWarmWindows();
    a.hear("Terminal");
    await advance(CLOSE_MS);
    await advance(30_000);
    expect(a.status()).toBe(STARTING);
    a.engine().crash();
    expect(a.engine().restarting).not.toBeNull();

    a.focus(false);
    b.focus(true);
    await advance(500 + OPEN_MS);
    expect(a.status()).toBe(UNFOCUSED);
    expect(b.status()).toBe(LISTENING);
    expect(lockHolder()).toBe(b.pid);
    expectSettled(a, b);

    // Focused again, the window starts a new child and listens.
    await switchFocus(b, a);
    expect(a.status()).toBe(LISTENING);
    expectSettled(a, b);
  });

  it("turns listening off in the waiting window on a click on Other window, as its tooltip says", async () => {
    const [a, b] = await twoWarmWindows();
    a.hear("Claude");
    await advance(CLOSE_MS);
    a.focus(false);
    b.focus(true);
    await advance(5_000);
    expect(b.tooltip()).toContain("Click to disable listening in this window");
    await b.run("wakeWord.toggle");
    await settle();
    expect(b.status()).toBe(OFF);
    a.close();
    await advance(5_000);
    expect(b.status()).toBe(OFF);
  });

  it("behaves as before with the setting off: the first window keeps the microphone until it stops", async () => {
    const settings = { ...ROUTES, pauseOnFocusLoss: false };
    const a = await window("A", true, settings);
    const b = await window("B", false, settings);
    await advance(LOAD_MS + OPEN_MS);
    expect(a.status()).toBe(LISTENING);
    expect(b.status()).toBe(OTHER_WINDOW);
    expect(b.tooltip()).toBe(
      "Another editor window is already listening. Only one instance listens at a time. " +
        "This window takes over automatically when that one stops."
    );
    expect(b.logs).toContain("[info] Another editor window is listening. This window will take over if it stops.");

    a.focus(false);
    b.focus(true);
    await advance(30_000);
    expect(a.status()).toBe(LISTENING);
    expect(b.status()).toBe(OTHER_WINDOW);

    // Disabled in the first window: the second takes over at its next
    // ten-second check, counted from when it began to stand by.
    await a.run("wakeWord.disable");
    await advance(10_000 + LOAD_MS + OPEN_MS);
    expect(b.status()).toBe(LISTENING);
    expect(b.logs).toContain("[info] The listening window has stopped. Taking over.");
    expect(editor.mic.overlaps).toEqual([]);
  });

  it("follows focus from the moment the setting is turned on, while a window listens without focus", async () => {
    const settings = { ...ROUTES, pauseOnFocusLoss: false };
    const a = await window("A", true, settings);
    const b = await window("B", false, settings);
    await advance(LOAD_MS + OPEN_MS);
    a.focus(false);
    b.focus(true);
    await advance(1_000);
    expect(a.status()).toBe(LISTENING);
    expect(b.status()).toBe(OTHER_WINDOW);

    for (const w of [a, b]) {
      w.set("pauseOnFocusLoss", true);
      w.changeSettings("wakeWord.pauseOnFocusLoss");
    }
    await advance(CLOSE_MS);
    expect(a.status()).toBe(UNFOCUSED);
    expect(a.holdsMicrophone()).toBe(false);
    // The focused window now checks the lock at the handover's pace.
    await advance(100 + LOAD_MS + OPEN_MS);
    expect(b.status()).toBe(LISTENING);
    expectSettled(a, b);
  });

  it("goes on waiting for focus in a window paused for it when the setting is turned off, as before", async () => {
    const [a, b] = await twoWarmWindows();
    for (const w of [a, b]) {
      w.set("pauseOnFocusLoss", false);
      w.changeSettings("wakeWord.pauseOnFocusLoss");
    }
    await advance(1_000);
    expect(b.status()).toBe(UNFOCUSED);
    expect(a.status()).toBe(LISTENING);

    // Focus ends the pause. The first window still has the lock, and with
    // the setting off it keeps it, so the second stands by.
    a.focus(false);
    b.focus(true);
    await advance(1_000);
    expect(a.status()).toBe(LISTENING);
    expect(b.status()).toBe(OTHER_WINDOW);
    expect(editor.mic.overlaps).toEqual([]);
  });

  it("does not resume in a window whose consent was reset in another window", async () => {
    const [a, b] = await twoWarmWindows();
    await a.run("wakeWord.resetConsent");
    await settle();
    expect(a.status()).toBe(OFF);

    a.focus(false);
    b.focus(true);
    await advance(1_000);
    expect(b.status()).toBe(OFF);
    expect(b.holdsMicrophone()).toBe(false);
    expect(b.logs).toContain(
      "[info] Listening is off: microphone consent was reset. Enable listening to be asked again."
    );
    expect(editor.mic.overlaps).toEqual([]);
  });
});
