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

// NOTE: Task 11 will UPDATE this function to use verifyTokenStrict and gate on
// wasLegacy when AUTH_ENABLED is true (prevents silent v0.6→v0.7 token rotation).
export async function refreshToken(
  token: string,
  gracePeriod = "1h",
): Promise<string> {
  let claims: AuthClaims;
  try {
    claims = await verifyToken(token);
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      const verifyWith = async (key: Uint8Array) =>
        jwtVerify(token, key, { clockTolerance: gracePeriod, algorithms: ["HS256"] });
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
      const role = payload.role;
      if (role !== "agent" && role !== "admin" && role !== "member") {
        throw new Error("Invalid role in token");
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

export async function authenticateRequest(req: IncomingMessage): Promise<AuthResult> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "Missing or invalid Authorization header",
      wwwAuthenticate: 'Bearer realm="mcp-coordinator", error="invalid_token"',
    };
  }

  const token = authHeader.slice(7);
  let claims: AuthClaims;
  try {
    claims = await verifyToken(token);
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
