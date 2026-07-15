import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Clock } from "../../src/auth/clock.js";
import { Sweeper } from "../../src/sweeper/index.js";
import { TIER1_EVENTS, TIER2_EVENTS } from "../../src/security/audit-events.js";

// FakeClock — same pattern as oauth-state.test.ts and refresh-rotation tests.
class FakeClock implements Clock {
  constructor(public current = 1_700_000_000) {}
  now(): number {
    return this.current;
  }
  advance(s: number): void {
    this.current += s;
  }
}

// Build the minimal Phase 2 schema the sweeper touches. This mirrors the
// post-migration shape in src/database.ts: oauth_state with INTEGER epoch
// columns, refresh_tokens with TEXT timestamps, device_auth_requests with
// TEXT expires_at, and audit_log with TEXT ISO created_at + action column.
const SCHEMA = `
  CREATE TABLE orgs (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL
  );

  CREATE TABLE oauth_state (
    state           TEXT PRIMARY KEY,
    code_verifier   TEXT NOT NULL,
    redirect_uri    TEXT NOT NULL,
    provider        TEXT NOT NULL,
    org_id          TEXT,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    consumed_at     INTEGER,
    nonce           TEXT
  );

  CREATE TABLE device_auth_requests (
    device_code      TEXT PRIMARY KEY,
    user_code        TEXT NOT NULL UNIQUE,
    nonce            TEXT NOT NULL UNIQUE,
    approved_user_id TEXT,
    org_id           TEXT,
    expires_at       TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT '2026-01-01 00:00:00'
  );

  CREATE TABLE refresh_tokens (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    jti             TEXT NOT NULL UNIQUE,
    device_label    TEXT,
    expires_at      TEXT NOT NULL,
    revoked_at      TEXT,
    last_used_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT '2026-01-01 00:00:00'
  );

  CREATE TABLE audit_log (
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
    created_at        TEXT NOT NULL DEFAULT '2026-01-01 00:00:00'
  );

  -- Phase 1 tables (performance-01): TEXT ISO-8601 timestamps, no retention
  -- before this task. layer_firings uses fired_at, the other four use
  -- created_at.
  CREATE TABLE file_activity (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    agent_name  TEXT,
    tool_name   TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    module      TEXT,
    created_at  TEXT DEFAULT '2026-01-01 00:00:00'
  );

  CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT DEFAULT '2026-01-01 00:00:00'
  );

  CREATE TABLE thread_messages (
    id                TEXT PRIMARY KEY,
    thread_id         TEXT NOT NULL,
    agent_id          TEXT NOT NULL,
    agent_name        TEXT,
    type              TEXT NOT NULL,
    content           TEXT NOT NULL,
    context_snapshot  TEXT,
    in_reply_to       TEXT,
    round             INTEGER NOT NULL,
    token_estimate    INTEGER DEFAULT 0,
    created_at        TEXT DEFAULT '2026-01-01 00:00:00'
  );

  CREATE TABLE action_summaries (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    file_path   TEXT,
    summary     TEXT NOT NULL,
    created_at  TEXT DEFAULT '2026-01-01 00:00:00'
  );

  CREATE TABLE layer_firings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT,
    layer      TEXT NOT NULL,
    score      INTEGER NOT NULL,
    agent_id   TEXT,
    fired_at   TEXT DEFAULT '2026-01-01 00:00:00'
  );
`;

let db: Database.Database;
let clock: FakeClock;
let sweeper: Sweeper;
const ENV_BACKUP = { ...process.env };

