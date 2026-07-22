// tests/consultation.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation } from "../../src/consultation.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import fs from "fs";

const TEST_DIR = "data-test-consultation";
let consultation: Consultation;
let registry: AgentRegistry;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  // v0.9 (issue #79): FK on threads/thread_messages/agents/events.org_id
  // → orgs(id) needs the org rows referenced by the cross-org scoping tests.
  seedTestOrgs(getDb(), ["org-a", "org-b"]);
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
  registry.register("default", "a1", "Agent A", ["src/auth"]);
  registry.register("default", "a2", "Agent B", ["src/users"]);
  registry.register("default", "a3", "Agent C", ["src/api"]);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Consultation", () => {
  it("opens a thread with announce_work", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
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
    // Only a1 is online, a2 works on users, a3 on api â€" none overlap with auth
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth middleware",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
    });
    // expected_respondents should be empty since no other agent has src/auth
    const parsed = JSON.parse(thread.expected_respondents || "[]");
    expect(parsed).toHaveLength(0);
    // Thread should auto-resolve
    const updated = consultation.getThread("default", thread.id);
    expect(updated!.status).toBe("resolved");
  });

  it("identifies expected respondents based on module overlap", () => {
    registry.register("default", "a2", "Agent B", ["src/auth", "src/users"]);
    const thread = consultation.announceWork("default", {
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
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    const msg = consultation.postToThread("default", {
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
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "I depend on auth/types.ts",
    });
    consultation.proposeResolution("default", thread.id, "a1", "Keep interface compatible");
    const updated = consultation.getThread("default", thread.id);
    expect(updated!.status).toBe("resolving");
    expect(updated!.resolution_summary).toBe("Keep interface compatible");
  });

  it("approves resolution and resolves thread", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "noted",
    });
    consultation.proposeResolution("default", thread.id, "a1", "Keep interface compatible");
    consultation.approveResolution("default", thread.id, "a2");
    const updated = consultation.getThread("default", thread.id);
    expect(updated!.status).toBe("resolved");
    expect(updated!.resolved_at).toBeDefined();
  });

  it("contests resolution and returns to open", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "noted",
    });
    consultation.proposeResolution("default", thread.id, "a1", "Keep interface compatible");
    consultation.contestResolution("default", thread.id, "a2", "This will break my cache layer");
    const updated = consultation.getThread("default", thread.id);
    expect(updated!.status).toBe("open");
    expect(updated!.round).toBe(2);
  });

  it("cancels a thread", () => {
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.cancelThread("default", thread.id, "a1", "Changed my mind");
    const updated = consultation.getThread("default", thread.id);
    expect(updated!.status).toBe("cancelled");
  });

  it("lists threads with filters", () => {
    consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Task 1",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.announceWork("default", {
      agent_id: "a2",
      subject: "Task 2",
      target_modules: ["src/users"],
      target_files: [],
    });
    const all = consultation.listThreads("default", {});
    expect(all.length).toBeGreaterThanOrEqual(2);
    const byAgent = consultation.listThreads("default", { agent_id: "a1" });
    expect(byAgent.every((t) => t.initiator_id === "a1")).toBe(true);
  });

  it("announceWork records assigned_to for directed dispatch", () => {
    const thread = consultation.announceWork("default", {
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
    const thread = consultation.announceWork("default", {
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
    consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Open",
      target_modules: ["src/users"],
      target_files: [],
      keep_open: true,
    });
    // Directed at a2
    consultation.announceWork("default", {
      agent_id: "a1",
      subject: "For a2",
      target_modules: ["src/users"],
      target_files: [],
      assigned_to: "a2",
    });
    // Directed at a3
    consultation.announceWork("default", {
      agent_id: "a1",
      subject: "For a3",
      target_modules: ["src/api"],
      target_files: [],
      assigned_to: "a3",
    });

    const forA2 = consultation.listThreads("default", { assigned_to_me: "a2" });
    const subjects = forA2.map((t) => t.subject).sort();
    // a2 sees: the open-pool one + its own directed one. NOT a3's.
    expect(subjects).toContain("Open");
    expect(subjects).toContain("For a2");
    expect(subjects).not.toContain("For a3");
  });

  it("gets thread with messages", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "noted",
    });
    const full = consultation.getThreadWithMessages("default", thread.id);
    expect(full!.thread.id).toBe(thread.id);
    expect(full!.messages).toHaveLength(1);
  });

  it("logs action summaries", () => {
    consultation.logActionSummary("default", {
      session_id: "s1",
      agent_id: "a1",
      file_path: "src/auth/middleware.ts",
      summary: "Added JWT validation middleware",
    });
    const summaries = consultation.getActionSummaries("default", "a1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).toBe("Added JWT validation middleware");
  });

  it("gets thread updates since timestamp", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    const since = new Date().toISOString();
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "new info",
    });
    const updates = consultation.getThreadUpdates("default", "a1", since);
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it("auto-resolves thread on timeout", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "test timeout",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // Manually set created_at to 5 minutes ago and timeout to 1 second
    const db = getDb();
    db.prepare(
      "UPDATE threads SET created_at = datetime('now', '-5 minutes'), timeout_seconds = 1 WHERE id = ?",
    ).run(thread.id);

    // B2: timeout check no longer a getThread side-effect; call sweeper directly.
    consultation.checkTimeouts();
    const updated = consultation.getThread("default", thread.id);
    expect(updated!.status).toBe("resolved");
    expect(updated!.resolution_summary).toContain("timeout");
  });

  // â"€â"€ Resolution event tests â"€â"€

  it("emits consensus resolution event on approve", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Test consensus",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "ok",
    });
    consultation.proposeResolution("default", thread.id, "a1", "Agreed");
    consultation.approveResolution("default", thread.id, "a2", "Agent B");

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

    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Test auto",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // Simulate external auto-resolve (normally done by server-setup.ts)
    consultation.emitResolution(thread.id, "auto_resolved");

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("auto_resolved");
    expect(events[0].had_messages).toBe(false);
  });

  it("emits timeout resolution event", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Test timeout event",
      target_modules: ["src/auth"],
      target_files: [],
    });
    const db = getDb();
    db.prepare(
      "UPDATE threads SET created_at = datetime('now', '-5 minutes'), timeout_seconds = 1 WHERE id = ?",
    ).run(thread.id);

    consultation.checkTimeouts(); // B2: explicit call (no longer a getThread side-effect)

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("timeout");
    expect(events[0].thread_id).toBe(thread.id);
  });

  it("emits max_rounds resolution event", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Test max rounds",
      target_modules: ["src/auth"],
      target_files: [],
    });
    const db = getDb();
    db.prepare("UPDATE threads SET max_rounds = 1 WHERE id = ?").run(thread.id);

    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "ok",
    });
    consultation.proposeResolution("default", thread.id, "a1", "Plan A");
    consultation.contestResolution("default", thread.id, "a2", "Disagree");

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("max_rounds");
  });

  it("emits closed resolution event", () => {
    // Register another agent with overlapping modules so the thread stays open
    // (auto-resolves to 'resolved' if no concerned agents, which would prevent manual close)
    registry.register("default", "a-overlap", "Overlap", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Test close",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.closeThread("default", thread.id, "a1", "Done manually");

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("closed");
    expect(events[0].resolution_summary).toBe("Done manually");
  });

  it("emits agent_departure resolution event", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Test departure",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.handleAgentDeparture("default", "a2");

    expect(events).toHaveLength(1);
    expect(events[0].resolution_type).toBe("agent_departure");
  });

  it("had_messages is true when thread has messages", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Test messages",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "warning",
      content: "watch out",
    });
    consultation.proposeResolution("default", thread.id, "a1", "Noted");
    consultation.approveResolution("default", thread.id, "a2");

    expect(events[0].had_messages).toBe(true);
  });

  it("had_messages is false when thread has no user messages", () => {
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "No messages",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.emitResolution(thread.id, "auto_resolved");

    expect(events[0].had_messages).toBe(false);
  });

  // â"€â"€ Additional branch coverage tests â"€â"€

  it("postToThread on non-open thread throws", () => {
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.cancelThread("default", thread.id, "a1", "Changed my mind");
    expect(() =>
      consultation.postToThread("default", {
        thread_id: thread.id,
        agent_id: "a2",
        type: "context",
        content: "Too late",
      }),
    ).toThrow(/cancelled/);
  });

  it("proposeResolution by non-initiator throws", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(() =>
      consultation.proposeResolution("default", thread.id, "a2", "My resolution"),
    ).toThrow(/initiator/);
  });

  it("cancelThread by non-initiator throws", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(() => consultation.cancelThread("default", thread.id, "a2", "I want to cancel")).toThrow(
      /initiator/,
    );
  });

  it("contestResolution on non-resolving thread throws", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // Thread is still "open", not "resolving"
    expect(() => consultation.contestResolution("default", thread.id, "a2", "Disagree")).toThrow(
      /not resolving/,
    );
  });

  it("approveResolution on non-resolving thread throws", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // Thread is still "open", not "resolving"
    expect(() => consultation.approveResolution("default", thread.id, "a2")).toThrow(
      /not resolving/,
    );
  });

  it("getThread returns null for unknown id", () => {
    const result = consultation.getThread("default", "non-existent-id");
    expect(result).toBeNull();
  });

  it("getThreadWithMessages returns null for unknown id", () => {
    const result = consultation.getThreadWithMessages("default", "non-existent-id");
    expect(result).toBeNull();
  });

  it("checkTimeouts does nothing when no threads are timed out", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Fresh thread",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // Thread was just created â€" should not time out
    expect(() => consultation.checkTimeouts()).not.toThrow();
    const updated = consultation.getThread("default", thread.id);
    expect(updated!.status).toBe("open");
  });

  it("getActionSummariesBySession returns only matching session entries", () => {
    consultation.logActionSummary("default", {
      session_id: "session-A",
      agent_id: "a1",
      file_path: "src/auth/login.ts",
      summary: "Added login handler",
    });
    consultation.logActionSummary("default", {
      session_id: "session-A",
      agent_id: "a2",
      file_path: "src/users/profile.ts",
      summary: "Updated profile schema",
    });
    consultation.logActionSummary("default", {
      session_id: "session-B",
      agent_id: "a3",
      file_path: "src/api/routes.ts",
      summary: "Added new route",
    });

    const sessionA = consultation.getActionSummariesBySession("default", "session-A");
    expect(sessionA).toHaveLength(2);
    expect(sessionA.every((s) => s.session_id === "session-A")).toBe(true);

    const sessionB = consultation.getActionSummariesBySession("default", "session-B");
    expect(sessionB).toHaveLength(1);
    expect(sessionB[0].summary).toBe("Added new route");

    const sessionC = consultation.getActionSummariesBySession("default", "session-C");
    expect(sessionC).toHaveLength(0);
  });

  it("announceWork stores depends_on_files and exports_affected", () => {
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth with deps",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
      depends_on_files: ["src/shared/types.ts", "src/config/env.ts"],
      exports_affected: ["AuthMiddleware", "validateToken"],
    });

    const stored = consultation.getThread("default", thread.id);
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
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    registry.register("default", "a3", "Agent C", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // a2 responds, a3 departs
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "noted",
    });
    consultation.handleAgentDeparture("default", "a3");
    // Propose and only a2 needs to approve
    consultation.proposeResolution("default", thread.id, "a1", "Keep compat");
    consultation.approveResolution("default", thread.id, "a2");
    const updated = consultation.getThread("default", thread.id);
    expect(updated!.status).toBe("resolved");
  });

  // â"€â"€ Unknown thread ID tests (Agent Alpha) â"€â"€

  it("postToThread throws on unknown thread_id", () => {
    expect(() =>
      consultation.postToThread("default", {
        thread_id: "nonexistent-thread",
        agent_id: "a1",
        type: "context",
        content: "Hello",
      }),
    ).toThrow(/not found/);
  });

  it("proposeResolution throws on unknown thread_id", () => {
    expect(() =>
      consultation.proposeResolution("default", "nonexistent-thread", "a1", "My plan"),
    ).toThrow(/not found/);
  });

  it("approveResolution throws on unknown thread_id", () => {
    expect(() => consultation.approveResolution("default", "nonexistent-thread", "a2")).toThrow(
      /not found/,
    );
  });

  it("contestResolution throws on unknown thread_id", () => {
    expect(() =>
      consultation.contestResolution("default", "nonexistent-thread", "a2", "Disagree"),
    ).toThrow(/not found/);
  });

  // â"€â"€ Filter and since parameter tests (Agent Alpha) â"€â"€

  it("listThreads filters by module", () => {
    consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Auth work",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.announceWork("default", {
      agent_id: "a2",
      subject: "Users work",
      target_modules: ["src/users"],
      target_files: [],
    });
    const authThreads = consultation.listThreads("default", { module: "src/auth" });
    expect(authThreads.length).toBeGreaterThanOrEqual(1);
    expect(authThreads.every((t) => t.target_modules.includes("src/auth"))).toBe(true);
    expect(
      authThreads.some(
        (t) => t.target_modules.includes("src/users") && !t.target_modules.includes("src/auth"),
      ),
    ).toBe(false);
  });

  it("getThreadUpdates respects since parameter", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Refactor auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "old message",
    });
    const since = new Date(Date.now() + 1000).toISOString();
    const updates = consultation.getThreadUpdates("default", "a1", since);
    expect(updates).toHaveLength(0);
  });

  it("getActionSummaries respects since parameter", () => {
    consultation.logActionSummary("default", {
      session_id: "s1",
      agent_id: "a1",
      file_path: "src/auth/old.ts",
      summary: "Old action",
    });
    const since = new Date(Date.now() + 60000).toISOString();
    const summaries = consultation.getActionSummaries("default", "a1", since);
    expect(summaries).toHaveLength(0);
  });

  // â"€â"€ Edge case tests (Agent Delta) â"€â"€

  it("handleAgentDeparture resolves resolving thread when last respondent approved then departs", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    registry.register("default", "a3", "Agent C", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Test departure resolving",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "ok",
    });
    consultation.proposeResolution("default", thread.id, "a1", "Go ahead");
    consultation.approveResolution("default", thread.id, "a2");
    const midState = consultation.getThread("default", thread.id);
    expect(midState!.status).toBe("resolving");

    consultation.handleAgentDeparture("default", "a3");
    const final = consultation.getThread("default", thread.id);
    expect(final!.status).toBe("resolved");
    const departureEvents = events.filter((e) => e.resolution_type === "agent_departure");
    expect(departureEvents.length).toBeGreaterThanOrEqual(1);
    expect(departureEvents[0].thread_id).toBe(thread.id);
  });

  it("checkTimeouts emits timeout with had_messages=true on thread that has messages", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const events: any[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Test timeout with messages",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "I have concerns",
    });

    const db = getDb();
    db.prepare(
      "UPDATE threads SET created_at = datetime('now', '-5 minutes'), timeout_seconds = 1 WHERE id = ?",
    ).run(thread.id);

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
    expect(() => consultation.cancelThread("default", "nonexistent", "a1", "reason")).toThrow(
      /not found/,
    );
  });

  it("cancelThread without reason posts no message", () => {
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Cancel test",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.cancelThread("default", thread.id, "a1");
    const full = consultation.getThreadWithMessages("default", thread.id);
    expect(full!.messages).toHaveLength(0);
  });

  it("getThreadUpdates with since returns matching messages", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Updates test",
      target_modules: ["src/auth"],
      target_files: [],
    });
    const before = new Date(Date.now() - 60000).toISOString();
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "recent message",
    });
    const updates = consultation.getThreadUpdates("default", "a1", before);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].content).toBe("recent message");
  });

  // â"€â"€ Bug: closeThread missing validations (found by both Chasseurs) â"€â"€

  it("BUG: closeThread should throw on nonexistent thread but silently succeeds", () => {
    // cancelThread throws on nonexistent thread, but closeThread just does a blind UPDATE
    expect(() =>
      consultation.closeThread("default", "nonexistent-thread-id", "a1", "Done"),
    ).toThrow(/not found/);
  });

  it("BUG: closeThread allows non-initiator to close another agent's thread", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Owned by a1",
      target_modules: ["src/auth"],
      target_files: [],
    });
    // a2 should NOT be able to close a1's thread
    expect(() =>
      consultation.closeThread("default", thread.id, "a2", "I'm closing your thread"),
    ).toThrow(/initiator/);
  });

  it("BUG: closeThread allows closing an already cancelled thread", () => {
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Will be cancelled",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.cancelThread("default", thread.id, "a1", "cancelled");
    // closeThread should not allow re-closing a cancelled thread
    expect(() =>
      consultation.closeThread("default", thread.id, "a1", "Reopening from cancelled?"),
    ).toThrow();
  });

  // â"€â"€ Bug: getThreadUpdates date normalization (Chasseur Alpha) â"€â"€

  it("BUG: getThreadUpdates fails with timezone offset dates like +05:00", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Date normalization test",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "test message",
    });
    // Using timezone offset format instead of Z â€" the normalization regex
    // \.\d+$ won't match because the string ends with ":00" not digits
    // So the normalized string keeps "+05:00" which SQLite can't compare
    const sinceWithOffset = "2020-01-01T00:00:00.000+05:00";
    const updates = consultation.getThreadUpdates("default", "a1", sinceWithOffset);
    // Should find the message (since is in the past), but the malformed
    // normalization may cause SQLite to return wrong results
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  // â"€â"€ Bug: stale approvals across rounds (Chasseur Bravo) â"€â"€

  it("BUG: allRespondentsApproved should not count approvals from previous rounds", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    registry.register("default", "a3", "Agent C", ["src/auth"]);

    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Cross-round approval bug",
      target_modules: ["src/auth"],
      target_files: [],
    });

    // Round 1: a2 approves, a3 contests â†’ round goes to 2
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a2",
      type: "context",
      content: "ok",
    });
    consultation.postToThread("default", {
      thread_id: thread.id,
      agent_id: "a3",
      type: "context",
      content: "concerns",
    });
    consultation.proposeResolution("default", thread.id, "a1", "Plan A");
    consultation.approveResolution("default", thread.id, "a2");
    // a2 approved in round 1, but a3 contests
    consultation.contestResolution("default", thread.id, "a3", "Breaks my cache");
    const afterContest = consultation.getThread("default", thread.id);
    expect(afterContest!.status).toBe("open");
    expect(afterContest!.round).toBe(2);

    // Round 2: propose again, only a3 approves this time
    // a2's approval from round 1 should NOT carry over
    consultation.proposeResolution("default", thread.id, "a1", "Plan B - adjusted");
    consultation.approveResolution("default", thread.id, "a3");

    const final = consultation.getThread("default", thread.id);
    // BUG: thread resolves because a2's stale round-1 approval is still counted
    // Expected: thread should still be "resolving" waiting for a2's round-2 approval
    expect(final!.status).toBe("resolving");
  });

  // â"€â"€ Bug: listThreads module LIKE on JSON is fragile (Chasseur Bravo) â"€â"€

  it("BUG: listThreads module filter should not match partial module names", () => {
    consultation.announceWork("default", {
      agent_id: "a1",
      subject: "API work",
      target_modules: ["src/api"],
      target_files: [],
    });
    consultation.announceWork("default", {
      agent_id: "a2",
      subject: "API Gateway work",
      target_modules: ["src/api-gateway"],
      target_files: [],
    });

    const filtered = consultation.listThreads("default", { module: "src/api" });
    // BUG: LIKE '%src/api%' also matches 'src/api-gateway'
    // All returned threads should contain exactly "src/api" in target_modules
    const allMatchExact = filtered.every((t) => {
      const modules: string[] = JSON.parse(t.target_modules);
      return modules.includes("src/api");
    });
    expect(allMatchExact).toBe(true);
  });
});

