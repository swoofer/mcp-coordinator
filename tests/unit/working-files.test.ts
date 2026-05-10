import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { WorkingFilesTracker } from "../../src/working-files-tracker.js";

const TEST_DIR = mkdtempSync(path.join(tmpdir(), "wf-"));

describe("WorkingFilesTracker", () => {
  let tracker: WorkingFilesTracker;

  beforeEach(() => {
    initDatabase(TEST_DIR);
    getDb().exec("DELETE FROM working_files");
    tracker = new WorkingFilesTracker();
  });

  afterAll(() => { closeDb(); rmSync(TEST_DIR, { recursive: true, force: true }); });

  it("start inserts a row with claim_until ~30min in the future", () => {
    tracker.start("agentA", "src/foo.ts", 30);
    const row = getDb().prepare("SELECT * FROM working_files WHERE agent_id=?").get("agentA") as any;
    expect(row.file_path).toBe("src/foo.ts");
    const until = new Date(row.claim_until).getTime();
    expect(until - Date.now()).toBeGreaterThan(29 * 60 * 1000);
    expect(until - Date.now()).toBeLessThan(31 * 60 * 1000);
  });

  it("start is idempotent (UPSERT on duplicate)", () => {
    tracker.start("agentA", "src/foo.ts", 30);
    tracker.start("agentA", "src/foo.ts", 30);
    const count = (getDb().prepare("SELECT COUNT(*) AS c FROM working_files").get() as any).c;
    expect(count).toBe(1);
  });

  it("stop deletes the matching row", () => {
    tracker.start("agentA", "src/foo.ts", 30);
    tracker.stop("agentA", "src/foo.ts");
    const count = (getDb().prepare("SELECT COUNT(*) AS c FROM working_files").get() as any).c;
    expect(count).toBe(0);
  });

  it("stop is a no-op when no row matches", () => {
    expect(() => tracker.stop("ghost", "nope.ts")).not.toThrow();
  });

  it("sweepExpired deletes rows past claim_until", () => {
    getDb().prepare(
      `INSERT INTO working_files (agent_id, file_path, started_at, last_activity_at, claim_until)
       VALUES (?, ?, datetime('now'), datetime('now'), datetime('now', '-1 minute'))`
    ).run("agentA", "src/old.ts");
    const evicted = tracker.sweepExpired();
    expect(evicted).toBe(1);
    const count = (getDb().prepare("SELECT COUNT(*) AS c FROM working_files").get() as any).c;
    expect(count).toBe(0);
  });

  it("clearForAgent deletes all rows for an offline agent", () => {
    tracker.start("agentA", "src/x.ts", 30);
    tracker.start("agentA", "src/y.ts", 30);
    tracker.start("agentB", "src/z.ts", 30);
    const cleared = tracker.clearForAgent("agentA");
    expect(cleared).toBe(2);
    const remaining = getDb().prepare("SELECT agent_id FROM working_files").all() as any[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].agent_id).toBe("agentB");
  });

  it("getIndex returns file→agents map, excluding caller and expired", () => {
    // alice and bob both work on src/foo.ts; carol on src/bar.ts
    tracker.start("alice", "src/foo.ts", 30);
    tracker.start("bob",   "src/foo.ts", 30);
    tracker.start("carol", "src/bar.ts", 30);
    // expired row for dave on src/foo.ts
    getDb().prepare(
      `INSERT INTO working_files (agent_id, file_path, started_at, last_activity_at, claim_until)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minute'))`
    ).run("dave", "src/foo.ts");

    const idx = tracker.getIndex(["src/foo.ts", "src/bar.ts"], "alice");
    expect(idx.get("src/foo.ts")?.has("bob")).toBe(true);
    expect(idx.get("src/foo.ts")?.has("alice")).toBe(false);  // caller excluded
    expect(idx.get("src/foo.ts")?.has("dave")).toBe(false);   // expired excluded
    expect(idx.get("src/bar.ts")?.has("carol")).toBe(true);

    const empty = tracker.getIndex([], "alice");
    expect(empty.size).toBe(0);
  });

  it("sweepExpired correctly evicts rows inserted via start()", () => {
    // This test ensures sweepExpired's comparison format matches start()'s storage format.
    // Bug: if storage uses ISO-with-Z and comparison uses datetime() space-format, expired rows
    // are not swept because lexicographic 'T' > ' '.
    tracker.start("agentA", "src/recent.ts", 30);
    // Force expiry by manually advancing the row's claim_until to the past, in the same format start() uses
    getDb().prepare(
      "UPDATE working_files SET claim_until = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minute') WHERE agent_id = 'agentA'"
    ).run();
    const evicted = tracker.sweepExpired();
    expect(evicted).toBe(1);
  });
});
