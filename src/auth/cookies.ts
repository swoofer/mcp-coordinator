import { parse, serialize } from "cookie";
import type { IncomingMessage, ServerResponse } from "node:http";

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
  const raw = parse(header);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function serializeCookie(name: string, value: string, attrs: CookieAttrs): string {
  return serialize(name, value, {
    httpOnly: attrs.httpOnly,
    secure: attrs.secure,
    // Downcast safe because CookieAttrs.sameSite is constrained upstream to
    // the three PascalCase variants; cookie@1 accepts the lowercase form.
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
    merged = [...(existing as string[]), ...cookies];
  } else if (typeof existing === "string") {
    merged = [existing, ...cookies];
  } else {
    merged = cookies;
  }
  res.setHeader("Set-Cookie", merged);
}

// Escape hatch for http:// non-localhost deployments behind an HTTPS reverse
// proxy. Defaults to true (Secure) so the safe path is the default. T29 boot
// validation emits the warning when this is flipped off.
export function getCookieSecureFlag(): boolean {
  return process.env.COORDINATOR_INSECURE_COOKIES !== "true";
}
