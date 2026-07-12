import crypto from "node:crypto";

/**
 * Hash an IdP user identifier for audit metadata. Purpose-keyed so this
 * hash cannot be cross-correlated with the lockout hash (login-lockout.ts).
 * GitHub user IDs are stable PII; audit rows store hashes, not raw IDs.
 */
export function hashIdpUserId(idpUserId: string): string {
  return crypto.createHash("sha256").update(`idp-user-id-v1\x00${idpUserId}`).digest("hex");
}
