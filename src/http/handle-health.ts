import type { IncomingMessage, ServerResponse } from "http";
import type { CoordinatorServices } from "../server-setup.js";
import { getDb } from "../database.js";
import { json } from "./utils.js";
import { getVersion } from "../../cli/version.js";

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
  services: Pick<CoordinatorServices, "mqttBridge">,
): void {
  const checks: ReadinessChecks = {
    db: { ok: false },
    mqtt: { ok: false },
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

/**
 * Backwards-compatible alias. The original /health route returned a fixed
 * {status:"ok",version} payload with no dep checks; semantically that is a
 * liveness probe, so we delegate. Anything that polled /health for "is the
 * process up" continues to work without changes.
 */
export function handleHealth(req: IncomingMessage, res: ServerResponse): void {
  return handleLivez(req, res);
}
