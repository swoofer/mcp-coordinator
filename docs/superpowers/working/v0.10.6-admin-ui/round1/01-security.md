# Round 1 review — Security (admin UI V1)

**Verdict**: NEEDS-REWORK

Spec is broadly on the right track (reuses session JWT, double-submit CSRF, audit, rate limiter) but several concrete assumptions in the design do not match the codebase as it stands. Two findings are exploitable as written (CORS wildcard on admin.html, CSRF cookie name wrong → all mutations fail open as 403 OR worse if the dev fixes the name without thinking about it), three are correctness footguns that will silently downgrade the security posture (CSP/inline-JS, IP rate limit absent, audit PII), and the rest are smaller hardening items. Fix the CRITICAL/MAJOR items before merge.

Files inspected:
- `C:\Users\gagno\projet\mcp-coordinator-new\src\auth\csrf.ts`
- `C:\Users\gagno\projet\mcp-coordinator-new\src\auth\cookies.ts`
- `C:\Users\gagno\projet\mcp-coordinator-new\src\auth\oauth-finalize.ts`
- `C:\Users\gagno\projet\mcp-coordinator-new\src\auth\logout.ts`
- `C:\Users\gagno\projet\mcp-coordinator-new\src\auth\oauth-login.ts`
- `C:\Users\gagno\projet\mcp-coordinator-new\src\auth\html.ts`
- `C:\Users\gagno\projet\mcp-coordinator-new\src\admin\handle-service-tokens.ts`
- `C:\Users\gagno\projet\mcp-coordinator-new\src\serve-http.ts` (line 481)
- `C:\Users\gagno\projet\mcp-coordinator-new\src\auth\rate-limit.ts`

## Concerns

### 1. `/dashboard/*` static handler emits `Access-Control-Allow-Origin: *` — admin.html will be cross-origin-readable — CRITICAL

**Description**: `src/serve-http.ts:481` unconditionally sets `"Access-Control-Allow-Origin": "*"` on every file under `/dashboard/`. The spec proposes serving the new admin UI at `dashboard/public/admin.html`, so the page itself becomes readable from any origin. The HTML and inline JS are not themselves secret, but: (a) any attacker page can `fetch("https://coordinator/dashboard/admin.html")` and inline the response into its DOM to mount a same-origin-looking phishing UI against logged-in admins, (b) it sets the expectation that "things under `/dashboard/` are CORS-open", which will bite the moment somebody serves data files (template manifests, role-listing JSON for dropdown prefill, etc.) from the same prefix, (c) it signals "no Origin discipline here" which makes the CSRF defence-in-depth claim ring hollow.

**Recommendation**: Drop `Access-Control-Allow-Origin: *` from the static handler entirely for HTML (it is only needed for JS/CSS that some other host might want to embed, which is not a real use case here). At minimum, gate it so HTML responses get no ACAO header. Better: require an authenticated session cookie before serving `admin.html` (return 302→`/api/auth/login` for unauthenticated requests). Today `/dashboard/admin.html` would be served to anyone who knows the path, with no auth, no Cache-Control, no CSP, and CORS wide-open.

### 2. Static admin.html is served unauthenticated → unauth probe surface + clickjack/phish target — MAJOR

**Description**: The dashboard static handler does *not* call `authenticateRequest`. The spec's auth model gates only the JSON API, which is correct in principle, but it leaves `/dashboard/admin.html` (and any future admin assets) reachable by anonymous users. The page would render its tabs, fire `fetch('/api/admin/orgs')`, get 401, and only then redirect — meaning an attacker can: (a) confirm "this host has an admin UI" without credentials (recon for targeted phishing), (b) host a copy of the page with attacker-controlled JS in an iframe IF X-Frame-Options is not also added (the existing `sendHtml` helper sets `X-Frame-Options: DENY` but the dashboard static path does NOT — `src/serve-http.ts:479-483` only sets `Content-Type` and `Access-Control-Allow-Origin`).

**Recommendation**: Either (a) require an authenticated admin session before the file bytes are returned (preferred — gives 401 not 200), or (b) at minimum add `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` to every `/dashboard/*` response, and remove the wildcard CORS header. If the static handler stays auth-less, document explicitly that the page is a public probe surface and that the JSON API is the trust boundary.

### 3. Existing HTML CSP is `script-src 'none'` — inline JS in admin.html will be blocked, and the spec's "CSP already allows it for index.html" is false — MAJOR

**Description**: The spec at `### CSP` says *"The dashboard already serves with a CSP. Confirm the existing policy allows inline JS for the existing index.html; admin.html follows the same pattern."* This is unverified and wrong: `src/auth/html.ts:48-49` sets `Content-Security-Policy: default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`. However that CSP is only emitted by `sendHtml()` for the OAuth pages; the `/dashboard/*` static handler emits NO CSP at all. So today `index.html` works only because the dashboard handler ships no CSP. There are two related risks: (a) if a CSP is added to `/dashboard/*` (recommended hardening) the admin.html inline JS breaks silently in browsers; (b) shipping admin.html with NO CSP gives a real stored-XSS path real teeth if any of the org/user fields ever land in innerHTML unescaped (see Concern 4).

