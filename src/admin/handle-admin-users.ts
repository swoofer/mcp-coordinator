// T06 (v0.10.6) — Admin-UI users endpoints. Two handlers behind admin gate:
//   GET   /api/admin/users          → list (no CSRF, no audit)
//   PATCH /api/admin/users/:id      → update role (CSRF, Tier 1 audit
//                                       admin.user.role_changed)
//
// Mirrors src/admin/handle-admin-orgs.ts (T05) for admin auth + CSRF + bounded
// JSON body + AppError envelope. The PATCH mutation runs inside
// `ctx.db.transaction(fn).immediate()` so the read-modify-write of the user
// row + audit row commits atomically with no TOCTOU window for the last-admin
// guard (V3 PATCH 1 + PATCH 2 + PATCH 5).
//
// Last-admin guard (V3 PATCH 1): the only invariant enforced server-side is
// "never let the admin count drop to 0". The guard SQL is a plain
// `SELECT COUNT(*) FROM users WHERE role = 'admin'` — there is NO dead
// `OR ? <> id` clause. The 'admin'→'member' downgrade is refused with 409
// LAST_ADMIN whenever the count would drop to 0, regardless of whether the
// target is the actor themselves or a different admin user.
//
// Body validation: only `role` is accepted (`validateUpdateBody` rejects
// anything else with UNKNOWN_FIELD; `validateRoleField` rejects values other
// than "admin" | "member"). Targeting an 'agent' or 'service' user surfaces
// 400 NOT_HUMAN_USER (V3 PATCH 12) — these roles are non-human principals
// and not eligible for role changes from this endpoint.
//
// Audit metadata is strict flat scalars (V3 PATCH 13): target_user_id,
// old_role, new_role. Actor info lands on the audit row's actor_user_id
// column via the outer withAuditContext established by the route dispatcher
// (T07 wires routes + audit context; this handler only emits).
//
// request_id is auto-injected by appError() (V3 PATCH 16).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "../auth/context.js";
import { authenticateRequest } from "../auth.js";
import { appError } from "../http/response-contract.js";
import { audit } from "../security/audit.js";
import { parseCookies, CSRF_COOKIE_NAME } from "../auth/cookies.js";
import { verifyCsrfToken } from "../auth/csrf.js";
import {
  AdminValidationError,
  validatePathParam,
  validateRoleField,
  validateUpdateBody,
} from "./validate.js";
import { writeJson, readJsonBody, writeValidationError } from "./admin-common.js";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "member" | "agent" | "service";
  primary_org_id: string;
  created_at: string;
  last_login_at: string | null;
}

const USER_BODY_FIELDS = ["role"] as const;

const USER_PATH_RE = /^\/api\/admin\/users\/([^/]+)$/;

/** Admin auth gate. Returns claim subset on success, null on rejection. */
async function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ user_id: string; org: string; role: "admin" } | null> {
  const authResult = await authenticateRequest(req, { authEnabled: true });
  if (!authResult.ok) {
    res.writeHead(authResult.status, {
      "Content-Type": "application/json; charset=utf-8",
      ...(authResult.wwwAuthenticate ? { "WWW-Authenticate": authResult.wwwAuthenticate } : {}),
    });
    res.end(JSON.stringify(appError("UNAUTHORIZED", authResult.error)));
    return null;
  }
  if (authResult.claims.role !== "admin") {
    writeJson(res, 403, appError("FORBIDDEN", "Admin role required"));
    return null;
  }
  return {
    user_id: authResult.claims.user_id,
    org: authResult.claims.org,
    role: "admin",
  };
}

/** Double-submit CSRF check for mutating endpoints. */
function checkCsrf(req: IncomingMessage, res: ServerResponse): boolean {
  const cookies = parseCookies(req);
  const cookieValue = cookies[CSRF_COOKIE_NAME];
  const headerRaw = req.headers["x-csrf-token"];
  const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (!verifyCsrfToken(cookieValue, headerValue)) {
    writeJson(res, 403, appError("CSRF_FAILED", "CSRF validation failed"));
    return false;
  }
  return true;
}

