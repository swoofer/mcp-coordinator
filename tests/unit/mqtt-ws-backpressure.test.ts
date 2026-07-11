import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { EventEmitter } from "events";
import { Duplex } from "stream";
import { createServer, type Server as HttpServer } from "http";
import mqtt from "mqtt";
import { WebSocket as RawWebSocket } from "ws";
import type { WebSocket } from "ws";
import { startEmbeddedMqttBroker, wsToDuplex } from "../../src/mqtt-broker.js";
import { silentLogger } from "../../src/logger.js";

/**
 * performance-04 — WS<->MQTT bridge backpressure + maxPayload.
 *
 * Before this fix, `wsToDuplex` (src/mqtt-broker.ts):
 *  1. `write(chunk, _, cb) { ws.send(chunk); cb(); }` called `cb()`
 *     synchronously, before the chunk was actually flushed to the socket —
 *     a slow WS consumer let `ws.bufferedAmount` grow without bound because
 *     the writer was never told to slow down.
 *  2. `ws.on("message", d => duplex.push(d))` ignored `push()`'s return
 *     value, so a slow-draining aedes side let inbound WS data buffer
 *     without bound.
 *  3. The `WebSocketServer` had no `maxPayload`, so `ws`'s 100 MiB default
 *     applied — a single oversized frame could be sent unbounded-ish.
 *
 * The fixed `wsToDuplex` threads `ws.send`'s flush callback through to the
 * Duplex `write` callback (real backpressure), respects `push()`'s return
 * value by pausing/resuming the socket, and the WebSocketServer is now
 * constructed with a 1 MiB `maxPayload`.
 */

// ---------------------------------------------------------------------------
// Fake `ws`-shaped WebSocket for fine-grained control over flush timing.
// ---------------------------------------------------------------------------
interface FakeWebSocket extends EventEmitter {
  send: (data: unknown, cb: (err?: Error) => void) => void;
  pause: () => void;
  resume: () => void;
  close: () => void;
}

/** wsToDuplex only touches send/pause/resume/close/on — safe to cast our
 * fake through `unknown` rather than implementing every `ws.WebSocket` member. */
function asWebSocket(fake: FakeWebSocket): WebSocket {
  return fake as unknown as WebSocket;
}

