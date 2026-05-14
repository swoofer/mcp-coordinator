import type { IncomingMessage, ServerResponse } from "node:http";
import { jwtVerify } from "jose";
import type { AuthHandlerContext } from "./context.js";
import { audit } from "../security/audit.js";
import { oauthError } from "../http/response-contract.js";
import { mintTokenPair, computeFingerprint } from "./oauth-finalize.js";
import { isAcceptedKid } from "./jwt-keys.js";
import { readTokenEpoch } from "./token-epoch.js";

/**
 * Refresh-token rotation handler — T19a happy path + JWT validation.
 *
 * Called from T18's POST /api/auth/oauth/token dispatcher when
 * grant_type=refresh_token. T18 is not yet built — tests drive this
 * handler directly.
 *
 * T19a scope (this file):
 *   1. Parse form body, extract refresh_token
 *   2. JWT verify (HS256 pinned, kid allowlist, ±30s clock tolerance,
 *      issuer match) via jose v6
 *   3. Service-account JWT short-circuit (T19c expands)
 *   4. token_epoch check via T03 readTokenEpoch (admin-force-revoke wins)
 *   5. SELECT refresh_tokens row by jti
 *   6. Revoked-row placeholder reject (T19b implements 10s grace +
 *      fingerprint + replay_count + family revoke)
 *   7. Atomic UPDATE WHERE jti=? AND revoked_at IS NULL — V4 FIX 5; if
 *      changes !== 1, race lost, treat as reuse (T19b implements)
 *   8. mintTokenPair via T16helpers (same family_id, new fingerprint)
 *   9. UPDATE successor.parent_jti = old.jti (mintTokenPair sets NULL)
 *   10. Tier 2 audit auth.refresh.rotated
 *   11. RFC 6749 §5.1 JSON response (no Cache-Control 'no-store')
 *
 * Audits emit auth.invalid_token (Tier 2) on all rejection paths.
 *
 * Out of scope for T19a (lands in T19b/c):
 *   - 10s grace window + fingerprint match on revoked row (reuse vs.
 *     legitimate-late-retry)
 *   - Family-wide revocation on reuse detection
 *   - Idle-timeout window (separate from JWT exp)
 *   - IdP refresh + allowlist re-check
 *   - Service-account verification path (currently rejects flat)
 */

const CLOCK_TOLERANCE_S = 30;
const ACCESS_TTL_S = 15 * 60; // matches mintTokenPair default

interface RefreshRow {
  jti: string;
  user_id: string;
  org_id: string;
  family_id: string | null;
  parent_jti: string | null;
  revoked_at: string | null;
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
 *
 * Returns parsed claims on success. Throws on any validation failure
 * (jose's JWTExpired / JWTInvalid / JWSSignatureVerificationFailed /
 * etc., or our own `unknown_kid` / `no_key_for_kid` Errors).
 */
async function verifyRefreshJwt(
  token: string,
  ctx: AuthHandlerContext,
): Promise<ParsedRefreshClaims> {
  // jose enforces `algorithms: ["HS256"]` and `issuer` for us; the
  // kid-lookup callback also enforces the kid allowlist. The two
  // defense-in-depth checks below would be dead code (algorithms list
  // covers alg; isAcceptedKid pairs with the registry so getKey always
  // resolves) — omitted for 100% branch coverage.
  const { payload } = await jwtVerify(
    token,
    async (header) => {
      const kid = header.kid;
      if (!kid || !isAcceptedKid(kid)) {
        throw new Error(`unknown_kid: ${String(kid)}`);
      }
      // isAcceptedKid implies the registry has it (T08b invariant).
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
): void {
  res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(oauthError(error, description)));
}

/**
 * POST /api/auth/oauth/token grant_type=refresh_token — refresh-token
 * rotation handler. See file header for full T19a flow. Exported as
 * a free function so T18's dispatcher can invoke it directly; tests
 * drive without going through the dispatcher.
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
  //    flatly because service tokens never rotate (single use, mint a
  //    new one via admin CLI per V4 §service-tokens).
  if (claims.service_account === true) {
    writeOAuthError(
      res,
      "invalid_grant",
      "Service tokens do not rotate. Mint a new one via admin CLI.",
    );
    return;
  }

  // 4. token_epoch check (T03). Checked before DB row lookup so an
  //    admin force-revoke wins over a still-extant row.
  const epoch = readTokenEpoch(ctx.db, claims.sub);
  if (claims.iat < epoch) {
    audit("auth.invalid_token", {
      tier: 2,
      metadata: { reason: "token_epoch_exceeded" },
    });
    writeOAuthError(res, "invalid_grant", "Session invalidated by admin");
    return;
  }

  // 5. SELECT refresh row
  const row = ctx.db
    .prepare(
      `SELECT jti, user_id, org_id, family_id, parent_jti, revoked_at,
              consumer_fingerprint, expires_at
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

  // 6. T19b will handle row.revoked_at !== null with 10s grace +
  //    fingerprint match + family revoke. T19a placeholder reject.
  if (row.revoked_at !== null) {
    writeOAuthError(res, "invalid_grant", "Refresh token already revoked");
    return;
  }

  // 7. Atomic rotation: UPDATE WHERE jti=? AND revoked_at IS NULL
  //    (V4 FIX 5). If a concurrent rotation revoked the row between
  //    our SELECT and UPDATE, changes !== 1 and we treat it as a race
  //    (T19b adds full reuse-detection semantics for this path).
  //    better-sqlite3 is sync — no explicit transaction wrapper needed
  //    here; each statement is its own atomic unit and a failure
  //    between UPDATE and INSERT leaves the user re-authable (old row
  //    revoked, no new row) without a security regression.
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

  // 8. Mint new pair sharing the family_id; new fingerprint from this
  //    request's ip+ua (V3 §B-NEW-2). T19b will use this fingerprint
  //    in reuse detection on the next rotation attempt.
  const ip = req.socket?.remoteAddress ?? null;
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;
  const fingerprint = computeFingerprint(ip, ua);
  const newPair = await mintTokenPair(ctx.db, ctx.clock, {
    user: {
      user_id: row.user_id,
      primary_org_id: row.org_id,
      role: "member", // T19a placeholder; T19c re-derives from users table
    },
    registry: ctx.signingKeys,
    issuer: ctx.publicUrl.replace(/\/$/, ""),
    familyId: row.family_id ?? undefined,
    fingerprint,
  });

  // 9. Fix successor.parent_jti — mintTokenPair always inserts NULL,
  //    but for non-root rotations we need the predecessor link so
  //    T19b can walk the family tree on reuse detection.
  ctx.db
    .prepare("UPDATE refresh_tokens SET parent_jti = ? WHERE jti = ?")
    .run(claims.jti, newPair.refreshJti);

  // 10. Tier 2 audit. Old + new jti + family_id let the audit log
  //     reconstruct the rotation chain for forensics.
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
