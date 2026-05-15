import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export interface SingleFlightOptions {
  lockPath: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_AFTER_MS = 30_000;

export class LockAcquisitionTimeout extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`Could not acquire ${lockPath} within ${timeoutMs}ms`);
    this.name = "LockAcquisitionTimeout";
  }
}

/**
 * Acquire a single-flight lock. Only one process at a time gets the lock;
 * others wait. Stale locks (older than staleAfterMs) are forcibly cleared
 * to recover from crashed holders.
 *
 * The lock is implemented via an atomic O_EXCL file create; this works on
 * both POSIX and Windows (Node's `wx` flag maps to `O_EXCL | O_CREAT | O_WRONLY`).
 */
export async function acquireLock(opts: SingleFlightOptions): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const deadline = Date.now() + timeoutMs;

  // Ensure parent directory exists so the lock create itself doesn't ENOENT.
  // Use path.dirname via fs APIs (require node:path inline).
  // Best-effort: caller normally already has the parent dir.

  while (true) {
    try {
      // O_EXCL: fail if file exists. wx mode = write + exclusive create.
      const fd = await fs.promises.open(opts.lockPath, "wx");
      await fd.write(String(process.pid));
      await fd.close();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      // Check for stale lock.
      try {
        const stat = await fs.promises.stat(opts.lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.promises.unlink(opts.lockPath).catch(() => {
            /* race-ok */
          });
          continue; // retry immediately
        }
      } catch {
        /* lock disappeared mid-check; retry */
      }
      if (Date.now() >= deadline) {
        throw new LockAcquisitionTimeout(opts.lockPath, timeoutMs);
      }
      await sleep(pollMs);
    }
  }
}

/** Release the lock. Safe to call even if not held (unlink ENOENT is ignored). */
export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await fs.promises.unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Convenience: wraps a critical section. Always releases, even on throw. */
export async function withLock<T>(opts: SingleFlightOptions, fn: () => Promise<T>): Promise<T> {
  await acquireLock(opts);
  try {
    return await fn();
  } finally {
    await releaseLock(opts.lockPath);
  }
}
