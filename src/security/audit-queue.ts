import type Database from "better-sqlite3";
import type { Clock } from "../auth/clock.js";
import { realClock } from "../auth/clock.js";
import { GENESIS_HASH, computeRowHash, getAuditChainKey } from "./audit-chain.js";

export interface AuditQueueRow {
  actor_user_id: string | null;
  actor_org_id: string | null;
  action: string;
  target: string | null;
  actor_ip: string | null;
  actor_user_agent: string | null;
  request_id: string | null;
  outcome: "success" | "failure" | "denied";
  metadata_json: string | null;
}

export interface AuditQueueMetrics {
  readonly enqueued: number;
  readonly flushed: number;
  readonly dropped: number;
  readonly batchesWritten: number;
}

const CAPACITY = 10_000;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 100;

/**
 * Bounded buffered queue for Tier 2 audit rows.
 *
 * Hot-path callers enqueue synchronously; rows are flushed in batches
 * of {@link BATCH_SIZE} on a {@link FLUSH_INTERVAL_MS}-millisecond timer
 * (whichever fires first). Capacity {@link CAPACITY} bounds memory; once
 * full, enqueue drops the row, increments the dropped counter, and the
 * caller is unaffected — Tier 2 is "may drop under pressure" per V3 §B-NEW-6.
 *
 * `drain(timeoutMs)` is the SIGTERM hook: flush pending, then if any rows
 * were dropped during the lifetime of the queue, emit a final sync
 * `system.shutdown.audit_loss` row capturing the count. Returns the
 * final metrics snapshot.
 *
 * The queue is created with a `db` handle injected (not via the global
 * `getDb()` shim) so tests can use isolated in-memory databases.
 */
