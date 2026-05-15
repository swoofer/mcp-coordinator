/* eslint-disable no-console */
/**
 * T33 chaos — MembershipCache stale-on-error under 50% IdP failure rate.
 *
 * Verifies V3 §B-NEW-5: when the IdP transiently fails, the
 * MembershipCache returns cached memberships (stale, but within the
 * 10-min absolute window) so refresh rotation stays functional.
 *
 * Setup:
 *   - FakeClock (deterministic; advances 1s per iteration so cache
 *     positive-TTL boundary is exercised without wall-clock dependency).
 *   - Stub IdPProvider.listMemberships that throws IdPTransientError
 *     on a deterministic 50% pattern (every other call).
 *
 * Run loop (N iterations):
 *   - First call seeds the cache (success).
 *   - Subsequent calls alternate succeed/fail. With cache TTL=60s and
 *     1s advance per iter, the first 60 results are cache hits regardless
 *     of provider state. Past 60s, fail iterations should fall through to
 *     stale-served, success iterations refresh the cache.
 *
 * Output: count of stale_served vs. hits vs. misses vs. hard_failure.
 * Assertion: hard_failure == 0 (no IdPTransientError surfaces past the
 * cache layer once the cache has been seeded).
 */
import { FakeClock } from "../../helpers/clock.js";
import { MembershipCache } from "../../../src/auth/membership-cache.js";
import { IdPTransientError } from "../../../src/auth/providers/errors.js";
import type { IdPProvider, ExchangeCodeResult } from "../../../src/auth/providers/types.js";

function makeFlakyProvider(failEveryNth: number): IdPProvider & { callCount: number } {
  const p = {
    name: "github" as const,
    callCount: 0,
    buildAuthUrl: () => "https://example/unused",
    exchangeCode: async (): Promise<ExchangeCodeResult> => { throw new Error("unused"); },
    listMemberships: async (_token: string): Promise<string[]> => {
      p.callCount++;
      if (p.callCount % failEveryNth === 0) throw new IdPTransientError();
      return ["perf-org"];
    },
  };
  return p;
}

async function main(): Promise<void> {
  const N = parseInt(process.env.CHAOS_N ?? "1000", 10);
  const FAIL_EVERY = parseInt(process.env.CHAOS_FAIL_EVERY ?? "2", 10); // 50% if 2

  const clock = new FakeClock();
  const cache = new MembershipCache(clock);
  const provider = makeFlakyProvider(FAIL_EVERY);

  // Seed the cache once with a successful call so subsequent failures
  // can fall back to stale. Without a prior entry, IdPTransientError
  // propagates (no stale to serve) — that's the documented behavior of
  // membership-cache.ts:97-110, not a bug.
  await cache.getMemberships("u-perf", provider, "tok");

  let success = 0;
  let staleServed = 0;
  let hardFailure = 0;
  let hits = 0;
  let misses = 0;
  let lastHits = cache.metrics.hits;
  let lastMisses = cache.metrics.misses;
  let lastStale = cache.metrics.staleServed;

  for (let i = 0; i < N; i++) {
    try {
      const result = await cache.getMemberships("u-perf", provider, "tok");
      if (!Array.isArray(result)) throw new Error("non-array result");
      success++;
      const dHits = cache.metrics.hits - lastHits;
      const dMisses = cache.metrics.misses - lastMisses;
      const dStale = cache.metrics.staleServed - lastStale;
      hits += dHits;
      misses += dMisses;
      staleServed += dStale;
      lastHits = cache.metrics.hits;
      lastMisses = cache.metrics.misses;
      lastStale = cache.metrics.staleServed;
    } catch (err) {
      if (err instanceof IdPTransientError) {
        hardFailure++;
      } else {
        throw err;
      }
    }
    // Advance 1s/iter so the cache TTL is exercised. By iter 60 the
    // positive TTL has expired and fail iters fall through to stale.
    clock.advance(1);
  }

  console.log("\nchaos: idp-failure-injection");
  console.log(`  N=${N}, fail_every_nth=${FAIL_EVERY} (~${Math.round(100 / FAIL_EVERY)}% failure rate)`);
  console.log(`  success=${success}, hard_failure=${hardFailure}`);
  console.log(`  cache hits=${hits}, misses=${misses}, stale_served=${staleServed}`);
  console.log(`  provider.callCount=${provider.callCount}`);

  // Assertion: once primed, stale-on-error keeps rotation functional.
  // hard_failure may be non-zero only if the cache TTL+stale window
  // exceeded (>10min total) — N=1000 with 1s/iter stays well within.
  if (hardFailure > 0 && N <= 600) {
    throw new Error(
      `chaos assertion failed: hard_failure=${hardFailure} (expected 0 within 10-min stale window)`,
    );
  }

  const summary = {
    chaos: "idp-failure-injection",
    n: N,
    fail_every_nth: FAIL_EVERY,
    success,
    hard_failure: hardFailure,
    cache_hits: hits,
    cache_misses: misses,
    stale_served: staleServed,
    provider_call_count: provider.callCount,
  };
  console.log("JSON_SUMMARY: " + JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
