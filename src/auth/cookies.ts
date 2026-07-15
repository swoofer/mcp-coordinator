import { parseCookie, stringifySetCookie } from "cookie";
import type { IncomingMessage, ServerResponse } from "node:http";

// Canonical cookie names for Phase 2 session + CSRF. Exported here so
// src/auth.ts, src/auth/logout.ts, src/auth/oauth-finalize.ts,
// src/auth/device-flow.ts, and test helpers all reference one source of
// truth (eliminates 4-way string-literal drift; see v0.10.6 Round 1 finding).
// The __Host- prefix is load-bearing — see hostCookie() below.
export const SESSION_COOKIE_NAME = "__Host-coordinator_session";
export const CSRF_COOKIE_NAME = "__Host-coordinator_csrf";

export interface CookieAttrs {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  path?: string;
  domain?: string;
  maxAge?: number;
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  // cookie.parse returns Record<string, string | undefined>; the package may
  // assign undefined for malformed entries. Filter to give callers a cleaner
  // contract (no `| undefined` propagating through call sites).
  const raw = parseCookie(header);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function serializeCookie(name: string, value: string, attrs: CookieAttrs): string {
  return stringifySetCookie({
    name,
    value,
    httpOnly: attrs.httpOnly,
    secure: attrs.secure,
    // Downcast safe because CookieAttrs.sameSite is constrained upstream to
    // the three PascalCase variants; cookie accepts the lowercase form.
    sameSite: attrs.sameSite?.toLowerCase() as "strict" | "lax" | "none" | undefined,
    path: attrs.path,
    domain: attrs.domain,
    maxAge: attrs.maxAge,
  });
}

// __Host- prefix enforces Secure + Path=/ + no Domain (RFC 6265bis-13 §4.1.3).
// Rejecting bad names here catches caller mistakes at the first Set-Cookie
// attempt rather than at browser-side silent drop.
export function hostCookie(
  name: string,
  value: string,
  opts: Pick<CookieAttrs, "httpOnly" | "sameSite" | "maxAge">,
): string {
  if (!name.startsWith("__Host-")) {
    throw new Error(`hostCookie requires __Host- prefix; got ${name}`);
  }
  return serializeCookie(name, value, {
    httpOnly: opts.httpOnly,
    secure: true,
    sameSite: opts.sameSite,
    path: "/",
    // domain intentionally omitted — __Host- forbids the Domain attribute.
    maxAge: opts.maxAge,
  });
}

// Append cookies to existing Set-Cookie header without clobbering. Node's
// http.ServerResponse requires array form for multiple Set-Cookie values;
// replacing a single string via setHeader would drop prior cookies.
export function setCookies(res: ServerResponse, cookies: string[]): void {
  if (cookies.length === 0) return;
  const existing = res.getHeader("Set-Cookie");
  let merged: string[];
  if (Array.isArray(existing)) {
    merged = [...existing, ...cookies];
  } else if (typeof existing === "string") {
    merged = [existing, ...cookies];
  } else {
    merged = cookies;
  }
  res.setHeader("Set-Cookie", merged);
}

// securite-auth-05: NOT currently wired into hostCookie() below. hostCookie()
// hardcodes `secure: true` unconditionally because every Phase 2 cookie
// (SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, STATE_COOKIE_NAME) is __Host--
// prefixed, and RFC 6265bis §4.1.3 requires __Host- cookies to always carry
// Secure — dropping it based on this flag would produce a cookie the
// __Host- prefix contract forbids. This function is kept for a future
// non-__Host- cookie type that could legitimately honor the flag; today,
// setting COORDINATOR_INSECURE_COOKIES=true has NO effect on any cookie the
// server actually sets. See boot.ts:warnOnInsecureCookiesFlag for the boot-
// time warning that disarms the resulting footgun, and .env.example for the
// operator-facing doc of what the flag actually does (bypasses the
// COORDINATOR_PUBLIC_URL http://-non-localhost boot check — nothing more).
export function getCookieSecureFlag(): boolean {
  return process.env.COORDINATOR_INSECURE_COOKIES !== "true";
}
