/**
 * Channel test harness — for asserting that the upcoming Channels integration
 * (#130 Phase 1, `cli/channel.ts`) emits the right `notifications/claude/channel`
 * events when given specific MQTT inputs.
 *
 * Two pieces ship from this file:
 *
 *   1. `createChannelHarness(opts)` — spawns the channel-mode stdio process,
 *      connects an MCP SDK client, captures every `notifications/claude/channel`
 *      payload, and exposes a `waitForNotification(predicate, timeoutMs?)`
 *      helper so tests can assert on specific events without poll-loops.
 *
 *   2. `createMockMqttBroker()` — boots an in-process aedes broker on a free
 *      port and returns an mqtt.js client wired with publish helpers that
 *      match the wire-level topics the Channels implementation will subscribe
 *      to (`coordinator/<org>/consultations/new`, `.../messages`,
 *      `.../agents/<id>/status`). Tests use these to drive the channel mode
 *      end-to-end without standing up the full coordinator daemon.
 *
 * Why both pieces live in one file: they're always used together. Every
 * Channels Phase 1 test will look like:
 *
 *   const broker  = await createMockMqttBroker();
 *   const channel = await createChannelHarness({ mqttUrl: broker.url });
 *   broker.publishConsultationOpened({ thread_id: "t-1", subject: "...", agent_id: "a" });
 *   const ev = await channel.waitForNotification((n) =>
 *     n.params.meta.topic_kind === "consultation_opened",
 *   );
 *   expect(ev.params.content).toContain("...");
 *
 * Until `cli/channel.ts` lands, point `command`/`args` at any stdio MCP server
 * that declares `experimental["claude/channel"]` and pushes the right
 * notifications — see `tests/unit/channel-harness-self-test.ts` for the
 * minimal inline stub used to prove the wiring.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { createServer as createTcpServer, type Server as NetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

// ─── Notification contract ────────────────────────────────────────────────

/**
 * Wire-level shape of a `notifications/claude/channel` event. Mirrors the
 * Channels #130 contract: a free-form `content` string (what Claude sees in
 * the chat surface) plus a `meta` map of string → string tags the harness
 * uses for assertion-filtering (`topic_kind`, `thread_id`, `agent_id`, ...).
 *
 * Kept loose by design: the implementation team is still iterating on `meta`
 * keys, and we don't want test infra to drift each time a key is added.
 */
/**
 * Built as a fresh zod-v3 object schema (rather than extending the SDK's
 * `NotificationSchema`) so it composes cleanly with this repo's zod v3 — the
 * SDK exposes its internal zod v4 through `.extend(...)` return types, which
 * breaks v3 inference at the call site.
 *
 * Marked `.passthrough()` on `params` so the implementation team can add new
 * fields without breaking the harness — only `content` and `meta` are
 * load-bearing for assertions today.
 */
export const ChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z
    .object({
      content: z.string(),
      meta: z.record(z.string()),
    })
    .passthrough(),
});

export type ChannelNotification = z.infer<typeof ChannelNotificationSchema>;

export type ChannelNotificationPredicate = (n: ChannelNotification) => boolean;

// ─── Harness handle ───────────────────────────────────────────────────────

export interface ChannelHarness {
  /** Live MCP SDK client connected to the channel-mode stdio process. */
  client: Client;
  /**
   * Every `notifications/claude/channel` the server has pushed since the
   * harness connected, in arrival order. Mutated as new events arrive — tests
   * can snapshot with `.slice()` if they need a stable view.
   */
  readonly receivedNotifications: ChannelNotification[];
  /**
   * Resolve with the first notification (past OR future) matching the
   * predicate. Rejects with a descriptive Error if none matches within
   * `timeoutMs` (default 2000ms).
   *
   * Past matches are returned synchronously on next-tick — this lets tests
   * write straight-line code without worrying about race conditions between
   * "publish MQTT" and "subscribe to notifications".
   */
  waitForNotification(
    predicate: ChannelNotificationPredicate,
    timeoutMs?: number,
  ): Promise<ChannelNotification>;
  /**
   * Shut down the stdio subprocess + close the client. MUST run in
   * `afterEach`/`afterAll` or a try/finally — otherwise the subprocess
   * leaks across the suite.
   */
  cleanup(): Promise<void>;
}

