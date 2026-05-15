import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { jwtVerify } from "jose";
import type { AuthHandlerContext } from "./context.js";
import type { Clock } from "./clock.js";
import { audit } from "../security/audit.js";
import { oauthError, bearerAuthHeader } from "../http/response-contract.js";
import { mintTokenPair, computeFingerprint } from "./oauth-finalize.js";
import { mintAccessJWT, mintRefreshJWT } from "./jwt-mint.js";
import { isAcceptedKid } from "./jwt-keys.js";
import { readTokenEpoch } from "./token-epoch.js";
import { resolveOrgFromMemberships, type AllowlistMatch } from "./allowlist.js";
import { IdPTokenRevoked, IdPTransientError } from "./providers/errors.js";
import { getOrgSetting } from "./org-settings.js";

/**
 * Refresh-token rotation handler — T19a happy + T19b reuse + T19c aux.
 *
 * Called from T18's POST /api/auth/oauth/token dispatcher when
 * grant_type=refresh_token. T18 is not yet built — tests drive this
 * handler directly.
 *
 * Full flow:
 *   1. Parse form body, extract refresh_token
 *   2. JWT verify (HS256 pinned, kid allowlist, ±30s clock tolerance,
 *      issuer match) via jose v6
 *   3. Service-account JWT short-circuit (service tokens never rotate)
 *   4. token_epoch check via T03 readTokenEpoch (admin-force-revoke wins)
 *   5. SELECT refresh_tokens row by jti
 *   6. T19c idle-timeout check (V4 FIX 24): if
 *      COORDINATOR_SESSION_IDLE_TIMEOUT is set and (now - last_used_at)
 *      exceeds it, revoke the row (reason='idle_expired') + Tier 2 audit
 *      auth.refresh.idle_expired + 400 invalid_grant.
 *   7. T19c IdP membership refresh + allowlist re-check (V4 FIX 7):
 *      - If users.idp_access_token IS NULL (Phase 1 migration), skip
 *        check — token_epoch + idle alone protect the session.
 *      - getMemberships via T04 cache. IdPTokenRevoked → 401 +
 *        WWW-Authenticate + Tier 1 audit auth.idp.token_revoked.
 *        IdPTransientError → 503 temporarily_unavailable. Other errors
 *        re-thrown to caller.
 *      - resolveOrgFromMemberships → null means user no longer in any
 *        allowlisted org: revoke this row + Tier 1 audit
 *        auth.login.denied.not_in_org + 401 invalid_grant.
 *   8. T19b reuse-detection branch on row.revoked_at != null
 *      (passes allowlistMatch — grace branch re-checks for V4 FIX 7).
 *   9. Atomic UPDATE WHERE jti=? AND revoked_at IS NULL — V4 FIX 5
 *   10. mintTokenPair via T16helpers (same family_id, new fingerprint)
 *   11. UPDATE successor.parent_jti = old.jti
 *   12. Tier 2 audit auth.refresh.rotated
 *   13. RFC 6749 §5.1 JSON response
 *
 * Out of scope for T19c (Phase 2 follow-ups):
 *   - last_used_at updates on every refresh use (separate from rotation)
 *   - T18 dispatcher wiring
 */

const CLOCK_TOLERANCE_S = 30;
const ACCESS_TTL_S = 15 * 60; // matches mintTokenPair default
const REFRESH_TTL_S = 30 * 24 * 3600; // matches mintTokenPair default
const GRACE_WINDOW_S = 10;
const REPLAY_THRESHOLD = 3;

interface RefreshRow {
  jti: string;
  user_id: string;
  org_id: string;
  family_id: string | null;
  parent_jti: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  consumer_fingerprint: string | null;
  expires_at: string;
  last_used_at: string | null;
}

/**
 * Parse a duration string ("60s", "15m", "2h", "30d") to seconds. Used
 * by T19c idle-timeout config. Strict format — anything else throws so
 * misconfiguration surfaces at the first refresh rather than silently
 * disabling idle checks.
 */
function parseDuration(s: string): number {
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) throw new Error(`invalid duration: ${s}`);
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 3600;
    case "d": return n * 86400;
    // Unreachable: the regex constrains [smhd]. Kept for exhaustiveness.
    /* c8 ignore next 2 */
    default: throw new Error(`invalid duration unit: ${m[2]}`);
  }
}

