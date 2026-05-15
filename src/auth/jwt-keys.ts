// JWT key registry: kid -> signing key. Phase 2 hardcodes the accepted
// kid allowlist to ["hs256-v1"]. Key rotation Phase 2.5 introduces
// "hs256-v0" as a verify-only kid during overlap window.

export const ACCEPTED_KIDS = ["hs256-v1"] as const;
export type AcceptedKid = (typeof ACCEPTED_KIDS)[number];

export interface JwtKeyRegistry {
  readonly current: { kid: AcceptedKid; key: Uint8Array };
  // Resolve a kid to its key for signature verification.
  // Returns undefined if the kid is not on the allowlist.
  getKey(kid: string): Uint8Array | undefined;
}

export function buildJwtKeyRegistry(currentSecret: Buffer): JwtKeyRegistry {
  const current = {
    kid: "hs256-v1" as AcceptedKid,
    key: new Uint8Array(currentSecret),
  };
  const map = new Map<string, Uint8Array>([[current.kid, current.key]]);
  return {
    current,
    getKey: (kid: string): Uint8Array | undefined => map.get(kid),
  };
}

// True iff the kid is on the accepted allowlist.
export function isAcceptedKid(kid: string): kid is AcceptedKid {
  return (ACCEPTED_KIDS as readonly string[]).includes(kid);
}
