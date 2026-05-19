# Admin UI plan — V2 patches

**Date**: 2026-05-18
**Status**: V2 patches — supersedes specific sections of plan V1
**Supersedes**: `2026-05-18-admin-ui-plan.md` V1
**Plan review trail**: `docs/superpowers/working/v0.10.6-admin-ui/plan-round1/` (4 reviewers)
**Synthesis**: `docs/superpowers/working/v0.10.6-admin-ui/plan-round1/00-SYNTHESIS-PLAN.md`
**Read order**: V1 plan first (overall shape + context), then this patches doc (task splits + edge fixes + acceptance precision).
**Companion**: v0.10.5 IdP encryption (`docs/superpowers/plans/2026-05-17-idp-encryption-plan-V2-patches.md`) — same patches-doc structure.

## Purpose

Plan Round 1 (4 reviewers) found 12 convergent issues + 13 single-reviewer issues against V1. Most are mechanical: 16 tasks should be 21 (5 splits + 3 new tasks + 1 helper lift + 1 reclassify), several dependency edges are wrong, acceptance criteria need command-bindings, and 4 of 10 open questions need to be resolved (not "left for implementation"). Architecture is sound — no rewrite needed.

V2 is a patches-doc (not a full rewrite). The V1 plan body remains the authoritative description of each task; this doc patches the task list, the DAG, the acceptance criteria, and adds 5 new tasks (T00, T10a, T09c, T15b, plus the test-helper TH).

---

## PATCH 1 — Preamble: bind acceptance commands

**Supersedes**: V1 implicit "lint clean" / "tests pass" / "coverage gate met" / "100% coverage" phrasing throughout (T01, T02, T05, T06, T08, T09, T11, T12, T13, T14).

**Reason**: 9 V1 tasks list "Lint clean" but `package.json` has no `lint` script (verified: only `build`, `test`, `test:watch`, `test:e2e`, `cli`, `start`, `dev`, `dev:stdio`, `perf:*`, `chaos:*`, `prepublishOnly`). "100% coverage" is mentioned but no `vitest.config.ts` threshold entries exist for the new admin files. An implementer cannot tell when acceptance is satisfied; it becomes judgment.

Add to plan preamble (immediately after the existing introduction):

