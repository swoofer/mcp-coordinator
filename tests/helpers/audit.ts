import { getAuditQueue } from "../../src/security/audit.js";
import { getDb } from "../../src/database.js";
import type { AuditQueueMetrics } from "../../src/security/audit-queue.js";

/**
 * Drain the Tier 2 queue + return metrics. Returns null if no queue is
 * registered — pre-T11b code paths and tests that opt out of async batching
 * leave the queue uninitialized (Tier 2 falls back to sync in that case),
 * so a null return is meaningful rather than an error.
 */
export function drainAuditQueue(): AuditQueueMetrics | null {
  return getAuditQueue()?.drain() ?? null;
}

/** Convenience: SELECT all audit rows matching an action, oldest-first. */
export function findAuditRows(action: string): Array<Record<string, unknown>> {
  return getDb()
    .prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id ASC")
    .all(action) as Array<Record<string, unknown>>;
}

/**
 * Assertion helper for integration tests. Throws if no row matches `action`
 * or if the latest row's fields don't match the spec. Strict equality —
 * callers comparing JSON-serialized metadata must pass the serialized string.
 */
export function expectAuditRow(action: string, fields: Record<string, unknown>): void {
  const rows = findAuditRows(action);
  if (rows.length === 0) {
    throw new Error(`No audit row with action="${action}"`);
  }
  const row = rows[rows.length - 1];
  for (const [k, v] of Object.entries(fields)) {
    if (row[k] !== v) {
      throw new Error(
        `Audit row mismatch on ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(row[k])}`,
      );
    }
  }
}
