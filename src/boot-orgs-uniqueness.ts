import type { DatabaseAdapter } from "./db-adapter.js";
import { withTransaction } from "./db-adapter.js";
import { BootValidationError, loadEncryptionKey } from "./boot-encryption.js";
import { createLogger } from "./observability/logger.js";
import {
  GENESIS_HASH,
  computeRowHash,
  configureAuditChainKeyFromMaster,
  getAuditChainKey,
  type AuditChainFields,
} from "./security/audit-chain.js";

/**
 * v0.10.6 T03 — pre-flight boot guard for the `orgs.name` UNIQUE INDEX.
 *
 * Background: the admin UI's POST /api/admin/orgs handler relies on a UNIQUE
 * INDEX on `orgs(name)` so that a name collision surfaces as SQLITE_CONSTRAINT
 * and is mapped to a 409 ORG_NAME_TAKEN response. SCHEMA in src/database.ts
 * creates `idx_orgs_name` via `CREATE UNIQUE INDEX IF NOT EXISTS` — on a fresh
 * deployment this is a no-op; on an upgrading deployment with accidental
 * duplicate org names it would abort with the cryptic SQLite error
 *
 *     SQLITE_ERROR: UNIQUE constraint failed: orgs.name
 *
 * mid-migration with no remediation hint. This guard runs BEFORE SCHEMA
 * executes and converts that error into a precise, actionable
 * BootValidationError naming each duplicate row + the fix SQL (V3 PATCH 10
 * pattern, mirroring the v0.10.5 boot-encryption guards).
 *
 * Override: COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES=1 lets boot proceed despite
 * duplicates (still creates the index — the duplicate write would still fail
 * later, but the operator has explicitly acknowledged this and the upgrade
 * isn't blocked). The override path emits a Tier 1 audit
 * (`admin.orgs.duplicate_names_accepted`) listing every duplicate so the
 * remediation timeline is captured in the audit chain.
 *
 * Idempotency (V2 PATCH 17): if `idx_orgs_name` already exists, skip the
 * SELECT entirely — the UNIQUE constraint is already enforced so duplicates
 * cannot have been introduced since the index was created, and we don't want
 * a full-table scan on every boot at scale (5M-org deployments).
 *
 * Fresh-DB safety: on a brand-new DB the `orgs` table doesn't exist yet, so
 * we skip the SELECT (no duplicates possible).
 */

export interface OrgDuplicateRow {
  name: string;
  /** COUNT(*) per name. */
  n: number;
  /** GROUP_CONCAT(id, ',') of the duplicate row ids. */
  ids: string;
}

export interface OrgsUniquenessGuardResult {
  /**
   * Non-null only when duplicates exist AND the override env was set. The
   * caller (`initDatabase`) writes the corresponding `admin.orgs.duplicate_
   * names_accepted` audit row AFTER SCHEMA has executed (so the audit_log
   * table is guaranteed to have its v0.8-renamed column shape).
   *
   * Null otherwise — either there were no duplicates, or the guard short-
   * circuited (index already exists / orgs table absent), or the guard
   * threw (no-override-with-duplicates path).
   */
  pendingDuplicatesAcceptedAudit: {
    duplicates: OrgDuplicateRow[];
    totalDuplicateRows: number;
  } | null;
}

export interface OrgsUniquenessGuardDeps {
  db: DatabaseAdapter;
  env: NodeJS.ProcessEnv;
  /**
   * Optional logger for the override-accepted warning. Kept loose (just the
   * methods we actually use) so callers can pass a Pino instance, a console
   * shim, or a test fake without a hard dependency on Pino's type tree.
   */
  logger?: {
    warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  };
}

/**
 * Narrow row shape for the table-exists probe.
 */
interface NameRow {
  name: string;
}

/**
 * Run the pre-flight duplicate-name guard. MUST be called before SCHEMA in
 * `initDatabase()` so the SCHEMA's `CREATE UNIQUE INDEX IF NOT EXISTS
 * idx_orgs_name` does not abort with a cryptic SQLITE_CONSTRAINT error.
 *
 * Behavior matrix:
 *
 *   1. `orgs` table absent (fresh DB)              → no-op, returns null payload.
 *   2. `idx_orgs_name` already exists              → no-op (PATCH 17 short-circuit),
 *                                                    returns null payload.
 *   3. No duplicates                               → no-op, returns null payload.
 *   4. Duplicates + override unset                 → throws BootValidationError.
 *   5. Duplicates + COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES=1
 *                                                  → logger.warn, returns
 *                                                    pending audit payload.
 */
