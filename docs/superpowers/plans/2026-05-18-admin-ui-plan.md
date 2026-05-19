# Admin web UI for orgs + users — implementation plan v1

> **For agentic workers**: REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each task is an atomic PR. Acceptance = all listed test files pass + lint clean + coverage gate met.

## Status

**Plan version**: v1 (initial draft, pre-review)
**Version target**: mcp-coordinator@0.10.6
**Date**: 2026-05-18
**Spec**: `docs/superpowers/specs/2026-05-18-admin-ui-design.md` (V2)
**Spec patches**: `docs/superpowers/specs/2026-05-18-admin-ui-design-V3-patches.md` (18 patches)
**Review trail**: `docs/superpowers/working/v0.10.6-admin-ui/round1/` (6 reviewers) + `round2/` (3 reviewers)
**Companion**: v0.10.5 IdP encryption (`docs/superpowers/plans/2026-05-17-idp-encryption-plan.md`) — same plan structure

## Revisions

(Empty — initial draft. Each plan-review round adds a revision section here.)

## Plan structure

16 tasks across 4 phases. Phase ordering reflects dependencies; tasks within a phase may run sequentially or in parallel as noted.

```
Phase A — Foundation              (T01-T03)   constants, audit registration, schema. Mergeable independently.
Phase B — Backend handlers        (T04-T08)   validate.ts + 2 handlers + route wiring + static-handler headers.
Phase C — Frontend                (T09-T12)   shared infra (CSS + strings + admin.js) + 3 page bundles.
Phase D — Tests, docs, release    (T13-T16)   integration + e2e + docs + npm publish.
```

### Dependency DAG

```
T01 (CSRF_COOKIE_NAME + boot guard infra) ─┐
T02 (TIER1_EVENTS registration)            ├─→ (independent, parallel)
T03 (orgs UNIQUE INDEX + pre-flight guard) ─┘

T04 (src/admin/validate.ts) ─┬─→ T05 (handle-admin-orgs.ts)   ──┐
                             └─→ T06 (handle-admin-users.ts)  ──┤
T03 (UNIQUE INDEX present) ──→ T05 (409 ORG_NAME_TAKEN path)    │
T02 (TIER1_EVENTS) ──────────→ T05, T06 (audit retention)       │
T01 (CSRF_COOKIE_NAME const) ─→ T05, T06 (CSRF check)           │
                                                                ↓
T05 + T06 ──→ T07 (route dispatch wiring in auth-routes.ts) ──→ T13 (integration tests)
T08 (serve-http.ts ACAO/CSP patch) ─────────────────────────────┐
                                                                ↓
T09 (admin.css + STRINGS + admin-strings.js + admin.js shared) ─┤
                              ↓                                 │
T10 (admin.html + admin-common bootstrap fetchJSON/t/CSRF)  ────┤
                              ↓                                 │
T11 (admin-orgs.html + admin-orgs.js) ──────────────────────────┤
T12 (admin-users.html + admin-users.js) ────────────────────────┤
                                                                ↓
T07 + T11 + T12 ──→ T13 (integration tests admin-orgs/users flows)
T07 + T11 + T12 + T08 + T13 ──→ T14 (Playwright e2e admin-ui.spec.ts)
T13 + T14 ──→ T15 (docs: README admin section + onboarding-self-host update)
T15 ──→ T16 (release v0.10.6)
```

Critical-path observations:
- T01, T02, T03 can ship as 3 small parallel PRs immediately.
- T04 blocks T05 + T06 (validators are imported).
- T03 blocks T05's POST/PATCH 409 ORG_NAME_TAKEN behavior (without the index, conflicts surface as 500).
- T07 blocks all backend integration tests (no dispatch = handlers unreachable).
- T08 blocks T11 + T12 e2e behavior (without ACAO drop + CSP, browser script may fail policy checks or expose admin HTML cross-origin).
- T09 blocks T10/T11/T12 (shared `t()`, `STRINGS`, `fetchJSON`, `renderTable`, CSS classes).

### LOC budget (rough)

| Phase | Tasks | LOC (impl + tests) | PRs |
|---|---|---|---|
| A | T01-T03 | ~250 | 3 |
| B | T04-T08 | ~900 | 5 |
| C | T09-T12 | ~1100 | 4 |
| D | T13-T16 | ~750 | 4 |
| **Total** | **16** | **~3000** | **14-16** |

Phase C is the largest because static HTML + bootstrap JS dominates LOC by file count; per-file complexity is modest. Phase D's integration + e2e tests are the heaviest test surface.

---

# Phase A — Foundation

Mergeable independently; unblock everything downstream. Zero handler code in this phase.

## T01: `CSRF_COOKIE_NAME` constant + `BootValidationError` reuse

**Size**: ~80 LOC (1 const export + import-side updates + tests)
**Dependencies**: none
**Spec refs**: V2 §Auth + CSRF (line 188), V3 PATCH 10 (BootValidationError reuse)

**Files touched**:
- `src/auth/csrf.ts` — **MODIFIED** — add `export const CSRF_COOKIE_NAME = "__Host-coordinator_csrf";`
- `src/auth/oauth-finalize.ts:24` — **MODIFIED** — replace string literal with import.
- `src/auth/logout.ts:30` — **MODIFIED** — same.
- `src/auth/device-flow.ts:208` — **MODIFIED** — same.
- `src/auth/oauth-finalize.ts:305,323` — **MODIFIED** — same.
- `tests/unit/csrf-cookie-name.test.ts` (NEW) — assert constant value + literal equality + greppable single source.

**Implementation summary**:
1. Add the export. Value MUST be exactly `"__Host-coordinator_csrf"` (verify against existing literal usage byte-for-byte).
2. Search & replace all `"__Host-coordinator_csrf"` literal occurrences in `src/auth/` with the imported constant. Do NOT replace in tests or comments (constant is for runtime code paths).
3. Verify by `grep -rn '"__Host-coordinator_csrf"' src/` returns only the definition site post-refactor.
4. Confirm `BootValidationError` exists somewhere already (used in v0.10.5 boot guards — `src/security/encryption.ts` or `src/boot.ts`). If not exported in a place importable by `src/database.ts`, hoist it to `src/errors.ts` as a separate ~10-LOC delta in this PR.

**Test cases**:
- `CSRF_COOKIE_NAME === "__Host-coordinator_csrf"` (literal value pin).
- `BootValidationError` can be imported from a stable path; `new BootValidationError("msg")` extends `Error`.
- No regression: `oauth-finalize`, `logout`, `device-flow` existing CSRF tests still pass unchanged.

**Acceptance**:
- New test green.
- All existing auth tests pass.
- Lint clean.
- `grep -rn '"__Host-coordinator_csrf"' src/` shows the constant definition + zero literal duplicates.

---

## T02: Register 3 new admin events in `TIER1_EVENTS`

**Size**: ~40 LOC (1 file edit + 1 test)
**Dependencies**: none
**Spec refs**: V3 PATCH 3

**Files touched**:
- `src/security/audit-events.ts:14-36` — **MODIFIED** — append `"admin.org.created"`, `"admin.org.updated"`, `"admin.user.role_changed"` to `TIER1_EVENTS`.
- `tests/unit/audit-events-registration.test.ts` (NEW) — assert each event ∈ `TIER1_EVENTS`.

**Implementation summary**:
1. Read `TIER1_EVENTS` array literal in `src/security/audit-events.ts`.
2. Append the 3 new string literals before the `] as const;` close.
3. Write trivial unit test using `expect(TIER1_EVENTS).toContain(...)` per V3 PATCH 3 example.

**Test cases**:
- `TIER1_EVENTS` contains `"admin.org.created"`.
- `TIER1_EVENTS` contains `"admin.org.updated"`.
- `TIER1_EVENTS` contains `"admin.user.role_changed"`.
- None of the three appear in `TIER2_EVENTS` (membership-exclusivity check; prevents accidental double-register).

