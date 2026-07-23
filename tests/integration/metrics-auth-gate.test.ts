/**
 * /metrics is served through the same generic route table as /health,
 * /livez, and /api/* — but unlike those, it was dispatched BEFORE the
 * shared authenticateRequest gate and carried no AUTH_ENABLED check of its
 * own, so it was reachable without a token even with auth turned on
 * (contrast with /metrics/auth, which always requires a bearer/loopback
 * check regardless of AUTH_ENABLED).
 *
 * serve-http.ts reads COORDINATOR_AUTH_ENABLED / _JWT_SECRET into
 * module-level consts evaluated once at import time (see
 * register-rate-limit.test.ts's header comment for the same caveat), so
 * this file sets env vars BEFORE the first dynamic import and never
 * statically imports serve-http.js.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { startServer as StartServerFn, ServerHandle } from "../../src/serve-http.js";
import { createToken } from "../../src/auth.js";

const STRONG_JWT_SECRET = "ZGVhZGJlZWZjYWZlYmFiZTAxMjM0NTY3ODlhYmNkZWY9elk5cQ==metrics";
const REGISTRATION_SECRET = "metrics-auth-gate-test-registration-secret";
const ADMIN_SECRET = "metrics-auth-gate-test-admin-secret";

const ENV_KEYS = [
  "COORDINATOR_AUTH_ENABLED",
  "COORDINATOR_JWT_SECRET",
  "COORDINATOR_REGISTRATION_SECRET",
  "COORDINATOR_ADMIN_SECRET",
] as const;

let envSnapshot: Record<string, string | undefined> = {};
let startServer: typeof StartServerFn;

beforeAll(async () => {
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  process.env.COORDINATOR_AUTH_ENABLED = "true";
  process.env.COORDINATOR_JWT_SECRET = STRONG_JWT_SECRET;
  process.env.COORDINATOR_REGISTRATION_SECRET = REGISTRATION_SECRET;
  process.env.COORDINATOR_ADMIN_SECRET = ADMIN_SECRET;

  // Dynamic import — see file header. Must happen AFTER the env vars above
  // are set, since serve-http.ts reads them into module-level consts once,
  // at import time.
  ({ startServer } = await import("../../src/serve-http.js"));
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

let handle: ServerHandle | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  if (handle) {
    await handle.stop().catch(() => undefined);
    handle = undefined;
  }
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

interface Resp {
  status: number;
  body: string;
}

function getMetrics(port: number, token?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      { host: "127.0.0.1", port, path: "/metrics", method: "GET", timeout: 5000, headers },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: buf }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function bootServer(prefix: string): Promise<{ port: number }> {
  dataDir = mkdtempSync(path.join(tmpdir(), prefix));
  const port = await getFreePort();
  const mqttTcpPort = await getFreePort();
  handle = await startServer({ port, dataDir, mqttTcpPort, registerSignalHandlers: false });
  return { port };
}

describe("GET /metrics — gated by AUTH_ENABLED", () => {
  it("401 with no token when auth is enabled", async () => {
    const { port } = await bootServer("metrics-auth-no-token-");
    const res = await getMetrics(port);
    expect(res.status).toBe(401);
  });

  it("200 with a valid bearer token when auth is enabled", async () => {
    const { port } = await bootServer("metrics-auth-with-token-");
    const token = await createToken("agent-metrics", "agent");
    const res = await getMetrics(port, token);
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/mcp_coordinator/);
  });

  it("401 with a garbage token when auth is enabled", async () => {
    const { port } = await bootServer("metrics-auth-bad-token-");
    const res = await getMetrics(port, "not-a-real-jwt");
    expect(res.status).toBe(401);
  });
});
