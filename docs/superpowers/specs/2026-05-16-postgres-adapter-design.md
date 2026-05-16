# Postgres adapter -- design + scope honesty

**Status**: design, **not** scheduled for immediate implementation
**Target release**: v0.11.0-alpha (foundation), v1.0 (production)
**Author**: autonomous agent loop, 2026-05-16
**References**:
  - `src/db-adapter.ts` (the current `DatabaseAdapter` interface)
  - `src/database.ts` (better-sqlite3 + bun:sqlite factories)
  - `docs/superpowers/specs/2026-05-11-auth-saas-ready-design.md`
    §C (Postgres adapter as the path to multi-instance)

## Motivation

The Phase 1 + Phase 2 stack runs on better-sqlite3 (Node) or
bun:sqlite (Bun). For single-instance deployments this is excellent:
zero-config, atomic-write WAL, sub-millisecond latency. For regulated
multi-instance workloads it's the wrong choice:

1. **Single writer.** Only one process can write to the file at a
   time. Horizontal scaling via load balancer is structurally
   impossible.
2. **Backup / replication story.** SQLite's `.backup` API and
   Litestream-style streaming-replication are workable but rougher
   than a managed RDBMS like RDS Aurora / Cloud SQL.
3. **Compliance posture.** Many SOC 2 / FedRAMP / HIPAA-adjacent
   audits expect a database with built-in access logging, point-in-
   time-recovery, encryption at rest at the storage layer, and
   role-based access controls. Postgres delivers these out of the
   box; SQLite asks the operator to assemble them.

## The honest cost

This is the part of the spec I want to surface FIRST so we don't
under-budget. **Postgres support is months of work, not days.** The
specific costs:

### 1. Sync→async interface conversion (the killer)

`better-sqlite3` is synchronous: `.prepare(sql).get(...)` /
`.all(...)` / `.run(...)` return values directly. The coordinator
code is built on this assumption -- every handler is `await`-able at
the top level but the SQL inside is sync. **168 distinct
`.prepare(...)` call sites across 35 source files** (measured
2026-05-16). Each one assumes the synchronous shape.

Postgres clients (`pg`, `pg-pool`) are inherently asynchronous. There
is no synchronous wrapper that doesn't deadlock the event loop. So
to support Postgres we MUST convert the `DatabaseAdapter.prepare(...)`
return type from:

```ts
interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
```

to:

```ts
interface Statement {
  run(...params: unknown[]): Promise<RunResult>;
  get(...params: unknown[]): Promise<unknown>;
  all(...params: unknown[]): Promise<unknown[]>;
}
```

Every one of the 168 callsites becomes `await`-ed. Many of them are
inside `db.transaction(() => { ... })` blocks, which means the
`transaction` wrapper itself becomes async. Many of those are inside
hot paths (refresh-rotation, oauth-callback) where the await
boundary needs careful audit for re-entrancy bugs.

Rough effort estimate: 2-3 person-weeks of mechanical refactor + 1
week of test rewriting + 1 week of cross-cutting integration
testing. **Not feasible in a single autonomous-loop session.**

### 2. SQL dialect translation

better-sqlite3 and Postgres diverge on:

