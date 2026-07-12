/**
 * Origin validation for /mcp (MCP Streamable HTTP transport).
 *
 * MCP spec MUST: servers MUST validate the `Origin` header on all incoming
 * connections to prevent DNS rebinding attacks. Browser-originated requests
 * always carry an `Origin` header; non-browser clients (curl, the MCP SDK's
 * own HTTP client, server-to-server calls) typically do not — those are not
 * subject to the browser same-origin model this check defends against, so
 * they are allowed through unconditionally.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  publicUrl: string | undefined,
): boolean {
  if (!origin) return true; // client non-navigateur (curl, SDK MCP) — pas d'en-tete Origin
  try {
    const u = new URL(origin);
    if (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "[::1]" ||
      u.hostname === "::1"
    )
      return true;
    if (publicUrl && origin === new URL(publicUrl).origin) return true;
  } catch {
    /* Origin malforme */
  }
  return false;
}
