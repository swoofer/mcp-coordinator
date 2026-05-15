/** RFC 6749 §5.1 token response shape returned by /api/auth/oauth/token */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
}

/** RFC 6749 §5.2 OAuth error envelope */
export interface OAuthErrorEnvelope {
  error: string;
  error_description?: string;
  error_uri?: string;
}

/** Coordinator app-error envelope (non-OAuth endpoints) */
export interface AppErrorEnvelope {
  code: string;
  message: string;
  request_id: string | null;
  details?: Record<string, unknown>;
}

/** RFC 8628 §3.2 device authorization response */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** GET /api/auth/me response shape (T24) */
export interface UserinfoResponse {
  user_id: string;
  email: string;
  name: string | null;
  role: "admin" | "member" | "service";
  org: { id: string; name: string };
  active_org_id: string;
}

/** GET /healthz response */
export interface HealthzResponse {
  status: "alive";
}

/** GET /health/ready response */
export interface HealthReadyResponse {
  status: "ready" | "not_ready";
  checks: {
    db: { ok: boolean; error?: string };
    audit_queue: { ok: boolean; depth: number; capacity: number; threshold_percent: number };
    sweeper: { ok: boolean };
    draining: boolean;
  };
}

/** Tokens captured by the SDK between calls. Consumers persist as they see fit. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds at which the access token expires. SDK proactively refreshes
   *  ~60s before this (best-effort; no jitter in the minimal SDK -- T40b adds it). */
  accessExpiresAt: number;
}
