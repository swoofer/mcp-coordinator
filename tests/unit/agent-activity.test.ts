// tests/agent-activity.test.ts - TDD RED phase
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { AgentActivityTracker } from "../../src/agent-activity.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import fs from "fs";

const TEST_DIR = "data-test-activity";
let registry: AgentRegistry;
let tracker: AgentActivityTracker;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  // v0.9 (issue #79): FK on agents.org_id → orgs(id) needs the org rows
  // referenced by the org-scoping tests to already exist.
  seedTestOrgs(getDb(), ["org-a", "org-b", "orgA", "orgB"]);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM agent_activity_status");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
  tracker = new AgentActivityTracker(registry);
  registry.register("default", "a1", "Agent Alpha", ["src/auth"]);
  registry.register("default", "a2", "Agent Beta", ["src/shared"]);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("AgentActivityTracker", () => {
  // -- Core status transitions --

  it("new agent starts as idle", () => {
    const activity = tracker.getActivity("default", "a1");
    expect(activity.activity_status).toBe("idle");
    expect(activity.current_file).toBeNull();
    expect(activity.current_thread).toBeNull();
  });

  it("transitions to working when file activity reported", () => {
    tracker.reportFileActivity("default", "a1", "src/auth/login.ts");
    const activity = tracker.getActivity("default", "a1");
    expect(activity.activity_status).toBe("working");
    expect(activity.current_file).toBe("src/auth/login.ts");
  });

  it("transitions to waiting when thread is open", () => {
    tracker.reportWaiting("default", "a1", "thread-123");
    const activity = tracker.getActivity("default", "a1");
    expect(activity.activity_status).toBe("waiting");
    expect(activity.current_thread).toBe("thread-123");
  });

  it("transitions back to working after waiting", () => {
    tracker.reportWaiting("default", "a1", "thread-123");
    tracker.reportFileActivity("default", "a1", "src/auth/login.ts");
    const activity = tracker.getActivity("default", "a1");
    expect(activity.activity_status).toBe("working");
    expect(activity.current_thread).toBeNull();
  });

  it("transitions to offline when agent goes offline", () => {
    tracker.reportFileActivity("default", "a1", "src/auth/login.ts");
    tracker.reportOffline("default", "a1");
    const activity = tracker.getActivity("default", "a1");
    expect(activity.activity_status).toBe("offline");
    expect(activity.current_file).toBeNull();
    expect(activity.current_thread).toBeNull();
  });

  it("transitions to idle after inactivity timeout", () => {
    tracker.reportFileActivity("default", "a1", "src/auth/login.ts");
    // Simulate old timestamp
    const db = getDb();
    db.prepare(
      "UPDATE agent_activity_status SET last_activity_at = datetime('now', '-10 minutes') WHERE agent_id = ?",
    ).run("a1");
    const activity = tracker.getActivity("default", "a1", { idleAfterMinutes: 5 });
    expect(activity.activity_status).toBe("idle");
  });

  // -- Heartbeat enrichi --

  it("heartbeat updates last_activity_at and current state", () => {
    tracker.heartbeat("default", "a1", { currentFile: "src/auth/login.ts", currentThread: null });
    const activity = tracker.getActivity("default", "a1");
    expect(activity.activity_status).toBe("working");
    expect(activity.current_file).toBe("src/auth/login.ts");
  });

  it("heartbeat with no file and no thread -> idle", () => {
    tracker.heartbeat("default", "a1", { currentFile: null, currentThread: null });
    const activity = tracker.getActivity("default", "a1");
    expect(activity.activity_status).toBe("idle");
  });

  it("heartbeat with thread and no file -> waiting", () => {
    tracker.heartbeat("default", "a1", { currentFile: null, currentThread: "thread-456" });
    const activity = tracker.getActivity("default", "a1");
    expect(activity.activity_status).toBe("waiting");
    expect(activity.current_thread).toBe("thread-456");
  });

  // -- Listing --

  it("listAll returns activity for all online agents", () => {
    tracker.reportFileActivity("default", "a1", "src/auth/login.ts");
    tracker.reportWaiting("default", "a2", "thread-789");
    const all = tracker.listAll("default");
    expect(all).toHaveLength(2);
    const a1 = all.find((a) => a.agent_id === "a1");
    const a2 = all.find((a) => a.agent_id === "a2");
    expect(a1!.activity_status).toBe("working");
    expect(a2!.activity_status).toBe("waiting");
  });

  it("listAll includes idle agents with no activity record", () => {
    // a1 and a2 are online but have no activity recorded
    const all = tracker.listAll("default");
    expect(all).toHaveLength(2);
    expect(all.every((a) => a.activity_status === "idle")).toBe(true);
  });

  it("listAll excludes offline agents", () => {
    registry.setOffline("default", "a2");
    const all = tracker.listAll("default");
    expect(all).toHaveLength(1);
    expect(all[0].agent_id).toBe("a1");
  });

  // -- Edge cases --

  it("getActivity for unknown agent returns offline", () => {
    const activity = tracker.getActivity("default", "unknown-agent");
    expect(activity.activity_status).toBe("offline");
  });

  it("reportFileActivity updates current_file on repeated calls", () => {
    tracker.reportFileActivity("default", "a1", "src/auth/login.ts");
    tracker.reportFileActivity("default", "a1", "src/auth/validate.ts");
    const activity = tracker.getActivity("default", "a1");
    expect(activity.current_file).toBe("src/auth/validate.ts");
  });

  it("preserves activity across heartbeats", () => {
    tracker.reportFileActivity("default", "a1", "src/auth/login.ts");
    tracker.heartbeat("default", "a1", { currentFile: "src/auth/login.ts", currentThread: null });
    const activity = tracker.getActivity("default", "a1");
    expect(activity.activity_status).toBe("working");
    expect(activity.last_activity_at).toBeDefined();
  });

  it("stays working when activity is recent (not timed out)", () => {
    tracker.reportFileActivity("default", "a1", "src/auth/login.ts");
    // Don't backdate -- activity just happened
    const activity = tracker.getActivity("default", "a1", { idleAfterMinutes: 5 });
    expect(activity.activity_status).toBe("working");
  });
});

