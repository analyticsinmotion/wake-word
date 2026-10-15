import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In-memory stand-in for the handful of fs calls the lock module makes.
 *
 * It honours the `wx` (exclusive create) flag, which is what makes lock
 * acquisition atomic between two windows, so the race path can be driven
 * deterministically rather than hoped for. Each file keeps the time it was
 * written, from `clock`, which statSync() reports.
 */
const fsMock = vi.hoisted(() => {
  const files = new Map<string, string>();
  const modified = new Map<string, number>();
  const dirs = new Set<string>();
  const clock = { now: 0 };
  const errno = (code: string, p: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: ${p}`), { code });

  return {
    files,
    modified,
    dirs,
    clock,
    reset(): void {
      files.clear();
      modified.clear();
      dirs.clear();
      clock.now = Date.parse("2026-09-05T10:30:00.000Z");
    },
    readFileSync: vi.fn((p: string): string => {
      const content = files.get(p);
      if (content === undefined) {
        throw errno("ENOENT", p);
      }
      return content;
    }),
    writeFileSync: vi.fn((p: string, data: string, opts?: { flag?: string }): void => {
      if (opts?.flag === "wx" && files.has(p)) {
        throw errno("EEXIST", p);
      }
      files.set(p, String(data));
      modified.set(p, clock.now);
    }),
    unlinkSync: vi.fn((p: string): void => {
      if (!files.delete(p)) {
        throw errno("ENOENT", p);
      }
      modified.delete(p);
    }),
    mkdirSync: vi.fn((p: string): void => {
      dirs.add(p);
    }),
    statSync: vi.fn((p: string): { mtimeMs: number } => {
      const mtimeMs = modified.get(p);
      if (mtimeMs === undefined) {
        throw errno("ENOENT", p);
      }
      return { mtimeMs };
    }),
  };
});

vi.mock("fs", () => ({
  readFileSync: fsMock.readFileSync,
  writeFileSync: fsMock.writeFileSync,
  unlinkSync: fsMock.unlinkSync,
  mkdirSync: fsMock.mkdirSync,
  statSync: fsMock.statSync,
}));

import * as path from "path";
import {
  LOCK_CHECK_INTERVAL_MS,
  LOCK_FILE_NAME,
  LOCK_FOCUSED_CHECK_INTERVAL_MS,
  LOCK_HANDOVER_INTERVAL_MS,
  LOCK_HANDOVER_MS,
  LOCK_WRITE_GRACE_MS,
  TAKEOVER_SUFFIX,
  isProcessAlive,
  lockCheckDelay,
  lockFilePath,
  readLock,
  releaseLock,
  tryAcquireLock,
} from "../../src/lockFile";

const STORAGE = path.join("/", "storage", "wake-word");
const LOCK = path.join(STORAGE, LOCK_FILE_NAME);
const TAKEOVER = `${LOCK}${TAKEOVER_SUFFIX}`;

/** A PID that no operating system will have handed out. */
const DEAD_PID = 2_147_483_647;
const OTHER_PID = 4242;

const alive = () => true;
const dead = () => false;
/** The mock filesystem's clock, for tests that look at a file's age. */
const now = () => new Date(fsMock.clock.now);

/**
 * Put a lock file in place, written `ageMs` before the mock clock's now: a
 * minute ago unless a test says otherwise, which is long past the time a
 * window takes to write one.
 */
function plant(lock: unknown, ageMs = 60_000, file = LOCK): void {
  fsMock.files.set(file, typeof lock === "string" ? lock : JSON.stringify(lock));
  fsMock.modified.set(file, fsMock.clock.now - ageMs);
}

function stored(): { pid: number; startedAt: string } {
  return JSON.parse(fsMock.files.get(LOCK) ?? "null");
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => {
  fsMock.reset();
  fsMock.readFileSync.mockClear();
  fsMock.writeFileSync.mockClear();
  fsMock.unlinkSync.mockClear();
  fsMock.mkdirSync.mockClear();
  fsMock.statSync.mockClear();
});

describe("lockFilePath", () => {
  it("places the lock inside the storage directory", () => {
    expect(lockFilePath(STORAGE)).toBe(LOCK);
    expect(path.basename(lockFilePath(STORAGE))).toBe("wake-word.lock");
  });
});

describe("LOCK_CHECK_INTERVAL_MS", () => {
  it("polls a standing-by window every ten seconds", () => {
    expect(LOCK_CHECK_INTERVAL_MS).toBe(10_000);
  });
});

describe("lockCheckDelay", () => {
  it("checks every ten seconds whatever the wait, when listening does not follow focus", () => {
    for (const waited of [0, 100, 2_000, 60_000]) {
      expect(lockCheckDelay(waited, false)).toBe(LOCK_CHECK_INTERVAL_MS);
    }
  });

  it("checks every 100 ms for the first two seconds of a handover, then once a second", () => {
    expect(LOCK_HANDOVER_INTERVAL_MS).toBe(100);
    expect(LOCK_HANDOVER_MS).toBe(2_000);
    expect(LOCK_FOCUSED_CHECK_INTERVAL_MS).toBe(1_000);
    expect(lockCheckDelay(0, true)).toBe(100);
    expect(lockCheckDelay(1_900, true)).toBe(100);
    expect(lockCheckDelay(2_000, true)).toBe(1_000);
    expect(lockCheckDelay(600_000, true)).toBe(1_000);
  });

  it("makes twenty quick checks and then slows down, counting the wait from its own delays", () => {
    const delays: number[] = [];
    let waited = 0;
    for (let i = 0; i < 25; i++) {
      const delay = lockCheckDelay(waited, true);
      delays.push(delay);
      waited += delay;
    }
    expect(delays.filter((d) => d === 100)).toHaveLength(20);
    expect(delays.slice(20)).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
  });
});

describe("isProcessAlive", () => {
  it("is true for this process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("is false for a PID that does not exist", () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });

  it("rejects process-group and malformed PIDs rather than probing them", () => {
    // kill(0, 0) and kill(-1, 0) address groups and succeed, which would read
    // as a live lock holder that can never die.
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(NaN)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });

  it("treats a process it is not allowed to signal as alive", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    try {
      expect(isProcessAlive(OTHER_PID)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("treats a process that is gone as dead", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    try {
      expect(isProcessAlive(OTHER_PID)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("readLock", () => {
  it("reports an absent file", () => {
    expect(readLock(LOCK)).toEqual({ kind: "absent" });
  });

  it("reads a well-formed lock", () => {
    plant({ pid: OTHER_PID, startedAt: "2026-09-05T10:30:00.000Z" });
    expect(readLock(LOCK)).toEqual({
      kind: "held",
      lock: { pid: OTHER_PID, startedAt: "2026-09-05T10:30:00.000Z" },
    });
  });

  it("tolerates a missing startedAt", () => {
    plant({ pid: OTHER_PID });
    expect(readLock(LOCK)).toEqual({ kind: "held", lock: { pid: OTHER_PID, startedAt: "" } });
  });

  it("reports malformed JSON as corrupt", () => {
    plant("{ not json");
    expect(readLock(LOCK)).toEqual({ kind: "corrupt" });
  });

  it("reports a lock without a usable pid as corrupt", () => {
    for (const bad of [{}, { pid: "12" }, { pid: 0 }, { pid: -3 }, { pid: 1.5 }, null, 7, "str"]) {
      plant(bad);
      expect(readLock(LOCK), JSON.stringify(bad)).toEqual({ kind: "corrupt" });
    }
  });

  it("reports an unreadable file as corrupt rather than absent", () => {
    plant({ pid: OTHER_PID });
    fsMock.readFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    expect(readLock(LOCK)).toEqual({ kind: "corrupt" });
  });
});

describe("tryAcquireLock", () => {
  it("succeeds when no lock exists and writes this process's pid", () => {
    const now = () => new Date("2026-09-05T10:30:00.000Z");
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive, now })).toBe(true);
    expect(stored()).toEqual({ pid: 100, startedAt: "2026-09-05T10:30:00.000Z" });
  });

  it("creates the storage directory first", () => {
    tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive });
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(STORAGE, { recursive: true });
  });

  it("creates the file exclusively", () => {
    tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive });
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      LOCK,
      expect.any(String),
      expect.objectContaining({ flag: "wx" })
    );
  });

  it("defaults to the real process pid", () => {
    expect(tryAcquireLock(LOCK)).toBe(true);
    expect(stored().pid).toBe(process.pid);
  });

  it("fails when another running process holds the lock", () => {
    plant({ pid: OTHER_PID, startedAt: "earlier" });
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive })).toBe(false);
    // The holder's lock is left exactly as it was.
    expect(stored()).toEqual({ pid: OTHER_PID, startedAt: "earlier" });
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it("probes the holder's pid, not its own", () => {
    plant({ pid: OTHER_PID });
    const isAlive = vi.fn(() => true);
    tryAcquireLock(LOCK, { ownPid: 100, isAlive });
    expect(isAlive).toHaveBeenCalledWith(OTHER_PID);
  });

  it("takes over a stale lock left by a dead process", () => {
    plant({ pid: DEAD_PID, startedAt: "long ago" });
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: dead })).toBe(true);
    expect(stored().pid).toBe(100);
  });

  it("uses the real liveness probe against a stale lock by default", () => {
    plant({ pid: DEAD_PID });
    expect(tryAcquireLock(LOCK, { ownPid: 100 })).toBe(true);
    expect(stored().pid).toBe(100);
  });

  it("takes over a lock that is not valid JSON", () => {
    plant("{ definitely not json");
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive })).toBe(true);
    expect(stored().pid).toBe(100);
  });

  it("takes over a lock that names no usable pid", () => {
    plant({ startedAt: "2026-09-05T10:30:00.000Z" });
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive })).toBe(true);
    expect(stored().pid).toBe(100);
  });

  it("succeeds without rewriting when the lock is already ours", () => {
    // Listening resumes after every cooldown and start() runs again; the
    // original startedAt must survive that.
    plant({ pid: 100, startedAt: "original" });
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: dead })).toBe(true);
    expect(stored()).toEqual({ pid: 100, startedAt: "original" });
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it("yields to the window that wins a simultaneous create", () => {
    // Both windows read "absent". The other one's exclusive create lands
    // first, so ours fails with EEXIST and we must read again and defer.
    fsMock.writeFileSync.mockImplementationOnce(() => {
      plant({ pid: OTHER_PID, startedAt: "won" });
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    });
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive })).toBe(false);
    expect(stored()).toEqual({ pid: OTHER_PID, startedAt: "won" });
  });

  it("takes over when the race winner has already died", () => {
    fsMock.writeFileSync.mockImplementationOnce(() => {
      plant({ pid: DEAD_PID });
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    });
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: dead })).toBe(true);
    expect(stored().pid).toBe(100);
  });

  it("gives up after losing the create twice", () => {
    // Pathological: the file keeps reappearing under a pid that reads as
    // dead. Two passes and out, so the caller is never spun forever.
    const lose = (): never => {
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    };
    fsMock.writeFileSync.mockImplementationOnce(lose).mockImplementationOnce(lose);
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: dead })).toBe(false);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it("propagates a write failure when the storage directory cannot be written at all", () => {
    // An unwritable storage directory is the caller's decision: the
    // extension logs it and listens without coordination.
    const refuse = (): never => {
      throw errno("EACCES");
    };
    // The lock, and then the file the lock module writes beside it to tell
    // an unwritable directory from a passing refusal.
    fsMock.writeFileSync.mockImplementationOnce(refuse).mockImplementationOnce(refuse);
    expect(() => tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive })).toThrow(/EACCES/);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(2);
    expect(fsMock.files.size).toBe(0);
  });

  it("does not take the lock this time when Windows refuses the create for a moment", () => {
    // EPERM while another process is still deleting the previous lock file.
    // The directory itself can be written, so this is no reason to listen
    // without coordination: the next check takes the lock.
    fsMock.writeFileSync.mockImplementationOnce(() => {
      throw errno("EPERM");
    });
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive })).toBe(false);
    expect(fsMock.files.size).toBe(0);
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive })).toBe(true);
    expect(stored().pid).toBe(100);
  });

  it("removes the file it writes to check the directory", () => {
    fsMock.writeFileSync.mockImplementationOnce(() => {
      throw errno("EBUSY");
    });
    tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive });
    const probe = fsMock.writeFileSync.mock.calls[1][0];
    expect(probe).toBe(`${LOCK}.100.probe`);
    expect(fsMock.files.has(probe)).toBe(false);
  });

  it("copes with the stale lock vanishing before it can be removed", () => {
    plant({ pid: DEAD_PID });
    // Another window removed the stale file between our read and our unlink.
    fsMock.unlinkSync.mockImplementationOnce((p: string) => {
      fsMock.files.delete(p);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: dead })).toBe(true);
    expect(stored().pid).toBe(100);
  });
});

/**
 * The races tryAcquireLock() closes, each of which would let two windows
 * believe they hold the lock at once, driven one step at a time.
 */
describe("tryAcquireLock under contention", () => {
  it("leaves an empty lock a moment after another window created it, before its write", () => {
    // The exclusive create makes the file, and the write fills it a moment
    // later. Taken over as corrupt, the new lock would be deleted under its
    // owner.
    plant("", 0);
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive, now })).toBe(false);
    expect(fsMock.files.get(LOCK)).toBe("");
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it("leaves a corrupt lock written less than LOCK_WRITE_GRACE_MS ago, and takes it over after that", () => {
    expect(LOCK_WRITE_GRACE_MS).toBe(1_000);
    plant("{ half a lock", LOCK_WRITE_GRACE_MS - 1);
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive, now })).toBe(false);
    fsMock.clock.now += 1;
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive, now })).toBe(true);
    expect(stored().pid).toBe(100);
  });

  it("takes over a corrupt lock dated in the future, as one is after the clock is set back", () => {
    plant("{ not json", -3_600_000);
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive, now })).toBe(true);
    expect(stored().pid).toBe(100);
  });

  it("leaves a corrupt lock that cannot be looked at for the next check", () => {
    plant("{ not json");
    fsMock.statSync.mockImplementationOnce(() => {
      throw errno("EPERM");
    });
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive, now })).toBe(false);
    expect(fsMock.files.get(LOCK)).toBe("{ not json");
  });

  it("reads the winner of a simultaneous create as still being written, not as corrupt", () => {
    fsMock.writeFileSync.mockImplementationOnce(() => {
      // The other window's exclusive create has made the file, empty.
      plant("", 0);
      throw errno("EEXIST");
    });
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive, now })).toBe(false);
    expect(fsMock.files.get(LOCK)).toBe("");
  });

  it("does not delete a stale lock while another window holds the takeover file", () => {
    plant({ pid: DEAD_PID, startedAt: "long ago" });
    plant(String(OTHER_PID), 0, TAKEOVER);
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: dead, now })).toBe(false);
    expect(stored()).toEqual({ pid: DEAD_PID, startedAt: "long ago" });
    expect(fsMock.files.get(TAKEOVER)).toBe(String(OTHER_PID));
  });

  it("removes a takeover file left by a window that stopped part way, and takes over at the next check", () => {
    plant({ pid: DEAD_PID, startedAt: "long ago" });
    plant(String(OTHER_PID), LOCK_WRITE_GRACE_MS, TAKEOVER);
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: dead, now })).toBe(false);
    expect(fsMock.files.has(TAKEOVER)).toBe(false);
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: dead, now })).toBe(true);
    expect(stored().pid).toBe(100);
  });

  it("reads the lock again under the takeover file, and leaves one another window has taken since", () => {
    // The race the takeover file closes: this window has read the stale
    // lock, and before it deletes it another window takes it over and
    // writes its own. Deleting by name would delete that window's new lock.
    plant({ pid: DEAD_PID, startedAt: "long ago" });
    fsMock.readFileSync.mockImplementationOnce((p: string) => {
      const stale = fsMock.files.get(p) as string;
      plant({ pid: OTHER_PID, startedAt: "just now" }, 0);
      return stale;
    });
    const isAlive = (pid: number) => pid === OTHER_PID;
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive, now })).toBe(false);
    expect(stored()).toEqual({ pid: OTHER_PID, startedAt: "just now" });
    expect(fsMock.files.has(TAKEOVER)).toBe(false);
  });

  it("takes over a stale lock through the takeover file, and removes the takeover file", () => {
    plant({ pid: DEAD_PID, startedAt: "long ago" });
    expect(tryAcquireLock(LOCK, { ownPid: 100, isAlive: dead, now })).toBe(true);
    expect(stored().pid).toBe(100);
    expect(fsMock.files.has(TAKEOVER)).toBe(false);
    expect(fsMock.writeFileSync.mock.calls[0][0]).toBe(TAKEOVER);
  });

  it("propagates a failure to write the takeover file in a directory that cannot be written", () => {
    plant({ pid: DEAD_PID, startedAt: "long ago" });
    const refuse = (): never => {
      throw errno("EROFS");
    };
    fsMock.writeFileSync.mockImplementationOnce(refuse).mockImplementationOnce(refuse);
    expect(() => tryAcquireLock(LOCK, { ownPid: 100, isAlive: dead, now })).toThrow(/EROFS/);
  });
});

describe("releaseLock", () => {
  it("deletes the lock this process wrote", () => {
    plant({ pid: 100, startedAt: "x" });
    releaseLock(LOCK, 100);
    expect(fsMock.files.has(LOCK)).toBe(false);
  });

  it("defaults to the real process pid", () => {
    plant({ pid: process.pid, startedAt: "x" });
    releaseLock(LOCK);
    expect(fsMock.files.has(LOCK)).toBe(false);
  });

  it("leaves another process's lock alone", () => {
    plant({ pid: OTHER_PID, startedAt: "theirs" });
    releaseLock(LOCK, 100);
    expect(stored()).toEqual({ pid: OTHER_PID, startedAt: "theirs" });
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it("does nothing when there is no lock", () => {
    expect(() => releaseLock(LOCK, 100)).not.toThrow();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it("leaves a corrupt lock in place because ownership cannot be proven", () => {
    plant("{ not json");
    expect(() => releaseLock(LOCK, 100)).not.toThrow();
    expect(fsMock.files.has(LOCK)).toBe(true);
  });

  it("swallows a delete failure", () => {
    plant({ pid: 100 });
    fsMock.unlinkSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    expect(() => releaseLock(LOCK, 100)).not.toThrow();
  });
});

describe("acquire and release together", () => {
  it("models two windows starting, the first closing, the second taking over", () => {
    // Window A starts and takes the lock.
    expect(tryAcquireLock(LOCK, { ownPid: 1, isAlive: () => true })).toBe(true);

    // Window B starts while A is alive and stands down.
    const aAlive = { value: true };
    const probe = (pid: number) => (pid === 1 ? aAlive.value : false);
    expect(tryAcquireLock(LOCK, { ownPid: 2, isAlive: probe })).toBe(false);

    // A crashes: its lock is left behind, its pid is gone.
    aAlive.value = false;

    // B's watcher fires and takes over.
    expect(tryAcquireLock(LOCK, { ownPid: 2, isAlive: probe })).toBe(true);
    expect(stored().pid).toBe(2);

    // B disables listening and the lock is gone for the next window.
    releaseLock(LOCK, 2);
    expect(readLock(LOCK)).toEqual({ kind: "absent" });
  });

  it("models the owner disabling listening so the other window can start", () => {
    expect(tryAcquireLock(LOCK, { ownPid: 1, isAlive: alive })).toBe(true);
    expect(tryAcquireLock(LOCK, { ownPid: 2, isAlive: alive })).toBe(false);
    releaseLock(LOCK, 1);
    expect(tryAcquireLock(LOCK, { ownPid: 2, isAlive: alive })).toBe(true);
    expect(stored().pid).toBe(2);
  });

  it("keeps the lock through a cooldown and re-acquire cycle", () => {
    expect(tryAcquireLock(LOCK, { ownPid: 1, isAlive: alive })).toBe(true);
    const first = stored();
    // Cooldown expires, listening resumes, start() asks again.
    expect(tryAcquireLock(LOCK, { ownPid: 1, isAlive: alive })).toBe(true);
    expect(stored()).toEqual(first);
    // The other window still cannot take it.
    expect(tryAcquireLock(LOCK, { ownPid: 2, isAlive: alive })).toBe(false);
  });
});
