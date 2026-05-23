# MQTT Event Catalog for Channels Integration (Phase 1)

**Date:** 2026-05-23
**Scope:** Audit of every MQTT topic the coordinator publishes (and subscribes
to) from `src/mqtt-bridge.ts`, with concrete payload shapes and a Phase 1
priority recommendation for the Channels CLI integration.
**Related issue:** [#130 — Channels integration spike](https://github.com/swoofer/mcp-coordinator/issues/130)
**Audited file:** `src/mqtt-bridge.ts` (297 lines, single source of every
production publish call)

---

## 1. Purpose

The Channels CLI integration aims to translate selected MQTT coordination
events into `notifications/claude/channel` messages that Claude can react to
in-band. This document is the input artifact for that decision: it enumerates
**every** topic published by `MqttBridge`, the payload shape, the trigger
site, and a Phase 1 recommendation (High / Medium / Low / Skip) with a
suggested `<channel>` tag attribute set for each.

The catalog is read-only — no source files were modified. The goal is to
give the Channels spike a single document to scope from.

---

## 2. Methodology

- Read `src/mqtt-bridge.ts` end-to-end (the only file containing
  `client.publish` calls — confirmed via repo-wide grep, results scoped to
  `src/`).
- Traced each `publish*` method to its call sites using the
  `publishConsultation|publishMessage|publishResolution|publishBroadcast|publishAgentOffline|publishTaskClaimed|publishTaskCompleted|publishQuotaUpdate|registerAgent|clearRetainedConsultation|mqttPublish`
  search across `src/**/*.ts`.
- Cross-referenced expected wire output with `examples/python-mqtt/README.md`
  to validate topic strings and payload examples.
- All topics are org-scoped under `coordinator/<orgId>/...` (see
  `mqttPublish` at `src/mqtt-bridge.ts:278-287` which enforces the prefix
  for any caller-supplied topic).

Citations use `file:line` for every claim.

---

## 3. Topic Family: `consultations/*`

The highest-signal events for Claude. This is the core coordination layer —
every cross-agent decision point flows through here.

### 3.1 `coordinator/<orgId>/consultations/new`

| Field | Value |
|---|---|
| **Publisher** | `publishConsultation` — `src/mqtt-bridge.ts:132-143` |
| **Trigger** | `announce_work` MCP tool — `src/tools/consultation-tools.ts:72` |
| **QoS / retain** | QoS 1, **retain: true** (only the most recent consultation is retained; cleared on resolve via `clearRetainedConsultation`) |
| **Payload type** | `{ thread_id: string; agent_id: string; subject: string; target_modules: string[] }` |
| **Sample** | `{"thread_id":"thread-7f3a","agent_id":"agent-alpha","subject":"Refactor token cache","target_modules":["src/quota","src/auth"]}` |
| **Phase 1 priority** | **High** — this is the canonical "another agent wants to coordinate with you" signal. Must surface to Claude. |
| **Suggested `<channel>` attributes** | `kind="consultation"` `event="new"` `thread-id="thread-7f3a"` `initiator="agent-alpha"` `subject="…"` `modules="src/quota,src/auth"` |

A retained empty payload (zero-length buffer) is published by
`clearRetainedConsultation` at `src/mqtt-bridge.ts:154-163` when a
consultation resolves and the retained slot still references that thread.
Channels subscribers should ignore zero-length payloads on this topic
(MQTT semantics: this is a retain-clear, not a real event).

---

### 3.2 `coordinator/<orgId>/consultations/<threadId>/messages`

| Field | Value |
|---|---|
| **Publisher** | `publishMessage` — `src/mqtt-bridge.ts:165-172` |
| **Trigger** | `post_to_thread` MCP tool — `src/tools/consultation-tools.ts:107` |
| **QoS / retain** | QoS 0, retain: false (high-frequency chat, lossy-OK — see comment at `src/mqtt-bridge.ts:167`) |
| **Payload type** | `{ agent_id: string; type: MessageType; content: string }` where `MessageType = "context" \| "suggestion" \| "warning" \| "resolution" \| "approve" \| "contest"` (`src/types.ts:60-66`) |
| **Sample** | `{"agent_id":"agent-beta","type":"warning","content":"I'm editing src/quota/quota.ts in branch foo — please coordinate."}` |
| **Phase 1 priority** | **High** for `type ∈ {warning, contest}`, **Medium** for `{suggestion, resolution, approve}`, **Low** for `{context}`. The CLI filter should split by `type` rather than subscribing to all messages indiscriminately. |
| **Suggested `<channel>` attributes** | `kind="consultation"` `event="message"` `thread-id="thread-7f3a"` `from="agent-beta"` `message-type="warning"` |

---

### 3.3 `coordinator/<orgId>/consultations/<threadId>/status`

| Field | Value |
|---|---|
| **Publisher** | `publishResolution` — `src/mqtt-bridge.ts:174-182` |
| **Trigger sites** | (a) `propose_resolution` MCP tool — `src/tools/consultation-tools.ts:122` publishes with `status: "resolving"`. (b) `Consultation.onResolve` centralized hook — `src/server-setup.ts:137` publishes with `status: "resolved"` (skipped when `resolution_type === "auto_resolved"`). |
| **QoS / retain** | QoS 1, **retain: true** |
| **Payload type** | `{ status: "resolving" \| "resolved"; summary: string }` |
| **Sample (resolving)** | `{"status":"resolving","summary":"Switch to PBKDF2 with 600k iters; both branches OK with this."}` |
| **Sample (resolved)** | `{"status":"resolved","summary":"Approved by agent-alpha."}` |
| **Phase 1 priority** | **High** — terminal state changes on threads Claude is participating in. |
| **Suggested `<channel>` attributes** | `kind="consultation"` `event="status"` `thread-id="thread-7f3a"` `status="resolved"` `summary="…"` |

---

### 3.4 `coordinator/<orgId>/consultations/<threadId>/claimed`

| Field | Value |
|---|---|
| **Publisher** | `publishTaskClaimed` — `src/mqtt-bridge.ts:201-210` |
| **Trigger** | `POST /api/claim-task` (HTTP, not MCP) — `src/http/handle-rest.ts:207` |
| **QoS / retain** | QoS 1, retain: false |
| **Payload type** | `{ agent_id: string; claimed_by: string; claimed_at: string /* ISO 8601 */ }` (`agent_id` and `claimed_by` always equal — kept for backward compat per `src/mqtt-bridge.ts:207`) |
| **Sample** | `{"agent_id":"agent-gamma","claimed_by":"agent-gamma","claimed_at":"2026-05-23T14:22:01.123Z"}` |
| **Phase 1 priority** | **High** when the local agent's directed-dispatch task is claimed (race detection) or when a peer claims something the local agent was about to claim. **Medium** otherwise. Filtering by `thread_id` membership belongs to the channel CLI, not the broker. |
| **Suggested `<channel>` attributes** | `kind="task"` `event="claimed"` `thread-id="thread-7f3a"` `claimed-by="agent-gamma"` `claimed-at="2026-05-23T14:22:01.123Z"` |

---

### 3.5 `coordinator/<orgId>/consultations/<threadId>/completed`

| Field | Value |
|---|---|
| **Publisher** | `publishTaskCompleted` — `src/mqtt-bridge.ts:212-220` |
| **Trigger** | `POST /api/propose-resolution` (HTTP, not MCP) — `src/http/handle-rest.ts:230`. **Note:** the method is named "completed" but is wired to the *propose-resolution* REST endpoint, not a separate "complete" action. The MCP `propose_resolution` tool publishes `/status` (3.3) instead. |
| **QoS / retain** | QoS 1, retain: false |
| **Payload type** | `{ agent_id: string; completed_by: string; summary: string }` |
| **Sample** | `{"agent_id":"agent-gamma","completed_by":"agent-gamma","summary":"Implemented PBKDF2 migration, all tests green."}` |
| **Phase 1 priority** | **High** — coordination terminal event on the HTTP path. |
| **Suggested `<channel>` attributes** | `kind="task"` `event="completed"` `thread-id="thread-7f3a"` `completed-by="agent-gamma"` `summary="…"` |

**Caveat for spike scoping:** The naming overlap between `publishResolution`
(MCP path, `/status`) and `publishTaskCompleted` (HTTP path, `/completed`)
means subscribers must listen to **both** subtrees to reliably observe
"thread done." Channel CLI should normalize them to a single
`event="resolved"` or `event="completed"` notification.

---

## 4. Topic Family: `agents/*`

### 4.1 `coordinator/<orgId>/agents/<agentId>/status`

| Field | Value |
|---|---|
| **Publishers** | (a) `registerAgent` — `src/mqtt-bridge.ts:123-130`. (b) `publishAgentOffline` — `src/mqtt-bridge.ts:192-199` **(dead code — see §7)**. (c) LWT (Last Will & Testament) registered at `src/mqtt-bridge.ts:55-60`. |
| **Triggers** | (a) `register_agent` MCP tool — `src/tools/agents-tools.ts:29`. (b) None in production. (c) Auto-published by broker when the bridge socket drops unexpectedly. |
| **QoS / retain** | `registerAgent`: retain: true, default QoS 0. `publishAgentOffline`: retain: true, QoS 0. LWT: QoS 1, retain: false. |
| **Payload type — online** | `{ status: "online"; name: string }` |
| **Payload type — offline (regular)** | `{ status: "offline" }` *(dead path)* |
| **Payload type — offline (LWT)** | `{ status: "offline"; reason: "lwt_unexpected" }` |
| **Sample** | `{"status":"online","name":"Agent Alpha"}` |
| **Phase 1 priority** | **Medium** — useful background context ("teammate just came online; teammate just crashed") but rarely actionable for Claude during a task. |
| **Suggested `<channel>` attributes** | `kind="agent"` `event="status"` `agent-id="agent-alpha"` `status="online"` `reason="lwt_unexpected"?` |

---

## 5. Topic Family: `broadcast`

### 5.1 `coordinator/<orgId>/broadcast`

| Field | Value |
|---|---|
| **Publisher** | `publishBroadcast` — `src/mqtt-bridge.ts:184-190` |
| **Trigger** | **None in production code.** See §7 — dead code. The bridge subscribes to this topic (`src/mqtt-bridge.ts:73`) for inbound, but no internal caller publishes here. External clients calling the `mqtt_publish` MCP tool with topic `broadcast` would route here. |
| **QoS / retain** | QoS 0, retain: false |
| **Payload type** | `{ agent_id: string; message: string }` |
| **Sample** | `{"agent_id":"agent-alpha","message":"Broker maintenance in 5 min."}` |
| **Phase 1 priority** | **Skip** — no production publisher; if/when re-enabled, reclassify as Medium. |
| **Suggested `<channel>` attributes** | `kind="broadcast"` `from="agent-alpha"` (deferred) |

---

## 6. Topic Family: `quota/*`

### 6.1 `coordinator/<orgId>/quota/update`

| Field | Value |
|---|---|
| **Publisher** | `publishQuotaUpdate` — `src/mqtt-bridge.ts:227-231` |
| **Trigger** | `QuotaCache.onRefresh` callback — `src/server-setup.ts:107`. Fires every time the macOS quota poller produces a fresh `QuotaInfo`. |
| **QoS / retain** | QoS 0, retain: false (next refresh overwrites — `src/mqtt-bridge.ts:229`) |
| **Payload type** | `QuotaInfo` (`src/quota/quota.ts:20-27`): `{ fiveHour: QuotaBucket; sevenDay: QuotaBucket; sevenDaySonnet: QuotaBucket \| null; fetchedAt: number }` where `QuotaBucket = { utilization: number /* 0–100 */; resetsAt: string /* ISO 8601 */; minutesUntilReset: number }` (`src/quota/quota.ts:11-18`) |
| **Sample** | `{"fiveHour":{"utilization":42.7,"resetsAt":"2026-05-23T19:00:00Z","minutesUntilReset":97},"sevenDay":{"utilization":18.2,"resetsAt":"2026-05-30T00:00:00Z","minutesUntilReset":9817},"sevenDaySonnet":null,"fetchedAt":1716475321000}` |
| **Phase 1 priority** | **Low** — useful telemetry but typically noise during normal sessions. Surface only when `utilization > 80` or `minutesUntilReset < 30`. |
| **Suggested `<channel>` attributes** | `kind="quota"` `event="update"` `bucket="five-hour"` `utilization="42.7"` `resets-at="2026-05-23T19:00:00Z"` (one notification per bucket, gated by threshold) |

---

## 7. Dead Code (Defined but Never Called in Production)

Two `publish*` methods are defined on `MqttBridge` but have **no production
caller** — confirmed via grep across `src/**/*.ts`:

1. **`publishAgentOffline`** (`src/mqtt-bridge.ts:192-199`) — references
   appear only in (a) its own definition, (b) test file
   `tests/unit/p1-mqtt-correctness.test.ts` (none invoke it), and (c)
   historical commentary in `docs/superpowers/working/audit/code/05-mqtt.md`.
   Crash detection is now handled exclusively by the LWT mechanism
   (`src/mqtt-bridge.ts:55-60`), making this method redundant. Recommend
   either wiring it to the agent-departure path or deleting it in a future
   cleanup PR.

2. **`publishBroadcast`** (`src/mqtt-bridge.ts:184-190`) — no caller. The
   bridge *subscribes* to `coordinator/<orgId>/broadcast` at line 73 but
   nothing internal publishes to it. External callers could still hit it via
   the `mqtt_publish` MCP tool (`src/tools/mqtt-tools.ts:48-56`).

These do **not** need to be in the Phase 1 channel filter list.

---

## 8. Pass-Through: `mqttPublish` (User-Supplied Topic)

`mqttPublish(topic, payload)` (`src/mqtt-bridge.ts:278-287`) lets the
`mqtt_publish` MCP tool (`src/tools/mqtt-tools.ts:48-56`) publish to an
arbitrary topic, scoped to `coordinator/<orgId>/...`. Payload is an opaque
string — the bridge does not parse it.

**Phase 1 priority:** **Skip** as a *publisher* signal (it's a generic
escape hatch). However, the Channels subscriber should still receive any
events agents push through this channel — the topic filter
`coordinator/<orgId>/#` already covers it.

---

## 9. Broker Subscriptions (Not Publishes — For Context Only)

These are topics the bridge **subscribes to** in `src/mqtt-bridge.ts:71-73`.
They are listed here so the spike has full directional context, but they are
**inputs to the bridge**, not outputs:

| Topic | Purpose | Notes |
|---|---|---|
| `coordinator/<orgId>/agents/+/status` | Detect peer offline events from other bridges/LWTs and trigger `onOfflineHandler`. | See message handler at `src/mqtt-bridge.ts:80-86`. |
| `coordinator/<orgId>/consultations/#` | Fan into per-agent listener queues for the `wait_for_message` / `get_queued_messages` MCP tools. | See `src/mqtt-bridge.ts:90-104`. |
| `coordinator/<orgId>/broadcast` | Same fanout as above (broadcasts routed to all listeners). | Same handler. |

**These are not channel candidates** — they are the bridge's own input
plumbing.

---

## 10. Recommended Phase 1 Event Filter List

The Channels CLI subscriber should bind to the following topic filters, in
this priority order. Lower-priority filters should be guarded by client-side
thresholds (annotated below).

### Priority 1 — High (always surface)

```
coordinator/<orgId>/consultations/new
coordinator/<orgId>/consultations/+/status
coordinator/<orgId>/consultations/+/completed
coordinator/<orgId>/consultations/+/messages  # client filter: type ∈ {warning, contest}
```

These are the four event classes that represent direct, actionable
coordination signals. Every one carries a `thread_id` (either in the topic
or the payload) so Claude can resolve them against its own active threads.

### Priority 2 — Medium (surface with light filtering)

```
coordinator/<orgId>/consultations/+/claimed       # surface when the claimed thread is one Claude announced or is watching
coordinator/<orgId>/consultations/+/messages      # client filter: type ∈ {suggestion, resolution, approve}
coordinator/<orgId>/agents/+/status               # surface online/offline transitions; suppress retained-state replay on connect
```

### Priority 3 — Low (telemetry, threshold-gated)

```
coordinator/<orgId>/quota/update   # surface only when utilization > 80 or minutes_until_reset < 30
```

### Skip in Phase 1

- `coordinator/<orgId>/broadcast` — no production publisher (§7).
- `coordinator/<orgId>/consultations/+/messages` with `type=context` — informational only, would drown Claude.
- Retained empty-payload publishes on `consultations/new` — these are MQTT retain-clear sentinels (§3.1), not real events.

### Single subscription option

If the spike prefers one wildcard subscription with client-side routing
instead of N specific binds, use:

```
coordinator/<orgId>/#
```

…and apply the priority/filter rules from above in the CLI. This is what
`examples/python-mqtt/subscribe.py` does today and matches the broker's
expected access pattern.

---

## 11. Open Questions / Spike Inputs

1. **Org scoping in multi-tenant Phase 5.** Today every catalog entry hardcodes
   `coordinator/<orgId>/...` and the quota callback even uses the literal
   `"default"` org (`src/server-setup.ts:101-106`). The Channels CLI will need
   to know which `orgId` to bind to — likely from the same auth claims the
   MCP session uses.
2. **`/status` vs `/completed` naming overlap (§3.5).** Spike should decide
   whether the channel notification normalizes both into a single
   `event="resolved"` or keeps them distinct.
3. **Retain-clear sentinel handling (§3.1).** Channels CLI must drop
   zero-length payloads on `consultations/new`; otherwise users will see a
   ghost "consultation cancelled" notification on every resolve.
4. **Dead-code cleanup.** Decide whether to wire `publishAgentOffline` and
   `publishBroadcast` or delete them in the same PR window as the channels
   work, to keep the public MQTT contract honest.
