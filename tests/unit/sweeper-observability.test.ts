import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Sweeper } from "../../src/sweeper/index.js";
import {
  registry,
  sweeperCircuitOpen,
  sweeperConsecutiveFailures,
  sweeperLastRunTimestamp,
  sweeperRowsDeletedTotal,
} from "../../src/observability/metrics.js";

/**
 * Surfaced while verifying the design for #348 — three defects that are
 * independent of it and true today.
 *
 * 1. `runPass`'s catch was bare: `} catch {`. Five consecutive failures open
 *    the circuit and stop retention permanently, and the operator was left
 *    with a stopped sweeper and no statement of why.
 *
 * 2. coordinator_sweeper_circuit_open, _consecutive_failures,
 *    _last_run_timestamp and _rows_deleted_total were declared in
 *    src/observability/metrics.ts and set by nothing. A scrape reported 0 for
 *    a circuit that had been open for a week — and there is an alert rule
 *    keyed on the first of them, at severity `page`, that could never fire.
 *
 * 3. handleHealthReady was called with no options, so its `sweeper` probe
 *    read `opts.sweeperCircuitOpen ?? false` and answered ok:true
 *    unconditionally. The comment on that option said "T28 will wire the real
 *    signal"; T28 had landed.
 *
 * Same family as #353 and #368: a guardrail that exists, works, and reports
 * to nobody.
 */

/** A clock that never moves, so lastRunTimestamp is predictable. */
const clock = { now: () => 1_700_000_000 };

/** A database whose every prepare() throws — the shape of a real failure. */
function brokenDb() {
  return {
    prepare() {
      throw new Error("no such column: row_hash");
    },
    transaction: (fn: () => unknown) => fn,
  } as unknown as Database.Database;
}

function workingDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE oauth_state (id TEXT PRIMARY KEY, expires_at INTEGER);
    CREATE TABLE device_auth_requests (id TEXT PRIMARY KEY, expires_at TEXT);
    CREATE TABLE refresh_tokens (id TEXT PRIMARY KEY, revoked_at TEXT, expires_at TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, created_at TEXT);
    CREATE TABLE file_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT);
    CREATE TABLE thread_messages (id TEXT PRIMARY KEY, created_at TEXT);
    CREATE TABLE action_summaries (id TEXT PRIMARY KEY, created_at TEXT);
    CREATE TABLE layer_firings (id INTEGER PRIMARY KEY AUTOINCREMENT, fired_at TEXT);
    CREATE TABLE orgs (id TEXT PRIMARY KEY);
  `);
  return db;
}

/** Current value of an unlabelled gauge on the Phase 2 registry. */
async function gauge(name: string): Promise<number | undefined> {
  const metric = await registry.getSingleMetricAsString(name);
  const line = metric.split("\n").find((l) => l.startsWith(name) && !l.startsWith(name + "{"));
  return line ? Number(line.split(" ").pop()) : undefined;
}

describe("a stopped sweeper says why it stopped", () => {
  beforeEach(() => {
    sweeperCircuitOpen.reset();
    sweeperConsecutiveFailures.reset();
    sweeperLastRunTimestamp.reset();
    sweeperRowsDeletedTotal.reset();
  });

  it("keeps the failure message instead of discarding it", () => {
    const sweeper = new Sweeper(brokenDb(), clock);
    sweeper.runPass();
    // The exact string an operator needs. Before, the catch bound nothing and
    // this was unknowable from outside the process.
    expect(sweeper.metrics.lastError).toBe("no such column: row_hash");
    expect(sweeper.metrics.consecutiveFailures).toBe(1);
    expect(sweeper.metrics.circuitOpen).toBe(false);
  });

  it("still trips the breaker after five, now with a reason attached", () => {
    const sweeper = new Sweeper(brokenDb(), clock);
    for (let i = 0; i < 5; i++) sweeper.runPass();
    expect(sweeper.metrics.circuitOpen).toBe(true);
    expect(sweeper.metrics.lastError).toBe("no such column: row_hash");
  });

  it("clears the reason once a pass succeeds", () => {
    const db = workingDb();
    const sweeper = new Sweeper(db, clock);
    // Force one failure, then let a real pass run.
    const broken = new Sweeper(brokenDb(), clock);
    broken.runPass();
    expect(broken.metrics.lastError).not.toBeNull();

    sweeper.runPass();
    expect(sweeper.metrics.lastError).toBeNull();
    db.close();
  });

  it("resetCircuit clears the reason too", () => {
    const sweeper = new Sweeper(brokenDb(), clock);
    for (let i = 0; i < 5; i++) sweeper.runPass();
    sweeper.resetCircuit();
    expect(sweeper.metrics.circuitOpen).toBe(false);
    expect(sweeper.metrics.lastError).toBeNull();
  });
});

describe("the sweeper's Prometheus gauges are actually set", () => {
  beforeEach(() => {
    sweeperCircuitOpen.reset();
    sweeperConsecutiveFailures.reset();
    sweeperLastRunTimestamp.reset();
    sweeperRowsDeletedTotal.reset();
  });

  it("publishes circuit_open, so the paging alert can fire", async () => {
    // docs/ops/alerts/coordinator-alerts.yaml keys a severity:page alert on
    // coordinator_sweeper_circuit_open == 1. Nothing ever set it.
    const sweeper = new Sweeper(brokenDb(), clock);
    for (let i = 0; i < 5; i++) sweeper.runPass();
    expect(sweeper.metrics.circuitOpen).toBe(true);
    expect(await gauge("coordinator_sweeper_circuit_open")).toBe(1);
  });

  it("publishes consecutive_failures as it climbs", async () => {
    const sweeper = new Sweeper(brokenDb(), clock);
    sweeper.runPass();
    expect(await gauge("coordinator_sweeper_consecutive_failures")).toBe(1);
    sweeper.runPass();
    expect(await gauge("coordinator_sweeper_consecutive_failures")).toBe(2);
  });

  it("publishes last_run_timestamp after a successful pass", async () => {
    const db = workingDb();
    new Sweeper(db, clock).runPass();
    expect(await gauge("coordinator_sweeper_last_run_timestamp")).toBe(1_700_000_000);
    db.close();
  });

  it("reads 0, not a stale time, when no pass has ever succeeded", async () => {
    // prom-client Gauges report 0 until first set, and this one is only set
    // after a successful pass. So 0 means "never succeeded", not "ran at the
    // epoch" — worth knowing before alerting on time() - metric.
    new Sweeper(brokenDb(), clock).runPass();
    expect(await gauge("coordinator_sweeper_last_run_timestamp")).toBe(0);
  });

  it("adds only the delta to the rows-deleted counter across passes", async () => {
    // _rowsDeletedByTable is cumulative and the metric is a Counter; adding
    // the running total each pass would double-count.
    const db = workingDb();
    // 2020, not 2000, on purpose. The sweeper compares
    // strftime('%s', created_at) to the cutoff as TEXT, so the comparison is
    // lexicographic: a 9-digit epoch (anything before 2001-09-09) sorts
    // ABOVE a 10-digit one and is never swept. No coordinator row can
    // predate 2001, so this is a curiosity rather than a bug — but it makes
    // a fixture dated 2000 silently sweep nothing.
    const old = "2020-01-01T00:00:00Z";
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO events (created_at) VALUES (?)").run(old);
    }
    const sweeper = new Sweeper(db, clock);
    sweeper.runPass();
    const after = await registry.getSingleMetricAsString("coordinator_sweeper_rows_deleted_total");
    const events = after.split("\n").find((l) => l.includes('table="events"'));
    expect(events, "no events row in the counter").toBeDefined();
    expect(Number(events!.split(" ").pop())).toBe(3);

    // A second pass deletes nothing; the counter must not move.
    sweeper.runPass();
    const after2 = await registry.getSingleMetricAsString("coordinator_sweeper_rows_deleted_total");
    const events2 = after2.split("\n").find((l) => l.includes('table="events"'));
    expect(Number(events2!.split(" ").pop())).toBe(3);
    db.close();
  });
});

describe("readiness gets the real circuit signal (#348 side-finding)", () => {
  const SERVE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "serve-http.ts"),
    "utf8",
  );

  it("handleHealthReady is called with the sweeper's actual state", () => {
    // The handler always honoured the flag — tests/unit/health.test.ts:98 pins
    // that it answers 503 with sweeper.ok=false. What was missing was a
    // production caller passing it: `await handleHealthReady(req, res)` with
    // no options at all, so `opts.sweeperCircuitOpen ?? false` was always
    // false. A tested capability with no caller.
    const call = SERVE.slice(SERVE.indexOf("handleHealthReady(req, res"));
    expect(call.slice(0, 200)).toContain("sweeperCircuitOpen");
    expect(call.slice(0, 200)).toContain("retentionSweeper.metrics.circuitOpen");
  });

  it("the handler ctx carries the sweeper so the value is read per request", () => {
    // Capturing a boolean at wiring time would freeze it at false forever.
    expect(SERVE).toContain("retentionSweeper: Sweeper;");
  });
});
