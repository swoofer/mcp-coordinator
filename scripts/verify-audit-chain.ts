#!/usr/bin/env tsx
/**
 * verify-audit-chain.ts -- walk audit_log and validate the SHA-256
 * chain installed by T50 (v0.9.1).
 *
 * Usage:
 *   tsx scripts/verify-audit-chain.ts [--db <path>] [--json]
 *
 * Exit codes:
 *   0  chain is intact -- every row_hash recomputes correctly and
 *      every prev_hash links to the previous row's row_hash
 *   1  one or more rows fail verification
 *   2  could not open the database / malformed CLI args
 *
 * What this script proves when it exits 0:
 *   - No row's content has been mutated in place (action, actor fields,
 *     target, request_id, outcome, metadata_json). Re-hashing produces
 *     the stored row_hash byte-for-byte.
 *   - No row has been inserted out of order. Each row's prev_hash
 *     matches the previous row's row_hash.
 *
 * What this script does NOT prove on exit 0:
 *   - That `created_at` is correct -- it is intentionally outside the
 *     hash so SQL's default timestamp behaviour works. An attacker
 *     with DB write access can rewrite timestamps without invalidating
 *     row_hash. Pair with TLS-protected log shipping or an external
 *     timestamp authority for time integrity.
 *   - That no rows have been deleted. The retention sweeper
 *     legitimately deletes old audit rows; this script reports id-gaps
 *     in the summary so operators can correlate with the sweeper's
 *     own metrics, but a malicious deletion is indistinguishable from
 *     a sweeper deletion without an external tip-attestation record.
 *
 * The recommended operational workflow is documented in
 * docs/ops/audit-integrity.md.
 */
import { createRequire } from "node:module";
import path from "node:path";
import {
  GENESIS_HASH,
  computeRowHash,
  type AuditChainFields,
} from "../src/security/audit-chain.js";

const require = createRequire(import.meta.url);

interface CliArgs {
  dbPath: string;
  json: boolean;
}

interface AuditRow extends AuditChainFields {
  id: number;
  prev_hash: string | null;
  row_hash: string | null;
}

interface RowFinding {
  id: number;
  reason:
    | "missing_hash"
    | "wrong_row_hash"
    | "wrong_prev_hash"
    | "id_gap_before";
  expected?: string;
  actual?: string | null;
  /** When reason === "id_gap_before", the gap size (rows missing
   *  between previous-row-id and this row's id). */
  gap_size?: number;
}

interface Report {
  db_path: string;
  total_rows: number;
  verified_rows: number;
  findings: RowFinding[];
  tip_row_hash: string | null;
  ok: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let dbPath = "data/coordinator.db";
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") {
      const next = argv[i + 1];
      if (!next) throw new Error("--db requires a path");
      dbPath = next;
      i++;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { dbPath, json };
}

function printUsage(): void {
  process.stderr.write(
    "Usage: tsx scripts/verify-audit-chain.ts [--db <path>] [--json]\n",
  );
}

function verify(rows: AuditRow[]): RowFinding[] {
  const findings: RowFinding[] = [];
  // prevHash = null until the first row sets it; this makes the
  // verifier robust to legitimate front-deletion by the retention
  // sweeper (the first remaining row's prev_hash points at a
  // long-deleted row's row_hash, which we can't verify locally --
  // we accept its claim and verify forward from there).
  //
  // The unconditional starting-from-GENESIS check is the job of the
  // tip-attestation workflow (docs/ops/audit-integrity.md), which
  // compares the FIRST observed prev_hash against an external record
  // of the previous attestation's tip.
  let prevHash: string | null = null;
  let prevId: number | null = null;

  for (const row of rows) {
    if (prevId !== null && row.id !== prevId + 1) {
      findings.push({
        id: row.id,
        reason: "id_gap_before",
        gap_size: row.id - prevId - 1,
      });
    }

    if (row.row_hash === null || row.prev_hash === null) {
      findings.push({ id: row.id, reason: "missing_hash" });
      prevId = row.id;
      continue;
    }

    // First-row case: prevHash is null. We accept the claimed prev_hash
    // verbatim. Subsequent rows must chain against the previous row's
    // row_hash exactly.
    if (prevHash !== null && row.prev_hash !== prevHash) {
      findings.push({
        id: row.id,
        reason: "wrong_prev_hash",
        expected: prevHash,
        actual: row.prev_hash,
      });
    }

    const recomputed = computeRowHash(row.prev_hash, {
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

    if (recomputed !== row.row_hash) {
      findings.push({
        id: row.id,
        reason: "wrong_row_hash",
        expected: recomputed,
        actual: row.row_hash,
      });
    }

    prevHash = row.row_hash;
    prevId = row.id;
  }

  return findings;
}

function loadRows(dbPath: string): AuditRow[] {
  const absolute = path.resolve(dbPath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3") as new (p: string, opts?: { readonly?: boolean }) => {
    prepare: (sql: string) => { all: () => unknown[] };
    close: () => void;
  };
  const db = new Database(absolute, { readonly: true });
  try {
    return db
      .prepare(
        "SELECT id, actor_user_id, actor_org_id, action, target, " +
          "actor_ip, actor_user_agent, request_id, outcome, " +
          "metadata_json, prev_hash, row_hash FROM audit_log ORDER BY id ASC",
      )
      .all() as AuditRow[];
  } finally {
    db.close();
  }
}

function printHuman(report: Report): void {
  const out: string[] = [];
  out.push(`Audit chain verification`);
  out.push(`  DB:            ${report.db_path}`);
  out.push(`  Total rows:    ${report.total_rows}`);
  out.push(`  Verified rows: ${report.verified_rows}`);
  out.push(`  Tip row_hash:  ${report.tip_row_hash ?? "(empty table)"}`);
  out.push("");
  if (report.findings.length === 0) {
    out.push("Result: OK -- every row's hash recomputes correctly.");
  } else {
    out.push(`Result: ${report.findings.length} finding(s):`);
    for (const f of report.findings) {
      switch (f.reason) {
        case "missing_hash":
          out.push(`  id=${f.id}  missing prev_hash or row_hash (NULL)`);
          break;
        case "wrong_row_hash":
          out.push(
            `  id=${f.id}  row_hash mismatch -- expected ${f.expected}, got ${f.actual}`,
          );
          break;
        case "wrong_prev_hash":
          out.push(
            `  id=${f.id}  prev_hash mismatch -- expected ${f.expected}, got ${f.actual}`,
          );
          break;
        case "id_gap_before":
          out.push(
            `  id=${f.id}  id-gap of ${f.gap_size} before this row (sweeper deletion or tampering)`,
          );
          break;
      }
    }
  }
  process.stdout.write(out.join("\n") + "\n");
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    printUsage();
    process.exit(2);
  }

  let rows: AuditRow[];
  try {
    rows = loadRows(args.dbPath);
  } catch (err) {
    process.stderr.write(`Failed to open DB: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const findings = verify(rows);
  const tip = rows.length > 0 ? rows[rows.length - 1].row_hash : null;
  // Findings of reason "id_gap_before" alone do NOT fail verification
  // -- legitimate sweeper deletions look the same. Real failures are
  // missing_hash, wrong_row_hash, wrong_prev_hash.
  const verificationFailures = findings.filter(
    (f) => f.reason !== "id_gap_before",
  );
  const report: Report = {
    db_path: args.dbPath,
    total_rows: rows.length,
    verified_rows: rows.length - verificationFailures.length,
    findings,
    tip_row_hash: tip,
    ok: verificationFailures.length === 0,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    printHuman(report);
  }

  process.exit(report.ok ? 0 : 1);
}

main();
