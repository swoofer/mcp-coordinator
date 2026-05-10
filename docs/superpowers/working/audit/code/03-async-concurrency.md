# Async/Concurrency Audit — mcp-coordinator

**Score: 4/10** — multi-step DB sequences run unwrapped, MQTT subscribe before connect, listener fan-out leaks across agents, and timer/listener cleanup is partial. SQLite (better-sqlite3) is synchronous, which masks some races, but the inter-step gaps remain visible to other tickers (`checkTimeouts`, departure handler, MQTT callbacks).

## Hazards

### H1 — Non-atomic resolution: TOCTOU on `allRespondentsApproved` (CRITICAL)
`consultation.ts:196-214` (`approveResolution`). The flow is: `getThread` → `postResolutionMessage` (INSERT) → `allRespondentsApproved` (SELECT) → conditional UPDATE → `emitResolution`. None of this is wrapped in `db.transaction(...)`. If two respondents call `approveResolution` near-simultaneously (both via HTTP/MCP), both can pass the `status === 'resolving'` check, both insert approve rows, and **both observe `allRespondentsApproved === true`** → both run the UPDATE and both fire `emitResolution`. Result: duplicate "consensus" SSE events and duplicate MQTT publishes for one thread. Same shape exists in `contestResolution` (216) and `handleAgentDeparture` (280-315 — the loop reads then writes per thread without a transaction; a concurrent `approveResolution` mid-loop can cause double-resolve).

### H2 — Auto-resolve race on announce (HIGH)
`consultation.ts:64-131` (`announceWork`). The respondent set is computed by reading `agents` (line 82-84) **before** the INSERT. An agent that goes offline between the SELECT and the INSERT is added to `expected_respondents`; a `handleAgentDeparture` running concurrently won't see the still-uncommitted thread, leaving a stale respondent that blocks consensus forever (until the timeout fires). Same for `setOnline` happening after the SELECT — the thread is auto-resolved with `respondentIds.length === 0` even though a matching agent appeared. No transaction wraps the read+insert.

### H3 — MQTT subscribe before connect + race on `this.client!`
`mqtt-bridge.ts:43-50`. `subscribe("coordinator/consultations/#")` and `subscribe("coordinator/broadcast")` are called **outside** the `connect` handler (lines 48-49) — they run synchronously after `mqtt.connect()` returns but before the TCP/WS handshake. With aedes the queued subs usually flush, but on slow brokers the subscriptions are silently dropped and no consultation messages ever reach listeners. Move both into the `"connect"` callback. Bonus: `this.client!.subscribe(...)` outside the handler will throw if `mqtt.connect` ever returns `null` (it doesn't today, but the `!` is unsafe).

### H4 — Event ordering: `consultations/new` is NOT guaranteed before `+/messages`
`mqtt-bridge.ts:104-118`. `publishConsultation` and `publishMessage` are independent `client.publish()` calls with QoS 0 (default). The MQTT spec orders messages **per topic**, not across topics. A subscriber on `coordinator/consultations/#` may receive a `messages` packet before `new` for the same `thread_id` if the producer publishes both within one event-loop tick. Worse: `publishConsultation` is called from `consultation.announceWork` callers, while `publishMessage` is called from `postToThread` — there is no `await` or barrier between them in the upstream caller chain. Subscribers must be defensive (treat `messages` as implicit thread-create), or producer must publish with QoS 1 + retain on `new`.

### H5 — Listener fan-out broadcasts every message to every agent
`mqtt-bridge.ts:51-77`. The `"message"` handler iterates `this.listeners.values()` and pushes the same `QueuedMessage` into **every** registered agent's queue, including the agent that produced it and unrelated agents. Two consequences:
1. Memory growth: queues accumulate without bound — `getQueuedMessages` only drains on agent poll. A quiet agent registered but never polling leaks one queue entry per inbound MQTT message.
2. `waitForMessage` (188-207) returns the first message from any consultation, not just ones relevant to the agent — agents are woken for messages they don't care about. Filter by topic/agent_id at fan-out time.

### H6 — `waitForMessage` timer leak + double-resolve window
`mqtt-bridge.ts:198-206`. The `setTimeout` is never cleared when a message resolves the promise. The 30s/60s timer keeps firing, then the guard `listener.waitResolve === resolve` skips the resolve — but the timer holds a closure over `listener` and `resolve`, preventing GC. Under load (one new wait per agent per poll cycle) this stacks thousands of pending timers. Also: between `if (listener.queue.length > 0) return listener.queue.shift()!` (193) and `listener.waitResolve = resolve` (199) there is no atomic guard — if a message arrives in that microtask window, fan-out (line 67) tries `listener.waitResolve` (still `null`) and pushes to queue; the new wait then sleeps until timeout despite a message being available. Fix: re-check `queue.length` after assigning `waitResolve` inside the Promise executor.

### H7 — `removeListener` drops queued messages silently
`mqtt-bridge.ts:180-186`. Deleting the agent's entry discards `listener.queue`. If an agent disconnects + reconnects across an MCP session boundary, every message that arrived during the gap is lost — there is no replay path through SQLite (consultation messages live in `thread_messages`, but MQTT broadcasts don't). Combined with H3, agents miss state changes on flaky connections.

