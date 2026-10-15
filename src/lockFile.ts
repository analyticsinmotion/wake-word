import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import * as path from "path";

/**
 * Cross-window listener coordination.
 *
 * Every editor window runs its own extension host, and each one activates
 * this extension. Without coordination three windows meant three engine
 * processes on the same microphone, three detections of one phrase, and
 * three commands firing at once. The fix is a PID lock in globalStorage,
 * which every window of the same editor shares. A window opens the microphone
 * only while it holds the lock, and gives the lock up only once its
 * microphone is closed, so two windows never have it open at once.
 *
 * Which window holds it depends on `wakeWord.pauseOnFocusLoss`. With the
 * setting on, the lock follows focus: a window that loses focus pauses and
 * releases the lock, and the window that gains focus takes it. With it off,
 * the first window to start listening keeps the lock until listening stops
 * there. Either way it is held through a handoff: the microphone has been
 * handed to an assistant, and a second window must not take it in the
 * meantime. A crash releases nothing, so a lock whose PID is no longer
 * running is treated as free.
 *
 * Nothing here touches the VS Code API. The extension host passes the storage
 * directory in, so this module is unit tested with the filesystem mocked.
 */

export const LOCK_FILE_NAME = "wake-word.lock";

/**
 * How often a window standing by checks whether the lock holder has gone,
 * when listening does not follow focus. The holder keeps the lock until
 * listening stops there, so nothing is gained by looking more often.
 */
export const LOCK_CHECK_INTERVAL_MS = 10_000;

/**
 * How often a focused window checks the lock while it waits for the window
 * that lost focus to release it. That window releases the lock once its
 * engine has closed the microphone, which takes milliseconds and at most the
 * engine's 500 ms pause timeout, but the two windows hear about the change
 * of focus separately and in either order.
 */
export const LOCK_HANDOVER_INTERVAL_MS = 100;

/**
 * How long a focused window keeps checking at LOCK_HANDOVER_INTERVAL_MS. A
 * window that still holds the lock after this is not handing it over: it is
 * finishing a start, or a wake phrase has handed its microphone to an
 * assistant, and it keeps the lock until that handoff ends.
 */
export const LOCK_HANDOVER_MS = 2_000;

/**
 * How often a focused window checks the lock after LOCK_HANDOVER_MS, until
 * the holder releases it or this window loses focus. Once a second is soon
 * enough after a handoff ends and cheap enough to keep up for as long as one
 * lasts.
 */
export const LOCK_FOCUSED_CHECK_INTERVAL_MS = 1_000;

/**
 * A lock file written less than this long ago that cannot be read as a lock
 * is taken to be still being written. See tryAcquireLock().
 */
export const LOCK_WRITE_GRACE_MS = 1_000;

/**
 * How long a window standing by waits before its next check of the lock,
 * given how long it has been waiting. `followsFocus` is the
 * `wakeWord.pauseOnFocusLoss` setting; with it on, only a focused window
 * checks at all.
 */
export function lockCheckDelay(waitedMs: number, followsFocus: boolean): number {
  if (!followsFocus) {
    return LOCK_CHECK_INTERVAL_MS;
  }
  return waitedMs < LOCK_HANDOVER_MS ? LOCK_HANDOVER_INTERVAL_MS : LOCK_FOCUSED_CHECK_INTERVAL_MS;
}

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
 * so is a corrupt one, once it is older than LOCK_WRITE_GRACE_MS.
 *
 * The write uses exclusive create (`wx`) so two windows that read the same
 * absent or stale lock at the same moment cannot both believe they own it:
 * one create fails with EEXIST, and that window reads again to find the
 * winner. Windows restored together on editor startup all reach this point
 * within the same second, so that race is the common case, not a corner.
 *
 * Three more races would each let two windows believe they hold the lock at
 * once, and are closed here:
 *
 * - The exclusive create makes the file before the write fills it, so for a
 *   moment a lock that has just been taken reads as an empty file. A window
 *   that took that over as corrupt would delete the new lock and write its
 *   own. A corrupt lock written less than LOCK_WRITE_GRACE_MS ago is
 *   therefore left for the next check.
 * - Taking over an abandoned lock is a delete and then a create. Two windows
 *   that judge the same lock abandoned can interleave so that the second
 *   one's delete removes the lock the first has just created. Only the
 *   window holding the takeover file deletes a lock it does not own: see
 *   removeAbandonedLock().
 * - A create can fail with EPERM on Windows for a moment while another
 *   process is still deleting the previous file of that name. Taken for an
 *   unwritable directory, it would make the window listen without
 *   coordination. A create that fails for any reason but EEXIST is a
 *   failure to take the lock this time if a file beside it can be written.
 *   Only a storage directory that cannot be written at all makes the error
 *   propagate, and the caller then decides whether to listen without
 *   coordination.
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

    if (state.kind === "corrupt" && inspectCorruptLock(lockPath, now()) === "writing") {
      return false;
    }

    // Stale or corrupt: clear it so the exclusive create can succeed.
    if (state.kind !== "absent" && !removeAbandonedLock(lockPath, ownPid, isAlive, now)) {
      return false;
    }

    mkdirSync(path.dirname(lockPath), { recursive: true });

    const lock: LockInfo = { pid: ownPid, startedAt: now().toISOString() };
    try {
      writeFileSync(lockPath, JSON.stringify(lock), { encoding: "utf8", flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Lost the race. Loop once to read the winner.
        continue;
      }
      if (canWriteBeside(lockPath, ownPid)) {
        return false;
      }
      throw err;
    }
  }

  return false;
}

