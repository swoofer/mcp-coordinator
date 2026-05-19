# Round 2 review — Frontend / a11y / UX (admin UI V2)

**Verdict**: APPROVE-WITH-NITS

V2 is a substantial step forward on the frontend axis. The 3-file split is justified, day-1 JS extraction closes the CSP gap, the staging-save pattern (D16) is the right call, and the a11y/responsive/contrast sections actually exist now where V1 hand-waved them. The findings below are mostly precision gaps in the V2 prose — most are fixable with one-paragraph edits, not architectural rework. One UX hole (proactive 409 visibility for last-admin) and one CSP/existing-page contradiction (index.html still uses inline `onclick` + `innerHTML` everywhere) deserve explicit attention before implementation.

Files inspected:
- `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\specs\2026-05-18-admin-ui-design.md`
- `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\v0.10.6-admin-ui\round1\00-SYNTHESIS.md`
- `C:\Users\gagno\projet\mcp-coordinator-new\dashboard\public\index.html` (lines 1-80, 177-1199 inline JS surface)

## Findings

### 1. CSP scope must be admin-only; the spec leaves index.html's fate ambiguous — MAJOR

**Description**: D7 says CSP applies "for paths matching `^/dashboard/admin(-orgs|-users)?\.html$`" — good, that's scoped. But the spec is silent on what happens to `dashboard/public/index.html` under the same handler. `index.html` is built almost entirely around inline JS (line 237 `<script>` block runs ~960 lines), inline `onclick=` handlers (lines 177, 190, 191, 583), and pervasive `innerHTML` for HTML-string interpolation with user data (lines 347, 548, 717, 729, 855, 877-878, 898, 926, 934, 954, 1006, 1081-1166). If V2's CSP regex accidentally catches index.html (e.g., somebody later loosens the regex), the existing dashboard breaks instantly. Conversely, if reviewers read D7's "for HTML responses (admin pages and `index.html`)" line under §Static file serving point 1 (which removes ACAO from *both*) and assume index.html also gets the CSP, they'll be wrong. The spec mixes the two scopes in adjacent bullets.

**Recommendation**: Add one sentence to D7: *"The CSP/X-Frame-Options/Referrer-Policy block is gated on the admin-path regex above; `index.html` keeps its current behavior (no CSP) and is explicitly out of scope for v0.10.6. ACAO removal applies to all HTML."* Also pin the regex test: `^/dashboard/admin\.html$` OR `^/dashboard/admin-(orgs|users)\.html$` — the current `admin(-orgs|-users)?\.html` matches `admin.html`, `admin-orgs.html`, `admin-users.html` but not `admin-orgs-foo.html` if added later, which is fine; document this.

### 2. The spec's own JS-loading pattern contradicts itself mid-paragraph — MODERATE

**Description**: Under §Frontend → "File layout (D8)", the spec lists 5 files (admin.html / admin-orgs.html / admin-users.html / admin.js / admin.css). Then the next paragraph says: *"each page also loads its specific bootstrap as a separate file (`admin-orgs.js`, `admin-users.js`) — keeps `script-src 'self'` strict."* So the file list is wrong: there are actually 6 or 7 files (admin.js + admin-orgs.js + admin-users.js, plus optionally admin-index.js for the landing page links). The "wait, that's inline JS again" prose mid-paragraph reads like an unfinished thought — the author caught themselves but didn't fix the file table. This will trip the implementer.

**Recommendation**: Replace the inline correction with a clean final layout:
```
admin.html       — landing (links + email + Logout). Loads admin.js + admin-index.js
admin-orgs.html  — Loads admin.js + admin-orgs.js
admin-users.html — Loads admin.js + admin-users.js
admin.js         — shared helpers (csrf, fetchJson, escape, renderTable, toast, dialog wiring)
admin-index.js   — landing bootstrap (fetch /api/auth/me for email; wire logout)
admin-orgs.js    — orgs page bootstrap
admin-users.js   — users page bootstrap
admin.css        — shared styles
```
That's 8 files total, all served with `script-src 'self'`. The "5 static files" tally in §Scope summary and §What was cut needs updating to match.

### 3. Stale-state concurrent edits (org renamed mid-edit) have no client UX — MODERATE

