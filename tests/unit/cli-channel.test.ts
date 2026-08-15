/**
 * Unit tests for the Channels CLI (`mcp-coordinator channel`).
 *
 * Covers:
 *   - The pure `buildChannelNotification` helper for every supported
 *     topic shape (consultations/new, consultations/<id>/messages,
 *     agents/<id>/status), plus the empty-tombstone skip. (Phase 1)
 *   - The Server constructed by `buildChannelServer` declares the
 *     `experimental['claude/channel']` capability AND a `tools` capability
 *     (Phase 2 adds the `post_to_thread` reply tool).
 *   - The `post_to_thread` tool: schema validation rejects missing
 *     `thread_id`, and a successful call publishes the right MQTT topic +
 *     payload against a mocked mqtt client. (Phase 2)
 *
 * MQTT itself is not exercised here — that's the integration test's job
 * (the unit tests mock `mqtt.connect` to assert the publish args).
 * We tear the MQTT client down immediately via `handle.stop()` to keep this
 * file fast and process-clean.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildChannelNotification,
  buildChannelServer,
  buildReplyPublish,
  CHANNEL_REPLY_AGENT_ID,
  PostToThreadArgsSchema,
} from "../../cli/channel.js";

describe("buildChannelNotification — payload translation", () => {
  it("renders a consultation_new event", () => {
    const out = buildChannelNotification(
      "coordinator/acme/consultations/new",
      JSON.stringify({
        thread_id: "t-123",
        agent_id: "alice",
        subject: "review auth refactor",
        target_modules: ["src/auth"],
      }),
    );
    expect(out).not.toBeNull();
    expect(out!.content).toContain("alice");
    expect(out!.content).toContain("t-123");
    expect(out!.content).toContain("review auth refactor");
    expect(out!.meta).toMatchObject({
      event_type: "consultation_new",
      org: "acme",
      thread_id: "t-123",
      agent_id: "alice",
    });
  });

  it("renders a consultation_message event and truncates long bodies", () => {
    const longBody = "x".repeat(500);
    const out = buildChannelNotification(
      "coordinator/acme/consultations/t-9/messages",
      JSON.stringify({
        agent_id: "bob",
        type: "comment",
        content: longBody,
      }),
    );
    expect(out).not.toBeNull();
    expect(out!.content).toMatch(/thread t-9 from bob \[comment\]/);
    // 160-char cap with trailing "..."
    expect(out!.content.length).toBeLessThan(260);
    expect(out!.content.endsWith("...")).toBe(true);
    expect(out!.meta).toMatchObject({
      event_type: "consultation_message",
      thread_id: "t-9",
      agent_id: "bob",
      message_type: "comment",
    });
  });

  it("renders an agent_status event with the agent name when present", () => {
    const out = buildChannelNotification(
      "coordinator/acme/agents/alice/status",
      JSON.stringify({ status: "online", name: "Alice" }),
    );
    expect(out).not.toBeNull();
    expect(out!.content).toBe("Agent alice (Alice) is online");
    expect(out!.meta).toMatchObject({
      event_type: "agent_status",
      agent_id: "alice",
      status: "online",
    });
  });

  it("renders an agent_status offline event with the LWT reason", () => {
    const out = buildChannelNotification(
      "coordinator/acme/agents/alice/status",
      JSON.stringify({ status: "offline", reason: "lwt_unexpected" }),
    );
    expect(out!.content).toContain("offline");
    expect(out!.content).toContain("lwt_unexpected");
  });

  it("returns null for the empty retained tombstone (cleared consultation)", () => {
    // mqtt-bridge.clearRetainedConsultation publishes an empty payload to
    // wipe the retain flag — translating it into a blank notification would
    // spam the session.
    const out = buildChannelNotification("coordinator/acme/consultations/new", "");
    expect(out).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const out = buildChannelNotification("coordinator/acme/consultations/new", "{not valid json");
    expect(out).toBeNull();
  });

  it("returns null for unknown topic shapes", () => {
    const out = buildChannelNotification(
      "coordinator/acme/some/random/topic",
      JSON.stringify({ foo: "bar" }),
    );
    expect(out).toBeNull();
  });
});

describe("buildChannelServer — capability surface", () => {
  // We point at a port we know is closed; mqtt.connect will retry forever but
  // we tear it down in afterEach. The Server itself is constructed
  // synchronously before any MQTT activity matters.
  let handle: ReturnType<typeof buildChannelServer> | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
  });

  it("declares experimental['claude/channel'] + experimental.tools + top-level tools", () => {
    handle = buildChannelServer({
      brokerUrl: "mqtt://127.0.0.1:1", // closed port — no broker to talk to
      log: () => {}, // silence stderr in tests
    });

    // Server keeps its options private (_capabilities), but we can verify the
    // shape via `getCapabilities`-style access through the public initializer
    // contract. The SDK exposes nothing simpler than a property cast for
    // this kind of introspection in a unit test — justified `any` use.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capsField = (handle.server as any)._capabilities as Record<string, unknown>;
    expect(capsField).toBeDefined();
    // Phase 1: channel push capability.
    expect(capsField.experimental).toMatchObject({
      "claude/channel": {},
      // Phase 2: symbolic flag so Channels-aware hosts know the tools on
      // this server belong to the channel surface.
      tools: {},
    });
    // Phase 2: real `tools` capability so the MCP SDK lets us register
    // tools/list + tools/call handlers.
    expect(capsField.tools).toBeDefined();
    expect(capsField.resources).toBeUndefined();
    expect(capsField.prompts).toBeUndefined();
  });

  it("includes a non-empty instructions string for the client", () => {
    handle = buildChannelServer({
      brokerUrl: "mqtt://127.0.0.1:1",
      log: () => {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instructions = (handle.server as any)._instructions as string | undefined;
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(50);
    expect(instructions).toMatch(/notifications\/claude\/channel/);
    // Phase 2: instructions must tell Claude when to use the reply tool.
    expect(instructions).toMatch(/post_to_thread/);
  });
});

// ─── Phase 2: post_to_thread reply tool ──────────────────────────────────

describe("PostToThreadArgsSchema — validation", () => {
  it("accepts a minimal valid call (thread_id + content)", () => {
    const parsed = PostToThreadArgsSchema.safeParse({
      thread_id: "t-1",
      content: "hello",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an optional agent_id override", () => {
    const parsed = PostToThreadArgsSchema.safeParse({
      thread_id: "t-1",
      content: "hello",
      agent_id: "custom-agent",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.agent_id).toBe("custom-agent");
    }
  });

  it("rejects a call missing thread_id", () => {
    const parsed = PostToThreadArgsSchema.safeParse({ content: "hello" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.path.join("."));
      expect(issues).toContain("thread_id");
    }
  });

  it("rejects a call missing content", () => {
    const parsed = PostToThreadArgsSchema.safeParse({ thread_id: "t-1" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty thread_id (zero-length string)", () => {
    const parsed = PostToThreadArgsSchema.safeParse({ thread_id: "", content: "hi" });
    expect(parsed.success).toBe(false);
  });
});

describe("buildReplyPublish — wire shape", () => {
  it("produces the documented topic + payload + opts for a default-org reply", () => {
    const out = buildReplyPublish({
      org: "default",
      thread_id: "t-42",
      agent_id: CHANNEL_REPLY_AGENT_ID,
      content: "ack — looking now",
    });
    expect(out.topic).toBe("coordinator/default/consultations/t-42/messages");
    const decoded = JSON.parse(out.payload) as Record<string, unknown>;
    expect(decoded).toEqual({
      agent_id: "channel",
      type: "context",
      content: "ack — looking now",
    });
    // Matches MqttBridge.publishMessage: QoS 0, no retain (chat-style traffic).
    expect(out.opts).toEqual({ qos: 0, retain: false });
  });

  it("namespaces the topic by org", () => {
    const out = buildReplyPublish({
      org: "acme",
      thread_id: "t-1",
      agent_id: "channel",
      content: "x",
    });
    expect(out.topic).toBe("coordinator/acme/consultations/t-1/messages");
  });

  it("honours a caller-supplied agent_id override", () => {
    const out = buildReplyPublish({
      org: "default",
      thread_id: "t-1",
      agent_id: "alice",
      content: "x",
    });
    const decoded = JSON.parse(out.payload) as Record<string, unknown>;
    expect(decoded.agent_id).toBe("alice");
  });
});

// Mock the `mqtt` module so we can assert publish() args without a broker.
//
// vi.mock is hoisted by vitest, so the mock is in place before
// `buildChannelServer` imports mqtt. The factory returns a default export
// matching mqtt's surface: `connect()` yields a thin EventEmitter with the
// methods buildChannelServer calls (subscribe, publish, end, on).
vi.mock("mqtt", () => {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const publishCalls: Array<{ topic: string; payload: string; opts: unknown }> = [];
  const create = (): unknown => {
    const ee = new EventEmitter();
    const client = Object.assign(ee, {
      subscribe: (_topic: string, _opts: unknown, cb: (err: Error | null) => void): void =>
        cb(null),
      publish: (
        topic: string,
        payload: string,
        opts: unknown,
        cb: (err: Error | null) => void,
      ): void => {
        publishCalls.push({ topic, payload, opts });
        cb(null);
      },
      end: (_force: boolean, _opts: unknown, cb: () => void): void => {
        cb();
      },
      __publishCalls: publishCalls,
    });
    // Don't auto-fire "connect" — leaves the channel in a not-yet-ready
    // state, which is fine because the unit test invokes the handler
    // directly (no real round-trip through MQTT readiness).
    return client;
  };
  return {
    default: { connect: (_url: string) => create() },
    connect: (_url: string) => create(),
  };
});

describe("buildChannelServer — post_to_thread tool registration", () => {
  let handle: ReturnType<typeof buildChannelServer> | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
  });

  it("registers the tool with the documented name + required-fields schema via tools/list", async () => {
    handle = buildChannelServer({ brokerUrl: "mqtt://127.0.0.1:1", log: () => {} });
    // Drive the registered handler via the SDK's protected dispatcher: there
    // is no public "list tools on this server" method on the server-side, so
    // we reach into the internal _requestHandlers map. Justified `any` for
    // unit-test introspection only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers = (handle.server as any)._requestHandlers as Map<
      string,
      (req: unknown, extra: unknown) => Promise<unknown>
    >;
    const listHandler = handlers.get("tools/list");
    expect(listHandler).toBeDefined();
    const result = (await listHandler!(
      { method: "tools/list", params: {} },
      {
        signal: new AbortController().signal,
        requestId: 1,
        sendNotification: async () => {},
        sendRequest: async () => ({}),
        // v2 reads ctx.mcpReq while dispatching (input-required handling), so
        // a v1-shaped extra makes the dispatcher throw before the handler is
        // ever reached. Only id/method are consulted on this path.
        mcpReq: { id: 1, method: "tools/call", requestState: () => undefined },
      },
    )) as {
      tools: Array<{ name: string; description: string; inputSchema: { required?: string[] } }>;
    };
    expect(result.tools).toHaveLength(1);
    const tool = result.tools[0];
    expect(tool.name).toBe("post_to_thread");
    expect(tool.description).toMatch(/consultation_opened/);
    expect(tool.inputSchema.required).toEqual(["thread_id", "content"]);
  });

  it("publishes the right MQTT topic + payload when post_to_thread is called", async () => {
    handle = buildChannelServer({
      brokerUrl: "mqtt://127.0.0.1:1",
      org: "default",
      log: () => {},
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers = (handle.server as any)._requestHandlers as Map<
      string,
      (req: unknown, extra: unknown) => Promise<unknown>
    >;
    const callHandler = handlers.get("tools/call");
    expect(callHandler).toBeDefined();

    const result = (await callHandler!(
      {
        method: "tools/call",
        params: {
          name: "post_to_thread",
          arguments: { thread_id: "t-99", content: "ack from channel" },
        },
      },
      {
        signal: new AbortController().signal,
        requestId: 2,
        sendNotification: async () => {},
        sendRequest: async () => ({}),
        // v2 reads ctx.mcpReq while dispatching (input-required handling),
        // so a v1-shaped extra makes the dispatcher throw before the handler
        // is ever reached. Only id/method are consulted on this path.
        mcpReq: { id: 2, method: "tools/call", requestState: () => undefined },
      },
    )) as { isError?: boolean; content: Array<{ type: string; text: string }> };

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("t-99");

    // Reach into the mocked mqtt client to assert the publish args.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (handle.mqttClient as any).__publishCalls as Array<{
      topic: string;
      payload: string;
      opts: { qos: number; retain: boolean };
    }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].topic).toBe("coordinator/default/consultations/t-99/messages");
    expect(JSON.parse(calls[0].payload)).toEqual({
      agent_id: "channel",
      type: "context",
      content: "ack from channel",
    });
    expect(calls[0].opts).toEqual({ qos: 0, retain: false });
  });

  it("returns an isError result (not a throw) when arguments are invalid", async () => {
    handle = buildChannelServer({ brokerUrl: "mqtt://127.0.0.1:1", log: () => {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers = (handle.server as any)._requestHandlers as Map<
      string,
      (req: unknown, extra: unknown) => Promise<unknown>
    >;
    const callHandler = handlers.get("tools/call");
    const result = (await callHandler!(
      {
        method: "tools/call",
        params: { name: "post_to_thread", arguments: { content: "no thread id" } },
      },
      {
        signal: new AbortController().signal,
        requestId: 3,
        sendNotification: async () => {},
        sendRequest: async () => ({}),
        // v2 reads ctx.mcpReq while dispatching (input-required handling), so
        // a v1-shaped extra makes the dispatcher throw before the handler is
        // ever reached. Only id/method are consulted on this path.
        mcpReq: { id: 3, method: "tools/call", requestState: () => undefined },
      },
    )) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid arguments/);
  });

  it("returns an isError result for an unknown tool name", async () => {
    handle = buildChannelServer({ brokerUrl: "mqtt://127.0.0.1:1", log: () => {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers = (handle.server as any)._requestHandlers as Map<
      string,
      (req: unknown, extra: unknown) => Promise<unknown>
    >;
    const callHandler = handlers.get("tools/call");
    const result = (await callHandler!(
      {
        method: "tools/call",
        params: { name: "nonexistent", arguments: {} },
      },
      {
        signal: new AbortController().signal,
        requestId: 4,
        sendNotification: async () => {},
        sendRequest: async () => ({}),
        // v2 reads ctx.mcpReq while dispatching (input-required handling), so
        // a v1-shaped extra makes the dispatcher throw before the handler is
        // ever reached. Only id/method are consulted on this path.
        mcpReq: { id: 4, method: "tools/call", requestState: () => undefined },
      },
    )) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool/);
  });
});
