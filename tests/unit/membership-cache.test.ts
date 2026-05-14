import { describe, it, expect, beforeEach, vi } from "vitest";
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

function makeFakeProvider(name: string, behavior: FakeBehavior): IdPProvider & {
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
    expect(events).toEqual([
      { userId: "user-1", provider: "github", ageSeconds: 120 },
    ]);
  });

  it("IdPTransientError with no cached entry: re-throws", async () => {
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { throwTransient: true });
    await expect(cache.getMemberships("user-1", provider, "tok"))
      .rejects.toBeInstanceOf(IdPTransientError);
    expect(cache.metrics.staleServed).toBe(0);
    expect(cache.size()).toBe(0);
  });

  it("IdPTransientError after 10min of cached entry: re-throws (cache evicted)", async () => {
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { ok: ["acme"] });
    await cache.getMemberships("user-1", provider, "tok");
    clock.advance(601); // past 10min absolute LRU TTL — entry evicted
    provider.setBehavior({ throwTransient: true });
    await expect(cache.getMemberships("user-1", provider, "tok"))
      .rejects.toBeInstanceOf(IdPTransientError);
    expect(cache.metrics.staleServed).toBe(0);
  });

  it("IdPTokenRevoked: propagates always (no stale fallback)", async () => {
    const events: StaleServedEvent[] = [];
    const cache = new MembershipCache(clock, (e) => events.push(e));
    const provider = makeFakeProvider("github", { ok: ["acme"] });
    await cache.getMemberships("user-1", provider, "tok");
    clock.advance(120);
    provider.setBehavior({ throwRevoked: true });
    await expect(cache.getMemberships("user-1", provider, "tok"))
      .rejects.toBeInstanceOf(IdPTokenRevoked);
    expect(cache.metrics.staleServed).toBe(0);
    expect(events).toEqual([]);
  });

  it("provider has no listMemberships: throws ProviderCapabilityError", async () => {
    const cache = new MembershipCache(clock);
    const provider = makeFakeProvider("github", { noListMemberships: true });
    await expect(cache.getMemberships("user-1", provider, "tok"))
      .rejects.toBeInstanceOf(ProviderCapabilityError);
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
    await expect(cache.getMemberships("user-1", provider, "tok"))
      .rejects.toThrow("boom");
    expect(cache.metrics.staleServed).toBe(0);
    expect(events).toEqual([]);
  });
});
