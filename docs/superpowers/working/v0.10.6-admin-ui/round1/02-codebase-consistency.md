# Round 1 review — Codebase consistency

**Reviewer lens**: integration with existing patterns, file/line accuracy, framework conventions
**Spec under review**: docs/superpowers/specs/2026-05-18-admin-ui-design.md
**Overall verdict**: NEEDS-INTEGRATION-WORK

The high-level architecture (admin REST resources mirroring `handle-service-tokens.ts`, JWT role gate, double-submit CSRF, async-context audit) is coherent with existing patterns. But the spec's sample code does not compile against the real codebase. Almost every helper named in the snippets is either invented (`respondUnauthorized`, `respondForbidden`, `respondTooManyRequests`) or has the wrong signature (`authResult.authenticated`, `ctx.rateLimiter.check({ key, limit, windowMs })`, `parseCookies(req)["__Host-csrf"]`). The static-file plumbing the spec assumes also does not exist — the dashboard container has no SPA fallback for `admin.html`, the in-process `/dashboard/*` handler doesn't enforce auth on HTML, and there is no `/login` route to redirect to. Ten concrete findings below; fixing them is mostly mechanical but the spec's "mirror the existing pattern" framing currently misrepresents what mirroring actually requires.

## Concerns

### 1. `authResult.authenticated` does not exist — the field is `authResult.ok` — CRITICAL
**Description**: Spec §"Authentication" reads `if (!authResult.authenticated) { return respondUnauthorized(...) }`. The real `AuthResult` discriminator is `ok`. Every existing admin handler in `src/admin/handle-service-tokens.ts` (lines 57, 195, 268) uses `if (!authResult.ok)`. There are zero matches for `authResult.authenticated` in the codebase, and 12 matches for `authResult.ok` across 5 files. The spec snippet will not type-check.

**Recommendation**: Replace `authResult.authenticated` with `authResult.ok` throughout §"Authentication" and the architecture diagram step 1. When `ok === false`, the result also carries `status`, `error`, and optionally `wwwAuthenticate` (see `handle-service-tokens.ts:57-66`); the spec should show forwarding those.

### 2. `respondUnauthorized` / `respondForbidden` / `respondTooManyRequests` are invented — CRITICAL
**Description**: Spec §"Authentication" + §"Rate limiting" call three helpers that simply do not exist in this codebase. `grep -r "function respond"` in `src/` returns zero results. The only response helper is `appError(code, message, details?)` from `src/http/response-contract.ts:67`, which returns the JSON envelope but does NOT write headers or call `res.end()`. The real pattern is the verbose 4-line block used at every site in `handle-service-tokens.ts`:
```typescript
res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
res.end(JSON.stringify(appError("FORBIDDEN", "Only admins can ...")));
return;
```

**Recommendation**: Either (a) drop the invented helpers and use the existing verbose block (consistent with the file the spec claims to mirror), OR (b) propose adding the helpers as a prerequisite refactor in `src/http/response-contract.ts`. Don't write the spec as if they're already there.

### 3. `ctx.rateLimiter.check()` signature is wrong — CRITICAL
**Description**: Spec §"Rate limiting" calls `await ctx.rateLimiter.check({ key, limit, windowMs })` and checks `rlResult.allowed` + `rlResult.retryAfter`. The actual signature in `src/auth/rate-limit.ts:38` is **synchronous** (no `await`) and takes two positional args: `check(key: string, cfg: { per: number; window_seconds: number })`. The result shape is also different: success has `{ allowed: true, remaining, reset_at }`, failure has `{ allowed: false, retry_after_seconds }` (snake_case, seconds — not `retryAfter` ms). Per-IP framing also doesn't match the existing key convention (login uses `${ip}` or `${userId}` raw, not a `admin:${user_id}` namespace — though that's a stylistic call).

