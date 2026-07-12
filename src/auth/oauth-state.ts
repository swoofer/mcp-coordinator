import type Database from "better-sqlite3";
import crypto from "node:crypto";
import type { Clock } from "./clock.js";

// 10-minute absolute TTL per spec §4.1. Short enough to bound replay
// window, long enough to tolerate slow user IdP login flows.
const TTL_S = 600;

export interface OAuthStateRow {
  state: string;
  code_verifier: string;
  redirect_uri: string;
  provider: string;
  org_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  /** T55 (v0.10.1): OIDC nonce, when present. Other flows leave NULL. */
  nonce: string | null;
}

export interface ConsumedOAuthState {
  code_verifier: string;
  redirect_uri: string;
  provider: string;
  /** T55: OIDC nonce that the callback must verify against the
   *  id_token's `nonce` claim. Null for non-OIDC flows. */
  nonce: string | null;
}

// Status returned by inspectOAuthState — used by /api/auth/oauth/callback
// to disambiguate failed CAS into HTTP 400 (unknown/expired) vs 409 (consumed).
export type OAuthStateStatus = "unknown" | "expired" | "consumed";

// Create a new PKCE state row. Returns the state + verifier for the
// caller to embed in the OAuth authorize URL (state param + S256-hashed
// code_challenge — challenge hashing is T08b's job).
// 256-bit entropy on both values; base64url is URL-safe (43 chars unpadded).
export function createOAuthState(
  db: Database.Database,
  clock: Clock,
  provider: string,
  redirectUri: string,
): { state: string; code_verifier: string } {
  const state = crypto.randomBytes(32).toString("base64url");
  const code_verifier = crypto.randomBytes(32).toString("base64url");
  const now = clock.now();
  // org_id is resolved at callback by T09 (allowlist) based on the user's GitHub
  // org memberships. Left NULL on INSERT; future UPDATE may set it during the
  // callback transaction.
  db.prepare(
    `
    INSERT INTO oauth_state (state, code_verifier, redirect_uri, provider, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(state, code_verifier, redirectUri, provider, now, now + TTL_S);
  return { state, code_verifier };
}

/**
 * Like createOAuthState, but accepts a caller-supplied code_verifier.
 * The auto-generation in createOAuthState is convenient for tests; this
 * variant is used by /auth/login (T15) which generates the verifier via
 * T08b's PKCE module so the same verifier value flows into the GitHub
 * authorize URL's code_challenge.
 */
export function createOAuthStateWithVerifier(
  db: Database.Database,
  clock: Clock,
  provider: string,
  redirectUri: string,
  codeVerifier: string,
  /** T55 (v0.10.1): OIDC nonce. Pass when the provider requires
   *  id_token nonce verification (OIDCProvider). Other providers
   *  pass undefined / null. */
  nonce?: string | null,
): { state: string } {
  const state = crypto.randomBytes(32).toString("base64url");
  const now = clock.now();
  db.prepare(
    `
    INSERT INTO oauth_state
      (state, code_verifier, redirect_uri, provider, created_at, expires_at, nonce)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(state, codeVerifier, redirectUri, provider, now, now + TTL_S, nonce ?? null);
  return { state };
}

// Atomic CAS: mark state consumed iff not already consumed AND not expired.
// Returns the row's verifier/redirect/provider on success, null otherwise.
// Atomicity lives in the UPDATE...WHERE clause — two concurrent callers
// on the same state race at the SQL row-lock level, and only the one
// that flips consumed_at from NULL wins. Critical for one-time-use PKCE.
export function consumeOAuthState(
  db: Database.Database,
  clock: Clock,
  state: string,
): ConsumedOAuthState | null {
  const now = clock.now();
  const row = db
    .prepare(
      `
    UPDATE oauth_state
    SET consumed_at = ?
    WHERE state = ? AND consumed_at IS NULL AND expires_at > ?
    RETURNING code_verifier, redirect_uri, provider, nonce
  `,
    )
    .get(now, state, now) as ConsumedOAuthState | undefined;
  return row ?? null;
}

// Disambiguate a failed consumeOAuthState into a status code. Called
// AFTER a failed CAS — the state is already known-bad so a non-atomic
// read here is race-tolerant (any state change beyond consumed/expired
// is impossible: once consumed_at is set, it never resets).
// Precondition: caller must have just observed a failed consumeOAuthState
// on this state. Enforced at runtime by checking expires_at against clock:
// a live un-consumed row indicates a precondition violation and throws.
export function inspectOAuthState(
  db: Database.Database,
  clock: Clock,
  state: string,
): { status: OAuthStateStatus; row: OAuthStateRow | null } {
  const row = db.prepare("SELECT * FROM oauth_state WHERE state = ?").get(state) as
    OAuthStateRow | undefined;
  if (!row) return { status: "unknown", row: null };
  if (row.consumed_at !== null) return { status: "consumed", row };
  // Row is un-consumed: distinguish truly-expired from live (precondition violation).
  if (row.expires_at <= clock.now()) return { status: "expired", row };
  throw new Error(
    "inspectOAuthState: row is live (un-consumed, un-expired); use consumeOAuthState first",
  );
}
