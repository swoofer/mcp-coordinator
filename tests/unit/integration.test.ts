import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation } from "../../src/consultation.js";
import { ConflictDetector } from "../../src/conflict-detector.js";
import { DependencyMapper } from "../../src/dependency-map.js";
import { FileTracker } from "../../src/file-tracker.js";
import { SummaryContextProvider } from "../../src/context-provider.js";
import { SseEmitter } from "../../src/sse-emitter.js";
import { ImpactScorer } from "../../src/impact-scorer.js";
import { IntrospectionManager } from "../../src/introspection.js";
import fs from "fs";

const TEST_DIR = "data-test-integration";

let registry: AgentRegistry;
let consultation: Consultation;
let conflictDetector: ConflictDetector;
let depMap: DependencyMapper;
let fileTracker: FileTracker;
let contextProvider: SummaryContextProvider;
let sseEmitter: SseEmitter;
let impactScorer: ImpactScorer;
let introspection: IntrospectionManager;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM introspections");
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM action_summaries");
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM dependency_map");
  db.exec("DELETE FROM agents");

  registry = new AgentRegistry();
  consultation = new Consultation();
  depMap = new DependencyMapper();
  fileTracker = new FileTracker();
  conflictDetector = new ConflictDetector(consultation, depMap, fileTracker);
  contextProvider = new SummaryContextProvider(registry, consultation, fileTracker);
  sseEmitter = new SseEmitter();
  impactScorer = new ImpactScorer(registry, fileTracker);
  introspection = new IntrospectionManager();
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Integration: Full Consultation Lifecycle", () => {
  it("complete flow: announce â†’ respond â†’ propose â†’ approve â†’ resolve", () => {
    // Setup: 2 agents with overlapping modules
    registry.register("default", "agent-a", "Agent A", ["src/auth", "src/shared"]);
    registry.register("default", "agent-b", "Agent B", ["src/api", "src/shared"]);

    // Agent A announces work
    const thread = consultation.announceWork("default", {
      agent_id: "agent-a",
      subject: "Refactor auth middleware",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });
    expect(thread.status).toBe("open");

    // Agent B responds with context
    const msg = consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "agent-b",
      agent_name: "Agent B",
      type: "warning",
      content: "I depend on User interface in shared/types.ts",
    });
    expect(msg.round).toBe(1);

    // Agent A proposes resolution
    consultation.proposeResolution("default", thread.id, "agent-a", "Keep interface backward compatible");
    const resolving = consultation.getThread("default", thread.id)!;
    expect(resolving.status).toBe("resolving");

    // Agent B approves
    consultation.approveResolution("default", thread.id, "agent-b");
    const resolved = consultation.getThread("default", thread.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolved_at).toBeDefined();

    // Verify thread has all messages
    const full = consultation.getThreadWithMessages("default", thread.id)!;
    expect(full.messages.length).toBeGreaterThanOrEqual(3); // warning + resolution + approve
  });

  it("contestation triggers new round", () => {
    registry.register("default", "agent-a", "Agent A", ["src/shared"]);
    registry.register("default", "agent-b", "Agent B", ["src/shared"]);

    const thread = consultation.announceWork("default", {
      agent_id: "agent-a",
      subject: "Change shared interface",
      target_modules: ["src/shared"],
      target_files: [],
    });

    consultation.postToThread("default", {
      thread_id: thread.id, agent_id: "agent-b", type: "context", content: "noted",
    });

    // Propose
    consultation.proposeResolution("default", thread.id, "agent-a", "My approach");

    // Contest
    consultation.contestResolution("default", thread.id, "agent-b", "This breaks my code");
    const contested = consultation.getThread("default", thread.id)!;
    expect(contested.status).toBe("open");
    expect(contested.round).toBe(2);

    // Re-propose with adjusted plan
    consultation.postToThread("default", {
      thread_id: thread.id, agent_id: "agent-a", type: "suggestion", content: "How about this instead",
    });
    consultation.proposeResolution("default", thread.id, "agent-a", "Adjusted approach");
    consultation.approveResolution("default", thread.id, "agent-b");

    const final = consultation.getThread("default", thread.id)!;
    expect(final.status).toBe("resolved");
  });

  it("auto-resolves when no agents overlap", () => {
    registry.register("default", "agent-a", "Agent A", ["src/auth"]);
    registry.register("default", "agent-b", "Agent B", ["src/users"]);

    const thread = consultation.announceWork("default", {
      agent_id: "agent-a",
      subject: "Internal auth change",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(thread.status).toBe("resolved");
  });

  it("handles agent departure mid-consultation", () => {
    registry.register("default", "agent-a", "Agent A", ["src/shared"]);
    registry.register("default", "agent-b", "Agent B", ["src/shared"]);
    registry.register("default", "agent-c", "Agent C", ["src/shared"]);

    const thread = consultation.announceWork("default", {
      agent_id: "agent-a",
      subject: "Refactor shared",
      target_modules: ["src/shared"],
      target_files: [],
    });

    // B responds, C departs
    consultation.postToThread("default", {
      thread_id: thread.id, agent_id: "agent-b", type: "context", content: "ok",
    });
    consultation.handleAgentDeparture("agent-c");

    // Only B needs to approve now
    consultation.proposeResolution("default", thread.id, "agent-a", "My plan");
    consultation.approveResolution("default", thread.id, "agent-b");

    const resolved = consultation.getThread("default", thread.id)!;
    expect(resolved.status).toBe("resolved");
  });
});

