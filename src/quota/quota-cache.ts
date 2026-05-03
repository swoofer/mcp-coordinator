// Coordinator-side quota cache with hybrid refresh:
//
// - "lazy":       a consumer requesting /api/quota while the cache is stale
//                 triggers a refresh on that call (single-flight-deduped so
//                 simultaneous requesters share the same in-flight fetch).
// - "background": when at least one agent is registered as active, a timer
//                 pre-refreshes the cache every TTL seconds so consumers
//                 always see fresh data without paying the Anthropic latency.
//
// When the credential reader throws NotImplementedError (non-macOS platforms
// pre-impl) or the API is down, getCachedQuota() returns null and the HTTP
// layer surfaces that as 503 — the consumer treats "unknown" as "continue",
// per the project decision to fail-open on quota checks.

import type { CredentialReader } from "./credential-reader.js";
import { createCredentialReader } from "./credential-reader.js";
import { fetchQuotaFromAnthropic, QuotaUnavailableError, type QuotaInfo } from "./quota.js";
import type { Logger } from "../logger.js";

// 2 min — the quota endpoint moves in percentage points, not token counts, so
// sub-minute freshness is overkill. Lower values caused Anthropic to 429 the
// endpoint itself when several agents were online at once.
export const DEFAULT_TTL_MS = 120_000;
// Anthropic rate-limits the /api/oauth/usage endpoint itself. When we get 429,
// we stop hammering and wait this long (or the server-provided Retry-After)
// before attempting again. 5 min is a comfortable default for a usage endpoint
// that only moves in %, not token counts — we don't need sub-minute freshness.
const DEFAULT_429_COOLDOWN_MS = 5 * 60_000;
const MIN_429_COOLDOWN_MS = 60_000;

export interface QuotaCacheOptions {
  ttlMs?: number;
  reader?: CredentialReader;
  logger?: Logger;
  /**
   * Injected for tests so we don't hit network. Defaults to the real
   * Anthropic fetcher.
   */
  fetcher?: (reader: CredentialReader) => Promise<QuotaInfo>;
  /**
   * Notified every time a refresh produces a new QuotaInfo. The server wires
   * this to MQTT + SSE so dashboards see live updates.
   */
  onRefresh?: (info: QuotaInfo) => void;
}

export interface QuotaCacheStatus {
  /** Last fetched info, or null if never successfully fetched. */
  info: QuotaInfo | null;
  /** True when the last fetch attempt threw (Keychain / network / parse). */
  unavailable: boolean;
  /** Most recent failure reason, for debug. */
  lastError: string | null;
  /** Number of agents currently registered as active (drives background refresh). */
  activeAgents: number;
  ttlMs: number;
  /**
   * When > now, the cache is in a 429 cool-down — it refuses to hit the
   * Anthropic usage API until this time passes. Surfaced so the HTTP layer
   * can explain the delay to the user instead of showing a generic 503.
   */
  cooldownUntil: number | null;
}

/**
 * Returns true if the cached info is still within TTL. Pure function so
 * callers can decide cache freshness without touching the cache instance.
 */
export function isFresh(info: QuotaInfo | null, ttlMs: number, now: number = Date.now()): boolean {
  if (!info) return false;
  return now - info.fetchedAt < ttlMs;
}

export class QuotaCache {
  private info: QuotaInfo | null = null;
  private lastError: string | null = null;
  private refreshInFlight: Promise<QuotaInfo | null> | null = null;
  private activeAgents = 0;
  private backgroundTimer: NodeJS.Timeout | null = null;
  private cooldownUntil = 0;
  private readonly ttlMs: number;
  private readonly reader: CredentialReader;
  private readonly logger: Logger | undefined;
  private readonly fetcher: (reader: CredentialReader) => Promise<QuotaInfo>;
  private readonly onRefresh: ((info: QuotaInfo) => void) | undefined;

  constructor(opts: QuotaCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.reader = opts.reader ?? createCredentialReader();
    this.logger = opts.logger;
    this.fetcher = opts.fetcher ?? fetchQuotaFromAnthropic;
    this.onRefresh = opts.onRefresh;
  }

  /**
   * Returns the cached QuotaInfo if fresh, otherwise triggers a refresh and
   * returns the new value. Returns null when fetching fails (fail-open path).
   * Concurrent calls share a single in-flight fetch.
   */
  async get(): Promise<QuotaInfo | null> {
    if (isFresh(this.info, this.ttlMs)) return this.info;
    return this.refresh();
  }

