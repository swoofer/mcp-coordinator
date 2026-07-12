import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { closeDb } from "../../src/database.js";
import { createServices, type CoordinatorServices } from "../../src/server-setup.js";
import { handleRest, type RestContext } from "../../src/http/handle-rest.js";
import { runRegisterFlow } from "../../src/register-workflow.js";

/**
 * architecture-07: REST /api/register and MCP register_agent now share
 * runRegisterFlow (src/register-workflow.ts), which — unlike the old REST
 * path alone — also calls mqttBridge.registerAgent(agentId, name) so an
 * agent registered over REST publishes the same retained MQTT "online"
 * status an MCP-registered agent does.
 */

let dataDir: string;
let services: CoordinatorServices;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "register-workflow-"));
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
    writeHead(s: number) { status = s; },
    end(buf?: string) { if (buf) chunks.push(buf); },
  } as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => (chunks.length ? JSON.parse(chunks.join("")) : null) };
}

function makeCtx(): RestContext {
  let runConfig: Record<string, unknown> | null = null;
  return {
    services,
    httpLog: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
    authEnabled: false,
    claims: { sub: "legacy", user_id: "legacy", org: "default", role: "admin", jti: "j-register-test" },
    getRunConfig: () => runConfig,
    setRunConfig: (cfg) => { runConfig = cfg; },
  };
}

describe("runRegisterFlow (architecture-07 shared REST/MCP register flow)", () => {
  it("registers the agent, emits agent_online exactly once, and publishes MQTT retained status", async () => {
    const registerSpy = vi.spyOn(services.mqttBridge, "registerAgent");
    const events: string[] = [];
    services.sseEmitter.addListener("default", (e) => events.push(e.type));

    const agent = runRegisterFlow(services, "default", "a1", "Agent A", ["src/auth"]);

    expect(agent.id).toBe("a1");
    expect(services.registry.get("default", "a1")).toBeTruthy();
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith("a1", "Agent A");

    await flush();
    const onlineEvents = events.filter((t) => t === "agent_online");
    expect(onlineEvents).toHaveLength(1); // no double-emit
  });

  it("REST /api/register now calls mqttBridge.registerAgent (previously REST-only path skipped it)", async () => {
    const registerSpy = vi.spyOn(services.mqttBridge, "registerAgent");
    const { res, getStatus } = mockRes();

    await handleRest(mockReq({ agent_id: "a1", name: "Agent A", modules: ["src/auth"] }, "/api/register"), res, makeCtx());

    expect(getStatus()).toBe(200);
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith("a1", "Agent A");
  });

  it("REST /api/register emits agent_online exactly once (no double-emit from the shared flow)", async () => {
    const events: { type: string }[] = [];
    services.sseEmitter.addListener("default", (e) => events.push({ type: e.type }));
    const { res } = mockRes();

    await handleRest(mockReq({ agent_id: "a1", name: "Agent A", modules: [] }, "/api/register"), res, makeCtx());
    await flush();

    expect(events.filter((e) => e.type === "agent_online")).toHaveLength(1);
  });
});
