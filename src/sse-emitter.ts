import { getDb } from "./database.js";
import type { CoordinatorEvent, EventType } from "./types.js";

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

export class SseEmitter {
  private entries: ListenerEntry[] = [];
  // P3: track refusals so operators can see when the cap is being hit.
  // Also lets tests assert "we refused without throwing" without scraping logs.
  private rejectedCount = 0;

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
        } catch {
          // Listener errors must not crash the emitter or affect siblings.
          // Drop silently — the SSE response writers swallow their own
          // socket errors via the unsubscribe path on req.on("close").
        }
      });
    }
  }

  getEventsSince(orgId: string, lastId: number): CoordinatorEvent[] {
    const db = getDb();
    return db
      .prepare("SELECT * FROM events WHERE org_id = ? AND id > ? ORDER BY id")
      .all(orgId, lastId) as CoordinatorEvent[];
  }

  addListener(orgId: string, listener: EventListener): () => void {
    // P3: refuse-with-no-op when the cap is reached. Returning a no-op
    // keeps the caller's unsubscribe contract intact (no special-casing
    // upstream) while preventing the array from growing past MAX_SSE_CLIENTS.
    if (this.entries.length >= MAX_SSE_CLIENTS) {
      this.rejectedCount++;
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
}
