/**
 * performance-01 — proves the retention Sweeper actually runs when the
 * server boots Phase-1-only (COORDINATOR_OAUTH_ENABLED unset/"false", the
 * default mono-tenant deployment profile). Before this task the Sweeper
 * was only ever instantiated inside bootPhase2 (src/boot.ts), so a
 * Phase-1-only deployment never pruned ANY table — not even Phase 2's
 * audit_log, and certainly not the 5 Phase 1 tables (file_activity,
 * events, thread_messages, action_summaries, layer_firings).
 *
 * R3 (anti-fantôme): starts a real server via startServer(), inserts
 * stale rows directly into the live DB, triggers a real pass on the
 * SAME Sweeper instance the server is running (via handle.sweeper —
 * NOT a fresh throwaway Sweeper), and asserts the stale rows are gone.
 *
 * R5(3): also proves Phase 2 mode does not end up running two Sweeper
 * instances — only one purges Phase 1 + Phase 2 tables together.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import { getDb } from "../../src/database.js";
import { Sweeper } from "../../src/sweeper/index.js";
import { resetAuditQueue } from "../../src/security/audit.js";
import { resetPhase2Auth } from "../../src/auth.js";

const STRONG_SECRET = "ZGVhZGJlZWZjYWZlYmFiZTAxMjM0NTY3ODlhYmNkZWY9elk5cQ==";
const ENV_KEYS = [
  "COORDINATOR_OAUTH_ENABLED",
  "COORDINATOR_JWT_SECRET",
  "COORDINATOR_GITHUB_CLIENT_ID",
  "COORDINATOR_GITHUB_CLIENT_SECRET",
  "COORDINATOR_PUBLIC_URL",
  "COORDINATOR_GITHUB_ORG",
  "COORDINATOR_INSECURE_COOKIES",
] as const;

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
}

let handle: ServerHandle | undefined;
let dataDir: string | undefined;
let envSnapshot: Record<string, string | undefined> | undefined;

afterEach(async () => {
  if (handle) {
    await handle.stop().catch(() => undefined);
    handle = undefined;
  }
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  if (envSnapshot) {
    for (const k of ENV_KEYS) {
      if (envSnapshot[k] === undefined) delete process.env[k];
      else process.env[k] = envSnapshot[k];
    }
    envSnapshot = undefined;
  }
});

describe("Sweeper — Phase-1-only wiring (performance-01)", () => {
  it("startServer exposes a running Sweeper instance when Phase 2 is NOT active", async () => {
    envSnapshot = {};
    for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k]; // Phase-1-only: OAUTH_ENABLED unset

    dataDir = mkdtempSync(path.join(tmpdir(), "sweeper-phase1-"));

    const startSpy = vi.spyOn(Sweeper.prototype, "start");
    try {
      handle = await startServer({
        port: 0,
        dataDir,
        mqttTcpPort: 0,
        registerSignalHandlers: false,
      });
      expect(startSpy).toHaveBeenCalledTimes(1);
    } finally {
      startSpy.mockRestore();
    }

    expect(handle.sweeper).toBeInstanceOf(Sweeper);
  });

  it("R3: a real pass on the live Phase-1-only server actually deletes stale rows from all 5 Phase 1 tables", async () => {
    envSnapshot = {};
    for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];

    dataDir = mkdtempSync(path.join(tmpdir(), "sweeper-phase1-e2e-"));

    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });

    const db = getDb();
    // Parent rows required by FK constraints (thread_messages -> agents/threads,
    // layer_firings has no enforced FK but keep it consistent).
    db.prepare(`INSERT INTO agents (id, name) VALUES ('a1', 'Agent A')`).run();
    db.prepare(
      `INSERT INTO threads (id, initiator_id, subject) VALUES ('t1', 'a1', 'test thread')`,
    ).run();

    // Stale rows (well beyond every Phase 1 retention default) + one fresh
    // row per table so we also prove the sweeper doesn't nuke everything.
    db.prepare(
      `INSERT INTO file_activity (session_id, agent_id, tool_name, file_path, created_at)
       VALUES ('s1','a1','Read','f-old.ts', ?), ('s1','a1','Read','f-new.ts', ?)`,
    ).run(isoDaysAgo(40), isoDaysAgo(1));
    db.prepare(
      `INSERT INTO events (type, payload, created_at) VALUES ('e-old','{}', ?), ('e-new','{}', ?)`,
    ).run(isoDaysAgo(40), isoDaysAgo(1));
    db.prepare(
      `INSERT INTO thread_messages (id, thread_id, agent_id, type, content, round, created_at)
       VALUES ('tm-old','t1','a1','message','hi',1, ?), ('tm-new','t1','a1','message','hi',1, ?)`,
    ).run(isoDaysAgo(60), isoDaysAgo(1));
    db.prepare(
      `INSERT INTO action_summaries (id, session_id, agent_id, summary, created_at)
       VALUES ('as-old','s1','a1','did stuff', ?), ('as-new','s1','a1','did stuff', ?)`,
    ).run(isoDaysAgo(60), isoDaysAgo(1));
    db.prepare(
      `INSERT INTO layer_firings (thread_id, layer, score, agent_id, fired_at)
       VALUES ('t1','L1',1,'a1', ?), ('t1','L1',1,'a1', ?)`,
    ).run(isoDaysAgo(60), isoDaysAgo(1));

    // Trigger a real pass on the ACTUAL instance the server is running —
    // not a throwaway Sweeper built fresh in the test (that would prove
    // nothing about wiring).
    expect(handle.sweeper).toBeInstanceOf(Sweeper);
    handle.sweeper!.runPass();

    expect(
      (db.prepare("SELECT file_path FROM file_activity").all() as { file_path: string }[]).map(
        (r) => r.file_path,
      ),
    ).toEqual(["f-new.ts"]);
    expect(
      (db.prepare("SELECT type FROM events").all() as { type: string }[]).map((r) => r.type),
    ).toEqual(["e-new"]);
    expect(
      (db.prepare("SELECT id FROM thread_messages").all() as { id: string }[]).map((r) => r.id),
    ).toEqual(["tm-new"]);
    expect(
      (db.prepare("SELECT id FROM action_summaries").all() as { id: string }[]).map((r) => r.id),
    ).toEqual(["as-new"]);
    expect(
      (db.prepare("SELECT fired_at FROM layer_firings").all() as { fired_at: string }[]).length,
    ).toBe(1);
  });

  it("R5(3): Phase 2 mode runs exactly ONE Sweeper instance (no double-start)", async () => {
    envSnapshot = {};
    for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];

    // This one keeps the pre-probe: COORDINATOR_PUBLIC_URL must carry the
    // port and is read by startServer at boot, so the number has to exist
    // before the server binds. mqttTcpPort has no such constraint.
    const port = await getFreePort();
    dataDir = mkdtempSync(path.join(tmpdir(), "sweeper-phase2-"));

    process.env.COORDINATOR_OAUTH_ENABLED = "true";
    process.env.COORDINATOR_JWT_SECRET = STRONG_SECRET;
    process.env.COORDINATOR_GITHUB_CLIENT_ID = "test-client-id";
    process.env.COORDINATOR_GITHUB_CLIENT_SECRET = "test-client-secret";
    process.env.COORDINATOR_PUBLIC_URL = `http://localhost:${port}`;
    process.env.COORDINATOR_GITHUB_ORG = "acme-sweeper-phase2-only";
    process.env.COORDINATOR_INSECURE_COOKIES = "true";

    resetAuditQueue();
    resetPhase2Auth();

    // Spy on Sweeper.prototype.start to prove startServer does NOT create
    // and start a second, independent Sweeper on top of bootPhase2's own
    // instance when Phase 2 is active.
    const startSpy = vi.spyOn(Sweeper.prototype, "start");
    try {
      handle = await startServer({
        port,
        dataDir,
        mqttTcpPort: 0,
        registerSignalHandlers: false,
      });
      expect(startSpy).toHaveBeenCalledTimes(1);
    } finally {
      startSpy.mockRestore();
    }

    // Exactly one Sweeper is exposed by the handle (Phase 2's own, which
    // now also purges the 5 Phase 1 tables) — startServer must NOT have
    // created a second, independent Sweeper on top of bootPhase2's.
    expect(handle.sweeper).toBeInstanceOf(Sweeper);

    const db = getDb();
    db.prepare(`INSERT INTO events (type, payload, created_at) VALUES ('e-old','{}', ?)`).run(
      isoDaysAgo(40),
    );
    handle.sweeper!.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c).toBe(0);
  });
});
