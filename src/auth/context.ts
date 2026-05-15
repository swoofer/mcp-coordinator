import type Database from "better-sqlite3";
import type { Clock } from "./clock.js";
import type { JwtKeyRegistry } from "./jwt-keys.js";
import type { MembershipCache } from "./membership-cache.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { RateLimiter } from "./rate-limit.js";

/**
 * Phase 2 auth handler dependencies. Composed at boot (T29) and passed
 * to every dispatchAuthRoutes call from serve-http.ts.
 *
 * T15 added the Phase C OAuth-init dependencies (rateLimiter,
 * publicUrl, stateBindingKey). T16helpers added signingKeys (JWT key
 * registry) used by mintTokenPair. T45 added the ProviderRegistry.
 * T46 dropped the legacy single-provider `githubProvider` field; all
 * handlers now resolve their IdP through `providers`.
 */
export interface AuthHandlerContext {
  db: Database.Database;
  clock: Clock;
  /** IdP provider registry (T45). Always non-null; boot registers at
   *  least one provider. Handlers resolve the active IdP via
   *  `providers.get(name)` (callback uses state.provider, refresh uses
   *  user.idp_provider, login uses `providers.getDefault()`). */
  providers: ProviderRegistry;
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
