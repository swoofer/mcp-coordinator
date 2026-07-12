import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";

/**
 * tests-06 (audit) — MqttBridge reconnection path was previously uncovered.
 *
 * mqtt.js (the real `mqtt` package) auto-reconnects by default and re-emits
 * "connect" on every successful (re)connection — it does NOT give the caller
 * a distinct "reconnected" event. src/mqtt-bridge.ts registers its
 * `client.on("connect", ...)` handler ONCE inside connect()'s executor, so
 * that same handler re-runs on every reconnect: it re-subscribes to the 3
 * topics and sets `connected = true` again. This suite verifies that
 * re-subscription actually happens on a simulated reconnect.
 *
 * The last describe block covers the outage window: MqttBridge now listens
 * for the client's "close"/"offline" events and resets `connected` to false,
 * so `isConnected()` reports the real state during an outage (rather than
 * lying "true" between disconnect and the next successful "connect"). This
 * gap was found while writing this test and fixed here as a follow-up to
 * protocole-mcp-06, whose mqtt-tools.ts guards depend on isConnected().
 *
 * Uses the same fake `mqtt` module pattern as p1-mqtt-correctness.test.ts /
 * mqtt-bridge-bounded.test.ts so the real MqttBridge reconnect/subscribe
 * logic runs against a controllable fake client instead of a real broker.
 */

interface SubscribeCall {
  topic: string;
}

let lastClient: FakeMqttClient | null = null;
const subscribeCalls: SubscribeCall[] = [];

class FakeMqttClient extends EventEmitter {
  publish(): this {
    return this;
  }
  subscribe(topic: string | string[]): this {
    const topics = Array.isArray(topic) ? topic : [topic];
    for (const t of topics) subscribeCalls.push({ topic: t });
    return this;
  }
  endAsync(): Promise<void> {
    return Promise.resolve();
  }
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

beforeEach(() => {
  subscribeCalls.length = 0;
  lastClient = null;
});

describe("MqttBridge reconnection (tests-06)", () => {
  it("re-subscribes to all 3 topics on the initial connect", async () => {
    const {} = await makeConnectedBridge();
    const topics = subscribeCalls.map((c) => c.topic);
    expect(topics).toEqual([
      "coordinator/default/agents/+/status",
      "coordinator/default/consultations/#",
      "coordinator/default/broadcast",
    ]);
  });

  it("re-subscribes to all 3 topics again when the client emits a second 'connect' (simulated reconnect)", async () => {
    const { bridge, client } = await makeConnectedBridge();
    expect(subscribeCalls).toHaveLength(3);

    // Simulate mqtt.js's own auto-reconnect: after a drop, it re-establishes
    // the TCP/TLS session and re-emits "connect" on the SAME client instance
    // (no new mqtt.connect() call, no new client object).
    client.emit("connect");

    expect(subscribeCalls).toHaveLength(6);
    const secondBatch = subscribeCalls.slice(3).map((c) => c.topic);
    expect(secondBatch).toEqual([
      "coordinator/default/agents/+/status",
      "coordinator/default/consultations/#",
      "coordinator/default/broadcast",
    ]);
    expect(bridge.isConnected()).toBe(true);
  });

  it("publishing after a reconnect uses the (still valid) client — no dangling reference from the first connect", async () => {
    const { bridge, client } = await makeConnectedBridge();
    client.emit("connect"); // reconnect

    const publishSpy = vi.spyOn(client, "publish");
    bridge.publishBroadcast("agent-1", "hello after reconnect");
    expect(publishSpy).toHaveBeenCalledWith(
      "coordinator/default/broadcast",
      JSON.stringify({ agent_id: "agent-1", message: "hello after reconnect" }),
    );
  });
});

describe("MqttBridge reconnection — isConnected() tracks the outage window", () => {
  it("isConnected() goes false when the client drops the connection (close/offline listeners wired)", async () => {
    const { bridge, client } = await makeConnectedBridge();
    expect(bridge.isConnected()).toBe(true);

    // mqtt.js emits "close" (and "offline") when the connection drops, before
    // it starts attempting to reconnect. MqttBridge now resets `connected`
    // on either event, so isConnected() reports the real state during an
    // outage — the mqtt-tools.ts guards (protocole-mcp-06) fire correctly
    // instead of silently attempting (and, with a real client, dropping) the op.
    client.emit("close");
    expect(bridge.isConnected()).toBe(false);
  });

  it("'offline' also flips isConnected() to false", async () => {
    const { bridge, client } = await makeConnectedBridge();
    client.emit("offline");
    expect(bridge.isConnected()).toBe(false);
  });

  it("recovers on its own: connected → close (false) → connect (true)", async () => {
    const { bridge, client } = await makeConnectedBridge();
    expect(bridge.isConnected()).toBe(true);
    client.emit("close");
    expect(bridge.isConnected()).toBe(false);
    client.emit("connect"); // mqtt.js's own reconnect succeeds
    expect(bridge.isConnected()).toBe(true);
  });
});
