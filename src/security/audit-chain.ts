import crypto from "node:crypto";

/**
 * Append-only hash chain for the audit_log table.
 *
 * Every row carries:
 *   - prev_hash: the row_hash of the immediately previous row (by id),
 *     or GENESIS_HASH for the very first row in the chain.
 *   - row_hash:  SHA-256 over `prev_hash || canonicalRowFields(row)`,
 *     hex-encoded.
 *
 * Tampering with any committed row's content -- changing the action,
 * actor, outcome, or metadata -- breaks the row's own row_hash. Inserting
 * a forged row between two existing rows is blocked by SQLite's
 * AUTOINCREMENT id (which monotonically increases past every previously-
 * issued value); even if an attacker engineered a duplicate id, the
 * row_hash would not chain to the next row's prev_hash.
 *
 * What this chain does NOT prove:
 *   - Timestamp integrity. `created_at` is set by SQL default and is
 *     NOT part of the hash, so an attacker with DB write access can
 *     rewrite `created_at` without invalidating row_hash. For SOC 2
 *     Type II evidence the recommended pattern is to export the
 *     current tip row_hash to a separate append-only store (signed and
 *     timestamped externally) on a periodic schedule.
 *   - Deletion. The retention sweeper deletes audit rows past their TTL;
 *     verify-audit-chain.ts detects gaps in the id sequence but
 *     legitimate sweeper deletions also leave gaps. Detection requires
 *     pairing chain verification with the external tip-attestation
 *     workflow.
 *
 * Genesis row constant: a 64-character zero string. Picking zero (vs a
 * random sentinel) means a fresh DB and an introspectable migration
 * snapshot start at the same point -- a verifier doesn't need a separate
 * "find the genesis" step.
 */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Fields hashed into row_hash. Order matters: the canonical
 * serialization is a JSON object with these exact keys, sorted
 * alphabetically (matches Node's default JSON.stringify on a
 * pre-sorted object). Adding a new column in the future requires a
 * versioning strategy -- do NOT silently include new fields, or
 * post-migration verification of pre-migration rows will fail.
 */
export interface AuditChainFields {
  action: string;
  actor_org_id: string | null;
  actor_ip: string | null;
  actor_user_agent: string | null;
  actor_user_id: string | null;
  metadata_json: string | null;
  outcome: string | null;
  request_id: string | null;
  target: string | null;
}

/**
 * Canonical serialization of an audit row's chainable fields. Keys are
 * inserted in alphabetical order so two callers building from different
 * struct field orderings produce byte-identical input to the hash.
 *
 * null vs missing: every key is always emitted with its value, including
 * `null`. This is deliberate -- silently dropping null fields would
 * make the canonical form ambiguous if a future migration changed a
 * column from NULL to NOT NULL (the hash for "absent" and "explicitly
 * null" would coincide).
 */
export function canonicalRowFields(row: AuditChainFields): string {
  // Build with explicit ordering rather than Object.keys(row).sort() so
  // a misspelled field at a call site is a TypeScript error rather than
  // silently dropped.
  const ordered = {
    action: row.action,
    actor_org_id: row.actor_org_id,
    actor_ip: row.actor_ip,
    actor_user_agent: row.actor_user_agent,
    actor_user_id: row.actor_user_id,
    metadata_json: row.metadata_json,
    outcome: row.outcome,
    request_id: row.request_id,
    target: row.target,
  };
  return JSON.stringify(ordered);
}

/**
 * Compute row_hash for a single row given the previous row's row_hash.
 *
 *   row_hash = SHA-256-hex(prev_hash || canonicalRowFields(row))
 *
 * prev_hash is treated as a raw string (not parsed as hex bytes), so
 * the hash domain is the concatenation of two human-readable strings.
 * This makes the spec readable in a single line of pseudocode without
 * losing any security property -- SHA-256 is collision-resistant
 * regardless of input encoding.
 */
export function computeRowHash(prevHash: string, row: AuditChainFields): string {
  const h = crypto.createHash("sha256");
  h.update(prevHash, "utf8");
  h.update(canonicalRowFields(row), "utf8");
  return h.digest("hex");
}
