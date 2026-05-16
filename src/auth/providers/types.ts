export interface IdpUserInfo {
  idp_user_id: string;
  email: string;
  name?: string;
  idp_org_id?: string;
  /** T58 (v0.10.4): group / role memberships the IdP attests at
   *  sign-in time, when the provider has been configured to extract
   *  them. OIDCProvider reads this from the id_token's configured
   *  groups claim; other providers leave it undefined.
   *
   *  Used by the "id_token_groups" allowlist strategy: each entry
   *  is a candidate match against orgs.allowlist_github_org
   *  (case-insensitive). The semantic re-purposes that column for
   *  group names; operators wanting OIDC sign-in put their group
   *  names there. See docs/idp-providers.md "Configuring generic
   *  OIDC" -> "Allowlist via id_token groups claim". */
  groups?: string[];
}

export interface ExchangeCodeResult {
  user: IdpUserInfo;
  accessToken: string;
  /** Seconds-until-expiry of `accessToken`, when the IdP advertises one
   *  (e.g. GitHub App user-to-server tokens: 28800 = 8h). OAuth App
   *  tokens have no expiry; omit. */
  accessTokenExpiresIn?: number;
  /** Refresh token, when the IdP returns one (GitHub Apps always do;
   *  OAuth Apps don't). Stored in `users.idp_refresh_token` so
   *  refresh-rotation can call `IdPProvider.refreshIdpToken` to mint a
   *  fresh access token on 401. */
  refreshToken?: string;
  /** Seconds-until-expiry of the refresh token. After this window the
   *  user must re-authorize from scratch (GitHub Apps: 6mo). */
  refreshTokenExpiresIn?: number;
}

/**
 * Result of an IdP refresh-token exchange. The provider returns a
 * fresh access token (and possibly a rotated refresh token) which
 * the caller stores in `users.idp_access_token` /
 * `users.idp_refresh_token` before retrying the original API call.
 */
export interface IdpRefreshResult {
  accessToken: string;
  accessTokenExpiresIn?: number;
  refreshToken?: string;
  refreshTokenExpiresIn?: number;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export type DevicePollResult =
  | { status: "authorization_pending" }
  | { status: "slow_down"; new_interval: number }
  | { status: "expired_token" }
  | { status: "access_denied" }
  | ({ status: "granted" } & ExchangeCodeResult);

/**
 * How the coordinator should look up the user's org allowlist match.
 *
 *   "memberships" -- call provider.listMemberships(accessToken), match
 *                    against orgs.allowlist_github_org (the default;
 *                    GitHub OAuth App + GitHub App)
 *   "idp_org_id"  -- skip the memberships round-trip; match
 *                    IdpUserInfo.idp_org_id directly against
 *                    orgs.allowlist_idp_org_id (T56, v0.10.2;
 *                    GoogleProvider's `hd` claim is the canonical case)
 *   "none"        -- the provider has no portable allowlist model;
 *                    deployments wanting to use it must vendor a
 *                    subclass that overrides the strategy (generic
 *                    OIDCProvider's default)
 */
export type AllowlistStrategy =
  | "memberships"
  | "idp_org_id"
  | "id_token_groups"
  | "none";

export interface IdPProvider {
  readonly name: string;
  /** T56: declares how the callback should look up the org allowlist
   *  match for users from this provider. Default behaviour (when
   *  omitted) is "memberships" -- matches the Phase 2 semantics. */
  readonly allowlistStrategy?: AllowlistStrategy;
  /** Build the IdP's authorize URL. `nonce` (T55, v0.10.1) is OIDC's
   *  defence-in-depth against id_token replay; OIDC providers MUST
   *  include it in the URL and verify it at exchangeCode time.
   *  Non-OIDC providers ignore it. */
  buildAuthUrl(state: string, redirectUri: string, codeChallenge?: string, nonce?: string): string | Promise<string>;
  /** Exchange the IdP authorization code for tokens. `nonce` is the
   *  value passed to buildAuthUrl, read back from the oauth_state row;
   *  OIDC providers verify the id_token's `nonce` claim against it. */
  exchangeCode(code: string, redirectUri: string, codeVerifier?: string, nonce?: string | null): Promise<ExchangeCodeResult>;
  listMemberships?(accessToken: string): Promise<string[]>;
  requestDeviceCode?(): Promise<DeviceCodeResponse>;
  pollDeviceToken?(deviceCode: string): Promise<DevicePollResult>;
  /** Exchange a refresh token for a fresh access token (and possibly a
   *  rotated refresh token). Implemented only by providers whose IdP
   *  returns expiring access tokens with refresh -- currently
   *  GitHubAppProvider (T53). On 401/invalid_grant from the IdP,
   *  implementations MUST throw IdPTokenRevoked so refresh-rotation
   *  treats the row as evicted. */
  refreshIdpToken?(refreshToken: string): Promise<IdpRefreshResult>;
}

// Branded types: nominal at the type level via a phantom __brand tag.
// Prevents accidental swapping of structurally-identical string IDs
// (e.g. passing a UserId where an OrgId is expected).
export type Brand<T, B> = T & { readonly __brand: B };
export type UserId = Brand<string, "UserId">;
export type OrgId = Brand<string, "OrgId">;
export type Jti = Brand<string, "Jti">;
export type FamilyId = Brand<string, "FamilyId">;
export type DeviceCode = Brand<string, "DeviceCode">;
export type UserCode = Brand<string, "UserCode">;
