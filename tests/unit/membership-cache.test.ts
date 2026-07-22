import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import type { Clock } from "../../src/auth/clock.js";
import type { IdPProvider } from "../../src/auth/providers/types.js";
import {
  IdPTokenRevoked,
  IdPTransientError,
  ProviderCapabilityError,
} from "../../src/auth/providers/errors.js";
import {
  MembershipCache,
  type StaleServedEvent,
  type SharedMembershipStore,
} from "../../src/auth/membership-cache.js";

class FakeClock implements Clock {
  constructor(public current = 1_000_000) {}
  now(): number {
    return this.current;
  }
  advance(s: number): void {
    this.current += s;
  }
}

interface FakeBehavior {
  ok?: string[];
  throwTransient?: boolean;
  throwRevoked?: boolean;
  noListMemberships?: boolean;
}

function makeFakeProvider(
  name: string,
  behavior: FakeBehavior,
): IdPProvider & {
  callCount: number;
  setBehavior(b: FakeBehavior): void;
} {
  let current = { ...behavior };
  const stub: IdPProvider & { callCount: number; setBehavior(b: FakeBehavior): void } = {
    name,
    callCount: 0,
    setBehavior(b: FakeBehavior) {
      current = { ...b };
      // Refresh whether listMemberships is defined based on new behavior.
      if (current.noListMemberships) {
        stub.listMemberships = undefined;
      } else {
        stub.listMemberships = async () => {
          stub.callCount++;
          if (current.throwTransient) throw new IdPTransientError();
          if (current.throwRevoked) throw new IdPTokenRevoked();
          return current.ok ?? [];
        };
      }
    },
    buildAuthUrl: () => "https://x",
    exchangeCode: async () => ({
      user: { idp_user_id: "1", email: "a@x" },
      accessToken: "tok",
    }),
    listMemberships: behavior.noListMemberships
      ? undefined
      : async () => {
          stub.callCount++;
          if (current.throwTransient) throw new IdPTransientError();
          if (current.throwRevoked) throw new IdPTokenRevoked();
          return current.ok ?? [];
        },
  };
  return stub;
}

let clock: FakeClock;

beforeEach(() => {
  clock = new FakeClock();
});

