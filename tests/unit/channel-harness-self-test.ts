/**
 * Self-test for `tests/helpers/channel-test-harness.ts`.
 *
 * Proves both pieces of the harness work end-to-end without depending on the
 * not-yet-existing `cli/channel.ts`:
 *
 *   1. `createChannelHarness({ command, args })` — spawns a tiny inline stub
 *      MCP server (see `fixtures/channel-stub-server.ts`) that declares
 *      `experimental["claude/channel"]` and pushes one notification on a
 *      timer. We assert `waitForNotification(...)` resolves with the right
 *      shape (`content`, `meta`) and that `receivedNotifications` captured it.
 *
 *   2. `createMockMqttBroker()` — boots an in-process aedes broker, connects
 *      a second mqtt.js client as a subscriber, then drives all three publish
 *      helpers (`publishConsultationOpened`, `publishThreadMessage`,
 *      `publishAgentStatus`) and asserts the subscriber receives the
 *      correctly-shaped messages on the correctly-formed topics.
 *
 * This file is intentionally named `*-self-test.ts` (not `*.test.ts`) so it
 * does NOT auto-run with the rest of the suite — it's a wiring proof for the
 * implementation team, runnable explicitly via:
 *
 *   pnpm test tests/unit/channel-harness-self-test.ts
 *
 * The vitest CLI accepts explicit file paths outside the default include
 * glob, so this still runs as a regular test file when targeted.
 */
import { TSX_NODE_ARGS } from "../helpers/tsx-node.js";
import { describe, it, expect } from "vitest";
import mqtt from "mqtt";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChannelHarness,
  createMockMqttBroker,
  type ChannelNotification,
} from "../helpers/channel-test-harness.js";

const __filename = fileURLToPath(import.meta.url);
const STUB_SERVER_PATH = path.resolve(
  path.dirname(__filename),
  "fixtures",
  "channel-stub-server.ts",
);

describe("channel-test-harness — createChannelHarness", () => {
  it("captures a notifications/claude/channel event and matches a predicate", async () => {
    // Point the harness at the inline stub instead of the (not-yet-existing)
    // cli/channel.ts. The harness already defaults to node + the tsx loader;
    // we override here to be explicit about which binary runs.
    const command = process.execPath;
    const harness = await createChannelHarness({
      command,
      args: [...TSX_NODE_ARGS, STUB_SERVER_PATH],
    });

    try {
      // The stub pushes a single notification 25ms after `initialized`.
      // Generous timeout to absorb tsx startup on slow CI machines.
      const notification = await harness.waitForNotification(
        (n: ChannelNotification) => n.params.meta.topic_kind === "consultation_opened",
        5000,
      );

      expect(notification.method).toBe("notifications/claude/channel");
      expect(notification.params.content).toContain("consultation opened");
      expect(notification.params.meta).toMatchObject({
        topic_kind: "consultation_opened",
        thread_id: "t-stub-1",
        agent_id: "agent-stub",
      });

      // `receivedNotifications` should have captured exactly the one event.
      expect(harness.receivedNotifications).toHaveLength(1);
      expect(harness.receivedNotifications[0]).toBe(notification);
    } finally {
      await harness.cleanup();
    }
  }, 15_000);

  it("waitForNotification rejects on timeout with a descriptive error", async () => {
    const command = process.execPath;
    const harness = await createChannelHarness({
      command,
      args: [...TSX_NODE_ARGS, STUB_SERVER_PATH],
    });

    try {
      // Predicate that will NEVER match — the stub only emits `consultation_opened`.
      await expect(
        harness.waitForNotification((n) => n.params.meta.topic_kind === "never_emitted_kind", 250),
      ).rejects.toThrow(/timed out after 250ms/);
    } finally {
      await harness.cleanup();
    }
  }, 15_000);
});