**Recommendation**: Ship admin.html with a real CSP from day one: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`. That requires extracting the inline JS to `dashboard/public/admin.js` — the spec already lists this as a fallback ("If CSP needs tightening to `script-src 'self'`, extract the admin JS"); make it the default, not the fallback. Audit `index.html` separately for the same treatment but do not block this PR on it.

### 4. XSS surfaces in admin.html — every server-returned org/user field is attacker-controlled — MAJOR

**Description**: Orgs are created by admins, but `name`, `allowlist_github_org`, and `allowlist_idp_org_id` are free-form strings validated only for length + "no control bytes" per the spec. That permits `<script>`, `"><img onerror=...>`, `javascript:` URI fragments, etc. Users come from OAuth so `email` is provider-validated, but `name` is whatever the IdP returns — Google/GitHub `name` can contain `<` and `>`. The spec says "client-side escape on render" but does not specify HOW. The current pattern in `index.html` uses `.innerHTML = ` in places; copy-pasting that pattern is how stored XSS lands. With CSP `script-src 'self'` (Concern 3), inline `<script>` injection is blocked, but `javascript:` URLs in href, `onerror=` handlers, and DOM clobbering still work to varying degrees, and right now there is no CSP at all on `/dashboard/*`.

**Recommendation**: (a) Mandate `textContent` (never `innerHTML`) for all server-returned strings in admin.html and call this out as a code-review checklist item. (b) Ship CSP per Concern 3 — this is the killshot for `<script>` injection even if a `textContent` rule slips. (c) Also server-side: reject any field containing `<` or `>` or quotes for org names/allowlists — defense in depth; nothing legitimate needs them. (d) Add a test that creates an org named `<img src=x onerror=alert(1)>`, fetches it via the UI, and asserts the literal string appears in `document.body.innerText` and that no script tag is in `document.body.innerHTML`.

### 5. CSRF cookie name and JS-readable assumption are inconsistent with the codebase — MAJOR

**Description**: The spec says `readCookie('__Host-csrf')` and `parseCookies(req)["__Host-csrf"]`. The actual cookie name set by login/device-flow is `__Host-coordinator_csrf` (see `src/auth/oauth-finalize.ts:24`, `src/auth/logout.ts:30`, `src/auth/device-flow.ts:208`). If the implementer copies the spec verbatim, every mutation will fail closed (403 forever — annoying but safe) OR the implementer will rename one side to match the other and accidentally break the OAuth pages that depend on the existing name. The `httpOnly: false` flag is set correctly on this cookie so JS can read it, but the spec should call this out so a future hardening pass does not flip `httpOnly: true` and silently break admin.html. The CSRF helper itself (`verifyCsrfToken`) is sound — uses `timingSafeEqual` with length pre-check — so the helper assumption is fine.

**Recommendation**: Fix the cookie name in the spec to `__Host-coordinator_csrf`. Add an integration test that asserts the exact cookie name across login + admin mutation. Add a comment to `src/auth/cookies.ts` noting which cookies must remain `httpOnly: false` and why (CSRF double-submit requires JS read). Consider exporting a `CSRF_COOKIE_NAME` constant from a shared module so spec, login, logout, and admin all reference the same string.

### 6. Audit `before/after` metadata can leak PII and stale secrets into the audit log indefinitely — MAJOR

**Description**: `admin.org.updated` metadata is specified as `{ before: {...full row...}, after: {...full row...} }`. The orgs table today only holds name + allowlists, so that is bounded, but: (a) v0.10.5 just shipped IdP encryption — if any IdP-related config gets promoted into `orgs` later, `before/after` will silently start emitting ciphertext or worse, plaintext, to the audit log, (b) more generally, dumping whole rows is a "log spreading" anti-pattern that means PII retention/erasure (GDPR Art. 17) becomes a per-event problem. For `admin.user.role_changed`, the spec is correctly minimal (`old_role, new_role` only) — copy that discipline to orgs.

**Recommendation**: Make `before/after` field-scoped: only the values of `changed_fields` get logged, not the full row. Example: `metadata: { org_id, changed_fields: ["allowlist_github_org"], changes: { allowlist_github_org: { before: "acme", after: "acme-new" } }, actor_user_id }`. Add an explicit denylist of column names that must never be emitted to audit metadata (forward-compat for any future encrypted/secret column on orgs). Document the rule in a comment in the audit-events file so reviewers catch additions.

### 7. Last-admin protection is TOCTOU as written — MAJOR

**Description**: The check is "SELECT COUNT(*) WHERE role='admin' = 1 AND target is that user; then UPDATE". Between the SELECT and the UPDATE, another admin in another request can demote *themselves* (their own request also passes the count=2 check because at SELECT time there are 2 admins). Result: zero admins. Reproducible with two concurrent PATCH requests from two different admin browsers. Also the check ignores `users.role` vs `user_orgs.role` distinction: the spec notes "admin role comes from `users.role` at login time (or from `user_orgs.role` for the primary org)" — if multi-org membership grants admin, COUNT on `users.role` misses those admins and falsely returns 1.