function isoFromEpoch(epoch: number): string {
  // Match the SQLite CURRENT_TIMESTAMP format: 'YYYY-MM-DD HH:MM:SS' (UTC, no TZ).
  return new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function seedOAuthState(state: string, expiresAt: number): void {
  db.prepare(
    `INSERT INTO oauth_state (state, code_verifier, redirect_uri, provider, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(state, "v", "https://cb", "github", expiresAt - 600, expiresAt);
}

function seedDevice(code: string, expiresAtEpoch: number): void {
  db.prepare(
    `INSERT INTO device_auth_requests (device_code, user_code, nonce, expires_at) VALUES (?, ?, ?, ?)`,
  ).run(code, `uc-${code}`, `n-${code}`, String(expiresAtEpoch));
}

function seedRefreshToken(opts: { id: string; expiresAt: number; revokedAt: number | null }): void {
  db.prepare(
    `INSERT INTO refresh_tokens (id, org_id, user_id, jti, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    "o1",
    "u1",
    `jti-${opts.id}`,
    String(opts.expiresAt),
    opts.revokedAt === null ? null : String(opts.revokedAt),
  );
}

function seedAudit(action: string, createdAtEpoch: number): void {
  db.prepare(`INSERT INTO audit_log (action, outcome, created_at) VALUES (?, 'success', ?)`).run(
    action,
    isoFromEpoch(createdAtEpoch),
  );
}

// ───── Phase 1 table seed helpers (performance-01) ─────
let fileActivitySeq = 0;
function seedFileActivity(createdAtEpoch: number): void {
  fileActivitySeq++;
  db.prepare(
    `INSERT INTO file_activity (session_id, agent_id, tool_name, file_path, created_at)
     VALUES (?, 'a1', 'Read', ?, ?)`,
  ).run(`s-${fileActivitySeq}`, `f-${fileActivitySeq}.ts`, isoFromEpoch(createdAtEpoch));
}

let eventsSeq = 0;
function seedEvent(createdAtEpoch: number): void {
  eventsSeq++;
  db.prepare(`INSERT INTO events (type, payload, created_at) VALUES (?, '{}', ?)`).run(
    `evt-${eventsSeq}`,
    isoFromEpoch(createdAtEpoch),
  );
}

let threadMessagesSeq = 0;
function seedThreadMessage(createdAtEpoch: number): void {
  threadMessagesSeq++;
  db.prepare(
    `INSERT INTO thread_messages (id, thread_id, agent_id, type, content, round, created_at)
     VALUES (?, 't1', 'a1', 'message', 'hi', 1, ?)`,
  ).run(`tm-${threadMessagesSeq}`, isoFromEpoch(createdAtEpoch));
}

let actionSummariesSeq = 0;
function seedActionSummary(createdAtEpoch: number): void {
  actionSummariesSeq++;
  db.prepare(
    `INSERT INTO action_summaries (id, session_id, agent_id, summary, created_at)
     VALUES (?, 's1', 'a1', 'did a thing', ?)`,
  ).run(`as-${actionSummariesSeq}`, isoFromEpoch(createdAtEpoch));
}

function seedLayerFiring(firedAtEpoch: number): void {
  db.prepare(
    `INSERT INTO layer_firings (thread_id, layer, score, agent_id, fired_at)
     VALUES ('t1', 'L1', 1, 'a1', ?)`,
  ).run(isoFromEpoch(firedAtEpoch));
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  clock = new FakeClock();
  sweeper = new Sweeper(db, clock);
});

afterEach(() => {
  sweeper.stop();
  db.close();
  // Restore env snapshot to keep tests hermetic.
  for (const k of Object.keys(process.env)) {
    if (!(k in ENV_BACKUP)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ENV_BACKUP)) {
    process.env[k] = v;
  }
  vi.useRealTimers();
});

// ───── oauth_state sweep (2 cases) ─────
describe("Sweeper — oauth_state", () => {
  it("deletes rows whose expires_at < now - 60s buffer", () => {
    seedOAuthState("expired", clock.now() - 120);
    sweeper.runPass();
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM oauth_state").get() as { c: number };
    expect(remaining.c).toBe(0);
    expect(sweeper.metrics.rowsDeletedByTable.oauth_state).toBe(1);
  });

  it("keeps rows that have not yet passed the 60s buffer", () => {
    // expires_at is still in the future → must be kept.
    seedOAuthState("live", clock.now() + 600);
    // also seed one inside the buffer (expired but within last 60s)
    seedOAuthState("buffered", clock.now() - 30);
    sweeper.runPass();
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM oauth_state").get() as { c: number };
    expect(remaining.c).toBe(2);
    expect(sweeper.metrics.rowsDeletedByTable.oauth_state).toBe(0);
  });
});

// ───── device_auth_requests sweep (2 cases) ─────
describe("Sweeper — device_auth_requests", () => {
  it("deletes rows with TEXT epoch expires_at older than now - 60s", () => {
    seedDevice("dc-expired", clock.now() - 120);
    sweeper.runPass();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM device_auth_requests").get() as { c: number }).c,
    ).toBe(0);
    expect(sweeper.metrics.rowsDeletedByTable.device_auth_requests).toBe(1);
  });

  it("keeps live device codes", () => {
    seedDevice("dc-live", clock.now() + 600);
    sweeper.runPass();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM device_auth_requests").get() as { c: number }).c,
    ).toBe(1);
  });
});

