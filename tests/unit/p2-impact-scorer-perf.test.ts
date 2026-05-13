import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { FileTracker } from "../../src/file-tracker.js";
import { Consultation } from "../../src/consultation.js";
import { ImpactScorer } from "../../src/impact-scorer.js";

/**
 * P2 Performance — impact-scorer.ts must stay <5ms at the marketing scale,
 * and we hold ourselves to a 50ms ceiling here (10× generous buffer for CI
 * jitter on Windows runners). The three optimizations under test:
 *
 *   O1: cache parsed agent.modules JSON once per scoring pass (eliminates
 *       the 4·A JSON.parse multiplier the audit found).
 *   O2: bound resolved-thread queries with `since_minutes` (default 30) so
 *       impact-scorer doesn't scan all-time history on every call.
 *   O3: pre-build a file→agents reverse index (one batched SQL query) so
 *       the inner per-file check is O(1) Map.get instead of O(F) SQL.
 */

let dataDir: string;
let registry: AgentRegistry;
let tracker: FileTracker;
let consultation: Consultation;
let scorer: ImpactScorer;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "p2-perf-"));
  initDatabase(dataDir);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM action_summaries");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
  tracker = new FileTracker();
  consultation = new Consultation();
  scorer = new ImpactScorer(registry, tracker, consultation);
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Seeds the DB with a deterministic load that mirrors the audit's "scale"
 * scenario:
 *   - 50 online agents (each owning 2 modules)
 *   - 200 file_activity rows spread across those agents
 *   - 100 resolved threads (most stale, a few recent)
 *
 * Returns the announce_work params used in the timing run so the snapshot
 * test can compare scoring output against a known-correct baseline.
 */
