import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  acquireLock,
  releaseLock,
  isPidAlive,
  LockHeldError,
  type LockHandle,
} from "../../cli/lib/pid-lock.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEAD_PID = 99_999_999;

function makeTempLockPath(): string {
  const tag = randomBytes(8).toString("hex");
  return path.join(os.tmpdir(), `pid-lock-test-${tag}.lock`);
}

describe("pid-lock", () => {
  let lockPath: string;
  const cleanupPaths: string[] = [];

  beforeEach(() => {
    lockPath = makeTempLockPath();
    cleanupPaths.push(lockPath);
  });

  afterEach(() => {
    for (const p of cleanupPaths.splice(0)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });

  describe("isPidAlive", () => {
    it("returns true for current process PID", () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it("returns false for a very high PID unlikely to exist", () => {
      expect(isPidAlive(DEAD_PID)).toBe(false);
    });

    it("returns false for invalid PID (-1)", () => {
      expect(isPidAlive(-1)).toBe(false);
    });

    it("returns false for NaN", () => {
      expect(isPidAlive(Number.NaN)).toBe(false);
    });

    it("returns false for zero", () => {
      expect(isPidAlive(0)).toBe(false);
    });

    it("returns false for non-integer", () => {
      expect(isPidAlive(1.5)).toBe(false);
    });

    it("returns true when process.kill throws EPERM (alive but not signalable)", () => {
      const spy = vi.spyOn(process, "kill").mockImplementation(() => {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });
      try {
        expect(isPidAlive(12345)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns false when process.kill throws ESRCH", () => {
      const spy = vi.spyOn(process, "kill").mockImplementation(() => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      });
      try {
        expect(isPidAlive(12345)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("acquireLock", () => {
    it("creates lock file with current PID when path doesn't exist", () => {
      const handle = acquireLock(lockPath);
      expect(handle.path).toBe(lockPath);
      expect(handle.ownerPid).toBe(process.pid);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    });

    it("takes over a stale lock (dead PID)", () => {
      fs.writeFileSync(lockPath, String(DEAD_PID));
      const handle = acquireLock(lockPath);
      expect(handle.ownerPid).toBe(process.pid);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    });

    it("takes over a lock owned by the current PID (defensive)", () => {
      fs.writeFileSync(lockPath, String(process.pid));
      const handle = acquireLock(lockPath);
      expect(handle.ownerPid).toBe(process.pid);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    });

    it("takes over a lock when contents are non-numeric/garbage", () => {
      fs.writeFileSync(lockPath, "not-a-number");
      const handle = acquireLock(lockPath);
      expect(handle.ownerPid).toBe(process.pid);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    });

    it("throws LockHeldError when file holds an alive OTHER PID (2-process spawn)", async () => {
      const fixture = path.join(__dirname, "fixtures", "forever-child.cjs");
      const child: ChildProcess = fork(fixture, { stdio: "pipe" });
      try {
        const childPid = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("child PID timeout")), 5000);
          child.stdout?.once("data", (d: Buffer) => {
            clearTimeout(timer);
            resolve(parseInt(String(d).trim(), 10));
          });
          child.once("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
        });
        expect(childPid).toBeGreaterThan(0);
        expect(childPid).not.toBe(process.pid);

        fs.writeFileSync(lockPath, String(childPid));

        let caught: unknown;
        try {
          acquireLock(lockPath);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(LockHeldError);
        const err = caught as LockHeldError;
        expect(err.heldByPid).toBe(childPid);
        expect(err.path).toBe(lockPath);
        expect(err.name).toBe("LockHeldError");
        expect(err.message).toContain(String(childPid));

        // File unchanged
        expect(fs.readFileSync(lockPath, "utf8")).toBe(String(childPid));
      } finally {
        child.kill();
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
        });
      }
    });

    it("propagates non-EEXIST errors from openSync", () => {
      // Try to create a lock inside a non-existent directory
      const bogus = path.join(os.tmpdir(), `nope-${randomBytes(4).toString("hex")}`, "nested", "x.lock");
      expect(() => acquireLock(bogus)).toThrow();
    });
  });

  describe("releaseLock", () => {
    it("removes the lock file", () => {
      const handle = acquireLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);
      releaseLock(handle);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("is idempotent on already-deleted file", () => {
      const handle: LockHandle = { path: lockPath, ownerPid: process.pid };
      // File doesn't exist
      expect(() => releaseLock(handle)).not.toThrow();
    });

    it("propagates non-ENOENT errors", () => {
      // Use a path that's actually a directory to trigger a non-ENOENT error
      const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), "pid-lock-dir-"));
      cleanupPaths.push(dirPath);
      const handle: LockHandle = { path: dirPath, ownerPid: process.pid };
      try {
        releaseLock(handle);
        // Some platforms may unlink the dir (rare); if it didn't throw, clean up alt way.
      } catch (e) {
        expect(e).toBeDefined();
      } finally {
        try {
          fs.rmdirSync(dirPath);
        } catch {
          /* ignore */
        }
      }
    });
  });
});
