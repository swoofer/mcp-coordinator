# P4 — `src/db-adapter.ts` audit (v0.5 Performance)

**Verdict: MAKE REAL.** Add one genuine helper (`withTransaction`) instead of deleting the file or leaving it as a copy of `better-sqlite3` types. The phantom abstraction stays, but it now earns its keep.

---

## 1. What the abstraction does today

`src/db-adapter.ts` exports three interfaces:

- `RunResult` — `{ changes, lastInsertRowid }` (mirrors `better-sqlite3`'s `RunResult`)
- `Statement` — `{ run, get, all }` returning `unknown` instead of generics
- `DatabaseAdapter` — `{ prepare, exec, close, transaction }`

**Caller usage** (54 `getDb()` calls across 14 src files):

| Export             | Imported by         | Real use                                 |
| ------------------ | ------------------- | ---------------------------------------- |
| `DatabaseAdapter`  | `database.ts` only  | typing the singleton + factory returns   |
| `Statement`        | nobody              | dead export                              |
| `RunResult`        | nobody              | dead export                              |

**Portability work performed: zero.** Both `createBunSqlite` and `createBetterSqlite3` cast the raw driver with `as DatabaseAdapter` — no method shim, no parameter normalization, no error remapping. The interface is a strict subset of better-sqlite3's API, so the cast is structural luck, not engineering.

## 2. What's in `database.ts`

`database.ts` chooses a backend by sniffing `globalThis.Bun`:

- `createBetterSqlite3` requires `better-sqlite3`, sets `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON` via `pragma()`.
- `createBunSqlite` requires `bun:sqlite`, sets the same three PRAGMAs via `exec("PRAGMA …")` (Bun's API does not expose `pragma()`).

**Are they swappable?** Mostly, but with caveats Bun users will hit:

1. **`Statement.all/get/run` parameter binding**: better-sqlite3 accepts spread positionals; Bun coerces objects with named binding. The current code uses positional `?` everywhere, so this works.
2. **`db.transaction(fn)`**: better-sqlite3 returns a callable that runs the body in a transaction. Bun's `Database.transaction` exists since Bun 1.1 with the same shape. OK.
3. **Return types**: better-sqlite3 returns plain objects; Bun returns plain objects too. OK in practice.

The Bun path is **not exercised by CI** (no Bun in `package.json`, no `bun test` script). It is aspirational, not validated.

## 3. Decision: **MAKE REAL**

Rationale: deleting forfeits the Bun escape hatch (cheap optionality) and rewrites 50+ imports for no perf gain. Keeping as-is leaves a dead `Statement`/`RunResult` and a misleading file. The cheapest upgrade that *justifies* the abstraction is to add helpers that eliminate the verbose two-step `db.transaction()` boilerplate already used in 4 places (`consultation.ts` x3, `dependency-map.ts` x1).

## 4. Implementation plan

**Files modified**

- `src/db-adapter.ts` — add `withTransaction<T>(db, fn): T` helper + retain interface
- `src/dependency-map.ts` — adopt helper in `setMap()` (single-call, lowest risk)
- `tests/unit/db-adapter.test.ts` — extend to assert helper passes through return value

**Risk**

- Tests at risk: `dependency-map.test.ts`, `b1-transactions.test.ts`. The semantics are identical to the current `db.transaction(fn)()` pattern — the helper is `(db, fn) => db.transaction(fn)()`. No behavior change.
- Other 3 transaction sites in `consultation.ts` (`announceWork`, `approveResolution`, `checkTimeouts`) intentionally **left alone** in this pilot — they each return a value the caller destructures, and migrating them is a follow-up, not a one-shot. The helper supports them; adoption can be incremental.

**Cost**

- LOC delta: +12 (helper + JSDoc), -4 (dependency-map.ts boilerplate), +5 (test) = ~+13 net
- Time: 20 min for pilot, 30 min review, ~1 h to migrate the 3 remaining sites in a follow-up

## 5. Pilot commit

Implemented:

1. `src/db-adapter.ts` — added `withTransaction<T>(db: DatabaseAdapter, fn: () => T): T` plus a header comment documenting the design intent (real abstraction now, not just types). Marked `Statement`/`RunResult` exports kept for backwards compat (they are part of the public surface anyone subclassing the adapter would need).
2. `src/dependency-map.ts` — `setMap()` now calls `withTransaction(db, () => { … })` instead of `const tx = db.transaction(() => { … }); tx();`.
3. `tests/unit/db-adapter.test.ts` — added a test asserting `withTransaction` returns the function's result and propagates throws.

No production behavior changed. The pilot proves the helper works and is safely adoptable elsewhere later.
