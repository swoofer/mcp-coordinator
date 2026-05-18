import { describe, it, expect } from "vitest";
import {
  DecryptionError,
  MalformedCiphertext,
  DEKUnwrapFailed,
  DataDecryptFailed,
  UnknownCipherVersion,
} from "../../src/security/encryption.js";

describe("encryption error classes", () => {
  describe("DecryptionError", () => {
    it("is an instance of Error", () => {
      const e = new DecryptionError("boom");
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(DecryptionError);
      expect(e.name).toBe("DecryptionError");
      expect(e.message).toBe("boom");
    });

    it("propagates cause when provided", () => {
      const cause = new Error("root");
      const e = new DecryptionError("boom", { cause });
      expect(e.cause).toBe(cause);
    });
  });

  describe("MalformedCiphertext", () => {
    it("extends DecryptionError and Error", () => {
      const e = new MalformedCiphertext("bad");
      expect(e).toBeInstanceOf(MalformedCiphertext);
      expect(e).toBeInstanceOf(DecryptionError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe("MalformedCiphertext");
      expect(e.message).toBe("bad");
    });

    it("propagates cause when provided", () => {
      const cause = new Error("root");
      const e = new MalformedCiphertext("bad", { cause });
      expect(e.cause).toBe(cause);
    });
  });

  describe("DEKUnwrapFailed", () => {
    it("extends DecryptionError and Error", () => {
      const e = new DEKUnwrapFailed("nope");
      expect(e).toBeInstanceOf(DEKUnwrapFailed);
      expect(e).toBeInstanceOf(DecryptionError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe("DEKUnwrapFailed");
      expect(e.message).toBe("nope");
    });

    it("propagates cause when provided", () => {
      const cause = new Error("root");
      const e = new DEKUnwrapFailed("nope", { cause });
      expect(e.cause).toBe(cause);
    });
  });

  describe("DataDecryptFailed", () => {
    it("extends DecryptionError and Error", () => {
      const e = new DataDecryptFailed("nope");
      expect(e).toBeInstanceOf(DataDecryptFailed);
      expect(e).toBeInstanceOf(DecryptionError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe("DataDecryptFailed");
      expect(e.message).toBe("nope");
    });

    it("propagates cause when provided", () => {
      const cause = new Error("root");
      const e = new DataDecryptFailed("nope", { cause });
      expect(e.cause).toBe(cause);
    });
  });

  describe("UnknownCipherVersion", () => {
    it("extends Error but NOT DecryptionError", () => {
      const e = new UnknownCipherVersion("v?");
      expect(e).toBeInstanceOf(UnknownCipherVersion);
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(DecryptionError);
      expect(e.name).toBe("UnknownCipherVersion");
      expect(e.message).toBe("v?");
    });

    it("propagates cause when provided", () => {
      const cause = new Error("root");
      const e = new UnknownCipherVersion("v?", { cause });
      expect(e.cause).toBe(cause);
    });
  });
});
