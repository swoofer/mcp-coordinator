// T25 — Service-token issuance + verification override (V4 FIX 10, V2 §A.7).
//
// Service tokens are long-lived JWTs for CI/CD systems. Admin-only issuance
// with hard caps + audit trail. They never rotate (T19a short-circuits on
// claims.service_account === true → 400 INVALID_GRANT). Per V4 §5.5 the
// authenticateRequest service-account branch DB-validates the jti on every
// request, overriding the §9.5 trust-signature default so admin force-revoke
// wins immediately without waiting for token expiry.
//
// Storage: service tokens live in refresh_tokens with family_id matching
// ^service:[0-9a-f-]{36}$. parent_jti is NULL (family root); they never
// rotate so no successor row is ever inserted.
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { Clock } from "./clock.js";
import type { JwtKeyRegistry } from "./jwt-keys.js";
import { mintAccessJWT } from "./jwt-mint.js";

/** Hardcoded 90-day ceiling. NOT env-configurable (V4 FIX 10). */
export const SERVICE_TOKEN_MAX_TTL_S = 90 * 86400;
export const SERVICE_TOKEN_MIN_REASON_LEN = 10;
const FAMILY_ID_REGEX = /^service:[0-9a-f-]{36}$/;

export type ServiceTokenScope = "read" | "write" | "admin";

export interface IssueServiceTokenOptions {
  db: Database.Database;
  clock: Clock;
  signingKeys: JwtKeyRegistry;
  issuer: string; // COORDINATOR_PUBLIC_URL (trailing slash stripped by caller)
  targetUserId: string;
  targetOrgId: string;
  scope: ServiceTokenScope;
  ttlSeconds: number;
  reason: string;
  issuedByAdminId: string;
}

export interface IssuedServiceToken {
  jti: string;
  accessToken: string; // service JWT — shown once; never retrievable
  familyId: string;
  expiresAt: number; // UNIX seconds
}

export class ServiceTokenValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceTokenValidationError";
  }
}

/**
 * Mint a service token. Validates ttl/reason/scope/target BEFORE any DB write
 * so a failed precondition leaves no orphaned rows.
 *
 * Caller is responsible for the admin-auth check (T25 endpoint or CLI does
 * this BEFORE invoking issueServiceToken).
 *
 * INSERTs a refresh_tokens row with family_id = "service:<uuid>" so the
 * authenticateRequest service-account branch can validate via DB lookup
 * (verifyServiceTokenJti).
 */
export async function issueServiceToken(
  opts: IssueServiceTokenOptions,
): Promise<IssuedServiceToken> {
  if (opts.ttlSeconds <= 0) {
    throw new ServiceTokenValidationError(
      "INVALID_TTL",
      "TTL must be positive",
    );
  }
  if (opts.ttlSeconds > SERVICE_TOKEN_MAX_TTL_S) {
    throw new ServiceTokenValidationError(
      "TTL_EXCEEDS_MAX",
      `TTL ${opts.ttlSeconds}s exceeds hardcoded 90d ceiling`,
    );
  }
  if (!opts.reason || opts.reason.length < SERVICE_TOKEN_MIN_REASON_LEN) {
    throw new ServiceTokenValidationError(
      "REASON_TOO_SHORT",
      `Reason must be at least ${SERVICE_TOKEN_MIN_REASON_LEN} chars`,
    );
  }
  if (
    opts.scope !== "read" &&
    opts.scope !== "write" &&
    opts.scope !== "admin"
  ) {
    throw new ServiceTokenValidationError(
      "INVALID_SCOPE",
      "Scope must be read|write|admin",
    );
  }

  // Verify target user exists + is a member of the target org. Allow the
  // target_org to be either the user's primary org OR a user_orgs membership
  // — both make this a legitimate "this user belongs in this org" assertion.
  const userRow = opts.db
    .prepare("SELECT id, primary_org_id FROM users WHERE id = ?")
    .get(opts.targetUserId) as
    | { id: string; primary_org_id: string }
    | undefined;
  if (!userRow) {
    throw new ServiceTokenValidationError(
      "USER_NOT_FOUND",
      "Target user does not exist",
    );
  }
  if (userRow.primary_org_id !== opts.targetOrgId) {
    const membership = opts.db
      .prepare("SELECT 1 FROM user_orgs WHERE user_id = ? AND org_id = ?")
      .get(opts.targetUserId, opts.targetOrgId);
    if (!membership) {
      throw new ServiceTokenValidationError(
        "USER_NOT_IN_ORG",
        "Target user is not a member of the target org",
      );
    }
  }

  // family_id format invariant. crypto.randomUUID() ALWAYS yields a
  // canonical lower-hex UUID, so this regex always matches in practice —
  // the guard documents the invariant for future maintainers.
  const familyId = `service:${crypto.randomUUID()}`;
  /* c8 ignore next 3 */
  if (!FAMILY_ID_REGEX.test(familyId)) {
    throw new ServiceTokenValidationError(
      "INTERNAL",
      "family_id format invariant violated",
    );
  }

  const now = opts.clock.now();
  const expiresAt = now + opts.ttlSeconds;
  const jti = crypto.randomUUID();

  // INSERT refresh_tokens row. parent_jti is NULL (family root); service
  // tokens never rotate so no successor will ever exist. consumer_fingerprint
  // is NULL — service tokens are CI/CD non-browser clients.
  opts.db
    .prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
          expires_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      opts.targetUserId,
      opts.targetOrgId,
      jti,
      familyId,
      String(expiresAt),
      String(now),
    );

  // Mint the service JWT. Claims include service_account=true, scope,
  // issued_by — used by authenticateRequest's service-account branch.
  const accessToken = await mintAccessJWT({
    claims: {
      sub: opts.targetUserId,
      active_org_id: opts.targetOrgId,
      family_id: familyId,
      role: "service",
      service_account: true,
      scope: opts.scope,
      issued_by: opts.issuedByAdminId,
    },
    registry: opts.signingKeys,
    issuer: opts.issuer,
    ttlSeconds: opts.ttlSeconds,
    jti,
  });

  return { jti, accessToken, familyId, expiresAt };
}