describe("MembershipCache.getMemberships", () => {
  it("cache miss: hits provider, stores entry, returns memberships", async () => {
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { ok: ["acme", "widgets"] });
    const result = await cache.getMemberships("user-1", provider, "tok");
    expect(result).toEqual(["acme", "widgets"]);
    expect(provider.callCount).toBe(1);
    expect(cache.metrics.misses).toBe(1);
    expect(cache.metrics.hits).toBe(0);
    expect(cache.size()).toBe(1);
  });

  it("cache hit within 60s: no provider call", async () => {
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { ok: ["acme"] });
    await cache.getMemberships("user-1", provider, "tok");
    clock.advance(59);
    const result = await cache.getMemberships("user-1", provider, "tok");
    expect(result).toEqual(["acme"]);
    expect(provider.callCount).toBe(1);
    expect(cache.metrics.hits).toBe(1);
    expect(cache.metrics.misses).toBe(1);
  });

  it("after 60s positive TTL expired but provider succeeds: refreshes entry", async () => {
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { ok: ["acme"] });
    await cache.getMemberships("user-1", provider, "tok");
    clock.advance(61);
    provider.setBehavior({ ok: ["acme", "newco"] });
    const result = await cache.getMemberships("user-1", provider, "tok");
    expect(result).toEqual(["acme", "newco"]);
    expect(provider.callCount).toBe(2);
    expect(cache.metrics.misses).toBe(2);
    expect(cache.metrics.hits).toBe(0);
  });

  it("IdPTransientError within 10min of cached entry: returns stale + metric + callback", async () => {
    const events: StaleServedEvent[] = [];
    const cache = new MembershipCache(clock, (e) => events.push(e));
    const provider = makeFakeProvider("github", { ok: ["acme"] });
    await cache.getMemberships("user-1", provider, "tok");
    clock.advance(120); // past 60s positive TTL, well within 10min stale window
    provider.setBehavior({ throwTransient: true });
    const result = await cache.getMemberships("user-1", provider, "tok");
    expect(result).toEqual(["acme"]);
    expect(cache.metrics.staleServed).toBe(1);
    expect(events).toEqual([{ userId: "user-1", provider: "github", ageSeconds: 120 }]);
  });

  it("IdPTransientError with no cached entry: re-throws", async () => {
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { throwTransient: true });
    await expect(cache.getMemberships("user-1", provider, "tok")).rejects.toBeInstanceOf(
      IdPTransientError,
    );
    expect(cache.metrics.staleServed).toBe(0);
    expect(cache.size()).toBe(0);
  });

  it("IdPTransientError after STALE_MAX_S: re-throws via application-side age check", async () => {
    // Note: LRU TTL uses wall-clock Date.now() and is NOT driven by the
    // injected FakeClock — so the LRU entry is technically still present
    // here. The application-side `age < STALE_MAX_S` guard in
    // membership-cache.ts is what causes the re-throw. This guard is the
    // authoritative stale-window enforcement; do not remove it trusting LRU.
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { ok: ["acme"] });
    await cache.getMemberships("user-1", provider, "tok");
    clock.advance(601); // past 10min stale window (601 >= STALE_MAX_S=600)
    provider.setBehavior({ throwTransient: true });
    await expect(cache.getMemberships("user-1", provider, "tok")).rejects.toBeInstanceOf(
      IdPTransientError,
    );
    expect(cache.metrics.staleServed).toBe(0);
  });

  it("IdPTokenRevoked: propagates always (no stale fallback)", async () => {
    const events: StaleServedEvent[] = [];
    const cache = new MembershipCache(clock, (e) => events.push(e));
    const provider = makeFakeProvider("github", { ok: ["acme"] });
    await cache.getMemberships("user-1", provider, "tok");
    clock.advance(120);
    provider.setBehavior({ throwRevoked: true });
    await expect(cache.getMemberships("user-1", provider, "tok")).rejects.toBeInstanceOf(
      IdPTokenRevoked,
    );
    expect(cache.metrics.staleServed).toBe(0);
    expect(events).toEqual([]);
  });

  it("provider has no listMemberships: throws ProviderCapabilityError", async () => {
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { noListMemberships: true });
    await expect(cache.getMemberships("user-1", provider, "tok")).rejects.toBeInstanceOf(
      ProviderCapabilityError,
    );
  });

  it("normalizes memberships to lowercase", async () => {
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { ok: ["GitHub", "Acme", "MIXED-Case"] });
    const result = await cache.getMemberships("user-1", provider, "tok");
    expect(result).toEqual(["github", "acme", "mixed-case"]);
  });

  it("cache key includes provider.name: different providers don't collide for same userId", async () => {
    const cache = new MembershipCache(clock);
    const ghProvider = makeFakeProvider("github", { ok: ["acme"] });
    const glProvider = makeFakeProvider("gitlab", { ok: ["other"] });
    const r1 = await cache.getMemberships("user-1", ghProvider, "tok");
    const r2 = await cache.getMemberships("user-1", glProvider, "tok");
    expect(r1).toEqual(["acme"]);
    expect(r2).toEqual(["other"]);
    expect(cache.size()).toBe(2);
    expect(ghProvider.callCount).toBe(1);
    expect(glProvider.callCount).toBe(1);
  });

  it("onStaleServed callback is optional: cache works without it", async () => {
    const cache = new MembershipCache(clock); // no callback
    const provider = makeFakeProvider("github", { ok: ["acme"] });
    await cache.getMemberships("user-1", provider, "tok");
    clock.advance(120);
    provider.setBehavior({ throwTransient: true });
    const result = await cache.getMemberships("user-1", provider, "tok");
    expect(result).toEqual(["acme"]);
    expect(cache.metrics.staleServed).toBe(1);
  });

  it("size() and clear() test helpers work", async () => {
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { ok: ["acme"] });
    expect(cache.size()).toBe(0);
    await cache.getMemberships("user-1", provider, "tok");
    await cache.getMemberships("user-2", provider, "tok");
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("non-IdP error during provider call: propagates without stale fallback", async () => {
    // Defensive: stale-on-error only fires on IdPTransientError. A generic
    // Error must propagate, even when a cached entry exists.
    const events: StaleServedEvent[] = [];
    const cache = new MembershipCache(clock, (e) => events.push(e));
    const provider = makeFakeProvider("github", { ok: ["acme"] });
    await cache.getMemberships("user-1", provider, "tok");
    clock.advance(120);
    // Replace listMemberships with one that throws a generic Error.
    provider.listMemberships = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(cache.getMemberships("user-1", provider, "tok")).rejects.toThrow("boom");
    expect(cache.metrics.staleServed).toBe(0);
    expect(events).toEqual([]);
  });
});

// ── Phase 5 multi-instance: optional shared write-through store ────────────
//
// Hand-mocked store (no live Redis) covering: SETEX write on a fresh miss,
// GET hit (fresh entry served without calling the provider), GET miss
// (falls through to the provider), and best-effort error swallowing on
// both the read and write sides.

class FakeSharedStore implements SharedMembershipStore {
  private map = new Map<string, string>();
  getCalls = 0;
  setexCalls: Array<{ key: string; ttlSeconds: number; value: string }> = [];
  throwOnGet = false;
  throwOnSetex = false;

  async get(key: string): Promise<string | null> {
    this.getCalls++;
    if (this.throwOnGet) throw new Error("shared store unavailable");
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    this.setexCalls.push({ key, ttlSeconds, value });
    if (this.throwOnSetex) throw new Error("shared store unavailable");
    this.map.set(key, value);
  }

