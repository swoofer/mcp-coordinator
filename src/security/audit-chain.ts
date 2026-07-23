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
 * Per-row hashing algorithm markers. Every chain entry records which
 * algorithm produced its row_hash so verification stays correct across a
 * backward-compatible migration (legacy rows and keyed rows coexist).
 *
 *   - {@link ALG_SHA256}: unkeyed SHA-256. Used by every row written before
 *     this migration, and by new rows when no master key is configured
 *     (encryption disabled). Stored as a bare 64-hex digest, byte-identical
 *     to the pre-migration format.
 *   - {@link ALG_HMAC_V1}: HMAC-SHA256 keyed by a key derived from the master
 *     key (see {@link deriveAuditChainKey}). Used by new rows once a key is
 *     available. Stored with a "hmac-sha256-v1:" prefix so verification can
 *     tell the two apart with no schema change.
 *
 * Why keying matters: an unkeyed chain is publicly recomputable, so anyone
 * with direct DB write access can rewrite historical rows and regenerate a
 * fully self-consistent chain from GENESIS_HASH forward. Keying the row_hash
 * with a secret that never lives in the DB (it is derived from the env/Vault
 * master key) means a DB-write-only attacker can no longer forge valid
 * row_hashes. Keyed audit integrity therefore requires COORDINATOR_ENCRYPTION_KEY
 * to be set; without it the chain honestly records unkeyed sha256 and provides
 * tamper-evidence only against partial/single-row edits.
 */
export const ALG_SHA256 = "sha256";
export const ALG_HMAC_V1 = "hmac-sha256-v1";
export type ChainAlgorithm = typeof ALG_SHA256 | typeof ALG_HMAC_V1;

const HMAC_PREFIX = `${ALG_HMAC_V1}:`;

/**
 * HKDF (RFC 5869) parameters for deriving the audit-chain HMAC key from the
 * master key. A distinct, versioned `info` label domain-separates this key
 * from every other use of the master key (envelope DEK wrapping, key
 * fingerprint, pseudonyms), and a stable salt keeps derivation deterministic
 * so the verifier reproduces the exact same key. Deriving from the existing
 * master key adds NO new key-management surface — no new secret to store,
 * rotate, or mount.
 */
const HKDF_SALT = "mcc-audit-chain-hkdf-salt-v1";
const HKDF_INFO = "audit-chain-hmac-v1";

/**
 * Derive the 32-byte audit-chain HMAC key from the 32-byte master key via
 * HKDF-SHA256. Deterministic: the same master key always yields the same
 * chain key, so a verifier holding the master key reproduces the key and can
 * validate keyed rows.
 */
export function deriveAuditChainKey(masterKey: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", masterKey, Buffer.from(HKDF_SALT), Buffer.from(HKDF_INFO), 32),
  );
}

/**
 * Process-wide audit-chain key. Null when encryption is disabled (no master
 * key) — new rows then fall back to unkeyed sha256, recorded honestly. Set
 * once at boot via {@link configureAuditChainKeyFromMaster}.
 */
let _chainKey: Buffer | null = null;

/** Set the derived audit-chain key directly (mainly for tests). */
export function configureAuditChainKey(key: Buffer | null): void {
  _chainKey = key;
}

/**
 * Configure the audit-chain key from the master key (or null when encryption
 * is disabled). Keeps the derive-or-null decision here rather than at the
 * boot call site, so boot wiring is a single unconditional call.
 */
export function configureAuditChainKeyFromMaster(masterKey: Buffer | null): void {
  _chainKey = masterKey ? deriveAuditChainKey(masterKey) : null;
}

/** The configured audit-chain key, or null when the chain is unkeyed. */
export function getAuditChainKey(): Buffer | null {
  return _chainKey;
}

/** Test helper: reset the singleton between test runs. */
export function resetAuditChainKey(): void {
  _chainKey = null;
}

/**
 * Classify a stored row_hash by its recorded algorithm. A "hmac-sha256-v1:"
 * prefix marks a keyed row; anything else is a legacy/unkeyed sha256 row.
 */
export function algorithmOf(storedRowHash: string): ChainAlgorithm {
  return storedRowHash.startsWith(HMAC_PREFIX) ? ALG_HMAC_V1 : ALG_SHA256;
}

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
 *   keyed (key present):  "hmac-sha256-v1:" || HMAC-SHA256-hex(key, prev_hash || canonicalRowFields(row))
 *   unkeyed (key null):   SHA-256-hex(prev_hash || canonicalRowFields(row))
 *
 * When `key` is supplied the row_hash is an HMAC keyed by a secret that never
 * lives in the database (derived from the master key), so an attacker with
 * DB-write-only access cannot recompute a valid row_hash and therefore cannot
 * regenerate a self-consistent forged chain. When `key` is null the function
 * falls back to the original unkeyed SHA-256 and returns a bare 64-hex digest
 * byte-identical to the pre-migration format — this keeps legacy rows and
 * no-key deployments verifiable, with the algorithm recorded honestly via the
 * presence/absence of the "hmac-sha256-v1:" prefix (see {@link algorithmOf}).
 *
 * prev_hash is treated as a raw string (not parsed as hex bytes), so the hash
 * domain is the concatenation of two human-readable strings — a stored
 * prev_hash carries the previous row's full row_hash (including any algorithm
 * prefix), which binds the algorithm marker into the chain as well.
 */
export function computeRowHash(
  prevHash: string,
  row: AuditChainFields,
  key: Buffer | null = null,
): string {
  const canonical = canonicalRowFields(row);
  if (key) {
    const mac = crypto.createHmac("sha256", key);
    mac.update(prevHash, "utf8");
    mac.update(canonical, "utf8");
    return HMAC_PREFIX + mac.digest("hex");
  }
  const h = crypto.createHash("sha256");
  h.update(prevHash, "utf8");
  h.update(canonical, "utf8");
  return h.digest("hex");
}
