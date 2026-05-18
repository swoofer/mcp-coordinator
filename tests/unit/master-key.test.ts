import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decodeMasterKey,
  shannonEntropyBitsPerByte,
  computeKeyFingerprint,
} from "../../src/security/master-key.js";

// A minimal logger stub matching the subset of the pino Logger interface that
// decodeMasterKey uses (logger?.warn). We cast to `any` at the call site to
// avoid pulling in the full Logger type for tests.
function makeLogger() {
  return { warn: vi.fn() };
}

describe("decodeMasterKey", () => {
  it("accepts a 64-char hex string", () => {
    const key = randomBytes(32);
    const hex = key.toString("hex");
    expect(hex).toHaveLength(64);
    const decoded = decodeMasterKey(hex);
    expect(decoded.equals(key)).toBe(true);
  });

  it("accepts a 44-char base64 string", () => {
    const key = randomBytes(32);
    const b64 = key.toString("base64");
    expect(b64).toHaveLength(44);
    const decoded = decodeMasterKey(b64);
    expect(decoded.equals(key)).toBe(true);
  });

  it("accepts a 43-char base64url string", () => {
    // randomBytes(32).toString("base64url") yields 43 chars (no padding).
    let b64u: string;
    let key: Buffer;
    // Loop until we get a base64url string with no '+' or '/' alias chars,
    // which Buffer.from(...).toString("base64url") guarantees anyway.
    do {
      key = randomBytes(32);
      b64u = key.toString("base64url");
    } while (b64u.length !== 43);
    const decoded = decodeMasterKey(b64u);
    expect(decoded.equals(key)).toBe(true);
  });

  it("trims surrounding whitespace before decoding", () => {
    const key = randomBytes(32);
    const padded = `   ${key.toString("base64")}   \n`;
    const decoded = decodeMasterKey(padded);
    expect(decoded.equals(key)).toBe(true);
  });

  it("rejects key that decodes to wrong length with clear message", () => {
    // 64 hex chars but we'll construct one that's actually 64 chars of hex —
    // that's exactly 32 bytes. To force the wrong-length branch we use a 44-char
    // base64 that decodes to a non-32-byte buffer. base64 of 31 bytes = 44 chars
    // with one '=' padding; we instead need exact 44 chars matching the regex
    // but decoding to a different length. Use 33 bytes → 44 chars base64.
    const wrongLength = randomBytes(33).toString("base64"); // 44 chars, decodes to 33
    expect(wrongLength).toHaveLength(44);
    expect(() => decodeMasterKey(wrongLength)).toThrow(/got 33/);
    expect(() => decodeMasterKey(wrongLength)).toThrow(/exactly 32 bytes/);
  });

  it("throws on catastrophic low entropy (all-same-byte key)", () => {
    // Buffer.alloc(32, 0xaa) → entropy 0; base64 encodes to 44 chars.
    const constantKey = Buffer.alloc(32, 0xaa).toString("base64");
    expect(constantKey).toHaveLength(44);
    expect(() => decodeMasterKey(constantKey)).toThrow(/catastrophically low entropy/);
  });

  it("warns on medium entropy (passphrase-like key) but accepts it", () => {
    // 32 bytes with 16 distinct values each appearing twice → entropy = log2(16) = 4.0
    // which falls in [3.0, 4.5) → warn but accept.
    const mediumKey = Buffer.from("0123456789abcdef".repeat(2), "utf8").toString("base64");
    const logger = makeLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decoded = decodeMasterKey(mediumKey, logger as any);
    expect(decoded).toHaveLength(32);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const firstArg = logger.warn.mock.calls[0][0];
    expect(firstArg).toMatchObject({ entropy_bits_per_byte: expect.any(Number) });
  });

  it("does not warn when no logger is supplied for medium entropy", () => {
    // Confirms the optional-chaining branch when logger is undefined.
    const mediumKey = Buffer.from("0123456789abcdef".repeat(2), "utf8").toString("base64");
    expect(() => decodeMasterKey(mediumKey)).not.toThrow();
  });

  it("silently accepts a high-entropy random key", () => {
    const randomKey = randomBytes(32).toString("base64");
    const logger = makeLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decoded = decodeMasterKey(randomKey, logger as any);
    expect(decoded).toHaveLength(32);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("throws on unrecognized format", () => {
    expect(() => decodeMasterKey("not-a-valid-format-string")).toThrow(/format unrecognized/);
  });

  it("error message for unrecognized format mentions accepted alphabets", () => {
    try {
      decodeMasterKey("xyz");
      expect.fail("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/64-char hex/);
      expect(msg).toMatch(/44-char base64/);
      expect(msg).toMatch(/43-char base64url/);
    }
  });
});

describe("shannonEntropyBitsPerByte", () => {
  it("returns 0 for an all-same-byte buffer", () => {
    expect(shannonEntropyBitsPerByte(Buffer.alloc(32, 0xaa))).toBe(0);
  });

  it("returns ~7-8 bits/byte for a uniformly-random buffer", () => {
    const h = shannonEntropyBitsPerByte(randomBytes(4096));
    expect(h).toBeGreaterThan(7.5);
    expect(h).toBeLessThanOrEqual(8);
  });

  it("returns log2(N) for a buffer of N evenly-distributed distinct bytes", () => {
    // 16 distinct bytes each appearing twice → entropy = log2(16) = 4.
    const buf = Buffer.from("0123456789abcdef".repeat(2), "utf8");
    expect(shannonEntropyBitsPerByte(buf)).toBeCloseTo(4, 10);
  });

  it("handles empty buffer (n=0 → NaN-free path; freq all zero)", () => {
    // With n=0 the loop body never runs and we never divide; result is 0.
    expect(shannonEntropyBitsPerByte(Buffer.alloc(0))).toBe(0);
  });
});

describe("computeKeyFingerprint", () => {
  it("returns exactly 16 hex characters", () => {
    const fp = computeKeyFingerprint(randomBytes(32));
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same key", () => {
    const key = randomBytes(32);
    expect(computeKeyFingerprint(key)).toBe(computeKeyFingerprint(key));
  });

  it("produces distinct outputs for different keys", () => {
    const fp1 = computeKeyFingerprint(randomBytes(32));
    const fp2 = computeKeyFingerprint(randomBytes(32));
    expect(fp1).not.toBe(fp2);
  });

  it("matches the known HMAC-SHA256('mcc-fingerprint-v1', key) prefix for a fixed key", () => {
    // Known vector: key = repeated hex pattern, fingerprint precomputed.
    const key = Buffer.from(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "hex",
    );
    expect(computeKeyFingerprint(key)).toBe("f55a90aa43294568");
  });

  it("matches the known fingerprint for an all-0x42 key", () => {
    const key = Buffer.alloc(32, 0x42);
    expect(computeKeyFingerprint(key)).toBe("c5b8685627585ab4");
  });
});
