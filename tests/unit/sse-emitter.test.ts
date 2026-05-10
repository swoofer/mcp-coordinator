// tests/sse-emitter.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { SseEmitter } from "../../src/sse-emitter.js";
import fs from "fs";

const TEST_DIR = "data-test-sse";
let emitter: SseEmitter;

// P3: emit() now fans out via setImmediate so listeners don't block the
// emitter or each other. Tests that assert synchronously on listener side
// effects must drain the queue first.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM events");
  emitter = new SseEmitter();
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("SseEmitter", () => {
  it("emits and retrieves events", () => {
    emitter.emit("thread_opened", { thread_id: "t1", subject: "Test" });
    emitter.emit("message_posted", { thread_id: "t1", agent_id: "a1" });
    const events = emitter.getEventsSince(0);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("thread_opened");
    expect(events[1].type).toBe("message_posted");
  });

  it("filters events by since id", () => {
    emitter.emit("agent_online", { agent_id: "a1" });
    emitter.emit("agent_online", { agent_id: "a2" });
    const all = emitter.getEventsSince(0);
    const firstId = all[0].id!;
    const after = emitter.getEventsSince(firstId);
    expect(after).toHaveLength(1);
    expect(JSON.parse(after[0].payload).agent_id).toBe("a2");
  });

  it("notifies registered listeners", async () => {
    const received: string[] = [];
    emitter.addListener((event) => received.push(event.type));
    emitter.emit("file_edited", { file: "test.ts" });
    await flush();
    expect(received).toContain("file_edited");
  });

  it("removeAllListeners â€” no listener is called after removal", async () => {
    const received: string[] = [];
    emitter.addListener((event) => received.push(event.type));
    emitter.removeAllListeners();
    emitter.emit("agent_online", { agent_id: "a1" });
    await flush();
    expect(received).toHaveLength(0);
  });

  it("unsubscribe function â€” listener is not called after unsubscribing", async () => {
    const received: string[] = [];
    const unsubscribe = emitter.addListener((event) => received.push(event.type));
    unsubscribe();
    emitter.emit("thread_opened", { thread_id: "t1", subject: "Test" });
    await flush();
    expect(received).toHaveLength(0);
  });

  it("multiple listeners â€” both receive events, removing one leaves the other active", async () => {
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const unsubscribeA = emitter.addListener((event) => receivedA.push(event.type));
    emitter.addListener((event) => receivedB.push(event.type));

    emitter.emit("agent_online", { agent_id: "a1" });
    await flush();
    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);

    unsubscribeA();
    emitter.emit("agent_online", { agent_id: "a2" });
    await flush();
    expect(receivedA).toHaveLength(1); // still 1 â€” unsubscribed listener did not fire
    expect(receivedB).toHaveLength(2); // still active â€” fired again
  });

  it("event payload preserves complex data integrity through JSON round-trip", () => {
    const complexPayload = {
      thread_id: "t-complex",
      agent_id: "a1",
      metadata: { priority: 42, tags: ["auth", "refactor"], nested: { flag: true } },
    };
    emitter.emit("thread_opened", complexPayload);
    const events = emitter.getEventsSince(0);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0].payload);
    expect(parsed.thread_id).toBe("t-complex");
    expect(parsed.agent_id).toBe("a1");
    expect(parsed.metadata.priority).toBe(42);
    expect(parsed.metadata.tags).toEqual(["auth", "refactor"]);
    expect(parsed.metadata.nested.flag).toBe(true);
  });
});


