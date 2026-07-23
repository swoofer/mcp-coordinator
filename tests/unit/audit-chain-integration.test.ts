import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { audit, initAuditQueue, resetAuditQueue, getAuditQueue } from "../../src/security/audit.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import {
  ALG_HMAC_V1,
  ALG_SHA256,
  GENESIS_HASH,
  algorithmOf,
  computeRowHash,
  configureAuditChainKey,
  deriveAuditChainKey,
  resetAuditChainKey,
} from "../../src/security/audit-chain.js";
import { decodeMasterKey } from "../../src/security/master-key.js";
import { ensureAuditChainKeyForBootAudit } from "../../src/boot-orgs-uniqueness.js";
import { withAuditContext } from "../../src/auth/audit-context.js";
import { withRequestId } from "../../src/auth/request-id.js";

const require = createRequire(import.meta.url);
const DatabaseCtor = require("better-sqlite3") as new (path: string) => Database.Database;

const TEST_DIR = "data-test-audit-chain-integration";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VERIFY_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "verify-audit-chain.ts");

interface VerifierResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Spawn the real scripts/verify-audit-chain.ts against a DB file — same
 * pattern as tests/unit/verify-audit-chain.test.ts's runVerifier. Used here
 * to prove end to end (not just via algorithmOf()) that a fix/regression in
 * this file's audit()-level tests actually satisfies (or trips) the shipped
 * verifier. */
