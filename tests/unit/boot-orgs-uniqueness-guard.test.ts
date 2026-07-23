import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import type { DatabaseAdapter } from "../../src/db-adapter.js";
import {
  runOrgsUniquenessGuard,
  emitDuplicatesAcceptedAudit,
  ensureAuditChainKeyForBootAudit,
  type OrgsUniquenessGuardDeps,
} from "../../src/boot-orgs-uniqueness.js";
import { BootValidationError } from "../../src/boot-encryption.js";
import {
  ALG_HMAC_V1,
  algorithmOf,
  configureAuditChainKey,
  deriveAuditChainKey,
  getAuditChainKey,
  resetAuditChainKey,
} from "../../src/security/audit-chain.js";
import { decodeMasterKey } from "../../src/security/master-key.js";

/**
 * T03 (v0.10.6) — pre-flight boot guard for `idx_orgs_name`.
 *
 * Branch matrix mirrored from src/boot-orgs-uniqueness.ts:
 *   1. `orgs` absent (fresh DB) → no-op.
 *   2. `idx_orgs_name` already exists → PATCH 17 short-circuit (no SELECT).
 *   3. No duplicates → no-op.
 *   4. Duplicates + override unset → BootValidationError naming duplicates.
 *   5. Duplicates + COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES=1 →
 *      logger warn + returns pending audit payload + emitDuplicates… writes
 *      a Tier 1 audit row in the chain.
 */

interface WarnCall {
  obj: Record<string, unknown> | string;
  msg?: string;
}

interface FakeLogger {
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  warnCalls: WarnCall[];
}

function makeLogger(): FakeLogger {
  const warnCalls: WarnCall[] = [];
  return {
    warn(obj, msg) {
      warnCalls.push({ obj, msg });
    },
    warnCalls,
  };
}

function makeRawDb(): Database.Database {
  return new Database(":memory:");
}

