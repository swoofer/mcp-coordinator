import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Build the RFC 8414 OAuth 2.0 Authorization Server Metadata document.
 * All endpoint URLs are derived from `publicUrl` (env COORDINATOR_PUBLIC_URL,
 * validated at boot in T29). Trailing slash defensively stripped.
 *
 * token_endpoint_auth_methods_supported = ["none"] per V4 FIX 12:
 * coordinator's own clients (CLI + browser) are public OAuth 2.1 clients;
 * no client_secret is required when calling the token endpoint.
 */
export function buildDiscoveryDoc(publicUrl: string): Record<string, unknown> {
  const base = publicUrl.replace(/\/$/, "");
  return {
    issuer: base,
    token_endpoint: `${base}/api/auth/oauth/token`,
    device_authorization_endpoint: `${base}/api/auth/oauth/device_authorization`,
    revocation_endpoint: `${base}/api/auth/revoke`,
    userinfo_endpoint: `${base}/api/auth/me`,
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    // RFC 8414 section 2 requires authorization_endpoint only "unless no grant
    // types are supported that use the authorization endpoint", and requires
    // response_types_supported unconditionally. This coordinator has no
    // authorization endpoint of its own: /auth/login drives the upstream IdP
    // and discards every OAuth parameter the caller sends (issue #307). So the
    // endpoint is omitted and the response types it would have offered are empty.
    // authorization_code stays advertised: it is a real, completable grant at the
    // token endpoint for a client that drives the IdP itself.
    response_types_supported: [],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${base}/docs/oauth-setup`,
    id_token_signing_alg_values_supported: ["HS256"],
  };
}

/**
 * HTTP handler for /.well-known/oauth-authorization-server. Accepts
 * publicUrl as parameter so callers don't reach into process.env directly
 * (per T44 getOrgSetting shim discipline; T29 boot composes this).
 */
export function handleDiscovery(
  _req: IncomingMessage,
  res: ServerResponse,
  publicUrl: string,
): void {
  const doc = buildDiscoveryDoc(publicUrl);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=86400",
  });
  res.end(JSON.stringify(doc));
}