function runVerifyScript(dbPath: string, env: Record<string, string>): VerifierResult {
  // Drop any ambient COORDINATOR_ENCRYPTION_KEY so a stray value in this
  // process's own env can't mask a "no key" assertion — mirrors
  // tests/unit/verify-audit-chain.test.ts's runVerifier.
  const baseEnv = { ...process.env };
  delete baseEnv.COORDINATOR_ENCRYPTION_KEY;
  const result = spawnSync("npx", ["tsx", VERIFY_SCRIPT_PATH, "--db", dbPath, "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    shell: process.platform === "win32",
    env: { ...baseEnv, ...env },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

interface AuditRow {
  id: number;
  action: string;
  actor_user_id: string | null;
  actor_org_id: string | null;
  actor_ip: string | null;
  actor_user_agent: string | null;
  request_id: string | null;
  outcome: string | null;
  target: string | null;
  metadata_json: string | null;
  prev_hash: string;
  row_hash: string;
}

function readChain(): AuditRow[] {
  return getDb()
    .prepare(
      "SELECT id, action, actor_user_id, actor_org_id, actor_ip, " +
        "actor_user_agent, request_id, outcome, target, metadata_json, " +
        "prev_hash, row_hash FROM audit_log ORDER BY id ASC",
    )
    .all() as unknown as AuditRow[];
}

function clearDataDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => {
  clearDataDir();
  resetAuditQueue();
  initDatabase(TEST_DIR);
  // Ensure tip is at GENESIS for the suite (the fresh DB has 0 rows
  // unless a previous suite leaked something via the global module
  // state). The migration backfill is a no-op on an empty table.
  const db = getDb();
  (db as unknown as { prepare: (s: string) => { run: () => void } })
    .prepare("DELETE FROM audit_log")
    .run();
});

afterEach(() => {
  const queue = getAuditQueue();
  if (queue) queue.drain(0);
  resetAuditQueue();
  resetAuditChainKey();
  closeDb();
  clearDataDir();
});

describe("audit hash chain -- keyed HMAC vs unkeyed fallback", () => {
  const MASTER = Buffer.alloc(32, 0x5a);

  it("with no chain key configured, rows are recorded as unkeyed sha256", () => {
    audit("test.event.nokey", { tier: 1 });
    const [row] = readChain();
    expect(algorithmOf(row.row_hash)).toBe(ALG_SHA256);
    expect(row.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("with a chain key configured, rows are recorded as keyed hmac-sha256-v1", () => {
    const key = deriveAuditChainKey(MASTER);
    configureAuditChainKey(key);
    audit("test.event.keyed", { tier: 1, metadata: { foo: "bar" } });
    const [row] = readChain();
    expect(algorithmOf(row.row_hash)).toBe(ALG_HMAC_V1);
    // Recomputes with the key...
    const expected = computeRowHash(
      row.prev_hash,
      {
        action: row.action,
        actor_org_id: row.actor_org_id,
        actor_ip: row.actor_ip,
        actor_user_agent: row.actor_user_agent,
        actor_user_id: row.actor_user_id,
        metadata_json: row.metadata_json,
        outcome: row.outcome,
        request_id: row.request_id,
        target: row.target,
      },
      key,
    );
    expect(row.row_hash).toBe(expected);
    // ...but an attacker without the key cannot reproduce it with the
    // unkeyed algorithm.
    const unkeyedForge = computeRowHash(
      row.prev_hash,
      {
        action: row.action,
        actor_org_id: row.actor_org_id,
        actor_ip: row.actor_ip,
        actor_user_agent: row.actor_user_agent,
        actor_user_id: row.actor_user_id,
        metadata_json: row.metadata_json,
        outcome: row.outcome,
        request_id: row.request_id,
        target: row.target,
      },
      null,
    );
    expect(unkeyedForge).not.toBe(row.row_hash);
  });
});

describe("audit hash chain -- end-to-end through audit() Tier 1", () => {
  it("first row chains from GENESIS_HASH", () => {
    audit("test.event.alpha", { tier: 1 });
    const rows = readChain();
    expect(rows).toHaveLength(1);
    expect(rows[0].prev_hash).toBe(GENESIS_HASH);
    expect(rows[0].row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("subsequent rows chain prev_hash = previous row_hash", () => {
    audit("test.event.alpha", { tier: 1 });
    audit("test.event.beta", { tier: 1 });
    audit("test.event.gamma", { tier: 1 });
    const rows = readChain();
    expect(rows).toHaveLength(3);
    expect(rows[0].prev_hash).toBe(GENESIS_HASH);
    expect(rows[1].prev_hash).toBe(rows[0].row_hash);
    expect(rows[2].prev_hash).toBe(rows[1].row_hash);
    expect(new Set(rows.map((r) => r.row_hash)).size).toBe(3);
  });

  it("row_hash matches the canonical recomputation", () => {
    audit("test.event.recompute", {
      tier: 1,
      metadata: { foo: "bar" },
      target: "t1",
      outcome: "denied",
    });
    const [row] = readChain();
    const expected = computeRowHash(row.prev_hash, {
      action: row.action,
      actor_org_id: row.actor_org_id,
      actor_ip: row.actor_ip,
      actor_user_agent: row.actor_user_agent,
      actor_user_id: row.actor_user_id,
      metadata_json: row.metadata_json,
      outcome: row.outcome,
      request_id: row.request_id,
      target: row.target,
    });
    expect(row.row_hash).toBe(expected);
  });

  it("captures actor + request fields from AsyncLocalStorage context", () => {
    withRequestId("req-xyz", () => {
      withAuditContext(
        { userId: "u-123", orgId: "org-acme" },
        { ip: "1.2.3.4", userAgent: "TestAgent/1.0" },
        () => {
          audit("test.event.ctx", { tier: 1 });
        },
      );
    });
    const [row] = readChain();
    expect(row.actor_user_id).toBe("u-123");
    expect(row.actor_org_id).toBe("org-acme");
    expect(row.actor_ip).toBe("1.2.3.4");
    expect(row.actor_user_agent).toBe("TestAgent/1.0");
    expect(row.request_id).toBe("req-xyz");
    // Hash recomputes correctly with the context fields baked in.
    const expected = computeRowHash(row.prev_hash, {
      action: row.action,
      actor_org_id: row.actor_org_id,
      actor_ip: row.actor_ip,
      actor_user_agent: row.actor_user_agent,
      actor_user_id: row.actor_user_id,
      metadata_json: row.metadata_json,
      outcome: row.outcome,
      request_id: row.request_id,
      target: row.target,
    });
    expect(row.row_hash).toBe(expected);
  });
});

describe("audit hash chain -- end-to-end through audit() Tier 2 batched", () => {
  it("batch flush produces a continuous chain across multiple enqueued rows", () => {
    initAuditQueue(getDb() as unknown as Database.Database);
    audit("test.tier2.a", { tier: 2 });
    audit("test.tier2.b", { tier: 2 });
    audit("test.tier2.c", { tier: 2 });
    getAuditQueue()!.flush();

    const rows = readChain();
    expect(rows).toHaveLength(3);
    expect(rows[0].prev_hash).toBe(GENESIS_HASH);
    expect(rows[1].prev_hash).toBe(rows[0].row_hash);
    expect(rows[2].prev_hash).toBe(rows[1].row_hash);
  });

  it("interleaved Tier 1 + Tier 2 keep a single linear chain", () => {
    initAuditQueue(getDb() as unknown as Database.Database);
    audit("t1.a", { tier: 1 });
    audit("t2.b", { tier: 2 });
    getAuditQueue()!.flush();
    audit("t1.c", { tier: 1 });
    audit("t2.d", { tier: 2 });
    getAuditQueue()!.flush();

    const rows = readChain();
    expect(rows.map((r) => r.action)).toEqual(["t1.a", "t2.b", "t1.c", "t2.d"]);
    expect(rows[0].prev_hash).toBe(GENESIS_HASH);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].prev_hash, `link ${i}`).toBe(rows[i - 1].row_hash);
    }
  });
});

describe("audit hash chain -- backfill on pre-existing rows", () => {
  it("re-running initDatabase on a DB with chain-less rows fills the chain", () => {
    // Start by inserting a row directly without hash columns. This
    // mimics a DB created before the T50 migration: the columns are
    // there (added by initDatabase already in beforeEach) but with
    // NULL hashes.
    const db = getDb();
    db.prepare(
      "INSERT INTO audit_log (action, outcome, prev_hash, row_hash) " + "VALUES (?, ?, NULL, NULL)",
    ).run("legacy.event.alpha", "success");
    db.prepare(
      "INSERT INTO audit_log (action, outcome, prev_hash, row_hash) " + "VALUES (?, ?, NULL, NULL)",
    ).run("legacy.event.beta", "success");

    // Re-run initDatabase: the backfill loop should walk the unhashed
    // rows in id-order and chain them from GENESIS_HASH.
    closeDb();
    initDatabase(TEST_DIR);

    const rows = readChain();
    expect(rows).toHaveLength(2);
    expect(rows[0].prev_hash).toBe(GENESIS_HASH);
    expect(rows[0].row_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1].prev_hash).toBe(rows[0].row_hash);
    expect(rows[1].row_hash).not.toBe(rows[0].row_hash);
  });

  it("backfill is idempotent -- re-running does not re-hash already-hashed rows", () => {
    audit("first.event", { tier: 1 });
    audit("second.event", { tier: 1 });
    const before = readChain();

    closeDb();
    initDatabase(TEST_DIR);
    const after = readChain();

    expect(after[0].row_hash).toBe(before[0].row_hash);
    expect(after[1].row_hash).toBe(before[1].row_hash);
  });

  it("backfill resumes correctly after a partial fill", () => {
    // Insert one row with hashes, then one without -- mimics an
    // interrupted backfill that crashed between rows.
    const db = getDb();
    const prevHash = GENESIS_HASH;
    const fakeHash = computeRowHash(prevHash, {
      action: "first.event",
      actor_org_id: null,
      actor_ip: null,
      actor_user_agent: null,
      actor_user_id: null,
      metadata_json: null,
      outcome: "success",
      request_id: null,
      target: null,
    });
    db.prepare(
      "INSERT INTO audit_log (action, outcome, prev_hash, row_hash) " + "VALUES (?, ?, ?, ?)",
    ).run("first.event", "success", prevHash, fakeHash);
    db.prepare(
      "INSERT INTO audit_log (action, outcome, prev_hash, row_hash) " + "VALUES (?, ?, NULL, NULL)",
    ).run("second.event", "success");

    closeDb();
    initDatabase(TEST_DIR);

    const rows = readChain();
    expect(rows).toHaveLength(2);
    expect(rows[0].row_hash).toBe(fakeHash);
    expect(rows[1].prev_hash).toBe(fakeHash);
    expect(rows[1].row_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("audit hash chain -- tamper detection", () => {
  it("editing an existing row's action breaks the chain (row_hash mismatches recomputed)", () => {
    audit("clean.event", { tier: 1 });
    audit("victim.event", { tier: 1, target: "original-target" });
    audit("after.event", { tier: 1 });

    // Tamper: change row 2's action in-place without updating row_hash.
    const db = getDb();
    db.prepare("UPDATE audit_log SET action = ? WHERE action = ?").run(
      "ATTACKER_INSERTED",
      "victim.event",
    );

    const rows = readChain();
    const tampered = rows.find((r) => r.action === "ATTACKER_INSERTED")!;
    const recomputed = computeRowHash(tampered.prev_hash, {
      action: tampered.action,
      actor_org_id: tampered.actor_org_id,
      actor_ip: tampered.actor_ip,
      actor_user_agent: tampered.actor_user_agent,
      actor_user_id: tampered.actor_user_id,
      metadata_json: tampered.metadata_json,
      outcome: tampered.outcome,
      request_id: tampered.request_id,
      target: tampered.target,
    });
    expect(recomputed).not.toBe(tampered.row_hash);
  });
});

describe("audit hash chain -- restore-triggered boot audit rows (security review fix)", () => {
  // Regression test for the boot-ordering defect: performRestoreCheck
  // (src/boot.ts step 5, NR12 restore detection) can call audit() directly
  // -- "recovery.token_epoch_global_bump" / "recovery.completed" -- and step
  // 5 used to run before step 7b's configureAuditChainKeyFromMaster call, so
  // on an encrypted deployment a restore-triggered boot wrote those rows
  // unkeyed even though the rest of the chain is HMAC-keyed. The fix calls
  // the same ensureAuditChainKeyForBootAudit helper used for the
  // duplicates-accepted boot row (src/boot-orgs-uniqueness.ts), early in
  // bootPhase2, before performRestoreCheck runs. These tests reproduce
  // performRestoreCheck's exact two audit() calls directly (it isn't
  // exported) against the real production audit()/database.ts stack, and
  // verify both via algorithmOf() and by spawning the actual shipped
  // scripts/verify-audit-chain.ts.
  const RAW_MASTER_KEY = randomBytes(32).toString("base64");
  const CHAIN_KEY = deriveAuditChainKey(decodeMasterKey(RAW_MASTER_KEY));
  const KEYED_ENV = { COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY };
  const BOOT_ENV = {
    COORDINATOR_OAUTH_ENABLED: "true",
    COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY,
  };

  function emitKeyedTip(): void {
    // Simulates a prior real audit() call under encryption (e.g. an earlier
    // boot's config.boot row) -- the tip is HMAC-keyed.
    configureAuditChainKey(CHAIN_KEY);
    audit("config.boot", { tier: 1 });
    // Simulates the exact pre-fix state at the moment performRestoreCheck
    // used to run: the chain-key singleton is unconfigured.
    resetAuditChainKey();
  }

  function emitRestoreAudits(): void {
    // The exact two calls performRestoreCheck (src/boot.ts) makes.
    audit("recovery.token_epoch_global_bump", { tier: 1, metadata: { stale_seconds: 999 } });
    audit("recovery.completed", {
      tier: 1,
      metadata: { stale_seconds: 999, threshold_seconds: 300 },
    });
  }

  it("RED (pre-fix repro): restore-path audit() rows are unkeyed even though the tip is keyed", () => {
    emitKeyedTip();
    emitRestoreAudits();

    const recoveryRows = readChain().filter((r) => r.action.startsWith("recovery."));
    expect(recoveryRows).toHaveLength(2);
    for (const row of recoveryRows) {
      expect(algorithmOf(row.row_hash)).toBe(ALG_SHA256);
    }

    const result = runVerifyScript(path.join(TEST_DIR, "coordinator.db"), KEYED_ENV);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.findings.some((f: { reason: string }) => f.reason === "downgraded_alg")).toBe(
      true,
    );
  });

  it("GREEN (fix): ensureAuditChainKeyForBootAudit before the restore-path audit() calls keys them", () => {
    emitKeyedTip();
    // This is exactly what src/boot.ts's bootPhase2 now does before calling
    // performRestoreCheck.
    ensureAuditChainKeyForBootAudit(BOOT_ENV);
    emitRestoreAudits();

    const recoveryRows = readChain().filter((r) => r.action.startsWith("recovery."));
    expect(recoveryRows).toHaveLength(2);
    for (const row of recoveryRows) {
      expect(algorithmOf(row.row_hash)).toBe(ALG_HMAC_V1);
      expect(row.row_hash.startsWith("hmac-sha256-v1:")).toBe(true);
    }

    const result = runVerifyScript(path.join(TEST_DIR, "coordinator.db"), KEYED_ENV);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.findings.some((f: { reason: string }) => f.reason === "downgraded_alg")).toBe(
      false,
    );
  });

  it("a real keyed->unkeyed forge of a restore-path row is STILL rejected after the fix", () => {
    emitKeyedTip();
    ensureAuditChainKeyForBootAudit(BOOT_ENV);
    emitRestoreAudits();

    // Attacker with DB-write-only access (no key) rewrites the
    // recovery.completed row's content and recomputes a plain unkeyed
    // sha256 (no prefix) -- same forgery technique used elsewhere in this
    // suite, applied to a restore-path row specifically.
    const db = getDb();
    const victim = readChain().find((r) => r.action === "recovery.completed")!;
    const forged = computeRowHash(
      victim.prev_hash,
      {
        action: "ATTACKER",
        actor_org_id: null,
        actor_ip: null,
        actor_user_agent: null,
        actor_user_id: null,
        metadata_json: null,
        outcome: victim.outcome,
        request_id: null,
        target: null,
      },
      null,
    );
    expect(forged.startsWith("hmac-sha256-v1:")).toBe(false);
    db.prepare("UPDATE audit_log SET action = 'ATTACKER', row_hash = ? WHERE id = ?").run(
      forged,
      victim.id,
    );

    const result = runVerifyScript(path.join(TEST_DIR, "coordinator.db"), KEYED_ENV);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.findings.some((f: { reason: string }) => f.reason === "downgraded_alg")).toBe(
      true,
    );
  });
});
