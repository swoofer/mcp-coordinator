# Admin web UI for orgs + users (v0.10.6 design)

**Status**: V2 (post Round 1 review — 6 reviewers, 75 findings synthesized)
**Target**: mcp-coordinator v0.10.6
**Author**: autonomous agent, 2026-05-18
**Companion**: v0.10.5 IdP encryption (just shipped)

## Revision history

| Version | Date | Changes |
|---|---|---|
| V1 | 2026-05-18 | Initial draft. Unanimous NEEDS-REWORK / OVER-ENGINEERED verdict from 6 reviewers. |
| V2 | 2026-05-18 | Rewrite per `working/v0.10.6-admin-ui/round1/00-SYNTHESIS.md`. Key changes: real API signatures (D1/D2/D3/D4); CSRF cookie name fix (D3); CSP + ACAO fix for `/dashboard/*` (D7); 5→3 audit events with flat scalar metadata (D5/C7); per-IP pre-auth rate limit instead of per-actor post-auth (D6); 5→3 static files with day-1 JS extraction (D8); last-admin TOCTOU-safe via `BEGIN IMMEDIATE` (D9); orgs.name UNIQUE INDEX added (D10); mutation + audit in one tx (D11); explicit hand-rolled validation (D12); raw SQLite timestamps (D13); `LIMIT 5000` ceiling, no `truncated` flag (D14); a11y + responsive + i18n requirements (D15); staging-save + pre-emptive banner role-change UX (D16). |

## Summary

Add a small admin web UI for operators to manage orgs (CRUD allowlists) and users (role assignment). Today these operations require `UPDATE` statements via `sqlite3 coordinator.db`. v0.10.6 adds **5 REST endpoints** under `/api/admin/{orgs,users}` and **3 static pages** under `dashboard/public/admin*.html` — gated by the existing `role === "admin"` JWT claim, CSRF-protected via the existing double-submit cookie pattern.

Effort: ~3-4 days. Single release. Backward-compatible (additive; one new UNIQUE index on `orgs.name`).

## Goals

1. Operators can list, create, and update orgs (name + 2 allowlist fields) via UI or raw HTTP.
2. Operators can list users (filtered by org) and change a user's role (admin ↔ member) via UI or raw HTTP.
3. All mutations emit Tier-1 audit events with flat-scalar metadata limited to changed fields.
4. Per-IP rate limit BEFORE auth on `/api/admin/*` (caps unauthenticated probe / JWT-grind cost).
5. Browser-served UI uses existing session cookie + CSRF double-submit. No new auth model.
6. One additive schema change: `CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_name ON orgs(name)`.

## Non-goals

- **Org deletion.** Cascade decisions are non-trivial and irreversible. Defer to v0.11.0.
- **User creation.** Users are created at first OAuth login.
- **User suspension.** Requires schema migration. Defer.
- **`user_orgs` multi-org role management.** Treat `users.role` as the single source of truth for v0.10.6.
- **Audit log viewer in the UI.** Out of scope.
- **Bulk operations.** One row at a time.
- **Step-up authentication.** Existing JWT + role check is sufficient.
- **Optimistic concurrency (`If-Match` / ETag).** Last-writer-wins; audit log is recovery. Defer.
- **HMAC-bound CSRF token.** Existing double-submit is intentional (V4 spec patches CUT 2). Defer.
- **i18n.** Admin pages are English-only by design ("operator tool").
- **Pagination.** Hard ceiling `LIMIT 5000`; revisit when a deployment hits it.

## Architecture

