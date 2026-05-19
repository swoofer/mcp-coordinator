# Plan Round 1 — Synthesis (v0.10.6 admin UI)

**Date**: 2026-05-18
**Reviewers**: 4 (atomicity, dep-graph, missing-tasks, acceptance-tests)
**Verdicts**: NEEDS-RESHAPE / OVER-CONSTRAINED / GAPS-EXIST / NEEDS-TIGHTENING
**Outcome**: V2-patches doc (no rewrite needed; architecture is sound)
**Output**: `docs/superpowers/plans/2026-05-18-admin-ui-plan-V2-patches.md`

## Convergent findings (2+ reviewers — ACCEPT)

| # | Finding | Reviewers | Resolution |
|---|---|---|---|
| C1 | "Lint clean" / "tests pass" / "coverage gate met" are undefined; bind to commands in plan preamble | atomicity (implicit), missing#2, acceptance#1 | PATCH 1 (preamble bindings) |
| C2 | T05/T06 too large + tests deferred → unverifiable in isolation; split per endpoint | atomicity#2-3, acceptance#4 | PATCHES 3, 4 (split T05→T05a/b, T06→T06a/b) |
| C3 | `ctx.requestId` plumbing is a blocking prereq, not an open question — promote to task | atomicity#5, missing#3 | PATCH 2 (new T00) |
| C4 | `vitest.config.ts` per-file thresholds for new admin files have no home + conflict with V2 Cut#6 | missing#1, acceptance#2 | PATCH 6 (pre-stub in T03 / new files) |
| C5 | CI lint script wiring (V3 PATCH 2 / 8 / 15 greps) has no home — currently inline acceptance only | missing#2, acceptance#1, atomicity#6 | PATCH 5 (T09c new task + package.json + CI step) |
| C6 | T09 too large; split CSS / JS / lint-CI | atomicity#6, acceptance#11 | PATCH 5 (T09a/b/c split) |
| C7 | `updated_at` schema decision (V3 PATCH 13) is open-question — must resolve before T05 | atomicity#5, dep-graph#7, missing#4 | PATCH 7 (defer to runtime fresh-row; no schema migration in v0.10.6) |
| C8 | `/api/auth/me` existence — open question that blocks T10's acceptance | atomicity#5, dep-graph#6, missing#5 | PATCH 8 (T-aux T10a: verify-or-add) |
| C9 | T11/T12 false dep on T05/T06 — frontend tests against API contract, can mock | dep-graph#4, atomicity (implicit) | PATCH 9 (loosen deps; frontend uses mock fixture) |
| C10 | T13/T14 dependency edges wrong: T11/T12→T13 (false), T10→T14 (missing), T13→T14 (over-constraint), T13/T14→T15 (over-constraint) | dep-graph#1-3, dep-graph#8, missing#8 | PATCH 10 (DAG corrections) |
| C11 | `admin-session.ts` test helper needs to exist before T05/T06 tests, not T13 | atomicity#2, acceptance#12 | PATCH 4 (lift helper to Phase A as T-helper) |
| C12 | T15 docs split by audience (user vs operator); T16 reclassify as ceremony | atomicity#4, missing#6-7 | PATCH 11 (T15a + T15b; T16 ceremony) |

## Single-reviewer findings (accept / reject / defer with rationale)

### ACCEPT

| # | Reviewer | Finding | Disposition / Patch |
|---|---|---|---|
| S1 | acceptance#3 | Per-IP RL test needs concrete recipe (IP key source, fake timers, reset semantics) | ACCEPT → PATCH 12 (RL test recipe in T13) |
| S2 | acceptance#4 | "2 concurrent demotes" test misnamed under better-sqlite3 single-connection — reframe as TOCTOU sentinel + differential test (planted 3-clause SQL) | ACCEPT → PATCH 13 (rename + add differential sentinel) |
| S3 | acceptance#5 | CSP header test must parse directive map, not string-match | ACCEPT → PATCH 14 (CSP parse map in T08) |
| S4 | acceptance#6 | ACAO drop test needs 4-vector mutation-resistance matrix | ACCEPT → PATCH 14 (ACAO matrix in T08) |
| S5 | acceptance#7 | 409 ORG_NAME_TAKEN must test SQLITE_CONSTRAINT_UNIQUE column-scope discriminator | ACCEPT → PATCH 15 (T05b test addition) |
| S6 | acceptance#8 | `.immediate()` is concurrency property — add static-assertion grep test | ACCEPT → folded into PATCH 5 (lint:admin) |
| S7 | acceptance#10 | Playwright config needs explicit browser matrix + CI inclusion + axe-core devDep pinned | ACCEPT → PATCH 16 (T14 acceptance tightening) |
| S8 | acceptance#11 | jsdom devDep must be added explicitly; resolve Open Q #4 | ACCEPT → PATCH 5 (T09b adds `jsdom` devDep) |
| S9 | dep-graph#5 | T01 → T03 is conditional ("if BootValidationError needs hoist") — split T01 makes this explicit | ACCEPT → PATCH 3 (T01b conditional + drop if already exported) |
| S10 | dep-graph#1 | T11+T12 → T13 false edge | ACCEPT → PATCH 10 |
| S11 | dep-graph#3 | T10 → T14 missing edge | ACCEPT → PATCH 10 |
| S12 | acceptance#13 | T03 pre-flight idempotency under-tested for perf path | ACCEPT → PATCH 17 (T03 acceptance: short-circuit when index exists) |
| S13 | acceptance#14 | T07 URI-decode error path: move decoding into validators, eliminate dispatcher try/catch | ACCEPT → PATCH 18 (T07 simplification; validatePathParam handles) |