export interface ServiceTokenRow {
  jti: string;
  user_id: string;
  org_id: string;
  family_id: string;
  expires_at: string | number;
  created_at: string | number;
  last_used_at: string | number | null;
  revoked_at: string | number | null;
  revoked_reason: string | null;
}

export interface ListServiceTokensOptions {
  activeOnly?: boolean;
  userId?: string;
  orgId?: string;
}

/**
 * List service tokens (refresh_tokens rows with family_id matching
 * "service:%"). ORDER BY created_at DESC (newest first).
 */
export function listServiceTokens(
  db: Database.Database,
  opts: ListServiceTokensOptions = {},
): ServiceTokenRow[] {
  const conditions: string[] = ["family_id LIKE 'service:%'"];
  const params: unknown[] = [];
  if (opts.activeOnly) conditions.push("revoked_at IS NULL");
  if (opts.userId) {
    conditions.push("user_id = ?");
    params.push(opts.userId);
  }
  if (opts.orgId) {
    conditions.push("org_id = ?");
    params.push(opts.orgId);
  }
  const sql = `
    SELECT jti, user_id, org_id, family_id, expires_at, created_at,
           last_used_at, revoked_at, revoked_reason
    FROM refresh_tokens
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
  `;
  return db.prepare(sql).all(...params) as ServiceTokenRow[];
}

/**
 * Revoke a service token by jti. Returns true if a row was affected
 * (false on unknown jti, already-revoked row, or non-service token).
 *
 * revokedByAdminId is currently unused by the SQL (revoked_reason is a
 * fixed-vocabulary CHECK enforced at app layer; "admin" is the value for
 * this case). The full admin audit row carrying who-revoked-whom is
 * emitted by the caller, not here — issueServiceToken is the pattern.
 */
export function revokeServiceToken(
  db: Database.Database,
  clock: Clock,
  jti: string,
  revokedByAdminId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE refresh_tokens
         SET revoked_at = ?, revoked_reason = 'admin'
       WHERE jti = ?
         AND family_id LIKE 'service:%'
         AND revoked_at IS NULL`,
    )
    .run(String(clock.now()), jti);
  void revokedByAdminId; // emitted by caller's audit row, not by this SQL
  return result.changes > 0;
}

/**
 * Service-account verification override (V4 §5.5). Called from
 * authenticateRequest when claims.service_account === true. Returns true
 * iff the jti is still active (refresh_tokens row exists, family is a
 * service family, and revoked_at IS NULL).
 *
 * This is the override that defeats §9.5's trust-signature default —
 * every service-token request hits the DB so admin force-revoke wins
 * immediately.
 */
export function verifyServiceTokenJti(
  db: Database.Database,
  jti: string,
): boolean {
  const row = db
    .prepare(
      "SELECT revoked_at FROM refresh_tokens WHERE jti = ? AND family_id LIKE 'service:%'",
    )
    .get(jti) as { revoked_at: string | number | null } | undefined;
  if (!row) return false;
  return row.revoked_at === null;
}