**Description**: The spec defers `If-Match`/ETag (R5, S14) and accepts last-writer-wins. That's reasonable for org *name/allowlist* edits. But the user-facing failure mode isn't specified. Scenario: Admin A opens admin-orgs.html, sees org "acme" at row position 3. Admin B simultaneously renames "acme" → "acme-prod" and saves. Admin A then patches allowlist on what they still see as "acme" (using the stable `id`, so the PATCH *succeeds*) — and the success toast says "Saved" but the row in A's table still shows the stale name "acme" until refresh. Worse, if A *also* tried to PATCH the name to "acme-v2", the PATCH succeeds (last-writer-wins) silently overwriting B's rename with no warning. The spec's threat model row "Concurrent PATCH on same org" lists this as accepted, but the *frontend* spec doesn't describe what the operator sees.

**Recommendation**: Add to §Render states or §Last-admin UX (rename it to "Mutation feedback"): after every successful PATCH, the server response carries the fresh row; replace the table row's DOM in place from that response (don't trust the local cache). For added safety, the toast can carry a 30-second auto-refresh option: `[Refresh table]`. This costs zero backend code (response already returns the row per §Endpoints) and closes 80% of the stale-UI surprise. Document explicitly: "No optimistic-concurrency check; if two admins edit the same field within the same second, the second write wins silently. Audit log is the recovery record."

### 4. Last-admin pre-emptive banner needs server-truth, not client-counted — MODERATE

**Description**: D16 says *"Top-of-page banner ('You are the only admin…') renders when client-computed admin count == 1."* The client computes this from `GET /api/admin/users` — but that endpoint has `LIMIT 5000`, filters to `role IN ('admin','member')`, and isn't ordered to put admins first. In a deployment with >5000 users, admins past row 5000 are invisible to the client, and the banner could fire false-positive ("you are the only admin!") when there are actually 3 admins, two of which fell off the limit. Even at <5000 users the count is *eventually consistent*: between the GET and the PATCH-save click, another admin could be demoted elsewhere, and the staging UX gives no proactive signal of the resulting 409.

Additionally, the user only discovers `CONFLICT_LAST_ADMIN` *after* clicking Save (current spec). The reviewer prompt asks specifically about proactive discovery.

**Recommendation**: Two-part fix:
- (a) Add a cheap server endpoint or include `admin_count` in the existing `GET /api/admin/users` response envelope: `{ users: [...], meta: { admin_count: N } }`. Counts via `SELECT COUNT(*) FROM users WHERE role='admin'` — one extra query, no schema change. Client banner reads `meta.admin_count`, not derived from the (possibly truncated) `users` array.
- (b) For proactive 409 visibility: when `admin_count === 1` AND the user is viewing their own row OR a row currently set to `admin`, *disable* the demote option in the `<select>` (`<option disabled>member — would leave system without admin</option>`) and surface a small inline hint. Discovery happens at hover/focus time, not save time. Keep the server 409 as backstop for the race (TOCTOU is already covered by D9).

### 5. Pure `textContent` mandate is correct but renderTable spec is too thin — MODERATE

**Description**: §DOM construction rules says *"`admin.js` provides `renderTable(rows, columns)` where `columns` is `[{ header, accessor }]`"*. The CI grep `\.innerHTML\s*=\s*[^"'``]` (rejects non-literal innerHTML) is good. But the spec doesn't show how interactive cells (the role `<select>`, the per-row Save `<button>`, the inline-edit field for allowlist) are constructed. An implementer following only what's written will reach for innerHTML the moment they need to wire `<select><option>admin</option><option>member</option></select>` into a cell. The "may use innerHTML with string literals only" loophole is the exact loophole that lets `\`<select>${row.role === 'admin' ? 'selected' : ''}\``-style template strings creep back in.

**Recommendation**: Add a concrete example to the spec (10-15 lines):
```javascript
// admin.js — RIGHT
function makeRoleCell(user, onChange) {
  const td = document.createElement('td');
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', `Role for ${user.email}`);  // SR label uses email, not name
  for (const r of ['admin', 'member']) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    if (r === user.role) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  td.appendChild(sel);
  return td;
}
```
And add to the lint rule: also grep for backtick template strings inside `.innerHTML` assignment OR `insertAdjacentHTML` calls. Ban `insertAdjacentHTML` outright in admin*.js — it bypasses the literal-only carve-out.

