import mqtt from "mqtt";
import { silentLogger, type Logger } from "./logger.js";

interface QueuedMessage {
  topic: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

interface AgentListener {
  queue: QueuedMessage[];
  waitResolve: ((msg: QueuedMessage | null) => void) | null;
}

/**
 * performance-05: cap on the per-agent queued-message backlog. An agent
 * that registers a listener (via waitForMessage/getQueuedMessages) but
 * never drains it would otherwise accumulate every consultation/broadcast
 * message forever. Once full, the oldest queued message is dropped to make
 * room for the newest — recent activity matters more than ancient backlog.
 */
const MAX_LISTENER_QUEUE = 1000;

export class MqttBridge {
  /**
   * Task 22: the bridge is a SINGLE multi-org client. `homeOrgId` is only the
   * org under which the coordinator-internal identity registers its own LWT
   * presence (`coordinator/<homeOrgId>/agents/coordinator-internal/status`).
   * All agent-facing publish/subscribe operations are org-scoped by an explicit
   * `orgId` parameter (matching the codebase idiom where every service method
   * takes orgId as its first argument), NOT by this field.
   */
  private homeOrgId: string;
  private client: mqtt.MqttClient | null = null;
  private connected = false;
  private onOfflineHandler: ((orgId: string, agentId: string) => void) | null = null;
  /**
   * Task 22: listeners are nested `Map<orgId, Map<agentId, AgentListener>>`
   * so consultation fan-out never crosses org boundaries. The wildcard
   * subscription below means this bridge sees every org's traffic; delivery
   * MUST filter by org or an agent in org A would receive org B's
   * consultation messages. Nesting by orgId (rather than a single map keyed
   * by a joined `orgId+agentId` string) also makes "every listener in this
   * org" a direct lookup instead of a string-prefix scan, so there is no
   * delimiter for an unrestricted agentId to collide with.
   */
  private listeners = new Map<string, Map<string, AgentListener>>();
  private log: Logger;
  private agentId: string = "coordinator-internal";
  /**
   * P1: track the last threadId we retained on `coordinator/<orgId>/consultations/new`.
   * The topic is fixed per-org (not per-thread), so retain holds only the LAST
   * event for that org. `clearRetainedConsultation(orgId, threadId)` only clears
   * when it matches, so a later consultation isn't accidentally wiped by a stale
   * resolve callback. Task 22: keyed per-org (one retained slot per org).
   */
  private lastRetainedConsultationThreadId = new Map<string, string>();

  /**
   * issue #236: notified whenever an inbound message is discarded. Kept as an
   * optional callback rather than a metrics dependency so the bridge stays
   * decoupled from prom-client; serve-http wires it to a counter.
   */
  private onDropHandler: ((reason: string) => void) | null = null;

  constructor(homeOrgId: string, logger?: Logger) {
    this.homeOrgId = homeOrgId;
    this.log = logger ?? silentLogger;
  }

  /** Register a sink for discarded-message reasons (issue #236). */
  onDrop(handler: (reason: string) => void): void {
    this.onDropHandler = handler;
  }

  /**
   * Record a dropped inbound message: one warn line plus the counter.
   *
   * Warn, not error: a drop is usually a misconfigured publisher rather than a
   * coordinator fault, and it must not drown a busy log — so the topic is
   * included but the payload never is (it can carry consultation content).
   */
  private recordDrop(reason: string, topic: string, extra?: Record<string, unknown>): void {
    this.log.warn({ reason, topic, ...extra }, "MQTT message dropped");
    this.onDropHandler?.(reason);
  }

  /** Get (or lazily create) the inner agentId->listener map for one org. */
  private orgListeners(orgId: string): Map<string, AgentListener> {
    let inner = this.listeners.get(orgId);
    if (!inner) {
      inner = new Map();
      this.listeners.set(orgId, inner);
    }
    return inner;
  }

  async connect(config: {
    url: string;
    username?: string;
    password?: string;
    agentId?: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("MQTT connection timeout"));
      }, 5000);

      // P1 fix: LWT requires a stable agent identifier. Default to
      // "coordinator-internal" which matches the auth identity used by
      // serve-http for the embedded broker bridge.
      this.agentId = config.agentId || "coordinator-internal";

