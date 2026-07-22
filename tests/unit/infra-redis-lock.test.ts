import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { acquireLock, releaseLock, withLock } from "../../src/infra/redis.js";
import type { RedisClient } from "../../src/infra/redis.js";

/**
 * Hand-mocked node-redis-style client covering exactly the surface the
 * lock helpers use: set (NX/EX), get, eval (the compare-and-delete Lua).
 * No live Redis, no timers.
 */
class FakeRedisClient {
  private store = new Map<string, string>();

  async set(
    key: string,
    value: string,
    opts?: { NX?: boolean; EX?: number },
  ): Promise<string | null> {
    if (opts?.NX && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async expire(_key: string, _ttl: number): Promise<boolean> {
    return true;
  }

  /** Mirrors RELEASE_LUA: compare-and-delete. */
  async eval(_script: string, opts: { keys: string[]; arguments: string[] }): Promise<number> {
    const [key] = opts.keys;
    const [owner] = opts.arguments;
    if (this.store.get(key) === owner) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  // Test helper, not part of the real RedisClient surface.
  _peek(key: string): string | undefined {
    return this.store.get(key);
  }
}

let client: FakeRedisClient;

beforeEach(() => {
  client = new FakeRedisClient();
});

describe("acquireLock", () => {
  it("returns true when the key is free (SET NX succeeds)", async () => {
    const ok = await acquireLock(client as unknown as RedisClient, "lock:a", 30, "owner-1");
    expect(ok).toBe(true);
    expect(client._peek("lock:a")).toBe("owner-1");
  });

  it("returns false when the key is already held by another owner (SET NX fails)", async () => {
    await acquireLock(client as unknown as RedisClient, "lock:a", 30, "owner-1");
    const ok = await acquireLock(client as unknown as RedisClient, "lock:a", 30, "owner-2");
    expect(ok).toBe(false);
    // Original owner's value is untouched.
    expect(client._peek("lock:a")).toBe("owner-1");
  });

  it("returns false even for the same owner re-acquiring (SET NX has no owner-aware retry)", async () => {
    await acquireLock(client as unknown as RedisClient, "lock:a", 30, "owner-1");
    const ok = await acquireLock(client as unknown as RedisClient, "lock:a", 30, "owner-1");
    expect(ok).toBe(false);
  });
});

describe("releaseLock", () => {
  it("deletes the key when the owner token matches", async () => {
    await acquireLock(client as unknown as RedisClient, "lock:a", 30, "owner-1");
    await releaseLock(client as unknown as RedisClient, "lock:a", "owner-1");
    expect(client._peek("lock:a")).toBeUndefined();
  });

  it("does NOT delete the key when the owner token does not match (lost the lock to a TTL expiry + another holder)", async () => {
    await acquireLock(client as unknown as RedisClient, "lock:a", 30, "owner-1");
    // Simulate our TTL expiring and someone else taking the lock.
    await client.set("lock:a", "owner-2");
    await releaseLock(client as unknown as RedisClient, "lock:a", "owner-1");
    expect(client._peek("lock:a")).toBe("owner-2");
  });

  it("is a no-op (does not throw) when the key does not exist", async () => {
    await expect(
      releaseLock(client as unknown as RedisClient, "lock:missing", "owner-1"),
    ).resolves.toBeUndefined();
  });

  it("swallows eval errors (best-effort release; TTL is the backstop)", async () => {
    const throwingClient = {
      set: client.set.bind(client),
      get: client.get.bind(client),
      expire: client.expire.bind(client),
      eval: async () => {
        throw new Error("connection lost");
      },
    };
    await expect(
      releaseLock(throwingClient as unknown as RedisClient, "lock:a", "owner-1"),
    ).resolves.toBeUndefined();
  });
});

describe("withLock", () => {
  it("acquires the lock, runs the body, and releases it on success", async () => {
    let ranBody = false;
    const result = await withLock(
      client as unknown as RedisClient,
      "lock:crit",
      30,
      "owner-1",
      async () => {
        ranBody = true;
        // Lock must be held while the body runs.
        expect(client._peek("lock:crit")).toBe("owner-1");
        return 42;
      },
    );
    expect(ranBody).toBe(true);
    expect(result).toBe(42);
    // Released after the body completes.
    expect(client._peek("lock:crit")).toBeUndefined();
  });

  it("releases the lock even when the body throws", async () => {
    await expect(
      withLock(client as unknown as RedisClient, "lock:crit", 30, "owner-1", () => {
        throw new Error("body blew up");
      }),
    ).rejects.toThrow("body blew up");
    expect(client._peek("lock:crit")).toBeUndefined();
  });

  describe("retry loop (fake timers — no real waiting)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("waits and retries when the lock is initially held, then succeeds once it frees", async () => {
      await acquireLock(client as unknown as RedisClient, "lock:crit", 30, "owner-other");

      const promise = withLock(
        client as unknown as RedisClient,
        "lock:crit",
        30,
        "owner-1",
        () => "acquired",
        { retryMs: 100, maxWaitMs: 5_000 },
      );

      // Let the first (failing) acquire attempt run, then free the
      // competing lock before the retry timer fires.
      await vi.advanceTimersByTimeAsync(0);
      await releaseLock(client as unknown as RedisClient, "lock:crit", "owner-other");
      await vi.advanceTimersByTimeAsync(100);

      await expect(promise).resolves.toBe("acquired");
      // withLock released its own lock after the body ran.
      expect(client._peek("lock:crit")).toBeUndefined();
    });

    it("times out and throws if the lock is never freed within maxWaitMs", async () => {
      await acquireLock(client as unknown as RedisClient, "lock:crit", 30, "owner-other");

      const promise = withLock(
        client as unknown as RedisClient,
        "lock:crit",
        30,
        "owner-1",
        () => "unreachable",
        { retryMs: 10, maxWaitMs: 5 },
      );
      const assertion = expect(promise).rejects.toThrow(/Timed out waiting for lock/);
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
    });
  });
});
