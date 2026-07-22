import type { Clock } from "./clock.js";
import type { IRateLimiter, RateLimitConfig, RateLimitResult } from "./rate-limit.js";
import type { RedisClient } from "../infra/redis.js";

const KEY_PREFIX = "coordinator:rl:";

// Atomic INCR + EXPIRE-on-first + TTL read, one round trip. The TTL<0 branch
// heals keys that lost their expiry (e.g. a crash between INCR and EXPIRE
// under a non-scripted implementation, or a manual PERSIST).
const CHECK_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {c, ttl}
`;

/**
 * Redis-backed rate limiter (Phase 5 multi-instance) — fixed-window
 * INCR+EXPIRE per docs/ops/single-instance-constraints.md ("Redis INCR with
 * EXPIRE per (endpoint, identifier) — pure DI change").
 *
 * Semantics vs the in-memory token bucket: `per` attempts are allowed per
 * `window_seconds` window (attempt per+1 is denied), identical at the policy
 * level; only the smoothing differs (fixed window vs proportional refill),
 * which the maintainer's plan explicitly accepts.
 *
 * Availability bias: on Redis errors this limiter FAILS OPEN (allows the
 * call) and logs — a Redis outage must not take the whole auth surface down.
 * Trade-off documented for the upstream MR (lockout is best-effort during a
 * Redis outage; the in-memory limiter has the same property today when a
 * process restarts).
 */
export class RedisRateLimiter implements IRateLimiter {
  constructor(
    private readonly client: RedisClient,
    private readonly clock: Clock,
    private readonly onError?: (err: unknown) => void,
  ) {}

  async check(key: string, cfg: RateLimitConfig): Promise<RateLimitResult> {
    const k = KEY_PREFIX + key;
    try {
      const reply = (await this.client.eval(CHECK_LUA, {
        keys: [k],
        arguments: [String(cfg.window_seconds)],
      })) as [number, number];
      const count = Number(reply[0]);
      const ttl = Math.max(1, Number(reply[1]));
      if (count <= cfg.per) {
        return {
          allowed: true,
          remaining: cfg.per - count,
          reset_at: this.clock.now() + ttl,
        };
      }
      return { allowed: false, retry_after_seconds: ttl };
    } catch (err) {
      this.onError?.(err);
      return { allowed: true, remaining: cfg.per, reset_at: this.clock.now() + cfg.window_seconds };
    }
  }

  async peek(key: string, cfg: RateLimitConfig): Promise<RateLimitResult> {
    const k = KEY_PREFIX + key;
    try {
      const [raw, ttl] = await Promise.all([this.client.get(k), this.client.ttl(k)]);
      const count = raw === null ? 0 : Number(raw);
      if (count < cfg.per) {
        return {
          allowed: true,
          remaining: cfg.per - count,
          reset_at: this.clock.now() + (ttl > 0 ? ttl : cfg.window_seconds),
        };
      }
      return { allowed: false, retry_after_seconds: Math.max(1, ttl) };
    } catch (err) {
      this.onError?.(err);
      return { allowed: true, remaining: cfg.per, reset_at: this.clock.now() + cfg.window_seconds };
    }
  }

  /** Redis TTLs expire keys natively; nothing to sweep. */
  sweep(): number {
    return 0;
  }

  /** Test helper: count keys under the limiter prefix (SCAN, non-blocking). */
  async size(): Promise<number> {
    let count = 0;
    for await (const keys of this.client.scanIterator({ MATCH: `${KEY_PREFIX}*`, COUNT: 100 })) {
      count += Array.isArray(keys) ? keys.length : 1;
    }
    return count;
  }

  /** Test helper: delete all limiter keys. */
  async reset(): Promise<void> {
    for await (const keys of this.client.scanIterator({ MATCH: `${KEY_PREFIX}*`, COUNT: 100 })) {
      const batch = Array.isArray(keys) ? keys : [keys];
      if (batch.length > 0) await this.client.del(batch as string[]);
    }
  }
}
