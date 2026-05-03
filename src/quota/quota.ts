// Anthropic OAuth quota endpoint — port from reserve/agents/src/quota.rs.
//
// Pipeline: credential reader → OAuth access token → HTTP GET /api/oauth/usage
// → QuotaInfo with 3 buckets (5h / 7d / 7d-sonnet).
//
// This module is the wire protocol. The cache + refresh strategy live in
// quota-cache.ts so this file stays side-effect-free and easy to test.

import type { CredentialReader } from "./credential-reader.js";

export interface QuotaBucket {
  /** 0.0 – 100.0 */
  utilization: number;
  /** ISO 8601 timestamp when this bucket resets */
  resetsAt: string;
  /** Positive = reset is in the future; negative = already reset */
  minutesUntilReset: number;
}

export interface QuotaInfo {
  fiveHour: QuotaBucket;
  sevenDay: QuotaBucket;
  /** The 7-day bucket limited to Sonnet usage. Anthropic omits it when absent. */
  sevenDaySonnet: QuotaBucket | null;
  /** Wall-clock time the coordinator fetched this, for cache freshness checks. */
  fetchedAt: number;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";

export class QuotaUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    /** HTTP status from the upstream API when available — lets the cache
     * differentiate "retry now" vs "back off" (e.g. 429 → cool-down). */
    public readonly httpStatus?: number,
    /** Retry-After hint (seconds) from the upstream when provided. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "QuotaUnavailableError";
  }
}

/**
 * Fetch the current quota info from Anthropic. Throws QuotaUnavailableError
 * if the credential is missing (non-macOS platforms stub this path), the API
 * is unreachable, or the response shape is unexpected.
 */
export async function fetchQuotaFromAnthropic(reader: CredentialReader): Promise<QuotaInfo> {
  let token: string;
  try {
    token = await reader.readClaudeOAuthToken();
  } catch (err) {
    throw new QuotaUnavailableError(
      `cannot read OAuth token: ${(err as Error).message}`,
      err,
    );
  }

  let resp: Response;
  try {
    resp = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": BETA_HEADER,
      },
    });
  } catch (err) {
    throw new QuotaUnavailableError(
      `cannot reach Anthropic usage API: ${(err as Error).message}`,
      err,
    );
  }

  if (!resp.ok) {
    const retryAfterRaw = resp.headers.get("retry-after");
    const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
    throw new QuotaUnavailableError(
      `usage API returned HTTP ${resp.status}`,
      undefined,
      resp.status,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new QuotaUnavailableError(
      `usage API returned non-JSON body: ${(err as Error).message}`,
      err,
    );
  }

  return parseUsageResponse(body);
}

/**
 * Parse the JSON payload returned by /api/oauth/usage. Exported so tests can
 * exercise shape handling without hitting the network.
 */
export function parseUsageResponse(payload: unknown): QuotaInfo {
  if (!payload || typeof payload !== "object") {
    throw new QuotaUnavailableError("usage API body is not an object");
  }
  const rec = payload as Record<string, unknown>;

  const fiveHour = parseBucket(rec, "five_hour");    // required
  const sevenDay = parseBucket(rec, "seven_day");    // required
  // Anthropic sometimes omits the sonnet-specific bucket (e.g. workspaces
  // without a seven_day_sonnet cap). Optional — null signals "not tracked".
  let sevenDaySonnet: QuotaBucket | null = null;
  try {
    sevenDaySonnet = parseBucket(rec, "seven_day_sonnet");
  } catch {
    sevenDaySonnet = null;
  }

  return { fiveHour, sevenDay, sevenDaySonnet, fetchedAt: Date.now() };
}

function parseBucket(payload: Record<string, unknown>, key: string): QuotaBucket {
  const raw = payload[key];
  if (!raw || typeof raw !== "object") {
    throw new QuotaUnavailableError(`usage API: field "${key}" missing or not an object`);
  }
  const bucket = raw as Record<string, unknown>;

  const utilization = bucket.utilization;
  if (typeof utilization !== "number") {
    throw new QuotaUnavailableError(`usage API: "${key}.utilization" missing or non-numeric`);
  }

  const resetsAt = bucket.resets_at;
  if (typeof resetsAt !== "string") {
    throw new QuotaUnavailableError(`usage API: "${key}.resets_at" missing or non-string`);
  }

  return {
    utilization,
    resetsAt,
    minutesUntilReset: minutesUntil(resetsAt),
  };
}

/**
 * Positive = date is in the future. Returns 0 on an unparseable date so
 * callers can still make a "quota already reset" decision without crashing.
 */
export function minutesUntil(iso8601: string): number {
  const t = Date.parse(iso8601);
  if (Number.isNaN(t)) return 0;
  return Math.round((t - Date.now()) / 60_000);
}