```
Browser (admin user, role=admin)
  GET /dashboard/admin.html             ← index (links to orgs/users pages)
  GET /dashboard/admin-orgs.html        ← inline form + table
  GET /dashboard/admin-users.html       ← filter + table + role dropdown
    → served by src/serve-http.ts:449   (in-process static handler)
    → with CSP, X-Frame-Options, Cache-Control: no-store
    → without Access-Control-Allow-Origin (dropped for HTML)
  fetch('/api/admin/orgs', { credentials: 'include' })
    → __Host-coordinator_session cookie authenticates
  fetch('/api/admin/orgs/o123', {
    method: 'PATCH', credentials: 'include',
    headers: { 'X-CSRF-Token': readCookie('__Host-coordinator_csrf') },
    body: JSON.stringify({ allowlist_github_org: 'acme' }),
  })
    → server verifyCsrfToken(cookieValue, headerValue) pre-write
                              ↓
src/http/auth-routes.ts  (extended)
  Each handler runs (mirrors handle-service-tokens.ts):
    1. Per-IP rate limit BEFORE auth     (D6: caps probe/JWT-grind cost)
    2. authenticateRequest(req, {authEnabled:true}); if (!result.ok) → forward .status + .wwwAuthenticate
    3. assert claims.role === "admin" else 403 FORBIDDEN
    4. For mutations: parseCookies(req)[CSRF_COOKIE_NAME] + verifyCsrfToken
    5. Bounded body read (4 KB cap, JSON.parse) — pattern from handle-service-tokens.ts
    6. Validate via AdminValidationError-throwing helpers
    7. BEGIN IMMEDIATE tx: mutation UPDATE + audit() INSERT + COMMIT  (D11)
    8. respond JSON + Cache-Control: no-store
                              ↓
src/admin/handle-admin-orgs.ts   (NEW)
src/admin/handle-admin-users.ts  (NEW)
src/admin/validate.ts            (NEW) — AdminValidationError + per-field validators
```

## Endpoints

All under `/api/admin/`, all require admin role, all set `Cache-Control: no-store`, all parse body with the 4 KB-capped read loop from `handle-service-tokens.ts:81-104`.

### Implementation contract

Each handler exports `async (req: IncomingMessage, res: ServerResponse, ctx: AuthHandlerContext, ...pathParams): Promise<void>`. Writes the response itself; no return-Response style.

### 1. `GET /api/admin/orgs`

List orgs. **Auth**: admin. **Query**: none. **Audit/RL**: none (read-only past the pre-auth limit).
**Response 200**: `{ "orgs": [{ id, name, allowlist_github_org, allowlist_idp_org_id, created_at }] }`.
**SQL**: `SELECT id, name, allowlist_github_org, allowlist_idp_org_id, created_at FROM orgs ORDER BY created_at ASC, id ASC LIMIT 5000`.

### 2. `POST /api/admin/orgs`

Create org. **Auth**: admin. **CSRF**: required.
**Body**: `{ name: string, allowlist_github_org?: string | null, allowlist_idp_org_id?: string | null }`.
**Validation**: see §Validation rules.
**Response 201**: `{ "org": { id, name, allowlist_github_org, allowlist_idp_org_id, created_at } }`. `id` = `randomUUID()`.
**Errors**: 400 INVALID_REQUEST, 409 ORG_NAME_TAKEN (UNIQUE INDEX violation).
**Audit**: `admin.org.created`, Tier 1, metadata `{ org_id, target_org_id, name, allowlist_github_org, allowlist_idp_org_id }`. (`actor_*` auto-captured.)

### 3. `PATCH /api/admin/orgs/:id`

Update org. **Auth**: admin. **CSRF**: required.
**Route regex**: `/^\/api\/admin\/orgs\/([^/]+)$/`; `decodeURIComponent` wrapped in try/catch → 400 BAD_PATH.
**Body** (at least one field): `{ name?: string, allowlist_github_org?: string | null, allowlist_idp_org_id?: string | null }`. `null` clears; absent leaves unchanged.
**Response 200**: `{ "org": { id, name, allowlist_github_org, allowlist_idp_org_id } }`.
**Errors**: 400 INVALID_REQUEST (validation / empty body / unknown field), 404 NOT_FOUND, 409 ORG_NAME_TAKEN.
**Audit**: `admin.org.updated`, Tier 1, metadata `{ org_id, target_org_id, changed_fields: ["name", ...], name_before, name_after, allowlist_github_org_before, allowlist_github_org_after, ... }` — only `<field>_before` and `<field>_after` scalars for fields in `changed_fields`. (D4)

