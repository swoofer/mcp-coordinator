import { LRUCache } from "lru-cache";
import crypto from "node:crypto";
import type { Clock } from "./clock.js";
import type { IdPProvider } from "./providers/types.js";
import {
  IdPTransientError,
  ProviderCapabilityError,
} from "./providers/errors.js";

export interface MembershipCacheEntry {
  memberships: string[]; // lowercase org logins
  ts: number; // seconds since epoch
}

export interface MembershipCacheMetrics {
  readonly hits: number;
  readonly misses: number;
  readonly staleServed: number;
}

export interface StaleServedEvent {
  userId: string;
  provider: string;
  ageSeconds: number;
}

// 60s positive TTL: within this window cache is authoritative.
// 10min absolute LRU lifetime: beyond positive TTL we still keep the entry
// available so stale-on-error can serve it during transient IdP outages.
// Setting LRU `ttl` to STALE_MAX_S (not POSITIVE_TTL_S) is essential —
// otherwise the LRU evicts after 60s and stale-on-error has nothing to serve.
const POSITIVE_TTL_S = 60;
const STALE_MAX_S = 600;
const CACHE_CAPACITY = 10_000;

/**
 * Caches IdP `listMemberships` results per (user_id, provider) for 60s.
 * On IdPTransientError within a 10-minute stale window, returns cached
 * memberships and invokes the onStaleServed callback (used by callers
 * to emit Tier 2 audit `auth.idp.stale_served` and increment metrics).
 *
 * The cache stores ONLY normalized lowercase memberships; raw IdP
 * org names are case-preserved by upstream APIs but Phase 2 uses
 * lowercase as canonical form for allowlist comparison (T09).
 */
export class MembershipCache {
  private cache: LRUCache<string, MembershipCacheEntry>;
  // Internal mutable counters. Exposed publicly via `metrics` typed as the
  // readonly MembershipCacheMetrics interface so external consumers cannot
  // corrupt audit-relevant fields (e.g. `cache.metrics.hits = 0`).
  private _metrics = { hits: 0, misses: 0, staleServed: 0 };
  get metrics(): MembershipCacheMetrics {
    return this._metrics;
  }

  constructor(
    private clock: Clock,
    private onStaleServed?: (e: StaleServedEvent) => void,
  ) {
    this.cache = new LRUCache<string, MembershipCacheEntry>({
      max: CACHE_CAPACITY,
      ttl: STALE_MAX_S * 1000, // 10 min absolute — positive-vs-stale decided by entry.ts
    });
  }

  /**
   * Look up memberships for (userId, provider). Calls provider.listMemberships
   * on cache miss. Returns cached on IdPTransientError within stale window.
   * Propagates IdPTokenRevoked (no stale).
   *
   * Throws ProviderCapabilityError if the provider didn't implement listMemberships.
   */
  async getMemberships(
    userId: string,
    provider: IdPProvider,
    accessToken: string,
  ): Promise<string[]> {
    const key = this.cacheKey(userId, provider.name);
    const cached = this.cache.get(key);
    const now = this.clock.now();

    if (cached && (now - cached.ts) < POSITIVE_TTL_S) {
      this._metrics.hits++;
      return cached.memberships;
    }

    if (!provider.listMemberships) {
      throw new ProviderCapabilityError("listMemberships");
    }

    try {
      const raw = await provider.listMemberships(accessToken);
      const memberships = raw.map((s) => s.toLowerCase());
      this.cache.set(key, { memberships, ts: now });
      this._metrics.misses++;
      return memberships;
    } catch (err) {
      if (err instanceof IdPTransientError && cached) {
        const age = now - cached.ts;
        // Authoritative stale-window check. LRU TTL uses wall-clock Date.now()
        // and is NOT driven by the injected Clock; this application-side guard
        // is the sole enforcement mechanism for the 10-minute stale boundary.
        if (age < STALE_MAX_S) {
          this._metrics.staleServed++;
          this.onStaleServed?.({ userId, provider: provider.name, ageSeconds: age });
          return cached.memberships;
        }
      }
      throw err;
    }
  }

  /** Test helper: clear all entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Test helper: get cache size. */
  size(): number {
    return this.cache.size;
  }

  private cacheKey(userId: string, providerName: string): string {
    return crypto.createHash("sha256")
      .update(`${userId}|${providerName}`)
      .digest("hex");
  }
}
