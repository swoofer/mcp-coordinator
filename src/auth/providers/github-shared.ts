// Shared HTTP + zod plumbing used by both GitHubProvider (OAuth App,
// T05) and GitHubAppProvider (GitHub App, T53). The two providers
// differ in their OAuth flow specifics and refresh-token handling but
// share the underlying transport (retry-once-on-5xx, GitHub API
// header conventions, RFC 5988 pagination, response shape parsing).

import { z } from "zod";
import { IdPTokenRevoked, IdPTransientError } from "./errors.js";

export const DEFAULT_API_BASE = "https://api.github.com";
export const DEFAULT_AUTH_BASE = "https://github.com";
export const REQUEST_TIMEOUT_MS = 5000;

/**
 * Single fetch attempt with a hard timeout. AbortSignal.timeout is the
 * Node 20+ primitive -- no manual setTimeout + AbortController pairing.
 */
export async function fetchOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Retry once on 5xx OR network/timeout. Don't retry on 4xx.
 *
 * Rationale: a single retry covers transient blips (GitHub maintenance
 * windows, brief network flaps) without amplifying load. Beyond one
 * retry callers should rely on cache (T04 membership-cache
 * stale-on-error) and surface IdPTransientError so upstream backoff
 * policy can take over.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  try {
    const res = await fetchOnce(url, init, timeoutMs);
    if (res.status < 500 || res.status >= 600) return res;
  } catch {
    // fall through to retry
  }
  return fetchOnce(url, init, timeoutMs);
}

/**
 * Map HTTP status to typed error. 401 means the token is no longer
 * valid (revoked or expired); 403 covers both rate-limit and
 * forbidden (both are transient from the caller's POV -- backoff or
 * wait for rate-limit window); 5xx is transient by definition.
 */
export function mapGitHubHttpError(status: number, label: string = "GitHub"): Error {
  if (status === 401) return new IdPTokenRevoked();
  if (status === 403) return new IdPTransientError(`${label} 403 (rate limit or forbidden)`);
  if (status >= 500 && status < 600) return new IdPTransientError(`${label} ${status}`);
  return new Error(`${label} HTTP ${status}`);
}

/**
 * Parse RFC 5988 Link header for the `rel="next"` URL.
 *
 * Format: `<https://api.github.com/user/orgs?page=2>; rel="next", <...>; rel="last"`
 * Returns the next-page URL or null if there is no next page.
 *
 * SSRF guard: requires the next URL's origin to match `expectedOrigin`.
 * A compromised upstream (or MITM in a GHES deployment) could otherwise
 * point pagination at an attacker-controlled host, leaking the OAuth
 * Bearer token carried by `apiHeaders`.
 */
export function parseNextLink(linkHeader: string | null, expectedOrigin: string): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) {
      try {
        const next = new URL(match[1]);
        if (next.origin !== expectedOrigin) return null;
        return match[1];
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * GitHub API request headers. The `X-GitHub-Api-Version` pin keeps the
 * coordinator on a stable response shape across GHES upgrades; it's
 * date-versioned per GitHub docs.
 */
export function apiHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ---- zod schemas for GitHub API response shapes ----

export const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  scope: z.string().optional(),
  // GitHub App user-to-server tokens add these; OAuth App tokens
  // omit them.
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
});

export const GitHubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
});

export const GitHubEmailSchema = z.object({
  email: z.string(),
  primary: z.boolean(),
  verified: z.boolean(),
});

export const GitHubEmailsSchema = z.array(GitHubEmailSchema);

export const GitHubOrgSchema = z.object({ login: z.string() });
export const GitHubOrgsSchema = z.array(GitHubOrgSchema);

// T57: /user/installations response shape. Pagination matches /user/orgs.
export const GitHubInstallationSchema = z.object({
  id: z.number(),
  account: z.object({
    login: z.string(),
    type: z.string().optional(),
  }),
});
export const GitHubInstallationsResponseSchema = z.object({
  total_count: z.number(),
  installations: z.array(GitHubInstallationSchema),
});

// ---- Shared identity + membership helpers ----

import type { IdpUserInfo } from "./types.js";