### 4. `GET /api/admin/users`

List users. **Auth**: admin. **Query**: `?org=<org_id>` optional; validated against `/^[A-Za-z0-9_-]{1,64}$/`.
**SQL**: `SELECT id, email, name, role, primary_org_id, created_at, last_login_at FROM users WHERE role IN ('admin','member') [AND primary_org_id = ?] ORDER BY created_at ASC, id ASC LIMIT 5000`.
**Response 200**: `{ "users": [{ id, email, name, role, primary_org_id, created_at, last_login_at }] }`. No `truncated` flag.
**Filter rationale**: `agent` / `service` roles are mint-only; do not surface in the human-user admin UI (D5/S18).

### 5. `PATCH /api/admin/users/:id`

Change user role. **Auth**: admin. **CSRF**: required.
**Route regex**: `/^\/api\/admin\/users\/([^/]+)$/`.
**Body**: `{ "role": "admin" | "member" }`. Case-sensitive.
**Response 200**: `{ "user": { id, role } }`.
**Errors**: 400 INVALID_REQUEST, 404 NOT_FOUND, 409 NOT_HUMAN_USER (target current role is `agent`/`service`), 409 CONFLICT_LAST_ADMIN, 409 CONFLICT_SELF_DEMOTION (actor == target AND only admin).
**Audit**: `admin.user.role_changed`, Tier 1, `outcome: "success" | "denied"`, metadata `{ target_user_id, role_before, role_after, denied_reason? }`.

**Last-admin protection (D9)**: inside `BEGIN IMMEDIATE`:

```sql
UPDATE users SET role = ?
  WHERE id = ?
    AND role IN ('admin','member')          -- guards NOT_HUMAN_USER race
    AND (
      ? = 'admin'                            -- promote: always OK
      OR (SELECT COUNT(*) FROM users WHERE role='admin') > 1  -- demote: need >1
      OR ? <> id                             -- demote-other: OK if >1 anyway covered above
    );
```

Then `if (info.changes === 0)`: re-`SELECT role FROM users WHERE id = ?` to distinguish 404 / NOT_HUMAN_USER / CONFLICT_LAST_ADMIN / CONFLICT_SELF_DEMOTION, write `outcome: "denied"` audit row, return 409 with `appError("CONFLICT_LAST_ADMIN", "Cannot demote last admin. Promote another user first.")`.

**Self-demotion policy** (S6): refused only when *actor == target AND new_role != "admin" AND admin count == 1*; otherwise allowed. UI surfaces a pre-emptive banner when admin count == 1 (D16).

## Validation rules (D12, S16, S17)

A new module `src/admin/validate.ts` exports `class AdminValidationError extends Error { field: string }` and the validators below. Handler catches it and emits `appError("INVALID_REQUEST", err.message, { field: err.field })` with 400.

| Field | Rule |
|---|---|
| `name` (org) | Required. After NFC normalize: 1–200 Unicode code points. Reject if any character in `[ --​-‏‪-‮⁦-⁩﻿]` (C0/C1 controls, ZWS, bidi-overrides, isolates, BOM). Reject `<`, `>`, `"`, `'` (defense-in-depth for XSS). ZWJ U+200D and emoji variation selectors permitted. |
| `allowlist_github_org` | Optional. If string: 1–200 NFC code points, same denylist as `name`. If `null` (clear): allowed. |
| `allowlist_idp_org_id` | Same as `allowlist_github_org`. |
| `role` | Required, case-sensitive literal `"admin"` or `"member"`. Reject `null`, `"ADMIN"`, `"agent"`, `"service"`, any other string. |
| `?org=` query | Match `/^[A-Za-z0-9_-]{1,64}$/`; reject longer/odder values with 400. |
| URL `:id` path param | Match route regex `[^/]+`; `decodeURIComponent` try/catch → 400 BAD_PATH on malformed `%`. |
| PATCH body | Reject if empty object → 400 INVALID_REQUEST "no fields to update". Reject any unknown field (incl. `id`) → 400 INVALID_REQUEST `{ field: "<name>" }`. Duplicate JSON keys: rely on `JSON.parse` last-wins (documented). |
| Body byte cap | 4096 bytes; same loop as `handle-service-tokens.ts:81-95`. |

