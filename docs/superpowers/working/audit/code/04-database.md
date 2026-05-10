# Database / Persistence Layer Audit

**Score: 5/10**

WAL is on, parameterized statements everywhere, FK declarations exist, and there is a sane index baseline. But schema integrity is shallow (no CHECKs, no `ON DELETE`, no `NOT NULL` on JSON cols), several hot paths are unbounded or N+1, multi-statement state transitions run without transactions, and there is zero retention/GC. Synchronous `better-sqlite3` calls also block the event loop on growing tables.

---

## Issues

### 1. Multi-statement transitions are not transactional
`src/consultation.ts:209-213, 231-234, 295-313` perform "UPDATE thread + post message + emit event" sequences using independent `db.prepare().run()` calls. `approveResolution`, `contestResolution`, and `handleAgentDeparture` can leave threads in inconsistent states if a process dies mid-sequence (status flipped to `resolved` without the `approve` row, or `expected_respondents` rewritten without the matching status update). The adapter exposes `transaction<T>(fn)` (`src/db-adapter.ts:16`) but nothing in the codebase uses it. Wrap every multi-row state change in `db.transaction(...)()`.

### 2. Foreign keys declared but never enforceable
`src/database.ts:40, 55-56, 66, 115-116, 128` declare `FOREIGN KEY` on most child tables, yet no FK targets `ON DELETE CASCADE` / `ON DELETE SET NULL`. With `foreign_keys = ON` you can never delete an agent that ever posted a message — which is exactly why no GC exists. `file_activity` (`:83-92`) has neither a FK nor an index on `(session_id, created_at)` despite being used in time-window aggregations.

### 3. No CHECK constraints on enum-like columns
`status`, `type`, `activity_status`, `tool_name` are free-form TEXT (`src/database.ts:15, 27, 48, 124`). A typo such as `'open '` or `'Open'` silently corrupts `listThreads` filters. Add `CHECK (status IN ('open','resolving','resolved','cancelled'))` and equivalents for message `type`, introspection `status`, etc.

### 4. Unbounded SELECTs / missing pagination on hot tables
`src/consultation.ts:357-359, 401, 426`, `src/agent-registry.ts:26, 31`, `src/file-tracker.ts:22, 27-33` all return entire result sets with no `LIMIT`/`OFFSET`. `getThreadWithMessages`, `listThreads`, `getThreadUpdates`, `getBySession`, and `getHotFiles` will allocate the full row set into JS memory; combined with sync `better-sqlite3` this stalls the event loop linearly with table growth.

### 5. Hidden N+1 in `handleAgentDeparture`
`src/consultation.ts:287-314` loads every open/resolving thread, then for each one runs `getThread` → `checkTimeouts` → `UPDATE` → potentially another `UPDATE` and `emitResolution` (which itself runs a `COUNT(*)` query at `:40`). For N threads and M departing agents this is O(N·M) round-trips inside a non-transaction. Fix: single `UPDATE … json_remove(expected_respondents, …)` plus a follow-up filtered `UPDATE … WHERE expected_respondents = '[]'`.

### 6. `getThread` triggers `checkTimeouts` on every read
`src/consultation.ts:317-343, 346, 376` runs a full table scan over `threads` every time anyone reads a single thread, including inside other loops (issue #5). Worse, `idx_threads_status` exists but the `datetime(created_at, '+' || (timeout_seconds * round) || ' seconds')` predicate is non-sargable, so the index is unused. Move timeout reaping to a periodic worker.

### 7. Schema migrations are silent and untracked
`src/database.ts:169-179` uses `try { ALTER TABLE … } catch {}` — every new column needs another swallowed-error line, errors mask real failures (disk full, locked DB), and there is no `schema_version` table to reason about state. Adopt a numbered migration runner that records applied versions.

### 8. No retention / GC story
`thread_messages`, `events`, `file_activity`, `action_summaries`, `introspections` only grow. There is no `VACUUM`, no `DELETE WHERE created_at < …`, and no archive path. Combined with #2 (no cascade), the DB is append-only by accident, not by design.

---

## Three concrete improvements

1. **Transactions + cascade**: wrap state transitions in `db.transaction(...)()` and add `ON DELETE CASCADE` to `thread_messages`, `introspections`, `agent_activity_status`; use `ON DELETE SET NULL` for `threads.claimed_by`/`assigned_to` and `threads.initiator_id`.
2. **Schema_version migration runner** + `CHECK` constraints on `status`/`type`/`activity_status` and `NOT NULL DEFAULT '[]'` on every JSON-array column.
3. **Pagination + composite indexes**: add `LIMIT` to every `list*`/`get*` API, plus `idx_messages_thread_created (thread_id, created_at)`, `idx_file_activity_path_created (file_path, created_at)`, `idx_threads_status_assigned (status, assigned_to)`, and a nightly `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM` job.

---

DONE: `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\04-database.md`