**Acceptance**:
- Test passes.
- Sweeper retention test (existing) still passes (Tier 1 = 365d retention for new events).
- Lint clean.

---

## T03: `orgs.name` UNIQUE INDEX migration + pre-flight boot guard

**Size**: ~130 LOC (migration block + pre-flight SELECT + 2 tests)
**Dependencies**: T01 (for `BootValidationError` import path stability)
**Spec refs**: V2 §Schema (D10) lines 357-365, V3 PATCH 10

**Files touched**:
- `src/database.ts` — **MODIFIED** — append pre-flight duplicate-name check + `CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_name ON orgs(name)` to the migration block.
- `tests/integration/migration-orgs-unique.test.ts` (NEW) — both fail-loud-on-dupes and succeed-on-unique paths.

**Implementation summary**:
1. Locate the migration block in `src/database.ts` (search for `CREATE UNIQUE INDEX IF NOT EXISTS` precedents; place new block alongside).
2. Insert pre-flight SELECT per V3 PATCH 10 exactly:
   ```typescript
   const dupes = db.prepare(`
     SELECT name, COUNT(*) AS n, GROUP_CONCAT(id, ',') AS ids
     FROM orgs GROUP BY name HAVING COUNT(*) > 1
   `).all() as Array<{ name: string; n: number; ids: string }>;
   if (dupes.length > 0) {
     const detail = dupes.map(d => `  name="${d.name}" (${d.n} rows, ids: ${d.ids})`).join("\n");
     throw new BootValidationError(
       `Cannot create UNIQUE INDEX idx_orgs_name: duplicate org names found.\n` +
       `Resolve by renaming duplicates before upgrading. SQL:\n` +
       `  UPDATE orgs SET name = name || '_' || id WHERE id IN (<keep-only-one-id-per-name>);\n` +
       `Duplicates:\n${detail}`
     );
   }
   db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_name ON orgs(name)");
   ```
3. Idempotent: re-running migration on a DB with the index is a no-op (verified by `IF NOT EXISTS`).
4. Coordinate with T01's `BootValidationError` hoist (T01 lands first; T03 imports from the hoisted path).

**Test cases** (per V3 PATCH 10):
- Boot with 2 orgs `("o1","acme"), ("o2","acme")` → throws `BootValidationError` with message matching `/duplicate org names found.*name="acme".*ids: o1,o2/s`.
- Boot with 2 distinct orgs → migration succeeds; `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orgs_name'` returns a row.
- Re-run migration on already-indexed DB → no-op, no error.
- Boot with 3+ groups of dupes → error message lists all of them.

**Acceptance**:
- All tests pass.
- Existing migration tests unchanged.
- `orgs.name` UNIQUE index visible in `sqlite_master` after fresh boot.

---

# Phase B — Backend handlers

Validators are the foundation; handlers depend on them; dispatch wires both; static-handler patch is independent and parallel-able.

## T04: `src/admin/validate.ts` — `AdminValidationError` + per-field validators

**Size**: ~200 LOC (class + validators + tests)
**Dependencies**: none (independent)
**Spec refs**: V2 §Validation rules (lines 144-159), V3 PATCH 11 (no-echo + empty-string + request_id), V3 PATCH 12 (role enum)

**Files touched**:
- `src/admin/validate.ts` (NEW) — `AdminValidationError` class with code-only constructor + `genericMessageFor(code)` + validators: `validateOrgName`, `validateAllowlistField`, `validateRoleEnum`, `validateOrgIdQueryParam`, `validatePathParam`, `validatePatchBody`.
- `tests/unit/admin-validate.test.ts` (NEW) — exhaustive per-rule matrix.

**Implementation summary**:
1. Implement `AdminValidationError(field, code)` per V3 PATCH 11 exact shape; constructor calls `super(genericMessageFor(code))`.
2. `ValidationCode` type union: `REQUIRED | TOO_LONG | TOO_SHORT | DISALLOWED_CHARS | INVALID_ENUM | UNKNOWN_FIELD | EMPTY_BODY | BAD_PATH`.
3. `genericMessageFor` switch returns generic strings only (NO input echo).
4. `validateOrgName(value)`:
   - Reject `undefined`/`null` → `REQUIRED`.
   - NFC normalize: `value.normalize("NFC")`.
   - Reject if length 0 → `TOO_SHORT`.
   - Reject if `[...norm].length > 200` (code-point count, not byte) → `TOO_LONG`.
   - Reject if denylist regex matches (C0/C1 controls, ZWS U+200B, bidi-overrides U+202A-U+202E + U+2066-U+2069, BOM U+FEFF, `<>"'`) → `DISALLOWED_CHARS`.
5. `validateAllowlistField(value, fieldName)`:
   - `null` is allowed (clear semantics).
   - `undefined` is allowed (absent = no change).
   - String: same as `validateOrgName` rules (incl. empty rejection per V3 PATCH 11).
6. `validateRoleEnum(value)`: case-sensitive `"admin"` or `"member"` only.
7. `validateOrgIdQueryParam(value)`: `/^[A-Za-z0-9_-]{1,64}$/` else 400.
8. `validatePathParam(rawId)`: try `decodeURIComponent(rawId)`, catch → `BAD_PATH`.
9. `validatePatchBody(body, allowedFields)`:
   - Reject if not plain object → `INVALID_ENUM`.
   - Reject if no own keys → `EMPTY_BODY`.
   - Reject if any key ∉ `allowedFields` → `UNKNOWN_FIELD` with `field: <unknownKey>`.

**Test cases** (per V2 + V3 patches):
- Valid name "acme" → no throw.
- Empty name `""` → `TOO_SHORT` (V3 PATCH 11 explicit row).
- Name with 200 code points (boundary, emoji-padded 4-byte UTF-8) → no throw.
- Name with 201 code points → `TOO_LONG`.
- Name with ZWJ family `"👨‍👩‍👧‍👦"` → no throw (permitted per spec).
- Name with RTL override `"acme‮"` → `DISALLOWED_CHARS`.
- Name with `<` / `>` / `"` / `'` → `DISALLOWED_CHARS` (each tested separately).
- Name with NUL byte → `DISALLOWED_CHARS`.
- Name with BOM U+FEFF → `DISALLOWED_CHARS`.
- `allowlist_github_org: null` → no throw.
- `allowlist_github_org: ""` → `TOO_SHORT`.
- `allowlist_github_org: undefined` → no throw.
- `role: "admin"` / `"member"` → no throw.
- `role: "ADMIN"` / `"Admin"` / `"agent"` / `"service"` / `null` → `INVALID_ENUM`.
- `?org=` with valid `[A-Za-z0-9_-]{1,64}` → no throw.
- `?org=` with `org with spaces` / `>64 chars` → throws.
- `decodeURIComponent("o%2")` (malformed) → `BAD_PATH`.
- PATCH body `{}` → `EMPTY_BODY`.
- PATCH body `{ name: "x", evil: 1 }` → `UNKNOWN_FIELD` with `field: "evil"`.
- **Generic message assertion**: for each validation error, `err.message` does NOT contain the rejected input value (verify with `expect(err.message).not.toContain(maliciousInput)`).

**Acceptance**:
- All ~25 test cases pass.
- 100% coverage on `src/admin/validate.ts` (small file, easy gate).
- Lint clean.

---

## T05: `src/admin/handle-admin-orgs.ts` (GET + POST + PATCH)

**Size**: ~280 LOC (3 handlers + tests deferred to T13)
**Dependencies**: T01 (CSRF_COOKIE_NAME), T02 (audit events), T03 (UNIQUE INDEX), T04 (validators)
**Spec refs**: V2 §Endpoints 1-3 (lines 87-110), V3 PATCH 1 (irrelevant here), V3 PATCH 2 (`.immediate()`), V3 PATCH 11 (request_id in errors), V3 PATCH 13 (return fresh row + `updated_at`), V3 PATCH 16 (adminError helper)

