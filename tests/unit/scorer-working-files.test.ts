import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { FileTracker } from "../../src/file-tracker.js";
import { WorkingFilesTracker } from "../../src/working-files-tracker.js";
import { ImpactScorer } from "../../src/impact-scorer.js";

const TEST_DIR = mkdtempSync(path.join(tmpdir(), "scorer-wf-"));

describe("ImpactScorer Layer 1 union with working_files", () => {
  let registry: AgentRegistry;
  let fileTracker: FileTracker;
  let workingFiles: WorkingFilesTracker;
  let scorer: ImpactScorer;

  beforeEach(() => {
    initDatabase(TEST_DIR);
    getDb().exec("DELETE FROM agents; DELETE FROM file_activity; DELETE FROM working_files;");
    registry = new AgentRegistry();
    fileTracker = new FileTracker();
    workingFiles = new WorkingFilesTracker();
    scorer = new ImpactScorer(registry, fileTracker, undefined, workingFiles);
    registry.register("default", "alice", "Alice", []);
    registry.register("default", "bob", "Bob", []);
    registry.setOnline("default", "alice");
    registry.setOnline("default", "bob");
  });
  afterAll(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("scores 100 when another agent has working_files on the same path", () => {
    workingFiles.start("default", "bob", "src/foo.ts", 30);
    const scores = scorer.score({
      org_id: "default",
      agent_id: "alice",
      target_modules: [],
      target_files: ["src/foo.ts"],
    });
    const bobScore = scores.find((s) => s.agent_id === "bob")!;
    expect(bobScore.score).toBe(100);
    expect(bobScore.reasons.join(" ")).toMatch(/in flight/);
  });
});
