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
  // #305: renamed from "auth.state.mixup". The branch fires when the state's
  // provider is no longer registered — a value we wrote ourselves, which no
  // third party can vary — so it never detected a mix-up.
  "auth.state.provider_unregistered",
  // Deprecated alias, emitted by nothing since #305. Kept because the sweeper
  // deletes by literal `action IN (...)`: dropping the string would leave every
  // row written before the rename matching neither tier list, and
  // tests/unit/sweeper.test.ts pins that such rows are never swept — i.e. they
  // would be retained forever rather than for the Tier 1 window.
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
  // v0.10.6 T03: boot-time override accepted duplicate org names instead of
  // failing the UNIQUE INDEX pre-flight (COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES=1).
  // Operator-acknowledged risk; full duplicate list lands in the metadata.
  "admin.orgs.duplicate_names_accepted",
  // v0.10.6 T02 (V2 §C.2 master table, V3 PATCH 3): admin UI mutations.
  // Emitted by handle-admin-orgs / handle-admin-users in the same transaction
  // as the underlying INSERT/UPDATE so the write and audit row commit atomically.
  // `admin.user.role_changed` carries both `outcome: "success"` and
  // `outcome: "denied"` rows (denied_reason ∈ last_admin | self_demotion |
  // not_human_user | not_found).
  "admin.org.created",
  "admin.org.updated",
  "admin.user.role_changed",
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
  // #305: an unregistered IdP name arrived from the client at the token
  // endpoint (`body.provider`). Tier 2 because both the value and the rate are
  // attacker-controlled on an unauthenticated path — see auditUnknownProvider
  // in src/auth/audit-helpers.ts for why Tier 1 would be harmful here.
  "auth.provider.unknown",
  "auth.idp.stale_served",
] as const;

export type Tier1Event = (typeof TIER1_EVENTS)[number];
export type Tier2Event = (typeof TIER2_EVENTS)[number];