// ===========================================================================
// GET /api/admin/users
// ===========================================================================
/**
 * List users (admin role required). Optional `?org=<id>` filter scopes the
 * list to a single primary_org_id; otherwise returns all human users in the
 * deployment. Service tokens and agent identities are excluded (filter to
 * role IN ('admin','member') per V3 PATCH 12).
 *
 * Response shape: `{ users: [...], meta: { admin_count: N } }` where
 * `admin_count` is the GLOBAL count of admin users (NOT per-org filtered) —
 * the frontend uses this for the proactive "last admin" UX (V3 PATCH 14):
 * the demote `<option>` is disabled when admin_count === 1.
 *
 * Hard `LIMIT 5000` ceiling (no pagination in v0.10.6 — see V2 §Non-goals).
 */
export async function handleListUsers(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const claims = await requireAdmin(req, res);
  if (!claims) return;

  const url = new URL(req.url!, "http://localhost");
  const orgFilterRaw = url.searchParams.get("org");

  let orgFilter: string | null = null;
  if (orgFilterRaw !== null) {
    try {
      orgFilter = validatePathParam(orgFilterRaw, "org");
    } catch (err) {
      /* c8 ignore next — validators only throw AdminValidationError. */
      if (!(err instanceof AdminValidationError)) throw err;
      writeValidationError(res, err);
      return;
    }
  }

  // Filter to ('admin','member') only — exclude 'agent' and 'service'
  // roles (V3 PATCH 12). Optional primary_org_id scoping comes from ?org.
  const rows =
    orgFilter !== null
      ? (ctx.db
          .prepare(
            `SELECT id, email, name, role, primary_org_id, created_at, last_login_at
             FROM users
            WHERE role IN ('admin', 'member')
              AND primary_org_id = ?
            ORDER BY created_at ASC, id ASC
            LIMIT 5000`,
          )
          .all(orgFilter) as UserRow[])
      : (ctx.db
          .prepare(
            `SELECT id, email, name, role, primary_org_id, created_at, last_login_at
             FROM users
            WHERE role IN ('admin', 'member')
            ORDER BY created_at ASC, id ASC
            LIMIT 5000`,
          )
          .all() as UserRow[]);

  // admin_count is GLOBAL across the deployment — independent of ?org filter
  // (V3 PATCH 14). The proactive-disable banner needs a count that can't be
  // gamed by listing a single-admin org and getting count=1.
  const countRow = ctx.db
    .prepare("SELECT COUNT(*) AS admin_count FROM users WHERE role = 'admin'")
    .get() as { admin_count: number };

  writeJson(res, 200, {
    users: rows,
    meta: { admin_count: countRow.admin_count },
  });
}

// ===========================================================================
// PATCH /api/admin/users/:id
// ===========================================================================
interface UpdateUserBody {
  role?: unknown;
}

/**
 * Update a user's role (admin role required, CSRF required). Body shape:
 * `{ role: "admin" | "member" }`. Only `role` is accepted; any other field
 * returns 400 UNKNOWN_FIELD.
 *
 * Flow (all inside `db.transaction(fn).immediate()`):
 *   Phase 1 — SELECT target row. 404 NOT_FOUND when missing.
 *             400 NOT_HUMAN_USER when role IN ('agent','service').
 *             200 no-op when role is unchanged (no audit emitted).
 *   Phase 2 — If demoting an admin, SELECT COUNT(admin). Refuse with 409
 *             LAST_ADMIN when count === 1 (the last admin in the system).
 *             V3 PATCH 1: no actor-vs-target distinction — the invariant is
 *             "admin_count must never drop to 0", which is the same whether
 *             the actor demotes themselves or another admin.
 *   Phase 3 — UPDATE + Tier 1 audit admin.user.role_changed (atomic).
 *
 * The `.immediate()` suffix acquires SQLite's RESERVED lock at BEGIN rather
 * than at the first WRITE, eliminating the deferred-mode TOCTOU window
 * between the chain-tip SELECT inside audit() and our UPDATE (V3 PATCH 2).
 */
