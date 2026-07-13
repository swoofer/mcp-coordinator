// Sweeper module — periodic retention pruner for 11 tables (6 Phase 2 +
// 5 Phase 1; performance-01).
// Spec refs: V4 §17.7 (sweeper design), V2 §C.12 (SQL examples).
//
// One setInterval ticks every 60s and runs a "chained pass": each chain
// iteration executes 11 bounded `DELETE ... LIMIT 1000` statements. If a
// chain iteration deletes exactly BATCH_SIZE rows (signalling that more
// stale rows likely remain), we immediately re-run, up to MAX_CHAINED_RUNS
// iterations per tick. This drains backlogs without monopolizing the loop.
//
// Tables swept:
//   1. oauth_state              expires_at < now - 60s buffer
//   2. device_auth_requests     CAST(expires_at AS INTEGER) < now - 60s buffer
//   3. refresh_tokens (revoked) revoked_at IS NOT NULL AND
//                               CAST(revoked_at AS INTEGER) < now - retention_days
//   4. refresh_tokens (expired) revoked_at IS NULL AND
//                               CAST(expires_at AS INTEGER) < now - 30d (hard limit)
//   5. audit_log Tier 1         strftime('%s', created_at) < cutoff
//                               AND action IN TIER1_EVENTS
//   6. audit_log Tier 2         strftime('%s', created_at) < cutoff
//                               AND action IN TIER2_EVENTS
//   7. file_activity            strftime('%s', created_at) < cutoff (7d)
//   8. events                   strftime('%s', created_at) < cutoff (7d)
//   9. thread_messages          strftime('%s', created_at) < cutoff (30d)
//  10. action_summaries         strftime('%s', created_at) < cutoff (30d)
//  11. layer_firings            strftime('%s', fired_at) < cutoff (30d) —
//                               NOTE: this table's timestamp column is
//                               `fired_at`, NOT `created_at` like the other
//                               Phase 1 tables.
//
// Circuit-breaker: 5 consecutive errors halt the sweeper (stop()) and set
// circuitOpen=true so T36 /health/ready can surface degraded state. Manual
// reset via resetCircuit() (test helper / admin CLI to be wired later).
//
// SIGTERM: drain() stops the interval and returns. SQLite is synchronous,
// so by the time drain() is called the current pass has already completed.
// The timeoutMs parameter is reserved for a future async driver swap.
//
// NOTE on `DELETE ... LIMIT`: this syntax requires the SQLite compile flag
// SQLITE_ENABLE_UPDATE_DELETE_LIMIT. better-sqlite3 ships with it enabled by
// default; if a custom build disables it these queries will throw. The
// circuit-breaker will trip after 5 ticks and halt the sweeper.
//
// Configuration (via T44 getOrgSetting; respects per-org overrides → env
// fallback → built-in default):
//   refresh_retention_days           default 180  (revoked refresh_tokens TTL)
//   audit_retention_days             default 365  (Tier 1 audit_log TTL)
//   audit_tier2_retention_days       default 90   (Tier 2 audit_log TTL)
//   file_activity_retention_days     default 7    (performance-01)
//   events_retention_days            default 7    (performance-01)
//   thread_messages_retention_days   default 30   (performance-01)
//   action_summaries_retention_days  default 30   (performance-01)
//   layer_firings_retention_days     default 30   (performance-01)
//
// WIRING NOTE (performance-01): this Sweeper is instantiated in TWO places
// depending on deployment profile — never both at once for the same
// process. src/boot.ts (bootPhase2) starts it when Phase 2 OAuth is active
// (COORDINATOR_OAUTH_ENABLED=true); src/serve-http.ts (startServer) starts
// its OWN instance only when bootPhase2 did NOT run (Phase-1-only, the
// default mono-tenant deployment) so retention still runs there. See
// src/serve-http.ts for the guard that prevents a double-start.

import type Database from "better-sqlite3";
import type { Clock } from "../auth/clock.js";
import { getOrgSetting } from "../auth/org-settings.js";
import { TIER1_EVENTS, TIER2_EVENTS } from "../security/audit-events.js";

const SWEEP_INTERVAL_MS = 60_000;
const BATCH_SIZE = 1000;
const MAX_CHAINED_RUNS = 3;
const CIRCUIT_BREAK_THRESHOLD = 5;
const STALE_BUFFER_S = 60;
const REFRESH_EXPIRED_RETENTION_DAYS = 30;
const SECONDS_PER_DAY = 86_400;

export interface SweeperMetrics {
  readonly lastRunTimestamp: number | null;
  readonly rowsDeletedByTable: Readonly<Record<string, number>>;
  readonly consecutiveFailures: number;
  readonly circuitOpen: boolean;
  readonly totalRuns: number;
}

