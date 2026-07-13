import { describe, it, expect } from "vitest";
import { redactTokenParam } from "../../src/http/utils.js";

/**
 * securite-auth-03: `?token=<jwt>` is a deliberate, accepted GET-only auth
 * transport (EventSource-compat, see src/auth.ts authenticateRequest). The
 * pino REDACT_PATHS allowlist (src/observability/redact-paths.ts) does NOT
 * cover this — it redacts structured object *paths*, not a substring inside
 * a plain `url` string value. redactTokenParam() is the mitigation: every
 * call site that logs a request URL must route it through this first.
 * See docs/security/threat-model.md, Asset 1 residual-risk note.
 */
describe("redactTokenParam", () => {
  it("masks a token= query param at the end of the URL", () => {
    expect(redactTokenParam("/api/events?token=eyJhbGciOiJIUzI1NiJ9.abc.def")).toBe(
      "/api/events?token=[REDACTED]",
    );
  });

  it("masks token= when it is the first of several query params", () => {
    expect(redactTokenParam("/api/events?token=secret123&foo=bar")).toBe(
      "/api/events?token=[REDACTED]&foo=bar",
    );
  });

  it("masks token= when it is NOT the first query param", () => {
    expect(redactTokenParam("/api/events?foo=bar&token=secret123")).toBe(
      "/api/events?foo=bar&token=[REDACTED]",
    );
  });

  it("stops masking at a fragment (#) boundary", () => {
    expect(redactTokenParam("/x?token=abc123#section")).toBe("/x?token=[REDACTED]#section");
  });

  it("is case-insensitive on the param name", () => {
    expect(redactTokenParam("/x?TOKEN=abc123")).toBe("/x?TOKEN=[REDACTED]");
  });

  it("leaves a URL with no token param unchanged", () => {
    expect(redactTokenParam("/api/hot-files?agent_id=a1")).toBe("/api/hot-files?agent_id=a1");
    expect(redactTokenParam("/api/status")).toBe("/api/status");
  });

  it("handles empty string and no-query-string URLs without throwing", () => {
    expect(redactTokenParam("")).toBe("");
    expect(redactTokenParam("/dashboard")).toBe("/dashboard");
  });

  it("masks EVERY token= occurrence (adversarial: repeated param)", () => {
    expect(redactTokenParam("/x?token=first&token=second")).toBe(
      "/x?token=[REDACTED]&token=[REDACTED]",
    );
  });

  it("never leaves the raw token substring in the output (adversarial)", () => {
    const secret = "s3cr3t.jwt.payload";
    const out = redactTokenParam(`/api/events?token=${secret}`);
    expect(out).not.toContain(secret);
  });
});
