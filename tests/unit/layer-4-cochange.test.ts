import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
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
    initDatabase(TEST_DIR);
    const db = getDb();
    db.exec("DELETE FROM agents; DELETE FROM file_activity; DELETE FROM git_cochange;");
    // Seed a co-change ratio of 0.6 between a.ts and b.ts
    db.prepare("INSERT INTO git_cochange (file_a, file_b, count, total_commits, computed_at) VALUES (?,?,?,?, datetime('now'))")
      .run("a.ts", "b.ts", 3, 5);
    registry = new AgentRegistry();
    fileTracker = new FileTracker();
    scorer = new ImpactScorer(registry, fileTracker);
    registry.register("alice", "A", []);
    registry.register("bob",   "B", []);
    registry.setOnline("alice"); registry.setOnline("bob");
    // Bob recently edited b.ts
    fileTracker.log({ session_id: "s", agent_id: "bob", tool_name: "Edit", file_path: "b.ts" });
  });
  afterAll(() => { closeDb(); rmSync(TEST_DIR, { recursive: true, force: true }); });

  it("scores 60 when ratio > 0.5 (alice→a.ts, bob touched b.ts which co-changes 0.6)", () => {
    const scores = scorer.score({ agent_id: "alice", target_modules: [], target_files: ["a.ts"] });
    const bob = scores.find(s => s.agent_id === "bob")!;
    expect(bob.score).toBeGreaterThanOrEqual(60);
    expect(bob.reasons.join(" ")).toMatch(/co-change/i);
  });

  it("canonical lookup (alice→b.ts → finds pair when bob touched a.ts)", () => {
    // Reverse direction: alice announces b.ts, bob touched a.ts
    getDb().exec("DELETE FROM file_activity");
    fileTracker.log({ session_id: "s", agent_id: "bob", tool_name: "Edit", file_path: "a.ts" });
    const scores = scorer.score({ agent_id: "alice", target_modules: [], target_files: ["b.ts"] });
    const bob = scores.find(s => s.agent_id === "bob")!;
    expect(bob.score).toBeGreaterThanOrEqual(60);
  });
});
