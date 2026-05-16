import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "fs";

const DIR = "data-test-orgs-migration";

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("orgs table", () => {
  it("exists after init", () => {
    const db = getDb();
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='orgs'"
    ).get();
    expect(row).toBeDefined();
  });

  it("seeds the default org on first boot", () => {
    const db = getDb();
    const row = db.prepare("SELECT id, name FROM orgs WHERE id = 'default'").get() as {
      id: string;
      name: string;
    };
    expect(row.id).toBe("default");
    expect(row.name).toBe("Default Organization");
  });

  it("has the expected columns (+ v0.10.2 allowlist_idp_org_id)", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(orgs)").all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    // v0.8 adds allowlist_github_org for B-NEW-4 Phase 5 SaaS readiness
    // v0.10.2 adds allowlist_idp_org_id (T56, generic IdP-supplied org)
    expect(names).toEqual([
      "allowlist_github_org", "allowlist_idp_org_id", "created_at", "id",
      "idp_org_id", "idp_provider", "name",
    ]);
  });
});

describe("users table", () => {
  it("exists with expected columns (v0.10: + idp_refresh_token for GitHub App T54)", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string; notnull: number }[];
    const names = cols.map((c) => c.name).sort();
    // v0.8: org_id → primary_org_id (renamed); + token_epoch (NR12 + Q8), idp_access_token (V4 FIX 4)
    // v0.10.0: + idp_refresh_token (T54, GitHub App user-to-server refresh)
    expect(names).toEqual([
      "created_at", "email", "id", "idp_access_token", "idp_provider",
      "idp_refresh_token", "idp_user_id", "last_login_at", "name",
      "primary_org_id", "role", "token_epoch",
    ]);
  });

  it("enforces UNIQUE(idp_provider, idp_user_id)", () => {
    const db = getDb();
    db.prepare("INSERT INTO orgs (id, name) VALUES ('o1', 'Org 1')").run();
    db.prepare(
      "INSERT INTO users (id, primary_org_id, email, idp_provider, idp_user_id) VALUES (?, ?, ?, ?, ?)"
    ).run("u1", "o1", "a@x", "github", "12345");
    expect(() =>
      db.prepare(
        "INSERT INTO users (id, primary_org_id, email, idp_provider, idp_user_id) VALUES (?, ?, ?, ?, ?)"
      ).run("u2", "o1", "b@x", "github", "12345")
    ).toThrow(/UNIQUE/);
  });

  it("idx_users_org survives RENAME COLUMN (auto-points to primary_org_id)", () => {
    const db = getDb();
    // Phase 1 created idx_users_org ON users(org_id). v0.8 RENAME COLUMN keeps
    // the index name but auto-points it at the new column name (SQLite ≥3.25).
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_org'"
    ).get();
    expect(row).toBeDefined();
  });
});

describe("refresh_tokens table", () => {
  it("exists with expected columns (Phase 1 + v0.8 family lineage + reuse detection)", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(refresh_tokens)").all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    // v0.8 adds: family_id, parent_jti, revoked_reason, replay_count, consumer_fingerprint
    expect(names).toEqual([
      "consumer_fingerprint", "created_at", "device_label", "expires_at", "family_id",
      "id", "jti", "last_used_at", "org_id", "parent_jti",
      "replay_count", "revoked_at", "revoked_reason", "user_id",
    ]);
  });

  it("has Phase 1 + v0.8 indexes (incl partial UNIQUE on parent_jti)", () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='refresh_tokens'"
    ).all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_refresh_user");        // Phase 1
    expect(names).toContain("idx_refresh_org_user");    // Phase 1
    expect(names).toContain("idx_refresh_family");      // v0.8
    expect(names).toContain("idx_refresh_parent");      // v0.8 partial UNIQUE
    expect(names).toContain("idx_refresh_user_active"); // v0.8
    expect(names).toContain("idx_refresh_expires");     // v0.8
  });
});

