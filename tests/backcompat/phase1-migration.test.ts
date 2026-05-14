import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "node:fs";
import path from "node:path";

/**
 * T43 — Phase 1 backcompat: schema migration to v8.
 *
 * Constructs a fresh DB at the Phase 1 (pre-v8) schema with realistic
 * seeded data, then runs initDatabase to apply the v0.7→v0.8 migration.
 * Asserts:
 *   - user_version becomes 8
 *   - Data preserved through column renames (org_id → primary_org_id, etc.)
 *   - Backfills populate new NOT NULL / business-critical columns:
 *       users.token_epoch = 0
 *       refresh_tokens.family_id = lowercase 32-char hex
 *       audit_log.outcome = 'legacy_unknown' (Phase 1 rows)
 *   - Re-running initDatabase is idempotent (no duplicate rows, no errors)
 *
 * This is an INTEGRATION test that exercises the full upgrade path on
 * realistic Phase 1 data. Skips the heavyweight binary fixture in favor of
 * in-memory schema construction (more maintainable + reviewable).
 *
 * Refs: V2 §B T43, plan v1 §T43.
 */

const DIR = "data-test-backcompat-migration";

beforeAll(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  // Build the Phase 1 (post-v0.7 migration) schema manually. Mirrors the
  // SCHEMA constant at the top of src/database.ts BUT with pre-v8 column
  // names (org_id NOT primary_org_id; user_id/ip/user_agent/metadata on
  // audit_log instead of actor_*). After the seeded inserts, set
  // user_version=7 so initDatabase enters the v0.7→v0.8 branch.
  const { default: Database } = await import("better-sqlite3");
  const dbPath = path.join(DIR, "coordinator.db");
  const raw = new Database(dbPath);
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orgs (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      idp_provider  TEXT,
      idp_org_id    TEXT,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE users (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL REFERENCES orgs(id),
      email           TEXT NOT NULL,
      name            TEXT,
      idp_provider    TEXT NOT NULL,
      idp_user_id     TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'member',
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at   TEXT,
      UNIQUE(idp_provider, idp_user_id)
    );
    CREATE INDEX idx_users_org ON users(org_id);
    CREATE TABLE refresh_tokens (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL REFERENCES orgs(id),
      user_id         TEXT NOT NULL REFERENCES users(id),
      jti             TEXT NOT NULL UNIQUE,
      device_label    TEXT,
      expires_at      TEXT NOT NULL,
      revoked_at      TEXT,
      last_used_at    TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE device_auth_requests (
      device_code      TEXT PRIMARY KEY,
      user_code        TEXT NOT NULL UNIQUE,
      nonce            TEXT NOT NULL UNIQUE,
      approved_user_id TEXT REFERENCES users(id),
      org_id           TEXT,
      expires_at       TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         TEXT,
      org_id          TEXT,
      action          TEXT NOT NULL,
      target          TEXT,
      ip              TEXT,
      user_agent      TEXT,
      metadata        TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO orgs (id, name) VALUES ('default', 'Default Organization');
  `);
  // Seed REALISTIC Phase 1 data — multiple users, multiple refresh tokens,
  // multiple audit rows — so backfills are exercised on more than one row.
  const insertUser = raw.prepare(
    "INSERT INTO users (id, org_id, email, idp_provider, idp_user_id, role) VALUES (?,?,?,?,?,?)"
  );
  insertUser.run("user-alice", "default", "alice@example.com", "github", "alice-gh", "member");
  insertUser.run("user-bob", "default", "bob@example.com", "github", "bob-gh", "admin");
  insertUser.run("user-carol", "default", "carol@example.com", "github", "carol-gh", "member");

  const insertRefresh = raw.prepare(
    "INSERT INTO refresh_tokens (id, org_id, user_id, jti, expires_at) VALUES (?,?,?,?,?)"
  );
  insertRefresh.run("rt-1", "default", "user-alice", "jti-1", "2099-01-01T00:00:00Z");
  insertRefresh.run("rt-2", "default", "user-bob",   "jti-2", "2099-01-01T00:00:00Z");
  insertRefresh.run("rt-3", "default", "user-bob",   "jti-3", "2099-01-01T00:00:00Z"); // 2nd device

  const insertAudit = raw.prepare(
    "INSERT INTO audit_log (user_id, org_id, action, ip, user_agent, metadata) VALUES (?,?,?,?,?,?)"
  );
  insertAudit.run("user-alice", "default", "auth.login.success", "1.2.3.4", "Mozilla/5.0", JSON.stringify({ phase: 1 }));
  insertAudit.run("user-bob",   "default", "thread.create", "5.6.7.8", "Mozilla/5.0", JSON.stringify({ thread_id: "t1" }));
  insertAudit.run(null, "default", "auth.login.failure", "9.10.11.12", "evil-bot/1.0", JSON.stringify({ reason: "bad_password" }));

  raw.exec("PRAGMA user_version = 7;");
  raw.close();

  // Run the real v0.8 migration via initDatabase.
  initDatabase(DIR);
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* EBUSY ignored */ }
});

describe("Phase 1 → v8 migration (T43)", () => {
  it("user_version is bumped to 8", () => {
    const v = getDb().prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(8);
  });

  it("users primary_org_id column receives renamed Phase 1 org_id data", () => {
    const rows = getDb()
      .prepare("SELECT id, primary_org_id FROM users ORDER BY id")
      .all() as { id: string; primary_org_id: string }[];
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.primary_org_id).toBe("default");
    }
  });

  it("users.token_epoch backfilled to 0 (V4 FIX 4 default)", () => {
    const rows = getDb()
      .prepare("SELECT id, token_epoch, idp_access_token FROM users ORDER BY id")
      .all() as { id: string; token_epoch: number; idp_access_token: string | null }[];
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.token_epoch).toBe(0);
      expect(r.idp_access_token).toBeNull();
    }
  });

  it("audit_log Phase 1 rows backfilled with outcome='legacy_unknown'", () => {
    // The seeded Phase 1 rows had NULL outcome (column didn't exist) — the
    // migration's UPDATE ... WHERE outcome IS NULL fills them in. Plus we
    // expect the migration.audit_backfill provenance row.
    const phase1Rows = getDb()
      .prepare(
        "SELECT action, outcome, actor_user_id, actor_ip FROM audit_log " +
        "WHERE action IN ('auth.login.success', 'thread.create', 'auth.login.failure') ORDER BY id",
      )
      .all() as { action: string; outcome: string; actor_user_id: string | null; actor_ip: string }[];
    expect(phase1Rows).toHaveLength(3);
    for (const r of phase1Rows) {
      expect(r.outcome).toBe("legacy_unknown");
    }
    // Data preserved through rename
    const loginRow = phase1Rows.find((r) => r.action === "auth.login.success")!;
    expect(loginRow.actor_user_id).toBe("user-alice");
    expect(loginRow.actor_ip).toBe("1.2.3.4");
    // Null user_id row preserved as null
    const failureRow = phase1Rows.find((r) => r.action === "auth.login.failure")!;
    expect(failureRow.actor_user_id).toBeNull();
  });

  it("migration.audit_backfill provenance row emitted exactly once", () => {
    const rows = getDb()
      .prepare(
        "SELECT outcome, metadata_json FROM audit_log " +
        "WHERE action = 'migration.audit_backfill' ORDER BY id",
      )
      .all() as { outcome: string; metadata_json: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("success");
    const meta = JSON.parse(rows[0].metadata_json);
    expect(meta.from_version).toBe(7);
    expect(meta.to_version).toBe(8);
    expect(meta.rows_marked_legacy).toBeGreaterThanOrEqual(3);
  });

  it("refresh_tokens Phase 1 rows get family_id backfilled (random hex), parent_jti=NULL", () => {
    const rows = getDb()
      .prepare(
        "SELECT id, family_id, parent_jti, replay_count FROM refresh_tokens ORDER BY id",
      )
      .all() as {
        id: string;
        family_id: string;
        parent_jti: string | null;
        replay_count: number;
      }[];
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      // randomblob(16) → 32 lowercase hex chars
      expect(r.family_id).toMatch(/^[0-9a-f]{32}$/);
      // Each Phase 1 token is its own family root
      expect(r.parent_jti).toBeNull();
      expect(r.replay_count).toBe(0);
    }
    // Each Phase 1 row got a UNIQUE family_id (random hex on backfill)
    const families = new Set(rows.map((r) => r.family_id));
    expect(families.size).toBe(3);
  });

  it("user_orgs join table backfilled from users.primary_org_id (1 row per user)", () => {
    const userOrgs = getDb()
      .prepare("SELECT user_id, org_id, role FROM user_orgs ORDER BY user_id")
      .all() as { user_id: string; org_id: string; role: string }[];
    expect(userOrgs).toHaveLength(3);
    expect(userOrgs.map((r) => r.user_id)).toEqual(["user-alice", "user-bob", "user-carol"]);
    for (const r of userOrgs) {
      expect(r.org_id).toBe("default");
    }
    expect(userOrgs.find((r) => r.user_id === "user-bob")?.role).toBe("admin");
  });

  it("re-running initDatabase is idempotent (no duplicate rows, no errors)", () => {
    closeDb();
    // First re-run
    initDatabase(DIR);
    // Second re-run for good measure — migration must withstand multiple
    // boots on an already-upgraded DB. Real-world: container restarts.
    closeDb();
    initDatabase(DIR);

    const userOrgsCount = getDb()
      .prepare("SELECT COUNT(*) AS c FROM user_orgs")
      .get() as { c: number };
    expect(userOrgsCount.c).toBe(3); // Not 6, not 9.

    const backfillCount = getDb()
      .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'migration.audit_backfill'")
      .get() as { c: number };
    expect(backfillCount.c).toBe(1); // Only the first migration emitted the marker.

    const v = getDb()
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    expect(v.user_version).toBe(8);
  });

  it("re-running initDatabase does NOT re-backfill family_id (stable across boots)", () => {
    // After the prior test re-ran initDatabase twice, family_ids must be
    // STABLE — the UPDATE has WHERE family_id IS NULL, so re-running on a
    // already-populated DB must be a no-op. If family_ids changed across
    // boots, refresh-token rotation would lose all in-flight families.
    const before = getDb()
      .prepare("SELECT id, family_id FROM refresh_tokens ORDER BY id")
      .all() as { id: string; family_id: string }[];

    closeDb();
    initDatabase(DIR);

    const after = getDb()
      .prepare("SELECT id, family_id FROM refresh_tokens ORDER BY id")
      .all() as { id: string; family_id: string }[];

    expect(after).toEqual(before);
  });

  it("FK enforcement is re-enabled after migration completes", () => {
    const fk = getDb().prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });
});
