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
  private orgId: string;
  private client: mqtt.MqttClient | null = null;
  private connected = false;
  private onOfflineHandler: ((agentId: string) => void) | null = null;
  private listeners = new Map<string, AgentListener>();
  private log: Logger;
  private agentId: string = "coordinator-internal";
  /**
   * P1: track the last threadId we retained on `coordinator/<orgId>/consultations/new`.
   * The topic is fixed (not per-thread), so retain holds only the LAST event.
   * `clearRetainedConsultation(threadId)` only clears when it matches, so a
   * later consultation isn't accidentally wiped by a stale resolve callback.
   */
  private lastRetainedConsultationThreadId: string | null = null;

  constructor(orgId: string, logger?: Logger) {
    this.orgId = orgId;
    this.log = logger ?? silentLogger;
  }

  async connect(config: { url: string; username?: string; password?: string; agentId?: string }): Promise<void> {
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
        will: {
          topic: `coordinator/${this.orgId}/agents/${this.agentId}/status`,
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
        this.client!.subscribe(`coordinator/${this.orgId}/agents/+/status`);
        this.client!.subscribe(`coordinator/${this.orgId}/consultations/#`);
        this.client!.subscribe(`coordinator/${this.orgId}/broadcast`);
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
        // Topic: coordinator/<orgId>/agents/<agentId>/status → parts[2]="agents", parts[3]=agentId, parts[4]="status"
        if (parts[2] === "agents" && parts[4] === "status") {
          const agentId = parts[3];
          const status = message.toString();
          if (status === "offline") {
            // performance-05: remove the departed agent's listener + queue
            // here, inside the bridge itself, so cleanup doesn't depend on
            // a caller having wired onOffline — an offline agent's backlog
            // is dead weight the instant it goes offline.
            this.removeListener(agentId);
            if (this.onOfflineHandler) {
              this.onOfflineHandler(agentId);
            }
          }
        }

        // Route consultation messages to agent listeners
        // Topic: coordinator/<orgId>/consultations/... or coordinator/<orgId>/broadcast
        if (parts[2] === "consultations" || parts[2] === "broadcast") {
          try {
            const payload = JSON.parse(message.toString());
            const msg: QueuedMessage = { topic, payload, timestamp: Date.now() };
            for (const listener of this.listeners.values()) {
              if (listener.waitResolve) {
                const resolve = listener.waitResolve;
                listener.waitResolve = null;
                resolve(msg);
              } else {
                // performance-05: drop-oldest once at capacity — keep the
                // freshest MAX_LISTENER_QUEUE messages, not the stalest.
                if (listener.queue.length >= MAX_LISTENER_QUEUE) {
                  listener.queue.shift();
                }
                listener.queue.push(msg);
              }
            }
          } catch { /* ignore malformed */ }
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

  onOffline(handler: (agentId: string) => void): void {
    this.onOfflineHandler = handler;
  }

  registerAgent(agentId: string, name: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `coordinator/${this.orgId}/agents/${agentId}/status`,
      JSON.stringify({ status: "online", name }),
      { retain: true }
    );
  }

  publishConsultation(threadId: string, agentId: string, subject: string, targetModules: string[]): void {
    if (!this.client || !this.connected) return;
    // P1 fix: QoS 1 (at-least-once) so consultation events survive transient
    // disconnects. retain=true so a coordinator/subscriber restart can rebuild
    // the active state without an event-history replay.
    this.lastRetainedConsultationThreadId = threadId;
    this.client.publish(
      `coordinator/${this.orgId}/consultations/new`,
      JSON.stringify({ thread_id: threadId, agent_id: agentId, subject, target_modules: targetModules }),
      { qos: 1, retain: true }
    );
  }

  /**
   * P1 fix: clear the retained `coordinator/consultations/new` event when the
   * matching thread resolves. The topic is fixed (not per-thread), so retain
   * holds only the LAST consultation — clearing here means a coordinator
   * restart after resolution doesn't re-broadcast a stale "new" event.
   *
   * No-op when the supplied threadId doesn't match the currently retained one
   * (a newer consultation has already overwritten it).
   */
  clearRetainedConsultation(threadId: string): void {
    if (!this.client || !this.connected) return;
    if (this.lastRetainedConsultationThreadId !== threadId) return;
    this.client.publish(
      `coordinator/${this.orgId}/consultations/new`,
      "",
      { qos: 1, retain: true }
    );
    this.lastRetainedConsultationThreadId = null;
  }

  publishMessage(threadId: string, agentId: string, type: string, content: string): void {
    if (!this.client || !this.connected) return;
    // QoS 0: high-frequency chat-style traffic, lossy-OK.
    this.client.publish(
      `coordinator/${this.orgId}/consultations/${threadId}/messages`,
      JSON.stringify({ agent_id: agentId, type, content })
    );
  }

  publishResolution(threadId: string, status: string, summary: string): void {
    if (!this.client || !this.connected) return;
    // P1 fix: QoS 1 (at-least-once) — resolution is a state-change event.
    this.client.publish(
      `coordinator/${this.orgId}/consultations/${threadId}/status`,
      JSON.stringify({ status, summary }),
      { qos: 1, retain: true }
    );
  }

  publishBroadcast(agentId: string, message: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `coordinator/${this.orgId}/broadcast`,
      JSON.stringify({ agent_id: agentId, message })
    );
  }

  publishAgentOffline(agentId: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `coordinator/${this.orgId}/agents/${agentId}/status`,
      JSON.stringify({ status: "offline" }),
      { retain: true }
    );
  }

  publishTaskClaimed(threadId: string, claimedBy: string): void {
    if (!this.client || !this.connected) return;
    // P1 fix: QoS 1 — claim is a coordination state-change. Loss would mean
    // multiple agents think a task is unclaimed.
    this.client.publish(
      `coordinator/${this.orgId}/consultations/${threadId}/claimed`,
      JSON.stringify({ agent_id: claimedBy, claimed_by: claimedBy, claimed_at: new Date().toISOString() }),
      { qos: 1 }
    );
  }

  publishTaskCompleted(threadId: string, completedBy: string, summary: string): void {
    if (!this.client || !this.connected) return;
    // P1 fix: QoS 1 — completion is a coordination state-change.
    this.client.publish(
      `coordinator/${this.orgId}/consultations/${threadId}/completed`,
      JSON.stringify({ agent_id: completedBy, completed_by: completedBy, summary }),
      { qos: 1 }
    );
  }

  /**
   * Fanout a refreshed QuotaInfo to live subscribers (dashboard widget,
   * scheduled-agent runners, anything wanting realtime quota pressure).
   * Typed via `unknown` to avoid an import cycle with the quota module.
   */
  publishQuotaUpdate(info: unknown): void {
    if (!this.client || !this.connected) return;
    // QoS 0: high-frequency telemetry, lossy-OK (the next refresh overwrites).
    this.client.publish(`coordinator/${this.orgId}/quota/update`, JSON.stringify(info));
  }

  // ── Agent listener methods (for integrated MCP tools) ──

  registerListener(agentId: string): void {
    if (!this.listeners.has(agentId)) {
      this.listeners.set(agentId, { queue: [], waitResolve: null });
    }
  }

  removeListener(agentId: string): void {
    const listener = this.listeners.get(agentId);
    if (listener?.waitResolve) {
      listener.waitResolve(null); // unblock any waiting call
    }
    this.listeners.delete(agentId);
  }

  /** Test helper: current listener count (performance-05). */
  listenerCount(): number {
    return this.listeners.size;
  }

  async waitForMessage(agentId: string, timeoutMs: number): Promise<QueuedMessage | null> {
    this.registerListener(agentId);
    const listener = this.listeners.get(agentId)!;

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

  getQueuedMessages(agentId: string): QueuedMessage[] {
    this.registerListener(agentId);
    const listener = this.listeners.get(agentId)!;
    const messages = [...listener.queue];
    listener.queue.length = 0;
    return messages;
  }

  mqttPublish(topic: string, payload: string): void {
    if (this.client && this.connected) {
      // Ensure all outbound topics are org-scoped. If caller passes an unscoped
      // topic, prepend the org prefix; if already prefixed, pass through.
      const scopedTopic = topic.startsWith(`coordinator/${this.orgId}/`)
        ? topic
        : `coordinator/${this.orgId}/${topic.replace(/^coordinator\//, "")}`;
      this.client.publish(scopedTopic, payload);
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
