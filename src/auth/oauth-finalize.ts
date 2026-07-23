import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { ServerResponse } from "node:http";
import type { Clock } from "./clock.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME, hostCookie, setCookies } from "./cookies.js";
import type { JwtKeyRegistry } from "./jwt-keys.js";
import { mintAccessJWT, mintRefreshJWT } from "./jwt-mint.js";
import type { IdpUserInfo } from "./providers/types.js";
import type { EncryptionProvider } from "../security/encryption.js";
import { encryptNullable } from "../security/encrypt-nullable.js";
import { getOrgSetting } from "./org-settings.js";

/**
 * Shared OAuth-finalize helpers — consumed by:
 *   - T16c: browser callback (302 redirect + cookies)
 *   - T18: CLI authorization_code grant (JSON response)
 *
 * Pure functions: no env reads, no module-level state, no audit() emission.
 * Callers compose the flow + emit audits at their own boundaries.
 */

const ACCESS_TTL_S_DEFAULT = 15 * 60; // 15 minutes
const REFRESH_TTL_S_DEFAULT = 30 * 24 * 3600; // 30 days
const STATE_COOKIE_NAME = "__Host-coordinator_oauth_state";

export interface AllowlistOrg {
  org_id: string;
  org_name: string;
}

export interface ProvisionedUser {
  user_id: string;
  primary_org_id: string;
  role: "admin" | "member" | "service";
}

export interface ProvisionResult {
  user: ProvisionedUser;
  isNew: boolean;
  bootstrapAdmin: boolean;
}

export interface ProvisionUserArgs {
  db: Database.Database;
  clock: Clock;
  idpUser: IdpUserInfo;
  accessToken: string;
  allowlistOrg: AllowlistOrg;
  providerName: string;
  /** T54: optional IdP refresh token. GitHub App user-to-server tokens
   *  carry one (8h access + 6mo refresh); OAuth App / Google / OIDC
   *  do not and pass undefined. Stored in users.idp_refresh_token. */
  idpRefreshToken?: string | null;
  /** T08: encryption provider used to wrap idp_access_token +
   *  idp_refresh_token at write. Pass `PassthroughEncryption` when no
   *  master key is configured (boot wires this up via bootPhase2). */
  encryption: EncryptionProvider;
}

/**
 * Find-or-create the user for a given IdP user-info + allowlisted org.
 *
 * Called inside a BEGIN IMMEDIATE TRANSACTION by the caller (T16b wraps
 * this in a TX that also includes the refresh-token insert). The caller
 * is responsible for the TX boundaries.
 *
 * Bootstrap-admin atomic check per V4 FIX 16: if this is the first user
 * (no admin exists), promote them to admin. The race-safe form uses a
 * conditional UPDATE that checks `NOT EXISTS (SELECT 1 FROM users WHERE
 * role='admin' AND id != :new_user_id)`.
 *
 * Stores `idp_access_token` per V4 FIX 4 so T19c can call listMemberships
 * during refresh rotation.
 *
 * Returns the provisioned user + flags. Callers decide whether to audit
 * `auth.user.created` (T16b emits Tier 2) or `auth.admin.bootstrapped`
 * (T16b emits Tier 1).
 */
