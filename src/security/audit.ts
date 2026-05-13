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

export function auditLog(ev: AuditEvent): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (user_id, org_id, action, target, ip, user_agent, metadata)
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
