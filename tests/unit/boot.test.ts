import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { bootPhase2, BootValidationError } from "../../src/boot.js";
import { FakeClock } from "../helpers/clock.js";
import { resetAuditQueue } from "../../src/security/audit.js";
import { resetPhase2Auth } from "../../src/auth.js";
import {
  initDatabase as initGlobalDatabase,
  getDb as getGlobalDb,
  closeDb as closeGlobalDb,
} from "../../src/database.js";
import fs from "node:fs";

/**
 * T29 boot validation tests.
 *
 * Strategy: each test spins up a fresh in-memory better-sqlite3 instance with
 * the minimal schema bootPhase2 touches (orgs, users, audit_log). The Tier 1
 * `config.boot` + `recovery.*` audits emitted by bootPhase2 route through
 * `audit()`, which reads `getDb()` (the global singleton). To make those
 * writes go to our test DB, we initialize the global DB on disk once
 * per suite and use SAVEPOINT-style cleanup between tests.
 *
 * Env var management: every test that mutates COORDINATOR_* keys must
 * restore them in afterEach. We snapshot the originals before any test and
 * restore them after the suite.
 */

const ENV_KEYS = [
  "COORDINATOR_OAUTH_ENABLED",
  "COORDINATOR_JWT_SECRET",
  "COORDINATOR_GITHUB_CLIENT_ID",
  "COORDINATOR_GITHUB_CLIENT_SECRET",
  "COORDINATOR_PUBLIC_URL",
  "COORDINATOR_GITHUB_ORG",
  "COORDINATOR_INSECURE_COOKIES",
  "COORDINATOR_ALLOW_RESTORE",
  "COORDINATOR_JWT_SECRET_PREV",
  "COORDINATOR_JWT_SECRET_PREV_ROTATED_AT",
  "COORDINATOR_GITHUB_AUTH_BASE_URL",
  "COORDINATOR_GITHUB_API_BASE_URL",
  "COORDINATOR_GOOGLE_CLIENT_ID",
  "COORDINATOR_GOOGLE_CLIENT_SECRET",
  "COORDINATOR_OIDC_ISSUER_URL",
  "COORDINATOR_OIDC_CLIENT_ID",
  "COORDINATOR_OIDC_CLIENT_SECRET",
];

// 32 random bytes (high entropy, no dictionary words) — passes
// assertSecretEntropy(128).
const STRONG_SECRET = "ZGVhZGJlZWZjYWZlYmFiZTAxMjM0NTY3ODlhYmNkZWY=xY9q";
// A DIFFERENT high-entropy secret used as the "prev" during rotation
// overlap tests. Distinct bytes from STRONG_SECRET to ensure boot wires
// them through as separate kid entries.
const STRONG_SECRET_PREV = "QkJCQkNDQ0NEREREMTIzNDU2N3F4UnZMbXp6OUtPUEFi";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS orgs (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    allowlist_github_org  TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    email        TEXT,
    token_epoch  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id     TEXT,
    actor_org_id      TEXT,
    action            TEXT NOT NULL,
    target            TEXT,
    actor_ip          TEXT,
    actor_user_agent  TEXT,
    request_id        TEXT,
    outcome           TEXT,
    metadata_json     TEXT,
    prev_hash         TEXT,
    row_hash          TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
  );
