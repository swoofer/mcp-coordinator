import { getDb } from "../database.js";
import { getRequestId } from "../auth/request-id.js";
import { getCurrentActor, getCurrentRequest } from "../auth/audit-context.js";

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
  getDb()
    .prepare(
      `INSERT INTO audit_log (actor_user_id, actor_org_id, action, target, actor_ip, actor_user_agent, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ev.user_id ?? null,
      ev.org_id ?? null,
      ev.action,
      ev.target ?? null,
      ev.ip ?? null,
      ev.user_agent ?? null,
      ev.metadata ? JSON.stringify(ev.metadata) : null,
    );
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
  // tier resolution kept for routing (Tier 2 fallback today; T11b later).
  const tier = options.tier ?? 2;
  void tier; // currently unused at storage time — routes through same INSERT
             // until T11b adds the AuditQueue branch.

  const actor = getCurrentActor();
  const request = getCurrentRequest();
  const metadataJson = options.metadata ? JSON.stringify(options.metadata) : null;
  const outcome = options.outcome ?? "success";
  const target = options.target ?? null;
  const requestId = getRequestId() ?? null;

  getDb()
    .prepare(`
      INSERT INTO audit_log
        (actor_user_id, actor_org_id, action, target,
         actor_ip, actor_user_agent, request_id, outcome,
         metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      actor.userId,
      actor.orgId,
      action,
      target,
      request.ip,
      request.userAgent,
      requestId,
      outcome,
      metadataJson,
    );
}
