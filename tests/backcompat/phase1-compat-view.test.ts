import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "node:fs";
import path from "node:path";

/**
 * T43 — Phase 1 backcompat: users_legacy_v0_7 compat view.
 *
 * The v0.7→v0.8 migration renames the Phase 1 users `org_id` column
 * to `primary_org_id`. To preserve direct-SQL consumers that were
 * querying the Phase 1 column (read-only reporting tools, dashboards),
 * the migration creates a SQL VIEW `users_legacy_v0_7` that aliases
 * primary_org_id back to org_id. T43 pins this contract.
 *
 * The view is documented as deprecated; per CHANGELOG it is scheduled
 * for removal in v0.9.0.
 *
 * Refs: V2 §B T01a, T43.
 */

const DIR = "data-test-backcompat-view";

beforeAll(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  // Same setup as phase1-migration.test.ts: build the Phase 1 schema,
  // seed it, then run the v0.8 migration. We use a separate test dir
  // so this suite's assertions are independent of phase1-migration's.
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
  raw.prepare(
    "INSERT INTO users (id, org_id, email, name, idp_provider, idp_user_id, role, last_login_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run("user-alice", "default", "alice@example.com", "Alice Adams", "github", "alice-gh", "member", "2026-01-01T00:00:00Z");
  raw.prepare(
    "INSERT INTO users (id, org_id, email, name, idp_provider, idp_user_id, role) VALUES (?,?,?,?,?,?,?)"
  ).run("user-bob", "default", "bob@example.com", "Bob Brown", "github", "bob-gh", "admin");
  raw.exec("PRAGMA user_version = 7;");
  raw.close();

  initDatabase(DIR);
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* EBUSY ignored */ }
});

describe("users_legacy_v0_7 compat view (T43)", () => {
  it("query SELECT org_id FROM users_legacy_v0_7 returns the renamed primary_org_id value", () => {
    const rows = getDb()
      .prepare("SELECT id, org_id FROM users_legacy_v0_7 ORDER BY id")
      .all() as { id: string; org_id: string }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.org_id).toBe("default");
    }
  });

  it("view exposes all Phase 1 columns including renamed ones", () => {
    // PRAGMA table_info works on views; columns are derived from the
    // SELECT list of the view definition.
    const cols = getDb()
      .prepare("PRAGMA table_info(users_legacy_v0_7)")
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    // Phase 1 view contract: original column names from the v0.7 baseline.
    expect(names).toContain("id");
    expect(names).toContain("org_id"); // <- aliased from primary_org_id
    expect(names).toContain("email");
    expect(names).toContain("name");
    expect(names).toContain("idp_provider");
    expect(names).toContain("idp_user_id");
    expect(names).toContain("role");
    expect(names).toContain("created_at");
    expect(names).toContain("last_login_at");
    // Phase 2 additions surfaced through the view (read-only forward signal).
    expect(names).toContain("token_epoch");
    // Phase 2-only column intentionally hidden from the view.
    expect(names).not.toContain("primary_org_id");
    expect(names).not.toContain("idp_access_token");
  });

  it("view returns one row per users row (no projection drift)", () => {
    const viewCount = getDb()
      .prepare("SELECT COUNT(*) AS c FROM users_legacy_v0_7")
      .get() as { c: number };
    const tableCount = getDb()
      .prepare("SELECT COUNT(*) AS c FROM users")
      .get() as { c: number };
    expect(viewCount.c).toBe(tableCount.c);
    expect(viewCount.c).toBe(2);
  });

  it("view returns same logical data shape as Phase 1 users table", () => {
    const aliceFromView = getDb()
      .prepare("SELECT id, org_id, email, name, idp_provider, idp_user_id, role FROM users_legacy_v0_7 WHERE id = ?")
      .get("user-alice") as Record<string, unknown>;
    expect(aliceFromView).toMatchObject({
      id: "user-alice",
      org_id: "default",
      email: "alice@example.com",
      name: "Alice Adams",
      idp_provider: "github",
      idp_user_id: "alice-gh",
      role: "member",
    });
  });

  it("direct INSERT into the view fails (view is read-only)", () => {
    // SQLite VIEWs are non-updatable unless INSTEAD OF triggers exist.
    // The migration intentionally creates NO such triggers — protects
    // data integrity. Phase 1 readers must migrate their writes to
    // the underlying users table, not write through the deprecated view.
    expect(() => {
      getDb()
        .prepare(
          "INSERT INTO users_legacy_v0_7 (id, org_id, email, idp_provider, idp_user_id) " +
          "VALUES ('user-evil', 'default', 'e@x.com', 'github', 'evil-gh')",
        )
        .run();
    }).toThrow();
  });
});
