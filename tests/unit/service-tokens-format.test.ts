import { describe, it, expect } from "vitest";
import { formatIssuedToken, formatTokenList } from "../../cli/service-tokens.js";

const ISSUED = {
  jti: "jti-123",
  access_token: "tok-abc",
  expires_at: "2026-08-01T00:00:00Z",
};

const TOKENS = [
  {
    jti: "a",
    user_id: "u1",
    org_id: "o1",
    family_id: "service:x",
    expires_at: "2026-08-01",
    created_at: "2026-07-01",
    last_used_at: null,
    revoked_at: null,
    revoked_reason: null,
    status: "active" as const,
  },
  {
    jti: "b",
    user_id: "u2",
    org_id: "o2",
    family_id: "service:y",
    expires_at: "2026-09-01",
    created_at: "2026-07-02",
    last_used_at: null,
    revoked_at: "2026-07-05",
    revoked_reason: "leak",
    status: "revoked" as const,
  },
];

describe("formatIssuedToken", () => {
  it("json mode: emits a parseable single object with exactly the token fields", () => {
    const out = formatIssuedToken(ISSUED, true);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual(ISSUED);
  });

  it("text mode: human-readable block, no JSON", () => {
    const out = formatIssuedToken(ISSUED, false);
    expect(out).toContain("Service token issued:");
    expect(out).toContain("jti-123");
    expect(out).toContain("tok-abc");
    expect(() => JSON.parse(out)).toThrow();
  });
});

describe("formatTokenList", () => {
  it("json mode: emits a parseable array of all tokens", () => {
    const out = formatTokenList(TOKENS, true);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].jti).toBe("a");
    expect(parsed[1].status).toBe("revoked");
  });

  it("json mode: empty list is a valid empty array", () => {
    const out = formatTokenList([], true);
    expect(JSON.parse(out)).toEqual([]);
  });

  it("text mode: TSV table with a header row", () => {
    const out = formatTokenList(TOKENS, false);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("JTI\tUSER\tORG\tSTATUS\tEXPIRES_AT");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1].split("\t")).toEqual(["a", "u1", "o1", "active", "2026-08-01"]);
  });

  it("text mode: empty list prints the placeholder", () => {
    expect(formatTokenList([], false)).toBe("(no service tokens)\n");
  });
});
