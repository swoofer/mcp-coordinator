import type { ServerResponse } from "node:http";

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape the 5 HTML special chars (RFC 3986 §2.2 + HTML attribute safety).
 * Coerces any input to string via String(...). Use this on every
 * untrusted value before embedding in markup.
 */
export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]!);
}

/**
 * Render a template with `${key}` placeholders, auto-escaping every
 * interpolation. Missing keys render as empty string. The template is
 * trusted; only `ctx` values are escaped.
 *
 *   render("<p>${msg}</p>", { msg: "<b>hi</b>" })
 *     → "<p>&lt;b&gt;hi&lt;/b&gt;</p>"
 *
 * Keys are ASCII identifier-style: [A-Za-z_][A-Za-z0-9_]*. Non-matching
 * tokens pass through unmodified (so literal "${" can appear if not
 * followed by an identifier-style placeholder).
 */
export function render(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    return escapeHtml(ctx[key] ?? "");
  });
}

/**
 * Send a HTML response with the Phase 2 security header bundle:
 * - Content-Security-Policy: lock down script + frame + form-action
 * - X-Frame-Options: DENY (defense-in-depth alongside CSP frame-ancestors)
 * - Referrer-Policy: no-referrer
 * - Cache-Control: no-store (auth pages must not be cached)
 */
export function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  res.end(body);
}
