import { getDb } from "./database.js";
import type { CoordinatorEvent, EventType } from "./types.js";
import { silentLogger, type Logger } from "./logger.js";

type EventListener = (event: CoordinatorEvent) => void;

interface ListenerEntry {
  orgId: string;
  listener: EventListener;
}

interface EmitOptions {
  org_id: string;
}

/**
 * P3: bound the listener array so a runaway client (or DoS attempt) can't
 * grow it without limit. Default 100 covers a small-to-mid swarm — enough
 * headroom for a dashboard + every agent + a handful of CLI tailers, but
 * not so large that a leak would silently exhaust memory. Override via
 * COORDINATOR_MAX_SSE_CLIENTS for larger deployments.
 */
const DEFAULT_MAX_SSE_CLIENTS = 100;

export const MAX_SSE_CLIENTS = (() => {
  const raw = process.env.COORDINATOR_MAX_SSE_CLIENTS;
  if (!raw) return DEFAULT_MAX_SSE_CLIENTS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SSE_CLIENTS;
})();

const NOOP = () => {};

/**
 * issue #353: a saturated cap or a listener that throws on every event would
 * otherwise emit one line per attempt. The first occurrence is always logged,
 * then one in every SAMPLE, so a systematic failure stays visible without
 * drowning the log. The counters are exact regardless of sampling.
 */
const LOG_SAMPLE = 100;

export class SseEmitter {
  private entries: ListenerEntry[] = [];
  // P3: track refusals so operators can see when the cap is being hit.
  // Also lets tests assert "we refused without throwing" without scraping logs.
  private rejectedCount = 0;
  // #353: listener callbacks that threw during fan-out. The throw is still
  // swallowed -- one bad listener must not take out its siblings -- but it is
  // no longer invisible.
  private listenerErrorCount = 0;
  private readonly log: Logger;
  private onRejected: () => void = () => {};
  private onListenerError: () => void = () => {};

  constructor(log: Logger = silentLogger) {
    this.log = log;
  }

  /**
   * #353: wire the Prometheus counters. Kept as setters rather than a
   * constructor dependency so the emitter stays constructible in tests and in
   * stdio mode without a metrics registry.
   */
  setMetricSinks(sinks: { onRejected?: () => void; onListenerError?: () => void }): void {
    if (sinks.onRejected) this.onRejected = sinks.onRejected;
    if (sinks.onListenerError) this.onListenerError = sinks.onListenerError;
  }

  emit(type: EventType, payload: Record<string, unknown>, options: EmitOptions): void {
    const db = getDb();
    // The spread `{ ...payload, org_id: options.org_id }` deliberately OVERWRITES any
    // caller-supplied `org_id` field in `payload`. The authoritative source is
    // `options.org_id` (derived from `claims.org` in the handler), so callers cannot
    // smuggle a different org through the payload. This is intentional.
    const payloadWithOrg = { ...payload, org_id: options.org_id };
    const payloadStr = JSON.stringify(payloadWithOrg);
    const result = db
      .prepare("INSERT INTO events (org_id, type, payload) VALUES (?, ?, ?)")
      .run(options.org_id, type, payloadStr);

    const event: CoordinatorEvent = {
      id: result.lastInsertRowid as number,
      type,
      payload: payloadStr,
      created_at: new Date().toISOString(),
    };

    // Snapshot + filter by org_id, then fan-out via setImmediate so a slow
    // listener (e.g. a stalled SSE client whose socket buffer is full) cannot
    // block siblings or the emit() caller. Snapshot the array first so a
    // listener that unsubscribes mid-loop doesn't shift indices under us.
    const snapshot = this.entries.filter((e) => e.orgId === options.org_id);
    for (const entry of snapshot) {
      setImmediate(() => {
        try {
          entry.listener(event);
        } catch (err) {
          // Listener errors must not crash the emitter or affect siblings.
          // Still swallowed -- but counted and sampled into the log, so a
          // listener failing on every event is visible instead of silent.
          this.listenerErrorCount++;
          this.onListenerError();
          if (this.listenerErrorCount === 1 || this.listenerErrorCount % LOG_SAMPLE === 0) {
            this.log.warn(
              { err, org_id: entry.orgId, total: this.listenerErrorCount },
              "SSE listener threw during fan-out",
            );
          }
        }
      });
    }
  }

