import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { AuthHandlerContext } from "./context.js";
import { appError } from "../http/response-contract.js";
import { audit } from "../security/audit.js";
import { authenticateRequest } from "../auth.js";
import { CSRF_COOKIE_NAME, parseCookies } from "./cookies.js";
import { verifyCsrfToken } from "./csrf.js";

const DEVICE_CODE_TTL_S = 600; // 10-minute device flow window per RFC 8628
const DEFAULT_POLL_INTERVAL_S = 5; // initial poll cadence; slow_down may increase

// User-code alphabet: 20 unambiguous uppercase chars (no I/O/0/1/U/V).
// 8 chars chosen → 20^8 = 25.6B combinations = ~34.6 bits entropy.
// Format: XXXX-XXXX for readability on a TV/CLI screen.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const COLLISION_RETRY_MAX = 3;

// Per V4 FIX 14 + spec §17.6 NR11
const RATE_LIMIT_PER_MIN = { per: 5, window_seconds: 60 } as const;
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
        null, // org_id resolved at approve time (T20)
        String(expiresAt),
        ip === "unknown" ? null : ip,
        userAgent,
        null, // requester_country: GeoIP deferred
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

// V4 NR11: approve/deny rate limit per authenticated user.
// 10/min and 20/hr — both must pass.
const APPROVE_RATE_PER_MIN = { per: 10, window_seconds: 60 } as const;
const APPROVE_RATE_PER_HOUR = { per: 20, window_seconds: 3600 } as const;

const APPROVE_FAILURE_THRESHOLD = 5;

/**
 * POST /auth/device/approve — user-facing form post that approves OR denies
 * a pending device-authorization row.
 *
 * Flow (per plan v1 §T20 + V4 FIX 18/21 + V2 §C.9):
 *   1. Authenticate via cookie (T27 Scenario 5) — browser-only, no Bearer.
 *      Unauthenticated → 401 + WWW-Authenticate.
 *   2. Parse form body (user_code, _csrf, action ∈ {approve, deny}).
 *      Missing user_code/action → 400 INVALID_REQUEST.
 *      Unknown action → 400 INVALID_ACTION.
 *   3. Rate limit per authenticated user (V4 NR11: 10/min + 20/hr).
 *   4. CSRF double-submit: `__Host-coordinator_csrf` cookie value must
 *      timing-safe match the form `_csrf` field. Fail → 403 + Tier 2 audit
 *      auth.csrf.failed.
 *   5. action=approve: atomic CAS UPDATE
 *         SET approved_user_id = ?, approved_at = ?
 *         WHERE user_code = ? AND approved_user_id IS NULL
 *           AND denied_at IS NULL AND expires_at > now
 *           AND failed_approval_attempts < 5
 *      Success → Tier 2 audit auth.device.approved + 302 /auth/success.
 *      Failure → inspect row state:
 *        - row missing                          → 302 ?error=invalid_code
 *        - expired                              → 302 ?error=expired
 *        - already approved/denied              → 302 ?error=consumed
 *        - else (attempts ≥ 5 OR race)          → atomic increment
 *           failed_approval_attempts; if new value ≥ 5 → V4 FIX 21 lockout
 *           (set denied_at + denied_reason='too_many_failed_approvals') +
 *           Tier 2 audit auth.device.denied reason='brute_force' + 302
 *           ?error=lockout. Else → 302 ?error=consumed.
 *   6. action=deny: atomic UPDATE SET denied_at, denied_reason='user_denied'
 *      WHERE user_code = ? AND approved_user_id IS NULL AND denied_at IS NULL
 *      AND expires_at > now. Success → Tier 2 audit auth.device.denied
 *      reason='user_denied'. Always redirects to /auth/device?status=denied
 *      (no info leak on unknown/expired user_code).
 */
