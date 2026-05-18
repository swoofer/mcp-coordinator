import { describe, it, expect } from "vitest";
import { pseudonym } from "../../src/security/audit-pseudonym.js";

/**
 * T12b: shared audit-pseudonym helper. Pinned HMAC label
 * "mcc-audit-pseudonym-v1" (V3 PATCH 17). The whole point of pinning the
 * label is reproducible operator-side correlation, so the test asserts on
 * EXACT precomputed vectors — any drift in label, algorithm, or slice
 * length would silently re-pseudonymize every historical audit row.
 */
describe("security/audit-pseudonym: pseudonym()", () => {
  it("returns exactly 16 hex characters", () => {
    const out = pseudonym("user-alice");
    expect(out).toMatch(/^[0-9a-f]{16}$/);
    expect(out.length).toBe(16);
  });

  it("is deterministic: same input → same output across calls", () => {
    const a = pseudonym("user-alice");
    const b = pseudonym("user-alice");
    expect(a).toBe(b);
  });

  it("different inputs produce different outputs", () => {
    const a = pseudonym("user-alice");
    const b = pseudonym("user-bob");
    expect(a).not.toBe(b);
  });

  // Vectors precomputed with:
  //   createHmac("sha256", "mcc-audit-pseudonym-v1")
  //     .update(input).digest("hex").slice(0, 16)
  // Any change in label, algorithm, or slice length will break these.
  // That's the point — drift surfaces here, NOT in production audit rows.
  it("known label produces known vectors (label/algorithm pinning check)", () => {
    expect(pseudonym("user-alice")).toBe("7a98bc7e5f3cf038");
    expect(pseudonym("user-bob")).toBe("4647c06db5869ced");
  });

  it("empty string input produces a deterministic 16-hex pseudonym", () => {
    expect(pseudonym("")).toBe("8923adea434d6ea4");
  });
});
