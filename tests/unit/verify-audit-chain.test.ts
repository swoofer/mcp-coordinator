import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "node:path";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  GENESIS_HASH,
  computeRowHash,
  deriveAuditChainKey,
  resetAuditChainKey,
} from "../../src/security/audit-chain.js";
import { decodeMasterKey } from "../../src/security/master-key.js";
import {
  emitDuplicatesAcceptedAudit,
  ensureAuditChainKeyForBootAudit,
} from "../../src/boot-orgs-uniqueness.js";
import type { DatabaseAdapter } from "../../src/db-adapter.js";
import { TIER1_EVENTS, TIER2_EVENTS } from "../../src/security/audit-events.js";

// A high-entropy 32-byte master key (base64) accepted by decodeMasterKey.
// The same string is handed to the spawned verifier via env so it derives
// the identical chain key.
const RAW_MASTER_KEY = randomBytes(32).toString("base64");
const CHAIN_KEY = deriveAuditChainKey(decodeMasterKey(RAW_MASTER_KEY));

const require = createRequire(import.meta.url);
const DatabaseCtor = require("better-sqlite3") as new (path: string) => Database.Database;

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "verify-audit-chain.ts");

// Minimal audit_log schema with chain columns -- the verifier only
// reads, so we don't need any of the index or default columns.
const AUDIT_SCHEMA = `
  CREATE TABLE audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id   TEXT,
    actor_org_id    TEXT,
    action          TEXT NOT NULL,
    target          TEXT,
    actor_ip        TEXT,
    actor_user_agent TEXT,
    request_id      TEXT,
    outcome         TEXT,
    metadata_json   TEXT,
    prev_hash       TEXT,
    row_hash        TEXT,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

interface ScriptResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runVerifier(args: string[], env?: Record<string, string>): ScriptResult {
  // spawnSync (not execFileSync) so we get stdout + stderr regardless
  // of exit code -- the verifier exits 1 on findings and 2 on
  // bad-args / DB-open errors, and we need to inspect the JSON
  // payload either way.
  // Use shell: true on Windows so `npx` (a .cmd shim) resolves
  // through cmd.exe; POSIX systems are unaffected.
  // The spawned process inherits a clean env plus any overrides; we drop
  // COORDINATOR_ENCRYPTION_KEY unless the test explicitly sets one so a
  // stray ambient key can't mask a "no key" assertion.
  const baseEnv = { ...process.env };
  delete baseEnv.COORDINATOR_ENCRYPTION_KEY;
  const result = spawnSync("npx", ["tsx", SCRIPT_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    shell: process.platform === "win32",
    env: { ...baseEnv, ...(env ?? {}) },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

let sandbox: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "verify-chain-"));
  dbPath = path.join(sandbox, "test.db");
  db = new DatabaseCtor(dbPath);
  db.exec(AUDIT_SCHEMA);
});

afterEach(() => {
  db.close();
  rmSync(sandbox, { recursive: true, force: true });
});

function insertRow(
  action: string,
  prevHash: string,
  options: { tamperContent?: boolean; nullHash?: boolean; key?: Buffer | null } = {},
): string {
  const rowHash = options.nullHash
    ? null
    : computeRowHash(
        prevHash,
        {
          action,
          actor_org_id: null,
          actor_ip: null,
          actor_user_agent: null,
          actor_user_id: null,
          metadata_json: null,
          outcome: "success",
          request_id: null,
          target: null,
        },
        options.key ?? null,
      );
  const finalAction = options.tamperContent ? `${action}.tampered` : action;
  db.prepare(
    "INSERT INTO audit_log (action, outcome, prev_hash, row_hash) " + "VALUES (?, ?, ?, ?)",
  ).run(finalAction, "success", options.nullHash ? null : prevHash, rowHash);
  return rowHash ?? "";
}

describe("verify-audit-chain script", () => {
  it("empty audit_log -> exit 0, tip is null", () => {
    const result = runVerifier(["--db", dbPath, "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.total_rows).toBe(0);
    expect(report.tip_row_hash).toBeNull();
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("valid 3-row chain -> exit 0, ok=true, tip = last row_hash", () => {
    const h1 = insertRow("event.a", GENESIS_HASH);
    const h2 = insertRow("event.b", h1);
    const h3 = insertRow("event.c", h2);

    const result = runVerifier(["--db", dbPath, "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.total_rows).toBe(3);
    expect(report.verified_rows).toBe(3);
    expect(report.tip_row_hash).toBe(h3);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    // h2 must not equal h1
    expect(h2).not.toBe(h1);
  });

  it("tampered content (row_hash no longer matches recomputation) -> exit 1", () => {
    const h1 = insertRow("event.a", GENESIS_HASH);
    insertRow("event.b", h1);
    // Tamper: rewrite row 2's action without updating row_hash.
    db.prepare("UPDATE audit_log SET action = 'ATTACKER' WHERE id = 2").run();

    const result = runVerifier(["--db", dbPath, "--json"]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.findings.length).toBeGreaterThanOrEqual(1);
    expect(report.findings.some((f: { reason: string }) => f.reason === "wrong_row_hash")).toBe(
      true,
    );
  });

  it("forged prev_hash (chain split) -> exit 1, wrong_prev_hash finding", () => {
    const h1 = insertRow("event.a", GENESIS_HASH);
    insertRow("event.b", h1);
    // Tamper row 2's prev_hash to claim it followed a non-existent row.
    db.prepare("UPDATE audit_log SET prev_hash = ? WHERE id = 2").run("a".repeat(64));

    const result = runVerifier(["--db", dbPath, "--json"]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.findings.some((f: { reason: string }) => f.reason === "wrong_prev_hash")).toBe(
      true,
    );
  });

  it("missing hash (null prev_hash) -> exit 1, missing_hash finding", () => {
    insertRow("event.a", GENESIS_HASH, { nullHash: true });

    const result = runVerifier(["--db", dbPath, "--json"]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.findings.some((f: { reason: string }) => f.reason === "missing_hash")).toBe(true);
  });

  it("front-deletion -> exit 0, no findings", () => {
    // The verifier trusts the first surviving row's prev_hash as the entry
    // point: it claims to chain from a deleted row the verifier cannot
    // reconstruct locally.
    //
    // #348: the title used to say "(sweeper retention)", implying this is
    // the shape a sweep leaves behind. It is not -- see the middle-deletion
    // case below. A pure front-deletion is what a SINGLE-TIER chain leaves,
    // which is the Phase-1 mono-tenant profile only.
    const h1 = insertRow("event.a", GENESIS_HASH);
    const h2 = insertRow("event.b", h1);
    insertRow("event.c", h2);
    db.prepare("DELETE FROM audit_log WHERE id = 1").run();

    const result = runVerifier(["--db", dbPath, "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("middle-deletion -> exit 0, id_gap_before only", () => {
    // #348, now fixed. This comment first said "the retention sweeper never
    // deletes middle rows -- it deletes by age, oldest first. A middle gap is
    // an attacker signature." Both sentences were false.
    //
    // The sweeper runs TWO deletes on audit_log with two different TTLs,
    // discriminated by `action IN (...)`: Tier 1 at 365 days, Tier 2 at 90.
    // It therefore deletes by age AND by action -- middle rows, not a
    // prefix. Measured: 25 Tier-2 rows purged out of 50 leaves 24
    // wrong_prev_hash findings on a healthy database.
    //
    // So a middle gap is NOT an attacker signature; past day 91 it is the
    // ordinary shape of a swept database. The verifier now treats the row
    // after a gap as a new chain head -- the same tolerance it has always
    // had for the FIRST row, whose prev_hash also points at something it
    // cannot see.
    //
    // The gap is still reported, informationally. What is gone is the
    // wrong_prev_hash that made a routine sweep look like tampering.
    const h1 = insertRow("event.a", GENESIS_HASH);
    const h2 = insertRow("event.b", h1);
    insertRow("event.c", h2);
    db.prepare("DELETE FROM audit_log WHERE id = 2").run();

    const result = runVerifier(["--db", dbPath, "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.findings.some((f: { reason: string }) => f.reason === "id_gap_before")).toBe(
      true,
    );
    // The finding this fix removes.
    expect(report.findings.some((f: { reason: string }) => f.reason === "wrong_prev_hash")).toBe(
      false,
    );
  });

  it("content mutation after a gap is still caught", () => {
    // The cost of tolerating the gap is bounded: wrong_row_hash checks a row
    // against ITSELF, not against its predecessor, so editing a surviving
    // row still fails even though the row before it was deleted.
    const h1 = insertRow("event.a", GENESIS_HASH);
    const h2 = insertRow("event.b", h1);
    insertRow("event.c", h2, { tamperContent: true });
    db.prepare("DELETE FROM audit_log WHERE id = 2").run();

    const result = runVerifier(["--db", dbPath, "--json"]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.findings.some((f: { reason: string }) => f.reason === "wrong_row_hash")).toBe(
      true,
    );
  });

  it("nonexistent DB path -> exit 2", () => {
    const result = runVerifier(["--db", path.join(sandbox, "missing.db"), "--json"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Failed to open DB/);
  });

  it("unknown CLI arg -> exit 2", () => {
    const result = runVerifier(["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Unknown argument/);
  });

  it("human-readable output (no --json) lists each finding", () => {
    const h1 = insertRow("event.a", GENESIS_HASH);
    insertRow("event.b", h1);
    db.prepare("UPDATE audit_log SET action = 'EVIL' WHERE id = 2").run();

    const result = runVerifier(["--db", dbPath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Audit chain verification/);
    expect(result.stdout).toMatch(/row_hash mismatch/);
  });
});

describe("verify-audit-chain script: keyed (HMAC) rows", () => {
  const KEYED_ENV = { COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY };

  it("valid keyed 3-row chain verifies with the key in env -> exit 0", () => {
    const h1 = insertRow("event.a", GENESIS_HASH, { key: CHAIN_KEY });
    const h2 = insertRow("event.b", h1, { key: CHAIN_KEY });
    const h3 = insertRow("event.c", h2, { key: CHAIN_KEY });
    expect(h1.startsWith("hmac-sha256-v1:")).toBe(true);

    const result = runVerifier(["--db", dbPath, "--json"], KEYED_ENV);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.verified_rows).toBe(3);
    expect(report.tip_row_hash).toBe(h3);
    expect(report.ok).toBe(true);
  });

  it("keyed chain WITHOUT a key in env -> exit 1, no_key_for_hmac findings", () => {
    const h1 = insertRow("event.a", GENESIS_HASH, { key: CHAIN_KEY });
    insertRow("event.b", h1, { key: CHAIN_KEY });

    const result = runVerifier(["--db", dbPath, "--json"]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.findings.some((f: { reason: string }) => f.reason === "no_key_for_hmac")).toBe(
      true,
    );
  });

  it("tampered keyed row (content changed, hash stale) -> exit 1, wrong_row_hash", () => {
    const h1 = insertRow("event.a", GENESIS_HASH, { key: CHAIN_KEY });
    insertRow("event.b", h1, { key: CHAIN_KEY });
    db.prepare("UPDATE audit_log SET action = 'ATTACKER' WHERE id = 2").run();

    const result = runVerifier(["--db", dbPath, "--json"], KEYED_ENV);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.findings.some((f: { reason: string }) => f.reason === "wrong_row_hash")).toBe(
      true,
    );
  });

  it("keyed row forged with the unkeyed sha256 algorithm no longer verifies -> exit 1", () => {
    // Attacker with DB write access but WITHOUT the key rewrites row 2's
    // content and recomputes a plain unkeyed sha256 (bare, no prefix) --
    // the pre-migration forgery technique. The verifier rejects it as an
    // algorithm downgrade: a keyed chain never reverts to unkeyed.
    const h1 = insertRow("event.a", GENESIS_HASH, { key: CHAIN_KEY });
    insertRow("event.b", h1, { key: CHAIN_KEY });
    const forged = computeRowHash(
      h1,
      {
        action: "ATTACKER",
        actor_org_id: null,
        actor_ip: null,
        actor_user_agent: null,
        actor_user_id: null,
        metadata_json: null,
        outcome: "success",
        request_id: null,
        target: null,
      },
      null,
    );
    expect(forged.startsWith("hmac-sha256-v1:")).toBe(false);
    db.prepare("UPDATE audit_log SET action = 'ATTACKER', row_hash = ? WHERE id = 2").run(forged);

    const result = runVerifier(["--db", dbPath, "--json"], KEYED_ENV);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.findings.some((f: { reason: string }) => f.reason === "downgraded_alg")).toBe(
      true,
    );
  });

  it("legacy unkeyed sha256 rows still verify even when a key is present -> exit 0", () => {
    const h1 = insertRow("event.a", GENESIS_HASH);
    const h2 = insertRow("event.b", h1);
    insertRow("event.c", h2);

    const result = runVerifier(["--db", dbPath, "--json"], KEYED_ENV);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
  });

  it("legit migration boundary (sha256 rows then keyed rows) verifies -> exit 0", () => {
    const h1 = insertRow("legacy.a", GENESIS_HASH);
    const h2 = insertRow("legacy.b", h1);
    const h3 = insertRow("keyed.c", h2, { key: CHAIN_KEY });
    insertRow("keyed.d", h3, { key: CHAIN_KEY });

    const result = runVerifier(["--db", dbPath, "--json"], KEYED_ENV);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.verified_rows).toBe(4);
  });

  describe("boot-time duplicates-accepted row (security review fix)", () => {
    // Regression test for the boot-ordering defect: initDatabase's
    // emitDuplicatesAcceptedAudit (src/boot-orgs-uniqueness.ts) runs before
    // bootPhase2 configures the audit-chain key (src/boot.ts), so on an
    // encrypted deployment the boot-time row used to be written unkeyed
    // even though every other row is HMAC-keyed -- a keyed-tip-then-unkeyed-
    // row shape that this verifier's downgraded_alg check (correctly)
    // treats as a possible forgery. The fix
    // (ensureAuditChainKeyForBootAudit) derives/configures the chain key on
    // demand right before that row is written. This test builds the chain
    // with the REAL production functions (not the local insertRow helper)
    // and runs the shipped verifier against it end to end.
    afterEach(() => {
      resetAuditChainKey();
    });

    it("keyed tip + boot-time row WITHOUT the fix's key config -> exit 1, downgraded_alg (bug repro)", () => {
      // Keyed tip, simulating a prior real audit() call under encryption.
      insertRow("config.boot", GENESIS_HASH, { key: CHAIN_KEY });
      // getAuditChainKey() unconfigured at this call site -- reproduces the
      // exact defect (emitDuplicatesAcceptedAudit called before bootPhase2's
      // configureAuditChainKeyFromMaster).
      emitDuplicatesAcceptedAudit(db as unknown as DatabaseAdapter, {
        duplicates: [{ name: "acme", n: 2, ids: "o1,o2" }],
        totalDuplicateRows: 2,
      });

      const result = runVerifier(["--db", dbPath, "--json"], KEYED_ENV);
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.findings.some((f: { reason: string }) => f.reason === "downgraded_alg")).toBe(
        true,
      );
    });

    it("keyed tip + boot-time row WITH the fix's key config -> exit 0, no downgraded_alg", () => {
      insertRow("config.boot", GENESIS_HASH, { key: CHAIN_KEY });
      // This is exactly what src/database.ts's initDatabase now does before
      // calling emitDuplicatesAcceptedAudit.
      ensureAuditChainKeyForBootAudit({
        COORDINATOR_OAUTH_ENABLED: "true",
        COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY,
      });
      emitDuplicatesAcceptedAudit(db as unknown as DatabaseAdapter, {
        duplicates: [{ name: "acme", n: 2, ids: "o1,o2" }],
        totalDuplicateRows: 2,
      });

      const result = runVerifier(["--db", dbPath, "--json"], KEYED_ENV);
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(true);
      expect(report.verified_rows).toBe(2);
      expect(report.findings.some((f: { reason: string }) => f.reason === "downgraded_alg")).toBe(
        false,
      );
    });

    it("real keyed->unkeyed forge is STILL rejected after the fix (fix does not weaken detection)", () => {
      const h1 = insertRow("config.boot", GENESIS_HASH, { key: CHAIN_KEY });
      ensureAuditChainKeyForBootAudit({
        COORDINATOR_OAUTH_ENABLED: "true",
        COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY,
      });
      emitDuplicatesAcceptedAudit(db as unknown as DatabaseAdapter, {
        duplicates: [{ name: "acme", n: 2, ids: "o1,o2" }],
        totalDuplicateRows: 2,
      });
      // Attacker with DB-write-only access (no key) rewrites row 2's content
      // and recomputes a plain unkeyed sha256 (no prefix) -- same forgery
      // technique as the "keyed row forged with the unkeyed sha256
      // algorithm" test above, applied to the boot-emitted row specifically.
      const forged = computeRowHash(
        h1,
        {
          action: "ATTACKER",
          actor_org_id: null,
          actor_ip: null,
          actor_user_agent: null,
          actor_user_id: null,
          metadata_json: null,
          outcome: "success",
          request_id: null,
          target: null,
        },
        null,
      );
      expect(forged.startsWith("hmac-sha256-v1:")).toBe(false);
      db.prepare("UPDATE audit_log SET action = 'ATTACKER', row_hash = ? WHERE id = 2").run(forged);

      const result = runVerifier(["--db", dbPath, "--json"], KEYED_ENV);
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.findings.some((f: { reason: string }) => f.reason === "downgraded_alg")).toBe(
        true,
      );
    });
  });
});

// ── #348: what the real sweeper actually leaves behind ──────────────────

describe("a swept chain verifies clean (#348)", () => {
  // Every other test in this file simulates a deletion by hand. This one
  // reproduces the SHAPE the production sweeper produces, using the real
  // tier lists, because the assumption the rest of the suite encoded — that
  // the sweeper only ever removes a prefix — is false.
  //
  // src/sweeper/index.ts runs two DELETEs on audit_log with two TTLs
  // (Tier 1 at 365 days, Tier 2 at 90), discriminated by `action IN (...)`.
  // Past day 91 a two-tier deployment has had its Tier 2 rows removed from
  // between its Tier 1 rows, which is a middle deletion however you look at
  // it.
  it("alternating tiers, Tier 2 purged: exit 0, gaps reported informationally", () => {
    const tier1 = TIER1_EVENTS[0];
    const tier2 = TIER2_EVENTS[0];

    // 20 rows, alternating tiers, chained exactly as audit() would.
    let prev = GENESIS_HASH;
    for (let i = 0; i < 20; i++) {
      prev = insertRow(i % 2 === 0 ? tier1 : tier2, prev);
    }

    const clean = runVerifier(["--db", dbPath, "--json"], {
      COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY,
    });
    expect(clean.status, "a freshly written chain must verify").toBe(0);

    // The Tier 2 pass, in isolation: exactly what the sweeper does once the
    // shorter TTL elapses, and nothing else.
    const deleted = db.prepare("DELETE FROM audit_log WHERE action = ?").run(tier2).changes;
    expect(deleted).toBe(10);

    const swept = runVerifier(["--db", dbPath, "--json"], {
      COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY,
    });
    const report = JSON.parse(swept.stdout) as {
      ok: boolean;
      findings: Array<{ reason: string }>;
    };

    // This assertion used to read `toBe(1)` with more than five
    // wrong_prev_hash findings — the defect, pinned so it stayed visible.
    // docs/ops/audit-integrity.md calls exit 1 "a Tier 1 security signal"
    // that "should page the on-call engineer immediately", on an hourly
    // cron, and routine retention triggered it.
    expect(swept.status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.findings.filter((f) => f.reason === "wrong_prev_hash")).toHaveLength(0);

    // The gaps are still reported. They are what a sweep genuinely leaves,
    // and an operator correlating them with the sweeper's own counters is
    // the intended use — they just no longer fail the run.
    expect(report.findings.some((f) => f.reason === "id_gap_before")).toBe(true);
  });

  it("a forged row inside a swept chain is still caught", () => {
    // The bound on what tolerating gaps costs. An attacker who edits a
    // surviving row fails wrong_row_hash regardless of what was deleted
    // around it, because that check hashes the row against itself.
    const tier1 = TIER1_EVENTS[0];
    const tier2 = TIER2_EVENTS[0];
    let prev = GENESIS_HASH;
    for (let i = 0; i < 20; i++) {
      prev = insertRow(i % 2 === 0 ? tier1 : tier2, prev);
    }
    db.prepare("DELETE FROM audit_log WHERE action = ?").run(tier2);
    db.prepare("UPDATE audit_log SET action = 'ATTACKER' WHERE id = 5").run();

    const result = runVerifier(["--db", dbPath, "--json"], {
      COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY,
    });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as { findings: Array<{ reason: string }> };
    expect(report.findings.some((f) => f.reason === "wrong_row_hash")).toBe(true);
  });

  it("a single-tier chain IS purged as a strict prefix — which is why this hid", () => {
    // The Phase-1 mono-tenant profile writes one tier, so its purge really
    // does remove a prefix and really does verify clean. That is the profile
    // the suite was written against.
    let prev = GENESIS_HASH;
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      prev = insertRow(TIER1_EVENTS[0], prev);
      ids.push(i + 1);
    }
    db.prepare("DELETE FROM audit_log WHERE id <= 2").run();

    const result = runVerifier(["--db", dbPath, "--json"], {
      COORDINATOR_ENCRYPTION_KEY: RAW_MASTER_KEY,
    });
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as { ok: boolean }).ok).toBe(true);
  });
});