**Files touched**:
- `src/admin/handle-admin-orgs.ts` (NEW) — exports `handleListOrgs`, `handleCreateOrg`, `handleUpdateOrg`.
- Tests come in T13.

**Implementation summary**:
1. **Common scaffold** for all 3 handlers (mirror `src/admin/handle-service-tokens.ts:51-104`):
   - Auth: `authenticateRequest(req, { authEnabled: true })`; 401 on `!ok` (with `WWW-Authenticate` passthrough).
   - Role gate: `if (claims.role !== "admin")` → 403 FORBIDDEN.
   - Per-IP RL: only POST/PATCH (V3 PATCH 4 — GETs unrate-limited). 60/min/IP via `ctx.rateLimiter.check("admin-api-mut:${ip}", { per: 60, window_seconds: 60 })`. 429 + `Retry-After` on deny.
   - CSRF: only POST/PATCH. `parseCookies(req)[CSRF_COOKIE_NAME]` + header `x-csrf-token` + `verifyCsrfToken`. 403 CSRF_FAILED on mismatch.
   - Body parse: 4 KB cap loop (copy from `handle-service-tokens.ts:81-104`).
   - Validation: wrap in try/catch; `AdminValidationError` → 400 INVALID_REQUEST with `{ field, request_id }`.
   - Response: always `Cache-Control: no-store`.
2. **`adminError(ctx, code, message, extra?)` helper** at module top: `appError(code, message, { ...extra, request_id: ctx.requestId })` per V3 PATCH 16.
3. **`handleListOrgs(req, res, ctx)`** (GET /api/admin/orgs):
   - Auth + role gate (no RL pre-auth, no CSRF).
   - SQL: `SELECT id, name, allowlist_github_org, allowlist_idp_org_id, created_at FROM orgs ORDER BY created_at ASC, id ASC LIMIT 5000`.
   - Response 200 `{ orgs: [...] }`.
4. **`handleCreateOrg(req, res, ctx)`** (POST /api/admin/orgs):
   - Full scaffold (RL + CSRF + body parse + validate).
   - Validate `name`, `allowlist_github_org`, `allowlist_idp_org_id`.
   - Generate `id = randomUUID()`.
   - Tx: `db.transaction(() => { INSERT; audit("admin.org.created", ...); }).immediate()`.
   - On INSERT failure with `SQLITE_CONSTRAINT_UNIQUE` (orgs.name) → catch and respond 409 ORG_NAME_TAKEN.
   - Response 201 `{ org: { id, name, allowlist_github_org, allowlist_idp_org_id, created_at } }` — re-SELECT for `created_at`.
   - Audit metadata per V2 line 100 (flat scalars).
5. **`handleUpdateOrg(req, res, ctx, orgId)`** (PATCH /api/admin/orgs/:id):
   - `orgId` already URI-decoded by dispatcher (T07); if dispatcher passes raw, decode here with try/catch → 400 BAD_PATH.
   - Validate PATCH body: at least one field, no unknown fields.
   - Validate each present field.
   - Tx (`.immediate()`):
     1. `SELECT name, allowlist_github_org, allowlist_idp_org_id FROM orgs WHERE id = ?` — capture "before" snapshot. If null → 404 NOT_FOUND.
     2. Build `UPDATE orgs SET <field> = ?, ... WHERE id = ?` dynamic by present body keys.
     3. Run UPDATE. Catch UNIQUE on name → 409 ORG_NAME_TAKEN.
     4. `SELECT name, allowlist_github_org, allowlist_idp_org_id, updated_at FROM orgs WHERE id = ?` — fresh row.
     5. `audit("admin.org.updated", ...)` with `changed_fields` + `<field>_before`/`<field>_after` only for fields in `changed_fields` (V2 line 109).
   - Response 200 `{ org: { id, name, allowlist_github_org, allowlist_idp_org_id, updated_at? } }` (V3 PATCH 13 fresh-row).
   - Note: `updated_at` returned only if column exists (see open question 3). If absent, omit gracefully.

**Test cases**: deferred to T13.

**Acceptance**:
- File compiles, lints clean.
- 3 handlers exported with the contract: `async (req, res, ctx, ...pathParams) => Promise<void>`.
- No `db.transaction(fn)()` (deferred) — all uses end in `.immediate()` (V3 PATCH 2 lint).
- All `appError` calls include `request_id` via `adminError` helper.

---

## T06: `src/admin/handle-admin-users.ts` (GET + PATCH) with last-admin TOCTOU guard

**Size**: ~280 LOC (2 handlers + last-admin SQL + tests deferred to T13)
**Dependencies**: T01, T02, T04
**Spec refs**: V2 §Endpoints 4-5 (lines 111-142), V3 PATCH 1 (last-admin SQL — 2 clauses), V3 PATCH 2 (`.immediate()`), V3 PATCH 5 (SQLITE_BUSY → 503), V3 PATCH 12 (role IN), V3 PATCH 14 (meta.admin_count + truncated), V3 PATCH 16

**Files touched**:
- `src/admin/handle-admin-users.ts` (NEW) — exports `handleListUsers`, `handleUpdateUserRole`.
- Tests in T13.