export async function handleDeviceApprove(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  // (1) Cookie auth via T27 Scenario 5.
  const authResult = await authenticateRequest(req, { authEnabled: true });
  if (!authResult.ok) {
    res.writeHead(authResult.status, {
      "Content-Type": "application/json; charset=utf-8",
      ...(authResult.wwwAuthenticate ? { "WWW-Authenticate": authResult.wwwAuthenticate } : {}),
    });
    res.end(JSON.stringify(appError("UNAUTHORIZED", authResult.error)));
    return;
  }
  const claims = authResult.claims;

  // (2) Parse form body.
  let body: Record<string, string>;
  try {
    body = await parseFormBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("INVALID_REQUEST", "Could not parse form body")));
    return;
  }

  const userCode = body.user_code;
  const csrfForm = body._csrf;
  const action = body.action;

  if (!userCode || !action) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("INVALID_REQUEST", "Missing user_code or action")));
    return;
  }

  // (3) Rate limit per authenticated user. Placed after auth so the key
  // can use user_id (rather than IP, which can be shared/NATed for legit
  // approvers); placed before CSRF so an attacker that spams /approve with
  // bogus CSRF tokens still pays the per-user rate-limit cost.
  const minRate = ctx.rateLimiter.check(
    `device-approve-min:${claims.user_id}`,
    APPROVE_RATE_PER_MIN,
  );
  if (!minRate.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(minRate.retry_after_seconds),
    });
    res.end(
      JSON.stringify(appError("RATE_LIMITED", "Too many device approve requests (per minute)")),
    );
    return;
  }
  const hourRate = ctx.rateLimiter.check(
    `device-approve-hour:${claims.user_id}`,
    APPROVE_RATE_PER_HOUR,
  );
  if (!hourRate.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(hourRate.retry_after_seconds),
    });
    res.end(
      JSON.stringify(appError("RATE_LIMITED", "Too many device approve requests (per hour)")),
    );
    return;
  }

  // (4) CSRF double-submit. Tier 2 audit on failure (V4 patches CUT 2 —
  // SameSite=Strict + __Host- + this random double-submit is the defense).
  const cookies = parseCookies(req);
  const csrfCookie = cookies[CSRF_COOKIE_NAME];
  if (!verifyCsrfToken(csrfCookie, csrfForm)) {
    audit("auth.csrf.failed", {
      tier: 2,
      metadata: { user_id: claims.user_id, endpoint: "/auth/device/approve" },
    });
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("CSRF_FAILED", "CSRF validation failed")));
    return;
  }

  const base = ctx.publicUrl.replace(/\/$/, "");
  const now = ctx.clock.now();

  if (action === "approve") {
    // (5) Atomic CAS approve. CAST(expires_at AS INTEGER) — T17 stores as
    // TEXT epoch seconds; SQLite needs the cast to compare against integer.
    const result = ctx.db
      .prepare(
        `
        UPDATE device_auth_requests
        SET approved_user_id = ?, approved_at = ?
        WHERE user_code = ?
          AND approved_user_id IS NULL
          AND denied_at IS NULL
          AND CAST(expires_at AS INTEGER) > ?
          AND failed_approval_attempts < ?
        RETURNING device_code, requester_ip, requester_user_agent
      `,
      )
      .get(claims.user_id, now, userCode, now, APPROVE_FAILURE_THRESHOLD) as
      | {
          device_code: string;
          requester_ip: string | null;
          requester_user_agent: string | null;
        }
      | undefined;

    if (result) {
      audit("auth.device.approved", {
        tier: 2,
        metadata: {
          actor_user_id: claims.user_id,
          requester_ip: result.requester_ip,
          requester_user_agent: result.requester_user_agent,
        },
      });
      res.writeHead(302, { Location: `${base}/auth/success` });
      res.end();
      return;
    }

    // Approve UPDATE matched 0 rows — diagnose + maybe lockout.
    await handleApproveFailure(res, ctx, base, userCode, claims.user_id, now);
    return;
  }

  if (action === "deny") {
    // (6) Atomic deny. Same WHERE guards as approve (sans attempts<5 —
    // explicit user denial is always honored unless the row is expired
    // or already consumed).
    const denyResult = ctx.db
      .prepare(
        `
        UPDATE device_auth_requests
        SET denied_at = ?, denied_reason = 'user_denied'
        WHERE user_code = ?
          AND approved_user_id IS NULL
          AND denied_at IS NULL
          AND CAST(expires_at AS INTEGER) > ?
        RETURNING device_code
      `,
      )
      .get(now, userCode, now) as { device_code: string } | undefined;

    if (denyResult) {
      audit("auth.device.denied", {
        tier: 2,
        metadata: {
          actor_user_id: claims.user_id,
          reason: "user_denied",
        },
      });
    }
    // Always redirect — no-op deny (unknown/expired/consumed user_code)
    // gets the same response as a successful deny. Avoids leaking row
    // existence to a CSRF-laundered attacker.
    res.writeHead(302, { Location: `${base}/auth/device?status=denied` });
    res.end();
    return;
  }

  // Unknown action.
  res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("INVALID_ACTION", "action must be 'approve' or 'deny'")));
}