  /**
   * Returns the cached value synchronously, even if stale or missing. Used
   * by the HTTP handler to decide 200 vs 503 without awaiting a refresh.
   */
  snapshot(): QuotaCacheStatus {
    return {
      info: this.info,
      unavailable: this.info === null && this.lastError !== null,
      lastError: this.lastError,
      activeAgents: this.activeAgents,
      ttlMs: this.ttlMs,
      cooldownUntil: this.cooldownUntil > Date.now() ? this.cooldownUntil : null,
    };
  }

  /**
   * Force a refresh now. Returns the new value or null on failure. Subsequent
   * concurrent callers share the same in-flight promise so we never issue
   * parallel Anthropic calls for the same refresh window. During a 429
   * cool-down we short-circuit to the cached value (possibly null) without
   * hitting the API — keeps us from hammering an endpoint that's already
   * pushing back.
   */
  async refresh(): Promise<QuotaInfo | null> {
    if (Date.now() < this.cooldownUntil) {
      this.logger?.debug({ cooldown_ms_remaining: this.cooldownUntil - Date.now() }, "quota refresh skipped — 429 cool-down active");
      return this.info;
    }
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh()
      .finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<QuotaInfo | null> {
    try {
      const info = await this.fetcher(this.reader);
      this.info = info;
      this.lastError = null;
      this.cooldownUntil = 0;
      this.logger?.debug({ five_hour: info.fiveHour.utilization, seven_day: info.sevenDay.utilization }, "quota refreshed");
      this.onRefresh?.(info);
      return info;
    } catch (err) {
      const msg = err instanceof QuotaUnavailableError ? err.message : (err as Error).message;
      this.lastError = msg;

      // 429 = Anthropic itself is rate-limiting the usage endpoint. Back off
      // to avoid making it worse — respect Retry-After when provided,
      // otherwise apply a 5-minute cool-down. MIN_429_COOLDOWN_MS prevents
      // Retry-After spoofing / zero values from letting us spam.
      if (err instanceof QuotaUnavailableError && err.httpStatus === 429) {
        const suggestedMs = err.retryAfterSeconds !== undefined
          ? err.retryAfterSeconds * 1000
          : DEFAULT_429_COOLDOWN_MS;
        const cooldownMs = Math.max(suggestedMs, MIN_429_COOLDOWN_MS);
        this.cooldownUntil = Date.now() + cooldownMs;
        this.logger?.warn({ cooldown_ms: cooldownMs }, "quota 429 — backing off");
      } else if (this.info === null) {
        // First-ever fetch failed for some other reason — warn once.
        this.logger?.warn({ err: msg }, "quota fetch failed — consumers will see 503");
      } else {
        this.logger?.debug({ err: msg }, "quota refresh failed — serving stale cache");
      }
      return null;
    }
  }

  /**
   * Call when an agent connects so the background tick keeps the cache warm
   * during an active run. Multiple calls without a matching decrement are
   * idempotent above 0 — the tick runs whenever activeAgents > 0.
   */
  onAgentActive(): void {
    this.activeAgents++;
    if (this.backgroundTimer === null) this.startBackgroundTick();
  }

  /**
   * Call when an agent disconnects so the background tick stops when the
   * coordinator goes idle — no point re-fetching if nobody will read it.
   */
  onAgentInactive(): void {
    if (this.activeAgents > 0) this.activeAgents--;
    if (this.activeAgents === 0) this.stopBackgroundTick();
  }

  /**
   * Stop the timer so process teardown doesn't leak. Safe to call multiple
   * times. The next onAgentActive() will restart it.
   */
  stopBackgroundTick(): void {
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  }

  private startBackgroundTick(): void {
    // Kick off one refresh immediately so the first consumer after a cold
    // start doesn't eat the network latency.
    void this.refresh();
    this.backgroundTimer = setInterval(() => {
      // Skip the tick if we have no agents — onAgentInactive will stop us,
      // but belt-and-suspenders in case counting goes wrong.
      if (this.activeAgents === 0) return;
      void this.refresh();
    }, this.ttlMs);
    // Don't keep the event loop alive just for the tick.
    if (typeof this.backgroundTimer.unref === "function") this.backgroundTimer.unref();
  }
}
