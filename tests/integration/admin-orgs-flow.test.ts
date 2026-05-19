/**
 * T13 (v0.10.6) — end-to-end integration test for the admin-UI orgs flow.
 *
 * Boots the real HTTP server via `startServer()` with Phase 2 OAuth wiring
 * enabled (COORDINATOR_OAUTH_ENABLED=true) so the auth-routes dispatcher
 * actually owns /api/admin/orgs. Exercises the full request lifecycle:
 * cookie + CSRF auth gate, validators, DB writes, Tier 1 audit emission,
 * UNIQUE-INDEX 409 translation.
 *
 * Mirrors tests/integration/serve-http-admin-headers.test.ts for the
 * startServer + free-port + mkdtmp pattern. The signing-key registry used
 * here is rebuilt from COORDINATOR_JWT_SECRET so the JWT minted by
 * makeAdminSession verifies under the same kid the verifier owns.
 *
 * Admin user bootstrap: bootPhase2 only ensures an orgs row exists for the
 * configured GitHub org — it does NOT seed users. The admin row is INSERTed
 * directly via getDb() after startServer returns, then makeAdminSession
 * mints a session-cookie JWT for that user id under the live registry.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import { getDb, closeDb } from "../../src/database.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { makeAdminSession, type AdminSession } from "../helpers/admin-session.js";
import { resetPhase2Auth } from "../../src/auth.js";
import { resetAuditQueue } from "../../src/security/audit.js";

// High-entropy secret (mirrors tests/integration/health-ready-encryption.test.ts).
const STRONG_SECRET = "ZGVhZGJlZWZjYWZlYmFiZTAxMjM0NTY3ODlhYmNkZWY=xY9q";
const GITHUB_ORG = "acme-admin-orgs-flow";
const ADMIN_USER_ID = "u-admin-orgs-flow";
const ADMIN_ORG_ID = "org-admin-orgs-flow";

const ENV_KEYS = [
  "COORDINATOR_OAUTH_ENABLED",
  "COORDINATOR_JWT_SECRET",
  "COORDINATOR_GITHUB_CLIENT_ID",
  "COORDINATOR_GITHUB_CLIENT_SECRET",
  "COORDINATOR_PUBLIC_URL",
  "COORDINATOR_GITHUB_ORG",
  "COORDINATOR_INSECURE_COOKIES",
  "COORDINATOR_AUTH_ENABLED",
] as const;

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: <T = unknown>() => T;
}

interface RequestOpts {
  method: string;
  path: string;
  session?: AdminSession;
  body?: unknown;
  headers?: Record<string, string>;
}

function request(port: number, opts: RequestOpts): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let bodyStr: string | undefined;
    if (opts.body !== undefined) {
      bodyStr = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }
    if (opts.session) {
      headers["Cookie"] = opts.session.cookieHeader;
      // CSRF header only needed for mutating verbs, but harmless on GET.
      if (opts.method !== "GET") {
        headers["X-CSRF-Token"] = opts.session.csrfHeader;
      }
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: opts.path,
        method: opts.method,
        headers,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: buf,
            json: <T>() => JSON.parse(buf) as T,
          }),
        );
      },
    );
    req.on("error", reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

let handle: ServerHandle;
let dataDir: string;
let port: number;
let envSnapshot: Record<string, string | undefined>;
let session: AdminSession;

beforeAll(async () => {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];

  port = await getFreePort();
  const mqttTcpPort = await getFreePort();
  dataDir = mkdtempSync(path.join(tmpdir(), "admin-orgs-flow-"));

  // Boot Phase 2 OAuth so dispatchAuthRoutes is wired. AUTH_ENABLED is left
  // unset on purpose — that gates the legacy Phase 1 token machinery, which
  // we do NOT need (and which would force COORDINATOR_REGISTRATION_SECRET
  // + COORDINATOR_ADMIN_SECRET that have nothing to do with the admin UI).
  process.env.COORDINATOR_OAUTH_ENABLED = "true";
  process.env.COORDINATOR_JWT_SECRET = STRONG_SECRET;
  process.env.COORDINATOR_GITHUB_CLIENT_ID = "test-client-id";
  process.env.COORDINATOR_GITHUB_CLIENT_SECRET = "test-client-secret";
  process.env.COORDINATOR_PUBLIC_URL = `http://localhost:${port}`;
  process.env.COORDINATOR_GITHUB_ORG = GITHUB_ORG;
  // Required since PUBLIC_URL is http:// — but localhost is whitelisted, so
  // this flag is technically optional. Set explicitly to be defensive against
  // hostname resolution that might pick a non-localhost form on CI.
  process.env.COORDINATOR_INSECURE_COOKIES = "true";
  delete process.env.COORDINATOR_AUTH_ENABLED;

  // Pre-clean module-level singletons that may leak from a prior test file
  // (vitest fileParallelism is false, but state is process-global).
  resetAuditQueue();
  resetPhase2Auth();

  handle = await startServer({
    port,
    dataDir,
    mqttTcpPort,
    registerSignalHandlers: false,
  });

  // Bootstrap the admin user. bootPhase2 created an orgs row for GITHUB_ORG
  // via ensureBootstrapOrg, but with a randomized id. We INSERT a known org
  // + admin user row so makeAdminSession can sign a JWT whose `sub` matches
  // a real DB row (token_epoch lookup needs the row to exist).
  const db = getDb();
  db.prepare(
    `INSERT INTO orgs (id, name, allowlist_github_org, allowlist_idp_org_id, created_at)
     VALUES (?, ?, NULL, NULL, datetime('now'))`,
  ).run(ADMIN_ORG_ID, "AdminOrgsFlowOrg");
  db.prepare(
    `INSERT INTO users
       (id, primary_org_id, email, name, idp_provider, idp_user_id,
        idp_access_token, role, last_login_at, token_epoch)
     VALUES (?, ?, ?, ?, 'github', ?, 'tok', 'admin', '0', 0)`,
  ).run(
    ADMIN_USER_ID,
    ADMIN_ORG_ID,
    `${ADMIN_USER_ID}@example.com`,
    "admin-orgs-flow",
    `gh-${ADMIN_USER_ID}`,
  );
  // Clear any audit rows emitted during boot so test assertions only count
  // rows produced by the requests under test.
  db.exec("DELETE FROM audit_log");

  const registry = buildJwtKeyRegistry(Buffer.from(STRONG_SECRET, "utf8"));
  session = await makeAdminSession({
    userId: ADMIN_USER_ID,
    orgId: ADMIN_ORG_ID,
    registry,
    issuer: `http://localhost:${port}`,
    role: "admin",
  });
}, 30_000);

afterAll(async () => {
  try {
    await handle?.stop();
  } catch {
    // best-effort
  }
  try {
    closeDb();
  } catch {
    // best-effort
  }
  resetPhase2Auth();
  resetAuditQueue();
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best-effort (Windows EBUSY)
  }
});

describe("T13: admin orgs flow (end-to-end through real HTTP server)", () => {
  // Captured org id for the org we create in the first test and reuse below.
  let createdOrgId: string;

  it("rejects unauthenticated POST /api/admin/orgs with 401", async () => {
    const r = await request(port, {
      method: "POST",
      path: "/api/admin/orgs",
      body: { name: "no-auth-org" },
    });
    expect(r.status).toBe(401);
    expect(r.json<{ code: string }>().code).toBe("UNAUTHORIZED");
  });

  it("POST /api/admin/orgs (valid CSRF) → 201, persists row + emits Tier 1 audit", async () => {
    const r = await request(port, {
      method: "POST",
      path: "/api/admin/orgs",
      session,
      body: {
        name: "Engineering",
        allowlist_github_org: "engineering-gh",
      },
    });
    expect(r.status).toBe(201);
    const body = r.json<{ org: { id: string; name: string; allowlist_github_org: string | null } }>();
    expect(body.org.name).toBe("Engineering");
    expect(body.org.allowlist_github_org).toBe("engineering-gh");
    createdOrgId = body.org.id;

    // Row landed in DB.
    const row = getDb()
      .prepare("SELECT id, name, allowlist_github_org FROM orgs WHERE id = ?")
      .get(createdOrgId) as { id: string; name: string; allowlist_github_org: string | null };
    expect(row).toBeDefined();
    expect(row.name).toBe("Engineering");
    expect(row.allowlist_github_org).toBe("engineering-gh");

    // Audit row landed with flat-scalar metadata.
    const auditRows = getDb()
      .prepare(
        "SELECT action, metadata_json FROM audit_log WHERE action = 'admin.org.created'",
      )
      .all() as Array<{ action: string; metadata_json: string }>;
    expect(auditRows).toHaveLength(1);
    const meta = JSON.parse(auditRows[0]!.metadata_json) as Record<string, unknown>;
    expect(meta.org_id).toBe(createdOrgId);
    expect(meta.target_org_id).toBe(createdOrgId);
    expect(meta.name).toBe("Engineering");
    expect(meta.allowlist_github_org).toBe("engineering-gh");
    expect(meta.allowlist_idp_org_id).toBeNull();
  });

  it("GET /api/admin/orgs returns the newly-created org", async () => {
    const r = await request(port, {
      method: "GET",
      path: "/api/admin/orgs",
      session,
    });
    expect(r.status).toBe(200);
    const body = r.json<{ orgs: Array<{ id: string; name: string }> }>();
    const found = body.orgs.find((o) => o.id === createdOrgId);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Engineering");
  });

  it("PATCH /api/admin/orgs/:id → 200 + DB updated + admin.org.updated audit", async () => {
    const r = await request(port, {
      method: "PATCH",
      path: `/api/admin/orgs/${createdOrgId}`,
      session,
      body: { name: "Engineering-Renamed" },
    });
    expect(r.status).toBe(200);
    const body = r.json<{ org: { id: string; name: string } }>();
    expect(body.org.id).toBe(createdOrgId);
    expect(body.org.name).toBe("Engineering-Renamed");

    const row = getDb()
      .prepare("SELECT name FROM orgs WHERE id = ?")
      .get(createdOrgId) as { name: string };
    expect(row.name).toBe("Engineering-Renamed");

    // Audit chain: one created + one updated event.
    const updatedRows = getDb()
      .prepare(
        "SELECT metadata_json FROM audit_log WHERE action = 'admin.org.updated' ORDER BY id ASC",
      )
      .all() as Array<{ metadata_json: string }>;
    expect(updatedRows).toHaveLength(1);
    const meta = JSON.parse(updatedRows[0]!.metadata_json) as Record<string, unknown>;
    expect(meta.org_id).toBe(createdOrgId);
    expect(meta.target_org_id).toBe(createdOrgId);
    expect(meta.name_before).toBe("Engineering");
    expect(meta.name_after).toBe("Engineering-Renamed");
    // changed_fields is an array — flat-scalar policy permits arrays of
    // strings in this field per the handler's metadata composition (T05).
    expect(Array.isArray(meta.changed_fields)).toBe(true);
    expect(meta.changed_fields).toContain("name");
  });

  it("POST /api/admin/orgs with duplicate name → 409 ORG_NAME_TAKEN", async () => {
    // Same name as the just-renamed org → unique-index hit.
    const r = await request(port, {
      method: "POST",
      path: "/api/admin/orgs",
      session,
      body: { name: "Engineering-Renamed" },
    });
    expect(r.status).toBe(409);
    expect(r.json<{ code: string }>().code).toBe("ORG_NAME_TAKEN");

    // No new admin.org.created audit row emitted.
    const createdRows = getDb()
      .prepare(
        "SELECT id FROM audit_log WHERE action = 'admin.org.created'",
      )
      .all();
    expect(createdRows).toHaveLength(1);
  });
});
