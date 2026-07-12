/**
 * Phase 2 Prometheus metric registry. Per V2 patches §B T37, this is a
 * SEPARATE Registry from Phase 1's `src/metrics.ts` to avoid namespace
 * coupling — Phase 2 auth + audit + IdP metrics live here; Phase 1
 * announce/resolution/REST metrics stay in `src/metrics.ts` and continue
 * to serve `/metrics`. This registry is served from `/metrics/auth`.
 *
 * Tenant-scoped metrics carry an `org_id` label so Phase 5 multi-tenant
 * deployments get per-org cardinality from day 1.
 *
 * Label conventions:
 *   - org_id      — tenant scope (Phase 5)
 *   - outcome     — success | failure | denied | locked | 4xx | 5xx | timeout
 *   - reason      — short slug for failure / revocation cause
 *   - scope       — local | global  (logout); or service token scope
 *   - endpoint    — token | user | emails | orgs (IdP); or HTTP route
 *   - identifier_type — ip | family | user  (rate limit dimension)
 *   - table       — sweeper deletion target table
 */
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

/**
 * Histogram buckets tuned for auth-flow HTTP latency: sub-ms warm path
 * up through multi-second IdP-bound calls. Same shape recommended by
 * spec §17.1.
 */
const COMMON_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

// ── Auth activity ───────────────────────────────────────────────────────

export const authLoginAttemptsTotal = new Counter({
  name: "coordinator_auth_login_attempts_total",
  help: "Total auth login attempts by outcome and org",
  labelNames: ["outcome", "org_id"] as const,
  registers: [registry],
});

export const authLoginSuccessTotal = new Counter({
  name: "coordinator_auth_login_success_total",
  help: "Total successful logins by org",
  labelNames: ["org_id"] as const,
  registers: [registry],
});

