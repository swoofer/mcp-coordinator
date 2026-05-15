import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../database.js";
import { getAuditQueue } from "../security/audit.js";

export interface ReadinessOptions {
  /** Set to true when the sweeper circuit-breaker (T28) has tripped open.
   *  Phase 2 hardwires false until T28 lands; T28 will wire the real signal. */
  sweeperCircuitOpen?: boolean;
  /** Hard cap on audit queue depth as % of capacity. Default 80. */
  auditDepthThresholdPercent?: number;
  /** Set to true when the server is draining (SIGTERM hook calls this).
   *  T29 boot wires the signal. */
  draining?: boolean;
}

const AUDIT_QUEUE_CAPACITY = 10_000;

/**
 * Liveness probe — always 200 if the process is responsive. Phase 2
 * /healthz alias for orchestrator probes that want a different path
 * than Phase 1's /livez.
 */
export function handleHealthz(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ status: "alive" }));
}

/**
 * Readiness probe — 503 when ANY of:
 *   - sweeper circuit is open
 *   - audit queue depth > threshold (default 80% of capacity)
 *   - DB is unreachable (SELECT 1 throws)
 *   - server is draining
 *
 * Returns a structured payload regardless of status so observers can
 * parse uniformly. The Phase 2 /health/ready path is distinct from
 * Phase 1's /readyz (which checks db + mqtt + tree_sitter + git_cochange);
 * Phase 2 readiness is auth-flow-specific.
 */
export function handleHealthReady(
  _req: IncomingMessage,
  res: ServerResponse,
  opts: ReadinessOptions = {},
): void {
  const checks = {
    db: { ok: false as boolean, error: undefined as string | undefined },
    audit_queue: {
      ok: true as boolean,
      depth: 0,
      capacity: AUDIT_QUEUE_CAPACITY,
      threshold_percent: opts.auditDepthThresholdPercent ?? 80,
    },
    sweeper: { ok: !(opts.sweeperCircuitOpen ?? false) },
    draining: opts.draining ?? false,
  };

  try {
    getDb().prepare("SELECT 1").get();
    checks.db.ok = true;
  } catch (err) {
    checks.db.error = (err as Error).message;
  }

  const queue = getAuditQueue();
  if (queue) {
    const depth = queue.size();
    const threshold =
      (checks.audit_queue.threshold_percent / 100) * AUDIT_QUEUE_CAPACITY;
    checks.audit_queue.depth = depth;
    checks.audit_queue.ok = depth <= threshold;
  }

  const ready =
    checks.db.ok &&
    checks.audit_queue.ok &&
    checks.sweeper.ok &&
    !checks.draining;

  res.writeHead(ready ? 200 : 503, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(
    JSON.stringify({
      status: ready ? "ready" : "not_ready",
      checks,
    }),
  );
}
