import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation } from "../../src/consultation.js";
import { WorkingFilesTracker } from "../../src/working-files-tracker.js";
import fs from "fs";

/**
 * issue #330 — `coordinator/<org>/agents/<id>/status` is publishable by anyone
 * the broker admits, and in the default profile the broker is anonymous. The
 * handler behind it used to run the full departure cleanup on the strength of
 * that message alone.
 *
 * The issue's headline is the working_files wipe. Measuring it turned up two
 * effects it does not mention, both worse:
 *
 *   - `handleAgentDeparture` force-RESOLVES an open thread when the named agent
 *     was its last expected respondent. A resolved thread has no path back;
 *     working_files re-appear on the agent's next claim.
 *   - `setOffline` removed the agent from `listOnline`, which is what feeds
 *     consultation routing — and NOTHING in production set the status back, so
 *     the effect was permanent until re-registration.
 *
 * The rule this file pins: a message anyone can forge may update presence,
 * which is cheap and now self-healing. It may not destroy another agent's work
 * unless the coordinator's OWN record agrees the agent went quiet.
 */

const TEST_DIR = "data-test-departure-authority";
let registry: AgentRegistry;
let consultation: Consultation;
let workingFiles: WorkingFilesTracker;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});
afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM working_files");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
  consultation = new Consultation();
  workingFiles = new WorkingFilesTracker();
  registry.register("default", "victime", "Victime", ["src"]);
  registry.register("default", "autre", "Autre", ["src"]);
});

/** Backdate last_seen_at by N seconds, as wall-clock silence would. */
const age = (agentId: string, seconds: number) =>
  getDb()
    .prepare("UPDATE agents SET last_seen_at = datetime('now', ? || ' seconds') WHERE id = ?")
    .run(`-${seconds}`, agentId);

const insertThread = (id: string, extra: Record<string, unknown>) => {
  const cols = {
    id,
    org_id: "default",
    initiator_id: "autre",
    subject: "x",
    status: "open",
    ...extra,
  };
  const keys = Object.keys(cols);
  getDb()
    .prepare(`INSERT INTO threads (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...keys.map((k) => (cols as Record<string, unknown>)[k]));
};

describe("the coordinator's own record decides a departure (#330)", () => {
  it("a live agent is not stale, so its cleanup is refused", () => {
    expect(registry.isStale("default", "victime")).toBe(false);
  });

  it("an agent past the online TTL is stale, so a real departure still cleans up", () => {
    age("victime", 1000); // default TTL is 900s
    expect(registry.isStale("default", "victime")).toBe(true);
  });

  it("the TTL is the same one listOnline applies", () => {
    // Not an independent threshold: an agent listOnline has already stopped
    // showing is exactly one whose departure is safe to believe.
    age("victime", 1000);
    expect(registry.listOnline("default").map((a) => a.id)).not.toContain("victime");
    expect(registry.isStale("default", "victime")).toBe(true);
  });

  it("an unknown agent counts as stale — there is no work of its to protect", () => {
    expect(registry.isStale("default", "jamais-vu")).toBe(true);
    expect(registry.isStale("autre-org", "victime")).toBe(true);
  });

  it("COORDINATOR_AGENT_ONLINE_TTL_SECONDS moves the line", () => {
    age("victime", 100);
    expect(registry.isStale("default", "victime")).toBe(false);
    process.env.COORDINATOR_AGENT_ONLINE_TTL_SECONDS = "60";
    try {
      expect(registry.isStale("default", "victime")).toBe(true);
    } finally {
      delete process.env.COORDINATOR_AGENT_ONLINE_TTL_SECONDS;
    }
  });
});

describe("presence is self-healing again (#330)", () => {
  it("a heartbeat brings an offline agent back to listOnline", () => {
    registry.setOffline("default", "victime");
    expect(registry.listOnline("default").map((a) => a.id)).not.toContain("victime");
    registry.heartbeat("default", "victime");
    expect(registry.listOnline("default").map((a) => a.id)).toContain("victime");
  });

  it("which is what makes the forged flag survivable", () => {
    // Before this, `setOnline` had no production caller: an agent knocked
    // offline by a forged message stayed out of consultation routing forever,
    // however hard it heartbeat.
    registry.setOffline("default", "victime");
    registry.heartbeat("default", "victime");
    const row = getDb().prepare("SELECT status FROM agents WHERE id='victime'").get() as {
      status: string;
    };
    expect(row.status).toBe("online");
  });

  it("a heartbeat for an agent in another org does not resurrect this one", () => {
    registry.setOffline("default", "victime");
    registry.heartbeat("autre-org", "victime");
    const row = getDb().prepare("SELECT status FROM agents WHERE id='victime'").get() as {
      status: string;
    };
    expect(row.status).toBe("offline");
  });
});

describe("what the deferred cleanup costs, measured (#330)", () => {
  it("working_files still release on their own TTL, with no departure at all", () => {
    workingFiles.start("default", "victime", "src/a.ts", 30);
    getDb().prepare("UPDATE working_files SET claim_until = ?").run("2000-01-01T00:00:00Z");
    expect(workingFiles.sweepExpired()).toBe(1);
  });

  it("open threads still resolve on their own timeout, with no departure at all", () => {
    insertThread("t1", {
      expected_respondents: JSON.stringify(["victime"]),
      timeout_seconds: 1,
      created_at: "2000-01-01T00:00:00Z",
    });
    consultation.checkTimeouts();
    const t = getDb().prepare("SELECT status FROM threads WHERE id='t1'").get() as {
      status: string;
    };
    expect(t.status).toBe("resolved");
  });

  it("so deferring bounds the delay — it does not leak the state", () => {
    // Both sweepers above run on intervals the operator configures. That is the
    // whole cost of refusing an unverified departure.
    workingFiles.start("default", "victime", "src/a.ts", 30);
    insertThread("t2", { expected_respondents: JSON.stringify(["victime"]) });
    expect(registry.isStale("default", "victime")).toBe(false);
    const claims = getDb().prepare("SELECT COUNT(*) c FROM working_files").get() as { c: number };
    const thread = getDb().prepare("SELECT status FROM threads WHERE id='t2'").get() as {
      status: string;
    };
    expect(claims.c).toBe(1);
    expect(thread.status).toBe("open");
  });
});

describe("the effects a departure has, which is why it needs authority (#330)", () => {
  it("it force-resolves an open thread when the agent was the last respondent", () => {
    insertThread("t3", { expected_respondents: JSON.stringify(["victime"]) });
    consultation.handleAgentDeparture("default", "victime");
    const t = getDb().prepare("SELECT status FROM threads WHERE id='t3'").get() as {
      status: string;
    };
    // Nothing reverses this. The issue's headline effect does reverse.
    expect(t.status).toBe("resolved");
  });

  it("it unclaims a thread the agent holds", () => {
    insertThread("t4", {
      claimed_by: "victime",
      claimed_at: "2026-01-01T00:00:00Z",
      expected_respondents: JSON.stringify(["victime", "autre"]),
    });
    consultation.handleAgentDeparture("default", "victime");
    const t = getDb().prepare("SELECT claimed_by FROM threads WHERE id='t4'").get() as {
      claimed_by: string | null;
    };
    expect(t.claimed_by).toBeNull();
  });
});
