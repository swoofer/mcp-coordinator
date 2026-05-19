# Admin UI for orgs + users — V3 patches

**Date**: 2026-05-18
**Status**: V3 patches — supersedes specific sections of V2
**Supersedes**: `2026-05-18-admin-ui-design.md` V2, specific sections enumerated below
**Round 2 reviews**: `docs/superpowers/working/v0.10.6-admin-ui/round2/` (01-security-concurrency, 02-frontend-a11y, 03-api-codebase)
**Synthesis**: `docs/superpowers/working/v0.10.6-admin-ui/round2/00-SYNTHESIS-R2.md`
**Read order**: V2 spec first (architecture + rationale), then this patches doc (mechanical fixes + UX tightening).

## Purpose

Round 2 (3 reviewers) found 26 issues against V2. The architecture is sound; V3 closes mechanical bugs and scope ambiguities that would produce wrong-but-plausible implementations. No new architectural decisions — just precision on what V2 left ambiguous, plus the two genuine bugs (last-admin dead OR-clause, deferred-vs-immediate transaction).

V3 is patches-doc style (not full rewrite) because:
- V2's architecture survives unchanged.
- Patches are localized — easier to audit.
- Matches `2026-05-17-idp-token-encryption-design-V3-patches.md` convention (just shipped, v0.10.5).

---

## PATCH 1 — Last-admin SQL guard: delete dead OR-clause

**Supersedes**: V2 §Endpoints / "PATCH /api/admin/users/:id" / "Last-admin protection (D9)" SQL block (lines 129-138).

**Reason**: The third OR-clause `? <> id` re-opens the lockout the guard exists to prevent. Walk through: actor A (admin) demotes target B (the only admin); clause 1 (`? = 'admin'`) false, clause 2 (`COUNT > 1`) false, clause 3 (`A <> B`) **true** → UPDATE succeeds → zero admins → operator locked out. The "demote-other vs demote-self" distinction is policy noise; the **server invariant is "never let admin count drop to 0"**, period. That invariant lives in clause 2 alone. The actor-vs-target distinction is only used for the post-UPDATE 4xx-code dispatch (SELF_DEMOTION vs LAST_ADMIN), not the predicate.

**New SQL** (in `BEGIN IMMEDIATE` tx):

```sql
UPDATE users SET role = ?
  WHERE id = ?
    AND role IN ('admin','member')          -- guards NOT_HUMAN_USER race
    AND (
      ? = 'admin'                            -- promote to admin: always OK
      OR (SELECT COUNT(*) FROM users WHERE role='admin') > 1  -- demote: need >1 admins to survive
    );
```

Bind order: `[new_role, target_id, new_role]`. Note that `actor_id` is NOT bound into the SQL — the actor-vs-target check happens in TS after the UPDATE in the re-SELECT branch:

```typescript
if (info.changes === 0) {
  const current = db.prepare("SELECT role FROM users WHERE id = ?").get(targetId) as { role: string } | undefined;
  if (!current) return appError("NOT_FOUND", "User not found");
  if (current.role === "agent" || current.role === "service") {
    return appError("NOT_HUMAN_USER", "Cannot change role of non-human user");
  }
  // role IS admin AND admin count == 1 — distinguish self vs other for UX
  if (targetId === ctx.actorUserId) {
    audit("admin.user.role_changed", { tier: 1, outcome: "denied", metadata: { target_user_id: targetId, role_before: "admin", role_after: newRole, denied_reason: "self_demotion" } });
    return appError("CONFLICT_SELF_DEMOTION", "You are the only admin. Promote another user first.");
  }
  audit("admin.user.role_changed", { tier: 1, outcome: "denied", metadata: { target_user_id: targetId, role_before: "admin", role_after: newRole, denied_reason: "last_admin" } });
  return appError("CONFLICT_LAST_ADMIN", "Cannot demote last admin. Promote another user first.");
}
```

**Test addition** (in `tests/integration/handle-admin-users.test.ts`):

```typescript
test("admin A demoting only-admin B (different user) MUST 409 LAST_ADMIN", async () => {
  // Seed: A=admin, B=admin (2 admins). Demote A first (allowed → 1 admin = B).
  // Then: A (now member) is the actor, attempts to PATCH B's role to "member".
  // (In practice the auth gate would 403 because A is no longer admin —
  //  re-seed so the actor remains admin via a third admin C, demote it, then
  //  C-as-actor demotes B.)
  // Setup: A=admin, B=admin, C=admin. Demote C (still 2 admins).
  // C-as-actor demotes B → MUST 409 (admin count would drop from 2 to 1
  // ... wait, that's fine).
  //
  // Correct setup for the bug repro:
  //   A=admin, B=admin. Demote A (1 admin left = B).
  //   Re-promote A using B-as-actor (back to 2 admins).
  //   Now A-as-actor demotes B → CURRENT V2 SQL would 200 (clause 3 true); V3 MUST 409.
  // Assertion: response.status === 409, body.code === "CONFLICT_LAST_ADMIN".
});
```

Also extend the existing "concurrent demote against last 2 admins" test to verify exactly-one-200-one-409 outcome under the new 2-clause guard.

---

## PATCH 2 — `db.transaction(fn).immediate()` not `db.transaction(fn)()`

**Supersedes**: V2 §Transaction model (D11) code snippet (lines 253-263) AND the trailing note "For the IMMEDIATE flavor use `db.transaction(fn).immediate()`."

**Reason**: V2's code shows `db.transaction(fn)()` — the deferred form. The prose then says ".immediate() is the IMMEDIATE flavor". Implementers copy-paste the snippet. Without `.immediate()`, SQLite opens a DEFERRED tx and upgrades to RESERVED only at the first WRITE. The `audit()` call inside the tx performs a chain-tip `SELECT row_hash FROM audit_log ... LIMIT 1` BEFORE its INSERT. Under concurrent writers, two transactions can both pass the SELECT, both write rows with the same `prev_hash` → chain fork. For the last-admin guard specifically, deferred mode also widens the COUNT-vs-UPDATE window.

**New snippet** (replaces V2 lines 253-263):

```typescript
const db = ctx.db;

const result = db.transaction(() => {
  const info = db.prepare(SQL_UPDATE_GUARDED).run(newRole, targetId, newRole);
  if (info.changes === 0) {
    // re-SELECT for accurate 4xx — see PATCH 1
    return { ok: false as const, ...resolveDenialReason(db, targetId, ctx.actorUserId, newRole) };
  }
  audit("admin.user.role_changed", {
    tier: 1,
    outcome: "success",
    metadata: { target_user_id: targetId, target_org_id: targetOrgId, role_before: roleBefore, role_after: newRole },
  });
  return { ok: true as const, user: { id: targetId, role: newRole } };
}).immediate();   // <-- IMMEDIATE flavor: acquires RESERVED at BEGIN, not first write
```

**Anchor sentence** to add to §Transaction model (replaces the V2 trailing note):

> The `.immediate()` suffix is non-optional. The deferred form (`db.transaction(fn)()`) acquires the write lock only on the first WRITE statement, leaving a TOCTOU window between the chain-tip SELECT inside `audit()` and our UPDATE. `ctx.db` and `getDb()` return the same singleton `DatabaseAdapter` in single-instance mode (verified `database.ts:785` + `audit.ts:110`), so the audit INSERT participates in the open transaction.