export interface CreateChannelHarnessOptions {
  /**
   * Spawnable command. Defaults to `tsx` (resolved on PATH) so the harness
   * works out of the box against `cli/channel.ts` once that file lands.
   * Override to point at a mock binary (e.g. `process.execPath`) for the
   * self-test, or at `pnpm` once the official entrypoint is wired up.
   */
  command?: string;
  /**
   * Args passed to `command`. Defaults to `["cli/channel.ts"]` (resolved
   * against the repo root). Override to point at the inline stub or a
   * custom build.
   */
  args?: string[];
  /**
   * Extra env vars merged onto `process.env`. Use this to pass
   * `COORDINATOR_MQTT_URL`, `COORDINATOR_ORG`, etc. to the channel mode.
   */
  env?: Record<string, string>;
  /**
   * Convenience: passed to the spawned process as `COORDINATOR_MQTT_URL`
   * (which is the env var the Channels implementation team has agreed on).
   * Set this to the URL returned by `createMockMqttBroker()`. If you also
   * pass `env.COORDINATOR_MQTT_URL`, the explicit env value wins.
   */
  mqttUrl?: string;
  /** Working directory for the spawned process. Defaults to the repo root. */
  cwd?: string;
}

/**
 * Spawn the channel-mode stdio MCP server and return a harness that captures
 * every `notifications/claude/channel` push. Tests then drive inputs via
 * `createMockMqttBroker()` and assert on the captured events.
 */
export async function createChannelHarness(
  opts: CreateChannelHarnessOptions = {},
): Promise<ChannelHarness> {
  // On Windows, `tsx` (and all npm-installed CLIs) are .cmd shims. The MCP
  // SDK's StdioClientTransport spawns without a shell, so we must point at
  // the .cmd directly. Mirrors the pattern in mcp-client-harness.ts.
  const defaultCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const defaultArgs = ["tsx", path.join(REPO_ROOT, "cli", "channel.ts")];

  const command = opts.command ?? defaultCommand;
  const args = opts.args ?? defaultArgs;

  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Defensive: never let a channel-mode subprocess try to enable auth.
    COORDINATOR_AUTH_ENABLED: "false",
  };
  if (opts.mqttUrl !== undefined) {
    mergedEnv.COORDINATOR_MQTT_URL = opts.mqttUrl;
  }
  Object.assign(mergedEnv, opts.env ?? {});

  const transport = new StdioClientTransport({
    command,
    args,
    env: mergedEnv,
    cwd: opts.cwd ?? REPO_ROOT,
    // Pipe stderr through so test failure output surfaces server logs.
    stderr: "pipe",
  });

  const client = new Client(
    { name: "channel-harness", version: "0.0.0-test" },
    { capabilities: {} },
  );

  // Buffer of all notifications seen + a list of pending `waitForNotification`
  // callers. New arrivals try each waiter in order; a matching waiter is
  // resolved and removed from the list.
  const receivedNotifications: ChannelNotification[] = [];
  interface Waiter {
    predicate: ChannelNotificationPredicate;
    resolve: (n: ChannelNotification) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }
  const waiters: Waiter[] = [];

  client.setNotificationHandler(ChannelNotificationSchema, (notification) => {
    // `setNotificationHandler` already ran the zod parse — `notification` here
    // is the parsed shape. Cast through `unknown` to bridge the SDK's zod v4
    // type surface back to this file's zod v3 inference.
    const parsed = notification as unknown as ChannelNotification;
    receivedNotifications.push(parsed);

    // Try to fulfill any pending waiter. Iterate by index because we mutate
    // the array on a match.
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i];
      let matched = false;
      try {
        matched = w.predicate(parsed);
      } catch (err) {
        // A throwing predicate is a test bug — surface it.
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (matched) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(parsed);
        return;
      }
    }
  });

  await client.connect(transport);

  return {
    client,
    receivedNotifications,
    waitForNotification(predicate, timeoutMs = 2000) {
      // Fast-path: maybe a past notification already matches.
      for (const n of receivedNotifications) {
        let matched = false;
        try {
          matched = predicate(n);
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
        if (matched) return Promise.resolve(n);
      }
      return new Promise<ChannelNotification>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(
            new Error(
              `channel-harness: waitForNotification timed out after ${timeoutMs}ms ` +
                `(received ${receivedNotifications.length} notification(s) so far, none matched)`,
            ),
          );
        }, timeoutMs);
        // `unref()` so a leaked waiter doesn't hold the event loop open.
        timer.unref?.();
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    cleanup: async () => {
      // Reject any still-pending waiters so tests don't hang on a forgotten
      // `await` after teardown.
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error("channel-harness: cleanup() called before notification arrived"));
      }
      try {
        await client.close();
      } catch {
        // Subprocess may already be gone; swallow.
      }
    },
  };
}

// ─── Mock MQTT broker ─────────────────────────────────────────────────────