describe("device_auth_requests table", () => {
  it("exists with expected columns (Phase 1 + v0.8 requester forensics + brute-force defense)", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(device_auth_requests)").all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    // v0.8 adds: requester_ip, requester_user_agent, requester_country, failed_approval_attempts,
    // denied_at, denied_reason (V4 FIX 21), last_polled_at, interval (T18 poll grant),
    // approved_at (T20 approve handler)
    expect(names).toEqual([
      "approved_at", "approved_user_id", "created_at", "denied_at", "denied_reason",
      "device_code", "expires_at", "failed_approval_attempts", "interval",
      "last_polled_at", "nonce", "org_id", "requester_country",
      "requester_ip", "requester_user_agent", "user_code",
    ]);
  });

  it("enforces user_code UNIQUE", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO device_auth_requests (device_code, user_code, nonce, expires_at, org_id) VALUES (?, ?, ?, ?, ?)"
    ).run("dc1", "UC1234", "n1", "2099-01-01", "default");
    expect(() =>
      db.prepare(
        "INSERT INTO device_auth_requests (device_code, user_code, nonce, expires_at, org_id) VALUES (?, ?, ?, ?, ?)"
      ).run("dc2", "UC1234", "n2", "2099-01-01", "default")
    ).toThrow(/UNIQUE/);
  });

  it("enforces nonce UNIQUE", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO device_auth_requests (device_code, user_code, nonce, expires_at, org_id) VALUES (?, ?, ?, ?, ?)"
    ).run("dc3", "UC9999", "shared-nonce", "2099-01-01", "default");
    expect(() =>
      db.prepare(
        "INSERT INTO device_auth_requests (device_code, user_code, nonce, expires_at, org_id) VALUES (?, ?, ?, ?, ?)"
      ).run("dc4", "UC8888", "shared-nonce", "2099-01-01", "default")
    ).toThrow(/UNIQUE/);
  });
});

describe("audit_log table", () => {
  it("exists with expected columns (v0.8 renames + request_id + outcome)", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(audit_log)").all() as { name: string; notnull: number }[];
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.id).toBeDefined();
    expect(byName.action).toBeDefined();
    expect(byName.action.notnull).toBe(1);
    // v0.8 renames: user_id → actor_user_id, org_id → actor_org_id,
    // ip → actor_ip, user_agent → actor_user_agent, metadata → metadata_json
    expect(byName.actor_org_id.notnull).toBe(0);
    expect(byName.actor_user_id.notnull).toBe(0);
    expect(byName.actor_ip).toBeDefined();
    expect(byName.actor_user_agent).toBeDefined();
    expect(byName.metadata_json).toBeDefined();
    // v0.8 adds:
    expect(byName.request_id).toBeDefined();
    expect(byName.outcome).toBeDefined();
    // Old names removed by RENAME:
    expect(byName.user_id).toBeUndefined();
    expect(byName.org_id).toBeUndefined();
    expect(byName.ip).toBeUndefined();
    expect(byName.user_agent).toBeUndefined();
    expect(byName.metadata).toBeUndefined();
  });

  it("has time-ordered indexes for org/user/action", () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'"
    ).all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_audit_org_time");
    expect(names).toContain("idx_audit_user");
    expect(names).toContain("idx_audit_action");
  });
});

describe("ALTER existing tables for org_id", () => {
  const TABLES_NEEDING_ORG = [
    "agents", "threads", "thread_messages", "action_summaries",
    "file_activity", "events", "dependency_map", "introspections",
    "agent_activity_status", "revoked_agents", "working_files",
    "git_cochange", "git_cochange_meta", "layer_firings",
  ];

  it.each(TABLES_NEEDING_ORG)("table %s has org_id column", (table) => {
    const db = getDb();
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("org_id");
  });

  it("inserts default org_id when omitted (DEFAULT 'default')", () => {
    const db = getDb();
    db.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run("a-test", "test-agent");
    const row = db.prepare("SELECT org_id FROM agents WHERE id = 'a-test'").get() as
      { org_id: string };
    expect(row.org_id).toBe("default");
  });
});

describe("user_version after migration", () => {
  it("is 8 after a fresh init (v0.8 = Phase 2 schema)", () => {
    const db = getDb();
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(8);
  });
});

describe("indexes added by Task 5 migration", () => {
  it("idx_events_org_id exists (composite index on events for org-scoped reads)", () => {
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_org_id'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("idx_events_org_id");
  });
});
