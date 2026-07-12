/**
 * Integration smoke test for `mcp-coordinator channel` (Phase 1).
 *
 *   embedded MQTT broker (aedes, free port)
 *         ▲ publish coordinator/...
 *         │
 *         ┴ subscribe coordinator/+/...
 *   `mcp-coordinator channel` subprocess (spawned via tsx, stdio)
 *         ▲ MCP notifications/claude/channel
 *         │
 *         ┴ StdioClientTransport
 *   MCP SDK Client (test process)
 *
 * The test wires a fake event end-to-end: publish on the broker → expect a
 * `notifications/claude/channel` notification at the client. The spawn shape
 * mirrors `tests/helpers/mcp-client-harness.ts` (which the in-flight harness
 * refactor — Agent 3 — may extend later; we reproduce it inline here to avoid
 * coupling).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import type { Stream } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import mqtt, { type MqttClient } from "mqtt";
import { startEmbeddedMqttBroker, type EmbeddedMqttBroker } from "../../src/mqtt-broker.js";
import { silentLogger } from "../../src/logger.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Marker the `channel` CLI prints on stderr once its MQTT subscriptions are
 * active (see `cli/channel.ts`, printed when `handle.ready` resolves).
 */
const READY_MARKER = "[channel] subscriptions active";

/**
 * Wait for `marker` to appear on a piped child-process stderr stream, with a
 * safety timeout. Replaces a fixed sleep: instead of guessing how long the
 * subprocess takes to wire up its MQTT SUBSCRIBEs, we watch for the CLI's own
 * readiness announcement. Deterministic and as fast as the subprocess allows.
 *
 * Safe against the "listener attached late" race: a piped Node stream that
 * hasn't been read yet stays in paused mode and buffers writes internally, so
 * data emitted before `.on("data", ...)` is attached is still delivered once
 * we start listening — nothing is lost between spawn and this call.
 */
function waitForStderrMarker(
  stderr: Stream | null | undefined,
  marker: string,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!stderr) {
      reject(new Error("waitForStderrMarker: no stderr stream (was stdio piped?)"));
      return;
    }
    let buf = "";
    const cleanup = (): void => {
      clearTimeout(timer);
      stderr.off("data", onData);
    };
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf-8");
      if (buf.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `waitForStderrMarker: timed out after ${timeoutMs}ms waiting for ${JSON.stringify(marker)}; captured stderr so far: ${JSON.stringify(buf)}`,
        ),
      );
    }, timeoutMs);
    stderr.on("data", onData);
  });
}

