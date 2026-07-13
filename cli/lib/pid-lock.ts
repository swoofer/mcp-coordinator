import * as fs from "node:fs";

export class LockHeldError extends Error {
  constructor(
    public readonly path: string,
    public readonly heldByPid: number,
  ) {
    super(`Lock held by alive PID ${heldByPid} at ${path}`);
    this.name = "LockHeldError";
  }
}

export interface LockHandle {
  readonly path: string;
  readonly ownerPid: number;
}

/** Check whether a given PID is alive (cross-platform). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 — existence check only, no actual signal
    return true;
  } catch (err: unknown) {
    // ESRCH = no such process; EPERM = exists but we can't signal it (still alive)
    if ((err as NodeJS.ErrnoException)?.code === "EPERM") return true;
    return false;
  }
}

/**
 * Atomically acquire a lock by creating `path` with the current PID written into it.
 * - If the file does not exist: creates it (atomic via `wx` flag).
 * - If the file exists but its PID is dead: takes over the lock (unlink + recreate).
 * - If the file exists and its PID is alive: throws LockHeldError.
 */
export function acquireLock(path: string): LockHandle {
  const myPid = process.pid;
  try {
    const fd = fs.openSync(path, "wx");
    fs.writeSync(fd, String(myPid));
    fs.closeSync(fd);
    return { path, ownerPid: myPid };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    // File exists — check PID
    const contents = fs.readFileSync(path, "utf8").trim();
    const heldByPid = parseInt(contents, 10);
    if (Number.isFinite(heldByPid) && isPidAlive(heldByPid) && heldByPid !== myPid) {
      throw new LockHeldError(path, heldByPid);
    }
    // Stale (dead PID) or our own — take over
    fs.unlinkSync(path);
    const fd = fs.openSync(path, "wx");
    fs.writeSync(fd, String(myPid));
    fs.closeSync(fd);
    return { path, ownerPid: myPid };
  }
}

/** Release a previously acquired lock. Idempotent. */
export function releaseLock(handle: LockHandle): void {
  try {
    fs.unlinkSync(handle.path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return; // already gone
    throw err;
  }
}
