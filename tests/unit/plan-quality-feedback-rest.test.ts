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
 * #351 — the plan-quality verdict was computed on every announce and sent
 * only on the SSE stream, i.e. to the dashboard. `POST /api/announce`
 * answered `{ thread_id, status, impact }`; `planQuality` appeared in neither
 * transport's response.
 *
 * So an agent whose plan was scored down to `discovery` could not learn it,
 * and could not revise. The signal was decorative for the one party able to
 * act on it. The MCP half is covered in mcp-tool-handlers.test.ts; this is
 * the REST half.
 */

let dataDir: string;
let services: CoordinatorServices;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plan-quality-rest-"));
  services = createServices({ dataDir });
});

afterEach(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function mockReq(body: unknown, url: string): IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json" };
  req.method = "POST";
  req.url = url;
  (req as unknown as { push: (chunk: unknown) => void }).push(JSON.stringify(body));
  (req as unknown as { push: (chunk: unknown) => void }).push(null);
  return req;
}

function mockRes() {
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
    getBody: () =>
      chunks.length
        ? (JSON.parse(chunks.join("")) as {
            thread_id: string;
            status: string;
            impact: unknown;
            plan_quality: { mode: string; score: number };
            plan_downgrade_reason: string | null;
          })
        : null,
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
      jti: "j-plan-quality",
    },
  };
}

async function announce(plan?: string) {
  // threads.initiator_id has an FK to agents(id): announce before register
  // fails at the DB, not at the handler.
  const reg = mockRes();
  await handleRest(
    mockReq({ agent_id: "a1", name: "A1", modules: ["src/auth"] }, "/api/register"),
    reg.res,
    makeCtx(),
  );
  expect(reg.getStatus()).toBe(200);

  const { res, getStatus, getBody } = mockRes();
  await handleRest(
    mockReq(
      {
        agent_id: "a1",
        subject: "Refactor auth",
        target_modules: ["src/auth"],
        target_files: ["src/auth/middleware.ts"],
        ...(plan === undefined ? {} : { plan }),
      },
      "/api/announce",
    ),
    res,
    makeCtx(),
  );
  expect(getStatus()).toBe(200);
  return getBody()!;
}

describe("POST /api/announce returns its plan verdict (#351)", () => {
  it("tells the agent when its plan was scored down, and why", async () => {
    const body = await announce("Fix stuff");
    expect(body.plan_quality.mode).toBe("discovery");
    expect(body.plan_downgrade_reason).toContain("plan downgraded");
    expect(body.plan_downgrade_reason).toContain("no files");
  });

  it("reports the verdict on a good plan too, with no downgrade reason", async () => {
    const body = await announce(
      "Ajouter un champ optionnel role_permissions dans src/shared/types.ts à l'interface User, puis créer un type UserPublic sans ce champ pour les routes API dans src/api/routes.ts.",
    );
    expect(body.plan_quality.mode).toBe("with_plan");
    expect(body.plan_downgrade_reason).toBeNull();
  });

  it("does not manufacture a downgrade when no plan was supplied", async () => {
    // discovery is the honest mode for a planless announce, not a demotion.
    const body = await announce(undefined);
    expect(body.plan_quality.mode).toBe("discovery");
    expect(body.plan_downgrade_reason).toBeNull();
  });

  it("keeps the keys it already returned", async () => {
    // The change is additive; nothing reading thread_id/status/impact breaks.
    const body = await announce("Fix stuff");
    expect(body).toHaveProperty("thread_id");
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("impact");
  });
});