### DEFER

| # | Finding | Reason |
|---|---|---|
| D1 | acceptance#9 — T13/T14 last-admin server-side 409 overlap | Acknowledged in PATCH 16: T14 reframes "bypass UI" test to assert UI revert/error-render, drop redundant status assertion |
| D2 | missing#6 — PATCH 17d non-goal in docs | Folded into PATCH 11 (T15b includes "Out of scope" section) |
| D3 | missing#7 — LIMIT 5000 rationale doc | Folded into PATCH 11 (T15b includes "Pagination" section) |

### REJECT

| # | Finding | Reason |
|---|---|---|
| R1 | atomicity Open Q #5 — extract `withAdminScaffold` wrapper | V1 already rejected; only 2 handlers; extract in v0.11.0. V2 keeps duplication for clarity. |
| R2 | Open Q #3 — ship `updated_at` schema + triggers | Rejected per V3 PATCH 13 pattern (response builds fresh row from re-SELECT; if no `updated_at` column, omit gracefully). Avoids migration risk for marginal benefit. |

## Architectural decisions changed by V2 plan

1. **`updated_at` schema NOT shipped** in v0.10.6 (Open Q #3 resolved REJECT). PATCH responses omit `updated_at` field gracefully when column absent. Defers schema work to v0.11.0 if needed.
2. **`admin-session.ts` helper lifted to Phase A** (was implied to be authored in T13). Now blocks T05a/T05b/T06a/T06b tests.
3. **Frontend tests decoupled from backend** (T11/T12 use mock fixtures; e2e at T14 is the only place real backend + real frontend cross paths). Eliminates T05/T06 → T11/T12 false edges.
4. **`vitest.config.ts` thresholds pre-stubbed** in a Phase A task (per v0.10.5 precedent) — eliminates merge conflicts and silent drift.
5. **CI lint as its own task** (T09c) — runs in `prepublishOnly` AND GH Actions, so the 6 grep checks (db.transaction without immediate, inline JS, on*=, innerHTML, insertAdjacentHTML) cannot silently regress.
6. **T16 reclassified as ceremony** (release-please bot PR + npm publish), not a tracked dev task. CHANGELOG augmentation folded into T15a.
7. **T07 simplified** — `decodeURIComponent` moves into `validatePathParam` (T04); dispatcher no longer needs try/catch.
8. **Concurrent-demote test renamed** — V1's "2 concurrent demotes" is impossible under single-connection better-sqlite3; reframed as "TOCTOU sentinel" with explicit sequential + differential (planted-3-clause) tests.

## New task layout (V1: 16 → V2: 21)

```
Phase A — Foundation (parallel)              7 tasks
  T00   ctx.requestId plumbing                   (~30 LOC)   blocks T05*, T06*
  T01a  CSRF_COOKIE_NAME constant                (~50 LOC)
  T01b  BootValidationError hoist (if needed)    (~20 LOC)   conditional; may delete
  T02   TIER1_EVENTS registration                (~40 LOC)
  T03   orgs.name UNIQUE INDEX + boot guard +    (~180 LOC)  pre-stubs vitest thresholds
        pre-stubbed vitest thresholds
  T04   validate.ts + adminError + scaffold      (~280 LOC)  absorbs adminError, validatePathParam
        helpers
  TH    tests/helpers/admin-session.ts           (~80 LOC)   blocks T05a/b, T06a/b tests

Phase B — Backend handlers (mostly parallel) 6 tasks
  T05a  handleListOrgs + tests                   (~130 LOC)
  T05b  handleCreateOrg + handleUpdateOrg + tests(~250 LOC)
  T06a  handleListUsers + tests                  (~130 LOC)
  T06b  handleUpdateUserRole + last-admin guard  (~250 LOC)  ships its own regression sentinel
        + dedicated regression tests
  T07   auth-routes.ts dispatch                  (~90 LOC)
  T08   serve-http.ts ACAO/CSP + 4-vector tests  (~130 LOC)

Phase C — Frontend (parallel)                5 tasks
  T09a  admin.css (theme + responsive + a11y)    (~120 LOC)
  T09b  admin.js + STRINGS + jsdom tests +       (~250 LOC)  adds jsdom devDep
        jsdom devDep
  T09c  lint:admin script + GH Actions step +    (~80 LOC)
        package.json wiring
  T10   admin.html + admin-index.js              (~120 LOC)  deps T09a+T09b+T10a
  T10a  /api/auth/me verify-or-add (ride-along)  (~50 LOC)   pre-req; may be no-op
  T11   admin-orgs.html + admin-orgs.js          (~350 LOC)  uses mock fixture; deps T09a+T09b only
  T12   admin-users.html + admin-users.js        (~350 LOC)  uses mock fixture; deps T09a+T09b only

Phase D — Tests, docs, release               3 tasks (+ ceremony)
  T13   Integration cross-cutting matrix         (~350 LOC)  RL recipe, audit invariants, no
        (RL, audit, TOCTOU sentinel diff test)               per-handler happy-paths (those ship in T05*/T06*)
  T14   Playwright e2e + axe + CI inclusion      (~350 LOC)  pin browser matrix + axe-playwright
  T15a  README + onboarding + CHANGELOG          (~80 LOC)
  T15b  docs/ops/admin-ui.md operator runbook    (~250 LOC)  includes PATCH 17d non-goal + 17f rationale
  T16   release ceremony (release-please bot)    n/a         not a tracked task

TOTAL: 21 tasks (V1 had 16) + T16 as ceremony
TOTAL LOC: ~3500 (V1 ~3000; +~500 for T00, T10a, lint task, helper)
```

## New dependency DAG (V2)

```
T00, T01a, T01b, T02, T04, TH       ← Phase A, all independent
T01b ──→ T03                         (conditional; drop if BootValidationError already exported)
T00 ──→ T05a, T05b, T06a, T06b      (ctx.requestId required)
T04 ──→ T05a, T05b, T06a, T06b      (validators + adminError helper)
T03 ──→ T05b                        (UNIQUE INDEX for 409 ORG_NAME_TAKEN)
T02 ──→ T05b, T06b                  (audit event registration)
T01a ──→ T05*, T06*                 (CSRF_COOKIE_NAME)
TH ──→ T05*, T06*                   (test helper)

T05a, T05b, T06a, T06b ──→ T07      (dispatcher imports handlers)
T07 ──→ T13                         (integration tests need dispatch)

T09a, T09b ──→ T10, T11, T12        (shared CSS + JS)
T09c                                 (parallel-independent; runs in CI)
T10a ──→ T10                        (auth/me ride-along)

T07, T08, T10, T10a, T11, T12 ──→ T14   (e2e needs everything)
                                    NOTE: T13 NOT in T14 deps (per dep-graph#2)

T07 ──→ T15a, T15b                  (API stable enough to document)

T13, T14, T15a, T15b ──→ T16 (ceremony)
```

No cycles. Critical path: T04 → T05b/T06b → T07 → T14 = 4 slots (was 9 in V1).

## Recommended merge sequence (6 slots)

```
Slot 1 (parallel): T00, T01a, T01b, T02, T03, T04, TH       (7 PRs — Phase A)
Slot 2 (parallel): T05a, T05b, T06a, T06b, T08, T09a,       (8 PRs — Phase B+C foundation)
                   T09b, T09c
Slot 3 (parallel): T07, T10a                                (2 PRs)
Slot 4 (parallel): T10, T11, T12, T13, T15a, T15b           (6 PRs)
Slot 5:            T14                                       (1 PR — e2e last)
Slot 6:            T16                                       (release ceremony)
```

## Open questions resolution table

| OQ # | V1 question | V2 resolution |
|---|---|---|
| 1 | `/api/auth/me` exists? | T10a — verify pre-impl; ride-along (~30 LOC) if absent. Cookie is HttpOnly so client-decode is impossible. |
| 2 | `admin-strings.js` as separate file? | KEEP FOLDED into `admin.js` per V3 PATCH 18. |
| 3 | `updated_at` schema + triggers? | REJECTED — defer to v0.11.0. PATCH handlers omit field gracefully when column absent (re-SELECT returns whatever exists). |
| 4 | jsdom unit tests for `admin.js`? | YES — `jsdom` added as devDep in T09b. `// @vitest-environment jsdom` pragma per-test-file. |
| 5 | T05/T06 extract shared `withAdminScaffold`? | REJECTED for v0.10.6 — only 2 handler files; extract in v0.11.0 if 3rd arrives. |
| 6 | T11/T12 parallel atomicity? | CONFIRMED parallel (no shared files; mock fixture for tests). |
| 7 | CI lint admin-only constraints? | YES — T09c new task. `package.json scripts.lint:admin` + GH Actions step + `prepublishOnly` chain. |
| 8 | `ctx.requestId` plumbing? | T00 promoted to Phase A blocking task. |
| 9 | per-file coverage thresholds? | YES for `src/admin/*` — pre-stubbed in T03 with TODO comments; each task fills in. Overrides V2 Cut#6 explicitly. |
| 10 | beta tag vs straight ship? | Straight ship v0.10.6 — admin UI is additive + low-risk. No change from V1. |

## Recommended next step

Proceed to implementation. Begin Slot 1 (Phase A — 7 parallel PRs). All open questions resolved; all blocking gaps converted to tasks. Round 2 plan review is NOT needed — see V2-patches doc's closing section for rationale.
