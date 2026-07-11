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
 * Google OAuth 2.0 / OIDC provider. Phase 4 piece brought forward in
 * v0.9.0 (T47). Web-flow only -- device code is not currently
 * implemented because Google's device-code flow is a CLI-experience
 * problem the coordinator does not yet solve.
 *
 * Trust model:
 *   - Token exchange happens at the standard Google endpoint over TLS.
 *   - The id_token signature is verified against Google's JWKS using
 *     RS256; iss must equal "https://accounts.google.com" and aud must
 *     equal our client_id. This is mandatory per the SaaS-ready design
 *     §I -- skipping id_token verification would let a token issued
 *     for another Google relying party impersonate users here.
 *   - The id_token claims (sub, email, name, hd) are the authoritative
 *     source of user identity; we do NOT make an additional /userinfo
 *     round-trip because the verified id_token already gives us
 *     everything we need and adds one fewer point of failure.
 *
 * Allowlist:
 *   - Google has no GitHub-org equivalent. listMemberships throws
 *     IdPTransientError-shaped errors are NOT raised here -- the
 *     missing-implementation case is a deployment bug, not a transient
 *     failure. Operators wiring up Google should set the org's
 *     allowlist_github_org column to the Workspace hosted-domain
 *     (`hd` claim) and resolve via that. Schema-level hosted-domain
 *     support lands with T48 / v0.10.
 */
export interface GoogleProviderConfig {
  clientId: string;
  clientSecret: string;
  /** Optional override for tests; defaults to the public Google JWKS. */
  jwksUrl?: string;
  /** Optional override for tests; defaults to the public Google issuer. */
  issuer?: string;
  /** Optional override for tests; defaults to the public Google token endpoint. */
  tokenUrl?: string;
  /** Optional override for tests; defaults to accounts.google.com authorize. */
  authorizeUrl?: string;
}

const DEFAULT_ISSUER = "https://accounts.google.com";
const DEFAULT_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

const SCOPE = "openid email profile";
const REQUEST_TIMEOUT_MS = 5000;

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
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  // Google Workspace hosted-domain claim. Present iff the user signed
  // in via a Workspace tenant; used by hd-based allowlist deployments
  // (T48). Absent for personal @gmail.com accounts.
  hd: z.string().optional(),
});

export class GoogleProvider implements IdPProvider {
  readonly name = "google";
  /** T56: Google's allowlist is driven by the Workspace `hd` claim
   *  surfaced as `IdpUserInfo.idp_org_id`. listMemberships throws on
   *  this provider because Google has no GitHub-org equivalent, so
   *  the strategy MUST be "idp_org_id" for sign-in to work. */
  readonly allowlistStrategy = "idp_org_id" as const;
  private readonly issuer: string;
  private readonly authorizeUrl: string;
  private readonly tokenUrl: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly cfg: GoogleProviderConfig) {
    this.issuer = cfg.issuer ?? DEFAULT_ISSUER;
    this.authorizeUrl = cfg.authorizeUrl ?? DEFAULT_AUTHORIZE_URL;
    this.tokenUrl = cfg.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.jwks = createRemoteJWKSet(new URL(cfg.jwksUrl ?? DEFAULT_JWKS_URL));
  }

  buildAuthUrl(
    state: string,
    redirectUri: string,
    codeChallenge?: string,
    nonce?: string,
  ): string {
    const u = new URL(this.authorizeUrl);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("scope", SCOPE);
    u.searchParams.set("response_type", "code");
    // access_type=online: we don't need long-lived refresh against
    // Google directly -- the coordinator mints its own refresh family
    // and only re-checks Google membership opportunistically.
    u.searchParams.set("access_type", "online");
    if (codeChallenge) {
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
    }
    // securite-auth-02: OIDC nonce (Core 1.0 §3.1.2.1), mirrors
    // OIDCProvider.buildAuthUrl (oidc.ts). Bound to the oauth_state row
    // by the caller; verified against id_token.nonce in exchangeCode.
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
      res = await fetch(this.tokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Network error / timeout. Treat as transient so the caller can
      // surface a 503 rather than a 500.
      throw new IdPTransientError("Google token endpoint unreachable");
    }

    if (res.status === 401) throw new IdPTokenRevoked();
    if (res.status >= 500 && res.status < 600) {
      throw new IdPTransientError(`Google token endpoint ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`Google token exchange failed: HTTP ${res.status}`);
    }

    const json = await res.json();
    const token = TokenResponseSchema.parse(json);

    // Verify id_token: RS256 only, iss must match, aud must match our
    // client_id. jose looks up the signing key by `kid` from the JWKS
    // and rejects anything that fails. Any verification failure maps
    // to IdPTokenRevoked because the practical outcome -- the token we
    // were just given is not usable -- is identical to a server-side
    // revocation from the caller's perspective.
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token.id_token, this.jwks, {
        issuer: this.issuer,
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
        // JWKS itself unreachable / malformed: transient.
        throw new IdPTransientError("Google JWKS unavailable");
      }
      // Signature mismatch, expired, wrong issuer/audience, wrong alg:
      // the token is structurally invalid for our deployment.
      throw new IdPTokenRevoked();
    }

    const claims = IdTokenClaimsSchema.parse(payload);

    // securite-auth-02: nonce check, mirrors OIDCProvider.exchangeCode
    // (oidc.ts). If the caller passed a nonce (the standard path from
    // oauth-login -> oauth_state.nonce -> oauth-callback), it MUST
    // match the id_token's nonce claim. Mismatch/absence indicates a
    // replayed id_token issued for a different authorize request.
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

    const user: IdpUserInfo = {
      idp_user_id: claims.sub,
      email: claims.email,
      ...(claims.name !== undefined ? { name: claims.name } : {}),
      ...(claims.hd !== undefined ? { idp_org_id: claims.hd } : {}),
    };
    return { user, accessToken: token.access_token };
  }

  /**
   * Google has no GitHub-orgs equivalent. Deployments using Google for
   * sign-in must drive their allowlist off the user's hosted-domain
   * (`hd`) claim, surfaced as `idp_org_id` on IdpUserInfo. Native hd
   * support in `orgs.allowlist_*` lands in T48.
   *
   * Throwing here is a deliberate fail-fast: a hypothetical
   * deployment that registers GoogleProvider AND relies on the
   * Phase 2 listMemberships allowlist code path will get a clear
   * stack trace instead of a silent empty-memberships denial.
   */
  async listMemberships(_accessToken: string): Promise<string[]> {
    throw new Error(
      "GoogleProvider.listMemberships is not supported; configure hd-based allowlist instead",
    );
  }
}