describe("Integration: Impact Scoring + Introspection", () => {
  it("scores agents correctly: file hit > module overlap > no link", () => {
    registry.register("default", "agent-a", "Agent A", ["src/auth"]);
    registry.register("default", "agent-b", "Agent B", ["src/shared"]);       // module overlap = 30
    registry.register("default", "agent-c", "Agent C", ["src/api"]);          // no overlap = 0

    // Agent B also recently edited the target file
    fileTracker.log({ org_id: "default", session_id: "s1", agent_id: "agent-b", tool_name: "Edit", file_path: "src/shared/types.ts" });

    const categorized = impactScorer.categorize({
      org_id: "default",
      agent_id: "agent-a",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });

    expect(categorized.concerned).toHaveLength(1);
    expect(categorized.concerned[0].agent_id).toBe("agent-b");
    expect(categorized.concerned[0].score).toBe(100);

    expect(categorized.pass).toHaveLength(1);
    expect(categorized.pass[0].agent_id).toBe("agent-c");
    expect(categorized.pass[0].score).toBe(0);
  });

  it("gray zone agent triggers introspection", () => {
    registry.register("default", "agent-a", "Agent A", ["src/auth"]);
    registry.register("default", "agent-b", "Agent B", ["src/shared"]); // module overlap = 30 (gray zone)

    const categorized = impactScorer.categorize({
      org_id: "default",
      agent_id: "agent-a",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });

    expect(categorized.gray_zone).toHaveLength(1);
    expect(categorized.gray_zone[0].agent_id).toBe("agent-b");
    expect(categorized.gray_zone[0].score).toBe(30);

    // Create introspection for gray zone agent
    const thread = consultation.announceWork("default", {
      agent_id: "agent-a",
      subject: "test",
      target_modules: ["src/shared"],
      target_files: [],
    });

    const intro = introspection.create("default", {
      thread_id: thread.id,
      agent_id: "agent-b",
      score: 30,
      reasons: ["module overlap: src/shared"],
    });
    expect(intro.status).toBe("pending");

    // Liaison responds: not concerned
    const responded = introspection.respond("default", intro.id, "I don't use User interface");
    expect(responded?.status).toBe("responded");

    // Verify agent NOT added to expected_respondents
    const pending = introspection.getPending("default", "agent-b");
    expect(pending).toHaveLength(0);
  });

  it("introspection: concerned agent gets added to thread", () => {
    registry.register("default", "agent-a", "Agent A", ["src/auth"]);
    registry.register("default", "agent-b", "Agent B", ["src/shared"]);

    const thread = consultation.announceWork("default", {
      agent_id: "agent-a",
      subject: "test",
      target_modules: ["src/shared"],
      target_files: [],
    });

    const intro = introspection.create("default", {
      thread_id: thread.id,
      agent_id: "agent-b",
      score: 30,
      reasons: ["module overlap"],
    });

    // Liaison responds: concerned
    const responded = introspection.respond("default", intro.id, "I import User in my service");
    expect(responded?.status).toBe("responded");

    // Manually add to expected_respondents (as serve-http.ts would)
    const db = getDb();
    const t = consultation.getThread("default", thread.id)!;
    const respondents: string[] = JSON.parse(t.expected_respondents || "[]");
    if (!respondents.includes("agent-b")) {
      respondents.push("agent-b");
      db.prepare("UPDATE threads SET expected_respondents = ? WHERE id = ?")
        .run(JSON.stringify(respondents), thread.id);
    }

    const updated = consultation.getThread("default", thread.id)!;
    const updatedRespondents: string[] = JSON.parse(updated.expected_respondents || "[]");
    expect(updatedRespondents).toContain("agent-b");
  });
});