export const authLoginFailureTotal = new Counter({
  name: "coordinator_auth_login_failure_total",
  help: "Total failed logins by reason (invalid_state, expired, consumed, not_in_allowlist, idp_error, ...)",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const authRefreshRotatedTotal = new Counter({
  name: "coordinator_auth_refresh_rotated_total",
  help: "Total successful refresh-token rotations by org",
  labelNames: ["org_id"] as const,
  registers: [registry],
});

export const authRefreshChainRevokedTotal = new Counter({
  name: "coordinator_auth_refresh_chain_revoked_total",
  help: "Total refresh-token chain revocations by reason (reuse_detected, suspicious_replay, admin)",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const authRefreshSuspiciousReplayTotal = new Counter({
  name: "coordinator_auth_refresh_suspicious_replay_total",
  help: "Total suspicious refresh-token replay attempts detected",
  registers: [registry],
});

export const authTokenRevokedTotal = new Counter({
  name: "coordinator_auth_token_revoked_total",
  help: "Total token revocations by reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const authLogoutTotal = new Counter({
  name: "coordinator_auth_logout_total",
  help: "Total logouts by scope (local|global)",
  labelNames: ["scope"] as const,
  registers: [registry],
});

// ── Device flow ─────────────────────────────────────────────────────────

export const authDeviceCodeIssuedTotal = new Counter({
  name: "coordinator_auth_device_code_issued_total",
  help: "Total device-flow codes issued",
  registers: [registry],
});

export const authDeviceApprovedTotal = new Counter({
  name: "coordinator_auth_device_approved_total",
  help: "Total device-flow approvals",
  registers: [registry],
});

export const authDeviceDeniedTotal = new Counter({
  name: "coordinator_auth_device_denied_total",
  help: "Total device-flow denials by reason (user|expired|brute_force)",
  labelNames: ["reason"] as const,
  registers: [registry],
});

// ── Service tokens ──────────────────────────────────────────────────────

export const authServiceTokenIssuedTotal = new Counter({
  name: "coordinator_auth_service_token_issued_total",
  help: "Total service tokens issued by scope",
  labelNames: ["scope"] as const,
  registers: [registry],
});

export const authServiceTokenUsedTotal = new Counter({
  name: "coordinator_auth_service_token_used_total",
  help: "Total service-token usages by scope (sampled max 1/hr per token)",
  labelNames: ["scope"] as const,
  registers: [registry],
});

export const authServiceTokenRevokedTotal = new Counter({
  name: "coordinator_auth_service_token_revoked_total",
  help: "Total service tokens revoked",
  registers: [registry],
});

// ── IdP ─────────────────────────────────────────────────────────────────

export const idpApiCallsTotal = new Counter({
  name: "coordinator_idp_api_calls_total",
  help: "Total IdP API calls by endpoint and outcome",
  labelNames: ["endpoint", "outcome"] as const,
  registers: [registry],
});

export const idpCacheHitsTotal = new Counter({
  name: "coordinator_idp_cache_hits_total",
  help: "Total IdP cache hits",
  registers: [registry],
});

export const idpCacheMissesTotal = new Counter({
  name: "coordinator_idp_cache_misses_total",
  help: "Total IdP cache misses",
  registers: [registry],
});

export const idpStaleServedTotal = new Counter({
  name: "coordinator_idp_stale_served_total",
  help: "Total times stale IdP cache entries were served (graceful degradation)",
  registers: [registry],
});

export const idpRateLimitRemaining = new Gauge({
  name: "coordinator_idp_rate_limit_remaining",
  help: "Current IdP rate-limit remaining from X-RateLimit-Remaining header",
  registers: [registry],
});

// ── IdP token encryption (Phase 3) ──────────────────────────────────────

export const encryptionEnabledGauge = new Gauge({
  name: "coordinator_idp_encryption_enabled",
  help: "1 if COORDINATOR_ENCRYPTION_KEY is set and EnvelopeEncryption is active; 0 if running PassthroughEncryption",
  registers: [registry],
});

export const decryptFailuresCounter = new Counter({
  name: "coordinator_idp_decrypt_failures_total",
  help: "Total number of IdP token decrypt failures since process start",
  labelNames: ["error_class"] as const,
  registers: [registry],
});

export const plaintextRowsGauge = new Gauge({
  name: "coordinator_idp_plaintext_rows",
  help: "Number of users.idp_*_token rows still stored as plaintext (updated by encryption verify or migrate; NOT real-time)",
  registers: [registry],
});

// ── Audit + sweeper gauges ──────────────────────────────────────────────

export const auditQueueDepth = new Gauge({
  name: "coordinator_audit_queue_depth",
  help: "Current pending Tier 2 audit queue rows",
  registers: [registry],
});

export const sweeperCircuitOpen = new Gauge({
  name: "coordinator_sweeper_circuit_open",
  help: "1 when sweeper circuit-breaker is open, 0 otherwise",
  registers: [registry],
});

export const sweeperConsecutiveFailures = new Gauge({
  name: "coordinator_sweeper_consecutive_failures",
  help: "Current count of consecutive sweeper failures",
  registers: [registry],
});

export const sweeperLastRunTimestamp = new Gauge({
  name: "coordinator_sweeper_last_run_timestamp",
  help: "Unix seconds when the sweeper last ran (any outcome)",
  registers: [registry],
});

// ── Audit + sweep counters ──────────────────────────────────────────────

export const auditDropsTotal = new Counter({
  name: "coordinator_audit_drops_total",
  help: "Tier 2 audit queue overflow drops",
  registers: [registry],
});

export const auditAfterCriticalOpFailuresTotal = new Counter({
  name: "coordinator_audit_after_critical_op_failures_total",
  help: "Telemetry-of-telemetry-loss: audit() failures emitted AFTER a critical security op succeeded (V4 FIX 23)",
  registers: [registry],
});

export const sweeperRowsDeletedTotal = new Counter({
  name: "coordinator_sweeper_rows_deleted_total",
  help: "Total rows deleted by the sweeper, by table",
  labelNames: ["table"] as const,
  registers: [registry],
});

// ── Rate limit ──────────────────────────────────────────────────────────

export const rateLimitBlockedTotal = new Counter({
  name: "coordinator_rate_limit_blocked_total",
  help: "Total requests blocked by rate-limit, by endpoint + identifier dimension",
  labelNames: ["endpoint", "identifier_type"] as const,
  registers: [registry],
});

export const loginLockoutTriggeredTotal = new Counter({
  name: "coordinator_login_lockout_triggered_total",
  help: "Total login lockouts triggered (per-family or per-IP)",
  registers: [registry],
});

// ── Histograms (Phase 2 SLI) ────────────────────────────────────────────

export const authRequestDurationSeconds = new Histogram({
  name: "coordinator_auth_request_duration_seconds",
  help: "Phase 2 auth HTTP request duration by endpoint",
  labelNames: ["endpoint"] as const,
  buckets: [...COMMON_BUCKETS],
  registers: [registry],
});

// ── Lifecycle ───────────────────────────────────────────────────────────

/**
 * Reset all Phase 2 metric values. Test-only helper — production callers
 * NEVER reset metric state. (Note: this resets counter/gauge/histogram
 * values; metric declarations themselves remain registered.)
 */
export function resetMetricsForTest(): void {
  registry.resetMetrics();
}

/**
 * Register default Node process metrics (event-loop lag, GC, RSS, etc.)
 * onto the Phase 2 registry. Called once at boot from T29; declaring
 * collection here as an explicit lifecycle entry-point keeps tests
 * deterministic (no side-effects at module load time).
 */
export function registerDefaultMetrics(): void {
  collectDefaultMetrics({ register: registry });
}
