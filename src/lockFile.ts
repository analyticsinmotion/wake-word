import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import * as path from "path";

/**
 * Cross-window listener coordination.
 *
 * Every editor window runs its own extension host, and each one activates
 * this extension. Without coordination three windows meant three engine
 * processes on the same microphone, three detections of one phrase, and
 * three commands firing at once. The fix is a PID lock in globalStorage,
 * which every window of the same editor shares: the first window to start
 * listening writes its extension host PID, and the others stand down until
 * that PID is gone.
 *
 * The lock is held for the whole listening session, including the cooldown
 * after a detection: the microphone is handed to an assistant then, and a
 * second window must not grab it in the meantime. It is released when the
 * user disables listening in the owning window and when that window's
 * extension host deactivates. A crash releases nothing, so a lock whose PID
 * is no longer running is treated as free.
 *
 * Nothing here touches the VS Code API. The extension host passes the storage
 * directory in, so this module is unit tested with the filesystem mocked.
 */

export const LOCK_FILE_NAME = "wake-word.lock";

/** How often a standing-by window checks whether the lock holder has gone. */
export const LOCK_CHECK_INTERVAL_MS = 10_000;

export interface LockInfo {
  /** Extension host PID of the window that is listening. */
  pid: number;
  /** ISO timestamp of when that window took the lock. Informational. */
  startedAt: string;
}

export type LockState =
  | { kind: "absent" }
  | { kind: "corrupt" }
  | { kind: "held"; lock: LockInfo };

export interface AcquireOptions {
  /** PID written to the lock and recognised as our own. Defaults to process.pid. */
  ownPid?: number;
  /** Liveness probe for a foreign PID. Defaults to isProcessAlive. */
  isAlive?: (pid: number) => boolean;
  /** Clock for the startedAt stamp. */
  now?: () => Date;
}

/** Path of the lock file inside the extension's global storage directory. */
export function lockFilePath(storageDir: string): string {
  return path.join(storageDir, LOCK_FILE_NAME);
}

/**
 * True when a process with this PID is running.
 *
 * Signal 0 delivers nothing and only checks that the target exists, on
 * Windows as well as POSIX. EPERM means the process exists but belongs to
 * another user, which still counts as alive. Zero and negative values address
 * process groups rather than a process, and kill(0, 0) succeeds without
 * saying anything about a lock holder, so they are rejected up front.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read and validate the lock file.
 *
 * A missing file is `absent`. Anything that is not a JSON object with a
 * positive integer `pid` is `corrupt`; the caller treats that the same as a
 * stale lock, because a file that cannot name its owner cannot be honoured.
 */
export function readLock(lockPath: string): LockState {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    return { kind: "corrupt" };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { kind: "corrupt" };
    }
    const pid = (parsed as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return { kind: "corrupt" };
    }
    const startedAt = (parsed as { startedAt?: unknown }).startedAt;
    return {
      kind: "held",
      lock: { pid, startedAt: typeof startedAt === "string" ? startedAt : "" },
    };
  } catch {
    return { kind: "corrupt" };
  }
}

/**
 * Take the listener lock if it is free, stale, or already ours.
 *
 * Returns false when another running process holds it. A lock naming a PID
 * that is no longer running was left by a crashed window and is taken over;
 * so is a corrupt one.
 *
 * The write uses exclusive create (`wx`) so two windows that read the same
 * absent or stale lock at the same moment cannot both believe they own it:
 * one create fails with EEXIST, and that window reads again to find the
 * winner. Windows restored together on editor startup all reach this point
 * within the same second, so that race is the common case, not a corner.
 *
 * Filesystem errors other than EEXIST propagate. The caller decides whether
 * to listen without coordination when the storage directory is unwritable.
 */
export function tryAcquireLock(lockPath: string, options: AcquireOptions = {}): boolean {
  const ownPid = options.ownPid ?? process.pid;
  const isAlive = options.isAlive ?? isProcessAlive;
  const now = options.now ?? (() => new Date());

  // Two passes: the second is for a window that lost the exclusive create
  // and needs to see who won.
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = readLock(lockPath);

    if (state.kind === "held") {
      if (state.lock.pid === ownPid) {
        return true;
      }
      if (isAlive(state.lock.pid)) {
        return false;
      }
    }

    if (state.kind !== "absent") {
      // Stale or corrupt: clear it so the exclusive create can succeed.
      try {
        unlinkSync(lockPath);
      } catch {
        // Another window may have removed it first. The create below
        // settles who owns the replacement.
      }
    }

    mkdirSync(path.dirname(lockPath), { recursive: true });

    const lock: LockInfo = { pid: ownPid, startedAt: now().toISOString() };
    try {
      writeFileSync(lockPath, JSON.stringify(lock), { encoding: "utf8", flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      // Lost the race. Loop once to read the winner.
    }
  }

  return false;
}

/**
 * Remove the lock, but only if this process wrote it.
 *
 * Best effort throughout: a lock that cannot be removed is a stale lock, and
 * the next window to look treats a dead PID as free.
 */
export function releaseLock(lockPath: string, ownPid: number = process.pid): void {
  try {
    const state = readLock(lockPath);
    if (state.kind === "held" && state.lock.pid === ownPid) {
      unlinkSync(lockPath);
    }
  } catch {
    // Nothing to do. See above.
  }
}