interface ParsedRefreshClaims {
  sub: string;
  active_org_id: string;
  family_id: string;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  service_account?: boolean;
}

async function parseFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const params = new URLSearchParams(body);
      const out: Record<string, string> = {};
      for (const [k, v] of params) out[k] = v;
      resolve(out);
    });
    req.on("error", reject);
  });
}

/**
 * Verify a refresh JWT. HS256 pinned; kid must be on the T08b
 * ACCEPTED_KIDS allowlist (`["hs256-v1"]`). Issuer must equal
 * ctx.publicUrl (trailing slash stripped). Clock skew tolerance ±30s
 * per RFC 7519 §4.1.4.
 */
async function verifyRefreshJwt(
  token: string,
  ctx: AuthHandlerContext,
): Promise<ParsedRefreshClaims> {
  const { payload } = await jwtVerify(
    token,
    async (header) => {
      const kid = header.kid;
      if (!kid || !isAcceptedKid(kid)) {
        throw new Error(`unknown_kid: ${String(kid)}`);
      }
      return ctx.signingKeys.getKey(kid)!;
    },
    {
      algorithms: ["HS256"],
      issuer: ctx.publicUrl.replace(/\/$/, ""),
      clockTolerance: `${CLOCK_TOLERANCE_S}s`,
    },
  );
  return payload as unknown as ParsedRefreshClaims;
}

function writeOAuthError(
  res: ServerResponse,
  error: string,
  description: string,
  status = 400,
): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(oauthError(error, description)));
}

/**
 * Atomic family revoke. Marks every non-revoked row in the family as
 * revoked with the provided reason. Per V4 FIX 23 commit-then-audit:
 * caller emits the Tier 1 audit AFTER this returns; if the audit insert
 * throws, the revoke is already committed (security wins over telemetry).
 */
function revokeFamilyForReuse(
  db: Database.Database,
  clock: Clock,
  familyId: string,
  reason: "reuse_detected" | "suspicious_replay",
): void {
  const now = clock.now();
  db.prepare(
    `UPDATE refresh_tokens
     SET revoked_at = ?, revoked_reason = ?
     WHERE family_id = ? AND revoked_at IS NULL`,
  ).run(String(now), reason, familyId);
}

/**
 * T19b reuse-detection branch. Invoked when the SELECTed refresh row has
 * a non-null `revoked_at`. Implements V3 §B-NEW-2 + V4 FIX 5/6/7/23:
 *
 *   - Beyond 10s grace OR revoked_reason != 'rotated' => HARD reuse:
 *     revoke family + Tier 1 audit auth.refresh.chain_revoked + 401.
 *   - Within grace + 'rotated' but no successor (orphan; should be
 *     impossible given partial UNIQUE idx_refresh_parent, but defended)
 *     => HARD reuse with reason=no_successor.
 *   - Within grace + 'rotated' + successor exists + same fingerprint:
 *     legitimate retry; re-mint deterministic pair via T08b iatOverride
 *     and return 200 with the SAME refresh_jti so the client gets
 *     byte-identical tokens.
 *   - Within grace + 'rotated' + successor exists + mismatch fingerprint:
 *     stolen-token signature. Atomic UPDATE ... RETURNING increments
 *     replay_count. >= 3 => revoke family + chain_revoked audit. Below
 *     threshold => Tier 1 suspicious_replay audit (no successor leaked).
 *
 * All rejection branches return 401 invalid_grant. The grace re-mint
 * branch returns 200 with the cached successor pair.
 *
 * T19c addition: `allowlistRecheckFailed` is true when the caller's IdP
 * membership refresh determined the user is no longer in any allowlisted
 * org. On the same-fingerprint grace branch (V4 FIX 7) we MUST deny the
 * retry instead of re-minting — the user lost org membership between
 * rotations and is no longer authorized. We revoke the family and emit
 * auth.login.denied.not_in_org (NOT chain_revoked: this is policy-based
 * rejection, not stolen-token detection).
 */
