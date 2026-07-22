import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Client } from "aedes";
import {
  createAedesAuthorizeSubscribeHook,
  createAedesAuthorizePublishHook,
} from "../../src/mqtt-broker.js";
import { silentLogger } from "../../src/logger.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation } from "../../src/consultation.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import fs from "fs";

/**
 * Regression tests for two cross-tenant isolation gaps found while porting
 * the MQTT multi-org bridge onto the current org model:
 *
 *  - internal bridge ACL exemption (mqtt-broker.ts): the coordinator's own
 *    internal MQTT client was locked to the org-prefix ACL like any other
 *    tenant, so it could only ever route org "default" traffic.
 *  - handleAgentDeparture (consultation.ts): the agent-departure sweep had
 *    no org_id predicate, so an offline event for an agent_id string that
 *    happened to exist in two different orgs unclaimed/resolved threads in
 *    BOTH — a cross-tenant side effect from a single-org MQTT event.
 */

// ---------------------------------------------------------------------------
// Internal bridge ACL exemption (mqtt-broker.ts authorizeSubscribe/authorizePublish)
// ---------------------------------------------------------------------------

/** Minimal fake Aedes client carrying the fields the real hooks read. */
function fakeClient(fields: { id?: string; org?: string; role?: string }): Client {
  return {
    id: fields.id ?? "fake-client",
    org: fields.org,
    role: fields.role,
  } as unknown as Client;
}

function runAuthorizeSubscribe(
  client: Client,
  topic: string,
): Promise<{ err: Error | null; sub: { topic: string; qos: number } | null }> {
  const hook = createAedesAuthorizeSubscribeHook(silentLogger);
  return new Promise((resolve) => {
    hook(client, { topic, qos: 0 }, (err, sub) => resolve({ err, sub }));
  });
}

function runAuthorizePublish(client: Client, topic: string): Promise<{ err: Error | null }> {
  const hook = createAedesAuthorizePublishHook(silentLogger);
  return new Promise((resolve) => {
    hook(client, { topic }, (err) => resolve({ err }));
  });
}