`;

const DATA_DIR = "data-test-boot";
let envSnapshot: Record<string, string | undefined>;
let db: Database.Database;
let clock: FakeClock;

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function applyValidEnv(): void {
  setEnv({
    COORDINATOR_OAUTH_ENABLED: "true",
    COORDINATOR_JWT_SECRET: STRONG_SECRET,
    COORDINATOR_GITHUB_CLIENT_ID: "test-client-id",
    COORDINATOR_GITHUB_CLIENT_SECRET: "test-client-secret",
    COORDINATOR_PUBLIC_URL: "http://localhost:3100",
    COORDINATOR_GITHUB_ORG: "acme",
    COORDINATOR_INSECURE_COOKIES: undefined,
    COORDINATOR_ALLOW_RESTORE: undefined,
  });
}

beforeEach(() => {
  // Snapshot env keys this suite touches.
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];

  // Reset module-level singletons so prior tests don't leak.
  resetAuditQueue();
  resetPhase2Auth();

  // Initialize the global DB used by audit() (writes config.boot Tier 1).
  // The global DB owns the audit_log table for these tests; the `db`
  // injected into bootPhase2 IS the same instance for restore-check + orgs
  // table operations.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  initGlobalDatabase(DATA_DIR);
  // Cast adapter to better-sqlite3 surface (structurally compatible).
  db = getGlobalDb() as unknown as Database.Database;
  // Clear test-relevant tables to isolate cases. The real DB schema has
  // many more columns than our minimal SCHEMA above, but the orgs +
  // audit_log + users surface bootPhase2 reads/writes is a strict subset.
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM users");
  db.exec("DELETE FROM orgs");

  clock = new FakeClock(1_700_000_000);
});

afterEach(() => {
  // Restore env to suite-entry values.
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  resetAuditQueue();
  resetPhase2Auth();
  try {
    closeGlobalDb();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* Windows EBUSY ignored — vitest re-runs handle file locks */
  }
});

describe("bootPhase2 — disabled path", () => {
  it("returns null when enabled=false (Phase 1 compatibility)", () => {
    const result = bootPhase2({ enabled: false, db, clock });
    expect(result).toBeNull();
  });
});

describe("bootPhase2 — required env validation", () => {
  it("throws BootValidationError when COORDINATOR_JWT_SECRET is missing", () => {
    applyValidEnv();
    delete process.env.COORDINATOR_JWT_SECRET;
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      BootValidationError,
    );
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /COORDINATOR_JWT_SECRET is required/,
    );
  });

  it("throws BootValidationError when COORDINATOR_GITHUB_CLIENT_ID is missing", () => {
    applyValidEnv();
    delete process.env.COORDINATOR_GITHUB_CLIENT_ID;
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /COORDINATOR_GITHUB_CLIENT_ID is required/,
    );
  });

  it("throws BootValidationError when COORDINATOR_GITHUB_CLIENT_SECRET is missing", () => {
    applyValidEnv();
    delete process.env.COORDINATOR_GITHUB_CLIENT_SECRET;
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /COORDINATOR_GITHUB_CLIENT_SECRET is required/,
    );
  });

  it("throws BootValidationError when COORDINATOR_PUBLIC_URL is missing", () => {
    applyValidEnv();
    delete process.env.COORDINATOR_PUBLIC_URL;
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /COORDINATOR_PUBLIC_URL is required/,
    );
  });

  it("throws BootValidationError when COORDINATOR_GITHUB_ORG is missing", () => {
    applyValidEnv();
    delete process.env.COORDINATOR_GITHUB_ORG;
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /COORDINATOR_GITHUB_ORG is required/,
    );
  });

  it("throws when a required env var is whitespace-only (treated as missing)", () => {
    applyValidEnv();
    process.env.COORDINATOR_GITHUB_ORG = "   ";
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      BootValidationError,
    );
  });
});

describe("bootPhase2 — PUBLIC_URL validation", () => {
  it("throws when PUBLIC_URL is not a valid URL", () => {
    applyValidEnv();
    process.env.COORDINATOR_PUBLIC_URL = "not-a-url";
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /is not a valid URL/,
    );
  });

  it("throws when PUBLIC_URL uses an unsupported scheme (ftp://)", () => {
    applyValidEnv();
    process.env.COORDINATOR_PUBLIC_URL = "ftp://example.com";
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /must be http:\/\/ or https:\/\//,
    );
  });

  it("throws when PUBLIC_URL uses http:// with non-localhost host and no INSECURE_COOKIES override", () => {
    applyValidEnv();
    process.env.COORDINATOR_PUBLIC_URL = "http://example.com:3100";
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /COORDINATOR_INSECURE_COOKIES=true to override/,
    );
  });

  it("accepts http://localhost without INSECURE_COOKIES", () => {
    applyValidEnv();
    process.env.COORDINATOR_PUBLIC_URL = "http://localhost:3100";
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    void result!.shutdown();
  });

  it("accepts http://127.0.0.1 without INSECURE_COOKIES", () => {
    applyValidEnv();
    process.env.COORDINATOR_PUBLIC_URL = "http://127.0.0.1:3100";
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    void result!.shutdown();
  });

  it("accepts http:// non-localhost WITH COORDINATOR_INSECURE_COOKIES=true", () => {
    applyValidEnv();
    process.env.COORDINATOR_PUBLIC_URL = "http://example.com:3100";
    process.env.COORDINATOR_INSECURE_COOKIES = "true";
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    void result!.shutdown();
  });

  it("accepts https:// non-localhost without override", () => {
    applyValidEnv();
    process.env.COORDINATOR_PUBLIC_URL = "https://prod.example.com";
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    void result!.shutdown();
  });
});

describe("bootPhase2 — JWT secret entropy", () => {
  it("rejects a dictionary-word secret (e.g. 'changeme')", () => {
    applyValidEnv();
    process.env.COORDINATOR_JWT_SECRET = "changeme";
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /secret entropy/,
    );
  });

  it("rejects an all-same-byte secret", () => {
    applyValidEnv();
    process.env.COORDINATOR_JWT_SECRET = "a".repeat(64);
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /secret entropy/,
    );
  });

  it("accepts a valid high-entropy secret", () => {
    applyValidEnv();
    // STRONG_SECRET already used; just confirm boot succeeds.
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    void result!.shutdown();
  });
});

describe("bootPhase2 — bootstrap orgs row (B-NEW-4)", () => {
  it("INSERTs a row when no orgs.allowlist_github_org matches env", () => {
    applyValidEnv();
    const before = db.prepare("SELECT COUNT(*) AS n FROM orgs").get() as {
      n: number;
    };
    expect(before.n).toBe(0);
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    const rows = db
      .prepare("SELECT allowlist_github_org FROM orgs")
      .all() as Array<{ allowlist_github_org: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].allowlist_github_org).toBe("acme");
    void result!.shutdown();
  });

  it("does NOT duplicate-INSERT when an orgs row already matches (case-insensitive)", () => {
    applyValidEnv();
    db.prepare(
      "INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)",
    ).run("org-existing", "ACME Corp", "ACME");
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    const rows = db.prepare("SELECT COUNT(*) AS n FROM orgs").get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
    void result!.shutdown();
  });
});

describe("bootPhase2 — NR12 restore detection", () => {
  it("empty audit_log: boot succeeds with no restore check failure", () => {
    applyValidEnv();
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    // No recovery audits should have been emitted.
    const recoveryRows = db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'recovery.%'")
      .get() as { n: number };
    expect(recoveryRows.n).toBe(0);
    void result!.shutdown();
  });

  it("audit_log < 5min stale: boot succeeds, no recovery audit", () => {
    applyValidEnv();
    // Seed an audit row created "just now" relative to fake clock.
    // Use SQL `datetime(?, 'unixepoch')` to convert epoch → ISO string matching
    // the audit_log.created_at format strftime('%s', ...) parses back.
    const recent = clock.now() - 60; // 1 min stale — well within threshold.
    db.prepare(
      `INSERT INTO audit_log (action, created_at)
       VALUES (?, datetime(?, 'unixepoch'))`,
    ).run("seed.recent", recent);
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    const recoveryRows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'recovery.%'",
      )
      .get() as { n: number };
    expect(recoveryRows.n).toBe(0);
    void result!.shutdown();
  });

  it("audit_log > 5min stale + ALLOW_RESTORE unset: throws BootValidationError", () => {
    applyValidEnv();
    const stale = clock.now() - 1000; // ~16 min stale.
    db.prepare(
      `INSERT INTO audit_log (action, created_at)
       VALUES (?, datetime(?, 'unixepoch'))`,
    ).run("seed.stale", stale);
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /Restore suspected/,
    );
  });

  it("audit_log > 5min stale + ALLOW_RESTORE=true: bumps token_epoch + emits recovery audits", () => {
    applyValidEnv();
    process.env.COORDINATOR_ALLOW_RESTORE = "true";
    // Seed a user so bumpTokenEpochAllUsers has something to bump. The real
    // users table has NOT NULL columns we satisfy by listing them explicitly.
    // We pre-create the required parent org row to satisfy the FK on
    // primary_org_id (B-NEW-4 bootstrap runs later in boot, so we'd race it).
    db.prepare(
      "INSERT OR IGNORE INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)",
    ).run("org-seed", "seed", "acme");
    db.prepare(
      `INSERT INTO users (
         id, primary_org_id, email, idp_provider, idp_user_id, role, token_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("u-1", "org-seed", "u1@example.com", "github", "12345", "member", 0);
    const stale = clock.now() - 2000; // ~33 min stale.
    db.prepare(
      `INSERT INTO audit_log (action, created_at)
       VALUES (?, datetime(?, 'unixepoch'))`,
    ).run("seed.stale.allowed", stale);

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();

    // token_epoch should have been bumped (> 0 after bump).
    const userRow = db
      .prepare("SELECT token_epoch FROM users WHERE id = ?")
      .get("u-1") as { token_epoch: number };
    expect(userRow.token_epoch).toBeGreaterThan(0);

    // Recovery audits should be present.
    const tepoch = db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = ?",
      )
      .get("recovery.token_epoch_global_bump") as { n: number };
    expect(tepoch.n).toBe(1);
    const completed = db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = ?",
      )
      .get("recovery.completed") as { n: number };
    expect(completed.n).toBe(1);

    void result!.shutdown();
  });
});

