// T05 (v0.10.6) — Admin-UI orgs endpoints. Three handlers behind admin gate:
//   GET   /api/admin/orgs          → list (no CSRF, no audit)
//   POST  /api/admin/orgs          → create (CSRF, Tier 1 audit admin.org.created)
//   PATCH /api/admin/orgs/:id      → update (CSRF, Tier 1 audit admin.org.updated)
//
// Mirrors src/admin/handle-service-tokens.ts for the admin auth gate, bounded
// body read, and appError envelope. Mutations run inside `db.transaction(fn)
// .immediate()` so the row write + audit row land atomically — see V3 PATCH 2
// (BEGIN IMMEDIATE) and V3 PATCH 5. UNIQUE INDEX `idx_orgs_name` (T03) makes
// duplicate names surface as SQLITE_CONSTRAINT, which we translate to 409
// ORG_NAME_TAKEN. Audit metadata is strict flat scalars (V3 PATCH 13).
// request_id is auto-injected by appError() (V3 PATCH 16).
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AuthHandlerContext } from "../auth/context.js";
import { authenticateRequest } from "../auth.js";
import { appError } from "../http/response-contract.js";
import { audit } from "../security/audit.js";
import { parseCookies, CSRF_COOKIE_NAME } from "../auth/cookies.js";
import { verifyCsrfToken } from "../auth/csrf.js";
import {
  AdminValidationError,
  validateAllowlistField,
  validateNameField,
  validatePathParam,
  validateUpdateBody,
} from "./validate.js";
import { writeJson, readJsonBody, writeValidationError } from "./admin-common.js";

interface OrgRow {
  id: string;
  name: string;
  allowlist_github_org: string | null;
  allowlist_idp_org_id: string | null;
  created_at: string;
}

const ORG_BODY_FIELDS = [
  "name",
  "allowlist_github_org",
  "allowlist_idp_org_id",
] as const;

/** Admin gate. Returns the AuthClaims on success, null on rejection (response
 *  already written). Mirrors handle-service-tokens.ts §authenticateRequest. */
async function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<
  | { user_id: string; org: string; role: "admin" }
  | null
