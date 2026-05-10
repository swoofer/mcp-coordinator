# Refactoring Audit — mcp-coordinator-new

**Score: 4/10**

The shape works (clear domain boundaries: registry / consultation / file-tracker / impact / mqtt / sse) but the *seams* leak. Two giant transport files re-implement the same orchestration, raw SQL escapes the data classes, and `db-adapter` is a phantom abstraction.

## Refactor Opportunities

### 1. Duplicated `announce_work` orchestration (HIGHEST LEVERAGE)
`server-setup.ts:160-263` (MCP path) and `serve-http.ts:145-221` (REST path) are **~100 lines of near-identical logic**: assess plan, detect conflicts, categorize impact, override `expected_respondents`, auto-resolve, emit SSE for impact/introspection, emit `thread_opened`, MQTT publish. Any bugfix must be applied twice (e.g., the `// Only auto-resolve...` comment is copy-pasted verbatim at `server-setup.ts:199` and `serve-http.ts:169`).
**Extract** `AnnounceWorkflow.execute(params): { thread, conflicts, impact, context }` into a new `src/workflows/announce.ts`. Both transports call one method.

### 2. Raw SQL leaks inside transport layer
`serve-http.ts:165-180, 261-278, 287-294, 405-414, 442-454` — handlers do `(await import("./database.js")).getDb().prepare("UPDATE threads SET ...")`. The `Consultation` class exists precisely so SQL stays in one place; bypassing it for `claim`, `unclaim`, `poison`, `reset`, `expected_respondents` updates means the schema is now coupled to the HTTP layer.
**Extract** `Consultation.claimTask`, `unclaimTask` (with poison logic), `setRespondents`, `autoResolveIfAlone`. Move `/api/reset` SQL into a `Database.resetAll()` helper.

### 3. `db-adapter.ts` is a no-op abstraction
File defines `DatabaseAdapter`/`Statement`/`RunResult` interfaces, then `database.ts:146,157` does `return raw as DatabaseAdapter` — i.e., the interface is **structurally identical to better-sqlite3**, so swapping in postgres breaks every `getDb().prepare("...")` call (52 sites). The "adapter" provides zero translation.
**Decision time:** either delete the abstraction (rename to `SqliteHandle`, accept the lock-in) OR build a real query builder / repository that hides SQL. Half-abstractions cost more than they save.

### 4. `Consultation` is a god object
`consultation.ts` (500 lines) handles: thread CRUD, message CRUD, resolution lifecycle (propose/approve/contest/cancel/close), timeout sweeping, agent departure cleanup, action-summary CRUD, and update polling. SRP violation — `ActionSummary` has nothing to do with consultation threads.
**Split into** `ThreadStore` (CRUD + listThreads/getThread), `ResolutionEngine` (propose/approve/contest/cancel/close + emitResolution + allRespondentsApproved), `ActionSummaryStore` (logActionSummary, getActionSummaries*). `checkTimeouts()` belongs in a `TimeoutSweeper` running on a real interval, not piggy-backed on every `getThread()`/`listThreads()` call (line 346, 376) which makes reads write-heavy.

### 5. SSE+MQTT dual-publish boilerplate
`server-setup.ts:122-124, 243-250, 278-284, 296-297` and `serve-http.ts:104, 124, 142, 212-220, 296-298, 316-320` — every state change does `sseEmitter.emit(type, payload); mqttBridge.publish<X>(...)`. Two channels, hand-wired N times. The `consultation.onResolve` callback at `server-setup.ts:82-96` already proves the right pattern (one event → fan out).
**Extract** `EventBus.publish(domainEvent)` with subscribers `[sseEmitter, mqttBridge]`. Domain code emits once.

### 6. Tight `serve-http.ts` coupling (838 lines, 25+ routes inline)
One giant `if/else if` chain handles auth, REST, SSE, MCP, dashboard static files, MQTT broker startup. `handleRest` alone is ~420 lines. No router, no middleware composition.
**Extract** `routes/agent.ts`, `routes/thread.ts`, `routes/quota.ts`, `routes/admin.ts` + a 20-line dispatch table.

### 7. `FileTracker.fileToModule` belongs in a pure utility
`file-tracker.ts:52-60` is a pure path-parsing function on an instance method. Used by file-tracker logging only, but the same "first 2 path segments = module" convention likely lives elsewhere (impact-scorer, conflict-detector). **Extract** `src/util/module-path.ts`.

## Top 3 Highest-Leverage

1. **#1 Workflow extraction** — kills ~200 lines of duplication and the silent drift risk between MCP/REST.
2. **#2 SQL repatriation** — restores the data-layer invariant; without it #4 can't be split cleanly.
3. **#5 EventBus** — collapses cross-cutting fanout, makes adding a third channel (webhooks, log shipping) trivial.

DONE — `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\13-refactoring.md`
