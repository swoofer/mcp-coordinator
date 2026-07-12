import crypto from "node:crypto";

// Derive a domain-separated 32-byte key from the master JWT secret via
// HKDF-SHA-256. Each "info" label produces a key that cannot be confused
// with another, even though they share the same IKM.
//
// Phase 2 uses only one derived key (state-binding-v1) since V4 CUT 2
// removed HMAC-CSRF. Adding new purposes = new info labels, never key reuse.
export function deriveKey(jwtSecret: Buffer, info: string, keyLen: number = 32): Buffer {
  // Empty salt is RFC 5869 compliant for high-entropy IKM (JWT_SECRET).
  return Buffer.from(crypto.hkdfSync("sha256", jwtSecret, Buffer.alloc(0), info, keyLen));
}

export const STATE_BINDING_INFO = "state-binding-v1";

// Derive the HMAC key used to bind oauth_state values to cookies
// (per V4 FIX 19). Called once at boot; the result is cached in
// ServerContext, not re-derived per request.
export function deriveStateBindingKey(jwtSecret: Buffer): Buffer {
  return deriveKey(jwtSecret, STATE_BINDING_INFO);
}
