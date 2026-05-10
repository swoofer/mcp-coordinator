# TypeScript Type-Safety Audit — mcp-coordinator

**Score: 6 / 10**

TS 5.7 with `strict: true`. Solid baseline, but the boundary between SQLite/HTTP/MQTT and the typed domain leaks heavily through `as` casts and `JSON.parse` returning `any`. Zod is used only for MCP tool inputs, not for any other untrusted boundary.

## tsconfig posture (`tsconfig.json:1-15`)
- `strict: true` enables `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, etc.
- Missing: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`. With these off, `payload.exp`, `parts[3]`, `respondents[0]`, all silently look defined.
- `declaration: true` + `exports["./types"]` correctly publishes `dist/src/types.d.ts` (`package.json:33-37`).

## Findings

1. **Unsound `EventType` cast bypasses the discriminated union**
   `src/serve-http.ts:202`, `src/serve-http.ts:434`, `src/server-setup.ts:230` — `sseEmitter.emit("impact_scored" as any, ...)` and `emit("run_config" as any, ...)`. `"run_config"` is not a member of `EventType` (`src/types.ts:91-107`); the cast hides a genuine bug — the dashboard subscribers will never receive it under the typed surface.

2. **All SQLite reads are blind `as Foo` casts**
   `src/agent-registry.ts:21,26,31`; `src/consultation.ts:178,349,401,426,441,453,460`; `src/dependency-map.ts:7-9,40-42`; `src/sse-emitter.ts:32`; `src/file-tracker.ts:22`; `src/introspection.ts:49,56,63`. None validate column shape; a schema migration that drops/renames a field compiles cleanly and crashes at first read. Even `lastInsertRowid as number` (`src/sse-emitter.ts:17`) is unsafe — better-sqlite3 returns `number | bigint`.

3. **HTTP request bodies cast straight to typed shapes**
   `src/serve-http.ts:88,102,108,120,128,137,146,224,251,433,459` — `body as { agent_id: string; ... }` on every endpoint. There is no runtime validation despite `zod` already being a dependency. A POST with missing/wrong-typed `target_files` becomes a runtime crash inside `JSON.stringify(undefined)` or worse, a silently corrupted DB row.

4. **`JSON.parse` returns `any`, then assigned to typed locals**
   `src/consultation.ts:87,292,483`; `src/dependency-map.ts:14-16,46-48`; `src/conflict-detector.ts:32-33`; `src/impact-scorer.ts:40,70-71`; `src/server-setup.ts:241,413,441`; `src/serve-http.ts:199,215,339,408,467,476`. `const respondents: string[] = JSON.parse(...)` is a lie — TS trusts the annotation but the runtime value is whatever happens to be in the column. Compare with `src/quota/quota.ts:106-148` which validates field-by-field — that is the right pattern, applied nowhere else.

5. **JWT claim coerced via cast**
   `src/serve-http.ts:533` and `:548` — `(payload.exp as number) * 1000`. `payload.exp` is `unknown`; if the upstream lib ever omits it, you get `NaN * 1000 = NaN` and an `Invalid Date`. `decodeJwtPayload` (`src/serve-http.ts:72-78`) is also a hand-rolled JSON parse with no integrity check (comment says "we just minted it"), but the type system can't enforce that invariant.

6. **`DatabaseAdapter` cast hides a structural-typing escape**
   `src/database.ts:146,157` — `return raw as DatabaseAdapter`. The two adapters (better-sqlite3, bun:sqlite) are imported via `require()` with no type info; the cast claims compliance the compiler never checked. `Statement.get(): unknown` and `all(): unknown[]` (`src/db-adapter.ts:7-9`) push the unsafety up to every call site (see finding #2).

7. **Header / URL-segment unchecked cast**
   `src/serve-http.ts:611` — `parseInt(req.headers["last-event-id"] as string || "0", 10)` casts a `string | string[] | undefined` to `string`. With `noUncheckedIndexedAccess` off, `parts[3]` in `src/mqtt-bridge.ts:53` is also typed as `string` but is really `string | undefined`.

8. **Discriminated union under-used**
   `EventType` (`src/types.ts:91-107`) is a string union, but `CoordinatorEvent.payload` is `string` (`:113`), so payload shape is divorced from type tag. A real discriminated union (`{ type: "agent_online", payload: { agent_id: string } } | ...`) would let `sseEmitter.emit` reject the `"run_config" as any` bug at compile time.

## Three hardening steps
1. **Define a single `RowSchemas` zod module and replace every `db.prepare(...).all() as Foo[]` with `Foo.parse(...)`.** Co-locate schemas with their `interface`. Removes findings 2, 4, 6 in one pass.
2. **Validate every HTTP endpoint with zod.** Build per-route `z.object(...)` schemas and a `validate(body, schema)` helper that returns 400 with a useful error. Removes findings 3, 5, 7.
3. **Tighten `tsconfig.json`** with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and convert `CoordinatorEvent` to a discriminated union so `EventType` and `payload` are linked. Then delete the three `"... as any"` casts; the compiler will surface the missing `run_config` event type.