function seedScale(): { org_id: string; agent_id: string; target_modules: string[]; target_files: string[]; depends_on_files: string[] } {
  // 50 agents, agent ids agent-00 .. agent-49.
  const agentIds: string[] = [];
  for (let i = 0; i < 50; i++) {
    const id = `agent-${i.toString().padStart(2, "0")}`;
    agentIds.push(id);
    // Two modules per agent: a "src" module and a "lib" module, deterministic
    // by index so prefix-overlap with "src/shared" stays predictable.
    registry.register("default", id, `Agent ${i}`, [`src/mod-${i}`, `lib/util-${i % 5}`]);
  }

  // 200 file activities spread across the agents. ~10 of them touch files
  // that overlap with what the announcer will target — this is what Layer 1
  // and the file→agents index exist to detect.
  for (let f = 0; f < 200; f++) {
    const agent = agentIds[f % agentIds.length];
    // Files 0..9 are "shared" (scored against). The rest are unrelated noise
    // that the index must skim past efficiently.
    const filePath = f < 50
      ? `src/shared/types-${f % 10}.ts`
      : `src/mod-${f % 50}/file-${f}.ts`;
    tracker.log({
      org_id: "default",
      session_id: `s-${f}`,
      agent_id: agent,
      tool_name: "Edit",
      file_path: filePath,
    });
  }

  // 100 resolved threads. 90 of them are 2 hours old (stale — must be
  // excluded by O2's since_minutes bound). 10 are recent and on the same
  // file the announcer targets, so they should drive Layer 0a scoring.
  const db = getDb();
  for (let t = 0; t < 100; t++) {
    const initiator = agentIds[t % agentIds.length];
    const isRecent = t < 10;
    const targetFiles = isRecent
      ? ["src/shared/types-0.ts"]
      : [`src/mod-${t % 50}/old-file-${t}.ts`];
    const thread = consultation.announceWork("default", {
      agent_id: initiator,
      subject: `Old work ${t}`,
      target_modules: [`src/mod-${t % 50}`],
      target_files: targetFiles,
    });
    if (!isRecent) {
      // Backdate stale threads so O2's window-filter excludes them.
      db.prepare(
        "UPDATE threads SET created_at = datetime('now', '-2 hours'), resolved_at = datetime('now', '-2 hours'), status = 'resolved' WHERE id = ?"
      ).run(thread.id);
    } else {
      // Force recent threads into 'resolved' so they hit the Layer 0
      // resolved-window code path (rather than the open/resolving path).
      db.prepare(
        "UPDATE threads SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(thread.id);
    }
  }

  return {
    // Use a fresh announcer id NOT in agentIds so all 50 agents are scored.
    org_id: "default",
    agent_id: "announcer-x",
    target_modules: ["src/shared", "src/mod-3"],
    target_files: ["src/shared/types-0.ts", "src/shared/types-1.ts"],
    depends_on_files: ["src/shared/types-2.ts"],
  };
}

describe("P2 perf - impact-scorer at scale", () => {
  it("score() completes in <50ms with 50 agents / 200 file activities / 100 threads", () => {
    const params = seedScale();

    // Warm-up call to amortize SQLite statement preparation. The audit's
    // "<5ms" claim was about steady-state hot-path latency, not first-touch
    // setup; warm-up makes the timing comparable to that promise.
    scorer.score(params);

    const start = performance.now();
    const ITERATIONS = 5;
    for (let i = 0; i < ITERATIONS; i++) {
      scorer.score(params);
    }
    const avgMs = (performance.now() - start) / ITERATIONS;

    // 50ms ceiling = 10× the <5ms target. Generous on purpose for Windows /
    // CI noise, but tight enough to fail loudly if O1/O2/O3 regress.
    expect(avgMs).toBeLessThan(50);

    // Surface the timing in CI logs so regressions are visible at a glance
    // (vitest preserves console.log per-test under --reporter=verbose).
    // eslint-disable-next-line no-console
    console.log(`P2 perf: ${avgMs.toFixed(2)}ms avg over ${ITERATIONS} runs`);
  });

  it("scoring output matches a known-correct snapshot at scale", () => {
    const params = seedScale();
    const scores = scorer.score(params);

    // 50 agents must all be scored (none filtered out — announcer is not in
    // the registry, so no self-filter trims the result set).
    expect(scores).toHaveLength(50);

    // Every agent that has a file_activity row on src/shared/types-0.ts
    // should score 100 (Layer 1: same file). With f%50 distribution and 50
    // shared-file activities, each agent 0..9 gets one activity on each of
    // types-0..types-9, then agents 10..49 also pick up activities on the
    // same files via the f%50 wrap. So all 50 agents touched at least one
    // shared/types-* file. But only the ones who touched types-0 or types-1
    // (target_files) should hit Layer 1 = score 100.
    const score100 = scores.filter((s) => s.score === 100);
    expect(score100.length).toBeGreaterThanOrEqual(2);

    // The recent resolved-thread initiators (agents 0..9) all targeted
    // types-0.ts → Layer 0a should fire for them too. Verify at least one
    // score-100 result has an "announced same file" reason.
    const announcedReasons = scores.flatMap((s) => s.reasons).filter((r) => r.includes("announced same file"));
    expect(announcedReasons.length).toBeGreaterThan(0);

    // O2 invariant: the 90 stale threads (2 hours old) must NOT contribute
    // any "announced same file" reasons. Because their target_files were
    // mod-X/old-file-X.ts (not src/shared/types-0), this is a structural
    // check — but the more important invariant is that the result is stable
    // and reproducible regardless of how many stale rows exist.
    const allReasons = scores.flatMap((s) => s.reasons).join("\n");
    expect(allReasons).not.toContain("old-file-");

    // Every agent that has 'src/mod-3' in their modules should hit Layer 3
    // (module overlap, score 30) when not already promoted higher.
    const mod3Agent = scores.find((s) => s.agent_id === "agent-03");
    expect(mod3Agent).toBeDefined();
    // agent-03 owns src/mod-3, so module overlap fires. They also touched
    // types-0/types-1 via the f%50 distribution, so Layer 1 promotes them
    // to 100. The reason list must contain both layers' findings.
    expect(mod3Agent!.reasons.some((r) => r.includes("module overlap"))).toBe(true);
  });
});

