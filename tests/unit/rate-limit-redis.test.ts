import { describe, it, expect, beforeEach } from "vitest";
import type { Clock } from "../../src/auth/clock.js";
import { RedisRateLimiter } from "../../src/auth/rate-limit-redis.js";
import type { RedisClient } from "../../src/infra/redis.js";

class FakeClock implements Clock {
  constructor(public current = 1_000_000) {}
  now(): number {
    return this.current;
  }
  advance(s: number): void {
    this.current += s;
  }
}

/**
 * Hand-mocked node-redis-style client covering exactly the surface
 * RedisRateLimiter uses: eval (the INCR+EXPIRE Lua), get, ttl,
 * scanIterator, del. Values are stored in a plain Map so window/TTL
 * semantics can be asserted deterministically without a live Redis.
 */
class FakeRedisClient {
  private store = new Map<string, { count: number; expiresAtTick: number | null }>();
  public tick = 0;
  public evalError: unknown = null;

  async eval(
    _script: string,
    opts: { keys: string[]; arguments: string[] },
  ): Promise<[number, number]> {
    if (this.evalError) throw this.evalError;
    const key = opts.keys[0];
    const windowSeconds = Number(opts.arguments[0]);
    let entry = this.store.get(key);
    if (!entry) {
      entry = { count: 0, expiresAtTick: null };
      this.store.set(key, entry);
    }
    entry.count += 1;
    if (entry.count === 1) {
      entry.expiresAtTick = this.tick + windowSeconds;
    }
    let ttl = entry.expiresAtTick === null ? -1 : entry.expiresAtTick - this.tick;
    if (ttl < 0) {
      entry.expiresAtTick = this.tick + windowSeconds;
      ttl = windowSeconds;
    }
    return [entry.count, ttl];
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    return entry ? String(entry.count) : null;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAtTick === null) return -2;
    return Math.max(-1, entry.expiresAtTick - this.tick);
  }

  async del(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.store.delete(k)) n++;
    }
    return n;
  }

  async *scanIterator(_opts: { MATCH: string; COUNT: number }): AsyncGenerator<string[]> {
    yield Array.from(this.store.keys());
  }
}

let clock: FakeClock;
let client: FakeRedisClient;
let limiter: RedisRateLimiter;

beforeEach(() => {
  clock = new FakeClock();
  client = new FakeRedisClient();
  limiter = new RedisRateLimiter(client as unknown as RedisClient, clock);
});

describe("RedisRateLimiter.check", () => {
  it("first hit sets the expiry window and allows", async () => {
    const r = await limiter.check("k1", { per: 3, window_seconds: 60 });
    expect(r.allowed).toBe(true);
    if (r.allowed) {
      expect(r.remaining).toBe(2);
      expect(r.reset_at).toBe(clock.now() + 60);
    }
  });

  it("increments the count on each subsequent hit within the window", async () => {
    const cfg = { per: 3, window_seconds: 60 };
    const r1 = await limiter.check("k1", cfg);
    const r2 = await limiter.check("k1", cfg);
    const r3 = await limiter.check("k1", cfg);
    expect(r1.allowed && r1.remaining).toBe(2);
    expect(r2.allowed && r2.remaining).toBe(1);
    expect(r3.allowed && r3.remaining).toBe(0);
  });

  it("denies once the count exceeds `per`, with a positive retry_after_seconds", async () => {
    const cfg = { per: 2, window_seconds: 60 };
    await limiter.check("k1", cfg);
    await limiter.check("k1", cfg);
    const third = await limiter.check("k1", cfg);
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.retry_after_seconds).toBeGreaterThan(0);
    }
  });

  it("fails open (allows) when the underlying client throws", async () => {
    const cfg = { per: 1, window_seconds: 60 };
    // Exhaust the limit first so we know a real check would deny.
    await limiter.check("k1", cfg);
    await limiter.check("k1", cfg); // now over limit

    client.evalError = new Error("ECONNREFUSED");
    let seenErr: unknown = null;
    const failingLimiter = new RedisRateLimiter(client as unknown as RedisClient, clock, (err) => {
      seenErr = err;
    });
    const result = await failingLimiter.check("k1", cfg);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.remaining).toBe(cfg.per);
    }
    expect(seenErr).toBeInstanceOf(Error);
  });
});

describe("RedisRateLimiter.peek", () => {
  it("returns allowed=true with full remaining on an untouched key", async () => {
    const r = await limiter.peek("fresh", { per: 5, window_seconds: 60 });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBe(5);
  });

  it("does not consume — repeated peeks report the same state", async () => {
    const cfg = { per: 3, window_seconds: 60 };
    await limiter.check("k1", cfg); // count=1
    const p1 = await limiter.peek("k1", cfg);
    const p2 = await limiter.peek("k1", cfg);
    expect(p1).toEqual(p2);
    expect(p1.allowed && p1.remaining).toBe(2);
  });

  it("reports denied once count reaches `per`", async () => {
    const cfg = { per: 1, window_seconds: 60 };
    await limiter.check("k1", cfg); // count=1, at limit
    const p = await limiter.peek("k1", cfg);
    expect(p.allowed).toBe(false);
  });

  it("fails open on client error", async () => {
    client.evalError = new Error("down"); // affects eval, but peek uses get/ttl
    // Force get/ttl to throw instead by monkey-patching.
    (client as unknown as { get: () => Promise<string> }).get = () => {
      throw new Error("down");
    };
    const cfg = { per: 1, window_seconds: 60 };
    const r = await limiter.peek("k1", cfg);
    expect(r.allowed).toBe(true);
  });
});

describe("RedisRateLimiter.sweep", () => {
  it("is a no-op returning 0 (Redis TTLs expire keys natively)", () => {
    expect(limiter.sweep()).toBe(0);
  });
});

describe("RedisRateLimiter.size / reset", () => {
  it("size counts keys under the limiter prefix via scanIterator", async () => {
    const cfg = { per: 5, window_seconds: 60 };
    await limiter.check("a", cfg);
    await limiter.check("b", cfg);
    expect(await limiter.size()).toBe(2);
  });

  it("reset deletes all limiter keys, after which size is 0 and checks start fresh", async () => {
    const cfg = { per: 1, window_seconds: 60 };
    await limiter.check("a", cfg);
    await limiter.check("b", cfg);
    expect(await limiter.size()).toBe(2);

    await limiter.reset();
    expect(await limiter.size()).toBe(0);

    const r = await limiter.check("a", cfg);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBe(0);
  });
});
