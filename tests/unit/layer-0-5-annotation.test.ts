import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { FileTracker } from "../../src/file-tracker.js";
import { ImpactScorer } from "../../src/impact-scorer.js";

const TEST_DIR = mkdtempSync(path.join(tmpdir(), "l05-"));

describe("Layer 0.5 annotation", () => {
  let registry: AgentRegistry, fileTracker: FileTracker, scorer: ImpactScorer;
  beforeEach(() => {
    initDatabase(TEST_DIR);
    getDb().exec("DELETE FROM agents; DELETE FROM file_activity;");
    registry = new AgentRegistry();
    fileTracker = new FileTracker();
    scorer = new ImpactScorer(registry, fileTracker);
    // Use the actual register signature (positional). If different in your codebase, adapt.
    registry.register("alice", "A", []);
    registry.register("bob",   "B", []);
    registry.setOnline("alice"); registry.setOnline("bob");
    // Bob recently edited foo.ts touching getById only
    fileTracker.log({
      org_id: "default",
      session_id: "s", agent_id: "bob", tool_name: "Edit", file_path: "src/foo.ts",
      symbols_touched: ["getById"],
    });
  });
  afterAll(() => { closeDb(); rmSync(TEST_DIR, { recursive: true, force: true }); });

  it("score stays 100 with annotated reason when symbols disjoint", () => {
    const scores = scorer.score({
      org_id: "default",
      agent_id: "alice", target_modules: [], target_files: ["src/foo.ts"],
      target_symbols: ["update"],
    });
    const bob = scores.find(s => s.agent_id === "bob")!;
    expect(bob.score).toBe(100);
    expect(bob.reasons.join(" ")).toMatch(/disjoint symbols/);
  });

  it("score 100 plain reason when target_symbols absent", () => {
    const scores = scorer.score({
      org_id: "default",
      agent_id: "alice", target_modules: [], target_files: ["src/foo.ts"],
    });
    const bob = scores.find(s => s.agent_id === "bob")!;
    expect(bob.score).toBe(100);
    expect(bob.reasons.join(" ")).not.toMatch(/disjoint/);
  });
});
