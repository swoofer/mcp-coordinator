import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decodeMasterKey,
  shannonEntropyBitsPerByte,
  computeKeyFingerprint,
  detectWeakKeyPattern,
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

  it("rejects a sequential ascending key (0x00..0x1F) despite high Shannon entropy", () => {
    // Every byte value is distinct, so shannonEntropyBitsPerByte reports the
    // maximum possible 5.0 bits/byte for a 32-symbol alphabet (order-blind
    // metric) -- yet this is one of the least random 32-byte strings
    // possible. Must be rejected by the pattern check, not silently accepted.
    const sequential = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    expect(shannonEntropyBitsPerByte(sequential)).toBeCloseTo(5.0, 10);
    const b64 = sequential.toString("base64");
    expect(() => decodeMasterKey(b64)).toThrow(/catastrophically low entropy/);
  });

  it("rejects a sequential descending key with wraparound", () => {
    const sequential = Buffer.from(Array.from({ length: 32 }, (_, i) => (255 - i) % 256));
    const b64 = sequential.toString("base64");
    expect(() => decodeMasterKey(b64)).toThrow(/catastrophically low entropy/);
  });

  it("rejects a low-alphabet key that would otherwise only warn (medium Shannon entropy)", () => {
    // 11 distinct byte values spread across 32 bytes: Shannon entropy is
    // roughly log2(11) ~= 3.46 bits/byte, which falls in the old [3.0, 4.5)
    // "warn but accept" band -- yet 11 distinct values in 32 bytes is a
    // strong low-effective-alphabet signal a real CSPRNG key won't produce.
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) buf[i] = i % 11;
    const entropy = shannonEntropyBitsPerByte(buf);
    expect(entropy).toBeGreaterThanOrEqual(3.0);
    expect(entropy).toBeLessThan(4.5);
    const b64 = buf.toString("base64");
    expect(() => decodeMasterKey(b64)).toThrow(/catastrophically low entropy/);
  });

  it("still warns (does not reject) a medium-entropy 16-distinct-value key", () => {
    // Regression guard: the new low-alphabet check must not tighten the
    // existing warn-band behavior for a 16-distinct-value key.
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) buf[i] = i % 16;
    const b64 = buf.toString("base64");
    const logger = makeLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => decodeMasterKey(b64, logger as any)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("still throws via the Shannon check for a skewed low-entropy key that evades the pattern checks", () => {
    // 12 distinct byte values (at the low-alphabet floor, so the alphabet
    // check does NOT fire) but heavily skewed toward one dominant value:
    // Shannon entropy is well under 3.0 despite clearing the distinct-value
    // floor, and the byte order is not a constant-step sequence. This must
    // still be rejected -- via the original Shannon-based message, since
    // detectWeakKeyPattern legitimately returns null for it.
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 21; i++) buf[i] = 0;
    for (let i = 0; i < 11; i++) buf[21 + i] = i + 1;
    expect(detectWeakKeyPattern(buf)).toBeNull();
    const entropy = shannonEntropyBitsPerByte(buf);
    expect(entropy).toBeLessThan(3.0);
    const b64 = buf.toString("base64");
    expect(() => decodeMasterKey(b64)).toThrow(/catastrophically low entropy/);
    expect(() => decodeMasterKey(b64)).toThrow(/bits\/byte/);
  });

  it("accepts many independent random keys (no false-positive pattern rejection)", () => {
    // Conservativeness check: run several independent CSPRNG draws through
    // decodeMasterKey and confirm none trip the new pattern checks.
    for (let i = 0; i < 25; i++) {
      const key = randomBytes(32);
      expect(() => decodeMasterKey(key.toString("base64"))).not.toThrow();
    }
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

describe("detectWeakKeyPattern", () => {
  it("flags an all-identical-byte buffer", () => {
    expect(detectWeakKeyPattern(Buffer.alloc(32, 0x42))).toMatch(/all bytes identical/);
  });

  it("flags a constant-step ascending sequence", () => {
    const buf = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    expect(detectWeakKeyPattern(buf)).toMatch(/sequential\/arithmetic byte progression/);
  });

  it("flags a constant-step descending sequence with wraparound", () => {
    const buf = Buffer.from(Array.from({ length: 32 }, (_, i) => (255 - i * 3) % 256));
    expect(detectWeakKeyPattern(buf)).toMatch(/sequential\/arithmetic byte progression/);
  });

  it("flags a very small effective alphabet", () => {
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) buf[i] = i % 5;
    expect(detectWeakKeyPattern(buf)).toMatch(/low effective alphabet/);
  });

  it("returns null for a uniformly-random buffer", () => {
    expect(detectWeakKeyPattern(randomBytes(32))).toBeNull();
  });

  it("returns null for a non-arithmetic, non-small-alphabet buffer with one broken step", () => {
    // Mostly-sequential but one deliberately broken step must NOT be flagged
    // as arithmetic (constant-step requires EVERY consecutive gap to match),
    // and has enough distinct values to clear the alphabet floor.
    const buf = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    buf[17] = 250; // breaks the constant +1 step at a single point
    expect(detectWeakKeyPattern(buf)).toBeNull();
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