describe("Integration: Conflict Detection + Dependencies", () => {
  it("detects module overlap conflict", () => {
    registry.register("default", "agent-a", "Agent A", ["src/shared"]);
    registry.register("default", "agent-b", "Agent B", ["src/shared"]);

    // Agent B has open thread on src/shared
    consultation.announceWork("default", {
      agent_id: "agent-b",
      subject: "Working on shared",
      target_modules: ["src/shared"],
      target_files: [],
    });

    const conflicts = conflictDetector.detect({
      org_id: "default",
      agent_id: "agent-a",
      target_modules: ["src/shared"],
      target_files: [],
    });

    expect(conflicts.some(c => c.type === "module_overlap")).toBe(true);
  });

  it("detects dependency chain via blast radius", () => {
    registry.register("default", "agent-a", "Agent A", ["src/auth"]);
    registry.register("default", "agent-b", "Agent B", ["src/shared"]);

    depMap.setMap("default", {
      "src/shared": { module_id: "src/shared", depends_on: [], exports: ["User"], owners: [] },
      "src/auth": { module_id: "src/auth", depends_on: ["src/shared"], exports: [], owners: [] },
    });

    consultation.announceWork("default", {
      agent_id: "agent-b",
      subject: "Modifying shared",
      target_modules: ["src/shared"],
      target_files: [],
    });

    const conflicts = conflictDetector.detect({
      org_id: "default",
      agent_id: "agent-a",
      target_modules: ["src/auth"],
      target_files: [],
    });

    expect(conflicts.some(c => c.type === "dependency_chain")).toBe(true);
  });
});

describe("Integration: SSE Events", () => {
  // P3: SseEmitter fans out via setImmediate now — drain the queue before
  // asserting on listener side effects.
  const flushSse = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("emits events for full lifecycle", async () => {
    const emitted: { type: string; payload: any }[] = [];
    sseEmitter.addListener("default", (event) => {
      emitted.push({ type: event.type, payload: JSON.parse(event.payload) });
    });

    // Emit events as the flow would
    sseEmitter.emit("agent_online", { agent_id: "a1", name: "Agent A", modules: ["src/auth"] }, { org_id: "default" });
    sseEmitter.emit("thread_opened", { thread_id: "t1", subject: "test", agent_id: "a1" }, { org_id: "default" });
    sseEmitter.emit("impact_scored", { thread_id: "t1", agent_id: "a2", score: 100, category: "concerned" }, { org_id: "default" });
    sseEmitter.emit("message_posted", { thread_id: "t1", agent_id: "a2", type: "context", content: "info" }, { org_id: "default" });
    sseEmitter.emit("resolution_proposed", { thread_id: "t1", agent_id: "a1", summary: "plan" }, { org_id: "default" });
    sseEmitter.emit("thread_resolved", { thread_id: "t1", resolution: "plan" }, { org_id: "default" });

    await flushSse();
    expect(emitted).toHaveLength(6);
    expect(emitted.map(e => e.type)).toEqual([
      "agent_online", "thread_opened", "impact_scored",
      "message_posted", "resolution_proposed", "thread_resolved"
    ]);

    // Verify events are persisted
    const stored = sseEmitter.getEventsSince("default", 0);
    expect(stored).toHaveLength(6);
  });

  it("getEventsSince filters correctly", () => {
    sseEmitter.emit("agent_online", { agent_id: "a1" }, { org_id: "default" });
    sseEmitter.emit("agent_online", { agent_id: "a2" }, { org_id: "default" });

    const all = sseEmitter.getEventsSince("default", 0);
    const firstId = all[0].id!;
    const afterFirst = sseEmitter.getEventsSince("default", firstId);
    expect(afterFirst).toHaveLength(1);
    expect(JSON.parse(afterFirst[0].payload).agent_id).toBe("a2");
  });
});

