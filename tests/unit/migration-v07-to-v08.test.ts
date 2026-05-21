import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "fs";
import path from "path";

const DIR = "data-test-v07-to-v08-migration";

beforeAll(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  // Manually create a v0.7-shaped database (post-Phase 1, user_version=7) so the v0.8
  // migration's column renames + ADD COLUMNs + table creations exercise end-to-end.
  // Schema mirrors the Phase 1 final state from src/database.ts SCHEMA constant +
  // v0.6→v0.7 migration outputs.
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
    PRAGMA user_version = 7;
  `);
  // Seed Phase 1 sample data so backfills + renames are exercised on real rows.
  raw.prepare(
    "INSERT INTO users (id, org_id, email, idp_provider, idp_user_id, role) VALUES (?,?,?,?,?,?)"
  ).run("user-1", "default", "alice@example.com", "github", "alice-gh", "member");
  raw.prepare(
    "INSERT INTO refresh_tokens (id, org_id, user_id, jti, expires_at) VALUES (?,?,?,?,?)"
  ).run("rt-1", "default", "user-1", "jti-phase1-1", "2099-01-01T00:00:00Z");
  raw.prepare(
    "INSERT INTO audit_log (user_id, org_id, action, ip, user_agent, metadata) VALUES (?,?,?,?,?,?)"
  ).run("user-1", "default", "auth.login.success", "1.2.3.4", "Mozilla/5.0", JSON.stringify({ phase: 1 }));
  raw.close();

  // Run real v0.8 migration via initDatabase.
  initDatabase(DIR);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("v0.7 → v0.8 migration", () => {
  it("user_version bumped to at least 8 (currently 9 after v0.9 FK migration)", () => {
    const db = getDb();
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    // v0.9 (issue #79) runs after v0.8 in the same initDatabase pass, so on
    // a fresh boot the version arrives at 9. The v0.8-specific migrations
    // exercised below (audit_log column renames, user_orgs backfill,
    // refresh_tokens family_id, etc.) all completed by the time user_version
    // reached 8 — we just don't observe that intermediate state from outside.
    expect(v.user_version).toBeGreaterThanOrEqual(8);
  });

  it("audit_log columns renamed to actor_* + metadata_json", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(audit_log)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("actor_user_id");
    expect(names).toContain("actor_org_id");
    expect(names).toContain("actor_ip");
    expect(names).toContain("actor_user_agent");
    expect(names).toContain("metadata_json");
    expect(names).toContain("request_id");
    expect(names).toContain("outcome");
    // Old names gone
    expect(names).not.toContain("user_id");
    expect(names).not.toContain("ip");
    expect(names).not.toContain("user_agent");
    expect(names).not.toContain("metadata");
  });

  it("audit_log Phase 1 rows backfilled with outcome='legacy_unknown'", () => {
    const db = getDb();
    const row = db.prepare(
      "SELECT outcome, actor_user_id, actor_ip FROM audit_log WHERE action = 'auth.login.success'"
    ).get() as { outcome: string; actor_user_id: string; actor_ip: string };
    expect(row.outcome).toBe("legacy_unknown");
    expect(row.actor_user_id).toBe("user-1"); // data preserved through rename
    expect(row.actor_ip).toBe("1.2.3.4");
  });

  it("audit_log emits migration.audit_backfill provenance event", () => {
    const db = getDb();
    const row = db.prepare(
      "SELECT outcome, metadata_json FROM audit_log WHERE action = 'migration.audit_backfill'"
    ).get() as { outcome: string; metadata_json: string };
    expect(row.outcome).toBe("success");
    const meta = JSON.parse(row.metadata_json);
    expect(meta.from_version).toBe(7);
    expect(meta.to_version).toBe(8);
    expect(meta.rows_marked_legacy).toBeGreaterThanOrEqual(1);
  });

  it("users.org_id renamed to primary_org_id; token_epoch + idp_access_token added", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string; dflt_value: string | null }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("primary_org_id");
    expect(names).toContain("token_epoch");
    expect(names).toContain("idp_access_token");
    expect(names).not.toContain("org_id");
    // Default value pinned for token_epoch (V4 FIX 4)
    const tokenEpoch = cols.find((c) => c.name === "token_epoch");
    expect(tokenEpoch?.dflt_value).toBe("0");
  });

  it("user_orgs table created and backfilled from users.primary_org_id", () => {
    const db = getDb();
    const userOrgs = db.prepare("SELECT user_id, org_id, role FROM user_orgs").all() as
      { user_id: string; org_id: string; role: string }[];
    expect(userOrgs).toHaveLength(1);
    expect(userOrgs[0]).toMatchObject({ user_id: "user-1", org_id: "default", role: "member" });
  });

  it("orgs.allowlist_github_org column added", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(orgs)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("allowlist_github_org");
  });

  it("oauth_state table created with required schema (+ v0.10.1 nonce)", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(oauth_state)").all() as { name: string; pk: number }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      "code_verifier", "consumed_at", "created_at", "expires_at",
      "nonce", "org_id", "provider", "redirect_uri", "state",
    ]);
    // state is the PK
    expect(cols.find((c) => c.name === "state")?.pk).toBe(1);
  });

  it("refresh_tokens gains family_id/parent_jti/replay_count/consumer_fingerprint", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(refresh_tokens)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("family_id");
    expect(names).toContain("parent_jti");
    expect(names).toContain("revoked_reason");
    expect(names).toContain("replay_count");
    expect(names).toContain("consumer_fingerprint");
  });

  it("refresh_tokens Phase 1 row gets family_id backfilled (non-NULL uuid-like)", () => {
    const db = getDb();
    const row = db.prepare("SELECT family_id, parent_jti FROM refresh_tokens WHERE id = 'rt-1'").get() as
      { family_id: string; parent_jti: string | null };
    expect(row.family_id).toMatch(/^[0-9a-f]{32}$/); // hex(randomblob(16)) = 32 lowercase hex chars
    expect(row.parent_jti).toBeNull(); // Phase 1 row is family root
  });

  it("refresh_tokens partial UNIQUE index on parent_jti exists (V4 FIX 6)", () => {
    const db = getDb();
    const idx = db.prepare("PRAGMA index_list(refresh_tokens)").all() as
      { name: string; unique: number }[];
    const parentIdx = idx.find((i) => i.name === "idx_refresh_parent");
    expect(parentIdx).toBeDefined();
    expect(parentIdx?.unique).toBe(1);
  });

  it("device_auth_requests gains requester_* + failed_approval_attempts", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(device_auth_requests)").all() as
      { name: string; dflt_value: string | null }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("requester_ip");
    expect(names).toContain("requester_user_agent");
    expect(names).toContain("requester_country");
    expect(names).toContain("failed_approval_attempts");
    const failedAttempts = cols.find((c) => c.name === "failed_approval_attempts");
    expect(failedAttempts?.dflt_value).toBe("0");
  });

  it("device_auth_requests gains denied_at + denied_reason (V4 FIX 21)", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(device_auth_requests)").all() as
      { name: string; type: string; notnull: number; dflt_value: string | null }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("denied_at");
    expect(names).toContain("denied_reason");
    // Both nullable per spec — existing rows get NULL on ADD COLUMN
    const deniedAt = cols.find((c) => c.name === "denied_at");
    expect(deniedAt?.type).toBe("INTEGER");
    expect(deniedAt?.notnull).toBe(0);
    const deniedReason = cols.find((c) => c.name === "denied_reason");
    expect(deniedReason?.type).toBe("TEXT");
    expect(deniedReason?.notnull).toBe(0);
  });

  it("device_auth_requests gains last_polled_at + interval (T18 poll grant)", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(device_auth_requests)").all() as
      { name: string; type: string; notnull: number; dflt_value: string | null }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("last_polled_at");
    expect(names).toContain("interval");
    // last_polled_at: nullable INTEGER (unix seconds), set on each /token poll
    const lastPolledAt = cols.find((c) => c.name === "last_polled_at");
    expect(lastPolledAt?.type).toBe("INTEGER");
    expect(lastPolledAt?.notnull).toBe(0);
    // interval: NOT NULL INTEGER DEFAULT 5 (RFC 8628 §3.5)
    const interval = cols.find((c) => c.name === "interval");
    expect(interval?.type).toBe("INTEGER");
    expect(interval?.notnull).toBe(1);
    expect(interval?.dflt_value).toBe("5");
  });

  it("system_state table created for NR12 restore detection", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(system_state)").all() as { name: string; pk: number }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["key", "updated_at", "value"]);
    expect(cols.find((c) => c.name === "key")?.pk).toBe(1);
  });

  it("users_legacy_v0_7 compat view returns same logical data as users", () => {
    const db = getDb();
    const viewRow = db.prepare("SELECT id, org_id, email FROM users_legacy_v0_7").get() as
      { id: string; org_id: string; email: string };
    expect(viewRow.id).toBe("user-1");
    expect(viewRow.org_id).toBe("default"); // primary_org_id aliased back to org_id
    expect(viewRow.email).toBe("alice@example.com");
  });

  it("FK enforcement re-enabled after migration", () => {
    const db = getDb();
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  it("migration is idempotent: second initDatabase run does not error or duplicate", () => {
    // Close and reopen — second initDatabase should run all migrations again
    // without throwing and without double-backfilling.
    closeDb();
    initDatabase(DIR);
    const db = getDb();
    const userOrgsCount = db.prepare("SELECT COUNT(*) AS c FROM user_orgs").get() as { c: number };
    expect(userOrgsCount.c).toBe(1); // not 2
    const backfillRowCount = db.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'migration.audit_backfill'"
    ).get() as { c: number };
    expect(backfillRowCount.c).toBe(1); // not 2
    // Version still at the current head (8 after v0.8, 9 after v0.9 FK migration).
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBeGreaterThanOrEqual(8);
  });
});