describe("channel CLI — smoke (MQTT → notifications/claude/channel)", () => {
  let broker: EmbeddedMqttBroker | null = null;
  let brokerPort = 0;
  let client: Client | null = null;
  let publisher: MqttClient | null = null;
  const receivedNotifications: Array<{ method: string; params: unknown }> = [];

  beforeAll(async () => {
    brokerPort = await getFreePort();
    broker = await startEmbeddedMqttBroker({
      tcpPort: brokerPort,
      logger: silentLogger,
      // No authenticate hook → anonymous mode, matches default daemon flow.
    });

    // Spawn `mcp-coordinator channel` over stdio. We invoke node-modules tsx
    // directly (not via `npx`) — on Windows, the npx.cmd shim breaks signal
    // forwarding so SIGTERM/SIGKILL from StdioClientTransport.close() never
    // reach the actual tsx process and the test hangs in afterAll.
    const tsxBin = path.join(
      REPO_ROOT,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.CMD" : "tsx",
    );
    const command = tsxBin;
    const args = [
      path.join(REPO_ROOT, "cli", "index.ts"),
      "channel",
      "--broker-url",
      `mqtt://127.0.0.1:${brokerPort}`,
    ];

    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...(process.env as Record<string, string>) },
      stderr: "pipe", // surface server logs on failure
    });

    client = new Client(
      { name: "channel-smoke-test", version: "0.0.0" },
      // Declare the experimental capability on the CLIENT side too, so the
      // server's initialize handshake doesn't trip over a missing peer.
      { capabilities: { experimental: { "claude/channel": {} } } },
    );

    // Custom notification handler. The SDK's `setNotificationHandler` requires
    // a Zod schema whose `method` literal matches — we use the open
    // NotificationSchema and filter manually.
    client.fallbackNotificationHandler = async (notif) => {
      receivedNotifications.push({ method: notif.method, params: notif.params });
    };

    await client.connect(transport);

    // Wait for the subprocess to wire up its MQTT subscriptions before we
    // publish — without this we race the SUBSCRIBE packet. The CLI prints
    // "[channel] subscriptions active" on stderr once ready (cli/channel.ts);
    // watch for that instead of guessing with a fixed sleep.
    await waitForStderrMarker(transport.stderr, READY_MARKER);
  }, 30_000);

  afterAll(async () => {
    // Force end the publisher with `true` (don't wait for in-flight PUBACKs).
    try {
      if (publisher)
        await new Promise<void>((resolve) => publisher!.end(true, {}, () => resolve()));
    } catch {}
    // Closing the client kills the StdioClientTransport, which sends SIGTERM
    // to the channel subprocess. On Windows the SIGTERM-equivalent doesn't
    // always run our SIGTERM handler — that's fine, the parent kills the
    // process tree anyway.
    try {
      if (client) await client.close();
    } catch {}
    try {
      if (broker) await broker.close();
    } catch {}
  }, 30_000);

  it("forwards a published consultation_new event as a notifications/claude/channel", async () => {
    publisher = mqtt.connect(`mqtt://127.0.0.1:${brokerPort}`, {
      clientId: `test-publisher-${Date.now()}`,
      clean: true,
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("publisher connect timeout")), 5000);
      publisher!.on("connect", () => {
        clearTimeout(t);
        resolve();
      });
      publisher!.on("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    receivedNotifications.length = 0;

    publisher!.publish(
      "coordinator/testorg/consultations/new",
      JSON.stringify({
        thread_id: "thr-smoke-1",
        agent_id: "scout",
        subject: "smoke-test consultation",
        target_modules: ["src/x"],
      }),
      { qos: 1 },
    );

    // Wait for the notification to round-trip MQTT → channel subprocess → stdio → client.
    const deadline = Date.now() + 5000;
    let match: { method: string; params: unknown } | undefined;
    while (Date.now() < deadline) {
      match = receivedNotifications.find((n) => n.method === "notifications/claude/channel");
      if (match) break;
      await new Promise<void>((r) => setTimeout(r, 100));
    }

    expect(
      match,
      `did not receive notifications/claude/channel; got: ${JSON.stringify(receivedNotifications)}`,
    ).toBeDefined();
    const params = match!.params as { content: string; meta: Record<string, string> };
    expect(params.content).toContain("scout");
    expect(params.content).toContain("thr-smoke-1");
    expect(params.meta.event_type).toBe("consultation_new");
    expect(params.meta.thread_id).toBe("thr-smoke-1");
    expect(params.meta.agent_id).toBe("scout");
    expect(params.meta.org).toBe("testorg");
  }, 20_000);

  it("schemas exported by the SDK still expose a base NotificationSchema we can use", () => {
    // Sanity: this test file imports NotificationSchema. If the SDK ever drops
    // it the channel CLI would still work, but our test harness wouldn't —
    // catch that here as a contract assertion rather than a confusing failure.
    expect(NotificationSchema).toBeDefined();
  });

  // ─── Phase 2: post_to_thread reply tool ─────────────────────────────────
  //
  // End-to-end: call the tool via the MCP client and verify the resulting
  // MQTT publish lands on the broker with the expected topic + payload.
  // Subscribes via a second mqtt.js client connected to the same broker.
  it("exposes post_to_thread on tools/list and publishes a real MQTT message when called", async () => {
    expect(client).not.toBeNull();
    if (!client) return;

    // Confirm the tool surface advertises post_to_thread.
    const tools = await client.listTools();
    const reply = tools.tools.find((t) => t.name === "post_to_thread");
    expect(
      reply,
      `expected post_to_thread in tools/list; got ${tools.tools.map((t) => t.name).join(",")}`,
    ).toBeDefined();
    expect(reply!.description).toMatch(/consultation_opened/);

    // Subscribe to the messages topic on the broker so we can observe the
    // publish triggered by the tools/call below.
    const subscriber = mqtt.connect(`mqtt://127.0.0.1:${brokerPort}`, {
      clientId: `reply-tool-subscriber-${Date.now()}`,
      clean: true,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("subscriber connect timeout")), 5000);
      subscriber.on("connect", () => {
        clearTimeout(t);
        resolve();
      });
      subscriber.on("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    const messageTopic = "coordinator/default/consultations/thr-reply-1/messages";
    const seen: Array<{ topic: string; payload: string }> = [];
    subscriber.on("message", (topic, payload) => {
      seen.push({ topic, payload: payload.toString("utf-8") });
    });
    await new Promise<void>((resolve, reject) => {
      subscriber.subscribe(messageTopic, { qos: 0 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Drive the tool through the real MCP client.
    const result = await client.callTool({
      name: "post_to_thread",
      arguments: {
        thread_id: "thr-reply-1",
        content: "integration smoke reply from the channel",
      },
    });

    // The SDK normalises a tools/call response into { content: [...] }.
    expect(result.isError).toBeFalsy();

    // Wait for the broker to deliver the message back to our subscriber.
    const deadline = Date.now() + 5000;
    let match: { topic: string; payload: string } | undefined;
    while (Date.now() < deadline) {
      match = seen.find((m) => m.topic === messageTopic);
      if (match) break;
      await new Promise<void>((r) => setTimeout(r, 50));
    }

    expect(
      match,
      `did not receive MQTT publish on ${messageTopic}; got: ${JSON.stringify(seen)}`,
    ).toBeDefined();
    const decoded = JSON.parse(match!.payload) as Record<string, unknown>;
    expect(decoded.agent_id).toBe("channel");
    expect(decoded.type).toBe("context");
    expect(decoded.content).toBe("integration smoke reply from the channel");

    await new Promise<void>((resolve) => subscriber.end(true, {}, () => resolve()));
  }, 20_000);

  it("publishes a reply to a broker-side subscriber via the mock-broker helper", async () => {
    // Same test as above but uses createMockMqttBroker's helpers as a sanity
    // check — gives maintainers a copy-pasteable shape that uses the harness
    // utilities rather than raw mqtt.js. Keeps both code paths exercised.
    const { createMockMqttBroker } = await import("../helpers/channel-test-harness.js");
    const mockBroker = await createMockMqttBroker({ org: "altorg" });
    try {
      const messageTopic = "coordinator/altorg/consultations/thr-alt-1/messages";
      const seen: Array<{ topic: string; payload: string }> = [];
      mockBroker.publisher.on("message", (topic, payload) => {
        seen.push({ topic, payload: payload.toString("utf-8") });
      });
      await new Promise<void>((resolve, reject) => {
        mockBroker.publisher.subscribe(messageTopic, { qos: 0 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Spin up a second channel subprocess against this broker, with --org
      // pointing at "altorg" so its post_to_thread publishes there.
      const { createChannelHarness } = await import("../helpers/channel-test-harness.js");
      const tsxBin = path.join(
        REPO_ROOT,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "tsx.CMD" : "tsx",
      );
      const altHarness = await createChannelHarness({
        command: tsxBin,
        args: [
          path.join(REPO_ROOT, "cli", "index.ts"),
          "channel",
          "--broker-url",
          mockBroker.url,
          "--org",
          "altorg",
        ],
      });
      try {
        // Wait for the channel subprocess to wire up its MQTT subs before we
        // drive a tool call. (Subscriptions aren't strictly required for a
        // publish-side test, but the spawned process needs MQTT to be
        // connected so the publish callback fires.) The harness's client
        // exposes the underlying StdioClientTransport via `.transport` — pull
        // its piped stderr and watch for the same readiness marker as above.
        const altTransport = altHarness.client.transport as StdioClientTransport | undefined;
        await waitForStderrMarker(altTransport?.stderr, READY_MARKER);

        const result = await altHarness.client.callTool({
          name: "post_to_thread",
          arguments: {
            thread_id: "thr-alt-1",
            content: "alt-org reply",
            agent_id: "channel-tester",
          },
        });
        expect(result.isError).toBeFalsy();

        const deadline = Date.now() + 5000;
        let match: { topic: string; payload: string } | undefined;
        while (Date.now() < deadline) {
          match = seen.find((m) => m.topic === messageTopic);
          if (match) break;
          await new Promise<void>((r) => setTimeout(r, 50));
        }
        expect(
          match,
          `did not receive MQTT publish on ${messageTopic}; got: ${JSON.stringify(seen)}`,
        ).toBeDefined();
        const decoded = JSON.parse(match!.payload) as Record<string, unknown>;
        expect(decoded.agent_id).toBe("channel-tester");
        expect(decoded.content).toBe("alt-org reply");
      } finally {
        await altHarness.cleanup();
      }
    } finally {
      await mockBroker.cleanup();
    }
  }, 30_000);
});
