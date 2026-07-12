// tests/unit/sse-event-bound.test.ts
//
// performance-02 — bound event history load at the SQL layer.
//
// Before the fix, handleSse's no-Last-Event-ID branch did
// `getEventsSince(orgId, 0).slice(-50)`: SQLite returns EVERY row for the
// org (`SELECT * ... ORDER BY id`, no LIMIT), and JS trims to the last 50
// afterwards. At scale (200K events) that's a full synchronous table scan +
// materialization per SSE connection. These tests prove the SQL layer now
// bounds the result set itself — SseEmitter never materializes more rows
// than requested, in either the "most recent N" path or the Last-Event-ID
// resumption path (which is capped so an old id can't force a full reload).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { SseEmitter } from "../../src/sse-emitter.js";
import fs from "fs";

const TEST_DIR = "data-test-sse-event-bound";
let emitter: SseEmitter;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM events");
  emitter = new SseEmitter();
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/**
 * Insert `count` events directly (bypassing SseEmitter.emit's setImmediate
 * fan-out, which we don't need here) inside a single transaction for speed.
 * Payload encodes the insertion index so tests can assert exact ordering.
 */
function seedEvents(count: number): void {
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO events (org_id, type, payload) VALUES (?, ?, ?)",
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run("default", "agent_online", JSON.stringify({ seq: i }));
    }
  });
  tx();
}

function seqOf(event: { payload: string }): number {
  return JSON.parse(event.payload).seq;
}

describe("SseEmitter — SQL-bounded recent events (performance-02)", () => {
  // R1: characterize today's ordering contract for getEventsSince(orgId, 0)
  // with no limit — it still returns everything (that's the documented
  // legacy behavior for the no-limit overload), which is exactly why the
  // no-Last-Event-ID callsite must NOT use this form anymore.
  it("getEventsSince(orgId, 0) with no limit returns ALL rows (the bug's root cause)", () => {
    seedEvents(500);
    const all = emitter.getEventsSince("default", 0);
    expect(all).toHaveLength(500);
  });

  // R3: the bounded method never returns more than `limit` rows.
  it("getRecentEvents bounds the SQL result set to `limit`, not total history", () => {
    seedEvents(500);
    const recent = emitter.getRecentEvents("default", 50);
    expect(recent).toHaveLength(50);
  });

  // R3: those 50 rows are the LAST 50 in chronological (ascending id) order —
  // i.e. functionally identical to the old getEventsSince(0).slice(-50).
  it("getRecentEvents returns the last N events in chronological order", () => {
    seedEvents(500);
    const recent = emitter.getRecentEvents("default", 50);
    const seqs = recent.map(seqOf);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => 450 + i));
    // strictly ascending id order
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i].id!).toBeGreaterThan(recent[i - 1].id!);
    }
  });

  // Equivalence check: getRecentEvents(orgId, 50) must match the OLD
  // behavior (getEventsSince(orgId, 0).slice(-50)) exactly, event-for-event.
  it("matches the legacy getEventsSince(0).slice(-50) result exactly", () => {
    seedEvents(237); // an count that isn't a round multiple of 50
    const legacy = emitter.getEventsSince("default", 0).slice(-50);
    const bounded = emitter.getRecentEvents("default", 50);
    expect(bounded.map((e) => e.id)).toEqual(legacy.map((e) => e.id));
    expect(bounded.map(seqOf)).toEqual(legacy.map(seqOf));
  });

  // R5: fewer events than the limit — returns min(limit, total), never pads
  // or errors.
  it("returns fewer than `limit` rows when history is smaller than the limit", () => {
    seedEvents(1);
    expect(emitter.getRecentEvents("default", 50)).toHaveLength(1);
  });

  // R5: zero events.
  it("returns an empty array when there is no history", () => {
    expect(emitter.getRecentEvents("default", 50)).toEqual([]);
  });

  // R5: exactly at the limit.
  it("returns exactly `limit` rows when total equals the limit", () => {
    seedEvents(50);
    expect(emitter.getRecentEvents("default", 50)).toHaveLength(50);
  });

  // getEventsSince with a limit: resumption path bound.
  it("getEventsSince with a limit caps the resumption read (oldest-first within the cap)", () => {
    seedEvents(500);
    const all = emitter.getEventsSince("default", 0);
    const firstId = all[0].id!;
    const capped = emitter.getEventsSince("default", firstId - 1, 100);
    expect(capped).toHaveLength(100);
    expect(capped.map(seqOf)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  // R5: Last-Event-ID past the end of history returns 0 rows, not an error.
  it("getEventsSince beyond the last id returns an empty array", () => {
    seedEvents(500);
    const all = emitter.getEventsSince("default", 0);
    const lastId = all[all.length - 1].id!;
    expect(emitter.getEventsSince("default", lastId, 1000)).toEqual([]);
    expect(emitter.getEventsSince("default", lastId + 999)).toEqual([]);
  });

  // R5: a very old Last-Event-ID is capped, not fully loaded.
  it("getEventsSince from a very old id with a cap never returns more than the cap", () => {
    seedEvents(5000);
    const capped = emitter.getEventsSince("default", 0, 1000);
    expect(capped).toHaveLength(1000);
    expect(capped.map(seqOf)[0]).toBe(0);
    expect(capped.map(seqOf)[999]).toBe(999);
  });

  // Org isolation still holds under the bounded query.
  it("getRecentEvents only returns events for the requested org", () => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)").run("org-x", "org-x");
    emitter.emit("agent_online", { agent_id: "a1" }, { org_id: "default" });
    emitter.emit("agent_online", { agent_id: "a2" }, { org_id: "org-x" });
    const recent = emitter.getRecentEvents("default", 50);
    expect(recent).toHaveLength(1);
    expect(JSON.parse(recent[0].payload).agent_id).toBe("a1");
  });
});
