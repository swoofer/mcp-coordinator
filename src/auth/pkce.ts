import crypto from "node:crypto";

// Generate a PKCE code_verifier per RFC 7636 §4.1: 43-128 chars from
// unreserved set [A-Z][a-z][0-9]-._~. base64url over 32 random bytes
// yields 43 chars in that set -- the minimum valid length.
export function generateVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// Compute the S256 code_challenge from a verifier per RFC 7636 §4.2.
// The footgun this prevents: implementations that SHA-256 the verifier's
// *bytes* (the random bytes) instead of the *base64url-encoded string*.
// The RFC mandates the latter. Pass the result of generateVerifier
// (or any string verifier obtained from elsewhere) -- never raw bytes.
export function computeChallenge(verifier: string): string {
  const hash = crypto.createHash("sha256").update(verifier, "ascii").digest();
  return hash.toString("base64url");
}
