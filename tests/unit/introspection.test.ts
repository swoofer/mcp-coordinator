import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { IntrospectionManager } from "../../src/introspection.js";
import { Consultation } from "../../src/consultation.js";
import fs from "fs";

const TEST_DIR = "data-test-introspection";
let registry: AgentRegistry;
let introspection: IntrospectionManager;
let consultation: Consultation;

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
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "test", target_modules: ["src/shared"], target_files: [],
    });
    const intro = introspection.create({
      thread_id: thread.id, agent_id: "a2", score: 45, reasons: ["module overlap: src/shared"],
    });
    expect(intro.status).toBe("pending");
    expect(intro.score).toBe(45);
  });

  it("responds as concerned", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.register("default", "a2", "Agent B", ["src/shared"]);
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "test", target_modules: ["src/shared"], target_files: [],
    });
    const intro = introspection.create({
      thread_id: thread.id, agent_id: "a2", score: 45, reasons: ["module overlap"],
    });
    const updated = introspection.respond(intro.id, true, "J'importe User dans mon service");
    expect(updated.status).toBe("concerned");
    expect(updated.concerned).toBe(1);
    expect(updated.response).toContain("User");
    expect(updated.responded_at).toBeDefined();
  });

  it("responds as not concerned", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.register("default", "a2", "Agent B", ["src/shared"]);
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "test", target_modules: ["src/shared"], target_files: [],
    });
    const intro = introspection.create({
      thread_id: thread.id, agent_id: "a2", score: 35, reasons: ["module overlap"],
    });
    const updated = introspection.respond(intro.id, false, "Mon code n'utilise pas cette interface");
    expect(updated.status).toBe("not_concerned");
    expect(updated.concerned).toBe(0);
  });

  it("lists pending introspections for an agent", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.register("default", "a2", "Agent B", ["src/shared"]);
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "test", target_modules: ["src/shared"], target_files: [],
    });
    introspection.create({ thread_id: thread.id, agent_id: "a2", score: 40, reasons: ["overlap"] });
    introspection.create({ thread_id: thread.id, agent_id: "a2", score: 35, reasons: ["co-change"] });
    const pending = introspection.getPending("a2");
    expect(pending).toHaveLength(2);
  });

  it("lists introspections by thread", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.register("default", "a2", "Agent B", ["src/shared"]);
    registry.register("default", "a3", "Agent C", ["src/users"]);
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "test", target_modules: ["src/shared"], target_files: [],
    });
    introspection.create({ thread_id: thread.id, agent_id: "a2", score: 45, reasons: ["overlap"] });
    introspection.create({ thread_id: thread.id, agent_id: "a3", score: 35, reasons: ["co-change"] });
    const all = introspection.getByThread(thread.id);
    expect(all).toHaveLength(2);
  });

  it("respond() with non-existent introspection_id returns null", () => {
    const result = introspection.respond("non-existent-id", true, "Should not work");
    expect(result).toBeNull();
  });
});



