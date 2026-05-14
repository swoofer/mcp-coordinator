// T25 — POST /api/admin/service-tokens. Admin-only service-token issuance.
// Per V4 FIX 10 + V2 §A.7. Emits Tier 1 audit auth.service_token.issued so
// the provenance trail survives even if the audit queue drains late.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "../auth/context.js";
import { authenticateRequest } from "../auth.js";
import { appError } from "../http/response-contract.js";
import {
  issueServiceToken,
  ServiceTokenValidationError,
  type ServiceTokenScope,
} from "../auth/service-tokens.js";
import { audit } from "../security/audit.js";

interface IssueRequestBody {
  user_id?: unknown;
  org_id?: unknown;
  scope?: unknown;
  ttl?: unknown;
  reason?: unknown;
}

/**
 * Parse a duration string of the form `Ns|Nm|Nh|Nd` into seconds.
 * Throws on any other shape — caller surfaces as 400 INVALID_TTL.
 */
function parseDurationSeconds(s: string): number {
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) throw new Error(`invalid duration: ${s}`);
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case "s":
      return n;
    case "m":
      return n * 60;
    case "h":
      return n * 3600;
    case "d":
      return n * 86400;
    /* c8 ignore next 2 — regex character class already constrains m[2] */
    default:
      throw new Error("unreachable");
  }
}

export async function handleIssueServiceToken(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const authResult = await authenticateRequest(req, { authEnabled: true });
  if (!authResult.ok) {
    res.writeHead(authResult.status, {
      "Content-Type": "application/json; charset=utf-8",
      ...(authResult.wwwAuthenticate
        ? { "WWW-Authenticate": authResult.wwwAuthenticate }
        : {}),
    });
    res.end(JSON.stringify(appError("UNAUTHORIZED", authResult.error)));
    return;
  }
  if (authResult.claims.role !== "admin") {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify(
        appError("FORBIDDEN", "Only admins can issue service tokens"),
      ),
    );
    return;
  }

  // Parse JSON body. Bounded read — we don't expect bodies >4KB on this
  // endpoint; misuse beyond that gets a 400 rather than letting it grow.
  let body: IssueRequestBody;
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > 4096) {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify(appError("INVALID_REQUEST", "Request body too large")),
        );
        return;
      }
      chunks.push(buf);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify(appError("INVALID_REQUEST", "Could not parse JSON body")),
    );
    return;
  }

  if (
    typeof body.user_id !== "string" ||
    typeof body.org_id !== "string" ||
    typeof body.scope !== "string" ||
    typeof body.ttl !== "string" ||
    typeof body.reason !== "string"
  ) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify(appError("INVALID_REQUEST", "Missing required fields")),
    );
    return;
  }

  let ttlSeconds: number;
  try {
    ttlSeconds = parseDurationSeconds(body.ttl);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify(
        appError("INVALID_TTL", "Invalid TTL format; use Ns/Nm/Nh/Nd"),
      ),
    );
    return;
  }

  try {
    const issued = await issueServiceToken({
      db: ctx.db,
      clock: ctx.clock,
      signingKeys: ctx.signingKeys,
      issuer: ctx.publicUrl.replace(/\/$/, ""),
      targetUserId: body.user_id,
      targetOrgId: body.org_id,
      scope: body.scope as ServiceTokenScope,
      ttlSeconds,
      reason: body.reason,
      issuedByAdminId: authResult.claims.user_id,
    });

    audit("auth.service_token.issued", {
      tier: 1,
      metadata: {
        jti: issued.jti,
        issued_by: authResult.claims.user_id,
        target_user_id: body.user_id,
        target_org_id: body.org_id,
        scope: body.scope,
        ttl_seconds: ttlSeconds,
        reason: body.reason,
      },
    });

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        jti: issued.jti,
        access_token: issued.accessToken,
        expires_at: new Date(issued.expiresAt * 1000).toISOString(),
      }),
    );
  } catch (err) {
    /* c8 ignore next 4 — non-validation errors are programming bugs; tested
       paths only hit the ServiceTokenValidationError branch. */
    if (!(err instanceof ServiceTokenValidationError)) {
      throw err;
    }
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError(err.code, err.message)));
  }
}
