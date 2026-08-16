import { SignJWT, jwtVerify, decodeProtectedHeader, errors } from "jose";
import { randomUUID } from "crypto";
import type { IncomingMessage } from "http";
import type Database from "better-sqlite3";
import { getDb } from "./database.js";
import { silentLogger, type Logger } from "./logger.js";
import { parseCookies, SESSION_COOKIE_NAME } from "./auth/cookies.js";
import { isAcceptedKid, type JwtKeyRegistry } from "./auth/jwt-keys.js";
import { readTokenEpoch, getEpochFloor } from "./auth/token-epoch.js";
import { verifyServiceTokenJti } from "./auth/service-tokens.js";
import { audit } from "./security/audit.js";
import { bearerAuthHeader } from "./http/response-contract.js";

let signingKey: Uint8Array;
let prevKey: Uint8Array | null = null;
let defaultExpiry = "24h";
let log: Logger = silentLogger;

export function setAuthLogger(logger: Logger): void {
  log = logger;
}

/**
 * "internal" is reserved for the coordinator's own MQTT bridge client — the
 * single process-internal identity minted server-side (see
 * wireMqtt/serve-http.ts) so it can route every org's MQTT traffic without
 * being bound to one org's topic prefix. It carries no REST privileges:
 * verifyToken falls back to "member" for it, and although verifyTokenStrict
 * preserves the literal role (so the MQTT authenticate hook can recover it),
 * authenticateRequest explicitly rejects claims.role === "internal" as
 * unauthorized, and refreshToken refuses to re-mint an "internal" token —
 * on both the non-expired (happy) path and the expired-token grace-period
 * recovery path, so a leaked bridge token can never be turned into a
 * renewable "member" credential. Only the MQTT authenticate hook
 * (mqtt-broker.ts) may act on this role.
 */
export type AuthRole = "agent" | "admin" | "member" | "service" | "internal";

export interface AuthClaims {
  sub: string;
  user_id: string;
  org: string;
  role: AuthRole;
  jti: string;
  /** Phase 2 cookie/Bearer JWTs only — same as `org` when set. */
  active_org_id?: string;
  /** Phase 2 cookie/Bearer JWTs — refresh-token family identifier (T19). */
  family_id?: string;
  /** Phase 2 service-account marker (T25). */
  service_account?: boolean;
}

export interface CreateTokenOptions {
  user_id?: string;
  org?: string;
}

export interface InitAuthOptions {
  prevSecret?: string;
}

export interface AuthenticateOptions {
  authEnabled: boolean;
}

export function initAuth(secret: string, expiry?: string, options: InitAuthOptions = {}): void {
  signingKey = new TextEncoder().encode(secret);
  prevKey = options.prevSecret ? new TextEncoder().encode(options.prevSecret) : null;
  if (expiry) defaultExpiry = expiry;
}

export async function createToken(
  agentId: string,
  role: AuthRole,
  expiry?: string,
  options: CreateTokenOptions = {},
): Promise<string> {
  const jti = randomUUID();
  return new SignJWT({
    role,
    user_id: options.user_id ?? agentId,
    org: options.org ?? "default",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(agentId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiry || defaultExpiry)
    .sign(signingKey);
}

export async function verifyToken(token: string): Promise<AuthClaims> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, signingKey, { algorithms: ["HS256"] }));
  } catch (err) {
    if (prevKey && err instanceof errors.JWSSignatureVerificationFailed) {
      ({ payload } = await jwtVerify(token, prevKey, { algorithms: ["HS256"] }));
    } else {
      throw err;
    }
  }
  if (!payload.sub) throw new Error("Missing sub claim in token");
  const role = payload.role;
  if (role !== "agent" && role !== "admin" && role !== "member") {
    throw new Error("Invalid role in token");
  }
  return {
    sub: payload.sub,
    role,
    user_id: typeof payload.user_id === "string" ? payload.user_id : "legacy",
    org: typeof payload.org === "string" ? payload.org : "default",
    jti: typeof payload.jti === "string" ? payload.jti : randomUUID(),
  };
}

