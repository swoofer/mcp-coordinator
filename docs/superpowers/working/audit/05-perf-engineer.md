# Performance Engineering Audit — mcp-coordinator

## Score: Perf transparency = 3/10

The page asserts three numbers (`<5ms detection`, `<50ms push`, `30-45s consensus`) with zero
methodology, zero hardware, zero N. The README's "Test Results" table is presented next to a
216-test footer link, but `tests/unit/` contains **no perf or benchmark file** (verified via Glob
of `tests/unit/*.ts`). No CI perf gate, no `bench/` directory, no published harness.

## Concerns about the claims

1. **"<5ms detection" is unconditional and untested.**
   `ImpactScorer.score()` (`src/impact-scorer.ts:34-149`) loops over **every online agent** ×
   their **active threads** × per-file SQLite `checkFileConflict` calls (Layer 1 + 2).
   Each call hits `file_activity` with a `datetime('now', '-N minutes')` predicate (`src/file-tracker.ts:42-50`).
   Cost grows roughly O(agents × target_files × deps) and per query touches an unbounded
   table. With 10 agents × 5 files × 3 deps = 150 disk-bound queries per `announce_work`.
   Where is the latency vs N curve? No data published.

2. **"<50ms MQTT push" mixes two paths and ignores QoS.**
   Grep for `qos|QoS` across `src/`: zero matches. `MqttBridge.publish*` (`src/mqtt-bridge.ts:104-170`)
   uses the mqtt.js default = **QoS 0 (at-most-once, fire-and-forget, no ack)**. Latency
   measurement is therefore meaningless: a packet that's silently dropped on a busy WS link
   "delivers in 0ms". Claim is unfalsifiable as published. No LAN vs WAN split, no jitter, no
   p99.

3. **"30-45s consensus" is a behavioral range, not a system metric.**
   Consensus time is dominated by **agent LLM round-trips** (Claude turn latency, polling
   cadence — see README "Push vs polling" section), not by the coordinator. Publishing it as
   an engineering number conflates the protocol with whoever is on the other end. A slow
   model or a 30s polling loop will trivially blow the upper bound.

4. **`file_activity` is unbounded and has no GC.**
   Schema (`src/database.ts:83-92`) declares an autoincrement append-only table. Grep for
   `DELETE FROM file_activity|cleanup|TTL|prune`: only `/api/reset` (test-only,
   `src/serve-http.ts:449`) deletes it. Index `idx_file_activity_path` exists, but the
   `datetime('now', '-N minutes')` predicate is **not sargable** against it — SQLite will scan.
   After a multi-week team run the hot path degrades silently. No retention policy in code,
   none documented.

5. **SSE fan-out is synchronous and serial.**
   `SseEmitter.emit` (`src/sse-emitter.ts:9-26`) does an INSERT then a `for` loop calling
   every listener inline; `handleSse` (`src/serve-http.ts:602-625`) writes directly on the
   request socket. **One slow consumer (slow client, paused tab) blocks the emit path** for
   every other consumer and the originating MCP tool call. No backpressure, no per-listener
   queue, no drop policy. N consumers cost O(N) per event, on the request thread.

6. **Quota check is on the request path with a network fallback.**
   `QuotaCache.get()` (`src/quota/quota-cache.ts:100-103`) awaits `refresh()` on stale cache,
   which awaits `fetch()` to `api.anthropic.com` (`src/quota/quota.ts:65-70`). The
   single-flight dedupe is good, but the **first stale request blocks on a WAN call** with no
   timeout in the fetch itself. A slow Anthropic response stalls every concurrent
   `coordinator_status`. TTL is 120s, 429 cool-down 5 min — neither is shown to the user.

7. **SQLite WAL is enabled (`busy_timeout = 5000`) but write contention isn't characterized.**
   Good: `journal_mode=WAL` set in both adapters (`src/database.ts:143, 154`). Bad: WAL
   serializes writes, so concurrent `announce_work`/`log` from N agents queue. No published
   throughput ceiling, no profile of contention at 10/50/100 agents.

8. **Listener fan-out in MqttBridge is also serial.**
   `MqttBridge.connect` `on("message")` handler (`src/mqtt-bridge.ts:51-77`) iterates
   `this.listeners` sequentially per inbound MQTT message — same blocking-consumer hazard.

## 3 missing benchmarks the doc must publish

1. **Detection latency vs scale matrix:** `score()` p50/p95/p99 at N = 1, 10, 50, 100 online
   agents and `file_activity` table size = 0, 10k, 100k, 1M rows. Hardware specified.
2. **MQTT delivery: explicit QoS, link, payload — and loss rate.** Push latency p50/p99
   for QoS 0 vs QoS 1 vs QoS 2 over loopback / LAN / WAN, with packet-loss percentage at
   each level (the current claim is silently dependent on no loss).
3. **Concurrent-write throughput on SQLite WAL:** `announce_work` ops/sec sustained at 10/50/100
   concurrent writers, including p99 latency under contention and the point at which
   `busy_timeout = 5000` starts firing SQLITE_BUSY.

Until these land, the perf table on the landing page should be relabeled "indicative on the
maintainer's laptop, single-agent path" or removed.