/** Suffix of the file whose holder alone may delete an abandoned lock. */
export const TAKEOVER_SUFFIX = ".takeover";

/**
 * Delete a lock left by a crashed window, or a corrupt one, so a new one can
 * be created. Returns true when the name is free for the exclusive create,
 * and false when this is not the moment: another window is taking the lock
 * over, or the lock is no longer abandoned.
 *
 * Only the window that creates the takeover file, exclusively, deletes a
 * lock that is not its own, and it reads the lock again first: while it
 * holds that file, no other window deletes the lock, so what it reads is
 * what it deletes. The create that follows is exclusive as always, so a
 * window that creates the lock in between wins, and this one reads the
 * winner on its second pass.
 *
 * A takeover file older than LOCK_WRITE_GRACE_MS was left by a window that
 * stopped part way, since a takeover lasts microseconds: it is removed, and
 * the lock is taken over at the next check.
 */
function removeAbandonedLock(
  lockPath: string,
  ownPid: number,
  isAlive: (pid: number) => boolean,
  now: () => Date
): boolean {
  const takeover = `${lockPath}${TAKEOVER_SUFFIX}`;
  try {
    writeFileSync(takeover, String(ownPid), { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      // As for the lock itself: only a directory that cannot be written at
      // all is the caller's to decide about.
      if (canWriteBeside(lockPath, ownPid)) {
        return false;
      }
      throw err;
    }
    if (inspectCorruptLock(takeover, now()) === "abandoned") {
      try {
        unlinkSync(takeover);
      } catch {
        // Removed by its holder or another window meanwhile.
      }
    }
    return false;
  }
  try {
    const state = readLock(lockPath);
    if (state.kind === "absent") {
      return true;
    }
    if (state.kind === "held" && (state.lock.pid === ownPid || isAlive(state.lock.pid))) {
      return false;
    }
    if (state.kind === "corrupt") {
      const corrupt = inspectCorruptLock(lockPath, now());
      if (corrupt !== "abandoned") {
        return corrupt === "gone";
      }
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Gone already: the name is free either way.
    }
    return true;
  } finally {
    try {
      unlinkSync(takeover);
    } catch {
      // Removed by a window that took it for abandoned: see above.
    }
  }
}

/**
 * What a file that could not be read as a lock is: `writing`, written less
 * than LOCK_WRITE_GRACE_MS ago and probably still being written (see
 * tryAcquireLock()); `gone`, removed since it was read; or `abandoned`,
 * older, and left by a window that stopped part way through writing it. One
 * that cannot be looked at counts as `writing`, so it is left for the next
 * check. The age is compared both ways, so a clock set back after the file
 * was written cannot keep a corrupt lock from ever being taken over.
 */
function inspectCorruptLock(file: string, now: Date): "writing" | "gone" | "abandoned" {
  try {
    const age = Math.abs(now.getTime() - statSync(file).mtimeMs);
    return age < LOCK_WRITE_GRACE_MS ? "writing" : "abandoned";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "writing";
  }
}

/**
 * True when a file can be written beside the lock: the storage directory
 * works, so a failure to create the lock itself was about that one name. The
 * file carries this process's PID, so windows never share one, and is
 * removed at once.
 */
function canWriteBeside(lockPath: string, ownPid: number): boolean {
  const probe = `${lockPath}.${ownPid}.probe`;
  try {
    writeFileSync(probe, "", { encoding: "utf8", flag: "w" });
  } catch {
    return false;
  }
  try {
    unlinkSync(probe);
  } catch {
    // Left behind, it is overwritten the next time this process looks.
  }
  return true;
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

/**
 * One line saying who holds the lock, for Show Diagnostics.
 *
 * A lock naming a PID that is no longer running, and one that cannot be
 * read, both say so: either is taken over by the next window that starts.
 */
export function describeLock(
  state: LockState,
  ownPid: number = process.pid,
  isAlive: (pid: number) => boolean = isProcessAlive
): string {
  switch (state.kind) {
    case "absent":
      return "free (no window is listening)";
    case "corrupt":
      return "unreadable (the next window to start listening takes it over)";
    case "held": {
      const { pid, startedAt } = state.lock;
      const since = startedAt ? `, since ${startedAt}` : "";
      if (pid === ownPid) {
        return `held by this window (pid ${pid}${since})`;
      }
      if (isAlive(pid)) {
        return `held by another window (pid ${pid}${since})`;
      }
      return `stale (pid ${pid} is not running; the next window to start listening takes it over)`;
    }
  }
}