/**
 * Diagnose why an approve UPDATE matched 0 rows and emit the right redirect.
 * Increments failed_approval_attempts only when the row exists, isn't
 * expired, and isn't already consumed — i.e., the approve failed because
 * attempts ≥ 5 OR a race (which we conservatively treat as another failed
 * attempt). On crossing the V4 FIX 21 threshold, lock the row out.
 */
async function handleApproveFailure(
  res: ServerResponse,
  ctx: AuthHandlerContext,
  base: string,
  userCode: string,
  callerUserId: string,
  now: number,
): Promise<void> {
  const row = ctx.db
    .prepare(
      `
      SELECT user_code, approved_user_id, denied_at, expires_at,
             failed_approval_attempts
      FROM device_auth_requests WHERE user_code = ?
    `,
    )
    .get(userCode) as
    | {
        user_code: string;
        approved_user_id: string | null;
        denied_at: number | null;
        expires_at: number | string;
        failed_approval_attempts: number;
      }
    | undefined;

  if (!row) {
    // Unknown user_code. No row to increment (brute-force counter is
    // per-user_code); rate limit + 25.6B keyspace bound this attack.
    res.writeHead(302, { Location: `${base}/auth/device?error=invalid_code` });
    res.end();
    return;
  }

  if (Number(row.expires_at) <= now) {
    res.writeHead(302, { Location: `${base}/auth/device?error=expired` });
    res.end();
    return;
  }

  if (row.approved_user_id !== null || row.denied_at !== null) {
    res.writeHead(302, { Location: `${base}/auth/device?error=consumed` });
    res.end();
    return;
  }

  // Row exists, not expired, not consumed. Approve failed because either
  // failed_approval_attempts ≥ 5 OR a race occurred. Increment and check
  // the V4 FIX 21 lockout threshold.
  const incResult = ctx.db
    .prepare(
      `
      UPDATE device_auth_requests
      SET failed_approval_attempts = failed_approval_attempts + 1
      WHERE user_code = ?
      RETURNING failed_approval_attempts
    `,
    )
    .get(userCode) as { failed_approval_attempts: number } | undefined;
  /* c8 ignore next */
  const attempts = incResult?.failed_approval_attempts ?? 0;

  if (attempts >= APPROVE_FAILURE_THRESHOLD) {
    // V4 FIX 21: lock the row out so subsequent approves fall to "consumed".
    ctx.db
      .prepare(
        `
        UPDATE device_auth_requests
        SET denied_at = ?, denied_reason = 'too_many_failed_approvals'
        WHERE user_code = ?
      `,
      )
      .run(now, userCode);
    audit("auth.device.denied", {
      tier: 2,
      metadata: { actor_user_id: callerUserId, reason: "brute_force" },
    });
    res.writeHead(302, { Location: `${base}/auth/device?error=lockout` });
    res.end();
    return;
  }

  res.writeHead(302, { Location: `${base}/auth/device?error=consumed` });
  res.end();
}
