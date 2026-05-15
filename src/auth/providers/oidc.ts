import { z } from "zod";
import {
  createRemoteJWKSet,
  jwtVerify,
  errors as joseErrors,
  type JWTPayload,
} from "jose";
import type {
  IdPProvider,
  ExchangeCodeResult,
  IdpUserInfo,
} from "./types.js";
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
  /** Optional discovery doc override for tests; otherwise auto-fetched. */
  discoveryUrl?: string;
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

export class OIDCProvider implements IdPProvider {
  readonly name: string;
  private readonly discoveryUrl: string;
  private cachedDiscovery: DiscoveryDoc | null = null;
  private cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly cfg: OIDCProviderConfig) {
    this.name = cfg.name ?? "oidc";
    // RFC: discovery doc lives at `<issuer>/.well-known/openid-configuration`.
    // Some issuers (Keycloak realms) terminate the issuer URL without a
    // trailing slash; normalize so concatenation is idempotent.
    const normalizedIssuer = cfg.issuerUrl.replace(/\/$/, "");
    this.discoveryUrl =
      cfg.discoveryUrl ?? `${normalizedIssuer}/.well-known/openid-configuration`;
  }

  async buildAuthUrl(
    state: string,
    redirectUri: string,
    codeChallenge?: string,
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
    return u.toString();
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
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
      });
    } catch {
      throw new IdPTransientError("OIDC token endpoint unreachable");
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

    // Email is OPTIONAL in OIDC core (some providers require explicit
    // "email" scope; some IdPs like Azure AD ship `email` only when
    // the user has a verified email). The coordinator's user model
    // requires a usable identifier -- prefer email, fall back to
    // preferred_username, fall back to sub. Operators wanting
    // strict-email mode can subclass and override.
    const email =
      claims.email ?? claims.preferred_username ?? claims.sub;

    const user: IdpUserInfo = {
      idp_user_id: claims.sub,
      email,
      ...(claims.name !== undefined ? { name: claims.name } : {}),
    };
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

    // Cross-check: the discovery doc's own `issuer` MUST equal the
    // configured issuer (RFC OpenID Connect Discovery 1.0 §4.3). A
    // mismatch indicates a misconfigured deployment OR a redirect
    // attack against the discovery URL itself.
    if (parsed.issuer !== this.cfg.issuerUrl) {
      throw new Error(
        `OIDC discovery issuer mismatch: expected ${this.cfg.issuerUrl}, got ${parsed.issuer}`,
      );
    }

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
