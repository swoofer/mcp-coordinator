# Plan Round 1 — Task atomicity (v0.10.6)

**Verdict**: NEEDS-RESHAPE

The plan is overall well-decomposed (16 tasks, mostly in the 80-350 LOC sweet spot), with a clear DAG and good cohesion per task. However, several tasks bundle mixed concerns, one is borderline-too-large, two are too small to justify their own PR, and one critical pre-req (`ctx.requestId` plumbing — Open question #8) is currently dangling rather than scheduled as its own task. The reshape recommendations below total 6 changes; net task count moves from 16 to ~17.

## Recommended changes

### 1. SPLIT: T01 (CSRF constant + BootValidationError hoist)

**Current**: T01 bundles two unrelated changes: (a) export a `CSRF_COOKIE_NAME` constant and replace 5 literal call-sites in `src/auth/*`, and (b) "if needed, hoist `BootValidationError` to `src/errors.ts`" (conditional ~10 LOC delta).

**Issue**: Mixed concerns. (a) is a pure refactor in `src/auth/`. (b) is a conditional refactor in `src/errors.ts` / `src/security/encryption.ts` driven entirely by T03's needs. They touch different subsystems, have different reviewers, and a reviewer of (a) shouldn't need to load context about boot-time error taxonomy. The conditional "if not already exported, hoist" phrasing also makes the PR scope unknowable until implementation starts.

**Recommendation**: Split into T01a (CSRF constant + literal replacements, ~50 LOC, depends on nothing) and T01b (`BootValidationError` export/hoist, ~20 LOC, depends on nothing, prerequisite of T03). Resolve the "if needed" up-front during planning by grepping once for the current export status; if already exported, drop T01b entirely.

**New layout**: T01a → CSRF constant. T01b → BootValidationError hoist (or deleted). T03 depends on T01b only (not T01a).

---

### 2. SPLIT: T05 (handle-admin-orgs.ts bundles GET + POST + PATCH + adminError helper)

**Current**: T05 implements three endpoints (GET list, POST create, PATCH update) plus the `adminError` helper plus the common scaffold (auth/role/RL/CSRF/body-parse) in a single ~280 LOC PR. Tests are explicitly deferred to T13.

**Issue**: 280 LOC at the high end of the target range, three behaviorally-distinct endpoints, and a shared helper (`adminError`) that T06 also depends on. Reviewing PATCH-with-409-ORG_NAME_TAKEN-on-UNIQUE-violation requires a different mental model than reviewing GET-list-with-LIMIT-5000. The PR also has no tests of its own (deferred to T13), meaning T05 is unverifiable in isolation — it violates "testable in isolation." A reviewer cannot confirm the handlers behave correctly without waiting for T13.

**Recommendation**: Split into T05a (GET list, ~80 LOC + tests) and T05b (POST + PATCH mutations, ~200 LOC + tests). Move the `adminError` helper + common scaffold extraction to T04 (the validators task) since both T05a/b and T06 depend on it. Add tests to each handler PR (don't defer all to T13) — keep T13 as the cross-cutting integration matrix (RL across endpoints, audit retention, e2e flows) but each handler PR carries its own focused happy-path + error-path tests.

**New layout**: T04 grows to include `adminError(ctx, code, ...)` helper + scaffold helpers (~+50 LOC). T05a = GET list + tests. T05b = POST + PATCH + tests. Same split rationale applies to T06.

---

### 3. SPLIT: T06 (handle-admin-users.ts GET + PATCH + last-admin SQL bundles)

**Current**: Same shape as T05 — GET list (with `?org=` filter + admin_count meta) plus PATCH role-change (with the load-bearing 2-clause last-admin SQL guard + SQLITE_BUSY → 503 handling + 4-case re-SELECT distinguisher). ~280 LOC, tests deferred to T13.

**Issue**: PATCH role-change is the highest-risk handler in the entire plan (V3 PATCH 1 explicitly calls out the 3-clause dead-code regression; the test in T13 line 750 is a "regression sentinel"). Bundling it with the much-simpler GET list buries the riskiest review under boilerplate. Also unverifiable in isolation (tests in T13).

**Recommendation**: Split into T06a (GET list with admin_count + truncated + `?org=` filter, ~80 LOC + tests) and T06b (PATCH role-change with last-admin SQL + 4-case denial logic + SQLITE_BUSY handling, ~200 LOC + tests including the V3 PATCH 1 regression sentinel). T06b should carry its own dedicated last-admin test file so the regression sentinel ships with the code that introduces the guard, not separately in T13.

**New layout**: T06a = list handler + tests. T06b = role-change handler + last-admin guard + dedicated regression tests. T13 keeps the cross-cutting matrix (concurrency, RL scope, audit assertions).

---

### 4. MERGE + RE-SCOPE: T15 (docs) + T16 (release)

**Current**: T15 = README + onboarding + new `docs/ops/admin-ui.md` runbook (~300 LOC). T16 = release-please bump + CHANGELOG augmentation + version bump + npm publish (~50 LOC, mostly config/auto-generated).

**Issue**: T16 at ~50 LOC is too small to justify a standalone PR — it's a release-please bot PR with a manual CHANGELOG touch-up; not a unit of code review. Conversely T15 is bundling three audiences (end-user README, self-host operator onboarding doc, ops runbook) into one PR; the runbook (`docs/ops/admin-ui.md`) is the largest new artifact and the only fully-new file. Mixed audiences = mixed reviewers and divergent acceptance criteria ("does this read well for an operator?" vs "does this match the README's feature-list style?").

**Recommendation**: Split T15 into T15a (README + onboarding-self-host updates — user-facing copy, ~80 LOC) and T15b (new `docs/ops/admin-ui.md` operator runbook including lockout-recovery SQL — operator-facing reference, ~220 LOC). Fold T16's manual CHANGELOG augmentation into T15a (release-please will pick it up); leave T16 as a non-PR release ceremony step (bot PR + npm publish), not a tracked dev task.

**New layout**: T15a = user docs + CHANGELOG line. T15b = operator runbook. T16 → released as ceremony, removed from atomic-task list.

---

### 5. ADD: T00 — `ctx.requestId` plumbing on `AuthHandlerContext` (resolve Open question #8)

**Current**: Open question #8 flags that V3 PATCH 16 requires `ctx.requestId`, but plumbing is currently "verify against `src/auth/context.ts` before T05. If absent, T05 (or a sub-task) adds it (~10 LOC)." Similarly Open question #1 (`/api/auth/me`) and #3 (`updated_at` columns) carry conditional work that hasn't been scheduled.

**Issue**: Hidden dependency. T05/T06/all handlers and the entire validator-error contract (V3 PATCH 11) assume `ctx.requestId` exists. If it doesn't, the work is silently absorbed into T05 (already too large) or T04 (out of scope). This pattern — "we'll find out during implementation" — produces PRs that grow mid-review or introduce surprise infrastructure changes.

**Recommendation**: Resolve open questions #1, #3, #8 during plan-review (grep the codebase now). For each that requires net-new code, schedule an explicit Phase A task. Specifically: T00 = `ctx.requestId` exists/added (~20 LOC, depends on nothing, blocker for all handlers). If `/api/auth/me` is missing, add T10b (~30 LOC ride-along). If `updated_at` columns are wanted, fold ~50 LOC into T03 explicitly (don't leave as "open question").

**New layout**: T00 added to Phase A as a 4th independent foundation task. Open question #1 resolved either way (ride-along or client-side JWT decode confirmed impossible due to HttpOnly). Open question #3 resolved (in or out — no "defer trigger if too invasive" hedge).

---

### 6. SPLIT: T09 (admin.css + admin.js + STRINGS + lint scripts + jsdom test setup)

**Current**: T09 = ~350 LOC bundling (a) admin.css full theme + responsive breakpoints + AA-contrast palette, (b) admin.js with 8 distinct helpers (`t`, `STRINGS`, `fetchJson`, `fetchWithTimeout`, `renderTable`, `showToast`, `readCsrfToken`, `redirectToLogin`), (c) `STRINGS` i18n table per V3 PATCH 18, (d) 4 grep-based CI lint scripts wired into package.json, (e) jsdom test runner setup + ~50 LOC unit tests.

**Issue**: Largest task in the plan, three distinct concerns (visual theme / JS runtime helpers / CI lint infrastructure), and contains setup work (jsdom config — Open question #4) whose scope is itself uncertain. The CSS is independently reviewable by someone who doesn't care about JS module conventions; the lint scripts are CI-infrastructure that should be greppable as a single commit. Bundling jsdom setup with helper implementation also conflates "do we add a test runner" with "do these helpers work" — Open question #4 suggests the runner may not even be wanted.

**Recommendation**: Split into T09a (admin.css — theme + responsive + a11y, ~120 LOC, no JS), T09b (admin.js shared helpers + STRINGS + jsdom unit tests, ~200 LOC; resolves Open question #4 in this PR), and T09c (CI lint scripts: inline-JS / on*-attr / innerHTML / insertAdjacentHTML grep + package.json wiring + GHA step, ~50 LOC). T09c can land first as it's pure CI infra and starts catching violations even before T10-T12 land.

**New layout**: T09a (CSS only) → T09b (JS shared module + tests) → T09c (lint enforcement). T10/T11/T12 depend on T09a + T09b. T09c is parallel-independent.

---

## Summary table

| Original | Action | New tasks | Net delta |
|---|---|---|---|
| T01 | split | T01a, T01b | +1 |
| T05 | split + push helper to T04 | T05a, T05b | +1 |
| T06 | split | T06a, T06b | +1 |
| T09 | split 3-way | T09a, T09b, T09c | +2 |
| T15 | split + absorb T16 changelog | T15a, T15b | +1 |
| T16 | reclassify as ceremony | (removed from task list) | -1 |
| new | add | T00 (ctx.requestId) | +1 |
| **Total** | | 16 → 22 tasks | +6 |

Tasks T02, T03, T04, T07, T08, T10, T11, T12, T13, T14 are right-sized as-is (with the caveat that T04 absorbs the `adminError` helper, growing from ~200 to ~250 LOC — still in-range).