| | SQLite | Postgres |
|---|---|---|
| Placeholders | `?` | `$1`, `$2`, ... |
| AUTOINCREMENT | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL` / `BIGSERIAL` / `IDENTITY` |
| RETURNING | Supported (since 3.35) | Supported |
| JSON | TEXT + `json_extract()` | `JSONB` + `->` / `->>` |
| Timestamps | TEXT or INTEGER (Unix seconds) | `TIMESTAMP` / `TIMESTAMPTZ` |
| Boolean | INTEGER 0/1 | native `BOOLEAN` |
| `CURRENT_TIMESTAMP` | UTC text | local zone TIMESTAMP by default |
| `strftime('%s', x)` | builtin | `EXTRACT(EPOCH FROM x)` |
| `INSERT OR IGNORE` | builtin | `INSERT ... ON CONFLICT DO NOTHING` |
| `INSERT OR REPLACE` | builtin | `INSERT ... ON CONFLICT DO UPDATE` |
| `PRAGMA` | runtime | not supported (use `SET`) |
| `PRAGMA user_version` | builtin schema-version mechanism | `pg_settings` / dedicated table |
| `PRAGMA journal_mode=WAL` | meaningful | not applicable |
| `WITHOUT ROWID` | supported | no-op |
| Identifier quoting | `"`, `[]`, ``` ` ``` | `"` only (case-folding subtleties) |
| LIKE case sensitivity | case-insensitive by default | case-sensitive; need `ILIKE` |

Strategies:

**A. Two SQL files per migration** -- one for SQLite, one for
Postgres. Most maintenance-friendly but doubles the test surface.

**B. SQL translator** -- runtime rewriter that takes
better-sqlite3-flavoured SQL and emits Postgres-compatible SQL.
Worked for some products (Knex, Kysely) but adds a learning curve
and a class of bugs (translator misses an edge case, wrong query
goes to prod).

**C. Lowest-common-denominator SQL** -- write only SQL that both
dialects accept. Loses access to dialect-specific features but is
cheapest to maintain. The audit-chain backfill (`UPDATE audit_log
SET prev_hash = ?, row_hash = ? WHERE id = ?`) is already this; many
others would need rewrites.

Recommendation: **option C as the default, with option A for the
dozen or so dialect-specific cases** (datetime arithmetic, JSON
extraction, `INSERT OR IGNORE`). Avoid option B entirely -- the
debugging cost of a translator bug in a security audit row is
unacceptable.

### 3. Transaction semantics

SQLite transactions are file-level and serializable; Postgres is
MVCC with multiple isolation levels. The coordinator's existing code
implicitly assumes serializable behaviour in several places:

- **OAuth state CAS** (`UPDATE oauth_state SET consumed_at = ? WHERE
  state = ? AND consumed_at IS NULL`) -- Postgres at READ COMMITTED
  isolation would still produce correct one-time-use semantics for a
  single state token, but if we ever batch CAS we'd need stricter
  isolation.
- **Refresh-token rotation reuse detection** -- the row-locking is
  implicit on SQLite; on Postgres we'd want `SELECT ... FOR UPDATE`
  inside the transaction.
- **Bootstrap-admin promote** (`UPDATE users SET role = 'admin'
  WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE role =
  'admin' AND id != ?)`) -- serializable on SQLite; on Postgres at
  READ COMMITTED two concurrent first-sign-ins could both promote.
  Need `SERIALIZABLE` here OR a unique partial index.

Each of these needs an audit-and-update before Postgres can ship.

### 4. Connection pooling

`pg-pool` is the standard. Sizing: roughly `(active concurrent
requests * 1.5) + 1` connections, capped by Postgres `max_connections`.
For a coordinator handling ~50 concurrent OAuth flows, a pool of 10
is generous. Multi-instance: each coordinator instance has its own
pool; total connections to Postgres = N * pool_size + safety margin.

The pool wrapper goes inside `createPostgresAdapter()`. Each
`prepare()` call becomes either:
- A prepared-statement cache (per-connection, since pg's prepared
  statements are per-session) -- complex but matches SQLite's
  caching
- Or a fresh `pool.query(sql, params)` every time, accepting the
  slight overhead in exchange for simplicity

Recommendation: **fresh-query-per-call** for v0.11.0-alpha. Optimise
to per-connection prepared-statement caching later if benchmarks
justify the complexity.

### 5. Schema migrations

`PRAGMA user_version` doesn't exist in Postgres. Replacement:

```sql
CREATE TABLE IF NOT EXISTS coordinator_schema (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Migration runner reads the highest version + applies each unapplied
file in id order, inside a transaction. Idempotent.

This is a behaviour change for the existing migration code in
`src/database.ts` (which uses try/catch on each `ALTER TABLE` to
make migrations idempotent). The schema-version-table pattern is
cleaner and Postgres-compatible. Migrate SQLite to it at the same
time so both dialects share the runner.

### 6. Test infrastructure

The Phase 1 + Phase 2 test suite uses in-memory better-sqlite3 via
`new Database(":memory:")`. For Postgres tests we need a real
Postgres -- options:

- **`pg-mem`** -- in-memory Postgres emulator. Fast (no Docker)
  but covers only ~80% of features and has known bugs. Acceptable
  for unit tests; insufficient for integration tests.
- **Testcontainers** -- spins up a real `postgres:17-alpine`
  container per test file. Slow (3-5s startup) but covers 100%.
- **Shared docker-compose Postgres** -- one container for all
  tests, reset via `TRUNCATE` between tests. Faster than
  testcontainers but introduces test ordering coupling.

Recommendation: **pg-mem for unit tests + testcontainers for
integration tests** (the existing `tests/integration/` dir). CI
gains a ~5min Postgres-suite wall clock; acceptable for the
compliance value delivered.

### 7. Bun:sqlite future

The current adapter supports both `better-sqlite3` (Node) and
`bun:sqlite` (Bun). Bun's sqlite is also synchronous and conforms to
the current interface. After the sync→async conversion, Bun:sqlite
still works (async-over-sync via `Promise.resolve(syncResult)` is
trivial). But the question becomes: is Bun:sqlite worth maintaining
as a third backend?

Recommendation: **drop bun:sqlite during v0.11.0**. Bun:sqlite users
can continue on v0.10.x; the maintenance cost of a third backend
isn't justified by the user base.

## Implementation plan

If we proceed, the work breaks into ordered milestones:

1. **v0.11.0-alpha-1 (foundation, ~3 weeks)**
   - Async `DatabaseAdapter` interface
   - Convert all 168 callsites to `await`
   - All existing tests still passing under better-sqlite3
   - Single big PR, NO Postgres support yet
2. **v0.11.0-alpha-2 (~2 weeks)**
   - `PostgresAdapter` skeleton (pool, query, transaction)
   - Schema migration runner (replaces `PRAGMA user_version` path)
   - Unit tests against pg-mem
3. **v0.11.0-alpha-3 (~2 weeks)**
   - Schema dialect translation (option A: per-dialect SQL files
     for the ~12 cases that need it)
   - Integration tests against testcontainers Postgres
4. **v0.11.0-beta (~1 week)**
   - Boot-time `COORDINATOR_DATABASE_URL` env var to choose
     backend
   - Ops docs (`docs/ops/postgres-setup.md`,
     `docs/ops/postgres-backup-restore.md`)
   - Multi-instance smoke test (two coordinator processes, same
     Postgres DB)
5. **v0.11.0 GA**
   - Drop bun:sqlite backend
   - Schema dialect translation for all remaining edge cases
   - Documented production-readiness

**Total**: ~8 weeks calendar time for a focused team. Cannot be
delivered in an autonomous-loop session.

## No-go criteria

We should NOT pursue Postgres if any of the following are true at
decision time:

1. No concrete enterprise customer requirement -- "would be nice"
   isn't sufficient justification for 8 weeks of refactor.
2. The multi-instance use case can be served by a different
   architecture (e.g. shared Redis for cache invalidation + sticky
   sessions on the load balancer).
3. The compliance audit accepts SQLite + Litestream + filesystem
   encryption + documented backup procedures.

## What we can do without committing to Postgres

Several pieces of Postgres-prep work are independently valuable and
can land incrementally:

- **Audit the sync DB usage.** Identify the hot-path callsites where
  an `await` boundary would matter most. Document.
- **Schema dialect catalogue.** List every SQL feature the existing
  code uses; classify each as "portable" / "needs translation" /
  "SQLite-only". The bulk of this work is in `src/database.ts`
  SCHEMA constant + the migration ALTERs.
- **Lower-cost wins.** The audit-chain (v0.9.1) backfill already
  uses portable SQL; new code can follow that pattern without
  committing to Postgres.

These deliver lasting value (better SQL hygiene, clearer documentation)
even if the Postgres milestone never starts.

## Open questions

1. **Who is the first customer?** A real Postgres deployment with a
   real compliance requirement would unlock the budget for the
   8-week project. A speculative one does not.

2. **Will Postgres-enabled multi-instance need a Redis layer
   anyway?** Most multi-instance OAuth deployments use Redis for
   the rate-limit token bucket + membership cache invalidation, not
   the user database. So Postgres alone may not deliver
   multi-instance -- it's a necessary-but-not-sufficient piece.

3. **What's the upgrade path?** A SQLite -> Postgres migration tool
   that reads the SQLite file and emits a Postgres `.sql` dump is
   real work (~1 week) but operators will need it.

## Decision for the autonomous-loop session

Land **this spec** as the contract for what Postgres support would
look like + what it would cost. Do NOT start the sync→async
conversion in the same loop session -- the integration risk on a
multi-week refactor delivered in one autonomous burst is too high
for what's currently a single-instance product.

The Postgres adapter remains on the roadmap as a v0.11.0+ project
contingent on the no-go criteria above flipping. The
incremental-wins items in the previous section CAN be picked up in
future loop sessions if the user wants to derisk a future Postgres
push without committing to it.