  /**
   * performance-02: `limit` bounds the SQL result set itself (LIMIT clause)
   * rather than loading every row since `lastId` and trimming in JS. This
   * matters for the Last-Event-ID resumption path — a client reconnecting
   * with a very old id would otherwise force a full-history scan+load. When
   * `limit` is provided the DB still returns rows in ascending id order (the
   * chronological order callers expect), it just stops at `limit` rows —
   * i.e. the OLDEST `limit` events after `lastId`, not an arbitrary window.
   * Callers that need the most RECENT N events regardless of `lastId` should
   * use `getRecentEvents` instead.
   */
  getEventsSince(orgId: string, lastId: number, limit?: number): CoordinatorEvent[] {
    const db = getDb();
    if (limit === undefined) {
      return db
        .prepare("SELECT * FROM events WHERE org_id = ? AND id > ? ORDER BY id")
        .all(orgId, lastId) as CoordinatorEvent[];
    }
    return db
      .prepare("SELECT * FROM events WHERE org_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(orgId, lastId, limit) as CoordinatorEvent[];
  }

  /**
   * performance-02: the "last N events" query bounded at the SQL layer.
   * Previously callers did `getEventsSince(orgId, 0).slice(-N)`, which loads
   * the ENTIRE org history into memory (better-sqlite3 is synchronous — at
   * 200K events that's ~655ms of blocked event loop) just to keep the tail.
   * Instead we ask SQLite for the last N rows directly (`ORDER BY id DESC
   * LIMIT ?`), so at most N rows are ever materialized, then reverse in JS
   * (cheap — bounded to N elements) to restore chronological order.
   */
  getRecentEvents(orgId: string, limit: number): CoordinatorEvent[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM events WHERE org_id = ? ORDER BY id DESC LIMIT ?")
      .all(orgId, limit) as CoordinatorEvent[];
    return rows.reverse();
  }

  addListener(orgId: string, listener: EventListener): () => void {
    // P3: refuse-with-no-op when the cap is reached. Returning a no-op
    // keeps the caller's unsubscribe contract intact (no special-casing
    // upstream) while preventing the array from growing past MAX_SSE_CLIENTS.
    if (this.entries.length >= MAX_SSE_CLIENTS) {
      this.rejectedCount++;
      this.onRejected();
      if (this.rejectedCount === 1 || this.rejectedCount % LOG_SAMPLE === 0) {
        // The clients-active gauge reads exactly MAX_SSE_CLIENTS here whether
        // there are 100 healthy clients or 100 plus N refusals, so the refusal
        // has to say so itself.
        this.log.warn(
          { org_id: orgId, cap: MAX_SSE_CLIENTS, total_rejected: this.rejectedCount },
          "SSE listener refused: MAX_SSE_CLIENTS reached",
        );
      }
      return NOOP;
    }
    const entry: ListenerEntry = { orgId, listener };
    this.entries.push(entry);
    return () => {
      this.entries = this.entries.filter((e) => e !== entry);
    };
  }

  removeAllListeners(): void {
    this.entries = [];
  }

  /** P3: introspection for tests + ops dashboards. */
  listenerCount(): number {
    return this.entries.length;
  }

  /** P3: count of addListener calls refused due to MAX_SSE_CLIENTS. */
  getRejectedCount(): number {
    return this.rejectedCount;
  }

  /** #353: count of listener callbacks that threw during fan-out. */
  getListenerErrorCount(): number {
    return this.listenerErrorCount;
  }
}
