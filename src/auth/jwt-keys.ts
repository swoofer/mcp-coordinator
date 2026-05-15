// JWT key registry: kid -> signing key. Phase 2 hardcodes the accepted
// kid allowlist to ["hs256-v1", "hs256-v0"]. The current kid "hs256-v1"
// is used for sign + verify; "hs256-v0" is registered only when an
// operator provides a previous secret during a rotation overlap window,
// in which case it is verify-only (old tokens still validate; new
// tokens are always minted under "hs256-v1").
//
// See docs/ops/key-rotation.md for the end-to-end rotation procedure.

export const ACCEPTED_KIDS = ["hs256-v1", "hs256-v0"] as const;
export type AcceptedKid = (typeof ACCEPTED_KIDS)[number];

// Only the current kid signs new tokens; prev is verify-only. This is a
// stricter sub-type of AcceptedKid so that mint paths can't accidentally
// sign under the previous kid even if the registry resolves it for verify.
export type CurrentKid = "hs256-v1";

export interface JwtKeyRegistry {
  readonly current: { kid: CurrentKid; key: Uint8Array };
  // Resolve a kid to its key for signature verification.
  // Returns undefined if the kid is not on the allowlist OR if no prev
  // secret was provided at build time and the caller asked for "hs256-v0".
  getKey(kid: string): Uint8Array | undefined;
}

/**
 * Build the JWT key registry. The current secret signs new tokens under
 * kid "hs256-v1". An optional previous secret registers under "hs256-v0"
 * for VERIFY-ONLY during a rotation overlap window — old tokens signed
 * with prev still validate so existing sessions don't immediately fail.
 *
 * To complete a rotation:
 * 1. Set COORDINATOR_JWT_SECRET_PREV = current secret, set new current,
 *    optionally record ROTATED_AT timestamp.
 * 2. Restart. New mints use current; old mints still verify under prev.
 * 3. Wait refresh_TTL (default 30d) for natural session turnover,
 *    OR call bumpTokenEpochAllUsers via admin to force immediate re-auth.
 * 4. Unset COORDINATOR_JWT_SECRET_PREV + restart. Old kid no longer
 *    resolves; tokens signed with prev (if any remain) 401 on verify.
 */
export function buildJwtKeyRegistry(
  currentSecret: Buffer,
  prevSecret?: Buffer,
): JwtKeyRegistry {
  const current = {
    kid: "hs256-v1" as CurrentKid,
    key: new Uint8Array(currentSecret),
  };
  const map = new Map<string, Uint8Array>([[current.kid, current.key]]);
  if (prevSecret) {
    map.set("hs256-v0", new Uint8Array(prevSecret));
  }
  return {
    current,
    getKey: (kid: string): Uint8Array | undefined => map.get(kid),
  };
}

// True iff the kid is on the accepted allowlist.
export function isAcceptedKid(kid: string): kid is AcceptedKid {
  return (ACCEPTED_KIDS as readonly string[]).includes(kid);
}