/**
 * Fetch `/user` + `/user/emails` and assemble IdpUserInfo. Used by
 * both GitHubProvider and GitHubAppProvider after they obtain an
 * access token via their respective OAuth flows.
 *
 * Email selection: prefer `primary && verified`; otherwise first
 * `verified`. If `/user` returned a public email and no verified
 * email exists in `/user/emails`, fall back to that. Throws if no
 * usable email found.
 */
export async function fetchGitHubUserInfo(
  apiBaseUrl: string,
  accessToken: string,
): Promise<IdpUserInfo> {
  const userRes = await fetchWithRetry(`${apiBaseUrl}/user`, {
    method: "GET",
    headers: apiHeaders(accessToken),
  });
  if (!userRes.ok) {
    throw mapGitHubHttpError(userRes.status);
  }
  const userJson = await userRes.json();
  const user = GitHubUserSchema.parse(userJson);

  const emailsRes = await fetchWithRetry(`${apiBaseUrl}/user/emails`, {
    method: "GET",
    headers: apiHeaders(accessToken),
  });
  if (!emailsRes.ok) {
    throw mapGitHubHttpError(emailsRes.status);
  }
  const emailsJson = await emailsRes.json();
  const emails = GitHubEmailsSchema.parse(emailsJson);

  const primaryVerified = emails.find((e) => e.primary && e.verified);
  const firstVerified = emails.find((e) => e.verified);
  const chosen = primaryVerified?.email ?? firstVerified?.email ?? user.email;
  if (!chosen) {
    throw new Error("GitHub user has no verified email");
  }

  return {
    idp_user_id: String(user.id),
    email: chosen,
    name: user.name ?? undefined,
  };
}

/**
 * List the user's organization logins. Paginated via RFC 5988 Link
 * headers. SSRF-guarded via `parseNextLink` against the configured
 * `apiBaseUrl`.
 */
export async function listGitHubOrgs(apiBaseUrl: string, accessToken: string): Promise<string[]> {
  const logins: string[] = [];
  const expectedOrigin = new URL(apiBaseUrl).origin;
  let url: string | null = `${apiBaseUrl}/user/orgs?per_page=100`;
  while (url) {
    const res: Response = await fetchWithRetry(url, {
      method: "GET",
      headers: apiHeaders(accessToken),
    });
    if (!res.ok) {
      throw mapGitHubHttpError(res.status);
    }
    const json = await res.json();
    const orgs = GitHubOrgsSchema.parse(json);
    for (const o of orgs) {
      logins.push(o.login);
    }
    url = parseNextLink(res.headers.get("link"), expectedOrigin);
  }
  return logins;
}

/**
 * List the GitHub App installations the current user has access to,
 * returning the installation account logins (lowercased to match the
 * existing membership-cache + allowlist normalization).
 *
 * T57 (v0.10.3): used by GitHubAppProvider when
 * `allowlistSource === "user_installations"` to drive the org
 * allowlist off the App's installation footprint rather than the
 * user's GitHub-org memberships. This delivers the
 * "App-installed-on-org IS the allowlist" property without needing
 * the App's RSA private key -- the user's own user-to-server token
 * is sufficient because `/user/installations` is scoped to
 * installations the user can access.
 *
 * Endpoint: `GET /user/installations` (paginated).
 * Response: `{ total_count, installations: [{ account: { login }, ... }] }`.
 *
 * Each result becomes a candidate match against
 * `orgs.allowlist_github_org`. Personal-account installations
 * (`account.type === "User"`) work too -- the account login is the
 * user's own GitHub login, which an operator can put on the
 * allowlist if they want personal-account sign-in.
 */
export async function listGitHubAppInstallations(
  apiBaseUrl: string,
  accessToken: string,
): Promise<string[]> {
  const logins: string[] = [];
  const expectedOrigin = new URL(apiBaseUrl).origin;
  let url: string | null = `${apiBaseUrl}/user/installations?per_page=100`;
  while (url) {
    const res: Response = await fetchWithRetry(url, {
      method: "GET",
      headers: apiHeaders(accessToken),
    });
    if (!res.ok) {
      throw mapGitHubHttpError(res.status, "GitHub App");
    }
    const json = await res.json();
    const parsed = GitHubInstallationsResponseSchema.parse(json);
    for (const inst of parsed.installations) {
      logins.push(inst.account.login);
    }
    url = parseNextLink(res.headers.get("link"), expectedOrigin);
  }
  return logins;
}
