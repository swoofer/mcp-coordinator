import { describe, it, expect } from "vitest";
import { PassthroughEncryption, type EncryptionContext } from "../../src/security/encryption.js";

describe("PassthroughEncryption", () => {
  const enc = new PassthroughEncryption();
  const ctx: EncryptionContext = {
    org_id: "o1",
    column: "idp_access_token",
    user_id: "u1",
  };

  it("encrypt returns plaintext unchanged", () => {
    expect(enc.encrypt("hello", ctx)).toBe("hello");
  });

  it("decrypt returns ciphertext unchanged", () => {
    expect(enc.decrypt("hello", ctx)).toBe("hello");
  });

  it("round-trips arbitrary string", () => {
    const orig = "alice@example.com";
    const ct = enc.encrypt(orig, ctx);
    expect(enc.decrypt(ct, ctx)).toBe(orig);
  });
});