**Audit step**: implementer MUST grep all new admin handlers for `db.transaction(` and verify every occurrence ends in `.immediate()`. CI lint:

```bash
grep -nE 'db\.transaction\([^)]*\)\(\)' src/admin/ && exit 1 || true
```

---

## PATCH 3 — Register new audit events in `TIER1_EVENTS`

**Supersedes**: V2 §Audit events (lines 237-247) — adds explicit task.

**Reason**: `src/security/audit-events.ts:14-36` defines `TIER1_EVENTS` as a `const` array. The sweeper (`src/sweeper/index.ts`) classifies retention by string membership in this array. The three new event names — `admin.org.created`, `admin.org.updated`, `admin.user.role_changed` — are NOT currently in either `TIER1_EVENTS` or `TIER2_EVENTS`. Without registration, rows escape both Tier-1 (365d) and Tier-2 (90d) retention sweeps → un-pruned forever (different bug than retention-too-short, but still wrong).

**New change** — edit `src/security/audit-events.ts`, extend the array:

```typescript
export const TIER1_EVENTS = [
  // ... existing entries ...
  "migration.audit_backfill",
  // v0.10.6 admin UI:
  "admin.org.created",
  "admin.org.updated",
  "admin.user.role_changed",
] as const;
```

**Test addition** (in `tests/integration/handle-admin-orgs.test.ts` or a new `tests/unit/audit-events-registration.test.ts`):

```typescript
import { TIER1_EVENTS } from "../../src/security/audit-events.js";

test("admin UI audit events are registered in TIER1_EVENTS", () => {
  expect(TIER1_EVENTS).toContain("admin.org.created");
  expect(TIER1_EVENTS).toContain("admin.org.updated");
  expect(TIER1_EVENTS).toContain("admin.user.role_changed");
});
```

This trivially-cheap test prevents the silent retention bug.

---

## PATCH 4 — Two-tier rate limit: mutations pre-auth, GETs unlimited

**Supersedes**: V2 §Auth + CSRF / Rate limiting (D6) lines 204-221.

**Reason**: V2 applies 60 req/min/IP to **every** `/api/admin/*` request including GETs. Legitimate admins behind corporate NAT (shared egress with thousands of non-admin colleagues whose browsers prefetch URLs, or whose monitoring probes admin endpoints) get locked out by 60 unrelated requests/min from the same egress IP. Attacker grinding from a botnet through the same egress proxy locks the admin out entirely — including from the login page (pre-auth RL fires first). The Cut#5 rationale ("authenticated admins are trusted") applies only post-auth, not to a pre-auth bucket. **GETs are read-only, behind auth+role, and have `LIMIT 5000` hard ceiling — they don't need pre-auth RL.** Mutations are where JWT-grind / probe cost lives.

**New behavior** — replace the single bucket with a method check:

```typescript
const ip = (req.socket.remoteAddress ?? "unknown");
const isMutation = method === "POST" || method === "PATCH" || method === "DELETE";
if (isMutation) {
  const rl = ctx.rateLimiter.check(`admin-api-mut:${ip}`, { per: 60, window_seconds: 60 });
  if (!rl.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(rl.retry_after_seconds),
    });
    res.end(JSON.stringify(appError("RATE_LIMITED", "Too many admin mutations")));
    return;
  }
}
// GETs proceed straight to auth — no pre-auth bucket.
```

**Rationale update** (replaces V2's "Caps unauthenticated probe traffic + brute-force-of-JWT cost"):

> Pre-auth rate limit applies to **mutating methods only**. GET endpoints are auth+role-gated with a `LIMIT 5000` hard ceiling and pose negligible JWT-grind value (no state change, same forged-cookie cost per request as a 401). Limiting GETs would lock out legitimate NAT'd admins for unrelated traffic on the shared egress IP. Mutations retain the 60/min/IP bucket — that's the actual probe / brute-force surface.

**Test addition** (in `tests/integration/handle-admin-orgs.test.ts`):

```typescript
test("GET /api/admin/orgs is NOT rate-limited per-IP pre-auth", async () => {
  // 100 GETs from same IP in 60s, all authenticated → all 200, no 429.
});

test("POST /api/admin/orgs IS rate-limited per-IP at 60/min", async () => {
  // 61st POST in 60s → 429 with Retry-After.
});
```

---

## PATCH 5 — `BEGIN IMMEDIATE` UX clarification + BUSY mapping

**Supersedes**: V2 §Endpoints test row "2 concurrent demotes against the only 2 admins → exactly one 200 + one 409" and §Last-admin protection prose.

**Reason**: V2's wording implies a textbook TOCTOU window that `BEGIN IMMEDIATE` on a single better-sqlite3 connection does not actually have (the second writer **blocks** behind the RESERVED lock, doesn't race). Reviewers re-deriving this on every audit will get nervous. Also: if a multi-process / multi-connection deployment ever materializes (e.g., a future read-replica), `SQLITE_BUSY` becomes a real surface that should map to a sensible HTTP status.

**New prose** (add to §Endpoints / Last-admin protection, after the SQL block from PATCH 1):

> Under better-sqlite3 single-connection mode (the default for v0.10.6), `BEGIN IMMEDIATE` on the singleton connection serializes writers: the second concurrent PATCH **blocks** until the first commits or rolls back, then runs its `SELECT COUNT(*)` against the post-commit state. No TOCTOU window exists. If a future deployment uses multiple writer connections (not planned for v0.10.6), `SQLITE_BUSY` may surface — map to 503 with `Retry-After: 1`:

```typescript
} catch (err: unknown) {
  if (err instanceof Error && (err as { code?: string }).code === "SQLITE_BUSY") {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Retry-After": "1" });
    res.end(JSON.stringify(appError("DB_BUSY", "Database busy, retry")));
    return;
  }
  throw err;
}
```

**Test row update** (in §Testing):

> "Last-admin: 2 concurrent demotes against the only 2 admins → exactly one 200 + one 409. Use shared `ctx.db` handle (better-sqlite3 serializes on the same connection); test asserts blocking behavior, not racing. If a future test surfaces `SQLITE_BUSY`, verify the 503 + Retry-After mapping above."

---

## PATCH 6 — ACAO drop: admin pages only via explicit URL regex

**Supersedes**: V2 §Static file serving + headers (D7) lines 224-235, specifically item 1 ("Drop `Access-Control-Allow-Origin: *` for HTML responses (admin pages and `index.html`)").

**Reason**: V2's "for HTML responses (admin pages and `index.html`)" wording is ambiguous and overreaches. `dashboard/public/index.html` may have external consumers (docs sites embedding it, monitoring scrapers); silently dropping ACAO from it is a scope expansion outside this spec's mandate. The fix should be **surgical** — drop ACAO only for the admin URL pattern.

**New behavior** — amend `src/serve-http.ts:470-483` (the file-serve block inside the `/dashboard/*` handler):