describe("bootPhase2 — success path", () => {
  it("happy boot returns { context, sweeper, shutdown } with composed deps", () => {
    applyValidEnv();
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    const bs = result!;
    expect(bs.context).toBeDefined();
    expect(bs.context.db).toBe(db);
    expect(bs.context.clock).toBe(clock);
    expect(bs.context.publicUrl).toBe("http://localhost:3100");
    expect(bs.context.stateBindingKey).toBeInstanceOf(Buffer);
    expect(bs.context.stateBindingKey.length).toBe(32);
    expect(bs.context.signingKeys.current.kid).toBe("hs256-v1");
    expect(bs.context.rateLimiter).toBeDefined();
    expect(bs.context.membershipCache).toBeDefined();
    const githubProvider = bs.context.providers.get("github");
    expect(githubProvider).not.toBeNull();
    expect(githubProvider!.name).toBe("github");
    expect(bs.sweeper).toBeDefined();
    expect(typeof bs.shutdown).toBe("function");
    void bs.shutdown();
  });

  it("emits config.boot Tier 1 audit with public_url + github_org metadata", () => {
    applyValidEnv();
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    const row = db
      .prepare(
        "SELECT metadata_json FROM audit_log WHERE action = ?",
      )
      .get("config.boot") as { metadata_json: string };
    expect(row).toBeDefined();
    const meta = JSON.parse(row.metadata_json);
    expect(meta.public_url).toBe("http://localhost:3100");
    expect(meta.github_org).toBe("acme");
    void result!.shutdown();
  });

  it("shutdown() drains sweeper + audit queue idempotently", async () => {
    applyValidEnv();
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    await result!.shutdown();
    // Calling shutdown twice should not throw — sweeper.stop is idempotent,
    // audit queue.drain becomes a no-op once closed.
    await result!.shutdown();
  });

  it("shutdown() handles missing audit queue gracefully (defensive null-guard)", async () => {
    applyValidEnv();
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    // Force-clear the audit queue singleton to exercise the `if (queue)`
    // null branch in shutdown. In production the queue is always set when
    // boot succeeds, but a test that resets between rapid restarts could
    // race against this — defend in depth.
    resetAuditQueue();
    await result!.shutdown();
  });

  it("uses realClock when opts.clock is omitted", () => {
    applyValidEnv();
    const result = bootPhase2({ enabled: true, db });
    expect(result).not.toBeNull();
    // realClock.now() returns ~now in epoch seconds — verify the composed
    // context uses something time-like.
    expect(result!.context.clock.now()).toBeGreaterThan(1_600_000_000);
    void result!.shutdown();
  });
});

