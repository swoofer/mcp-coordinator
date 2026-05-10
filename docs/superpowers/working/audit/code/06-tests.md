# Test Quality Audit — 216 Tests / 18 Files

**Score: 6.5 / 10**

Stronger than typical Node projects: real SQLite (not mocked), bug-hunting style ("BUG:" tests pre-document known defects), good consultation/conflict coverage. Weakened by: zero coverage of the network/transport layer (~1727 LOC untested), heavy timing-dependent tests, single-process serialization (`fileParallelism: false`) hiding concurrency bugs.

## Coverage map

| File | Tests | Notes |
|---|---|---|
| consultation | 54 | Best coverage; bug tests included |
| quota | 24 | Only file using mocks/fake timers properly |
| auth | 23 | Real timing waits — flaky risk |
| impact-scorer | 19 | Layer 0/1/2 ladder well exercised |
| agent-activity | 16 | TDD-grade |
| integration | 15 | Real cross-module flows, valuable |
| conflict-detector | 11 | OK |
| plan-quality, file-tracker, sse-emitter, dependency-map, introspection, agent-registry, logger, context-provider, cli-config, database, db-adapter | 4–8 | Thin |

## Untested source files (critical gap)

- `src/serve-http.ts` — **820 LOC, zero tests**. The HTTP/MCP entry point. Auth-route routing, request body parsing, SSE streaming, /api/reset are completely uncovered. The auth.test.ts:208-221 "BUG" test even encodes a known query-string bypass that lives in this untested file.
- `src/mqtt-broker.ts` — 119 LOC embedded broker, no test.
- `src/mqtt-bridge.ts` — 230 LOC, no test. Connection retry, queue draining, agent listener lifecycle untested.
- `src/server-setup.ts` — 526 LOC wiring, only indirectly touched via logger.test.ts:39.
- `src/quota/credential-reader.ts` — Keychain reader untested (skipped because it shells out to `security`).

## Test quality issues (file:line)

1. **db-adapter.test.ts:7-22** — Single test that just constructs a literal object and checks `typeof` on its functions. Pure trivial assertion (`expect(adapter).toBeDefined()`). This is a tautology, not a test.
2. **auth.test.ts:43, 186** — Real `setTimeout(1100)` and `setTimeout(1500)` for token expiry. Flaky on slow CI; quota.test.ts proves `vi.useFakeTimers` works in this codebase. ~2.6 s of wasted wall-clock per run.
3. **logger.test.ts:19-23** — `expect(logger).toBeDefined()` then checks `level === "info"`. The "child loggers" test (line 30) only verifies that calling `.child()` returns something defined. No assertion that the child actually emits a `component` field.
4. **vitest.config.ts:6** — `fileParallelism: false` serializes the entire suite. Required because every test file shares hard-coded `data-test-*` directories at the project root and `getDb()` is module-level singleton state. This means concurrent-write race conditions in production code are **structurally undetectable** by the test suite.
5. **integration.test.ts:399-450** — Two "BUG" tests run the `/api/reset` SQL inline in the test rather than calling the actual endpoint. They prove the SQL list works, not that serve-http.ts uses the same SQL list. If serve-http.ts diverges, tests still pass.
6. **agent-registry.test.ts:60** — `expect(after).toBeDefined()` after `heartbeat()` — never compares to the prior `last_seen_at` value, so a no-op `heartbeat` would pass.
7. **introspection.test.ts** — Only 6 tests for a security-adjacent module. No test for: re-responding to a closed introspection, response after thread resolves, ID collision, or SQL-injection-style agent_id.
8. **No concurrency tests anywhere except quota.test.ts:222-239** (single-flight). No test for: two agents announcing identical work simultaneously, two introspections responding concurrently, file_activity races.

## Top 3 highest-value tests to add

1. **HTTP route integration suite for `serve-http.ts`** — spin up real server on ephemeral port, exercise `/api/register`, `/api/announce_work`, `/api/reset`, `/api/auth/refresh`, SSE `/events` stream. Would have caught the reset bugs (integration.test.ts:399), the query-string admin bypass (auth.test.ts:208), and validates the actual route table — not a mock of it.
2. **Concurrent consultation race test** — two agents call `announceWork` on the same `target_files` within 1 ms, plus two `approveResolution` calls. Requires removing `fileParallelism: false` for one suite or using `Promise.all` over real handlers. Would cover the gap between consultation.test.ts:811 (cross-round approval bug) and reality.
3. **MQTT bridge round-trip test** — start embedded broker (mqtt-broker.ts), connect bridge, publish a message, assert agent listener receives it; then disconnect agent, assert `onOfflineHandler` fires within retry window. The 230 LOC of mqtt-bridge.ts plus 119 LOC of mqtt-broker.ts have **zero** automated coverage — entire transport layer is verified only by manual dashboard testing.

**Path:** `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\06-tests.md`