describe("channel-test-harness — createMockMqttBroker", () => {
  it("publishes consultation_opened, thread_message, and agent_status to the right topics", async () => {
    const broker = await createMockMqttBroker({ org: "default" });

    // Subscriber side: a second mqtt.js client that records every received
    // message. The channel mode (or our stub) will play exactly this role
    // once it's wired up.
    interface Captured {
      topic: string;
      payload: string;
      retain: boolean;
    }
    const captured: Captured[] = [];
    const subscriber = mqtt.connect(broker.url, {
      clientId: "self-test-subscriber",
      reconnectPeriod: 0,
      connectTimeout: 3000,
    });
    await new Promise<void>((resolve, reject) => {
      subscriber.once("connect", () => resolve());
      subscriber.once("error", reject);
    });
    subscriber.on("message", (topic, payload, packet) => {
      captured.push({
        topic,
        payload: payload.toString(),
        retain: packet.retain,
      });
    });
    await new Promise<void>((resolve, reject) => {
      subscriber.subscribe("coordinator/default/#", { qos: 1 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    try {
      await broker.publishConsultationOpened({
        thread_id: "t-1",
        subject: "refactor module X",
        agent_id: "agent-a",
        target_modules: ["modA"],
      });
      await broker.publishThreadMessage({
        thread_id: "t-1",
        agent_id: "agent-b",
        type: "comment",
        content: "looks good",
      });
      await broker.publishAgentStatus({
        agent_id: "agent-a",
        status: "online",
        name: "Alice",
      });

      // Wait until all three messages have arrived. Polling is fine here —
      // the broker is in-process, so the latency is microseconds.
      const deadline = Date.now() + 2000;
      while (captured.length < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(captured.length).toBeGreaterThanOrEqual(3);

      const newEvent = captured.find((c) => c.topic === "coordinator/default/consultations/new");
      expect(newEvent).toBeDefined();
      expect(JSON.parse(newEvent!.payload)).toEqual({
        thread_id: "t-1",
        agent_id: "agent-a",
        subject: "refactor module X",
        target_modules: ["modA"],
      });

      const msgEvent = captured.find(
        (c) => c.topic === "coordinator/default/consultations/t-1/messages",
      );
      expect(msgEvent).toBeDefined();
      expect(JSON.parse(msgEvent!.payload)).toEqual({
        agent_id: "agent-b",
        type: "comment",
        content: "looks good",
      });

      const statusEvent = captured.find(
        (c) => c.topic === "coordinator/default/agents/agent-a/status",
      );
      expect(statusEvent).toBeDefined();
      expect(JSON.parse(statusEvent!.payload)).toEqual({
        status: "online",
        name: "Alice",
      });
      // Verify the broker actually stored the retain flag — a fresh
      // subscriber connecting AFTER the publish must receive the message
      // immediately on subscribe, with `retain=true`. (Subscribers already
      // connected at publish time see retain=false because the broker
      // delivers it as a live message, not a retained replay.)
      const lateSubscriber = mqtt.connect(broker.url, {
        clientId: "self-test-late-subscriber",
        reconnectPeriod: 0,
        connectTimeout: 3000,
      });
      await new Promise<void>((resolve, reject) => {
        lateSubscriber.once("connect", () => resolve());
        lateSubscriber.once("error", reject);
      });
      try {
        const replay = await new Promise<{ retain: boolean; payload: string } | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 1000);
          lateSubscriber.on("message", (_topic, payload, packet) => {
            clearTimeout(timer);
            resolve({ retain: packet.retain, payload: payload.toString() });
          });
          lateSubscriber.subscribe(
            "coordinator/default/agents/agent-a/status",
            { qos: 1 },
            (err) => {
              if (err) {
                clearTimeout(timer);
                resolve(null);
              }
            },
          );
        });
        expect(replay).not.toBeNull();
        expect(replay!.retain).toBe(true);
        expect(JSON.parse(replay!.payload)).toEqual({ status: "online", name: "Alice" });
      } finally {
        await new Promise<void>((resolve) => lateSubscriber.end(false, {}, () => resolve()));
      }
    } finally {
      await new Promise<void>((resolve) => {
        subscriber.end(false, {}, () => resolve());
      });
      await broker.cleanup();
    }
  }, 15_000);

  it("publishRaw escape hatch publishes to arbitrary topics", async () => {
    const broker = await createMockMqttBroker();
    const subscriber = mqtt.connect(broker.url, {
      clientId: "self-test-raw-subscriber",
      reconnectPeriod: 0,
      connectTimeout: 3000,
    });
    await new Promise<void>((resolve, reject) => {
      subscriber.once("connect", () => resolve());
      subscriber.once("error", reject);
    });
    const received: Array<{ topic: string; payload: string }> = [];
    subscriber.on("message", (topic, payload) => {
      received.push({ topic, payload: payload.toString() });
    });
    await new Promise<void>((resolve, reject) => {
      subscriber.subscribe("custom/#", (err) => (err ? reject(err) : resolve()));
    });

    try {
      await broker.publishRaw("custom/topic", "hello world");
      const deadline = Date.now() + 1000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(received).toEqual([{ topic: "custom/topic", payload: "hello world" }]);
    } finally {
      await new Promise<void>((resolve) => subscriber.end(false, {}, () => resolve()));
      await broker.cleanup();
    }
  }, 10_000);
});
