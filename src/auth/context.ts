import type Database from "better-sqlite3";
import type { Clock } from "./clock.js";
import type { JwtKeyRegistry } from "./jwt-keys.js";
import type { MembershipCache } from "./membership-cache.js";
import type { IdPProvider } from "./providers/types.js";
import type { RateLimiter } from "./rate-limit.js";

/**
 * Phase 2 auth handler dependencies. Composed at boot (T29) and passed
 * to every dispatchAuthRoutes call from serve-http.ts. Future tasks
 * extend this with: providers registry (T05), audit queue (T11b),
 * rate limiter (T12), membership cache (T04), JWT key registry (T08b),
 * metrics registry (T37), logger (T36), etc.
 *
 * T15 adds the Phase C OAuth-init dependencies (githubProvider,
 * rateLimiter, publicUrl, stateBindingKey). T16helpers adds signingKeys
 * (JWT key registry) used by mintTokenPair in the shared finalize path.
 * T29 boot composes; tests stub.
 */
export interface AuthHandlerContext {
  db: Database.Database;
  clock: Clock;
  /** GitHub IdP — Phase 2 single-provider. Phase 4 adds a registry. */
  githubProvider: IdPProvider;
  rateLimiter: RateLimiter;
  /** Public URL for redirect URI construction. From COORDINATOR_PUBLIC_URL.
   *  T29 boot validates this is set; tests pass directly. */
  publicUrl: string;
  /** HKDF-derived state-binding key (T08b deriveStateBindingKey).
   *  Used for HMAC cookie binding per V4 FIX 19. */
  stateBindingKey: Buffer;
  /** JWT key registry (T08b buildJwtKeyRegistry). Used by T16helpers
   *  mintTokenPair to sign access + refresh JWTs in the OAuth finalize
   *  path shared by T16c (browser callback) and T18 (CLI grant). */
  signingKeys: JwtKeyRegistry;
  /** T04 IdP membership cache. Used by T16b (callback) and T18 (CLI
   *  grant) to look up listMemberships per (user_id, provider) with a
   *  60s positive TTL + 10min stale-on-error window. */
  membershipCache: MembershipCache;
}