export async function handleUpdateUser(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const claims = await requireAdmin(req, res);
  if (!claims) return;
  if (!checkCsrf(req, res)) return;

  // Extract :id from the URL path. The dispatcher (T07) only routes matching
  // paths here, but we re-parse defensively so this handler is safe to call
  // standalone (and so unit tests don't need to mock a dispatcher).
  const urlPath = req.url!.split(/[?#]/)[0]!;
  const m = USER_PATH_RE.exec(urlPath);
  if (!m) {
    writeJson(res, 400, appError("BAD_PATH", "Invalid user path"));
    return;
  }
  let rawId = m[1]!;
  try {
    rawId = decodeURIComponent(rawId);
  } catch {
    writeJson(res, 400, appError("BAD_PATH", "Invalid user path encoding"));
    return;
  }

  let userId: string;
  try {
    userId = validatePathParam(rawId, "id");
  } catch (err) {
    /* c8 ignore next — validators only throw AdminValidationError. */
    if (!(err instanceof AdminValidationError)) throw err;
    writeValidationError(res, err);
    return;
  }

  const body = await readJsonBody<UpdateUserBody>(req, res);
  if (!body) return;

  try {
    validateUpdateBody(body as Record<string, unknown>, USER_BODY_FIELDS);
  } catch (err) {
    /* c8 ignore next */
    if (!(err instanceof AdminValidationError)) throw err;
    writeValidationError(res, err);
    return;
  }

  let newRole: "admin" | "member";
  try {
    newRole = validateRoleField(body.role, "role");
  } catch (err) {
    /* c8 ignore next */
    if (!(err instanceof AdminValidationError)) throw err;
    writeValidationError(res, err);
    return;
  }

  type TxOk = {
    ok: true;
    user: { id: string; role: "admin" | "member" };
    changed: boolean;
  };
  type TxFail =
    | { ok: false; status: 404; code: "NOT_FOUND"; message: string }
    | { ok: false; status: 400; code: "NOT_HUMAN_USER"; message: string }
    | { ok: false; status: 409; code: "LAST_ADMIN"; message: string };

  const tx = ctx.db.transaction((): TxOk | TxFail => {
    // Phase 1: read the target row.
    const target = ctx.db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) as
      { id: string; role: UserRow["role"] } | undefined;

    if (!target) {
      return {
        ok: false,
        status: 404,
        code: "NOT_FOUND",
        message: "User not found",
      };
    }
    if (target.role === "agent" || target.role === "service") {
      return {
        ok: false,
        status: 400,
        code: "NOT_HUMAN_USER",
        message: "Cannot change role of non-human user",
      };
    }
    if (target.role === newRole) {
      // No-op: role is already the requested value. No audit (we only emit
      // on actual state transitions per V3 PATCH 13 metadata discipline).
      return {
        ok: true,
        user: { id: target.id, role: newRole },
        changed: false,
      };
    }

    // Phase 2: last-admin guard. Only when demoting an admin (admin→member
    // when target.role === 'admin' AND newRole !== 'admin'). The count
    // INCLUDES the target user (admins-as-of-now). If the count is exactly
    // 1, the demote would leave zero admins → refuse.
    //
    // V3 PATCH 1: NO dead `OR ? <> id` clause. The invariant is "admin_count
    // must never drop to 0" — the actor-vs-target distinction is policy
    // noise that re-opens the lockout the guard exists to prevent.
    if (target.role === "admin" && newRole !== "admin") {
      const countRow = ctx.db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
        .get() as { n: number };
      if (countRow.n === 1) {
        return {
          ok: false,
          status: 409,
          code: "LAST_ADMIN",
          message: "Cannot demote last admin. Promote another user first.",
        };
      }
    }

    // Phase 3: UPDATE + audit (atomic — same tx).
    ctx.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(newRole, userId);

    audit("admin.user.role_changed", {
      tier: 1,
      metadata: {
        target_user_id: userId,
        old_role: target.role,
        new_role: newRole,
      },
    });

    return {
      ok: true,
      user: { id: userId, role: newRole },
      changed: true,
    };
  });
  const outcome: TxOk | TxFail = tx.immediate();

  if (!outcome.ok) {
    writeJson(res, outcome.status, appError(outcome.code, outcome.message));
    return;
  }

  writeJson(res, 200, { user: outcome.user });
}
