import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { initDatabase, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation, DEFAULT_ACTION_SUMMARY_LIMIT } from "../../src/consultation.js";
import { FileTracker } from "../../src/file-tracker.js";
import { SummaryContextProvider } from "../../src/context-provider.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import { getDb } from "../../src/database.js";

/**
 * issue #361 — getActionSummaries had no LIMIT and its only caller passed no
 * `since`, so it returned everything inside the 30-day retention window. That
 * array travels into the `context` of every announce_work response, once per
 * concerned peer. Measured on the issue: one peer with 200 summaries made a
 * single response 59 kB, ~14 800 tokens, 97 % of it context.
 *
 * The size matters beyond bandwidth: the Claude API's context editing triggers
 * at 100 000 input tokens and evicts the *oldest* tool results first — which
 * are the peer announcements. An unbounded coordination payload accelerates
 * the loss of the coordination state it is carrying.
 */

const TEST_DIR = "data-test-announce-bound";

let registry: AgentRegistry;
let consultation: Consultation;
let provider: SummaryContextProvider;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  seedTestOrgs(getDb(), ["default"]);
  registry = new AgentRegistry();
  consultation = new Consultation();
  provider = new SummaryContextProvider(registry, consultation, new FileTracker());
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Give one agent `n` summaries and return the context another agent would receive. */
function contextAfter(agentId: string, n: number, summary = "Edited a file") {
  registry.register("default", agentId, `Agent ${agentId}`, ["src/auth"]);
  for (let i = 0; i < n; i++) {
    consultation.logActionSummary("default", {
      session_id: "s1",
      agent_id: agentId,
      file_path: `src/auth/file-${i}.ts`,
      summary: `${summary} ${i}`,
    });
  }
  return provider.getRelevantContext("default", agentId, {
    thread_id: "t1",
    subject: "Refactor auth",
    target_modules: ["src/auth"],
    target_files: ["src/auth/middleware.ts"],
  });
}

describe("announce_work context is bounded (#361)", () => {
  it("returns at most the default number of summaries, however many exist", () => {
    const ctx = contextAfter("peer-many", 200);
    expect(ctx.action_summaries).toHaveLength(DEFAULT_ACTION_SUMMARY_LIMIT);
  });

  it("keeps the newest, not an arbitrary slice", () => {
    // DESC + LIMIT: dropping the oldest is the whole point. Returning the
    // first ten written would bound the size and lose the useful end.
    const ctx = contextAfter("peer-order", 50, "action");
    const numbers = ctx.action_summaries.map((s) => Number(s.summary.split(" ").pop()));
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(40);
  });

  it("a peer with fewer summaries than the bound is unaffected", () => {
    const ctx = contextAfter("peer-few", 3);
    expect(ctx.action_summaries).toHaveLength(3);
  });

  // The measurement the issue made, reproduced in-process so both sides are
  // measured by the same code path rather than compared across runs.
  it("caps the response an announcing agent receives", () => {
    const bounded = contextAfter("peer-size", 200);
    const unbounded = {
      ...bounded,
      action_summaries: consultation.getActionSummaries("default", "peer-size", undefined, 10_000),
    };

    const boundedBytes = Buffer.byteLength(JSON.stringify(bounded));
    const unboundedBytes = Buffer.byteLength(JSON.stringify(unbounded));

    expect(unboundedBytes).toBeGreaterThan(20_000);
    expect(boundedBytes).toBeLessThan(3_000);
    // Not a fixed ratio -- just that the bound is doing real work at the scale
    // the issue measured.
    expect(unboundedBytes / boundedBytes).toBeGreaterThan(8);
  });

  it("a caller can still ask for more, explicitly", () => {
    const all = consultation.getActionSummaries("default", "peer-many", undefined, 500);
    expect(all.length).toBe(200);
  });
});

describe("a single oversized summary cannot inflate the context (#361)", () => {
  it("truncates on the way out rather than rejecting on the way in", () => {
    // log_action_summary documents `summary` as a one-liner and neither
    // transport constrains it. Bounding at ingest would newly reject payloads
    // both accept today; bounding here fixes the size without that.
    const ctx = contextAfter("peer-verbose", 1, "x".repeat(5000));
    expect(ctx.action_summaries).toHaveLength(1);
    expect(ctx.action_summaries[0].summary).toContain("(truncated)");
    expect(ctx.action_summaries[0].summary.length).toBeLessThan(350);
  });

  it("leaves a genuine one-liner alone", () => {
    const ctx = contextAfter("peer-terse", 1, "Fixed the import");
    expect(ctx.action_summaries[0].summary).toBe("Fixed the import 0");
  });
});
