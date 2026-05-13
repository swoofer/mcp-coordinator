import { describe, it, expect } from "vitest";
import { PassthroughEncryption } from "../../src/security/encryption.js";

describe("PassthroughEncryption", () => {
  const enc = new PassthroughEncryption();
  const ctx = { org_id: "o1", column: "users.email" };

  it("encrypt returns plaintext unchanged", () => {
    expect(enc.encrypt("hello", ctx)).toBe("hello");
  });

  it("decrypt returns ciphertext unchanged", () => {
    expect(enc.decrypt("hello", ctx)).toBe("hello");
  });

  it("hmac returns value unchanged (no indexing transformation in Phase 1)", () => {
    expect(enc.hmac("hello", ctx)).toBe("hello");
  });

  it("round-trips arbitrary string", () => {
    const orig = "alice@example.com";
    const ct = enc.encrypt(orig, ctx);
    expect(enc.decrypt(ct, ctx)).toBe(orig);
  });
});
