import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { createLogger, getRedactPaths } from "../../src/observability/logger.js";

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

describe("observability/logger: createLogger", () => {
  it("returns a Logger object with info/warn/error methods", () => {
    const logger = createLogger({ level: "silent" });
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("custom level option is honored (silent produces no output)", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger({ level: "silent", destination: sink });
    logger.info("nothing should be written");
    logger.error("not even errors");
    expect(chunks.join("")).toBe("");
  });

  it("default level is info (debug calls do not emit)", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger({ destination: sink });
    logger.debug("hidden");
    logger.info("visible");
    const out = chunks.join("");
    expect(out).not.toContain("hidden");
    expect(out).toContain("visible");
  });
});

describe("observability/logger: redaction", () => {
  it("Authorization header is redacted (req.headers.authorization)", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger({ destination: sink });
    logger.info({ req: { headers: { authorization: "Bearer SECRET_TOKEN_X" } } }, "msg");
    const out = chunks.join("");
    expect(out).not.toContain("SECRET_TOKEN_X");
    expect(out).toContain("[REDACTED]");
  });

  it("Cookie header is redacted (req.headers.cookie)", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger({ destination: sink });
    logger.info({ req: { headers: { cookie: "session=SECRET_COOKIE_VAL" } } }, "msg");
    const out = chunks.join("");
    expect(out).not.toContain("SECRET_COOKIE_VAL");
    expect(out).toContain("[REDACTED]");
  });

  it("Authorization header is redacted at headers.authorization path too", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger({ destination: sink });
    logger.info({ headers: { authorization: "Bearer ANOTHER_SECRET" } }, "msg");
    const out = chunks.join("");
    expect(out).not.toContain("ANOTHER_SECRET");
  });

  it("*.access_token paths are redacted (token at depth 2)", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger({ destination: sink });
    logger.info({ tokens: { access_token: "AT_PLAINTEXT_VALUE" } }, "msg");
    const out = chunks.join("");
    expect(out).not.toContain("AT_PLAINTEXT_VALUE");
    expect(out).toContain("[REDACTED]");
  });

  it("*.refresh_token paths are redacted", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger({ destination: sink });
    logger.info({ tokens: { refresh_token: "RT_PLAINTEXT_VALUE" } }, "msg");
    const out = chunks.join("");
    expect(out).not.toContain("RT_PLAINTEXT_VALUE");
  });

  it("*.idp_refresh_token paths are redacted", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger({ destination: sink });
    logger.info({ user: { idp_refresh_token: "IDP_RT_PLAINTEXT_VALUE" } }, "msg");
    const out = chunks.join("");
    expect(out).not.toContain("IDP_RT_PLAINTEXT_VALUE");
    expect(out).toContain("[REDACTED]");
  });

  it("body.code_verifier is redacted", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger({ destination: sink });
    logger.info({ body: { code_verifier: "PKCE_VERIFIER_PLAINTEXT" } }, "msg");
    const out = chunks.join("");
    expect(out).not.toContain("PKCE_VERIFIER_PLAINTEXT");
  });

  it("req.session is redacted", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger({ destination: sink });
    logger.info({ req: { session: { jti: "SESSION_JTI_PLAINTEXT", user: "u1" } } }, "msg");
    const out = chunks.join("");
    expect(out).not.toContain("SESSION_JTI_PLAINTEXT");
  });

  it("non-sensitive fields are NOT redacted (sanity)", () => {
    const { sink, chunks } = makeSink();
    const logger = createLogger({ destination: sink });
    logger.info({ user_id: "u-public", action: "ping" }, "msg");
    const out = chunks.join("");
    expect(out).toContain("u-public");
    expect(out).toContain("ping");
    expect(out).not.toContain("[REDACTED]");
  });
});

describe("observability/logger: getRedactPaths", () => {
  it("returns the 17-path redaction allowlist", () => {
    const paths = getRedactPaths();
    expect(paths).toHaveLength(17);
  });

  it("includes the documented anchors", () => {
    const paths = getRedactPaths();
    expect(paths).toContain("req.headers.authorization");
    expect(paths).toContain("*.access_token");
    expect(paths).toContain("body.code_verifier");
    expect(paths).toContain("req.idpAccessToken");
  });
});
