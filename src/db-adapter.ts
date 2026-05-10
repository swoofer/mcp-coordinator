/**
 * Database adapter surface.
 *
 * Design intent: this file is the *contract* both `createBetterSqlite3` and
 * `createBunSqlite` (in `database.ts`) implement. The interfaces are a strict
 * subset of better-sqlite3's API that Bun:sqlite also satisfies, so callers
 * stay portable across both runtimes.
 *
 * Helpers (e.g. `withTransaction`) live here so portable code paths can use
 * one canonical entry point without each call site re-deriving the
 * `db.transaction(fn)()` two-step pattern.
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DatabaseAdapter {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
  transaction<T>(fn: () => T): () => T;
}

/**
 * Run `fn` inside a single SQLite transaction and return its result.
 *
 * Replaces the verbose two-step pattern:
 *
 *     const tx = db.transaction(() => { ...; return value; });
 *     const value = tx();
 *
 * with:
 *
 *     const value = withTransaction(db, () => { ...; return value; });
 *
 * Errors thrown inside `fn` propagate to the caller and the transaction is
 * rolled back by the underlying driver (better-sqlite3 / bun:sqlite both do
 * this). Use this for any read-modify-write block where multiple statements
 * must be atomic.
 */
export function withTransaction<T>(db: DatabaseAdapter, fn: () => T): T {
  return db.transaction(fn)();
}
