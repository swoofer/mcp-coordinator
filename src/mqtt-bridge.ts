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

export class MqttBridge {
  private client: mqtt.MqttClient | null = null;
  private connected = false;
  private onOfflineHandler: ((agentId: string) => void) | null = null;
  private listeners = new Map<string, AgentListener>();
  private log: Logger;

  constructor(logger?: Logger) {
    this.log = logger || silentLogger;
  }

  async connect(config: { url: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("MQTT connection timeout"));
      }, 5000);

      this.client = mqtt.connect(config.url, {
        clientId: `coordinator-${Date.now()}`,
        clean: true,
      });

      this.client.on("connect", () => {
        clearTimeout(timeout);
        this.connected = true;
        this.log.info({ url: config.url }, "MQTT connected");

        // Subscribe to agent status for LWT detection
        this.client!.subscribe("coordinator/agents/+/status");
        resolve();
      });

      // Subscribe to consultation topics for agent listeners
      this.client!.subscribe("coordinator/consultations/#");
      this.client!.subscribe("coordinator/broadcast");

      this.client.on("message", (topic, message) => {
        const parts = topic.split("/");
        if (parts[1] === "agents" && parts[3] === "status") {
          const agentId = parts[2];
          const status = message.toString();
          if (status === "offline" && this.onOfflineHandler) {
            this.onOfflineHandler(agentId);
          }
        }

        // Route consultation messages to agent listeners
        if (parts[1] === "consultations" || parts[1] === "broadcast") {
          try {
            const payload = JSON.parse(message.toString());
            const msg: QueuedMessage = { topic, payload, timestamp: Date.now() };
            for (const listener of this.listeners.values()) {
              if (listener.waitResolve) {
                const resolve = listener.waitResolve;
                listener.waitResolve = null;
                resolve(msg);
              } else {
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
      `coordinator/agents/${agentId}/status`,
      JSON.stringify({ status: "online", name }),
      { retain: true }
    );
  }

  publishConsultation(threadId: string, agentId: string, subject: string, targetModules: string[]): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      "coordinator/consultations/new",
      JSON.stringify({ thread_id: threadId, agent_id: agentId, subject, target_modules: targetModules })
    );
  }

  publishMessage(threadId: string, agentId: string, type: string, content: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `coordinator/consultations/${threadId}/messages`,
      JSON.stringify({ agent_id: agentId, type, content })
    );
  }

  publishResolution(threadId: string, status: string, summary: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `coordinator/consultations/${threadId}/status`,
      JSON.stringify({ status, summary }),
      { retain: true }
    );
  }

  publishBroadcast(agentId: string, message: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      "coordinator/broadcast",
      JSON.stringify({ agent_id: agentId, message })
    );
  }

  publishAgentOffline(agentId: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `coordinator/agents/${agentId}/status`,
      JSON.stringify({ status: "offline" }),
      { retain: true }
    );
  }

  publishTaskClaimed(threadId: string, claimedBy: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `coordinator/consultations/${threadId}/claimed`,
      JSON.stringify({ agent_id: claimedBy, claimed_by: claimedBy, claimed_at: new Date().toISOString() })
    );
  }

  publishTaskCompleted(threadId: string, completedBy: string, summary: string): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `coordinator/consultations/${threadId}/completed`,
      JSON.stringify({ agent_id: completedBy, completed_by: completedBy, summary })
    );
  }

  /**
   * Fanout a refreshed QuotaInfo to live subscribers (dashboard widget,
   * scheduled-agent runners, anything wanting realtime quota pressure).
   * Typed via `unknown` to avoid an import cycle with the quota module.
   */
  publishQuotaUpdate(info: unknown): void {
    if (!this.client || !this.connected) return;
    this.client.publish("coordinator/quota/update", JSON.stringify(info));
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
      this.client.publish(topic, payload);
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
