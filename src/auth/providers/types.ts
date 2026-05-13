export interface IdpUserInfo {
  idp_user_id: string;
  email: string;
  name?: string;
  idp_org_id?: string;
}

export interface IdPProvider {
  name: string;
  buildAuthUrl(state: string, redirectUri: string, codeChallenge?: string): string;
  exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<IdpUserInfo>;
}