  // Test helper: seed a raw entry as another instance would have written it.
  seed(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe("MembershipCache.getMemberships — Phase 5 shared store", () => {
  it("miss with no local/shared entry: hits the provider, then write-through SETEXes the shared store", async () => {
    const shared = new FakeSharedStore();
    const cache = new MembershipCache(clock, undefined, shared);
    const provider = makeFakeProvider("github", { ok: ["acme"] });

    const result = await cache.getMemberships("user-1", provider, "tok");

    expect(result).toEqual(["acme"]);
    expect(provider.callCount).toBe(1);
    expect(cache.metrics.misses).toBe(1);
    // Write-through is fire-and-forget but awaited by the setex Promise
    // resolving synchronously in this fake — give the microtask queue a
    // tick so the un-awaited `void ...setex(...)` call has landed.
    await Promise.resolve();
    expect(shared.setexCalls.length).toBe(1);
    expect(shared.setexCalls[0].ttlSeconds).toBe(60);
    expect(JSON.parse(shared.setexCalls[0].value)).toEqual({
      memberships: ["acme"],
      ts: clock.now(),
    });
  });

  it("local cache miss but a FRESH shared entry exists: returns it, copies into local cache, does NOT call the provider", async () => {
    const shared = new FakeSharedStore();
    const cache = new MembershipCache(clock, undefined, shared);
    const provider = makeFakeProvider("github", { ok: ["should-not-be-used"] });

    // Seed the shared store as another instance's write would look, at the
    // cache's internal key shape: we don't know the sha256 key here, so
    // seed via a first miss on a sibling cache instance sharing the store,
    // then verify THIS cache's fresh read hits it without calling its own
    // provider.
    const writerCache = new MembershipCache(clock, undefined, shared);
    const writerProvider = makeFakeProvider("github", { ok: ["acme"] });
    await writerCache.getMemberships("user-1", writerProvider, "tok");
    await Promise.resolve();
    expect(shared.setexCalls.length).toBe(1);

    const result = await cache.getMemberships("user-1", provider, "tok");

    expect(result).toEqual(["acme"]);
    expect(provider.callCount).toBe(0);
    expect(cache.metrics.hits).toBe(1);
    expect(cache.metrics.misses).toBe(0);
    // Copied into the local LRU so a later stale-on-error has something to
    // serve without going back through the shared store.
    expect(cache.size()).toBe(1);
  });

  it("shared entry exists but is STALE (past the 60s positive TTL): falls through to the provider", async () => {
    const shared = new FakeSharedStore();
    shared.seed(
      cacheKeyFor("user-1", "github"),
      JSON.stringify({ memberships: ["old"], ts: clock.now() - 61 }),
    );
    const cache = new MembershipCache(clock, undefined, shared);
    const provider = makeFakeProvider("github", { ok: ["fresh"] });

    const result = await cache.getMemberships("user-1", provider, "tok");

    expect(result).toEqual(["fresh"]);
    expect(provider.callCount).toBe(1);
    expect(cache.metrics.misses).toBe(1);
  });

  it("shared store GET returns null (miss): falls through to the provider", async () => {
    const shared = new FakeSharedStore();
    const cache = new MembershipCache(clock, undefined, shared);
    const provider = makeFakeProvider("github", { ok: ["acme"] });

    const result = await cache.getMemberships("user-1", provider, "tok");

    expect(shared.getCalls).toBe(1);
    expect(result).toEqual(["acme"]);
    expect(provider.callCount).toBe(1);
  });

  it("shared store GET throws: best-effort — swallowed, falls through to the provider", async () => {
    const shared = new FakeSharedStore();
    shared.throwOnGet = true;
    const cache = new MembershipCache(clock, undefined, shared);
    const provider = makeFakeProvider("github", { ok: ["acme"] });

    const result = await cache.getMemberships("user-1", provider, "tok");

    expect(result).toEqual(["acme"]);
    expect(provider.callCount).toBe(1);
    expect(cache.metrics.misses).toBe(1);
  });

  it("shared store SETEX throws on write-through: swallowed — getMemberships still resolves normally", async () => {
    const shared = new FakeSharedStore();
    shared.throwOnSetex = true;
    const cache = new MembershipCache(clock, undefined, shared);
    const provider = makeFakeProvider("github", { ok: ["acme"] });

    const result = await cache.getMemberships("user-1", provider, "tok");

    expect(result).toEqual(["acme"]);
    await Promise.resolve(); // let the fire-and-forget setex rejection settle
    expect(shared.setexCalls.length).toBe(1);
  });

  it("without a shared store (undefined): getMemberships behaves exactly as single-instance (no get/setex calls)", async () => {
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { ok: ["acme"] });
    const result = await cache.getMemberships("user-1", provider, "tok");
    expect(result).toEqual(["acme"]);
  });
});

// Mirrors MembershipCache's private cacheKey() (sha256 of "userId|providerName")
// so a test can seed the shared store directly under the same key the cache
// computes internally.
function cacheKeyFor(userId: string, providerName: string): string {
  return crypto.createHash("sha256").update(`${userId}|${providerName}`).digest("hex");
}
