// tests/consultation.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation } from "../../src/consultation.js";
import fs from "fs";

const TEST_DIR = "data-test-consultation";
let consultation: Consultation;
let registry: AgentRegistry;

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
  registry.register("a1", "Agent A", ["src/auth"]);
  registry.register("a2", "Agent B", ["src/users"]);
  registry.register("a3", "Agent C", ["src/api"]);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Consultation", () => {
  it("opens a thread with announce_work", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth middleware",
      plan: "Split middleware into validation + session",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
    });
    expect(thread.id).toBeDefined();
    expect(thread.status).toBe("open");
    expect(thread.initiator_id).toBe("a1");
    expect(thread.round).toBe(1);
  });

  it("resolves instantly when no agents are concerned", () => {
    // Only a1 is online, a2 works on users, a3 on api â€” none overlap with auth
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth middleware",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
    });
    // expected_respondents should be empty since no other agent has src/auth
    const parsed = JSON.parse(thread.expected_respondents || "[]");
    expect(parsed).toHaveLength(0);
    // Thread should auto-resolve
    const updated = consultation.getThread(thread.id);
    expect(updated!.status).toBe("resolved");
  });

  it("identifies expected respondents based on module overlap", () => {
    registry.register("a2", "Agent B", ["src/auth", "src/users"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    const respondents = JSON.parse(thread.expected_respondents || "[]");
    expect(respondents).toContain("a2");
    expect(respondents).not.toContain("a3");
    expect(thread.status).toBe("open");
  });

  it("posts a message to a thread", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    const msg = consultation.postToThread({
      thread_id: thread.id,
      agent_id: "a2",
      agent_name: "Agent B",
      type: "context",
      content: "I have a dependency on auth/types.ts",
    });
    expect(msg.type).toBe("context");
    expect(msg.round).toBe(1);
  });

  it("proposes resolution and transitions to resolving", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread({
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "I depend on auth/types.ts",
    });
    consultation.proposeResolution(thread.id, "a1", "Keep interface compatible");
    const updated = consultation.getThread(thread.id);
    expect(updated!.status).toBe("resolving");
    expect(updated!.resolution_summary).toBe("Keep interface compatible");
  });

  it("approves resolution and resolves thread", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread({
      thread_id: thread.id, agent_id: "a2", type: "context", content: "noted",
    });
    consultation.proposeResolution(thread.id, "a1", "Keep interface compatible");
    consultation.approveResolution(thread.id, "a2");
    const updated = consultation.getThread(thread.id);
    expect(updated!.status).toBe("resolved");
    expect(updated!.resolved_at).toBeDefined();
  });

  it("contests resolution and returns to open", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread({
      thread_id: thread.id, agent_id: "a2", type: "context", content: "noted",
    });
    consultation.proposeResolution(thread.id, "a1", "Keep interface compatible");
    consultation.contestResolution(thread.id, "a2", "This will break my cache layer");
    const updated = consultation.getThread(thread.id);
    expect(updated!.status).toBe("open");
    expect(updated!.round).toBe(2);
  });

  it("cancels a thread", () => {
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.cancelThread(thread.id, "a1", "Changed my mind");
    const updated = consultation.getThread(thread.id);
    expect(updated!.status).toBe("cancelled");
  });

  it("lists threads with filters", () => {
    consultation.announceWork({ agent_id: "a1", subject: "Task 1", target_modules: ["src/auth"], target_files: [] });
    consultation.announceWork({ agent_id: "a2", subject: "Task 2", target_modules: ["src/users"], target_files: [] });
    const all = consultation.listThreads({});
    expect(all.length).toBeGreaterThanOrEqual(2);
    const byAgent = consultation.listThreads({ agent_id: "a1" });
    expect(byAgent.every((t) => t.initiator_id === "a1")).toBe(true);
  });

  it("announceWork records assigned_to for directed dispatch", () => {
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Task for a2",
      target_modules: ["src/users"],
      target_files: [],
      assigned_to: "a2",
    });
    expect(thread.assigned_to).toBe("a2");
    // Directed dispatch forces keep_open even without module overlap.
    expect(thread.status).toBe("open");
  });

  it("announceWork without assigned_to leaves it NULL (open pool)", () => {
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Open task",
      target_modules: ["src/users"],
      target_files: [],
      keep_open: true,
    });
    expect(thread.assigned_to ?? null).toBeNull();
  });

  it("listThreads({assigned_to_me}) returns own + unassigned only", () => {
    // Open-pool thread (claimable by anyone)
    consultation.announceWork({
      agent_id: "a1", subject: "Open", target_modules: ["src/users"], target_files: [], keep_open: true,
    });
    // Directed at a2
    consultation.announceWork({
      agent_id: "a1", subject: "For a2", target_modules: ["src/users"], target_files: [], assigned_to: "a2",
    });
    // Directed at a3
    consultation.announceWork({
      agent_id: "a1", subject: "For a3", target_modules: ["src/api"], target_files: [], assigned_to: "a3",
    });

    const forA2 = consultation.listThreads({ assigned_to_me: "a2" });
    const subjects = forA2.map((t) => t.subject).sort();
    // a2 sees: the open-pool one + its own directed one. NOT a3's.
    expect(subjects).toContain("Open");
    expect(subjects).toContain("For a2");
    expect(subjects).not.toContain("For a3");
  });

  it("gets thread with messages", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread({
      thread_id: thread.id, agent_id: "a2", type: "context", content: "noted",
    });
    const full = consultation.getThreadWithMessages(thread.id);
    expect(full!.thread.id).toBe(thread.id);
    expect(full!.messages).toHaveLength(1);
  });

  it("logs action summaries", () => {
    consultation.logActionSummary({
      session_id: "s1",
      agent_id: "a1",
      file_path: "src/auth/middleware.ts",
      summary: "Added JWT validation middleware",
    });
    const summaries = consultation.getActionSummaries("a1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).toBe("Added JWT validation middleware");
  });

  it("gets thread updates since timestamp", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    const since = new Date().toISOString();
    consultation.postToThread({
      thread_id: thread.id, agent_id: "a2", type: "context", content: "new info",
    });
    const updates = consultation.getThreadUpdates("a1", since);
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it("auto-resolves thread on timeout", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "test timeout",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // Manually set created_at to 5 minutes ago and timeout to 1 second
    const db = getDb();
    db.prepare("UPDATE threads SET created_at = datetime('now', '-5 minutes'), timeout_seconds = 1 WHERE id = ?")
      .run(thread.id);

    // Next getThread should trigger timeout check
    const updated = consultation.getThread(thread.id);
    expect(updated!.status).toBe("resolved");
    expect(updated!.resolution_summary).toContain("timeout");
  });

  // â”€â”€ Resolution event tests â”€â”€

  it("emits consensus resolution event on approve", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1", subject: "Test consensus", target_modules: ["src/auth"], target_files: [],
    });
    consultation.postToThread({ thread_id: thread.id, agent_id: "a2", type: "context", content: "ok" });
    consultation.proposeResolution(thread.id, "a1", "Agreed");
    consultation.approveResolution(thread.id, "a2", "Agent B");

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("consensus");
    expect(events[0].approved_by).toBe("a2");
    expect(events[0].approved_by_name).toBe("Agent B");
    expect(events[0].had_messages).toBe(true);
    expect(events[0].created_at).toBeDefined();
    expect(events[0].resolved_at).toBeDefined();
  });

  it("emits auto_resolved when called externally", () => {
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1", subject: "Test auto", target_modules: ["src/auth"], target_files: [],
    });
    // Simulate external auto-resolve (normally done by server-setup.ts)
    consultation.emitResolution(thread.id, "auto_resolved");

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("auto_resolved");
    expect(events[0].had_messages).toBe(false);
  });

  it("emits timeout resolution event", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1", subject: "Test timeout event", target_modules: ["src/auth"], target_files: [],
    });
    const db = getDb();
    db.prepare("UPDATE threads SET created_at = datetime('now', '-5 minutes'), timeout_seconds = 1 WHERE id = ?")
      .run(thread.id);

    consultation.getThread(thread.id); // triggers checkTimeouts

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("timeout");
    expect(events[0].thread_id).toBe(thread.id);
  });

  it("emits max_rounds resolution event", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1", subject: "Test max rounds", target_modules: ["src/auth"], target_files: [],
    });
    const db = getDb();
    db.prepare("UPDATE threads SET max_rounds = 1 WHERE id = ?").run(thread.id);

    consultation.postToThread({ thread_id: thread.id, agent_id: "a2", type: "context", content: "ok" });
    consultation.proposeResolution(thread.id, "a1", "Plan A");
    consultation.contestResolution(thread.id, "a2", "Disagree");

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("max_rounds");
  });

  it("emits closed resolution event", () => {
    // Register another agent with overlapping modules so the thread stays open
    // (auto-resolves to 'resolved' if no concerned agents, which would prevent manual close)
    registry.register("a-overlap", "Overlap", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1", subject: "Test close", target_modules: ["src/auth"], target_files: [],
    });
    consultation.closeThread(thread.id, "a1", "Done manually");

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("closed");
    expect(events[0].resolution_summary).toBe("Done manually");
  });

  it("emits agent_departure resolution event", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1", subject: "Test departure", target_modules: ["src/auth"], target_files: [],
    });
    consultation.handleAgentDeparture("a2");

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("agent_departure");
  });

  it("had_messages is true when thread has messages", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1", subject: "Test messages", target_modules: ["src/auth"], target_files: [],
    });
    consultation.postToThread({ thread_id: thread.id, agent_id: "a2", type: "warning", content: "watch out" });
    consultation.proposeResolution(thread.id, "a1", "Noted");
    consultation.approveResolution(thread.id, "a2");

    expect(events[0].had_messages).toBe(true);
  });

  it("had_messages is false when thread has no user messages", () => {
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1", subject: "No messages", target_modules: ["src/auth"], target_files: [],
    });
    consultation.emitResolution(thread.id, "auto_resolved");

    expect(events[0].had_messages).toBe(false);
  });

  // â”€â”€ Additional branch coverage tests â”€â”€

  it("postToThread on non-open thread throws", () => {
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.cancelThread(thread.id, "a1", "Changed my mind");
    expect(() =>
      consultation.postToThread({
        thread_id: thread.id,
        agent_id: "a2",
        type: "context",
        content: "Too late",
      })
    ).toThrow(/cancelled/);
  });

  it("proposeResolution by non-initiator throws", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(() =>
      consultation.proposeResolution(thread.id, "a2", "My resolution")
    ).toThrow(/initiator/);
  });

  it("cancelThread by non-initiator throws", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(() =>
      consultation.cancelThread(thread.id, "a2", "I want to cancel")
    ).toThrow(/initiator/);
  });

  it("contestResolution on non-resolving thread throws", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // Thread is still "open", not "resolving"
    expect(() =>
      consultation.contestResolution(thread.id, "a2", "Disagree")
    ).toThrow(/not resolving/);
  });

  it("approveResolution on non-resolving thread throws", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // Thread is still "open", not "resolving"
    expect(() =>
      consultation.approveResolution(thread.id, "a2")
    ).toThrow(/not resolving/);
  });

  it("getThread returns null for unknown id", () => {
    const result = consultation.getThread("non-existent-id");
    expect(result).toBeNull();
  });

  it("getThreadWithMessages returns null for unknown id", () => {
    const result = consultation.getThreadWithMessages("non-existent-id");
    expect(result).toBeNull();
  });

  it("checkTimeouts does nothing when no threads are timed out", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Fresh thread",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // Thread was just created â€” should not time out
    expect(() => consultation.checkTimeouts()).not.toThrow();
    const updated = consultation.getThread(thread.id);
    expect(updated!.status).toBe("open");
  });

  it("getActionSummariesBySession returns only matching session entries", () => {
    consultation.logActionSummary({
      session_id: "session-A",
      agent_id: "a1",
      file_path: "src/auth/login.ts",
      summary: "Added login handler",
    });
    consultation.logActionSummary({
      session_id: "session-A",
      agent_id: "a2",
      file_path: "src/users/profile.ts",
      summary: "Updated profile schema",
    });
    consultation.logActionSummary({
      session_id: "session-B",
      agent_id: "a3",
      file_path: "src/api/routes.ts",
      summary: "Added new route",
    });

    const sessionA = consultation.getActionSummariesBySession("session-A");
    expect(sessionA).toHaveLength(2);
    expect(sessionA.every((s) => s.session_id === "session-A")).toBe(true);

    const sessionB = consultation.getActionSummariesBySession("session-B");
    expect(sessionB).toHaveLength(1);
    expect(sessionB[0].summary).toBe("Added new route");

    const sessionC = consultation.getActionSummariesBySession("session-C");
    expect(sessionC).toHaveLength(0);
  });

  it("announceWork stores depends_on_files and exports_affected", () => {
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth with deps",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
      depends_on_files: ["src/shared/types.ts", "src/config/env.ts"],
      exports_affected: ["AuthMiddleware", "validateToken"],
    });

    const stored = consultation.getThread(thread.id);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!.depends_on_files || "[]")).toEqual([
      "src/shared/types.ts",
      "src/config/env.ts",
    ]);
    expect(JSON.parse(stored!.exports_affected || "[]")).toEqual([
      "AuthMiddleware",
      "validateToken",
    ]);
  });

  it("handles agent departure mid-thread", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    registry.register("a3", "Agent C", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // a2 responds, a3 departs
    consultation.postToThread({
      thread_id: thread.id, agent_id: "a2", type: "context", content: "noted",
    });
    consultation.handleAgentDeparture("a3");
    // Propose and only a2 needs to approve
    consultation.proposeResolution(thread.id, "a1", "Keep compat");
    consultation.approveResolution(thread.id, "a2");
    const updated = consultation.getThread(thread.id);
    expect(updated!.status).toBe("resolved");
  });

  // â”€â”€ Unknown thread ID tests (Agent Alpha) â”€â”€

  it("postToThread throws on unknown thread_id", () => {
    expect(() =>
      consultation.postToThread({
        thread_id: "nonexistent-thread",
        agent_id: "a1",
        type: "context",
        content: "Hello",
      })
    ).toThrow(/not found/);
  });

  it("proposeResolution throws on unknown thread_id", () => {
    expect(() =>
      consultation.proposeResolution("nonexistent-thread", "a1", "My plan")
    ).toThrow(/not found/);
  });

  it("approveResolution throws on unknown thread_id", () => {
    expect(() =>
      consultation.approveResolution("nonexistent-thread", "a2")
    ).toThrow(/not found/);
  });

  it("contestResolution throws on unknown thread_id", () => {
    expect(() =>
      consultation.contestResolution("nonexistent-thread", "a2", "Disagree")
    ).toThrow(/not found/);
  });

  // â”€â”€ Filter and since parameter tests (Agent Alpha) â”€â”€

  it("listThreads filters by module", () => {
    consultation.announceWork({
      agent_id: "a1", subject: "Auth work", target_modules: ["src/auth"], target_files: [],
    });
    consultation.announceWork({
      agent_id: "a2", subject: "Users work", target_modules: ["src/users"], target_files: [],
    });
    const authThreads = consultation.listThreads({ module: "src/auth" });
    expect(authThreads.length).toBeGreaterThanOrEqual(1);
    expect(authThreads.every((t) => t.target_modules.includes("src/auth"))).toBe(true);
    expect(authThreads.some((t) => t.target_modules.includes("src/users") && !t.target_modules.includes("src/auth"))).toBe(false);
  });

  it("getThreadUpdates respects since parameter", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "Refactor auth", target_modules: ["src/auth"], target_files: [],
    });
    consultation.postToThread({
      thread_id: thread.id, agent_id: "a2", type: "context", content: "old message",
    });
    const since = new Date(Date.now() + 1000).toISOString();
    const updates = consultation.getThreadUpdates("a1", since);
    expect(updates).toHaveLength(0);
  });

  it("getActionSummaries respects since parameter", () => {
    consultation.logActionSummary({
      session_id: "s1", agent_id: "a1", file_path: "src/auth/old.ts", summary: "Old action",
    });
    const since = new Date(Date.now() + 60000).toISOString();
    const summaries = consultation.getActionSummaries("a1", since);
    expect(summaries).toHaveLength(0);
  });

  // â”€â”€ Edge case tests (Agent Delta) â”€â”€

  it("handleAgentDeparture resolves resolving thread when last respondent approved then departs", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    registry.register("a3", "Agent C", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Test departure resolving",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread({ thread_id: thread.id, agent_id: "a2", type: "context", content: "ok" });
    consultation.proposeResolution(thread.id, "a1", "Go ahead");
    consultation.approveResolution(thread.id, "a2");
    const midState = consultation.getThread(thread.id);
    expect(midState!.status).toBe("resolving");

    consultation.handleAgentDeparture("a3");
    const final = consultation.getThread(thread.id);
    expect(final!.status).toBe("resolved");
    const departureEvents = events.filter((e) => e.resolution_type === "agent_departure");
    expect(departureEvents.length).toBeGreaterThanOrEqual(1);
    expect(departureEvents[0].thread_id).toBe(thread.id);
  });

  it("checkTimeouts emits timeout with had_messages=true on thread that has messages", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Test timeout with messages",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread({
      thread_id: thread.id, agent_id: "a2", type: "context", content: "I have concerns",
    });

    const db = getDb();
    db.prepare("UPDATE threads SET created_at = datetime('now', '-5 minutes'), timeout_seconds = 1 WHERE id = ?")
      .run(thread.id);

    consultation.checkTimeouts();

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("timeout");
    expect(events[0].had_messages).toBe(true);
    expect(events[0].thread_id).toBe(thread.id);
  });

  it("emitResolution on nonexistent thread does nothing", () => {
    expect(() => consultation.emitResolution("nonexistent", "auto_resolved")).not.toThrow();
  });

  it("cancelThread on nonexistent thread throws", () => {
    expect(() => consultation.cancelThread("nonexistent", "a1", "reason")).toThrow(/not found/);
  });

  it("cancelThread without reason posts no message", () => {
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "Cancel test", target_modules: ["src/auth"], target_files: [],
    });
    consultation.cancelThread(thread.id, "a1");
    const full = consultation.getThreadWithMessages(thread.id);
    expect(full!.messages).toHaveLength(0);
  });

  it("getThreadUpdates with since returns matching messages", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "Updates test", target_modules: ["src/auth"], target_files: [],
    });
    const before = new Date(Date.now() - 60000).toISOString();
    consultation.postToThread({
      thread_id: thread.id, agent_id: "a2", type: "context", content: "recent message",
    });
    const updates = consultation.getThreadUpdates("a1", before);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].content).toBe("recent message");
  });

  // â”€â”€ Bug: closeThread missing validations (found by both Chasseurs) â”€â”€

  it("BUG: closeThread should throw on nonexistent thread but silently succeeds", () => {
    // cancelThread throws on nonexistent thread, but closeThread just does a blind UPDATE
    expect(() =>
      consultation.closeThread("nonexistent-thread-id", "a1", "Done")
    ).toThrow(/not found/);
  });

  it("BUG: closeThread allows non-initiator to close another agent's thread", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Owned by a1",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // a2 should NOT be able to close a1's thread
    expect(() =>
      consultation.closeThread(thread.id, "a2", "I'm closing your thread")
    ).toThrow(/initiator/);
  });

  it("BUG: closeThread allows closing an already cancelled thread", () => {
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Will be cancelled",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.cancelThread(thread.id, "a1", "cancelled");
    // closeThread should not allow re-closing a cancelled thread
    expect(() =>
      consultation.closeThread(thread.id, "a1", "Reopening from cancelled?")
    ).toThrow();
  });

  // â”€â”€ Bug: getThreadUpdates date normalization (Chasseur Alpha) â”€â”€

  it("BUG: getThreadUpdates fails with timezone offset dates like +05:00", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Date normalization test",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread({
      thread_id: thread.id, agent_id: "a2", type: "context", content: "test message",
    });
    // Using timezone offset format instead of Z â€” the normalization regex
    // \.\d+$ won't match because the string ends with ":00" not digits
    // So the normalized string keeps "+05:00" which SQLite can't compare
    const sinceWithOffset = "2020-01-01T00:00:00.000+05:00";
    const updates = consultation.getThreadUpdates("a1", sinceWithOffset);
    // Should find the message (since is in the past), but the malformed
    // normalization may cause SQLite to return wrong results
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  // â”€â”€ Bug: stale approvals across rounds (Chasseur Bravo) â”€â”€

  it("BUG: allRespondentsApproved should not count approvals from previous rounds", () => {
    registry.register("a2", "Agent B", ["src/auth"]);
    registry.register("a3", "Agent C", ["src/auth"]);

    const thread = consultation.announceWork({
      agent_id: "a1",
      subject: "Cross-round approval bug",
      target_modules: ["src/auth"],
      target_files: [],
    });

    // Round 1: a2 approves, a3 contests â†’ round goes to 2
    consultation.postToThread({ thread_id: thread.id, agent_id: "a2", type: "context", content: "ok" });
    consultation.postToThread({ thread_id: thread.id, agent_id: "a3", type: "context", content: "concerns" });
    consultation.proposeResolution(thread.id, "a1", "Plan A");
    consultation.approveResolution(thread.id, "a2");
    // a2 approved in round 1, but a3 contests
    consultation.contestResolution(thread.id, "a3", "Breaks my cache");
    const afterContest = consultation.getThread(thread.id);
    expect(afterContest!.status).toBe("open");
    expect(afterContest!.round).toBe(2);

    // Round 2: propose again, only a3 approves this time
    // a2's approval from round 1 should NOT carry over
    consultation.proposeResolution(thread.id, "a1", "Plan B â€” adjusted");
    consultation.approveResolution(thread.id, "a3");

    const final = consultation.getThread(thread.id);
    // BUG: thread resolves because a2's stale round-1 approval is still counted
    // Expected: thread should still be "resolving" waiting for a2's round-2 approval
    expect(final!.status).toBe("resolving");
  });

  // â”€â”€ Bug: listThreads module LIKE on JSON is fragile (Chasseur Bravo) â”€â”€

  it("BUG: listThreads module filter should not match partial module names", () => {
    consultation.announceWork({
      agent_id: "a1",
      subject: "API work",
      target_modules: ["src/api"],
      target_files: [],
    });
    consultation.announceWork({
      agent_id: "a2",
      subject: "API Gateway work",
      target_modules: ["src/api-gateway"],
      target_files: [],
    });

    const filtered = consultation.listThreads({ module: "src/api" });
    // BUG: LIKE '%src/api%' also matches 'src/api-gateway'
    // All returned threads should contain exactly "src/api" in target_modules
    const allMatchExact = filtered.every((t) => {
      const modules: string[] = JSON.parse(t.target_modules);
      return modules.includes("src/api");
    });
    expect(allMatchExact).toBe(true);
  });
});


