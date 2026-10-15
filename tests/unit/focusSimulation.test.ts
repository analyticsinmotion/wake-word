import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Editor, EditorWindow, Microphone, closeAllWindows, openWindow } from "../mocks/editorWindows";
import { lockFilePath, readLock } from "../../src/lockFile";

/**
 * Windows of one editor, driven at random: focus moving between them and to
 * other applications, wake phrases, manual resumes, Enable and Disable, the
 * engine crashing or failing, windows closing, crashing, and opening, and
 * the setting changing, each after a random delay, with the engine's model
 * load, device opening, and acknowledgements taking random times too.
 *
 * Each window hears of a change of focus after a delay of its own, so the
 * window losing focus and the window gaining it hear of it in either order,
 * as the extension hosts of two editor windows do. Each window's own events
 * arrive in the order they happened, as one window's do.
 *
 * Every run uses the real lock module on a storage directory of its own, and
 * checks, after every step, that no two windows have the microphone open at
 * once. In the runs where every window follows focus, it also checks, once
 * the run has settled, that no window that is not focused has the
 * microphone, and that the focused window listens unless it was turned off,
 * failed, or is itself in a manual handoff, or the lock belongs to a window
 * whose manual handoff is still waiting for the user.
 *
 * WAKE_WORD_FOCUS_RUNS sets the number of runs of each kind (default 40) and
 * WAKE_WORD_FOCUS_SEED the first seed, so a failing run can be repeated on
 * its own. A failure names the seed and the steps.
 */

const RUNS = Number(process.env.WAKE_WORD_FOCUS_RUNS ?? 40);
const FIRST_SEED = Number(process.env.WAKE_WORD_FOCUS_SEED ?? 1);
const STEPS = 60;

const TERMINAL = {
  label: "Terminal",
  phrase: "hey computer",
  command: "workbench.action.terminal.focus",
  cooldownSeconds: 5,
};
const CLAUDE = { label: "Claude", phrase: "hey claude", command: "claude-vscode.focus", handoff: "manual" };

const LISTENING = "$(mic) Wake: Listening";
const OFF = "$(circle-slash) Wake: Off";
const PAUSED = "$(debug-pause) Wake: Paused";
const ERROR = "$(error) Wake: Error";

/** mulberry32: a small seeded generator, so a run can be repeated. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface Run {
  seed: number;
  random: () => number;
  editor: Editor;
  windows: EditorWindow[];
  /** The window the operating system has focused, or null for another application. */
  focused: EditorWindow | null;
  /** When each window's latest focus event arrives, so its next one comes after it. */
  delivery: Map<EditorWindow, number>;
  now: number;
  steps: string[];
  nextPid: number;
  /** Every window follows focus, so the checks of a settled editor apply. */
  followsFocus: boolean;
}

/** What the settled editor of a run that follows focus came to. */
type Ending = "listening" | "waiting for a handoff" | "focused window off" | "no window focused";

function pick<T>(run: Run, items: readonly T[]): T {
  return items[Math.floor(run.random() * items.length)];
}

function between(run: Run, low: number, high: number): number {
  return Math.floor(low + run.random() * (high - low));
}

function open(run: Run): EditorWindow[] {
  return run.windows.filter((w) => w.isOpen());
}

/** The editor tells a window of a change of focus, after a delay of that window's own. */
function deliverFocus(run: Run, w: EditorWindow, focused: boolean): void {
  const at = Math.max(run.now + between(run, 0, 60), run.delivery.get(w) ?? 0);
  run.delivery.set(w, at);
  setTimeout(() => w.focus(focused), at - run.now);
}

/** The operating system moves focus to a window, or away from the editor when `to` is null. */
function moveFocus(run: Run, to: EditorWindow | null): void {
  if (run.focused === to) {
    return;
  }
  if (run.focused && run.focused.isOpen()) {
    deliverFocus(run, run.focused, false);
  }
  run.focused = to;
  if (to) {
    deliverFocus(run, to, true);
  }
}

