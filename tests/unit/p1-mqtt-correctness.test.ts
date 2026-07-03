import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";

/**
 * P1 audit fixes — MQTT correctness:
 *  1. State-change publishes use QoS 1 (claim/complete/consultation/resolution).
 *  2. `coordinator/default/consultations/new` is published with retain=true so a
 *     coordinator/subscriber restart can rebuild the active state.
 *  3. `clearRetainedConsultation` clears the retained slot on resolve.
 *  4. LWT is registered on connect so a crashed bridge auto-broadcasts offline.
 *
 * Uses a fake `mqtt` module so we can inspect the connect options + every
 * publish call without standing up a real broker.
 */

interface PublishCall {
  topic: string;
  payload: string | Buffer;
  options?: { qos?: number; retain?: boolean };
}

interface ConnectCall {
  url: string;
  options: Record<string, unknown>;
}

const connectCalls: ConnectCall[] = [];
const publishCalls: PublishCall[] = [];
let lastClient: FakeMqttClient | null = null;

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
    connect: (url: string, options: Record<string, unknown>) => {
      connectCalls.push({ url, options });
      const client = new FakeMqttClient();
      lastClient = client;
      // Emit "connect" on next microtask so the bridge promise resolves.
      queueMicrotask(() => client.emit("connect"));
      return client;
    },
  },
}));

// Import AFTER vi.mock so the bridge picks up the fake module.
import { MqttBridge } from "../../src/mqtt-bridge.js";

async function makeConnectedBridge(opts?: { agentId?: string }): Promise<MqttBridge> {
  const bridge = new MqttBridge("default");
  await bridge.connect({ url: "mqtt://localhost:1883", ...opts });
  return bridge;
}

beforeEach(() => {
  connectCalls.length = 0;
  publishCalls.length = 0;
  lastClient = null;
});

describe("P1 — MQTT QoS 1 for state-change publishes", () => {
  it("publishTaskClaimed publishes with qos:1", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishTaskClaimed("default", "thread-123", "agent-A");
    const call = publishCalls.find(
      (c) => c.topic === "coordinator/default/consultations/thread-123/claimed",
    );
    expect(call).toBeDefined();
    expect(call!.options?.qos).toBe(1);
  });

  it("publishTaskCompleted publishes with qos:1", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishTaskCompleted("default", "thread-456", "agent-B", "all good");
    const call = publishCalls.find(
      (c) => c.topic === "coordinator/default/consultations/thread-456/completed",
    );
    expect(call).toBeDefined();
    expect(call!.options?.qos).toBe(1);
  });

  it("publishConsultation publishes with qos:1", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishConsultation("default", "thread-789", "agent-C", "subject", ["mod1"]);
    const call = publishCalls.find((c) => c.topic === "coordinator/default/consultations/new");
    expect(call).toBeDefined();
    expect(call!.options?.qos).toBe(1);
  });

  it("publishResolution publishes with qos:1", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishResolution("default", "thread-xyz", "resolved", "all good");
    const call = publishCalls.find(
      (c) => c.topic === "coordinator/default/consultations/thread-xyz/status",
    );
    expect(call).toBeDefined();
    expect(call!.options?.qos).toBe(1);
  });

  it("publishMessage stays at QoS 0 (high-frequency, lossy-OK)", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishMessage("default", "thread-1", "agent-X", "comment", "hi");
    const call = publishCalls.find(
      (c) => c.topic === "coordinator/default/consultations/thread-1/messages",
    );
    expect(call).toBeDefined();
    // QoS 0 = either undefined or 0 (mqtt.js default).
    expect(call!.options?.qos ?? 0).toBe(0);
  });

  it("publishQuotaUpdate stays at QoS 0", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishQuotaUpdate({ fiveHour: 42 });
    const call = publishCalls.find((c) => c.topic === "coordinator/default/quota/update");
    expect(call).toBeDefined();
    expect(call!.options?.qos ?? 0).toBe(0);
  });
});