function createOrgsTable(db: Database.Database): void {
  // Minimal orgs table — only the columns the guard's SELECT cares about.
  db.exec(`
    CREATE TABLE orgs (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
}

function createAuditLogTable(db: Database.Database): void {
  // Mirror the post-v0.8-migration audit_log shape used by
  // emitDuplicatesAcceptedAudit + insertAuditRowWithChain.
  db.exec(`
    CREATE TABLE audit_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id    TEXT,
      actor_org_id     TEXT,
      action           TEXT NOT NULL,
      target           TEXT,
      actor_ip         TEXT,
      actor_user_agent TEXT,
      request_id       TEXT,
      outcome          TEXT,
      metadata_json    TEXT,
      prev_hash        TEXT,
      row_hash         TEXT,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

let raw: Database.Database;
let db: DatabaseAdapter;
let logger: FakeLogger;

beforeEach(() => {
  raw = makeRawDb();
  db = raw as unknown as DatabaseAdapter;
  logger = makeLogger();
});

afterEach(() => {
  try {
    raw.close();
  } catch {
    /* idempotent */
  }
  // The audit-chain key is a process-wide singleton (src/security/audit-
  // chain.ts) — reset it after every test so a key configured by the
  // boot-ordering-fix tests below can never leak into an unrelated test
  // (in this file or, since these tests run in-process, a later one) that
  // assumes an unkeyed chain.
  resetAuditChainKey();
});

function deps(env: NodeJS.ProcessEnv = {}): OrgsUniquenessGuardDeps {
  return { db, env, logger };
}

describe("runOrgsUniquenessGuard — branch matrix", () => {
  it("Branch 1: orgs table absent → no-op, null payload", () => {
    const r = runOrgsUniquenessGuard(deps());
    expect(r.pendingDuplicatesAcceptedAudit).toBeNull();
    expect(logger.warnCalls).toHaveLength(0);
  });

  it("Branch 2: idx_orgs_name already exists → short-circuits the SELECT", () => {
    createOrgsTable(raw);
    raw.exec("CREATE UNIQUE INDEX idx_orgs_name ON orgs(name)");
    // Sanity: duplicates can't exist now, but seed a single row so the SELECT
    // would have iterated had it run.
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o1", "acme");

    // Hijack `prepare` to detect whether the GROUP BY SELECT is invoked.
    const originalPrepare = raw.prepare.bind(raw);
    const preparedSqls: string[] = [];
    (raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      preparedSqls.push(sql);
      return originalPrepare(sql);
    };

    const r = runOrgsUniquenessGuard(deps());
    expect(r.pendingDuplicatesAcceptedAudit).toBeNull();
    // The GROUP BY scan must NOT be prepared on this path.
    const groupBySql = preparedSqls.find((s) => /GROUP BY name/.test(s));
    expect(groupBySql).toBeUndefined();
  });

  it("Branch 3: no duplicates → no-op, null payload", () => {
    createOrgsTable(raw);
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o1", "acme");
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o2", "wayne");

    const r = runOrgsUniquenessGuard(deps());
    expect(r.pendingDuplicatesAcceptedAudit).toBeNull();
    expect(logger.warnCalls).toHaveLength(0);
  });

  it("Branch 4: duplicates without override → BootValidationError naming duplicates", () => {
    createOrgsTable(raw);
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o1", "acme");
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o2", "acme");
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o3", "wayne");
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o4", "wayne");

    let caught: Error | null = null;
    try {
      runOrgsUniquenessGuard(deps({}));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(BootValidationError);
    const msg = caught!.message;
    expect(msg).toMatch(/duplicate org names found/);
    expect(msg).toMatch(/name="acme"/);
    expect(msg).toMatch(/ids: o1,o2/);
    expect(msg).toMatch(/name="wayne"/);
    expect(msg).toMatch(/ids: o3,o4/);
    // Must point operators at the override env name for the audit-accepted path.
    expect(msg).toContain("COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES=1");
  });

  it("Branch 4: error mentions wrong env value does NOT bypass the guard", () => {
    createOrgsTable(raw);
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o1", "acme");
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o2", "acme");
    // Common mistakes: empty string, "0", "true", "yes".
    for (const bogus of ["", "0", "true", "yes", "1 "]) {
      expect(() =>
        runOrgsUniquenessGuard(deps({ COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES: bogus })),
      ).toThrow(BootValidationError);
    }
  });

  it("Branch 5: override accepted → no throw + logger warn + pending audit payload", () => {
    createOrgsTable(raw);
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o1", "acme");
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o2", "acme");
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o3", "wayne");
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o4", "wayne");
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o5", "wayne");

    const r = runOrgsUniquenessGuard(deps({ COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES: "1" }));

    expect(r.pendingDuplicatesAcceptedAudit).not.toBeNull();
    const payload = r.pendingDuplicatesAcceptedAudit!;
    expect(payload.duplicates).toHaveLength(2);
    // 2 acme + 3 wayne = 5
    expect(payload.totalDuplicateRows).toBe(5);
    const acme = payload.duplicates.find((d) => d.name === "acme");
    expect(acme).toBeDefined();
    expect(acme?.n).toBe(2);
    expect(acme?.ids.split(",").sort()).toEqual(["o1", "o2"]);
    const wayne = payload.duplicates.find((d) => d.name === "wayne");
    expect(wayne).toBeDefined();
    expect(wayne?.n).toBe(3);

    // Warn logged with full duplicate breakdown so the operator sees the list
    // in the process log even before the audit row commits.
    expect(logger.warnCalls).toHaveLength(1);
    const call = logger.warnCalls[0];
    expect(call.msg).toMatch(/COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES/);
    expect(call.obj).toMatchObject({
      duplicate_groups: 2,
      total_rows: 5,
    });
  });

  it("Branch 5: works without a logger (logger is optional)", () => {
    createOrgsTable(raw);
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o1", "n");
    raw.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run("o2", "n");
    const r = runOrgsUniquenessGuard({
      db,
      env: { COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES: "1" },
    });
    expect(r.pendingDuplicatesAcceptedAudit).not.toBeNull();
  });
});

describe("emitDuplicatesAcceptedAudit — writes Tier 1 chain row", () => {
  it("inserts an admin.orgs.duplicate_names_accepted row with prev_hash + row_hash", () => {
    createAuditLogTable(raw);
    emitDuplicatesAcceptedAudit(db, {
      duplicates: [
        { name: "acme", n: 2, ids: "o1,o2" },
        { name: "wayne", n: 3, ids: "o3,o4,o5" },
      ],
      totalDuplicateRows: 5,
    });
    const rows = raw
      .prepare("SELECT action, outcome, metadata_json, prev_hash, row_hash FROM audit_log")
      .all() as Array<{
      action: string;
      outcome: string;
      metadata_json: string;
      prev_hash: string;
      row_hash: string;
    }>;
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.action).toBe("admin.orgs.duplicate_names_accepted");
    expect(r.outcome).toBe("success");
    // First row in a fresh chain links to GENESIS_HASH (64 zeros).
    expect(r.prev_hash).toBe("0".repeat(64));
    // SHA-256 hex = 64 chars.
    expect(r.row_hash).toMatch(/^[0-9a-f]{64}$/);
    const meta = JSON.parse(r.metadata_json) as {
      duplicate_groups: number;
      total_rows: number;
      duplicates: Array<{ name: string; n: number; ids: string[] }>;
    };
    expect(meta.duplicate_groups).toBe(2);
    expect(meta.total_rows).toBe(5);
    expect(meta.duplicates[0]).toEqual({ name: "acme", n: 2, ids: ["o1", "o2"] });
    expect(meta.duplicates[1]).toEqual({
      name: "wayne",
      n: 3,
      ids: ["o3", "o4", "o5"],
    });
  });

  it("chains correctly when the audit_log already has rows", () => {
    createAuditLogTable(raw);
    // Seed a prior row with a known row_hash; emit our row and assert
    // prev_hash points to the seeded tip.
    const priorRowHash = "a".repeat(64);
    raw
      .prepare("INSERT INTO audit_log (action, outcome, prev_hash, row_hash) VALUES (?, ?, ?, ?)")
      .run("seed.event", "success", "0".repeat(64), priorRowHash);

    emitDuplicatesAcceptedAudit(db, {
      duplicates: [{ name: "acme", n: 2, ids: "o1,o2" }],
      totalDuplicateRows: 2,
    });

    const rows = raw.prepare("SELECT action, prev_hash FROM audit_log ORDER BY id").all() as Array<{
      action: string;
      prev_hash: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[1].action).toBe("admin.orgs.duplicate_names_accepted");
    expect(rows[1].prev_hash).toBe(priorRowHash);
  });
});

describe("ensureAuditChainKeyForBootAudit — boot-ordering fix (security review)", () => {
  // A high-entropy 32-byte master key (base64), same shape decodeMasterKey
  // accepts elsewhere in the suite (tests/unit/verify-audit-chain.test.ts).
  const RAW_MASTER_KEY = randomBytes(32).toString("base64");
  const CHAIN_KEY = deriveAuditChainKey(decodeMasterKey(RAW_MASTER_KEY));

  it("Phase 1 (OAuth disabled): no-op regardless of COORDINATOR_ENCRYPTION_KEY", () => {
    ensureAuditChainKeyForBootAudit({
      COORDINATOR_OAUTH_ENABLED: "false",
      COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY,
    });
    expect(getAuditChainKey()).toBeNull();
  });

  it("OAuth enabled, no encryption key set: stays unkeyed (honest, matches bootPhase2)", () => {
    ensureAuditChainKeyForBootAudit({ COORDINATOR_OAUTH_ENABLED: "true" });
    expect(getAuditChainKey()).toBeNull();
  });

  it("OAuth enabled + encryption key set: configures the same derived key bootPhase2 would", () => {
    ensureAuditChainKeyForBootAudit({
      COORDINATOR_OAUTH_ENABLED: "true",
      COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY,
    });
    expect(getAuditChainKey()).toEqual(CHAIN_KEY);
  });

  it("does not clobber an already-configured key (idempotent / no-reconfigure)", () => {
    // configureAuditChainKey sets the chain key directly (bypassing HKDF
    // derivation) -- the test helper documented in security/audit-chain.ts
    // for exactly this "pre-configured sentinel key" setup.
    const other = randomBytes(32);
    configureAuditChainKey(other);
    ensureAuditChainKeyForBootAudit({
      COORDINATOR_OAUTH_ENABLED: "true",
      COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY,
    });
    // Still the pre-configured key, not re-derived from RAW_MASTER_KEY.
    expect(getAuditChainKey()).toEqual(other);
  });

  it(
    "RED (pre-fix repro): without calling ensureAuditChainKeyForBootAudit first, " +
      "the boot-time row is unkeyed even though the tip is keyed (encrypted deployment)",
    () => {
      createAuditLogTable(raw);
      // Simulate a prior real audit() call under encryption (bootPhase2 already
      // configured the key earlier in a previous, successful boot) — the tip is
      // an HMAC-keyed row.
      const keyedTip = `${ALG_HMAC_V1}:${"a".repeat(64)}`;
      raw
        .prepare("INSERT INTO audit_log (action, outcome, prev_hash, row_hash) VALUES (?, ?, ?, ?)")
        .run("config.boot", "success", "0".repeat(64), keyedTip);

      // getAuditChainKey() is unconfigured at this call site — reproduces the
      // exact defect: initDatabase's emitDuplicatesAcceptedAudit runs before
      // bootPhase2's configureAuditChainKeyFromMaster call.
      expect(getAuditChainKey()).toBeNull();
      emitDuplicatesAcceptedAudit(db, {
        duplicates: [{ name: "acme", n: 2, ids: "o1,o2" }],
        totalDuplicateRows: 2,
      });

      const row = raw
        .prepare("SELECT row_hash FROM audit_log WHERE action = 'admin.orgs.duplicate_names_accepted'")
        .get() as { row_hash: string };
      // Bug reproduced: unkeyed sha256 chained onto a keyed tip — exactly the
      // shape verify-audit-chain.ts's downgraded_alg check flags.
      expect(algorithmOf(row.row_hash)).not.toBe(ALG_HMAC_V1);
    },
  );

  it(
    "GREEN (fix): calling ensureAuditChainKeyForBootAudit first keys the boot-time " +
      "row on an encrypted deployment, chaining cleanly onto a keyed tip (no downgrade)",
    () => {
      createAuditLogTable(raw);
      const keyedTip = `${ALG_HMAC_V1}:${"a".repeat(64)}`;
      raw
        .prepare("INSERT INTO audit_log (action, outcome, prev_hash, row_hash) VALUES (?, ?, ?, ?)")
        .run("config.boot", "success", "0".repeat(64), keyedTip);

      // This is exactly what initDatabase now does (src/database.ts) before
      // calling emitDuplicatesAcceptedAudit.
      ensureAuditChainKeyForBootAudit({
        COORDINATOR_OAUTH_ENABLED: "true",
        COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY,
      });
      emitDuplicatesAcceptedAudit(db, {
        duplicates: [{ name: "acme", n: 2, ids: "o1,o2" }],
        totalDuplicateRows: 2,
      });

      const rows = raw
        .prepare("SELECT action, prev_hash, row_hash FROM audit_log ORDER BY id")
        .all() as Array<{ action: string; prev_hash: string; row_hash: string }>;
      expect(rows).toHaveLength(2);
      const bootRow = rows[1];
      expect(bootRow.action).toBe("admin.orgs.duplicate_names_accepted");
      expect(bootRow.prev_hash).toBe(keyedTip);
      // Fixed: the row is HMAC-keyed like the tip it chains onto — no
      // algorithm downgrade for verify-audit-chain.ts to (falsely) flag.
      expect(algorithmOf(bootRow.row_hash)).toBe(ALG_HMAC_V1);
      expect(bootRow.row_hash.startsWith(`${ALG_HMAC_V1}:`)).toBe(true);
    },
  );
});