      this.client = mqtt.connect(config.url, {
        clientId: `${this.agentId}-${Date.now()}`,
        clean: true,
        username: config.username,
        password: config.password,
        // P1 fix: register Last Will & Testament so a crashed/disconnected
        // bridge automatically broadcasts offline status. Without this the
        // agent appears online indefinitely after an unexpected disconnect.
        // Task 22: the coordinator-internal identity lives under homeOrgId.
        will: {
          topic: `coordinator/${this.homeOrgId}/agents/${this.agentId}/status`,
          payload: Buffer.from(JSON.stringify({ status: "offline", reason: "lwt_unexpected" })),
          qos: 1,
          retain: false,
        },
      });

      this.client.on("connect", () => {
        clearTimeout(timeout);
        this.connected = true;
        this.log.info({ url: config.url }, "MQTT connected");

        // All SUBSCRIBE packets must be sent AFTER CONNACK or the broker may
        // silently drop them under clean:true sessions. Keep the three
        // subscribes co-located inside this handler.
        // Task 22: subscribe across ALL orgs (`coordinator/+/...`) so a single
        // bridge serves every tenant. The real org is recovered from the topic
        // prefix (parts[1]) in the message handler below.
        this.client!.subscribe(`coordinator/+/agents/+/status`);
        this.client!.subscribe(`coordinator/+/consultations/#`);
        this.client!.subscribe(`coordinator/+/broadcast`);
        resolve();
      });

      // protocole-mcp-06 follow-up (found via tests-06): mqtt.js emits "close"
      // and "offline" when the connection drops. Without resetting `connected`,
      // isConnected() keeps reporting true through the whole outage window, so
      // the MQTT tool guards (mqtt-tools.ts) would falsely report success while
      // publishes silently no-op. mqtt.js auto-reconnects and fires "connect"
      // again (which re-sets `connected` and re-subscribes above).
      this.client.on("close", () => {
        this.connected = false;
      });
      this.client.on("offline", () => {
        this.connected = false;
      });

      this.client.on("message", (topic, message) => {
        const parts = topic.split("/");
        // Topic: coordinator/<orgId>/... → parts[1] = orgId (Task 22).
        const orgId = parts[1];
        if (!orgId) return;

        // Topic: coordinator/<orgId>/agents/<agentId>/status → parts[2]="agents", parts[3]=agentId, parts[4]="status"
        if (parts[2] === "agents" && parts[4] === "status") {
          const agentId = parts[3];
          // Presence payloads are JSON ({status:"online"|"offline", ...}) — from
          // registerAgent/publishAgentOffline and the LWT. Parse the JSON status;
          // fall back to the raw string for older/raw clients that publish a bare
          // "offline". Without this the offline branch never fired for the
          // coordinator's own JSON offline/LWT messages.
          let status = message.toString();
          try {
            const parsed = JSON.parse(status);
            if (parsed && typeof parsed.status === "string") status = parsed.status;
          } catch {
            /* not JSON — treat the payload as the raw status string */
          }
          if (status === "offline") {
            // performance-05: remove the departed agent's listener + queue
            // here, inside the bridge itself, so cleanup doesn't depend on
            // a caller having wired onOffline — an offline agent's backlog
            // is dead weight the instant it goes offline. Task 22: threaded
            // with the org recovered from the topic prefix so cleanup never
            // crosses tenants.
            this.removeListener(orgId, agentId);
            if (this.onOfflineHandler) {
              // Task 22: thread the real org from the topic prefix instead of
              // the hard-coded "default" so setOffline/SSE target the right
              // tenant.
              this.onOfflineHandler(orgId, agentId);
            }
          }
        }

        // Route consultation messages to agent listeners.
        // Topic: coordinator/<orgId>/consultations/... or coordinator/<orgId>/broadcast
        if (parts[2] === "consultations" || parts[2] === "broadcast") {
          try {
            const payload = JSON.parse(message.toString());
            const msg: QueuedMessage = { topic, payload, timestamp: Date.now() };
            // Nobody is listening for this org: the message is accepted off the
            // wire and then goes nowhere. Silent until #236.
            if (this.orgListeners(orgId).size === 0) {
              this.recordDrop("no_listener", topic, { org: orgId });
            }
            // Task 22: deliver ONLY to listeners of the same org. Without this
            // filter the wildcard subscription would leak org B's consultation
            // traffic into org A's listeners.
            for (const listener of this.orgListeners(orgId).values()) {
              if (listener.waitResolve) {
                const resolveListener = listener.waitResolve;
                listener.waitResolve = null;
                resolveListener(msg);
              } else {
                // performance-05: drop-oldest once at capacity — keep the
                // freshest MAX_LISTENER_QUEUE messages, not the stalest.
                if (listener.queue.length >= MAX_LISTENER_QUEUE) {
                  listener.queue.shift();
                  this.recordDrop("queue_full", topic, {
                    org: orgId,
                    cap: MAX_LISTENER_QUEUE,
                  });
                }
                listener.queue.push(msg);
              }
            }
          } catch {
            // Non-JSON payload on a consultations/broadcast topic. Previously
            // swallowed entirely, so a publisher sending the wrong shape got a
            // "published" acknowledgement and no delivery, with nothing in the
            // log to explain it.
            this.recordDrop("malformed_payload", topic, { org: orgId });
          }
        }
      });