export function provisionUser(args: ProvisionUserArgs): ProvisionResult {
  const {
    db,
    clock,
    idpUser,
    accessToken,
    allowlistOrg,
    providerName,
    idpRefreshToken,
    encryption,
  } = args;
  const refreshTokenValue = idpRefreshToken ?? null;
  const existing = db
    .prepare(
      `SELECT id, primary_org_id, role
       FROM users
       WHERE idp_provider = ? AND idp_user_id = ?`,
    )
    .get(providerName, idpUser.idp_user_id) as
    { id: string; primary_org_id: string; role: string } | undefined;

  if (existing) {
    // Returning user — update idp_access_token + idp_refresh_token + last_login_at.
    // T08: encrypt at write. AAD includes user_id + column so a swap of
    // ciphertext between users or between columns fails decrypt.
    const ctxAccess = {
      org_id: allowlistOrg.org_id,
      column: "idp_access_token" as const,
      user_id: existing.id,
    };
    const ctxRefresh = {
      org_id: allowlistOrg.org_id,
      column: "idp_refresh_token" as const,
      user_id: existing.id,
    };
    db.prepare(
      `UPDATE users
       SET idp_access_token = ?, idp_refresh_token = ?, last_login_at = ?
       WHERE id = ?`,
    ).run(
      encryptNullable(encryption, accessToken, ctxAccess),
      encryptNullable(encryption, refreshTokenValue, ctxRefresh),
      String(clock.now()),
      existing.id,
    );

    return {
      user: {
        user_id: existing.id,
        primary_org_id: existing.primary_org_id,
        role: existing.role as "admin" | "member" | "service",
      },
      isNew: false,
      bootstrapAdmin: false,
    };
  }

  // New user — INSERT then bootstrap-admin atomic check.
  // T08: compute userId BEFORE the bind so EncryptionContext.user_id is
  // correct for AAD construction (binding ciphertext to its row).
  const userId = crypto.randomUUID();
  const now = String(clock.now());
  const ctxAccess = {
    org_id: allowlistOrg.org_id,
    column: "idp_access_token" as const,
    user_id: userId,
  };
  const ctxRefresh = {
    org_id: allowlistOrg.org_id,
    column: "idp_refresh_token" as const,
    user_id: userId,
  };

  db.prepare(
    `INSERT INTO users
       (id, primary_org_id, email, name, idp_provider, idp_user_id,
        idp_access_token, idp_refresh_token, role, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    allowlistOrg.org_id,
    idpUser.email,
    idpUser.name ?? null,
    providerName,
    idpUser.idp_user_id,
    encryptNullable(encryption, accessToken, ctxAccess),
    encryptNullable(encryption, refreshTokenValue, ctxRefresh),
    "member", // start as member; bootstrap check may promote
    now,
  );

  // Bootstrap-admin atomic check.
  const promoteResult = db
    .prepare(
      `UPDATE users
       SET role = 'admin'
       WHERE id = ?
         AND NOT EXISTS (
           SELECT 1 FROM users WHERE role = 'admin' AND id != ?
         )`,
    )
    .run(userId, userId);

  const bootstrapAdmin = promoteResult.changes === 1;
  const finalRole: "admin" | "member" = bootstrapAdmin ? "admin" : "member";

  // user_orgs row with FINAL role (V4 FIX 16: not the initial 'member')
  db.prepare(
    `INSERT INTO user_orgs (user_id, org_id, role, joined_at)
     VALUES (?, ?, ?, ?)`,
  ).run(userId, allowlistOrg.org_id, finalRole, now);

  return {
    user: {
      user_id: userId,
      primary_org_id: allowlistOrg.org_id,
      role: finalRole,
    },
    isNew: true,
    bootstrapAdmin,
  };
}

/**
 * Raised inside the provisioning transaction when the `auto_provision`
 * org setting is disabled and the caller has no existing user row for
 * this IdP identity. Callers catch this after the transaction rolls back
 * and turn it into a 403 response — the account is never created.
 */
export class ProvisioningDeniedError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ProvisioningDeniedError";
  }
}

/**
 * Find-or-create a user, gated by the `auto_provision` org setting
 * (resolved via {@link getOrgSetting}, org-scope-less lookup — see that
 * module for the resolution order).
 *
 * When auto_provision is "false" and no user row exists yet for
 * (idp_provider, idp_user_id), the transaction aborts with
 * {@link ProvisioningDeniedError} instead of creating the account, so an
 * org can require an admin to provision users out-of-band before they can
 * sign in. The existence check runs INSIDE the same BEGIN IMMEDIATE
 * transaction as the insert so a concurrent provisioning attempt can't
 * race between the check and the write.
 *
 * Shared by both OAuth entry points — the browser callback
 * (oauth-callback.ts) and the CLI authorization_code token grant
 * (oauth-token.ts) — so the gate applies uniformly regardless of which
 * flow a client uses.
 */
export function provisionUserWithAutoProvisionGate(args: ProvisionUserArgs): ProvisionResult {
  const autoProvision = String(
    getOrgSetting(args.db, null, "auto_provision", "true"),
  ).toLowerCase();
  const tx = args.db.transaction((): ProvisionResult => {
    if (autoProvision === "false") {
      const existing = args.db
        .prepare("SELECT id FROM users WHERE idp_provider = ? AND idp_user_id = ?")
        .get(args.providerName, args.idpUser.idp_user_id);
      if (!existing) {
        throw new ProvisioningDeniedError("USER_NOT_PROVISIONED");
      }
    }
    return provisionUser(args);
  });
  return tx.immediate();
}

export interface MintTokenPairOptions {
  user: ProvisionedUser;
  registry: JwtKeyRegistry;
  issuer: string;
  /** Optional; generated if absent (new session). */
  familyId?: string;
  /** SHA-256(ip + "|" + ua), or null for service-token flows. */
  fingerprint: string | null;
  accessTTLSeconds?: number;
  refreshTTLSeconds?: number;
}

export interface MintedTokenPair {
  accessJwt: string;
  refreshJwt: string;
  refreshJti: string;
  familyId: string;
  expiresAtRefresh: number;
}

/**
 * Mint an access + refresh JWT pair and INSERT the refresh row. The
 * caller is responsible for wrapping this in a transaction (T16c does
 * so as part of the callback's BEGIN IMMEDIATE TX).
 *
 * familyId is auto-generated if not provided (new session); refresh
 * rotation (T19a) reuses the existing family_id for successors.
 *
 * fingerprint is used for V3 §B-NEW-2 stolen-token detection in T19b.
 * Browser flows pass SHA-256(ip+"|"+ua); CLI service-token flows may
 * pass null (rotation not supported for service tokens anyway).
 */
export async function mintTokenPair(
  db: Database.Database,
  clock: Clock,
  opts: MintTokenPairOptions,
): Promise<MintedTokenPair> {
  const familyId = opts.familyId ?? crypto.randomUUID();
  const accessTTL = opts.accessTTLSeconds ?? ACCESS_TTL_S_DEFAULT;
  const refreshTTL = opts.refreshTTLSeconds ?? REFRESH_TTL_S_DEFAULT;
  const now = clock.now();
  const expiresAtRefresh = now + refreshTTL;

  const refreshJti = crypto.randomUUID();
  const accessJwt = await mintAccessJWT({
    claims: {
      sub: opts.user.user_id,
      active_org_id: opts.user.primary_org_id,
      family_id: familyId,
      role: opts.user.role,
    },
    registry: opts.registry,
    issuer: opts.issuer,
    ttlSeconds: accessTTL,
  });

  const { jwt: refreshJwt } = await mintRefreshJWT({
    claims: {
      sub: opts.user.user_id,
      active_org_id: opts.user.primary_org_id,
      family_id: familyId,
    },
    registry: opts.registry,
    issuer: opts.issuer,
    ttlSeconds: refreshTTL,
    jti: refreshJti,
  });

  // INSERT refresh_tokens row. Family root has parent_jti=NULL.
  db.prepare(
    `INSERT INTO refresh_tokens
       (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
        expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    opts.user.user_id,
    opts.user.primary_org_id,
    refreshJti,
    familyId,
    opts.fingerprint,
    String(expiresAtRefresh),
    String(now),
  );

  return { accessJwt, refreshJwt, refreshJti, familyId, expiresAtRefresh };
}

export interface SessionCookieOptions {
  accessJwt: string;
  csrfToken: string;
  /** Max-Age for both cookies; defaults to access TTL (15 min). */
  maxAgeSeconds?: number;
  /** Clear the oauth_state cookie at the same time (T16c sets this true). */
  clearStateCookie?: boolean;
}

/**
 * Emit session + CSRF cookies. Both __Host-prefixed.
 *
 *   __Host-coordinator_session: HttpOnly (JWT — never JS-readable)
 *   __Host-coordinator_csrf:    not HttpOnly (JS must read to send in form)
 *
 * Both SameSite=Strict — same-origin only. Different from T15's state
 * cookie (Lax) because session/CSRF aren't part of a redirect-back flow.
 *
 * Optionally clears the __Host-coordinator_oauth_state cookie used during
 * the redirect-from-GitHub flow.
 */
export function setSessionCookies(res: ServerResponse, opts: SessionCookieOptions): void {
  const maxAge = opts.maxAgeSeconds ?? ACCESS_TTL_S_DEFAULT;
  const sessionCookie = hostCookie(SESSION_COOKIE_NAME, opts.accessJwt, {
    httpOnly: true,
    sameSite: "Strict",
    maxAge,
  });
  const csrfCookie = hostCookie(CSRF_COOKIE_NAME, opts.csrfToken, {
    httpOnly: false,
    sameSite: "Strict",
    maxAge,
  });
  const cookies = [sessionCookie, csrfCookie];
  if (opts.clearStateCookie) {
    // Expire the state cookie immediately by re-setting with maxAge=0.
    cookies.push(
      hostCookie(STATE_COOKIE_NAME, "", {
        httpOnly: true,
        sameSite: "Lax",
        maxAge: 0,
      }),
    );
  }
  setCookies(res, cookies);
}

/**
 * Compute a request fingerprint per V3 §B-NEW-2. SHA-256 of `ip + "|" + ua`
 * — caller passes both. Used for stolen-token detection in T19b refresh
 * rotation (different fingerprint within grace window = theft attempt).
 *
 * Returns null if both inputs are null/empty — preserves call-site clarity
 * over forcing a "unknown|unknown" sentinel hash.
 */
export function computeFingerprint(ip: string | null, userAgent: string | null): string | null {
  if (!ip && !userAgent) return null;
  return crypto
    .createHash("sha256")
    .update(`${ip ?? ""}|${userAgent ?? ""}`)
    .digest("hex");
}