describe("MQTT broker ACL — internal bridge exemption", () => {
  it("authorizeSubscribe grants the internal-role client access to ANY org's topic", async () => {
    const client = fakeClient({ org: "default", role: "internal" });
    const { err, sub } = await runAuthorizeSubscribe(client, "coordinator/acme-corp/threads");
    expect(err).toBeNull();
    expect(sub).not.toBeNull(); // non-null = granted (MQTT 3.1.1: null = SUBACK 128)
  });

  it("authorizePublish grants the internal-role client access to ANY org's topic", async () => {
    const client = fakeClient({ org: "default", role: "internal" });
    const { err } = await runAuthorizePublish(client, "coordinator/acme-corp/broadcast");
    expect(err).toBeNull();
  });

  it("authorizeSubscribe still confines an ordinary (non-internal) client to its own org", async () => {
    const client = fakeClient({ org: "acme-corp" });
    const same = await runAuthorizeSubscribe(client, "coordinator/acme-corp/threads");
    expect(same.sub).not.toBeNull();
    const cross = await runAuthorizeSubscribe(client, "coordinator/other-org/threads");
    expect(cross.sub).toBeNull(); // denied
  });

  it("authorizePublish still confines an ordinary (non-internal) client to its own org", async () => {
    const client = fakeClient({ org: "acme-corp" });
    const cross = await runAuthorizePublish(client, "coordinator/other-org/broadcast");
    expect(cross.err).not.toBeNull(); // denied (protocol violation -> disconnect)
  });

  it("does NOT exempt role 'admin' — only the literal internal-bridge role bypasses the org ACL", async () => {
    // Deliberate: a real org admin's MQTT token also carries role "admin" for
    // REST purposes. Exempting "admin" here would let any org admin's token
    // read/write every other org's MQTT topics — a NEW cross-tenant hole.
    // Only the server-minted "internal" role (used exclusively by the
    // coordinator's own bridge client) is exempt.
    const client = fakeClient({ org: "acme-corp", role: "admin" });
    const sub = await runAuthorizeSubscribe(client, "coordinator/other-org/threads");
    expect(sub.sub).toBeNull();
    const pub = await runAuthorizePublish(client, "coordinator/other-org/broadcast");
    expect(pub.err).not.toBeNull();
  });

  it("authorizeSubscribe rejects a client with no org and no internal role", async () => {
    const client = fakeClient({});
    const { err, sub } = await runAuthorizeSubscribe(client, "coordinator/default/threads");
    expect(err).not.toBeNull();
    expect(sub).toBeNull();
  });

  it("authorizePublish rejects a client with no org and no internal role", async () => {
    const client = fakeClient({});
    const { err } = await runAuthorizePublish(client, "coordinator/default/broadcast");
    expect(err).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Org-scoped agent departure (consultation.ts handleAgentDeparture)
// ---------------------------------------------------------------------------

const TEST_DIR = "data-test-mqtt-tenant-isolation";
let consultation: Consultation;
let registry: AgentRegistry;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  seedTestOrgs(getDb(), ["org-a", "org-b"]);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
  consultation = new Consultation();
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("consultation.handleAgentDeparture — org scoping", () => {
  // agents.id is globally UNIQUE across every org (LOAD-BEARING index —
  // several FKs target agents(id) directly), so the same agent_id string
  // can never be a REGISTERED agent in two orgs at once. But threads.claimed_by
  // / expected_respondents are plain TEXT with no such FK: claim-task (REST/MCP)
  // accepts any caller-supplied agent_id string scoped only by the caller's own
  // org token — so two unrelated orgs independently claiming/expecting the
  // same agent_id string (a generic identifier like "agent-x" is a realistic
  // collision) is exactly the scenario the bug allowed to cross-contaminate.
  // These tests reproduce that by seeding the collision directly into
  // threads.claimed_by / expected_respondents, without requiring the
  // (architecturally impossible) same registered agent in two orgs.
  it("does not unclaim a same-agent_id thread in a different org", () => {
    registry.register("org-a", "initiator-a", "Initiator A", ["src/a"]);
    registry.register("org-b", "initiator-b", "Initiator B", ["src/b"]);

    const threadA = consultation.announceWork("org-a", {
      agent_id: "initiator-a",
      subject: "Work A",
      target_modules: ["src/a"],
      target_files: [],
      keep_open: true,
    });
    const threadB = consultation.announceWork("org-b", {
      agent_id: "initiator-b",
      subject: "Work B",
      target_modules: ["src/b"],
      target_files: [],
      keep_open: true,
    });
    getDb()
      .prepare("UPDATE threads SET claimed_by = ?, claimed_at = ? WHERE id = ? AND org_id = ?")
      .run("agent-x", new Date().toISOString(), threadA.id, "org-a");
    getDb()
      .prepare("UPDATE threads SET claimed_by = ?, claimed_at = ? WHERE id = ? AND org_id = ?")
      .run("agent-x", new Date().toISOString(), threadB.id, "org-b");

    consultation.handleAgentDeparture("org-a", "agent-x");

    const stillClaimedInB = consultation.getThread("org-b", threadB.id);
    expect(stillClaimedInB?.claimed_by).toBe("agent-x");
    const unclaimedInA = consultation.getThread("org-a", threadA.id);
    expect(unclaimedInA?.claimed_by).toBeNull();
  });

  it("does not remove a same-agent_id from expected_respondents in a different org", () => {
    registry.register("org-a", "initiator-a", "Initiator A", ["src/a"]);
    registry.register("org-b", "initiator-b", "Initiator B", ["src/b"]);

    const threadA = consultation.announceWork("org-a", {
      agent_id: "initiator-a",
      subject: "Work A",
      target_modules: ["src/a"],
      target_files: [],
      keep_open: true,
    });
    const threadB = consultation.announceWork("org-b", {
      agent_id: "initiator-b",
      subject: "Work B",
      target_modules: ["src/b"],
      target_files: [],
      keep_open: true,
    });
    // Seed the collision: both threads list "agent-x" as an expected
    // respondent, in two different orgs.
    getDb()
      .prepare("UPDATE threads SET expected_respondents = ? WHERE id = ? AND org_id = ?")
      .run(JSON.stringify(["agent-x"]), threadA.id, "org-a");
    getDb()
      .prepare("UPDATE threads SET expected_respondents = ? WHERE id = ? AND org_id = ?")
      .run(JSON.stringify(["agent-x"]), threadB.id, "org-b");

    consultation.handleAgentDeparture("org-a", "agent-x");

    const updatedA = consultation.getThread("org-a", threadA.id);
    const updatedB = consultation.getThread("org-b", threadB.id);
    expect(JSON.parse(updatedA?.expected_respondents || "[]")).not.toContain("agent-x");
    expect(JSON.parse(updatedB?.expected_respondents || "[]")).toContain("agent-x");
  });

  it("still auto-resolves an open thread in the departing agent's own org when it was the last respondent", () => {
    registry.register("org-a", "agent-x", "Agent X", ["src/a"]);
    registry.register("org-a", "initiator-a", "Initiator A", ["src/a"]);

    const threadA = consultation.announceWork("org-a", {
      agent_id: "initiator-a",
      subject: "Work A",
      target_modules: ["src/a"],
      target_files: [],
    });
    expect(JSON.parse(threadA.expected_respondents || "[]")).toEqual(["agent-x"]);

    consultation.handleAgentDeparture("org-a", "agent-x");

    const resolved = consultation.getThread("org-a", threadA.id);
    expect(resolved?.status).toBe("resolved");
  });
});