async function handleReuseBranch(
  res: ServerResponse,
  ctx: AuthHandlerContext,
  claims: ParsedRefreshClaims,
  row: RefreshRow,
  fingerprint: string | null,
  allowlistRecheckFailed: boolean,
): Promise<void> {
  const now = ctx.clock.now();
  const revokedAt = Number(row.revoked_at);
  const elapsed = now - revokedAt;
  const familyId = row.family_id;

  // Hard reuse: beyond grace OR not a normal rotation.
  if (elapsed >= GRACE_WINDOW_S || row.revoked_reason !== "rotated") {
    if (familyId) {
      revokeFamilyForReuse(ctx.db, ctx.clock, familyId, "reuse_detected");
    }
    audit("auth.refresh.chain_revoked", {
      tier: 1,
      metadata: {
        old_jti: claims.jti,
        family_id: familyId,
        reason: "hard_reuse",
        elapsed_seconds: elapsed,
      },
    });
    writeOAuthError(res, "invalid_grant", "Refresh token chain revoked", 401);
    return;
  }

  // Within grace + rotated: look up successor via partial UNIQUE index.
  const successor = ctx.db
    .prepare(
      `SELECT jti, user_id, org_id, family_id, parent_jti, revoked_at,
              revoked_reason, consumer_fingerprint, expires_at, last_used_at
       FROM refresh_tokens WHERE parent_jti = ?`,
    )
    .get(claims.jti) as RefreshRow | undefined;

  if (!successor) {
    // Orphan: revoke row marked 'rotated' but no successor — treat as hard reuse.
    if (familyId) {
      revokeFamilyForReuse(ctx.db, ctx.clock, familyId, "reuse_detected");
    }
    audit("auth.refresh.chain_revoked", {
      tier: 1,
      metadata: {
        old_jti: claims.jti,
        family_id: familyId,
        reason: "no_successor",
      },
    });
    writeOAuthError(res, "invalid_grant", "Refresh token chain revoked", 401);
    return;
  }

  // Fingerprint match → legitimate retry. Per V3 spec: "null fingerprint
  // is unknown; treat as mismatch" — security default. Only a non-null
  // exact match returns the cached successor.
  const fingerprintMatches =
    fingerprint !== null &&
    successor.consumer_fingerprint !== null &&
    successor.consumer_fingerprint === fingerprint;

  if (fingerprintMatches) {
    // V4 FIX 7: on the same-fingerprint grace re-mint, re-check that the
    // user is still in an allowlisted org. If the caller's IdP refresh
    // returned no allowlist match, deny — even though this is the
    // "legitimate retry" branch by fingerprint, the user's authorization
    // has been revoked at the IdP layer and we must not issue a new pair.
    if (allowlistRecheckFailed) {
      if (familyId) {
        revokeFamilyForReuse(ctx.db, ctx.clock, familyId, "reuse_detected");
      }
      audit("auth.login.denied.not_in_org", {
        tier: 1,
        metadata: {
          user_id: row.user_id,
          jti: claims.jti,
          family_id: familyId,
          phase: "refresh_grace",
        },
      });
      writeOAuthError(
        res,
        "invalid_grant",
        "User no longer in allowlisted org",
        401,
      );
      return;
    }
    // Deterministic re-mint: pin iat to (expires_at - REFRESH_TTL_S) so the
    // resulting JWT is byte-identical to the original. Phase 2 uses a fixed
    // 30-day refresh TTL — see REFRESH_TTL_S_DEFAULT in oauth-finalize.ts.
    const successorExpiresAt = Number(successor.expires_at);
    const successorIat = successorExpiresAt - REFRESH_TTL_S;
    const issuer = ctx.publicUrl.replace(/\/$/, "");

    const accessJwt = await mintAccessJWT({
      claims: {
        sub: successor.user_id,
        active_org_id: successor.org_id,
        family_id: successor.family_id ?? "",
        role: "member", // T19c re-derives from users table
      },
      registry: ctx.signingKeys,
      issuer,
      ttlSeconds: ACCESS_TTL_S,
      iatOverride: successorIat,
    });
    const { jwt: refreshJwt } = await mintRefreshJWT({
      claims: {
        sub: successor.user_id,
        active_org_id: successor.org_id,
        family_id: successor.family_id ?? "",
        // successor.parent_jti is guaranteed non-null: the SELECT above
        // is `WHERE parent_jti = claims.jti`, which excludes NULL rows.
        parent_jti: successor.parent_jti as string,
      },
      registry: ctx.signingKeys,
      issuer,
      ttlSeconds: REFRESH_TTL_S,
      jti: successor.jti,
      iatOverride: successorIat,
    });

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        access_token: accessJwt,
        refresh_token: refreshJwt,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_S,
      }),
    );
    return;
  }

  // Fingerprint mismatch within grace → atomic replay_count++.
  // The row was SELECTed by jti at the top of refreshTokenGrant and we
  // hold no transaction lock, but the row never DELETEs in Phase 2 — only
  // the revoked_at column flips. So `replayResult` is always defined.
  const replayResult = ctx.db
    .prepare(
      `UPDATE refresh_tokens
       SET replay_count = replay_count + 1
       WHERE jti = ?
       RETURNING replay_count`,
    )
    .get(claims.jti) as { replay_count: number };
  const replayCount = replayResult.replay_count;

  if (replayCount >= REPLAY_THRESHOLD) {
    if (familyId) {
      revokeFamilyForReuse(ctx.db, ctx.clock, familyId, "reuse_detected");
    }
    audit("auth.refresh.chain_revoked", {
      tier: 1,
      metadata: {
        old_jti: claims.jti,
        family_id: familyId,
        reason: "replay_threshold_hit",
        replay_count: replayCount,
      },
    });
    writeOAuthError(res, "invalid_grant", "Refresh token chain revoked", 401);
    return;
  }

  audit("auth.refresh.suspicious_replay", {
    tier: 1,
    metadata: {
      old_jti: claims.jti,
      family_id: familyId,
      replay_count: replayCount,
    },
  });
  writeOAuthError(res, "invalid_grant", "Refresh token validation failed", 401);
}

