import { describe, it, expect } from "vitest";
import { EnvelopeEncryption } from "../../src/security/envelope-encryption.js";
import {
  type EncryptionContext,
  MalformedCiphertext,
  DEKUnwrapFailed,
  DataDecryptFailed,
  UnknownCipherVersion,
} from "../../src/security/encryption.js";
import { randomBytes } from "node:crypto";

const KEY_A = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const KEY_B = Buffer.from("fedcba9876543210fedcba9876543210", "utf8");

const FIXED_CONTEXT: EncryptionContext = {
  org_id: "org-1",
  column: "idp_access_token",
  user_id: "user-1",
};

// Hand-crafted by running encrypt() once with KEY_A + FIXED_CONTEXT + "hello",
// then pinned here as a wire-format regression canary. If this test breaks,
// the storage format changed and existing rows are unreadable.
const EXPECTED_CT =
  "enc:v1:H7L0G9h4Y3ifnEWHZ5iAC-3nYrXFyFg5pbU3PpA--8zav77Rfpsl30WYggxMm8imeEb9pscbe-gqb_86GLbUJ5K1JVR5KDdwgtloxYBvcIZdccyDbppumDxLyVot";

describe("EnvelopeEncryption", () => {
  it("1. round-trip basic: 200-byte token", () => {
    const provider = new EnvelopeEncryption(KEY_A);
    const plaintext = "x".repeat(200);
    const ct = provider.encrypt(plaintext, FIXED_CONTEXT);
    expect(ct.startsWith("enc:v1:")).toBe(true);
    expect(provider.decrypt(ct, FIXED_CONTEXT)).toBe(plaintext);
  });

  it("2. round-trip binary: NUL + multi-byte UTF-8 + emoji", () => {
    const provider = new EnvelopeEncryption(KEY_A);
    const plaintext = "中文\x00more\x00bytes\x00🔐end";
    const ct = provider.encrypt(plaintext, FIXED_CONTEXT);
    expect(provider.decrypt(ct, FIXED_CONTEXT)).toBe(plaintext);
  });

  it("3. round-trip short: single-char plaintext", () => {
    const provider = new EnvelopeEncryption(KEY_A);
    const ct = provider.encrypt("a", FIXED_CONTEXT);
    expect(provider.decrypt(ct, FIXED_CONTEXT)).toBe("a");
  });

  it("4. wrong master key → DEKUnwrapFailed", () => {
    const providerA = new EnvelopeEncryption(KEY_A);
    const providerB = new EnvelopeEncryption(KEY_B);
    const ct = providerA.encrypt("secret", FIXED_CONTEXT);
    expect(() => providerB.decrypt(ct, FIXED_CONTEXT)).toThrow(DEKUnwrapFailed);
  });

  describe("5. AAD swap matrix → DataDecryptFailed", () => {
    it("cross-row (user_id swap)", () => {
      const provider = new EnvelopeEncryption(KEY_A);
      const ct = provider.encrypt("token", {
        org_id: "o1",
        column: "idp_access_token",
        user_id: "u1",
      });
      expect(() =>
        provider.decrypt(ct, {
          org_id: "o1",
          column: "idp_access_token",
          user_id: "u2",
        }),
      ).toThrow(DataDecryptFailed);
    });

    it("cross-column (column swap)", () => {
      const provider = new EnvelopeEncryption(KEY_A);
      const ct = provider.encrypt("token", {
        org_id: "o1",
        column: "idp_access_token",
        user_id: "u1",
      });
      expect(() =>
        provider.decrypt(ct, {
          org_id: "o1",
          column: "idp_refresh_token",
          user_id: "u1",
        }),
      ).toThrow(DataDecryptFailed);
    });

    it("cross-org (org_id swap)", () => {
      const provider = new EnvelopeEncryption(KEY_A);
      const ct = provider.encrypt("token", {
        org_id: "o1",
        column: "idp_access_token",
        user_id: "u1",
      });
      expect(() =>
        provider.decrypt(ct, {
          org_id: "o2",
          column: "idp_access_token",
          user_id: "u1",
        }),
      ).toThrow(DataDecryptFailed);
    });
  });

  it("6. malformed base64 → MalformedCiphertext", () => {
    const provider = new EnvelopeEncryption(KEY_A);
    // A 50-byte blob is shorter than required 88-byte minimum, so even though
    // base64url decode succeeds, length check raises MalformedCiphertext.
    // For a string that fails base64 in strict mode, Node treats invalid chars
    // as stop tokens; the resulting buffer may be short, also raising MalformedCiphertext.
    expect(() => provider.decrypt("enc:v1:not-valid-base64!@#", FIXED_CONTEXT)).toThrow(
      MalformedCiphertext,
    );
  });

  it("7. truncated ciphertext (<88 bytes) → MalformedCiphertext with length msg", () => {
    const provider = new EnvelopeEncryption(KEY_A);
    const short = Buffer.alloc(50).toString("base64url");
    try {
      provider.decrypt("enc:v1:" + short, FIXED_CONTEXT);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedCiphertext);
      expect((err as Error).message).toMatch(/too short/);
      expect((err as Error).message).toMatch(/50/);
    }
  });

  it("8. unknown versions v2, v99, v999 → UnknownCipherVersion", () => {
    const provider = new EnvelopeEncryption(KEY_A);
    for (const v of ["2", "99", "999"]) {
      expect(() => provider.decrypt(`enc:v${v}:abcdef`, FIXED_CONTEXT)).toThrow(
        UnknownCipherVersion,
      );
    }
  });

  describe("9. out-of-range versions → MalformedCiphertext", () => {
    const provider = new EnvelopeEncryption(KEY_A);
    it("v0 rejected (no leading zero)", () => {
      expect(() => provider.decrypt("enc:v0:abc", FIXED_CONTEXT)).toThrow(MalformedCiphertext);
    });
    it("v01 rejected (leading zero)", () => {
      expect(() => provider.decrypt("enc:v01:abc", FIXED_CONTEXT)).toThrow(MalformedCiphertext);
    });
    it("v1000 rejected (>999)", () => {
      expect(() => provider.decrypt("enc:v1000:abc", FIXED_CONTEXT)).toThrow(MalformedCiphertext);
    });
  });

  it("10. plaintext passthrough on missing prefix (legacy lazy-migration)", () => {
    const provider = new EnvelopeEncryption(KEY_A);
    expect(provider.decrypt("plain text token", FIXED_CONTEXT)).toBe("plain text token");
  });

  it("11. format injection forcing-function (length-prefixed AAD is parser-proof)", () => {
    const provider = new EnvelopeEncryption(KEY_A);
    const ctA = provider.encrypt("secret", {
      org_id: "evil_org",
      column: "idp_access_token",
      user_id: "u1",
    });
    // An attack against a hypothetical pipe-delimited AAD would attempt to make
    // "evil|_org_idp_access_token_u1|" parse equivalently to the original.
    // With length-prefixed AAD, these byte sequences differ → MUST throw.
    expect(() =>
      provider.decrypt(ctA, {
        org_id: "evil",
        column: "idp_access_token",
        user_id: "_org_idp_access_token_u1",
      }),
    ).toThrow(DataDecryptFailed);
    // Also test the inverse smuggling attempt
    expect(() =>
      provider.decrypt(ctA, {
        org_id: "evil_org_idp_access_token_u1",
        column: "idp_access_token",
        user_id: "",
      }),
    ).toThrow(DataDecryptFailed);
  });

  describe("12. constructor validation", () => {
    it("rejects 16-byte key with actionable message", () => {
      expect(() => new EnvelopeEncryption(Buffer.alloc(16))).toThrowError(
        /32-byte master key.*got 16.*openssl rand -base64 32/s,
      );
    });
    it("rejects 0-byte key", () => {
      expect(() => new EnvelopeEncryption(Buffer.alloc(0))).toThrow(/got 0/);
    });
    it("rejects 64-byte key", () => {
      expect(() => new EnvelopeEncryption(randomBytes(64))).toThrow(/got 64/);
    });
    it("accepts 32-byte key", () => {
      expect(() => new EnvelopeEncryption(Buffer.alloc(32))).not.toThrow();
    });
  });

  it("13. deterministic vector (wire-format regression canary)", () => {
    const provider = new EnvelopeEncryption(KEY_A);
    expect(provider.decrypt(EXPECTED_CT, FIXED_CONTEXT)).toBe("hello");
  });

  it("14. AAD field >65535 bytes rejected", () => {
    const provider = new EnvelopeEncryption(KEY_A);
    const huge = "a".repeat(65536);
    expect(() =>
      provider.encrypt("x", {
        org_id: huge,
        column: "idp_access_token",
        user_id: "u1",
      }),
    ).toThrowError(/too long for AAD/);
  });
});
