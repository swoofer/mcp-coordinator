/**
 * architecture-01 / protocole-mcp-03 — "ghost guard" endpoints. These three
 * handlers exist, are unit-tested, are documented (OpenAPI), and are
 * consumed by the SDK client (`sdk/src/discovery.ts`,
 * `sdk/src/types.ts::HealthzResponse` / `HealthReadyResponse`) and by
 * `mcp-coordinator doctor` (`cli/doctor.ts` probes 1, 6, 7) — but were never
 * wired into serve-http.ts's router, so they 404 in real HTTP despite every
 * other layer treating them as live.
 *
 * This is a real end-to-end integration test: a real `startServer()` HTTP
 * server, real `fetch()` calls against it — not a unit call into the
 * handler function directly (that already existed and already passed,
 * which is exactly how the gap stayed invisible).
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr === null || typeof addr === "string") {
        s.close();
        reject(new Error("getFreePort: could not resolve port"));
        return;
      }
      const p = addr.port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

// High-entropy JWT secret required by readRequiredEnv + assertSecretEntropy
// (mirrors tests/integration/health-ready-encryption.test.ts).
const STRONG_SECRET = "ZGVhZGJlZWZjYWZlYmFiZTAxMjM0NTY3ODlhYmNkZWY=xY9q";

const PHASE2_ENV_KEYS = [
  "COORDINATOR_OAUTH_ENABLED",
  "COORDINATOR_JWT_SECRET",
  "COORDINATOR_GITHUB_CLIENT_ID",
  "COORDINATOR_GITHUB_CLIENT_SECRET",
  "COORDINATOR_PUBLIC_URL",
  "COORDINATOR_GITHUB_ORG",
] as const;

describe("ghost-endpoint routing (architecture-01, protocole-mcp-03)", () => {
  let handle: ServerHandle | undefined;
  let dataDir: string | undefined;
  let envSnapshot: Record<string, string | undefined> = {};

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    envSnapshot = {};
  });

  describe("Phase 1 only (no OAuth) — /healthz and /health/ready", () => {
    it("GET /healthz returns 200 with the same alive body shape as /livez", async () => {
      const port = await getFreePort();
      dataDir = mkdtempSync(path.join(tmpdir(), "ghost-endpoints-"));
      handle = await startServer({ port, dataDir, mqttTcpPort: await getFreePort(), mqttWsPath: "/mqtt" });

      const [healthzRes, livezRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/healthz`),
        fetch(`http://127.0.0.1:${port}/livez`),
      ]);

      expect(healthzRes.status).toBe(200);
      expect(livezRes.status).toBe(200);
      const healthzBody = (await healthzRes.json()) as { status: string };
      const livezBody = (await livezRes.json()) as { status: string };
      // sdk/src/types.ts HealthzResponse: { status: "alive" }
      expect(healthzBody.status).toBe("alive");
      expect(healthzBody.status).toBe(livezBody.status);
    });

    it("GET /health/ready returns 200 with checks.db/audit_queue/sweeper/draining (Phase 2 readiness shape)", async () => {
      const port = await getFreePort();
      dataDir = mkdtempSync(path.join(tmpdir(), "ghost-endpoints-"));
      handle = await startServer({ port, dataDir, mqttTcpPort: await getFreePort(), mqttWsPath: "/mqtt" });

      const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        checks: {
          db: { ok: boolean };
          audit_queue: { ok: boolean; depth: number; capacity: number; threshold_percent: number };
          sweeper: { ok: boolean };
          draining: boolean;
        };
      };
      // sdk/src/types.ts HealthReadyResponse shape; cli/doctor.ts probes 6/7
      // read checks.audit_queue.{depth,threshold_percent} and checks.sweeper.ok.
      expect(body.status).toBe("ready");
      expect(body.checks.db.ok).toBe(true);
      expect(typeof body.checks.audit_queue.depth).toBe("number");
      expect(typeof body.checks.audit_queue.threshold_percent).toBe("number");
      expect(typeof body.checks.sweeper.ok).toBe("boolean");
      expect(typeof body.checks.draining).toBe("boolean");
    });
  });

  describe("Phase 2 (OAuth) active — /.well-known/oauth-authorization-server", () => {
    it("GET /.well-known/oauth-authorization-server returns a valid RFC 8414 doc", async () => {
      const port = await getFreePort();
      const publicUrl = `http://localhost:${port}`;
      for (const k of PHASE2_ENV_KEYS) envSnapshot[k] = process.env[k];
      process.env.COORDINATOR_OAUTH_ENABLED = "true";
      process.env.COORDINATOR_JWT_SECRET = STRONG_SECRET;
      process.env.COORDINATOR_GITHUB_CLIENT_ID = "test-client-id";
      process.env.COORDINATOR_GITHUB_CLIENT_SECRET = "test-client-secret";
      process.env.COORDINATOR_PUBLIC_URL = publicUrl;
      process.env.COORDINATOR_GITHUB_ORG = "acme-ghost-endpoints";

      dataDir = mkdtempSync(path.join(tmpdir(), "ghost-endpoints-"));
      handle = await startServer({ port, dataDir, mqttTcpPort: await getFreePort(), mqttWsPath: "/mqtt" });

      const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as Record<string, unknown>;
      // RFC 8414 minimum fields a real SDK/doctor client relies on
      // (sdk/src/discovery.ts, cli/doctor.ts probeDiscovery).
      expect(doc.issuer).toBe(publicUrl);
      expect(doc.authorization_endpoint).toBe(`${publicUrl}/auth/login`);
      expect(doc.token_endpoint).toBe(`${publicUrl}/api/auth/oauth/token`);
      expect(Array.isArray(doc.grant_types_supported)).toBe(true);
    });

    it("negative: without Phase 2 (OAuth off), discovery 404s — no OAuth metadata leak", async () => {
      const port = await getFreePort();
      dataDir = mkdtempSync(path.join(tmpdir(), "ghost-endpoints-"));
      // COORDINATOR_OAUTH_ENABLED intentionally left unset.
      handle = await startServer({ port, dataDir, mqttTcpPort: await getFreePort(), mqttWsPath: "/mqtt" });

      const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
      expect(res.status).toBe(404);
    });
  });
});
