# Code Audit Synthesis — mcp-coordinator v0.2.1

**Date**: 2026-05-10
**Method**: 20 autonomous critical experts, each reading actual source files (not docs)
**Average score**: **4.85/10**

## Score breakdown

| # | Expert | Score |
|---|--------|------:|
| 11 | Resource Management | 3/10 |
| 1 | Software Architect | 4/10 |
| 3 | Async/Concurrency | 4/10 |
| 5 | MQTT Protocol | 4/10 |
| 7 | Security | 4/10 |
| 9 | Performance | 4/10 |
| 13 | Refactoring | 4/10 |
| 18 | HTTP/SSE | 4/10 |
| 19 | Edge Cases | 4/10 |
| 4 | Database/SQLite | 5/10 |
| 8 | API Design (MCP tools) | 5/10 |
| 10 | Error Handling | 5/10 |
| 15 | Build/Tooling | 5/10 |
| 16 | Logging | 5/10 |
| 2 | TypeScript | 6/10 |
| 12 | Code Quality | 6/10 |
| 20 | MCP Spec Conformance | 6/10 |
| 6 | Test Quality | 6.5/10 |
| 17 | CLI UX | 6.5/10 |
| 14 | Dependencies | 7.5/10 |

---

## 🔴 BLOCKING bugs (multiple experts independently found these)

### B1. Race condition in `announceWork` and `approveResolution` — no transactions
**Reported by**: Backend, Async, Database, Errors, Refactoring, Edge Cases (6 experts)

`consultation.ts:64-131` (announce) and `consultation.ts:196-214` (approve) do read-then-write across multiple tables WITHOUT `db.transaction()`. Two concurrent agents announcing the same file will produce inconsistent thread state. Two concurrent approvals will fire duplicate consensus emissions. **This breaks the "work-stealing claim (atomic)" claim in the docs.**

**Fix**: wrap in `db.transaction(() => { ... })`. The API exists in `database.ts` but is unused in hot paths.

### B2. `checkTimeouts` runs as side-effect inside `getThread`/`listThreads`
**Reported by**: Async, Database, Performance, Code Quality (4 experts)

`consultation.ts:317-343, 346, 376` — every read fires a full table scan with `datetime()` predicate, AND mutates state. N parallel readers fire N duplicate `timeout` emissions for the same thread. Performance + correctness double bug.

**Fix**: extract to dedicated background worker on a timer, never call from getters.

### B3. MQTT broker has ZERO authentication
**Reported by**: Security, MQTT (2 experts)

`mqtt-broker.ts:59` instantiates Aedes with no `authenticate`/`authorizePublish`/`authorizeSubscribe` hooks. WS upgrade handler at `mqtt-broker.ts:100-105` bypasses JWT entirely. **Anyone on the LAN can publish forged claims like `coordinator/consultations/+/claimed`.**

