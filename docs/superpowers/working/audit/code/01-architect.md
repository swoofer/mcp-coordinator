# Architecture Audit — mcp-coordinator

**Score: 4 / 10**

A working prototype that crossed the threshold of "complex enough to need real layering" three commits ago and never refactored. Two transports, two MCP tool surfaces, one giant SQL grab-bag — held together by a global singleton DB.

## Findings

### F1. Two parallel tool surfaces, copy-pasted logic — `server-setup.ts:160-263` vs `serve-http.ts:145-221`
`announce_work` (MCP tool) and `POST /api/announce` (REST) implement the same ~100 lines: `assessPlanQuality`, `impactScorer.categorize`, the `expected_respondents` UPDATE, the auto-resolve guard, the gray-zone introspection loop, the impact_scored fanout, the downgrade-event emit. Two near-identical copies. A bug fixed in one will live on in the other (and clearly already has — the `(await import("./database.js")).getDb()` raw SQL UPDATEs at `server-setup.ts:184` and `serve-http.ts:167` are byte-identical workarounds). This is the single largest defect in the codebase.

### F2. `serve-http.ts` is an 820-line god file mixing 6 responsibilities
Lines 1-83: bootstrap, env parsing, JWT helpers. 85-506: a 420-line `if/else if` ladder that *is* the REST router (`handleRest`). 508-575: auth router. 586-625: SSE encoding + handler. 627-809: server lifecycle, MCP transport multiplexing, MQTT broker startup, dashboard static serving. No router abstraction, no controller layer — every endpoint is a branch in one function. Adding a route means scrolling to find the right `else if` and grepping that you didn't shadow an earlier match (the `url?.startsWith` checks at lines 329, 425, 483 are order-sensitive).

### F3. Persistence leaks through every layer via `getDb()` global singleton — 50+ call sites
`database.ts:8` declares `let db: DatabaseAdapter` as module state. Every service (`agent-registry`, `consultation`, `file-tracker`, `sse-emitter`, `dependency-map`, `introspection`, `agent-activity`, `auth`) calls `getDb()` directly inside method bodies. The transport layer bypasses services entirely with raw SQL: `serve-http.ts:267-279` writes the poison-threshold logic (`UPDATE threads SET claimed_by = NULL ... unclaim_count = COALESCE(unclaim_count, 0) + 1`) and `serve-http.ts:441-454` does a bare `DELETE FROM` table sweep. Worse, six sites use `(await import("./database.js")).getDb()` (`serve-http.ts:165, 261, 287, 405, 442`; `server-setup.ts:183, 195`) — dynamic import for a module already statically imported in the file. Tests cannot stub the DB without monkey-patching the module.

### F4. Domain logic embedded in the HTTP handler — claim/unclaim/poison live in `serve-http.ts`, not in a service
`/api/claim-task` (`serve-http.ts:281-310`) and `/api/unclaim-task` (255-280) are core consultation behaviours: optimistic claim, directed-dispatch enforcement, poison-threshold after `POISON_THRESHOLD = 2` aborts. None of this lives on the `Consultation` class — the SQL is hand-written in the route handler. The MCP surface in `server-setup.ts` doesn't expose claim/unclaim at all, so STDIO-mode agents physically cannot work-steal. A symptom of having no `TaskClaimingService`.

### F5. Hidden SSE/MQTT side-effect coupling in `createServices` — `server-setup.ts:62-96`
The factory wires three back-channels: `quotaCache.onRefresh` directly calls both `sseEmitter.emit` and `mqttBridge.publishQuotaUpdate`; an SSE listener is added to the emitter that calls back into `quotaCache.onAgentActive/onAgentInactive`; `consultation.onResolve` fans out to SSE + MQTT. This is the *only* integration wiring in the codebase, hidden inside a "services factory." Removing one transport means surgery in the constructor. There is no event bus, no `Notifier` interface — every emitter has hard-coded knowledge of every transport.

### F6. `consultation.ts` (499 lines) does five jobs: persistence, lifecycle FSM, timeout sweeper, message store, action-summary store
The class holds the thread state machine (`announceWork`, `proposeResolution`, `approve/contest`, `cancelThread`, `closeThread`, `handleAgentDeparture`), is also the message repository (`postToThread`, `getThreadUpdates`), is also the action-summary repository (`logActionSummary`, `getActionSummaries`, `getActionSummariesBySession` — three methods that have nothing to do with consultations), and is also the timeout sweeper (`checkTimeouts` is called *eagerly inside every `getThread` and `listThreads` read*, `consultation.ts:346, 376` — every read does an UPDATE).

### F7. `impact-scorer.ts:60-66` queries resolved threads via a `listThreads({ status: "resolved" })` then filters in JS for the 30-min window
A scan of every resolved thread on every announce. No `since` parameter on `listThreads`. At a few hundred resolved threads the cost is invisible; at production scale it isn't.

## Refactor Recommendations

1. **Kill the duplicate announce path.** Extract a single `AnnouncementService.announce(params)` that owns plan quality, impact scoring, expected-respondents persistence, auto-resolve, introspection creation, and event fanout. `server-setup.ts:announce_work` and `serve-http.ts:/api/announce` become 5-line adapters. Repeat for claim/unclaim/propose/approve.

2. **Introduce a Repository layer + DI.** Replace `getDb()` global with a `Repositories` bag (`ThreadsRepo`, `MessagesRepo`, `EventsRepo`) injected into services via constructor. Delete every `(await import("./database.js"))` call site. Move the raw SQL out of `serve-http.ts` into the repos. Tests can pass a mock `DatabaseAdapter`.

3. **Split `serve-http.ts`.** A `routes/` directory with one file per resource (`routes/threads.ts`, `routes/agents.ts`, `routes/auth.ts`, `routes/quota.ts`, `routes/events.ts`); a 50-line `serve-http.ts` that only owns the HTTP server, MCP transport multiplexing, dashboard static, and broker startup. Replace the `if/else if` ladder with an explicit table or a tiny router.
