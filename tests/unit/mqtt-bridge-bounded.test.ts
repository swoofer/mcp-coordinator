import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";

/**
 * performance-05 — MqttBridge listener queue + listener-map bounding.
 *
 * Before this fix: `listener.queue.push(msg)` (src/mqtt-bridge.ts) had no
 * cap, so an agent that registers a listener but never calls
 * waitForMessage()/getQueuedMessages() accumulates every consultation/
 * broadcast message forever. Separately, an `onOffline` handler existed
 * but never removed the departed agent's listener/queue — an agent that
 * disconnects and reconnects under a new session leaves its old listener
 * (and whatever backlog it held) orphaned in the `listeners` Map forever.
 *
 * Uses a fake `mqtt` module (same pattern as p1-mqtt-correctness.test.ts)
 * so we can drive `client.emit("message", ...)` directly without a real
 * broker, while exercising MqttBridge's real routing/cleanup logic.
 */

interface PublishCall {
  topic: string;
  payload: string | Buffer;
  options?: { qos?: number; retain?: boolean };
}

let lastClient: FakeMqttClient | null = null;
const publishCalls: PublishCall[] = [];

class FakeMqttClient extends EventEmitter {
  publish(topic: string, payload: string | Buffer, options?: { qos?: number; retain?: boolean }): this {
    publishCalls.push({ topic, payload, options });
    return this;
  }
  subscribe(_topic: string | string[]): this { return this; }
  endAsync(): Promise<void> { return Promise.resolve(); }
}

vi.mock("mqtt", () => ({
  default: {
    connect: (_url: string, _options: Record<string, unknown>) => {
      const client = new FakeMqttClient();
      lastClient = client;
      queueMicrotask(() => client.emit("connect"));
      return client;
    },
  },
}));

// Import AFTER vi.mock so the bridge picks up the fake module.
import { MqttBridge } from "../../src/mqtt-bridge.js";

async function makeConnectedBridge(): Promise<{ bridge: MqttBridge; client: FakeMqttClient }> {
  const bridge = new MqttBridge("default");
  await bridge.connect({ url: "mqtt://localhost:1883" });
  return { bridge, client: lastClient! };
}

function emitBroadcast(client: FakeMqttClient, seq: number): void {
  client.emit("message", "coordinator/default/broadcast", Buffer.from(JSON.stringify({ seq })));
}

function emitOffline(client: FakeMqttClient, agentId: string): void {
  client.emit("message", `coordinator/default/agents/${agentId}/status`, Buffer.from("offline"));
}

beforeEach(() => {
  publishCalls.length = 0;
  lastClient = null;
});

describe("MqttBridge listener queue cap (performance-05)", () => {
  it("caps the backlog: pushing far more than the cap keeps only the newest N (drop-oldest)", async () => {
    const { bridge, client } = await makeConnectedBridge();
    bridge.registerListener("agent-1");
    const CAP = 1000; // mirrors MAX_LISTENER_QUEUE in src/mqtt-bridge.ts
    const TOTAL = CAP + 250;
    for (let i = 0; i < TOTAL; i++) emitBroadcast(client, i);

    const messages = bridge.getQueuedMessages("agent-1");
    expect(messages.length).toBe(CAP);
    // Oldest 250 were dropped; the retained window is the newest CAP entries.
    expect((messages[0].payload as { seq: number }).seq).toBe(TOTAL - CAP);
    expect((messages[messages.length - 1].payload as { seq: number }).seq).toBe(TOTAL - 1);
  });

  it("preserves the most recent messages under sustained overflow (not drop-newest)", async () => {
    const { bridge, client } = await makeConnectedBridge();
    bridge.registerListener("agent-1");
    for (let i = 0; i < 1500; i++) emitBroadcast(client, i);

    const seqs = bridge
      .getQueuedMessages("agent-1")
      .map((m) => (m.payload as { seq: number }).seq);
    expect(seqs.includes(1499)).toBe(true); // newest survives
    expect(seqs.includes(0)).toBe(false); // oldest dropped
  });

  it("does not cap while a waitForMessage call is pending (delivered directly, no queueing)", async () => {
    const { bridge, client } = await makeConnectedBridge();
    const waitPromise = bridge.waitForMessage("agent-1", 5000);
    emitBroadcast(client, 42);
    const msg = await waitPromise;
    expect(msg).not.toBeNull();
    expect((msg!.payload as { seq: number }).seq).toBe(42);
  });
});

describe("MqttBridge listener cleanup on agent departure (performance-05)", () => {
  it("an agent going offline removes its listener entry entirely", async () => {
    const { bridge, client } = await makeConnectedBridge();
    bridge.registerListener("agent-1");
    emitBroadcast(client, 1);
    emitBroadcast(client, 2);
    expect(bridge.listenerCount()).toBe(1);

    emitOffline(client, "agent-1");

    expect(bridge.listenerCount()).toBe(0);
  });

  it("drops the departed agent's backlog (no residual growth across reconnects)", async () => {
    const { bridge, client } = await makeConnectedBridge();
    bridge.registerListener("agent-1");
    emitBroadcast(client, 1);
    emitBroadcast(client, 2);

    emitOffline(client, "agent-1");

    // A later read re-registers a FRESH listener — old backlog is gone,
    // not silently prepended/merged.
    expect(bridge.getQueuedMessages("agent-1")).toEqual([]);
  });

  it("unblocks an in-flight waitForMessage with null when the agent goes offline", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, client } = await makeConnectedBridge();
      const waitPromise = bridge.waitForMessage("agent-1", 5000);
      emitOffline(client, "agent-1");
      await expect(waitPromise).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not affect other agents' listeners", async () => {
    const { bridge, client } = await makeConnectedBridge();
    bridge.registerListener("agent-1");
    bridge.registerListener("agent-2");
    emitBroadcast(client, 1); // fans out to both listeners

    emitOffline(client, "agent-1");

    expect(bridge.listenerCount()).toBe(1);
    expect(bridge.getQueuedMessages("agent-2").length).toBe(1);
  });

  it("still invokes the externally-registered onOffline handler (existing behavior preserved)", async () => {
    const { bridge, client } = await makeConnectedBridge();
    const handler = vi.fn();
    bridge.onOffline(handler);

    emitOffline(client, "agent-1");

    expect(handler).toHaveBeenCalledWith("agent-1");
  });

  it("cleans up even when no onOffline handler is registered", async () => {
    const { bridge, client } = await makeConnectedBridge();
    bridge.registerListener("agent-1");
    expect(() => emitOffline(client, "agent-1")).not.toThrow();
    expect(bridge.listenerCount()).toBe(0);
  });
});