describe("wsToDuplex — write backpressure (performance-04)", () => {
  it("does not call ws.send again until the previous send's flush callback fires (bounded, not unbounded)", () => {
    let sendCalls = 0;
    const pendingCbs: Array<(err?: Error) => void> = [];
    const ws = new EventEmitter() as unknown as FakeWebSocket;
    ws.send = (_data, cb) => { sendCalls++; pendingCbs.push(cb); };
    ws.pause = () => {};
    ws.resume = () => {};
    ws.close = () => {};

    const duplex = wsToDuplex(asWebSocket(ws));
    const chunk = Buffer.alloc(4096, 1);

    // A well-behaved writer stops as soon as write() returns false and waits
    // for 'drain'. Simulate that: keep writing until backpressure kicks in.
    let ok = true;
    let writes = 0;
    while (ok && writes < 1000) {
      ok = duplex.write(chunk);
      writes++;
    }

    // The fake ws.send() never actually flushes (no auto-resolve), so with
    // the fix in place the Duplex must not have handed more than one chunk
    // to the underlying transport at a time — proving the write callback
    // threading (not "fire and forget") is what gates further writes.
    expect(sendCalls).toBe(1);
    // Backpressure must have kicked in well before exhausting the write loop
    // guard — i.e. write() eventually returned false instead of accepting
    // unbounded chunks.
    expect(ok).toBe(false);
    expect(writes).toBeLessThan(1000);

    // Cleanup: flush the pending callback so the Duplex doesn't leak a timer/handle.
    pendingCbs.forEach((cb) => cb());
  });

  it("contrast: the pre-fix pattern (cb() called synchronously, ignoring flush) never applies backpressure", () => {
    // Inline reproduction of the buggy write() from before this fix, to make
    // the contrast with the fixed wsToDuplex() explicit without touching
    // production code.
    let sendCalls = 0;
    const buggyWs: { send: (data: unknown) => void } = {
      send: () => { sendCalls++; /* never flushes, real socket buffer grows unbounded */ },
    };

    const buggyDuplex = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        buggyWs.send(chunk);
        cb(); // <-- the bug: fires immediately, no real flush signal
      },
    });

    const chunk = Buffer.alloc(4096, 1);
    let ok = true;
    for (let i = 0; i < 200; i++) {
      ok = buggyDuplex.write(chunk);
    }
    // Every write "succeeds" instantly and ws.send is invoked 200 times with
    // no backpressure ever applied — this is exactly the unbounded-growth
    // hazard the fix eliminates.
    expect(sendCalls).toBe(200);
    expect(ok).toBe(true);
  });

  it("resumes writing once the flush callback fires (drain), and delivers chunks in order", async () => {
    let sendCalls = 0;
    const pendingCbs: Array<(err?: Error) => void> = [];
    const receivedSizes: number[] = [];
    const ws = new EventEmitter() as unknown as FakeWebSocket;
    ws.send = (data, cb) => {
      sendCalls++;
      receivedSizes.push((data as Buffer).length);
      pendingCbs.push(cb);
    };
    ws.pause = () => {};
    ws.resume = () => {};
    ws.close = () => {};

    const duplex = wsToDuplex(asWebSocket(ws));
    const chunkA = Buffer.alloc(10, 0xaa);
    const chunkB = Buffer.alloc(10, 0xbb);

    duplex.write(chunkA);
    duplex.write(chunkB);
    expect(sendCalls).toBe(1); // second chunk withheld until first flushes

    pendingCbs.shift()?.(); // flush chunk A
    await vi.waitFor(() => expect(sendCalls).toBe(2));

    pendingCbs.shift()?.(); // flush chunk B
    expect(receivedSizes).toEqual([10, 10]);
  });

  it("propagates a send error to the write callback instead of hanging", async () => {
    const ws = new EventEmitter() as unknown as FakeWebSocket;
    ws.send = (_data, cb) => cb(new Error("socket blew up"));
    ws.pause = () => {};
    ws.resume = () => {};
    ws.close = () => {};

    const duplex = wsToDuplex(asWebSocket(ws));
    const errored = new Promise<Error | null | undefined>((resolve) => {
      duplex.write(Buffer.from("x"), (err) => resolve(err));
    });
    expect(await errored).toBeInstanceOf(Error);
  });
});

