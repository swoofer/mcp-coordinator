import type Database from "better-sqlite3";

// Direct SQLite read per request. No cache.
// Phase 2 design choice (V4 CUT 1): better-sqlite3 sync read on indexed
// PK is ~50-100µs; cache invalidation across Phase 5 multi-instance
// would need a pub/sub channel which isn't worth the complexity.
export function readTokenEpoch(
  db: Database.Database,
  userId: string,
): number {
  const row = db
    .prepare("SELECT token_epoch FROM users WHERE id = ?")
    .get(userId) as { token_epoch?: number } | undefined;
  return row?.token_epoch ?? 0;
}

// Bump epoch monotonically — never decreases even under NTP rollback.
// MAX(now, current+1) guarantees epoch is strictly greater than any
// JWT issued before this call, regardless of wall-clock direction.
// Returns the new epoch value.
export function bumpTokenEpoch(
  db: Database.Database,
  userId: string,
): number {
  const result = db
    .prepare(`
      UPDATE users
      SET token_epoch = MAX(CAST(strftime('%s','now') AS INTEGER), token_epoch + 1)
      WHERE id = ?
      RETURNING token_epoch
    `)
    .get(userId) as { token_epoch: number } | undefined;
  if (!result) throw new Error(`bumpTokenEpoch: user not found: ${userId}`);
  return result.token_epoch;
}

// Used by NR12 restore reconciliation (T29): invalidates ALL sessions
// after a DB restore from backup. Returns rows-changed count.
export function bumpTokenEpochAllUsers(
  db: Database.Database,
): number {
  const result = db
    .prepare(`
      UPDATE users
      SET token_epoch = MAX(CAST(strftime('%s','now') AS INTEGER), token_epoch + 1)
    `)
    .run();
  return result.changes;
}
