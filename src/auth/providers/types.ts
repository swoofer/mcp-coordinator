export interface IdpUserInfo {
  idp_user_id: string;
  email: string;
  name?: string;
  idp_org_id?: string;
}

export interface ExchangeCodeResult {
  user: IdpUserInfo;
  accessToken: string;
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
