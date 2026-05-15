import type { TokenSet } from "./types.js";

export interface RefreshStrategy {
  /** Number of milliseconds until the next proactive refresh should fire,
   *  or null if the access token has already expired (refresh now). */
  nextRefreshDelayMs(tokens: TokenSet): number | null;
}

const DEFAULT_LEAD_SECONDS = 120; // 2 minutes
const DEFAULT_JITTER_SECONDS = 30; // +/- 30s

/**
 * Schedules proactive refresh at (accessExpiresAt - leadSeconds +/- jitter).
 * Returns null if the access token has already expired (caller should
 * refresh immediately).
 *
 * The jitter prevents thundering-herd refreshes when many CLI instances
 * are minted from the same TokenSet (e.g., a CI matrix of 100 parallel jobs
 * that all sourced the same vendored tokens.json on day 1, then refresh
 * for the first time on day 30 simultaneously).
 */
export class ProactiveRefresh implements RefreshStrategy {
  constructor(
    private readonly leadSeconds: number = DEFAULT_LEAD_SECONDS,
    private readonly jitterSeconds: number = DEFAULT_JITTER_SECONDS,
    private readonly rng: () => number = Math.random,
  ) {}

  nextRefreshDelayMs(tokens: TokenSet): number | null {
    const nowS = Math.floor(Date.now() / 1000);
    const targetS = tokens.accessExpiresAt - this.leadSeconds;
    const jitterS = (this.rng() * 2 - 1) * this.jitterSeconds; // [-jitter, +jitter]
    const fireAtS = targetS + jitterS;
    const delayMs = (fireAtS - nowS) * 1000;
    if (delayMs <= 0) return null; // refresh immediately
    return Math.floor(delayMs);
  }
}

/** Disable proactive refresh (rely on the client's lazy refresh on the next call). */
export class NoOpRefresh implements RefreshStrategy {
  nextRefreshDelayMs(_tokens: TokenSet): number | null {
    return null;
  }
}