      this.client.on("error", (err) => {
        clearTimeout(timeout);
        this.log.error({ err }, "MQTT error");
        reject(err);
      });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  onOffline(handler: (orgId: string, agentId: string) => void): void {
    this.onOfflineHandler = handler;
  }

  registerAgent(orgId: string, agentId: string, name: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `coordinator/${orgId}/agents/${agentId}/status`,
      JSON.stringify({ status: "online", name }),
      { retain: true },
    );
  }

  publishConsultation(
    orgId: string,
    threadId: string,
    agentId: string,
    subject: string,
    targetModules: string[],
  ): void {
    if (!this.client || !this.connected) return;
    // P1 fix: QoS 1 (at-least-once) so consultation events survive transient
    // disconnects. retain=true so a coordinator/subscriber restart can rebuild
    // the active state without an event-history replay.
    this.lastRetainedConsultationThreadId.set(orgId, threadId);
    this.client.publish(
      `coordinator/${orgId}/consultations/new`,
      JSON.stringify({
        thread_id: threadId,
        agent_id: agentId,
        subject,
        target_modules: targetModules,
      }),
      { qos: 1, retain: true },
    );
  }

  /**
   * P1 fix: clear the retained `coordinator/<orgId>/consultations/new` event when
   * the matching thread resolves. The topic is fixed per-org (not per-thread), so
   * retain holds only the LAST consultation for that org — clearing here means a
   * coordinator restart after resolution doesn't re-broadcast a stale "new" event.
   *
   * No-op when the supplied threadId doesn't match the currently retained one for
   * that org (a newer consultation has already overwritten it).
   */
  clearRetainedConsultation(orgId: string, threadId: string): void {
    if (!this.client || !this.connected) return;
    if (this.lastRetainedConsultationThreadId.get(orgId) !== threadId) return;
    this.client.publish(`coordinator/${orgId}/consultations/new`, "", {
      qos: 1,
      retain: true,
    });
    this.lastRetainedConsultationThreadId.delete(orgId);
  }

  publishMessage(
    orgId: string,
    threadId: string,
    agentId: string,
    type: string,
    content: string,
  ): void {
    if (!this.client || !this.connected) return;
    // QoS 0: high-frequency chat-style traffic, lossy-OK.
    this.client.publish(
      `coordinator/${orgId}/consultations/${threadId}/messages`,
      JSON.stringify({ agent_id: agentId, type, content }),
    );
  }

  publishResolution(orgId: string, threadId: string, status: string, summary: string): void {
    if (!this.client || !this.connected) return;
    // P1 fix: QoS 1 (at-least-once) — resolution is a state-change event.
    this.client.publish(
      `coordinator/${orgId}/consultations/${threadId}/status`,
      JSON.stringify({ status, summary }),
      { qos: 1, retain: true },
    );
  }

  publishBroadcast(orgId: string, agentId: string, message: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `coordinator/${orgId}/broadcast`,
      JSON.stringify({ agent_id: agentId, message }),
    );
  }

  publishAgentOffline(orgId: string, agentId: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `coordinator/${orgId}/agents/${agentId}/status`,
      JSON.stringify({ status: "offline" }),
      { retain: true },
    );
  }

  publishTaskClaimed(orgId: string, threadId: string, claimedBy: string): void {
    if (!this.client || !this.connected) return;
    // P1 fix: QoS 1 — claim is a coordination state-change. Loss would mean
    // multiple agents think a task is unclaimed.
    this.client.publish(
      `coordinator/${orgId}/consultations/${threadId}/claimed`,
      JSON.stringify({
        agent_id: claimedBy,
        claimed_by: claimedBy,
        claimed_at: new Date().toISOString(),
      }),
      { qos: 1 },
    );
  }

  publishTaskCompleted(
    orgId: string,
    threadId: string,
    completedBy: string,
    summary: string,
  ): void {
    if (!this.client || !this.connected) return;
    // P1 fix: QoS 1 — completion is a coordination state-change.
    this.client.publish(
      `coordinator/${orgId}/consultations/${threadId}/completed`,
      JSON.stringify({ agent_id: completedBy, completed_by: completedBy, summary }),
      { qos: 1 },
    );
  }

  /**
   * Fanout a refreshed QuotaInfo to live subscribers (dashboard widget,
   * scheduled-agent runners, anything wanting realtime quota pressure).
   * Typed via `unknown` to avoid an import cycle with the quota module.
   *
   * Quota is intentionally GLOBAL (account-level billing pressure), not per-org,
   * so it publishes under homeOrgId. Per-org quota is a separate Phase 5 concern.
   */
  publishQuotaUpdate(info: unknown): void {
    if (!this.client || !this.connected) return;
    // QoS 0: high-frequency telemetry, lossy-OK (the next refresh overwrites).
    this.client.publish(`coordinator/${this.homeOrgId}/quota/update`, JSON.stringify(info));
  }

  // ── Agent listener methods (for integrated MCP tools) ──

  registerListener(orgId: string, agentId: string): void {
    const inner = this.orgListeners(orgId);
    if (!inner.has(agentId)) {
      inner.set(agentId, { queue: [], waitResolve: null });
    }
  }

  removeListener(orgId: string, agentId: string): void {
    const inner = this.listeners.get(orgId);
    const listener = inner?.get(agentId);
    if (listener?.waitResolve) {
      listener.waitResolve(null); // unblock any waiting call
    }
    inner?.delete(agentId);
  }

  /** Test helper: current listener count (performance-05). */
  listenerCount(): number {
    let count = 0;
    for (const inner of this.listeners.values()) count += inner.size;
    return count;
  }

  /**
   * issue #357: how many messages are still queued for one agent.
   *
   * Read-only on purpose. waitForMessage and getQueuedMessages both call
   * registerListener, so asking either of them how deep the queue is would
   * create a listener as a side effect of an observation -- and
   * getQueuedMessages would also drain it. This one does neither: an agent
   * with no listener has nothing queued, which is the honest answer.
   */
  queueDepth(orgId: string, agentId: string): number {
    return this.listeners.get(orgId)?.get(agentId)?.queue.length ?? 0;
  }

  async waitForMessage(
    orgId: string,
    agentId: string,
    timeoutMs: number,
  ): Promise<QueuedMessage | null> {
    this.registerListener(orgId, agentId);
    const listener = this.orgListeners(orgId).get(agentId)!;

    // Check queue first
    if (listener.queue.length > 0) {
      return listener.queue.shift()!;
    }

    // Block until message or timeout
    return new Promise<QueuedMessage | null>((resolve) => {
      listener.waitResolve = resolve;
      setTimeout(() => {
        if (listener.waitResolve === resolve) {
          listener.waitResolve = null;
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  getQueuedMessages(orgId: string, agentId: string): QueuedMessage[] {
    this.registerListener(orgId, agentId);
    const listener = this.orgListeners(orgId).get(agentId)!;
    const messages = [...listener.queue];
    listener.queue.length = 0;
    return messages;
  }

  mqttPublish(orgId: string, topic: string, payload: string): void {
    if (this.client && this.connected) {
      // Task 22: force every outbound topic into the caller's org namespace. An
      // unscoped topic is prefixed with the caller's org; a topic already scoped
      // to a DIFFERENT org is re-homed into the caller's org so a token can never
      // publish outside its tenant. A topic already correctly scoped passes through.
      const orgPrefix = `coordinator/${orgId}/`;
      let scopedTopic: string;
      if (topic.startsWith(orgPrefix)) {
        scopedTopic = topic;
      } else {
        scopedTopic = `${orgPrefix}${topic.replace(/^coordinator\/[^/]+\//, "").replace(/^coordinator\//, "")}`;
      }
      // issue #236: the bridge only subscribes to three patterns —
      // agents/+/status, consultations/#, broadcast. A topic outside those is
      // published to the broker and then received by nobody, while the caller
      // gets an unconditional "published". Nothing arrives at the message
      // handler, so this is the only place the dead end is knowable.
      const rest = scopedTopic.slice(orgPrefix.length);
      const routable =
        rest === "broadcast" ||
        rest.startsWith("consultations/") ||
        /^agents\/[^/]+\/status$/.test(rest);
      if (!routable) {
        this.recordDrop("unroutable_topic", scopedTopic, { org: orgId });
      }
      // QoS 1 to match the other coordination publishers: at-least-once, so a
      // reconnecting subscriber does not miss the event outright.
      this.client.publish(scopedTopic, payload, { qos: 1 });
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.log.info("MQTT disconnected");
      this.connected = false;
      await this.client.endAsync();
    }
  }
}
