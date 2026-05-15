import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { hashIdpUserId } from "../../src/auth/audit-helpers.js";
import { hashIdentifier } from "../../src/auth/login-lockout.js";

/**
 * Unit tests for hashIdpUserId — purpose-keyed SHA-256 used in audit
 * metadata. The purpose key ("idp-user-id-v1") prevents cross-correlation
 * with the lockout hash ("login-lockout-v1") and with naive SHA-256 of
 * the same input.
 */

describe("hashIdpUserId", () => {
  it("is deterministic: same input produces the same output", () => {
    const a = hashIdpUserId("gh-12345");
    const b = hashIdpUserId("gh-12345");
    expect(a).toBe(b);
  });

  it("produces a 64-character hex string (SHA-256 hex digest)", () => {
    const out = hashIdpUserId("gh-12345");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different inputs produce different hashes", () => {
    const a = hashIdpUserId("gh-12345");
    const b = hashIdpUserId("gh-67890");
    expect(a).not.toBe(b);
  });

  it("is purpose-keyed: hash differs from raw SHA-256 and from the lockout hash", () => {
    const input = "gh-12345";
    const purposeKeyed = hashIdpUserId(input);
    const naive = crypto.createHash("sha256").update(input).digest("hex");
    const lockout = hashIdentifier(input);
    expect(purposeKeyed).not.toBe(naive);
    expect(purposeKeyed).not.toBe(lockout);
  });
});
