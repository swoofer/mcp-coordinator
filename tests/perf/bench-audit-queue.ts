/* eslint-disable no-console */
/**
 * T33 perf bench — Tier 2 audit queue throughput + drop accounting.
 *
 * Scenario A (normal load): 10K emissions, paced under capacity.
 *   Expected: 0 drops; batched flushes account for all rows.
 * Scenario B (burst): 20K emissions in a tight synchronous loop with no
 *   yield between calls. Buffer caps at CAPACITY=10000; excess increments
 *   the dropped counter while the caller is unaffected.
 *
 * Measures:
 *   - enqueue() per-call latency (should stay sub-microsecond on fast path)
 *   - drain() time for normal-load scenario
 *   - drop_count for burst scenario
 *
 * In-memory better-sqlite3 — no boot side effects.
 */
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { AuditQueue, type AuditQueueRow } from "../../src/security/audit-queue.js";

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
    prev_hash       TEXT,
    row_hash        TEXT,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

function makeRow(i: number): AuditQueueRow {
  return {
    actor_user_id: "u-perf",
    actor_org_id: "org-perf",
    action: "perf.audit.tier2",
    target: null,
    actor_ip: "127.0.0.1",
    actor_user_agent: "perf-bench/1.0",
    request_id: `req-${i}`,
    outcome: "success",
    metadata_json: JSON.stringify({ i }),
  };
}

async function scenarioA(n: number): Promise<{
  enqueue_ns_p50: number;
  enqueue_ns_p99: number;
  drain_ms: number;
  enqueued: number;
  flushed: number;
  dropped: number;
  batches: number;
}> {
  const db = new DatabaseCtor(":memory:");
  db.exec(AUDIT_SCHEMA);
  const q = new AuditQueue(db);

  const lat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const start = process.hrtime.bigint();
    q.enqueue(makeRow(i));
    const dt = Number(process.hrtime.bigint() - start);
    lat[i] = dt;
  }
  const drainStart = performance.now();
  const metrics = q.drain(5000);
  const drainMs = performance.now() - drainStart;

  const sorted = Array.from(lat).sort((a, b) => a - b);
  db.close();
  return {
    enqueue_ns_p50: sorted[Math.floor(n * 0.5)]!,
    enqueue_ns_p99: sorted[Math.floor(n * 0.99)]!,
    drain_ms: drainMs,
    enqueued: metrics.enqueued,
    flushed: metrics.flushed,
    dropped: metrics.dropped,
    batches: metrics.batchesWritten,
  };
}

async function scenarioB(n: number): Promise<{
  enqueued: number;
  flushed: number;
  dropped: number;
  batches: number;
  total_ms: number;
}> {
  const db = new DatabaseCtor(":memory:");
  db.exec(AUDIT_SCHEMA);
  const q = new AuditQueue(db);

  // Tight loop with no async yield. The queue's BATCH_SIZE=50 internal
  // flush still runs (sync, since better-sqlite3 is sync) so the buffer
  // ping-pongs near full as flushes drain it; whether drops occur depends
  // on whether sync flush throughput beats the synchronous enqueue rate.
  // Either way, the metrics account for what actually happened.
  const start = performance.now();
  for (let i = 0; i < n; i++) q.enqueue(makeRow(i));
  const totalMs = performance.now() - start;
  const metrics = q.drain(5000);
  db.close();
  return {
    enqueued: metrics.enqueued,
    flushed: metrics.flushed,
    dropped: metrics.dropped,
    batches: metrics.batchesWritten,
    total_ms: totalMs,
  };
}

async function main(): Promise<void> {
  const N_NORMAL = parseInt(process.env.BENCH_N_NORMAL ?? "10000", 10);
  const N_BURST = parseInt(process.env.BENCH_N_BURST ?? "20000", 10);

  const a = await scenarioA(N_NORMAL);
  const b = await scenarioB(N_BURST);

  console.log("\naudit-queue (scenario A: normal load):");
  console.log(`  N=${N_NORMAL}`);
  console.log(
    `  enqueue p50=${a.enqueue_ns_p50.toFixed(0)}ns, p99=${a.enqueue_ns_p99.toFixed(0)}ns`,
  );
  console.log(`  drain=${a.drain_ms.toFixed(1)}ms, batches=${a.batches}`);
  console.log(`  enqueued=${a.enqueued}, flushed=${a.flushed}, dropped=${a.dropped}`);

  console.log("\naudit-queue (scenario B: burst):");
  console.log(`  N=${N_BURST}, total=${b.total_ms.toFixed(1)}ms`);
  console.log(
    `  enqueued=${b.enqueued}, flushed=${b.flushed}, dropped=${b.dropped}, batches=${b.batches}`,
  );

  const summary = {
    bench: "audit-queue",
    normal: {
      n: N_NORMAL,
      enqueue_ns_p50: Number(a.enqueue_ns_p50.toFixed(0)),
      enqueue_ns_p99: Number(a.enqueue_ns_p99.toFixed(0)),
      drain_ms: Number(a.drain_ms.toFixed(3)),
      enqueued: a.enqueued,
      flushed: a.flushed,
      dropped: a.dropped,
      batches: a.batches,
    },
    burst: {
      n: N_BURST,
      total_ms: Number(b.total_ms.toFixed(3)),
      enqueued: b.enqueued,
      flushed: b.flushed,
      dropped: b.dropped,
      batches: b.batches,
    },
  };
  console.log("JSON_SUMMARY: " + JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