// ───── refresh_tokens revoked retention (3 cases) ─────
describe("Sweeper — refresh_tokens (revoked retention)", () => {
  it("deletes refresh tokens revoked > retention_days ago (default 180)", () => {
    const revoked200dAgo = clock.now() - 200 * 86400;
    seedRefreshToken({ id: "rt-old", expiresAt: clock.now() + 3600, revokedAt: revoked200dAgo });
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM refresh_tokens").get() as { c: number }).c).toBe(
      0,
    );
    expect(sweeper.metrics.rowsDeletedByTable.refresh_tokens_revoked).toBe(1);
  });

  it("keeps refresh tokens revoked within retention window", () => {
    const revoked100dAgo = clock.now() - 100 * 86400;
    seedRefreshToken({ id: "rt-keep", expiresAt: clock.now() + 3600, revokedAt: revoked100dAgo });
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM refresh_tokens").get() as { c: number }).c).toBe(
      1,
    );
    expect(sweeper.metrics.rowsDeletedByTable.refresh_tokens_revoked).toBe(0);
  });

  it("honours env override COORDINATOR_REFRESH_RETENTION_DAYS=90", () => {
    process.env.COORDINATOR_REFRESH_RETENTION_DAYS = "90";
    const revoked100dAgo = clock.now() - 100 * 86400;
    seedRefreshToken({ id: "rt-env", expiresAt: clock.now() + 3600, revokedAt: revoked100dAgo });
    sweeper.runPass();
    // 100d > 90d retention → should now be deleted.
    expect((db.prepare("SELECT COUNT(*) AS c FROM refresh_tokens").get() as { c: number }).c).toBe(
      0,
    );
    expect(sweeper.metrics.rowsDeletedByTable.refresh_tokens_revoked).toBe(1);
  });
});

// ───── refresh_tokens lingering expired un-revoked (2 cases) ─────
describe("Sweeper — refresh_tokens (lingering expired un-revoked)", () => {
  it("deletes un-revoked tokens whose expires_at is > 30d in the past", () => {
    const expired35dAgo = clock.now() - 35 * 86400;
    seedRefreshToken({ id: "rt-35d", expiresAt: expired35dAgo, revokedAt: null });
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM refresh_tokens").get() as { c: number }).c).toBe(
      0,
    );
    expect(sweeper.metrics.rowsDeletedByTable.refresh_tokens_expired).toBe(1);
  });

  it("keeps un-revoked tokens whose expires_at is within the 30d window", () => {
    const expired20dAgo = clock.now() - 20 * 86400;
    seedRefreshToken({ id: "rt-20d", expiresAt: expired20dAgo, revokedAt: null });
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM refresh_tokens").get() as { c: number }).c).toBe(
      1,
    );
    expect(sweeper.metrics.rowsDeletedByTable.refresh_tokens_expired).toBe(0);
  });
});

// ───── audit_log Tier 1 (2 cases) ─────
describe("Sweeper — audit_log Tier 1", () => {
  it("deletes Tier 1 events older than audit_retention_days (default 365)", () => {
    const t1Action = TIER1_EVENTS[0]; // auth.refresh.chain_revoked
    seedAudit(t1Action, clock.now() - 400 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c).toBe(0);
    expect(sweeper.metrics.rowsDeletedByTable.audit_log_tier1).toBe(1);
  });

  it("keeps Tier 1 events within the 365d window", () => {
    const t1Action = TIER1_EVENTS[1];
    seedAudit(t1Action, clock.now() - 300 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c).toBe(1);
    expect(sweeper.metrics.rowsDeletedByTable.audit_log_tier1).toBe(0);
  });
});