Tests cover each rule. NFC-normalize edge cases include emoji-only name, ZWJ family (`👨‍👩‍👧‍👦` — must pass), RTL override (must reject), 4-byte UTF-8 padding around 200-codepoint boundary.

## Auth + CSRF

### Authentication

Mirror `src/admin/handle-service-tokens.ts:51-75` verbatim:

```typescript
const authResult = await authenticateRequest(req, { authEnabled: true });
if (!authResult.ok) {
  res.writeHead(authResult.status, {
    "Content-Type": "application/json; charset=utf-8",
    ...(authResult.wwwAuthenticate ? { "WWW-Authenticate": authResult.wwwAuthenticate } : {}),
  });
  res.end(JSON.stringify(appError("UNAUTHORIZED", authResult.error)));
  return;
}
if (authResult.claims.role !== "admin") {
  res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("FORBIDDEN", "Only admins can manage orgs")));
  return;
}
```

No new auth code, no step-up.

### CSRF

CSRF cookie is `__Host-coordinator_csrf` (per `oauth-finalize.ts:24`, `logout.ts:30`, `device-flow.ts:208`). It is set without `HttpOnly` deliberately (comment at `oauth-finalize.ts:305`: "not HttpOnly (JS must read to send in form)"). V2 adds an exported `CSRF_COOKIE_NAME` constant to `src/auth/csrf.ts` so spec, login, logout, and admin handlers all reference one string.

For mutations:

```typescript
const cookies = parseCookies(req);
const cookieVal = cookies[CSRF_COOKIE_NAME];
const headerVal = req.headers["x-csrf-token"];
const headerStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
if (!verifyCsrfToken(cookieVal, headerStr)) {
  res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("CSRF_FAILED", "CSRF token mismatch")));
  return;
}
```

### Rate limiting (D6)

Per-IP bucket BEFORE `authenticateRequest`, mirroring `src/auth/oauth-login.ts:73-82`. Caps unauthenticated probe traffic + brute-force-of-JWT cost:

```typescript
const ip = (req.socket.remoteAddress ?? "unknown");
const rl = ctx.rateLimiter.check(`admin-api:${ip}`, { per: 60, window_seconds: 60 });
if (!rl.allowed) {
  res.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": String(rl.retry_after_seconds),
  });
  res.end(JSON.stringify(appError("RATE_LIMITED", "Too many admin requests")));
  return;
}
```