describe("P1 — retained consultations/new", () => {
  it("publishConsultation publishes with retain:true", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishConsultation("default", "thread-A", "agent-1", "subj", ["mod"]);
    const call = publishCalls.find((c) => c.topic === "coordinator/default/consultations/new");
    expect(call).toBeDefined();
    expect(call!.options?.retain).toBe(true);
  });

  it("clearRetainedConsultation publishes empty payload with retain:true", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishConsultation("default", "thread-A", "agent-1", "subj", ["mod"]);
    publishCalls.length = 0; // forget the publish above

    bridge.clearRetainedConsultation("default", "thread-A");
    const clear = publishCalls.find((c) => c.topic === "coordinator/default/consultations/new");
    expect(clear).toBeDefined();
    // Empty payload signals "clear retained".
    const payloadStr =
      typeof clear!.payload === "string" ? clear!.payload : clear!.payload.toString();
    expect(payloadStr).toBe("");
    expect(clear!.options?.retain).toBe(true);
  });

  it("clearRetainedConsultation is a no-op when threadId doesn't match", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishConsultation("default", "thread-A", "agent-1", "subj", ["mod"]);
    publishCalls.length = 0;

    // Stale resolve callback for an old thread that's already been overwritten.
    bridge.clearRetainedConsultation("default", "stale-thread");
    expect(
      publishCalls.find((c) => c.topic === "coordinator/default/consultations/new"),
    ).toBeUndefined();
  });

  it("a newer publishConsultation overwrites the retained slot (next clear by older threadId is no-op)", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishConsultation("default", "thread-old", "agent-1", "subj", ["mod"]);
    bridge.publishConsultation("default", "thread-new", "agent-2", "subj2", ["mod"]);
    publishCalls.length = 0;

    bridge.clearRetainedConsultation("default", "thread-old"); // stale
    expect(
      publishCalls.find((c) => c.topic === "coordinator/default/consultations/new"),
    ).toBeUndefined();

    bridge.clearRetainedConsultation("default", "thread-new"); // matches latest retain
    expect(
      publishCalls.find((c) => c.topic === "coordinator/default/consultations/new"),
    ).toBeDefined();
  });
});

describe("P1 — Last Will & Testament on connect", () => {
  it("registers an LWT for the default 'coordinator-internal' agent", async () => {
    await makeConnectedBridge();
    expect(connectCalls.length).toBe(1);
    const will = connectCalls[0].options.will as
      | {
          topic: string;
          payload: Buffer | string;
          qos: number;
          retain: boolean;
        }
      | undefined;
    expect(will).toBeDefined();
    expect(will!.topic).toBe("coordinator/default/agents/coordinator-internal/status");
    const payload = typeof will!.payload === "string" ? will!.payload : will!.payload.toString();
    const parsed = JSON.parse(payload);
    expect(parsed).toEqual({ status: "offline", reason: "lwt_unexpected" });
    expect(will!.qos).toBe(1);
    expect(will!.retain).toBe(false);
  });

  it("LWT topic uses the supplied agentId", async () => {
    await makeConnectedBridge({ agentId: "agent-foo" });
    const will = connectCalls[0].options.will as { topic: string };
    expect(will.topic).toBe("coordinator/default/agents/agent-foo/status");
  });

  it("clientId encodes the agentId so the broker can correlate clients", async () => {
    await makeConnectedBridge({ agentId: "agent-foo" });
    const clientId = connectCalls[0].options.clientId as string;
    expect(clientId.startsWith("agent-foo-")).toBe(true);
  });
});

describe("P1 — backward-compat: existing publishes still produce the right shape", () => {
  it("publishTaskClaimed payload still includes thread metadata + ISO timestamp", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishTaskClaimed("default", "t-1", "agent-X");
    const call = publishCalls.find(
      (c) => c.topic === "coordinator/default/consultations/t-1/claimed",
    )!;
    const payload = JSON.parse(call.payload.toString());
    expect(payload.agent_id).toBe("agent-X");
    expect(payload.claimed_by).toBe("agent-X");
    expect(typeof payload.claimed_at).toBe("string");
    expect(() => new Date(payload.claimed_at as string).toISOString()).not.toThrow();
  });

  it("publishConsultation payload still has thread_id, agent_id, subject, target_modules", async () => {
    const bridge = await makeConnectedBridge();
    bridge.publishConsultation("default", "t-2", "agent-Y", "my subject", ["modA", "modB"]);
    const call = publishCalls.find((c) => c.topic === "coordinator/default/consultations/new")!;
    const payload = JSON.parse(call.payload.toString());
    expect(payload).toEqual({
      thread_id: "t-2",
      agent_id: "agent-Y",
      subject: "my subject",
      target_modules: ["modA", "modB"],
    });
  });
});
