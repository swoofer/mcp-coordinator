/**
 * T13 (v0.10.6) — end-to-end integration test for the admin-UI users flow.
 *
 * Mirrors admin-orgs-flow.test.ts for the boot/teardown pattern. Focus is the
 * last-admin guard (V3 PATCH 1): the `admin_count must never drop to 0`
 * invariant is enforced atomically inside the PATCH /api/admin/users/:id
 * transaction. We exercise the refusal path (only one admin remaining), the
 * audit-chain invariant (refused PATCHes emit no audit row), and the
 * re-promotion path that unlocks the second demote.
 *
 * Bootstrap of admin user A (actor): the access JWT minted by makeAdminSession
 * carries `sub: ADMIN_A_ID`. authenticateRequest verifies the cookie under the
 * registry derived from COORDINATOR_JWT_SECRET; the users-handler then reads
 * the role off the validated claims. ADMIN_A_ID's DB row must exist BEFORE the
 * first request so readTokenEpoch finds an epoch (defaults to 0 for a fresh
 * row, satisfying claims.iat >= epoch).
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

const STRONG_SECRET = "ZGVhZGJlZWZjYWZlYmFiZTAxMjM0NTY3ODlhYmNkZWY=xY9q";
const GITHUB_ORG = "acme-admin-users-flow";

const ORG_X = "org-users-flow-x";
const ORG_Y = "org-users-flow-y";
const ADMIN_A_ID = "u-admin-A"; // actor (cookie holder)
const ADMIN_B_ID = "u-admin-B"; // demote/promote target
const MEMBER_1_ID = "u-member-1";
const MEMBER_2_ID = "u-member-2";
const MEMBER_3_ID = "u-member-3";

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

function insertOrg(id: string, name: string): void {
  getDb()
    .prepare(
      `INSERT INTO orgs (id, name, allowlist_github_org, allowlist_idp_org_id, created_at)
       VALUES (?, ?, NULL, NULL, datetime('now'))`,
    )
    .run(id, name);
}

function insertUser(id: string, orgId: string, role: "admin" | "member"): void {
  getDb()
    .prepare(
      `INSERT INTO users
         (id, primary_org_id, email, name, idp_provider, idp_user_id,
          idp_access_token, role, last_login_at, token_epoch)
       VALUES (?, ?, ?, ?, 'github', ?, 'tok', ?, '0', 0)`,
    )
    .run(id, orgId, `${id}@example.com`, id, `gh-${id}`, role);
}

let handle: ServerHandle;
let dataDir: string;
let port: number;
let envSnapshot: Record<string, string | undefined>;
let session: AdminSession;

beforeAll(async () => {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];

  // Keeps the pre-probe: COORDINATOR_PUBLIC_URL below must carry the port and
  // startServer reads it at boot, so the number has to exist before we bind.
  // Everywhere without that constraint passes `port: 0` instead and reads
  // handle.port back — see tests/integration/bind-host.test.ts.
  port = await getFreePort();
  dataDir = mkdtempSync(path.join(tmpdir(), "admin-users-flow-"));

  process.env.COORDINATOR_OAUTH_ENABLED = "true";
  process.env.COORDINATOR_JWT_SECRET = STRONG_SECRET;
  process.env.COORDINATOR_GITHUB_CLIENT_ID = "test-client-id";
  process.env.COORDINATOR_GITHUB_CLIENT_SECRET = "test-client-secret";
  process.env.COORDINATOR_PUBLIC_URL = `http://localhost:${port}`;
  process.env.COORDINATOR_GITHUB_ORG = GITHUB_ORG;
  process.env.COORDINATOR_INSECURE_COOKIES = "true";
  delete process.env.COORDINATOR_AUTH_ENABLED;

  resetAuditQueue();
  resetPhase2Auth();

  handle = await startServer({
    port,
    dataDir,
    mqttTcpPort: 0,
    registerSignalHandlers: false,
  });

  // Seed: two orgs, two admins (A, B), three members. A is the actor whose
  // JWT we mint below — its row MUST exist before the first request so the
  // Phase 2 cookie verifier can read its token_epoch.
  insertOrg(ORG_X, "OrgX");
  insertOrg(ORG_Y, "OrgY");
  insertUser(ADMIN_A_ID, ORG_X, "admin");
  insertUser(ADMIN_B_ID, ORG_X, "admin");
  insertUser(MEMBER_1_ID, ORG_X, "member");
  insertUser(MEMBER_2_ID, ORG_Y, "member");
  insertUser(MEMBER_3_ID, ORG_Y, "member");

  // Clear boot-time audit noise so test assertions count only test-induced rows.
  getDb().exec("DELETE FROM audit_log");

  const registry = buildJwtKeyRegistry(Buffer.from(STRONG_SECRET, "utf8"));
  session = await makeAdminSession({
    userId: ADMIN_A_ID,
    orgId: ORG_X,
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
    // best-effort
  }
});

describe("T13: admin users flow (end-to-end through real HTTP server)", () => {
  it("GET /api/admin/users → returns all 5 seeded users + meta.admin_count = 2", async () => {
    const r = await request(port, {
      method: "GET",
      path: "/api/admin/users",
      session,
    });
    expect(r.status).toBe(200);
    const body = r.json<{
      users: Array<{ id: string; role: string; primary_org_id: string }>;
      meta: { admin_count: number };
    }>();
    const ids = body.users.map((u) => u.id).sort();
    expect(ids).toEqual([ADMIN_A_ID, ADMIN_B_ID, MEMBER_1_ID, MEMBER_2_ID, MEMBER_3_ID].sort());
    expect(body.meta.admin_count).toBe(2);
  });

  it("GET /api/admin/users?org=<ORG_X> → returns only ORG_X members (filtered)", async () => {
    const r = await request(port, {
      method: "GET",
      path: `/api/admin/users?org=${ORG_X}`,
      session,
    });
    expect(r.status).toBe(200);
    const body = r.json<{
      users: Array<{ id: string; primary_org_id: string }>;
      meta: { admin_count: number };
    }>();
    const ids = body.users.map((u) => u.id).sort();
    expect(ids).toEqual([ADMIN_A_ID, ADMIN_B_ID, MEMBER_1_ID].sort());
    // admin_count is GLOBAL (V3 PATCH 14) — not filtered by ?org.
    expect(body.meta.admin_count).toBe(2);
  });

  it("PATCH /api/admin/users/<B> {role: 'member'} → 200, audit emitted, admin_count drops to 1", async () => {
    const r = await request(port, {
      method: "PATCH",
      path: `/api/admin/users/${ADMIN_B_ID}`,
      session,
      body: { role: "member" },
    });
    expect(r.status).toBe(200);
    const body = r.json<{ user: { id: string; role: string } }>();
    expect(body.user.id).toBe(ADMIN_B_ID);
    expect(body.user.role).toBe("member");

    // Audit row landed with strict flat scalars.
    const rows = getDb()
      .prepare(
        "SELECT metadata_json FROM audit_log WHERE action = 'admin.user.role_changed' ORDER BY id ASC",
      )
      .all() as Array<{ metadata_json: string }>;
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0]!.metadata_json) as Record<string, unknown>;
    expect(meta.target_user_id).toBe(ADMIN_B_ID);
    expect(meta.old_role).toBe("admin");
    expect(meta.new_role).toBe("member");

    // Subsequent GET reflects the new global count.
    const list = await request(port, {
      method: "GET",
      path: "/api/admin/users",
      session,
    });
    expect(list.status).toBe(200);
    const lbody = list.json<{ meta: { admin_count: number } }>();
    expect(lbody.meta.admin_count).toBe(1);
  });

  it("PATCH /api/admin/users/<A> {role: 'member'} → 409 LAST_ADMIN, no audit, A still admin", async () => {
    // Capture the current audit-chain tip so we can prove no row was appended.
    const tipBefore = getDb()
      .prepare("SELECT id, row_hash FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as { id: number; row_hash: string } | undefined;

    const r = await request(port, {
      method: "PATCH",
      path: `/api/admin/users/${ADMIN_A_ID}`,
      session,
      body: { role: "member" },
    });
    expect(r.status).toBe(409);
    expect(r.json<{ code: string }>().code).toBe("LAST_ADMIN");

    // A is still admin in the DB (the guard ran inside the immediate-mode tx
    // and rolled back the role-change SET clause along with the audit emit).
    const aRow = getDb().prepare("SELECT role FROM users WHERE id = ?").get(ADMIN_A_ID) as {
      role: string;
    };
    expect(aRow.role).toBe("admin");

    // Audit chain tip is unchanged — refused PATCH emitted nothing.
    const tipAfter = getDb()
      .prepare("SELECT id, row_hash FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as { id: number; row_hash: string } | undefined;
    expect(tipAfter?.id).toBe(tipBefore?.id);
    expect(tipAfter?.row_hash).toBe(tipBefore?.row_hash);
  });

  it("PATCH /api/admin/users/<B> {role: 'admin'} → 200 (re-promote), unblocks A demote", async () => {
    const r = await request(port, {
      method: "PATCH",
      path: `/api/admin/users/${ADMIN_B_ID}`,
      session,
      body: { role: "admin" },
    });
    expect(r.status).toBe(200);
    expect(r.json<{ user: { role: string } }>().user.role).toBe("admin");

    // Now demote A — B is admin, so admin_count would go from 2 → 1, not 0.
    const r2 = await request(port, {
      method: "PATCH",
      path: `/api/admin/users/${ADMIN_A_ID}`,
      session,
      body: { role: "member" },
    });
    expect(r2.status).toBe(200);
    expect(r2.json<{ user: { role: string } }>().user.role).toBe("member");

    // A is now member in DB, B is admin.
    const a = getDb().prepare("SELECT role FROM users WHERE id = ?").get(ADMIN_A_ID) as {
      role: string;
    };
    const b = getDb().prepare("SELECT role FROM users WHERE id = ?").get(ADMIN_B_ID) as {
      role: string;
    };
    expect(a.role).toBe("member");
    expect(b.role).toBe("admin");
  });
});
