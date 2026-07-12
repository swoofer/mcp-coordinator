import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { AuditQueue, type AuditQueueRow } from "../../src/security/audit-queue.js";
import { GENESIS_HASH } from "../../src/security/audit-chain.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import {
  audit,
  initAuditQueue,
  getAuditQueue,
  resetAuditQueue,
} from "../../src/security/audit.js";

const require = createRequire(import.meta.url);
const DatabaseCtor = require("better-sqlite3") as new (
  path: string,
  options?: { readonly?: boolean },
) => Database.Database;

// The audit_log schema mirrors src/database.ts post-v0.8 migration. We
// build a minimal in-memory DB here so AuditQueue tests stay isolated
// from the global initDatabase() side effects, but the integration
// section below uses the real getDb() path.
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

function makeRow(overrides: Partial<AuditQueueRow> = {}): AuditQueueRow {
  return {
    actor_user_id: null,
    actor_org_id: null,
    action: "test.queue.row",
    target: null,
    actor_ip: null,
    actor_user_agent: null,
    request_id: null,
    outcome: "success",
    metadata_json: null,
    ...overrides,
  };
}

interface AuditRow {
  id: number;
  action: string;
  outcome: string | null;
  metadata_json: string | null;
}

function countRows(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
}

describe("AuditQueue", () => {
  let db: Database.Database;
  let queue: AuditQueue;

  beforeEach(() => {
    db = new DatabaseCtor(":memory:");
    db.exec(AUDIT_SCHEMA);
    queue = new AuditQueue(db);
  });

  it("enqueue stores row in buffer; nothing in DB yet", () => {
    queue.enqueue(makeRow({ action: "test.buffered" }));
    expect(queue.size()).toBe(1);
    expect(countRows(db)).toBe(0);
    expect(queue.metrics.enqueued).toBe(1);
    expect(queue.metrics.flushed).toBe(0);
  });

  it("after 50 enqueues, the 50th triggers a flush", () => {
    for (let i = 0; i < 50; i++) queue.enqueue(makeRow({ action: `bulk.${i}` }));
    expect(queue.size()).toBe(0);
    expect(countRows(db)).toBe(50);
    expect(queue.metrics.flushed).toBe(50);
    expect(queue.metrics.batchesWritten).toBe(1);
  });

  it("100ms timer flushes a partial batch", () => {
    vi.useFakeTimers();
    try {
      queue.enqueue(makeRow({ action: "test.partial" }));
      queue.enqueue(makeRow({ action: "test.partial2" }));
      expect(countRows(db)).toBe(0);
      vi.advanceTimersByTime(100);
      expect(countRows(db)).toBe(2);
      expect(queue.metrics.batchesWritten).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("overflow at capacity drops rows and increments dropped counter", () => {
    // Enqueue exactly CAPACITY (10_000) — none should drop. The 10_001st drops.
    // Use a buffered queue that doesn't auto-flush: stub the prepared statement
    // to do nothing so the buffer can fill without immediate writes.
    // Easier: just push 10_001 rows and assert dropped === 1. Because every
    // 50th flushes synchronously, the buffer never reaches 10_000 — we must
    // pre-fill the internal buffer past CAPACITY without flushing.
    // Strategy: monkey-patch flush() to no-op so buffer accumulates.
    const realFlush = queue.flush.bind(queue);
    queue.flush = (): void => { /* swallow */ };
    try {
      for (let i = 0; i < 10_000; i++) queue.enqueue(makeRow());
      expect(queue.metrics.enqueued).toBe(10_000);
      expect(queue.metrics.dropped).toBe(0);
      // 10_001st: buffer is full, drop.
      queue.enqueue(makeRow());
      expect(queue.metrics.dropped).toBe(1);
      expect(queue.metrics.enqueued).toBe(10_000); // unchanged
    } finally {
      queue.flush = realFlush;
    }
  });

  it("flush() is idempotent", () => {
    queue.enqueue(makeRow({ action: "test.idem" }));
    queue.flush();
    expect(countRows(db)).toBe(1);
    // Second flush on empty buffer must not throw or write again.
    expect(() => queue.flush()).not.toThrow();
    expect(countRows(db)).toBe(1);
    expect(queue.metrics.batchesWritten).toBe(1);
  });

  it("drain() flushes pending, closes queue; post-drain enqueues fall through to sync", () => {
    queue.enqueue(makeRow({ action: "before.drain" }));
    expect(queue.isClosed()).toBe(false);
    const metrics = queue.drain();
    expect(queue.isClosed()).toBe(true);
    expect(metrics.flushed).toBe(1);
    expect(countRows(db)).toBe(1);

    // Post-drain enqueue is written sync — verify via a 2nd connection... but
    // :memory: doesn't share state across handles. Use the same handle and
    // verify the row appears synchronously.
    queue.enqueue(makeRow({ action: "after.drain" }));
    expect(countRows(db)).toBe(2);
    expect(queue.metrics.flushed).toBe(2);
  });

  it("drain() with dropped > 0 writes a system.shutdown.audit_loss row", () => {
    // Force a drop by filling the buffer past capacity (see overflow test).
    const realFlush = queue.flush.bind(queue);
    queue.flush = (): void => { /* swallow */ };
    for (let i = 0; i < 10_000; i++) queue.enqueue(makeRow());
    queue.enqueue(makeRow()); // dropped
    queue.enqueue(makeRow()); // dropped
    queue.flush = realFlush;

    expect(queue.metrics.dropped).toBe(2);
    const metrics = queue.drain();
    expect(metrics.dropped).toBe(2);

    const shutdownRow = db
      .prepare("SELECT * FROM audit_log WHERE action = ?")
      .get("system.shutdown.audit_loss") as AuditRow | undefined;
    expect(shutdownRow).toBeDefined();
    expect(shutdownRow!.outcome).toBe("failure");
    expect(JSON.parse(shutdownRow!.metadata_json!)).toEqual({ dropped_count: 2 });
  });

  it("drain() with dropped == 0 does NOT write a shutdown row", () => {
    queue.enqueue(makeRow({ action: "clean.shutdown" }));
    queue.drain();
    const shutdownRow = db
      .prepare("SELECT * FROM audit_log WHERE action = ?")
      .get("system.shutdown.audit_loss") as AuditRow | undefined;
    expect(shutdownRow).toBeUndefined();
  });

  it("drain() is idempotent — second call is a no-op", () => {
    const realFlush = queue.flush.bind(queue);
    queue.flush = (): void => { /* swallow */ };
    for (let i = 0; i < 10_000; i++) queue.enqueue(makeRow());
    queue.enqueue(makeRow()); // drop
    queue.flush = realFlush;

    queue.drain();
    queue.drain(); // second call, no-op

    const shutdownRows = db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?")
      .get("system.shutdown.audit_loss") as { n: number };
    expect(shutdownRows.n).toBe(1);
  });

  it("metrics counters are accurate across enqueue, flush, drop, batches", () => {
    // 50 rows → 1 forced batch flush (50 flushed, 1 batch)
    for (let i = 0; i < 50; i++) queue.enqueue(makeRow());
    expect(queue.metrics).toEqual({
      enqueued: 50,
      flushed: 50,
      dropped: 0,
      batchesWritten: 1,
    });
    // 3 more, manually flush → +1 batch, +3 flushed
    for (let i = 0; i < 3; i++) queue.enqueue(makeRow());
    queue.flush();
    expect(queue.metrics).toEqual({
      enqueued: 53,
      flushed: 53,
      dropped: 0,
      batchesWritten: 2,
    });
  });

  it("transaction batching: a partial-batch failure rolls back the whole batch", () => {
    // Stub insertStmt to throw on the 3rd row to prove the tx is atomic.
    // Easiest: feed the queue a row that violates outcome length via direct
    // SQL — but the schema has no constraints. Instead, sabotage the prepared
    // statement to throw on the 2nd run() call.
    const realRun = queue["insertStmt"].run.bind(queue["insertStmt"]);
    let calls = 0;
    queue["insertStmt"].run = ((...args: unknown[]) => {
      calls++;
      if (calls === 2) throw new Error("simulated mid-batch failure");
      return realRun(...args);
    }) as typeof queue["insertStmt"]["run"];

    queue.enqueue(makeRow({ action: "tx.row.1" }));
    queue.enqueue(makeRow({ action: "tx.row.2" }));
    queue.enqueue(makeRow({ action: "tx.row.3" }));
    expect(() => queue.flush()).toThrow(/simulated mid-batch failure/);
    // Atomicity: all 3 rolled back.
    expect(countRows(db)).toBe(0);
  });

  it("concurrent enqueues via Promise.all do not lose rows", async () => {
    const tasks = Array.from({ length: 200 }, (_, i) =>
      Promise.resolve().then(() => queue.enqueue(makeRow({ action: `c.${i}` }))),
    );
    await Promise.all(tasks);
    queue.flush();
    expect(countRows(db)).toBe(200);
    expect(queue.metrics.enqueued).toBe(200);
    expect(queue.metrics.flushed).toBe(200);
  });

  it("drain() swallows shutdown-row write failure without throwing", () => {
    // Force a drop, then sabotage the shutdown statement so .run() throws.
    const realFlush = queue.flush.bind(queue);
    queue.flush = (): void => { /* swallow */ };
    for (let i = 0; i < 10_000; i++) queue.enqueue(makeRow());
    queue.enqueue(makeRow()); // drop
    queue.flush = realFlush;

    queue["shutdownStmt"].run = (() => {
      throw new Error("simulated shutdown write failure");
    }) as typeof queue["shutdownStmt"]["run"];

    // Drain must NOT throw — telemetry-loss-on-telemetry-loss is logged later (T36).
    expect(() => queue.drain()).not.toThrow();
    expect(queue.isClosed()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Closed-DB robustness: a scheduled flush timer firing after the DB has
  // been closed (test teardown race, process shutdown) must NO-OP, never
  // throw or become an unhandled timer-callback exception.
  // -------------------------------------------------------------------------

  it("R1: scheduled timer flush after db.close() does not throw (was: crashed the run)", () => {
    vi.useFakeTimers();
    try {
      queue.enqueue(makeRow({ action: "test.late.timer" }));
      expect(queue.size()).toBe(1);
      db.close();
      // Before the fix, this synchronously rethrows the better-sqlite3
      // "database is not open" error out of the timer callback (fake
      // timers execute callbacks in-line), crashing the test run.
      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closed-db timer flush is a clean no-op: buffer cleared, not counted as flushed", () => {
    vi.useFakeTimers();
    try {
      queue.enqueue(makeRow({ action: "test.late.timer2" }));
      db.close();
      vi.advanceTimersByTime(100);
      expect(queue.size()).toBe(0);
      expect(queue.metrics.flushed).toBe(0);
      expect(queue.metrics.batchesWritten).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("explicit flush() on a closed db does not throw and drops the pending batch", () => {
    queue.enqueue(makeRow({ action: "test.explicit.flush" }));
    db.close();
    expect(() => queue.flush()).not.toThrow();
    expect(queue.size()).toBe(0);
    expect(queue.metrics.flushed).toBe(0);
  });

  it("R5: db closed while a batch is pending — no exception, pending rows simply not written", () => {
    for (let i = 0; i < 10; i++) queue.enqueue(makeRow({ action: `pending.${i}` }));
    expect(queue.size()).toBe(10);
    db.close();
    expect(() => queue.flush()).not.toThrow();
    expect(queue.size()).toBe(0);
    // Nothing was written (db closed before writeBatchSync could run) —
    // this is acceptable shutdown-path loss, not a correctness bug.
    expect(queue.metrics.flushed).toBe(0);
  });

  it("post-drain enqueue on a closed db does not throw (writeBatchSync's own db.open guard)", () => {
    // enqueue()'s post-drain path calls writeBatchSync() directly, bypassing
    // flush()'s own db.open guard entirely. writeBatchSync() carries its own
    // defense-in-depth guard for exactly this path — exercise it here rather
    // than via flush(), since flush() would short-circuit before reaching it.
    queue.enqueue(makeRow({ action: "before.drain" }));
    queue.drain();
    expect(queue.isClosed()).toBe(true);
    db.close();
    expect(() =>
      queue.enqueue(makeRow({ action: "after.drain.closed.db" })),
    ).not.toThrow();
    // Still counted as "flushed" by enqueue()'s post-drain contract even
    // though writeBatchSync() no-op'd — matches the pre-existing behavior
    // documented for the post-drain sync path.
    expect(queue.metrics.flushed).toBe(2);
  });

  it("drain() shutdown row falls back to GENESIS_HASH when the ledger has no prior rows", () => {
    // tip?.row_hash ?? GENESIS_HASH: the existing dropped-row drain test always
    // has prior rows in the ledger (flush() at drain time writes the buffered
    // batch first), so tipStmt.get() returns a real tip and the ?? fallback
    // is never exercised. Keep flush() permanently stubbed through drain()
    // itself so nothing is ever written before the shutdown row, forcing an
    // empty ledger and the GENESIS_HASH fallback.
    queue.flush = (): void => {
      /* swallow: buffer is never actually written, even during drain() */
    };
    for (let i = 0; i < 10_000; i++) queue.enqueue(makeRow());
    queue.enqueue(makeRow()); // dropped
    expect(queue.metrics.dropped).toBe(1);

    const metrics = queue.drain();
    expect(metrics.dropped).toBe(1);

    const shutdownRow = db
      .prepare("SELECT * FROM audit_log WHERE action = ?")
      .get("system.shutdown.audit_loss") as AuditRow | undefined;
    expect(shutdownRow).toBeDefined();
    expect(shutdownRow!.metadata_json && JSON.parse(shutdownRow!.metadata_json)).toEqual({
      dropped_count: 1,
    });
    const fullRow = db
      .prepare("SELECT prev_hash FROM audit_log WHERE action = ?")
      .get("system.shutdown.audit_loss") as { prev_hash: string };
    expect(fullRow.prev_hash).toBe(GENESIS_HASH);
  });

  it("scheduled timer flush swallows an unexpected flush() error without rethrowing", () => {
    // The db.open guard in flush()/writeBatchSync() handles the common closed-db
    // race, but scheduleFlush()'s try/catch is the last line of defense for
    // anything else that goes wrong on the unattended timer path. Force flush()
    // to throw something other than the guarded case to exercise that catch.
    vi.useFakeTimers();
    const realFlush = queue.flush.bind(queue);
    try {
      queue.enqueue(makeRow({ action: "test.timer.unexpected.error" }));
      expect(queue.size()).toBe(1);
      queue.flush = (): void => {
        throw new Error("simulated unexpected flush failure");
      };
      // Before this test, an error thrown inside the timer callback would
      // propagate as an unhandled exception (fake timers run callbacks inline).
      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    } finally {
      queue.flush = realFlush;
      vi.useRealTimers();
    }
  });

  it("R3/R5: normal flush on an open db still writes correctly with an intact hash chain", () => {
    queue.enqueue(makeRow({ action: "normal.1" }));
    queue.enqueue(makeRow({ action: "normal.2" }));
    queue.flush();
    expect(countRows(db)).toBe(2);
    expect(queue.metrics.flushed).toBe(2);
    const rows = db
      .prepare("SELECT prev_hash, row_hash FROM audit_log ORDER BY id ASC")
      .all() as { prev_hash: string; row_hash: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].prev_hash).toBe(GENESIS_HASH);
    expect(rows[1].prev_hash).toBe(rows[0].row_hash);
    expect(rows[0].row_hash).not.toBe(rows[1].row_hash);
  });
});

// ---------------------------------------------------------------------------
// audit() routing integration: Tier 1 sync, Tier 2 queue, Tier 2 fallback
// ---------------------------------------------------------------------------

const DIR = "data-test-audit-queue-routing";

describe("audit() routing integration", () => {
  beforeAll(() => {
    fs.mkdirSync(DIR, { recursive: true });
    initDatabase(DIR);
  });
  beforeEach(() => {
    getDb().exec("DELETE FROM audit_log");
    resetAuditQueue();
  });
  afterAll(() => {
    resetAuditQueue();
    closeDb();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it("initAuditQueue() returns a queue accessible via getAuditQueue()", () => {
    const q = initAuditQueue(getDb() as unknown as Database.Database);
    expect(q).toBeInstanceOf(AuditQueue);
    expect(getAuditQueue()).toBe(q);
  });

  it("Tier 2 routes to queue when initialized; row in buffer, not yet in DB", () => {
    const q = initAuditQueue(getDb() as unknown as Database.Database);
    audit("test.tier2.routed", { tier: 2 });
    expect(q.size()).toBe(1);
    // Read via the same connection (better-sqlite3 sees its own pending statements,
    // but the row was never INSERTed yet). Use a 2nd connection to be sure.
    const reader = new DatabaseCtor(path.join(DIR, "coordinator.db"), { readonly: true });
    try {
      const rows = reader
        .prepare("SELECT * FROM audit_log WHERE action = ?")
        .all("test.tier2.routed") as AuditRow[];
      expect(rows).toHaveLength(0);
    } finally {
      reader.close();
    }
    q.flush();
    const rows2 = getDb()
      .prepare("SELECT * FROM audit_log WHERE action = ?")
      .all("test.tier2.routed") as AuditRow[];
    expect(rows2).toHaveLength(1);
  });

  it("Tier 1 bypasses the queue even when one is initialized", () => {
    const q = initAuditQueue(getDb() as unknown as Database.Database);
    audit("test.tier1.bypass", { tier: 1 });
    expect(q.size()).toBe(0);
    const rows = getDb()
      .prepare("SELECT * FROM audit_log WHERE action = ?")
      .all("test.tier1.bypass") as AuditRow[];
    expect(rows).toHaveLength(1);
  });

  it("without initAuditQueue, Tier 2 falls back to sync direct INSERT", () => {
    // resetAuditQueue() already cleared singleton in beforeEach.
    expect(getAuditQueue()).toBeNull();
    audit("test.tier2.fallback", { tier: 2 });
    const rows = getDb()
      .prepare("SELECT * FROM audit_log WHERE action = ?")
      .all("test.tier2.fallback") as AuditRow[];
    expect(rows).toHaveLength(1);
  });

  it("resetAuditQueue() clears the singleton", () => {
    initAuditQueue(getDb() as unknown as Database.Database);
    expect(getAuditQueue()).not.toBeNull();
    resetAuditQueue();
    expect(getAuditQueue()).toBeNull();
  });
});
