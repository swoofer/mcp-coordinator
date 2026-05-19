# Round 2 — API design + codebase integration review (V2 admin UI spec)

**Reviewer lens**: API surface fidelity + codebase integration. Focused on what changed in V2 (post Round 1 synthesis).
**Spec**: `docs/superpowers/specs/2026-05-18-admin-ui-design.md` (V2)
**Verdict**: ACCEPT with NITS. All previously-flagged Round 1 critical API mismatches are correctly resolved in V2. Three new sub-issues worth tightening before implementation; one factual claim in the spec needs a small correction.

---

## Verified-correct in V2

| Claim | Status | Evidence |
|---|---|---|
| `authResult.ok` + `.status` + `.wwwAuthenticate` shape | CORRECT | `src/auth.ts:206-208` defines `AuthResult` as discriminated union with exactly those fields; V2 spec block at lines 167-181 is byte-identical to `src/admin/handle-service-tokens.ts:56-66`. |
| `rateLimiter.check(key, { per, window_seconds })` signature | CORRECT | `src/auth/rate-limit.ts:38` matches; V2 snippet at spec lines 208-219 uses `retry_after_seconds` (snake_case) correctly. |
| `appError(code, message, details?)` exists | CORRECT | `src/http/response-contract.ts:67-79`. V2 uses it throughout via inline `res.writeHead + res.end(JSON.stringify(appError(...)))`. |
| `audit()` accepts `outcome` field | CORRECT | `src/security/audit.ts:77` — `outcome?: "success" \| "failure" \| "denied"`. V2's `outcome: "denied"` path on last-admin refusal works. |
| `playwright.config.ts` + `tests/e2e/` scaffolding exists | CORRECT | `playwright.config.ts` at repo root; `tests/e2e/` has 3 existing specs (`browser-oauth.spec.ts`, `cli-device-flow.spec.ts`, `refresh-on-401.spec.ts`) + `tests/e2e/helpers/coordinator-fixture.ts`. New `admin-ui.spec.ts` can copy that fixture pattern; we are NOT starting from scratch. |
| Route dispatch pattern (literal + regex with `decodeURIComponent` wrapped) | CORRECT | `src/http/auth-routes.ts:114-121` is exactly the precedent V2 cites for `/api/admin/{orgs,users}/:id` PATCH. |
| Audit names are purely string-typed (no compile-time enum) | CORRECT | `audit(action: string, options)` — `src/security/audit.ts:91` — no enum gate. But see Finding 4 below for retention impact. |
| `CSRF_COOKIE_NAME` does not already exist as an exported constant | CORRECT | Grep confirms it lives as a local module-level constant in 3 files (`oauth-finalize.ts:24`, `logout.ts`, `device-flow.ts`) — never exported. Adding it as an export in `src/auth/csrf.ts` is purely additive, no collision. |
| `AdminValidationError` class is novel | CORRECT | No `*ValidationError` in the validate sense exists in `src`. `ServiceTokenValidationError` (`src/auth/service-tokens.ts:46`) is the precedent V2 explicitly mirrors. No existing `src/admin/validate.ts`. |

---

## Findings

### F1 — Spec's `BEGIN IMMEDIATE` snippet is broken: `audit()` re-acquires IMMEDIATE inside an already-open transaction — DEADLOCK / NESTED-TX risk — CRITICAL

**Spec location**: lines 250-263 + "Transaction model (D11)".

