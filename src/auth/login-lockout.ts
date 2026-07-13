import crypto from "node:crypto";
import { RateLimiter } from "./rate-limit.js";

const LOCKOUT_KEY_PREFIX = "lockout:";

/**
 * Defaults match V3 §B-NEW-8 lockout policy: 5 failures within 15 minutes
 * triggers a 15-minute lockout. Env overrides flow through T44 getOrgSetting
 * at callsites (T16b wires this).
 */
export const DEFAULT_LOCKOUT_THRESHOLD = 5;
export const DEFAULT_LOCKOUT_WINDOW_SECONDS = 15 * 60;

export interface LockoutConfig {
  threshold: number;
  window_seconds: number;
}

export interface LockoutCheckResult {
  locked: boolean;
  /** Retry-After hint when locked; undefined otherwise. */
  retry_after_seconds?: number;
}

/**
 * Hash an identifier (GitHub login or IP) for lockout bookkeeping.
 *
 * The hash is keyed by purpose ("login-lockout-v1") so a future lockout
 * surface (e.g., admin-CLI lockout) doesn't collide with this one. We
 * don't store raw GitHub logins in memory; the hash also lands in audit
 * rows via auth.login.locked metadata.
 */
export function hashIdentifier(identifier: string): string {
  return crypto.createHash("sha256").update(`login-lockout-v1\x00${identifier}`).digest("hex");
}

/**
 * Record a failed login attempt. Returns whether the identifier is now
 * locked (i.e., the failure consumed the last token).
 *
 * Audit emission is the caller's responsibility (T16b emits
 * auth.login.locked Tier 1 when locked=true). This module is wire-clean
 * — no DB, no audit.
 *
 * Semantics: `threshold` is the number of attempts ALLOWED within
 * `window_seconds`. The (threshold+1)th attempt locks out. This matches
 * V3 §B-NEW-8 wording ("5 failed auth.login.failure per identifier within
 * 15min → 15min lockout") — 5 failures are tolerated; the 6th locks.
 */
export function recordFailedLogin(
  limiter: RateLimiter,
  identifierHash: string,
  cfg: LockoutConfig = {
    threshold: DEFAULT_LOCKOUT_THRESHOLD,
    window_seconds: DEFAULT_LOCKOUT_WINDOW_SECONDS,
  },
): LockoutCheckResult {
  const key = LOCKOUT_KEY_PREFIX + identifierHash;
  const result = limiter.check(key, {
    per: cfg.threshold,
    window_seconds: cfg.window_seconds,
  });
  if (result.allowed) return { locked: false };
  return { locked: true, retry_after_seconds: result.retry_after_seconds };
}

/**
 * Non-consuming check: returns true if the identifier currently has no
 * remaining attempts. Use this BEFORE attempting the login flow (T16b)
 * to short-circuit denied attempts without consuming additional tokens.
 */
export function isLocked(
  limiter: RateLimiter,
  identifierHash: string,
  cfg: LockoutConfig = {
    threshold: DEFAULT_LOCKOUT_THRESHOLD,
    window_seconds: DEFAULT_LOCKOUT_WINDOW_SECONDS,
  },
): LockoutCheckResult {
  const key = LOCKOUT_KEY_PREFIX + identifierHash;
  const result = limiter.peek(key, {
    per: cfg.threshold,
    window_seconds: cfg.window_seconds,
  });
  if (result.allowed) return { locked: false };
  return { locked: true, retry_after_seconds: result.retry_after_seconds };
}

/**
 * Test helper: reset lockout state. NOTE: this resets ALL buckets on the
 * limiter — production paths must NOT call this. Tests inject fresh
 * limiters, so blast radius is one test.
 */
export function resetLockoutForTest(limiter: RateLimiter, identifierHash: string): void {
  const key = LOCKOUT_KEY_PREFIX + identifierHash;
  limiter.reset();
  void key;
}