> {
  const authResult = await authenticateRequest(req, { authEnabled: true });
  if (!authResult.ok) {
    res.writeHead(authResult.status, {
      "Content-Type": "application/json; charset=utf-8",
      ...(authResult.wwwAuthenticate
        ? { "WWW-Authenticate": authResult.wwwAuthenticate }
        : {}),
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

/** Double-submit CSRF check on mutating endpoints. Returns true if valid. */
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

/** Detect SQLITE_CONSTRAINT_UNIQUE on idx_orgs_name. better-sqlite3 surfaces
 *  this as a regular Error with `UNIQUE constraint failed: orgs.name` in the
 *  message; the unique index also fires with `idx_orgs_name` in some sqlite
 *  builds. We match against both phrasings for portability. */
function isOrgNameUniqueViolation(err: unknown): boolean {
  /* c8 ignore next — defensive: only Errors reach the catch in practice. */
  if (!(err instanceof Error)) return false;
  // better-sqlite3 surfaces the unique index hit on orgs.name as
  // "UNIQUE constraint failed: orgs.name" (the index is on the column, not
  // the index name); same shape across sqlite 3.32+ + bun:sqlite.
  return err.message.includes("UNIQUE constraint failed: orgs.name");
}

// ===========================================================================
// GET /api/admin/orgs
// ===========================================================================
export async function handleListOrgs(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const claims = await requireAdmin(req, res);
  if (!claims) return;

  const rows = ctx.db
    .prepare(
      `SELECT id, name, allowlist_github_org, allowlist_idp_org_id, created_at
       FROM orgs
       ORDER BY created_at ASC, id ASC
       LIMIT 5000`,
    )
    .all() as OrgRow[];

  writeJson(res, 200, { orgs: rows });
}

// ===========================================================================
// POST /api/admin/orgs
// ===========================================================================
interface CreateOrgBody {
  name?: unknown;
  allowlist_github_org?: unknown;
  allowlist_idp_org_id?: unknown;
}

export async function handleCreateOrg(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const claims = await requireAdmin(req, res);
  if (!claims) return;
  if (!checkCsrf(req, res)) return;

  const body = await readJsonBody<CreateOrgBody>(req, res);
  if (!body) return;

  // Reject unknown fields up-front (PATCH 11: code-only, no input echo).
  for (const key of Object.keys(body)) {
    if (!ORG_BODY_FIELDS.includes(key as (typeof ORG_BODY_FIELDS)[number])) {
      writeValidationError(
        res,
        new AdminValidationError("UNKNOWN_FIELD", key),
      );
      return;
    }
  }

  let name: string;
  let allowGithub: string | null;
  let allowIdp: string | null;
  try {
    name = validateNameField(body.name, "name");
    allowGithub =
      body.allowlist_github_org === undefined
        ? null
        : validateAllowlistField(body.allowlist_github_org, "allowlist_github_org");
    allowIdp =
      body.allowlist_idp_org_id === undefined
        ? null
        : validateAllowlistField(body.allowlist_idp_org_id, "allowlist_idp_org_id");
  } catch (err) {
    /* c8 ignore next 2 — non-validation errors are programming bugs. */
    if (!(err instanceof AdminValidationError)) throw err;
    writeValidationError(res, err);
    return;
  }

  const orgId = randomUUID();

  let createdRow: OrgRow;
  try {
    const tx = ctx.db.transaction((): OrgRow => {
      ctx.db
        .prepare(
          `INSERT INTO orgs
             (id, name, allowlist_github_org, allowlist_idp_org_id, created_at)
           VALUES (?, ?, ?, ?, datetime('now'))`,
        )
        .run(orgId, name, allowGithub, allowIdp);

      const row = ctx.db
        .prepare(
          `SELECT id, name, allowlist_github_org, allowlist_idp_org_id, created_at
             FROM orgs WHERE id = ?`,
        )
        .get(orgId) as OrgRow;

      audit("admin.org.created", {
        tier: 1,
        metadata: {
          org_id: orgId,
          target_org_id: orgId,
          name,
          allowlist_github_org: allowGithub,
          allowlist_idp_org_id: allowIdp,
        },
      });
      return row;
    });
    createdRow = tx.immediate();
  } catch (err) {
    /* c8 ignore next — unexpected DB errors bubble up as a 500 via the dispatcher. */
    if (!isOrgNameUniqueViolation(err)) throw err;
    writeJson(
      res,
      409,
      appError("ORG_NAME_TAKEN", "An org with this name already exists"),
    );
    return;
  }

  writeJson(res, 201, { org: createdRow });
}

// ===========================================================================
// PATCH /api/admin/orgs/:id
// ===========================================================================
interface UpdateOrgBody {
  name?: unknown;
  allowlist_github_org?: unknown;
  allowlist_idp_org_id?: unknown;
}

const ORG_PATH_RE = /^\/api\/admin\/orgs\/([^/]+)$/;

export async function handleUpdateOrg(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const claims = await requireAdmin(req, res);
  if (!claims) return;
  if (!checkCsrf(req, res)) return;

  // Extract :id from the URL path. The dispatcher (T07) will only route
  // matching paths here, but we re-parse defensively so this handler is
  // safe to call standalone.
  const url = req.url ?? "";
  // String.split always returns at least one element, so the `[0]` is
  // never undefined; no `?? ""` fallback needed.
  const pathOnly = url.split(/[?#]/)[0]!;
  const m = ORG_PATH_RE.exec(pathOnly);
  if (!m) {
    writeJson(res, 400, appError("BAD_PATH", "Invalid org path"));
    return;
  }
  let rawId = m[1]!;
  try {
    rawId = decodeURIComponent(rawId);
  } catch {
    writeJson(res, 400, appError("BAD_PATH", "Invalid org path encoding"));
    return;
  }

  let orgId: string;
  try {
    orgId = validatePathParam(rawId, "id");
  } catch (err) {
    /* c8 ignore next — validators only throw AdminValidationError. */
    if (!(err instanceof AdminValidationError)) throw err;
    writeValidationError(res, err);
    return;
  }

  const body = await readJsonBody<UpdateOrgBody>(req, res);
  if (!body) return;

  try {
    validateUpdateBody(body as Record<string, unknown>, ORG_BODY_FIELDS);
  } catch (err) {
    /* c8 ignore next — validators only throw AdminValidationError. */
    if (!(err instanceof AdminValidationError)) throw err;
    writeValidationError(res, err);
    return;
  }

  // Validate each present field. Track which fields are present (undefined
  // means "not in body"; null is a meaningful clear).
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasGithub = Object.prototype.hasOwnProperty.call(
    body,
    "allowlist_github_org",
  );
  const hasIdp = Object.prototype.hasOwnProperty.call(
    body,
    "allowlist_idp_org_id",
  );

  let nameValue: string | undefined;
  let githubValue: string | null | undefined;
  let idpValue: string | null | undefined;
  try {
    if (hasName) nameValue = validateNameField(body.name, "name");
    if (hasGithub) {
      githubValue = validateAllowlistField(
        body.allowlist_github_org,
        "allowlist_github_org",
      );
    }
    if (hasIdp) {
      idpValue = validateAllowlistField(
        body.allowlist_idp_org_id,
        "allowlist_idp_org_id",
      );
    }
  } catch (err) {
    /* c8 ignore next — validators only throw AdminValidationError. */
    if (!(err instanceof AdminValidationError)) throw err;
    writeValidationError(res, err);
    return;
  }

  type TxOk = { ok: true; row: OrgRow };
  type TxFail = { ok: false; status: 404; code: "NOT_FOUND" };

  let outcome: TxOk | TxFail;
  try {
    const tx = ctx.db.transaction((): TxOk | TxFail => {
      const existing = ctx.db
        .prepare(
          `SELECT id, name, allowlist_github_org, allowlist_idp_org_id, created_at
             FROM orgs WHERE id = ?`,
        )
        .get(orgId) as OrgRow | undefined;
      if (!existing) {
        return { ok: false, status: 404, code: "NOT_FOUND" };
      }

      // Compose the SET clause from the present fields only.
      const sets: string[] = [];
      const params: Array<string | null> = [];
      const changedFields: string[] = [];
      const metadata: Record<string, unknown> = {
        org_id: orgId,
        target_org_id: orgId,
      };

      if (hasName && nameValue !== existing.name) {
        sets.push("name = ?");
        params.push(nameValue!);
        changedFields.push("name");
        metadata.name_before = existing.name;
        metadata.name_after = nameValue!;
      }
      if (hasGithub && githubValue !== existing.allowlist_github_org) {
        sets.push("allowlist_github_org = ?");
        params.push(githubValue ?? null);
        changedFields.push("allowlist_github_org");
        metadata.allowlist_github_org_before = existing.allowlist_github_org;
        metadata.allowlist_github_org_after = githubValue ?? null;
      }
      if (hasIdp && idpValue !== existing.allowlist_idp_org_id) {
        sets.push("allowlist_idp_org_id = ?");
        params.push(idpValue ?? null);
        changedFields.push("allowlist_idp_org_id");
        metadata.allowlist_idp_org_id_before = existing.allowlist_idp_org_id;
        metadata.allowlist_idp_org_id_after = idpValue ?? null;
      }

      if (sets.length > 0) {
        params.push(orgId);
        ctx.db
          .prepare(`UPDATE orgs SET ${sets.join(", ")} WHERE id = ?`)
          .run(...params);
      }

      const fresh = ctx.db
        .prepare(
          `SELECT id, name, allowlist_github_org, allowlist_idp_org_id, created_at
             FROM orgs WHERE id = ?`,
        )
        .get(orgId) as OrgRow;

      metadata.changed_fields = changedFields;

      audit("admin.org.updated", {
        tier: 1,
        metadata,
      });

      return { ok: true, row: fresh };
    });
    outcome = tx.immediate();
  } catch (err) {
    /* c8 ignore next — unexpected DB errors bubble up as a 500 via the dispatcher. */
    if (!isOrgNameUniqueViolation(err)) throw err;
    writeJson(
      res,
      409,
      appError("ORG_NAME_TAKEN", "An org with this name already exists"),
    );
    return;
  }

  if (!outcome.ok) {
    writeJson(res, 404, appError(outcome.code, "Org not found"));
    return;
  }

  writeJson(res, 200, { org: outcome.row });
}
