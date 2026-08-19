import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import type { startServer as StartServerFn, ServerHandle } from "../../src/serve-http.js";

/**
 * issue #319 — withAuditContext had no production call site, so every audit
 * row the daemon wrote carried actor_ip, actor_user_agent, actor_user_id and
 * actor_org_id as NULL. A security event that cannot say who caused it answers
 * half the question it exists for.
 *
 * The unauthenticated half is the one the security issues needed: an anonymous
 * caller trips an audit, and the row must still carry the network identity even
 * though there is no user behind it.
 *
 * Observing it takes a detour. Every request-scoped emitter in the tree is
 * Tier 2, so the row sits in the bounded queue rather than on disk while the
 * server runs. handle.stop() drains that queue, so the assertion happens after
 * shutdown, against a reopened database.
 */
const ENV_KEYS = [
  "COORDINATOR_OAUTH_ENABLED",
  "COORDINATOR_JWT_SECRET",
  "COORDINATOR_PUBLIC_URL",
  "COORDINATOR_GITHUB_CLIENT_ID",
  "COORDINATOR_GITHUB_CLIENT_SECRET",
  "COORDINATOR_GITHUB_ORG",
] as const;

let snapshot: Record<string, string | undefined> = {};
let dataDir: string;
let handle: ServerHandle | undefined;

function post(port: number, body: string, userAgent: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/auth/oauth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": userAgent,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) snapshot[k] = process.env[k];
  dataDir = mkdtempSync(path.join(tmpdir(), "audit-actor-"));
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  try {
    closeDb();
  } catch {
    // already closed by stop()
  }
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite handle a moment after close.
  }
}, 60000);

describe("audit rows carry the requester's network identity (#319)", () => {
  it("records actor_ip and actor_user_agent for an anonymous caller", async () => {
    process.env.COORDINATOR_OAUTH_ENABLED = "true";
    process.env.COORDINATOR_JWT_SECRET = "ZGVhZGJlZWZjYWZlYmFiZTAxMjM0NTY3ODlhYmNkZWY9elk5cQ==";
    process.env.COORDINATOR_PUBLIC_URL = "http://127.0.0.1";
    // Phase 2 refuses to boot with no IdP registered. These are never used:
    // the request names an unregistered provider and 400s before any network
    // call is made.
    process.env.COORDINATOR_GITHUB_CLIENT_ID = "test-client-id";
    process.env.COORDINATOR_GITHUB_CLIENT_SECRET = "test-client-secret";
    process.env.COORDINATOR_GITHUB_ORG = "test-org";

    const { startServer } = (await import("../../src/serve-http.js")) as {
      startServer: typeof StartServerFn;
    };
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });

    // An unregistered provider name on the token endpoint emits
    // auth.provider.unknown (#305) -- Tier 2, from inside the request.
    const status = await post(
      handle.port,
      "grant_type=authorization_code&code=c&redirect_uri=http%3A%2F%2Fx%2Fcb&provider=nope",
      "regression-probe/1.0",
    );
    expect(status).toBe(400);

    // Drain: stop() flushes the Tier 2 queue, then we reopen to read it.
    await handle.stop();
    handle = undefined;
    initDatabase(dataDir);

    const row = getDb()
      .prepare(
        "SELECT actor_ip, actor_user_agent FROM audit_log WHERE action = 'auth.provider.unknown' ORDER BY id DESC LIMIT 1",
      )
      .get() as { actor_ip: string | null; actor_user_agent: string | null } | undefined;

    expect(row, "no auth.provider.unknown row was written").toBeDefined();
    expect(row?.actor_user_agent).toBe("regression-probe/1.0");
    expect(row?.actor_ip).toBeTruthy();
  }, 60000);
});
