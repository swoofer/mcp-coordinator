import type { Clock } from "./clock.js";

export interface RateLimitConfig {
  /** Max tokens (capacity of the bucket). */
  per: number;
  /** Refill window in seconds. Full refill takes this duration. */
  window_seconds: number;
}

export type RateLimitResult =
  | { allowed: true; remaining: number; reset_at: number }
  | { allowed: false; retry_after_seconds: number };

interface BucketState {
  tokens: number;
  last_refill: number;
  expires_at: number;
}

/**
 * In-memory token-bucket rate limiter, single-instance (Phase 2).
 *
 * Refill model: bucket starts full ({@link RateLimitConfig.per} tokens).
 * Each `check` call consumes 1 token if available; refill rate is
 * `per / window_seconds` tokens per second. `sweep()` evicts buckets
 * whose absolute lifetime expired; `startSweeper()` wires it to a periodic
 * timer (performance-06) so callers don't have to invoke it manually.
 *
 * Phase 5 multi-instance: swap to Redis-backed limiter via DI; this
 * interface stays unchanged.
 */
export class RateLimiter {
  private buckets = new Map<string, BucketState>();
  private sweeperHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly clock: Clock) {}

  /** Check + consume one token. Returns whether the call is allowed. */
  check(key: string, cfg: RateLimitConfig): RateLimitResult {
    const now = this.clock.now();
    const refillRate = cfg.per / cfg.window_seconds;

    let bucket = this.buckets.get(key);
    if (!bucket || bucket.expires_at < now) {
      bucket = {
        tokens: cfg.per,
        last_refill: now,
        expires_at: now + cfg.window_seconds,
      };
      this.buckets.set(key, bucket);
    }

    // Refill: top up tokens proportional to elapsed time, capped at capacity.
    // This is what makes the bucket "token-bucket" vs "fixed window" — partial
    // refill lets bursts smooth out instead of cliff-edging at window roll.
    const elapsed = now - bucket.last_refill;
    if (elapsed > 0) {
      bucket.tokens = Math.min(cfg.per, bucket.tokens + elapsed * refillRate);
      bucket.last_refill = now;
    }
    bucket.expires_at = now + cfg.window_seconds;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        reset_at: now + cfg.window_seconds,
      };
    }

    const retry_after_seconds = Math.max(
      1,
      Math.ceil((1 - bucket.tokens) / refillRate),
    );
    return { allowed: false, retry_after_seconds };
  }

  /**
   * Peek at a bucket's allowed state WITHOUT consuming a token. Used by
   * login-lockout `isLocked()` to check whether the next failure would
   * exceed the threshold, and by metrics exporters that want the current
   * remaining count.
   */
  peek(key: string, cfg: RateLimitConfig): RateLimitResult {
    const now = this.clock.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.expires_at < now) {
      return {
        allowed: true,
        remaining: cfg.per,
        reset_at: now + cfg.window_seconds,
      };
    }
    // Apply refill projection without writing back.
    const refillRate = cfg.per / cfg.window_seconds;
    const elapsed = now - bucket.last_refill;
    const tokens = Math.min(
      cfg.per,
      bucket.tokens + Math.max(0, elapsed) * refillRate,
    );

    if (tokens >= 1) {
      return {
        allowed: true,
        remaining: Math.floor(tokens),
        reset_at: now + cfg.window_seconds,
      };
    }
    const retry_after_seconds = Math.max(
      1,
      Math.ceil((1 - tokens) / refillRate),
    );
    return { allowed: false, retry_after_seconds };
  }

  /**
   * Sweep expired buckets. Returns number of entries deleted. Callers may
   * invoke on any cadence; {@link startSweeper} wires this to a periodic
   * timer (performance-06 — this used to be a phantom guard: the method
   * existed but nothing ever called it, so `buckets` grew unbounded).
   */
  sweep(): number {
    const now = this.clock.now();
    let deleted = 0;
    for (const [key, b] of this.buckets.entries()) {
      if (b.expires_at < now) {
        this.buckets.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  /**
   * Start periodic sweeping of expired buckets (performance-06). Idempotent
   * — a second call while already running is a no-op. The timer is
   * `unref()`'d so it never keeps the process alive on its own, and is
   * meant to be stopped via {@link stopSweeper} at teardown (mirrors
   * WorkingFilesTracker.startSweeper / Consultation.startTimeoutSweeper).
   */
  startSweeper(intervalMs = 60_000): void {
    if (this.sweeperHandle) return;
    this.sweeperHandle = setInterval(() => {
      this.sweep();
    }, intervalMs);
    this.sweeperHandle.unref();
  }

  /** Stop the periodic sweeper. Safe to call multiple times / when unstarted. */
  stopSweeper(): void {
    if (!this.sweeperHandle) return;
    clearInterval(this.sweeperHandle);
    this.sweeperHandle = null;
  }

  /** Test helper: current bucket count. */
  size(): number {
    return this.buckets.size;
  }

  /** Test helper: reset all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}
