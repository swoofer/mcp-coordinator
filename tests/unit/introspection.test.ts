import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { IntrospectionManager } from "../../src/introspection.js";
import { Consultation } from "../../src/consultation.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import fs from "fs";

const TEST_DIR = "data-test-introspection";
let registry: AgentRegistry;
let introspection: IntrospectionManager;
let consultation: Consultation;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  // v0.9 (issue #79): FK on introspections/threads/agents.org_id → orgs(id).
  seedTestOrgs(getDb(), ["org-a", "org-b"]);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM introspections");
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM action_summaries");
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
  introspection = new IntrospectionManager();
  consultation = new Consultation();
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("IntrospectionManager", () => {
  it("creates and retrieves an introspection", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.register("default", "a2", "Agent B", ["src/shared"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "test",
      target_modules: ["src/shared"],
      target_files: [],
    });
    const intro = introspection.create("default", {
      thread_id: thread.id,
      agent_id: "a2",
      score: 45,
      reasons: ["module overlap: src/shared"],
    });
    expect(intro.status).toBe("pending");
    expect(intro.score).toBe(45);
  });

  it("responds as concerned", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.register("default", "a2", "Agent B", ["src/shared"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "test",
      target_modules: ["src/shared"],
      target_files: [],
    });
    const intro = introspection.create("default", {
      thread_id: thread.id,
      agent_id: "a2",
      score: 45,
      reasons: ["module overlap"],
    });
    const updated = introspection.respond("default", intro.id, "J'importe User dans mon service");
    expect(updated?.status).toBe("responded");
    expect(updated?.response).toContain("User");
    expect(updated?.responded_at).toBeDefined();
  });

  it("responds as not concerned", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.register("default", "a2", "Agent B", ["src/shared"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "test",
      target_modules: ["src/shared"],
      target_files: [],
    });
    const intro = introspection.create("default", {
      thread_id: thread.id,
      agent_id: "a2",
      score: 35,
      reasons: ["module overlap"],
    });
    const updated = introspection.respond(
      "default",
      intro.id,
      "Mon code n'utilise pas cette interface",
    );
    expect(updated?.status).toBe("responded");
    expect(updated?.response).toContain("interface");
  });

  it("lists pending introspections for an agent", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.register("default", "a2", "Agent B", ["src/shared"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "test",
      target_modules: ["src/shared"],
      target_files: [],
    });
    introspection.create("default", {
      thread_id: thread.id,
      agent_id: "a2",
      score: 40,
      reasons: ["overlap"],
    });
    introspection.create("default", {
      thread_id: thread.id,
      agent_id: "a2",
      score: 35,
      reasons: ["co-change"],
    });
    const pending = introspection.getPending("default", "a2");
    expect(pending).toHaveLength(2);
  });

  it("lists introspections by thread", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.register("default", "a2", "Agent B", ["src/shared"]);
    registry.register("default", "a3", "Agent C", ["src/users"]);
    const thread = consultation.announceWork("default", {
      agent_id: "a1",
      subject: "test",
      target_modules: ["src/shared"],
      target_files: [],
    });
    introspection.create("default", {
      thread_id: thread.id,
      agent_id: "a2",
      score: 45,
      reasons: ["overlap"],
    });
    introspection.create("default", {
      thread_id: thread.id,
      agent_id: "a3",
      score: 35,
      reasons: ["co-change"],
    });
    const all = introspection.getByThread("default", thread.id);
    expect(all).toHaveLength(2);
  });

  it("respond() with non-existent introspection_id returns null", () => {
    const result = introspection.respond("default", "non-existent-id", "Should not work");
    expect(result).toBeNull();
  });
});

describe("introspection org_id scoping", () => {
  // Agents and threads are FK-referenced by introspections. Register once
  // under "default" (agents.id is unique cross-org) then create threads for
  // each org so thread_id FKs are satisfied.
  let threadA: string;
  let threadB: string;

  beforeEach(() => {
    getDb().exec("DELETE FROM introspections");
    // Ensure agents exist (idempotent re-register is fine)
    registry = new AgentRegistry();
    registry.register("default", "a1", "Agent A", []);
    registry.register("default", "b1", "Agent B", []);
    // Create threads under org-a and org-b
    consultation = new Consultation();
    const tA = consultation.announceWork("org-a", {
      agent_id: "a1",
      subject: "s",
      target_modules: [],
      target_files: [],
    });
    const tB = consultation.announceWork("org-b", {
      agent_id: "b1",
      subject: "s",
      target_modules: [],
      target_files: [],
    });
    threadA = tA.id;
    threadB = tB.id;
  });

  it("create writes org_id", () => {
    introspection.create("org-a", { thread_id: threadA, agent_id: "a1", score: 5, reasons: "x" });
    const row = getDb().prepare("SELECT org_id FROM introspections").get() as { org_id: string };
    expect(row.org_id).toBe("org-a");
  });

  it("getPending scopes by org", () => {
    introspection.create("org-a", { thread_id: threadA, agent_id: "a1", score: 5, reasons: "x" });
    introspection.create("org-b", { thread_id: threadB, agent_id: "b1", score: 5, reasons: "y" });
    const pendingA = introspection.getPending("org-a", "a1");
    expect(pendingA).toHaveLength(1);
    expect(pendingA[0].thread_id).toBe(threadA);
  });

  it("respond scopes by org (cannot respond cross-org)", () => {
    const r = introspection.create("org-a", {
      thread_id: threadA,
      agent_id: "a1",
      score: 5,
      reasons: "x",
    });
    introspection.respond("org-b", r.id, "wrong-org-response"); // no-op
    expect(introspection.list("org-a", threadA)[0].response).toBeNull();
    introspection.respond("org-a", r.id, "correct-response");
    expect(introspection.list("org-a", threadA)[0].response).toBe("correct-response");
  });
});