// ───── audit_log Tier 2 (3 cases incl. unknown action) ─────
describe("Sweeper — audit_log Tier 2", () => {
  it("deletes Tier 2 events older than audit_tier2_retention_days (default 90)", () => {
    const t2Action = TIER2_EVENTS[0]; // auth.login.success
    seedAudit(t2Action, clock.now() - 100 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c).toBe(0);
    expect(sweeper.metrics.rowsDeletedByTable.audit_log_tier2).toBe(1);
  });

  it("keeps Tier 2 events within the 90d window", () => {
    const t2Action = TIER2_EVENTS[1];
    seedAudit(t2Action, clock.now() - 80 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c).toBe(1);
    expect(sweeper.metrics.rowsDeletedByTable.audit_log_tier2).toBe(0);
  });

  it("never deletes audit rows with actions outside both Tier lists (even very old)", () => {
    // Seed an action that is in neither TIER1_EVENTS nor TIER2_EVENTS,
    // older than every retention window — must survive.
    seedAudit("unknown.custom.action", clock.now() - 9999 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c).toBe(1);
  });
});

// ───── Phase 1 tables (performance-01) ─────
describe("Sweeper — file_activity (created_at, default 7d)", () => {
  it("deletes rows older than file_activity_retention_days (default 7)", () => {
    seedFileActivity(clock.now() - 10 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM file_activity").get() as { c: number }).c).toBe(
      0,
    );
    expect(sweeper.metrics.rowsDeletedByTable.file_activity).toBe(1);
  });

  it("keeps rows within the 7d window", () => {
    seedFileActivity(clock.now() - 3 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM file_activity").get() as { c: number }).c).toBe(
      1,
    );
    expect(sweeper.metrics.rowsDeletedByTable.file_activity).toBe(0);
  });
});

describe("Sweeper — events (created_at, default 7d)", () => {
  it("deletes rows older than events_retention_days (default 7)", () => {
    seedEvent(clock.now() - 10 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c).toBe(0);
    expect(sweeper.metrics.rowsDeletedByTable.events).toBe(1);
  });

  it("keeps rows within the 7d window", () => {
    seedEvent(clock.now() - 3 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c).toBe(1);
    expect(sweeper.metrics.rowsDeletedByTable.events).toBe(0);
  });
});

describe("Sweeper — thread_messages (created_at, default 30d)", () => {
  it("deletes rows older than thread_messages_retention_days (default 30)", () => {
    seedThreadMessage(clock.now() - 40 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM thread_messages").get() as { c: number }).c).toBe(
      0,
    );
    expect(sweeper.metrics.rowsDeletedByTable.thread_messages).toBe(1);
  });

  it("keeps rows within the 30d window", () => {
    seedThreadMessage(clock.now() - 20 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM thread_messages").get() as { c: number }).c).toBe(
      1,
    );
    expect(sweeper.metrics.rowsDeletedByTable.thread_messages).toBe(0);
  });
});

describe("Sweeper — action_summaries (created_at, default 30d)", () => {
  it("deletes rows older than action_summaries_retention_days (default 30)", () => {
    seedActionSummary(clock.now() - 40 * 86400);
    sweeper.runPass();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM action_summaries").get() as { c: number }).c,
    ).toBe(0);
    expect(sweeper.metrics.rowsDeletedByTable.action_summaries).toBe(1);
  });

  it("keeps rows within the 30d window", () => {
    seedActionSummary(clock.now() - 20 * 86400);
    sweeper.runPass();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM action_summaries").get() as { c: number }).c,
    ).toBe(1);
    expect(sweeper.metrics.rowsDeletedByTable.action_summaries).toBe(0);
  });
});

describe("Sweeper — layer_firings (fired_at, default 30d)", () => {
  it("deletes rows older than layer_firings_retention_days (default 30) using fired_at, not created_at", () => {
    seedLayerFiring(clock.now() - 40 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM layer_firings").get() as { c: number }).c).toBe(
      0,
    );
    expect(sweeper.metrics.rowsDeletedByTable.layer_firings).toBe(1);
  });

  it("keeps rows within the 30d window", () => {
    seedLayerFiring(clock.now() - 20 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM layer_firings").get() as { c: number }).c).toBe(
      1,
    );
    expect(sweeper.metrics.rowsDeletedByTable.layer_firings).toBe(0);
  });
});

