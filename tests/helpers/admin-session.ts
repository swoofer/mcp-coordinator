import { mintAccessJWT } from "../../src/auth/jwt-mint.js";
import type { AccessTokenClaims } from "../../src/auth/jwt-mint.js";
import { generateCsrfToken } from "../../src/auth/csrf.js";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  hostCookie,
} from "../../src/auth/cookies.js";
import type { JwtKeyRegistry } from "../../src/auth/jwt-keys.js";

/**
 * Test helper: construct a valid Phase 2 admin session (JWT + cookies + CSRF
 * token) without going through the OAuth flow. Returned strings are ready to
 * attach to fetch/supertest requests.
 *
 * The DB must already have the user row inserted (caller's responsibility —
 * via tests/helpers/seed.ts or direct db.prepare INSERT). This helper only
 * mints the session-cookie credential the auth dispatcher will accept on
 * Scenario 5 (cookie-based JWT auth, src/auth.ts §verifyPhase2SessionCookie).
 *
 * Cookie names are the canonical constants exported from src/auth/cookies.ts.
 */

export interface AdminSession {
  userId: string;
  orgId: string;
  role: "admin" | "member";
  jwt: string;
  /** Raw CSRF token value (the cookie value AND the X-CSRF-Token header value). */
  csrfCookieValue: string;
  /** Individual Set-Cookie-style strings (useful for tests that want each cookie separately). */
  cookies: {
    session: string;
    csrf: string;
  };
  /** Ready-to-send Cookie request header: both cookies joined with "; ". */
  cookieHeader: string;
  /** Value to send as X-CSRF-Token header (matches csrfCookieValue for double-submit). */
  csrfHeader: string;
}

export interface MakeAdminSessionOptions {
  userId: string;
  orgId: string;
  /** Same registry the verifier uses — typically built via buildJwtKeyRegistry(secret). */
  registry: JwtKeyRegistry;
  /** Issuer string — must equal ctx.publicUrl on the verifier (trailing slash stripped). */
  issuer: string;
  role?: "admin" | "member";
  /** Family id for the access JWT. Defaults to a deterministic test value. */
  familyId?: string;
  /** TTL in seconds. Defaults to 900 (15 min — matches V4 default). */
  ttlSeconds?: number;
}

/**
 * Mint a fresh admin session and return cookies + headers ready to attach
 * to test HTTP requests.
 *
 * Defaults: role="admin", familyId="fam-test", ttlSeconds=900.
 */
export async function makeAdminSession(
  opts: MakeAdminSessionOptions,
): Promise<AdminSession> {
  const role = opts.role ?? "admin";
  const familyId = opts.familyId ?? "fam-test";
  const ttlSeconds = opts.ttlSeconds ?? 900;

  const claims: AccessTokenClaims = {
    sub: opts.userId,
    active_org_id: opts.orgId,
    family_id: familyId,
    role,
  };

  const jwt = await mintAccessJWT({
    claims,
    registry: opts.registry,
    issuer: opts.issuer,
    ttlSeconds,
  });
  const csrfCookieValue = generateCsrfToken();

  // hostCookie enforces __Host- prefix + Secure + Path=/ + no Domain.
  // Session cookie is HttpOnly (JWT must not be JS-readable, per spec §9.5).
  // CSRF cookie is NOT HttpOnly (JS reads it to send in X-CSRF-Token header).
  const sessionCookie = hostCookie(SESSION_COOKIE_NAME, jwt, {
    httpOnly: true,
    sameSite: "Strict",
    maxAge: ttlSeconds,
  });
  const csrfCookie = hostCookie(CSRF_COOKIE_NAME, csrfCookieValue, {
    httpOnly: false,
    sameSite: "Strict",
    maxAge: ttlSeconds,
  });

  // Cookie request header is just name=value pairs joined by "; " — no attrs.
  const cookieHeader =
    `${SESSION_COOKIE_NAME}=${jwt}; ${CSRF_COOKIE_NAME}=${csrfCookieValue}`;

  return {
    userId: opts.userId,
    orgId: opts.orgId,
    role,
    jwt,
    csrfCookieValue,
    cookies: { session: sessionCookie, csrf: csrfCookie },
    cookieHeader,
    csrfHeader: csrfCookieValue,
  };
}