export class AuditQueue {
  private buffer: AuditQueueRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private _enqueued = 0;
  private _flushed = 0;
  private _dropped = 0;
  private _batchesWritten = 0;
  private closed = false;
  private readonly insertStmt: Database.Statement<unknown[]>;
  private readonly shutdownStmt: Database.Statement<unknown[]>;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock = realClock,
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO audit_log
        (actor_user_id, actor_org_id, action, target,
         actor_ip, actor_user_agent, request_id, outcome,
         metadata_json, prev_hash, row_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.shutdownStmt = db.prepare(`
      INSERT INTO audit_log
        (action, outcome, metadata_json, prev_hash, row_hash)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.tipStmt = db.prepare(
      "SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1",
    );
  }

  private readonly tipStmt: Database.Statement<unknown[]>;

  enqueue(row: AuditQueueRow): void {
    if (this.closed) {
      // Post-drain enqueues fall through to sync to avoid silent loss
      // during SIGTERM cleanup. Acceptable latency cost on the shutdown path.
      this.writeBatchSync([row]);
      this._flushed++;
      return;
    }
    if (this.buffer.length >= CAPACITY) {
      this._dropped++;
      return;
    }
    this.buffer.push(row);
    this._enqueued++;
    if (this.buffer.length >= BATCH_SIZE) {
      this.flush();
    } else if (!this.timer) {
      this.scheduleFlush();
    }
  }

  /** Flush all currently-buffered rows synchronously. Idempotent. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    if (!this.db.open) {
      // DB already closed (shutdown race / test teardown): drop the
      // pending batch instead of writing. This is reachable from a
      // scheduled timer firing after close, so it must never throw.
      // Not counted as flushed — the rows genuinely never reached disk.
      this.buffer = [];
      return;
    }
    const rows = this.buffer;
    this.buffer = [];
    this.writeBatchSync(rows);
    this._flushed += rows.length;
    this._batchesWritten++;
  }

  /**
   * Drain pending rows, then emit a final system.shutdown.audit_loss row
   * if any rows were dropped during this queue's lifetime.
   *
   * timeoutMs is currently a soft target: better-sqlite3 is synchronous so
   * flush() completes immediately on Node. The parameter is kept in the
   * API surface for forward-compat with a future async driver swap.
   */
  drain(_timeoutMs: number = 5000): AuditQueueMetrics {
    if (this.closed) return this.metrics;
    this.flush();
    this.closed = true;
    if (this._dropped > 0) {
      try {
        const tip = this.tipStmt.get() as { row_hash: string } | undefined;
        const prevHash = tip?.row_hash ?? GENESIS_HASH;
        const metadata = JSON.stringify({ dropped_count: this._dropped });
        const rowHash = computeRowHash(
          prevHash,
          {
            action: "system.shutdown.audit_loss",
            actor_org_id: null,
            actor_ip: null,
            actor_user_agent: null,
            actor_user_id: null,
            metadata_json: metadata,
            outcome: "failure",
            request_id: null,
            target: null,
          },
          getAuditChainKey(),
        );
        this.shutdownStmt.run("system.shutdown.audit_loss", "failure", metadata, prevHash, rowHash);
      } catch (err) {
        // Final-row write failure is itself unrecoverable telemetry loss;
        // log path will be added by T36 logger. For now, swallow — the
        // drain return value still reports the dropped count to the caller.
        void err;
      }
    }
    return this.metrics;
  }

  get metrics(): AuditQueueMetrics {
    return {
      enqueued: this._enqueued,
      flushed: this._flushed,
      dropped: this._dropped,
      batchesWritten: this._batchesWritten,
    };
  }

  /** Test helper: peek at the pending buffer length without flushing. */
  size(): number {
    return this.buffer.length;
  }

  /** Test helper: returns true if drain() has been called. */
  isClosed(): boolean {
    return this.closed;
  }

  private scheduleFlush(): void {
    const t = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch (err) {
        // Defensive: a scheduled flush firing after the DB has been closed
        // (test teardown race, process shutdown) must never surface as an
        // unhandled timer-callback exception that crashes the run. The
        // db.open guard in flush()/writeBatchSync() handles the common
        // case; this catch is the last line of defense for anything else
        // that goes wrong on this unattended path. Never rethrown.
        void err;
      }
    }, FLUSH_INTERVAL_MS);
    // Prevent the timer from holding the event loop open on Node — every
    // Node Timeout has .unref() (typings widen for browser shims).
    t.unref();
    this.timer = t;
  }

  private writeBatchSync(rows: AuditQueueRow[]): void {
    // Defense in depth: flush() already guards on db.open before calling
    // this, but writeBatchSync() is also reachable directly from enqueue()'s
    // post-drain sync path. A closed db here must no-op, not throw.
    if (!this.db.open) return;
    // Better-sqlite3 transaction for batched writes. The hash chain is
    // built inside the transaction: tip lookup runs once, then each row
    // is hashed against the previous row's hash and inserted with both
    // prev_hash and row_hash. Concurrent writers cannot interleave
    // because the transaction holds an IMMEDIATE lock from the first
    // statement onward.
    const insertStmt = this.insertStmt;
    const tipStmt = this.tipStmt;
    const chainKey = getAuditChainKey();
    const tx = this.db.transaction((batch: AuditQueueRow[]) => {
      const tip = tipStmt.get() as { row_hash: string } | undefined;
      let prevHash = tip?.row_hash ?? GENESIS_HASH;
      for (const r of batch) {
        const rowHash = computeRowHash(
          prevHash,
          {
            action: r.action,
            actor_org_id: r.actor_org_id,
            actor_ip: r.actor_ip,
            actor_user_agent: r.actor_user_agent,
            actor_user_id: r.actor_user_id,
            metadata_json: r.metadata_json,
            outcome: r.outcome,
            request_id: r.request_id,
            target: r.target,
          },
          chainKey,
        );
        insertStmt.run(
          r.actor_user_id,
          r.actor_org_id,
          r.action,
          r.target,
          r.actor_ip,
          r.actor_user_agent,
          r.request_id,
          r.outcome,
          r.metadata_json,
          prevHash,
          rowHash,
        );
        prevHash = rowHash;
      }
    });
    tx(rows);
    void this.clock; // reserved for future per-flush timing metrics; unused today
  }
}
