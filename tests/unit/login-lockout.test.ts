import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import type { Clock } from "../../src/auth/clock.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import {
  hashIdentifier,
  isLocked,
  recordFailedLogin,
  resetLockoutForTest,
  DEFAULT_LOCKOUT_THRESHOLD,
  DEFAULT_LOCKOUT_WINDOW_SECONDS,
} from "../../src/auth/login-lockout.js";

class FakeClock implements Clock {
  constructor(public current = 1_000_000) {}
  now(): number {
    return this.current;
  }
  advance(s: number): void {
    this.current += s;
  }
}

let clock: FakeClock;
let limiter: RateLimiter;

beforeEach(() => {
  clock = new FakeClock();
  limiter = new RateLimiter(clock);
});

describe("hashIdentifier", () => {
  it("is deterministic and returns 64-char hex", () => {
    const h1 = hashIdentifier("alice");
    const h2 = hashIdentifier("alice");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different inputs", () => {
    expect(hashIdentifier("alice")).not.toBe(hashIdentifier("bob"));
    expect(hashIdentifier("alice")).not.toBe(hashIdentifier("Alice"));
    expect(hashIdentifier("")).not.toBe(hashIdentifier("alice"));
  });

  it("is purpose-keyed: hash differs from raw sha256 of the identifier", () => {
    const purposed = hashIdentifier("alice");
    const raw = crypto.createHash("sha256").update("alice").digest("hex");
    expect(purposed).not.toBe(raw);
  });
});

describe("recordFailedLogin", () => {
  it("default threshold=5: attempts 1..5 are tolerated; 6th locks", async () => {
    const id = hashIdentifier("alice");
    for (let i = 1; i <= DEFAULT_LOCKOUT_THRESHOLD; i++) {
      const r = await recordFailedLogin(limiter, id);
      expect(r.locked).toBe(false);
    }
    const sixth = await recordFailedLogin(limiter, id);
    expect(sixth.locked).toBe(true);
    expect(sixth.retry_after_seconds).toBeGreaterThan(0);
  });

  it("respects custom config: threshold=2, window=30 — 3rd attempt locks", async () => {
    const id = hashIdentifier("eve");
    const cfg = { threshold: 2, window_seconds: 30 };
    expect((await recordFailedLogin(limiter, id, cfg)).locked).toBe(false);
    expect((await recordFailedLogin(limiter, id, cfg)).locked).toBe(false);
    const r3 = await recordFailedLogin(limiter, id, cfg);
    expect(r3.locked).toBe(true);
    expect(r3.retry_after_seconds).toBeGreaterThan(0);
  });
});

describe("isLocked", () => {
  it("returns false on a fresh identifier", async () => {
    const id = hashIdentifier("alice");
    expect((await isLocked(limiter, id)).locked).toBe(false);
  });

  it("returns true once threshold is exceeded; peek does not consume", async () => {
    const id = hashIdentifier("alice");
    for (let i = 0; i < DEFAULT_LOCKOUT_THRESHOLD + 1; i++) {
      await recordFailedLogin(limiter, id);
    }
    const r1 = await isLocked(limiter, id);
    const r2 = await isLocked(limiter, id);
    expect(r1.locked).toBe(true);
    expect(r2.locked).toBe(true);
    expect(r1.retry_after_seconds).toBeGreaterThan(0);
  });

  it("returns false again after window passes (TTL expiry)", async () => {
    const id = hashIdentifier("alice");
    for (let i = 0; i < DEFAULT_LOCKOUT_THRESHOLD + 1; i++) {
      await recordFailedLogin(limiter, id);
    }
    expect((await isLocked(limiter, id)).locked).toBe(true);
    clock.advance(DEFAULT_LOCKOUT_WINDOW_SECONDS + 1);
    expect((await isLocked(limiter, id)).locked).toBe(false);
  });

  it("uses default config when no cfg passed (covers default-arg branch)", async () => {
    const id = hashIdentifier("alice");
    // First call without cfg arg — exercises default parameter path.
    const r = await isLocked(limiter, id);
    expect(r.locked).toBe(false);
    expect(r.retry_after_seconds).toBeUndefined();
  });

  it("respects custom config (cfg branch)", async () => {
    const id = hashIdentifier("alice");
    const cfg = { threshold: 1, window_seconds: 60 };
    // After 2 failures with threshold=1 we should be locked.
    await recordFailedLogin(limiter, id, cfg);
    await recordFailedLogin(limiter, id, cfg);
    expect((await isLocked(limiter, id, cfg)).locked).toBe(true);
  });
});

describe("recordFailedLogin concurrency", () => {
  it("100 parallel failed-login records on same id: exactly threshold succeed", async () => {
    const id = hashIdentifier("alice");
    // Node is single-threaded for sync code; Promise.all on sync work still
    // serializes the bucket map, so we expect exactly DEFAULT_LOCKOUT_THRESHOLD
    // results with locked=false and the rest locked=true.
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        Promise.resolve(recordFailedLogin(limiter, id)),
      ),
    );
    const allowed = results.filter((r) => !r.locked).length;
    const locked = results.filter((r) => r.locked).length;
    expect(allowed).toBe(DEFAULT_LOCKOUT_THRESHOLD);
    expect(locked).toBe(100 - DEFAULT_LOCKOUT_THRESHOLD);
  });
});

describe("resetLockoutForTest", () => {
  it("clears lockout state (test helper)", async () => {
    const id = hashIdentifier("alice");
    for (let i = 0; i < DEFAULT_LOCKOUT_THRESHOLD + 1; i++) {
      await recordFailedLogin(limiter, id);
    }
    expect((await isLocked(limiter, id)).locked).toBe(true);
    resetLockoutForTest(limiter, id);
    expect((await isLocked(limiter, id)).locked).toBe(false);
  });
});
