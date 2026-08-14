import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import fs from "fs";

const TEST_DIR = "data-test-registry";
let registry: AgentRegistry;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  // v0.9 (issue #79): FK on agents.org_id → orgs(id) requires every org
  // referenced by the tests below to already exist as an orgs row.
  seedTestOrgs(getDb(), ["org-a", "org-b"]);
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
  beforeEach(() => {
    getDb().exec("DELETE FROM agents");
  });

  it("register writes org_id", () => {
    registry.register("org-a", "agent-1", "Agent 1", []);
    const row = getDb().prepare("SELECT org_id FROM agents WHERE id = 'agent-1'").get() as {
      org_id: string;
    };
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

  it("listAll scopes by org (does not include other orgs' agents)", () => {
    registry.register("org-a", "agent-1", "A1", []);
    registry.register("org-b", "agent-2", "B1", []);
    const a = registry.listAll("org-a");
    expect(a).toHaveLength(1);
    expect(a[0].id).toBe("agent-1");
  });

  it("setOnline scopes by org (does not flip another org's row)", () => {
    // Distinct agent IDs across orgs because Task 5.5's FK-preservation UNIQUE
    // INDEX on agents(id) blocks same-id-different-org. Scoping is still proven
    // by setOnline targeting one org while leaving the other untouched.
    registry.register("org-a", "agent-a-1", "A1", []);
    registry.register("org-b", "agent-b-1", "B1", []);
    registry.setOffline("org-a", "agent-a-1");
    registry.setOffline("org-b", "agent-b-1");
    registry.setOnline("org-a", "agent-a-1");
    expect(registry.get("org-a", "agent-a-1")?.status).toBe("online");
    expect(registry.get("org-b", "agent-b-1")?.status).toBe("offline");
    // Negative cross-scope: setOnline against the wrong org for an agent that
    // exists in the other org must no-op (not flip that other-org row).
    registry.setOnline("org-a", "agent-b-1");
    expect(registry.get("org-b", "agent-b-1")?.status).toBe("offline");
  });

  it("heartbeat scopes by org (only the calling org's last_seen_at advances)", async () => {
    registry.register("org-a", "agent-a-1", "A1", []);
    registry.register("org-b", "agent-b-1", "B1", []);
    const beforeB = registry.get("org-b", "agent-b-1")?.last_seen_at;
    // Wait long enough for SQLite's CURRENT_TIMESTAMP (1s resolution) to tick
    await new Promise((r) => setTimeout(r, 1100));
    registry.heartbeat("org-a", "agent-a-1");
    const afterA = registry.get("org-a", "agent-a-1")?.last_seen_at;
    const afterB = registry.get("org-b", "agent-b-1")?.last_seen_at;
    // org-a's last_seen_at advanced; org-b's is unchanged
    expect(afterA).not.toBe(beforeB);
    expect(afterB).toBe(beforeB);
    // Negative cross-scope: heartbeat against wrong org must not advance the
    // other-org row.
    await new Promise((r) => setTimeout(r, 1100));
    registry.heartbeat("org-a", "agent-b-1");
    const afterB2 = registry.get("org-b", "agent-b-1")?.last_seen_at;
    expect(afterB2).toBe(beforeB);
  });
  // Issue #231: agents.id carries a global UNIQUE index (idx_agents_id), which
  // is load-bearing for the FKs that still target agents(id). So the same agent
  // id genuinely cannot exist in two orgs yet. Until the schema migration lands,
  // the failure must at least be legible: name the owning org and say the
  // constraint is global, instead of surfacing a raw SQLite constraint string.
  it("register: a duplicate agent id from another org fails with an actionable message (#231)", () => {
    registry.register("org-a", "shared-id", "A", []);
    let err: Error | undefined;
    try {
      registry.register("org-b", "shared-id", "B", []);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // Names the id, the org that already holds it, and why.
    expect(err!.message).toContain("shared-id");
    expect(err!.message).toContain("org-a");
    expect(err!.message).toMatch(/global/i);
    // The raw driver text must not leak through.
    expect(err!.message).not.toMatch(/SQLITE_CONSTRAINT/);
    // And the first org's row is untouched.
    expect(registry.get("org-a", "shared-id")?.name).toBe("A");
    expect(registry.get("org-b", "shared-id")).toBeUndefined();
  });

  // Issue #233: listOnline used to filter on `status` alone. `status` only ever
  // becomes 'offline' via an opt-in REST call or an MQTT LWT that real agents
  // do not register, so a crashed agent stayed "online" forever and
  // wait_for_peers happily reported readiness against a corpse.
  describe("online staleness (#233)", () => {
    const TTL_ENV = "COORDINATOR_AGENT_ONLINE_TTL_SECONDS";
    afterEach(() => {
      delete process.env[TTL_ENV];
    });

    function backdate(orgId: string, agentId: string, seconds: number): void {
      getDb()
        .prepare("UPDATE agents SET last_seen_at = datetime('now', ?) WHERE org_id = ? AND id = ?")
        .run(`-${seconds} seconds`, orgId, agentId);
    }

    it("drops an agent whose last_seen_at is older than the TTL", () => {
      process.env[TTL_ENV] = "60";
      registry.register("org-a", "stale", "Stale", []);
      registry.register("org-a", "fresh", "Fresh", []);
      backdate("org-a", "stale", 600);

      const online = registry.listOnline("org-a").map((a) => a.id);
      expect(online).toContain("fresh");
      expect(online).not.toContain("stale");
    });

    it("listAll still reports the stale agent — this is a liveness filter, not a delete", () => {
      process.env[TTL_ENV] = "60";
      registry.register("org-a", "stale", "Stale", []);
      backdate("org-a", "stale", 600);

      expect(registry.listAll("org-a").map((a) => a.id)).toContain("stale");
      expect(registry.get("org-a", "stale")).toBeDefined();
    });

    it("a heartbeat brings a stale agent back", () => {
      process.env[TTL_ENV] = "60";
      registry.register("org-a", "back", "Back", []);
      backdate("org-a", "back", 600);
      expect(registry.listOnline("org-a").map((a) => a.id)).not.toContain("back");

      registry.heartbeat("org-a", "back");
      expect(registry.listOnline("org-a").map((a) => a.id)).toContain("back");
    });

    it("an explicitly offline agent stays out regardless of freshness", () => {
      process.env[TTL_ENV] = "60";
      registry.register("org-a", "gone", "Gone", []);
      registry.setOffline("org-a", "gone");
      expect(registry.listOnline("org-a").map((a) => a.id)).not.toContain("gone");
    });

    it("the TTL is generous by default so a quiet-but-live agent is not culled", () => {
      registry.register("org-a", "quiet", "Quiet", []);
      backdate("org-a", "quiet", 120); // 2 min idle, well under the default
      expect(registry.listOnline("org-a").map((a) => a.id)).toContain("quiet");
    });
  });
});
