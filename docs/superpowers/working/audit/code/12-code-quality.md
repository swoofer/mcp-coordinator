# Code Quality Audit — server-setup, consultation, impact-scorer, quota

**Score: 6 / 10**

Solid intent, reasonable cohesion, but the registration layer has clearly outgrown its single-file home and a handful of repeated patterns are leaking complexity into the call sites. Domain modules (`consultation`, `impact-scorer`, `quota`) are healthier than the wiring layer.

---

## Smells found

### 1. `server-setup.ts` is a 526-line god file with 23 inline tool registrations
`server-setup.ts:105-524` — `createMcpServer` is one ~420-line function. Each `server.tool(...)` is essentially a controller; smashing them together prevents per-tool unit tests, makes the file hostile to diffs, and forces future changes through merge-conflict territory. Threshold breach: file >500 lines, function >50 lines (>400).

### 2. `announce_work` handler is ~95 lines of imperative orchestration
`server-setup.ts:160-263` — Nesting reaches 4 levels (try → if → for → if). Mixes plan quality, conflict detection, DB writes, impact scoring, auto-resolve logic, SSE emission, MQTT emission, and context gathering. This is a use-case, not a tool registration; it deserves an `AnnounceWorkUseCase` class with discrete steps.

### 3. Dynamic `import("./database.js")` repeated 7× across the codebase
`server-setup.ts:183, 195` and 5 more in `serve-http.ts`. Pattern `(await import("./database.js")).getDb()` is bizarre because `getDb` is already statically importable everywhere else (e.g. `consultation.ts:2`). It costs a microtask per call, defeats tree-shaking, and signals a copy-paste origin rather than a deliberate lazy-load. Replace with a top-of-file static import.

### 4. Magic numbers without named constants
- `consultation.ts:116` — `600` (timeout seconds)
- `consultation.ts:154` — `Math.ceil(params.content.length / 4)` (token approximation)
- `impact-scorer.ts:48` — `30 * 60 * 1000` is named, good — but `100`, `80`, `30` score thresholds (lines 76, 84, 92, 106, 119, 133) and the `90/30` category cutoffs (`impact-scorer.ts:154-156`, repeated `server-setup.ts:216`) are bare literals duplicated across files. Extract `IMPACT_SCORES = { SAME_FILE: 100, DEPENDENCY: 80, MODULE: 30 }` and `CATEGORY = { CONCERNED: 90, GRAY_ZONE: 30 }`.
- `server-setup.ts:154` — `idleAfterMinutes: 5`, `server-setup.ts:388` — `since_minutes || 30`, `server-setup.ts:404` — `within_minutes || 30`, `server-setup.ts:459` — `(timeout_seconds ?? 30) * 1000`, `server-setup.ts:501` — `(timeout_seconds || 15) * 1000`. Defaults scattered across handlers, none named.

### 5. Duplicated category-cutoff logic
`impact-scorer.ts:154-156` defines the 90/30 thresholds inside `categorize()`, then `server-setup.ts:216` re-derives the same buckets inline:
`category: s.score >= 90 ? "concerned" : s.score >= 30 ? "gray_zone" : "pass"`.
Single source of truth violated; a score-cutoff change requires editing two files.

### 6. Boolean parameter `online_only` and other booleans hint at split
`server-setup.ts:128-133` — `list_agents({ online_only })` branches on a flag — typical "two methods masquerading as one". Same shape: `assigned_to_me?: string` in `listThreads` (`consultation.ts:374`) silently flips the predicate.

### 7. Inconsistent naming — snake_case ↔ camelCase
The codebase translates between snake_case (wire format / DB) and camelCase (TS) ad-hoc. `server-setup.ts:62-68` constructs a snake_case payload by hand from a camelCase `info`; `consultation.ts:35` takes `approvedBy`/`approvedByName` then re-emits as `approved_by`. No central serializer — every call site re-maps fields and an added field will silently drop.

### 8. `getThread` calls `checkTimeouts()` on every read (hidden side effect)
`consultation.ts:346` — Read methods (`getThread`, `listThreads`) silently mutate state. `getThread` is called inside `emitResolution`, `proposeResolution`, `approveResolution`, `contestResolution`, `cancelThread`, `closeThread`, `handleAgentDeparture`, `postResolutionMessage`, `allRespondentsApproved`. Each call re-runs the timeout sweep. It's both a perf paper-cut and a correctness landmine (recursive emission risk).

### 9. Long parameter lists / object-destructure handlers
`server-setup.ts:170` — `announce_work` callback destructures 9 parameters; `consultation.announceWork` (line 64) takes a 9-field params object. Beyond ~5 fields, intent is opaque at call sites.

### 10. Dead `as any` cast hiding a typing gap
`server-setup.ts:230` — `sseEmitter.emit("impact_scored" as any, …)` with a synthetic `category: "plan_quality"` that doesn't exist in the impact_scored event union. Either add the variant to the event type or move plan-quality to its own event name.

---

## Top 3 highest-leverage cleanups

1. **Split `server-setup.ts` into `tools/<domain>.ts` modules** (registry, consultation, files, deps, status, mqtt, coord). Each module exports a `register(server, services)` function. Drops the file to ~50 lines and unblocks per-tool tests. Fixes smells #1, #2, #9.
2. **Extract `AnnounceWorkUseCase` from the inline `announce_work` handler** — pure class taking `services` deps, returns `{ thread, conflicts, context, impact, events: [...] }`. Handler becomes a thin adapter that emits events. Kills the 95-line nested block and makes auto-resolve logic testable. Fixes #2, #5.
3. **Centralize impact-score constants and the snake_case event serializer** — one `impact-constants.ts` for thresholds, one `events/serialize.ts` that turns `QuotaInfo`/`ResolutionEvent`/`ImpactScore` into wire DTOs. Removes duplicated literals (#4, #5) and stops the camel↔snake drift (#7). Add a static `import { getDb } from "./database.js"` while you're in there to kill the seven dynamic imports (#3).

---

DONE — `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\12-code-quality.md`
