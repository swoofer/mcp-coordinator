import { getDb } from "../database.js";
import { getRequestId } from "../auth/request-id.js";
import { getCurrentActor, getCurrentRequest } from "../auth/audit-context.js";
import { AuditQueue, type AuditQueueRow } from "./audit-queue.js";
import { GENESIS_HASH, computeRowHash, getAuditChainKey } from "./audit-chain.js";

let _auditQueue: AuditQueue | null = null;

/**
 * Initialize the Tier 2 audit queue. Called once at boot (T29). Pass the
 * db handle so the queue's prepared statements bind to the right database
 * (better-sqlite3 statements are per-connection).
 */
export function initAuditQueue(db: import("better-sqlite3").Database): AuditQueue {
  _auditQueue = new AuditQueue(db);
  return _auditQueue;
}

/** Accessor for tests + SIGTERM drain wiring (T29). */
export function getAuditQueue(): AuditQueue | null {
  return _auditQueue;
}

/** Test helper: reset the singleton between test runs. */
export function resetAuditQueue(): void {
  _auditQueue = null;
}

export interface AuditEvent {
  user_id?: string | null;
  /** Nullable: unauthenticated actions (e.g. failed login before identity established). */
  org_id?: string | null;
  action: string;
  target?: string;
  ip?: string;
  user_agent?: string;
  metadata?: Record<string, unknown>;
}

// v0.8 (Phase 2): audit_log columns renamed per V4 FIX 1.
//   user_id    → actor_user_id
//   org_id     → actor_org_id
//   ip         → actor_ip
//   user_agent → actor_user_agent
//   metadata   → metadata_json
// The AuditEvent interface keeps semantic field names; this helper translates
// to the new column names internally. The richer Tier 1/Tier 2 + request_id +
// outcome semantics from spec §11 land in T11a; this helper is the Phase 1
// shim that still works post-rename. T11a will extend/replace it.
export function auditLog(ev: AuditEvent): void {
  const db = getDb();
  const chainFields = {
    action: ev.action,
    actor_org_id: ev.org_id ?? null,
    actor_ip: ev.ip ?? null,
    actor_user_agent: ev.user_agent ?? null,
    actor_user_id: ev.user_id ?? null,
    metadata_json: ev.metadata ? JSON.stringify(ev.metadata) : null,
    outcome: null,
    request_id: null,
    target: ev.target ?? null,
  };
  insertAuditRowWithChain(db, chainFields, /* hasOutcomeAndRequestId */ false);
}

// ---- Phase 2 audit() extension (T11a) ----

export type AuditTier = 1 | 2;

export interface AuditOptions {
  /** Tier 1 = sync direct INSERT (never drop).
   *  Tier 2 = async batched (T11b; until that lands, falls back to sync).
   *  OPTIONAL; defaults to 2 per V2 §C.6 backward compat. */
  tier?: AuditTier;
  metadata?: Record<string, unknown>;
  target?: string;
  outcome?: "success" | "failure" | "denied";
}

/**
 * Phase 2 audit emission. Reads actor + request from withAuditContext (T11a),
 * request_id from withRequestId (T10). Tier 1 = sync direct INSERT. Tier 2
 * currently also sync — T11b adds the bounded async batched queue. Until
 * then, callers writing Tier 2 events get correctness (no drops) at the cost
 * of latency on hot paths.
 *
 * Storage shape: id and created_at use SQL DEFAULTs from the audit_log
 * schema (AUTOINCREMENT id, default timestamp). No `tier` column stored —
 * retention queries (T28) classify by action name, not by stored tier.
 */
export function audit(action: string, options: AuditOptions = {}): void {
  const tier = options.tier ?? 2;
  const actor = getCurrentActor();
  const request = getCurrentRequest();
  const row: AuditQueueRow = {
    actor_user_id: actor.userId,
    actor_org_id: actor.orgId,
    action,
    target: options.target ?? null,
    actor_ip: request.ip,
    actor_user_agent: request.userAgent,
    request_id: getRequestId() ?? null,
    outcome: options.outcome ?? "success",
    metadata_json: options.metadata ? JSON.stringify(options.metadata) : null,
  };

  if (tier === 1 || !_auditQueue) {
    // Tier 1: sync direct INSERT. Also covers the "queue not initialized"
    // case — pre-boot audit emissions (e.g., migration) shouldn't drop.
    insertAuditRowWithChain(getDb(), row, /* hasOutcomeAndRequestId */ true);
  } else {
    _auditQueue.enqueue(row);
  }
}

/**
 * Shared insert helper for the Tier 1 sync path (and the legacy
 * `auditLog` shim). Looks up the current tip's row_hash, computes the
 * new row's hash, then INSERTs with both columns. Wrapped in IMMEDIATE
 * so a concurrent inserter cannot insert between our SELECT and INSERT.
 *
 * The `hasOutcomeAndRequestId` parameter discriminates between the new
 * 9-column shape (used by `audit()`) and the legacy 7-column shape
 * (used by `auditLog()`); the chain hash includes both columns either
 * way -- the legacy shim just passes `null` for the unused fields.
 */
function insertAuditRowWithChain(
  db: import("../db-adapter.js").DatabaseAdapter,
  row:
    | AuditQueueRow
    | (Omit<AuditQueueRow, "outcome" | "request_id"> & { outcome: null; request_id: null }),
  hasOutcomeAndRequestId: boolean,
): void {
  const tipStmt = db.prepare(
    "SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1",
  );
  const tip = tipStmt.get() as { row_hash: string } | undefined;
  const prevHash = tip?.row_hash ?? GENESIS_HASH;

  const chainRow = {
    action: row.action,
    actor_org_id: row.actor_org_id,
    actor_ip: row.actor_ip,
    actor_user_agent: row.actor_user_agent,
    actor_user_id: row.actor_user_id,
    metadata_json: row.metadata_json,
    outcome: row.outcome ?? null,
    request_id: row.request_id ?? null,
    target: row.target,
  };
  // getAuditChainKey() returns the master-derived HMAC key (keyed, forge-
  // resistant against DB-write-only attackers) or null when encryption is
  // disabled (unkeyed sha256 fallback, recorded honestly).
  const rowHash = computeRowHash(prevHash, chainRow, getAuditChainKey());

  if (hasOutcomeAndRequestId) {
    db.prepare(
      `INSERT INTO audit_log
         (actor_user_id, actor_org_id, action, target,
          actor_ip, actor_user_agent, request_id, outcome, metadata_json,
          prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.actor_user_id,
      row.actor_org_id,
      row.action,
      row.target,
      row.actor_ip,
      row.actor_user_agent,
      row.request_id,
      row.outcome,
      row.metadata_json,
      prevHash,
      rowHash,
    );
  } else {
    db.prepare(
      `INSERT INTO audit_log
         (actor_user_id, actor_org_id, action, target,
          actor_ip, actor_user_agent, metadata_json,
          prev_hash, row_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.actor_user_id,
      row.actor_org_id,
      row.action,
      row.target,
      row.actor_ip,
      row.actor_user_agent,
      row.metadata_json,
      prevHash,
      rowHash,
    );
  }
}
