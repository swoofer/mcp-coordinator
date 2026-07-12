import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Writable } from "node:stream";
import { createConsoleLogger, createPinoLogger, redactPaths } from "../../src/logger.js";
import { REDACT_PATHS } from "../../src/observability/redact-paths.js";

function makeSink(): { sink: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { sink, chunks };
}

/**
 * Builds a nested object with `secret` at the given dotted `path`.
 * A `"*"` wildcard segment (pino/fast-redact "any key at this level"
 * semantics) is materialized as a concrete key ("anyKey") so the
 * resulting object exercises that segment of REDACT_PATHS.
 */
function buildSecretAt(path: string, secret: string): Record<string, unknown> {
  const segments = path.split(".").map((s) => (s === "*" ? "anyKey" : s));
  return segments.reduceRight<unknown>((acc, seg) => ({ [seg]: acc }), secret) as Record<
    string,
    unknown
  >;
}

describe("Phase 1 logger redaction — console variant", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it.each(REDACT_PATHS)("redacts a secret at path %s", (path) => {
    const secret = `SECRET_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const logger = createConsoleLogger("info");
    logger.info(buildSecretAt(path, secret), "msg");
    const out = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(" ")).join("\n");
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("does not redact non-sensitive fields (sanity)", () => {
    const logger = createConsoleLogger("info");
    logger.info({ user_id: "u-public", action: "ping" }, "hello world");
    const out = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(out).toContain("u-public");
    expect(out).toContain("ping");
    expect(out).toContain("hello world");
    expect(out).not.toContain("[REDACTED]");
  });

  it("error/fatal levels are also redacted (console.error path)", () => {
    const logger = createConsoleLogger("info");
    logger.error({ req: { headers: { authorization: "Bearer ERR_SECRET" } } }, "boom");
    const out = errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(out).not.toContain("ERR_SECRET");
    expect(out).toContain("[REDACTED]");
  });
});

describe("Phase 1 logger redaction — pino variant", () => {
  it.each(REDACT_PATHS)("redacts a secret at path %s", (path) => {
    const { sink, chunks } = makeSink();
    const secret = `SECRET_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const logger = createPinoLogger("info", sink);
    logger.info(buildSecretAt(path, secret), "msg");
    const out = chunks.join("");
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("does not redact non-sensitive fields (sanity)", () => {
    const { sink, chunks } = makeSink();
    const logger = createPinoLogger("info", sink);
    logger.info({ user_id: "u-public", action: "ping" }, "hello world");
    const out = chunks.join("");
    expect(out).toContain("u-public");
    expect(out).toContain("ping");
    expect(out).toContain("hello world");
  });
});

describe("redactPaths (pure helper)", () => {
  it("redacts a plain nested path without mutating the input", () => {
    const input = { req: { headers: { authorization: "Bearer X" } } };
    const output = redactPaths(input, ["req.headers.authorization"]);
    expect((output as typeof input).req.headers.authorization).toBe("[REDACTED]");
    // Original object must be untouched (pure function).
    expect(input.req.headers.authorization).toBe("Bearer X");
  });

  it("supports a wildcard first segment", () => {
    const input = { tokens: { access_token: "AT" } };
    const output = redactPaths(input, ["*.access_token"]) as typeof input;
    expect(output.tokens.access_token).toBe("[REDACTED]");
    expect(input.tokens.access_token).toBe("AT");
  });

  it("leaves objects with no matching path untouched", () => {
    const input = { msg: "hello", level: 30 };
    const output = redactPaths(input, ["req.headers.authorization"]);
    expect(output).toEqual(input);
  });

  it("passes through non-object input unchanged", () => {
    expect(redactPaths("plain string" as unknown as Record<string, unknown>, REDACT_PATHS)).toBe(
      "plain string",
    );
    expect(redactPaths(null as unknown as Record<string, unknown>, REDACT_PATHS)).toBe(null);
  });
});
