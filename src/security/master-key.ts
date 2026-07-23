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
  // Pattern checks run BEFORE the Shannon check: Shannon entropy is a purely
  // frequency-based, order-blind metric, so a sequential key (0x00, 0x01,
  // 0x02, ...) has every byte value distinct and reports the maximum
  // possible entropy for its alphabet size — despite being one of the
  // least random 32-byte strings a person could construct. These checks
  // catch that class of weak-but-high-Shannon-entropy key.
  const weakPattern = detectWeakKeyPattern(key);
  if (weakPattern) {
    throw new Error(
      `COORDINATOR_ENCRYPTION_KEY has catastrophically low entropy (${weakPattern}). ` +
        "Not a random key — looks like a constant, sequential, or low-alphabet fixture. " +
        "AES-256 requires a uniformly-random 32-byte key. Generate with: openssl rand -base64 32",
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

/**
 * Detects low-complexity byte patterns that Shannon entropy cannot see
 * (Shannon is order-blind — it only looks at byte-value frequency). Returns
 * a short human-readable reason when the key matches a known weak
 * construction, or null when none of the checks fire.
 *
 * This is a targeted blocklist of easy-to-produce weak inputs, not a
 * general-purpose randomness test — it deliberately leaves wide headroom
 * (see per-check comments) so a genuine CSPRNG-generated key is vanishingly
 * unlikely to trip any of these checks.
 */
export function detectWeakKeyPattern(key: Buffer): string | null {
  // All bytes identical (e.g. Buffer.alloc(32, 0xaa)).
  if (key.every((b) => b === key[0])) {
    return "all bytes identical";
  }

  // Constant step between every pair of consecutive bytes (mod 256) —
  // catches ascending/descending runs and any other fixed-delta sequence.
  // Real random data essentially never has a constant delta across an
  // entire 32-byte buffer.
  const step = (key[1] - key[0] + 256) % 256;
  const isArithmetic = key.every((b, i) => i === 0 || (b - key[i - 1] + 256) % 256 === step);
  if (isArithmetic) {
    return "sequential/arithmetic byte progression";
  }

  // Very small effective alphabet — the key is built from only a handful of
  // distinct byte values (e.g. a short pattern or passphrase repeated to
  // fill the buffer). A true CSPRNG output over 32 bytes uses close to the
  // full byte range (expected ~30 distinct values in 32 draws from 256);
  // requiring at least 3/8 of the buffer length in distinct values leaves
  // large headroom against random keys while still catching low-alphabet
  // constructions that land in the old "medium entropy, just warn" band.
  const distinct = new Set(key).size;
  const minDistinct = Math.max(4, Math.ceil((key.length * 3) / 8));
  if (distinct < minDistinct) {
    return `low effective alphabet (${distinct} distinct byte values, need >= ${minDistinct})`;
  }

  return null;
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
  return createHmac("sha256", "mcc-fingerprint-v1").update(masterKey).digest("hex").slice(0, 16);
}
