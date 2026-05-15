import { describe, it, expect } from "vitest";
import {
  generateRequestId,
  getRequestId,
  withRequestId,
  resolveRequestId,
} from "../../src/auth/request-id.js";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("request-id", () => {
  describe("generateRequestId", () => {
    it("returns a UUID v4 (36 chars, version nibble = 4)", () => {
      const id = generateRequestId();
      expect(id).toHaveLength(36);
      expect(id).toMatch(UUID_V4_RE);
    });

    it("returns distinct IDs on each call", () => {
      const a = generateRequestId();
      const b = generateRequestId();
      expect(a).not.toBe(b);
    });
  });

  describe("getRequestId / withRequestId", () => {
    it("returns undefined when called outside withRequestId", () => {
      expect(getRequestId()).toBeUndefined();
    });

    it("returns the scoped ID inside the callback", () => {
      withRequestId("abc-123", () => {
        expect(getRequestId()).toBe("abc-123");
      });
    });

    it("is preserved across deep await boundaries", async () => {
      await withRequestId("deep-id", async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        await (async () => {
          await Promise.resolve();
          expect(getRequestId()).toBe("deep-id");
        })();
        expect(getRequestId()).toBe("deep-id");
      });
      // Back outside the scope.
      expect(getRequestId()).toBeUndefined();
    });

    it("concurrent contexts do not bleed", async () => {
      const seen: Array<{ tag: string; seen: string | undefined }> = [];
      const runOne = (tag: string) =>
        withRequestId(tag, async () => {
          await Promise.resolve();
          await new Promise((r) => setTimeout(r, 0));
          seen.push({ tag, seen: getRequestId() });
        });
      await Promise.all([runOne("alpha"), runOne("bravo")]);
      expect(seen).toEqual(
        expect.arrayContaining([
          { tag: "alpha", seen: "alpha" },
          { tag: "bravo", seen: "bravo" },
        ]),
      );
    });

    it("propagates the callback's return value", () => {
      const result = withRequestId("ret", () => 42);
      expect(result).toBe(42);
    });
  });

  describe("resolveRequestId", () => {
    it("returns the inbound header when valid", () => {
      expect(resolveRequestId("abc.DEF_123:-foo")).toBe("abc.DEF_123:-foo");
    });

    it("generates a fresh UUID when inbound is undefined", () => {
      const id = resolveRequestId(undefined);
      expect(id).toMatch(UUID_V4_RE);
    });

    it("generates fresh when inbound contains invalid chars (space)", () => {
      const id = resolveRequestId("has space");
      expect(id).not.toBe("has space");
      expect(id).toMatch(UUID_V4_RE);
    });

    it("generates fresh when inbound contains invalid chars (newline)", () => {
      const id = resolveRequestId("foo\nbar");
      expect(id).toMatch(UUID_V4_RE);
    });

    it("generates fresh when inbound is an array (multi-value header)", () => {
      const id = resolveRequestId(["one", "two"]);
      expect(id).toMatch(UUID_V4_RE);
    });

    it("accepts a 1-char inbound (lower length boundary)", () => {
      expect(resolveRequestId("a")).toBe("a");
    });

    it("accepts a 128-char inbound (upper length boundary)", () => {
      const id = "a".repeat(128);
      expect(resolveRequestId(id)).toBe(id);
    });

    it("rejects a 129-char inbound (just past upper boundary)", () => {
      const id = "a".repeat(129);
      const out = resolveRequestId(id);
      expect(out).not.toBe(id);
      expect(out).toMatch(UUID_V4_RE);
    });

    it("rejects empty string (below lower boundary)", () => {
      const out = resolveRequestId("");
      expect(out).toMatch(UUID_V4_RE);
    });
  });
});
