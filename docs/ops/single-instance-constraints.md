# Operations — Single-Instance Constraints

This runbook explains why the Phase 2 coordinator MUST run as a single
process per data directory, what guarantees break under multi-instance
operation, and the Phase 5 plan for horizontal scaling.

References:

- `src/auth/rate-limit.ts` — in-memory token-bucket limiter
  (`RateLimiter` class, single-instance design).
- `src/auth/membership-cache.ts` — in-memory IdP membership cache
  (`MembershipCache`, 60s positive TTL, 10min stale-on-error window).
- `src/security/audit-queue.ts` — in-memory Tier 2 audit buffer
  (10,000 row capacity, 100ms flush).
- `src/sweeper/index.ts` — single-instance retention sweeper
  (60s setInterval; 5-failure circuit breaker).
- `src/auth/login-lockout.ts` — login lockout state (in-memory).
- `src/auth/token-epoch.ts` — `bumpTokenEpoch` read race surface.
- V3 §B-NEW-7 (single-instance contract), V4 §17 (Phase 5 plan).

## TL;DR

The Phase 2 coordinator keeps four pieces of correctness-critical state
in memory: the rate-limit token buckets, the IdP membership cache, the
Tier 2 audit queue, and the sweeper's circuit-breaker counter. Running
two coordinator processes against the same SQLite database breaks
rate-limit and lockout guarantees, doubles IdP API call volume, races
on token-epoch reads, and produces unpredictable audit drop behaviour.
**Run exactly one coordinator process per data directory.** Phase 5
introduces Redis-backed equivalents that lift this constraint.

## Background

### What lives in memory

The Phase 2 design intentionally keeps several pieces of state in
process memory rather than in SQLite. The reasoning is performance and
correctness trade-offs at a single-tenant scale:

| Component        | Module                            | Why in-memory                                                                 |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| Rate limiter     | `src/auth/rate-limit.ts`          | Per-request decision; SQLite round-trip per check is excessive at hot-path latency. |
| Membership cache | `src/auth/membership-cache.ts`    | Avoids hitting the IdP on every authenticated request; 60s TTL is too short to persist meaningfully. |
| Audit queue      | `src/security/audit-queue.ts`     | Batched flush at 100ms decouples hot-path latency from disk write fsync.      |
| Sweeper state    | `src/sweeper/index.ts:63-75`      | Circuit-breaker counter and per-table delete totals are operational telemetry, not authoritative state. |
| Login lockout    | `src/auth/login-lockout.ts`       | High-rate read; per-IP and per-user-family buckets evolve on every login attempt. |

The trade-off: each piece is correct for a single process, but a
second process running against the same DB has no visibility into the
first process's in-memory state.

## What breaks under multi-instance

### 1. Rate limit doubles

Each instance maintains its own token bucket per `(endpoint,
identifier)` key. A user making N requests per second hits each
instance N/2 times — within each instance's limit, even though the
*aggregate* rate is the configured maximum. Effective rate limit ≈
**configured × instance count**.

Metric impact: `coordinator_rate_limit_blocked_total` will be lower
than expected; abusive actors are not throttled until they exceed the
per-instance limit.

### 2. Login lockout doubles

Same root cause: lockout buckets are keyed by IP/family with an
in-memory counter. An attacker spreading attempts across both instances
gets `2 × LOCKOUT_THRESHOLD` failed attempts before either instance
locks them out.

Metric impact: `coordinator_login_lockout_triggered_total` undercounts;
brute-force attacks succeed for longer.

### 3. IdP call volume doubles

Each instance has its own `MembershipCache`. A user hitting a
load-balanced cluster of two instances generates 2× the IdP API calls
in steady state (each instance misses on first contact, then warms
independently). For a deployment on GitHub with strict 5000-req/hr
limits, this halves the effective per-instance capacity.

Metric impact: `coordinator_idp_api_calls_total` doubles;
`coordinator_idp_rate_limit_remaining` declines faster.

### 4. Token-epoch read race

The token-epoch invalidation pattern is:

1. Operator bumps `users.token_epoch` (writes to DB).
2. Coordinator reads the bumped epoch on every authenticated request.
3. Tokens with `iat < bump_time` are rejected.

In a multi-instance deployment, an instance can serve an authenticated
request immediately after the bump SQL committed on another instance,
*before* its own per-request read sees the new epoch. The window is
brief but real (SQLite WAL consistency is per-connection; cross-process
visibility requires a read transaction on the second instance).

For Phase 2's threat model — emergency epoch bumps during incident
response — this window is unacceptable: a compromised refresh token
could be replayed during the window with no enforcement.

### 5. Audit queue drop semantics become probabilistic

Each instance's queue is independently bounded at 10,000 rows. A burst
that splits 60:40 across two instances might cause Instance A to drop
events while Instance B is fine, producing inconsistent forensic
coverage. The `system.shutdown.audit_loss` row written on SIGTERM is
per-instance, not aggregate.

### 6. Sweeper duplication

Both instances run `setInterval(runPass, 60_000)`. They will fight for
the SQLite write lock and at least one will fail intermittently — when
it fails 5 times in a row (`CIRCUIT_BREAK_THRESHOLD = 5` at
`src/sweeper/index.ts:49`), its circuit opens, the sweeper stops, and
`/health/ready` may report 503. The surviving sweeper still trims
rows, but you've lost the redundancy benefit and gained noisy alerts.

