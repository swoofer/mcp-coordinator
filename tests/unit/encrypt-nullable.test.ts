import { describe, it, expect, vi } from "vitest";
import { encryptNullable, decryptNullable } from "../../src/security/encrypt-nullable.js";
import {
  PassthroughEncryption,
  type EncryptionContext,
  type EncryptionProvider,
} from "../../src/security/encryption.js";

const ctx: EncryptionContext = {
  org_id: "org-1",
  column: "idp_access_token",
  user_id: "user-1",
};

describe("encryptNullable", () => {
  it("returns null for null input", () => {
    const enc = new PassthroughEncryption();
    expect(encryptNullable(enc, null, ctx)).toBeNull();
  });

  it("returns null for undefined input", () => {
    const enc = new PassthroughEncryption();
    expect(encryptNullable(enc, undefined, ctx)).toBeNull();
  });

  it("returns null for empty-string input", () => {
    const enc = new PassthroughEncryption();
    expect(encryptNullable(enc, "", ctx)).toBeNull();
  });

  it("calls provider.encrypt with exact args for non-empty value", () => {
    const enc = new PassthroughEncryption();
    const spy = vi.spyOn(enc, "encrypt");
    const out = encryptNullable(enc, "secret-token", ctx);
    expect(out).toBe("secret-token");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("secret-token", ctx);
  });

  it("does not call provider when value is empty", () => {
    const enc = new PassthroughEncryption();
    const spy = vi.spyOn(enc, "encrypt");
    encryptNullable(enc, "", ctx);
    encryptNullable(enc, null, ctx);
    encryptNullable(enc, undefined, ctx);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("decryptNullable", () => {
  it("returns null for null input", () => {
    const enc = new PassthroughEncryption();
    expect(decryptNullable(enc, null, ctx)).toBeNull();
  });

  it("calls provider.decrypt with exact args for non-null value", () => {
    const enc = new PassthroughEncryption();
    const spy = vi.spyOn(enc, "decrypt");
    const out = decryptNullable(enc, "ciphertext", ctx);
    expect(out).toBe("ciphertext");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("ciphertext", ctx);
  });

  it("passes empty string through to provider (only null is short-circuited)", () => {
    const provider: EncryptionProvider = {
      encrypt: (p) => p,
      decrypt: vi.fn().mockReturnValue(""),
    };
    const out = decryptNullable(provider, "", ctx);
    expect(out).toBe("");
    expect(provider.decrypt).toHaveBeenCalledWith("", ctx);
  });

  it("does not call provider when value is null", () => {
    const enc = new PassthroughEncryption();
    const spy = vi.spyOn(enc, "decrypt");
    decryptNullable(enc, null, ctx);
    expect(spy).not.toHaveBeenCalled();
  });
});
