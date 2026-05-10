# Performance Audit — mcp-coordinator

**Score: 4/10**

The code works for small swarms (≤10 agents, ≤100 threads/day) but the
"<5ms detection" claim is **not credible at scale**. Hot paths re-parse JSON
per agent, run nested O(N·M·F) scans, and call `checkTimeouts()` on every
read. SQLite is `better-sqlite3` (synchronous) — every query blocks the event
loop. No cache exists; no indexes are visible from these files.

---

## Hotspots

### 1. `impact-scorer.ts:34-149` — O(A · T · F) with JSON.parse per iteration
`score()` runs for every announce. Per online agent A, it iterates active
threads T (3 listThreads queries fired *before* filtering by initiator!) and
inside each thread loops target_files F with `Array.includes` (O(F²)).
Complexity: **O(A · T · F²) + 4·A JSON.parse calls**. For 20 agents × 50
open threads × 10 files = **10k inner ops + 80 parse calls** per announce.
The 3 `listThreads()` calls each issue a SQL query *and* trigger
`checkTimeouts()` — a recursive query — see #4.

### 2. `consultation.ts:317-343, 346, 376` — `checkTimeouts()` runs on every read
`getThread()` (line 346) and `listThreads()` (line 376) call `checkTimeouts()`
unconditionally. Each call executes 2 SQL statements with `datetime()`
arithmetic on every row. A single `score()` call → 3 listThreads → 3
checkTimeouts → 6 SQL scans. Plus `getThread()` is invoked recursively from
`emitResolution()`, `postResolutionMessage()`, `proposeResolution()`,
`approveResolution()`, etc. **A single resolve cascade fires 8-12 timeout
sweeps.**

### 3. `consultation.ts:287-314` — O(N) JSON re-encode on agent departure
For every open thread, the code: `JSON.parse` → `filter` → `JSON.stringify` →
UPDATE → `getThread()` (which fires checkTimeouts!). Then potentially fires
`emitResolution()` which queries again. **3-4 SQL round trips per thread,
all synchronous.** With 100 open threads, departure = 300+ blocking queries.

### 4. `mqtt-bridge.ts:51-77` — Broadcast fanout to ALL listeners regardless of topic
Every consultation message is delivered to every registered listener
(`for (const listener of this.listeners.values())` line 66). No topic
filtering, no per-agent routing. With N agents, each MQTT msg = O(N)
deliveries even when only one agent cares. **Memory leak risk**: queued
messages accumulate in `listener.queue` forever if `waitForMessage` is
never called (no bound, no eviction). A silent agent → unbounded growth.

### 5. `sse-emitter.ts:9-26` — Synchronous SQLite write blocks every event
Every `emit()` issues a synchronous INSERT before any listener fires.
Listeners run **inline in the emitter's call stack** — a slow listener
blocks all others and the caller. No try/catch around `listener(event)`,
so one throw kills the whole fanout. `addListener` uses array.filter on
removal (O(N)), fine for now but pattern doesn't scale past ~50.

### 6. `file-tracker.ts:42-50` — `checkFileConflict` called per target file
`impact-scorer.ts:99-109` loops `params.target_files` and fires one SQL
per file. 10 target files = 10 round-trips. Combined with Layer 2's
depends_on loop = 20 sequential `datetime()` queries per scoring pass.
Should be a single `WHERE file_path IN (...)` query.

### 7. `consultation.ts:154` — Token estimate is a magic divide
`Math.ceil(content.length / 4)` is fine perf-wise but masks a real cost:
no length cap on `content`. A 10MB content string = 2.5M token claim
stored to SQLite. No backpressure.

---

## "<5ms detection" claim — traceability

`announceWork()` → `score()` path:
- `registry.listOnline()` — 1 SQL
- 3× `listThreads()` — 3 SQL + 3× `checkTimeouts()` (6 SQL) = 9 SQL
- N × `checkFileConflict()` (Layer 1+2) — up to 2·F·A SQL
- N × `JSON.parse(agent.modules)` — A allocations

For 10 agents, 5 files: **~110 sync SQL calls + 40 JSON.parse**. On a warm
SSD this is 5-15ms. The claim only holds for trivial swarms.

---

## Top 3 Optimizations

1. **Cache `checkTimeouts()` with TTL (1s).** Single change eliminates
   80% of redundant SQL. Store `lastTimeoutSweep` timestamp on the
   Consultation instance.
2. **Batch `checkFileConflict` into one IN-clause query** in `impact-scorer`.
   Cuts 20 sequential queries to 1.
3. **Bound `mqtt-bridge` listener queues** (e.g., 100 msgs, drop-oldest)
   and add topic-prefix filtering so each agent only receives its own
   thread updates. Fixes both leak and fanout amplification.

---

`C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\09-performance.md`