export async function verifyTokenStrict(
  token: string,
): Promise<{ claims: AuthClaims; wasLegacy: boolean }> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, signingKey, { algorithms: ["HS256"] }));
  } catch (err) {
    if (prevKey && err instanceof errors.JWSSignatureVerificationFailed) {
      ({ payload } = await jwtVerify(token, prevKey, { algorithms: ["HS256"] }));
    } else {
      throw err;
    }
  }
  if (!payload.sub) throw new Error("Missing sub claim in token");
  // Tolerate missing/unknown role on v0.6 tokens. Default to 'member' (LEAST PRIVILEGE).
  // "internal" is preserved here (unlike verifyToken/refreshToken's tolerant
  // fallback) because this is the only path the MQTT authenticate hook uses
  // to recover the coordinator-internal bridge's role for its ACL exemption.
  const rawRole = payload.role;
  const role: AuthRole =
    rawRole === "agent" || rawRole === "admin" || rawRole === "member" || rawRole === "internal"
      ? rawRole
      : "member";
  // v0.7 detection: BOTH user_id AND org must be present strings.
  const hasV07 = typeof payload.user_id === "string" && typeof payload.org === "string";
  return {
    claims: {
      sub: payload.sub,
      role,
      user_id: typeof payload.user_id === "string" ? payload.user_id : "legacy",
      org: typeof payload.org === "string" ? payload.org : "default",
      jti: typeof payload.jti === "string" ? payload.jti : randomUUID(),
    },
    wasLegacy: !hasV07,
  };
}

export async function refreshToken(
  token: string,
  options: AuthenticateOptions,
  gracePeriod?: string,
): Promise<string> {
  const authEnabled = options.authEnabled;
  const grace = gracePeriod ?? "1h";

  let claims: AuthClaims;
  try {
    const { claims: c, wasLegacy } = await verifyTokenStrict(token);
    if (wasLegacy && authEnabled) {
      throw new Error("v0.6 token rejected: upgrade required (AUTH_ENABLED=true)");
    }
    // The MQTT-only "internal" bridge role must never be refreshable into a
    // perpetual REST/MCP credential. Reject it on the non-expired (happy)
    // path here; the expired-token recovery path below rejects it explicitly
    // too (see the matching check there) so a leaked, expired bridge token
    // can't be revived as "member" via the grace-period path either.
    if (c.role === "internal") {
      throw new Error("'internal' role tokens cannot be refreshed");
    }
    claims = c;
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      const verifyWith = async (key: Uint8Array) =>
        jwtVerify(token, key, { clockTolerance: grace, algorithms: ["HS256"] });
      let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
      try {
        ({ payload } = await verifyWith(signingKey));
      } catch (err2) {
        if (prevKey && err2 instanceof errors.JWSSignatureVerificationFailed) {
          ({ payload } = await verifyWith(prevKey));
        } else {
          throw err2;
        }
      }
      if (!payload.sub) throw new Error("Missing sub claim in token");
      // The MQTT-only "internal" bridge role must never be refreshable into a
      // perpetual REST/MCP credential, including via this expired-token grace
      // recovery branch. Reject it explicitly here — it must NOT fall through
      // the role allowlist below into the "unknown role -> member" default,
      // which would silently downgrade (and thus resurrect) it as a
      // refreshable "member" token.
      if (payload.role === "internal") {
        throw new Error("'internal' role tokens cannot be refreshed");
      }
      // Tolerate missing/unknown role on v0.6 tokens. Default to 'member' (LEAST PRIVILEGE).
      const rawRole = payload.role;
      const role: AuthRole =
        rawRole === "agent" || rawRole === "admin" || rawRole === "member" ? rawRole : "member";
      const hasV07 = typeof payload.user_id === "string" && typeof payload.org === "string";
      if (!hasV07 && authEnabled) {
        throw new Error("v0.6 token rejected: upgrade required (AUTH_ENABLED=true)");
      }
      claims = {
        sub: payload.sub,
        role,
        user_id: typeof payload.user_id === "string" ? payload.user_id : "legacy",
        org: typeof payload.org === "string" ? payload.org : "default",
        jti: typeof payload.jti === "string" ? payload.jti : randomUUID(),
      };
    } else {
      throw err;
    }
  }
  return createToken(claims.sub, claims.role, undefined, {
    user_id: claims.user_id,
    org: claims.org,
  });
}