/**
 * POST /api/auth/oauth/token grant_type=refresh_token — refresh-token
 * rotation handler. See file header for full T19a+T19b flow.
 */
export async function refreshTokenGrant(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
  preParsedBody?: Record<string, string>,
): Promise<void> {
  // 1. Parse form body. T18 dispatcher already consumed the request stream
  //    when dispatching on grant_type; it passes the parsed body via
  //    preParsedBody so we don't try to re-read a finished stream. Direct
  //    callers (tests, future internal flows) leave preParsedBody undefined
  //    and we read the body ourselves.
  let body: Record<string, string>;
  if (preParsedBody !== undefined) {
    body = preParsedBody;
  } else {
    try {
      body = await parseFormBody(req);
    } catch {
      writeOAuthError(res, "invalid_request", "Could not parse body");
      return;
    }
  }
  const refreshToken = body.refresh_token;
  if (!refreshToken) {
    writeOAuthError(res, "invalid_request", "Missing refresh_token");
    return;
  }

  // 2. JWT verify
  let claims: ParsedRefreshClaims;
  try {
    claims = await verifyRefreshJwt(refreshToken, ctx);
  } catch (err) {
    audit("auth.invalid_token", {
      tier: 2,
      metadata: { reason: (err as Error).message },
    });
    writeOAuthError(res, "invalid_grant", "Token verification failed");
    return;
  }

  // 3. Service-account short-circuit. T19c will expand to verify the
  //    service token against the service_tokens table; T19a rejects
  //    flatly because service tokens never rotate.
  if (claims.service_account === true) {
    writeOAuthError(
      res,
      "invalid_grant",
      "Service tokens do not rotate. Mint a new one via admin CLI.",
    );
    return;
  }

  // 4. token_epoch check (T03).
  const epoch = readTokenEpoch(ctx.db, claims.sub);
  if (claims.iat < epoch) {
    audit("auth.invalid_token", {
      tier: 2,
      metadata: { reason: "token_epoch_exceeded" },
    });
    writeOAuthError(res, "invalid_grant", "Session invalidated by admin");
    return;
  }

  // 5. SELECT refresh row (includes revoked_reason for T19b).
  const row = ctx.db
    .prepare(
      `SELECT jti, user_id, org_id, family_id, parent_jti, revoked_at,
              revoked_reason, consumer_fingerprint, expires_at, last_used_at
       FROM refresh_tokens WHERE jti = ?`,
    )
    .get(claims.jti) as RefreshRow | undefined;
  if (!row) {
    audit("auth.invalid_token", {
      tier: 2,
      metadata: { reason: "row_not_found" },
    });
    writeOAuthError(res, "invalid_grant", "Unknown refresh token");
    return;
  }

  // Compute fingerprint BEFORE the revoked-row branch (handleReuseBranch
  // needs it for the grace-window match check).
  const ip = req.socket?.remoteAddress ?? null;
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;
  const fingerprint = computeFingerprint(ip, ua);

  const now = ctx.clock.now();

  // 6. T19c idle-timeout check (V4 FIX 24). Configurable via org-settings
  //    shim: orgs.session_idle_timeout column (Phase 5) or
  //    COORDINATOR_SESSION_IDLE_TIMEOUT env (Phase 2). Empty / "0" / unset
  //    disables the check. Format: "60s", "15m", "2h", "30d".
  //
  //    On expiry: revoke ONLY this row (not the whole family — other
  //    sessions from the same family-ancestry could be legitimately
  //    active from a different consumer). 400 invalid_grant + Tier 2
  //    audit auth.refresh.idle_expired.
  const idleTimeoutRaw = getOrgSetting(
    ctx.db,
    row.org_id,
    "session_idle_timeout",
    "",
  );
  if (idleTimeoutRaw && idleTimeoutRaw !== "0") {
    const idleTimeoutS = parseDuration(idleTimeoutRaw);
    // last_used_at is optional; fall back to row creation time if absent
    // (defensive — schema sets a value on insert in T16helpers).
    const lastUsedAt = row.last_used_at !== null && row.last_used_at !== undefined
      ? Number(row.last_used_at)
      : claims.iat;
    const idleElapsed = now - lastUsedAt;
    if (idleElapsed > idleTimeoutS) {
      ctx.db
        .prepare(
          `UPDATE refresh_tokens
           SET revoked_at = ?, revoked_reason = 'idle_expired'
           WHERE jti = ? AND revoked_at IS NULL`,
        )
        .run(String(now), claims.jti);
      audit("auth.refresh.idle_expired", {
        tier: 2,
        metadata: {
          jti: claims.jti,
          user_id: row.user_id,
          idle_elapsed: idleElapsed,
          idle_timeout: idleTimeoutS,
        },
      });
      writeOAuthError(res, "invalid_grant", "Session idle timeout");
      return;
    }
  }

  // 7. T19c IdP membership refresh + allowlist re-check (V4 FIX 7).
  //    Loads users.idp_access_token (T16b sets on login). If absent:
  //    Phase 1 migration user — skip allowlist refresh, rely on token_epoch.
  //    Otherwise: call membershipCache (60s positive TTL + stale-on-error).
  //
  //    IdPTokenRevoked  → 401 + WWW-Authenticate + Tier 1 audit.
  //    IdPTransientError → 503 (stale-window already consumed in cache
  //                       layer; reaching here means no fresh AND no stale).
  //    Other errors      → propagate (unexpected).
  //
  //    resolveOrgFromMemberships null → user lost allowlisted-org access:
  //    revoke this row + Tier 1 audit + 401. Other families' sessions are
  //    untouched and will fail their own allowlist check on next refresh
  //    (or simply expire after token_epoch bump if admin chooses).
  const userRow = ctx.db
    .prepare("SELECT idp_access_token, idp_provider FROM users WHERE id = ?")
    .get(row.user_id) as
    | { idp_access_token: string | null; idp_provider: string }
    | undefined;
  const idpAccessToken = userRow?.idp_access_token ?? null;
  const idpProviderName = userRow?.idp_provider ?? null;

  // T46: look up the IdP via the registry using the user's stored
  // idp_provider. If a previously-provisioned user's provider is no
  // longer registered (e.g. operator removed it from boot config),
  // skip the allowlist recheck — token_epoch remains the kill switch.
  const idpProvider = idpProviderName ? ctx.providers.get(idpProviderName) : null;

  let allowlistMatch: AllowlistMatch | null = null;
  let allowlistRecheckPerformed = false;
  if (idpAccessToken && idpProvider) {
    allowlistRecheckPerformed = true;
    try {
      const memberships = await ctx.membershipCache.getMemberships(
        claims.sub,
        idpProvider,
        idpAccessToken,
      );
      allowlistMatch = resolveOrgFromMemberships(ctx.db, memberships);
    } catch (err) {
      if (err instanceof IdPTokenRevoked) {
        audit("auth.idp.token_revoked", {
          tier: 1,
          metadata: {
            user_id: row.user_id,
            phase: "refresh_membership_check",
          },
        });
        res.writeHead(401, {
          "Content-Type": "application/json; charset=utf-8",
          "WWW-Authenticate": bearerAuthHeader(
            "invalid_token",
            "IdP rejected the token",
          ),
        });
        res.end(
          JSON.stringify(
            oauthError("invalid_grant", "Identity provider rejected the token"),
          ),
        );
        return;
      }
      if (err instanceof IdPTransientError) {
        res.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify(
            oauthError("temporarily_unavailable", "Identity provider unavailable"),
          ),
        );
        return;
      }
      throw err;
    }

    // If the row is already revoked, defer allowlist denial to the
    // reuse-detection branch — it has the policy context (grace-window,
    // fingerprint match, family) needed to issue the right rejection.
    // Only the main rotation path revokes-this-row-only with reason='admin'.
    if (!allowlistMatch && row.revoked_at === null) {
      ctx.db
        .prepare(
          `UPDATE refresh_tokens
           SET revoked_at = ?, revoked_reason = 'admin'
           WHERE jti = ? AND revoked_at IS NULL`,
        )
        .run(String(now), claims.jti);
      audit("auth.login.denied.not_in_org", {
        tier: 1,
        metadata: {
          user_id: row.user_id,
          jti: claims.jti,
          phase: "refresh_rotation",
        },
      });
      writeOAuthError(
        res,
        "invalid_grant",
        "User is not in any allowlisted org",
        401,
      );
      return;
    }
  }

  // 8. T19b reuse-detection branch. Pass whether the IdP allowlist
  //    re-check failed; the grace re-mint path (V4 FIX 7) uses this to
  //    deny retries from users who lost allowlist access. Note: when
  //    allowlistRecheckPerformed is false (no idp_access_token), the
  //    grace branch trusts the prior session — same as Phase 1 behavior.
  if (row.revoked_at !== null) {
    const recheckFailed = allowlistRecheckPerformed && !allowlistMatch;
    await handleReuseBranch(res, ctx, claims, row, fingerprint, recheckFailed);
    return;
  }

  // 9. Atomic rotation (V4 FIX 5).
  const updateResult = ctx.db
    .prepare(
      `UPDATE refresh_tokens
       SET revoked_at = ?, revoked_reason = 'rotated'
       WHERE jti = ? AND revoked_at IS NULL`,
    )
    .run(String(now), claims.jti);
  if (updateResult.changes !== 1) {
    writeOAuthError(res, "invalid_grant", "Rotation race; please retry");
    return;
  }

  // 10. Mint new pair sharing the family_id.
  const newPair = await mintTokenPair(ctx.db, ctx.clock, {
    user: {
      user_id: row.user_id,
      primary_org_id: row.org_id,
      role: "member",
    },
    registry: ctx.signingKeys,
    issuer: ctx.publicUrl.replace(/\/$/, ""),
    familyId: row.family_id ?? undefined,
    fingerprint,
  });

  // 11. Fix successor.parent_jti.
  ctx.db
    .prepare("UPDATE refresh_tokens SET parent_jti = ? WHERE jti = ?")
    .run(claims.jti, newPair.refreshJti);

  // 12. Tier 2 audit.
  audit("auth.refresh.rotated", {
    tier: 2,
    metadata: {
      old_jti: claims.jti,
      new_jti: newPair.refreshJti,
      family_id: newPair.familyId,
    },
  });

  // 13. RFC 6749 §5.1 successful token response.
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      access_token: newPair.accessJwt,
      refresh_token: newPair.refreshJwt,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
    }),
  );
}
