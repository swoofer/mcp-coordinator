import { Command } from "commander";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  acquireLock,
  releaseLock,
  LockHeldError,
  type LockHandle,
} from "../lib/pid-lock.js";
import { getRunningCoordinatorPid } from "../server/backup.js";
import { decodeMasterKey } from "../../src/security/master-key.js";
import { EnvelopeEncryption } from "../../src/security/envelope-encryption.js";
import {
  encryptNullable,
  decryptNullable,
} from "../../src/security/encrypt-nullable.js";
import { ensureConfigDir, loadConfig } from "../config.js";

const DEFAULT_BATCH_SIZE = 100;
const ENC_PREFIX = "enc:v";
const ENC_RE = /^enc:v[0-9]+:/;

interface UserRow {
  id: string;
  primary_org_id: string;
  idp_access_token: string | null;
  idp_refresh_token: string | null;
}

export interface MigrateSummary {
  direction: "encrypt" | "decrypt";
  scanned: number;
  changed: number;
  skipped_cas: number;
  already_done: number;
  null_skipped: number;
}

export interface RunMigrationOptions {
  direction: string;
  batchSize: number;
  force: boolean;
  /** Override env-var lookup; testing seam. */
  encryptionKey?: string;
  /** Override config-dir lookup; testing seam. */
  configDir?: string;
  /** Override data-dir lookup; testing seam (else from loadConfig). */
  dataDir?: string;
  /** Optional override of which PID file the daemon-running check consults. */
  runningPid?: number | null;
}

export interface RunMigrationResult {
  exitCode: number;
  summary?: MigrateSummary;
  message?: string;
}

/**
 * Core logic, exit-free, used by both the CLI action and unit tests.
 *
 * Exit semantics:
 *   0 — success, no warnings
 *   1 — success but at least one CAS skip (concurrent mutation detected)
 *   2 — refused / fatal config error
 */
