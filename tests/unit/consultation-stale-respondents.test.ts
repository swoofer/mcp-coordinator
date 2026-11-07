/**
 * announceWork's first pass picks, among online agents, those whose modules
 * overlap the announced ones. It read `status = 'online'` alone, without the
 * presence TTL that AgentRegistry.listOnline applies (#233). An agent that
 * died without going offline therefore stayed a candidate respondent for
 * good: in production ~2,600 such agents made a thread on one module log
 * 354 respondents while 15 agents were alive.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation } from "../../src/consultation.js";

const TEST_DIR = "data-test-consultation-stale";
let registry: AgentRegistry;
let consultation: Consultation;

const ageOut = (agentId: string) =>
  getDb()
    .prepare("UPDATE agents SET last_seen_at = datetime('now', '-1 day') WHERE id = ?")
    .run(agentId);

const announce = () =>
  consultation.announceWork("default", {
    agent_id: "initiator",
    subject: "Change auth",
    target_modules: ["src/auth"],
    target_files: ["src/auth/session.ts"],
  });

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
  consultation = new Consultation();
  registry.register("default", "initiator", "Initiator", ["src/api"]);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("announceWork respondents", () => {
  it("leaves out an agent silent past the online TTL", () => {
    registry.register("default", "fresh", "Fresh", ["src/auth"]);
    registry.register("default", "stale", "Stale", ["src/auth"]);
    ageOut("stale");

    const thread = announce();

    expect(JSON.parse(thread.expected_respondents ?? "[]")).toEqual(["fresh"]);
  });

  it("resolves at once when the only overlapping agents are stale", () => {
    registry.register("default", "stale", "Stale", ["src/auth"]);
    ageOut("stale");

    const thread = announce();

    expect(thread.status).toBe("resolved");
  });
});
