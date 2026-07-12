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
 * It also documents a real, currently-unaddressed gap found while writing
 * this test (see the last describe block below): MqttBridge never listens
 * for the client's "close"/"offline" events, so `connected` is never reset
 * to `false` when the underlying connection drops — `isConnected()` can lie
 * (report true) during an outage window between disconnect and the next
 * successful "connect". This is a real behavior gap, not a test bug; it is
 * documented/asserted as CURRENT behavior here (not fixed — out of scope
 * for tests-06, which is a coverage-only task). See task report for the
 * writeup flagged to the maintainer.
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
  publish(): this { return this; }
  subscribe(topic: string | string[]): this {
    const topics = Array.isArray(topic) ? topic : [topic];
    for (const t of topics) subscribeCalls.push({ topic: t });
    return this;
  }
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

beforeEach(() => {
  subscribeCalls.length = 0;
  lastClient = null;
});

describe("MqttBridge reconnection (tests-06)", () => {
  it("re-subscribes to all 3 topics on the initial connect", async () => {
    const { } = await makeConnectedBridge();
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

describe("MqttBridge reconnection — documented gap (found while writing tests-06, not fixed here)", () => {
  it("isConnected() does NOT go false when the client drops the connection (no close/offline listener wired)", async () => {
    const { bridge, client } = await makeConnectedBridge();
    expect(bridge.isConnected()).toBe(true);

    // mqtt.js emits "close" (and "offline") when the connection drops, before
    // it starts attempting to reconnect. MqttBridge registers no listener for
    // either event, so `connected` is never flipped back to false here.
    client.emit("close");
    client.emit("offline");

    // This asserts CURRENT behavior (a real gap), not a desired contract:
    // isConnected() keeps reporting `true` through the entire outage window
    // between "close" and the next successful "connect". Consumers like
    // mqtt-tools.ts gate publish/wait/queue reads on isConnected(), so during
    // an outage they will NOT get the "MQTT broker not available" isError
    // path added for protocole-mcp-06 — they'll instead silently attempt
    // (and, with a real client, likely fail/queue) the operation.
    expect(bridge.isConnected()).toBe(true);
  });

  it("a subsequent successful reconnect ('connect' fires again) still reports connected — recovers on its own", async () => {
    const { bridge, client } = await makeConnectedBridge();
    client.emit("close");
    client.emit("connect"); // mqtt.js's own reconnect succeeds
    expect(bridge.isConnected()).toBe(true);
  });
});