export function runMigration(opts: RunMigrationOptions): RunMigrationResult {
  const direction = String(opts.direction).toLowerCase();
  if (direction !== "encrypt" && direction !== "decrypt") {
    return {
      exitCode: 2,
      message: `--direction must be 'encrypt' or 'decrypt' (got: ${opts.direction})`,
    };
  }
  const batchSize = Math.max(1, Math.floor(opts.batchSize));

  const configDir = opts.configDir ?? ensureConfigDir();

  // Daemon-running guard.
  const runningPid =
    opts.runningPid !== undefined
      ? opts.runningPid
      : getRunningCoordinatorPid(configDir);
  if (runningPid !== null && !opts.force) {
    return {
      exitCode: 2,
      message: `Coordinator daemon is running (PID ${runningPid}). Stop it first, or pass --force.`,
    };
  }

  // Load encryption key.
  const rawKey = opts.encryptionKey ?? process.env.COORDINATOR_ENCRYPTION_KEY;
  if (!rawKey) {
    return {
      exitCode: 2,
      message:
        "COORDINATOR_ENCRYPTION_KEY not set. Cannot perform encryption migration.",
    };
  }
  let key: Buffer;
  try {
    key = decodeMasterKey(rawKey);
  } catch (err) {
    return {
      exitCode: 2,
      message: `Failed to decode master key: ${(err as Error).message}`,
    };
  }
  const provider = new EnvelopeEncryption(key);

  // Resolve data dir.
  const dataDir = opts.dataDir ?? loadConfig(configDir).server.data_dir;

  // Acquire lock.
  const lockPath = path.join(dataDir, "migration.lock");
  let handle: LockHandle;
  try {
    handle = acquireLock(lockPath);
  } catch (err) {
    if (err instanceof LockHeldError) {
      return {
        exitCode: 2,
        message: `Migration lock held by alive PID ${err.heldByPid} (${err.path}). Wait or kill the process.`,
      };
    }
    throw err;
  }

  // SIGINT/SIGTERM cleanup — only register when called from the CLI path
  // (RunMigrationOptions does not expose this; cleanup is registered in
  // createMigrateCommand's action wrapper to keep this function side-effect-free
  // beyond DB + lock writes).

  try {
    const db = new Database(path.join(dataDir, "coordinator.db"));
    try {
      const summary =
        direction === "encrypt"
          ? runEncryptBatches(db, provider, batchSize)
          : runDecryptBatches(db, provider, batchSize);
      const exitCode = summary.skipped_cas > 0 ? 1 : 0;
      // T12b NOTE: an `encryption.migration.completed` Tier 2 audit was
      // considered here but skipped intentionally. The daemon's audit()
      // helper depends on (a) the global getDb() singleton from
      // src/database.ts being initialized, (b) the actor/request
      // AsyncLocalStorage state set by the HTTP layer, and (c) the
      // Tier 2 audit queue from initAuditQueue() — none of which exist
      // in this short-lived CLI process. The CLI already writes
      // formatSummary() to stdout (see createMigrateCommand below),
      // which is the operator-facing record. If/when a CLI-safe audit
      // path lands (Phase 4+), this is the emission site.
      return { exitCode, summary };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      exitCode: 2,
      message: `Migration error: ${(err as Error).message}`,
    };
  } finally {
    try {
      releaseLock(handle);
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Best-effort signal handler installed by the CLI action wrapper while
 * runMigration is in flight. Exits the process with code 130 (128 + SIGINT)
 * so a Ctrl-C reports as interrupted. The lock-release `finally` inside
 * runMigration normally runs unless the signal interrupts a syscall.
 *
 * Exported for unit-test coverage.
 */
export function migrationSignalHandler(): void {
  process.exit(130);
}

export function createMigrateCommand(): Command {
  return new Command("migrate")
    .description(
      "Encrypt or decrypt all IdP tokens in the database (idempotent)",
    )
    .option("--direction <dir>", "encrypt or decrypt", "encrypt")
    .option(
      "--batch-size <n>",
      "rows per transaction",
      String(DEFAULT_BATCH_SIZE),
    )
    .option(
      "--force",
      "proceed even if the coordinator daemon is running",
      false,
    )
    .action((opts: { direction: string; batchSize: string; force: boolean }) => {
      process.once("SIGINT", migrationSignalHandler);
      process.once("SIGTERM", migrationSignalHandler);

      const result = runMigration({
        direction: opts.direction,
        batchSize: parseInt(String(opts.batchSize), 10),
        force: Boolean(opts.force),
      });

      process.off("SIGINT", migrationSignalHandler);
      process.off("SIGTERM", migrationSignalHandler);

      if (result.summary) {
        process.stdout.write(formatSummary(result.summary) + "\n");
      }
      if (result.message) {
        process.stderr.write(result.message + "\n");
      }
      process.exit(result.exitCode);
    });
}

function runEncryptBatches(
  db: Database.Database,
  provider: EnvelopeEncryption,
  batchSize: number,
): MigrateSummary {
  const summary: MigrateSummary = {
    direction: "encrypt",
    scanned: 0,
    changed: 0,
    skipped_cas: 0,
    already_done: 0,
    null_skipped: 0,
  };
  let lastId = "";
  // Cursor by id to avoid re-reading rows we just modified.
  const selectStmt = db.prepare(
    "SELECT id, primary_org_id, idp_access_token, idp_refresh_token FROM users " +
      "WHERE id > ? ORDER BY id LIMIT ?",
  );
  const updAccess = db.prepare(
    "UPDATE users SET idp_access_token = ? WHERE id = ? AND idp_access_token = ?",
  );
  const updRefresh = db.prepare(
    "UPDATE users SET idp_refresh_token = ? WHERE id = ? AND idp_refresh_token = ?",
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = selectStmt.all(lastId, batchSize) as UserRow[];
    if (rows.length === 0) break;
    const tx = db.transaction((batch: UserRow[]) => {
      for (const row of batch) {
        summary.scanned++;
        for (const col of ["idp_access_token", "idp_refresh_token"] as const) {
          const value = row[col];
          if (value === null || value === "") {
            summary.null_skipped++;
            continue;
          }
          if (value.startsWith(ENC_PREFIX) && ENC_RE.test(value)) {
            summary.already_done++;
            continue;
          }
          const encrypted = encryptNullable(provider, value, {
            org_id: row.primary_org_id,
            column: col,
            user_id: row.id,
          });
          const stmt = col === "idp_access_token" ? updAccess : updRefresh;
          const result = stmt.run(encrypted, row.id, value);
          if (result.changes === 0) summary.skipped_cas++;
          else summary.changed++;
        }
      }
    });
    tx(rows);
    lastId = rows[rows.length - 1].id;
  }
  return summary;
}

function runDecryptBatches(
  db: Database.Database,
  provider: EnvelopeEncryption,
  batchSize: number,
): MigrateSummary {
  const summary: MigrateSummary = {
    direction: "decrypt",
    scanned: 0,
    changed: 0,
    skipped_cas: 0,
    already_done: 0,
    null_skipped: 0,
  };
  let lastId = "";
  const selectStmt = db.prepare(
    "SELECT id, primary_org_id, idp_access_token, idp_refresh_token FROM users " +
      "WHERE id > ? AND (idp_access_token GLOB 'enc:v[0-9]*:*' OR idp_refresh_token GLOB 'enc:v[0-9]*:*') " +
      "ORDER BY id LIMIT ?",
  );
  const updAccess = db.prepare(
    "UPDATE users SET idp_access_token = ? WHERE id = ? AND idp_access_token = ?",
  );
  const updRefresh = db.prepare(
    "UPDATE users SET idp_refresh_token = ? WHERE id = ? AND idp_refresh_token = ?",
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = selectStmt.all(lastId, batchSize) as UserRow[];
    if (rows.length === 0) break;
    const tx = db.transaction((batch: UserRow[]) => {
      for (const row of batch) {
        summary.scanned++;
        for (const col of ["idp_access_token", "idp_refresh_token"] as const) {
          const value = row[col];
          if (value === null) {
            summary.null_skipped++;
            continue;
          }
          if (!value.startsWith(ENC_PREFIX) || !ENC_RE.test(value)) {
            summary.already_done++; // already plaintext
            continue;
          }
          const plaintext = decryptNullable(provider, value, {
            org_id: row.primary_org_id,
            column: col,
            user_id: row.id,
          });
          const stmt = col === "idp_access_token" ? updAccess : updRefresh;
          const result = stmt.run(plaintext, row.id, value);
          if (result.changes === 0) summary.skipped_cas++;
          else summary.changed++;
        }
      }
    });
    tx(rows);
    lastId = rows[rows.length - 1].id;
  }
  return summary;
}

export function formatSummary(s: MigrateSummary): string {
  return (
    `Migration ${s.direction}: scanned=${s.scanned}, ` +
    `changed=${s.changed}, already_done=${s.already_done}, ` +
    `skipped_cas=${s.skipped_cas}, null_skipped=${s.null_skipped}`
  );
}