describe("agent-activity org_id scoping", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM agent_activity_status");
    // Register agents so FK (agent_id) -> agents(id) is satisfied.
    // idx_agents_id is UNIQUE on agents(id) alone, so agent-1/agent-2 can only live
    // in one org row -- we use 'default' but write activity rows for org-a/org-b.
    registry.register("default", "agent-1", "Agent One", []);
    registry.register("default", "agent-2", "Agent Two", []);
  });

  it("reportFileActivity writes org_id", () => {
    tracker.reportFileActivity("org-a", "agent-1", "x.ts");
    const row = getDb().prepare("SELECT org_id FROM agent_activity_status").get() as {
      org_id: string;
    };
    expect(row.org_id).toBe("org-a");
  });

  it("getStatus scopes by org", () => {
    tracker.reportFileActivity("org-a", "agent-1", "a.ts");
    tracker.reportFileActivity("org-b", "agent-1", "b.ts");
    expect(tracker.getStatus("org-a", "agent-1")?.current_file).toBe("a.ts");
    expect(tracker.getStatus("org-b", "agent-1")?.current_file).toBe("b.ts");
  });

  it("listActive scopes by org", () => {
    tracker.reportFileActivity("org-a", "agent-1", "a.ts");
    tracker.reportFileActivity("org-b", "agent-2", "b.ts");
    expect(tracker.listActive("org-a")).toHaveLength(1);
    expect(tracker.listActive("org-a")[0].agent_id).toBe("agent-1");
  });

  it("reportOffline scopes by org", () => {
    tracker.reportFileActivity("org-a", "agent-1", "x.ts");
    tracker.reportOffline("org-b", "agent-1"); // wrong org, no-op
    expect(tracker.getStatus("org-a", "agent-1")).not.toBeNull();
    tracker.reportOffline("org-a", "agent-1");
    expect(tracker.getStatus("org-a", "agent-1")?.activity_status).toBe("offline");
  });

  // -- Regression: #77 reportWaiting/heartbeat must thread real org_id --

  it("reportWaiting writes the caller's org_id (not 'default')", () => {
    tracker.reportWaiting("orgA", "agent-1", "thread-a");
    tracker.reportWaiting("orgB", "agent-2", "thread-b");

    const rowA = getDb()
      .prepare("SELECT org_id, current_thread FROM agent_activity_status WHERE agent_id = ?")
      .get("agent-1") as { org_id: string; current_thread: string };
    const rowB = getDb()
      .prepare("SELECT org_id, current_thread FROM agent_activity_status WHERE agent_id = ?")
      .get("agent-2") as { org_id: string; current_thread: string };

    expect(rowA.org_id).toBe("orgA");
    expect(rowA.current_thread).toBe("thread-a");
    expect(rowB.org_id).toBe("orgB");
    expect(rowB.current_thread).toBe("thread-b");
    // Neither row should be commingled under "default"
    expect(rowA.org_id).not.toBe("default");
    expect(rowB.org_id).not.toBe("default");
  });

  it("heartbeat writes the caller's org_id (not 'default')", () => {
    tracker.heartbeat("orgA", "agent-1", { currentFile: "a.ts", currentThread: null });
    tracker.heartbeat("orgB", "agent-2", { currentFile: null, currentThread: "thr-b" });

    const rowA = getDb()
      .prepare(
        "SELECT org_id, activity_status, current_file FROM agent_activity_status WHERE agent_id = ?",
      )
      .get("agent-1") as { org_id: string; activity_status: string; current_file: string };
    const rowB = getDb()
      .prepare(
        "SELECT org_id, activity_status, current_thread FROM agent_activity_status WHERE agent_id = ?",
      )
      .get("agent-2") as { org_id: string; activity_status: string; current_thread: string };

    expect(rowA.org_id).toBe("orgA");
    expect(rowA.activity_status).toBe("working");
    expect(rowA.current_file).toBe("a.ts");
    expect(rowB.org_id).toBe("orgB");
    expect(rowB.activity_status).toBe("waiting");
    expect(rowB.current_thread).toBe("thr-b");
    expect(rowA.org_id).not.toBe("default");
    expect(rowB.org_id).not.toBe("default");
  });
});
