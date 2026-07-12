import type { IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import type { AuthResult } from "../auth.js";

/**
 * S1: shared HTTP helpers extracted from serve-http.ts.
 * parseBody, json, decodeJwtPayload, safeEqual, jsonAuthError.
 */

const MAX_BODY_BYTES = parseInt(process.env.COORDINATOR_MAX_BODY_BYTES || "1048576", 10);

export function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        const err: Error & { statusCode?: number } = new Error("Payload too large");
        err.statusCode = 413;
        // destroy() may not exist on every IncomingMessage-like input (test stub).
        (req as unknown as { destroy?: (e?: Error) => void }).destroy?.(err);
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
  // securite-surface-07: baseline security header on every JSON API response
  // (this helper backs /health, /readyz, /livez, /api/*, error bodies, ...).
  // nosniff stops browsers from MIME-sniffing a JSON body as HTML/script.
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

/**
 * Decode a JWT payload WITHOUT verifying. Used only on tokens we just minted
 * ourselves (to read the `exp` claim before returning it to the client). Real
 * verification of inbound tokens happens in `authenticateRequest` via
 * jose.jwtVerify().
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const base64url = token.split(".")[1];
  return JSON.parse(Buffer.from(base64url, "base64url").toString("utf-8"));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function jsonAuthError(
  res: ServerResponse,
  authResult: Exclude<AuthResult, { ok: true }>,
): void {
  if (authResult.wwwAuthenticate) {
    res.setHeader("WWW-Authenticate", authResult.wwwAuthenticate);
  }
  json(res, { error: authResult.error }, authResult.status);
}

// securite-auth-03: GET requests (SSE / EventSource compat — see
// authenticateRequest in ../auth.ts) accept a bearer JWT via `?token=<jwt>`
// query param, decided/kept as-is (see docs/security/threat-model.md). That
// token is NOT covered by the pino REDACT_PATHS allowlist
// (../observability/redact-paths.ts) — those entries redact structured
// object *paths* (`req.headers.authorization`, `body.refresh_token`, ...),
// not a substring embedded inside a plain `url` string value. Every call
// site that logs a request URL (raw `req.url`, or any `url` derived from
// it) MUST route it through this first, or a valid/invalid JWT lands in
// cleartext in the log stream and any downstream log aggregator.
const TOKEN_QUERY_PARAM_RE = /([?&]token=)[^&#]*/gi;

export function redactTokenParam(url: string): string {
  return url.replace(TOKEN_QUERY_PARAM_RE, "$1[REDACTED]");
}

// performance-03: id-like path segments would otherwise become a Prometheus
// label VALUE, giving each distinct id (uuid, thread id, agent id, ...) its
// own unbounded time series. These three shapes cover the id-bearing REST
// routes in handle-rest.ts (consultation thread ids, agent ids) plus any
// numeric id scheme, without touching plain route words (e.g. "agents",
// "threads-active") so REST route templates stay distinguishable.
const UUID_SEGMENT_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LONG_HEX_SEGMENT_RE = /^[0-9a-fA-F]{16,}$/;
const LONG_NUMERIC_SEGMENT_RE = /^\d{4,}$/;

/**
 * Normalize a raw request path into a BOUNDED label for Prometheus metrics.
 *
 * Path segments that look like an opaque id (UUID, long hex string, long
 * numeric id) are collapsed to the literal `:id`, so the resulting label is
 * bounded by the number of route TEMPLATES the server exposes, not by the
 * number of distinct ids ever seen. Segments that don't match any id shape
 * (e.g. `agents`, `threads-active`) are left as-is, so real REST routes
 * remain distinguishable in the metric.
 *
 * See performance-03: passing the raw request path as a label value gives
 * every distinct path (including 404s on arbitrary prober paths) its own
 * Prometheus time series — unbounded cardinality, eventual OOM.
 */
export function metricRoute(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (segment === "") return segment;
      if (
        UUID_SEGMENT_RE.test(segment) ||
        LONG_HEX_SEGMENT_RE.test(segment) ||
        LONG_NUMERIC_SEGMENT_RE.test(segment)
      ) {
        return ":id";
      }
      return segment;
    })
    .join("/");
}
