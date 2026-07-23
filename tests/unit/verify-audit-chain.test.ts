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
} from "../../src/security/audit-chain.js";
import { decodeMasterKey } from "../../src/security/master-key.js";

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

  it("front-deletion (sweeper retention) -> exit 0, no findings", () => {
    // Sweeper deletes oldest rows first. After it removes row 1, the
    // verifier sees the chain starting at row 2 and trusts row 2's
    // prev_hash as the entry point (it claims to chain from a deleted
    // row 1, which the verifier cannot reconstruct locally -- the
    // tip-attestation workflow handles that).
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

  it("middle-deletion -> exit 1 (id_gap + wrong_prev_hash)", () => {
    // The retention sweeper never deletes middle rows -- it deletes
    // by age, oldest first. A middle gap is an attacker signature.
    const h1 = insertRow("event.a", GENESIS_HASH);
    const h2 = insertRow("event.b", h1);
    insertRow("event.c", h2);
    db.prepare("DELETE FROM audit_log WHERE id = 2").run();

    const result = runVerifier(["--db", dbPath, "--json"]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f: { reason: string }) => f.reason === "id_gap_before")).toBe(
      true,
    );
    expect(report.findings.some((f: { reason: string }) => f.reason === "wrong_prev_hash")).toBe(
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
});
