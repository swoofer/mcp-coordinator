# Round 2 synthesis — Admin UI spec V2

**Date**: 2026-05-18
**Reviews synthesized**: 01-security-concurrency, 02-frontend-a11y, 03-api-codebase
**Total findings**: 26 numbered items (8 security + 10 frontend + 8 api)
**Outcome**: V3 patches doc (`2026-05-18-admin-ui-design-V3-patches.md`) — supersedes specific sections of V2

## What V2 got right

Round 2 confirms V2's architecture is sound:
- 3-file frontend split + day-1 JS extraction closes V1's CSP/inline-JS gap.
- `BEGIN IMMEDIATE` + same-connection `audit()` correctly closes the Mode-A/Mode-B audit-vs-commit windows.
- `authResult.ok` shape, `rateLimiter.check` signature, `appError(code, message, details?)` envelope, `audit({ outcome })` field, route dispatch pattern, playwright fixture reuse — **all confirmed byte-correct** against the codebase.
- `CSRF_COOKIE_NAME` export is additive (no collision).
- `AdminValidationError` class is novel; `ServiceTokenValidationError` is correctly cited as the precedent.
- Staging-save UX (D16) — right pattern for last-admin pre-emptive feedback.
- a11y + responsive + contrast sections actually present (V1 hand-waved them).
- Per-IP RL BEFORE auth caps JWT-grind cost (correct rationale).
- `LIMIT 5000` hard ceiling + no `truncated` flag (simplicity won).

V2 does NOT need a structural rewrite. V3 is mechanical / tightening patches.

## Convergent findings (2+ reviewers)

| # | Theme | Reviewers | Severity | V3 patch |
|---|---|---|---|---|
| C1 | **`db.transaction(fn)()` vs `.immediate()`** — spec snippet uses deferred form while prose mandates IMMEDIATE | sec#4, api#F1 | MAJOR (api calls it CRITICAL) | PATCH 2 |
| C2 | **CSP / ACAO scope ambiguity** — spec's "for HTML responses (admin pages and `index.html`)" reads two ways; admin pages need CSP, index.html must NOT get CSP (would break it), but both should drop ACAO under one consistent rule | sec#5, frontend#1 | MAJOR | PATCH 6 + PATCH 7 |
| C3 | **Last-admin proactive UX vs server invariant** — server SQL guard has a bug (dead OR-clause demotes last-admin-other-user); client banner uses client-derived count that is unsafe past LIMIT 5000 | sec#1, frontend#4 | MAJOR | PATCH 1 + PATCH 14 |

## Single-reviewer findings — accept/reject

### Security + Concurrency (01)

| # | Finding | Decision | Rationale → V3 |
|---|---|---|---|
| sec#1 | Last-admin SQL dead OR-clause | **ACCEPT** | PATCH 1. Genuine bug — would allow last admin demotion of an "other" user. |
| sec#2 | Per-IP RL on GETs DoSes NAT'd admins | **ACCEPT** | PATCH 4. Two-tier: mutations 60/min/IP pre-auth; GETs unlimited (auth+role still gate). |
| sec#3 | `BEGIN IMMEDIATE` walkthrough textbook-TOCTOU wording is loose | **ACCEPT (partial)** | PATCH 5 — add 1-line note on better-sqlite3 serializing same-connection writes; tighten BUSY-mapping. |
| sec#4 | `db.transaction(fn)()` vs `.immediate()` | **ACCEPT** | PATCH 2 (convergent with api#F1). |
| sec#5 | ACAO drop overreaches to index.html | **ACCEPT** | PATCH 6 (convergent with frontend#1) — surgical regex match. |
| sec#6 | `readCsrfToken` throws on un-logged-in load | **ACCEPT** | PATCH 9 — initial GET probe + try/catch + login redirect. |
| sec#7 | UNIQUE INDEX migration aborts on dup names | **ACCEPT** | PATCH 10 — boot guard pre-flight SELECT with named-row error (matches v0.10.5 boot-guard pattern). |
| sec#8 | Validation error messages echoing user input | **ACCEPT** | PATCH 11 — explicit no-echo rule + generic message + `request_id`. |

### Frontend / a11y / UX (02)

| # | Finding | Decision | Rationale → V3 |
|---|---|---|---|
| frontend#1 | CSP scope vs index.html | **ACCEPT** | PATCH 7 (convergent with sec#5). |
| frontend#2 | File-layout contradiction (5 vs 8 files) | **ACCEPT** | PATCH 8 — pin **8 files total** (3 HTML + 4 JS + 1 CSS). |
| frontend#3 | Stale-state UX after concurrent edits | **ACCEPT** | PATCH 13 — server returns fresh row in PATCH response; client `replaceChildren()` from response (no ETag added). |
| frontend#4 | Last-admin banner client-truth past LIMIT 5000 | **ACCEPT** | PATCH 14 — server `meta.admin_count` in `/api/admin/users` response; disabled `<option>` proactively. |
| frontend#5 | renderTable thin spec | **ACCEPT** | PATCH 15 — concrete `makeRoleCell` example + ban `insertAdjacentHTML`. |
| frontend#6 | `request_id` in error toast | **ACCEPT** | PATCH 16 — add to envelope + render in toast. |
| frontend#7 | Responsive lower bound + zoom undefined | **DEFER to implementation** | Spec already lists ≤768px breakpoint; 320px / 200% zoom additions are CSS-detail, captured in PATCH 17 as a one-paragraph addition. |
| frontend#8 | Skeleton location + slow-fetch timeout | **DEFER to implementation** | Implementation detail; spec only needs the one-line "pre-rendered skeleton + 10s AbortController" rule → folded into PATCH 17. |
| frontend#9 | Empty state for missing org / zero orgs | **DEFER to implementation** | Copy-tweak — folded into PATCH 17. |
| frontend#10 | Centralize STRINGS table for future i18n | **ACCEPT** | PATCH 18 — small but huge future-leverage; trivial today. |

