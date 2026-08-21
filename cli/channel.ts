/**
 * `mcp-coordinator channel` — Claude Code Channels (Phase 1 push + Phase 2 reply).
 *
 * This subcommand runs as a stdio MCP server that Claude Code spawns when
 * the user passes `--channels mcp-coordinator`. It is NOT the daemon — it is
 * a thin separate process that:
 *
 *   1. Subscribes to the daemon's MQTT broker (mqtt://127.0.0.1:<port>).
 *   2. Translates each coordination event into a `notifications/claude/channel`
 *      notification and pushes it into the Claude session.
 *   3. (Phase 2) Exposes a single `post_to_thread` tool that lets Claude
 *      reply into a consultation thread by publishing a message back over
 *      MQTT — same wire shape the daemon would produce. Channels become
 *      bidirectional without coupling the channel process to the daemon's
 *      HTTP surface (MQTT remains the canonical bus).
 *
 *   Claude Code session  ──stdio──▶  mcp-coordinator channel
 *                          ◀──        (notifications/claude/channel)
 *                          ──▶        (tools/call post_to_thread)
 *                                          │
 *                                          ▼  mqtt subscribe + publish
 *                                    mcp-coordinator daemon (unchanged)
 *
 * Phase 3 (permission relay, out-of-session injection) remains deferred per
 * the reference-plugin study.
 *
 * Authoritative spec: https://code.claude.com/docs/en/channels-reference
 *
 * Research-preview note: until this plugin is on Anthropic's allowlist,
 * users must launch Claude Code with `--dangerously-load-development-channels`
 * to enable an unverified channel server. The `post_to_thread` tool exposed
 * here is also research-preview — its name/schema may change before the
 * Channels API leaves preview. Document this in your README before publishing.
 */
import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";
import mqtt, { type MqttClient } from "mqtt";
import { z } from "zod";
import { loadConfig } from "./config.js";

/**
 * Shape of the structured notification we push at Claude. Matches the
 * `notifications/claude/channel` contract from the Channels reference:
 * a freeform `content` string the model reads inline, plus a `meta` bag
 * the host surfaces as attributes on the `<channel>` context tag.
 */
export interface ChannelNotificationParams {
  content: string;
  meta: Record<string, string>;
}

/**
 * Pure helper: turn a (topic, payload) MQTT event into the params of a
 * `notifications/claude/channel` notification. Exported so unit tests can
 * exercise every event type without spinning up MQTT or stdio.
 *
 * Returns `null` for topics we explicitly don't route (e.g. the empty
 * retained tombstone published when a consultation is cleared).
 *
 * Topic patterns handled:
 *   - coordinator/<org>/consultations/new
 *   - coordinator/<org>/consultations/<thread_id>/messages
 *   - coordinator/<org>/agents/<agent_id>/status
 */
export function buildChannelNotification(
  topic: string,
  rawPayload: string,
): ChannelNotificationParams | null {
  // Empty retained payload = tombstone for a cleared retain. Skip it —
  // pushing a blank notification would just spam the session.
  if (rawPayload.length === 0) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawPayload) as Record<string, unknown>;
  } catch {
    // Malformed JSON on a topic we own is a daemon bug, not something to
    // surface to the model. Skip and let the operator notice in logs.
    return null;
  }

  const parts = topic.split("/");
  // parts = ["coordinator", "<org>", "<kind>", ...]
  const org = parts[1] ?? "unknown";
  const kind = parts[2];

  // consultations/new : { thread_id, agent_id, subject, target_modules }
  if (kind === "consultations" && parts[3] === "new") {
    const threadId = strField(payload, "thread_id");
    const agentId = strField(payload, "agent_id");
    const subject = strField(payload, "subject");
    return {
      content: `New consultation from ${agentId || "unknown agent"} (thread ${threadId || "?"}): ${subject || "(no subject)"}`,
      meta: {
        event_type: "consultation_new",
        org,
        thread_id: threadId,
        agent_id: agentId,
      },
    };
  }

  // consultations/<thread_id>/messages : { agent_id, type, content }
  if (kind === "consultations" && parts[4] === "messages") {
    const threadId = parts[3] ?? "";
    const agentId = strField(payload, "agent_id");
    const type = strField(payload, "type");
    const content = strField(payload, "content");
    // strField already caps and sanitises; this keeps the tighter 160-char
    // budget a message body had before #355, so the notification stays short.
    const trimmed = content.length > 160 ? `${content.slice(0, 157)}...` : content;
    return {
      content: `Message on thread ${threadId} from ${agentId || "unknown"} [${type || "msg"}]: ${trimmed}`,
      meta: {
        event_type: "consultation_message",
        org,
        thread_id: threadId,
        agent_id: agentId,
        message_type: type,
      },
    };
  }

  // agents/<agent_id>/status : { status, name?, reason? }
  if (kind === "agents" && parts[4] === "status") {
    const agentId = parts[3] ?? "";
    const status = strField(payload, "status");
    const name = strField(payload, "name");
    const reason = strField(payload, "reason");
    const who = name ? `${agentId} (${name})` : agentId;
    const tail = reason ? ` — ${reason}` : "";
    return {
      content: `Agent ${who} is ${status || "unknown"}${tail}`,
      meta: {
        event_type: "agent_status",
        org,
        agent_id: agentId,
        status,
      },
    };
  }

  return null;
}

