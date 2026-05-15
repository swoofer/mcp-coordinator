import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { generateCsrfToken, verifyCsrfToken } from "../../src/auth/csrf.js";

describe("generateCsrfToken", () => {
  it("returns a 43-char base64url string (256 bits unpadded)", () => {
    const t = generateCsrfToken();
    expect(t).toHaveLength(43);
    // base64url alphabet: A-Z a-z 0-9 - _ (no padding)
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("returns distinct values across 1000 calls (no obvious entropy bug)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateCsrfToken());
    expect(seen.size).toBe(1000);
  });
});

describe("verifyCsrfToken", () => {
  it("returns true when cookie === form", () => {
    const t = generateCsrfToken();
    expect(verifyCsrfToken(t, t)).toBe(true);
  });

  it("returns false when cookie !== form (same length)", () => {
    // Two distinct 43-char base64url strings.
    const a = "A".repeat(43);
    const b = "B".repeat(43);
    expect(verifyCsrfToken(a, b)).toBe(false);
  });

  it("returns false when lengths differ", () => {
    expect(verifyCsrfToken("short", "muchlongervalue")).toBe(false);
  });

  it("returns false when cookieValue is undefined", () => {
    expect(verifyCsrfToken(undefined, "x")).toBe(false);
  });

  it("returns false when formValue is undefined", () => {
    expect(verifyCsrfToken("x", undefined)).toBe(false);
  });

  it("returns false when both are undefined", () => {
    expect(verifyCsrfToken(undefined, undefined)).toBe(false);
  });

  it("returns false when one is empty string and the other is a token", () => {
    const t = generateCsrfToken();
    // Empty string is falsy and triggers the early-return guard, ensuring
    // we never feed a zero-length buffer to timingSafeEqual.
    expect(verifyCsrfToken("", t)).toBe(false);
    expect(verifyCsrfToken(t, "")).toBe(false);
  });

  it("property: two different random 32-byte tokens never match", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (a, b) => {
          const aStr = Buffer.from(a).toString("base64url");
          const bStr = Buffer.from(b).toString("base64url");
          return verifyCsrfToken(aStr, bStr) === false;
        },
      ),
    );
  });
});