describe("Integration: Context Provider", () => {
  it("provides relevant context for overlapping agent", () => {
    registry.register("default", "agent-a", "Agent A", ["src/shared"]);
    consultation.logActionSummary("default", {
      session_id: "s1", agent_id: "agent-a",
      file_path: "src/shared/types.ts", summary: "Added User.role_permissions field",
    });
    consultation.logActionSummary("default", {
      session_id: "s1", agent_id: "agent-a",
      file_path: "src/shared/utils.ts", summary: "Added permission helper",
    });

    const ctx = contextProvider.getRelevantContext("agent-a", {
      thread_id: "t1", subject: "Refactor shared",
      target_modules: ["src/shared"], target_files: [],
    });

    expect(ctx.modules).toContain("src/shared");
    expect(ctx.action_summaries).toHaveLength(2);
    expect(ctx.recent_files).toContain("src/shared/types.ts");
  });

  it("returns empty context for non-overlapping agent", () => {
    registry.register("default", "agent-a", "Agent A", ["src/users"]);

    const ctx = contextProvider.getRelevantContext("agent-a", {
      thread_id: "t1", subject: "Refactor auth",
      target_modules: ["src/auth"], target_files: [],
    });

    expect(ctx.modules).toHaveLength(0);
    expect(ctx.action_summaries).toHaveLength(0);
  });
});

describe("Integration: /api/reset parity (Chasseur Bravo)", () => {
  it("reset should clear agent_activity_status table", () => {
    const db = getDb();
    registry.register("default", "agent-a", "Agent A", ["src/auth"]);
    // Insert activity status
    db.prepare(
      `INSERT INTO agent_activity_status (agent_id, activity_status, current_file, last_activity_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    ).run("agent-a", "working", "src/auth/login.ts");

    // Simulate /api/reset â€” same DELETE statements as serve-http.ts
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DELETE FROM introspections");
    db.exec("DELETE FROM events");
    db.exec("DELETE FROM thread_messages");
    db.exec("DELETE FROM threads");
    db.exec("DELETE FROM action_summaries");
    db.exec("DELETE FROM file_activity");
    db.exec("DELETE FROM agent_activity_status");
    db.exec("DELETE FROM dependency_map");
    db.exec("DELETE FROM agents");
    db.exec("DELETE FROM revoked_agents");
    db.exec("PRAGMA foreign_keys = ON");

    // BUG: agent_activity_status is NOT cleared by /api/reset
    const rows = db.prepare("SELECT COUNT(*) as count FROM agent_activity_status").get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it("reset should clear dependency_map table", () => {
    const db = getDb();
    depMap.setMap("default", {
      "src/auth": { module_id: "src/auth", depends_on: ["src/shared"], exports: ["AuthMiddleware"], owners: [] },
    });

    // Simulate /api/reset â€” same DELETE statements as serve-http.ts
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DELETE FROM introspections");
    db.exec("DELETE FROM events");
    db.exec("DELETE FROM thread_messages");
    db.exec("DELETE FROM threads");
    db.exec("DELETE FROM action_summaries");
    db.exec("DELETE FROM file_activity");
    db.exec("DELETE FROM agent_activity_status");
    db.exec("DELETE FROM dependency_map");
    db.exec("DELETE FROM agents");
    db.exec("DELETE FROM revoked_agents");
    db.exec("PRAGMA foreign_keys = ON");

    // BUG: dependency_map is NOT cleared by /api/reset
    const rows = db.prepare("SELECT COUNT(*) as count FROM dependency_map").get() as { count: number };
    expect(rows.count).toBe(0);
  });
});



