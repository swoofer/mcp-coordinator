import { z } from "zod";
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload } from "jose";
import type { IdPProvider, ExchangeCodeResult, IdpUserInfo } from "./types.js";
import { IdPTokenRevoked, IdPTransientError } from "./errors.js";

/**
 * Generic OpenID Connect provider. Targets RFC 6749 + OpenID Connect
 * Discovery 1.0 (https://openid.net/specs/openid-connect-discovery-1_0.html).
 *
 * Verified against Okta, Auth0, Azure AD, Keycloak, and Authentik. Any
 * conformant OIDC implementer should work; configurations needing
 * non-standard tweaks (e.g. mandatory `prompt=login`) can vendor a
 * subclass.
 *
 * Trust model mirrors GoogleProvider (T47): id_token signature is
 * verified against the discovered JWKS using RS256; `iss` must match
 * the configured issuer; `aud` must match our client_id. Verification
 * failures map to IdPTokenRevoked; JWKS / discovery transport failures
 * map to IdPTransientError.
 *
 * Discovery doc is fetched lazily on first use and cached on the
 * instance for the process lifetime. OIDC issuers publish stable
 * endpoint URLs by contract; treating them as immutable matches the
 * RFC's "MAY be cached" wording while sidestepping a periodic
 * background refresh that this codebase has no scheduler for.
 *
 * Allowlist:
 *   - Generic OIDC has no consistent group / org mechanism (some IdPs
 *     publish `groups` claim, others use `realm_access.roles`, etc.).
 *     listMemberships throws fail-fast. Deployments that need an OIDC
 *     allowlist must either (a) front the coordinator with an
 *     authorizing proxy that filters at the IdP level, or (b) vendor
 *     a subclass that knows how to extract groups for their specific
 *     issuer.
 */
export interface OIDCProviderConfig {
  clientId: string;
  clientSecret: string;
  /** Issuer URL, MUST match the `iss` claim of returned id_tokens. */
  issuerUrl: string;
  /** Optional explicit name for the provider. Defaults to "oidc". */
  name?: string;
  /**
   * Origins the discovery document may point its endpoints at, beyond the
   * issuer's own (issue #304). Needed because real IdPs do split them:
   * Google issues from `accounts.google.com` but serves its token endpoint
   * from `oauth2.googleapis.com` and its JWKS from `www.googleapis.com`.
   *
   * Declaring the split is the operator's call and is visible in config —
   * unlike today, where the remote document decides silently.
   */
  extraAllowedOrigins?: readonly string[];
  /** Optional discovery doc override for tests; otherwise auto-fetched. */
  discoveryUrl?: string;
  /** T58 (v0.10.4): dot-notation path into the id_token where group
   *  / role memberships live. Common values:
   *    - "groups"              (Okta, Auth0, Authentik)
   *    - "realm_access.roles"  (Keycloak)
   *
   *  When set, OIDCProvider reads the array at this path from each
   *  verified id_token and populates IdpUserInfo.groups. The
   *  provider's allowlistStrategy switches to "id_token_groups"
   *  so the callback matches against orgs.allowlist_github_org.
   *
   *  Leave unset (default) to keep the original "none" strategy
   *  -- generic OIDC denies-by-default. */
  groupsClaim?: string;
}

interface DiscoveryDoc {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

const REQUEST_TIMEOUT_MS = 5000;
const SCOPE = "openid email profile";

const DiscoveryResponseSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  response_types_supported: z.array(z.string()).optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
});