```typescript
if (filePath && existsSync(filePath)) {
  const ext = path.extname(filePath);
  const contentTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
  };
  const content = readFileSync(filePath, "utf-8");

  // v0.10.6: admin pages get strict headers + drop ACAO. Other dashboard
  // files (including index.html) keep existing behavior unchanged.
  const isAdminPage = /^\/dashboard\/(admin|admin-orgs|admin-users)\.html(\?.*)?$/.test(url);

  const baseHeaders: Record<string, string> = {
    "Content-Type": contentTypes[ext] || "text/plain",
  };

  if (isAdminPage) {
    Object.assign(baseHeaders, {
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; " +
        "connect-src 'self'; img-src 'self' data:; form-action 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      // intentionally NO Access-Control-Allow-Origin
    });
  } else {
    baseHeaders["Access-Control-Allow-Origin"] = "*";  // preserve existing behavior
  }

  res.writeHead(200, baseHeaders);
  res.end(content);
}
```

**Anchor sentence** (replaces V2 §Static file serving item 1):

> 1. **For admin pages only** (matching `^/dashboard/(admin|admin-orgs|admin-users)\.html$`), drop `Access-Control-Allow-Origin` AND add the strict CSP / X-Frame-Options / Referrer-Policy / Cache-Control headers below. **All other `/dashboard/*` files** (including `index.html`) preserve their current `Access-Control-Allow-Origin: *` behavior — out of scope for v0.10.6.

---

## PATCH 7 — CSP scope: admin pages only (explicit non-application to index.html)

**Supersedes**: V2 §Static file serving + headers (D7) item 2 wording — tighten scope and pin regex.

**Reason**: Reviewer flagged that `dashboard/public/index.html` uses inline JS (`<script>` blocks, `onclick=` handlers) and `innerHTML` pervasively. If the CSP regex ever loosens to match `index.html`, the existing dashboard breaks instantly. The V2 text was ambiguous enough that a future maintainer might "simplify" the regex. Pin the scope explicitly.

