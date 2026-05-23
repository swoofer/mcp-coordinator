/**
 * Inline stub MCP server used by `channel-harness-self-test.ts`.
 *
 * Mimics what `cli/channel.ts` will do once #130 Phase 1 lands, without any
 * MQTT subscription logic:
 *
 *   1. Declares `experimental["claude/channel"]` capability so a client
 *      asserting on capabilities sees the same surface a real channel mode
 *      would expose.
 *   2. After `initialized`, pushes ONE `notifications/claude/channel` event
 *      on a short timer so the harness has something to capture.
 *
 * The whole point is to prove the harness wiring works end-to-end without
 * blocking on the not-yet-existing `cli/channel.ts`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "channel-stub", version: "0.0.0-test" },
  {
    capabilities: {
      // The Channels spec advertises this capability so consumers can detect
      // channel-mode support via the standard `initialize` exchange.
      experimental: {
        "claude/channel": {},
      },
    },
  },
);

// Once the client sends `initialized`, push one notification on a short timer.
// Done via `setTimeout` rather than inline so we exercise the asynchronous
// arrival path in the harness (waitForNotification with a future event).
server.oninitialized = (): void => {
  setTimeout(() => {
    void server.notification({
      method: "notifications/claude/channel",
      params: {
        content: "consultation opened: refactor auth module",
        meta: {
          topic_kind: "consultation_opened",
          thread_id: "t-stub-1",
          agent_id: "agent-stub",
        },
      },
    });
  }, 25);
};

const transport = new StdioServerTransport();
await server.connect(transport);