/**
 * Longest a single relayed field may be once it reaches another agent's
 * context. The five fields this bridge copies -- subject, plan, content,
 * summary, reason -- are declared `z.string()` with no `.max()` at either
 * transport, so an agent can put an arbitrary amount of text in one.
 */
const MAX_RELAYED_FIELD_CHARS = 200;

/**
 * Read a string field from a parsed JSON payload and make it safe to splice
 * into a <channel> body (#355).
 *
 * Everything this function returns was written by *another agent* and lands
 * verbatim in the reader's context. It is read as conversation content rather
 * than operator instruction -- only the static `instructions` string reaches a
 * system prompt -- so this is peer-level prompt injection, not privilege
 * escalation. It is still a real surface, and it was entirely unguarded:
 * newlines passed through, angle brackets passed through, and only `content`
 * had any length cap at all.
 *
 * Three things happen here, in order:
 *   - control characters and newlines collapse to spaces, so a payload cannot
 *     forge what looks like a new line of the transcript;
 *   - `<` and `>` are replaced, so a payload cannot close the surrounding
 *     <channel> tag or open one of its own;
 *   - the result is capped, with an explicit marker rather than a silent cut.
 */
function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") return "";
  let s = "";
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      s += " ";
    } else if (ch === "<") {
      s += "(";
    } else if (ch === ">") {
      s += ")";
    } else {
      s += ch;
    }
  }
  s = s.replace(/ {2,}/g, " ").trim();
  return s.length > MAX_RELAYED_FIELD_CHARS
    ? `${s.slice(0, MAX_RELAYED_FIELD_CHARS)}... (truncated)`
    : s;
}

const INSTRUCTIONS = [
  "You will receive coordination events from the mcp-coordinator daemon via",
  "`notifications/claude/channel`. Each event surfaces as a `<channel>` tag",
  "with `event_type`, optional `thread_id`, and optional `agent_id` attributes.",
  "",
  "Event types you will see:",
  "  - consultation_new (a.k.a. consultation_opened): another agent has opened",
  "    a consultation thread. This is the primary reason to reply — surface",
  "    context, propose a resolution, or just acknowledge.",
  "  - consultation_message: a new message landed on a thread. Reply when the",
  "    message asks you a question or otherwise requests input; otherwise treat",
  "    as ambient context.",
  "  - agent_status: an agent came online or went offline. READ-ONLY — do not",
  "    reply to status events.",
  "",
  "To reply into a thread, call the `post_to_thread` tool with the `thread_id`",
  "from the `<channel>` tag and your message in `content`. This publishes",
  "directly onto the coordinator's MQTT bus and reaches every other subscriber",
  "(including agents waiting on `wait_for_message`). No HTTP round-trip needed.",
  "",
  "Treat channel events as ambient awareness. Reply only when the event",
  "genuinely warrants it; this channel is a low-noise coordination surface,",
  "not a chat room.",
].join("\n");

