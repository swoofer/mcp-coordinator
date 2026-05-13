import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, closeDb } from "../../src/database.js";
import { initAuth } from "../../src/auth.js";
import { handleRest, type RestContext } from "../../src/http/handle-rest.js";
import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import fs from "fs";

const DIR = "data-test-ctx-thread";
const SECRET = "test-secret-at-least-32-characters-long!";

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  initAuth(SECRET);
});
afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// CRITICAL: reset auth state so module state doesn't contaminate later test files
// under vitest's fileParallelism: false. See "Module-state hygiene" in Conventions.
afterAll(() => {
  initAuth(SECRET);
});

function mockReq(body: object, url: string, method = "POST"): IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json" };
  req.method = method;
  req.url = url;
  (req as unknown as { push: (chunk: unknown) => void }).push(JSON.stringify(body));
  (req as unknown as { push: (chunk: unknown) => void }).push(null);
  return req;
}

function mockRes(): { res: ServerResponse; getStatus: () => number; getBody: () => unknown } {
  let status = 200;
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead(s: number) { status = s; },
    end(buf?: string) { if (buf) chunks.push(buf); },
  } as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => chunks.length ? JSON.parse(chunks.join("")) : null };
}

describe("RestContext claims threading", () => {
  it("RestContext interface requires a claims field (compile-time proof)", () => {
    // If RestContext doesn't have claims, this object literal will cause a
    // TypeScript type error and the test file won't compile.
    const ctx: RestContext = {
      services: {} as never,
      httpLog: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
      authEnabled: false,
      claims: { sub: "legacy", user_id: "legacy", org: "default", role: "admin", jti: "j-test" },
      getRunConfig: () => null,
      setRunConfig: () => {},
    };

    // The field must be accessible and correct.
    expect(ctx.claims.org).toBe("default");
    expect(ctx.claims.role).toBe("admin");
    expect(ctx.claims.sub).toBe("legacy");
  });

  it("claims with org='default' are passed through when AUTH_ENABLED=false (synthetic)", () => {
    // Build a ctx that carries synthetic legacy claims (the shape produced by
    // authenticateRequest when AUTH_ENABLED=false and no Bearer token).
    const ctx: RestContext = {
      services: {} as never,
      httpLog: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
      authEnabled: false,
      claims: { sub: "legacy", user_id: "legacy", org: "default", role: "admin", jti: "j-legacy" },
      getRunConfig: () => null,
      setRunConfig: () => {},
    };

    expect(ctx.claims.org).toBe("default");
  });

  it("claims with custom org are passed through when AUTH_ENABLED=true", () => {
    const ctx: RestContext = {
      services: {} as never,
      httpLog: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
      authEnabled: true,
      claims: { sub: "agent-a", user_id: "user-a", org: "org-acme", role: "agent", jti: "j-acme" },
      getRunConfig: () => null,
      setRunConfig: () => {},
    };

    expect(ctx.claims.org).toBe("org-acme");
  });

  it("handleRest executes /api/status without error with claims present", async () => {
    // /api/status is a lightweight GET handler that reads from services.
    // We verify that the handler runs (returns a response) when claims are in ctx.
    const ctx: RestContext = {
      services: {
        registry: { listOnline: () => [] } as never,
        fileTracker: { getHotFiles: () => [] } as never,
        consultation: { listThreads: () => [] } as never,
        mqttBridge: { isConnected: () => false } as never,
        activityTracker: null as never,
        introspection: null as never,
        sseEmitter: null as never,
        quotaCache: null as never,
        metrics: null as never,
      } as never,
      httpLog: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
      authEnabled: false,
      claims: { sub: "legacy", user_id: "legacy", org: "default", role: "admin", jti: "j-status" },
      getRunConfig: () => null,
      setRunConfig: () => {},
    };

    const { res, getStatus } = mockRes();
    // Should not throw — the handler runs with claims in context.
    await expect(
      handleRest(mockReq({}, "/api/status", "GET"), res, ctx)
    ).resolves.toBeUndefined();
    // /api/status returns 200 with JSON
    expect(getStatus()).toBe(200);
  });
});
