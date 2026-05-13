/**
 * Prometheus /metrics endpoint for mcp-coordinator (v0.4 Operability fix).
 *
 * Audit gap: README claims "Production-ready" but only exposed /health stub.
 * This module wires prom-client counters/gauges keyed off the events that
 * already flow through the coordinator (announces, resolutions, MQTT
 * publishes, REST requests, auth rejections) plus a snapshot of the live
 * system state (agents, threads, MQTT listeners, SSE clients).
 *
 * Design notes:
 *  - Uses a per-instance `Registry` (not the global default registry) so that
 *    multiple Coordinator instances in the same process (essaim's orchestrator
 *    pattern) get isolated metric counters instead of cross-contaminating.
 *  - Gauges are pulled lazily from a `services` snapshot at scrape time via
 *    `gaugeSnapshot()` â€” cheaper than maintaining mirror state and guarantees
 *    the value matches the DB (no drift from missed events).
 *  - SSE clients and MQTT listeners aren't exposed as public counts on those
 *    classes today. Callers update those gauges directly via `setSseClients`
 *    / `setMqttListeners` from the request lifecycle (see integration patch).
 */
import type { IncomingMessage, ServerResponse } from "http";
import {
  Registry,
  Counter,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";
import type { CoordinatorServices } from "./server-setup.js";
import { getDb } from "./database.js";

export type AnnounceResult = "thread_opened" | "auto_resolved";
export type ResolutionType =
  | "consensus"
  | "timeout"
  | "auto_resolved"
  | "agent_departure"
  | "max_rounds"
  | "closed";

export interface MetricsOptions {
  /**
   * If true, also collect Node.js process metrics (CPU, memory, event-loop
   * lag, etc.) via prom-client's collectDefaultMetrics. Default: true.
   */
  collectDefault?: boolean;
}

export class Metrics {
  readonly registry: Registry;

  // Counters
  readonly announces: Counter<"result">;
  readonly threadsResolved: Counter<"type">;
  readonly mqttPublishes: Counter<string>;
  readonly httpRequests: Counter<"route" | "status">;
  readonly authRejected: Counter<string>;

  // Gauges
  readonly agentsOnline: Gauge<string>;
  readonly threadsOpen: Gauge<string>;
  readonly threadsResolving: Gauge<string>;
  readonly mqttListenersActive: Gauge<string>;
  readonly sseClientsActive: Gauge<string>;
  readonly workingFilesActive: Gauge<string>;
  readonly gitCochangePairs: Gauge<string>;

  // v0.6 counters
  readonly workingFilesStarts: Counter<"result">;
  readonly treeSitterParseFailures: Counter<string>;
  readonly gitCochangeBuilds: Counter<"outcome">;

  constructor(opts: MetricsOptions = {}) {
    this.registry = new Registry();

    if (opts.collectDefault !== false) {
      collectDefaultMetrics({ register: this.registry });
    }

    this.announces = new Counter({
      name: "mcp_coordinator_announces_total",
      help: "Total announce_work calls, partitioned by outcome",
      labelNames: ["result"] as const,
      registers: [this.registry],
    });

    this.threadsResolved = new Counter({
      name: "mcp_coordinator_threads_resolved_total",
      help: "Total threads resolved, partitioned by resolution type",
      labelNames: ["type"] as const,
      registers: [this.registry],
    });

    this.mqttPublishes = new Counter({
      name: "mcp_coordinator_mqtt_publishes_total",
      help: "Total MQTT publishes by the coordinator bridge",
      registers: [this.registry],
    });

    this.httpRequests = new Counter({
      name: "mcp_coordinator_http_requests_total",
      help: "Total HTTP requests handled, partitioned by route + status",
      labelNames: ["route", "status"] as const,
      registers: [this.registry],
    });

    this.authRejected = new Counter({
      name: "mcp_coordinator_auth_rejected_total",
      help: "Total authentication rejections",
      registers: [this.registry],
    });

    this.agentsOnline = new Gauge({
      name: "mcp_coordinator_agents_online",
      help: "Current number of agents reporting status=online",
      registers: [this.registry],
    });

    this.threadsOpen = new Gauge({
      name: "mcp_coordinator_threads_open",
      help: "Current number of threads in status=open",
      registers: [this.registry],
    });

    this.threadsResolving = new Gauge({
      name: "mcp_coordinator_threads_resolving",
      help: "Current number of threads in status=resolving",
      registers: [this.registry],
    });

    this.mqttListenersActive = new Gauge({
      name: "mcp_coordinator_mqtt_listeners_active",
      help: "Current number of registered MQTT consultation listeners",
      registers: [this.registry],
    });

    this.sseClientsActive = new Gauge({
      name: "mcp_coordinator_sse_clients_active",
      help: "Current number of connected SSE clients",
      registers: [this.registry],
    });

    this.workingFilesActive = new Gauge({
      name: "mcp_coordinator_working_files_active",
      help: "Current working_files row count",
      registers: [this.registry],
    });

    this.workingFilesStarts = new Counter({
      name: "mcp_coordinator_working_files_starts_total",
      help: "Total working_files start calls",
      labelNames: ["result"] as const,
      registers: [this.registry],
    });

    this.treeSitterParseFailures = new Counter({
      name: "mcp_coordinator_tree_sitter_parse_failures_total",
      help: "Tree-sitter parse failures",
      registers: [this.registry],
    });

    this.gitCochangeBuilds = new Counter({
      name: "mcp_coordinator_git_cochange_builds_total",
      help: "git_cochange build attempts",
      labelNames: ["outcome"] as const,
      registers: [this.registry],
    });

    this.gitCochangePairs = new Gauge({
      name: "mcp_coordinator_git_cochange_pairs_total",
      help: "Current git_cochange row count",
      registers: [this.registry],
    });
  }

  // ── Counter helpers (named methods make hook points obvious) ──

  recordAnnounce(result: AnnounceResult): void {
    this.announces.inc({ result }, 1);
  }

  recordThreadResolved(type: ResolutionType): void {
    this.threadsResolved.inc({ type }, 1);
  }

  recordMqttPublish(): void {
    this.mqttPublishes.inc(1);
  }

  recordHttpRequest(route: string, status: number): void {
    this.httpRequests.inc({ route, status: String(status) }, 1);
  }

  recordAuthRejected(): void {
    this.authRejected.inc(1);
  }

  // ── Gauge setters (called from request lifecycle, see integration patch) ──

  setSseClients(n: number): void {
    this.sseClientsActive.set(n);
  }

  incSseClients(): void {
    this.sseClientsActive.inc(1);
  }

  decSseClients(): void {
    this.sseClientsActive.dec(1);
  }

  setMqttListeners(n: number): void {
    this.mqttListenersActive.set(n);
  }

  /**
   * Snapshot the gauges that derive from durable state (agents/threads).
   * Called at scrape time so the values are fresh without us having to mirror
   * every state transition. Safe to call repeatedly.
   *
   * Reads via the DB directly because AgentRegistry/Consultation don't yet
   * expose count getters â€” adding them would touch unrelated modules.
   */
  gaugeSnapshot(services: CoordinatorServices): void {
    try {
      // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
      this.agentsOnline.set(services.registry.listOnline("default").length);
    } catch {
      // Registry not initialised yet (test bootstrap race) â€” leave gauge at 0.
    }

    try {
      const db = getDb();
      const open = db
        .prepare("SELECT COUNT(*) as c FROM threads WHERE status = 'open'")
        .get() as { c: number };
      const resolving = db
        .prepare("SELECT COUNT(*) as c FROM threads WHERE status = 'resolving'")
        .get() as { c: number };
      this.threadsOpen.set(open.c);
      this.threadsResolving.set(resolving.c);
    } catch {
      // DB not initialised â€” leave gauges at their last-set values.
    }
  }

  /**
   * Render the current registry as Prometheus text exposition format.
   * Returns the body string + the content-type to set on the response.
   */
  async render(): Promise<{ body: string; contentType: string }> {
    const body = await this.registry.metrics();
    return { body, contentType: this.registry.contentType };
  }
}

/**
 * HTTP handler for GET /metrics. Refreshes the derived gauges from a
 * services snapshot, then writes the prom-client text exposition.
 *
 * Wire from serve-http.ts:
 *     if (url === "/metrics" && req.method === "GET") {
 *       await serveMetrics(req, res, services, metrics);
 *       return;
 *     }
 */
export async function serveMetrics(
  _req: IncomingMessage,
  res: ServerResponse,
  services: CoordinatorServices,
  metrics: Metrics,
): Promise<void> {
  metrics.gaugeSnapshot(services);
  const { body, contentType } = await metrics.render();
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
  });
  res.end(body);
}
