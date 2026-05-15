import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";

const require = createRequire(import.meta.url);
const DatabaseCtor = require("better-sqlite3") as new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => BetterSqlite3.Database;

/**
 * Open a fresh read-only connection on the same DB file. Use in tests that
 * need to assert Tier 1 audit rows were committed BEFORE the test function
 * returned — separate connections see committed state but not the current
 * connection's pending transactions, so this defeats the better-sqlite3
 * implicit-tx visibility window.
 *
 * Caller MUST close the returned handle in afterEach to release the WAL
 * reader slot.
 */
export function openReadCommitted(dbPath: string): BetterSqlite3.Database {
  return new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });
}