No per-actor post-auth limit (contrarian Cut#5): authenticated admins are already trusted; 10/min was too low to be useful and too easy to false-positive on batch edits.

## Static file serving + headers (D7)

`src/serve-http.ts:449-487` (the `/dashboard/*` handler) is amended:

1. **Drop `Access-Control-Allow-Origin: *`** for HTML responses (admin pages and `index.html`). Keep it only for `.js`/`.css`/`.json` if any external page needs them (none today; recommend dropping entirely).
2. **For paths matching `^/dashboard/admin(-orgs|-users)?\.html$`**, add headers:
   - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
   - `X-Frame-Options: DENY`
   - `Referrer-Policy: no-referrer`
   - `Cache-Control: no-store`
3. **Do not auth-gate the static HTML.** Trust boundary is the JSON API. Page is a thin shell; no secrets in the HTML.

Dashboard-container path (`dashboard/Dockerfile`) serves the same files; if deployed that way, document that the JSON API gate is the security boundary. The container has no auth; the admin pages should not be served from it in production deployments unless the container also serves the API (it doesn't today).

## Audit events (D4, D5)

Three event names. `audit()` auto-captures actor + IP + UA + request_id from withAuditContext (covered already by the dispatch chain in `serve-http.ts`).

| Event | Tier | Outcome | Metadata (flat scalars only) |
|---|---|---|---|
| `admin.org.created` | 1 | `success` | `{ org_id, target_org_id, name, allowlist_github_org, allowlist_idp_org_id }` |
| `admin.org.updated` | 1 | `success` | `{ org_id, target_org_id, changed_fields: ["name",...], name_before, name_after, allowlist_github_org_before, allowlist_github_org_after, allowlist_idp_org_id_before, allowlist_idp_org_id_after }` — only `<field>_before/after` keys for fields in `changed_fields` |
| `admin.user.role_changed` | 1 | `success` \| `denied` | `{ target_user_id, target_org_id, role_before, role_after, denied_reason? }` where `denied_reason ∈ {"last_admin","self_demotion","not_human_user","not_found"}` for `outcome: denied` |

No separate `*.failed` events for validation rejections (contrarian Cut#1: that's UI-affordance noise). DB-failure paths (disk-full, SQLITE_READONLY) throw → 500 + application log line; no best-effort audit-on-throw (contrarian S19).

## Transaction model (D11)

Each mutation handler opens `BEGIN IMMEDIATE`, performs the validated UPDATE, calls `audit(...)` (which INSERTs into `audit_log` via `getDb()` — same connection in better-sqlite3 single-instance mode), then `COMMIT`. Errors → `ROLLBACK`. This closes both Mode-A (commit before audit) and Mode-B (audit before failed commit) windows.

```typescript
const db = ctx.db;
const result = db.transaction(() => {
  const info = db.prepare(SQL_UPDATE_GUARDED).run(...);
  if (info.changes === 0) { /* re-SELECT for accurate 4xx */ return { ok: false, ... }; }
  audit("admin.org.updated", { tier: 1, metadata: {...} });   // inside same connection's open tx
  return { ok: true, ... };
})();
```

Note: better-sqlite3's `db.transaction(fn)()` wraps in `BEGIN ... COMMIT` and automatically falls back to `ROLLBACK` on throw. For the IMMEDIATE flavor use `db.transaction(fn).immediate()`.

## Frontend (3 static pages)

### File layout (D8)

```
dashboard/public/
  admin.html         — tiny landing page: two links (Orgs / Users) + admin email + Logout
  admin-orgs.html    — orgs table + inline-edit + "new org" <dialog>
  admin-users.html   — user table + org filter + role dropdown (staging) + confirm <dialog>
  admin.js           — shared: csrf, fetch wrapper, escape/DOM helpers, toast, dialog wiring
  admin.css          — shared dark theme, AA-contrast palette, responsive breakpoints
```

Each page sets `lang="en"`, `<meta name="viewport" content="width=device-width, initial-scale=1">`, includes `<link rel="stylesheet" href="admin.css">`, and `<script src="admin.js" defer></script>` plus its own small per-page inline-free `<script>` block — wait, that's inline JS again. Pattern instead: each page also loads its specific bootstrap as a separate file (`admin-orgs.js`, `admin-users.js`) — keeps `script-src 'self'` strict.

### DOM construction rules

- All server-returned strings rendered via `document.createElement` + `.textContent`. **Never `innerHTML` for data.** Static layout templates may use `innerHTML` with string literals only.
- `admin.js` provides `renderTable(rows, columns)` where `columns` is `[{ header, accessor }]` and the accessor returns a string or a constructed Node; the helper always uses `textContent` for strings.
- CI lint check: grep `admin*.js` for `\.innerHTML\s*=\s*[^"'`]` (anything other than literal) → fail.

### CSRF cookie read

```javascript
// admin.js
const CSRF_COOKIE = "__Host-coordinator_csrf";
function readCsrfToken() {
  const m = document.cookie.match(/(?:^|; )__Host-coordinator_csrf=([^;]+)/);
  if (!m) throw new Error("CSRF cookie missing — log in again");
  return decodeURIComponent(m[1]);
}
```

### Render states (S8)

Each table has three states:
- **Loading**: skeleton rows + "Loading…" placeholder (uses `aria-busy="true"` on the table).
- **Empty**: CTA card. Orgs: "No orgs yet. [Create your first org]". Users: "No users match this filter."
- **Error**: inline block with `role="alert"`, retry button, and a sub-line distinguishing network error (fetch reject → "Check your connection") from HTTP error (5xx → "Server error; contact ops"). 401/403 → redirect to `/auth/login`.

### Last-admin UX (D16, S7)

- Role column dropdown is a *staging* control. Changing it enables a per-row "Save" button. Clicking Save opens a confirmation `<dialog>` for demotions ("Demote alice@acme.com from admin to member?"). Promotions skip the confirm.
- On HTTP 409 `CONFLICT_LAST_ADMIN` or `CONFLICT_SELF_DEMOTION`: dropdown reverts to previous value; inline error renders at that row (`role="alert"`); no toast.
- Top-of-page banner ("You are the only admin. Promote another user before demoting yourself.") renders when client-computed admin count == 1.

### Accessibility (S9)

- Every `<input>` / `<select>` has an associated `<label for>` or `aria-label`.
- Modals use native `<dialog>` with `.showModal()` — focus trap + Escape handled by the browser.
- Tables include `<caption>` and `<th scope="col">`.
- Toasts: `<div role="status" aria-live="polite">` for success, `aria-live="assertive">` for errors.
- All interactive elements have visible focus styles; default browser outline preserved unless replaced.
- Playwright e2e adds an `axe-core` scan.

### Responsive (S10)

- Default desktop ≥1024px: two-column table layouts.
- ≤768px: tables collapse to card lists (one row per card; role dropdown + save stacked below identity).
- Tap targets ≥44×44px.

### Color contrast (S11)

- Override `--muted: #cbd5e1` (was `#94a3b8`) so all secondary text meets AA 4.5:1 against the existing `#0f0f1a` panel background.
- Status pills pair color with an icon/text marker (✓ saved, ⏳ saving, ✕ failed) to satisfy WCAG 1.4.1 (color is not the only signal).

### Confirmations (S13)

- Role demote: `<dialog>` shows target email + role transition. Promote: no confirm.
- Allowlist clear (PATCH with `allowlist_*: null`): `<dialog>` shows org name + impact text.
- Name change: no confirm.

## Timestamps (D13)

Returned as raw SQLite TEXT (`"YYYY-MM-DD HH:MM:SS"`) matching `handle-service-tokens.ts:240`. Client renders via `new Date(ts.replace(' ', 'T') + 'Z').toLocaleString()`. Test asserts the exact format from a fresh row.

## Route wiring (S30, Code#10)

In `src/http/auth-routes.ts`:

1. Add literals to `KNOWN_AUTH_PATHS`: `"/api/admin/orgs"`, `"/api/admin/users"`.
2. Extend `methodForPath`: `if (url === "/api/admin/orgs") return "GET, POST"; if (url === "/api/admin/users") return "GET";`.
3. Add literal dispatch lines:
   - `if (url === "/api/admin/orgs" && method === "GET")` → handleListOrgs
   - `if (url === "/api/admin/orgs" && method === "POST")` → handleCreateOrg
   - `if (url === "/api/admin/users" && method === "GET")` → handleListUsers
4. Add regex dispatch (mirror service-tokens revoke pattern at lines 114-121):
   - `/^\/api\/admin\/orgs\/([^/]+)$/` + `PATCH` → handleUpdateOrg(req, res, ctx, decodeURIComponent(match[1]))
   - `/^\/api\/admin\/users\/([^/]+)$/` + `PATCH` → handleUpdateUserRole(...)

Place all admin dispatch lines together for grep-ability.

## Schema (D10)

One additive migration in `src/database.ts` migration block (next idempotent CREATE INDEX entry):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_name ON orgs(name);
```

If the migration fails due to existing duplicate names: a separate operator runbook step (de-dupe via SQL) is required. Migration logs the failure and the boot aborts (consistent with existing migration error handling). For v0.10.6 single-tenant deployments, duplicates are not expected.

## Testing

| File | Coverage |
|---|---|
| `tests/integration/handle-admin-orgs.test.ts` (NEW) | All 3 org endpoints: per-IP RL (61st req → 429), auth gate (no/wrong/right), CSRF (missing/mismatched/valid), validation matrix (each rule from §Validation), DB integration (create + read + update), UNIQUE INDEX collision → 409, audit emission with exact flat-scalar metadata, mutation+audit in one tx (simulate UPDATE failure → no audit row) |
| `tests/integration/handle-admin-users.test.ts` (NEW) | All 2 user endpoints. Last-admin: 2 concurrent demotes against the only 2 admins → exactly one 200 + one 409. Self-demote with 1 admin → 409 CONFLICT_LAST_ADMIN. Self-demote with 2+ admins → 200. PATCH agent user → 409 NOT_HUMAN_USER. Audit `outcome: "denied"` row for each refusal. |
| `tests/e2e/admin-ui.spec.ts` (NEW, playwright) | Already-have-playwright check passes (`playwright.config.ts` exists in repo root). Browser test: login → /dashboard/admin.html → orgs page → create org with normal name → table updates → edit allowlist → save → toast → DB row matches. Role-change staging: change dropdown → no PATCH yet → click Save → confirm dialog → confirm → 200 → row updates. 409 path: simulate by demoting the only admin → revert + inline error. axe-core scan returns zero violations. |

No per-file 100% coverage thresholds (contrarian Cut#6). Existing repo defaults apply.

## Observability

No new prom metrics. The 3 audit events (with `outcome` field) provide the signal. Add `coordinator_admin_requests_total{endpoint, outcome}` if operators ask post-ship.

## Threat model

| Risk | Mitigation |
|---|---|
| Stolen admin session cookie | Existing SameSite=Strict + Secure + `__Host-` + JWT epoch revoke (unchanged) |
| CSRF | Double-submit token + SameSite=Strict. Token is NOT HMAC-bound to session (V4 CUT 2 — deferred). |
| Role escalation by non-admin | Hard `claims.role !== "admin"` check at every handler entry |
| Self-lockout (demote-last-admin) | Server-side 409 inside `BEGIN IMMEDIATE` (TOCTOU-safe) + UI pre-emptive banner |
| Mass user-list scrape | `LIMIT 5000` hard ceiling + per-IP RL + admin role gate |
| Replay on PATCH | CSRF token + idempotent semantics (PATCH with same body twice = same state); audit captures both |
| Stored XSS via org/user name | Server validation rejects `<`, `>`, `"`, `'`, control bytes, bidi-overrides; client uses `textContent` only; CSP `script-src 'self'` blocks injected `<script>` |
| Audit forgery via crafted name | `audit()` captures actor from async-context, not request body; chain hash detects tamper |
| Unauthenticated probe surface | Per-IP RL BEFORE auth caps probing cost |
| Static page clickjack | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` on admin pages |
| Cross-origin scrape of admin HTML | ACAO `*` dropped from `/dashboard/*` HTML responses |
| Concurrent PATCH on same org | Last-writer-wins; audit log captures both; ETag deferred to v0.10.7 |
| Session fixation | No new session minting in admin endpoints; existing oauth-finalize regen-on-login is unchanged |

## Risks accepted

- **No optimistic concurrency on org edits.** Two admins editing the same org → last-writer-wins. Audit log is the forensic record.
- **No HMAC binding on CSRF token.** Double-submit + SameSite=Strict + `__Host-` is the layered defense; binding deferred per V4 spec patches CUT 2.
- **No undo button.** Audit log + manual SQL is the recovery path.
- **No per-actor rate limit.** Authenticated admins are trusted; per-IP cap on auth path catches abuse.
- **English-only admin UI.** Operator tool; revisit if French operator pushback materializes.
- **Disk-full / read-only FS mid-PATCH** → 500 + application log; no best-effort failure-audit (would also fail). Operator runbook covers recovery.
- **`LIMIT 5000` truncation is silent.** If a real deployment hits >5000 users in one query, the table renders 5000 and the operator must use `?org=` to narrow. Pagination ships in v0.10.7 if needed.

## What was cut (vs V1)

| Cut | Reason |
|---|---|
| `admin.org.created.failed` audit event | Validation rejections are 400-response noise, not audit signal (Cut#1) |
| `admin.user.role_change.refused` standalone event | Collapsed into `admin.user.role_changed` with `outcome: "denied"` (Cut#2) |
| `before/after` row snapshots in audit | Field-scoped flat scalars only (Cut#3 + Sec#6 + Code#5) |
| 500-row cap + `truncated: true` | Replaced by `LIMIT 5000` hard ceiling (Cut#4) |
| Per-actor 10/min rate limit | Per-IP 60/min pre-auth limit instead (Cut#5 + Sec#8) |
| Per-file 100% coverage threshold | Repo default (Cut#6) |
| Inline-JS-with-CSP-fallback hedge | Day-1 extraction to `admin.js` / `admin-*.js` (Cut#9) |
| Single-page tab nav | Two pages + landing (Cut#10) |
| 5 test files (2 unit + 2 integration + 1 e2e) | 2 integration + 1 e2e (Cut#7 partial) |
| Org delete, user create, user suspend, bulk ops, step-up auth, audit-viewer UI, prom metrics | Deferred to v0.11.0+ (unchanged from V1) |

## References

- `src/admin/handle-service-tokens.ts` — pattern template (auth gate, body parsing, audit emission, response shape)
- `src/auth/csrf.ts` — `verifyCsrfToken`; add exported `CSRF_COOKIE_NAME = "__Host-coordinator_csrf"`
- `src/auth/cookies.ts` — `parseCookies`, `hostCookie`, `__Host-` enforcement
- `src/auth/oauth-finalize.ts:24,305,323` — canonical CSRF cookie name + non-HttpOnly rationale
- `src/auth/rate-limit.ts:38` — actual `check(key, { per, window_seconds })` signature
- `src/auth/oauth-login.ts:73-82` — per-IP RL pre-auth pattern to mirror
- `src/auth.ts:25-37` — `AuthClaims`; `:353-365` — `authResult.ok` + claims shape
- `src/security/audit.ts:91-114` — `audit()` signature, async-context capture, Tier 1 sync path
- `src/http/auth-routes.ts:101-150` — existing admin route dispatch + `KNOWN_AUTH_PATHS` + `methodForPath`
- `src/serve-http.ts:449-487` — `/dashboard/*` static handler (V2 amends this)
- `src/http/response-contract.ts` — `appError(code, message, details?)` envelope
- `src/database.ts:252-271` — orgs + users tables; `:651-657` — `org_id → primary_org_id` rename
- `dashboard/public/index.html` — existing dashboard for style reference (DO NOT inherit `innerHTML` pattern)
- `playwright.config.ts` — existing e2e infra (verified present)
- `docs/superpowers/working/v0.10.6-admin-ui/round1/00-SYNTHESIS.md` — Round 1 synthesis (drives V2)
- Companion: v0.10.5 IdP encryption design (just shipped — same release cadence)