**Problem**: The Tier 1 `audit()` path calls `insertAuditRowWithChain` (`src/security/audit.ts:127-177`), which performs a SELECT (chain tip) + INSERT. The function header comment at `audit.ts:119-122` says "Wrapped in IMMEDIATE so a concurrent inserter cannot insert between our SELECT and INSERT" — but reading the code, `insertAuditRowWithChain` does **not** itself open a transaction. It relies on the *caller* to be inside one (or on better-sqlite3's implicit single-statement atomicity, which does NOT protect the SELECT→INSERT pair).

V2's plan ("BEGIN IMMEDIATE tx: mutation UPDATE + `audit()` INSERT + COMMIT") is therefore actually fine for the chain integrity (the outer tx wraps the SELECT+INSERT) — but only if the outer tx really is IMMEDIATE. The V2 snippet says:

> `db.transaction(fn)()` wraps in `BEGIN ... COMMIT` and automatically falls back to `ROLLBACK` on throw. For the IMMEDIATE flavor use `db.transaction(fn).immediate()`.

That's correct (and `src/auth/oauth-callback.ts:382` uses `tx.immediate()` as precedent). **But the example block at spec lines 253-261 calls `db.transaction(() => {...})()` — the deferred flavor.** The "Note" below it mentions `.immediate()` as if optional. For the last-admin TOCTOU guarantee to hold against concurrent writers, the outer wrapper MUST be `.immediate()`, otherwise SQLite opens a DEFERRED tx, upgrades to a write-lock only at the first UPDATE — and another writer can interleave between the chain-tip SELECT inside `audit()` and our UPDATE, producing two rows with the same `prev_hash` (chain fork).

**Action**: Rewrite the §Transaction model code sample to `db.transaction(fn).immediate()`, and add a sentence: "The `.immediate()` suffix is non-optional — DEFERRED tx upgrade timing can fork the audit chain under concurrent writers."

---

### F2 — Three new audit event names not registered in `TIER1_EVENTS` — silently get Tier-2 retention (90 days, not 365) — MAJOR

**Spec location**: §Audit events (lines 237-247).

**Evidence**: `src/security/audit-events.ts:15-36` enumerates `TIER1_EVENTS`. The sweeper (`src/sweeper/index.ts:185-190`) deletes rows by `action IN (TIER1_EVENTS)` for the Tier-1 retention bucket. V2's three new names — `admin.org.created`, `admin.org.updated`, `admin.user.role_changed` — are NOT in the array. Tier classification in `audit()` is just sync-vs-async routing; **retention is decided purely by string membership in these constants.**

Consequence: if implementers add `audit("admin.org.created", { tier: 1, ... })` per spec but skip the `audit-events.ts` edit, the row falls through neither Tier-1 nor Tier-2 sweep predicates (Tier-2 also has its own enumerated list) — actually leaving the rows **un-pruned forever**, which is a different bug than retention-too-short. Either way it's wrong.

**Action**: Spec must add a one-line task: "Add `'admin.org.created'`, `'admin.org.updated'`, `'admin.user.role_changed'` to `TIER1_EVENTS` in `src/security/audit-events.ts`." Test should assert membership.

---

### F3 — `LIMIT 5000` has no precedent in the codebase; existing caps are `LIMIT 1000` (sweeper batches) — MINOR

**Spec location**: lines 91, 114, 407; multiple "5000" mentions.

**Evidence**: `LIMIT 1000` appears in 6 sweeper queries (`src/sweeper/index.ts` BATCH_SIZE) and is the documented cap throughout `docs/superpowers/specs/2026-05-13-auth-phase2-oauth-device-design-V4-patches.md`. No other read-path query in `src/` uses an arbitrary list cap; reads are either single-row or unbounded `ORDER BY ... LIMIT ?` with a parameter.

5000 is fine as a number — it's defensible (a single-instance deployment shouldn't have 5000 users) — but the spec's "match existing similar caps elsewhere" framing is technically incorrect: there ARE none. Recommend either (a) drop to `LIMIT 1000` for consistency with sweeper batch idiom, or (b) explicitly note: "Read-path cap; no existing precedent; chosen to be 50× sweeper batch so a deployment hitting the ceiling is obviously pathological."

**Action**: Pick one. I lean toward 1000 for boring consistency.

---

### F4 — `users.role IN ('admin', 'member')` filter omits the `'service'` role that exists in v0.10.5 — MAJOR (correctness gap)

**Spec location**: lines 114, 116, 132.

**Evidence**: `src/auth.ts:23` defines `AuthRole = "agent" | "admin" | "member" | "service"`. Service accounts (v0.10.5 / T25) are created via `mintAccessJWT` with `role: "service"` and stored as users in some flows. The V2 `GET /api/admin/users` filter `WHERE role IN ('admin','member')` and the last-admin guard `WHERE role IN ('admin','member')` both implicitly assume `'service'` rows in `users` don't exist or shouldn't be touched. That's *probably* true today (service tokens go in `refresh_tokens`, not `users`), but the validation rule mismatch is concerning: the spec's PATCH 409 NOT_HUMAN_USER says current role is "`agent` / `service`" — yet the SQL also accepts `'admin'/'member'` only.

