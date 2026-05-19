# Plan Round 1 — Missing tasks (v0.10.6)

**Verdict**: GAPS-EXIST
**Items checked**: 18 V3 patches + 14 V2 spec sections + 7 cross-cutting concerns = 39
**Missing**: 8 (3 BLOCKING, 5 NICE-TO-HAVE)
**Redundant**: 0

V2's architecture is fully task-mapped. Three convergent gaps: (a) `vitest.config.ts` per-file threshold entries for new admin files are not authored by any task (precedent at `vitest.config.ts:38` for `handle-service-tokens.ts` is 100% — the plan silently abandons that bar via T05/T06 acceptance "no per-file 100% threshold per V2 Cut#6"); (b) CI wiring for the V3 PATCH 2 / 8 / 15 grep lints (`db.transaction(...)()`, inline JS, `innerHTML = template`, `insertAdjacentHTML`) has no home task — `package.json` is mentioned in T09 but lint script + GitHub Actions step is only flagged as Open Question #7; (c) the `ctx.requestId` plumbing prerequisite for V3 PATCH 16 is open question #8, not a task.

## Coverage matrix

### V3 patches → tasks

| Ref | Task(s) | Status |
|---|---|---|
| PATCH 1 (last-admin SQL — drop dead OR-clause, 2 clauses) | T06 (impl) + T13 (dead-clause repro test cited verbatim) | COVERED |
| PATCH 2 (`.immediate()` mandatory) | T05 + T06 acceptance criteria explicitly assert "no `db.transaction(fn)()`"; T13 implicitly | PARTIAL — CI grep lint (`grep -nE 'db\.transaction\([^)]*\)\(\)' src/admin/`) per PATCH 2 has NO home task |
| PATCH 3 (TIER1_EVENTS registration) | T02 (dedicated) | COVERED |
| PATCH 4 (RL mutations only, GETs unlimited) | T05 + T06 scaffold + T13 RL tests (GETs no-429, 61st POST→429) | COVERED |
| PATCH 5 (BEGIN IMMEDIATE prose + SQLITE_BUSY→503) | T06 (try/catch SQLITE_BUSY, 503 + Retry-After) | COVERED |
| PATCH 6 (ACAO scope, admin pages only) | T08 | COVERED |
| PATCH 7 (CSP scope, pinned regex, admin pages only) | T08 | COVERED |
| PATCH 8 (8 files pin) | T08-T12 (3 HTML + 4 JS + 1 CSS distributed correctly across T09/T10/T11/T12) | COVERED |
| PATCH 9 (readCsrfToken defensive + login redirect) | T09 (`readCsrfToken` returns null) + T14 (incognito redirect e2e) | COVERED |
| PATCH 10 (UNIQUE INDEX pre-flight boot guard) | T03 (dedicated, verbatim SQL) | COVERED |
| PATCH 11 (no-echo validation + empty-string + request_id) | T04 (AdminValidationError code-only) + T13 (no-echo assertion) | COVERED |
| PATCH 12 (`role IN ('admin','member')` consistency) | T06 (handler + 4-case re-SELECT) + T13 (agent/service excluded test) | COVERED |
| PATCH 13 (stale-state UX, fresh row, `replaceChildren`) | T05/T06 (server fresh-row) + T11/T12 (client `row.replaceWith`) + T14 (concurrent-rename e2e) | PARTIAL — `updated_at` schema + triggers is OPEN QUESTION #3 not a task; deferred fallback is a code smell |
| PATCH 14 (`meta.admin_count` server-truth + `truncated`) | T06 (server) + T12 (banner + disabled option) + T13 (admin_count test) + T14 (e2e disabled option) | COVERED |
| PATCH 15 (`renderTable` concrete + ban `insertAdjacentHTML`) | T09 (`renderTable` impl with Node accessor) | PARTIAL — 3-grep CI lint defined verbatim inline at T09 but no `package.json` script / CI step task |
| PATCH 16 (`request_id` in error envelope + toast) | T05/T06 (`adminError(ctx,...)` helper) + T09 (`showToast` with copy button) | PARTIAL — `ctx.requestId` on `AuthHandlerContext` is OPEN QUESTION #8, not a task; T05 cannot start until verified |
| PATCH 17a (320px / 200% zoom / axe rules) | T09 (CSS) + T14 (axe + responsive) | COVERED |
| PATCH 17b (skeleton in HTML + 10s AbortController) | T09 (`fetchWithTimeout`) + T11/T12 (skeleton `<tr>`) | COVERED |
| PATCH 17c (empty-state copy + zero-orgs banner) | T11 + T12 | COVERED |
| PATCH 17d (`idp_provider`/`idp_org_id` non-goal) | T15 docs implicit | NICE-TO-HAVE GAP — no explicit task asserts Non-goal entry exists in any code/doc surface |
| PATCH 17e (parameterized 404-not-405) | T07 (test "DELETE /api/admin/orgs/abc → 404") | COVERED |
| PATCH 17f (`LIMIT 5000` rationale) | doc-only | GAP — no task captures the rationale sentence (T15 doesn't list it) |
| PATCH 18 (STRINGS table + `t()`) | T09 | COVERED |

### V2 spec sections → tasks

| Section | Task | Status |
|---|---|---|
| §Endpoints 1-5 | T05, T06 | COVERED |
| §Validation rules | T04 | COVERED |
| §Auth + CSRF | T05, T06 scaffold | COVERED |
| §Static file serving + headers | T08 | COVERED |
| §Audit events | T02 + T05 + T06 | COVERED |
| §Transaction model | T05 + T06 | COVERED |
| §Frontend (8 files) | T09-T12 | COVERED |
| §Render states (Loading/Empty/Error) | T11, T12 | COVERED |
| §Last-admin UX | T12 | COVERED |
| §Accessibility | T09 (CSS) + T11/T12 (markup) + T14 (axe) | COVERED |
| §Responsive / Color contrast / Confirmations | T09 + T11/T12 | COVERED |
| §Timestamps | T11 (Date render) | COVERED |
| §Route wiring | T07 | COVERED |
| §Schema | T03 | COVERED |
| §Testing | T13 + T14 | COVERED |
| §Observability | n/a (V2 explicit no new metrics) | COVERED |
| §Threat model | implicit | COVERED |

---

## Missing items

### 1. `vitest.config.ts` per-file coverage thresholds for new admin files — BLOCKING

**Spec ref**: `vitest.config.ts:20-82` (existing pattern: every security-critical file under `src/auth/`, `src/admin/handle-service-tokens.ts:38`, `src/security/*` has a 100/100/100/100 entry). V2 Cut#6 says "no per-file 100% coverage thresholds" — but the repo's actual practice plus the precedent at `vitest.config.ts:38` says otherwise for `src/admin/*` and security-critical paths. Plan Open Question #9 surfaces this but does not resolve it; T05/T06 acceptance says "no per-file 100% threshold per V2 Cut#6" — directly contradicts the repo's actual gate.

**Files un-thresholded by plan**: `src/admin/handle-admin-orgs.ts`, `src/admin/handle-admin-users.ts`, `src/admin/validate.ts`, `src/auth/csrf.ts` (modified by T01 — already 100%), `src/security/audit-events.ts` (modified by T02 — already 100%), `src/database.ts` migration block addition (T03 — `database.ts` is currently NOT thresholded; check if T03 brings it in scope).

**Recommendation**: Add explicit sub-task to T05/T06/T04: "Append `src/admin/handle-admin-orgs.ts`, `src/admin/handle-admin-users.ts`, `src/admin/validate.ts` to `vitest.config.ts:20-82` thresholds block at 100/100/100/100 (matches `handle-service-tokens.ts:38` precedent)." OR resolve Open Question #9 explicitly in a plan-review patch with reviewer sign-off that V2 Cut#6 overrides the repo precedent. Current plan ambiguity will break CI when implementer follows the precedent OR will silently regress security-critical coverage when implementer follows V2 Cut#6.

### 2. CI lint script wiring for V3 PATCH 2 / 8 / 15 grep checks — BLOCKING

**Spec ref**: V3 PATCH 2 (`grep -nE 'db\.transaction\([^)]*\)\(\)' src/admin/ && exit 1 || true`), PATCH 8 (`grep -nE '<script[^>]*>[^<]' dashboard/public/admin*.html` + `grep -nEi '\son[a-z]+\s*=' dashboard/public/admin*.html`), PATCH 15 (3 greps for `innerHTML`/`insertAdjacentHTML`). Plan mentions these inline at T05/T09 acceptance and Open Question #7 ("`lint:admin` script + GitHub Actions step") but no task adds the `package.json` script or the CI step. Implementer who follows acceptance reads "grep passes" and runs greps once manually — first regression after merge bypasses the check.

**Recommendation**: New sub-task in T09 (frontend lints) and T05 (backend lint) OR a single new T08.5 / T13.5: "Add `scripts.lint:admin` to `package.json` with all 6 grep commands; wire into existing CI pipeline alongside the `lint` job (verify against `.github/workflows/`)." ~30 LOC. Acceptance: the lint script fails on a planted violation in each of the 6 categories.

### 3. `ctx.requestId` plumbing prerequisite for V3 PATCH 16 — BLOCKING

**Spec ref**: V3 PATCH 16 ("If the field doesn't exist on the context type, add it (one-line type addition)"). Plan Open Question #8 says "Verify against `src/auth/context.ts` before T05. If absent, T05 (or a sub-task) adds it (~10 LOC)." This is a hard prerequisite for T05 + T06 + T13 + T16 — none of those can start before it's resolved. Currently buried in open-questions section, not in dependency DAG.

**Recommendation**: New T00 / T03.5 (parallel to T01-T03): "Verify `AuthHandlerContext.requestId` exists in `src/auth/context.ts` (or wherever the type lives). If absent, add it + pipe from dispatcher's async-context (`withAuditContext`). Acceptance: type definition exports `requestId: string`, dispatcher populates it for all routes, existing tests pass." Promote from Open Question to task with size ~20 LOC, dependencies none, blocks T05/T06.

### 4. `updated_at` schema + triggers for V3 PATCH 13 — NICE-TO-HAVE (currently DEFERRED)

**Spec ref**: V3 PATCH 13 (schema addition: `ALTER TABLE orgs/users ADD COLUMN updated_at` + `CREATE TRIGGER orgs/users_updated_at`). Plan Open Question #3 captures this as a recommendation to fold into T03. Currently no task implements it; T05/T06 fall back to "`new Date().toISOString()` at response time" — which means PATCH responses lie about the actual row update time (server clock at response-build moment, not commit moment).

**Recommendation**: Promote to a discrete task or fold into T03 explicitly. If folded: add ~50 LOC to T03 with `ALTER TABLE` + `CREATE TRIGGER` SQL + test "PATCH response `updated_at` matches DB row `updated_at` ± 1s." If deferred to v0.11.0: remove the `updated_at` mentions from T05/T06 acceptance to avoid implementer confusion.

### 5. `/api/auth/me` endpoint existence verification for T10 — NICE-TO-HAVE

**Spec ref**: Plan Open Question #1. T10 `admin-index.js` calls `fetch("/api/auth/me")` to populate the admin email banner. If endpoint doesn't exist, T10 needs a ride-along (~30 LOC) to add it. The cookie is HttpOnly → client can't decode JWT → ride-along is mandatory not optional.

**Recommendation**: Either (a) verify the endpoint exists pre-plan-merge and remove Open Question #1, OR (b) carve a sub-task T10a: "Add `GET /api/auth/me` returning `{ email, sub, role }` from authenticated claims if not already present. ~30 LOC + 5 unit tests."

### 6. PATCH 17d (`idp_provider` non-goal documentation surface) — NICE-TO-HAVE

**Spec ref**: V3 PATCH 17d ("`§Non-goals`: Editing `orgs.idp_provider` / `orgs.idp_org_id` via the admin UI"). Plan T15 (docs) doesn't enumerate this explicit non-goal in any doc file. Reader of `docs/ops/admin-ui.md` (the new runbook) has no signal that these columns are intentionally hidden — first operator who SQL-queries `orgs` and asks "why no UI for `idp_provider`?" gets no answer.

**Recommendation**: Add to T15 deliverable list for `docs/ops/admin-ui.md`: "Section 'Out of scope' explicitly lists `orgs.idp_provider` / `orgs.idp_org_id` (defer to v0.11.0)."

### 7. PATCH 17f (`LIMIT 5000` rationale) — NICE-TO-HAVE

**Spec ref**: V3 PATCH 17f ("50× sweeper batch; pathological if hit; use `?org=` to narrow"). No task captures this. T15 runbook would be the natural home; currently not listed.

**Recommendation**: Add to T15 `docs/ops/admin-ui.md` deliverables: "Section 'Pagination' explains the 5000 ceiling + when it triggers + `meta.truncated` signal + `?org=` narrowing workflow."

### 8. CI test inclusion for new e2e + integration files — NICE-TO-HAVE

**Spec ref**: `vitest.config.ts:5` (`include: ["tests/**/*.test.ts"]`) auto-picks up `tests/integration/handle-admin-*.test.ts` and `tests/unit/*.test.ts` — good. But `tests/e2e/admin-ui.spec.ts` is a Playwright `.spec.ts` file, NOT a vitest `.test.ts` — runs via `playwright.config.ts`, separate runner. T14 references "playwright.config.ts exists" but doesn't verify the new spec file is auto-discovered (or if a glob update is needed) and doesn't add a CI job invocation if e2e isn't already in CI.

**Recommendation**: Add to T14 acceptance: "(a) Verify `playwright.config.ts` `testDir` / `testMatch` includes `tests/e2e/admin-ui.spec.ts`; (b) confirm `.github/workflows/` has a Playwright job OR add one; (c) the new spec runs in CI on every PR." ~10 LOC config delta + workflow yaml if absent.

---

## Cross-cutting checks

| Check | Status |
|---|---|
| Release task with proper commit strategy | COVERED (T16 — release-please flow, CHANGELOG manual augmentation enumerated) |
| Docs task for runbook | COVERED (T15 — `docs/ops/admin-ui.md` NEW + README + onboarding-self-host updates) |
| Test helper scaffold (`adminFetchClient`) | COVERED (T13 §Test infrastructure section) |
| Dependency DAG completeness | INCOMPLETE — missing edges for: T00/T03.5 (requestId) → T05/T06; T03 (if updated_at folded) → T05/T06; CI-lint task → T16 |
| Per-PR atomicity | COVERED (16 tasks across 14-16 PRs, sized per V3 patches) |
| LOC budget realism | COVERED (~3000 LOC total, Phase B/C heavy as expected) |
| Open questions blocking implementation | PARTIAL — #1 (auth/me), #3 (updated_at), #8 (requestId), #9 (coverage threshold) all need pre-implementation resolution; plan flags but doesn't gate them |

---

## Priority summary

**Promote to tasks before implementation starts** (BLOCKING):
1. `vitest.config.ts` thresholds for new admin files (Missing #1)
2. CI lint script wiring (Missing #2)
3. `ctx.requestId` plumbing verification (Missing #3)

**Fold into existing tasks** (NICE-TO-HAVE):
4. `updated_at` schema → resolve in T03 patch (Missing #4)
5. `/api/auth/me` ride-along → resolve in T10 patch (Missing #5)
6. PATCH 17d/17f doc surface → add to T15 deliverables (Missing #6, #7)
7. Playwright CI inclusion → add to T14 acceptance (Missing #8)

No redundant tasks. No tasks need merging or splitting from a coverage standpoint (T05/T06 size is per-handler-file = appropriate atomicity; T11/T12 size is per-page-file = appropriate atomicity).