describe("consultation org_id scoping", () => {
  // a1, a2, a3 are already registered in the outer beforeEach under org "default".
  // These tests reuse those existing agent IDs but assign threads to different orgs
  // to verify per-org isolation. FK on threads.initiator_id references agents(id)
  // (cross-org by design — it checks id existence, not org matching).
  beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM thread_messages; DELETE FROM threads;");
  });

  it("announceWork writes org_id", () => {
    const t = consultation.announceWork("org-a", {
      agent_id: "a1",
      subject: "subj",
      plan: "p",
      target_modules: [],
      target_files: [],
    });
    const row = getDb().prepare("SELECT org_id FROM threads WHERE id = ?").get(t.id) as {
      org_id: string;
    };
    expect(row.org_id).toBe("org-a");
  });

  it("listThreads scopes by org", () => {
    // a1 auto-resolves when announcing (no respondents) — status = "resolved"
    consultation.announceWork("org-a", {
      agent_id: "a1",
      subject: "A subj",
      target_modules: [],
      target_files: [],
    });
    consultation.announceWork("org-b", {
      agent_id: "a2",
      subject: "B subj",
      target_modules: [],
      target_files: [],
    });
    const aThreads = consultation.listThreads("org-a", { status: "resolved" });
    expect(aThreads.every((t) => t.subject === "A subj")).toBe(true);
    const bThreads = consultation.listThreads("org-b", { status: "resolved" });
    expect(bThreads.every((t) => t.subject === "B subj")).toBe(true);
  });

  it("getThread returns null for cross-org access", () => {
    const t = consultation.announceWork("org-a", {
      agent_id: "a1",
      subject: "subj",
      target_modules: [],
      target_files: [],
    });
    expect(consultation.getThread("org-b", t.id)).toBeNull();
    expect(consultation.getThread("org-a", t.id)?.id).toBe(t.id);
  });

  it("postToThread scopes by org", () => {
    const t = consultation.announceWork("org-a", {
      agent_id: "a1",
      subject: "subj",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    consultation.postToThread("org-a", {
      thread_id: t.id,
      agent_id: "a1",
      type: "context",
      content: "hi",
    });
    // Cross-org post must throw (thread not found in org-b)
    expect(() =>
      consultation.postToThread("org-b", {
        thread_id: t.id,
        agent_id: "a2",
        type: "context",
        content: "hi",
      }),
    ).toThrow(/not found|not in org/i);
  });

  it("proposeResolution cannot operate on a thread in another org", () => {
    const t = consultation.announceWork("org-a", {
      agent_id: "a1",
      subject: "subj",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    expect(() => consultation.proposeResolution("org-b", t.id, "a1", "summary")).toThrow(
      /not found/i,
    );
    expect(() => consultation.proposeResolution("org-a", t.id, "a1", "summary")).not.toThrow();
  });

  it("approveResolution / contestResolution / cancelThread / closeThread reject cross-org access", () => {
    // Each state-transition method must refuse to mutate a thread it cannot see.
    const t = consultation.announceWork("org-a", {
      agent_id: "a1",
      subject: "subj",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    consultation.postToThread("org-a", {
      thread_id: t.id,
      agent_id: "a2",
      type: "context",
      content: "respond",
    });
    consultation.proposeResolution("org-a", t.id, "a1", "summary");

    expect(() => consultation.approveResolution("org-b", t.id, "a2")).toThrow(/not found/i);
    expect(() => consultation.contestResolution("org-b", t.id, "a2", "no")).toThrow(/not found/i);
    expect(() => consultation.cancelThread("org-b", t.id, "a1")).toThrow(/not found/i);
    expect(() => consultation.closeThread("org-b", t.id, "a1", "done")).toThrow(/not found/i);

    // Sanity: same-org calls still work.
    expect(() => consultation.contestResolution("org-a", t.id, "a2", "no")).not.toThrow();
  });

  it("getThreadUpdates does not leak messages from other orgs' threads", () => {
    // org-a has a thread with one message; org-b also opens one with a message.
    const tA = consultation.announceWork("org-a", {
      agent_id: "a1",
      subject: "A",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    consultation.postToThread("org-a", {
      thread_id: tA.id,
      agent_id: "a2",
      type: "context",
      content: "A-msg",
    });
    const tB = consultation.announceWork("org-b", {
      agent_id: "a3",
      subject: "B",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    consultation.postToThread("org-b", {
      thread_id: tB.id,
      agent_id: "a2",
      type: "context",
      content: "B-msg",
    });

    // a2 is "interested in" both orgs (registered globally), but the org-scoped query must only show one side.
    const updatesA = consultation.getThreadUpdates("org-a", "a2");
    const updatesB = consultation.getThreadUpdates("org-b", "a2");
    const aContents = updatesA.map((u) => u.content);
    const bContents = updatesB.map((u) => u.content);
    expect(aContents).not.toContain("B-msg");
    expect(bContents).not.toContain("A-msg");
  });
});

describe("consultation corrupted column resilience (qualite-code-07)", () => {
  it("announceWork does not throw when an online peer's agents.modules column is corrupted", () => {
    getDb()
      .prepare("UPDATE agents SET modules = ? WHERE org_id = 'default' AND id = 'a2'")
      .run("{not valid json");

    expect(() => {
      const thread = consultation.announceWork("default", {
        agent_id: "a1",
        subject: "Work on auth",
        target_modules: ["src/auth"],
        target_files: [],
      });
      expect(thread.id).toBeTruthy();
    }).not.toThrow();
  });

  it("handleAgentDeparture does not throw when a thread's expected_respondents column is corrupted", () => {
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Work on auth",
      target_modules: ["src/auth"],
      target_files: [],
      keep_open: true,
    });
    getDb()
      .prepare("UPDATE threads SET expected_respondents = ? WHERE id = ?")
      .run("TRUNCATED[", thread.id);

    expect(() => consultation.handleAgentDeparture("default", "a2")).not.toThrow();
    const updated = consultation.getThread("default", thread.id);
    // Corrupted column parses to [] — filtering a2 out of [] is still [].
    expect(updated?.expected_respondents).toBe("[]");
  });

  it("approveResolution does not throw when the thread's expected_respondents column is corrupted", () => {
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "Work on auth",
      target_modules: ["src/auth"],
      target_files: [],
      keep_open: true,
    });
    getDb()
      .prepare("UPDATE threads SET expected_respondents = ? WHERE id = ?")
      .run("not-json-at-all", thread.id);
    consultation.proposeResolution("default", thread.id, "a1", "done");

    expect(() => consultation.approveResolution("default", thread.id, "a1")).not.toThrow();
  });
});