describe("wsToDuplex — read backpressure (performance-04)", () => {
  it("pauses the socket once push() reports a full buffer, and resumes it once aedes drains (read() called)", async () => {
    const ws = new EventEmitter() as unknown as FakeWebSocket;
    ws.send = (_d, cb) => cb();
    let pauseCalls = 0;
    let resumeCalls = 0;
    ws.pause = () => { pauseCalls++; };
    ws.resume = () => { resumeCalls++; };
    ws.close = () => {};

    const duplex = wsToDuplex(asWebSocket(ws));
    // wsToDuplex now sets an explicit readableHighWaterMark (see
    // src/mqtt-broker.ts) instead of relying on Node's implicit stream
    // default, which is not guaranteed to be the same across Node
    // versions/platforms. Read it straight off the duplex and push enough
    // data to exceed it several times over, so `push()` is guaranteed to
    // report a full buffer regardless of any off-by-one in exactly how much
    // headroom a single push has before crossing the threshold.
    const hwm = duplex.readableHighWaterMark;
    expect(hwm).toBeGreaterThan(0);
    const chunk = Buffer.alloc(Math.ceil(hwm / 2), 1);
    const messageCount = 10; // total pushed = 5x hwm — comfortably over the line
    for (let i = 0; i < messageCount; i++) {
      ws.emit("message", chunk);
    }
    expect(pauseCalls).toBeGreaterThan(0); // backpressure engaged before all messages fit

    // Now attach a consumer — aedes draining the duplex triggers read()
    // internally, which must resume the socket.
    const received: Buffer[] = [];
    duplex.on("data", (d) => received.push(d as Buffer));
    await vi.waitFor(() => expect(resumeCalls).toBeGreaterThan(0));
    // No data is lost across the pause/resume cycle.
    await vi.waitFor(() => {
      const total = received.reduce((sum, b) => sum + b.length, 0);
      expect(total).toBe(messageCount * chunk.length);
    });
  });

  it("never pauses when the consumer keeps up with small/normal traffic (no false-positive backpressure)", async () => {
    const ws = new EventEmitter() as unknown as FakeWebSocket;
    ws.send = (_d, cb) => cb();
    let pauseCalls = 0;
    ws.pause = () => { pauseCalls++; };
    ws.resume = () => {};
    ws.close = () => {};

    const duplex = wsToDuplex(asWebSocket(ws));
    const received: Buffer[] = [];
    duplex.on("data", (d) => received.push(d as Buffer));

    for (let i = 0; i < 20; i++) {
      ws.emit("message", Buffer.from(`msg-${i}`));
    }
    // Readable emits "data" asynchronously even in flowing mode — give it a
    // tick to deliver everything already pushed.
    await vi.waitFor(() => expect(received.length).toBe(20));
    expect(pauseCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: real httpServer + real mqtt.js client over ws:// — proves
// normal MQTT traffic still works end-to-end with the backpressure-aware
// bridge, and that maxPayload rejects oversized frames without taking the
// broker down.
// ---------------------------------------------------------------------------
describe("startEmbeddedMqttBroker over WS — non-regression + maxPayload (performance-04)", () => {
  let httpServer: HttpServer;
  let broker: Awaited<ReturnType<typeof startEmbeddedMqttBroker>>;
  let wsUrl: string;

  beforeAll(async () => {
    httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    wsUrl = `ws://127.0.0.1:${port}/mqtt`;
    broker = await startEmbeddedMqttBroker({ httpServer, wsPath: "/mqtt", logger: silentLogger });
  });

  afterAll(async () => {
    await broker.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("a real MQTT client over WS can publish and receive normally (no regression, no deadlock, no message loss)", async () => {
    const sub = mqtt.connect(wsUrl, { clientId: "sub-1", reconnectPeriod: 0 });
    const pub = mqtt.connect(wsUrl, { clientId: "pub-1", reconnectPeriod: 0 });
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => { sub.once("connect", () => resolve()); sub.once("error", reject); }),
        new Promise<void>((resolve, reject) => { pub.once("connect", () => resolve()); pub.once("error", reject); }),
      ]);

      await new Promise<void>((resolve, reject) => {
        sub.subscribe("coordinator/default/perf04/topic", { qos: 1 }, (err) => (err ? reject(err) : resolve()));
      });

      const received = new Promise<string>((resolve) => {
        sub.once("message", (_topic, payload) => resolve(payload.toString()));
      });

      pub.publish("coordinator/default/perf04/topic", "hello-perf04", { qos: 1 });
      const payload = await received;
      expect(payload).toBe("hello-perf04");
    } finally {
      sub.end(true);
      pub.end(true);
    }
  }, 10000);

  it("rejects an oversized WS frame (maxPayload) with close code 1009, without crashing the broker", async () => {
    const raw = new RawWebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      raw.once("open", () => resolve());
      raw.once("error", reject);
    });

    const closeCode = new Promise<number>((resolve) => {
      raw.once("close", (code) => resolve(code));
    });
    // 1 MiB default limit — send comfortably over it.
    raw.send(Buffer.alloc(2 * 1024 * 1024, 1));

    expect(await closeCode).toBe(1009);
  }, 10000);

  it("a normal-size payload is unaffected by maxPayload (no false positive) — broker still serves other clients after the oversized rejection", async () => {
    const sub = mqtt.connect(wsUrl, { clientId: "sub-2", reconnectPeriod: 0 });
    const pub = mqtt.connect(wsUrl, { clientId: "pub-2", reconnectPeriod: 0 });
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => { sub.once("connect", () => resolve()); sub.once("error", reject); }),
        new Promise<void>((resolve, reject) => { pub.once("connect", () => resolve()); pub.once("error", reject); }),
      ]);
      await new Promise<void>((resolve, reject) => {
        sub.subscribe("coordinator/default/perf04/topic2", { qos: 0 }, (err) => (err ? reject(err) : resolve()));
      });
      const received = new Promise<string>((resolve) => {
        sub.once("message", (_topic, payload) => resolve(payload.toString()));
      });
      // ~64 KiB — normal-sized, well under the 1 MiB cap.
      const normalPayload = "x".repeat(64 * 1024);
      pub.publish("coordinator/default/perf04/topic2", normalPayload, { qos: 0 });
      expect(await received).toBe(normalPayload);
    } finally {
      sub.end(true);
      pub.end(true);
    }
  }, 10000);
});