```
## Acceptance command bindings

Throughout this plan, the following acceptance phrases bind to specific commands:

- **"tests pass"** = `npm test` exits 0 AND no test prints `SKIP` for any newly-added file.
- **"lint clean"** = `npx tsc --noEmit` exits 0 AND (where introduced) `npm run lint:admin`
   (added in T09c) exits 0. NOTE: project has no general `lint` script; TypeScript noEmit
   is the de-facto lint. Until T09c lands, admin-specific lint requirements stand as inline
   greps in task acceptance.
- **"coverage gate met"** = `npm test -- --coverage` exits 0 with vitest's per-file threshold
   for the task's touched files reaching 100/100/100/100. Per-file entries must exist in
   `vitest.config.ts` (T03 pre-stubs all entries with TODO comments; later tasks fill in
   by removing TODO).
- **"compile clean"** = `npm run build` exits 0.
- **"CI lint passes"** (admin-specific, post-T09c) = `npm run lint:admin` exits 0.
   Runs the 6 grep checks: (a) `db.transaction(...)()` without `.immediate()`,
   (b) inline `<script>` blocks in admin*.html, (c) `on*=` attributes in admin*.html,
   (d) `innerHTML = template` in admin*.js, (e) `insertAdjacentHTML` in admin*.js,
   (f) any `db.transaction(` in src/admin/ NOT immediately followed by `.immediate()`.
- **"no flakes on N reruns"** = enforced via CI by `--retries=2` on Playwright config;
   no test may rely on retry to pass (Playwright reports flaky-but-passed; gate flake count).

Each task's acceptance criteria inherit these unless explicitly overridden.

## Open questions — RESOLVED

V1 OQ #1 (`/api/auth/me` exists?) — see T10a (PATCH 8).
V1 OQ #2 (`admin-strings.js` separate file?) — REJECTED: keep STRINGS folded into admin.js per V3 PATCH 18.
V1 OQ #3 (`updated_at` schema?) — REJECTED: handler omits field gracefully when column absent;
  re-SELECT returns whatever exists. No migration in v0.10.6; defer to v0.11.0 if operator demand.
V1 OQ #4 (jsdom devDep?) — RESOLVED: `jsdom` added in T09b (PATCH 5).
V1 OQ #5 (extract withAdminScaffold?) — REJECTED for v0.10.6 (2 handler files; not worth
  abstraction); extract in v0.11.0 if 3rd handler file arrives.
V1 OQ #6 (T11/T12 parallel?) — CONFIRMED parallel via mock fixtures.
V1 OQ #7 (CI lint home?) — RESOLVED: T09c (PATCH 5).
V1 OQ #8 (ctx.requestId plumbing?) — RESOLVED: T00 (PATCH 2).
V1 OQ #9 (per-file coverage thresholds?) — ACCEPTED for src/admin/*: pre-stubbed in T03
  (PATCH 6). Overrides V2 Cut#6 explicitly for security-critical handlers.
V1 OQ #10 (beta tag?) — REJECTED: straight ship v0.10.6.
```

---

## PATCH 2 — NEW T00: `ctx.requestId` plumbing

**Supersedes**: V1 Open Question #8.
**Reason**: V3 PATCH 16 (`adminError` helper) assumes `ctx.requestId` exists on `AuthHandlerContext`. V1 buried this as an open question with conditional "T05 or a sub-task adds it (~10 LOC)." This is a hard prerequisite for T05*, T06*, T13 — all of which assume request_id in error envelopes. Promoting to a discrete Phase A task makes the dependency explicit.

Insert as new task before T01a:

```markdown
## T00: `ctx.requestId` plumbing on `AuthHandlerContext`

**Size**: ~30 LOC (type + dispatcher wiring + test)
**Dependencies**: none
**Spec refs**: V3 PATCH 16 (request_id in error envelope), V3 PATCH 11 (request_id in validation 400)

**Files touched**:
- `src/auth/context.ts` — **MODIFIED** (if `requestId: string` not already exported on
  `AuthHandlerContext`).
- `src/http/auth-routes.ts` or wherever `AuthHandlerContext` is constructed — **MODIFIED** —
  pipe `req.headers['x-request-id'] ?? randomUUID()` into `ctx.requestId` at dispatch time.
- `tests/unit/auth-context-request-id.test.ts` (NEW) — assert context contains `requestId`
  matching `/^[a-f0-9-]{8,}$/`; assert `x-request-id` request header is preserved when
  present; assert one is generated when absent.

**Implementation summary**:
1. Grep current state first: `grep -n "requestId" src/auth/context.ts`. If symbol already
   exists with `: string` type and is populated at dispatch, this task is a verification
   no-op (delete the impl bullets; keep only the test as a regression).
2. If absent: add `requestId: string` to the context type; populate at the single dispatcher
   entry point (likely `src/http/auth-routes.ts` or `src/serve-http.ts` — locate by
   `grep -rn "AuthHandlerContext" src/http/`).
3. Use `node:crypto.randomUUID()` for generation. Preserve any client-supplied
   `x-request-id` if present and matches `/^[A-Za-z0-9._-]{8,128}$/`.

**Test cases**:
- `ctx.requestId` populated on every request.
- Client-supplied `x-request-id: my-trace-id-123` preserved on context.
- Malformed client header (e.g. `x-request-id: <script>`) ignored; fresh UUID generated.
- Two requests in a row → distinct `requestId` values.

**Acceptance**:
- Test passes.
- `grep -rn "ctx\.requestId" src/` returns 0 hits before T05a; ≥4 hits after T05*/T06*
  land (one per error path).
- Existing dispatcher tests unchanged.
- Compile clean, lint clean.
```

---

## PATCH 3 — Split T01 into T01a / T01b

**Supersedes**: V1 §T01 entirely.
**Reason**: V1 T01 bundled two unrelated changes: (a) CSRF constant extraction in `src/auth/`, (b) conditional `BootValidationError` hoist in `src/errors.ts` / `src/security/encryption.ts`. Mixed concerns + conditional "if needed" scope makes the PR scope unknowable. The hoist is also a strict prerequisite for T03 while the constant blocks nothing.

### T01a: `CSRF_COOKIE_NAME` constant

```markdown
## T01a: `CSRF_COOKIE_NAME` constant + literal-replacement refactor

**Size**: ~50 LOC (1 const export + 5 import-site updates + 1 test)
**Dependencies**: none
**Spec refs**: V2 §Auth + CSRF (line 188)

**Files touched**:
- `src/auth/csrf.ts` — **MODIFIED** — add `export const CSRF_COOKIE_NAME =
  "__Host-coordinator_csrf";`
- `src/auth/oauth-finalize.ts:24,305,323` — **MODIFIED** — import + replace literal.
- `src/auth/logout.ts:30` — **MODIFIED** — same.
- `src/auth/device-flow.ts:208` — **MODIFIED** — same.
- `tests/unit/csrf-cookie-name.test.ts` (NEW) — pin value + grep-single-source assertion.

**Implementation summary**:
1. Add the export. Value MUST be exactly `"__Host-coordinator_csrf"` (verify against
   existing literal usage byte-for-byte).
2. Search & replace all `"__Host-coordinator_csrf"` literal occurrences in `src/auth/`
   with the imported constant. Do NOT replace in tests, fixtures, or comments.
3. Verify: `grep -rn '"__Host-coordinator_csrf"' src/` returns ONLY the definition site
   post-refactor.

**Acceptance**:
- New test green.
- All existing auth tests pass.
- Lint clean, compile clean.
- `grep -rn '"__Host-coordinator_csrf"' src/` shows 1 line (the export site).
```

### T01b: `BootValidationError` hoist (CONDITIONAL — may be deleted)

```markdown
## T01b: `BootValidationError` hoist (conditional pre-flight check)

**Size**: ~20 LOC OR 0 LOC (delete this task entirely if already exported)
**Dependencies**: none
**Spec refs**: V3 PATCH 10 (used in T03 boot guard)

**Pre-impl check (perform during plan-execution, NOT during implementation)**:
```bash
grep -rn "BootValidationError" src/ | head
grep -rn "export.*BootValidationError" src/
```

If the symbol is already exported from a path importable by `src/database.ts`
(typically `src/security/encryption.ts`, `src/boot.ts`, or `src/errors.ts`):
**DELETE THIS TASK**. T03 imports from existing path.

Otherwise:

**Files touched**:
- `src/errors.ts` (NEW or MODIFIED) — `export class BootValidationError extends Error { ... }`.
- Existing source where the class is currently defined — **MODIFIED** — re-export from new
  home OR delete the local definition (depending on call-site count).
- `tests/unit/boot-validation-error.test.ts` (NEW) — `new BootValidationError("msg")
  instanceof Error`, constructor takes string.

**Implementation summary**: minimal hoist; preserve any existing `code`/`field` properties.

**Acceptance**:
- Test passes (or task deleted with documented grep evidence).
- All existing tests pass unchanged.
- Lint clean, compile clean.
```

---

## PATCH 4 — Split T05 + T06 per endpoint; lift admin-session helper to Phase A

**Supersedes**: V1 §T05, §T06, and §"Test infrastructure" cross-cutting `tests/helpers/admin-session.ts`.

**Reason**: V1 T05 (3 endpoints) and T06 (2 endpoints + load-bearing last-admin SQL) bundled behaviorally-distinct handlers at 280 LOC each, with tests deferred to T13 — meaning the highest-risk PRs (T06 last-admin guard) were unverifiable in isolation. Reviewer of "PATCH /api/admin/users/:id last-admin guard with 4-case re-SELECT + SQLITE_BUSY → 503" needs a different mental model than reviewer of "GET /api/admin/users with `?org=` filter."

Additionally: the test helper `tests/helpers/admin-session.ts` was scheduled inside T13 as a cross-cutting addition, but per-handler tests in T05*/T06* depend on it.

### TH: `tests/helpers/admin-session.ts`

```markdown
## TH: tests/helpers/admin-session.ts (NEW — lifted from V1 T13 cross-cutting section)

**Size**: ~80 LOC (helper + self-tests)
**Dependencies**: none (uses existing `mintSession` pattern from auth tests)
**Spec refs**: V1 §Test infrastructure, V2 §Testing

**Files touched**:
- `tests/helpers/admin-session.ts` (NEW) — exports `adminFetchClient(coord, opts?)`.
- `tests/unit/admin-session-helper.test.ts` (NEW) — self-tests each public API.

**Implementation summary**:
1. `adminFetchClient(coord, { role = "admin", userId? }): { fetch, csrfToken, sessionCookie, userId }`.
   - Mints session via existing `mintSession` pattern (find by `grep -rn "mintSession"
     tests/integration/`).
   - Returns object: `fetch(url, opts)` auto-adds `Cookie` header + `X-CSRF-Token` for
     non-GET methods; `csrfToken`/`sessionCookie`/`userId` raw for tests that need them.
2. `coord.db` accessor exposed for direct DB seeding (last-admin matrix, etc.).
3. Reusable from Playwright via `request.newContext({ extraHTTPHeaders: ... })`.

**Test cases**:
- Mint admin session → `csrfToken` and `sessionCookie` are non-empty strings.
- Helper auto-adds CSRF header to POST/PATCH/DELETE; omits for GET.
- Mint member session via `{ role: "member" }` → 403 on subsequent admin endpoint call.
- `userId` field present for tests needing self-demote scenarios.

**Acceptance**:
- All self-tests pass.
- Existing auth-test patterns NOT modified (helper is additive).
- Coverage gate met.
- Lint clean.
```

### T05a: `handleListOrgs` (GET)

```markdown
## T05a: handleListOrgs (GET /api/admin/orgs) + tests

**Size**: ~130 LOC (handler + tests)
**Dependencies**: T00, T01a, T04, TH
**Spec refs**: V2 §Endpoints 1 (line 87-94), V3 PATCH 4 (no RL on GET)

**Files touched**:
- `src/admin/handle-admin-orgs.ts` (NEW; receives `handleListOrgs` + module-level
  scaffold-import; T05b adds POST/PATCH to same file).
- `tests/integration/handle-admin-orgs-list.test.ts` (NEW).
- `vitest.config.ts` — remove TODO on `src/admin/handle-admin-orgs.ts` threshold entry
  (pre-stubbed by T03 per PATCH 6) — IF this is the last admin-orgs PR; otherwise leave.

**Implementation summary**:
1. Implement common scaffold imports from T04 (`adminError`, `authenticateAdmin`,
   `validateOrgIdQueryParam`).
2. Handler: auth + role gate + SQL `SELECT id, name, allowlist_github_org, allowlist_idp_org_id,
   created_at FROM orgs ORDER BY created_at ASC, id ASC LIMIT 5000`.
3. Response: 200 `{ orgs: [...] }` with `Cache-Control: no-store`.

**Test cases**:
- No auth → 401 with `WWW-Authenticate`.
- Member role → 403 FORBIDDEN.
- Admin role → 200 with seeded orgs.
- Ordering: seed 3 orgs with distinct timestamps → response ordered ASC.
- LIMIT 5000: seed 5001 → response has exactly 5000 (NOT 5001).
- 100 GETs from same IP in 60s → all 200 (no RL on GETs per V3 PATCH 4).

**Acceptance**:
- All tests pass.
- Coverage gate met for `src/admin/handle-admin-orgs.ts` (will remain partial until T05b lands).
- Lint clean.
```

### T05b: `handleCreateOrg` + `handleUpdateOrg` (POST + PATCH)

```markdown
## T05b: handleCreateOrg + handleUpdateOrg + tests

**Size**: ~250 LOC (2 mutation handlers + dedicated tests including 409 discriminator)
**Dependencies**: T00, T01a, T02, T03, T04, T05a, TH
**Spec refs**: V2 §Endpoints 2-3 (lines 95-110), V3 PATCH 2 (.immediate()), V3 PATCH 11
  (no-echo + request_id), V3 PATCH 13 (return fresh row, omit updated_at gracefully),
  V3 PATCH 16 (adminError)

**Files touched**:
- `src/admin/handle-admin-orgs.ts` — **MODIFIED** — append `handleCreateOrg`,
  `handleUpdateOrg`.
- `tests/integration/handle-admin-orgs-mutations.test.ts` (NEW).
- `vitest.config.ts` — remove TODO on `src/admin/handle-admin-orgs.ts` (final fill-in).

**Implementation summary**:
1. POST: RL + CSRF + body parse (4 KB cap) + validate. Tx `.immediate()`. On UNIQUE
   violation → 409 ORG_NAME_TAKEN (see test #7 for column-scope discriminator).
2. PATCH: dispatcher passes already-decoded `orgId`. Capture before-snapshot, dynamic
   UPDATE, fresh re-SELECT (omit `updated_at` if column absent — graceful per OQ#3
   resolution). Emit `admin.org.updated` audit with `changed_fields` + before/after
   for changed fields only.

**Test cases** (THIS PR; not deferred to T13):
1. POST happy: 201 with `{ org: { id, name, allowlist_github_org, allowlist_idp_org_id,
   created_at } }`. New row in DB. `admin.org.created` audit emitted exactly once.
2. POST 400 empty name → `body.code === "REQUIRED"` / `TOO_SHORT`; `body.message` does
   NOT contain the rejected input.
3. POST 400 name with `<script>` → `body.message` does NOT contain `"<script>"`.
4. POST 400 unknown body field → `body.code === "UNKNOWN_FIELD"`, `body.field === "evil"`.
5. POST 400 response includes `body.request_id` matching `/^[a-f0-9-]+$/`.
6. POST 400 body >4096 bytes → 400 PAYLOAD_TOO_LARGE.
7. **POST 409 column-scope discriminator** (acceptance#7): seed conflicting `orgs.name` →
   `body.code === "ORG_NAME_TAKEN"`. Mock a second UNIQUE constraint on another column
   (or document that absent of one, the impl MUST check
   `err.code === "SQLITE_CONSTRAINT_UNIQUE" && err.message.includes("orgs.name")`).
   Acceptance: impl-side string match against `"orgs.name"` or `"idx_orgs_name"`.
8. PATCH happy: 200 with fresh row. `updated_at` field present-or-absent per schema.
9. PATCH 404 on unknown id.
10. PATCH 409 ORG_NAME_TAKEN on conflict (same discriminator as POST).
11. PATCH 400 BAD_PATH on malformed `%XX` — note: error originates from `validatePathParam`
    in T04 (NOT dispatcher), per acceptance#14 → T07 simplified.
12. Audit `admin.org.updated` includes `changed_fields` + only before/after for changed
    fields (V2 line 109).
13. Audit NOT emitted on validation reject (V2 Cut#1).
14. **Tx atomicity**: mock `db.prepare` for INSERT to throw → assert NO audit row in DB
    (proves mutation+audit are in single tx).

**Acceptance**:
- All 14 test cases pass.
- Coverage gate met for `src/admin/handle-admin-orgs.ts` (100/100/100/100).
- Lint clean.
- All `db.transaction(...)` calls end with `.immediate()` (grep verifiable; T09c lint
  enforces post-T09c).
```

### T06a: `handleListUsers` (GET)

```markdown
## T06a: handleListUsers (GET /api/admin/users) + tests

**Size**: ~130 LOC (handler + tests)
**Dependencies**: T00, T01a, T04, TH
**Spec refs**: V2 §Endpoints 4 (lines 111-130), V3 PATCH 14 (meta.admin_count + truncated)

**Files touched**:
- `src/admin/handle-admin-users.ts` (NEW; receives `handleListUsers` only; T06b adds PATCH).
- `tests/integration/handle-admin-users-list.test.ts` (NEW).

**Implementation summary**: per V1 T06 list spec; SQL includes `role IN ('admin','member')`
filter (V3 PATCH 12); response includes `meta.admin_count` + `meta.truncated`.

**Test cases**:
- Auth/role gates (401, 403).
- Returns `{ users, meta: { admin_count, truncated } }`.
- `meta.admin_count` matches `SELECT COUNT(*) FROM users WHERE role='admin'`.
- `?org=acme-org` filter applied.
- `?org=invalid_chars$` → 400 INVALID_REQUEST.
- `role IN ('admin','member')` filter: seed agent + service rows → assert excluded.
- LIMIT 5000: seed 5000+1 admin-or-member → response length === 5000, `meta.truncated === true`.
- 100 GETs in 60s same IP → all 200 (no RL on GETs).

**Acceptance**:
- All tests pass.
- Coverage gate met for handleListUsers code paths (file-level threshold reached when T06b lands).
- Lint clean.
```

### T06b: `handleUpdateUserRole` + last-admin guard (PATCH) — REGRESSION SENTINEL CARRIER

```markdown
## T06b: handleUpdateUserRole + last-admin TOCTOU guard + dedicated regression tests

**Size**: ~250 LOC (handler + 2-clause SQL + 4-case re-SELECT + SQLITE_BUSY + tests +
  TOCTOU sentinel)
**Dependencies**: T00, T01a, T02, T04, T06a, TH
**Spec refs**: V2 §Endpoints 5 (lines 131-142), V3 PATCH 1 (2-clause SQL), V3 PATCH 2
  (.immediate()), V3 PATCH 5 (SQLITE_BUSY → 503), V3 PATCH 12 (role enum), V3 PATCH 16
  (adminError)

**Files touched**:
- `src/admin/handle-admin-users.ts` — **MODIFIED** — append `handleUpdateUserRole`.
- `tests/integration/handle-admin-users-role-change.test.ts` (NEW) — handler-local
  matrix including TOCTOU sentinel.
- `vitest.config.ts` — remove TODO on `src/admin/handle-admin-users.ts`.

**Implementation summary**:
1. Common scaffold (RL + CSRF + body parse + validate). Body must contain `role` only.
2. **2-clause last-admin guard SQL exactly per V3 PATCH 1** (V1's 3-clause variant is the
   regression target):
   ```sql
   UPDATE users SET role = ?
     WHERE id = ?
       AND role IN ('admin','member')
       AND (? = 'admin' OR (SELECT COUNT(*) FROM users WHERE role='admin') > 1)
   ```
3. 4-case re-SELECT distinguisher when `info.changes === 0`:
   not_found / not_human_user / self_demotion / last_admin.
4. Wrap entire handler in try/catch for `SQLITE_BUSY` → 503 DB_BUSY + `Retry-After: 1`.

**Test cases** — handler-local + TOCTOU sentinel (per acceptance#4 — reframed):
1. Promote member → admin: 200, audit `admin.user.role_changed` success.
2. Demote one of two admins → 200; audit success.
3. Demote sole admin (self) → 409 CONFLICT_SELF_DEMOTION; audit denied with
   `denied_reason: "self_demotion"`.
4. **V3 PATCH 1 dead-clause repro (regression sentinel)**: seed A=admin, B=admin. Demote
   A using B-as-actor (1 admin = B). Re-promote A. A-as-actor demotes B → expect
   409 CONFLICT_LAST_ADMIN. V2's 3-clause SQL would've returned 200 — this test ships
   with the guard SQL, not in T13.
5. **TOCTOU sentinel (was V1 "2 concurrent demotes" — reframed per acceptance#4)**:
   - Test 5a (sequential, REPLACES "concurrent"): sequential demotes of last 2 admins
     → first 200, second 409 CONFLICT_LAST_ADMIN. Proves guard SQL holds invariant
     across handler calls.
   - Test 5b (differential test, NEW): create a separate test file
     `tests/integration/handle-admin-users-last-admin-differential.test.ts`. Manually
     install the buggy V2 3-clause SQL into the handler via `vi.spyOn` of the
     statement-building function (OR fork the handler into a fixture). Run the same
     "demote last admin" flow → assert second call returns 200 (proves the 3-clause
     bug). Then run with real 2-clause SQL → assert second call returns 409. This
     differential test proves the 2-clause vs 3-clause change is load-bearing.
6. PATCH on agent user → 409 NOT_HUMAN_USER + audit denied with
   `denied_reason: "not_human_user"`.
7. PATCH on service user → 409 NOT_HUMAN_USER.
8. PATCH with `{ role: "ADMIN" }` (uppercase) → 400 INVALID_REQUEST.
9. PATCH with `{ role: "agent" }` → 400 INVALID_REQUEST.
10. Happy 200 response: `{ user: { id, role: newRole } }`.
11. SQLITE_BUSY mock: throw `Error(`SQLITE_BUSY: database is locked`)` from prepared
    statement → 503 with `Retry-After: 1`.

**Acceptance**:
- All 11 test cases pass (including BOTH sentinel tests 4 and 5b).
- Coverage gate met for `src/admin/handle-admin-users.ts` (100/100/100/100).
- SQL is 2-clause (greppable: `grep -c "OR (SELECT COUNT" src/admin/handle-admin-users.ts`
  returns 1, not 2).
- All `db.transaction(...)` end with `.immediate()`.
- Lint clean.
```

---

## PATCH 5 — Split T09 three ways + add jsdom + define lint task

**Supersedes**: V1 §T09 entirely.
**Reason**: V1 T09 (~350 LOC) bundled three distinct concerns: visual theme (CSS), runtime helpers + STRINGS + jsdom tests (JS), and CI lint infrastructure. Reviewer of CSS doesn't need JS-module context; lint infra is a pure CI commit. Plus jsdom is not currently a devDep — Open Q #4 must resolve as YES (add it).

### T09a: `admin.css`

```markdown
## T09a: admin.css (theme + responsive + a11y)

**Size**: ~120 LOC (CSS only, no JS)
**Dependencies**: none
**Spec refs**: V2 §Frontend (CSS portions of lines 266-339), V3 PATCH 17a (320px / 200%
  zoom / axe rules)

**Files touched**:
- `dashboard/public/admin.css` (NEW).

**Implementation summary**: per V1 T09 CSS section verbatim — variables, status pills,
breakpoints, skeleton shimmer, tap targets ≥44×44px, `overflow-wrap: anywhere`.

**Acceptance**:
- File created.
- Manual smoke: open `/dashboard/admin.html` (after T10 lands) → AA contrast confirmed
  via axe (deferred to T14).
- 320px viewport renders without horizontal scroll (manual; T14 e2e verifies).
- Lint clean (tsc noEmit unchanged).
```

### T09b: `admin.js` + STRINGS + jsdom tests

```markdown
## T09b: admin.js shared module + STRINGS + jsdom unit tests + jsdom devDep

**Size**: ~250 LOC (JS module + ~50 LOC of jsdom unit tests + package.json devDep)
**Dependencies**: none
**Spec refs**: V2 §Frontend (JS portions), V3 PATCH 9 (readCsrfToken defensive),
  V3 PATCH 15 (renderTable concrete), V3 PATCH 16 (showToast w/ request_id copy),
  V3 PATCH 17b (fetchWithTimeout), V3 PATCH 18 (STRINGS table)

**Files touched**:
- `dashboard/public/admin.js` (NEW).
- `package.json` — **MODIFIED** — add `"jsdom": "^25"` to devDependencies (resolves OQ#4).
- `tests/unit/admin-js-shared.test.ts` (NEW) — `// @vitest-environment jsdom` pragma at
  top of file.
- `vitest.config.ts` — remove TODO on `dashboard/public/admin.js` IF using ESM imports
  in tests (otherwise file is not source-coverage-counted; verify the jsdom test loads
  it via `eval(readFileSync(...))` or via dynamic `import`).

**Implementation summary**: per V1 T09 JS section verbatim — STRINGS, t(), fetchJson,
fetchWithTimeout, renderTable (Node-accessor support), showToast, readCsrfToken
(returns null on miss), redirectToLogin. Attach to `window.AdminUI`.

**Test cases** (per acceptance#11 — must be runnable):
- `t("toast.org_saved")` → `"Org saved"`.
- `t("confirms.demote_role", { email: "a@b" })` → `"Demote a@b from admin to member?"`.
- `t("unknown.path")` → `"[missing: unknown.path]"`.
- `renderTable([{id:"x", n:"y"}], [{header:"N", accessor: r => r.n}])` returns `<table>`
  with `<td>y</td>`.
- `renderTable` with Node-returning accessor appends the Node (not stringified).
- `readCsrfToken()` with empty `document.cookie` → `null` (does NOT throw).
- `readCsrfToken()` with cookie set → decoded value.
- `fetchWithTimeout` aborts after 10000ms via `AbortController` (use `vi.useFakeTimers()`).

**Acceptance**:
- All jsdom tests pass via `npm test`.
- `package.json` devDeps include `jsdom`.
- `window.AdminUI` exposes the 8 documented helpers (assertion at end of test file).
- Lint clean.
```

### T09c: CI lint script wiring

```markdown
## T09c: lint:admin script + package.json wiring + CI step

**Size**: ~80 LOC (package.json script + GH Actions step OR test-based lint + 6 grep
  files of "planted-violation" fixtures)
**Dependencies**: none (pure CI infra; can ship before T05*/T06*/T11/T12)
**Spec refs**: V3 PATCH 2 (db.transaction without .immediate()), V3 PATCH 8 (inline JS
  + on*= attrs), V3 PATCH 15 (innerHTML + insertAdjacentHTML), acceptance#8 (.immediate()
  static assertion)

**Files touched**:
- `package.json` — **MODIFIED** — add:
  ```json
  "scripts": {
    "lint:admin": "node scripts/lint-admin.mjs",
    "prepublishOnly": "npm run build && npm run lint:admin && npm test"
  }
  ```
- `scripts/lint-admin.mjs` (NEW) — runs 6 grep checks via Node fs/glob; exits 1 on any
  match. Avoids shell-portability issues with raw grep on Windows.
- `.github/workflows/ci.yml` (if exists) — **MODIFIED** — add step `npm run lint:admin`.
  If no GHA workflow exists, the `prepublishOnly` hook above guarantees pre-release gate.
- `tests/unit/lint-admin-self.test.ts` (NEW) — sanity test: planted violations in
  ephemeral fixture files trigger script exit 1.

**Implementation summary**:
The 6 checks (each greps a directory glob; exit 1 if matches):
1. `grep -rnE 'db\.transaction\([^)]*\)\(\)' src/admin/` — V3 PATCH 2 (.immediate() missing).
2. `grep -rnE 'db\.transaction\(' src/admin/ | grep -v '\.immediate()'` — alternative
   form (per acceptance#8 — static assertion of .immediate() presence).
3. `grep -rnE '<script[^>]*>[^<]' dashboard/public/admin*.html` — V3 PATCH 8 (inline JS).
4. `grep -rnEi '\son[a-z]+\s*=' dashboard/public/admin*.html` — V3 PATCH 8 (on*= attrs).
5. `grep -rnE '\.innerHTML\s*=\s*[^"'"'"'`]' dashboard/public/admin*.js` — V3 PATCH 15.
6. `grep -rnE '\.insertAdjacentHTML\s*\(' dashboard/public/admin*.js` — V3 PATCH 15.

Use a small Node script (`scripts/lint-admin.mjs`) wrapping these as regex over `glob`-matched
files; collect findings; print summary; exit 1 if any.

**Test cases**:
- Plant violation #1 in a temp test fixture file → script exits 1 with violation #1 in stdout.
- Plant violation #2/3/4/5/6 → same.
- Run with clean fixtures → exits 0.
- `npm run lint:admin` on the current main branch (no admin files yet) → exits 0
  (empty matches).

**Acceptance**:
- `npm run lint:admin` exits 0 against current source tree.
- All planted-violation tests pass.
- `prepublishOnly` runs `lint:admin` (verify via `cat package.json`).
- Lint clean.
```

---

## PATCH 6 — `vitest.config.ts` per-file thresholds pre-stubbed in T03

**Supersedes**: V1 §T03 acceptance + V1 OQ#9.
**Reason**: V1 T05/T06 acceptance said "no per-file 100% threshold per V2 Cut#6", but `vitest.config.ts:38` already enforces 100% for `handle-service-tokens.ts` — admin handlers are equally security-critical. Per-file thresholds for the new admin files have no home task; multiple PRs each appending to the same `vitest.config.ts` block produces merge conflicts. Mirror v0.10.5's pre-stub pattern.

Add to T03's implementation summary:

```markdown
4. Extend `vitest.config.ts` `coverage.thresholds.perFile` with stub entries for ALL
   forthcoming admin files, each with a TODO comment naming the task that fills it in:

   "src/admin/validate.ts":            { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T04
   "src/admin/handle-admin-orgs.ts":   { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T05a+T05b
   "src/admin/handle-admin-users.ts":  { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T06a+T06b
   "src/http/auth-routes.ts":          { ...existing... }, // unchanged
   "tests/helpers/admin-session.ts":   { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO TH

   Each later task (T04, T05a, T05b, T06a, T06b, TH) just removes its TODO comment when
   the file lands at 100%. If a task ships at <100% intentionally (e.g., SQLITE_BUSY
   error path branch), the task's PR must explain in description + downgrade the
   threshold inline (e.g., `branches: 90`).
```

Add to T03 acceptance:
- `git diff vitest.config.ts` shows the 3 new admin-file stub entries + the existing
  entries unchanged.
- `npm test -- --coverage` exits 1 (expected — stubs reference files that don't exist
  yet, vitest warns but doesn't fail). T03 documents this expected warning in PR
  description; thresholds become enforceable once T04+ land.

---

## PATCH 7 — Open Question #3 (`updated_at` schema) RESOLVED: REJECT

**Supersedes**: V1 OQ#3, V1 T03 conditional ~50 LOC delta, V1 T05 `updated_at` response field.

**Decision**: Do NOT ship `updated_at` columns + triggers in v0.10.6. Defer to v0.11.0 if operator demand emerges.

**Rationale**:
- V3 PATCH 13's primary mechanism is "return fresh row from re-SELECT" — this works without
  `updated_at` (the row reflects post-commit state at the response-build moment regardless).
- Adding `updated_at` requires: 2 ALTER TABLE statements + 2 triggers + boot-time migration
  + tests for trigger correctness + risk of trigger interfering with sweeper / other writers.
- Marginal benefit: 1 field in PATCH response that approximates `Date.now()` more precisely.

**T05b implementation note** (replaces V1 T05 line 299): `updated_at` field is OMITTED
from PATCH response when column absent (default v0.10.6 state). Re-SELECT uses
`SELECT id, name, allowlist_github_org, allowlist_idp_org_id FROM orgs WHERE id = ?`
(no `updated_at` in column list). Handler must NOT synthesize the field via `new Date()`
— absent column → absent field. Clients tolerate absent field per spec V2 §Endpoints.

**Test addition in T05b** (folded into PATCH 4 above as test #8): "PATCH response
shape: `updated_at` field is ABSENT in v0.10.6 (column not present)."

**T15b runbook note** (PATCH 11): "v0.11.0 candidate: `updated_at` columns on `orgs`
+ `users` for precise mutation timestamps. Currently deferred per V2 patches OQ#3
rejection."

---

## PATCH 8 — NEW T10a: `/api/auth/me` verify-or-add

**Supersedes**: V1 OQ#1, V1 T10 line 579.
**Reason**: T10's landing page calls `fetch("/api/auth/me")` to populate admin email banner. Cookie is HttpOnly → client-side JWT decode impossible. V1 buried this as "open question 1" with conditional ride-along (~30 LOC). Promote to a discrete task so T10's acceptance can be verified.

Insert as Phase A-or-C ride-along:

```markdown
## T10a: /api/auth/me verify-or-add ride-along

**Size**: ~50 LOC if absent (handler + dispatch + tests) OR ~5 LOC verification commit if present
**Dependencies**: none (independent of all admin work)
**Spec refs**: V1 OQ#1, V2 §Auth (implicit for landing-page UX)

**Pre-impl check (perform during plan-execution)**:
```bash
grep -rn "/api/auth/me" src/ dashboard/
grep -rn "handleAuthMe\|handle_auth_me\|authMe" src/auth/
```

If endpoint exists with shape `GET /api/auth/me → 200 { email, sub, role }`:
**This task becomes a verification-only commit** — add a test file pinning the response
shape, then close.

Otherwise:

**Files touched**:
- `src/auth/handle-auth-me.ts` (NEW) — `handleAuthMe(req, res, ctx)`: auth gate, return
  `{ email: claims.email, sub: claims.sub, role: claims.role }`.
- `src/http/auth-routes.ts` — **MODIFIED** — add `"/api/auth/me"` to `KNOWN_AUTH_PATHS` +
  `methodForPath` returns `"GET"` + dispatch entry.
- `tests/integration/handle-auth-me.test.ts` (NEW).

**Test cases**:
- No auth → 401.
- Valid auth → 200 with `{ email, sub, role }`.
- Response is `Cache-Control: no-store`.
- Member role → 200 (endpoint not admin-gated; returns whatever the JWT claims).
- Agent role → 200 (same — caller can introspect).

**Acceptance**:
- All tests pass.
- Endpoint reachable from `/dashboard/admin.html` (verified in T10's manual smoke).
- Coverage gate met.
- Lint clean.
```

---

## PATCH 9 — Frontend tasks (T11/T12) decoupled from backend (T05*/T06*)

**Supersedes**: V1 §T11 deps (line 593: "T09, T05 for backend handlers to test against in T14"), V1 §T12 deps (line 643: "T09, T06").
**Reason**: Per dep-graph#4, T11/T12 source files (HTML + JS) do NOT import T05/T06 — they call JSON APIs at runtime. Coupling forces serialization that doesn't exist at compile time. Decouple by having T11/T12 ship with a **mock-fixture** for their own unit tests; e2e (T14) is the only place real backend + real frontend cross.

Apply to T11 acceptance:

```markdown
**Dependencies (V2)**: T09a, T09b (shared CSS + JS). NOT T05* — page calls JSON API at
runtime; unit tests use mock fixture.

**Test fixture (NEW addition to T11)**:
- `tests/fixtures/admin-orgs-api-mock.ts` (NEW) — exports `mockAdminOrgsApi(fetchSpy)`
  configuring `fetch` mock to return canned responses for `GET /api/admin/orgs`,
  `POST /api/admin/orgs`, `PATCH /api/admin/orgs/:id`.
- `tests/unit/admin-orgs-page.test.ts` (NEW, jsdom env) — loads `admin-orgs.js` under
  jsdom + mock fixture; asserts:
    * Renders 3 seeded rows from mock GET.
    * Empty-state copy renders when GET returns `{ orgs: [] }`.
    * Error-state with retry button when fetch rejects.
    * POST happy path → row appears in table.
    * PATCH 409 ORG_NAME_TAKEN → inline error in dialog, not toast.
```

Apply same pattern to T12 (mock fixture for users API + jsdom page tests).

**Critical-path implication**: T11/T12 can land in Slot 4 (parallel with T13) instead of Slot 5; only T14 needs the backend to actually exist for cross-stack assertions.

---

## PATCH 10 — Dependency edge corrections + new merge sequence

**Supersedes**: V1 §"Dependency DAG" (lines 32-56).
**Reason**: Per dep-graph#1-3, #6, #8 (4 corrections). Critical path drops from 9 slots to 6.

Apply these edge corrections:

| Edge | V1 | V2 | Reason |
|---|---|---|---|
| T11+T12 → T13 | present | dropped | dep-graph#1 — T13 tests JSON API, not pages |
| T13 → T14 | present | dropped | dep-graph#2 — e2e doesn't consume T13 artifacts |
| T10 → T14 | absent | added | dep-graph#3 — T14 tests landing page |
| T11 → T05, T12 → T06 | present | dropped | dep-graph#4 — runtime API call, no file-level dep |
| T01 → T03 | hard | conditional | dep-graph#5 — only if T01b is non-deleted |
| T13+T14 → T15 | present | T07 → T15 | dep-graph#8 — docs unblocked from tests |
| T13 acceptance | "no concurrent" | sentinel sentinel test | acceptance#4 — TOCTOU reframe |
| `ctx.requestId` | open question | T00 task | atomicity#5, missing#3 |

Replace V1 §Dependency DAG with:

```
Phase A (parallel — all 7 independent):
  T00   ctx.requestId
  T01a  CSRF constant
  T01b  BootValidationError hoist (CONDITIONAL — may be deleted)
  T02   TIER1_EVENTS
  T03   UNIQUE INDEX + boot guard + pre-stubbed vitest thresholds (PATCH 6)
  T04   validate.ts + adminError + scaffold helpers + validatePathParam (T07 simplification)
  TH    admin-session.ts test helper

Phase B (mostly parallel):
  T00, T01a, T04, TH ──→ T05a, T06a (list handlers, no schema dep)
  T00, T01a, T02, T03, T04, T05a, TH ──→ T05b (mutation handlers, needs UNIQUE INDEX + audit)
  T00, T01a, T02, T04, T06a, TH ──→ T06b (role change + last-admin)
  T01b → T03 (conditional)
  T05a, T05b, T06a, T06b ──→ T07
  (T08 independent; PATCH 14 applies to T08)
  (T09a, T09b, T09c independent — Phase C)

Phase C (parallel after Phase B foundation):
  T09a, T09b ──→ T10, T11, T12
  T10a ──→ T10 (auth/me ride-along)
  (T11/T12 NOT blocked on T05*/T06* per PATCH 9)

Phase D:
  T07 ──→ T13 (integration cross-cutting matrix)
  T07, T08, T10, T11, T12 ──→ T14 (e2e; T13 NOT in deps per dep-graph#2)
  T07 ──→ T15a, T15b (docs from spec, no test deps)
  T13, T14, T15a, T15b ──→ T16 (ceremony)
```

No cycles. Critical path: T04 → T05b/T06b → T07 → T14 (4 slots). With Slot 1 = Phase A
foundation, full timeline = 6 slots.

### Recommended merge sequence

```
Slot 1 (parallel — 7 PRs): T00, T01a, T01b, T02, T03, T04, TH
Slot 2 (parallel — 8 PRs): T05a, T05b, T06a, T06b, T08, T09a, T09b, T09c
Slot 3 (parallel — 2 PRs): T07, T10a
Slot 4 (parallel — 6 PRs): T10, T11, T12, T13, T15a, T15b
Slot 5 (1 PR):             T14
Slot 6 (ceremony):         T16 (release-please bot + npm publish)
```

V1 implied 9 sequential slots. V2 = 6 wall-clock slots, 24 PRs across 5 active development slots.

---

## PATCH 11 — Split T15 into T15a / T15b; T16 reclassified as ceremony

**Supersedes**: V1 §T15, §T16.
**Reason**: T15 (~300 LOC) bundled three audiences (user-facing README, self-host onboarding, ops runbook). T16 (~50 LOC) is a release-please bot PR, not a unit of code review.

### T15a: README + onboarding + CHANGELOG augmentation

```markdown
## T15a: README + onboarding-self-host + CHANGELOG

**Size**: ~80 LOC across 3 files
**Dependencies**: T07 (API path/method stable)
**Spec refs**: V2 §References

**Files touched**:
- `README.md` — **MODIFIED** — add "Admin UI" section under feature list; Compliance
  matrix entry for v0.10.6 "Admin web UI: Shipped."
- `docs/onboarding-self-host.md` — **MODIFIED** — add "Admin UI" subsection under
  §Operate; document `/dashboard/admin.html` entry + admin role JWT claim requirement.
- `CHANGELOG.md` — **MODIFIED** (manual augmentation before release-please picks up) —
  bullet list per V1 T16:
    * New `/api/admin/orgs` + `/api/admin/users` endpoints (5 total).
    * New `/dashboard/admin*.html` pages (3 total).
    * Schema change: `idx_orgs_name` UNIQUE INDEX with pre-flight duplicate-name boot
      guard (v0.10.6 fail-loud-on-dupe behavior).
    * 3 new Tier-1 audit events: `admin.org.created`, `admin.org.updated`,
      `admin.user.role_changed`.

**Acceptance**:
- All files updated.
- Internal links resolve (`npm run docs:check` if exists; else manual eyeball).
- Smoke-read by a non-implementer reviewer.
- Lint clean.
```

### T15b: `docs/ops/admin-ui.md` operator runbook

```markdown
## T15b: docs/ops/admin-ui.md operator runbook (NEW file)

**Size**: ~250 LOC (single new file)
**Dependencies**: T07 (API stable enough that paths/method examples are final)
**Spec refs**: V2 §References, V3 PATCH 10 (boot guard), V3 PATCH 17d (non-goal),
  V3 PATCH 17f (LIMIT 5000 rationale)

**Files touched**:
- `docs/ops/admin-ui.md` (NEW).

**Content sections (REQUIRED — verify each present)**:
1. Access prerequisites (admin role JWT claim, CSRF cookie present).
2. URL layout: `/dashboard/admin.html` (landing), `/dashboard/admin-orgs.html`,
   `/dashboard/admin-users.html`.
3. CSRF double-submit semantics + cookie name (`__Host-coordinator_csrf`).
4. Last-admin protection mechanics: 2-clause SQL guard + 409 CONFLICT_LAST_ADMIN
   surfacing + UI proactive disable.
5. Audit event names + tier + retention (3 events, all Tier-1, 365d).
6. **Gotcha: "Duplicate org names blocked boot"** (V3 PATCH 10 — link to fix SQL).
   Include the literal SQL recovery snippet.
7. **Lockout recovery**: how to restore admin role via raw SQL if admin demotes self
   accidentally (despite the guard, scripted demote is still possible if the user
   bypasses the UI). SQL snippet + warning.
8. **Out of scope (V3 PATCH 17d)**: editing `orgs.idp_provider` / `orgs.idp_org_id` via
   admin UI; deferred to v0.11.0.
9. **Pagination behavior (V3 PATCH 17f)**: LIMIT 5000 ceiling rationale (50× sweeper
   batch); `meta.truncated` signal explained; `?org=` filter narrowing workflow when
   `truncated === true`.
10. **v0.11.0 candidates**: `updated_at` columns (deferred per V2 patches OQ#3);
    org delete; user create; audit log viewer.

**Acceptance**:
- File created with all 10 sections present.
- Operator-mindset review pass by a non-implementer (someone who hasn't read the spec).
- All internal links resolve.
- Lint clean.
```

### T16: Release ceremony (not a tracked dev task)

T16 from V1 is reclassified as a release ceremony — not a code-review unit. The CHANGELOG
augmentation moves to T15a (above); the version bump + npm publish is automated via
release-please bot PR + CI on merge.

**Ceremony steps (executed by maintainer, not tracked as a PR)**:
1. Verify all of T01–T15 merged.
2. Verify `npm test` + `npm run lint:admin` + `npm run build` pass on `main`.
3. Merge release-please bot PR (auto-bumps to v0.10.6).
4. CI publishes to npm + drafts GitHub release.
5. Smoke-install: `npm install -g mcp-coordinator@0.10.6` + verify `/dashboard/admin.html`
   renders.

---

## PATCH 12 — T13: per-IP rate-limit test recipe

**Supersedes**: V1 §T13 RL test bullet (line 712-714).
**Reason**: Per acceptance#3, V1's "61st POST from same IP in 60s → 429 + Retry-After" lacks: IP key source, fake-timer strategy, limiter reset semantics, body-leak assertion.

Replace V1 RL bullet with:

```markdown
**Rate limit tests (per V3 PATCH 4 + acceptance#3 — concrete recipe)**:

Test infrastructure setup (in `beforeEach`):
- All requests bind to `127.0.0.1` in tests; per-IP key source is
  `req.socket.remoteAddress` (verify in `src/admin/handle-admin-orgs.ts` impl —
  if uses `X-Forwarded-For`, test must set header explicitly).
- Use `vi.useFakeTimers()` to control the 60s window.
- Call `coordinator.rateLimiter?.reset()` if helper exists; otherwise instantiate a
  fresh coordinator per test via existing fixture (cheaper than expected for
  in-memory SQLite).

Test cases (T13 file: `tests/integration/handle-admin-orgs.test.ts`):

1. **GETs unrate-limited** (V3 PATCH 4):
   ```typescript
   for (let i = 0; i < 100; i++) {
     const res = await adminClient.fetch("/api/admin/orgs");
     expect(res.status).toBe(200);
   }
   ```

2. **POST 60 then 61st**:
   ```typescript
   for (let i = 0; i < 60; i++) {
     const res = await adminClient.fetch("/api/admin/orgs", {
       method: "POST", body: JSON.stringify({ name: `org-${i}` }),
     });
     expect(res.status).toBe(201);
   }
   const res61 = await adminClient.fetch("/api/admin/orgs", {
     method: "POST", body: JSON.stringify({ name: "org-61" }),
   });
   expect(res61.status).toBe(429);
   expect(res61.headers.get("Retry-After")).toMatch(/^\d+$/);
   const body = await res61.json();
   expect(body.message).not.toMatch(/61|60|count/i);  // no count leak
   ```

3. **Window resets after 60s**:
   ```typescript
   // ...after 61st 429 above
   vi.advanceTimersByTime(60_001);
   const resAfter = await adminClient.fetch("/api/admin/orgs", {
     method: "POST", body: JSON.stringify({ name: "org-after" }),
   });
   expect(resAfter.status).toBe(201);
   ```

4. **RL per-handler scope** (mutation-resistance): from same IP, hit POST /api/admin/orgs
   60 times (cap exhausted), then GET /api/admin/users → 200 (GETs unrelated to mutation
   bucket).
```

---

## PATCH 13 — T13: Concurrent-demote test reframed as TOCTOU sentinel

**Supersedes**: V1 §T13 test bullet "2 concurrent demotes against last 2 admins → exactly one 200 + one 409" (line 751).
**Reason**: Per acceptance#4, better-sqlite3 is synchronous + single-connection. `Promise.all([demoteA(), demoteB()])` resolves serially in vitest's single event loop — no concurrency to race. The "concurrent" framing is misleading; what's actually being tested is the guard SQL's correctness across sequential calls (sufficient because the guard runs inside a single `.immediate()` tx so the invariant is maintained).

Critical: the **regression sentinel** for the V3 PATCH 1 2-clause-vs-3-clause SQL ships with **T06b** (per PATCH 4 above), not T13. T13's role is the cross-cutting matrix.

Replace V1 T13 last-admin section with:

```markdown
**Last-admin matrix (T13 cross-cutting tests — does NOT duplicate T06b's regression sentinel)**:

1. **Sequential TOCTOU sentinel** (renamed from "2 concurrent demotes"): seed last 2
   admins A,B. Sequential `await demote(A); await demote(B)`. Expect first 200, second
   409 CONFLICT_LAST_ADMIN. Proves the guard SQL holds invariant across handler calls.
   ```typescript
   const res1 = await adminClient.fetch(`/api/admin/users/${A.id}`, {
     method: "PATCH", body: JSON.stringify({ role: "member" }),
   });
   expect(res1.status).toBe(200);
   const res2 = await adminClient.fetch(`/api/admin/users/${B.id}`, {
     method: "PATCH", body: JSON.stringify({ role: "member" }),
   });
   expect(res2.status).toBe(409);
   ```

2. **Promise.all sentinel (documented limitation)**: include the same test under
   `Promise.all` to confirm vitest serializes. Document as "vitest single-event-loop
   limitation; real concurrency requires multi-process which is out of scope for
   integration tests."

3. **T06b's differential test (3-clause regression sentinel)** lives in T06b's PR,
   NOT here. T13 does not duplicate.

NOTE: V1's "second blocks then sees post-commit state" prose was about cross-connection
SQLite blocking — not applicable to better-sqlite3's single-connection model.
```

---

## PATCH 14 — T08: CSP directive-map test + ACAO 4-vector matrix

**Supersedes**: V1 §T08 test bullets (lines 446-453).
**Reason**: Per acceptance#5, string-equality on CSP header is brittle (whitespace, directive order). Per acceptance#6, ACAO drop test as written passes for the wrong reason if `isAdminPage` regex over-matches.

Replace V1 T08 test list with:

```markdown
**CSP directive-map tests (mutation-resistant per acceptance#5)**:

Helper:
```typescript
function parseCsp(header: string): Record<string, string[]> {
  return Object.fromEntries(
    header.split(/;\s*/).filter(Boolean).map(d => {
      const [name, ...sources] = d.trim().split(/\s+/);
      return [name, sources];
    })
  );
}
```

For each admin page (`/dashboard/admin.html`, `/dashboard/admin-orgs.html`,
`/dashboard/admin-users.html`):
```typescript
const csp = parseCsp(res.headers.get("Content-Security-Policy") ?? "");
expect(csp["default-src"]).toEqual(["'none'"]);
expect(csp["script-src"]).toEqual(["'self'"]);
expect(csp["style-src"]).toEqual(["'self'"]);
expect(csp["connect-src"]).toEqual(["'self'"]);
expect(csp["img-src"]).toEqual(["'self'", "data:"]);
expect(csp["form-action"]).toEqual(["'self'"]);
expect(csp["frame-ancestors"]).toEqual(["'none'"]);
expect(csp["base-uri"]).toEqual(["'none'"]);

// Mutation-resistance: future "quick fix" must not loosen CSP.
expect(csp["script-src"]).not.toContain("'unsafe-inline'");
expect(csp["script-src"]).not.toContain("'unsafe-eval'");
```

**ACAO 4-vector matrix (mutation-resistance per acceptance#6)**:

1. `/dashboard/admin.html` → `expect(res.headers.get("access-control-allow-origin")).
   toBeNull()`.
2. `/dashboard/admin-orgs.html?return_to=foo` → ACAO absent (query string variant —
   confirms regex `?(\?.*)?$` matches).
3. `/dashboard/index.html` → `expect(res.headers.get("access-control-allow-origin")).
   toBe("*")` (proves else-branch still runs).
4. `/dashboard/Admin.html` (uppercase A) → `expect(...).toBe("*")` (case-sensitive regex
   does NOT over-match; confirms ACAO present on non-admin paths).
5. `/dashboard/admin-extra.html` → ACAO present (regex deliberately rejects future
   admin-* extensions; opt-in only — confirms regex tightness).
```

---

## PATCH 15 — T05b: 409 ORG_NAME_TAKEN column-scope discriminator

**Supersedes**: V1 §T13 line 723 test bullet "409 ORG_NAME_TAKEN on duplicate name."
**Reason**: Per acceptance#7, the impl maps SQLITE_CONSTRAINT_UNIQUE → 409 ORG_NAME_TAKEN; if impl uses just `SQLITE_CONSTRAINT` (broader), a future UNIQUE on another column would also surface as ORG_NAME_TAKEN.

This test moves from T13 to T05b (the PR that introduces the discriminator code). Acceptance criterion for T05b:

```markdown
**409 ORG_NAME_TAKEN discriminator** (T05b test addition):

Impl-side requirement:
```typescript
} catch (err: any) {
  if (
    err.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    (err.message.includes("orgs.name") || err.message.includes("idx_orgs_name"))
  ) {
    adminError(ctx, res, 409, "ORG_NAME_TAKEN", "Org name already exists");
    return;
  }
  throw err;  // re-throw any other constraint error to surface as 500
}
```

Test:
1. POST duplicate name → 409 with `body.code === "ORG_NAME_TAKEN"`,
   `body.message === "Org name already exists"`, `body.message` does NOT contain the
   submitted name (no-echo per V3 PATCH 11).
2. **Column-scope check**: if a second UNIQUE constraint exists in the schema (verify
   via `SELECT * FROM sqlite_master WHERE type='index' AND sql LIKE '%UNIQUE%'`),
   seed a conflict on THAT table during PATCH path → assert response does NOT return
   ORG_NAME_TAKEN (proves the discriminator is column-specific).
3. If no second UNIQUE constraint exists, document in T05b acceptance: the impl MUST
   include `err.message.includes("orgs.name")` OR `"idx_orgs_name"`; the test asserts
   this via:
   ```typescript
   const handler = readFileSync("src/admin/handle-admin-orgs.ts", "utf8");
   expect(handler).toMatch(/orgs\.name|idx_orgs_name/);
   ```
```

---

## PATCH 16 — T14: browser matrix, axe-core devDep, CI inclusion

**Supersedes**: V1 §T14 acceptance + line 775 "POSSIBLY MODIFIED" for axe-core.
**Reason**: Per acceptance#10, V1's "all e2e pass on local + CI" + "no flakes on 5 reruns" is unenforceable. axe-core devDep is undecided.

Replace V1 T14 acceptance with:

```markdown
**Browser matrix + CI integration (per acceptance#10)**:

1. `package.json` devDeps:
   - Add `"axe-playwright": "^2"` (definitive).
   - Add `"@playwright/test"` if not present (verify).

2. `playwright.config.ts`:
   - CI mode: `projects: [{ name: "chromium" }]` only — saves CI minutes.
   - Local mode (default): `projects: [{ name: "chromium" }, { name: "firefox" },
     { name: "webkit" }]` — devs can opt in.
   - `retries: process.env.CI ? 2 : 0` — flake detection on PR, no retries locally.
   - `testDir: "tests/e2e"` (verify covers `admin-ui.spec.ts`).

3. CI inclusion:
   - Verify `.github/workflows/` has a Playwright job. If absent, add one in T14:
     ```yaml
     - name: Install Playwright
       run: npx playwright install --with-deps chromium
     - name: Run e2e
       run: npm run test:e2e
     ```
   - `package.json scripts.test:e2e` must exist (verify; add if absent).

4. **Concurrent-rename test multi-context support**: V1 line 802 ("Two browser contexts")
   requires `tests/e2e/helpers/coordinator-fixture.ts` to support `request.newContext()`
   with distinct sessions. Verify the fixture exposes a `newAdminContext()` method or
   that contexts can be created ad-hoc; if not, add to T14 scope (~20 LOC).

5. **T13/T14 overlap reframed** (per acceptance#9): T14's "bypass disabled UI via direct
   fetch in browser console" test is reframed to assert UI behavior:
   ```typescript
   // Programmatically re-enable the disabled <option>
   await page.evaluate(() => {
     document.querySelector('option[value=member]:disabled')?.removeAttribute('disabled');
   });
   await page.selectOption('select[name=role]', 'member');
   await page.click('button[data-action=save]');
   // Assert UI behavior, not status code (status is T13's job):
   await expect(page.locator('select[name=role]')).toHaveValue('admin'); // reverted
   await expect(page.locator('[role=alert]')).toBeVisible();              // inline error
   await expect(page.locator('#toasts > *')).toHaveCount(0);              // no toast
   ```

6. Flake-detection enforcement: CI fails if any test reports "flaky-but-passed" status
   (Playwright JSON reporter `--reporter=json`; CI script grep for `flaky` count > 0
   → fail).

**Acceptance**:
- All e2e tests pass on chromium in CI.
- axe-core scan reports zero violations on all 3 admin pages.
- 320px viewport test passes (no horizontal scroll).
- Concurrent-rename test passes (2 contexts).
- No flaky-but-passed in CI report.
- `axe-playwright` in `package.json` devDeps.
- Lint clean.
```

---

## PATCH 17 — T03: pre-flight idempotency for index-already-present case

**Supersedes**: V1 §T03 acceptance bullet "Re-run migration on already-indexed DB → no-op, no error" (line 181).
**Reason**: Per acceptance#13, V1's idempotency test only proves the migration doesn't crash. The pre-flight SELECT (full table scan on `orgs GROUP BY name`) runs on EVERY boot — perf regression at scale (5M orgs).

Replace V1 T03 implementation step 3 + add acceptance bullet:

```markdown
3. **Idempotent + short-circuit when index exists** (revised):
   ```typescript
   const indexExists = db.prepare(
     "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orgs_name'"
   ).get();
   if (!indexExists) {
     const dupes = db.prepare(`
       SELECT name, COUNT(*) AS n, GROUP_CONCAT(id, ',') AS ids
       FROM orgs GROUP BY name HAVING COUNT(*) > 1
     `).all() as Array<{ name: string; n: number; ids: string }>;
     if (dupes.length > 0) {
       throw new BootValidationError(...);
     }
     db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_name ON orgs(name)");
   }
   ```

**Test addition**:
- After fresh boot (index created), `vi.spyOn(db, 'prepare')`, boot again → assert the
  `SELECT name, COUNT(*) ... GROUP BY name` statement is NOT prepared.
- Boot on 10K-org DB → pre-flight + index creation completes in <500ms (perf sanity).

**Acceptance addition**:
- Subsequent boots after index creation do not re-run the duplicate-name scan.
- Spy-based test confirms short-circuit.
```

---

## PATCH 18 — T07 simplification: validatePathParam owns URI-decode

**Supersedes**: V1 §T07 implementation step 4 (lines 392-405).
**Reason**: Per acceptance#14, V1 has both `decodeURIComponent` in dispatcher (T07 try/catch → 400 BAD_PATH) AND `validatePathParam(rawId)` in validators (T04 also wraps try/catch). Duplicate error paths; test cannot distinguish source.

Replace V1 T07 step 4 with:

```markdown
4. Dispatcher passes RAW (still-encoded) path param to handler:
   ```typescript
   const orgMatch = url.match(/^\/api\/admin\/orgs\/([^/]+)$/);
   if (orgMatch && method === "PATCH") {
     await handleUpdateOrg(req, res, ctx, orgMatch[1]);  // raw, not decoded
     return true;
   }
   ```

5. Handler calls `validatePathParam(rawId)` which performs `decodeURIComponent` +
   try/catch → throws `AdminValidationError("BAD_PATH")` on malformed → handler maps to
   400 BAD_PATH via `adminError`.

6. Dispatcher has NO try/catch around path-param handling — single error path lives in
   `src/admin/validate.ts`.
```

**Test cases** (T07 + T04 jointly):
- `PATCH /api/admin/orgs/%41bc` → handler receives `"%41bc"`, decodes to `"Abc"`, processes
  normally.
- `PATCH /api/admin/orgs/o%2` → `validatePathParam` throws BAD_PATH; handler returns 400
  with `body.code === "BAD_PATH"`; assertion confirms error originates from `validate.ts`
  (test runs `vi.spyOn(validateModule, "validatePathParam")` to confirm called).

---

## Summary of changes from V1

| Area | V1 | V2 |
|---|---|---|
| Task count | 16 | 21 (+ T16 as ceremony, not tracked) |
| T01 | 1 task (CSRF + boot guard) | T01a (CSRF) + T01b (boot guard, conditional) |
| T05 | 1 task, 3 handlers, 280 LOC, tests deferred | T05a (GET) + T05b (POST+PATCH), tests in each PR |
| T06 | 1 task, 2 handlers + last-admin, tests deferred | T06a (GET) + T06b (PATCH + last-admin + regression sentinel) |
| T09 | 1 task, 350 LOC (CSS+JS+lint+jsdom) | T09a (CSS) + T09b (JS+jsdom devDep) + T09c (lint:admin task) |
| T15 | 1 task, 300 LOC (3 doc audiences) | T15a (user docs) + T15b (operator runbook) |
| T16 | Tracked task (~50 LOC) | Reclassified as ceremony (CHANGELOG → T15a) |
| ctx.requestId | Open Question #8 | T00 (Phase A task) |
| auth/me | Open Question #1 | T10a (verify-or-add ride-along) |
| updated_at schema | Open Question #3 | REJECTED — defer to v0.11.0; handler omits gracefully |
| jsdom devDep | Open Question #4 | YES — added in T09b |
| Coverage thresholds | "no per-file per V2 Cut#6" | YES for src/admin/* — pre-stubbed in T03 |
| CI lint home | Open Question #7 | T09c (package.json + GH Actions + lint-admin.mjs) |
| admin-session helper | Inside T13 cross-cutting | TH (Phase A) — blocks T05*/T06* tests |
| Acceptance commands | "lint clean" | `npx tsc --noEmit`, `npm run lint:admin`, `npm test`, etc. pinned in preamble |
| vitest threshold pre-stubbing | None | T03 pre-stubs all admin files with TODO comments |
| T11+T12 → T13 edge | Present | Dropped (false edge per dep-graph#1) |
| T13 → T14 edge | Present | Dropped (over-constraint per dep-graph#2) |
| T10 → T14 edge | Absent | Added (missing edge per dep-graph#3) |
| T11 → T05 / T12 → T06 | Present | Dropped (file-level decoupled; mock fixture for unit tests) |
| T13+T14 → T15 | Present | T07 → T15a/T15b (docs unblocked) |
| Concurrent demote test | "concurrent" framing | Reframed as TOCTOU sentinel (sequential) + differential test in T06b |
| CSP header test | String match | Directive map parse + mutation-resistant per-directive assertions |
| ACAO drop test | Single negative | 4-vector matrix (admin / admin?query / non-admin / case-variant / admin-extra) |
| 409 ORG_NAME_TAKEN | T13 happy-path test | T05b column-scope discriminator test |
| RL test recipe | One vague bullet | Concrete fake-timer + bucket-reset + body-leak assertion recipe |
| T03 pre-flight | Always-scan | Short-circuit when index exists + spy test |
| T07 URI-decode | Dispatcher try/catch | Moved into validatePathParam (T04 owns) |
| T14 browser matrix | Unspecified | Chromium-only CI; full matrix local; axe-playwright pinned |
| Critical path | 9 sequential slots | 6 slots |

## Round 2 plan review needed?

**Argument: NO.**

The 12 convergent findings + 13 single-reviewer findings are all mechanical: task splits along clear seams (per-endpoint, per-concern), dependency-edge corrections (4 wrong, 1 missing), acceptance-command bindings (preamble), and 4 open-question resolutions (3 accept, 1 reject). None of the findings questioned the architecture (handler design, audit-event taxonomy, CSP scope, last-admin SQL strategy, frontend file layout, render-state UX). The 4-reviewer pass exhausted the lenses: atomicity, deps, missing-tasks, and acceptance. A Round 2 would likely find:
- Pure style nits (which an implementer surfaces in PR review anyway).
- 1-2 minor edges (which the synthesis already enumerates with conservative defaults).
- Confirmation of the existing patches.

The marginal return on a Round 2 is low; the budget is better spent on implementation. PR-time review will catch any remaining drift since each task PR runs its own acceptance + the cross-cutting lint (T09c) + coverage gate.

If a Round 2 is run anyway, scope it tightly: ONLY re-verify the V2 DAG (no cycles introduced by new tasks T00/T10a/T09c) and ONLY re-verify the test recipes (RL, CSP, ACAO 4-vector, TOCTOU sentinel differential). Skip the architecture pass.

## Next steps

1. ✅ Plan V2 patches doc written (this file).
2. Begin implementation. Slot 1 first (T00, T01a, T01b, T02, T03, T04, TH in parallel — 7 PRs).
3. Use `subagent-driven-development` skill per the plan preamble.
4. Each PR pulls T#'s acceptance into its description.
5. Resolve T01b at PR-open time (grep first; delete task if `BootValidationError` already
   exported from importable path).
6. Resolve T10a at PR-open time (grep first; verification-only commit if `/api/auth/me`
   already exists).