describe("bootPhase2 — JWT prev-secret rotation overlap (v0.8.1)", () => {
  it("COORDINATOR_JWT_SECRET_PREV unset: boot succeeds, no config.key_rotation audit", () => {
    applyValidEnv();
    // Sanity: ensure prev is not set from a prior test's snapshot.
    delete process.env.COORDINATOR_JWT_SECRET_PREV;
    delete process.env.COORDINATOR_JWT_SECRET_PREV_ROTATED_AT;
    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();

    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = ?",
      )
      .get("config.key_rotation") as { n: number };
    expect(row.n).toBe(0);

    // The signing registry should NOT resolve hs256-v0 (no prev key).
    expect(result!.context.signingKeys.getKey("hs256-v0")).toBeUndefined();
    void result!.shutdown();
  });

  it("COORDINATOR_JWT_SECRET_PREV set: boot wires prev into registry + emits config.key_rotation Tier 1 audit", () => {
    applyValidEnv();
    process.env.COORDINATOR_JWT_SECRET_PREV = STRONG_SECRET_PREV;
    delete process.env.COORDINATOR_JWT_SECRET_PREV_ROTATED_AT;

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();

    // The registry now resolves hs256-v0 to the prev key bytes.
    const v0 = result!.context.signingKeys.getKey("hs256-v0");
    expect(v0).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(v0!).equals(Buffer.from(STRONG_SECRET_PREV, "utf8")))
      .toBe(true);
    // Current kid still signs new tokens with the current secret.
    expect(result!.context.signingKeys.current.kid).toBe("hs256-v1");
    expect(
      Buffer.from(result!.context.signingKeys.current.key).equals(
        Buffer.from(STRONG_SECRET, "utf8"),
      ),
    ).toBe(true);

    // Tier 1 audit row emitted with both kids + rotated_at="unset".
    const audit = db
      .prepare(
        "SELECT metadata_json FROM audit_log WHERE action = ?",
      )
      .get("config.key_rotation") as { metadata_json: string } | undefined;
    expect(audit).toBeDefined();
    const meta = JSON.parse(audit!.metadata_json);
    expect(meta.current_kid).toBe("hs256-v1");
    expect(meta.prev_kid).toBe("hs256-v0");
    expect(meta.rotated_at).toBe("unset");

    void result!.shutdown();
  });

  it("COORDINATOR_JWT_SECRET_PREV weak (dictionary word): throws BootValidationError-like entropy error", () => {
    applyValidEnv();
    process.env.COORDINATOR_JWT_SECRET_PREV = "changeme";
    // assertSecretEntropy throws a generic Error (not BootValidationError);
    // either way boot must fail before composing the registry.
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /secret entropy/,
    );
  });

  it("COORDINATOR_JWT_SECRET_PREV_ROTATED_AT (ISO timestamp): surfaces in audit metadata", () => {
    applyValidEnv();
    process.env.COORDINATOR_JWT_SECRET_PREV = STRONG_SECRET_PREV;
    process.env.COORDINATOR_JWT_SECRET_PREV_ROTATED_AT =
      "2026-05-15T00:00:00Z";

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();

    const audit = db
      .prepare(
        "SELECT metadata_json FROM audit_log WHERE action = ?",
      )
      .get("config.key_rotation") as { metadata_json: string };
    const meta = JSON.parse(audit.metadata_json);
    expect(meta.rotated_at).toBe("2026-05-15T00:00:00Z");
    expect(meta.current_kid).toBe("hs256-v1");
    expect(meta.prev_kid).toBe("hs256-v0");

    void result!.shutdown();
  });

  it("COORDINATOR_JWT_SECRET_PREV whitespace-only: treated as unset (no audit, no prev key)", () => {
    applyValidEnv();
    process.env.COORDINATOR_JWT_SECRET_PREV = "   ";

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();

    expect(result!.context.signingKeys.getKey("hs256-v0")).toBeUndefined();
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = ?",
      )
      .get("config.key_rotation") as { n: number };
    expect(row.n).toBe(0);

    void result!.shutdown();
  });
});

