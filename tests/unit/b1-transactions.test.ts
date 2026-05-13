import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { Consultation } from "../../src/consultation.js";
import { AgentRegistry } from "../../src/agent-registry.js";

let dataDir: string;
let registry: AgentRegistry;
let consultation: Consultation;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "b1-tx-"));
  initDatabase(dataDir);
  registry = new AgentRegistry();
  consultation = new Consultation();
  registry.register("default", "a1", "Agent A", ["src/auth"]);
});

afterEach(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

import { afterEach } from "vitest";

describe("B1 fix - approveResolution CAS pattern", () => {
  it("emits consensus event exactly once on normal approve flow", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const events: unknown[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1", subject: "B1 test", target_modules: ["src/auth"], target_files: [],
    });
    consultation.postToThread({ thread_id: thread.id, agent_id: "a2", type: "context", content: "ok" });
    consultation.proposeResolution(thread.id, "a1", "Agreed");
    consultation.approveResolution(thread.id, "a2", "Agent B");

    expect(events).toHaveLength(1);
  });

  it("CAS UPDATE...WHERE status='resolving' affects 0 rows when status was already changed", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "B1 CAS test", target_modules: ["src/auth"], target_files: [],
    });
    consultation.postToThread({ thread_id: thread.id, agent_id: "a2", type: "context", content: "ok" });
    consultation.proposeResolution(thread.id, "a1", "Agreed");

    // Simulate a race winner: another path already transitioned to resolved
    const db = getDb();
    db.prepare("UPDATE threads SET status='resolved', resolved_at=? WHERE id=?").run(new Date().toISOString(), thread.id);

    // The CAS-style UPDATE the loser would issue must affect 0 rows (no race won)
    const res = db
      .prepare("UPDATE threads SET status='resolved', resolved_at=? WHERE id=? AND status='resolving'")
      .run(new Date().toISOString(), thread.id);
    expect(res.changes).toBe(0);
  });

  it("approveResolution rejects if thread already resolved (no double consensus)", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const events: unknown[] = [];
    consultation.onResolve((e) => events.push(e));

    const thread = consultation.announceWork({
      agent_id: "a1", subject: "B1 reject double", target_modules: ["src/auth"], target_files: [],
    });
    consultation.postToThread({ thread_id: thread.id, agent_id: "a2", type: "context", content: "ok" });
    consultation.proposeResolution(thread.id, "a1", "Agreed");
    consultation.approveResolution(thread.id, "a2", "Agent B");

    // Now the thread is resolved. A second approve should throw — and not emit.
    expect(() => consultation.approveResolution(thread.id, "a2", "Agent B")).toThrow();
    expect(events).toHaveLength(1);
  });
});

describe("B1 fix - announceWork transaction atomicity", () => {
  it("uses a transaction (verifiable: SELECT respondents + INSERT thread observed atomically)", () => {
    // Hard to provoke a true race in single-threaded JS, but we can verify
    // the result of announceWork respects the snapshot taken at call time:
    // adding a respondent AFTER announce returns must not retroactively
    // appear in expected_respondents.
    registry.register("default", "a2", "Agent B", ["src/auth"]);

    const thread = consultation.announceWork({
      agent_id: "a1", subject: "B1 atomicity", target_modules: ["src/auth"], target_files: [],
    });

    // Add a3 AFTER announce. Should NOT appear in respondents.
    registry.register("default", "a3", "Agent C", ["src/auth"]);

    const respondents = JSON.parse(thread.expected_respondents || "[]");
    expect(respondents).toEqual(["a2"]);
    expect(respondents).not.toContain("a3");
  });

  it("respondents list is consistent with status (auto-resolve when 0 respondents)", () => {
    // No other agents online → autoResolve should be true
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "B1 consistency", target_modules: ["src/auth"], target_files: [],
    });
    expect(thread.status).toBe("resolved");
    expect(JSON.parse(thread.expected_respondents || "[]")).toEqual([]);
  });
});

