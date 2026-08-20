import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { AuditQueue } from "../../src/security/audit-queue.js";
import { emitDuplicatesAcceptedAudit } from "../../src/boot-orgs-uniqueness.js";
import type { DatabaseAdapter } from "../../src/db-adapter.js";

/**
 * #317 made the Tier 1 chained insert atomic: reading the chain tip and
 * inserting the new row as two implicit transactions lets a second writer
 * observe the same tip and fork the chain that audit-chain.ts exists to make
 * verifiable. Within one process the synchronous driver hides it; a second
 * PROCESS reaches it — cli/encryption/migrate.ts opens the same database.
 *
 * Two sites were missed at the time, found while mapping the chain for #348:
 *
 *   - AuditQueue.drain()'s system.shutdown.audit_loss row. Its sibling, the
 *     batch flush, has always been transactional.
 *   - emitDuplicatesAcceptedAudit, which runs from initDatabase at boot —
 *     precisely when a second process is most likely to be writing too.
 *
 * These tests assert the ORDER of driver calls rather than the source text: a
 * tip read that happens before any transaction is opened is the defect,
 * whatever it looks like in the file.
 */

/** Records whether each prepared statement ran inside an open transaction. */
function spyAdapter() {
  const calls: Array<{ sql: string; inTransaction: boolean }> = [];
  let depth = 0;

  const statement = (sql: string) => ({
    get: () => {
      calls.push({ sql, inTransaction: depth > 0 });
      return undefined;
    },
    all: () => {
      calls.push({ sql, inTransaction: depth > 0 });
      return [];
    },
    run: () => {
      calls.push({ sql, inTransaction: depth > 0 });
      return { changes: 1, lastInsertRowid: 1 };
    },
  });

  const db = {
    prepare: (sql: string) => statement(sql),
    transaction: (fn: (...args: unknown[]) => unknown) => {
      const wrapped = (...args: unknown[]) => {
        depth++;
        try {
          return fn(...args);
        } finally {
          depth--;
        }
      };
      // better-sqlite3 exposes .immediate/.deferred on the returned function.
      (wrapped as unknown as { immediate: unknown }).immediate = wrapped;
      return wrapped;
    },
  } as unknown as DatabaseAdapter;

  return { db, calls };
}

/**
 * Force the queue to record drops.
 *
 * enqueue() flushes at BATCH_SIZE (50) and only drops once the buffer
 * reaches CAPACITY (10 000), so a synchronous enqueue loop drains itself and
 * never drops. Neutralising flush lets the buffer fill. It stays neutralised
 * through drain(): the subject here is the shutdown row, not the batch, and
 * writing 10 000 buffered rows would only make the test slow.
 */
function overflow(queue: AuditQueue): void {
  (queue as unknown as { flush: () => void }).flush = () => {};
  for (let i = 0; i < 10_050; i++) {
    queue.enqueue({
      action: "auth.login.success",
      actor_org_id: null,
      actor_ip: null,
      actor_user_agent: null,
      actor_user_id: null,
      metadata_json: null,
      outcome: "success",
      request_id: null,
      target: null,
    });
  }
}

const isTipRead = (sql: string) => sql.includes("SELECT row_hash FROM audit_log");
const isAuditInsert = (sql: string) => sql.includes("INSERT INTO audit_log");

describe("every chained audit insert reads its tip inside a transaction", () => {
  it("emitDuplicatesAcceptedAudit: tip read and insert are both transactional", () => {
    const { db, calls } = spyAdapter();
    emitDuplicatesAcceptedAudit(db, {
      duplicates: [{ name: "acme", n: 2, ids: "a,b" }],
      totalDuplicateRows: 2,
    });

    const tip = calls.find((c) => isTipRead(c.sql));
    const insert = calls.find((c) => isAuditInsert(c.sql));
    expect(tip, "no tip read happened at all").toBeDefined();
    expect(insert, "no audit row was inserted").toBeDefined();
    // The read is the half that was outside. If it is, a concurrent writer
    // can hand two rows the same prev_hash.
    expect(tip!.inTransaction, "tip read is outside any transaction").toBe(true);
    expect(insert!.inTransaction, "insert is outside any transaction").toBe(true);
  });

  it("AuditQueue.drain: the shutdown row is written atomically", () => {
    // A real in-memory DB so the queue's constructor-time prepares succeed,
    // wrapped so we can observe transaction depth at call time.
    const real = new Database(":memory:");
    real.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT, actor_org_id TEXT, action TEXT NOT NULL, target TEXT,
        actor_ip TEXT, actor_user_agent TEXT, request_id TEXT, outcome TEXT,
        metadata_json TEXT, prev_hash TEXT, row_hash TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const calls: Array<{ sql: string; inTransaction: boolean }> = [];
    let depth = 0;
    const wrap = (sql: string, stmt: Database.Statement) =>
      new Proxy(stmt, {
        get(target, prop) {
          if (prop === "get" || prop === "run" || prop === "all") {
            return (...args: unknown[]) => {
              calls.push({ sql, inTransaction: depth > 0 });
              return (target[prop as "get"] as (...a: unknown[]) => unknown)(...args);
            };
          }
          return Reflect.get(target, prop);
        },
      });

    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => wrap(sql, target.prepare(sql));
        }
        if (prop === "transaction") {
          return (fn: (...a: unknown[]) => unknown) => {
            const inner = target.transaction((...a: unknown[]) => {
              depth++;
              try {
                return fn(...a);
              } finally {
                depth--;
              }
            });
            return inner;
          };
        }
        return Reflect.get(target, prop);
      },
    });

    const queue = new AuditQueue(db as unknown as Database.Database);
    overflow(queue);
    const metrics = queue.drain();
    expect(metrics.dropped, "queue never overflowed — test proves nothing").toBeGreaterThan(0);

    const shutdownWrite = calls.filter((c) => isAuditInsert(c.sql)).at(-1);
    const tipRead = calls.filter((c) => isTipRead(c.sql)).at(-1);
    expect(tipRead, "no tip read happened at all").toBeDefined();
    expect(shutdownWrite, "no shutdown row was written").toBeDefined();
    expect(tipRead!.inTransaction, "shutdown tip read is outside any transaction").toBe(true);
    expect(shutdownWrite!.inTransaction, "shutdown insert is outside any transaction").toBe(true);

    real.close();
  });

  it("the shutdown row still lands, and chains", () => {
    // Atomicity must not have cost the write itself.
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT, actor_org_id TEXT, action TEXT NOT NULL, target TEXT,
        actor_ip TEXT, actor_user_agent TEXT, request_id TEXT, outcome TEXT,
        metadata_json TEXT, prev_hash TEXT, row_hash TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const queue = new AuditQueue(db);
    overflow(queue);
    queue.drain();

    const row = db
      .prepare(
        "SELECT prev_hash, row_hash FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1",
      )
      .get("system.shutdown.audit_loss") as { prev_hash: string; row_hash: string } | undefined;
    expect(row, "shutdown row missing").toBeDefined();
    expect(row!.prev_hash).toMatch(/^[0-9a-f:a-z-]+$/);
    expect(row!.row_hash).not.toBe(row!.prev_hash);
    db.close();
  });
});