async function newWindow(run: Run, focused: boolean): Promise<EditorWindow> {
  const settings: Record<string, unknown> = { routes: [TERMINAL, CLAUDE] };
  if (!run.followsFocus && run.random() < 0.5) {
    settings.pauseOnFocusLoss = false;
  }
  const pid = run.nextPid++;
  const w = await openWindow(run.editor, `W${pid}`, pid, { settings, focused });
  run.windows.push(w);
  run.delivery.set(w, run.now);
  await w.run("wakeWord.enable");
  return w;
}

async function step(run: Run): Promise<void> {
  const windows = open(run);
  const roll = run.random();
  if (roll < 0.34) {
    const to = run.random() < 0.2 ? null : pick(run, windows);
    run.steps.push(`focus ${to ? to.id : "another application"}`);
    moveFocus(run, to);
  } else if (roll < 0.5) {
    run.steps.push('say "hey computer"');
    windows.forEach((w) => w.hear("Terminal"));
  } else if (roll < 0.6) {
    run.steps.push('say "hey claude"');
    windows.forEach((w) => w.hear("Claude"));
  } else if (roll < 0.7) {
    // The user resumes after a manual handoff, in the window they are in.
    const w = run.focused;
    if (w && w.isOpen() && w.status() === PAUSED) {
      run.steps.push(`resume in ${w.id}`);
      void w.run("wakeWord.toggle");
    }
  } else if (roll < 0.75) {
    const w = run.focused && run.focused.isOpen() && run.random() < 0.7 ? run.focused : pick(run, windows);
    run.steps.push(`toggle in ${w.id}`);
    void w.run("wakeWord.toggle");
  } else if (roll < 0.78) {
    // A command run in any window, as another extension can run it.
    const w = pick(run, windows);
    const command = run.random() < 0.5 ? "wakeWord.disable" : "wakeWord.enable";
    run.steps.push(`${command} in ${w.id}`);
    void w.run(command);
  } else if (roll < 0.81) {
    const w = pick(run, windows);
    run.steps.push(`engine crash in ${w.id}`);
    w.engine().crash();
  } else if (roll < 0.83) {
    const w = pick(run, windows);
    run.steps.push(`engine error in ${w.id}`);
    w.engine().error("The microphone stopped responding");
  } else if (roll < 0.87) {
    if (windows.length > 1 && run.random() < 0.5) {
      const w = pick(run, windows);
      run.steps.push(`close ${w.id}`);
      if (run.focused === w) {
        const others = windows.filter((other) => other !== w);
        moveFocus(run, run.random() < 0.7 ? pick(run, others) : null);
      }
      w.close();
    } else if (windows.length < 3) {
      const focus = run.random() < 0.5;
      const w = await newWindow(run, false);
      run.steps.push(`open ${w.id}${focus ? " and focus it" : ""}`);
      if (focus) {
        moveFocus(run, w);
      }
    }
  } else if (roll < 0.89) {
    if (windows.length > 1) {
      const w = pick(run, windows);
      run.steps.push(`extension host of ${w.id} crashes`);
      if (run.focused === w) {
        moveFocus(run, pick(run, windows.filter((other) => other !== w)));
      }
      await w.crash();
    }
  } else if (roll < 0.91 && !run.followsFocus) {
    const on = run.random() < 0.5;
    run.steps.push(`pauseOnFocusLoss ${on ? "on" : "off"} in every window`);
    for (const w of windows) {
      w.set("pauseOnFocusLoss", on);
      w.changeSettings("wakeWord.pauseOnFocusLoss");
    }
  } else {
    run.steps.push("wait");
  }
}

/** Let `ms` pass, in the order the timers fall due. */
async function pass(run: Run, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  run.now += ms;
  await settle();
}

function describeRun(run: Run): string {
  const states = open(run)
    .map((w) => `${w.id}${w === run.focused ? " (focused)" : ""}: ${w.status()}`)
    .join("; ");
  return `seed ${run.seed}: ${states}\nsteps: ${run.steps.join(" | ")}`;
}