### 7. Migration race at boot

Both instances run `initDatabase()` and try to apply schema migrations.
The migration SQL is mostly idempotent (`IF NOT EXISTS` everywhere)
but `PRAGMA user_version` writes race. The losing instance may see a
half-applied migration state. This is the most dangerous multi-instance
hazard — a botched migration can corrupt the schema.

## Operational rule

> **One coordinator process per `data/` directory.**

This is enforced by convention, not by code today (Phase 2 has no
process-level mutex). Standard tools to maintain it:

- `systemd` unit with `Type=simple` and no `Restart=` storms.
- `kubectl` Deployment with `replicas: 1` and `strategy: Recreate`
  (NOT RollingUpdate — RollingUpdate briefly runs two replicas).
- Docker Compose with `restart: unless-stopped` and a single service
  replica.

WARNING: A Kubernetes RollingUpdate strategy puts you into a brief
two-instance state during rollouts. Always use `Recreate` for the
Phase 2 coordinator.

## Migration to multi-instance (Phase 5 plan)

Phase 5 introduces a Redis (or compatible) dependency that backs each
in-memory component. The migration is incremental:

### Rate limiter

Swap `RateLimiter` for a Redis-backed implementation using the
`INCR` + `EXPIRE` pattern. The current class interface
(`check`, `sweep`) stays unchanged — the swap is a pure DI change.
See the comment at `src/auth/rate-limit.ts:30-32`.

### Login lockout

Same pattern as rate limiter — Redis `INCR` per `(family, type)` key
with `EXPIRE` set to the lockout window. Lockout state is
distributed; brute-force protection is global.

### Membership cache

Redis `SETEX` per `(user_id, provider)` key with the 60s positive
TTL. Stale-on-error promotion stays in-process (it's a transient
fallback during IdP outages). Cache hits become a network round-trip
to Redis instead of a Map lookup — slightly slower but eliminates
the cross-instance staleness problem.

### Audit queue

Redis Streams with a single consumer group. Each instance enqueues to
the stream; a dedicated flusher (could be a third process, or
elected-leader pattern) drains to SQLite. The bounded-capacity drop
semantic moves from process memory to a Redis `MAXLEN` setting.

### Token epoch

Already addressed by Redis pub/sub: when a `token_epoch` bump is
written to SQLite, publish the user_id to a Redis channel; all
instances subscribe and invalidate their per-request epoch cache.
The read race window collapses from "until next per-request read" to
"until next Redis pub/sub propagation" (single-digit milliseconds).

### Sweeper

Use a Redis lock (`SET key NX EX`) with a 60s TTL to elect one
sweeper across the cluster. Other instances skip their tick.
Liveness: the lock auto-expires if the leader crashes.

## Verification (today)

### Confirm single-instance

```sh
# systemd
systemctl list-units 'mcp-coordinator*'    # expect one active unit

# Kubernetes
kubectl get deploy mcp-coordinator -o jsonpath='{.spec.replicas}'   # expect "1"

# Docker
docker ps --filter name=mcp-coordinator | wc -l    # expect 1 + header
```

### Confirm no rolling-update overlap

```sh
kubectl get deploy mcp-coordinator -o jsonpath='{.spec.strategy.type}'
# expect "Recreate", NOT "RollingUpdate"
```

### File-lock evidence

SQLite uses POSIX file locks. If a second process opens the same DB,
it will not be excluded immediately (locks are advisory in WAL mode),
but you can confirm only one process holds the file:

```sh
fuser -v data/coordinator.db    # Linux; expect exactly one PID
lsof | grep coordinator.db      # cross-platform
```

## Failure modes

- **Accidental rolling update**: a Kubernetes RollingUpdate kicks off
  two-instance overlap. Symptoms: `coordinator_sweeper_circuit_open=1`
  on the losing instance shortly after deploy. Fix the strategy and
  manually `resetCircuit()` (see
  `docs/ops/sweeper-circuit-recovery.md`).

- **Shared NFS data directory**: two coordinators on different hosts
  both pointing at the same NFS-mounted `data/`. This is the worst
  case — SQLite's POSIX locks are NOT honoured across NFS, so the
  hazards above stack on top of file-corruption hazards. Never share
  the SQLite file over NFS.

- **Active-passive standby running on warm-start**: an operator
  spinning up a "warm spare" coordinator pointed at the same DB to
  reduce RTO. This briefly creates two-instance state during
  failover. Use Litestream's leader-elected mode or a single-instance
  + fast-restart design instead.

- **Local dev running against production DB**: developer accidentally
  points their laptop coordinator at the production DB via a
  forwarded port + shared volume. This is an exfil hazard, not just
  a correctness hazard. Strictly separate dev and production data
  directories.

- **Sidecar audit-tail / SIEM forwarder reading the DB live**:
  read-only access from another process is generally safe under WAL
  mode (concurrent reads are explicitly supported), but it can hold
  WAL checkpoints open longer than expected and grow the WAL file.
  Prefer reading the audit log via the audit-export tool or a
  scheduled SQL dump rather than tailing the live DB.