export interface MockMqttBroker {
  /** `mqtt://127.0.0.1:<port>` — pass this to `createChannelHarness({ mqttUrl })`. */
  readonly url: string;
  readonly port: number;
  /** A connected publisher client. Use the helpers below rather than `.publish()` directly. */
  readonly publisher: MqttClient;
  /**
   * Publish a `coordinator/<org>/consultations/new` event. Mirrors the
   * wire-level shape produced by `MqttBridge.publishConsultation`.
   */
  publishConsultationOpened(input: ConsultationOpenedInput): Promise<void>;
  /**
   * Publish a `coordinator/<org>/consultations/<thread_id>/messages` event.
   * Mirrors `MqttBridge.publishMessage`.
   */
  publishThreadMessage(input: ThreadMessageInput): Promise<void>;
  /**
   * Publish a `coordinator/<org>/agents/<agent_id>/status` event. Mirrors
   * `MqttBridge.registerAgent` / `publishAgentOffline`.
   */
  publishAgentStatus(input: AgentStatusInput): Promise<void>;
  /**
   * Escape hatch — publish a raw payload to an arbitrary topic. Use the typed
   * helpers above where possible.
   */
  publishRaw(
    topic: string,
    payload: string | Buffer,
    opts?: { qos?: 0 | 1 | 2; retain?: boolean },
  ): Promise<void>;
  cleanup(): Promise<void>;
}

export interface CreateMockMqttBrokerOptions {
  /** Org slug used to namespace topics. Defaults to `"default"` (matches MqttBridge default). */
  org?: string;
  /** Override the listen port. Defaults to 0 = OS-assigned free port. */
  port?: number;
}

export interface ConsultationOpenedInput {
  thread_id: string;
  subject: string;
  agent_id: string;
  target_modules?: string[];
}

export interface ThreadMessageInput {
  thread_id: string;
  agent_id: string;
  /** `comment`, `question`, `answer` — matches MqttBridge.publishMessage's `type`. */
  type: string;
  content: string;
}

export interface AgentStatusInput {
  agent_id: string;
  status: "online" | "offline";
  /** Display name. Present on `online`, omitted on `offline` (matches MqttBridge). */
  name?: string;
}

/**
 * Boot an in-process aedes broker on a free TCP port, return a publisher
 * client + topic-aware helpers. Anonymous CONNECTs are allowed — the
 * channel-mode subscriber and our publisher both connect without auth, just
 * like a Phase 1 deployment with `COORDINATOR_AUTH_ENABLED=false`.
 */
export async function createMockMqttBroker(
  opts: CreateMockMqttBrokerOptions = {},
): Promise<MockMqttBroker> {
  const org = opts.org ?? "default";

  const broker = await Aedes.createBroker({});
  const tcpServer: NetServer = createTcpServer((socket) => {
    broker.handle(socket as unknown as Parameters<typeof broker.handle>[0]);
  });

  const port = await new Promise<number>((resolve, reject) => {
    tcpServer.once("error", reject);
    tcpServer.listen(opts.port ?? 0, "127.0.0.1", () => {
      tcpServer.off("error", reject);
      const addr = tcpServer.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("mock-mqtt-broker: could not resolve listen port"));
        return;
      }
      resolve(addr.port);
    });
  });
  const url = `mqtt://127.0.0.1:${port}`;

  const publisher = mqtt.connect(url, {
    clientId: `channel-harness-publisher-${Date.now()}`,
    reconnectPeriod: 0,
    // Fast-fail on connect errors so a misconfigured test doesn't hang.
    connectTimeout: 3000,
  });
  await new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      publisher.off("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      publisher.off("connect", onConnect);
      reject(err);
    };
    publisher.once("connect", onConnect);
    publisher.once("error", onError);
  });

  const publish = (
    topic: string,
    payload: string | Buffer,
    publishOpts: { qos?: 0 | 1 | 2; retain?: boolean } = {},
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      publisher.publish(topic, payload, publishOpts, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

  return {
    url,
    port,
    publisher,
    publishConsultationOpened: (input) =>
      publish(
        `coordinator/${org}/consultations/new`,
        JSON.stringify({
          thread_id: input.thread_id,
          agent_id: input.agent_id,
          subject: input.subject,
          target_modules: input.target_modules ?? [],
        }),
        // Matches the real bridge: QoS 1 + retain so a late-subscribing channel
        // mode still receives the most-recent "new" event.
        { qos: 1, retain: true },
      ),
    publishThreadMessage: (input) =>
      publish(
        `coordinator/${org}/consultations/${input.thread_id}/messages`,
        JSON.stringify({
          agent_id: input.agent_id,
          type: input.type,
          content: input.content,
        }),
        // Matches the real bridge: QoS 0, no retain.
      ),
    publishAgentStatus: (input) => {
      const payload =
        input.status === "online"
          ? JSON.stringify({ status: "online", name: input.name ?? input.agent_id })
          : JSON.stringify({ status: "offline" });
      return publish(
        `coordinator/${org}/agents/${input.agent_id}/status`,
        payload,
        // Retained: the bridge keeps the latest agent status retained so new
        // subscribers see who's online without waiting for the next heartbeat.
        { retain: true },
      );
    },
    publishRaw: (topic, payload, publishOpts) => publish(topic, payload, publishOpts ?? {}),
    cleanup: async () => {
      try {
        await publisher.endAsync();
      } catch {
        // Already disconnected; ignore.
      }
      await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    },
  };
}
