import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  acquireLock,
  releaseLock,
  withLock,
  LockAcquisitionTimeout,
} from "../src/index.js";

// File-locking is wall-clock-bound; use real timers throughout this file.

describe("single-flight lock", () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `mcp-lock-${crypto.randomUUID()}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });
    lockPath = path.join(tmpDir, "tokens.json.lock");
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
  });

  it("acquireLock + releaseLock roundtrip", async () => {
    await acquireLock({ lockPath });
    const stat = await fs.promises.stat(lockPath);
    expect(stat.isFile()).toBe(true);
    await releaseLock(lockPath);
    await expect(fs.promises.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("acquireLock twice without release -> second call times out", async () => {
    await acquireLock({ lockPath });
    const start = Date.now();
    await expect(
      acquireLock({ lockPath, timeoutMs: 300, pollIntervalMs: 50, staleAfterMs: 60_000 }),
    ).rejects.toBeInstanceOf(LockAcquisitionTimeout);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    await releaseLock(lockPath);
  });

  it("stale lock (mtime in past) is forcibly cleared and new caller acquires", async () => {
    // Create a stale lock manually.
    await fs.promises.writeFile(lockPath, "99999");
    const pastMs = (Date.now() - 60_000) / 1000;
    await fs.promises.utimes(lockPath, pastMs, pastMs);

    // Stale threshold = 5s; 60s old = stale.
    await acquireLock({ lockPath, timeoutMs: 2_000, staleAfterMs: 5_000 });
    // Now we hold it; the contents should be our pid (overwritten).
    const contents = await fs.promises.readFile(lockPath, "utf8");
    expect(contents).toBe(String(process.pid));
    await releaseLock(lockPath);
  });

  it("withLock releases on throw", async () => {
    await expect(
      withLock({ lockPath }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(fs.promises.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("withLock returns the inner function's result", async () => {
    const result = await withLock({ lockPath }, async () => 42);
    expect(result).toBe(42);
    await expect(fs.promises.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("two concurrent acquireLock calls: second waits until first releases", async () => {
    let firstAcquiredAt = 0;
    let firstReleasedAt = 0;
    let secondAcquiredAt = 0;

    const first = (async () => {
      await acquireLock({ lockPath });
      firstAcquiredAt = Date.now();
      // Hold the lock briefly.
      await new Promise((r) => setTimeout(r, 200));
      firstReleasedAt = Date.now();
      await releaseLock(lockPath);
    })();

    // Wait briefly so the first call has time to start acquiring.
    await new Promise((r) => setTimeout(r, 50));

    const second = (async () => {
      await acquireLock({
        lockPath,
        timeoutMs: 5_000,
        pollIntervalMs: 25,
        staleAfterMs: 60_000,
      });
      secondAcquiredAt = Date.now();
      await releaseLock(lockPath);
    })();

    await Promise.all([first, second]);

    expect(firstAcquiredAt).toBeGreaterThan(0);
    expect(firstReleasedAt).toBeGreaterThan(firstAcquiredAt);
    // Second must have acquired AFTER first released (allow small fudge for poll interval).
    expect(secondAcquiredAt).toBeGreaterThanOrEqual(firstReleasedAt - 5);
  });
});
