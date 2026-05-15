// Audit event Tier classification (spec §11.2 inventory, V2 §C.2 master table).
//
// The audit_log table has no `tier` column — retention queries (T28 sweeper)
// classify rows by the `action` string against these lists. Tier 1 events are
// security-critical and use the longer retention (audit_retention_days, 365d
// default). Tier 2 events are higher-volume operational signals and use the
// shorter retention (audit_tier2_retention_days, 90d default).
//
// Caller-side: audit() in src/security/audit.ts uses an explicit `tier`
// option to decide sync vs queued routing; this module is purely for the
// retention sweeper today, though a future lint can cross-check that callers
// using `tier: 1` emit actions from TIER1_EVENTS and vice versa.

/** Tier 1: synchronous emission, never dropped, long retention. */
export const TIER1_EVENTS = [
  "auth.refresh.chain_revoked",
  "auth.refresh.suspicious_replay",
  "auth.state.replay",
  "auth.state.mixup",
  "auth.login.denied.not_in_org",
  "auth.login.locked",
  "auth.token.revoked",
  "auth.logout.global",
  "auth.service_token.issued",
  "auth.service_token.revoked",
  "auth.admin.bootstrapped",
  "auth.bootstrap.admin_assigned",
  "auth.idp.token_revoked",
  "auth.idp.unknown_kid",
  "recovery.token_epoch_global_bump",
  "recovery.completed",
  "config.boot",
  "config.key_rotation",
  "system.shutdown.audit_loss",
  "migration.audit_backfill",
] as const;

/** Tier 2: asynchronous emission (T11b queue), may drop under pressure, shorter retention. */
export const TIER2_EVENTS = [
  "auth.login.success",
  "auth.login.failure",
  "auth.refresh.rotated",
  "auth.refresh.idle_expired",
  "auth.device.code_issued",
  "auth.device.approved",
  "auth.device.denied",
  "auth.user.created",
  "auth.user.provisioned",
  "auth.logout.local",
  "auth.invalid_token",
  "auth.legacy_token.accepted",
  "auth.service_token.used",
  "auth.csrf.failed",
  "auth.idp.stale_served",
] as const;

export type Tier1Event = (typeof TIER1_EVENTS)[number];
export type Tier2Event = (typeof TIER2_EVENTS)[number];