function lockHolder(run: Run): number | null {
  const state = readLock(lockFilePath(run.editor.storage));
  return state.kind === "held" ? state.lock.pid : null;
}

/**
 * The checks of a settled editor whose windows all follow focus. Returns how
 * the run ended, so the test can tell that the endings it checks happen.
 */
function checkSettled(run: Run): Ending {
  const windows = open(run);
  for (const w of windows) {
    if (w !== run.focused) {
      expect(w.holdsMicrophone(), `${w.id} is not focused\n${describeRun(run)}`).toBe(false);
    }
  }
  const focused = run.focused && run.focused.isOpen() ? run.focused : null;
  if (!focused) {
    expect(run.editor.mic.holders.size, describeRun(run)).toBe(0);
    return "no window focused";
  }
  const status = focused.status();
  if (status === OFF || status === ERROR || status === PAUSED) {
    return "focused window off";
  }
  const holder = lockHolder(run);
  if (windows.some((w) => w !== focused && w.pid === holder && w.status() === PAUSED)) {
    expect(focused.holdsMicrophone(), describeRun(run)).toBe(false);
    return "waiting for a handoff";
  }
  expect(status, describeRun(run)).toBe(LISTENING);
  expect(holder, describeRun(run)).toBe(focused.pid);
  return "listening";
}

/** One run: open two or three windows, take STEPS random steps, let it settle, and check it. */
async function simulate(seed: number, followsFocus: boolean): Promise<Ending | null> {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "wake-word-sim-"));
  const run: Run = {
    seed,
    random: generator(seed),
    editor: {
      storage,
      mic: new Microphone(() => run.now),
      live: new Set(),
      timing: {
        load: () => between(run, 200, 2_000),
        open: () => between(run, 20, 400),
        // Now and then an acknowledgement does not come, and the engine's
        // 500 ms timeout kills the child.
        pause: () => (run.random() < 0.05 ? 600 : between(run, 1, 120)),
        release: () => (run.random() < 0.05 ? 600 : between(run, 1, 120)),
      },
      registered: ["workbench.action.terminal.focus", "claude-vscode.focus"],
      installed: [],
      globalState: new Map<string, unknown>([["wakeWord.userConsented", true]]),
    },
    windows: [],
    focused: null,
    delivery: new Map(),
    now: 0,
    steps: [],
    nextPid: 61_000 + seed * 10,
    followsFocus,
  };
  try {
    const count = run.random() < 0.5 ? 2 : 3;
    for (let i = 0; i < count; i++) {
      await newWindow(run, i === 0);
    }
    run.focused = run.windows[0];
    for (let i = 0; i < STEPS; i++) {
      await step(run);
      await pass(run, pick(run, [1, 5, 20, 60, 150, 400, 1_000, 3_000]));
      expect(run.editor.mic.overlaps, describeRun(run)).toEqual([]);
    }
    // Let every start, restart, cooldown, and handover finish.
    for (let i = 0; i < 40; i++) {
      await pass(run, 1_000);
    }
    expect(run.editor.mic.overlaps, describeRun(run)).toEqual([]);
    return followsFocus ? checkSettled(run) : null;
  } finally {
    closeAllWindows();
    vi.clearAllTimers();
    fs.rmSync(storage, { recursive: true, force: true });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("windows of one editor driven at random", () => {
  it(`never let two windows have the microphone, and listen only in the focused window (${RUNS} runs)`, async () => {
    const endings = new Map<Ending, number>();
    for (let i = 0; i < RUNS; i++) {
      const ending = (await simulate(FIRST_SEED + i, true)) as Ending;
      endings.set(ending, (endings.get(ending) ?? 0) + 1);
    }
    // Most runs end with the focused window listening, which is the ending
    // whose check says the most.
    expect(endings.get("listening") ?? 0).toBeGreaterThan(RUNS / 4);
  }, 600_000);

  it(`never let two windows have the microphone with the setting mixed and changing (${RUNS} runs)`, async () => {
    for (let i = 0; i < RUNS; i++) {
      await simulate(FIRST_SEED + 100_000 + i, false);
    }
  }, 600_000);
});
