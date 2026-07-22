import type Database from "better-sqlite3";

// Direct SQLite read per request. No cache.
// Phase 2 design choice (V4 CUT 1): better-sqlite3 sync read on indexed
// PK is ~50-100µs; cache invalidation across Phase 5 multi-instance
// would need a pub/sub channel which isn't worth the complexity.
export function readTokenEpoch(db: Database.Database, userId: string): number {
  const row = db.prepare("SELECT token_epoch FROM users WHERE id = ?").get(userId) as
    { token_epoch?: number } | undefined;
  return row?.token_epoch ?? 0;
}

// ── Phase 5 multi-instance: epoch bump pub/sub ──────────────────────────────
//
// The cross-process race (single-instance-constraints.md "token-epoch read
// race"): instance A commits a bump, but instance B's per-request read may
// not see it yet (SQLite WAL visibility is per-connection). The fix is a
// Redis pub/sub channel: A publishes the new epoch on bump; every instance
// keeps an in-memory FLOOR per user, and the auth check uses
// max(db_epoch, floor). The floor collapses the revocation window to
// pub/sub latency (~ms) without adding a cache (reads stay direct).

/** Publish-side seam. Wired by serve-http when COORDINATOR_REDIS_URL is set;
 *  null (default) = single-instance, no-op. */
export interface TokenEpochBus {
  publish(userId: string, epoch: number): void;
}

let _bus: TokenEpochBus | null = null;

export function setTokenEpochBus(bus: TokenEpochBus | null): void {
  _bus = bus;
}

// "*" is the all-users sentinel (bumpTokenEpochAllUsers / NR12 restore).
const _floorByUser = new Map<string, number>();
let _globalFloor = 0;

/** Subscriber-side: record a bump observed on the pub/sub channel. */
export function noteEpochBump(userId: string, epoch: number): void {
  if (!Number.isFinite(epoch)) return;
  if (userId === "*") {
    if (epoch > _globalFloor) _globalFloor = epoch;
    return;
  }
  const cur = _floorByUser.get(userId) ?? 0;
  if (epoch > cur) _floorByUser.set(userId, epoch);
}

/** Read the floor for a user (max of per-user and global sentinels). */
export function getEpochFloor(userId: string): number {
  return Math.max(_globalFloor, _floorByUser.get(userId) ?? 0);
}

/** Test helper. */
export function resetEpochFloorForTest(): void {
  _floorByUser.clear();
  _globalFloor = 0;
}

function publishBump(userId: string, epoch: number): void {
  // Floor entries come ONLY from the subscriber side (the publisher also
  // receives its own pub/sub message, so it converges too). The bumping
  // instance doesn't need a local floor — its own per-request DB read sees
  // its own committed write. This also keeps the module side-effect-free in
  // single-instance mode (no bus, no floor mutation — test isolation).
  try {
    _bus?.publish(userId, epoch);
  } catch {
    /* pub/sub is an accelerator; the DB row is the source of truth */
  }
}

// Bump epoch monotonically — never decreases even under NTP rollback.
// MAX(now, current+1) guarantees epoch is strictly greater than any
// JWT issued before this call, regardless of wall-clock direction.
// Returns the new epoch value.
export function bumpTokenEpoch(db: Database.Database, userId: string): number {
  const result = db
    .prepare(
      `
      UPDATE users
      SET token_epoch = MAX(CAST(strftime('%s','now') AS INTEGER), token_epoch + 1)
      WHERE id = ?
      RETURNING token_epoch
    `,
    )
    .get(userId) as { token_epoch: number } | undefined;
  if (!result) throw new Error(`bumpTokenEpoch: user not found: ${userId}`);
  publishBump(userId, result.token_epoch);
  return result.token_epoch;
}

// Used by NR12 restore reconciliation (T29): invalidates ALL sessions
// after a DB restore from backup. Returns rows-changed count.
export function bumpTokenEpochAllUsers(db: Database.Database): number {
  const result = db
    .prepare(
      `
      UPDATE users
      SET token_epoch = MAX(CAST(strftime('%s','now') AS INTEGER), token_epoch + 1)
    `,
    )
    .run();
  // All-users bump: broadcast the wall-clock floor under the "*" sentinel
  // (the per-user epochs are >= now by the MAX above).
  publishBump("*", Math.floor(Date.now() / 1000));
  return result.changes;
}
