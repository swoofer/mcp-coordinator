# Round 1 review — Edge cases

**Reviewer lens**: weird states, race conditions, "what if" scenarios
**Spec under review**: docs/superpowers/specs/2026-05-18-admin-ui-design.md
**Overall verdict**: GAPS-EXIST

The endpoint surface is small (5 routes) and the auth/CSRF/rate-limit primitives all already exist in the codebase — that's the low-architectural-risk story. The gaps are concentrated where the spec waves its hands: input validation ("no control bytes" leaves emoji/ZWJ/RTL/case/length-unit policy undefined), concurrency (last-admin protection, concurrent PATCH on the same org, audit-vs-commit ordering), and the boundary between the schema as written and the spec's assumed shape (the schema has `role IN {agent, admin, member, service}`, `primary_org_id NOT NULL`, and **no UNIQUE on `orgs.name`** — the spec's 409 path is racy). A handful of these are CRITICAL-by-default (last-admin TOCTOU, audit-without-commit) and should be addressed before the spec is implementation-frozen.

The spec also under-specifies behavior at exactly the boundary you have to get right: every `PATCH` body parse. JSON `null` vs missing field vs string is not enumerated. Extra unknown fields are not addressed. Case-sensitivity of `role` is silent. The "actor can demote anyone except the last admin" check is described as a target check; the actor-side TOCTOU (self vs. other) is not.

## Edge cases

### 1. Last-admin TOCTOU between two parallel demotions — CRITICAL
**Steps**:
1. The system has exactly two admins, Alice (`u-A`) and Bob (`u-B`).
2. Carol (a third admin, freshly added moments earlier) is being concurrently demoted by another tab. There are momentarily three admin rows.
3. Two requests arrive within ~1ms: (a) PATCH `/api/admin/users/u-A` `{"role":"member"}` from Bob; (b) PATCH `/api/admin/users/u-B` `{"role":"member"}` from Alice.
4. Each handler runs the spec's "last-admin protection": `SELECT COUNT(*) FROM users WHERE role = 'admin'` returns **2** for both. Neither hits the `count == 1 AND target is that admin` condition.
5. Both UPDATEs commit. `COUNT = 0`. **Zero admins remain. System is locked out.**

**What goes wrong**: The protection is a non-atomic check-then-act on a *count*, not a constraint. SQLite WAL mode serializes writers, but each `UPDATE` runs in its own implicit tx; the protective SELECT runs in a separate snapshot. The spec says "in a transaction" generically (§Architecture step 6) but doesn't specify isolation level or lock acquisition. With `better-sqlite3` defaults, both txs see the same pre-state and both UPDATEs succeed.

**Recommendation**: Either (a) wrap the SELECT + UPDATE in a single `BEGIN IMMEDIATE` tx so the second writer blocks until the first commits and re-reads the post-state count, then run the protection check inside the tx; or (b) move the invariant to a partial UNIQUE INDEX / trigger: `CREATE TRIGGER prevent_zero_admins BEFORE UPDATE ON users WHEN OLD.role='admin' AND NEW.role<>'admin' AND (SELECT COUNT(*) FROM users WHERE role='admin') <= 1 BEGIN SELECT RAISE(ABORT, 'last_admin'); END`. Add a concurrency test that spawns two parallel demotion requests and asserts exactly one succeeds and one returns 409.

### 2. Last-admin protection does not check the actor — CRITICAL
**Steps**:
1. System has one admin: Alice. Alice opens admin.html in two tabs.
2. Tab 1: Alice PATCHes herself: `/api/admin/users/u-Alice` `{"role":"member"}`. Spec's check fires: `count=1 AND target=u-Alice AND target.role='admin'` → 409. Good.
3. The spec's check is described as a **target-side** check. But consider: what if Alice promotes Bob (`u-B`) to admin in tab 2 (`/api/admin/users/u-B` `{"role":"admin"}`) and then in tab 1 still tries to demote herself before Bob's promotion commits?
4. Bob's promotion arrives first (`count` becomes 2). Alice's self-demotion arrives second (`count=2`, target is Alice, check passes). Alice is now a member; Bob is the only admin.

**What goes wrong**: That's actually the intended flow ("promote another first, then demote yourself"). The bug surface is the *inverse*: the spec doesn't say "you cannot demote yourself even when other admins exist". Some operators expect that as a footgun-guard. Worse, the spec does not specify whether `actor_user_id === target_user_id` self-demotion via direct API call should be allowed at all — does the UI flow ever exercise it? Mention it explicitly.

**Recommendation**: Spec must explicitly state: "self-demotion is allowed when other admins exist; the last-admin check is purely numeric and applies regardless of actor identity." OR: "self-demotion is refused with 409 `self_demotion_requires_other_actor`." Pick one. Add a unit test for each branch. Either policy is defensible; silence is a bug.

### 3. Concurrent PATCH on the same org — last-writer-wins, no version check — MAJOR
**Steps**:
1. Two admins, Alice and Bob, both load admin.html. Both see `org o-1` with `allowlist_github_org = "acme-corp"`.
2. Alice edits to `"acme-new"` and saves.
3. Bob (still on the stale view) edits to `"acme-old"` and saves 200ms later.
4. Both PATCHes succeed. Final state: `"acme-old"`. Alice's change is silently overwritten; she sees her toast confirmed.

**What goes wrong**: Standard last-writer-wins. The audit log captures both, so forensically recoverable — but the operator UX is "I changed it, then it changed back, and nobody told me." The spec's "Replay attack on PATCH" mitigation in the Threat model claims "idempotent semantics (PATCH the same body twice → same final state)" — but two *different* PATCHes from two *different* operators are not idempotent.

**Recommendation**: Either (a) add an `ETag` / `If-Match` header — GET returns `ETag: <hash(name|gh|idp)>`, PATCH requires matching `If-Match`; on mismatch return 412 with current state. Small implementation cost, eliminates the silent-overwrite class. OR (b) explicitly accept the risk in §Risks accepted: "Two admins editing the same org concurrently → last writer wins. Audit log is the recovery mechanism." Don't leave it implicit.

### 4. Audit emission vs DB commit ordering — race window in both directions — CRITICAL
**Steps**:
1. Spec §Architecture step 6 → "perform DB op in a transaction", step 7 → "emit Tier 1 audit". Two failure modes:

   **Mode A — audit-after-commit** (spec's literal order): DB UPDATE commits; process is `SIGKILL`'d before `audit()` is called. The org now has a new allowlist but no audit row was written. **Change-without-audit** — the exact gap the spec is designed to close.

   **Mode B — audit-before-commit** (if implementer reverses for "safer to over-log"): `audit()` writes its row (Tier 1 is a *separate* INSERT, per `src/security/audit.ts:107-110`); then the org UPDATE tx fails (CHECK constraint, FK constraint, busy timeout). **Audit-without-change** — operators investigating an incident see "Alice updated org X" but the org never actually changed.

2. Both modes are reproducible: Mode A by killing the process post-commit-pre-audit; Mode B by holding a write lock on `orgs` while the audit fires.

**What goes wrong**: The spec treats audit emission as if it were part of the same atomic unit as the mutation. It isn't — `audit()` writes to `audit_log` in a separate prepared statement, even in the Tier 1 sync path. SQLite gives you per-statement atomicity, not multi-statement atomicity, unless the caller opens a tx.

**Recommendation**: Spec must mandate **both** the mutation UPDATE and the audit INSERT inside one `BEGIN IMMEDIATE ... COMMIT` transaction. The current `audit()` API does not accept an external tx handle — either extend it (add an `audit({...,db})` overload that uses the caller's tx) or open the tx in the handler, run the UPDATE, call a low-level `insertAuditRowWithChain` directly within that tx, then COMMIT. Add a test that simulates UPDATE failure mid-tx and asserts zero audit rows are written. Add a test that simulates `audit()` failure and asserts the UPDATE rolls back.

### 5. The schema has no UNIQUE on `orgs.name` — the 409 path is racy — MAJOR
**Steps**:
1. Confirmed via `src/database.ts:252-258`: `CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, ...)` — no UNIQUE on `name`.
2. Spec §POST /api/admin/orgs says "409 (org with this name already exists — UNIQUE constraint if any; current schema has no UNIQUE on name, so this is a soft-check by `SELECT` first)" — explicitly acknowledges the race but doesn't fix it.
3. Two admins simultaneously POST `{name: "Acme"}`. Both `SELECT WHERE name = 'Acme'` return zero rows. Both INSERTs succeed. Database now has two orgs named "Acme" with different UUIDs. The Users tab dropdown shows "Acme" twice.

**What goes wrong**: The spec calls this out and shrugs. The "soft-check" is a TOCTOU with no fallback. The dashboard's org dropdown becomes ambiguous; operators selecting "Acme" from the filter dropdown get one of the two orgs nondeterministically (whichever the dropdown rendered first).

**Recommendation**: Add `CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_name ON orgs(name)` to the migration block in `database.ts`. This is a zero-cost migration (the spec already requires zero schema *changes* but doesn't forbid additive indexes). If for some reason name collisions are intentionally allowed (some operators may want it), the spec must say so explicitly and remove the 409 from the spec — letting both inserts succeed is incompatible with returning a 409.

### 6. `name` validation — "no control bytes" is underspecified — MAJOR
**Steps**:
1. Spec §POST validation: "name required (1-200 chars, no control bytes)". Three independent ambiguities:

   - **"chars"**: 200 UTF-8 bytes? 200 UTF-16 code units (JS `string.length`)? 200 Unicode code points? 200 grapheme clusters? Pick one. `"😀".length === 2` in JS (surrogate pair). A 100-char emoji name is "200 chars" by `length` and 400 bytes UTF-8.

   - **"control bytes"**: U+0000–U+001F + U+007F is the ASCII control range. What about U+0080–U+009F (C1 controls)? U+200B–U+200F (zero-width space, ZWNJ, ZWJ, LRM, RLM)? U+202A–U+202E (bidirectional override — RLO is the classic spoofing vector: `"Acme‮grO"` displays as "AcmeOrg" but stores as "Acme<RLO>grO")? U+2066–U+2069 (isolate)? U+FEFF (BOM)?

   - **Emoji/ZWJ sequences**: `"👨‍👩‍👧‍👦"` (family) is a ZWJ sequence — banning U+200D (ZWJ) breaks emoji families. Banning U+FE0F (variation selector) breaks colored emoji.

2. Without precise definition, two implementers will produce two different validators; the spec's 100% per-file coverage claim becomes vacuous.

**What goes wrong**:
- **RTL spoofing**: org named `Acme‮eritryxE` displays as "Acme**Eritryx**E" in the admin dropdown, fooling the operator into selecting it.
- **ZWS injection**: org named `Acme​` is visually identical to `Acme` but is a distinct row; the UNIQUE constraint (if added per #5) doesn't catch it.
- **Byte/char mismatch**: a 200-`length` name with surrogate pairs and combining marks could exceed SQLite's TEXT column expectations downstream (no inherent limit, but log truncation, audit metadata size, etc.).

**Recommendation**: Spec must specify:
- **Length**: "1 to 200 Unicode code points after NFC normalization" (operationally: `[...new Intl.Segmenter().segment(s.normalize('NFC'))].length` or simpler `Array.from(s.normalize('NFC')).length`).
- **Banned characters**: explicit list — `/[ --​-‏‪-‮⁦-⁩﻿]/` rejected.
- **Allowed**: emoji including ZWJ-joined sequences (don't ban U+200D wholesale).
- **Normalization**: apply NFC on write; reject inputs that change under NFC (or accept the normalized form — pick one).

Add a test fixture with: emoji-only name, RTL override, ZWJ family, BOM-prefixed, 199 vs 200 vs 201 code points, 4-byte UTF-8 chars padding to >200 bytes but <200 code points.

### 7. Role payload — JSON `null` vs missing vs case mismatch — MAJOR
**Steps**:
1. PATCH `/api/admin/users/:id` body shapes the spec does not enumerate:
   - `{"role": null}` — JSON null, not a string. Does `role !== "admin" && role !== "member"` reject (correct) or does some flavor of `if (!body.role)` treat it as "no change" (silent no-op)?
   - `{"role": "ADMIN"}` — case mismatch. Spec literally says `"admin" | "member"`. Is the validator case-sensitive? `"admin".toLowerCase()` is a common slip.
   - `{}` — empty PATCH body. Spec §3 says "Reject if body is empty (no fields to update)" for orgs; spec §5 for users does not. What does PATCH user with empty body do? 200-noop? 400?
   - `{"role": "agent"}` or `{"role": "service"}` — spec says reject. Reject with what error code? Same 400 as `{"role": "wizard"}`?
   - `{"role": "admin", "primary_org_id": "o-other"}` — extra unknown field. Silently ignored, or 400 `unexpected_field`? Defense-in-depth says reject.
   - `{"role": "admin", "role": "member"}` — JSON duplicate keys. RFC 8259 says behavior is undefined; `JSON.parse` keeps the last. Spec is silent.

**What goes wrong**: Each ambiguity is a separate compatibility surface that two implementers will resolve two ways, and the test suite (per spec §Testing) will pin whatever the first implementer wrote. Future PRs that "fix" any of these are breaking changes.

**Recommendation**: Spec must add a §Validation table covering each of the above with explicit verdict + error code. Suggested defaults:
- `null` for role → 400 INVALID_ROLE
- `"ADMIN"` → 400 INVALID_ROLE (case-sensitive; do not silently normalize — that hides client bugs)
- `{}` on users → 400 NO_FIELDS_TO_UPDATE (mirror orgs)
- `agent`/`service` → 400 INVALID_ROLE with specific `error_description: "agent and service roles are mint-only"` (per spec text but make it operator-visible)
- Unknown field → 400 UNEXPECTED_FIELD with field name in error_description
- Duplicate keys → reject with 400 (use `JSON.parse` with reviver that detects collisions, or just doc the JS-default last-wins as the contract).

### 8. `org_id` in URL vs `org_id` in body — undefined behavior — MAJOR
**Steps**:
1. PATCH `/api/admin/orgs/o-1` with body `{"name": "Acme", "id": "o-2"}`. Does the handler:
   - Ignore body `id` (URL is canonical)?
   - 400 ID_MISMATCH?
   - Update org `o-2` (body wins)?
   - Update org `o-1` but with `id=o-2` (rewriting the primary key — would break FK refs from `users.primary_org_id`, `user_orgs.org_id`, `refresh_tokens.org_id`)?
2. Same question for `/api/admin/users/:id` with `{"id": "u-other", "role": "admin"}`.

**What goes wrong**: Any of the four behaviors is defensible. Whichever the implementer picks, it should be specified. Letting body `id` *rewrite* a PK would cascade-break audit chain (`audit_log` chain hash references prior actor_user_ids).

**Recommendation**: Spec must add: "extra `id` field in PATCH body → 400 UNEXPECTED_FIELD" (subsumed by #7's "unknown field rejection"). For belt-and-braces: handler explicitly strips `id` from the SET clause; the URL `:id` is the only source of truth for which row to update.

### 9. `?org=` query — SQL injection surface — MAJOR
**Steps**:
1. Spec §GET /api/admin/users: `?org=<org_id>` filter. The spec doesn't show the SQL but the description "thin wrappers around SQL using db.prepare(...).run/get/all" implies parameterization.
2. The spec also gives no length/format validation on the query value. What happens if:
   - `?org=` + a 4 MB org_id (the 4KB body cap doesn't apply to query strings)?
   - `?org=' OR 1=1 --` (parameterized, so safe — but only *if* implementer uses `db.prepare("... WHERE primary_org_id = ?").all(orgQuery)` and not template-string concatenation).
   - `?org=o-1&org=o-2` (Node `url.parse` returns the first; `URLSearchParams` returns the first too; but some routers turn duplicates into arrays — `["o-1","o-2"]` then bound as `?` would either bind `[object Object]` or throw)?
   - `?org=null` (literal string "null" — not the same as omitted; would `WHERE primary_org_id = 'null'` match anything? Possibly the NULL-as-string footgun if any code coerces).

**What goes wrong**: Parameterized queries protect against injection only if every implementer uses them. The spec saying "thin wrappers" leaves the door open for a `db.exec("SELECT ... WHERE primary_org_id = '" + org + "'")` slip. The spec must mandate parameterization explicitly.

**Recommendation**: Spec must add to §Validation:
- All query/body string values bound via `?` placeholders (no template strings in SQL — enforce via lint rule).
- `?org=` value: validate as `/^[a-zA-Z0-9_-]{1,64}$/` (UUID-ish) before binding. Reject longer/oddly-shaped values with 400.
- Duplicate query params: take the first; ignore rest (or 400 — pick one).
- Add a test fixture: `?org='; DROP TABLE users; --` → expect 400 (not 500, not 200-with-empty-result).

### 10. Users with `role: 'agent' | 'service'` in the admin list — UI breakage — MAJOR
**Steps**:
1. Schema (per `src/auth.ts:23`): `type AuthRole = "agent" | "admin" | "member" | "service"`.
2. `src/database.ts:267`: `role TEXT NOT NULL DEFAULT 'member'` — no CHECK constraint enumerating values. Any string can be stored, but in practice agents/services come from `oauth-finalize` paths.
3. Spec §GET /api/admin/users returns *all* users without role filtering. So an `agent` user (or a `service` row, if any exists) shows up in the table.
4. Spec §Frontend: "Role column has [member ▾] dropdown — change triggers PATCH". The dropdown has two options. What does it show when the row's actual role is `"agent"`?
   - Defaults to first option (`member`)? → operator clicks save, accidentally demotes the agent to a member role they're not supposed to have.
   - Blank? → confusing.
   - Disabled with tooltip "agent/service roles managed via mint flow"? → correct, but spec doesn't say this.

**What goes wrong**: The PATCH endpoint rejects `agent`/`service` as **input** (correctly per spec), but does not reject them as **current** state on the target row. So PATCHing an `agent` user with `{"role":"member"}` would succeed — converting an agent into a regular user, which may leave dangling agent-only state elsewhere (agent registry, service-token grants).

**Recommendation**: Spec must add:
- GET /api/admin/users: either filter `WHERE role IN ('admin','member')` (hide agents/services from admin UI) OR include them with a `manageable: false` flag.
- PATCH /api/admin/users/:id: reject if `target.role` is currently `agent` or `service` → 409 NOT_HUMAN_USER with `error_description: "agent and service users cannot be re-roled via this endpoint"`.
- UI: render non-manageable rows with disabled dropdown + tooltip.

Add tests asserting all four current-role × four new-role combinations.

### 11. Users with NULL `primary_org_id` — filter dropdown gap — MINOR
**Steps**:
1. Confirmed via `src/database.ts`: original schema had `org_id NOT NULL`. The v0.8+ migration renames to `primary_org_id` but **the NOT NULL constraint is preserved** (SQLite ALTER TABLE RENAME COLUMN preserves nullability).
2. **However**: subsequent migrations (e.g., service-account onboarding, partial migrations) might `INSERT INTO users (... primary_org_id) VALUES (..., NULL)` if any future code path forgets the FK. Spec assumes `primary_org_id` is always set.
3. Spec §GET /api/admin/users with `?org=<org_id>` filters by `primary_org_id = ?`. Users with NULL `primary_org_id` show under no filter — they're invisible unless the operator hits the unfiltered list.

**What goes wrong**: If a user ever ends up with NULL `primary_org_id` (today: shouldn't happen; tomorrow: possible after multi-tenant work), the admin UI can't see them. Operators can't promote/demote orphans. Low-probability today.

**Recommendation**: Spec adds a §GET /api/admin/users param `?org=__null__` (or `?orphans=true`) to list users with NULL `primary_org_id`. Or document: "users without primary_org_id are managed via the (future) multi-org UI; v0.10.6 silently excludes them from `?org=` filters." Either is fine; silence is the bug.

### 12. Read-only filesystem / disk-full mid-PATCH — MAJOR
**Steps**:
1. Operator's host runs out of disk (or `/var/lib/coordinator` mounts read-only after a snapshot). Daemon stays up because most operations are reads.
2. Admin PATCHes an org. The UPDATE in `orgs` succeeds against WAL (page already cached), but the WAL checkpoint fails on disk-full → `SQLITE_FULL` or `SQLITE_READONLY`.
3. Per `better-sqlite3` defaults: the prepared statement's `.run()` throws synchronously.
4. Spec §Architecture step 6 → "perform DB op in a transaction"; step 7 → "emit Tier 1 audit". If audit fires after the throw is caught … what does the handler do?
   - Catches throw, returns 500 to the client, audit not emitted → operator sees a generic 500, no audit trail, no idea what failed.
   - Catches throw, emits `admin.org.updated.failed` audit, returns 500 → but the audit INSERT *also* fails on read-only FS → second throw, swallowed, still 500.
   - Catches throw, emits audit *before* attempting the UPDATE → false positive (#4 mode B).

**What goes wrong**: The spec does not enumerate `admin.org.updated.failed` / `admin.user.role_changed.failed` events. The audit table lists `admin.org.created.failed` (for *validation* failures) and `admin.user.role_change.refused` (for last-admin) but not generic DB-failure cases. So write failures are invisible to audit.

**Recommendation**: Spec adds two more audit events to the table: `admin.org.updated.failed` and `admin.user.role_changed.failed` with `metadata: { error_class, target_id, attempted_changes }`. Document that these are emitted on a best-effort basis after a write throw — they may themselves fail to write on read-only FS, in which case the failure surfaces only in the application log. Add an explicit test: simulate `SQLITE_READONLY` during PATCH and assert 5xx response + error log entry (audit emission is best-effort).

### 13. Rate limiter signature mismatch — implementer will guess — MINOR
**Steps**:
1. Spec §Rate limiting shows:
   ```typescript
   const rlResult = await ctx.rateLimiter.check({ key: ..., limit: 10, windowMs: 60_000 });
   ```
2. Actual `src/auth/rate-limit.ts:38`: `check(key: string, cfg: RateLimitConfig): RateLimitResult` — synchronous (no `await`), positional args (not an options object).
3. Existing call sites use `ctx.rateLimiter.check(\`device-auth-min:${ip}\`, RATE_LIMIT_PER_MIN)` (see `device-flow.ts:94`).

**What goes wrong**: Implementer copy-pastes the spec snippet, gets a TS error, "fixes" it by inventing a wrapper or `await`ing a sync function (no-op but lint-noisy), or worse — bypasses the rate limiter because "the spec API doesn't exist". Tests pass; rate limit is silently disabled.

**Recommendation**: Spec corrects the snippet to match the actual API:
```typescript
const rl = ctx.rateLimiter.check(`admin:${actor.user_id}`, { limit: 10, windowMs: 60_000 });
if (!rl.allowed) { return respondTooManyRequests(res, rl.retryAfterMs); }
```
And document the rate-limit key convention: `admin:<actor_user_id>` (per actor, not per IP — spec is inconsistent: §Goals item 4 says "per-IP" but §Rate limiting says "per actor_user_id"). Pick one. Per-actor is better for admin endpoints (admins legitimately work from multiple IPs); per-IP defends against a stolen session jumping between IPs.

### 14. CSRF cookie is unkeyed double-submit — stolen session means CSRF bypass — MINOR
**Steps**:
1. `src/auth/csrf.ts` (read): `verifyCsrfToken` compares cookie value to header value via timing-safe equal. No HMAC binding to the session or user.
2. So any party that can read the `__Host-csrf` cookie (XSS on a same-origin path; debug tooling; a malicious extension) can also fabricate a matching header on the same browser. SameSite=Strict + __Host- prefix do the heavy lifting; CSRF token is just defense-in-depth.
3. Spec doesn't acknowledge that the CSRF token is **not** a per-request nonce and **not** HMAC-bound — it's a long-lived random secret. If it ever leaks (e.g., into a frontend error report, a Sentry breadcrumb, a `localStorage` debug dump), it stays valid until the session rotates.

**What goes wrong**: For admin endpoints specifically — where a successful CSRF is one promote-to-admin away from full takeover — the relaxed CSRF model is more sensitive. Today's threat model section ("CSRF: Double-submit token + SameSite=Strict") undersells the limitation.

**Recommendation**: Spec adds to §Threat model:
- "CSRF token is double-submit only, not HMAC-bound to session. A stolen cookie pair (session + csrf, both `SameSite=Strict`) bypasses CSRF. Mitigation rests on SameSite + __Host- + Secure + short JWT TTL."
- Consider deferring to v0.11.0: HMAC-bind the CSRF token to the session token's `jti` (a one-line change in `csrf.ts`).
- For now, audit emissions for admin mutations include `actor_ip` and `actor_user_agent` (already do via async-context) so post-hoc forensics work even if the CSRF defense is bypassed.

### 15. `truncated: true` at 500-row cap — silent data loss in the UI — MINOR
**Steps**:
1. Spec §GET /api/admin/users: "capped at 500 to prevent surprise dumps. `truncated: true` when result hit the 500 cap."
2. The 501st-to-Nth users are invisible. If they include an admin (or the last admin you're trying to demote), the UI shows the wrong picture.
3. Per spec §Frontend: client populates the org-filter dropdown by reading `/api/admin/orgs` (no cap mentioned — does that have a cap too? Spec is silent. If you have >500 orgs you can't filter to half of them).

**What goes wrong**: Cap silently shrinks the visible universe. The `truncated: true` flag is shown how, in the UI? Spec frontend section doesn't say. The 500-row cap is also not deterministic without an `ORDER BY` — without ordering, "the 500 users you see" varies between calls.

**Recommendation**:
- Spec adds: GET /api/admin/users uses `ORDER BY created_at ASC, id ASC LIMIT 500` (deterministic; oldest users first).
- Spec adds: GET /api/admin/orgs also documents whether there's a cap and what order.
- Spec §Frontend adds: when `truncated: true`, the table shows a warning banner: "Showing 500 of N+ users. Filter by org to narrow."
- Defer pagination to v0.11.0 (spec already does); make the truncation surface visible.

### 16. Audit log `before/after` blobs may exceed reasonable size — NIT
**Steps**:
1. Spec §Audit events: `admin.org.updated` metadata includes `before: { name, allowlist_github_org, allowlist_idp_org_id }` and `after: { same }`.
2. With the 200-char limit on each field (per spec §validation, ambiguous per #6), the JSON blob is ~800 bytes worst case — fine.
3. **But**: if validation is loosened ("we now allow up to 1000 chars in `allowlist_idp_org_id` for some IdP"), the audit metadata grows to ~4 KB per row. The `audit_log.metadata` column is unbounded TEXT, so storage-wise no issue, but reads (e.g., `audit-log-stats`) become slow.

**What goes wrong**: Today's spec is fine. The structural risk is that `before/after` of the entire row scales linearly with column count and column size. When v0.11.0 adds more orgs columns (`suspended_at`, `quota_*`, etc.), `before/after` doubles automatically without anyone re-reviewing.

**Recommendation**: Spec adds: "audit `before/after` blobs contain ONLY the fields named in `changed_fields`, not the whole row." Reduces both noise (operator can see at a glance what changed) and the auto-growth-with-schema problem. Add a unit test asserting metadata size.

## Headline gaps to fix before implementation

1. **Last-admin TOCTOU under concurrency** (#1): the SELECT-COUNT-then-UPDATE pattern is not atomic. Wrap in `BEGIN IMMEDIATE` or add a DB trigger.
2. **Audit vs commit ordering** (#4): mutation UPDATE and audit INSERT must be in one transaction, or one of two failure modes will produce phantom audits / unaudited changes.
3. **Validation gaps on `name`, `role`, body shapes** (#6, #7, #8): spec needs an explicit Validation table covering Unicode policy, case sensitivity, null vs missing, unknown fields, URL/body id conflicts.
4. **`orgs.name` UNIQUE missing** (#5): the soft-SELECT-first 409 path is a race. Add a UNIQUE INDEX or accept duplicates explicitly.
5. **Agent/service users in the admin user list** (#10): GET filter and PATCH guard both needed; without them, admins can accidentally re-role non-human accounts.
6. **Last-admin protection is target-only, not actor-aware** (#2): explicitly state the self-demotion policy.
7. **Rate-limiter snippet doesn't match the real API** (#13): correct the spec snippet to avoid silent disable.
