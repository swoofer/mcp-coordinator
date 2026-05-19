# Round 2 — Security + Concurrency (admin UI V2)

**Verdict**: MINOR-CONCERNS

V2 closes the V1 critical issues (TOCTOU, ACAO, CSP, CSRF cookie name, audit-vs-commit ordering, rate-limit shape). The `BEGIN IMMEDIATE` + `audit()` in one tx works correctly under better-sqlite3 because `getDb()` returns the singleton handle and `audit()` reuses it. The last-admin SQL guard serializes correctly. However, a few residual concerns remain — the third OR-clause in the guard is dead/misleading, GET endpoints under per-IP RL invite NAT-shared admin DoS, the ACAO drop language overreaches to `index.html`, and the spec's mutation+audit snippet uses `db.transaction(fn)()` (DEFERRED) where the prose says `.immediate()`. None are blockers but each warrants a one-line spec fix before implementation.

## Concerns

### 1. Last-admin SQL guard has a dead OR-clause that defeats the protection if reordered — MAJOR

**Where**: §Endpoints / PATCH /api/admin/users/:id, lines 129-138 (the `UPDATE users SET role = ?` block)

**Issue**: The guard reads:
```sql
AND (
  ? = 'admin'                                              -- new_role promote: always OK
  OR (SELECT COUNT(*) FROM users WHERE role='admin') > 1  -- demote: need >1
  OR ? <> id                                               -- demote-other: OK if >1 anyway covered above
);
```
The third clause `? <> id` (actor_id ≠ target row's id) is **logically dead** as written — but worse, the comment is wrong: it says "covered above" yet the clause still evaluates and SHORT-CIRCUITS the protection. Walk it through: actor A (admin) demotes target B (the only admin). Both clauses 1 and 2 are false. Clause 3 binds `?` to `actor_id = A` and compares against the row's `id = B`. `A <> B` is **true**, so the UPDATE succeeds and demotes the last admin. This re-opens the exact lockout the guard is supposed to prevent. The "demote-other" case is meaningless: if admin count > 1, clause 2 already passes; if admin count == 1, demoting "other" still leaves zero admins.

The spec text says self-demotion is "refused only when actor==target AND new_role != admin AND admin count == 1" — that's correct as a *policy* for self-vs-other UX, but **the server invariant is "never let admin count drop to 0"**, period. Demote-other-last-admin is just as catastrophic as demote-self-last-admin.

**Recommendation**: Delete the third OR-clause. The correct guard is exactly two clauses (promote OK, OR demote-with->1-admins). The self-vs-other distinction only matters for the 409 error-code dispatch in the post-UPDATE re-SELECT, not for the UPDATE predicate itself. Update test matrix: add "admin A demotes the only admin B (different user)" → must 409, currently would 200.

### 2. Round-1 concurrent-demote walkthrough succeeds, but UX assumption is wrong — MINOR

**Where**: §Endpoints / PATCH users, §Tests, §Last-admin protection

**Issue**: Two concurrent PATCH demotions targeting the only two admins under `BEGIN IMMEDIATE` (better-sqlite3): `BEGIN IMMEDIATE` acquires a RESERVED lock; second writer blocks (or `SQLITE_BUSY` if `busy_timeout` is short). Whichever wins runs the `SELECT COUNT(*) > 1` check inside its tx and sees 2 admins → demotes one → COMMIT. Second tx then runs, sees `COUNT(*) = 1` → demote blocked → 0 rows changed → 409. Correct behavior.

But the test description says "2 concurrent demotes against the only 2 admins → exactly one 200 + one 409". This assumes the loser doesn't time out as `SQLITE_BUSY` first. Check that the test fixture sets a non-zero `busy_timeout` (better-sqlite3 default is 5 seconds, fine) and that the integration test issues both requests through the **same** db handle (better-sqlite3 serializes; cross-process would surface BUSY). If the second test fails intermittently with `SQLITE_BUSY` → the test is racy, not the protection.

**Recommendation**: Add a one-line note to the test row: "Use shared `ctx.db` handle (better-sqlite3 serializes on the same connection); if `SQLITE_BUSY` surfaces under load, map to 503 with `Retry-After: 1`." Also document that the second request blocks rather than racing the SELECT — the protection is robust either way, but the readback wording in the spec implies a textbook TOCTOU window that doesn't actually exist with `BEGIN IMMEDIATE`.

### 3. Per-IP pre-auth rate limit collapses on NAT'd legitimate admin — MAJOR

**Where**: §Auth + CSRF / Rate limiting (D6), lines 204-221

**Issue**: 60 req/min/IP applied to **every** `/api/admin/*` request, including GETs (the spec at §Endpoint #1 says "Audit/RL: none (read-only past the pre-auth limit)" — meaning RL DOES apply to GETs). Scenario: a legitimate admin behind a corporate NAT (shared egress IP with attackers, or shared with thousands of other employees who are NOT admins but happen to hit `/api/admin/*` via misconfigured monitoring / browser prefetch / scanned URL probing). The attacker only needs to consume 60 reqs/min on that shared IP and the legitimate admin is locked out of the API entirely — including legitimate GET-list refreshes during a bulk-edit session.

Worse: an attacker who knows the admin's egress IP can intentionally grind `/api/admin/orgs` from anywhere using a botnet that proxies through the same egress — the per-IP bucket counts both. The admin can't even log in to the admin UI because the RL fires BEFORE `authenticateRequest`.

The Cut#5 justification ("authenticated admins are trusted") doesn't apply to the **pre-auth path**, which is exactly where this bites.

**Recommendation**: Two-tier the limit:
- GETs (read-only): no per-IP RL, OR very generous (600/min/IP). They're behind auth+role anyway and have a `LIMIT 5000` hard ceiling.
- Mutations (POST/PATCH): keep 60/min/IP pre-auth.

OR: keep one limit but bump to 600/min/IP (10/sec) — still caps JWT-grind cost (server can do >10K JWT verifies/sec, but 10/sec/IP * 1000 IPs = 10K/sec ceiling) without locking out legitimate admins behind NAT. Document the trade-off explicitly in §Risks accepted.

### 4. Spec snippet uses `db.transaction(fn)()` but prose mandates `.immediate()` — MINOR

**Where**: §Transaction model (D11), lines 253-263

**Issue**: The code block shows `db.transaction(() => { ... })()` (call with `()` → DEFERRED tx), then the note below says "For the IMMEDIATE flavor use `db.transaction(fn).immediate()`." This is a contradiction inside one section. DEFERRED won't acquire the RESERVED lock until first write — for the UPDATE-guarded mutation it's *probably* fine because the UPDATE is the first statement, but `insertAuditRowWithChain` does a `SELECT row_hash FROM audit_log ... LIMIT 1` BEFORE its INSERT. Whether the SELECT is the audit's first statement matters: in the mutation handler's tx, the guarded UPDATE runs first (RESERVED lock acquired), so subsequent audit SELECT+INSERT are within the same write tx → fine. But the spec snippet as written is still misleading: implementers will copy the `db.transaction(fn)()` form.

Also: the comment at the snippet says "inside same connection's open tx" — verified correct (`audit()` → `insertAuditRowWithChain(getDb(), ...)` → `getDb()` returns the singleton DatabaseAdapter, same handle as `ctx.db`, so it participates in the open tx). Worth keeping that statement *in the spec* since reviewers will re-verify it on every audit-tx coupling question.

**Recommendation**: Change the snippet to `db.transaction(() => { ... }).immediate();` and delete the trailing note (or move it before the snippet as the rationale). Add one sentence: "`ctx.db` and `getDb()` return the same singleton DatabaseAdapter in single-instance mode (verified `database.ts:785` + `audit.ts:110`), so the audit INSERT participates in the open transaction."

### 5. ACAO drop language overreaches to `index.html` — MINOR

**Where**: §Static file serving + headers (D7), line 227

**Issue**: V2 says "Drop `Access-Control-Allow-Origin: *` for HTML responses (admin pages and `index.html`)." But the existing `serve-http.ts:481` blanket-sets ACAO `*` for ALL `/dashboard/*` responses; the user's review prompt flags that `index.html` intentionally has ACAO `*`. The actual handler at lines 470-483 doesn't distinguish content-type — it sets the header for everything matching `ext` in `contentTypes`. The proposed patch needs to be more surgical than "for HTML responses": either (a) keep ACAO `*` for `index.html` specifically and drop for `admin*.html`, or (b) drop for all HTML if the team agrees index.html doesn't actually need cross-origin access (which it might, e.g., for a docs site embedding it).

The spec hedges: "Keep it only for `.js`/`.css`/`.json` if any external page needs them (none today; recommend dropping entirely)." That's ambiguous — implementer will either drop everywhere (breaking any hypothetical index.html consumer) or get tangled trying to discriminate.

**Recommendation**: Decide explicitly. Recommend the surgical version: in `serve-http.ts:479-482`, add a check `const isAdminHtml = /^\/dashboard\/admin(-orgs|-users)?\.html$/.test(url);` — if `isAdminHtml`, set CSP + X-Frame-Options + Referrer-Policy + Cache-Control + NO ACAO; else preserve existing behavior (ACAO `*` for everything else). This is safest and explicitly scopes the change to admin pages only. The "drop ACAO entirely" suggestion is out of scope for v0.10.6 and should be lifted into a separate cleanup task.

### 6. CSRF cookie issuance window — pre-login admin page load will fail readCsrfToken() — MINOR

**Where**: §Frontend / CSRF cookie read (lines 288-296)

**Issue**: `__Host-coordinator_csrf` is set inside `setSessionCookies` (oauth-finalize.ts:323) which is called from `oauth-callback.ts:476` — i.e., the cookie only exists AFTER successful OAuth login. The admin pages are NOT auth-gated at the static-serve layer (per S1 + spec §Static file serving point 3: "Do not auth-gate the static HTML"). So a user can land on `/dashboard/admin.html` without ever having logged in, the page's bootstrap JS runs `readCsrfToken()` on first mutation, and gets "CSRF cookie missing — log in again" instead of a proper auth redirect.

That error path is acceptable for *mutations* (the user fixes by logging in), but the *initial GET* (`fetch('/api/admin/orgs', { credentials: 'include' })`) doesn't need the CSRF cookie at all (GETs don't enforce CSRF). The page will fail at first PATCH with a confusing message rather than at page load. Spec should document: on page load, do a probe `GET /api/admin/orgs` first; if 401 → redirect to `/auth/login`; then any subsequent mutation can safely read the cookie. The current snippet throws synchronously inside `readCsrfToken()`, which will crash the page before the redirect chance.

Also note `parseCookies` on the server-side — confirmed in `oauth-finalize.ts:24` and used by `csrf.ts` consumers; no concern there since the server reads the cookie value off `req.headers.cookie` directly. Verified the V2 plan to export `CSRF_COOKIE_NAME` from `csrf.ts` is consistent (currently the const lives in `oauth-finalize.ts:24` as a private; spec correctly moves it).

**Recommendation**: Wrap `readCsrfToken()` calls in try/catch in `admin.js`; on missing cookie, redirect to `/auth/login?return_to=` + current path rather than throw. Add a §Frontend bootstrap note: "On page load, perform initial GET; if 401, redirect to /auth/login before binding mutation handlers." Test: visit admin page in incognito → confirm redirect to /auth/login, not a raw error.

### 7. UNIQUE INDEX migration on existing duplicate names aborts boot — MINOR

**Where**: §Schema (D10), lines 357-365

**Issue**: V2 says "If the migration fails due to existing duplicate names: a separate operator runbook step (de-dupe via SQL) is required... the boot aborts." For v0.10.6 *new* deployments, fine. For *upgrade* deployments where two orgs were accidentally named "acme" via raw SQL (the very thing v0.10.6 exists to prevent operators from needing to do), the next `coordinator` start will hard-fail with `UNIQUE constraint failed: orgs.name` and the operator gets a server that won't boot, with no remediation steps in the changelog.

The spec acknowledges this but offloads it to a "separate operator runbook step" that doesn't exist yet.

**Recommendation**: Either (a) bundle a pre-migration check: `SELECT name, COUNT(*) FROM orgs GROUP BY name HAVING COUNT(*) > 1` — if non-empty, log each duplicate with row IDs and abort with a precise error message pointing to the runbook, OR (b) ship the runbook as a section in the v0.10.6 release notes ("Before upgrading: SELECT name, COUNT(*) FROM orgs GROUP BY name HAVING COUNT(*) > 1; if any rows returned, rename the duplicates via UPDATE orgs SET name = name || '_' || id WHERE..."). Recommend (a) — the precise error message in the abort log is the difference between a 5-minute and a 5-hour debugging session.

### 8. Validation error messages echoed in `appError.message` — verify no XSS surface — NIT

**Where**: §Validation rules + §Auth + CSRF

**Issue**: `AdminValidationError` carries a `field` and `message`; the handler emits `appError("INVALID_REQUEST", err.message, { field: err.field })`. If the validator ever includes the user-submitted value in the message (e.g., `"name '${value}' contains invalid character"`), and a client renders that message via `innerHTML`, that's a stored-XSS-via-error-message vector. The frontend mandates `textContent` (good), but third-party tools (CLI, scripts) might log the message somewhere that does render HTML (a Slack webhook with markdown auto-link, a status dashboard).

The spec validators don't currently echo the value in messages (the table just lists rules, not message strings), so this is preventive. But the §Validation rules don't explicitly forbid it.

**Recommendation**: Add to §Validation rules: "Error messages MUST NOT include the rejected input value verbatim. Use generic messages like 'name contains disallowed characters' or 'name exceeds 200 code points', not 'name <script>alert(1)</script> is invalid'. Field name in `details.field` is safe (controlled vocabulary)." One-line spec addition; saves a future CVE.
