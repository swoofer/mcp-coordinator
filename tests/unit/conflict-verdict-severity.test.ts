import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation } from "../../src/consultation.js";
import { ConflictDetector } from "../../src/conflict-detector.js";
import { DependencyMapper } from "../../src/dependency-map.js";
import { FileTracker } from "../../src/file-tracker.js";
import { seedTestOrgs } from "../helpers/orgs.js";

/**
 * issue #381 — the detector emitted `warning` and `info` and nothing else, so
 * it never stated a verdict anyone could act on. The issue asks which signals
 * are worth a refusal.
 *
 * The answer taken here is narrow on purpose: `error` is emitted for exactly
 * one case — a declared file overlap with a thread that is open AND claimed
 * by another agent. That is the case handleClaimTask ALREADY refuses, with
 * that exact predicate (`other.status = 'open' AND other.claimed_by IS NOT
 * NULL AND other.claimed_by != agent` plus a file intersection). Reporting it
 * at announce time makes the two agree. It does not invent a refusal.
 *
 * The issue suggests "the mapping already exists for the claim, the two
 * should agree", which reads like a copy but is not: the detector's own
 * file_overlap predicate is far wider — resolving threads, threads resolved
 * within 30 minutes, and unclaimed open threads all match it. Promoting all of
 * that to `error` would refuse cases claim_task grants today. Those stay
 * `warning`.
 *
 * Nothing enforces `error`. No call site branches on severity; the field is
 * written into the announce response and the SSE payload. Making it a refusal
 * is a separate decision and needs an authenticated agent identity first —
 * agent_id arrives from tool arguments, so a gate keyed on it is bypassed by
 * announcing under a peer's id.
 */

const DIR = "data-test-verdict";

let registry: AgentRegistry;
let consultation: Consultation;
let detector: ConflictDetector;

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
});

beforeEach(() => {
  getDb().exec("DELETE FROM threads; DELETE FROM agents;");
  seedTestOrgs(getDb(), ["default"]);
  registry = new AgentRegistry();
  consultation = new Consultation();
  detector = new ConflictDetector(consultation, new DependencyMapper(), new FileTracker());
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

/** Open a thread on src/auth/mw.ts and return its id. */
function announce(agentId: string): string {
  registry.register("default", agentId, "Agent " + agentId, ["src/auth"]);
  const thread = consultation.announceWork("default", {
    agent_id: agentId,
    subject: "work by " + agentId,
    target_modules: ["src/auth"],
    target_files: ["src/auth/mw.ts"],
    keep_open: true,
  });
  return thread.id;
}

function claim(threadId: string, agentId: string): void {
  getDb()
    .prepare("UPDATE threads SET claimed_by = ?, claimed_at = ? WHERE id = ?")
    .run(agentId, new Date().toISOString(), threadId);
}

function setStatus(threadId: string, status: string): void {
  getDb().prepare("UPDATE threads SET status = ? WHERE id = ?").run(status, threadId);
}

function fileConflicts(agentId = "newcomer") {
  registry.register("default", agentId, "Newcomer", ["src/auth"]);
  return detector
    .detect({
      org_id: "default",
      agent_id: agentId,
      target_modules: ["src/auth"],
      target_files: ["src/auth/mw.ts"],
    })
    .filter((c) => c.type === "file_overlap");
}

describe("the detector states one verdict it will stand behind (#381)", () => {
  it("an open thread HELD by another agent is an error", () => {
    // The exact case claim_task refuses.
    const id = announce("holder");
    claim(id, "holder");
    const conflicts = fileConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe("error");
    expect(conflicts[0].details).toContain("claim_task would refuse");
  });

  it("an open but UNCLAIMED thread stays a warning", () => {
    // claim_task grants this today. Refusing it would be a policy change.
    announce("idle");
    const conflicts = fileConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe("warning");
  });

  it("a thread the newcomer holds itself is not an error", () => {
    // claim_task's predicate is `claimed_by != agent` — one agent holding two
    // overlapping threads serialises itself, it does not block itself.
    const id = announce("holder");
    claim(id, "newcomer");
    const conflicts = fileConflicts("newcomer");
    expect(conflicts[0].severity).toBe("warning");
  });

  it("a RESOLVING thread stays a warning even when claimed", () => {
    // The detector's window is wider than claim_task's. Promoting the wider
    // window would refuse what claim_task grants.
    const id = announce("holder");
    claim(id, "holder");
    setStatus(id, "resolving");
    const conflicts = fileConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe("warning");
  });

  it("module overlap and dependency chains are unchanged", () => {
    // Only file_overlap gained a level. Widening the others would be
    // guesswork; the issue asks the question and does not answer it.
    const id = announce("holder");
    claim(id, "holder");
    const all = detector.detect({
      org_id: "default",
      agent_id: "newcomer",
      target_modules: ["src/auth"],
      target_files: ["src/auth/mw.ts"],
    });
    for (const c of all.filter((x) => x.type !== "file_overlap")) {
      expect(c.severity, c.type + " changed level").not.toBe("error");
    }
    void id;
  });

  it("nothing in the coordinator acts on the verdict yet", () => {
    // Stated as a test because #381's whole complaint is a signal nobody
    // consumes. If a gate lands, this fails and the gate's author has to
    // decide deliberately whether agent identity is authenticated first.
    const read = (p: string) => fs.readFileSync(p, "utf8");
    for (const file of [
      "src/tools/consultation-tools.ts",
      "src/http/rest-handlers.ts",
      "src/announce-workflow.ts",
    ]) {
      expect(read(file), file + " now branches on conflict severity").not.toMatch(
        /severity\s*===\s*["']error["']/,
      );
    }
  });
});
