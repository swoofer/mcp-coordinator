import { getDb } from "../database.js";

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