describe("bootPhase2 — GHES base URL wiring (v0.8.1-P2)", () => {
  // GitHubProvider doesn't expose authBaseUrl/apiBaseUrl publicly, so we
  // assert wiring behaviorally via buildAuthUrl — which prefixes with
  // `${this.authBaseUrl}/login/oauth/authorize`. That URL is the observable
  // surface that proves the env var flowed through the constructor.

  it("neither env var set: GitHubProvider defaults to github.com (buildAuthUrl points at github.com)", async () => {
    applyValidEnv();
    delete process.env.COORDINATOR_GITHUB_AUTH_BASE_URL;
    delete process.env.COORDINATOR_GITHUB_API_BASE_URL;

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();

    const authUrl = await result!.context.providers.get("github")!.buildAuthUrl(
      "state-x",
      "https://coordinator.example.com/cb",
    );
    expect(authUrl.startsWith("https://github.com/login/oauth/authorize"))
      .toBe(true);

    void result!.shutdown();
  });

  it("both env vars set: GitHubProvider uses the GHES overrides", async () => {
    applyValidEnv();
    process.env.COORDINATOR_GITHUB_AUTH_BASE_URL = "https://github.example.com";
    process.env.COORDINATOR_GITHUB_API_BASE_URL =
      "https://github.example.com/api/v3";

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();

    const authUrl = await result!.context.providers.get("github")!.buildAuthUrl(
      "state-x",
      "https://coordinator.example.com/cb",
    );
    expect(
      authUrl.startsWith("https://github.example.com/login/oauth/authorize"),
    ).toBe(true);

    void result!.shutdown();
  });

  it("only AUTH_BASE_URL set: auth overridden, api defaults to api.github.com", async () => {
    applyValidEnv();
    process.env.COORDINATOR_GITHUB_AUTH_BASE_URL = "https://github.example.com";
    delete process.env.COORDINATOR_GITHUB_API_BASE_URL;

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();

    const authUrl = await result!.context.providers.get("github")!.buildAuthUrl(
      "state-x",
      "https://coordinator.example.com/cb",
    );
    expect(
      authUrl.startsWith("https://github.example.com/login/oauth/authorize"),
    ).toBe(true);
    // api base default is exercised indirectly: provider construction
    // succeeded with only the auth override, proving the conditional spread
    // didn't accidentally pass undefined as apiBaseUrl.

    void result!.shutdown();
  });

  it("whitespace-only env vars: treated as unset (defaults to github.com)", async () => {
    applyValidEnv();
    process.env.COORDINATOR_GITHUB_AUTH_BASE_URL = "   ";
    process.env.COORDINATOR_GITHUB_API_BASE_URL = "   ";

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();

    const authUrl = await result!.context.providers.get("github")!.buildAuthUrl(
      "state-x",
      "https://coordinator.example.com/cb",
    );
    expect(authUrl.startsWith("https://github.com/login/oauth/authorize"))
      .toBe(true);

    void result!.shutdown();
  });

  it("invalid URL: throws BootValidationError", () => {
    applyValidEnv();
    process.env.COORDINATOR_GITHUB_AUTH_BASE_URL = "not-a-url";

    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      BootValidationError,
    );
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /COORDINATOR_GITHUB_AUTH_BASE_URL is not a valid URL/,
    );
  });

  it("non-http(s) scheme: throws BootValidationError", () => {
    applyValidEnv();
    process.env.COORDINATOR_GITHUB_API_BASE_URL = "ftp://github.example.com";

    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /COORDINATOR_GITHUB_API_BASE_URL must be http:\/\/ or https:\/\//,
    );
  });
});

