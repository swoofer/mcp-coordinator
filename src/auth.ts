import { SignJWT, jwtVerify, errors } from "jose";
import { randomUUID } from "crypto";
import type { IncomingMessage } from "http";
import { getDb } from "./database.js";
import { silentLogger, type Logger } from "./logger.js";

let signingKey: Uint8Array;
let prevKey: Uint8Array | null = null;
let defaultExpiry = "24h";
let log: Logger = silentLogger;

export function setAuthLogger(logger: Logger): void {
  log = logger;
}

export type AuthRole = "agent" | "admin" | "member";

export interface AuthClaims {
  sub: string;
  user_id: string;
  org: string;
  role: AuthRole;
  jti: string;
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

export async function verifyTokenStrict(token: string): Promise<{ claims: AuthClaims; wasLegacy: boolean }> {
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
  const rawRole = payload.role;
  const role: AuthRole =
    rawRole === "agent" || rawRole === "admin" || rawRole === "member"
      ? rawRole
      : "member";
  // v0.7 detection: BOTH user_id AND org must be present strings.
  const hasV07 = typeof payload.user_id === "string" && typeof payload.org === "string";
  return {
    claims: {
      sub: payload.sub, role,
      user_id: typeof payload.user_id === "string" ? payload.user_id : "legacy",
      org: typeof payload.org === "string" ? payload.org : "default",
      jti: typeof payload.jti === "string" ? payload.jti : randomUUID(),
    },
    wasLegacy: !hasV07,
  };
}

export async function refreshToken(
  token: string,
  options?: AuthenticateOptions,
  gracePeriod?: string,
): Promise<string> {
  const authEnabled = options?.authEnabled ?? false;
  const grace = gracePeriod ?? "1h";

  let claims: AuthClaims;
  try {
    const { claims: c, wasLegacy } = await verifyTokenStrict(token);
    if (wasLegacy && authEnabled) {
      throw new Error("v0.6 token rejected: upgrade required (AUTH_ENABLED=true)");
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
      // Tolerate missing/unknown role on v0.6 tokens. Default to 'member' (LEAST PRIVILEGE).
      const rawRole = payload.role;
      const role: AuthRole =
        rawRole === "agent" || rawRole === "admin" || rawRole === "member"
          ? rawRole
          : "member";
      const hasV07 = typeof payload.user_id === "string" && typeof payload.org === "string";
      if (!hasV07 && authEnabled) {
        throw new Error("v0.6 token rejected: upgrade required (AUTH_ENABLED=true)");
      }
      claims = {
        sub: payload.sub, role,
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

export function isRevoked(agentId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM revoked_agents WHERE agent_id = ?").get(agentId);
  return !!row;
}

export function revokeAgent(agentId: string, revokedBy: string): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO revoked_agents (agent_id, revoked_by) VALUES (?, ?)").run(agentId, revokedBy);
}

const ADMIN_ONLY_ROUTES = ["/api/auth/revoke", "/api/reset"];

export type AuthResult =
  | { ok: true; claims: AuthClaims }
  | { ok: false; status: 401 | 403; error: string; wwwAuthenticate?: string };

export async function authenticateRequest(req: IncomingMessage, options: AuthenticateOptions = { authEnabled: true }): Promise<AuthResult> {
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
  if (isRevoked(claims.sub)) {
    return { ok: false, status: 403, error: "Agent has been revoked" };
  }

  const url = req.url || "";
  // Strip query string and hash before matching — "/api/reset?x=1" must hit the check
  const pathOnly = url.split(/[?#]/)[0];
  if (ADMIN_ONLY_ROUTES.some((r) => pathOnly === r) && claims.role !== "admin") {
    return { ok: false, status: 403, error: "Admin access required" };
  }

  return { ok: true, claims };
}