### 6. Error toast / inline error lacks `request_id` for cross-referencing audit — MINOR

**Description**: §Render states "Error" mentions `role="alert"`, a retry button, and a "Check your connection" vs "Server error; contact ops" distinction. None of these surface the `request_id`. The audit table already records `request_id` per-event (auto-captured from `withAuditContext`), and the JSON envelope from `appError(code, message, details?)` could carry it in the response body. Without `request_id` shown in the toast, an operator who hits "Server error; contact ops" has no way to give ops a search key — they'd have to grep timestamps. Same problem for 409 CONFLICT_LAST_ADMIN: the audit row recording the denied attempt has a `request_id` that the operator can't see, so the audit log review later can't be tied back to "the moment I clicked Save and got the red box."

**Recommendation**: 
- Server: include `request_id` in every error response envelope: `appError("CONFLICT_LAST_ADMIN", "...", { field: ..., request_id: ctx.requestId })`. (`request_id` is already in async-context.)
- Client: toast and inline error render a small monospace `Request: 7f3a-…` line below the message, with a copy-to-clipboard icon. SR text: `aria-label="Copy request ID 7f3a..."`. This is one extra string per error and an enormous quality-of-life win for the ops/dev split the spec already assumes (per R8 rationale).

### 7. Responsive lower bound not specified; <320px and zoom 400% behavior undefined — MINOR

**Description**: §Responsive (S10) says *"≤768px: tables collapse to card lists ... Tap targets ≥44×44px"* and *"Default desktop ≥1024px"*. Two gaps: (a) what about 769-1023px (large tablet / small laptop)? The current rules imply "desktop table layout", which works visually but the prose doesn't confirm. (b) No explicit minimum width. WCAG 1.4.10 (Reflow) requires content to be usable at 320 CSS px without horizontal scroll. The org name field can legitimately hold 200 codepoints, and a 200-char allowlist column on a 320px viewport without horizontal scroll requires wrapping or truncation rules. Not specified. (c) WCAG 1.4.4 (Resize text) — 200% zoom. With the dark theme using small font sizes (the existing index.html uses 10-13px throughout), 200% zoom can blow tap targets out of cards.

**Recommendation**: One paragraph addition:
- "Supported viewports: 320px–∞ wide. Three breakpoints: ≥1024px (table), 768–1023px (table with reduced padding), <768px (card list). Card list mode tested at 320px with longest realistic content (200-codepoint name)."
- "Text resize up to 200% per WCAG 1.4.4 — no overflow truncation that hides text. Long names wrap with `overflow-wrap: anywhere`."
- Add to axe-core scan: include `color-contrast` and `target-size` rules explicitly (they're in axe-core's `best-practice` tag, not `wcag2aa` — easy miss).

### 8. Loading state on first paint: blocking fetch vs prerendered skeleton — MINOR

**Description**: §Render states says "Loading: skeleton rows + 'Loading…' placeholder (uses `aria-busy="true"`)." Good. But the spec doesn't say *where the skeleton lives*. Two implementations are possible: (a) HTML ships with empty `<table><tbody></tbody></table>`; admin-orgs.js fetches, populates tbody — first paint shows empty page for ~50-200ms (RTT). (b) HTML ships with N skeleton rows hardcoded (e.g., 3 shimmering placeholder `<tr>`s); admin-orgs.js replaces tbody on fetch complete — first paint shows skeleton immediately. The latter is materially better for perceived performance, especially on cold-cache first navigation, but the spec doesn't pick.

Also missing: behavior when fetch is slow (>2s). Spinner? Progressive disclosure? After 5s timeout? The current spec implies "wait forever".

**Recommendation**: Pick (b) — ship 3 hardcoded skeleton `<tr aria-hidden="true">` rows in the HTML inside `<tbody data-state="loading">`. Hardcode CSS shimmer animation (CSS-only, no JS). On fetch complete, replace innerHTML of the tbody with the rendered rows (this is the *one* permitted innerHTML site per the lint rule — wrap in a `replaceChildren()` API instead to avoid the loophole). For slow-fetch: 10-second client timeout on `fetch()` (`AbortController`), then render error state with retry button. Specify in spec.

### 9. Empty state for "zero users in selected org filter" needs distinct copy — MINOR

