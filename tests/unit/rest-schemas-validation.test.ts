import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { closeDb } from "../../src/database.js";
import { createServices, type CoordinatorServices } from "../../src/server-setup.js";
import { handleRest, type RestContext } from "../../src/http/handle-rest.js";

/**
 * qualite-code-02 / architecture-15: REST bodies are now validated with zod
 * (src/http/rest-schemas.ts) instead of being cast unchecked (`body as
 * {...}`). This suite proves:
 *   - invalid/malformed bodies get a structured 400 (appError envelope,
 *     with request_id and zod issues) instead of a 500 or silently wrong
 *     downstream behavior;
 *   - previously-valid inputs — including ones relying on tolerated
 *     optional fields (e.g. `modules` absent on /api/register) — still
 *     succeed exactly as before (R5 adversarial: no false-positive
 *     rejections).
 */

let dataDir: string;
let services: CoordinatorServices;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rest-schemas-"));
  services = createServices({ dataDir });
});

afterEach(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function mockReq(body: unknown, url: string, method = "POST"): IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json" };
  req.method = method;
  req.url = url;
  (req as unknown as { push: (chunk: unknown) => void }).push(JSON.stringify(body));
  (req as unknown as { push: (chunk: unknown) => void }).push(null);
  return req;
}

function mockRes(): { res: ServerResponse; getStatus: () => number; getBody: () => any } {
  let status = 200;
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead(s: number) {
      status = s;
    },
    end(buf?: string) {
      if (buf) chunks.push(buf);
    },
  } as unknown as ServerResponse;
  return {
    res,
    getStatus: () => status,
    getBody: () => (chunks.length ? JSON.parse(chunks.join("")) : null),
  };
}

function makeCtx(): RestContext {
  return {
    services,
    httpLog: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
    authEnabled: false,
    claims: {
      sub: "legacy",
      user_id: "legacy",
      org: "default",
      role: "admin",
      jti: "j-schema-test",
    },
  };
}

describe("REST body validation (qualite-code-02 / architecture-15)", () => {
  it("POST /api/register with non-array modules -> 400 structured, no crash", async () => {
    const { res, getStatus, getBody } = mockRes();
    await handleRest(
      mockReq({ agent_id: "a1", name: "A1", modules: "not-an-array" }, "/api/register"),
      res,
      makeCtx(),
    );
    expect(getStatus()).toBe(400);
    const body = getBody();
    expect(body.code).toBe("INVALID_REQUEST");
    expect(body.request_id).toBeDefined();
    expect(body.details.issues.some((i: { path: string }) => i.path === "modules")).toBe(true);
  });

  it("POST /api/register missing agent_id -> 400 structured", async () => {
    const { res, getStatus, getBody } = mockRes();
    await handleRest(mockReq({ name: "A1", modules: [] }, "/api/register"), res, makeCtx());
    expect(getStatus()).toBe(400);
    expect(getBody().code).toBe("INVALID_REQUEST");
  });

  it("POST /api/register without modules field still succeeds (back-compat: modules || [] tolerance)", async () => {
    const { res, getStatus, getBody } = mockRes();
    await handleRest(mockReq({ agent_id: "a1", name: "A1" }, "/api/register"), res, makeCtx());
    expect(getStatus()).toBe(200);
    const agent = getBody();
    expect(agent.id).toBe("a1");
    expect(JSON.parse(agent.modules)).toEqual([]);
  });

  it("POST /api/register with valid modules array still succeeds unchanged", async () => {
    const { res, getStatus, getBody } = mockRes();
    await handleRest(
      mockReq({ agent_id: "a2", name: "A2", modules: ["src/auth"] }, "/api/register"),
      res,
      makeCtx(),
    );
    expect(getStatus()).toBe(200);
    expect(JSON.parse(getBody().modules)).toEqual(["src/auth"]);
  });

  it("POST /api/announce with non-array target_modules -> 400 structured, not 500", async () => {
    services.registry.register("default", "a1", "Agent A", ["src/auth"]);
    const { res, getStatus, getBody } = mockRes();
    await handleRest(
      mockReq(
        {
          agent_id: "a1",
          subject: "test",
          target_modules: "src/auth",
          target_files: [],
        },
        "/api/announce",
      ),
      res,
      makeCtx(),
    );
    expect(getStatus()).toBe(400);
    expect(getBody().code).toBe("INVALID_REQUEST");
  });

  it("POST /api/announce with valid body still succeeds (plan/keep_open/assigned_to optional tolerance)", async () => {
    services.registry.register("default", "a1", "Agent A", ["src/auth"]);
    const { res, getStatus, getBody } = mockRes();
    await handleRest(
      mockReq(
        {
          agent_id: "a1",
          subject: "test",
          target_modules: ["src/auth"],
          target_files: ["src/auth/x.ts"],
        },
        "/api/announce",
      ),
      res,
      makeCtx(),
    );
    expect(getStatus()).toBe(200);
    expect(getBody().thread_id).toBeDefined();
  });

  it("POST /api/unclaim-task missing agent_id -> 400 structured (was: {success:false} 400 with unchecked cast)", async () => {
    const { res, getStatus, getBody } = mockRes();
    await handleRest(mockReq({ thread_id: "t1" }, "/api/unclaim-task"), res, makeCtx());
    expect(getStatus()).toBe(400);
    expect(getBody().code).toBe("INVALID_REQUEST");
  });

  it("POST /api/unclaim-task with empty-string agent_id -> 400 (preserves old truthy-check tolerance)", async () => {
    const { res, getStatus } = mockRes();
    await handleRest(
      mockReq({ thread_id: "t1", agent_id: "" }, "/api/unclaim-task"),
      res,
      makeCtx(),
    );
    expect(getStatus()).toBe(400);
  });

  it("POST /api/check-conflict with missing agent_id -> 400 structured", async () => {
    const { res, getStatus, getBody } = mockRes();
    await handleRest(mockReq({ file: "src/x.ts" }, "/api/check-conflict"), res, makeCtx());
    expect(getStatus()).toBe(400);
    expect(getBody().code).toBe("INVALID_REQUEST");
  });

  it("POST /api/check-conflict with valid body still succeeds", async () => {
    const { res, getStatus } = mockRes();
    await handleRest(
      mockReq({ file: "src/x.ts", agent_id: "a1" }, "/api/check-conflict"),
      res,
      makeCtx(),
    );
    expect(getStatus()).toBe(200);
  });

  it("POST /api/log-file without optional agent_name still succeeds (optional tolerance)", async () => {
    services.registry.register("default", "a1", "Agent A", []);
    const { res, getStatus } = mockRes();
    await handleRest(
      mockReq(
        {
          session_id: "s1",
          agent_id: "a1",
          tool_name: "Edit",
          file: "src/x.ts",
        },
        "/api/log-file",
      ),
      res,
      makeCtx(),
    );
    expect(getStatus()).toBe(200);
  });

  it("POST /api/log-file with missing required tool_name -> 400 structured", async () => {
    const { res, getStatus, getBody } = mockRes();
    await handleRest(
      mockReq({ session_id: "s1", agent_id: "a1", file: "src/x.ts" }, "/api/log-file"),
      res,
      makeCtx(),
    );
    expect(getStatus()).toBe(400);
    expect(getBody().code).toBe("INVALID_REQUEST");
  });
});