// ───── R5(1): retention boundary — just-under kept, just-over deleted ─────
describe("Sweeper — Phase 1 retention boundaries", () => {
  it("file_activity: a row 1s inside the 7d window is kept, a row 1s past it is deleted", () => {
    const retentionSeconds = 7 * 86400;
    seedFileActivity(clock.now() - retentionSeconds + 1); // just under → keep
    seedFileActivity(clock.now() - retentionSeconds - 1); // just over → delete
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM file_activity").get() as { c: number }).c).toBe(
      1,
    );
    expect(sweeper.metrics.rowsDeletedByTable.file_activity).toBe(1);
  });

  it("layer_firings: a row 1s inside the 30d window is kept, a row 1s past it is deleted", () => {
    const retentionSeconds = 30 * 86400;
    seedLayerFiring(clock.now() - retentionSeconds + 1); // just under → keep
    seedLayerFiring(clock.now() - retentionSeconds - 1); // just over → delete
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM layer_firings").get() as { c: number }).c).toBe(
      1,
    );
    expect(sweeper.metrics.rowsDeletedByTable.layer_firings).toBe(1);
  });
});

describe("Sweeper — Phase 1 retention env overrides", () => {
  it("honours COORDINATOR_EVENTS_RETENTION_DAYS override", () => {
    process.env.COORDINATOR_EVENTS_RETENTION_DAYS = "1";
    seedEvent(clock.now() - 2 * 86400);
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c).toBe(0);
    expect(sweeper.metrics.rowsDeletedByTable.events).toBe(1);
  });
});

// ───── Adaptive chained runs (2 cases) ─────
describe("Sweeper — adaptive chained runs", () => {
  it("chains up to 3 runs of BATCH_SIZE; runPass drains 3000 rows from a 3500-row backlog", () => {
    // Seed 3500 expired oauth_state rows. BATCH_SIZE=1000, MAX_CHAINED_RUNS=3
    // → 3 chains × 1000 rows = 3000 deleted in this tick; 500 remain.
    const insert = db.prepare(
      `INSERT INTO oauth_state (state, code_verifier, redirect_uri, provider, created_at, expires_at)
       VALUES (?, 'v', 'https://cb', 'github', ?, ?)`,
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < 3500; i++) {
        insert.run(`s-${i}`, clock.now() - 1000, clock.now() - 200);
      }
    });
    tx();
    expect((db.prepare("SELECT COUNT(*) AS c FROM oauth_state").get() as { c: number }).c).toBe(
      3500,
    );
    sweeper.runPass();
    const remaining = (db.prepare("SELECT COUNT(*) AS c FROM oauth_state").get() as { c: number })
      .c;
    expect(remaining).toBe(500);
    expect(sweeper.metrics.rowsDeletedByTable.oauth_state).toBe(3000);
  });

  it("stops chaining as soon as a chain iteration deletes fewer than BATCH_SIZE rows", () => {
    // 1500 expired rows: chain 1 deletes 1000 (full → re-run), chain 2 deletes
    // 500 (< BATCH_SIZE → stop). Total 1500, totalRuns increments once, and
    // sweeper does NOT do a 3rd chain.
    const insert = db.prepare(
      `INSERT INTO oauth_state (state, code_verifier, redirect_uri, provider, created_at, expires_at)
       VALUES (?, 'v', 'https://cb', 'github', ?, ?)`,
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < 1500; i++) {
        insert.run(`s2-${i}`, clock.now() - 1000, clock.now() - 200);
      }
    });
    tx();
    sweeper.runPass();
    expect((db.prepare("SELECT COUNT(*) AS c FROM oauth_state").get() as { c: number }).c).toBe(0);
    expect(sweeper.metrics.totalRuns).toBe(1);
  });
});

