import { createHmac } from "node:crypto";
import type { Logger } from "pino";

/** Decode the master key from env-var value. Throws on invalid input. */
export function decodeMasterKey(rawValue: string, logger?: Logger): Buffer {
  const trimmed = rawValue.trim();
  // Alphabet detection — length + alphabet combination is unambiguous by construction
  const isHex = /^[0-9a-fA-F]{64}$/.test(trimmed);
  const isB64 = /^[A-Za-z0-9+/]{42,44}={0,2}$/.test(trimmed);
  const isB64u = /^[A-Za-z0-9_-]{43}$/.test(trimmed);
  const matches = [isHex && "hex", isB64 && "base64", isB64u && "base64url"].filter(
    Boolean,
  ) as string[];
  if (matches.length === 0) {
    throw new Error(
      "COORDINATOR_ENCRYPTION_KEY format unrecognized. " +
        "Use exactly one of: 64-char hex, 44-char base64, or 43-char base64url. " +
        "Generate with: openssl rand -base64 32",
    );
  }
  const encoding = matches[0] as "hex" | "base64" | "base64url";
  const key = Buffer.from(trimmed, encoding);
  if (key.length !== 32) {
    throw new Error(
      `COORDINATOR_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
        "Use: openssl rand -base64 32",
    );
  }
  const entropy = shannonEntropyBitsPerByte(key);
  if (entropy < 3.0) {
    throw new Error(
      `COORDINATOR_ENCRYPTION_KEY has catastrophically low entropy (${entropy.toFixed(2)} bits/byte). ` +
        "Not a random key — looks like a constant, passphrase, or test fixture. " +
        "AES-256 requires a uniformly-random 32-byte key. Generate with: openssl rand -base64 32",
    );
  }
  if (entropy < 4.5) {
    logger?.warn(
      { entropy_bits_per_byte: parseFloat(entropy.toFixed(2)) },
      "COORDINATOR_ENCRYPTION_KEY has low entropy — looks like a passphrase. " +
        "AES-256 requires a uniformly-random 32-byte key. Generate with: openssl rand -base64 32",
    );
  }
  return key;
}

/** Compute Shannon entropy in bits/byte. Max ~8 for uniformly random data. */
export function shannonEntropyBitsPerByte(buffer: Buffer): number {
  const freq = new Array(256).fill(0);
  for (const b of buffer) freq[b]++;
  const n = buffer.length;
  let h = 0;
  for (const c of freq) {
    if (c === 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Compute the 16-hex-char (64-bit) key fingerprint. HMAC-SHA256 with label, sliced. */
export function computeKeyFingerprint(masterKey: Buffer): string {
  return createHmac("sha256", "mcc-fingerprint-v1")
    .update(masterKey)
    .digest("hex")
    .slice(0, 16);
}
