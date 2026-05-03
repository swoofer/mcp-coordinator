// tests/context-provider.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation } from "../../src/consultation.js";
import { FileTracker } from "../../src/file-tracker.js";
import { SummaryContextProvider } from "../../src/context-provider.js";
import fs from "fs";

const TEST_DIR = "data-test-context";
let registry: AgentRegistry;
let consultation: Consultation;
let tracker: FileTracker;
let provider: SummaryContextProvider;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM action_summaries");
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
  consultation = new Consultation();
  tracker = new FileTracker();
  provider = new SummaryContextProvider(registry, consultation, tracker);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("SummaryContextProvider", () => {
  it("returns context for agent with matching modules", () => {
    registry.register("a1", "Agent A", ["src/auth"]);
    consultation.logActionSummary({
      session_id: "s1",
      agent_id: "a1",
      file_path: "src/auth/middleware.ts",
      summary: "Added JWT validation",
    });
    tracker.log({ session_id: "s1", agent_id: "a1", tool_name: "Edit", file_path: "src/auth/middleware.ts" });

    const ctx = provider.getRelevantContext("a1", {
      thread_id: "t1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(ctx.agent_id).toBe("a1");
    expect(ctx.modules).toContain("src/auth");
    expect(ctx.action_summaries).toHaveLength(1);
    expect(ctx.recent_files).toContain("src/auth/middleware.ts");
  });

  it("returns empty context when no overlap", () => {
    registry.register("a1", "Agent A", ["src/users"]);
    const ctx = provider.getRelevantContext("a1", {
      thread_id: "t1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(ctx.modules).toHaveLength(0);
    expect(ctx.action_summaries).toHaveLength(0);
  });

  it("returns empty context for agent with no registered modules", () => {
    registry.register("a1", "Agent A", []);
    const ctx = provider.getRelevantContext("a1", {
      thread_id: "t1",
      subject: "Work on auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(ctx.agent_id).toBe("a1");
    expect(ctx.modules).toHaveLength(0);
    expect(ctx.recent_files).toHaveLength(0);
    expect(ctx.action_summaries).toHaveLength(0);
  });

  it("returns empty context for unknown agent", () => {
    const ctx = provider.getRelevantContext("nonexistent-agent", {
      thread_id: "t1",
      subject: "test",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(ctx.agent_id).toBe("nonexistent-agent");
    expect(ctx.modules).toHaveLength(0);
    expect(ctx.recent_files).toHaveLength(0);
    expect(ctx.action_summaries).toHaveLength(0);
  });
});