/**
 * issue #287: scoped to the org, not global.
 *
 * These ignored `org_id` entirely, on the premise that an agent id named
 * exactly one agent — "a revocation issued by an admin must be effective
 * across every org where that agent_id appears". The v11 migration (#231)
 * made ids unique per org instead, so two orgs may each have a `builder` and
 * they are different agents. Left global, one org's admin revoking `builder`
 * would 403 every other org's `builder` on every request, and could not
 * revoke their own without doing so.
 *
 * `revoked_agents` has been keyed (org_id, agent_id) since the composite-PK
 * migration; only this code ignored it. Rows written before v12 all carry
 * org_id='default' whatever org their agent is in, and are moved onto the
 * right org by migrateRevokedAgentsPerOrgV12 — without that, scoping the
 * lookup would silently un-revoke every agent outside 'default'.
 */
export function isRevoked(orgId: string, agentId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT 1 FROM revoked_agents WHERE org_id = ? AND agent_id = ?")
    .get(orgId, agentId);
  return !!row;
}

export function revokeAgent(orgId: string, agentId: string, revokedBy: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO revoked_agents (agent_id, org_id, revoked_by) VALUES (?, ?, ?)",
  ).run(agentId, orgId, revokedBy);
}

const ADMIN_ONLY_ROUTES = ["/api/auth/revoke", "/api/reset"];

export type AuthResult =
  | { ok: true; claims: AuthClaims }
  | { ok: false; status: 401 | 403; error: string; wwwAuthenticate?: string };

/**
 * Post-authentication route guards: revocation + admin-only routes.
 *
 * Every path through authenticateRequest that produces a successful
 * AuthResult (cookie, Bearer→Phase2 fallback, Bearer principal) MUST run its
 * claims through this helper before returning them. Applying the guards
 * inline in each branch let them drift apart — the cookie branch shipped
 * without either check, so a valid (or even revoked) session cookie could
 * call admin-only routes like /api/auth/revoke or /api/reset. Routing all
 * three paths through one function makes that divergence impossible to
 * reintroduce.
 */
