# Backend Engineer Audit — mcp-coordinator Protocol Design

**Score: 6/10** — Pragmatic for the stated scale (2-3 sessions), but not what the README claims it is. The protocol works for the happy path; nontrivial concurrency, failure, and consistency holes show up the moment you push past hobby use.

---

## Concrete Weaknesses

### 1. Race in `announce_work` — TOCTOU between scoring and INSERT
`Consultation.announceWork` reads online agents and computes respondents, then INSERTs the thread. There is no transaction wrapping the scoring + write. Two agents calling `announce_work` for the same files within the same millisecond will each see a clean board (Layer 0a iterates `listThreads({ status: "open" })` *before* their own row exists) and both INSERT a thread with score 0 and `auto_resolve=true`. README claims "atomically claims a task (work-stealing)" but `claim` isn't even visible in `consultation.ts` — there is no `UPDATE ... WHERE claimed_by IS NULL` guard shown. Whoever asks the question first wins by accident, not by design.

### 2. SQLite + WAL is fine for 5 agents, fatal at 50
`database.ts:143-145` sets `journal_mode = WAL`, `busy_timeout = 5000`. Single-writer serialization means any sustained `announce_work` storm queues writes behind the 5 s timeout, then throws `SQLITE_BUSY`. Combined with `getThread()` calling `checkTimeouts()` (consultation.ts:346) on every read — every read triggers a write attempt. README claims "team setup" with shared coordinators on LAN; the sizing math doesn't survive 10 agents on heartbeat + announce + poll.

### 3. Impact-scoring algorithm is brittle
- Layer 3 (line 127-131) module overlap uses `am.startsWith(tm + "/")`. `src/api` matches `src/api-gateway`? — fixed at the SQL filter (line 393) but **not** in the scorer itself. Inconsistent.
- `target_files` comparison is raw string equality (line 74). `./src/foo.ts`, `src/foo.ts`, `src\foo.ts` are three different files. No path normalization.
- Layer 0 windowing (`30 * 60 * 1000`) is hardcoded; SQLite-UTC parsing band-aid (line 53-56) reveals an earlier bug — the timestamp normalization is one stray timezone away from regressing again.
- Score is `max()`, never additive. Two simultaneous strong signals = same score as one.
- The 60 s file-tracker window (line 103, 117) is silent: a developer who walks away for 90 s, returns, and announces will never see the conflict.

### 4. Coordinator-crash mid-consultation = corrupted state
No journaling beyond SQLite, no event sourcing. If the coordinator dies between `proposeResolution` (sets status='resolving') and the SSE/MQTT publish (`mqtt-bridge`), agents subscribed to `coordinator/consultations/{id}/status` never see the event; on reconnect they'll poll, see status='resolving', and have no idea who proposed what. There's no replay, no last-event-id on MQTT (QoS not specified anywhere — Aedes default is QoS 0, fire-and-forget). A reboot = lost messages.

### 5. `checkTimeouts` is a polling side-effect inside a getter
`getThread()` and `listThreads()` each call `checkTimeouts()` (consultation.ts:346, 376). This means: (a) timeouts only fire when *someone reads* — a thread can sit timed-out for hours if nobody polls; (b) every read takes a write lock; (c) the dashboard, every agent, and every poll race to be the one that emits the `timeout` resolution. The `emitResolution` callback fires `timedOut.length` times, but two readers entering this code in parallel will both pass the WHERE clause once before the UPDATE commits — duplicate `coordinator/consultations/{id}/status` events.

### 6. 26 MCP tools is bloat masquerading as granularity
`get_thread` + `get_thread_updates` + `list_threads` + `coordinator_status` + `wait_for_message` + `get_queued_messages` overlap heavily. README itself admits Claude has to "poll periodically" — that's the symptom of a bad surface area, not a feature. Three orthogonal verbs (`announce`, `respond`, `subscribe`) covering ten sub-resources would beat 26 flat endpoints. The tool count balloons LLM context and increases the chance the agent picks the wrong tool.

### 7. MQTT push + MCP pull is the worst of both
README §"Push vs polling" admits Claude Code doesn't subscribe to MQTT and falls back to polling. So you pay the operational cost of an embedded broker (Aedes, port 1883, WS bridge, Bun Duplex hack at mqtt-broker.ts:13-33) for a population of clients that don't use it. Only essaim consumes it. For everyone else MQTT is dead weight.

---

## Three Better Alternatives

1. **Server-Sent Events end-to-end + idempotent REST.** SSE already works in MCP transports, ships with reconnect+last-event-id semantics, requires zero broker, and the dashboard already uses it (`/api/events`). Drop MQTT entirely until a real subscriber appears.

2. **Postgres + LISTEN/NOTIFY** (or NATS JetStream for the broker fans). Real concurrency, real transactions wrapping `score → INSERT thread → notify`, durable subjects, replay on reconnect. Removes the SQLite ceiling and gives you the work-stealing primitive (`SELECT ... FOR UPDATE SKIP LOCKED`) the README already pretends to have.

3. **Optimistic concurrency on threads via versioned compare-and-swap.** Single column `version INTEGER`, every state mutation `UPDATE ... SET version=version+1 WHERE id=? AND version=?`. Removes the read-then-write race in `approveResolution`, `claim`, `proposeResolution`. Pairs with a single `events` append-only log replacing the side-effect-in-getter pattern of `checkTimeouts`.

---

DONE — written to `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\02-backend-engineer.md`