### H8 — `SseEmitter` listener-list mutation during emit + no removeAllListeners on shutdown
`sse-emitter.ts:23-25`. `emit` iterates `this.listeners` while user-supplied listeners may call the unsubscribe closure returned by `addListener` (35-40), which reassigns `this.listeners = this.listeners.filter(...)`. The for-loop captured the old array reference, so the unsubscribe takes effect on the NEXT emit, not this one — usually fine, but in a re-entrant emit (listener calls `emit` synchronously, common for cascaded events) the new array starts iteration from index 0 with the freshly filtered array, double-firing earlier listeners. Snapshot with `[...this.listeners]` and document re-entrance.

### H9 — `checkTimeouts` invoked from every read (`getThread`, `listThreads`)
`consultation.ts:317-343, 346, 376`. Every `getThread` call runs the timeout SELECT+UPDATE. Under a request burst, multiple parallel callers each race to UPDATE the same timed-out threads and each fires `emitResolution("timeout")` for them. The SELECT-then-UPDATE between lines 320 and 336 is not transactional, so the same `timedOut` row id can be seen by N parallel requesters → N duplicate `timeout` resolutions and N duplicate MQTT/SSE fanouts. Wrap in `db.transaction` and let only one writer claim them (e.g., `RETURNING id` to scope downstream `emitResolution` to actually-flipped rows).

### H10 — `Aedes.createBroker()` not typed/awaited consistently
`mqtt-broker.ts:59`. `Aedes.createBroker()` is awaited correctly, but the surrounding `tcpServer.listen` Promise (80-87) attaches `once("error", reject)` then the persistent `on("error", ...)` later (88-90). If the bind succeeds but a later runtime error fires before the `once` handler is removed — race window line 84 `tcpServer.off("error", reject)` runs after `resolve()` — `reject` may still be on the emitter when an error fires synchronously inside the `listen` callback. Low-probability but real.

## Top-3 Priority Fixes

1. **Wrap multi-step state transitions in SQLite transactions.** `approveResolution`, `contestResolution`, `handleAgentDeparture`, `checkTimeouts`, and `announceWork` should each call `db.transaction(() => { ... })()`. Capture which rows actually flipped (use `changes` or `RETURNING`) and emit only for those — eliminates H1, H2, H9 duplicate emissions in one stroke.

2. **Fix MQTT bridge subscribe ordering + filter fan-out.** Move all `subscribe(...)` calls inside the `"connect"` handler (H3). In the `"message"` handler, parse `thread_id` from topic and route only to listeners that opted in (`registerListener(agentId, threadIds[])`); track per-listener subscriptions to avoid the unbounded broadcast (H5/H7).

3. **Plug `waitForMessage` timer + queue race.** Store the timer handle, `clearTimeout` on resolve, and re-check `listener.queue` immediately after assigning `waitResolve` inside the Promise executor. Also add `client.publish(..., { qos: 1 })` for `consultations/new` (H4) and use `retain: true` so late subscribers reconstruct thread state without depending on packet order.
