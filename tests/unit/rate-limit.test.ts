import { describe, it, expect, beforeEach } from "vitest";
import type { Clock } from "../../src/auth/clock.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";

// FakeClock mirrors T04/T06 — deterministic time for refill math.
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

describe("RateLimiter.check", () => {
  it("fresh bucket: first check returns allowed with remaining=per-1", () => {
    const r = limiter.check("k", { per: 3, window_seconds: 60 });
    expect(r.allowed).toBe(true);
    if (r.allowed) {
      expect(r.remaining).toBe(2);
      expect(r.reset_at).toBe(clock.now() + 60);
    }
  });

  it("exhausts the bucket: 4th call with per=3 returns not allowed", () => {
    const cfg = { per: 3, window_seconds: 60 };
    expect(limiter.check("k", cfg).allowed).toBe(true);
    expect(limiter.check("k", cfg).allowed).toBe(true);
    expect(limiter.check("k", cfg).allowed).toBe(true);
    const r = limiter.check("k", cfg);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.retry_after_seconds).toBeGreaterThanOrEqual(1);
    }
  });

  it("refills after full window passes", () => {
    const cfg = { per: 2, window_seconds: 60 };
    limiter.check("k", cfg);
    limiter.check("k", cfg);
    expect(limiter.check("k", cfg).allowed).toBe(false);
    clock.advance(60);
    expect(limiter.check("k", cfg).allowed).toBe(true);
  });

  it("partial refill: after half window, ~half tokens are restored", () => {
    const cfg = { per: 4, window_seconds: 60 };
    // Drain to 0
    limiter.check("k", cfg);
    limiter.check("k", cfg);
    limiter.check("k", cfg);
    limiter.check("k", cfg);
    expect(limiter.check("k", cfg).allowed).toBe(false);
    // refill rate = 4/60 ≈ 0.0667/s; after 30s, +2 tokens
    clock.advance(30);
    const r1 = limiter.check("k", cfg);
    const r2 = limiter.check("k", cfg);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    // 3rd should fail again (only ~2 tokens were refilled)
    expect(limiter.check("k", cfg).allowed).toBe(false);
  });

  it("multiple keys are independent", () => {
    const cfg = { per: 1, window_seconds: 60 };
    expect(limiter.check("a", cfg).allowed).toBe(true);
    expect(limiter.check("a", cfg).allowed).toBe(false);
    // "b" is untouched — should still get its full bucket.
    expect(limiter.check("b", cfg).allowed).toBe(true);
  });

  it("retry_after_seconds is sane for per=1, window=60", () => {
    const cfg = { per: 1, window_seconds: 60 };
    limiter.check("k", cfg);
    const r = limiter.check("k", cfg);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      // refill rate 1/60 per s → need 60s for next token
      expect(r.retry_after_seconds).toBeGreaterThanOrEqual(59);
      expect(r.retry_after_seconds).toBeLessThanOrEqual(61);
    }
  });

  it("retry_after_seconds is always >= 1 even at edge", () => {
    // With per=100, window_seconds=1 → refill rate 100/s. After draining
    // and advancing time so tokens approach 1, retry should still floor to 1.
    const cfg = { per: 100, window_seconds: 1 };
    for (let i = 0; i < 100; i++) limiter.check("k", cfg);
    const r = limiter.check("k", cfg);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.retry_after_seconds).toBeGreaterThanOrEqual(1);
    }
  });

  it("bucket expiry resets state when expires_at < now", () => {
    const cfg = { per: 1, window_seconds: 60 };
    limiter.check("k", cfg);
    expect(limiter.check("k", cfg).allowed).toBe(false);
    // Advance past expires_at — next check should treat bucket as fresh.
    clock.advance(120);
    const r = limiter.check("k", cfg);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBe(0);
  });
});

describe("RateLimiter.peek", () => {
  it("peek does NOT consume tokens", () => {
    const cfg = { per: 3, window_seconds: 60 };
    limiter.peek("k", cfg);
    limiter.peek("k", cfg);
    // Still 3 tokens available — three checks should all succeed.
    expect(limiter.check("k", cfg).allowed).toBe(true);
    expect(limiter.check("k", cfg).allowed).toBe(true);
    expect(limiter.check("k", cfg).allowed).toBe(true);
    expect(limiter.check("k", cfg).allowed).toBe(false);
  });

  it("peek on fresh key returns allowed=true, remaining=per, no bucket created", () => {
    const cfg = { per: 5, window_seconds: 60 };
    const r = limiter.peek("fresh", cfg);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBe(5);
    expect(limiter.size()).toBe(0);
  });

  it("peek reports locked after drain (matches check semantics)", () => {
    const cfg = { per: 1, window_seconds: 60 };
    limiter.check("k", cfg);
    const r = limiter.peek("k", cfg);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.retry_after_seconds).toBeGreaterThanOrEqual(1);
  });

  it("peek on existing partially-drained bucket returns remaining without consuming", () => {
    const cfg = { per: 3, window_seconds: 60 };
    limiter.check("k", cfg); // bucket exists, tokens = 2
    const r = limiter.peek("k", cfg);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBe(2);
    // Peek again — still 2 remaining (no consumption).
    const r2 = limiter.peek("k", cfg);
    expect(r2.allowed).toBe(true);
    if (r2.allowed) expect(r2.remaining).toBe(2);
  });

  it("peek treats expired bucket as fresh", () => {
    const cfg = { per: 1, window_seconds: 60 };
    limiter.check("k", cfg);
    clock.advance(120);
    const r = limiter.peek("k", cfg);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBe(1);
  });
});

describe("RateLimiter.sweep + reset + size", () => {
  it("sweep removes expired buckets and returns count", () => {
    const cfg = { per: 1, window_seconds: 60 };
    limiter.check("a", cfg);
    limiter.check("b", cfg);
    expect(limiter.size()).toBe(2);
    clock.advance(120);
    const removed = limiter.sweep();
    expect(removed).toBe(2);
    expect(limiter.size()).toBe(0);
  });

  it("sweep does not remove active buckets", () => {
    const cfg = { per: 1, window_seconds: 60 };
    limiter.check("a", cfg);
    clock.advance(30);
    const removed = limiter.sweep();
    expect(removed).toBe(0);
    expect(limiter.size()).toBe(1);
  });

  it("reset clears all buckets", () => {
    const cfg = { per: 1, window_seconds: 60 };
    limiter.check("a", cfg);
    limiter.check("b", cfg);
    expect(limiter.size()).toBe(2);
    limiter.reset();
    expect(limiter.size()).toBe(0);
  });
});
