import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import fs from "fs";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { handleHealth, handleLivez, handleReadyz } from "../../src/http/handle-health.js";

const TEST_DIR = "data-test-health";

/**
 * Mock ServerResponse just enough for the json() helper:
 *   res.writeHead(status, headers)  — captures status
 *   res.end(body)                    — captures body string
 * We ignore the headers map; tests only assert on status + parsed body.
 */
interface MockResponse {
  statusCode: number | null;
  body: unknown;
  writeHead(status: number, _headers?: Record<string, string>): MockResponse;
  end(payload?: string): void;
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: null,
    body: undefined,
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(payload?: string) {
      this.body = payload ? JSON.parse(payload) : null;
    },
  };
  return res;
}

function mockReq(): IncomingMessage {
  // Handlers ignore the request entirely (no body, no method, no url) — a
  // bare object cast satisfies the type signature without dragging in the
  // real http module.
  return {} as IncomingMessage;
}

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── /livez ──────────────────────────────────────────────────────────────

describe("handleLivez", () => {
  it("always returns 200 with alive shape", () => {
    const res = mockResponse();
    handleLivez(mockReq(), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("alive");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(typeof body.version).toBe("string");
  });

  it("does NOT include dep checks (liveness must not depend on DB/MQTT)", () => {
    const res = mockResponse();
    handleLivez(mockReq(), res as unknown as ServerResponse);
    expect(res.body).not.toHaveProperty("checks");
  });
});

// ── /readyz ─────────────────────────────────────────────────────────────

describe("handleReadyz", () => {
  it("returns 200 ready when DB + MQTT are both green", () => {
    const services = { mqttBridge: { isConnected: () => true } };
    const res = mockResponse();
    handleReadyz(mockReq(), res as unknown as ServerResponse, services as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("ready");
    const checks = body.checks as Record<string, unknown>;
    expect(checks.db).toEqual({ ok: true });
    expect(checks.mqtt).toEqual({ ok: true });
    // tree_sitter and git_cochange are present but optional — don't gate readiness
    expect(checks).toHaveProperty("tree_sitter");
    expect(checks).toHaveProperty("git_cochange");
    expect((checks.tree_sitter as Record<string, unknown>).optional).toBe(true);
    expect((checks.git_cochange as Record<string, unknown>).optional).toBe(true);
  });

  it("returns 503 not_ready when DB throws", () => {
    // Spy on getDb().prepare().get() — install a SELECT 1 that throws.
    const db = getDb();
    const originalPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql === "SELECT 1") {
        return {
          get: () => {
            throw new Error("disk i/o");
          },
        } as never;
      }
      return originalPrepare(sql);
    });

    const services = { mqttBridge: { isConnected: () => true } };
    const res = mockResponse();
    handleReadyz(mockReq(), res as unknown as ServerResponse, services as never);

    expect(res.statusCode).toBe(503);
    const body = res.body as {
      status: string;
      checks: { db: { ok: boolean; error?: string }; mqtt: { ok: boolean } };
    };
    expect(body.status).toBe("not_ready");
    expect(body.checks.db.ok).toBe(false);
    expect(body.checks.db.error).toContain("disk i/o");
    // MQTT was healthy — confirm the failed check doesn't taint other entries
    expect(body.checks.mqtt.ok).toBe(true);

    spy.mockRestore();
  });

  it("returns 503 not_ready when MQTT is not connected", () => {
    const services = { mqttBridge: { isConnected: () => false } };
    const res = mockResponse();
    handleReadyz(mockReq(), res as unknown as ServerResponse, services as never);

    expect(res.statusCode).toBe(503);
    const body = res.body as {
      status: string;
      checks: { db: { ok: boolean }; mqtt: { ok: boolean; error?: string } };
    };
    expect(body.status).toBe("not_ready");
    expect(body.checks.db.ok).toBe(true);
    expect(body.checks.mqtt.ok).toBe(false);
    expect(body.checks.mqtt.error).toBe("not connected");
  });

  it("returns 503 with both failed checks reported when both deps are down", () => {
    const db = getDb();
    const originalPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql === "SELECT 1") {
        return {
          get: () => {
            throw new Error("locked");
          },
        } as never;
      }
      return originalPrepare(sql);
    });

    const services = { mqttBridge: { isConnected: () => false } };
    const res = mockResponse();
    handleReadyz(mockReq(), res as unknown as ServerResponse, services as never);

    expect(res.statusCode).toBe(503);
    const body = res.body as { checks: { db: { ok: boolean }; mqtt: { ok: boolean } } };
    expect(body.checks.db.ok).toBe(false);
    expect(body.checks.mqtt.ok).toBe(false);

    spy.mockRestore();
  });

  it("response shape is Kubernetes-style on both 200 and 503", () => {
    // 200 path
    const okServices = { mqttBridge: { isConnected: () => true } };
    const okRes = mockResponse();
    handleReadyz(mockReq(), okRes as unknown as ServerResponse, okServices as never);
    expect(Object.keys(okRes.body as object).sort()).toEqual(["checks", "status"]);

    // 503 path (MQTT down)
    const downServices = { mqttBridge: { isConnected: () => false } };
    const downRes = mockResponse();
    handleReadyz(mockReq(), downRes as unknown as ServerResponse, downServices as never);
    expect(Object.keys(downRes.body as object).sort()).toEqual(["checks", "status"]);

    // Both responses have the same `checks` keys — uniform shape regardless of status.
    const okChecks = (okRes.body as { checks: object }).checks;
    const downChecks = (downRes.body as { checks: object }).checks;
    expect(Object.keys(okChecks).sort()).toEqual(["db", "git_cochange", "mqtt", "tree_sitter"]);
    expect(Object.keys(downChecks).sort()).toEqual(["db", "git_cochange", "mqtt", "tree_sitter"]);
  });
});

// ── /health (alias) ─────────────────────────────────────────────────────

describe("handleHealth (backwards-compat alias)", () => {
  it("delegates to /livez and returns 200 alive", () => {
    const res = mockResponse();
    handleHealth(mockReq(), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("alive");
    expect(body).toHaveProperty("uptime_seconds");
    expect(body).toHaveProperty("version");
  });
});
