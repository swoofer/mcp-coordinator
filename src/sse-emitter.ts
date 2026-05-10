import { getDb } from "./database.js";
import type { CoordinatorEvent, EventType } from "./types.js";

type EventListener = (event: CoordinatorEvent) => void;

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
  private listeners: EventListener[] = [];
  // P3: track refusals so operators can see when the cap is being hit.
  // Also lets tests assert "we refused without throwing" without scraping logs.
  private rejectedCount = 0;

  emit(type: EventType, payload: Record<string, unknown>): void {
    const db = getDb();
    const payloadStr = JSON.stringify(payload);
    const result = db
      .prepare("INSERT INTO events (type, payload) VALUES (?, ?)")
      .run(type, payloadStr);

    const event: CoordinatorEvent = {
      id: result.lastInsertRowid as number,
      type,
      payload: payloadStr,
      created_at: new Date().toISOString(),
    };

    // P3: async fan-out via setImmediate so a slow listener (e.g. a stalled
    // SSE client whose socket buffer is full) cannot block siblings or the
    // emit() caller. Snapshot the array first so a listener that unsubscribes
    // mid-loop doesn't shift indices under us.
    const snapshot = this.listeners.slice();
    for (const listener of snapshot) {
      setImmediate(() => {
        try {
          listener(event);
        } catch {
          // Listener errors must not crash the emitter or affect siblings.
          // Drop silently — the SSE response writers swallow their own
          // socket errors via the unsubscribe path on req.on("close").
        }
      });
    }
  }

  getEventsSince(lastId: number): CoordinatorEvent[] {
    const db = getDb();
    return db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id")
      .all(lastId) as CoordinatorEvent[];
  }

  addListener(listener: EventListener): () => void {
    // P3: refuse-with-no-op when the cap is reached. Returning a no-op
    // keeps the caller's unsubscribe contract intact (no special-casing
    // upstream) while preventing the array from growing past MAX_SSE_CLIENTS.
    if (this.listeners.length >= MAX_SSE_CLIENTS) {
      this.rejectedCount++;
      return NOOP;
    }
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  removeAllListeners(): void {
    this.listeners = [];
  }

  /** P3: introspection for tests + ops dashboards. */
  listenerCount(): number {
    return this.listeners.length;
  }

  /** P3: count of addListener calls refused due to MAX_SSE_CLIENTS. */
  getRejectedCount(): number {
    return this.rejectedCount;
  }
}
