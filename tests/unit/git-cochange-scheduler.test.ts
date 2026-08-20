// #368 — the refresh loop's own failure path.
//
// build() catches everything git-related itself: a missing .git, a shallow
// clone, a git log that fails or times out each get a counter, a meta row and a
// log line. So the errors that reach startScheduler's catch are the ones build()
// does *not* catch — getDb() and the SQLite writes — and those had no counter,
// no meta row, and no bound on how long the loop would keep retrying.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, promises as fsp } from "fs";
import { tmpdir } from "os";
import path from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { GitCochangeBuilder } from "../../src/git-cochange-builder.js";
import { Metrics } from "../../src/metrics.js";
import { seedTestOrgs } from "../helpers/orgs.js";

const TEST_DIR = mkdtempSync(path.join(tmpdir(), "gitcc-sched-"));

/** Current value of an unlabelled counter/gauge. */
async function value(metric: { get(): Promise<{ values: Array<{ value: number }> }> }) {
  return (await metric.get()).values[0]?.value ?? 0;
}

function meta(k: string): string | undefined {
  return (
    getDb()
      .prepare("SELECT v FROM git_cochange_meta WHERE org_id = ? AND k = ?")
      .get("default", k) as { v: string } | undefined
  )?.v;
}

describe("GitCochangeBuilder scheduler failures", () => {
  let metrics: Metrics;

  beforeEach(() => {
    try {
      closeDb();
    } catch {
      /* nothing to close yet */
    }
    initDatabase(TEST_DIR);
    getDb().exec("DELETE FROM git_cochange_meta;");
    seedTestOrgs(getDb(), ["default"]);
    metrics = new Metrics({ collectDefault: false });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      closeDb();
    } catch {
      /* already closed */
    }
    await fsp.rm(TEST_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 750 });
  }, 30000);

  /** A builder whose build() always rejects, wired to the metrics registry. */
  function failingBuilder(err = new Error("database is locked")) {
    const builder = new GitCochangeBuilder({ repoRoot: TEST_DIR, retryMs: 1000, metrics });
    const build = vi.spyOn(builder, "build").mockRejectedValue(err);
    return { builder, build };
  }

  it("counts the failure, records why, and marks the layer unavailable", async () => {
    const { builder } = failingBuilder();
    builder.startScheduler("default");

    await vi.advanceTimersByTimeAsync(5000); // first build, after the grace period

    expect(builder.getSchedulerFailureCount()).toBe(1);
    expect(await value(metrics.gitCochangeSchedulerFailures)).toBe(1);
    // The reason is the whole point: `available` says the layer is down,
    // `last_error` is the only place that says why.
    expect(meta("available")).toBe("false");
    expect(meta("last_error")).toBe("database is locked");

    builder.stopScheduler();
  });

  it("labels the outcome apart from the failures build() catches itself", async () => {
    const { builder } = failingBuilder();
    builder.startScheduler("default");
    await vi.advanceTimersByTimeAsync(5000);

    const outcomes = (await metrics.gitCochangeBuilds.get()).values;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].labels.outcome).toBe("scheduler_error");

    builder.stopScheduler();
  });

  it("stops retrying after five consecutive failures instead of looping forever", async () => {
    const { builder, build } = failingBuilder();
    builder.startScheduler("default");

    await vi.advanceTimersByTimeAsync(5000);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(1000);

    expect(build).toHaveBeenCalledTimes(5);
    expect(builder.isSchedulerCircuitOpen()).toBe(true);
    expect(await value(metrics.gitCochangeSchedulerCircuitOpen)).toBe(1);

    // The loop is genuinely stopped, not merely flagged: an hour of timers
    // produces no further attempt.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(build).toHaveBeenCalledTimes(5);
  });

  it("keeps retrying below the threshold", async () => {
    const { builder, build } = failingBuilder();
    builder.startScheduler("default");

    await vi.advanceTimersByTimeAsync(5000);
    for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(1000);

    expect(build).toHaveBeenCalledTimes(3);
    expect(builder.isSchedulerCircuitOpen()).toBe(false);
    expect(await value(metrics.gitCochangeSchedulerCircuitOpen)).toBe(0);

    builder.stopScheduler();
  });

  it("a successful build resets the run of failures", async () => {
    const builder = new GitCochangeBuilder({
      repoRoot: TEST_DIR,
      retryMs: 1000,
      refreshMs: 2000,
      metrics,
    });
    const build = vi.spyOn(builder, "build");
    build.mockRejectedValue(new Error("boom"));
    builder.startScheduler("default");

    await vi.advanceTimersByTimeAsync(5000);
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(builder.getSchedulerFailureCount()).toBe(4); // one short of the break

    build.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    expect(builder.getSchedulerFailureCount()).toBe(0);

    // A later failure starts a fresh run rather than tripping the breaker on
    // the strength of the old ones.
    build.mockRejectedValue(new Error("boom again"));
    await vi.advanceTimersByTimeAsync(2000); // refreshMs, the post-success interval
    expect(builder.getSchedulerFailureCount()).toBe(1);
    expect(builder.isSchedulerCircuitOpen()).toBe(false);

    builder.stopScheduler();
  });

  it("survives a database that is unreachable when it tries to record the failure", async () => {
    const { builder } = failingBuilder();
    closeDb(); // now getDb() inside recordSchedulerFailure throws too
    builder.startScheduler("default");

    // The counter still moves and the loop still schedules its retry: the
    // record of the failure must not become a second failure.
    await vi.advanceTimersByTimeAsync(5000);
    expect(builder.getSchedulerFailureCount()).toBe(1);
    expect(await value(metrics.gitCochangeSchedulerFailures)).toBe(1);

    builder.stopScheduler();
    initDatabase(TEST_DIR); // afterAll expects a live handle to close
  });
});
