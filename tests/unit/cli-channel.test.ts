/**
 * Unit tests for the Channels Phase 1 CLI (`mcp-coordinator channel`).
 *
 * Covers:
 *   - The pure `buildChannelNotification` helper for every supported
 *     topic shape (consultations/new, consultations/<id>/messages,
 *     agents/<id>/status), plus the empty-tombstone skip.
 *   - The Server constructed by `buildChannelServer` declares the
 *     `experimental['claude/channel']` capability and does NOT declare
 *     a `tools` capability (Phase 1 is push-only).
 *
 * MQTT itself is not exercised here — that's the integration test's job.
 * We tear the MQTT client down immediately via `handle.stop()` to keep this
 * file fast and process-clean.
 */
import { describe, it, expect, afterEach } from "vitest";
import { buildChannelNotification, buildChannelServer } from "../../cli/channel.js";

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
    const out = buildChannelNotification(
      "coordinator/acme/consultations/new",
      "",
    );
    expect(out).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const out = buildChannelNotification(
      "coordinator/acme/consultations/new",
      "{not valid json",
    );
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

  it("declares experimental['claude/channel'] capability and no tools capability", () => {
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
    expect(capsField.experimental).toMatchObject({ "claude/channel": {} });
    expect(capsField.tools).toBeUndefined();
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
  });
});