### API + codebase integration (03)

| # | Finding | Decision | Rationale → V3 |
|---|---|---|---|
| api#F1 | `BEGIN IMMEDIATE` snippet uses deferred form | **ACCEPT** | PATCH 2 (convergent with sec#4). |
| api#F2 | New audit events missing from `TIER1_EVENTS` | **ACCEPT** | PATCH 3 — explicit file + literal additions. Verified against `src/security/audit-events.ts:14-36`. |
| api#F3 | `LIMIT 5000` has no codebase precedent (sweeper uses 1000) | **REJECT** | The 5000 figure is intentional product call (50× sweeper, hard ceiling for human-user list). V2 §Risks accepted already documents trade. Adding one explanatory sentence — folded into PATCH 17. |
| api#F4 | `role IN ('admin','member')` SQL/prose inconsistency | **ACCEPT** | PATCH 12 — pick one consistent set; SQL filter excludes agent/service, handler explicit re-SELECT distinguishes 409 NOT_HUMAN_USER. |
| api#F5 | `idp_provider` / `idp_org_id` columns not exposed | **ACCEPT (doc-only)** | Folded into PATCH 17 — one sentence in §Non-goals. |
| api#F6 | `KNOWN_AUTH_PATHS.has(url)` + parameterized 404-not-405 | **ACCEPT (doc-only)** | Folded into PATCH 17 — matches existing service-tokens precedent. |
| api#F7 | Empty-string vs `null` for allowlist clear | **ACCEPT** | Folded into PATCH 11 — explicit row in validation table. |
| api#F8 | Dispatcher `return true;` wrapping | **REJECT** | Already in §Route wiring as understood; trivial implementation detail. |

## Architectural decisions changed by R2

1. **Per-IP rate limit**: single bucket all `/api/admin/*` → **two-tier** (mutations only pre-auth; GETs unlimited).
2. **Last-admin SQL guard**: 3 OR-clauses → **2 clauses** (drop the dead `? <> id` clause that re-opens lockout for demote-other-last-admin).
3. **CSP/ACAO scoping**: implicit ("for HTML responses") → **explicit URL regex match** for admin pages only.
4. **PATCH response shape**: returns row → returns **fresh row** + client `replaceChildren()` to handle stale-state concurrent edits.
5. **`GET /api/admin/users` envelope**: `{ users: [...] }` → `{ users: [...], meta: { admin_count: N } }` for authoritative banner truth.
6. **`db.transaction()` invocation**: `.transaction(fn)()` (deferred) → `.transaction(fn).immediate()` (mandatory).
7. **Frontend file count**: 5 (admin.html + admin-orgs.html + admin-users.html + admin.js + admin.css) → **8** (add admin-index.js, admin-orgs.js, admin-users.js as per-page bootstraps).
8. **`__Host-coordinator_csrf` cookie miss handling**: `throw` → **redirect to /auth/login**.
9. **UNIQUE INDEX migration**: silent abort → **pre-flight boot guard** with named-row error (v0.10.5 pattern).
10. **`TIER1_EVENTS`**: assumed-registered → **explicit task** to extend `src/security/audit-events.ts:14-36`.
11. **Strings**: scattered → centralized `STRINGS` table in `admin.js`.
12. **Validation messages**: no rule → **MUST NOT echo input**; include `request_id`.

## Round 3 needed?

**NO.**

Reasoning:
- V2's architecture survives R2 unchanged. All 26 findings are mechanical / scope-tightening / UX-precision — none are architectural.
- V3 patches are localized (12-18 patches, ~400-500 lines), well-bounded, and each one is a textual delta against an enumerated V2 section.
- The reviewers themselves recommended ACCEPT / APPROVE-WITH-NITS / MINOR-CONCERNS — none flagged "another design round needed".
- Remaining risk lives at the implementation-plan layer (file ordering, LOC budgets, task atomicity) — caught by plan review.
- Skipping R3 saves ~2-3 hours and ~200k tokens; matches the v0.10.5 cadence (which also stopped at R2 → V3 patches → plan).

If plan review surfaces architectural concerns from V3, revisit. Otherwise: plan → implement.

## What changed vs Round 1

| Round 1 (V1 → V2) | Round 2 (V2 → V3) |
|---|---|
| Architectural rewrite — 6 reviewers, 75 findings, unanimous NEEDS-REWORK | Mechanical/scope patches — 3 reviewers, 26 findings, ACCEPT / MINOR-CONCERNS / APPROVE-WITH-NITS |
| Many new sections (CSP scope, audit metadata flat-scalar, BEGIN IMMEDIATE, staging-save UX, a11y/responsive) | Section-targeted edits (SQL clause delete, regex pin, file-count pin, request_id plumbing) |
| V2 grew to ~440 lines | V3 patches doc: ~500-600 lines, supersedes specific V2 sections |

## Path forward

1. Write `2026-05-18-admin-ui-design-V3-patches.md` (this round).
2. Update task list: spec done → implementation plan.
3. Implementation plan (`docs/superpowers/plans/2026-05-18-admin-ui-plan.md`) — atomic tasks with file paths, LOC, dependencies, acceptance.
4. Round 1 plan review (atomicity / dependency graph / missing tasks / over-engineered tasks).
5. Apply plan patches.
6. Implement.