describe("bootPhase2 — Google IdP wiring (v0.9.0 T47)", () => {
  it("both env vars unset: only github is registered", () => {
    applyValidEnv();
    // Explicitly unset Google vars to make the test self-documenting.
    delete process.env.COORDINATOR_GOOGLE_CLIENT_ID;
    delete process.env.COORDINATOR_GOOGLE_CLIENT_SECRET;

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    expect(result!.context.providers.names()).toEqual(["github"]);
    void result!.shutdown();
  });

  it("both env vars set: registers google as a second provider; github stays default", () => {
    applyValidEnv();
    process.env.COORDINATOR_GOOGLE_CLIENT_ID = "google-cid.apps.googleusercontent.com";
    process.env.COORDINATOR_GOOGLE_CLIENT_SECRET = "google-secret";

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    expect(result!.context.providers.names()).toEqual(["github", "google"]);
    expect(result!.context.providers.getDefault()!.name).toBe("github");
    expect(result!.context.providers.get("google")).not.toBeNull();
    void result!.shutdown();
  });

  it("only client_id set: throws BootValidationError (fail-closed half-config)", () => {
    applyValidEnv();
    process.env.COORDINATOR_GOOGLE_CLIENT_ID = "google-cid.apps.googleusercontent.com";
    delete process.env.COORDINATOR_GOOGLE_CLIENT_SECRET;

    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      BootValidationError,
    );
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /both be set, or both unset/,
    );
  });

  it("only client_secret set: throws BootValidationError", () => {
    applyValidEnv();
    delete process.env.COORDINATOR_GOOGLE_CLIENT_ID;
    process.env.COORDINATOR_GOOGLE_CLIENT_SECRET = "google-secret";

    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /both be set, or both unset/,
    );
  });

  it("whitespace-only env vars: treated as unset", () => {
    applyValidEnv();
    process.env.COORDINATOR_GOOGLE_CLIENT_ID = "   ";
    process.env.COORDINATOR_GOOGLE_CLIENT_SECRET = "   ";

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    expect(result!.context.providers.names()).toEqual(["github"]);
    void result!.shutdown();
  });
});

