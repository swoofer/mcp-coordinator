import type { IncomingMessage, ServerResponse } from "http";
import type { CoordinatorServices } from "../server-setup.js";
import { getDb } from "../database.js";
import { json } from "./utils.js";
import { getVersion } from "../version.js";

/**
 * v0.4 Operability: Kubernetes-style health probes.
 *
 * - /livez   → is the process alive? Used by an orchestrator (k8s, systemd,
 *             docker swarm) to decide whether to restart the pod. MUST NOT
 *             check downstream deps; an unreachable DB does not mean the
 *             coordinator process should be killed and restarted.
 *
 * - /readyz  → are downstream deps ready? Used by a load balancer / service
 *             mesh to decide whether to add this pod to rotation. Returns 503
 *             when the DB or MQTT broker is not reachable so the LB drains
 *             traffic until the coordinator can actually serve it.
 *
 * - /health  → backwards-compat alias for /livez. The original stub returned
 *             {status:"ok",version} unconditionally; preserving alive-only
 *             semantics keeps existing dashboards and uptime probes green
 *             without forcing them to migrate.
 */

const STARTED_AT_MS = Date.now();

interface ReadinessChecks {
  db: { ok: boolean; error?: string };
  mqtt: { ok: boolean; error?: string };
  tree_sitter: {
    ok: boolean;
    grammars_loaded: number;
    total_grammars: number;
    optional: true;
    error?: string;
  };
  git_cochange: {
    available: boolean;
    status: string;
    last_error: string | null;
    scheduler_circuit_open: boolean;
    optional: true;
  };
}

const VERSION = getVersion();

function uptimeSeconds(): number {
  return Math.floor((Date.now() - STARTED_AT_MS) / 1000);
}

/**
 * Liveness probe — process is alive. Always returns 200 with no dep checks
 * so orchestrators don't restart the pod over transient downstream failures.
 */
export function handleLivez(_req: IncomingMessage, res: ServerResponse): void {
  json(res, {
    status: "alive",
    uptime_seconds: uptimeSeconds(),
    version: VERSION,
  });
}

/**
 * Readiness probe — downstream deps must all be green for the LB to route
 * traffic here. 503 when any check fails so the pod is drained until ready.
 *
 * Each check is wrapped in try/catch so a thrown DB/MQTT error becomes a
 * structured `{ok:false,error:"…"}` instead of a 500. The response shape is
 * identical between 200 and 503 so consumers can parse uniformly.
 */
export function handleReadyz(
  _req: IncomingMessage,
  res: ServerResponse,
  services: Pick<CoordinatorServices, "mqttBridge" | "treeSitter" | "gitCochange">,
): void {
  const checks: ReadinessChecks = {
    db: { ok: false },
    mqtt: { ok: false },
    tree_sitter: { ok: false, grammars_loaded: 0, total_grammars: 7, optional: true },
    git_cochange: {
      available: false,
      status: "unavailable",
      last_error: null,
      scheduler_circuit_open: false,
      optional: true,
    },
  };

  try {
    // Cheapest possible round-trip that exercises the connection without
    // touching application tables. Throws if the handle is closed or the
    // file is locked beyond busy_timeout.
    getDb().prepare("SELECT 1").get();
    checks.db.ok = true;
  } catch (err) {
    checks.db.error = (err as Error).message;
  }

  try {
    if (services.mqttBridge.isConnected()) {
      checks.mqtt.ok = true;
    } else {
      checks.mqtt.error = "not connected";
    }
  } catch (err) {
    checks.mqtt.error = (err as Error).message;
  }

  // Optional: tree-sitter status (does NOT gate readiness — Layer 0.5 degrades gracefully)
  try {
    if (services.treeSitter) {
      checks.tree_sitter = services.treeSitter.status();
    }
  } catch {
    // keep default { ok: false, grammars_loaded: 0, total_grammars: 7, optional: true }
  }

  // Optional: git_cochange availability (does NOT gate readiness — Layer 4 degrades gracefully)
  try {
    // #368: last_error was written on every failure path and read by nobody.
    // It is the only place the *reason* survives -- `status` says the layer is
    // down, this says why -- so it is reported next to it rather than deleted.
    const rows = getDb()
      .prepare(
        "SELECT k, v FROM git_cochange_meta WHERE org_id = ? AND k IN ('available', 'last_error')",
      )
      .all("default") as Array<{ k: string; v: string }>;
    const meta = new Map(rows.map((r) => [r.k, r.v]));
    const available = meta.get("available");
    checks.git_cochange = {
      available: available === "true",
      status: available ?? "unavailable",
      // A stale error from before the last successful build would read as a
      // live fault, so it is only reported while the layer is actually down.
      last_error: available === "true" ? null : (meta.get("last_error") ?? null),
      scheduler_circuit_open: services.gitCochange?.isSchedulerCircuitOpen() ?? false,
      optional: true,
    };
  } catch {
    // keep the default: unavailable, no reason known
  }

  // Gating: only db + mqtt block readiness. tree_sitter and git_cochange are reported but optional.
  const allOk = checks.db.ok && checks.mqtt.ok;
  json(
    res,
    {
      status: allOk ? "ready" : "not_ready",
      checks,
    },
    allOk ? 200 : 503,
  );
}

export interface HealthOptions {
  authEnabled?: boolean;
  jwtSecretSet?: boolean;
}

/**
 * Backwards-compatible alias extended with auth config status reporting.
 * The original /health route returned a fixed {status:"ok",version} payload;
 * we preserve that shape and ADD auth_enabled, jwt_secret_set, and warnings
 * so operators can verify auth config without inspecting logs.
 */
export async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  options: HealthOptions = {},
): Promise<void> {
  const authEnabled = options.authEnabled ?? false;
  const jwtSecretSet = options.jwtSecretSet ?? false;
  const warnings: string[] = [];
  if (authEnabled && !jwtSecretSet) {
    warnings.push(
      "AUTH_ENABLED=true but COORDINATOR_JWT_SECRET is unset — sessions invalidate on restart",
    );
  }
  const body = {
    status: "alive",
    uptime_seconds: uptimeSeconds(),
    version: VERSION,
    auth_enabled: authEnabled,
    jwt_secret_set: jwtSecretSet,
    warnings,
  };
  json(res, body);
}
