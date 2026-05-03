import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import fs from "fs";

const TEST_DIR = "data-test-registry";
let registry: AgentRegistry;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM action_summaries");
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("AgentRegistry", () => {
  it("registers and lists agents", () => {
    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/users"]);
    const online = registry.listOnline();
    expect(online).toHaveLength(2);
    expect(online[0].name).toBe("Agent A");
  });

  it("sets agent offline", () => {
    registry.register("a1", "Agent A", ["src/auth"]);
    registry.setOffline("a1");
    expect(registry.listOnline()).toHaveLength(0);
    const all = registry.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("offline");
  });

  it("re-registers brings agent back online", () => {
    registry.register("a1", "Agent A", ["src/auth"]);
    registry.setOffline("a1");
    registry.register("a1", "Agent A", ["src/auth", "src/api"]);
    const agent = registry.get("a1");
    expect(agent?.status).toBe("online");
    expect(JSON.parse(agent!.modules)).toContain("src/api");
  });

  it("heartbeat updates last_seen_at", () => {
    registry.register("a1", "Agent A", []);
    registry.heartbeat("a1");
    const after = registry.get("a1")!.last_seen_at;
    expect(after).toBeDefined();
  });

  it("returns undefined for unknown agent", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("setOnline() brings an offline agent back online", () => {
    registry.register("a1", "Agent A", ["src/auth"]);
    registry.setOffline("a1");
    expect(registry.get("a1")?.status).toBe("offline");
    registry.setOnline("a1");
    const agent = registry.get("a1");
    expect(agent?.status).toBe("online");
  });
});


