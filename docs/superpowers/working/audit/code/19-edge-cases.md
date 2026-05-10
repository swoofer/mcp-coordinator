# Edge-Case Audit

**Score: 4/10** — Happy path is solid, but multiple silent-corruption and crash vectors lurk in unvalidated inputs, race-prone SQL, and non-normalized identifiers. No empty-input guards, no bounds checking, no path canonicalization.

---

## Edge Cases Found

### 1. Path normalization missing — same file scored twice (HIGH)
**`file-tracker.ts:42-50`** + **`impact-scorer.ts:99-109`**
`checkFileConflict` does literal string equality on `file_path`. Agent A logs `src/foo.ts`, Agent B announces `./src/foo.ts` or `src\foo.ts` (Windows) or `/abs/path/src/foo.ts` — zero match, conflict missed. `fileToModule()` only strips leading `/`, ignoring `\\`, `./`, `..`, trailing slashes, and case (Windows is case-insensitive; Linux not). Two agents editing the same file via different path strings trigger no overlap.

### 2. `JSON.parse` on `agent.modules` crashes scorer for one bad row (HIGH)
**`impact-scorer.ts:40, 70-71`**, **`consultation.ts:87, 292, 483`**
Every call assumes columns are valid JSON. A single agent registered with malformed `modules` (corruption, manual DB edit, future schema drift) throws `SyntaxError` mid-`map()`, killing the whole `score()` call — no scores returned for any agent, not just the bad one. No try/catch, no schema validation on insert.

### 3. Same-name double-register silently overwrites modules (MED)
**`agent-registry.ts:7-15`**
`ON CONFLICT(id) DO UPDATE` keys on `id` only. Two agents with different IDs but same `name` coexist (no UNIQUE on `name`). Worse: if one re-registers with a shrunk module list (e.g. `["api"]` instead of `["api","auth"]`), all in-flight scoring for `auth` silently stops matching them, even mid-thread. Existing thread `expected_respondents` is not reconciled.

### 4. Cyclic dependency graph — `getBlastRadius` infinite-loop guard works, but `direct` may include `moduleId` itself (MED)
**`dependency-map.ts:52-88`**
Loop at line 58 adds `id` to `direct` when `info.depends_on.includes(moduleId)`. If `map[moduleId].depends_on` contains `moduleId` (self-cycle), `moduleId` ends up in its own `direct_dependents`. `visited` set saves us from infinite indirect traversal, but the result is semantically wrong (a module isn't its own dependent). Also `affected_exports` (line 78) returns `[]` silently when `moduleId` doesn't exist — no error, caller can't distinguish "no exports" from "no module".

### 5. Timeout SQL uses local `CURRENT_TIMESTAMP` vs UTC `created_at` (MED)
**`consultation.ts:317-336`**
SQLite `CURRENT_TIMESTAMP` returns UTC; `datetime(created_at, '+N seconds')` arithmetic is fine — BUT `Date.now()` and `new Date().toISOString()` writes elsewhere (lines 56, 113, 211, 233, 251, 276, 304, 311) use ISO-8601 with `Z`, while SQLite default `CURRENT_TIMESTAMP` writes `YYYY-MM-DD HH:MM:SS` (no Z). Mixing formats in `created_at` reads — the `parseSqliteUtc` helper (impact-scorer.ts:53) handles this, but `consultation.ts:42` uses raw `new Date(thread.created_at)` which interprets the SQLite naked timestamp as **local time** → `durationMs` skewed by TZ offset on non-UTC hosts.

### 6. `getThreadUpdates` `since` normalization drops sub-second precision (LOW-MED)
**`consultation.ts:419-423`**
`date.toISOString().slice(0, 19)` strips milliseconds. Two messages posted within the same second: client polls with `since=msg1.created_at`, gets msg1 *back* (>= comparison) plus msg2 — duplicate delivery. With many agents, polling loops re-process the same message indefinitely if comparator is non-strict.

### 7. Empty `target_files` + empty `target_modules` → silent no-op announce (LOW-MED)
**`consultation.ts:64-131`**
No validation. Calling `announceWork({target_files:[], target_modules:[]})` succeeds, creates a thread with `respondentIds=[]`, auto-resolves immediately (line 99), emits a `consensus`-less resolution. Pollutes thread history with junk, and `keep_open=true` makes it immortal — never times out (line 116: `timeout_seconds=0`), never has respondents to approve.

### 8. `handleAgentDeparture` race: re-resolves already-resolved thread (LOW)
**`consultation.ts:280-315`**
Between the SELECT (line 287) and UPDATE (lines 302/309), thread status can change. `getThread()` re-reads but doesn't recheck `status === 'resolved'` before forcing another UPDATE → `resolved_at` overwritten, double `emitResolution` fires `agent_departure` for an already-`consensus`-resolved thread. Listeners get duplicate events.

### 9. Unicode + `token_estimate = length/4` wildly wrong (LOW)
**`consultation.ts:154`**
`content.length` counts UTF-16 code units. Emoji (surrogate pairs) inflate by 2x. CJK chars are ~1 token each, not 0.25. French accents fine. Estimate is decorative but used in dashboards/quotas elsewhere.

---

## Top 3 Fixes
1. **Canonicalize paths on every read/write** (`file-tracker.ts`, `impact-scorer.ts`): `path.posix.normalize`, lowercase on Windows, resolve relative segments. Add at log-time *and* lookup-time.
2. **Wrap all `JSON.parse(column)` in safe parser** returning `[]` on error + logging — prevents one corrupt row from killing whole-system scoring.
3. **Validate `announceWork` inputs**: reject when `target_files.length === 0 && target_modules.length === 0`; cap arrays at e.g. 500 entries; reject empty `agent_id`/`subject`.

DONE: `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\19-edge-cases.md`