**Implementation summary**:
1. **Common scaffold**: same as T05 (auth, role, RL, CSRF, body parse, adminError helper).
2. **`handleListUsers(req, res, ctx)`** (GET /api/admin/users):
   - Parse `?org=` query param via `validateOrgIdQueryParam`.
   - SQL: `SELECT id, email, name, role, primary_org_id, created_at, last_login_at FROM users WHERE role IN ('admin','member') [AND primary_org_id = ?] ORDER BY created_at ASC, id ASC LIMIT 5000`.
   - Additional query: `SELECT COUNT(*) AS n FROM users WHERE role = 'admin'` → `admin_count` (V3 PATCH 14).
   - Compute `truncated = users.length === 5000` (V3 PATCH 14 reversal of V2 Cut#4).
   - Response 200: `{ users: [...], meta: { admin_count, truncated } }`.
3. **`handleUpdateUserRole(req, res, ctx, userId)`** (PATCH /api/admin/users/:id):
   - Validate path + body. Body must contain `role` only; validate enum.
   - Capture `roleBefore` via initial `SELECT role, primary_org_id FROM users WHERE id = ?` (outside tx — informational; tx re-reads for ground truth).
   - Tx (`.immediate()`):
     ```sql
     UPDATE users SET role = ?
       WHERE id = ?
         AND role IN ('admin','member')
         AND (
           ? = 'admin'                                              -- promote: always OK
           OR (SELECT COUNT(*) FROM users WHERE role='admin') > 1  -- demote: need >1
         )
     ```
     Bind: `[newRole, targetId, newRole]` (V3 PATCH 1 — note: 3 params total; actor_id is NOT bound).
   - If `info.changes === 1`: emit `audit("admin.user.role_changed", outcome: "success", metadata: { target_user_id, target_org_id, role_before, role_after })`. Respond 200 `{ user: { id, role: newRole } }`.
   - If `info.changes === 0`: re-SELECT distinguishes 4 cases (V3 PATCH 1 + 12):
     - Not found → 404 NOT_FOUND.
     - `role` is `agent`/`service` → 409 NOT_HUMAN_USER + audit denied with `denied_reason: "not_human_user"`.
     - `role` is `admin` AND `targetId === ctx.actorUserId` → 409 CONFLICT_SELF_DEMOTION + audit denied with `denied_reason: "self_demotion"`.
     - `role` is `admin` AND `targetId !== ctx.actorUserId` → 409 CONFLICT_LAST_ADMIN + audit denied with `denied_reason: "last_admin"`.
   - Wrap entire handler in try/catch for `SQLITE_BUSY` → 503 DB_BUSY with `Retry-After: 1` (V3 PATCH 5).
3. `ctx.actorUserId` comes from `authResult.claims.sub` (existing JWT claim). If `AuthHandlerContext` doesn't expose `actorUserId`, derive locally: `const actorUserId = authResult.claims.sub;`.

**Test cases**: deferred to T13.

**Acceptance**:
- File compiles, lints clean.
- 2 handlers exported.
- All SQL uses 2-clause last-admin guard (V3 PATCH 1), NOT 3 clauses.
- All `db.transaction()` end with `.immediate()`.
- `meta.admin_count` and `meta.truncated` present in list response.

---

## T07: Route dispatch wiring in `src/http/auth-routes.ts`

**Size**: ~90 LOC (KNOWN_AUTH_PATHS + methodForPath + 5 dispatch lines + tests)
**Dependencies**: T05, T06
**Spec refs**: V2 §Route wiring (lines 342-355), V3 PATCH 4 (RL applied inside handlers, not here), V3 PATCH 17e (404-not-405 for parameterized paths)

**Files touched**:
- `src/http/auth-routes.ts` — **MODIFIED** — add to `KNOWN_AUTH_PATHS`, extend `methodForPath`, add 3 literal-path + 2 regex dispatch entries.
- `tests/unit/auth-routes-admin-dispatch.test.ts` (NEW) — unit test routing matrix.

**Implementation summary**:
1. Extend `KNOWN_AUTH_PATHS`:
   ```typescript
   "/api/admin/orgs",
   "/api/admin/users",
   ```
   (Do NOT add parameterized paths — V3 PATCH 17e: 404 on unknown method to those is acceptable, matches service-tokens revoke precedent.)
2. Extend `methodForPath`:
   ```typescript
   if (url === "/api/admin/orgs") return "GET, POST";
   if (url === "/api/admin/users") return "GET";
   ```
3. Add literal dispatch (place all admin lines together for grep-ability):
   ```typescript
   if (url === "/api/admin/orgs" && method === "GET")  { await handleListOrgs(req, res, ctx); return true; }
   if (url === "/api/admin/orgs" && method === "POST") { await handleCreateOrg(req, res, ctx); return true; }
   if (url === "/api/admin/users" && method === "GET") { await handleListUsers(req, res, ctx); return true; }
   ```
4. Add regex dispatch (mirror service-tokens revoke at `auth-routes.ts:114-121`):
   ```typescript
   const orgMatch = url.match(/^\/api\/admin\/orgs\/([^/]+)$/);
   if (orgMatch && method === "PATCH") {
     await handleUpdateOrg(req, res, ctx, decodeURIComponent(orgMatch[1]));
     return true;
   }
   const userMatch = url.match(/^\/api\/admin\/users\/([^/]+)$/);
   if (userMatch && method === "PATCH") {
     await handleUpdateUserRole(req, res, ctx, decodeURIComponent(userMatch[1]));
     return true;
   }
   ```
   `decodeURIComponent` may throw on malformed `%XX`; wrap try/catch → 400 BAD_PATH.

**Test cases**:
- `GET /api/admin/orgs` → routes to `handleListOrgs`.
- `POST /api/admin/orgs` → routes to `handleCreateOrg`.
- `PATCH /api/admin/orgs/abc-123` → routes to `handleUpdateOrg` with `orgId = "abc-123"`.
- `PATCH /api/admin/orgs/%41bc` → routes with `orgId = "Abc"` (URI decoded).
- `PATCH /api/admin/orgs/o%2` → 400 BAD_PATH (malformed encoding).
- `DELETE /api/admin/orgs` → 405 METHOD_NOT_ALLOWED with `Allow: GET, POST` (from methodForPath).
- `DELETE /api/admin/orgs/abc` → 404 NOT_FOUND (parameterized path 404-not-405 per V3 PATCH 17e).
- `GET /api/admin/users?org=acme-org` → routes to `handleListUsers` (query passes through).
- `PATCH /api/admin/users/u-1` → routes to `handleUpdateUserRole`.

**Acceptance**:
- Routing matrix tests pass.
- Existing auth-route tests unchanged.
- Grep shows all 5 admin dispatch entries in one block.

---

## T08: `src/serve-http.ts` static handler — ACAO drop + admin CSP

**Size**: ~80 LOC (handler amendment + lint script + tests)
**Dependencies**: none (independent of handler PRs)
**Spec refs**: V2 §Static file serving (lines 224-235), V3 PATCH 6 (ACAO admin-only), V3 PATCH 7 (CSP admin-only, pinned regex), V3 PATCH 8 (8-file scope)

**Files touched**:
- `src/serve-http.ts:449-487` (the `/dashboard/*` handler block) — **MODIFIED** — branch on `isAdminPage` per V3 PATCH 6.
- `tests/unit/serve-http-admin-headers.test.ts` (NEW) — header presence/absence assertions.

**Implementation summary**:
1. Amend the file-serve block per V3 PATCH 6 exact pattern:
   - Compute `isAdminPage = /^\/dashboard\/(admin|admin-orgs|admin-users)\.html(\?.*)?$/.test(url)`.
   - If admin page: add CSP, X-Frame-Options, Referrer-Policy, Cache-Control. Do NOT add Access-Control-Allow-Origin.
   - Else: preserve existing `Access-Control-Allow-Origin: *` behavior unchanged.
2. CSP value per V2 line 229:
   ```
   default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
   ```
3. `script-src 'self'` requires **all** admin JS to be external files (no inline `<script>`). T09-T12 must comply.

**Test cases**:
- GET `/dashboard/admin.html` → response headers include `Content-Security-Policy` (value matches V2), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. Does NOT include `Access-Control-Allow-Origin`.
- GET `/dashboard/admin-orgs.html` → same.
- GET `/dashboard/admin-users.html` → same.
- GET `/dashboard/admin-orgs.html?v=2` → same (query string allowed by regex).
- GET `/dashboard/index.html` → response headers include `Access-Control-Allow-Origin: *`. Does NOT include CSP (preserves existing behavior — V3 PATCH 7).
- GET `/dashboard/admin-extra.html` → existing behavior (no CSP, has ACAO) — the regex deliberately rejects future admin-* extensions; opt-in only.
- GET `/dashboard/admin.js` → existing behavior (JS files keep current header behavior; CSP only on HTML).

**Acceptance**:
- All header tests pass.
- Existing `/dashboard/*` tests unchanged.
- Manual verification: open browser devtools on `/dashboard/admin.html` → CSP header visible, no ACAO.

---

# Phase C — Frontend

8 static files total: 3 HTML + 4 JS + 1 CSS (V3 PATCH 8). Shared infra first (T09), then admin landing + common helpers (T10), then per-page bundles (T11 + T12 — parallel).

## T09: `dashboard/public/admin.css` + `dashboard/public/admin.js` (shared infra + STRINGS)

**Size**: ~350 LOC (CSS theme + `STRINGS` + `t()` + `renderTable` + helpers)
**Dependencies**: none (frontend infra, independent of backend)
**Spec refs**: V2 §Frontend (lines 266-339), V3 PATCH 8 (8 files), V3 PATCH 15 (renderTable concrete example), V3 PATCH 18 (STRINGS centralized)

**Files touched**:
- `dashboard/public/admin.css` (NEW) — shared dark theme, AA-contrast palette, responsive breakpoints (≥1024 / 768-1023 / <768), 320px lower bound (V3 PATCH 17a), 200% zoom support, focus styles, status pill colors paired with icons.
- `dashboard/public/admin.js` (NEW) — shared module:
  - `STRINGS` table (V3 PATCH 18 verbatim structure).
  - `t(path, vars?)` lookup with `{placeholder}` interpolation.
  - `CSRF_COOKIE = "__Host-coordinator_csrf"` constant.
  - `readCsrfToken()` — returns null on miss (V3 PATCH 9, NOT throw).
  - `redirectToLogin()` — `location.assign('/auth/login?return_to=...')`.
  - `fetchJson(url, opts?)` — adds CSRF header for non-GET, handles 401/403 redirect, parses JSON (V3 PATCH 9).
  - `fetchWithTimeout(url, opts?, ms = 10000)` — `AbortController` wrapper (V3 PATCH 17b).
  - `renderTable(rows, columns)` — per V3 PATCH 15 (returns `<table>` Node; supports Node-returning accessors).
  - `showToast({ level, text, requestId })` — per V3 PATCH 16 (with copy-to-clipboard for request_id).
  - `escapeHtml` is **NOT** provided — `textContent` only; no escape helpers (defense against misuse).

**Implementation summary**:
1. CSS:
   - Variables: `--bg: #0f0f1a`, `--panel: #1a1a2e`, `--text: #f0f0f0`, `--muted: #cbd5e1` (V2 D11 — AA-contrast override).
   - Status pills: `.pill-saved` (green + ✓), `.pill-saving` (amber + ⏳), `.pill-failed` (red + ✕).
   - Breakpoints: `@media (max-width: 1023px)` reduced padding; `@media (max-width: 767px)` card-list layout.
   - Tap targets ≥44×44px on `<button>`, `<select>`, `<a.button>`.
   - `overflow-wrap: anywhere` on name/email cells for 200-codepoint test.
   - Skeleton shimmer animation (CSS-only) for `[data-state="loading"] tr[aria-hidden="true"]`.
2. JS:
   - Single ES module (or IIFE for browser; choose based on existing dashboard pattern — likely vanilla `<script defer>` so no module imports).
   - **No inline `<script>` ever.** All admin pages load `<script src="admin.js" defer></script>` then page-specific bootstraps.
   - All globals attached to a single `window.AdminUI = { t, fetchJson, fetchWithTimeout, renderTable, showToast, readCsrfToken, redirectToLogin, STRINGS }` to avoid pollution.

**Test cases**:
- Open question 4: do we add JS unit tests for `admin.js` (jsdom-based)? Recommendation: YES, minimal — `t('path.to.string', { vars })` interpolation correctness, `renderTable` Node-vs-string accessor handling, `readCsrfToken` returns null on missing cookie. ~50 LOC of tests.
- File `tests/unit/admin-js-shared.test.ts` (NEW, jsdom env):
  - `t("toast.org_saved")` → `"Org saved"`.
  - `t("confirms.demote_role", { email: "a@b" })` → `"Demote a@b from admin to member?"`.
  - `t("unknown.path")` → `"[missing: unknown.path]"`.
  - `renderTable([{id:"x", n:"y"}], [{header:"N", accessor: r => r.n}])` returns a `<table>` with `<td>y</td>`.
  - `renderTable` with Node-returning accessor appends the Node (not stringified).
  - `readCsrfToken()` with empty `document.cookie` → `null`.
  - `readCsrfToken()` with cookie set → decoded value.

**CI lint** (V3 PATCH 8 + PATCH 15):
- `grep -nE '<script[^>]*>[^<]' dashboard/public/admin*.html` → exit 1 if any inline JS.
- `grep -nEi '\son[a-z]+\s*=' dashboard/public/admin*.html` → exit 1 if any `on*=` attribute.
- `grep -nE '\.innerHTML\s*=\s*[^"`'"'"']' dashboard/public/admin*.js` → exit 1.
- `grep -nE '\.insertAdjacentHTML\s*\(' dashboard/public/admin*.js` → exit 1.
- Wire these into `package.json` `scripts.lint:admin` (or add to existing lint pipeline).

**Acceptance**:
- All shared helpers exported on `window.AdminUI`.
- CSS visually verified (manual) on 320px viewport.
- jsdom tests pass.
- CI lint scripts present and green.

---

## T10: `dashboard/public/admin.html` + `admin-index.js` (landing page)

**Size**: ~120 LOC (1 HTML + 1 bootstrap JS)
**Dependencies**: T09 (shared infra)
**Spec refs**: V2 §Frontend (file layout), V3 PATCH 8 (admin-index.js needed), V3 PATCH 9 (bootstrap probe + redirect)

**Files touched**:
- `dashboard/public/admin.html` (NEW) — landing page: 2 links (Orgs, Users) + admin email display + Logout button.
- `dashboard/public/admin-index.js` (NEW) — bootstrap: fetch `/api/auth/me` for email; wire Logout to POST `/api/auth/logout` then redirect.

**Implementation summary**:
1. HTML skeleton:
   ```html
   <!doctype html>
   <html lang="en">
   <head>
     <meta charset="utf-8">
     <meta name="viewport" content="width=device-width, initial-scale=1">
     <title>Admin — mcp-coordinator</title>
     <link rel="stylesheet" href="admin.css">
     <script src="admin.js" defer></script>
     <script src="admin-index.js" defer></script>
   </head>
   <body>
     <header>
       <h1>Admin</h1>
       <div class="user-info"><span id="admin-email" data-state="loading">Loading…</span> <button id="logout-btn">Logout</button></div>
     </header>
     <main>
       <nav class="admin-nav">
         <a href="/dashboard/admin-orgs.html">Orgs</a>
         <a href="/dashboard/admin-users.html">Users</a>
       </nav>
     </main>
     <div id="toasts" aria-live="polite"></div>
   </body>
   </html>
   ```
2. `admin-index.js`:
   ```javascript
   document.addEventListener("DOMContentLoaded", async () => {
     try {
       const res = await AdminUI.fetchJson("/api/auth/me");
       const data = await res.json();
       document.getElementById("admin-email").textContent = data.email || data.sub || "(unknown)";
     } catch (e) {
       if (e.message === "redirect") return;
       document.getElementById("admin-email").textContent = AdminUI.t("errors.server");
     }
     document.getElementById("logout-btn").addEventListener("click", async () => {
       await AdminUI.fetchJson("/api/auth/logout", { method: "POST" });
       location.assign("/auth/login");
     });
   });
   ```
3. Verify `/api/auth/me` exists (it's a standard pattern; if absent, fall back to decoding the JWT client-side OR add the endpoint as a separate ~30-LOC ride-along — log as open question 1).

**Test cases**: covered by T14 e2e (landing-page visit asserts email visible + nav links work).

**Acceptance**:
- HTML validates (no inline JS, all assets referenced via `src=`).
- Page renders correctly in browser (manual smoke).
- Logout button works.

---

## T11: `dashboard/public/admin-orgs.html` + `admin-orgs.js`

**Size**: ~350 LOC (HTML + JS with form + table + inline edit + dialog)
**Dependencies**: T09, T05 (for backend handlers to test against in T14)
**Spec refs**: V2 §Frontend (lines 266-339), V3 PATCH 13 (stale-state UX via fresh-row + replaceChildren), V3 PATCH 15 (renderTable pattern), V3 PATCH 16 (request_id toasts), V3 PATCH 17b (skeleton + slow-fetch), V3 PATCH 17c (empty-state copy)

**Files touched**:
- `dashboard/public/admin-orgs.html` (NEW).
- `dashboard/public/admin-orgs.js` (NEW).

**Implementation summary**:
1. HTML structure:
   - `<header>` with title + back link.
   - `<button id="new-org-btn">` opens a `<dialog id="new-org-dialog">` with form fields (name, allowlist_github_org, allowlist_idp_org_id) + Save/Cancel.
   - `<table id="orgs-table" aria-busy="true">` with `<caption>`, `<thead>` (Name, GitHub allowlist, IdP allowlist, Created, Actions), `<tbody id="orgs-tbody" data-state="loading">` containing 3 hardcoded `<tr aria-hidden="true">` skeleton rows.
   - `<div id="toasts" aria-live="polite">`.
2. `admin-orgs.js` bootstrap (per V3 PATCH 9):
   - On DOMContentLoaded: `AdminUI.fetchWithTimeout("/api/admin/orgs", {}, 10000)` → render.
   - Render: `tbody.replaceChildren(...orgs.map(makeOrgRow))` (V3 PATCH 15).
   - Empty state: if `orgs.length === 0`, render single row with CTA `t("empty.orgs")` + `t("cta.create_first_org")`.
   - Error state: catch → render `<tr role="alert">` with retry button + `t("errors.network")` / `t("errors.server")`.
3. **`makeOrgRow(org)`** — uses `document.createElement` + `.textContent` exclusively. Each row has `data-org-id`. Includes:
   - Name cell (editable on click → inline `<input>` + save button).
   - Allowlist cells (same inline-edit pattern; "clear" link sets to null with confirm dialog).
   - Created timestamp: `new Date(org.created_at.replace(' ', 'T') + 'Z').toLocaleString()`.
   - Actions cell (Edit, Clear-allowlist with confirm dialog).
4. **`savePatch(orgId, patch)`** per V3 PATCH 13:
   ```javascript
   const res = await AdminUI.fetchJson(`/api/admin/orgs/${encodeURIComponent(orgId)}`, {
     method: "PATCH",
     body: JSON.stringify(patch),
   });
   const data = await res.json();
   const row = document.querySelector(`tr[data-org-id="${orgId}"]`);
   row.replaceWith(makeOrgRow(data.org));
   AdminUI.showToast({ level: "success", text: AdminUI.t("toast.org_saved"), requestId: data.request_id });
   ```
5. **`createOrg(form)`** — POST + on success append new row to tbody. On 409 ORG_NAME_TAKEN → inline error in dialog (not toast).
6. **Confirm dialogs** for allowlist clear (`<dialog>` native, `.showModal()` for focus trap).
7. ARIA: `<table>` has `<caption>` + `<th scope="col">`; modals use native `<dialog>`; toasts have `role="status"` / `role="alert"`.

**Test cases**: covered by T14 (Playwright e2e).

**Acceptance**:
- HTML lint (no inline JS, no `on*=`) passes.
- JS lint (no `innerHTML = template`, no `insertAdjacentHTML`) passes.
- Page renders + functional in manual smoke.

---

## T12: `dashboard/public/admin-users.html` + `admin-users.js`

**Size**: ~350 LOC (HTML + JS with filter + table + role dropdown + last-admin UX)
**Dependencies**: T09, T06
**Spec refs**: V2 §Frontend / Last-admin UX (lines 306-310), V3 PATCH 13, V3 PATCH 14 (admin_count + proactive disabled option), V3 PATCH 15, V3 PATCH 17c (empty-state copy)

**Files touched**:
- `dashboard/public/admin-users.html` (NEW).
- `dashboard/public/admin-users.js` (NEW).

**Implementation summary**:
1. HTML:
   - `<header>` + back link.
   - `<div id="banner" hidden role="status">` — populated when `meta.admin_count === 1`.
   - `<form id="filter-form">` with `<select id="org-filter">` (populated from `/api/admin/orgs`) + Apply button.
   - `<table id="users-table">` with `<caption>` + `<thead>` (Email, Name, Org, Role, Last login, Actions) + `<tbody id="users-tbody" data-state="loading">` skeleton.
   - `<dialog id="confirm-demote-dialog">` for demote confirmation.
   - `<div id="toasts">`.
2. `admin-users.js`:
   - Initial loads: parallel `fetchWithTimeout("/api/admin/orgs")` + `fetchWithTimeout("/api/admin/users")`.
   - Populate org-filter dropdown from orgs. If empty (V3 PATCH 17c): hide filter, show banner "Create an org first" linking to admin-orgs.html.
   - Render users from `payload.users`; use `payload.meta.admin_count` for banner + disabled option logic.
   - `payload.meta.truncated === true` → show top notice "Showing first 5000 users. Use the org filter to narrow."
3. **`makeUserRow(user, { adminCount })`** per V3 PATCH 14:
   - Identity cell (email + name).
   - Org cell (primary_org_id).
   - Role cell: `<select>` with options `admin`/`member`. If `user.role === "admin" && adminCount === 1`, the `member` option is `disabled` with text `"member — would leave system without admin"`.
   - Last login cell (formatted).
   - Actions cell: Save button (disabled until select changes — staging-save UX per V2 D16).
4. **Save flow**:
   - On select change: enable Save button, mark row `data-pending="true"`.
   - On Save click: if demote, show `confirm-demote-dialog` with `t("confirms.demote_role", { email })`; if promote, skip confirm.
   - PATCH `/api/admin/users/${id}` with `{ role: newRole }`.
   - On 200: replace row from fresh response; toast success.
   - On 409 CONFLICT_LAST_ADMIN / CONFLICT_SELF_DEMOTION / NOT_HUMAN_USER: revert select to previous value, render inline error `role="alert"` at that row with `t("errors.last_admin")` etc.
   - On 503 DB_BUSY (V3 PATCH 5): retry once after `Retry-After`, then surface as error.
5. Filter form submit → reload table with `?org=` query.

**Test cases**: covered by T14.

**Acceptance**:
- HTML/JS lint clean.
- Manual smoke: visit, filter, attempt role change, observe disabled option when only 1 admin.

---

# Phase D — Tests, docs, release

## T13: Integration tests (admin-orgs-flow + admin-users-flow)

**Size**: ~500 LOC (2 test files, exhaustive)
**Dependencies**: T03, T04, T05, T06, T07
**Spec refs**: V2 §Testing (lines 369-374), V3 PATCH 1 (last-admin test), V3 PATCH 3 (TIER1 registration test — done in T02), V3 PATCH 4 (RL scope tests), V3 PATCH 11 (no-echo + request_id), V3 PATCH 14 (admin_count), V3 PATCH 16 (request_id in errors)

**Files touched**:
- `tests/integration/handle-admin-orgs.test.ts` (NEW).
- `tests/integration/handle-admin-users.test.ts` (NEW).

**Implementation summary**:
1. Each test file boots an in-memory coordinator via existing test helper (verify pattern in `tests/integration/handle-service-tokens.test.ts`).
2. Seed users: 1 admin + 1 member; orgs: 1 baseline.
3. Use existing CSRF cookie helper from auth tests (mint a session + extract cookie).

**Test cases for `handle-admin-orgs.test.ts`**:
- **Auth gate**:
  - No auth → 401 with `WWW-Authenticate`.
  - Member role → 403 FORBIDDEN.
  - Admin role + valid CSRF → proceeds.
- **CSRF gate** (POST/PATCH):
  - Missing CSRF header → 403 CSRF_FAILED.
  - Mismatched CSRF (cookie vs header) → 403 CSRF_FAILED.
  - Valid double-submit → proceeds.
- **Rate limit** (V3 PATCH 4):
  - 100 GETs from same IP in 60s → all 200, no 429.
  - 61st POST from same IP in 60s → 429 + `Retry-After`.
- **GET /api/admin/orgs**:
  - Returns `{ orgs: [...] }` with seeded org.
  - Ordering by `created_at ASC, id ASC`.
  - LIMIT 5000 (seed 5001, assert only 5000 returned).
- **POST /api/admin/orgs**:
  - Valid create → 201 with `{ org: { id, name, ..., created_at } }`. New row in DB.
  - Audit `admin.org.created` emitted exactly once with flat-scalar metadata (V2 line 100).
  - Mutation+audit in one tx: simulate INSERT failure (mock prepare to throw) → no audit row.
  - 409 ORG_NAME_TAKEN on duplicate name (relies on T03 UNIQUE INDEX).
  - 400 on empty name (V3 PATCH 11).
  - 400 on name with `<script>` → response `body.message === "field contains disallowed characters"`, `body.message` does NOT contain `"<script>"` or `"alert"` (V3 PATCH 11 no-echo).
  - 400 response includes `details.request_id` matching `/^[a-f0-9-]+$/` (V3 PATCH 11 + 16).
  - 400 on unknown field in body.
  - 400 on empty body.
  - 400 on body >4096 bytes.
- **PATCH /api/admin/orgs/:id**:
  - Valid update → 200 with fresh row (V3 PATCH 13).
  - 404 on unknown id.
  - 409 ORG_NAME_TAKEN on conflict.
  - Audit `admin.org.updated` with `changed_fields` + only `<field>_before`/`<field>_after` for changed fields (V2 line 109).
  - Audit NOT emitted on validation reject (no `*.failed` events per V2 Cut#1).
  - 400 BAD_PATH on malformed `%XX` in id.

**Test cases for `handle-admin-users.test.ts`**:
- All auth/CSRF/RL gates (same as orgs).
- **GET /api/admin/users**:
  - Returns `{ users, meta: { admin_count, truncated } }`.
  - `meta.admin_count` matches `SELECT COUNT(*)` from seeded data (V3 PATCH 14).
  - `?org=` filter applied.
  - `?org=invalid_chars$` → 400 INVALID_REQUEST.
  - `role IN ('admin','member')` filter: seed agent + service rows, assert excluded (V3 PATCH 12).
  - `LIMIT 5000` → `meta.truncated: true` when 5000 hit.
- **PATCH /api/admin/users/:id** — last-admin matrix (V3 PATCH 1):
  - Seed A=admin, B=admin. Demote A (allowed → 1 admin = B). 200.
  - Seed 1 admin only. Self-demote → 409 CONFLICT_SELF_DEMOTION with `denied_reason: "self_demotion"` in audit.
  - **V3 PATCH 1 dead-clause repro**: seed A=admin, B=admin. Demote A (1 admin = B). Re-promote A using B-as-actor (back to 2). A-as-actor demote B → 409 CONFLICT_LAST_ADMIN (V2's 3-clause SQL would've returned 200 — this test is the regression sentinel).
  - 2 concurrent demotes against last 2 admins → exactly one 200 + one 409 (V3 PATCH 5: under single-connection better-sqlite3, second blocks then sees post-commit state).
  - PATCH on agent user → 409 NOT_HUMAN_USER + audit `denied_reason: "not_human_user"`.
  - PATCH on service user → 409 NOT_HUMAN_USER.
  - PATCH with `{ role: "ADMIN" }` (uppercase) → 400 INVALID_REQUEST.
  - PATCH with `{ role: "agent" }` → 400 INVALID_REQUEST.
  - 200 response: `{ user: { id, role } }`.
  - Audit `admin.user.role_changed` with `outcome: "success"`, flat-scalar metadata.
  - Audit on each denied path with `outcome: "denied"`.

**Acceptance**:
- All ~40 test cases pass.
- No flakes on 10 reruns.
- Coverage: full handler files covered (no per-file 100% threshold per V2 Cut#6).

---

## T14: Playwright e2e (`tests/e2e/admin-ui.spec.ts`)

**Size**: ~300 LOC (single spec file)
**Dependencies**: T07, T08, T11, T12, T13
**Spec refs**: V2 §Testing (line 373), V3 PATCH 9 (incognito → login redirect), V3 PATCH 13 (concurrent rename), V3 PATCH 14 (single-admin disabled option)

**Files touched**:
- `tests/e2e/admin-ui.spec.ts` (NEW) — reuses `tests/e2e/helpers/coordinator-fixture.ts` (verified present per spec).
- `package.json` (POSSIBLY MODIFIED) — add axe-core devDep if absent.

**Implementation summary**:
1. Use existing `coordinator-fixture` for boot/teardown.
2. Use existing login helper to mint an admin session.
3. axe-core scan integration: `await injectAxe(page); const violations = await getViolations(page); expect(violations).toEqual([])`.

**Test cases** (per V2 + V3):
- **Landing page**: login → visit `/dashboard/admin.html` → admin email visible, nav links present, Logout works.
- **Orgs CRUD**:
  - Visit orgs page → table renders seeded org.
  - Click "New org" → dialog opens → fill form → Save → row appears in table → toast "Org saved".
  - Edit allowlist → Save → toast.
  - Clear allowlist → confirm dialog → confirm → row updates.
  - Validation error: empty name → inline error, no row added.
- **Users role change**:
  - Filter by org → table updates.
  - Change role dropdown (member → admin) → Save button enables.
  - Click Save → no confirm (promote) → 200 → row updates.
  - Change role dropdown (admin → member) → Save → confirm dialog appears → confirm → 200.
- **Last-admin proactive UX (V3 PATCH 14)**:
  - Seed 1 admin only. Visit users page. Assert top banner visible. Assert sole admin row's "member" `<option>` is `disabled` with "would leave system without admin" suffix.
- **Last-admin server-side 409**:
  - Bypass disabled UI via direct fetch in browser console. Assert 409 CONFLICT_SELF_DEMOTION, inline error rendered, dropdown reverts.
- **Incognito redirect (V3 PATCH 9)**:
  - Clear cookies, visit `/dashboard/admin.html` → redirected to `/auth/login?return_to=%2Fdashboard%2Fadmin.html`.
- **Concurrent rename (V3 PATCH 13)**:
  - Two browser contexts (admin sessions). Both load orgs page. A renames "acme" → "acme-a", saves. B renames "acme" → "acme-b", saves. B's table shows "acme-b" (last-writer wins; B's row reflects own write).
- **axe-core scan**:
  - On `/dashboard/admin.html`: zero violations.
  - On `/dashboard/admin-orgs.html`: zero violations.
  - On `/dashboard/admin-users.html`: zero violations (with single-admin banner visible).
- **Responsive**:
  - Resize viewport to 320px → table converts to card layout, all content visible, no horizontal scroll.

**Acceptance**:
- All e2e tests pass on local + CI.
- No flakes on 5 reruns.
- axe-core scan green.

---

## T15: Documentation

**Size**: ~300 LOC (3 doc files updated)
**Dependencies**: T13, T14
**Spec refs**: V2 §References, V2 §Risks accepted

**Files touched**:
- `README.md` — **MODIFIED** — add "Admin UI" section under feature list; update Compliance matrix to mark "Admin web UI" as Shipped in v0.10.6.
- `docs/onboarding-self-host.md` — **MODIFIED** — add section "Admin UI" under "5. Operate" (or appropriate section); document `/dashboard/admin.html` entry point + role requirement.
- `docs/ops/admin-ui.md` (NEW) — operator runbook:
  - Access prerequisites (admin role JWT claim).
  - URL layout (3 pages).
  - CSRF expectations.
  - Last-admin protection mechanics.
  - Audit event names + tier + retention.
  - Common gotchas: "Duplicate org names blocked boot" (V3 PATCH 10 — link to fix SQL).
  - Recovery: how to restore admin role via raw SQL if lockout occurs.

**Implementation summary**: write the docs. No tests required (doc-only). Verify links resolve in rendered Markdown.

**Acceptance**:
- All listed files updated.
- `npm run docs:check` (if exists) clean.
- No broken internal links.
- Smoke-read by a non-implementer reviewer.

---

## T16: Release v0.10.6

**Size**: ~50 LOC (release-please config + CHANGELOG verify + version bump)
**Dependencies**: T01-T15
**Spec refs**: none

**Files touched**:
- `release-please-config.json` — verify v0.10.6 entry / let release-please bump.
- `CHANGELOG.md` — auto-generated; verify content under v0.10.6 covers: admin UI feature, audit events added, schema change (UNIQUE INDEX), migration guidance (duplicate-name pre-flight).
- `package.json` — version bump.
- `package-lock.json` — auto-update.

**Implementation summary**:
1. Open release-please PR (the bot does this).
2. Manually augment CHANGELOG with operator-facing summary if release-please auto-content is too sparse. Must mention:
   - New `/api/admin/orgs` + `/api/admin/users` endpoints (5 total).
   - New `/dashboard/admin*.html` pages (3 total).
   - Schema change: `idx_orgs_name` UNIQUE INDEX (with pre-flight duplicate-name boot guard).
   - 3 new Tier-1 audit events.
3. Verify `prepublishOnly` passes (`npm run build && npm test`).
4. Merge → npm publish via CI.

**Acceptance**:
- Release-please PR merged.
- `mcp-coordinator@0.10.6` on npm.
- GitHub release published.
- Manual smoke-install verifies pages render.

---

# Test infrastructure (cross-cutting)

Not a task; documents helpers several tasks depend on.

## `tests/helpers/admin-session.ts` (NEW — created as part of T13)

Mints an admin JWT + CSRF cookie + returns a `fetch`-style caller pre-configured with both. Required by T13 + T14.

```typescript
export function adminFetchClient(coordinator, { role = "admin" } = {}) {
  const session = mintSession(coordinator, { role });   // existing helper pattern
  const csrf = session.csrfCookie;
  return async (url, opts = {}) => {
    const headers = {
      "Cookie": session.cookieHeader,
      ...(opts.method && opts.method !== "GET"
        ? { "X-CSRF-Token": csrf }
        : {}),
      ...opts.headers,
    };
    return fetch(`${coordinator.baseUrl}${url}`, { ...opts, headers });
  };
}
```

Place this file early; create as part of T13 (first test PR). Reused by T14 e2e via Playwright `request.newContext({ extraHTTPHeaders: ... })`.

## `dashboard/public/admin-strings.js` — NOT a separate file

The synthesis suggests `admin-strings.js` as a separate module. **Decision**: fold `STRINGS` table directly into `admin.js` per V3 PATCH 18 (which places it in `admin.js`). The plan's T09 bundles it there. Open question 2 captures the alternative.

---

# Open questions for plan review

1. **`/api/auth/me` endpoint existence** (T10 dependency): Does an endpoint exist that returns the authenticated user's email/sub? Quick grep needed before T10. If absent, ride-along (~30 LOC) in T10 OR decode JWT client-side from the session cookie (the cookie is HttpOnly, so client can't read it — confirms ride-along needed).

2. **`admin-strings.js` as separate file vs folded into `admin.js`**: Synthesis prompt suggests separate file; V3 PATCH 18 places `STRINGS` in `admin.js`. Plan currently folds. Trade-off: separate file = clearer single-purpose module; folded = fewer files + matches V3. Recommend keep folded (V3 wins) but flagging for review.

3. **`updated_at` columns on `orgs` + `users`** (V3 PATCH 13): The patch suggests adding `updated_at` columns + triggers. Plan currently treats as optional ("defer trigger if too invasive"). Recommend: SHIP in v0.10.6 alongside T03 (1 extra migration block); cost is ~30 LOC, benefit is freshness signal in PATCH responses. If accepted, fold into T03 as ~50 LOC delta. If deferred, fall back to `new Date().toISOString()` at response time.

4. **JS unit tests for `admin.js`** (T09): Plan includes ~50 LOC of jsdom-based unit tests for shared helpers (`t()`, `renderTable`, `readCsrfToken`). Concern: do we already have a jsdom test runner configured? If not, the setup overhead (vitest config + jsdom dep) may not justify the small test surface. Recommend: ADD jsdom + the tests (~30 min total setup; pays off for future frontend changes). Alternative: rely solely on Playwright e2e for JS coverage.

5. **T05 + T06 split or merge**: Both handlers share ~80% scaffold (auth/RL/CSRF/body-parse/adminError). Should we extract a shared `withAdminScaffold(handler)` wrapper before T05/T06, as a sub-task (T04b)? Trade-off: extraction = less duplication, harder to grep individual handler logic; duplication = clearer per-handler control flow. Recommend: duplication for v0.10.6 (only 2 handlers; extract in v0.11.0 if 3rd handler arrives).

6. **T11 + T12 atomicity**: They're independent (different pages, different endpoints). Should land as 2 parallel PRs after T09+T10. Confirmed parallel.

7. **CI lint for admin-only constraints** (V3 PATCH 8, 15): The grep-based lints (no inline JS, no `innerHTML = template`, no `insertAdjacentHTML`) need a home. Add to `package.json` scripts as `lint:admin` and wire into CI. Alternative: add as a separate `tests/lint/admin-lint.test.ts` that shells out to grep. Recommend: `package.json` script + GitHub Actions step (consistent with existing project patterns).

8. **`request_id` plumbing on `AuthHandlerContext`** (V3 PATCH 16): Spec assumes `ctx.requestId` exists. Verify against `src/auth/context.ts` before T05. If absent, T05 (or a sub-task) adds it (~10 LOC). Otherwise plan is correct as-written.

9. **Coverage thresholds**: V2 Cut#6 says no per-file 100% coverage. Plan follows. Confirm with reviewer: are there any files (`src/admin/validate.ts` is pure logic, easy 100%) where a per-file gate would catch regressions cheaply?

10. **Release cadence**: Plan assumes T16 ships after T15 docs. Alternative: cut a beta tag (v0.10.6-beta.0) after T13, gather operator feedback, then T15+T16. Recommend: ship straight to v0.10.6 (admin UI is additive + internal-tools-grade).

---

# What was cut from the plan (vs what spec implies)

| Cut | Reason |
|---|---|
| Per-actor post-auth rate limit | V2 Cut#5 + V3 PATCH 4 (per-IP pre-auth on mutations only) |
| `*.failed` audit events for validation rejections | V2 Cut#1 (400 noise, not signal) |
| Separate `*.refused` audit event for role change denial | V2 Cut#2 (folded into `outcome: "denied"`) |
| ETag / If-Match optimistic concurrency | V2 Non-goal + V3 PATCH 13 (fresh-row response is the substitute) |
| HMAC-bound CSRF token | V2 Non-goal (double-submit + SameSite=Strict layered defense) |
| i18n today | V2 Non-goal; V3 PATCH 18 centralizes strings to make future i18n cheap |
| Pagination | V2 Non-goal (LIMIT 5000 hard ceiling) |
| Org delete / user create / user suspend | V2 Non-goal (defer to v0.11.0) |
| Audit log viewer UI | V2 Non-goal |
| `coordinator_admin_requests_total` prom metric | V2 §Observability ("add post-ship if operators ask") |
| Inline `<script>` blocks with CSP fallback | V2 Cut#9 + V3 PATCH 8 (day-1 extraction to 4 JS files) |
| Single-page tab nav | V2 Cut#10 (3 separate pages with landing) |
| 5 test files (2 unit + 2 integration + 1 e2e) | V2 Cut#7 partial (2 integration + 1 e2e + small unit additions for validate.ts and admin.js helpers) |
| `idp_provider` / `idp_org_id` editing | V3 PATCH 17d (explicit non-goal) |

---

# Review request

This plan needs Round 1 plan review. Recommended reviewer lenses:

1. **Task atomicity**: are tasks the right size? Any that need splitting/merging? Particularly T05/T06 (handler size) and T11/T12 (frontend page size).
2. **Dependency graph**: missing edges? Cycles? Wrong ordering? Particularly the T03↔T05 (UNIQUE INDEX → 409 handling) and T08↔T11/T12 (CSP → page works) edges.
3. **Missing tasks**: anything V2 or V3 mandates that has no task here? Check each V3 PATCH (1-18) is covered.
4. **Over-engineered tasks**: anything that could be simpler? Particularly T09 (shared infra) — is the `STRINGS` table justifying its weight for English-only v0.10.6?
5. **Acceptance criteria**: are they specific enough that an implementer knows when they're done?
6. **LOC budgets**: rough but should be in the right order of magnitude. Phase B (~900) and Phase C (~1100) are the heavy hitters — credible?
7. **Open questions**: any flagged questions whose answer changes the task structure (especially #3 `updated_at` schema and #8 `ctx.requestId` plumbing)?

After Round 1 plan review, apply patches; then ready for subagent-driven implementation.