function applyRouteGuards(result: AuthResult, req: IncomingMessage): AuthResult {
  if (!result.ok) return result;
  if (isRevoked(result.claims.org, result.claims.sub)) {
    return { ok: false, status: 403, error: "Agent has been revoked" };
  }
  const url = req.url || "";
  // Strip query string and hash before matching — "/api/reset?x=1" must hit the check
  const pathOnly = url.split(/[?#]/)[0];
  if (ADMIN_ONLY_ROUTES.some((r) => pathOnly === r) && result.claims.role !== "admin") {
    return { ok: false, status: 403, error: "Admin access required" };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phase 2 cookie-based JWT auth (Scenario 5, spec §9.5)
// ---------------------------------------------------------------------------
//
// authenticateRequest is a top-level helper not currently parameterized by
// AuthHandlerContext. T29 boot will compose Phase 2 deps; for T27 we expose
// initPhase2Auth({ db, signingKeys, publicUrl }) which stashes those refs in
// a module-level variable. If the context is never wired (Phase 1 deploys),
// the cookie path falls through silently — preserving Phase 1 semantics.

const SESSION_CLOCK_TOLERANCE_S = 30;

/**
 * True iff the JWT's protected header carries a `kid` — the marker that
 * identifies a Phase 2 token (mintAccessJWT / mintRefreshJWT always set it;
 * Phase 1 createToken never does). Header decoding is unauthenticated by
 * design: it only picks the verifier, and that verifier re-checks the kid
 * against the ACCEPTED_KIDS allowlist before resolving a key. A malformed
 * token decodes to `false` and falls through to the Phase 1 verifier, which
 * rejects it.
 */
function hasKidHeader(token: string): boolean {
  try {
    return typeof decodeProtectedHeader(token).kid === "string";
  } catch {
    return false;
  }
}

interface Phase2AuthContext {
  db: Database.Database;
  signingKeys: JwtKeyRegistry;
  publicUrl: string;
}

let phase2Ctx: Phase2AuthContext | null = null;

/** Wire Phase 2 dependencies. Called once at boot (T29). */
export function initPhase2Auth(ctx: Phase2AuthContext): void {
  phase2Ctx = ctx;
}

/** Test helper: clear Phase 2 wiring between tests so Scenario 5 doesn't
 *  bleed into Phase 1 auth-test suites. Also exported for T29 reset paths. */
export function resetPhase2Auth(): void {
  phase2Ctx = null;
}

/**
 * Verify a Phase 2 session cookie JWT. Per spec §9.5:
 *   - HS256 pinned
 *   - kid must be on the T08b ACCEPTED_KIDS allowlist
 *   - iss must equal ctx.publicUrl (trailing slash stripped, mirroring T19)
 *   - ±30s clock tolerance per RFC 7519 §4.1.4
 *   - claims.iat >= user.token_epoch (T03 admin-force-revoke wins)
 *
 * Rejection paths emit Tier 2 audit auth.invalid_token with `reason` in the
 * metadata (mirrors refresh-rotation.ts's pattern). On success the returned
 * AuthClaims carry active_org_id + family_id + service_account so downstream
 * handlers (T20/T23/T24) can use them.
 */
async function verifyPhase2SessionCookie(
  token: string,
  ctx: Phase2AuthContext,
): Promise<AuthResult> {
  try {
    const { payload } = await jwtVerify(
      token,
      async (header) => {
        const kid = header.kid;
        if (!kid || !isAcceptedKid(kid)) {
          throw new Error(`unknown_kid: ${String(kid)}`);
        }
        const key = ctx.signingKeys.getKey(kid);
        // Unreachable when isAcceptedKid returned true and registry was built
        // from ACCEPTED_KIDS, but the registry is an interface — defend in depth.
        /* c8 ignore next */
        if (!key) throw new Error(`no_key_for_kid: ${kid}`);
        return key;
      },
      {
        algorithms: ["HS256"],
        issuer: ctx.publicUrl.replace(/\/$/, ""),
        clockTolerance: `${SESSION_CLOCK_TOLERANCE_S}s`,
      },
    );

    const claims = payload as unknown as {
      sub?: string;
      active_org_id?: string;
      family_id?: string;
      role?: string;
      jti?: string;
      iat?: number;
      service_account?: boolean;
      typ?: string;
    };

    // securite-auth-01: reject token-type confusion. A refresh-token
    // carries typ:"refresh" (or, for tokens minted before this fix, no
    // `typ` claim at all) and must never be accepted as a session
    // cookie / Bearer credential. Fail-closed: tokens without a `typ`
    // claim are treated as legacy and rejected too (see task-1.3 report
    // for the compat rationale) — this endpoint only accepts
    // typ === "access".
    if (claims.typ !== "access") {
      audit("auth.invalid_token", {
        tier: 2,
        metadata: { reason: "wrong_token_type" },
      });
      return {
        ok: false,
        status: 401,
        error: "Invalid session",
        wwwAuthenticate: bearerAuthHeader("invalid_token", "Invalid session"),
      };
    }

    if (!claims.sub) {
      audit("auth.invalid_token", { tier: 2, metadata: { reason: "missing_sub" } });
      return {
        ok: false,
        status: 401,
        error: "Invalid session cookie",
        wwwAuthenticate: bearerAuthHeader("invalid_token", "Invalid session"),
      };
    }
    if (typeof claims.iat !== "number") {
      audit("auth.invalid_token", { tier: 2, metadata: { reason: "missing_iat" } });
      return {
        ok: false,
        status: 401,
        error: "Invalid session cookie",
        wwwAuthenticate: bearerAuthHeader("invalid_token", "Invalid session"),
      };
    }

    // T03: admin-force-revoke check — claims older than the bumped epoch fail.
    // Phase 5: max() with the pub/sub epoch floor closes the cross-instance
    // WAL-visibility window (single-instance-constraints.md token-epoch race).
    const epoch = Math.max(readTokenEpoch(ctx.db, claims.sub), getEpochFloor(claims.sub));
    if (claims.iat < epoch) {
      audit("auth.invalid_token", {
        tier: 2,
        metadata: { reason: "token_epoch_exceeded" },
      });
      return {
        ok: false,
        status: 401,
        error: "Session invalidated",
        wwwAuthenticate: bearerAuthHeader("invalid_token", "Session invalidated"),
      };
    }

    // T25 / V4 §5.5: service-account override. Service tokens carry
    // service_account=true; every request DB-validates the jti so admin
    // force-revoke wins immediately (overrides §9.5 trust-signature).
    if (claims.service_account === true) {
      if (typeof claims.jti !== "string") {
        audit("auth.invalid_token", {
          tier: 2,
          metadata: { reason: "service_token_missing_jti" },
        });
        return {
          ok: false,
          status: 401,
          error: "Invalid service token",
          wwwAuthenticate: bearerAuthHeader("invalid_token", "Invalid service token"),
        };
      }
      if (!verifyServiceTokenJti(ctx.db, claims.jti)) {
        audit("auth.invalid_token", {
          tier: 2,
          metadata: { reason: "service_token_revoked" },
        });
        return {
          ok: false,
          status: 401,
          error: "Service token revoked",
          wwwAuthenticate: bearerAuthHeader("invalid_token", "Service token revoked"),
        };
      }
    }

    // Default role per LEAST PRIVILEGE if the JWT omits it. Phase 2 access
    // JWTs always set `role`, but the validator must be defensive.
    const rawRole = claims.role;
    const role: AuthRole =
      rawRole === "admin" || rawRole === "member" || rawRole === "service" || rawRole === "agent"
        ? rawRole
        : "member";

    return {
      ok: true,
      claims: {
        sub: claims.sub,
        user_id: claims.sub,
        org: claims.active_org_id ?? "default",
        role,
        jti: typeof claims.jti === "string" ? claims.jti : randomUUID(),
        active_org_id: claims.active_org_id,
        family_id: claims.family_id,
        service_account: claims.service_account,
      },
    };
  } catch (err) {
    audit("auth.invalid_token", {
      tier: 2,
      metadata: { reason: (err as Error).message },
    });
    return {
      ok: false,
      status: 401,
      error: "Invalid session cookie",
      wwwAuthenticate: bearerAuthHeader("invalid_token", "Invalid session"),
    };
  }
}

export async function authenticateRequest(
  req: IncomingMessage,
  options: AuthenticateOptions = { authEnabled: true },
): Promise<AuthResult> {
  const { authEnabled } = options;
  const authHeader = req.headers.authorization;

  // EventSource-compatible token transport: allow ?token=<JWT> on GET requests.
  // POST/PUT/PATCH are excluded (smuggling defense: POST endpoints use the body
  // as a credential channel, so hoisting a query param to auth would let an
  // attacker lure a victim's browser into a CSRF-authenticated POST).
  // Authorization header always takes precedence when both are present.
  let effectiveAuthHeader = authHeader;
  if (!effectiveAuthHeader && req.method === "GET") {
    try {
      // req.url may be relative (e.g. "/api/events?token=…") — prepend a dummy
      // base so URL can parse it. Attacker-controlled, so we wrap in try/catch.
      const parsed = new URL(req.url ?? "", "http://localhost");
      const qToken = parsed.searchParams.get("token");
      if (qToken) {
        effectiveAuthHeader = `Bearer ${qToken}`;
      }
    } catch {
      // Malformed URL — no fallback, fall through to scenario (b) 401.
    }
  }

  // Scenario 5: __Host-coordinator_session cookie (Phase 2 browser flows).
  // Only attempted when no Authorization / ?token= credential was presented
  // (Bearer wins per spec §9.5 precedence) AND Phase 2 deps are wired. If
  // initPhase2Auth() was never called (Phase 1 deployments), fall through
  // to the no-auth branch below as if the cookie weren't present.
  if (!effectiveAuthHeader && phase2Ctx) {
    const cookies = parseCookies(req);
    const sessionCookie = cookies[SESSION_COOKIE_NAME];
    if (sessionCookie) {
      return applyRouteGuards(await verifyPhase2SessionCookie(sessionCookie, phase2Ctx), req);
    }
  }

  // Scenario (a)/(b): No Authorization header (and no ?token= fallback)
  if (!effectiveAuthHeader || !effectiveAuthHeader.startsWith("Bearer ")) {
    if (!authEnabled) {
      // Scenario (a): AUTH_ENABLED=false → inject synthetic legacy claims
      return {
        ok: true,
        claims: {
          sub: "legacy",
          user_id: "legacy",
          org: "default",
          role: "admin",
          jti: randomUUID(),
        },
      };
    }
    // Scenario (b): AUTH_ENABLED=true → 401 with WWW-Authenticate
    return {
      ok: false,
      status: 401,
      error: "Missing or invalid Authorization header",
      wwwAuthenticate: 'Bearer realm="mcp-coordinator", error="invalid_token"',
    };
  }

  // Has a Bearer token — verify it
  const token = effectiveAuthHeader.slice(7);

  // Phase 2 JWTs (browser sessions, SDK/CLI device-flow tokens, refreshed
  // tokens, service tokens — everything minted by mintAccessJWT) are dispatched
  // on the `kid` header, which jwt-mint.ts always sets and Phase 1 createToken
  // never does. Do NOT use "Phase 1 verification threw" as the discriminator:
  // in production BOTH phases derive their HS256 key from the same
  // COORDINATOR_JWT_SECRET (serve-http.ts `initAuth(JWT_SECRET)` vs boot.ts
  // `buildJwtKeyRegistry(Buffer.from(jwtSecret, "utf8"))` — byte-identical), so
  // Phase 1 verification SUCCEEDS on a Phase 2 token, reports wasLegacy=true
  // (Phase 2 tokens carry sub/active_org_id, never the v0.7 user_id/org pair)
  // and 401s it as a v0.6 token. See auth-bearer-production-wiring.test.ts.
  //
  // The dispatch is fail-closed: once a token presents a kid, the Phase 2
  // verdict is final. Falling back to Phase 1 here would let a caller downgrade
  // to the weaker verifier — which skips the kid allowlist, the issuer check,
  // the typ:"access" token-type check, the T03 token_epoch revocation check and
  // the T25/V4 §5.5 service-account jti DB validation — by attaching a junk kid.
  if (phase2Ctx && hasKidHeader(token)) {
    return applyRouteGuards(await verifyPhase2SessionCookie(token, phase2Ctx), req);
  }

  let claims: AuthClaims;
  let wasLegacy: boolean;
  try {
    ({ claims, wasLegacy } = await verifyTokenStrict(token));
  } catch (err) {
    log.error({ err }, "JWT verification error");
    const isExpired = err instanceof errors.JWTExpired;
    return {
      ok: false,
      status: 401,
      error: isExpired ? "Token expired" : "Invalid or expired token",
      wwwAuthenticate: `Bearer realm="mcp-coordinator", error="${isExpired ? "expired_token" : "invalid_token"}"`,
    };
  }

  // The "internal" role is valid ONLY for the MQTT authenticate hook
  // (mqtt-broker.ts, via wireMqtt's verifyTokenStrict call) — never for
  // REST/MCP. Reject it here with the same shape as an invalid token so a
  // leaked bridge token (which can now travel a real network via the
  // external-broker option) carries no REST/MCP privilege.
  if (claims.role === "internal") {
    return {
      ok: false,
      status: 401,
      error: "Invalid or expired token",
      wwwAuthenticate: 'Bearer realm="mcp-coordinator", error="invalid_token"',
    };
  }

  // Scenario (c): v0.6 token (wasLegacy=true) under AUTH_ENABLED=true → reject
  if (wasLegacy && authEnabled) {
    return {
      ok: false,
      status: 401,
      error: "v0.6 token rejected: upgrade required (AUTH_ENABLED=true)",
      wwwAuthenticate: 'Bearer realm="mcp-coordinator", error="invalid_token"',
    };
  }

  // Scenario (c) AUTH_ENABLED=false or Scenario (d): proceed with claims
  return applyRouteGuards({ ok: true, claims }, req);
}
