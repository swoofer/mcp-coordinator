import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import fs from "fs";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { initAuditQueue, getAuditQueue, resetAuditQueue } from "../../src/security/audit.js";
import { handleHealthz, handleHealthReady } from "../../src/http/health.js";

const TEST_DIR = "data-test-health-t36";

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
  return {} as IncomingMessage;
}

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

afterAll(() => {
  // closeDb may have already been called by a failure test; guard.
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  resetAuditQueue();
});

describe("handleHealthz", () => {
  it("returns 200 with status: alive", () => {
    const res = mockResponse();
    handleHealthz(mockReq(), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "alive" });
  });
});

describe("handleHealthReady — happy path", () => {
  it("returns 200 when DB is reachable, queue absent, sweeper ok, not draining", async () => {
    const res = mockResponse();
    await handleHealthReady(mockReq(), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("ready");
    const checks = body.checks as Record<string, Record<string, unknown>>;
    expect(checks.db.ok).toBe(true);
    expect(checks.audit_queue.ok).toBe(true);
    expect(checks.audit_queue.depth).toBe(0);
    expect(checks.audit_queue.capacity).toBe(10_000);
    expect(checks.audit_queue.threshold_percent).toBe(80);
    expect(checks.sweeper.ok).toBe(true);
    expect(checks.draining).toBe(false);
  });

  it("response body shape matches the checks schema (keys present in both 200 and 503 paths)", async () => {
    const res = mockResponse();
    await handleHealthReady(mockReq(), res as unknown as ServerResponse, {
      sweeperCircuitOpen: true,
    });
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("checks");
    const checks = body.checks as Record<string, unknown>;
    expect(checks).toHaveProperty("db");
    expect(checks).toHaveProperty("audit_queue");
    expect(checks).toHaveProperty("sweeper");
    expect(checks).toHaveProperty("draining");
  });
});

describe("handleHealthReady — failure paths", () => {
  it("returns 503 with sweeper.ok=false when sweeperCircuitOpen: true", async () => {
    const res = mockResponse();
    await handleHealthReady(mockReq(), res as unknown as ServerResponse, {
      sweeperCircuitOpen: true,
    });
    expect(res.statusCode).toBe(503);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("not_ready");
    const checks = body.checks as Record<string, Record<string, unknown>>;
    expect(checks.sweeper.ok).toBe(false);
  });

  it("returns 503 with draining=true when draining: true", async () => {
    const res = mockResponse();
    await handleHealthReady(mockReq(), res as unknown as ServerResponse, {
      draining: true,
    });
    expect(res.statusCode).toBe(503);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("not_ready");
    const checks = body.checks as Record<string, unknown>;
    expect(checks.draining).toBe(true);
  });

  it("honors custom auditDepthThresholdPercent option", async () => {
    const res = mockResponse();
    await handleHealthReady(mockReq(), res as unknown as ServerResponse, {
      auditDepthThresholdPercent: 50,
    });
    const body = res.body as Record<string, unknown>;
    const checks = body.checks as Record<string, Record<string, unknown>>;
    expect(checks.audit_queue.threshold_percent).toBe(50);
  });
});

describe("handleHealthReady — audit queue depth check", () => {
  it("returns 200 when audit queue at exactly the threshold (8000 rows)", async () => {
    const db = getDb() as unknown as import("better-sqlite3").Database;
    const queue = initAuditQueue(db);
    // Monkey-patch flush() to no-op so the buffer fills past the auto-flush
    // batch boundary. Same pattern as audit-queue.test.ts overflow tests.
    const realFlush = queue.flush.bind(queue);
    queue.flush = (): void => {
      /* swallow */
    };
    try {
      for (let i = 0; i < 8000; i++) {
        queue.enqueue({
          actor_user_id: null,
          actor_org_id: null,
          action: "test.fill",
          target: null,
          actor_ip: null,
          actor_user_agent: null,
          request_id: null,
          outcome: "success",
          metadata_json: null,
        });
      }
      expect(queue.size()).toBe(8000);

      const res = mockResponse();
      await handleHealthReady(mockReq(), res as unknown as ServerResponse);
      const body = res.body as Record<string, unknown>;
      const checks = body.checks as Record<string, Record<string, unknown>>;
      expect(checks.audit_queue.depth).toBe(8000);
      expect(checks.audit_queue.ok).toBe(true);
      expect(res.statusCode).toBe(200);
    } finally {
      queue.flush = realFlush;
    }
  });

  it("returns 503 when audit queue depth > threshold (8001 rows, default 80%)", async () => {
    const db = getDb() as unknown as import("better-sqlite3").Database;
    const queue = initAuditQueue(db);
    const realFlush = queue.flush.bind(queue);
    queue.flush = (): void => {
      /* swallow */
    };
    try {
      for (let i = 0; i < 8001; i++) {
        queue.enqueue({
          actor_user_id: null,
          actor_org_id: null,
          action: "test.fill",
          target: null,
          actor_ip: null,
          actor_user_agent: null,
          request_id: null,
          outcome: "success",
          metadata_json: null,
        });
      }
      expect(queue.size()).toBe(8001);

      const res = mockResponse();
      await handleHealthReady(mockReq(), res as unknown as ServerResponse);
      expect(res.statusCode).toBe(503);
      const body = res.body as Record<string, unknown>;
      expect(body.status).toBe("not_ready");
      const checks = body.checks as Record<string, Record<string, unknown>>;
      expect(checks.audit_queue.depth).toBe(8001);
      expect(checks.audit_queue.ok).toBe(false);
    } finally {
      queue.flush = realFlush;
    }
  });

  it("returns 200 when audit queue not initialized (depth stays 0)", async () => {
    // resetAuditQueue in beforeEach already cleared the singleton.
    expect(getAuditQueue()).toBeNull();
    const res = mockResponse();
    await handleHealthReady(mockReq(), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    const checks = body.checks as Record<string, Record<string, unknown>>;
    expect(checks.audit_queue.depth).toBe(0);
    expect(checks.audit_queue.ok).toBe(true);
  });
});

describe("handleHealthReady — DB failure path", () => {
  // This test must run LAST in the file because it closes the DB. Vitest's
  // file-level afterAll re-tries closeDb defensively (try/catch).
  it("returns 503 when DB SELECT 1 throws (close DB first)", async () => {
    closeDb();
    const res = mockResponse();
    await handleHealthReady(mockReq(), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(503);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("not_ready");
    const checks = body.checks as Record<string, Record<string, unknown>>;
    expect(checks.db.ok).toBe(false);
    expect(typeof checks.db.error).toBe("string");
  });
});
