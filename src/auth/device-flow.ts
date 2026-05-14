import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { AuthHandlerContext } from "./context.js";
import { appError } from "../http/response-contract.js";
import { audit } from "../security/audit.js";

const DEVICE_CODE_TTL_S = 600;       // 10-minute device flow window per RFC 8628
const DEFAULT_POLL_INTERVAL_S = 5;   // initial poll cadence; slow_down may increase

// User-code alphabet: 20 unambiguous uppercase chars (no I/O/0/1/U/V).
// 8 chars chosen → 20^8 = 25.6B combinations = ~34.6 bits entropy.
// Format: XXXX-XXXX for readability on a TV/CLI screen.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const COLLISION_RETRY_MAX = 3;

// Per V4 FIX 14 + spec §17.6 NR11
const RATE_LIMIT_PER_MIN = { per: 5,  window_seconds: 60 } as const;
const RATE_LIMIT_PER_HOUR = { per: 20, window_seconds: 3600 } as const;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * Generate a user-friendly device code: 8 chars from the 20-char unambiguous
 * alphabet, formatted XXXX-XXXX. Uses crypto.randomInt for unbiased selection
 * (rather than `randomBytes[i] % len` which has modulo bias for non-power-of-2
 * alphabet sizes).
 */
function generateUserCode(): string {
  const chars: string[] = [];
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, USER_CODE_ALPHABET.length);
    chars.push(USER_CODE_ALPHABET[idx]!);
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`;
}

/** 256-bit device_code via base64url-encoded 32-byte CSPRNG. */
function generateDeviceCode(): string {
  return crypto.randomBytes(32).toString("base64url");
}

async function parseFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      // URLSearchParams + Buffer.concat are lenient: no realistic throw path
      // here. Socket-level failures arrive via the "error" listener below.
      const body = Buffer.concat(chunks).toString("utf8");
      const params = new URLSearchParams(body);
      const out: Record<string, string> = {};
      for (const [k, v] of params) out[k] = v;
      resolve(out);
    });
    req.on("error", reject);
  });
}

/**
 * POST /api/auth/oauth/device_authorization — RFC 8628 §3.1 device flow init.
 *
 * Form-encoded body: client_id (required by RFC). Optional `scope` — Phase 2
 * ignores; scope is hardcoded to read:user user:email read:org via the GitHub
 * provider. Phase 4 multi-client adds client_id registry validation here.
 *
 * Rate limited per IP: 5/min + 20/hr (V4 NR11). 429 on either threshold.
 *
 * Collision retry: device_auth_requests.user_code has UNIQUE constraint. If
 * INSERT fails with SQLITE_CONSTRAINT, regenerate user_code and retry up to
 * 3 times (V2 §C.8 race fix). After 3 failures, return 500 (extremely rare
 * given 25.6B-key space).
 *
 * Returns RFC 8628 §3.2 JSON shape with verification_uri +
 * verification_uri_complete (the latter pre-fills user_code for nicer UX).
 */
export async function handleDeviceAuthorization(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  // Rate limit (both per-min and per-hour must pass)
  const ip = req.socket?.remoteAddress ?? "unknown";
  const perMin = ctx.rateLimiter.check(`device-auth-min:${ip}`, RATE_LIMIT_PER_MIN);
  if (!perMin.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(perMin.retry_after_seconds),
    });
    res.end(JSON.stringify(appError("RATE_LIMITED", "Too many device auth requests (per minute)")));
    return;
  }
  const perHour = ctx.rateLimiter.check(`device-auth-hour:${ip}`, RATE_LIMIT_PER_HOUR);
  if (!perHour.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(perHour.retry_after_seconds),
    });
    res.end(JSON.stringify(appError("RATE_LIMITED", "Too many device auth requests (per hour)")));
    return;
  }

  // Parse form body. Phase 2 accepts client_id for RFC 8628 compliance but
  // does not validate against a registry (single-client deployment); Phase 4
  // multi-client adds a check here. Missing client_id is therefore tolerated.
  let body: Record<string, string>;
  try {
    body = await parseFormBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("INVALID_REQUEST", "Could not parse form body")));
    return;
  }
  void body.client_id; // documented Phase 2 no-op; Phase 4 wires validation

  // INSERT with collision retry. expires_at stored as stringified epoch
  // seconds — Phase 1 schema declares it TEXT NOT NULL; downstream T18/T20
  // poll/approve handlers parse it back to int for comparison.
  const now = ctx.clock.now();
  const expiresAt = now + DEVICE_CODE_TTL_S;
  const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
  const deviceCode = generateDeviceCode();
  const insertStmt = ctx.db.prepare(`
    INSERT INTO device_auth_requests
      (device_code, user_code, nonce, org_id, expires_at,
       requester_ip, requester_user_agent, requester_country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let userCode: string | null = null;
  for (let attempt = 0; attempt < COLLISION_RETRY_MAX; attempt++) {
    const candidate = generateUserCode();
    try {
      insertStmt.run(
        deviceCode,
        candidate,
        crypto.randomBytes(16).toString("base64url"), // nonce: Phase 1 schema requires UNIQUE NOT NULL
        null,                                          // org_id resolved at approve time (T20)
        String(expiresAt),
        ip === "unknown" ? null : ip,
        userAgent,
        null,                                          // requester_country: GeoIP deferred
      );
      userCode = candidate;
      break;
    } catch (err) {
      // SQLITE_CONSTRAINT_UNIQUE on user_code → retry. Anything else → abort.
      const msg = (err as Error).message ?? "";
      if (!msg.includes("UNIQUE constraint failed") || !msg.includes("user_code")) {
        throw err;
      }
      // collision; loop and regen
    }
  }

  if (userCode === null) {
    // Exhausted retries on a 25.6B-key space → either real wedging or DB
    // problem. Return 500 with a generic message.
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("INTERNAL_ERROR", "Could not allocate a device code")));
    return;
  }

  // Tier 2 audit (best-effort; sync-fallback if queue uninit).
  audit("auth.device.code_issued", {
    tier: 2,
    metadata: {
      user_code: userCode,
      requester_ip: ip === "unknown" ? null : ip,
      requester_ua: userAgent,
    },
  });

  // Build response per RFC 8628 §3.2. Normalize trailing slash on publicUrl
  // so verification_uri stays canonical.
  const base = ctx.publicUrl.replace(/\/$/, "");
  const response: DeviceCodeResponse = {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${base}/auth/device`,
    verification_uri_complete: `${base}/auth/device/confirm?user_code=${encodeURIComponent(userCode)}`,
    expires_in: DEVICE_CODE_TTL_S,
    interval: DEFAULT_POLL_INTERVAL_S,
  };

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(response));
}

/**
 * POST /auth/device/approve — user-facing form post that approves (or
 * denies) a pending device-authorization request.
 *
 * STUB: real implementation lands in T20. The stub returns 501 with a
 * structured app-error envelope so route registration can be tested
 * before the handler body exists.
 */
export async function handleDeviceApprove(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthHandlerContext,
): Promise<void> {
  res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("NOT_IMPLEMENTED", "handleDeviceApprove: stub awaits T20")));
}