export class Sweeper {
  private timer: NodeJS.Timeout | null = null;
  private _lastRunTimestamp: number | null = null;
  private _consecutiveFailures = 0;
  private _circuitOpen = false;
  private _totalRuns = 0;
  private _rowsDeletedByTable: Record<string, number> = {
    oauth_state: 0,
    device_auth_requests: 0,
    refresh_tokens_revoked: 0,
    refresh_tokens_expired: 0,
    audit_log_tier1: 0,
    audit_log_tier2: 0,
    file_activity: 0,
    events: 0,
    thread_messages: 0,
    action_summaries: 0,
    layer_firings: 0,
  };

  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  /** Start the periodic timer. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runPass(), SWEEP_INTERVAL_MS);
    // Unref so the timer doesn't block process exit (T29 may rely on this).
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop the periodic timer. Safe to call multiple times. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one chained pass. If a chain iteration deletes BATCH_SIZE rows,
   * re-run immediately up to MAX_CHAINED_RUNS times to drain backlogs.
   * On error, increments the consecutive-failure counter and trips the
   * circuit breaker after CIRCUIT_BREAK_THRESHOLD failures.
   */
  runPass(): void {
    if (this._circuitOpen) return;
    try {
      let chained = 0;
      while (chained < MAX_CHAINED_RUNS) {
        const deletedThisRun = this.sweepAll();
        chained++;
        if (deletedThisRun < BATCH_SIZE) break;
      }
      this._lastRunTimestamp = this.clock.now();
      this._consecutiveFailures = 0;
      this._totalRuns++;
    } catch {
      this._consecutiveFailures++;
      if (this._consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
        this._circuitOpen = true;
        this.stop();
      }
    }
  }