**Recommendation**: (a) Do the count + update in a single SQL statement, e.g. `UPDATE users SET role='member' WHERE id=? AND role='admin' AND (SELECT COUNT(*) FROM users WHERE role='admin') > 1` and check `changes() === 1`; if 0, return 409. (b) Wrap the read-modify-write in a SQLite `BEGIN IMMEDIATE; ... COMMIT;` so the SELECT and UPDATE are serialized against other writers. (c) If `user_orgs.role` is a real admin-grant path, count both: `SELECT (SELECT COUNT(*) FROM users WHERE role='admin') + (SELECT COUNT(*) FROM user_orgs WHERE role='admin') AS total_admins`. (d) Add a concurrency test: two parallel PATCHes both demoting different admins down to one — exactly one must succeed.

### 8. Rate limiter API mismatch — spec uses an API that does not exist; auth-failed requests bypass the limit — MAJOR

**Description**: Spec shows `ctx.rateLimiter.check({ key, limit: 10, windowMs: 60_000 })`. Actual API per `src/auth/rate-limit.ts` and call sites (`src/auth/oauth-login.ts:74`, `src/auth/userinfo.ts:58`) is positional: `ctx.rateLimiter.check(key, { per: N, window_seconds: M })`. If the implementer copies the spec verbatim, TypeScript will catch it — but the deeper issue is structural: the spec applies the limit AFTER auth (`per actor_user_id`), so an unauthenticated attacker spamming `/api/admin/orgs` consumes zero budget and gets only the cost of `authenticateRequest` (JWT verify — non-trivial CPU). They can also enumerate-by-timing the 401 vs 403 path (no auth vs auth-with-wrong-role) which leaks "who has admin role" to anyone with a stolen non-admin token.

**Recommendation**: (a) Use the actual API: `ctx.rateLimiter.check(\`admin:${claims.user_id}\`, { per: 10, window_seconds: 60 })`. (b) Add a per-IP rate limit BEFORE `authenticateRequest`, mirroring `oauth-login.ts:73-82` — e.g. `admin-probe:${ip}` at 60/min. This caps unauthenticated probe traffic and brute-force-of-JWT attempts. (c) Return identical response bodies and timing for "no auth" vs "auth+wrong role" — currently the spec leaks the distinction.

### 9. IDOR is not really mitigated — admins are global, not org-scoped — MINOR

**Description**: The spec implicitly assumes admins are global (any admin can mutate any org), which is correct for v0.10.6 single-tenant mode but is exactly what blocks the v0.11.0 multi-tenancy story listed as a goal. The `?org=<org_id>` filter on GET /api/admin/users is *advisory* — no server check restricts an admin from listing users in an org they shouldn't see, and no check restricts a future "org admin" from PATCHing an org they don't own. If v0.11.0 introduces per-org admin scope without re-auditing these handlers, you get an IDOR overnight.

**Recommendation**: (a) For v0.10.6, document explicitly in the handler comments: "admin role is currently global; v0.11.0 must add org-scope check here before granting per-org admin." (b) Add a TODO test marker (skipped test) that fails closed in v0.11.0 if cross-org access slips through. (c) Consider always logging `target_org_id` in admin audit metadata even when not strictly needed — makes the future scope-violation detection trivial.

### 10. No `Cache-Control: no-store` on the static admin.html — MINOR

**Description**: The `/dashboard/*` static handler does not set Cache-Control. Browsers and intermediate proxies may cache `admin.html`. If the admin user logs out and walks away, a back-button on the next user of the workstation reveals the admin UI shell (not the data — `/api/admin/*` will 401 — but the page structure leaks "this is a managed coordinator" info and pre-populates the UI for credential-stuffing attempts).

**Recommendation**: Set `Cache-Control: no-store` on `admin.html` specifically (the JSON API already does this per spec). Pairs with the auth-gate fix in Concern 2.

### 11. Session fixation surface unchanged but worth documenting — NIT

**Description**: The spec correctly does not introduce new session minting. The existing OAuth finalize regenerates session on login (good). No new fixation surface, but the spec should explicitly state "no new session is minted by admin endpoints; session lifecycle is unchanged" so a future reviewer doesn't reinvestigate.

**Recommendation**: One-line note in the Threat Model table: "Session fixation: no new session minting in admin endpoints; existing OAuth-finalize regen-on-login is the sole session creation path."

### 12. `authenticateRequest` return shape mismatch in the spec — NIT

**Description**: Spec snippet uses `if (!authResult.authenticated)` but the actual API per `src/admin/handle-service-tokens.ts:57` and `src/auth.ts:380` is `if (!authResult.ok)`. Cosmetic but the spec is supposed to be copyable.

**Recommendation**: Fix the snippet in the spec to use `.ok` and `respondUnauthorized` → match the real `res.writeHead(authResult.status, ...)` pattern from service-tokens. Otherwise the implementer will mix patterns.
