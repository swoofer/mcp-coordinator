export interface IdpUserInfo {
  idp_user_id: string;
  email: string;
  name?: string;
  idp_org_id?: string;
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

export interface IdPProvider {
  readonly name: string;
  buildAuthUrl(state: string, redirectUri: string, codeChallenge?: string): string | Promise<string>;
  exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<ExchangeCodeResult>;
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
