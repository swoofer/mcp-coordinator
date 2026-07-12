/* eslint-disable no-console */
/**
 * T33 chaos — Tier 2 audit queue overflow + drop accounting.
 *
 * Verifies V3 §B-NEW-6: when Tier 2 emissions exceed CAPACITY=10000,
 * drops are accounted for and the caller is unaffected; once flush
 * resumes, subsequent enqueues succeed.
 *
 * Setup:
 *   - Real AuditQueue against in-memory better-sqlite3.
 *   - Suppress the internal auto-flush by overriding `flush` to a no-op
 *     (and the timer scheduler) so the buffer fills past capacity.
 *   - Enqueue 15K rows synchronously. Buffer caps at 10K; the remaining
 *     5K increment `metrics.dropped` while enqueue stays sub-µs.
 *   - Restore the real flush, call queue.flush() to drain, then enqueue
 *     a small follow-up burst — verify they succeed.
 *
 * Output assertions:
 *   - dropped == N - CAPACITY (deterministic; no race window).
 *   - flushed == CAPACITY + recovery_n (all retained rows + post-recovery).
 *   - post_recovery_dropped == 0.
 */
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { AuditQueue, type AuditQueueRow } from "../../../src/security/audit-queue.js";

const require = createRequire(import.meta.url);
const DatabaseCtor = require("better-sqlite3") as new (path: string) => Database.Database;

const AUDIT_SCHEMA = `
  CREATE TABLE audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id   TEXT,
    actor_org_id    TEXT,
    action          TEXT NOT NULL,
    target          TEXT,
    actor_ip        TEXT,
    actor_user_agent TEXT,
    request_id      TEXT,
    outcome         TEXT,
    metadata_json   TEXT,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

const CAPACITY = 10_000;

function makeRow(i: number): AuditQueueRow {
  return {
    actor_user_id: "u-perf",
    actor_org_id: "org-perf",
    action: "perf.audit.overflow",
    target: null,
    actor_ip: "127.0.0.1",
    actor_user_agent: "perf-bench/1.0",
    request_id: `req-${i}`,
    outcome: "success",
    metadata_json: JSON.stringify({ i }),
  };
}

async function main(): Promise<void> {
  const N_BURST = parseInt(process.env.CHAOS_N ?? "15000", 10);
  const N_RECOVERY = parseInt(process.env.CHAOS_N_RECOVERY ?? "100", 10);

  const db = new DatabaseCtor(":memory:");
  db.exec(AUDIT_SCHEMA);
  const q = new AuditQueue(db);

  // Suppress the auto-flush. TS marks `flush` and `scheduleFlush` private/method;
  // at runtime they're plain instance properties on the prototype, so an
  // unknown-cast plus assign overrides them for THIS instance only.
  const qAny = q as unknown as {
    flush: () => void;
    scheduleFlush?: () => void;
    realFlush?: () => void;
  };
  // Save the prototype flush so we can re-enable it after the burst.
  const protoFlush = (Object.getPrototypeOf(q) as { flush: () => void }).flush;
  qAny.flush = () => {
    /* suppressed */
  };
  qAny.scheduleFlush = () => {
    /* suppressed */
  };

  // Burst N_BURST rows. The internal auto-flush at BATCH_SIZE=50 is
  // suppressed; the buffer fills until CAPACITY=10000, after which
  // `enqueue` increments `_dropped` without touching the buffer.
  for (let i = 0; i < N_BURST; i++) q.enqueue(makeRow(i));

  const burstMetrics = { ...q.metrics };

  // Restore flush + drain the retained rows.
  qAny.flush = protoFlush.bind(q);
  q.flush();
  const afterDrainMetrics = { ...q.metrics };

  // Post-recovery: enqueues should succeed normally.
  for (let i = 0; i < N_RECOVERY; i++) q.enqueue(makeRow(N_BURST + i));
  q.flush();
  const postRecoveryMetrics = { ...q.metrics };

  console.log("\nchaos: audit-queue-overflow");
  console.log(`  N_BURST=${N_BURST}, CAPACITY=${CAPACITY}`);
  console.log(
    `  after burst:    enqueued=${burstMetrics.enqueued}, dropped=${burstMetrics.dropped}, flushed=${burstMetrics.flushed}`,
  );
  console.log(
    `  after drain:    flushed=${afterDrainMetrics.flushed}, batches=${afterDrainMetrics.batchesWritten}`,
  );
  console.log(
    `  after recovery: enqueued=${postRecoveryMetrics.enqueued}, flushed=${postRecoveryMetrics.flushed}, dropped=${postRecoveryMetrics.dropped}`,
  );

  // Assertions.
  const expectedDropped = Math.max(0, N_BURST - CAPACITY);
  if (burstMetrics.dropped !== expectedDropped) {
    throw new Error(
      `drop accounting failed: got ${burstMetrics.dropped}, expected ${expectedDropped}`,
    );
  }
  if (burstMetrics.enqueued !== CAPACITY) {
    throw new Error(
      `enqueue accounting failed: got ${burstMetrics.enqueued}, expected ${CAPACITY}`,
    );
  }
  if (afterDrainMetrics.flushed !== CAPACITY) {
    throw new Error(
      `drain flushed mismatch: got ${afterDrainMetrics.flushed}, expected ${CAPACITY}`,
    );
  }
  const postRecoveryDropped = postRecoveryMetrics.dropped - burstMetrics.dropped;
  if (postRecoveryDropped !== 0) {
    throw new Error(`post-recovery dropped non-zero: ${postRecoveryDropped}`);
  }
  if (postRecoveryMetrics.flushed !== CAPACITY + N_RECOVERY) {
    throw new Error(
      `post-recovery flushed mismatch: got ${postRecoveryMetrics.flushed}, expected ${CAPACITY + N_RECOVERY}`,
    );
  }
  // Verify rows actually hit the DB.
  const rowCount = (db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
  if (rowCount !== CAPACITY + N_RECOVERY) {
    throw new Error(`DB row count mismatch: got ${rowCount}, expected ${CAPACITY + N_RECOVERY}`);
  }

  const summary = {
    chaos: "audit-queue-overflow",
    n_burst: N_BURST,
    capacity: CAPACITY,
    burst_dropped: burstMetrics.dropped,
    burst_enqueued: burstMetrics.enqueued,
    drain_flushed: afterDrainMetrics.flushed,
    recovery_n: N_RECOVERY,
    post_recovery_dropped: postRecoveryDropped,
    final_db_row_count: rowCount,
    assertions: "passed",
  };
  console.log("JSON_SUMMARY: " + JSON.stringify(summary));

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