**New regex + scope statement** (folded into PATCH 6's `isAdminPage` test; this PATCH adds the prose):

```regex
^/dashboard/(admin|admin-orgs|admin-users)\.html(\?.*)?$
```

Matches exactly three URLs (with optional query string for cache-busting):
- `/dashboard/admin.html`
- `/dashboard/admin-orgs.html`
- `/dashboard/admin-users.html`

Does NOT match:
- `/dashboard/admin-extra.html` (future page — opt in deliberately)
- `/dashboard/index.html` (existing dashboard — preserves inline JS)
- `/dashboard/admin/anything` (nested paths — none today)

**Anchor sentence** (add to §Static file serving + headers right after the regex):

> **Scope discipline**: the strict CSP / X-Frame-Options / Referrer-Policy / Cache-Control block applies **only** to the three admin pages. `dashboard/public/index.html` keeps its current header behavior (no CSP) and is explicitly out of scope for v0.10.6 — its inline `<script>` blocks and `innerHTML` usage would be broken by CSP `script-src 'self'`. A future cleanup task (post-v0.10.6) can refactor `index.html` to be CSP-compatible.

---

## PATCH 8 — Frontend file count: pin at 8 files

**Supersedes**: V2 §Frontend / File layout (D8) lines 268-279.

**Reason**: V2 lists 5 files (admin.html / admin-orgs.html / admin-users.html / admin.js / admin.css), then mid-paragraph admits "each page also loads its specific bootstrap as a separate file (`admin-orgs.js`, `admin-users.js`)" — implying 7. The author caught themselves mid-paragraph ("wait, that's inline JS again") but did not fix the file table. The landing page (`admin.html`) also needs a bootstrap to fetch `/api/auth/me` for the email + wire Logout. So actual count is 8.

**New file layout** (replaces V2 lines 268-279):

```
dashboard/public/
  admin.html         — landing (links + admin email + Logout). Loads admin.js + admin-index.js
  admin-orgs.html    — orgs table + inline-edit + "new org" <dialog>. Loads admin.js + admin-orgs.js
  admin-users.html   — user table + org filter + role dropdown (staging) + confirm <dialog>. Loads admin.js + admin-users.js
  admin.js           — shared helpers (CSRF, fetchJson, escape, renderTable, toast, dialog wiring, STRINGS table)
  admin-index.js     — landing bootstrap (fetch /api/auth/me for email; wire Logout)
  admin-orgs.js      — orgs page bootstrap (fetch, render, dialog wiring)
  admin-users.js     — users page bootstrap (fetch, render, role dropdown wiring)
  admin.css          — shared dark theme, AA-contrast palette, responsive breakpoints
```

**8 files total**. All loaded via `<script src="..." defer></script>` under strict `script-src 'self'`. No inline JS anywhere on admin pages.

**Anchor sentence** (add to §Frontend):

> All 8 files are served by the in-process static handler in `serve-http.ts:449`. The strict CSP `script-src 'self'` permits all of them (same-origin) and forbids any inline `<script>` block or `onclick=` attribute. CI lint MUST grep admin pages for inline `<script>` content and `on*=` attributes:

```bash
grep -nE '<script[^>]*>[^<]' dashboard/public/admin*.html && exit 1 || true
grep -nEi '\son[a-z]+\s*=' dashboard/public/admin*.html && exit 1 || true
```

Update the §What was cut table row: "5 static files → 8 static files (8 = 3 HTML + 4 JS + 1 CSS; the 4 JS = 1 shared + 3 per-page bootstraps)."

---

## PATCH 9 — `readCsrfToken` defensive read + login redirect

**Supersedes**: V2 §Frontend / CSRF cookie read (lines 288-296).

**Reason**: `__Host-coordinator_csrf` is set during OAuth login (`oauth-finalize.ts:323`). An unauthenticated user landing on `/dashboard/admin.html` (the page is NOT auth-gated at the static-serve layer — by design, S1) executes `readCsrfToken()` on first mutation attempt and hits a synchronous `throw "CSRF cookie missing"`. Worse, the initial GET `/api/admin/orgs` doesn't need CSRF and would return 401 cleanly — but the page never gets there because the bootstrap code throws first OR the GET fails with 401 and the user sees a raw error instead of the login page.

**New behavior** — replace V2 `readCsrfToken` with a try/catch + bootstrap flow:

```javascript
// admin.js
const CSRF_COOKIE = "__Host-coordinator_csrf";

function readCsrfToken() {
  const m = document.cookie.match(/(?:^|; )__Host-coordinator_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;   // return null, don't throw
}

function redirectToLogin() {
  const returnTo = encodeURIComponent(location.pathname + location.search);
  location.assign(`/auth/login?return_to=${returnTo}`);
}

async function fetchJson(url, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (opts.method && opts.method !== "GET") {
    const token = readCsrfToken();
    if (!token) {
      redirectToLogin();
      throw new Error("redirect");   // never reached, but type-safety
    }
    headers["X-CSRF-Token"] = token;
  }
  const res = await fetch(url, { credentials: "include", ...opts, headers });
  if (res.status === 401 || res.status === 403) {
    redirectToLogin();
    throw new Error("redirect");
  }
  return res;
}
```

**Bootstrap flow** (each `admin-*.js`):

```javascript
// admin-orgs.js (example)
async function init() {
  try {
    const res = await fetchJson("/api/admin/orgs");   // probe; 401 → redirect
    const data = await res.json();
    renderOrgsTable(data.orgs);
  } catch (e) {
    if (e.message === "redirect") return;   // browser is navigating away
    renderErrorState(e);
  }
}
document.addEventListener("DOMContentLoaded", init);
```

**Anchor sentence** (add to §Frontend after the CSRF block):

> On page load, each admin-*.js bootstrap performs an initial GET against its primary API endpoint. A 401/403 response triggers `redirectToLogin()` with `return_to=` the current path; the user lands on `/auth/login` and (after success) returns to the admin page with the CSRF cookie set. Mutation handlers call `readCsrfToken()` lazily inside `fetchJson`; if the cookie has expired (e.g., session timeout mid-edit), the redirect flow re-engages.

**Test addition** (in `tests/e2e/admin-ui.spec.ts`):

```typescript
test("incognito visit to /dashboard/admin.html redirects to /auth/login", async ({ page, context }) => {
  await context.clearCookies();
  await page.goto("/dashboard/admin.html");
  await expect(page).toHaveURL(/\/auth\/login\?return_to=%2Fdashboard%2Fadmin\.html/);
});
```

---

## PATCH 10 — UNIQUE INDEX migration: pre-flight boot guard

**Supersedes**: V2 §Schema (D10) lines 357-365.

**Reason**: V2 says "If the migration fails due to existing duplicate names: a separate operator runbook step (de-dupe via SQL) is required... the boot aborts." For an upgrading deployment with accidental duplicate org names, this means: `coordinator` start fails with `SQLITE_ERROR: UNIQUE constraint failed: orgs.name`, no remediation hint, operator has 5-hour debug session. The v0.10.5 boot-guard pattern (explicit pre-flight SELECT with named-row error message) is the established precedent and turns this into a 5-minute fix.

**New behavior** — add a pre-flight check in `src/database.ts` migration block, BEFORE the CREATE UNIQUE INDEX:

```typescript
// v0.10.6: pre-flight check for duplicate org names before adding UNIQUE INDEX.
// If duplicates exist, fail with a precise actionable error message that names
// the duplicates and points to the runbook fix.
const dupes = db.prepare(`
  SELECT name, COUNT(*) AS n, GROUP_CONCAT(id, ',') AS ids
  FROM orgs
  GROUP BY name
  HAVING COUNT(*) > 1
`).all() as Array<{ name: string; n: number; ids: string }>;

if (dupes.length > 0) {
  const detail = dupes
    .map((d) => `  name="${d.name}" (${d.n} rows, ids: ${d.ids})`)
    .join("\n");
  throw new BootValidationError(
    `Cannot create UNIQUE INDEX idx_orgs_name: duplicate org names found.\n` +
    `Resolve by renaming duplicates before upgrading. SQL:\n` +
    `  UPDATE orgs SET name = name || '_' || id WHERE id IN (<keep-only-one-id-per-name>);\n` +
    `Duplicates:\n${detail}`
  );
}

// Safe to create.
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_name ON orgs(name)");
```

`BootValidationError` is the existing error class used by the v0.10.5 boot guards (see `src/security/encryption.ts` or wherever it lives — implementer reuses).

**Anchor sentence** (replaces V2 §Schema lines 363-365):

> The pre-flight check converts the cryptic `SQLITE_ERROR: UNIQUE constraint failed` (which would otherwise abort migration mid-transaction with no remediation) into a precise actionable boot error naming each duplicate row + the fix SQL. Matches the v0.10.5 boot-guard pattern.

**Test addition** (in `tests/integration/migration-orgs-unique.test.ts` — NEW):

```typescript
test("boot with duplicate org names → fail-loud with named rows", () => {
  const db = openTestDb();
  // Bypass migration; seed duplicates directly.
  db.exec("INSERT INTO orgs (id, name) VALUES ('o1', 'acme'), ('o2', 'acme')");
  expect(() => runMigrations(db)).toThrow(/duplicate org names found.*name="acme".*ids: o1,o2/s);
});

test("boot with unique org names → succeeds + index created", () => {
  const db = openTestDb();
  db.exec("INSERT INTO orgs (id, name) VALUES ('o1', 'acme'), ('o2', 'wayne')");
  expect(() => runMigrations(db)).not.toThrow();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orgs_name'").get();
  expect(idx).toBeDefined();
});
```

---

## PATCH 11 — Validation: no input echo + empty-string rule + request_id

**Supersedes**: V2 §Validation rules table (lines 144-159) — adds two rows and one rule.

**Reason**: V2 validators carry a `message` field on `AdminValidationError` that the handler emits via `appError("INVALID_REQUEST", err.message, { field: err.field })`. If a validator ever includes the rejected user-input value in the message (e.g., `"name '${value}' contains invalid character"`), that string flows into:
- The JSON response body (safe today — client uses `textContent`).
- Server logs (safe — text only).
- Third-party log aggregators / Slack webhooks / status dashboards (potentially unsafe — markdown auto-link, HTML rendering).

Saving a future CVE is one spec sentence. Also: V2 is silent on empty string `""` for `name` / `allowlist_*` fields. The "1-200 NFC code points" rule rejects it via length, but an implementer reading just "if string: validate" might call the validator skipping the length-zero short-circuit.

**New validation rules** (add to V2 §Validation rules table):

| Field | Rule |
|---|---|
| Empty string `""` on `name`, `allowlist_github_org`, `allowlist_idp_org_id` | Rejected (length 0 < 1). Returns 400 INVALID_REQUEST with generic message. |
| **Error messages MUST NOT include user-submitted input verbatim.** | Use generic phrasing: `"name contains disallowed characters"`, `"name exceeds 200 code points"`, `"role must be 'admin' or 'member'"`. The `field` name in `details.field` is safe (controlled vocabulary). |
| **Every error response MUST include `request_id`** | Server: `appError("INVALID_REQUEST", message, { field, request_id: ctx.requestId })`. The `request_id` is already in async-context via `withAuditContext` — handlers pull from `ctx.requestId` (already populated by the dispatcher). |

**New `AdminValidationError`** (refines the V2 sketch):

```typescript
// src/admin/validate.ts
export class AdminValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly code: ValidationCode,
  ) {
    super(genericMessageFor(code));   // no input value in message
  }
}

type ValidationCode =
  | "REQUIRED"
  | "TOO_LONG"
  | "TOO_SHORT"
  | "DISALLOWED_CHARS"
  | "INVALID_ENUM"
  | "UNKNOWN_FIELD"
  | "EMPTY_BODY"
  | "BAD_PATH";

function genericMessageFor(code: ValidationCode): string {
  switch (code) {
    case "REQUIRED":         return "field is required";
    case "TOO_LONG":         return "field exceeds maximum length";
    case "TOO_SHORT":        return "field is empty or below minimum length";
    case "DISALLOWED_CHARS": return "field contains disallowed characters";
    case "INVALID_ENUM":     return "field value is not in the allowed set";
    case "UNKNOWN_FIELD":    return "request contains unknown field";
    case "EMPTY_BODY":       return "request body has no fields to update";
    case "BAD_PATH":         return "malformed path parameter";
  }
}
```

**Handler emission**:

```typescript
} catch (err) {
  if (err instanceof AdminValidationError) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("INVALID_REQUEST", err.message, {
      field: err.field,
      request_id: ctx.requestId,
    })));
    return;
  }
  throw err;
}
```

**Test addition** (in `tests/integration/handle-admin-orgs.test.ts`):

```typescript
test("validation error does NOT echo input value", async () => {
  const res = await postOrg({ name: "<script>alert(1)</script>" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.message).not.toContain("<script>");
  expect(body.message).not.toContain("alert");
  expect(body.message).toBe("field contains disallowed characters");
  expect(body.details.field).toBe("name");
  expect(body.details.request_id).toMatch(/^[a-f0-9-]+$/);
});

test("empty string for name is rejected", async () => {
  const res = await postOrg({ name: "" });
  expect(res.status).toBe(400);
  expect((await res.json()).details.field).toBe("name");
});
```

---

## PATCH 12 — `role IN ('admin','member')`: SQL/prose consistency

**Supersedes**: V2 §Endpoints lines 114, 116, 132 — pin one consistent rule.

**Reason**: V2 mixes (a) `WHERE role IN ('admin','member')` in the SQL filter (excluding agent/service from the user list), (b) prose at line 116 "agent/service roles are mint-only; do not surface in the human-user admin UI", and (c) PATCH 409 NOT_HUMAN_USER triggered when target current role is `agent`/`service`. The 409 path implies an agent/service row CAN reach the handler — but the GET filter excludes them entirely. If a row's role mutates between the GET (filtered) and the PATCH (route-by-id), the PATCH currently has no explicit NOT_HUMAN_USER detection — V2 relies on the SQL guard's `AND role IN ('admin','member')` to silently skip.

**Decision**: SQL filter EXCLUDES agent/service from listings; handler EXPLICITLY checks via re-SELECT and returns 409 NOT_HUMAN_USER.

**New SQL** (replaces V2 line 114):

```sql
-- GET /api/admin/users  (filter unchanged from V2):
SELECT id, email, name, role, primary_org_id, created_at, last_login_at
FROM users
WHERE role IN ('admin','member')
  [AND primary_org_id = ?]
ORDER BY created_at ASC, id ASC
LIMIT 5000
```

**New handler logic** for PATCH (folded into PATCH 1's re-SELECT branch):

```typescript
// Inside the if (info.changes === 0) branch:
const current = db.prepare("SELECT role FROM users WHERE id = ?").get(targetId) as { role: string } | undefined;
if (!current) return { ok: false, status: 404, code: "NOT_FOUND" };

// Explicit NOT_HUMAN_USER check — handles the race where a row's role
// changed between client GET and PATCH.
if (current.role === "agent" || current.role === "service") {
  audit("admin.user.role_changed", {
    tier: 1,
    outcome: "denied",
    metadata: { target_user_id: targetId, role_before: current.role, role_after: newRole, denied_reason: "not_human_user" },
  });
  return { ok: false, status: 409, code: "NOT_HUMAN_USER" };
}

// current.role === 'admin' AND info.changes === 0 → admin-count guard tripped
// (see PATCH 1 for self_demotion vs last_admin dispatch)
```

**Anchor sentence** (add to V2 §Endpoints / PATCH users):

> The `WHERE role IN ('admin','member')` clause in BOTH the GET list query AND the PATCH UPDATE guard ensures agent/service rows are never surfaced and never mutated. The explicit re-SELECT branch handles the rare race where a row mutates between list and patch (e.g., a service account being created in another process) by returning 409 NOT_HUMAN_USER with an audit row.

---

## PATCH 13 — Stale-state UX: server returns fresh row, client `replaceChildren()`

**Supersedes**: V2 §Endpoints PATCH responses + V2 §Frontend (no explicit stale-state handling).

**Reason**: V2 defers ETag/If-Match (R5). Last-writer-wins is accepted. But the **client UX** isn't specified. Two admins editing the same org simultaneously: A's PATCH succeeds (using stable `id`); A's row in the table still shows the pre-B-rename stale name until manual refresh. Worse: A's name PATCH silently overwrites B's name PATCH with no warning. Cheap fix: server returns the fresh row in PATCH response (already does per V2 §Endpoints); client replaces the row DOM in place from that response, not from cache.

**New server behavior** (already mostly in V2; tighten the contract): every PATCH MUST return the full fresh row, not just the changed fields:

```typescript
// PATCH /api/admin/orgs/:id response:
{
  "org": {
    "id": "...",
    "name": "...",           // current value (may differ from request body if another writer won)
    "allowlist_github_org": "...",
    "allowlist_idp_org_id": "...",
    "updated_at": "2026-05-18 14:33:21"   // server timestamp
  }
}
```

(`updated_at` is fetched via SELECT after the UPDATE inside the tx — same statement that re-confirms the row exists. Schema may need an `updated_at TEXT` column on `orgs` and `users` if not present; if so, add to v0.10.6 schema migrations.)

**Schema addition** (if not already present) — add to V2 §Schema:

```sql
ALTER TABLE orgs ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
-- Triggers to bump updated_at on UPDATE:
CREATE TRIGGER IF NOT EXISTS orgs_updated_at AFTER UPDATE ON orgs
BEGIN UPDATE orgs SET updated_at = datetime('now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS users_updated_at AFTER UPDATE ON users
BEGIN UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id; END;
```

If schema additions are deemed too invasive for v0.10.6, defer the trigger (returned `updated_at` becomes the server's `new Date().toISOString()` at response time — still useful as a "freshness" indicator without table changes).

**New client behavior** (add to V2 §Frontend / Render states as new section "Mutation feedback"):

```javascript
// admin-orgs.js
async function savePatch(orgId, patch) {
  try {
    const res = await fetchJson(`/api/admin/orgs/${orgId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    // Replace the row's DOM in place from the server's fresh data.
    const row = document.querySelector(`tr[data-org-id="${orgId}"]`);
    const newRow = makeOrgRow(data.org);
    row.replaceWith(newRow);
    showToast({
      level: "success",
      text: t("toast.org_saved"),
      requestId: data.request_id,   // see PATCH 16
    });
  } catch (e) {
    if (e.code === "CONFLICT_ORG_NAME_TAKEN") {
      showInlineError(orgId, t("errors.name_taken"));
    } else {
      showToast({ level: "error", text: e.message, requestId: e.request_id });
    }
  }
}
```

**Anchor sentence**: 

> After every successful PATCH, the client replaces the corresponding row DOM in place from the server's fresh response (not from local cache). If two admins edit the same field within the same second, the second write wins silently — but the second admin sees the freshly-applied state in their own table immediately. Audit log is the forensic record (V2 §Threat model row "Concurrent PATCH on same org" — unchanged).

**Test addition** (in `tests/e2e/admin-ui.spec.ts`):

```typescript
test("concurrent rename: B's table reflects A's win after B's save", async ({ page, context }) => {
  // Setup: org "acme". Open two tabs (A, B). Both load orgs list.
  // A: rename to "acme-a", save → success.
  // B: rename to "acme-b", save → success.
  // After B's save, B's row MUST show "acme-b" (B's write won — last-writer-wins).
  // (For a stricter test, reverse: B PATCHes allowlist; expect B's row to show
  //  the post-A-rename "acme-a" name in the same response.)
});
```

---

## PATCH 14 — `admin_count` in `/api/admin/users` response envelope

**Supersedes**: V2 §Endpoints / GET users response (line 115) + V2 §Frontend / Last-admin UX (line 309).

**Reason**: V2's "banner renders when client-computed admin count == 1" is unsafe past LIMIT 5000 (admins in rows >5000 are invisible to the client; banner false-positives) and racy (between GET and PATCH, another admin could be demoted elsewhere). Cheap fix: server computes the authoritative count and includes it in the envelope. Client uses that as truth + proactively disables the demote `<option>` for the last admin's row.

**New response shape** for GET /api/admin/users:

```json
{
  "users": [
    { "id": "...", "email": "...", "role": "admin", ... }
  ],
  "meta": {
    "admin_count": 3,
    "truncated": false
  }
}
```

`admin_count` is `SELECT COUNT(*) FROM users WHERE role='admin'` — one extra query, no schema change. `truncated` is a bonus (set when the LIMIT 5000 was hit, even though V2 said no truncated flag — reconsider including it given the cheap addition; if rejected, remove from this PATCH).

**Decision on `truncated`**: include it. It costs one `if (users.length === 5000)` check and turns the silent ceiling-hit into a debuggable signal. (Soft contradiction with V2 Cut#4; documented here as a reversal.)

**New SQL** (in handler):

```typescript
const users = db.prepare(SQL_LIST_USERS).all(...args);
const adminCount = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get() as { n: number }).n;
res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
res.end(JSON.stringify({
  users,
  meta: { admin_count: adminCount, truncated: users.length === 5000 },
}));
```

**New client behavior** (replaces V2 §Frontend / Last-admin UX banner):

```javascript
// admin-users.js
function renderUsers(payload) {
  const { users, meta } = payload;
  const adminCount = meta.admin_count;

  // Banner: server-truth, not client-derived.
  if (adminCount === 1) {
    document.getElementById("banner").textContent = t("banner.single_admin");
    document.getElementById("banner").hidden = false;
  } else {
    document.getElementById("banner").hidden = true;
  }

  // Proactive disabled option: if single admin, the demote option on the
  // sole admin's row is disabled with a clear hint.
  const tbody = document.getElementById("users-tbody");
  tbody.replaceChildren(...users.map((u) =>
    makeUserRow(u, { adminCount })
  ));
}

function makeUserRow(user, { adminCount }) {
  const tr = document.createElement("tr");
  tr.dataset.userId = user.id;
  // ... email / org / name cells ...
  tr.appendChild(makeRoleCell(user, { adminCount }));
  return tr;
}

function makeRoleCell(user, { adminCount }) {
  const td = document.createElement("td");
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", `Role for ${user.email}`);
  for (const r of ["admin", "member"]) {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r;
    if (r === user.role) opt.selected = true;
    // Proactive disable: only admin in system, this row IS that admin, demote attempt.
    if (user.role === "admin" && adminCount === 1 && r === "member") {
      opt.disabled = true;
      opt.textContent = `${r} — would leave system without admin`;
    }
    sel.appendChild(opt);
  }
  td.appendChild(sel);
  return td;
}
```

**Test addition**:

```typescript
test("GET /api/admin/users response includes meta.admin_count", async () => {
  const res = await getUsers();
  const data = await res.json();
  expect(data.meta).toBeDefined();
  expect(typeof data.meta.admin_count).toBe("number");
  expect(data.meta.admin_count).toBeGreaterThanOrEqual(1);
});

test("e2e: single admin sees disabled demote option on own row", async ({ page }) => {
  // Seed: 1 admin only. Load admin-users.html.
  // Assert: the demote <option value="member"> on the admin row is disabled
  // AND the top banner is visible.
});
```

**Anchor sentence**: replace V2 §Frontend / Last-admin UX bullet:

> Top-of-page banner ("You are the only admin...") renders when `meta.admin_count === 1` from the GET /api/admin/users response. The demote `<option>` for the sole admin is rendered with `disabled` + a "would leave system without admin" suffix — discovery happens at hover/focus time, not at save-click time. Server 409 CONFLICT_LAST_ADMIN remains the TOCTOU backstop (PATCH 1).

---

## PATCH 15 — `renderTable` concrete example + ban `insertAdjacentHTML`

**Supersedes**: V2 §Frontend / DOM construction rules (lines 281-285).

**Reason**: V2 says `admin.js` provides `renderTable(rows, columns)` where `columns = [{ header, accessor }]`. Too thin: implementer reaches for `innerHTML` the moment they need a `<select><option>` inside a cell. The "static layout templates may use `innerHTML` with string literals only" loophole is exactly where template strings sneak back in. Need a concrete example + an explicit ban on `insertAdjacentHTML`.

**New code example** (add to V2 §DOM construction rules):

```javascript
// admin.js — canonical interactive-cell pattern (use this, NOT innerHTML)

export function renderTable(rows, columns) {
  const table = document.createElement("table");
  // header
  const thead = document.createElement("thead");
  const headerTr = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = col.header;
    headerTr.appendChild(th);
  }
  thead.appendChild(headerTr);
  table.appendChild(thead);
  // body
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    if (row.id) tr.dataset.id = row.id;
    for (const col of columns) {
      const td = document.createElement("td");
      const value = col.accessor(row);
      if (value instanceof Node) {
        td.appendChild(value);            // interactive cell
      } else {
        td.textContent = String(value);   // text-only — safe by default
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// Usage — role dropdown (returns a Node, not a string):
function roleColumn(adminCount, onChange) {
  return {
    header: t("col.role"),
    accessor: (user) => {
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", `Role for ${user.email}`);
      for (const r of ["admin", "member"]) {
        const opt = document.createElement("option");
        opt.value = r;
        opt.textContent = r;
        if (r === user.role) opt.selected = true;
        if (user.role === "admin" && adminCount === 1 && r === "member") {
          opt.disabled = true;
          opt.textContent = `${r} — would leave system without admin`;
        }
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => onChange(user.id, sel.value));
      return sel;
    },
  };
}
```

**Updated CI lint** (replaces V2 single grep with three):

```bash
# Ban non-literal innerHTML assignment
grep -nE '\.innerHTML\s*=\s*[^"`'"'"']' dashboard/public/admin*.js && exit 1 || true

# Ban backtick template strings in innerHTML
grep -nE '\.innerHTML\s*=\s*`' dashboard/public/admin*.js && exit 1 || true

# Ban insertAdjacentHTML entirely — bypasses the literal-only carve-out
grep -nE '\.insertAdjacentHTML\s*\(' dashboard/public/admin*.js && exit 1 || true
```

**Anchor sentence** (replaces V2 §DOM construction final bullet):

> `insertAdjacentHTML` is **banned outright** in `admin*.js`. The "static layout `innerHTML` with string literals only" carve-out applies only to one-shot replacement of a known empty tbody from a fresh API response — use `tbody.replaceChildren(...nodes)` instead. The CI lint above blocks the three escape hatches (non-literal innerHTML, template-string innerHTML, insertAdjacentHTML).

---

## PATCH 16 — `request_id` in error response envelope + toast

**Supersedes**: V2 §Frontend / Render states "Error" section (no `request_id`) + V2 error responses (no `request_id` field).

**Reason**: The audit table already records `request_id` per-event (via `withAuditContext`). The error envelope from `appError(code, message, details?)` can carry it. Without it, an operator who hits "Server error; contact ops" has no key to give the on-call engineer — they grep timestamps. For 409 LAST_ADMIN, the audit row exists but the operator can't tie "the moment I clicked Save" to that audit row. One line of plumbing, large operability win.

**New server behavior** — every `appError` call in admin handlers MUST include `request_id`:

```typescript
// Helper to make this less error-prone:
function adminError(ctx: AuthHandlerContext, code: string, message: string, extra?: Record<string, unknown>) {
  return appError(code, message, { ...extra, request_id: ctx.requestId });
}

// Usage:
res.end(JSON.stringify(adminError(ctx, "CONFLICT_LAST_ADMIN", "Cannot demote last admin. Promote another user first.")));
```

The `ctx.requestId` is already in async-context (set by the dispatcher); handlers read it from the `AuthHandlerContext`. If the field doesn't exist on the context type, add it (one-line type addition).

**New client behavior** (add to V2 §Frontend / Render states "Error"):

```javascript
// admin.js
function showToast({ level, text, requestId }) {
  const div = document.createElement("div");
  div.setAttribute("role", level === "error" ? "alert" : "status");
  div.setAttribute("aria-live", level === "error" ? "assertive" : "polite");
  div.className = `toast toast-${level}`;
  const msg = document.createElement("p");
  msg.textContent = text;
  div.appendChild(msg);
  if (requestId) {
    const req = document.createElement("p");
    req.className = "request-id";
    req.textContent = `Request: ${requestId}`;
    // Copy-to-clipboard button
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", `Copy request ID ${requestId}`);
    btn.textContent = "Copy";
    btn.addEventListener("click", () => navigator.clipboard.writeText(requestId));
    req.appendChild(btn);
    div.appendChild(req);
  }
  document.getElementById("toasts").appendChild(div);
  setTimeout(() => div.remove(), 8000);
}
```

**Test addition**:

```typescript
test("error response envelope includes request_id", async () => {
  const res = await postOrg({ name: "" });   // triggers 400
  const body = await res.json();
  expect(body.details.request_id).toMatch(/^[a-f0-9-]+$/);
});
```

---

## PATCH 17 — Minor tightening: responsive lower bound, slow-fetch, empty-state copy, idp_provider non-goal, parameterized-path 404, LIMIT 5000 rationale

**Supersedes**: V2 various — small additions deferred from R2 frontend findings #7/#8/#9, api findings #F3/#F5/#F6.

**Reason**: These are one-paragraph or one-sentence additions that don't justify their own PATCH but collectively close the remaining R2 nits.

**17a — Responsive lower bound + zoom** (add to V2 §Responsive after the ≤768px bullet):

> Supported viewports: **320px–∞ wide**. Three breakpoints: ≥1024px (full table), 768–1023px (table with reduced padding), <768px (card list). Card list mode tested at 320px with longest realistic content (200-codepoint name). Text supports up to **200% zoom** per WCAG 1.4.4 — no overflow truncation that hides text. Long names wrap with `overflow-wrap: anywhere`. Axe-core scan includes `color-contrast` and `target-size` rules explicitly (they're in axe-core's `best-practice` tag, easy to miss in default config).

**17b — Slow-fetch timeout + skeleton location** (add to V2 §Render states "Loading"):

> Skeleton lives in the HTML — each table ships with 3 hardcoded skeleton `<tr aria-hidden="true">` rows under `<tbody data-state="loading">`. CSS-only shimmer animation (no JS). On fetch complete, `tbody.replaceChildren(...rows)` swaps the skeleton out (this is the **one** permitted innerHTML-equivalent site — but `replaceChildren()` avoids the loophole). For slow fetch: **10-second client timeout** via `AbortController`; on abort, render error state with retry button.

```javascript
async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
```

**17c — Empty-state copy for missing org / zero orgs** (refines V2 §Render states "Empty"):

> Users empty state copy: "**No users in this org (or org no longer exists).**" — handles both the legitimate-empty case and the org-deleted-elsewhere case without an extra cross-validate query. On the users page, if the orgs list (loaded once at page init for the filter dropdown) is empty, hide the org filter entirely and show banner "Create an org first" linking to `/dashboard/admin-orgs.html`.

**17d — `idp_provider` / `idp_org_id` exclusion** (add one sentence to V2 §Endpoints and V2 §Non-goals):

> **§Endpoints**: The `orgs` table also has legacy `idp_provider` and `idp_org_id` columns; the admin UI deliberately does NOT expose or modify them (they predate the allowlist machinery and changing them requires understanding existing IdP wiring out of scope for v0.10.6).
>
> **§Non-goals**: Editing `orgs.idp_provider` / `orgs.idp_org_id` via the admin UI. Defer to v0.11.0 alongside org delete + cascade decisions.

**17e — Parameterized-path 404-not-405** (add one sentence to V2 §Route wiring):

> Note: parameterized paths (`/api/admin/orgs/:id`, `/api/admin/users/:id`) are NOT added to `KNOWN_AUTH_PATHS` — methods other than PATCH on those paths will 404 (not 405). This matches the existing service-tokens revoke precedent at `src/http/auth-routes.ts:111-113` and is an accepted trade-off.

**17f — `LIMIT 5000` rationale** (add one sentence to V2 §Endpoints after the SQL):

> The 5000 ceiling is a read-path cap; there is no existing precedent in the codebase (the sweeper uses `LIMIT 1000` for batch idiom). 5000 was chosen as 50× the sweeper batch — a deployment hitting it is obviously pathological and should narrow via `?org=`. The new `meta.truncated` boolean (PATCH 14) surfaces the ceiling hit without breaking response shape.

---

## PATCH 18 — `STRINGS` table for centralized copy (future i18n)

**Supersedes**: V2 §Frontend — adds centralized string table.

**Reason**: V2 accepts English-only for v0.10.6 (Non-goal #i18n). But scattered strings across 7 files means future i18n is a 2-week refactor; a centralized table makes it a 2-day swap. Zero cost today.

**New module** — add to `dashboard/public/admin.js`:

```javascript
// admin.js — centralized strings (single source of truth; future i18n swap)
export const STRINGS = {
  banner: {
    single_admin: "You are the only admin. Promote another user before demoting yourself.",
  },
  errors: {
    csrf_missing: "Session expired. Reload the page.",
    last_admin: "Cannot demote last admin. Promote another user first.",
    self_demotion: "You are the only admin. Promote another user first.",
    not_human_user: "Cannot change role of non-human user.",
    name_taken: "An org with this name already exists.",
    network: "Check your connection.",
    server: "Server error; contact ops.",
    validation_generic: "Please correct the highlighted fields.",
  },
  confirms: {
    demote_role: "Demote {email} from admin to member?",
    clear_allowlist: "Clear allowlist for {org_name}? Users may lose access.",
  },
  empty: {
    orgs: "No orgs yet.",
    users: "No users in this org (or org no longer exists).",
  },
  toast: {
    org_saved: "Org saved",
    role_saved: "Role changed",
  },
  col: {
    role: "Role",
    email: "Email",
    name: "Name",
    org: "Org",
    created_at: "Created",
    last_login_at: "Last login",
    allowlist_github_org: "GitHub org allowlist",
    allowlist_idp_org_id: "IdP org allowlist",
  },
  cta: {
    create_first_org: "Create your first org",
    create_org: "New org",
    save: "Save",
    cancel: "Cancel",
    confirm: "Confirm",
    retry: "Retry",
  },
};

export function t(path, vars) {
  const value = path.split(".").reduce((o, k) => (o ? o[k] : undefined), STRINGS);
  if (typeof value !== "string") return `[missing: ${path}]`;
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}
```

**Usage** (in `admin-orgs.js`):

```javascript
import { t } from "./admin.js";
showToast({ level: "success", text: t("toast.org_saved") });
confirmDialog.textContent = t("confirms.demote_role", { email: user.email });
```

**Anchor sentence** (add to V2 §Frontend):

> All user-facing strings live in `STRINGS` in `admin.js`. Modules import `t(path, vars?)` for lookup with `{placeholder}` substitution. **English-only for v0.10.6**; future i18n = swap the table (no code changes). Lint: any string literal in JSX/HTML output paths in `admin-*.js` is a code-review smell — should be a `t('...')` call instead.

---

## Summary of changes from V2

| Area | V2 | V3 |
|---|---|---|
| Last-admin SQL guard | 3 OR-clauses (third one DEAD — re-opens lockout) | **2 clauses** (promote OR count>1) — server invariant only |
| `db.transaction` invocation | `.transaction(fn)()` (deferred) in snippet | **`.transaction(fn).immediate()`** — non-optional |
| `TIER1_EVENTS` registration | Implicit | **Explicit edit** to `src/security/audit-events.ts:14-36` + test |
| Per-IP rate limit scope | All `/api/admin/*` | **Mutations only**; GETs unlimited |
| `BEGIN IMMEDIATE` UX wording | Implies TOCTOU window | Clarifies serialization; adds SQLITE_BUSY → 503 mapping |
| ACAO drop scope | "for HTML responses (admin pages and index.html)" | **Admin pages only** via explicit URL regex |
| CSP scope | Same wording | **Admin pages only**; index.html explicitly preserved |
| Frontend file count | 5 files | **8 files** (3 HTML + 4 JS + 1 CSS) |
| `readCsrfToken` on missing cookie | `throw` | **Return null** + `redirectToLogin()` flow |
| UNIQUE INDEX migration on dupes | "Boot aborts; runbook required" | **Pre-flight boot guard** with named-row error |
| Validation error messages | No echo rule specified | **MUST NOT echo input**; generic phrasing; `request_id` |
| Empty string in `name` field | Implicit via length rule | **Explicit row** in validation table |
| `role IN (...)` consistency | Mixed across SQL and prose | **Pinned**: SQL excludes agent/service; handler explicit NOT_HUMAN_USER |
| Stale-state UX after concurrent edits | Undefined | **Server returns fresh row**; client `replaceChildren()` |
| `admin_count` source | Client-derived from possibly-truncated list | **Server-truth** in `meta.admin_count` envelope |
| Last-admin demote `<option>` | Disabled only after server 409 | **Proactively disabled** for single-admin row |
| `renderTable` interactive cells | Hand-waved | **Concrete `makeRoleCell` example** + ban `insertAdjacentHTML` |
| `request_id` in error responses | Absent | **Required** in every error envelope + toast |
| `LIMIT 5000` truncated signal | "No `truncated` flag" (Cut#4) | **Reversed**: `meta.truncated` boolean added |
| Responsive lower bound | ≤768px stated; <768 undefined | **320px lower bound** + 200% zoom rule + axe color-contrast/target-size |
| Skeleton location + slow-fetch | Undefined | **Pre-rendered HTML skeleton** + 10s `AbortController` |
| Empty-state copy (users) | "No users match this filter" | "No users in this org (or org no longer exists)" |
| `idp_provider` / `idp_org_id` exposure | Implicit non-goal | **Explicit non-goal** entry |
| Parameterized path 404-vs-405 | Not noted | **Explicit acknowledgment** (matches existing precedent) |
| `LIMIT 5000` rationale | "Match existing similar caps" (false) | **"50× sweeper batch; pathological if hit"** |
| Strings | Scattered across files | **Centralized `STRINGS` + `t()`** for future i18n |

## Implementation order impact

V3 patches make several touched files larger and a few signatures load-bearing. Implementation plan must:

1. Add `admin.org.created` / `admin.org.updated` / `admin.user.role_changed` to `TIER1_EVENTS` in `src/security/audit-events.ts` — atomic, first task (no dependencies).
2. Add pre-flight org-name duplicate guard + UNIQUE INDEX to `src/database.ts` migration block — second task (blocks any code that assumes the index).
3. Schema additions for `updated_at` column + triggers (PATCH 13) — third task if accepted; defer if rejected.
4. `src/admin/validate.ts` + `AdminValidationError` with code-only constructors — before handlers (handlers depend on it).
5. `src/admin/handle-admin-orgs.ts` + `src/admin/handle-admin-users.ts` — main handler logic with PATCH 1, 2, 4, 5, 11, 12, 14, 16.
6. `src/serve-http.ts:449` amendment (PATCH 6 + 7) — small, can land independently.
7. `dashboard/public/admin*.{html,js,css}` × 8 files (PATCH 8, 9, 13, 14, 15, 16, 17, 18) — frontend, last (depends on server endpoints).
8. Tests interleaved per task (no separate test-only PR).

Plan task count: ~14-18 atomic tasks across 3 PRs. Detailed plan to follow.

## Round 3 needed?

**NO.** Reasoning (see also synthesis doc):

- V2's architecture survives R2 unchanged. All 26 R2 findings are mechanical / scope-tightening / UX-precision — no architectural rework.
- V3 patches are localized (18 patches, each a textual delta against an enumerated V2 section). Auditable.
- Two genuine bugs (last-admin dead OR-clause, deferred-vs-immediate tx) are mechanical fixes; reviewers spotted them clearly and the fixes are unambiguous.
- All three R2 reviewers recommended ACCEPT / APPROVE-WITH-NITS / MINOR-CONCERNS. None flagged "another design round needed".
- Remaining risk lives at the implementation-plan layer (file ordering, LOC budgets, task atomicity, coverage matrix) — caught by plan review (Round 1 plan).
- Skipping R3 saves ~2-3 hours and ~200k tokens; matches v0.10.5 cadence which also stopped at R2 → V3 patches → plan → implementation.

If plan review (next step) surfaces V3-architectural concerns, revisit the spec. Otherwise: plan → implement.