**Action**: Pick one consistent set in `src/auth.ts`'s spirit. Recommended: keep filter `WHERE role IN ('admin','member')`, AND in handler code path check `if (currentRow.role === 'agent' || currentRow.role === 'service') → 409 NOT_HUMAN_USER`. Spec is internally inconsistent here.

---

### F5 — V2 mentions an `idp_provider TEXT` and `idp_org_id TEXT` column on `orgs` but cites `allowlist_github_org` / `allowlist_idp_org_id` as the canonical allowlist fields — verify intent — MINOR

**Spec location**: endpoint payloads — `{ name, allowlist_github_org, allowlist_idp_org_id, created_at }`.

**Evidence**: `src/database.ts:252-258` (initial `orgs` CREATE TABLE) defines `idp_provider TEXT` and `idp_org_id TEXT` columns. The two `allowlist_*` columns are added later by ALTER (lines 669, 675). So the table has **four** TEXT columns the admin might care about: `idp_provider`, `idp_org_id`, `allowlist_github_org`, `allowlist_idp_org_id`. V2 only exposes/modifies the latter two — which is the right product call (allowlists are the allowlist machinery; idp_provider/idp_org_id appear to be legacy fields), but the spec should explicitly say "we deliberately don't expose `idp_provider`/`idp_org_id` because they're …".

**Action**: One sentence in §Endpoints and one in §Non-goals.

---

### F6 — V2 uses `KNOWN_AUTH_PATHS.has(url)` but `/api/admin/orgs/:id` is parameterized and therefore CANNOT be added to that set — methods other than PATCH on that path will 404, not 405 — MINOR

**Spec location**: §Route wiring lines 343-355.

**Evidence**: `src/http/auth-routes.ts:111-121` explicitly documents this trade-off for service-tokens revoke ("non-POST methods on this path fall through to the dispatcher's return false (handleRest will 404). This skips the 405 branch for parameterized paths — acceptable trade-off"). V2 instructs adding `/api/admin/orgs` + `/api/admin/users` (the unparameterized roots) to `KNOWN_AUTH_PATHS`, which is correct, but doesn't acknowledge that `GET /api/admin/orgs/{id}` will 404 instead of 405. That matches the existing service-tokens precedent and is fine, but call it out explicitly so reviewers don't flag it as a regression.

**Action**: One sentence in §Route wiring acknowledging the parameterized-path 404-not-405 outcome, citing `auth-routes.ts:111-113`.

---

### F7 — Empty-string vs `null` semantics for allowlist clear unclear — POTENTIAL BUG

**Spec location**: line 106 "`null` clears; absent leaves unchanged".

**Question**: What about `""`? The validation rule says "If string: 1–200 NFC code points" — so `""` (zero length) fails validation → 400 INVALID_REQUEST. That's the right answer but it's not explicit. A naive implementer might write `if (typeof v === 'string') update(...)` and accidentally store `""`, which would NULL-vs-empty-string-corrupt downstream allowlist matching (which uses `=` comparison; `'' != NULL`).

**Action**: Add explicit row in validation table: "Empty string `""` on `name`, `allowlist_github_org`, `allowlist_idp_org_id` → 400 INVALID_REQUEST (length 0)." Test asserts this.

---

### F8 — `dispatchAuthRoutes` returns `Promise<boolean>` but admin handlers return `Promise<void>` — match the existing wrapping pattern — NIT

**Spec location**: §Implementation contract (line 85).

**Evidence**: Each handler in `auth-routes.ts` is called via `await handleX(req, res, ctx); return true;` (pattern at lines 53-56, 101-103, 117-119). V2's contract `(req, res, ctx, ...pathParams): Promise<void>` matches; the boolean is solely the dispatcher's wrapping concern.

No action needed — but worth noting in the spec that the dispatcher block adds `return true;` after each new `await handleXxx(...)` call, for grep parity with the existing 11 routes.

---

## Summary

V2's API surface claims are correct against the codebase with one exception (F4 role-set inconsistency) and two integration omissions (F1 IMMEDIATE flavor, F2 TIER1_EVENTS registration) that would silently break in production. F3/F5/F6/F7/F8 are nits. None are blocking; all are addressable in the implementation plan rather than another spec round if the author prefers.