export interface ChannelServerHandle {
  server: Server;
  mqttClient: MqttClient;
  /** Resolves when MQTT has CONNACKed and all three subscriptions are active. */
  ready: Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Default agent_id stamped onto channel-originated replies. The daemon's
 * audit trail uses this to attribute messages to the channel surface (rather
 * than to whichever agent_id Claude might guess). Callers can override at
 * tool-call time via the optional `agent_id` argument.
 */
export const CHANNEL_REPLY_AGENT_ID = "channel";

/**
 * Default `type` field for channel-originated replies on the
 * `coordinator/<org>/consultations/<id>/messages` topic. Matches the
 * `MessageType` union in `src/types.ts` (kept as a string so this file does
 * not pull in daemon types).
 */
const CHANNEL_REPLY_MESSAGE_TYPE = "context";

/**
 * Build the wire-level MQTT publish args for a `post_to_thread` reply.
 * Exported so unit tests can assert on the exact topic + payload without
 * spinning up a broker. Mirrors `MqttBridge.publishMessage` in `src/`.
 */
export function buildReplyPublish(input: {
  org: string;
  thread_id: string;
  agent_id: string;
  content: string;
}): { topic: string; payload: string; opts: { qos: 0 | 1 | 2; retain: boolean } } {
  return {
    topic: `coordinator/${input.org}/consultations/${input.thread_id}/messages`,
    payload: JSON.stringify({
      agent_id: input.agent_id,
      type: CHANNEL_REPLY_MESSAGE_TYPE,
      content: input.content,
    }),
    // QoS 0, no retain — matches MqttBridge.publishMessage (high-frequency
    // chat-style traffic, lossy-OK). Retain would be actively wrong: a future
    // subscriber would receive a stale "channel reply" on connect.
    opts: { qos: 0, retain: false },
  };
}

/**
 * zod schema for the `post_to_thread` tool's arguments. Exported so unit
 * tests can assert validation behaviour (e.g. missing `thread_id` is
 * rejected) without spinning up an MCP transport.
 */
export const PostToThreadArgsSchema = z.object({
  thread_id: z
    .string()
    .min(1, "thread_id is required")
    .describe("Thread ID from the <channel> tag's thread_id attribute."),
  content: z
    .string()
    .min(1, "content is required")
    .describe("The message body to post into the thread."),
  agent_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional override for the author attribution. Defaults to 'channel' so audit logs track channel-originated replies distinctly.",
    ),
});

export type PostToThreadArgs = z.infer<typeof PostToThreadArgsSchema>;

// The event_type here has to be one this file actually emits: the model is
// being told what to watch for. It said consultation_opened, which nothing
// produces -- translateEvent emits consultation_new, consultation_message and
// agent_status (#328).
const POST_TO_THREAD_TOOL_DESCRIPTION =
  "Reply into a consultation thread when the channel surfaces a " +
  '<channel event_type="consultation_new" thread_id="...">. Use to add ' +
  "context, propose a resolution, or just acknowledge the thread.";

/**
 * JSON Schema for `post_to_thread`'s `inputSchema`, derived from
 * `PostToThreadArgsSchema` so the published contract cannot drift from what
 * the handler actually validates (#363).
 *
 * The hand-written copy this replaces had already drifted: it advertised no
 * `minLength`, while the zod schema requires 1 on all three fields. A model
 * reading tools/list could send `content: ""` and get an isError for a value
 * the advertised contract called legal.
 *
 * Its comment claimed derivation was impossible because "the project's zod-v3
 * surface doesn't ship a toJSONSchema helper". The project is on zod 4.4.3 and
 * z.toJSONSchema exists; the justification outlived the constraint.
 *
 * Two shapes still have to be forced by hand, and neither is cosmetic:
 *   - `type` must be the literal "object", not `string`, for the tools/list
 *     result type. The object is deliberately NOT `as const` -- that made
 *     `required` a readonly tuple, which the v2 result type rejects.
 *   - `$schema` is emitted by z.toJSONSchema and does not belong in a
 *     tools/list entry, so it is destructured away.
 */
const { $schema: _jsonSchemaDialect, ...POST_TO_THREAD_JSON_SCHEMA } =
  z.toJSONSchema(PostToThreadArgsSchema);

// zod's own JSONSchema type is recursive and optional-heavy; it does not
// structurally satisfy the SDK's tools/list result, which fails with TS2322 on
// the whole handler. The SDK wants plain JSON values, so restate it as that.
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

const derived = POST_TO_THREAD_JSON_SCHEMA as {
  properties?: Record<string, JsonValue>;
  required?: string[];
};

const POST_TO_THREAD_INPUT_SCHEMA = {
  type: "object" as const,
  properties: derived.properties ?? {},
  required: derived.required ?? [],
  additionalProperties: false,
};

/**
 * Build the Server + MQTT client. Exported so tests can spin one up without
 * going through commander. Caller is responsible for `await handle.ready` and
 * for connecting `handle.server` to a transport.
 */
