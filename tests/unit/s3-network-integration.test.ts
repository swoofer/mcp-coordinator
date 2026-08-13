import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import path from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

let handle: ServerHandle | null = null;
let dataDir: string | null = null;

afterEach(async () => {
  if (handle) {
    await handle.stop().catch(() => undefined);
    handle = null;
  }
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
});

interface HttpResponse {
  status: number;
  body: string;
  bodyJson: () => unknown;
}

function httpRequest(opts: {
  port: number;
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: opts.method,
        timeout: 5000,
        headers: {
          ...(bodyStr
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
            : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            body,
            bodyJson: () => JSON.parse(body),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("HTTP timeout"));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe("S3 - HTTP integration tests for B4 (reset guard) end-to-end", () => {
  it("/health returns 200 OK with version", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "s3-health-"));
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    const port = handle.port;

    const res = await httpRequest({ port, method: "GET", path: "/health" });
    expect(res.status).toBe(200);
    const body = res.bodyJson() as { status: string; version: string; uptime_seconds: number };
    expect(body.status).toBe("alive");
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(body.version).toBeDefined();
  });

  it("POST /api/reset accepted in NODE_ENV=test (vitest default)", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "s3-reset-test-"));
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    const port = handle.port;

    // NODE_ENV is "test" under vitest by default — canResetDb returns true.
    expect(process.env.NODE_ENV).toBe("test");

    const res = await httpRequest({ port, method: "POST", path: "/api/reset", body: {} });
    expect(res.status).toBe(200);
  });

  it("POST /api/reset rejected with 403 when NODE_ENV is forced to production (B4 end-to-end)", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "s3-reset-prod-"));
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    const port = handle.port;

    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await httpRequest({ port, method: "POST", path: "/api/reset", body: {} });
      expect(res.status).toBe(403);
      expect(res.body).toContain("Forbidden");
    } finally {
      if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv;
      else delete process.env.NODE_ENV;
    }
  });
});

describe("S3 - HTTP integration tests for B5 (path traversal guard) end-to-end", () => {
  it("GET /dashboard/../package.json rejects with 404 (no escape from dashboard root)", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "s3-traversal-"));
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    const port = handle.port;

    const res = await httpRequest({ port, method: "GET", path: "/dashboard/../package.json" });
    expect(res.status).toBe(404);
    // package.json contents include "mcp-coordinator" — body must NOT contain it (no leak).
    expect(res.body).not.toContain("mcp-coordinator");
  });

  it("GET /dashboard/%2e%2e/package.json (URL-encoded) rejects with 404", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "s3-traversal2-"));
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    const port = handle.port;

    const res = await httpRequest({ port, method: "GET", path: "/dashboard/%2e%2e/package.json" });
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("mcp-coordinator");
  });
});

describe("S3 - HTTP integration tests for B1 (concurrent announceWork) end-to-end", () => {
  it("two concurrent /api/announce on overlapping files produce two consistent threads", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "s3-concurrent-"));
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    const port = handle.port;

    // Register 2 agents
    await httpRequest({
      port,
      method: "POST",
      path: "/api/register",
      body: { agent_id: "a1", name: "A1", modules: ["src/auth"] },
    });
    await httpRequest({
      port,
      method: "POST",
      path: "/api/register",
      body: { agent_id: "a2", name: "A2", modules: ["src/auth"] },
    });

    // Fire 2 announces "concurrently" via Promise.all
    const [r1, r2] = await Promise.all([
      httpRequest({
        port,
        method: "POST",
        path: "/api/announce",
        body: {
          agent_id: "a1",
          subject: "A1 work",
          target_modules: ["src/auth"],
          target_files: ["src/auth/types.ts"],
        },
      }),
      httpRequest({
        port,
        method: "POST",
        path: "/api/announce",
        body: {
          agent_id: "a2",
          subject: "A2 work",
          target_modules: ["src/auth"],
          target_files: ["src/auth/types.ts"],
        },
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const j1 = r1.bodyJson() as { thread_id: string; status: string };
    const j2 = r2.bodyJson() as { thread_id: string; status: string };
    expect(j1.thread_id).toBeDefined();
    expect(j2.thread_id).toBeDefined();
    expect(j1.thread_id).not.toBe(j2.thread_id);
    // Both should be open (peer detected) — the B1 transaction guarantees
    // both see a consistent agent registry snapshot during the announce.
  });
});