const TokenResponseSchema = z.object({
  access_token: z.string(),
  id_token: z.string(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string(),
  refresh_token: z.string().optional(),
});

const IdTokenClaimsSchema = z.object({
  sub: z.string(),
  email: z.string().email().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  preferred_username: z.string().optional(),
});

/**
 * Endpoints a discovery document is allowed to name.
 *
 * issue #304: `getDiscovery` took `authorization_endpoint`, `token_endpoint`
 * and `jwks_uri` verbatim from the remote document, cross-checking only its
 * `issuer` field. That check is not a mitigation: whoever controls the
 * document controls `issuer` too, so it passes for free. A poisoned document
 * could therefore point `token_endpoint` at a collector and receive the
 * `client_secret`, the authorization code and the PKCE verifier — and point
 * `authorization_endpoint` at a phishing page that the user's own browser is
 * redirected to. The discovery result is cached for the process lifetime, so
 * one poisoned fetch persists until restart.
 *
 * The fix is the guard this repo already uses for GitHub pagination
 * (`parseNextLink` in github-shared.ts, whose comment names the same threat):
 * require the origin to be one we already trust. Not an IP-range denylist —
 * the collector in the reproduction sits on a public IP, so ranges would not
 * have stopped it.
 */
export function assertAllowedEndpointOrigin(
  label: string,
  endpoint: string,
  issuerUrl: string,
  extraAllowedOrigins: readonly string[] = [],
): void {
  let endpointOrigin: string;
  try {
    endpointOrigin = new URL(endpoint).origin;
  } catch {
    throw new Error(`OIDC discovery ${label} is not a valid URL: ${endpoint}`);
  }
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(issuerUrl).origin);
  } catch {
    throw new Error(`OIDC issuer URL is not a valid URL: ${issuerUrl}`);
  }
  for (const extra of extraAllowedOrigins) {
    let extraOrigin: string;
    try {
      extraOrigin = new URL(extra).origin;
    } catch {
      throw new Error(`COORDINATOR_OIDC_EXTRA_ORIGINS entry is not a valid URL: ${extra}`);
    }
    // A URL with no usable origin serialises to the literal string "null" —
    // and so do data:, file: and every other non-special scheme. Letting one
    // into the set would make it match ALL of them, turning a config typo
    // (writing `host:443`, which is how people spell an origin) into a
    // bypass. Found in adversarial review of this very guard.
    if (extraOrigin === "null") {
      throw new Error(
        `COORDINATOR_OIDC_EXTRA_ORIGINS entry has no usable origin: ${extra}. ` +
          `Write a full origin including the scheme, e.g. https://oauth2.googleapis.com`,
      );
    }
    allowed.add(extraOrigin);
  }
  // data:, file: and friends all serialise to "null". Refuse them before
  // any set membership question, so no allowlist entry can ever admit one.
  if (endpointOrigin === "null") {
    throw new Error(
      `OIDC discovery ${label} has no usable origin: ${endpoint}. ` +
        `Only http(s) endpoints are accepted.`,
    );
  }
  if (!allowed.has(endpointOrigin)) {
    throw new Error(
      `OIDC discovery ${label} points at ${endpointOrigin}, which is not the issuer's origin ` +
        `(${[...allowed].join(", ")}). Refusing: a discovery document that names a foreign ` +
        `origin can redirect the client_secret or the user's browser. If this IdP legitimately ` +
        `splits its endpoints, declare the origin in COORDINATOR_OIDC_EXTRA_ORIGINS.`,
    );
  }
}
export class OIDCProvider implements IdPProvider {
  readonly name: string;
  /** T56 + T58: defaults to "none" (generic OIDC denies-by-default).
   *  When `groupsClaim` is configured, switches to "id_token_groups"
   *  so the callback matches IdpUserInfo.groups against
   *  orgs.allowlist_github_org. */
  readonly allowlistStrategy: "none" | "id_token_groups";
  private readonly discoveryUrl: string;
  private cachedDiscovery: DiscoveryDoc | null = null;
  private cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly cfg: OIDCProviderConfig) {
    this.name = cfg.name ?? "oidc";
    this.allowlistStrategy = cfg.groupsClaim ? "id_token_groups" : "none";
    // RFC: discovery doc lives at `<issuer>/.well-known/openid-configuration`.
    // Some issuers (Keycloak realms) terminate the issuer URL without a
    // trailing slash; normalize so concatenation is idempotent.
    const normalizedIssuer = cfg.issuerUrl.replace(/\/$/, "");
    this.discoveryUrl = cfg.discoveryUrl ?? `${normalizedIssuer}/.well-known/openid-configuration`;
  }

  async buildAuthUrl(
    state: string,
    redirectUri: string,
    codeChallenge?: string,
    nonce?: string,
  ): Promise<string> {
    const disco = await this.getDiscovery();
    const u = new URL(disco.authorizationEndpoint);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("scope", SCOPE);
    u.searchParams.set("response_type", "code");
    if (codeChallenge) {
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
    }
    // T55: OIDC nonce (Core 1.0 §3.1.2.1). Bound to the oauth_state
    // row by the caller; verified against id_token.nonce in
    // exchangeCode. The caller (oauth-login) MUST pass a value for
    // OIDC providers; absence here is a misconfiguration upstream
    // and lets the IdP fall through to nonce-less behaviour rather
    // than failing closed -- acceptable because state binding + PKCE
    // already provide proof-of-possession.
    if (nonce) {
      u.searchParams.set("nonce", nonce);
    }
    return u.toString();
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
    nonce?: string | null,
  ): Promise<ExchangeCodeResult> {
    const disco = await this.getDiscovery();
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    if (codeVerifier) body.set("code_verifier", codeVerifier);

    let res: Response;
    try {
      res = await fetch(disco.tokenEndpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // issue #304: the origin guard binds the URL the discovery document
        // NAMES, not where the request ends up. fetch defaults to
        // redirect: "follow", and a 307 or 308 re-issues the POST with method
        // and body intact — so an allowlisted token endpoint that redirects
        // hands this body, client_secret included, to the redirect target.
        // Reproduced: 307/308 leak it, 302/303 downgrade to GET and drop it.
        //
        // This needs no attacker to bite. An IdP that 308s /token to a
        // regional host would ship the secret to an origin the operator never
        // declared, while the guard reported success. Fail closed instead: a
        // token endpoint that redirects is a deployment to fix, not to follow.
        redirect: "error",
      });
    } catch {
      throw new IdPTransientError(
        "OIDC token endpoint unreachable, or it answered with a redirect (refused: see issue #304)",
      );
    }

    if (res.status === 401) throw new IdPTokenRevoked();
    if (res.status >= 500 && res.status < 600) {
      throw new IdPTransientError(`OIDC token endpoint ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`OIDC token exchange failed: HTTP ${res.status}`);
    }

    const token = TokenResponseSchema.parse(await res.json());

    // Verify id_token. Same envelope as GoogleProvider: iss must match
    // the configured issuer (RFC 7517 §3.1.3.7), aud must match our
    // client_id, signature must be RS256 against a JWK present in the
    // discovered JWKS. Any failure -> IdPTokenRevoked; JWKS transport
    // failures -> IdPTransientError.
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token.id_token, this.getJwks(disco), {
        issuer: this.cfg.issuerUrl,
        audience: this.cfg.clientId,
        algorithms: ["RS256"],
      });
      payload = result.payload;
    } catch (err) {
      if (
        err instanceof joseErrors.JWKSNoMatchingKey ||
        err instanceof joseErrors.JWKSMultipleMatchingKeys ||
        err instanceof joseErrors.JWKSInvalid
      ) {
        throw new IdPTransientError("OIDC JWKS unavailable");
      }
      throw new IdPTokenRevoked();
    }

    const claims = IdTokenClaimsSchema.parse(payload);

    // T55: nonce check. If the caller passed a nonce (the standard
    // path from oauth-login -> oauth_state.nonce -> oauth-callback),
    // it MUST match the id_token's nonce claim. Mismatch indicates
    // a replayed id_token issued for a different authorize request.
    //
    // If nonce is null/undefined, the caller is the CLI auth-code
    // grant (which predates per-state nonce tracking) and we skip
    // the check -- PKCE already provides proof-of-possession at the
    // exchange step, so absence of nonce verification narrows but
    // does not eliminate the residual risk.
    if (nonce !== undefined && nonce !== null) {
      // Read from the raw verified payload, not the zod-narrowed
      // `claims` (which strips unknown keys including `nonce`).
      const tokenNonce = (payload as { nonce?: unknown }).nonce;
      if (typeof tokenNonce !== "string" || tokenNonce !== nonce) {
        throw new IdPTokenRevoked();
      }
    }

    // Email is OPTIONAL in OIDC core (some providers require explicit
    // "email" scope; some IdPs like Azure AD ship `email` only when
    // the user has a verified email). The coordinator's user model
    // requires a usable identifier -- prefer email, fall back to
    // preferred_username, fall back to sub. Operators wanting
    // strict-email mode can subclass and override.
    const email = claims.email ?? claims.preferred_username ?? claims.sub;

    const user: IdpUserInfo = {
      idp_user_id: claims.sub,
      email,
      ...(claims.name !== undefined ? { name: claims.name } : {}),
    };

    // T58: extract groups from the verified id_token payload when
    // groupsClaim is configured. The path is dot-notation so
    // "realm_access.roles" (Keycloak) and "groups" (Okta / Auth0 /
    // Authentik) both work without per-IdP code branches. Missing
    // path / non-array value -> empty groups list, which makes the
    // allowlist match fail downstream -- caller is denied. That's
    // the right behaviour for misconfigured deployments.
    if (this.cfg.groupsClaim) {
      const groups = extractGroupsFromClaims(payload, this.cfg.groupsClaim);
      if (groups.length > 0) {
        user.groups = groups;
      }
    }

    return { user, accessToken: token.access_token };
  }

  /**
   * Generic OIDC has no portable group-membership model. Vendoring a
   * subclass that consumes the issuer-specific groups claim is the
   * intended extension point.
   */
  async listMemberships(_accessToken: string): Promise<string[]> {
    throw new Error(
      "OIDCProvider.listMemberships is not implemented; vendor a subclass that reads issuer-specific groups claims",
    );
  }

  /**
   * Fetch + cache the OIDC discovery document. Cache is process-lifetime
   * intentionally -- discovery URLs are stable per RFC, and we have no
   * scheduler to refresh. A boot redeploy is the implicit invalidator.
   */
  private async getDiscovery(): Promise<DiscoveryDoc> {
    if (this.cachedDiscovery !== null) return this.cachedDiscovery;

    let res: Response;
    try {
      res = await fetch(this.discoveryUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new IdPTransientError("OIDC discovery endpoint unreachable");
    }
    if (res.status >= 500 && res.status < 600) {
      throw new IdPTransientError(`OIDC discovery ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    }
    const parsed = DiscoveryResponseSchema.parse(await res.json());

    // Cross-check the discovery doc's own `issuer` against the configured one
    // (RFC OpenID Connect Discovery 1.0 §4.3). This catches a misconfigured
    // deployment or a redirect to a DIFFERENT issuer's document — and nothing
    // more. It is NOT a defence against a poisoned document (issue #304):
    // whoever controls the document controls this field too, so it passes for
    // free. The endpoint origins below are what actually constrains it.
    if (parsed.issuer !== this.cfg.issuerUrl) {
      throw new Error(
        `OIDC discovery issuer mismatch: expected ${this.cfg.issuerUrl}, got ${parsed.issuer}`,
      );
    }

    // issue #304: every endpoint the document names has to live on an origin
    // we already trust. Checked BEFORE caching, so a poisoned document is
    // never stored — the cache lives for the whole process.
    const extra = this.cfg.extraAllowedOrigins ?? [];
    assertAllowedEndpointOrigin(
      "authorization_endpoint",
      parsed.authorization_endpoint,
      this.cfg.issuerUrl,
      extra,
    );
    assertAllowedEndpointOrigin("token_endpoint", parsed.token_endpoint, this.cfg.issuerUrl, extra);
    assertAllowedEndpointOrigin("jwks_uri", parsed.jwks_uri, this.cfg.issuerUrl, extra);

    this.cachedDiscovery = {
      authorizationEndpoint: parsed.authorization_endpoint,
      tokenEndpoint: parsed.token_endpoint,
      jwksUri: parsed.jwks_uri,
    };
    return this.cachedDiscovery;
  }

  private getJwks(disco: DiscoveryDoc): ReturnType<typeof createRemoteJWKSet> {
    if (this.cachedJwks !== null) return this.cachedJwks;
    this.cachedJwks = createRemoteJWKSet(new URL(disco.jwksUri));
    return this.cachedJwks;
  }
}

/**
 * T58: walk dot-notation path through an id_token payload and
 * extract a string[] of groups. Returns `[]` for any "not really a
 * groups array" outcome (path missing, intermediate value not an
 * object, terminal value not an array, array contains non-strings).
 *
 * Non-string array entries are filtered rather than the whole
 * extraction failing -- this matches the "deny on misconfig"
 * stance: a broken IdP response produces an empty groups list which
 * fails the allowlist match downstream.
 *
 * Exported for unit-testing the path resolution independently of
 * the OIDC provider lifecycle.
 */
export function extractGroupsFromClaims(payload: unknown, claimPath: string): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  let cursor: unknown = payload;
  for (const segment of claimPath.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return [];
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (!Array.isArray(cursor)) return [];
  return cursor.filter((g): g is string => typeof g === "string");
}
