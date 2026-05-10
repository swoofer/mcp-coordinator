// tests/unit/p3-sse-resilience.test.ts
//
// P3 — SSE resilience: bounded listeners, async fan-out, heartbeat,
// interval cleanup on response close.
//
// Note on imports: MAX_SSE_CLIENTS is a module-load-time constant derived
// from process.env.COORDINATOR_MAX_SSE_CLIENTS. We import it after the
// production code has captured its value, so test 1 asserts against the
// real default (100). To exercise an artificially low cap without bouncing
// the module, we just overwhelm a fresh emitter — the cap behavior is
// independent of the cap *value*.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { initDatabase, closeDb, getDb } from "../../src/database.js";
import { SseEmitter, MAX_SSE_CLIENTS } from "../../src/sse-emitter.js";
import fs from "fs";

const TEST_DIR = "data-test-p3-sse";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

beforeEach(() => {
  // Each test starts from a clean events table so we can count fan-outs
  // deterministically (no historical events injected by neighbours).
  getDb().exec("DELETE FROM events");
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── Fix 1: bounded listeners ──────────────────────────────────────────────
describe("P3 Fix 1 — bounded listeners (refuse-with-no-op)", () => {
  it("returns a no-op unsubscribe once MAX_SSE_CLIENTS is reached", () => {
    const emitter = new SseEmitter();

    // Fill to the cap with cheap stub listeners.
    for (let i = 0; i < MAX_SSE_CLIENTS; i++) {
      emitter.addListener(() => {});
    }
    expect(emitter.listenerCount()).toBe(MAX_SSE_CLIENTS);
    expect(emitter.getRejectedCount()).toBe(0);

    // The next addListener must be refused. Behavior contract:
    //   - returns a function (not throws)
    //   - the listener is NOT registered (count stays at cap)
    //   - rejectedCount increments
    //   - calling the returned function is safe (no-op)
    const unsub = emitter.addListener(() => {
      throw new Error("should never run — refused listener");
    });

    expect(typeof unsub).toBe("function");
    expect(emitter.listenerCount()).toBe(MAX_SSE_CLIENTS);
    expect(emitter.getRejectedCount()).toBe(1);
    expect(() => unsub()).not.toThrow();
  });

  it("MAX_SSE_CLIENTS exposes a positive integer default", () => {
    // Sanity check on the chosen default — protects against accidental
    // 0/NaN/negative regressions in the env-parsing logic.
    expect(MAX_SSE_CLIENTS).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_SSE_CLIENTS)).toBe(true);
  });
});

// ── Fix 3: async fan-out doesn't block on a slow listener ─────────────────
describe("P3 Fix 3 — async fan-out (slow listener doesn't block)", () => {
  it("emit() returns immediately even when a listener takes >100ms", () => {
    const emitter = new SseEmitter();
    const slowListenerStarted: number[] = [];

    // Mount a deliberately slow listener. Note: this BLOCKS the event loop
    // when it runs (synchronous busy-wait), but because we wrap each
    // listener in setImmediate, it runs *after* emit() returns.
    emitter.addListener(() => {
      slowListenerStarted.push(Date.now());
      const start = Date.now();
      while (Date.now() - start < 150) {
        // synchronous block — would freeze emit() if fan-out were sync
      }
    });

    const t0 = Date.now();
    emitter.emit("agent_online", { agent_id: "a1" });
    const elapsed = Date.now() - t0;

    // The whole point: emit() returned without waiting on the slow listener.
    // Generous bound (10ms) accounts for SQLite insert + JSON.stringify on
    // slow CI runners; the slow listener is 150ms, so signal-to-noise is huge.
    expect(elapsed).toBeLessThan(10);
    expect(slowListenerStarted).toHaveLength(0); // hasn't fired yet
  });

  it("a throwing listener does not affect siblings", async () => {
    const emitter = new SseEmitter();
    const sibling: string[] = [];

    emitter.addListener(() => {
      throw new Error("boom — should be swallowed by emitter");
    });
    emitter.addListener((event) => {
      sibling.push(event.type);
    });

    emitter.emit("agent_online", { agent_id: "a1" });
    await flush();

    expect(sibling).toContain("agent_online");
  });
});

// ── Fix 2 + Fix 4: heartbeat writes and is cleared on close ───────────────
//
// We don't spin up the full HTTP server here — that would require a real
// socket, a coordinator boot, and would make the test brittle to fake-timer
// interactions. Instead we model the exact piece of handleSse the audit
// flagged: a setInterval that writes a heartbeat, paired with a close
// listener that clears it. This mirrors the production code in
// src/serve-http.ts (handleSse) line-for-line.
describe("P3 Fix 2 + Fix 4 — heartbeat + interval cleanup on close", () => {
  let writes: string[];
  let req: EventEmitter;
  let res: { write: (chunk: string) => void };
  let heartbeat: NodeJS.Timeout;

  // Mirror of production handleSse's heartbeat block. Kept inline (not
  // imported) because handleSse needs a real http.IncomingMessage/
  // ServerResponse pair, and the value under test here is the timer
  // lifecycle, not the HTTP plumbing.
  function startHeartbeat(intervalMs: number): NodeJS.Timeout {
    const t = setInterval(() => {
      try {
        res.write(":keep-alive\n\n");
      } catch {
        // socket closed — handled by the close listener
      }
    }, intervalMs);
    if (typeof t.unref === "function") t.unref();
    return t;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    writes = [];
    req = new EventEmitter();
    res = { write: (chunk: string) => { writes.push(chunk); } };
  });

  afterEach(() => {
    // Defence in depth — if a test forgot to wire close, kill the timer
    // here so vitest's fake timers don't leak between tests.
    if (heartbeat) clearInterval(heartbeat);
    vi.useRealTimers();
  });

  it("writes a heartbeat after the configured interval", () => {
    const HEARTBEAT_MS = 30_000;
    heartbeat = startHeartbeat(HEARTBEAT_MS);

    expect(writes).toHaveLength(0);

    // Just before the interval — still no heartbeat.
    vi.advanceTimersByTime(HEARTBEAT_MS - 1);
    expect(writes).toHaveLength(0);

    // Cross the interval — exactly one heartbeat fires.
    vi.advanceTimersByTime(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(":keep-alive\n\n");

    // And it keeps firing on each subsequent interval (proves it's a
    // setInterval, not a setTimeout).
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(writes).toHaveLength(3);
  });

  it("clearing the interval on req close stops further writes (no leak)", () => {
    const HEARTBEAT_MS = 30_000;
    heartbeat = startHeartbeat(HEARTBEAT_MS);

    // Wire the same close handler production handleSse uses: clear interval
    // first, then call unsubscribe (modelled here as a no-op since the
    // emitter is exercised in Fix 1/3 specs).
    let unsubscribed = false;
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribed = true;
    });

    // First interval — heartbeat fires.
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(writes).toHaveLength(1);

    // Client disconnects.
    req.emit("close");
    expect(unsubscribed).toBe(true);

    // Advance well past several would-be intervals. No further writes.
    vi.advanceTimersByTime(HEARTBEAT_MS * 5);
    expect(writes).toHaveLength(1);
  });
});