export function buildChannelServer(opts: {
  brokerUrl: string;
  // Optional auth — Phase 1 leaves this off by default (matches daemon's
  // anonymous-by-default broker config). Wire JWT only when the daemon has
  // AUTH_ENABLED and this process has been issued a token by some other means.
  username?: string;
  password?: string;
  /**
   * Org slug used to namespace the `coordinator/<org>/...` topic when
   * publishing replies. Defaults to `"default"` (matches MqttBridge's default
   * and `examples/python-mqtt/`). Only affects publish — subscriptions still
   * use a `+` wildcard so the channel sees events from every org on the
   * broker.
   */
  org?: string;
  /** Optional stderr logger; defaults to console.error so it surfaces under stdio. */
  log?: (msg: string, ...rest: unknown[]) => void;
}): ChannelServerHandle {
  const log = opts.log ?? ((m, ...rest) => console.error(`[channel] ${m}`, ...rest));
  const org = opts.org ?? "default";

  const server = new Server(
    { name: "mcp-coordinator-channel", version: "0.2.0" },
    {
      // Channels capability is experimental in the spec — declare it so
      // Claude Code's channel host recognises the server. Phase 2 adds:
      //   - `experimental.tools: {}` — signals to a Channels-aware host that
      //     this server's tools belong to the channel surface (not the main
      //     MCP toolbelt). This is the symbolic declaration the spec asks
      //     for.
      //   - top-level `tools: {}` — the MCP SDK's `assertRequestHandlerCapability`
      //     checks `_capabilities.tools` (not the experimental subkey) before
      //     allowing `tools/list` and `tools/call` handlers. Required for the
      //     `post_to_thread` registration below to actually be invocable.
      capabilities: {
        experimental: {
          "claude/channel": {},
          tools: {},
        },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  // Connect to the daemon's MQTT broker. `clean: true` + no LWT — we are a
  // pure subscriber, not a participating agent.
  const client = mqtt.connect(opts.brokerUrl, {
    clientId: `channel-${process.pid}-${Date.now()}`,
    clean: true,
    username: opts.username,
    password: opts.password,
    reconnectPeriod: 2000,
  });

  // ─── Phase 2: tool registration ─────────────────────────────────────────
  //
  // `tools/list` and `tools/call` handlers for the single `post_to_thread`
  // reply tool. Implementation publishes to MQTT directly — the channel
  // process never speaks HTTP to the daemon. This keeps the transport
  // surface minimal (stdio in, MQTT out) and aligns with the daemon's
  // "MQTT is the canonical bus" contract.

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "post_to_thread",
        description: POST_TO_THREAD_TOOL_DESCRIPTION,
        inputSchema: POST_TO_THREAD_INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler("tools/call", async (request) => {
    if (request.params.name !== "post_to_thread") {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Unknown tool: ${request.params.name}. The channel server only exposes 'post_to_thread'.`,
          },
        ],
      };
    }

    const parsed = PostToThreadArgsSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      // Surface validation failures as a tool-level error rather than an MCP
      // protocol error: the model can read the message, correct the call,
      // and retry. Throwing here would tear down the whole tools/call.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Invalid arguments for post_to_thread: ${parsed.error.message}`,
          },
        ],
      };
    }

    const { thread_id, content, agent_id } = parsed.data;
    const {
      topic,
      payload,
      opts: publishOpts,
    } = buildReplyPublish({
      org,
      thread_id,
      agent_id: agent_id ?? CHANNEL_REPLY_AGENT_ID,
      content,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        client.publish(topic, payload, publishOpts, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("post_to_thread publish failed", msg);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to publish reply to MQTT broker: ${msg}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Posted to thread ${thread_id} as ${agent_id ?? CHANNEL_REPLY_AGENT_ID}.`,
        },
      ],
    };
  });

  // Three topic patterns from the spec / issue #130.
  //
  // issue #330: the org segment was a `+` wildcard unconditionally, and the
  // broker's authorizeSubscribe hook tests `startsWith("coordinator/<org>/")`
  // — which a `+` never satisfies. So the moment MQTT auth was enabled all
  // three subscriptions were refused and this sidecar went deaf SILENTLY: a
  // subscribe refusal is `cb(null, null)`, not an error, so the callback below
  // sees no `err` and reports ready.
  //
  // So: when an org is EXPLICITLY configured, name it — that subscription the
  // ACL grants. Without one, keep the wildcard.
  //
  // Note this reads the RAW `opts.org`, not the `org` binding above, which is
  // `opts.org ?? "default"`. Using the defaulted value looked tidier and was
  // wrong: it silently pinned an unconfigured channel to `default` and killed
  // the cross-org watch mode, which channel-smoke covers by publishing on
  // `testorg` and `altorg`. "No org configured" and "org is default" are
  // different states here and only the raw option tells them apart.
  //
  // The wildcard remains incompatible with MQTT auth, and that is not a bug to
  // fix: watching every org IS a cross-org subscription, which is precisely
  // what the ACL exists to refuse. Under auth, pass `--org`.
  const orgSegment = opts.org ?? "+";
  const TOPICS = [
    `coordinator/${orgSegment}/consultations/new`,
    `coordinator/${orgSegment}/consultations/+/messages`,
    `coordinator/${orgSegment}/agents/+/status`,
  ];

  let readyResolve!: () => void;
  let readyReject!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  client.on("connect", () => {
    log("MQTT connected", { url: opts.brokerUrl });
    let pending = TOPICS.length;
    let failed = false;
    for (const t of TOPICS) {
      client.subscribe(t, { qos: 1 }, (err) => {
        if (err && !failed) {
          failed = true;
          readyReject(err);
          return;
        }
        if (--pending === 0 && !failed) {
          readyResolve();
        }
      });
    }
  });

  client.on("error", (err) => {
    log("MQTT error", err.message);
  });

  client.on("message", (topic, payload) => {
    const params = buildChannelNotification(topic, payload.toString("utf-8"));
    if (params === null) return;
    // Fire-and-forget: notifications are one-way. Errors here would mean the
    // stdio transport is dead, in which case Claude has already gone away.
    server
      .notification({
        method: "notifications/claude/channel",
        params: params as unknown as Record<string, unknown>,
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log("notification failed", msg);
      });
  });

  return {
    server,
    mqttClient: client,
    ready,
    stop: async () => {
      try {
        await new Promise<void>((resolve) => {
          client.end(false, {}, () => resolve());
        });
      } catch {
        // Best-effort.
      }
      try {
        await server.close();
      } catch {
        // Best-effort.
      }
    },
  };
}

export function createChannelCommand(): Command {
  return new Command("channel")
    .description(
      "Run the Claude Code Channels stdio server (Phase 1: push-only). " +
        "Subscribes to the local coordinator daemon's MQTT broker and pushes " +
        "coordination events into the Claude session as `notifications/claude/channel`.",
    )
    .option(
      "--broker-url <url>",
      "MQTT broker URL (defaults to mqtt://127.0.0.1:<config.server.port - 1> or env COORDINATOR_MQTT_URL)",
    )
    .option("--mqtt-username <user>", "MQTT username (optional, only when daemon has AUTH_ENABLED)")
    .option("--mqtt-password <pass>", "MQTT password / JWT (optional)")
    .option(
      "--org <slug>",
      "Org slug used when publishing replies via post_to_thread (defaults to env COORDINATOR_ORG or 'default')",
    )
    .action(
      async (rawOpts: {
        brokerUrl?: string;
        mqttUsername?: string;
        mqttPassword?: string;
        org?: string;
      }) => {
        // Resolve broker URL: flag > env > config-derived default.
        // The daemon exposes MQTT on a separate TCP port from HTTP. Until the
        // daemon publishes the MQTT port via config.json explicitly, we default
        // to mqtt://127.0.0.1:1883 (the conventional broker port). loadConfig()
        // is still consulted for forward compat — if a future schema adds an
        // explicit `server.mqtt_port`, this branch will be widened to use it.
        void loadConfig(); // touched intentionally — surfaces config errors early
        const brokerUrl =
          rawOpts.brokerUrl ?? process.env.COORDINATOR_MQTT_URL ?? "mqtt://127.0.0.1:1883";

        const handle = buildChannelServer({
          brokerUrl,
          username: rawOpts.mqttUsername ?? process.env.COORDINATOR_MQTT_USER,
          password: rawOpts.mqttPassword ?? process.env.COORDINATOR_MQTT_PASSWORD,
          org: rawOpts.org ?? process.env.COORDINATOR_ORG,
        });

        const transport = new StdioServerTransport();
        await handle.server.connect(transport);

        // Surface SIGINT/SIGTERM cleanly — Claude Code may send these to shut
        // down the channel host. We ALSO listen for stdin EOF: when the parent
        // process closes our stdin (the official MCP SDK close path), we exit
        // gracefully without waiting for a signal. This matters on Windows
        // where signal forwarding through `npx`/`tsx` shims is unreliable.
        let shuttingDown = false;
        const shutdown = async (): Promise<void> => {
          if (shuttingDown) return;
          shuttingDown = true;
          await handle.stop();
          process.exit(0);
        };
        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());
        process.stdin.on("end", () => void shutdown());
        process.stdin.on("close", () => void shutdown());

        // Don't await ready — the stdio handshake should complete even if MQTT
        // is still connecting. Surface readiness on stderr for operators.
        handle.ready.then(
          () => console.error("[channel] subscriptions active"),
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[channel] subscribe failed:", msg);
          },
        );
      },
    );
}