describe("bootPhase2 — generic OIDC wiring (v0.9.0 T48)", () => {
  it("no OIDC env vars set: registry has only github", () => {
    applyValidEnv();
    delete process.env.COORDINATOR_OIDC_ISSUER_URL;
    delete process.env.COORDINATOR_OIDC_CLIENT_ID;
    delete process.env.COORDINATOR_OIDC_CLIENT_SECRET;

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    expect(result!.context.providers.names()).toEqual(["github"]);
    void result!.shutdown();
  });

  it("all three OIDC env vars set: registers oidc as a second provider", () => {
    applyValidEnv();
    process.env.COORDINATOR_OIDC_ISSUER_URL = "https://idp.example.test/realms/main";
    process.env.COORDINATOR_OIDC_CLIENT_ID = "oidc-cid";
    process.env.COORDINATOR_OIDC_CLIENT_SECRET = "oidc-secret";

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    expect(result!.context.providers.names()).toEqual(["github", "oidc"]);
    expect(result!.context.providers.get("oidc")).not.toBeNull();
    void result!.shutdown();
  });

  it("only issuer set: throws BootValidationError", () => {
    applyValidEnv();
    process.env.COORDINATOR_OIDC_ISSUER_URL = "https://idp.example.test/realms/main";
    delete process.env.COORDINATOR_OIDC_CLIENT_ID;
    delete process.env.COORDINATOR_OIDC_CLIENT_SECRET;

    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      BootValidationError,
    );
    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /must all be set together/,
    );
  });

  it("only client_id set: throws BootValidationError", () => {
    applyValidEnv();
    delete process.env.COORDINATOR_OIDC_ISSUER_URL;
    process.env.COORDINATOR_OIDC_CLIENT_ID = "oidc-cid";
    delete process.env.COORDINATOR_OIDC_CLIENT_SECRET;

    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /must all be set together/,
    );
  });

  it("malformed issuer URL: throws BootValidationError", () => {
    applyValidEnv();
    process.env.COORDINATOR_OIDC_ISSUER_URL = "not-a-url";
    process.env.COORDINATOR_OIDC_CLIENT_ID = "oidc-cid";
    process.env.COORDINATOR_OIDC_CLIENT_SECRET = "oidc-secret";

    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /is not a valid URL/,
    );
  });

  it("ftp:// issuer URL: throws BootValidationError", () => {
    applyValidEnv();
    process.env.COORDINATOR_OIDC_ISSUER_URL = "ftp://idp.example.test";
    process.env.COORDINATOR_OIDC_CLIENT_ID = "oidc-cid";
    process.env.COORDINATOR_OIDC_CLIENT_SECRET = "oidc-secret";

    expect(() => bootPhase2({ enabled: true, db, clock })).toThrow(
      /must be http:\/\/ or https:\/\//,
    );
  });

  it("github + google + oidc all configured: three providers, github default", () => {
    applyValidEnv();
    process.env.COORDINATOR_GOOGLE_CLIENT_ID = "google-cid";
    process.env.COORDINATOR_GOOGLE_CLIENT_SECRET = "google-secret";
    process.env.COORDINATOR_OIDC_ISSUER_URL = "https://idp.example.test/realms/main";
    process.env.COORDINATOR_OIDC_CLIENT_ID = "oidc-cid";
    process.env.COORDINATOR_OIDC_CLIENT_SECRET = "oidc-secret";

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    expect(result!.context.providers.names()).toEqual(["github", "google", "oidc"]);
    expect(result!.context.providers.getDefault()!.name).toBe("github");
    void result!.shutdown();
  });
});
