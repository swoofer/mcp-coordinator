import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { AuditQueue, type AuditQueueRow } from "../../src/security/audit-queue.js";
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