**Recommendation**: Rewrite the snippet to:
```typescript
const rl = ctx.rateLimiter.check(`admin:${authResult.claims.user_id}`, {
  per: 10, window_seconds: 60,
});
if (!rl.allowed) {
  res.writeHead(429, { "Content-Type": "application/json; charset=utf-8",
                        "Retry-After": String(rl.retry_after_seconds) });
  res.end(JSON.stringify(appError("RATE_LIMITED", "Too many admin mutations")));
  return;
}
```

### 4. CSRF cookie name is `__Host-coordinator_csrf`, not `__Host-csrf` — CRITICAL
**Description**: Spec architecture diagram, §"CSRF", and §"Frontend client-side flow" all reference cookie name `__Host-csrf` (e.g., `parseCookies(req)["__Host-csrf"]`, `readCookie('__Host-csrf')`). The real cookie name, set by `src/auth/oauth-finalize.ts:323` and consumed by `src/auth/device-flow.ts:317` + `src/auth/logout.ts:30`, is `__Host-coordinator_csrf`. Three independent files declare `const CSRF_COOKIE_NAME = "__Host-coordinator_csrf"`. Reading the wrong key returns `undefined` → `verifyCsrfToken(undefined, ...)` → `false` → 100% of mutations 403 in production.

**Recommendation**: Replace `__Host-csrf` with `__Host-coordinator_csrf` in 3 spots. Better: export `CSRF_COOKIE_NAME` from `src/auth/csrf.ts` once and import it in the new handlers and the admin.html JS (so the browser code can't drift either). The same cleanup eliminates 3 duplicated string literals already in the codebase.

### 5. Spec proposes `before/after` audit metadata blobs — heavier than existing convention — MAJOR
**Description**: §"Audit events" specifies `admin.org.updated` with metadata `{ org_id, changed_fields, before: {...}, after: {...}, actor_user_id }`. The existing audit shape in `handle-service-tokens.ts:148-157` is flat scalars only: `{ jti, issued_by, target_user_id, target_org_id, scope, ttl_seconds, reason }`. No nested objects anywhere in the existing call sites. `audit()` in `src/security/audit.ts:91` accepts `metadata?: Record<string, unknown>` and serializes via `JSON.stringify`, so nested objects technically work — but: (a) it breaks the queryability invariant the existing chain assumes (operators currently `SELECT json_extract(metadata_json, '$.scope')`; nested `$.before.name` works but doubles the indirection), and (b) `actor_user_id` is **already auto-captured** from `withAuditContext` (see `audit-context.ts:33` + `audit.ts:96`) — including it in metadata duplicates the column.

**Recommendation**: Either (a) flatten to `{ org_id, changed_fields, old_name, new_name, old_allowlist_github_org, new_allowlist_github_org, ... }` matching existing scalar style, OR (b) explicitly accept the nested shape and document that operators querying audit must use nested `json_extract` paths. Drop `actor_user_id` from every metadata entry — `audit()` populates `actor_user_id` from the request context.

### 6. Dashboard Dockerfile has no admin.html plumbing; container is separate from API — CRITICAL
**Description**: Spec §"Architecture" shows `GET /dashboard/admin.html` served by "the existing static handler." There are TWO static-serving paths and neither does what the spec implies:
- **`dashboard/Dockerfile`** is a separate Node container on port 3200 that serves `dashboard/public/*` with a SPA fallback to `index.html` for anything not found. If you drop `admin.html` into `dashboard/public/`, it's served — but there is **no auth check whatsoever** at that layer (the Dockerfile inlines a 13-line static server, no `authenticateRequest`, no role gate, no cookie inspection). The page itself isn't sensitive (HTML+JS only), but the spec implies "session cookie authenticates the page load" — that only works for the API fetches, not for the HTML.
- **`src/serve-http.ts:450-487`** serves `/dashboard/*` from the coordinator process itself, also with no auth gate (it just `existsSync` + `readFileSync`). It does NOT have a SPA fallback (returns 404 instead of `index.html`).

These two serving paths conflict: the spec talks about "the existing static handler" as if there's one. In production, which one serves `/dashboard/admin.html` depends on deployment topology.

**Recommendation**: Pick one path and document it. If using the in-process handler (`serve-http.ts`), state that `dashboard/public/admin.html` will be served unauthenticated as static HTML (the API gate is what matters). If using the dashboard container, mention the SPA fallback means any typo URL also returns admin.html. Either way, drop the "redirect to /login on 401" guidance — there is no `/login` route; OAuth init lives at `/auth/login` (see `auth-routes.ts:53`).

### 7. Frontend redirect target `/login` does not exist — MAJOR
**Description**: §"Client-side flow" says `401/403 responses → redirect to /login`. The OAuth entry point is `/auth/login` (`auth-routes.ts:53`). There is no `/login` route registered anywhere. A redirect there will 404.

**Recommendation**: Change to `/auth/login`. Also note: `handleAuthLogin` requires the user to start the OAuth dance from scratch each time (no return-to-original-URL parameter today); operators landing on admin.html after a session expiry will have to re-navigate manually. If that's acceptable, say so; if not, propose adding a `?return_to=` param to the login flow as out-of-scope follow-up.

### 8. `users.primary_org_id` rename means PATCH /users body needs care; `users.org_id` is a v0.8 compat view — MINOR
**Description**: §"Endpoints #4" returns `primary_org_id` in the user payload, which matches reality (`database.ts:657`: `ALTER TABLE users RENAME COLUMN org_id TO primary_org_id`). Good. But there's a back-compat view `users` at `database.ts:769` that exposes `primary_org_id AS org_id` for one minor release — so SELECT queries in the new admin handlers need to be explicit about the underlying table (`FROM users` vs the view). Also the spec's `GET /api/admin/users` query param is `?org=<org_id>` but the column is `primary_org_id` — filter clause must be `WHERE primary_org_id = ?`. Spec doesn't show the SQL, so it's fine, but worth flagging for the implementer.

**Recommendation**: Add a "DB notes" subsection: filter by `primary_org_id` (not `org_id`); SELECT from `users` directly, not the compat view; include `last_login_at` per spec but note it can be NULL on never-logged-in users (currently impossible since users are created at first login, but the column allows NULL).

### 9. `audit()` async-context binding requires withAuditContext to be wrapping the handler — MAJOR
**Description**: §"Audit events" closing sentence: "Actor info (user_id, IP, request_id) auto-captured by `audit()` via async-context. No manual threading." True only if the dispatch chain wraps the handler in `withAuditContext(...)`. Looking at `handle-service-tokens.ts:147` it emits `audit("auth.service_token.issued", ...)` and assumes the actor is bound — meaning serve-http.ts must already wrap the request. The spec doesn't verify this; it just assumes. Worth a single sentence confirming the dispatch chain already does it (it does — `src/serve-http.ts` wraps via `withRequestId` + `withAuditContext` before calling `dispatchAuthRoutes`), and that the new admin handlers don't need to re-wrap.

**Recommendation**: Add one sentence to §"Audit events": "The request dispatch chain in serve-http.ts already establishes `withAuditContext(actor, request, fn)` before invoking `dispatchAuthRoutes`, so admin handlers inherit actor binding for free — same as `handle-service-tokens.ts`." This forestalls a confused implementer wrapping the handler again and breaking the chain.

### 10. `audit-routes.ts` dispatcher additions: parameterized PATCH /:id needs the same regex pattern as revoke — MINOR
**Description**: §"Architecture" diagram and "Endpoints" list 5 new routes including `PATCH /api/admin/orgs/:id` and `PATCH /api/admin/users/:id`. Looking at `auth-routes.ts:114-121`, the existing parameterized route (`/api/admin/service-tokens/<jti>/revoke`) uses a regex match (`url.match(/^\/api\/admin\/service-tokens\/([^/]+)\/revoke$/)`) and bypasses the `KNOWN_AUTH_PATHS` 405 check. The spec doesn't enumerate the dispatcher changes; an implementer might naively add the new IDs to `KNOWN_AUTH_PATHS` (with the literal `:id`) and accidentally trigger 405 on every real path.

The spec also doesn't address that `KNOWN_AUTH_PATHS` (Set of literal strings) cannot list `/api/admin/orgs/:id` because the URLs are not literals. The new parameterized routes must be regex-matched, and the `methodForPath` switch needs new branches for `/api/admin/orgs` (GET, POST) and `/api/admin/users` (GET) before any 405 path makes sense.

**Recommendation**: Add a §"Route wiring" subsection enumerating: (a) 2 literal route additions to `KNOWN_AUTH_PATHS` (`/api/admin/orgs`, `/api/admin/users`); (b) 2 regex-matched parameterized handlers for `/api/admin/orgs/<id>` and `/api/admin/users/<id>` (PATCH method); (c) `methodForPath` switch additions: `if (url === "/api/admin/orgs") return "GET, POST"; if (url === "/api/admin/users") return "GET";`.

### 11. Orgs schema has no UNIQUE on `name`; spec mentions a soft-check — VERIFY
**Description**: §"Endpoints #2" notes "409 (org with this name already exists — UNIQUE constraint if any; current schema has no UNIQUE on name, so this is a soft-check by SELECT first)." Verified true: `database.ts:252-258` defines `orgs` with `id TEXT PRIMARY KEY, name TEXT NOT NULL` — no UNIQUE on name. A SELECT-then-INSERT pattern has a TOCTOU race against concurrent POSTs (admin operator double-clicks, browser retries, etc.), but the only downside is two orgs with the same name. Not security-critical. Spec's framing is accurate; flagging only to note the implementation should at minimum use a transaction (`BEGIN IMMEDIATE; SELECT ...; INSERT ...; COMMIT;`) to narrow the race window.

**Recommendation**: Either (a) accept the race and document it ("two rapid POSTs with the same name may both succeed; this is acceptable since `id` is the primary key and consumers reference orgs by id"), OR (b) add a UNIQUE constraint as a v0.10.6 migration (`CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_name ON orgs(name)`) — note this may fail to apply if the existing DB already has duplicate-named orgs.

### 12. Test file paths use `tests/unit/` but the project convention should be verified — MINOR
**Description**: §"Testing" lists `tests/unit/handle-admin-orgs.test.ts`. The companion spec (`v0.10.5-idp-encryption`) places encryption tests under `tests/unit/` as well — pattern looks correct — but the spec doesn't verify the existing test file for `handle-service-tokens.ts` actually lives at `tests/unit/handle-service-tokens.test.ts`. Worth a one-line confirmation.

**Recommendation**: Confirm via `ls tests/unit/handle-service-tokens.test.ts` and either keep the path or correct it. The vitest config per-file thresholds line is plausible (the project uses this pattern) but the spec doesn't cite the exact `vitest.config.ts` line for the threshold block.

## Summary table

| # | Finding | Severity |
|---|---|---|
| 1 | `authResult.authenticated` doesn't exist — should be `.ok` | CRITICAL |
| 2 | `respondUnauthorized/Forbidden/TooManyRequests` are invented helpers | CRITICAL |
| 3 | `rateLimiter.check()` signature + result shape wrong (sync, positional, snake_case) | CRITICAL |
| 4 | CSRF cookie name is `__Host-coordinator_csrf`, not `__Host-csrf` | CRITICAL |
| 5 | Audit metadata `before/after` nested blobs break flat-scalar convention; `actor_user_id` is auto-captured | MAJOR |
| 6 | Two conflicting static-serving paths, neither has SPA fallback + auth as spec implies | CRITICAL |
| 7 | Redirect target `/login` does not exist — it's `/auth/login` | MAJOR |
| 8 | `users.primary_org_id` rename + compat view; filter SQL needs the new column name | MINOR |
| 9 | Audit auto-binding only works because serve-http.ts wraps with withAuditContext — make explicit | MAJOR |
| 10 | Dispatcher wiring for parameterized PATCH /:id paths isn't enumerated | MINOR |
| 11 | `orgs.name` has no UNIQUE; soft-check accepted but TOCTOU window should be narrowed | VERIFY |
| 12 | Test path convention not cross-checked against existing `tests/unit/` | MINOR |