**Description**: §Render states says: *"Empty: CTA card. Orgs: 'No orgs yet. [Create your first org]'. Users: 'No users match this filter.'"* The users empty state is good for "I filtered by org X and there are no users" but ambiguous for "I picked org X but org X doesn't exist anymore (404)" — currently the spec doesn't say what `GET /api/admin/users?org=missing` returns. Looking at §Endpoint 4: "validated against `/^[A-Za-z0-9_-]{1,64}$/`" then `WHERE primary_org_id = ?`. So a syntactically valid but non-existent org_id returns `200 { "users": [] }`, indistinguishable from "valid org, zero users". The UI shows "No users match this filter" — confusing if the operator just deleted the org from another tab.

**Recommendation**: Either (a) cross-validate `?org=` against the orgs table and return 404 on missing — at the cost of one extra SELECT — and have the client render "Org no longer exists. [Pick another]"; or (b) keep current behavior and tweak empty state copy: "No users in this org (or org no longer exists)." Option (b) is cheaper and consistent with "operators are trusted."

Also: zero-orgs empty state should NOT show the org filter dropdown on admin-users.html (the filter would be empty), but spec doesn't say. Hide filter when orgs list is empty; show banner "Create an org first" linking to admin-orgs.html.

### 10. i18n non-goal accepted, but spec doesn't centralize strings for future extraction — MINOR

**Description**: §Non-goals lists i18n as deferred ("English-only by design"). S12 in synthesis acknowledges the same. Fine. But the V2 spec doesn't say *where* the user-facing strings live. If they're scattered across admin.js + admin-orgs.js + admin-users.js + inline in HTML templates, future i18n extraction is a 2-week refactor. If they're centralized in a single `STRINGS` object in admin.js from day 1, future i18n is a 2-day swap. Cost difference: zero today, large later.

**Recommendation**: Add one paragraph to §Frontend:
```javascript
// admin.js
const STRINGS = {
  errors: {
    csrf_missing: "Session expired. Reload the page.",
    last_admin: "Cannot demote last admin. Promote another user first.",
    self_demotion: "You are the only admin. Promote another user first.",
    network: "Check your connection.",
    server: "Server error; contact ops. Request: {request_id}",
    // ...
  },
  confirms: {
    demote_role: "Demote {email} from admin to member?",
    clear_allowlist: "Clear allowlist for {org_name}? Users may lose access.",
  },
  empty: { orgs: "No orgs yet.", users: "No users match this filter." },
  // ...
};
function t(path, vars) { /* dotted lookup + {placeholder} substitution */ }
```
All UI strings reference `t('errors.last_admin')` etc. Zero runtime overhead, free option-value later. Document: "Single string table, English-only for v0.10.6. Future i18n = swap the table."

## Summary table

| # | Severity | Area | Fix size |
|---|---|---|---|
| 1 | MAJOR | CSP scope vs index.html | 2-line spec addition + path regex pin |
| 2 | MODERATE | File-layout self-contradiction | Rewrite §File layout (D8) cleanly; update scope summary |
| 3 | MODERATE | Stale-state UX after concurrent edits | Spec addition: "replace row from PATCH response" |
| 4 | MODERATE | Proactive 409 visibility for last-admin | Add `admin_count` to `/users` response; disable `<option>` proactively |
| 5 | MODERATE | renderTable interactive-cell example | Add ~15-line concrete example + ban `insertAdjacentHTML` |
| 6 | MINOR | request_id in error toast/inline | Add to error envelope + render in toast |
| 7 | MINOR | Responsive min-width / zoom undefined | 1-paragraph addition (320px lower bound, 200% zoom) |
| 8 | MINOR | First-paint skeleton location + slow-fetch timeout | Spec picks pre-rendered skeleton + 10s AbortController |
| 9 | MINOR | Empty-state copy for missing-org / zero-orgs | Tweak copy + hide filter when zero orgs |
| 10 | MINOR | Strings not centralized for future i18n | Add `STRINGS` table pattern to admin.js |

**Recommendation**: APPROVE-WITH-NITS. Findings 1, 2, 3, 4 should be addressed in the spec before implementation (they affect either security-adjacent scope or first-day UX). Findings 5-10 can be folded in during implementation or as a single V3 patch. None of these block the architecture.
