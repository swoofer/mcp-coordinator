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
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.register("default", "a2", "Agent B", ["src/users"]);
    const online = registry.listOnline("default");
    expect(online).toHaveLength(2);
    expect(online[0].name).toBe("Agent A");
  });

  it("sets agent offline", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.setOffline("default", "a1");
    expect(registry.listOnline("default")).toHaveLength(0);
    const all = registry.listAll("default");
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("offline");
  });

  it("re-registers brings agent back online", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.setOffline("default", "a1");
    registry.register("default", "a1", "Agent A", ["src/auth", "src/api"]);
    const agent = registry.get("default", "a1");
    expect(agent?.status).toBe("online");
    expect(JSON.parse(agent!.modules)).toContain("src/api");
  });

  it("heartbeat updates last_seen_at", () => {
    registry.register("default", "a1", "Agent A", []);
    registry.heartbeat("default", "a1");
    const after = registry.get("default", "a1")!.last_seen_at;
    expect(after).toBeDefined();
  });

  it("returns undefined for unknown agent", () => {
    expect(registry.get("default", "nonexistent")).toBeUndefined();
  });

  it("setOnline() brings an offline agent back online", () => {
    registry.register("default", "a1", "Agent A", ["src/auth"]);
    registry.setOffline("default", "a1");
    expect(registry.get("default", "a1")?.status).toBe("offline");
    registry.setOnline("default", "a1");
    const agent = registry.get("default", "a1");
    expect(agent?.status).toBe("online");
  });
});

describe("agent-registry org_id scoping", () => {
  beforeEach(() => { getDb().exec("DELETE FROM agents"); });

  it("register writes org_id", () => {
    registry.register("org-a", "agent-1", "Agent 1", []);
    const row = getDb().prepare("SELECT org_id FROM agents WHERE id = 'agent-1'").get() as { org_id: string };
    expect(row.org_id).toBe("org-a");
  });

  it("listOnline scopes by org", () => {
    registry.register("org-a", "agent-1", "A1", []);
    registry.register("org-b", "agent-2", "B1", []);
    const a = registry.listOnline("org-a");
    expect(a).toHaveLength(1);
    expect(a[0].id).toBe("agent-1");
  });

  it("get scopes by org (cannot fetch another org's agent)", () => {
    registry.register("org-a", "agent-1", "A1", []);
    expect(registry.get("org-b", "agent-1")).toBeUndefined();
    expect(registry.get("org-a", "agent-1")?.id).toBe("agent-1");
  });

  it("setOffline scopes by org", () => {
    registry.register("org-a", "agent-a-1", "A1", []);
    registry.register("org-b", "agent-b-1", "B1", []);
    registry.setOffline("org-a", "agent-a-1");
    expect(registry.get("org-a", "agent-a-1")?.status).toBe("offline");
    // Positive assertion — org-b's agent must still be online
    expect(registry.get("org-b", "agent-b-1")?.status).toBe("online");
  });
});


