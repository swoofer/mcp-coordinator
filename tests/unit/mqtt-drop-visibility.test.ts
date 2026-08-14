import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";

/**
 * issue #236 — every message the bridge discarded used to vanish silently.
 *
 * `mqtt_publish` answers "published" unconditionally (its only failure path is
 * a disconnected client), so a topic nothing routes, a non-JSON payload, or a
 * full listener queue all produced a success string and no delivery, with
 * nothing in the log and nothing on /metrics to explain it.
 *
 * These tests pin the four drop reasons to the `onDrop` sink. They deliberately
 * assert on the REASON, not on log text, so wording can change freely.
 *
 * Same fake-`mqtt` harness as mqtt-bridge-bounded.test.ts — drives
 * `client.emit("message", ...)` directly while exercising the real routing.
 */

interface PublishCall {
  topic: string;
  payload: string | Buffer;
  options?: { qos?: number; retain?: boolean };
}

let lastClient: FakeMqttClient | null = null;
const publishCalls: PublishCall[] = [];

class FakeMqttClient extends EventEmitter {
  publish(
    topic: string,
    payload: string | Buffer,
    options?: { qos?: number; retain?: boolean },
  ): this {
    publishCalls.push({ topic, payload, options });
    return this;
  }
  subscribe(_topic: string | string[]): this {
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

import { MqttBridge } from "../../src/mqtt-bridge.js";

async function makeBridge(): Promise<{
  bridge: MqttBridge;
  client: FakeMqttClient;
  drops: string[];
}> {
  const bridge = new MqttBridge("default");
  const drops: string[] = [];
  bridge.onDrop((reason) => drops.push(reason));
  await bridge.connect({ url: "mqtt://localhost:1883" });
  return { bridge, client: lastClient!, drops };
}

beforeEach(() => {
  publishCalls.length = 0;
  lastClient = null;
});

describe("MqttBridge drop visibility (#236)", () => {
  it("reports a topic that nothing routes, instead of accepting it silently", async () => {
    const { bridge, drops } = await makeBridge();

    // The bridge subscribes only to agents/+/status, consultations/#, and
    // broadcast. Anything else is published to the broker and consumed by
    // nobody — and never reaches the message handler, so the publish path is
    // the only place this is knowable.
    bridge.mqttPublish("default", "telemetry/cpu", JSON.stringify({ v: 1 }));

    expect(drops).toContain("unroutable_topic");
    // Still published — this is an observability fix, not a behaviour change.
    expect(publishCalls.map((c) => c.topic)).toContain("coordinator/default/telemetry/cpu");
  });

  it("stays quiet for the topics that DO route", async () => {
    const { bridge, drops } = await makeBridge();

    bridge.mqttPublish("default", "broadcast", JSON.stringify({ hello: 1 }));
    bridge.mqttPublish("default", "consultations/new", JSON.stringify({ id: "t1" }));
    bridge.mqttPublish("default", "agents/a1/status", JSON.stringify({ status: "online" }));

    expect(drops).toEqual([]);
  });

  it("reports a non-JSON payload on a routable topic", async () => {
    const { client, drops } = await makeBridge();

    client.emit("message", "coordinator/default/broadcast", Buffer.from("not json at all"));

    expect(drops).toContain("malformed_payload");
  });

  it("reports a broadcast that lands with no listener registered", async () => {
    const { client, drops } = await makeBridge();

    client.emit("message", "coordinator/default/broadcast", Buffer.from(JSON.stringify({ a: 1 })));

    expect(drops).toContain("no_listener");
  });

  it("publishes at QoS 1 so a reconnecting subscriber does not miss the event", async () => {
    const { bridge } = await makeBridge();

    bridge.mqttPublish("default", "broadcast", JSON.stringify({ hello: 1 }));

    const call = publishCalls.find((c) => c.topic === "coordinator/default/broadcast");
    expect(call?.options?.qos).toBe(1);
  });
});
