import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In-memory stand-in for the handful of fs calls the lock module makes.
 *
 * It honours the `wx` (exclusive create) flag, which is what makes lock
 * acquisition atomic between two windows, so the race path can be driven
 * deterministically rather than hoped for.
 */
const fsMock = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const errno = (code: string, p: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: ${p}`), { code });

  return {
    files,
    dirs,
    reset(): void {
      files.clear();
      dirs.clear();
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
    }),
    unlinkSync: vi.fn((p: string): void => {
      if (!files.delete(p)) {
        throw errno("ENOENT", p);
      }
    }),
    mkdirSync: vi.fn((p: string): void => {
      dirs.add(p);
    }),
  };
});

vi.mock("fs", () => ({
  readFileSync: fsMock.readFileSync,
  writeFileSync: fsMock.writeFileSync,
  unlinkSync: fsMock.unlinkSync,
  mkdirSync: fsMock.mkdirSync,
}));

import * as path from "path";
import {
  LOCK_CHECK_INTERVAL_MS,
  LOCK_FILE_NAME,
  isProcessAlive,
  lockFilePath,
  readLock,
  releaseLock,
  tryAcquireLock,
} from "../../src/lockFile";

const STORAGE = path.join("/", "storage", "wake-word");
const LOCK = path.join(STORAGE, LOCK_FILE_NAME);

/** A PID that no operating system will have handed out. */
const DEAD_PID = 2_147_483_647;
const OTHER_PID = 4242;

const alive = () => true;
const dead = () => false;

function plant(lock: unknown): void {
  fsMock.files.set(LOCK, typeof lock === "string" ? lock : JSON.stringify(lock));
}

function stored(): { pid: number; startedAt: string } {
  return JSON.parse(fsMock.files.get(LOCK) ?? "null");
}

beforeEach(() => {
  fsMock.reset();
  fsMock.readFileSync.mockClear();
  fsMock.writeFileSync.mockClear();
  fsMock.unlinkSync.mockClear();
  fsMock.mkdirSync.mockClear();
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

  it("propagates a write failure that is not a lost race", () => {
    // An unwritable storage directory is the caller's decision: the
    // extension logs it and listens without coordination.
    fsMock.writeFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    expect(() => tryAcquireLock(LOCK, { ownPid: 100, isAlive: alive })).toThrow(/EACCES/);
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