// ───── Circuit breaker (3 cases) ─────
describe("Sweeper — circuit breaker", () => {
  it("opens after 5 consecutive errors, stops the timer, and ignores subsequent runPass()", () => {
    db.close(); // force every subsequent DB call to throw
    for (let i = 0; i < 5; i++) sweeper.runPass();
    expect(sweeper.metrics.circuitOpen).toBe(true);
    expect(sweeper.metrics.consecutiveFailures).toBe(5);
    // Subsequent calls must be no-ops (no counter increment, no throw).
    sweeper.runPass();
    expect(sweeper.metrics.consecutiveFailures).toBe(5);
    expect(sweeper.metrics.totalRuns).toBe(0);
  });

  it("resetCircuit() clears state and the next runPass succeeds", () => {
    db.close();
    for (let i = 0; i < 5; i++) sweeper.runPass();
    expect(sweeper.metrics.circuitOpen).toBe(true);

    // Reopen a fresh db on the same handle path is impossible after .close(),
    // so build a new sweeper bound to a fresh db that has the schema.
    const db2 = new Database(":memory:");
    db2.exec(SCHEMA);
    const sweeper2 = new Sweeper(db2, clock);
    // Manually push it past threshold via a closed-db handle then reset:
    const badSweeper = new Sweeper(db, clock);
    for (let i = 0; i < 5; i++) badSweeper.runPass();
    expect(badSweeper.metrics.circuitOpen).toBe(true);
    badSweeper.resetCircuit();
    expect(badSweeper.metrics.circuitOpen).toBe(false);
    expect(badSweeper.metrics.consecutiveFailures).toBe(0);

    // And a clean sweeper on a healthy db runs to completion:
    sweeper2.runPass();
    expect(sweeper2.metrics.circuitOpen).toBe(false);
    expect(sweeper2.metrics.totalRuns).toBe(1);
    db2.close();
  });

  it("a successful run after partial errors resets consecutive_failures to 0", () => {
    // 3 failures, then heal the db, then a successful run → counter resets.
    // We simulate the "heal" by swapping the db handle on the prototype path:
    // simpler — drop+recreate one of the tables to force a 1-error tick.
    db.exec("DROP TABLE oauth_state");
    sweeper.runPass(); // fails
    sweeper.runPass(); // fails
    sweeper.runPass(); // fails
    expect(sweeper.metrics.consecutiveFailures).toBe(3);
    // Recreate the table → next run succeeds.
    db.exec(`
      CREATE TABLE oauth_state (
        state TEXT PRIMARY KEY, code_verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        provider TEXT NOT NULL, org_id TEXT, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, consumed_at INTEGER, nonce TEXT
      );
    `);
    sweeper.runPass();
    expect(sweeper.metrics.consecutiveFailures).toBe(0);
    expect(sweeper.metrics.totalRuns).toBe(1);
  });
});

// ───── Metrics accumulation (1 case) ─────
describe("Sweeper — metrics", () => {
  it("rowsDeletedByTable accumulates across multiple runs", () => {
    seedOAuthState("e1", clock.now() - 120);
    sweeper.runPass();
    expect(sweeper.metrics.rowsDeletedByTable.oauth_state).toBe(1);

    seedOAuthState("e2", clock.now() - 120);
    seedOAuthState("e3", clock.now() - 120);
    sweeper.runPass();
    expect(sweeper.metrics.rowsDeletedByTable.oauth_state).toBe(3);
    expect(sweeper.metrics.totalRuns).toBe(2);
    expect(sweeper.metrics.lastRunTimestamp).toBe(clock.now());
  });
});

// ───── Lifecycle: start/stop/drain (covers branches in interval mgmt) ─────
describe("Sweeper — lifecycle", () => {
  it("start() is idempotent (second call is a no-op)", () => {
    vi.useFakeTimers();
    sweeper.start();
    sweeper.start(); // must not create a second interval
    // Internally we can't inspect the timer count directly, but advancing
    // 60s should produce exactly one runPass invocation. Seed one expired
    // row and assert exactly one deletion.
    seedOAuthState("once", clock.now() - 120);
    vi.advanceTimersByTime(60_000);
    expect(sweeper.metrics.totalRuns).toBe(1);
    sweeper.stop();
  });

  it("stop() is safe when never started", () => {
    expect(() => sweeper.stop()).not.toThrow();
  });

  it("drain() stops the timer and resolves", async () => {
    sweeper.start();
    await expect(sweeper.drain(1000)).resolves.toBeUndefined();
    // Calling stop again is still safe.
    sweeper.stop();
  });

  it("drain() with default timeout argument works", async () => {
    sweeper.start();
    await expect(sweeper.drain()).resolves.toBeUndefined();
  });

  it("start() handles environments where timer.unref is missing", () => {
    // Force the unref branch off: vi.useFakeTimers gives Timeout-like
    // objects whose unref is a function, so we also cover the `if` guard
    // explicitly by patching setInterval to return an object without unref.
    const realSetInterval = globalThis.setInterval;
    const fakeTimer = {} as unknown as NodeJS.Timeout;
    globalThis.setInterval = ((..._args: unknown[]) => fakeTimer) as unknown as typeof setInterval;
    try {
      const s = new Sweeper(db, clock);
      expect(() => s.start()).not.toThrow();
      // Cannot call stop() because clearInterval on a fake timer is fine but
      // the timer field is the fake object → safe no-op.
      s.stop();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });
});