export function runOrgsUniquenessGuard(deps: OrgsUniquenessGuardDeps): OrgsUniquenessGuardResult {
  const { db, env, logger } = deps;

  // Branch 1: `orgs` table absent → fresh DB, nothing to check.
  const orgsTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orgs'")
    .get() as NameRow | undefined;
  if (!orgsTable) {
    return { pendingDuplicatesAcceptedAudit: null };
  }

  // Branch 2 (PATCH 17): index already exists → constraint already enforced,
  // skip the GROUP BY scan to avoid a full-table scan on every boot.
  const indexRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orgs_name'")
    .get() as NameRow | undefined;
  if (indexRow) {
    return { pendingDuplicatesAcceptedAudit: null };
  }

  // Pre-flight SELECT — V3 PATCH 10 exact shape.
  const dupes = db
    .prepare(
      `SELECT name, COUNT(*) AS n, GROUP_CONCAT(id, ',') AS ids
         FROM orgs
        GROUP BY name
       HAVING COUNT(*) > 1`,
    )
    .all() as OrgDuplicateRow[];

  // Branch 3: no duplicates → SCHEMA will create the index cleanly.
  if (dupes.length === 0) {
    return { pendingDuplicatesAcceptedAudit: null };
  }

  const detail = dupes.map((d) => `  name="${d.name}" (${d.n} rows, ids: ${d.ids})`).join("\n");
  const totalDuplicateRows = dupes.reduce((sum, d) => sum + d.n, 0);

  // Branch 4: no override → fail closed with actionable error.
  if (env.COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES !== "1") {
    throw new BootValidationError(
      `Cannot create UNIQUE INDEX idx_orgs_name: duplicate org names found.\n` +
        `Resolve by renaming duplicates before upgrading. SQL:\n` +
        `  UPDATE orgs SET name = name || '_' || id WHERE id IN (<keep-only-one-id-per-name>);\n` +
        `Or, to acknowledge and proceed (NOT recommended), set ` +
        `COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES=1 — an audit row will be ` +
        `written naming every duplicate, and SCHEMA's CREATE UNIQUE INDEX ` +
        `IF NOT EXISTS will then fail with SQLITE_CONSTRAINT, which the ` +
        `operator MUST resolve before the next boot.\n` +
        `Duplicates:\n${detail}`,
    );
  }

  // Branch 5: override accepted. Log a loud warning so the duplicate names
  // appear in the local process log even if the audit chain is later swept;
  // defer the audit_log INSERT to the caller (initDatabase) so we can rely
  // on the v0.8 column-renamed shape (actor_user_id, metadata_json, ...).
  if (logger) {
    logger.warn(
      {
        duplicate_groups: dupes.length,
        total_rows: totalDuplicateRows,
        duplicates: dupes,
      },
      "COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES=1: proceeding despite duplicate org names; SCHEMA's CREATE UNIQUE INDEX will likely fail at next boot — resolve before re-boot.",
    );
  }

  return {
    pendingDuplicatesAcceptedAudit: {
      duplicates: dupes,
      totalDuplicateRows,
    },
  };
}

/**
 * Ensure the audit-chain HMAC key is configured before ANY boot-time code
 * writes an audit row, on an encrypted deployment — before `bootPhase2`
 * itself gets a chance to run `configureAuditChainKeyFromMaster`
 * (src/boot.ts step 7b).
 *
 * Background (security review finding): two call paths write audit_log rows
 * earlier than step 7b:
 *
 *   1. `initDatabase` (src/database.ts) can call `emitDuplicatesAcceptedAudit`
 *      (this file) — `initDatabase` runs, and can write this row, well
 *      BEFORE `bootPhase2` is even invoked (the caller runs it strictly
 *      AFTER `createServices`/`initDatabase` returns).
 *   2. `performRestoreCheck` (src/boot.ts step 5, NR12 restore detection)
 *      can call `audit()` directly — "recovery.token_epoch_global_bump" /
 *      "recovery.completed" on a detected restore — and step 5 runs before
 *      step 7b within `bootPhase2` itself.
 *
 * In both cases the module-level chain-key singleton
 * (src/security/audit-chain.ts) is still unset at the call site, so
 * `getAuditChainKey()` returns null and the row is written as unkeyed
 * sha256 even when encryption is enabled and every other row in the chain
 * is HMAC-keyed. Since each row still chains onto the real tip, a boot on
 * an encrypted deployment then appends an unkeyed row after a keyed one —
 * which `scripts/verify-audit-chain.ts`'s downgraded-algorithm check
 * (correctly) treats as a possible forgery signature, false-positiving
 * `verify-audit-chain` on an otherwise-untampered chain. Path 1 re-triggers
 * on every boot for as long as the duplicate-org condition isn't
 * remediated; path 2 triggers on any boot that detects a restore.
 *
 * Fix: derive/configure the chain key here, on demand, right before the
 * row is written — using the exact same derivation
 * (`loadEncryptionKey` + `configureAuditChainKeyFromMaster`) `bootPhase2`
 * itself uses, gated by the identical condition it uses
 * (COORDINATOR_OAUTH_ENABLED=true — encryption in this codebase only
 * protects Phase 2 IdP token columns, so a Phase 1-only deployment never
 * has a master key to derive from regardless of whether
 * COORDINATOR_ENCRYPTION_KEY happens to be set, and this must not change
 * that). Called from two places: `initDatabase` (covers path 1, before
 * `bootPhase2` runs at all) and `bootPhase2` itself, early — before step 5 —
 * so it also covers path 2 and any future audit() emission added between
 * there and step 7b, without having to patch each call site individually.
 * `bootPhase2`'s own step 7b still re-configures the same key later from the
 * same env — harmless, since deriving twice from an identical master key is
 * deterministic and idempotent; that redundancy is what keeps `encKey`
 * (the raw master key, not just the derived chain key) available there for
 * `runEncryptionGuards`/`buildWrappedProvider`, and keeps `bootPhase2`
 * correct when exercised on its own (e.g. tests that call it without going
 * through `initDatabase` first).
 *
 * No-ops (does not re-derive) when a key is already configured, so it
 * never clobbers a key a caller configured for its own reasons (e.g. test
 * setup) with a freshly re-derived — but value-identical — one, and so the
 * two call sites above never do redundant work when both run in the same
 * boot.
 */
