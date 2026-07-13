/**
 * Phase 2 /metrics/auth HTTP handler. Scrapes the Phase 2 metric
 * registry (`src/observability/metrics.ts`). Lives at a separate path
 * from Phase 1's `/metrics` (`src/metrics.ts`) to keep the two
 * registries — and therefore the two namespace conventions — apart.
 *
 * Access control (both rules can apply):
 *   - `localhostOnly` (default true): allow only 127.0.0.1 / ::1 /
 *     ::ffff:127.0.0.1 / 127.0.0.0/8.
 *   - `bearerToken` set: allow any IP if the request carries a matching
 *     `Authorization: Bearer <token>` header. Comparison is constant-time.
 *
 * Either condition independently grants access; both being false yields
 * 403 with the standard error envelope.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { registry } from "../observability/metrics.js";
import { appError } from "./response-contract.js";

export interface MetricsHandlerOptions {
  /** When true (default), only allow requests from loopback addresses. */
  localhostOnly?: boolean;
  /**
   * Optional Bearer token. If provided, requests from any IP that carry
   * a matching `Authorization: Bearer <token>` header are allowed in
   * addition to (not instead of) the loopback rule.
   */
  bearerToken?: string;
}

function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  if (remoteAddress === "::1") return true;
  if (remoteAddress === "::ffff:127.0.0.1") return true;
  // 127.0.0.0/8 — matches "127.0.0.1", "127.0.0.5", etc.
  return remoteAddress.startsWith("127.");
}

function timingSafeBearerMatch(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // crypto.timingSafeEqual throws on length mismatch. Length is not
  // secret — checking it before the constant-time compare is correct.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Handle a request to /metrics/auth. Returns 200 with the Prometheus
 * text-exposition body on success, or 403 with the standard error
 * envelope on access denial.
 */
export async function handleMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MetricsHandlerOptions = {},
): Promise<void> {
  const localhostOnly = opts.localhostOnly ?? true;
  const fromLoopback = isLoopback(req.socket?.remoteAddress);
  const bearerOk = opts.bearerToken
    ? timingSafeBearerMatch(req.headers["authorization"] as string | undefined, opts.bearerToken)
    : false;

  const allowed = (localhostOnly && fromLoopback) || bearerOk;
  if (!allowed) {
    res.writeHead(403, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(appError("FORBIDDEN", "Access denied")));
    return;
  }

  const body = await registry.metrics();
  res.writeHead(200, { "Content-Type": registry.contentType });
  res.end(body);
}