  /** Run a single pass across all 11 tables. Returns total rows deleted. */
  private sweepAll(): number {
    const now = this.clock.now();
    const refreshRetentionDays = Number(
      getOrgSetting(this.db, null, "refresh_retention_days", "180"),
    );
    const auditRetentionDays = Number(getOrgSetting(this.db, null, "audit_retention_days", "365"));
    const auditTier2RetentionDays = Number(
      getOrgSetting(this.db, null, "audit_tier2_retention_days", "90"),
    );
    const fileActivityRetentionDays = Number(
      getOrgSetting(this.db, null, "file_activity_retention_days", "7"),
    );
    const eventsRetentionDays = Number(getOrgSetting(this.db, null, "events_retention_days", "7"));
    const threadMessagesRetentionDays = Number(
      getOrgSetting(this.db, null, "thread_messages_retention_days", "30"),
    );
    const actionSummariesRetentionDays = Number(
      getOrgSetting(this.db, null, "action_summaries_retention_days", "30"),
    );
    const layerFiringsRetentionDays = Number(
      getOrgSetting(this.db, null, "layer_firings_retention_days", "30"),
    );

    let total = 0;

    // 1. oauth_state — INTEGER epoch columns (Phase 2 schema, T01a).
    const oauthDeleted = this.db
      .prepare(`DELETE FROM oauth_state WHERE expires_at < ? LIMIT ?`)
      .run(now - STALE_BUFFER_S, BATCH_SIZE).changes;
    this._rowsDeletedByTable.oauth_state += oauthDeleted;
    total += oauthDeleted;

    // 2. device_auth_requests — expires_at is TEXT (Phase 1 schema, but
    //    T17 writes numeric epoch strings). CAST handles both forms safely.
    const deviceDeleted = this.db
      .prepare(`DELETE FROM device_auth_requests WHERE CAST(expires_at AS INTEGER) < ? LIMIT ?`)
      .run(now - STALE_BUFFER_S, BATCH_SIZE).changes;
    this._rowsDeletedByTable.device_auth_requests += deviceDeleted;
    total += deviceDeleted;

    // 3. refresh_tokens revoked retention — revoked_at is TEXT (Phase 1
    //    schema; recent code casts via Number()).
    const refreshRevokedCutoff = now - refreshRetentionDays * SECONDS_PER_DAY;
    const refreshRevokedDeleted = this.db
      .prepare(
        `DELETE FROM refresh_tokens WHERE revoked_at IS NOT NULL AND CAST(revoked_at AS INTEGER) < ? LIMIT ?`,
      )
      .run(refreshRevokedCutoff, BATCH_SIZE).changes;
    this._rowsDeletedByTable.refresh_tokens_revoked += refreshRevokedDeleted;
    total += refreshRevokedDeleted;

    // 4. refresh_tokens lingering expired un-revoked — hard 30d cap to
    //    avoid orphan rows from refresh chains that were never revoked
    //    cleanly (e.g., a server crash mid-rotation).
    const refreshExpiredCutoff = now - REFRESH_EXPIRED_RETENTION_DAYS * SECONDS_PER_DAY;
    const refreshExpiredDeleted = this.db
      .prepare(
        `DELETE FROM refresh_tokens WHERE revoked_at IS NULL AND CAST(expires_at AS INTEGER) < ? LIMIT ?`,
      )
      .run(refreshExpiredCutoff, BATCH_SIZE).changes;
    this._rowsDeletedByTable.refresh_tokens_expired += refreshExpiredDeleted;
    total += refreshExpiredDeleted;

    // 5. audit_log Tier 1 — created_at is TEXT ISO-8601 (CURRENT_TIMESTAMP
    //    default from T01a). strftime('%s', ...) converts ISO → epoch
    //    seconds as a TEXT result; bind cutoff as a string for type-safe
    //    lexicographic comparison (10-digit epochs sort correctly).
    const auditTier1Cutoff = now - auditRetentionDays * SECONDS_PER_DAY;
    const tier1Placeholders = TIER1_EVENTS.map(() => "?").join(",");
    const tier1Deleted = this.db
      .prepare(
        `DELETE FROM audit_log WHERE strftime('%s', created_at) < ? AND action IN (${tier1Placeholders}) LIMIT ?`,
      )
      .run(String(auditTier1Cutoff), ...TIER1_EVENTS, BATCH_SIZE).changes;
    this._rowsDeletedByTable.audit_log_tier1 += tier1Deleted;
    total += tier1Deleted;

    // 6. audit_log Tier 2 — same shape, shorter retention.
    const auditTier2Cutoff = now - auditTier2RetentionDays * SECONDS_PER_DAY;
    const tier2Placeholders = TIER2_EVENTS.map(() => "?").join(",");
    const tier2Deleted = this.db
      .prepare(
        `DELETE FROM audit_log WHERE strftime('%s', created_at) < ? AND action IN (${tier2Placeholders}) LIMIT ?`,
      )
      .run(String(auditTier2Cutoff), ...TIER2_EVENTS, BATCH_SIZE).changes;
    this._rowsDeletedByTable.audit_log_tier2 += tier2Deleted;
    total += tier2Deleted;

    // 7. file_activity — TEXT ISO-8601 created_at (performance-01).
    const fileActivityCutoff = now - fileActivityRetentionDays * SECONDS_PER_DAY;
    const fileActivityDeleted = this.db
      .prepare(`DELETE FROM file_activity WHERE strftime('%s', created_at) < ? LIMIT ?`)
      .run(String(fileActivityCutoff), BATCH_SIZE).changes;
    this._rowsDeletedByTable.file_activity += fileActivityDeleted;
    total += fileActivityDeleted;

    // 8. events — TEXT ISO-8601 created_at (performance-01).
    const eventsCutoff = now - eventsRetentionDays * SECONDS_PER_DAY;
    const eventsDeleted = this.db
      .prepare(`DELETE FROM events WHERE strftime('%s', created_at) < ? LIMIT ?`)
      .run(String(eventsCutoff), BATCH_SIZE).changes;
    this._rowsDeletedByTable.events += eventsDeleted;
    total += eventsDeleted;

    // 9. thread_messages — TEXT ISO-8601 created_at (performance-01).
    const threadMessagesCutoff = now - threadMessagesRetentionDays * SECONDS_PER_DAY;
    const threadMessagesDeleted = this.db
      .prepare(`DELETE FROM thread_messages WHERE strftime('%s', created_at) < ? LIMIT ?`)
      .run(String(threadMessagesCutoff), BATCH_SIZE).changes;
    this._rowsDeletedByTable.thread_messages += threadMessagesDeleted;
    total += threadMessagesDeleted;

    // 10. action_summaries — TEXT ISO-8601 created_at (performance-01).
    const actionSummariesCutoff = now - actionSummariesRetentionDays * SECONDS_PER_DAY;
    const actionSummariesDeleted = this.db
      .prepare(`DELETE FROM action_summaries WHERE strftime('%s', created_at) < ? LIMIT ?`)
      .run(String(actionSummariesCutoff), BATCH_SIZE).changes;
    this._rowsDeletedByTable.action_summaries += actionSummariesDeleted;
    total += actionSummariesDeleted;

    // 11. layer_firings — TEXT ISO-8601 fired_at (⚠️ NOT created_at;
    //     performance-01).
    const layerFiringsCutoff = now - layerFiringsRetentionDays * SECONDS_PER_DAY;
    const layerFiringsDeleted = this.db
      .prepare(`DELETE FROM layer_firings WHERE strftime('%s', fired_at) < ? LIMIT ?`)
      .run(String(layerFiringsCutoff), BATCH_SIZE).changes;
    this._rowsDeletedByTable.layer_firings += layerFiringsDeleted;
    total += layerFiringsDeleted;

    return total;
  }

  /**
   * SIGTERM hook: stop the timer and return. SQLite is synchronous so the
   * current pass (if any) has already finished by the time the event loop
   * returns control to the SIGTERM handler. The timeoutMs argument is
   * reserved for a future async driver swap.
   */
  async drain(_timeoutMs: number = 5000): Promise<void> {
    this.stop();
  }

  get metrics(): SweeperMetrics {
    return {
      lastRunTimestamp: this._lastRunTimestamp,
      rowsDeletedByTable: { ...this._rowsDeletedByTable },
      consecutiveFailures: this._consecutiveFailures,
      circuitOpen: this._circuitOpen,
      totalRuns: this._totalRuns,
    };
  }

  /** Test/admin helper: manually reset the circuit breaker. */
  resetCircuit(): void {
    this._circuitOpen = false;
    this._consecutiveFailures = 0;
  }
}
