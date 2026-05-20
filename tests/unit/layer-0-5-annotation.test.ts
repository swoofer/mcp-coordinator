import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, promises as fsp } from "fs";
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
    // Close any previous connection before re-init: initDatabase() reassigns the
    // module-level db without closing the old handle, which on Windows leaks
    // handles to the same .db file and causes EBUSY on rmSync in afterAll.
    try { closeDb(); } catch { /* nothing to close yet */ }
    initDatabase(TEST_DIR);
    getDb().exec("DELETE FROM agents; DELETE FROM file_activity;");
    registry = new AgentRegistry();
    fileTracker = new FileTracker();
    scorer = new ImpactScorer(registry, fileTracker);
    // Use the actual register signature (positional). If different in your codebase, adapt.
    registry.register("default", "alice", "A", []);
    registry.register("default", "bob", "B", []);
    registry.setOnline("default", "alice"); registry.setOnline("default", "bob");
    // Bob recently edited foo.ts touching getById only
    fileTracker.log({
      org_id: "default",
      session_id: "s", agent_id: "bob", tool_name: "Edit", file_path: "src/foo.ts",
      symbols_touched: ["getById"],
    });
  });
  afterAll(async () => {
    try { closeDb(); } catch { /* already closed */ }
    // Windows can hold .db handles for many seconds after better-sqlite3 close()
    // (Defender / indexer / WAL teardown). Retry generously so cleanup wins
    // once the OS releases the file.
    await fsp.rm(TEST_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 750 });
  }, 30000);

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


