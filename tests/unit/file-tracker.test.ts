import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { FileTracker } from "../../src/file-tracker.js";
import fs from "fs";

const TEST_DIR = "data-test-filetracker";
let tracker: FileTracker;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
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
    tracker.log({ session_id: "s1", agent_id: "a1", agent_name: "Agent A", tool_name: "Edit", file_path: "src/auth/middleware.ts" });
    const files = tracker.getBySession("s1");
    expect(files).toHaveLength(1);
    expect(files[0].file_path).toBe("src/auth/middleware.ts");
    expect(files[0].module).toBe("src/auth");
  });

  it("detects hot files", () => {
    tracker.log({ session_id: "s1", agent_id: "a1", tool_name: "Edit", file_path: "src/shared/types.ts" });
    tracker.log({ session_id: "s2", agent_id: "a2", tool_name: "Edit", file_path: "src/shared/types.ts" });
    const hot = tracker.getHotFiles(60);
    expect(hot).toHaveLength(1);
    expect(hot[0].file_path).toBe("src/shared/types.ts");
    expect(hot[0].agent_count).toBe(2);
  });

  it("no hot files when single agent", () => {
    tracker.log({ session_id: "s1", agent_id: "a1", tool_name: "Edit", file_path: "src/auth/index.ts" });
    expect(tracker.getHotFiles(60)).toHaveLength(0);
  });

  it("checks file conflict", () => {
    tracker.log({ session_id: "s1", agent_id: "a1", tool_name: "Edit", file_path: "src/auth/index.ts" });
    const conflict = tracker.checkFileConflict("src/auth/index.ts", "a2", 60);
    expect(conflict.conflict).toBe(true);
    expect(conflict.agents).toContain("a1");
    expect(tracker.checkFileConflict("src/auth/index.ts", "a1", 60).conflict).toBe(false);
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


