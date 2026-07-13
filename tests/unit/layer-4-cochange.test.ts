import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, promises as fsp } from "fs";
import { tmpdir } from "os";
import path from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { FileTracker } from "../../src/file-tracker.js";
import { ImpactScorer } from "../../src/impact-scorer.js";

const TEST_DIR = mkdtempSync(path.join(tmpdir(), "l4-"));

describe("Layer 4 git_cochange lookup", () => {
  let registry: AgentRegistry, fileTracker: FileTracker, scorer: ImpactScorer;
  beforeEach(() => {
    // Close any previous connection before re-init: initDatabase() reassigns the
    // module-level db without closing the old handle, which on Windows leaks
    // handles to the same .db file and causes EBUSY on rmSync in afterAll.
    try {
      closeDb();
    } catch {
      /* nothing to close yet */
    }
    initDatabase(TEST_DIR);
    const db = getDb();
    db.exec("DELETE FROM agents; DELETE FROM file_activity; DELETE FROM git_cochange;");
    // Seed a co-change ratio of 0.6 between a.ts and b.ts
    db.prepare(
      "INSERT INTO git_cochange (file_a, file_b, count, total_commits, computed_at) VALUES (?,?,?,?, datetime('now'))",
    ).run("a.ts", "b.ts", 3, 5);
    registry = new AgentRegistry();
    fileTracker = new FileTracker();
    scorer = new ImpactScorer(registry, fileTracker);
    registry.register("default", "alice", "A", []);
    registry.register("default", "bob", "B", []);
    registry.setOnline("default", "alice");
    registry.setOnline("default", "bob");
    // Bob recently edited b.ts
    fileTracker.log({
      org_id: "default",
      session_id: "s",
      agent_id: "bob",
      tool_name: "Edit",
      file_path: "b.ts",
    });
  });
  afterAll(async () => {
    try {
      closeDb();
    } catch {
      /* already closed */
    }
    // Windows can hold .db handles for many seconds after better-sqlite3 close()
    // (Defender / indexer / WAL teardown). Retry generously so cleanup wins
    // once the OS releases the file.
    await fsp.rm(TEST_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 750 });
  }, 30000);

  it("scores 60 when ratio > 0.5 (alice→a.ts, bob touched b.ts which co-changes 0.6)", () => {
    const scores = scorer.score({
      org_id: "default",
      agent_id: "alice",
      target_modules: [],
      target_files: ["a.ts"],
    });
    const bob = scores.find((s) => s.agent_id === "bob")!;
    expect(bob.score).toBeGreaterThanOrEqual(60);
    expect(bob.reasons.join(" ")).toMatch(/co-change/i);
  });

  it("canonical lookup (alice→b.ts → finds pair when bob touched a.ts)", () => {
    // Reverse direction: alice announces b.ts, bob touched a.ts
    getDb().exec("DELETE FROM file_activity");
    fileTracker.log({
      org_id: "default",
      session_id: "s",
      agent_id: "bob",
      tool_name: "Edit",
      file_path: "a.ts",
    });
    const scores = scorer.score({
      org_id: "default",
      agent_id: "alice",
      target_modules: [],
      target_files: ["b.ts"],
    });
    const bob = scores.find((s) => s.agent_id === "bob")!;
    expect(bob.score).toBeGreaterThanOrEqual(60);
  });
});
