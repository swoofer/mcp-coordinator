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
 * issue #374, step 2 — `detect()` now honours run_id.
 *
 * The filter itself is not new: `listThreads` has shipped
 * `AND (run_id IS NULL OR run_id = ?)` since run_id landed, keeping un-scoped
 * and same-run threads and dropping other runs. detect() runs on the same
 * announce_work call and was never wired to it — the same shape as #300,
 * where it was never wired to since_minutes either.
 *
 * WHAT THIS FIXES: an aborted or finished run stops leaking its stale threads
 * into the next one's conflict reports.
 *
 * WHAT IT DOES NOT FIX, stated because the issue's own measurement is about
 * this half: a parent and the sub-agents it spawned share ONE run, so
 * run-scoping keeps every warning between them. Separating "parent vs its own
 * child" from "sibling vs sibling" requires a lineage field that does not
 * exist — `agents` has no parent or spawned_by column. No rule keyed on
 * run_id alone can tell those two pairs apart; they have identical
 * signatures.
 */

const DIR = "data-test-run-scope";

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

/** Open a thread on src/auth/mw.ts, optionally scoped to a run. */
function announce(agentId: string, runId?: string): void {
  registry.register("default", agentId, "Agent " + agentId, ["src/auth"]);
  consultation.announceWork("default", {
    agent_id: agentId,
    subject: "work by " + agentId,
    target_modules: ["src/auth"],
    target_files: ["src/auth/mw.ts"],
    keep_open: true,
    ...(runId === undefined ? {} : { run_id: runId }),
  });
}

/** Conflicts a newcomer would be told about. */
function conflictsFor(runId?: string) {
  registry.register("default", "newcomer", "Newcomer", ["src/auth"]);
  return detector.detect({
    org_id: "default",
    agent_id: "newcomer",
    target_modules: ["src/auth"],
    target_files: ["src/auth/mw.ts"],
    ...(runId === undefined ? {} : { run_id: runId }),
  });
}

describe("detect() honours run_id (#374)", () => {
  it("a thread from another run is no longer reported", () => {
    // The measured harm this fixes: run-a aborted, its threads are still
    // open, and every announce in run-b conflicted with them.
    announce("stale-agent", "run-a");
    expect(conflictsFor("run-b")).toEqual([]);
  });

  it("a thread from the same run is still reported", () => {
    // Run-scoping must not blind an agent to its own run's peers — that is
    // the coordination the tool exists for.
    announce("peer", "run-a");
    const conflicts = conflictsFor("run-a");
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.map((c) => c.agent_id)).toContain("peer");
  });

  it("an un-scoped thread is reported to every run", () => {
    // `run_id IS NULL OR run_id = ?` keeps nulls on purpose: a thread opened
    // without a run belongs to everyone, which is the historical behaviour
    // and the migration path.
    announce("unscoped");
    expect(conflictsFor("run-b").length).toBeGreaterThan(0);
  });

  it("an announce without a run still sees everything — fail-open", () => {
    // This is the compatibility guarantee. Omitting run_id must behave
    // exactly as before, or a coordinator upgrade silently narrows detection
    // for every existing agent.
    announce("in-run", "run-a");
    announce("unscoped");
    const conflicts = conflictsFor(undefined);
    const ids = conflicts.map((c) => c.agent_id);
    expect(ids).toContain("in-run");
    expect(ids).toContain("unscoped");
  });

  it("a null run_id is treated as absent, not as a run named null", () => {
    announce("in-run", "run-a");
    const conflicts = detector.detect({
      org_id: "default",
      agent_id: "newcomer",
      target_modules: ["src/auth"],
      target_files: ["src/auth/mw.ts"],
      run_id: null,
    });
    expect(conflicts.map((c) => c.agent_id)).toContain("in-run");
  });

  it("same-run noise is NOT what this fixes", () => {
    // The issue measured a parent and its two sub-agents warning about each
    // other. They share a run, so they still do. Pinning it here so the
    // limitation is visible rather than assumed away — and so the test flips
    // loudly if someone later adds lineage and changes this.
    announce("parent", "run-a");
    announce("sub-1", "run-a");
    const conflicts = conflictsFor("run-a");
    expect(conflicts.map((c) => c.agent_id).sort()).toEqual(
      expect.arrayContaining(["parent", "sub-1"]),
    );
  });
});