Combined with `COORDINATOR_BIND=0.0.0.0` (the README's team-mode instruction), this is internet-exposable in a LAN scenario.

**Fix**: wire Aedes auth to the same JWT, gate both TCP + WS upgrade.

### B4. `/api/reset` is unauthenticated by default and wipes the DB
**Reported by**: Security (1 expert, but severity HIGH)

`serve-http.ts:759` exposes `/api/reset`. `AUTH_ENABLED` defaults to `false`. Any HTTP POST wipes `consultations`, `agents`, `file_activity`, `events`. **Single curl command destroys all coordination state.**

**Fix**: require admin token; or remove the endpoint entirely.

### B5. Dashboard path traversal
**Reported by**: Security, HTTP/SSE (2 experts)

`serve-http.ts:687-690` — `url.replace("/dashboard/", "")` joined into `path.join` with no `path.resolve`/`startsWith` guard. Reading `/dashboard/../../../etc/passwd` returns the file. **Pre-auth.**

**Fix**: canonicalize path and validate it stays under the dashboard root.

### B6. No graceful shutdown
**Reported by**: Resources, Errors, DevOps (3 experts)

No SIGTERM handler. `serve-http.ts:814` and `index.ts:28` exit on uncaught throws. No HTTP in-flight drain, no SSE client cleanup, no DB close, no MQTT close, no PID-file cleanup. **Daemon mode leaks PID file on every restart cycle.**

**Fix**: register `process.on('SIGTERM')` to coordinate shutdown across all subsystems.

---

## 🟠 STRUCTURAL issues (multiple experts independently)

### S1. Two god files: `serve-http.ts` (820 lines) and `server-setup.ts` (526 lines)
**Reported by**: Architect, Code Quality, Refactoring, HTTP/SSE (4 experts)

`serve-http.ts` is bootstrap + 420-line REST router + auth + SSE + lifecycle + MCP multiplexing + dashboard static — all in one file. `server-setup.ts` registers 23 tools inline in a single 420-line function.

**Fix**: split per-domain (`tools/agents.ts`, `tools/consultation.ts`, `tools/files.ts`); split HTTP into router + middleware modules.

### S2. Duplicated `announce_work` logic in two transports
**Reported by**: Architect, Refactoring (2 experts)

`server-setup.ts:160-263` (MCP tool) and `serve-http.ts:145-221` (REST endpoint) are ~100 lines of NEAR-IDENTICAL orchestration: scoring + auto-resolve + SSE/MQTT fanout. Bug fixes need to land in two places.

**Fix**: extract `AnnounceWorkflow.execute()` use-case class.

### S3. Network layer (`serve-http.ts`, `server-setup.ts`, `mqtt-bridge.ts`, `mqtt-broker.ts` = ~1727 LOC) has effectively ZERO test coverage
**Reported by**: Tests (1 expert)

The 216 unit tests focus on domain logic. The transport/protocol layer is uncovered. `vitest.config.ts:5-7` sets `fileParallelism: false` — this hides race conditions that production would expose.

**Fix**: add HTTP route integration suite, MQTT bridge round-trip suite, concurrent `announce_work` race suite.

---

## 🟡 PROTOCOL/PERFORMANCE issues

### P1. MQTT QoS 0 everywhere + no retained messages + no LWT
**Reported by**: MQTT, Async (2 experts)

Every publish in `mqtt-bridge.ts:97-169` is fire-and-forget (default QoS 0). `publishTaskClaimed` and `publishTaskCompleted` can vanish on disconnect. Coordinator restart loses event history (no retain). No will-and-testament means a crashed agent looks online indefinitely.

**Fix**: QoS 1 for state-change messages, retain `consultations/new`, register LWT on connect.

### P2. Impact scorer is O(A·T·F²) with 4·A JSON.parse calls per `announce_work`
**Reported by**: Performance, Edge Cases (2 experts)

`impact-scorer.ts` parses agent.modules JSON inside the loop, scans all resolved threads with no `since` parameter. The "<5ms detection" claim doesn't survive >10 agents and >100 file activities.

**Fix**: cache parsed modules; add `since` parameter to thread query; precompute file→agents reverse index.

### P3. SSE listener leak + no client cap + sync fan-out
**Reported by**: Resources, HTTP/SSE, Performance (3 experts)

`sse-emitter.ts:9-26` and `serve-http.ts:602-625` — listener array grows without bound, fan-out is synchronous (slow consumer blocks all), no heartbeat means proxies kill idle connections silently.

**Fix**: cap concurrent SSE clients, add 30s heartbeat, async fan-out with backpressure.

### P4. `db-adapter.ts` is a phantom abstraction
**Reported by**: Refactoring, Code Quality (2 experts)

It just re-exports `better-sqlite3` types. Adds no portability. Coupled to 50+ call sites including `getDb()` in serve-http.ts. Replacing SQLite would require rewriting 50 files.

**Fix**: either make it a real abstraction or delete it.

---

## 🟢 STRENGTHS (also noted)

- Dependencies: 7.5/10 — clean MIT-friendly tree, jose for JWT (good crypto choice), better-sqlite3 (right call for sync API)
- TypeScript strict mode enabled
- Test quality good for domain modules (consultation: 54 tests, quota: 24 tests)
- CLI doctor command exists and works (CLI UX 6.5/10)
- Logger structure is sound (Pino + child component loggers)
- Quota module has solid error handling and fake-timer tests

---

## 🚦 Verdict on the marketing claims

| Claim from landing | Reality from code |
|---|---|
| "<5ms detection" | False at scale (P2: O(A·T·F²)) |
| "<50ms push" | True for QoS 0 in-process; false across reconnect (P1) |
| "Work-stealing (atomic)" | False — no transaction (B1) |
| "Conflicts caught before code is written" | True conditional on agents actually polling/subscribing |
| "Production-ready" (FAQ) | False — no graceful shutdown (B6), no metrics (DevOps audit), unauthenticated `/api/reset` (B4) |
| "26 MCP tools" | True (verified by tech-accuracy in earlier audit) |
| "216 unit tests across 18 files" | True but transport layer untested (S3) |
| "Embedded MQTT broker" | True but unauthenticated (B3) |

---

## Top 5 priorities (highest impact ÷ effort)

1. **Wire Aedes JWT auth** (fixes B3, partially B5) — security blocker, ~half-day
2. **Wrap state transitions in `db.transaction()`** (fixes B1) — correctness blocker, ~day
3. **Move `checkTimeouts` to background worker** (fixes B2) — correctness + perf, ~half-day
4. **Add SIGTERM graceful shutdown** (fixes B6) — operability, ~day
5. **Auth-gate `/api/reset` or remove** (fixes B4) — data safety, 5 minutes

---

## Recommended roadmap impact

The current roadmap (`v0.3 — Semantic conflict detection`) ignores these issues. Suggest re-prioritizing:

- **v0.2.2 (security patch)**: B3, B4, B5 — same week
- **v0.3 — Correctness pass**: B1, B2, B6 — make claims true before adding features
- **v0.4 — Operability**: metrics, graceful shutdown, container, backup story
- **v0.5 — Semantic detection**: original roadmap goal
- **v1.0**: stable API + cross-repo