export function ensureAuditChainKeyForBootAudit(env: NodeJS.ProcessEnv): void {
  if (env.COORDINATOR_OAUTH_ENABLED !== "true") return;
  if (getAuditChainKey() !== null) return;
  const logger = createLogger({ level: "silent" });
  const masterKey = loadEncryptionKey(env, logger);
  configureAuditChainKeyFromMaster(masterKey);
}

/**
 * Append the `admin.orgs.duplicate_names_accepted` Tier 1 audit row for the
 * override-accepted branch. Called by `initDatabase` AFTER SCHEMA + v0.8
 * migrations have run, so the renamed columns (actor_user_id,
 * metadata_json, prev_hash, row_hash) are guaranteed to exist.
 *
 * Writes directly via the db handle (not via `audit()` in
 * src/security/audit.ts) because this runs DURING `initDatabase` — the
 * `audit()` helper's `getDb()` call resolves the still-being-initialized
 * module-level `db` reference, and the audit_queue isn't initialized yet
 * either. Mirrors the audit-chain bookkeeping inline.
 *
 * `getAuditChainKey()` below legitimately returns the derived key on an
 * encrypted deployment — the caller (`initDatabase`) runs
 * `ensureAuditChainKeyForBootAudit` first so the singleton is populated
 * before this row's hash is computed; see that function's doc comment.
 */
export function emitDuplicatesAcceptedAudit(
  db: DatabaseAdapter,
  payload: { duplicates: OrgDuplicateRow[]; totalDuplicateRows: number },
): void {
  // #317 made the Tier 1 chained insert atomic because a read-then-write
  // split across two implicit transactions lets a second writer observe the
  // same tip and fork the chain. This site was missed. It runs at boot, from
  // initDatabase, which is precisely when a second process (a migration, a
  // second coordinator racing to start) is most likely to be writing too.
  //
  // withTransaction nests through the driver's savepoints, so this stays
  // correct if a caller has already opened one.
  withTransaction(db, () => {
    const tip = db
      .prepare("SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get() as { row_hash: string } | undefined;
    const prevHash = tip?.row_hash ?? GENESIS_HASH;

    const metadata = {
      duplicate_groups: payload.duplicates.length,
      total_rows: payload.totalDuplicateRows,
      // Full duplicate manifest — keeps the forensic trail in the audit chain
      // even after the operator renames rows post-boot.
      duplicates: payload.duplicates.map((d) => ({
        name: d.name,
        n: d.n,
        ids: d.ids.split(","),
      })),
    };

    const chainRow: AuditChainFields = {
      action: "admin.orgs.duplicate_names_accepted",
      actor_org_id: null,
      actor_ip: null,
      actor_user_agent: null,
      actor_user_id: null,
      metadata_json: JSON.stringify(metadata),
      outcome: "success",
      request_id: null,
      target: null,
    };
    const rowHash = computeRowHash(prevHash, chainRow, getAuditChainKey());

    db.prepare(
      `INSERT INTO audit_log
         (actor_user_id, actor_org_id, action, target,
          actor_ip, actor_user_agent, request_id, outcome, metadata_json,
          prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      null,
      null,
      chainRow.action,
      null,
      null,
      null,
      null,
      chainRow.outcome,
      chainRow.metadata_json,
      prevHash,
      rowHash,
    );
  });
}
