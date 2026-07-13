import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { FileTracker } from "../../src/file-tracker.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import fs from "fs";

const TEST_DIR = "data-test-filetracker";
let tracker: FileTracker;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  // v0.9 (issue #79): FK on file_activity/agents.org_id → orgs(id).
  seedTestOrgs(getDb(), ["org-a", "org-b"]);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM action_summaries");
  db.exec("DELETE FROM agents");
  // Register agents directly for FK constraints
  db.exec("INSERT INTO agents (id, name, status) VALUES ('a1', 'Agent A', 'online')");
  db.exec("INSERT INTO agents (id, name, status) VALUES ('a2', 'Agent B', 'online')");
  tracker = new FileTracker();
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("FileTracker", () => {
  it("logs and retrieves file activity", () => {
    tracker.log({
      org_id: "default",
      session_id: "s1",
      agent_id: "a1",
      agent_name: "Agent A",
      tool_name: "Edit",
      file_path: "src/auth/middleware.ts",
    });
    const files = tracker.getBySession("default", "s1");
    expect(files).toHaveLength(1);
    expect(files[0].file_path).toBe("src/auth/middleware.ts");
    expect(files[0].module).toBe("src/auth");
  });

  it("detects hot files", () => {
    tracker.log({
      org_id: "default",
      session_id: "s1",
      agent_id: "a1",
      tool_name: "Edit",
      file_path: "src/shared/types.ts",
    });
    tracker.log({
      org_id: "default",
      session_id: "s2",
      agent_id: "a2",
      tool_name: "Edit",
      file_path: "src/shared/types.ts",
    });
    const hot = tracker.getHotFiles("default", 60);
    expect(hot).toHaveLength(1);
    expect(hot[0].file_path).toBe("src/shared/types.ts");
    expect(hot[0].agent_count).toBe(2);
  });

  it("no hot files when single agent", () => {
    tracker.log({
      org_id: "default",
      session_id: "s1",
      agent_id: "a1",
      tool_name: "Edit",
      file_path: "src/auth/index.ts",
    });
    expect(tracker.getHotFiles("default", 60)).toHaveLength(0);
  });

  it("checks file conflict", () => {
    tracker.log({
      org_id: "default",
      session_id: "s1",
      agent_id: "a1",
      tool_name: "Edit",
      file_path: "src/auth/index.ts",
    });
    const conflict = tracker.checkFileConflict("default", "src/auth/index.ts", "a2", 60);
    expect(conflict.conflict).toBe(true);
    expect(conflict.agents).toContain("a1");
    expect(tracker.checkFileConflict("default", "src/auth/index.ts", "a1", 60).conflict).toBe(
      false,
    );
  });

  it("deduces module from file path", () => {
    expect(tracker.fileToModule("src/auth/middleware.ts")).toBe("src/auth");
    expect(tracker.fileToModule("src/shared/types.ts")).toBe("src/shared");
    expect(tracker.fileToModule("package.json")).toBe("");
  });

  it("BUG: fileToModule returns wrong module for absolute paths", () => {
    // Absolute paths start with "/" â€” split("/") yields ["", "Users", ...]
    // so slice(0,2) gives ["", "Users"] â†’ "/Users" instead of the real module
    const result = tracker.fileToModule("/server/src/consultation.ts");
    // Expected: "server/src" (the real module), but the bug produces "/server"
    expect(result).toBe("server/src");
  });

  it("BUG: fileToModule returns empty string for root-relative single-segment paths", () => {
    // A path like "/file.ts" splits to ["", "file.ts"] â†’ slice(0,2) = ["", "file.ts"] â†’ "/file.ts"
    // which is nonsensical as a module name
    const result = tracker.fileToModule("/file.ts");
    expect(result).toBe("");
  });
});

describe("file-tracker org_id scoping", () => {
  // Setup: tracker, two orgs with overlapping data
  const tracker = new FileTracker();

  beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM file_activity");
  });

  it("log writes org_id into file_activity", () => {
    tracker.log({
      org_id: "org-a",
      session_id: "s1",
      agent_id: "a1",
      tool_name: "Edit",
      file_path: "x.ts",
    });
    const row = getDb().prepare("SELECT org_id FROM file_activity").get() as { org_id: string };
    expect(row.org_id).toBe("org-a");
  });

  it("getBySession only returns rows from the calling org", () => {
    tracker.log({
      org_id: "org-a",
      session_id: "s1",
      agent_id: "a1",
      tool_name: "Edit",
      file_path: "a.ts",
    });
    tracker.log({
      org_id: "org-b",
      session_id: "s1",
      agent_id: "a2",
      tool_name: "Edit",
      file_path: "b.ts",
    });
    const rows = tracker.getBySession("org-a", "s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe("a.ts");
  });

  it("getHotFiles only returns rows from the calling org", () => {
    tracker.log({
      org_id: "org-a",
      session_id: "s1",
      agent_id: "a1",
      tool_name: "Edit",
      file_path: "shared.ts",
    });
    tracker.log({
      org_id: "org-a",
      session_id: "s2",
      agent_id: "a2",
      tool_name: "Edit",
      file_path: "shared.ts",
    });
    tracker.log({
      org_id: "org-b",
      session_id: "s3",
      agent_id: "b1",
      tool_name: "Edit",
      file_path: "shared.ts",
    });
    tracker.log({
      org_id: "org-b",
      session_id: "s4",
      agent_id: "b2",
      tool_name: "Edit",
      file_path: "shared.ts",
    });
    const hotA = tracker.getHotFiles("org-a", 30);
    const hotB = tracker.getHotFiles("org-b", 30);
    expect(hotA[0].agent_count).toBe(2);
    expect(hotB[0].agent_count).toBe(2);
    // Each org sees only its own agents
    expect(hotA[0].agents.sort()).toEqual(["a1", "a2"]);
    expect(hotB[0].agents.sort()).toEqual(["b1", "b2"]);
  });

  it("checkFileConflict does not see other orgs’ agents", () => {
    tracker.log({
      org_id: "org-a",
      session_id: "s1",
      agent_id: "a1",
      tool_name: "Edit",
      file_path: "x.ts",
    });
    tracker.log({
      org_id: "org-b",
      session_id: "s2",
      agent_id: "b1",
      tool_name: "Edit",
      file_path: "x.ts",
    });
    const result = tracker.checkFileConflict("org-a", "x.ts", "a-other", 30);
    expect(result.conflict).toBe(true);
    expect(result.agents).toEqual(["a1"]); // not b1
  });

  it("getFileToAgentsIndex respects org_id scope", () => {
    tracker.log({
      org_id: "org-a",
      session_id: "s1",
      agent_id: "a1",
      tool_name: "Edit",
      file_path: "x.ts",
    });
    tracker.log({
      org_id: "org-b",
      session_id: "s2",
      agent_id: "b1",
      tool_name: "Edit",
      file_path: "x.ts",
    });
    const idx = tracker.getFileToAgentsIndex("org-a", ["x.ts"], "a-other", 30);
    expect(idx.get("x.ts")?.has("a1")).toBe(true);
    expect(idx.get("x.ts")?.has("b1")).toBe(false);
  });
});
