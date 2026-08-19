import crypto from "node:crypto";
import { audit } from "../security/audit.js";

/**
 * Hash an IdP user identifier for audit metadata. Purpose-keyed so this
 * hash cannot be cross-correlated with the lockout hash (login-lockout.ts).
 * GitHub user IDs are stable PII; audit rows store hashes, not raw IDs.
 */
export function hashIdpUserId(idpUserId: string): string {
  return crypto.createHash("sha256").update(`idp-user-id-v1\x00${idpUserId}`).digest("hex");
}

/**
 * Bound on the provider name copied into audit metadata. The name arrives
 * straight off the wire on an unauthenticated endpoint and `audit()`
 * serialises metadata with a plain JSON.stringify, so without a bound a
 * multi-megabyte `provider=` value would land verbatim in `metadata_json`.
 */
const MAX_OBSERVED_PROVIDER_CHARS = 64;

/** Where the unknown provider name was submitted from. */
//   auth_code_grant  - body.provider at the token endpoint
//   login_redirect   - ?provider= at /auth/login (#320)
export type UnknownProviderPhase = "auth_code_grant" | "login_redirect";

/**
 * Record that a caller asked for an IdP provider that is not registered
 * (issue #305).
 *
 * Tier 2, deliberately. The name comes from the request body on an endpoint
 * that advertises `token_endpoint_auth_methods_supported: ["none"]`, so an
 * anonymous caller controls both its content and the rate. Tier 1 would put
 * that caller in direct control of a synchronous, never-dropped INSERT on the
 * audit hash chain; the bounded Tier 2 queue is what this repo has for
 * attacker-driven volume (compare `auth.invalid_token`, `auth.csrf.failed`).
 *
 * `client_ip` is threaded through metadata rather than left to the `actor_ip`
 * column: `withAuditContext` has no production call site today, so that column
 * is NULL on every row the daemon writes. A row that cannot say *who* probed
 * would not answer the question this event exists to answer.
 */
export function auditUnknownProvider(opts: {
  observedProvider: string;
  registeredProviders: string[];
  phase: UnknownProviderPhase;
  clientIp: string | null;
}): void {
  const name = opts.observedProvider;
  audit("auth.provider.unknown", {
    tier: 2,
    outcome: "denied",
    metadata: {
      observed_provider:
        name.length <= MAX_OBSERVED_PROVIDER_CHARS
          ? name
          : `${name.slice(0, MAX_OBSERVED_PROVIDER_CHARS)}...(truncated)`,
      registered_providers: opts.registeredProviders,
      phase: opts.phase,
      client_ip: opts.clientIp,
    },
  });
}
