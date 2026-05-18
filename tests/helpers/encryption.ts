import { randomBytes } from "node:crypto";
import type { DatabaseAdapter } from "../../src/db-adapter.js";
import type { EncryptionProvider } from "../../src/security/encryption.js";
import { EnvelopeEncryption } from "../../src/security/envelope-encryption.js";
import { computeKeyFingerprint } from "../../src/security/master-key.js";
import { decryptNullable } from "../../src/security/encrypt-nullable.js";

export interface TestEncryption {
  provider: EnvelopeEncryption;
  key: Buffer;
  fingerprint: string;
}

/** Construct a fresh EnvelopeEncryption with a random 32-byte key. */
export function makeTestEncryption(): TestEncryption {
  const key = randomBytes(32);
  return {
    provider: new EnvelopeEncryption(key),
    key,
    fingerprint: computeKeyFingerprint(key),
  };
}

/**
 * Set COORDINATOR_ENCRYPTION_KEY to base64(key) for the duration of fn,
 * restoring (or unsetting) the original on cleanup.
 *
 * Synchronous variant only — async callers should compose explicitly to avoid
 * env leakage across awaits.
 */
export function withEncryptionEnv<T>(key: Buffer, fn: () => T): T {
  const original = process.env.COORDINATOR_ENCRYPTION_KEY;
  process.env.COORDINATOR_ENCRYPTION_KEY = key.toString("base64");
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.COORDINATOR_ENCRYPTION_KEY;
    else process.env.COORDINATOR_ENCRYPTION_KEY = original;
  }
}

/**
 * Select a single encrypted IdP token column from users, decrypt it via the provider,
 * and return the plaintext (or null). Helper for test assertions on stored values.
 *
 * Note: requires the row to have primary_org_id populated (needed for AAD reconstruction).
 */
export function selectIdpToken(
  db: DatabaseAdapter,
  userId: string,
  column: "idp_access_token" | "idp_refresh_token",
  provider: EncryptionProvider,
): string | null {
  const row = db.prepare(
    `SELECT ${column} AS value, primary_org_id FROM users WHERE id = ?`,
  ).get(userId) as { value: string | null; primary_org_id: string } | undefined;
  if (!row || row.value === null) return null;
  return decryptNullable(provider, row.value, {
    org_id: row.primary_org_id,
    column,
    user_id: userId,
  });
}
