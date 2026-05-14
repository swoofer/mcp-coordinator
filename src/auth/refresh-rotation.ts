import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { jwtVerify } from "jose";
import type { AuthHandlerContext } from "./context.js";
import type { Clock } from "./clock.js";
import { audit } from "../security/audit.js";
import { oauthError } from "../http/response-contract.js";
import { mintTokenPair, computeFingerprint } from "./oauth-finalize.js";
import { mintAccessJWT, mintRefreshJWT } from "./jwt-mint.js";
import { isAcceptedKid } from "./jwt-keys.js";
import { readTokenEpoch } from "./token-epoch.js";

/**
 * Refresh-token rotation handler — T19a happy path + T19b reuse detection.
 *
 * Called from T18's POST /api/auth/oauth/token dispatcher when
 * grant_type=refresh_token. T18 is not yet built — tests drive this
 * handler directly.
 *
 * T19a/b scope:
 *   1. Parse form body, extract refresh_token
 *   2. JWT verify (HS256 pinned, kid allowlist, ±30s clock tolerance,
 *      issuer match) via jose v6
 *   3. Service-account JWT short-circuit (T19c expands)
 *   4. token_epoch check via T03 readTokenEpoch (admin-force-revoke wins)
 *   5. SELECT refresh_tokens row by jti
 *   6. T19b reuse-detection branch on row.revoked_at != null:
 *      - 10s grace + revoked_reason='rotated' + fingerprint match
 *        => deterministic successor re-mint (V3 §B-NEW-2)
 *      - 10s grace + fingerprint mismatch => replay_count++ atomic;
 *        threshold (3) => family revoke + chain_revoked audit; below
 *        threshold => suspicious_replay audit
 *      - Beyond grace OR not 'rotated' OR no successor => family revoke
 *        + chain_revoked audit
 *      All branches return 401 with oauthError("invalid_grant", ...).
 *   7. Atomic UPDATE WHERE jti=? AND revoked_at IS NULL — V4 FIX 5
 *   8. mintTokenPair via T16helpers (same family_id, new fingerprint)
 *   9. UPDATE successor.parent_jti = old.jti
 *   10. Tier 2 audit auth.refresh.rotated
 *   11. RFC 6749 §5.1 JSON response
 *
 * Out of scope for T19b (lands in T19c):
 *   - Allowlist re-check on grace-branch successor return (V4 FIX 7)
 *   - Idle-timeout window
 *   - IdP refresh + membership refresh
 *   - Service-account verification path
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
 * V4 FIX 7 allowlist re-check on the grace-branch return is deferred to
 * T19c (which also adds the idle-timeout + IdP membership refresh).
 */
async function handleReuseBranch(
  res: ServerResponse,
  ctx: AuthHandlerContext,
  claims: ParsedRefreshClaims,
  row: RefreshRow,
  fingerprint: string | null,
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
              revoked_reason, consumer_fingerprint, expires_at
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
    // T19c will add the V4 FIX 7 allowlist re-check here before re-issue.
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
): Promise<void> {
  // 1. Parse form body
  let body: Record<string, string>;
  try {
    body = await parseFormBody(req);
  } catch {
    writeOAuthError(res, "invalid_request", "Could not parse body");
    return;
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
              revoked_reason, consumer_fingerprint, expires_at
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

  // 6. T19b reuse-detection branch.
  if (row.revoked_at !== null) {
    await handleReuseBranch(res, ctx, claims, row, fingerprint);
    return;
  }

  // 7. Atomic rotation (V4 FIX 5).
  const now = ctx.clock.now();
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

  // 8. Mint new pair sharing the family_id.
  const newPair = await mintTokenPair(ctx.db, ctx.clock, {
    user: {
      user_id: row.user_id,
      primary_org_id: row.org_id,
      role: "member", // T19c re-derives from users table
    },
    registry: ctx.signingKeys,
    issuer: ctx.publicUrl.replace(/\/$/, ""),
    familyId: row.family_id ?? undefined,
    fingerprint,
  });

  // 9. Fix successor.parent_jti.
  ctx.db
    .prepare("UPDATE refresh_tokens SET parent_jti = ? WHERE jti = ?")
    .run(claims.jti, newPair.refreshJti);

  // 10. Tier 2 audit.
  audit("auth.refresh.rotated", {
    tier: 2,
    metadata: {
      old_jti: claims.jti,
      new_jti: newPair.refreshJti,
      family_id: newPair.familyId,
    },
  });

  // 11. RFC 6749 §5.1 successful token response.
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
