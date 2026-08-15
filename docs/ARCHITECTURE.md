# Architecture

A map of the codebase for contributors: what lives where, the two
"generations" of the code (Phase 1 vs Phase 2) and their respective
conventions, the house lints that are enforced beyond `tsc`, and the
patterns to follow when adding a new REST endpoint or MCP tool.

This document describes what the code actually does today. Where a
convention is enforced by an automated lint, this doc cites the script
that enforces it — if a rule isn't backed by a script or a test, treat it
as a convention, not a guarantee.

## Directory map

| Path | What it is |
|---|---|
| `src/` | The server: MCP + REST + SSE transport, coordination core (registry, consultation, dependency map), embedded MQTT broker/bridge, Phase 2 auth/admin/security/observability subtrees. |
| `src/tools/*.ts` | MCP tool registrations, one file per domain (agents, consultation, mqtt, status, files, dependencies). |
| `src/http/*.ts` | REST router (`handle-rest.ts`), request/response helpers, zod body schemas (`rest-schemas.ts`), health/metrics HTTP handlers. |
| `src/auth/`, `src/admin/`, `src/security/`, `src/observability/`, `src/quota/`, `src/sweeper/` | Phase 2 subsystems (see below). |
| `cli/` | The `mcp-coordinator` CLI: `server`, `init`, `doctor`, `channel`, `config`, `dashboard`, encryption subcommands (`cli/encryption/`), server-lifecycle helpers (`cli/server/`, `cli/lib/`). |
| `dashboard/public/` | Static dashboard assets (HTML/CSS/vanilla JS), served directly — no bundler. Some modules (`admin-common.js`, `admin-strings.js`) are covered by the Vitest v8 coverage run (see `vitest.config.ts`'s `coverage.include`). |
| `sdk/` | Standalone TypeScript client package (own `package.json`/`tsconfig.json`/tests) for talking to a Phase 2 (OAuth-enabled) coordinator from other tools. Published/versioned independently of the main package. |
| `tests/` | Vitest suite (`tests/unit/*.test.ts`, `*-self-test.ts`), performance/chaos scripts (`tests/perf/`, `tests/perf/chaos/`, run manually — see `docs/maintainer-notes.md`), Playwright e2e (`tests/e2e/`, driven by `playwright.config.ts`), shared fixtures (`tests/helpers/`). |
| `docs/` | This file, `operating-modes.md`, `maintainer-notes.md`, `dependency-notes.md`, plus `docs/superpowers/specs/` (internal design docs — see the glossary below) and `docs/superpowers/working/` (working notes). |
| `scripts/` | House lint scripts (`lint-*.sh`) plus their orchestrator (`lint-run-all.sh`) — see below. |

## The two generations: Phase 1 vs Phase 2

The codebase grew in two identifiable eras with different conventions.
Comments in the source often tag which era a piece of code belongs to
(`T29`, `V3 §4`, `S1`/`S2`, etc. — see the glossary below).

**Phase 1 — coordination core.** Agent registry, consultation/thread
lifecycle, dependency map, MQTT broker/bridge, SSE emitter, the original
REST/MCP surface. Single-tenant by construction: no `org_id` scoping was
designed in from the start (some of it was retrofitted — see
"Multi-org: experimental status" in `docs/operating-modes.md`). Logging
goes through `src/logger.ts` (a hand-rolled `Logger` interface backed by
either `pino` or a plain console fallback — see "Logger/metrics" below).
Metrics go through `src/metrics.ts` (a `CoordinatorServices`-scoped
`prom-client` `Registry` instance, served at `/metrics`).

**Phase 2 — auth/OAuth/multi-org/admin.** `src/auth/`, `src/admin/`,
`src/security/`, `src/observability/`, `src/sweeper/`, plus the legacy
`src/auth.ts` shim (kept for the cookie-auth code path documented in
`src/boot.ts`). Introduces org-scoped rows (`orgs`, `users.primary_org_id`),
JWT sessions, OAuth/OIDC/device-flow providers, envelope encryption at
rest, and an admin UI. Per `CONTRIBUTING.md`, files under `src/auth/**`,
`src/security/**`, and `cli/encryption/**` are pinned to (near-)100% test
coverage in `vitest.config.ts`'s per-file `coverage.thresholds` block —
see "Coverage thresholds" below. Logging goes through
`src/observability/logger.ts` (`Logger` is a direct type alias for pino's
own `Logger`). Metrics go through `src/observability/metrics.ts` (a
module-level singleton `Registry`, served at `/metrics/auth`).

Per `docs/maintainer-notes.md`, the Phase 2 stack is considered
**frozen**: it is single-tenant at the MQTT/quota boundary today
(`org = "default"` hardcoded at those call sites — see
`docs/operating-modes.md`), and no further multi-org work starts without
a concrete operator request.

### Logger/metrics: two stacks, one redaction list

Phase 1 and Phase 2 each ship their own logger type and their own metrics
registry — a historical split, not a functional gap:

- **Loggers**: `src/logger.ts` exports a hand-rolled `Logger` interface
  with two backends (`createConsoleLogger`, used under the Bun-compiled
  binary because pino's `thread-stream` transport breaks under Bun; and
  `createPinoLogger` under Node). `src/observability/logger.ts` exports
  `Logger` as a direct alias of pino's own type and is pino-only (no Bun
  fallback — Phase 2 is not supported on Bun at all; see "Boot
  validation" below).
- **Metrics**: `src/metrics.ts` constructs a per-`CoordinatorServices`-
  instance `prom-client` `Registry` (so multiple coordinator instances in
  one process don't share counters) served at `/metrics`. Phase 2's
  `src/observability/metrics.ts` is a module-level singleton `Registry`
  served at `/metrics/auth`, deliberately kept separate to avoid
  namespace coupling between the two metric sets (see the module's own
  header comment).
- **Redaction is unified**: both loggers redact the same secret paths.
  `src/observability/redact-paths.ts` exports `REDACT_PATHS` (17 dotted
  paths — bearer/cookie headers, OAuth tokens, form bodies, session
  scope), imported by both `src/logger.ts` (applied via a hand-rolled
  `redactPaths()` helper for the console backend, and via pino's own
  `redact` option for the pino backend) and `src/observability/logger.ts`
  (pino's `redact` option). This closed the redaction gap previously
  tracked as architecture-09 (fixed in `securite-surface-04`,
  commit `6482528`).
- **What's actually deferred**: converging the two `Logger` *types* and
  the two metrics patterns (instance vs. singleton) into one is a
  cognitive-cost cleanup (qualite-code-06), not a security gap — the
  redaction fix above already closed the only security-relevant part of
  this split. It is not scheduled; do it opportunistically if you're
  already touching both stacks, not as a standalone refactor.
- **For new code**: prefer the Phase 2 stack
  (`src/observability/logger.ts` / `src/observability/metrics.ts`) unless
  you're extending an existing Phase 1 module that already imports
  `src/logger.ts` / `src/metrics.ts` — matching the surrounding file's
  existing import avoids a partial, file-by-file migration.

## House lints (`scripts/lint-*.sh`)

`bash scripts/lint-run-all.sh` runs all of the following (also wired into
CI's `Lint` job, `.github/workflows/lint.yml`) and reports every
violation before exiting non-zero, rather than stopping at the first
failure. `tests/unit/lint-scripts.test.ts` also exercises these scripts
directly (skipped if Git Bash isn't resolvable on Windows PATH — see the
"Windows: Git Bash vs. WSL on PATH" note in `CONTRIBUTING.md`).

1. **`lint-no-users-org-id.sh`** — forbids `users.org_id` outside an
   allowlist (`src/database.ts`, the v0.7→v0.8 migration test, and the
   lint-scripts test itself). Phase 2 renamed `users.org_id` to
   `users.primary_org_id`; the old name should only appear in the
   migration DDL / legacy compat view.
2. **`lint-no-current-timestamp.sh`** — forbids `CURRENT_TIMESTAMP` in
   `src/auth`, `src/quota`, `src/security`, `src/http`, `src/tools`. Phase
   2 SQL must use `strftime('%s','now')` so timestamp columns are unix
   seconds, not SQLite's default ISO-string format. Phase 1 baseline
   files are out of scope.
3. **`lint-no-audit-mutation.sh`** — forbids `UPDATE audit_log` /
   `DELETE FROM audit_log` outside `src/database.ts` (migration/backfill)
   and `src/sweeper/` (bounded TTL deletion). `audit_log` is append-only
   by design.
4. **`lint-html-escape.sh`** — forbids unescaped `${...}` template
   interpolations in `src/auth/pages/**/*.ts` unless the expression calls
   `escapeHtml(...)`. False positives are acceptable; false negatives are
   not.
5. **`lint-no-direct-env-in-auth.sh`** — forbids
   `process.env.COORDINATOR_*` reads in `src/auth`, `src/cli`,
   `src/admin`, except an explicit allowlist: `src/auth/org-settings.ts`
   (the `getOrgSetting()` shim, which provides per-org overrides with env
   fallback), `src/auth/cookies.ts` (the `getCookieSecureFlag()`
   pre-shim escape hatch), and **`src/boot.ts`** (the one place Phase 2
   boot validation is allowed to read env directly — see the comment at
   the top of that file). Everywhere else, config reads must flow through
   `getOrgSetting(db, orgId, key, default)`.

There is no lint enforcing `import type` for `CoordinatorServices` — in
practice every consumer that only needs the type (not a runtime value)
does write `import type { CoordinatorServices } from "../server-setup.js"`
(see `src/tools/agents-tools.ts`, `src/register-workflow.ts`,
`src/announce-workflow.ts`), but this is a convention observed in the
code, not a script-enforced rule.

## Coverage thresholds

Per `CONTRIBUTING.md`, files under `src/auth/**`, `src/security/**`, and
`cli/encryption/**` (plus a handful of individually pinned Phase 2 files
— `src/boot.ts`, `src/boot-encryption.ts`, `src/discovery.ts`,
`src/http/response-contract.ts`, `src/observability/logger.ts`,
`src/observability/metrics.ts`, admin/device-flow HTML pages, etc.) carry
per-file coverage thresholds in `vitest.config.ts`'s `coverage.thresholds`
block, most pinned at 100% branches/lines/statements/functions. A few
entries are intentionally below 100% with a `TODO(coverage-ratchet)`
comment pointing at audit finding `tests-01` — these are known gaps being
paid down incrementally, not a general exception. `pnpm test:ci` (`vitest
run --coverage`) fails the build if any pinned file regresses below its
threshold.

## Glossary of spec references (Txx / Vx / S1…)

Source comments throughout `src/` cite short codes like `T29`, `V3 §4`,
`S1`/`S2`, or audit finding IDs like `architecture-07`. These are pointers
into the project's internal planning history, not a single indexed
document:

- **`Vx §n`** (e.g. `V3 §4`, `V4 §16.3`) refers to a section of a
  *versioned* design/decisions document under `docs/superpowers/specs/`
  — e.g. `2026-05-13-v0.7.1-phase2-decisions-v2.md` /
  `-v3.md`, or `2026-05-13-auth-phase2-oauth-device-design-V4-patches.md`.
  Each `V` bump is a revision of the same design as requirements evolved.
- **`Txx`** (e.g. `T29`, `T45`, `T06a`/`b`/`c`) refers to a numbered
  implementation task within one of those design docs' task breakdowns.
  Not every `Txx` has a dedicated file in `docs/superpowers/specs/` today
  (some task lists were working documents that didn't get committed) —
  when in doubt, `git log -S T29 -- src/` or the CHANGELOG is the
  reliable way to find the commit(s) that implemented a given task.
- **`S1` / `S2`** (seen in `src/http/utils.ts`, `src/announce-workflow.ts`,
  `src/tools/*.ts`) mark refactor steps that extracted shared code (e.g.
  "S1: REST router extracted from serve-http.ts", "S2 fix: shared
  `announce_work` orchestration") — these are step labels from a specific
  cleanup pass, not a general-purpose numbering scheme.
- **`architecture-NN` / `qualite-code-NN` / `securite-*-NN` / etc.** refer
  to individual findings from a dated audit pass (see `audit/` at the
  repo root for the current one). This document's own "Boot validation"
  and "Logger/metrics" sections above were themselves written to close
  such findings (`architecture-10`, `architecture-09`, `qualite-code-06`).

If you can't resolve a specific code from context, treat it as a
breadcrumb into project history rather than a live contract — the
current source and tests are the source of truth.

## Boot validation (`src/boot.ts`)

`bootPhase2()` is the sole entry point that activates Phase 2 (auth,
sessions, encryption, the sweeper, audit queue). It returns `null` when
`COORDINATOR_OAUTH_ENABLED != "true"` (Phase 1-only deployments never pay
the Phase 2 validation cost). When OAuth is enabled, boot fails closed
(throws `BootValidationError`) rather than starting in a half-configured
state — see the numbered steps in the function body for the full
validation sequence (required env vars, `COORDINATOR_PUBLIC_URL` scheme/
localhost checks, JWT secret entropy, restore detection, per-provider
config pairing, encryption guards).

**Runtime constraint**: Phase 2 additionally refuses to boot on the Bun
runtime (`typeof globalThis.Bun !== "undefined"`, the same detection used
by `src/database.ts`'s `initDatabase()` for its Bun/`bun:sqlite` branch,
and by `src/logger.ts`'s `createLogger()` to pick the console logger over
pino). `src/auth/` and `src/admin/` bypass the `DatabaseAdapter`
abstraction via a cast to the better-sqlite3 surface and rely on
better-sqlite3-only APIs (e.g. `transaction().immediate()`) that
`bun:sqlite` doesn't implement — an untested combination that the GitHub
Releases Bun-compiled binaries could otherwise hit at runtime. `bootPhase2`
throws `BootValidationError` immediately when both `globalThis.Bun` is
defined and OAuth is enabled, before any other Phase 2 validation or DB
access. Run the Node build (npm/Docker) if you need OAuth; the Bun
binary is Phase-1-only.

## Process model: mono-instance-per-process, DB as a process singleton

`src/serve-http.ts` holds module-level state (`services`, `httpLog`,
`currentRunConfig`) that every HTTP/MCP/MQTT request handler closes over
directly — not per-call locals. That means **one Node process runs at most
one live coordinator at a time**. `startServer()` enforces this: a module
flag (`serverRunning`) is set on entry and a 2nd concurrent `startServer()`
call (without an intervening `handle.stop()`) throws immediately rather than
silently reassigning the 1st instance's state out from under it
(`architecture-02`). The flag is released in `stop()`, so the supported
restart pattern — `await startServer(); …; await handle.stop(); await
startServer();` **sequentially** in the same process — keeps working (tests
use this pattern; see `tests/integration/serve-http-mono-instance.test.ts`).
Running several coordinators side by side means running several **OS
processes**, each with its own port/`mqttTcpPort`/`dataDir` — not several
in-process instances.

`src/database.ts`'s `getDb()` is a classic locator: a module-level `let db`
set once by `initDatabase()` at boot and read by ~80 call sites across ~22
files via `getDb()` rather than constructor-injected `DatabaseAdapter`
instances (`architecture-03`). This is consistent with — and only tenable
because of — the mono-instance-per-process model above: since a process
only ever runs one coordinator, "the database" and "the process's database
connection" are the same thing, and a global locator introduces no
cross-instance ambiguity. The two concerns a locator normally raises are
therefore already closed here:

- **Two coordinators, two `dataDir`s, one process** — can't happen; ruled
  out by the `architecture-02` guard above.
- **Serial test isolation** (each Vitest file gets its own DB via
  `initDatabase()`/`closeDb()` around the single module-level `db`) —
  tracked separately as `tests-10`, dispositioned YAGNI (single-tenant
  deployment profile doesn't need `fileParallelism`; see `audit/` for the
  finding).

Constructor-injecting `DatabaseAdapter` into every domain class (registry,
consultation, file tracker, …) instead of calling `getDb()` is a **deferred
refactor, not a current defect**: it would let multiple coordinators share a
process and let Vitest run files in parallel (`fileParallelism`), but
nothing in this codebase's deployment profile needs either today, and the
migration is mechanical (swap `getDb()` reads for a constructor param) —
doable later without redesigning the call sites first. Do not start it
speculatively; it earns its keep only if/when a concrete need for
in-process multi-instance or parallel test files shows up.

## How to add an endpoint or MCP tool

Two transports exist side by side; a given feature is often exposed on
both. Follow the pattern of the nearest existing sibling rather than
inventing a new shape.

### REST endpoint

1. Add a zod schema for the request body (if any) to `src/http/rest-schemas.ts`
   — mirror the equivalent MCP tool's field set where one exists (see the
   file's own header comment for the "mirror, but don't newly reject
   previously-valid payloads" rule).
2. Add the route to `handle-rest.ts`'s `handleRest()` dispatcher (matched
   on `req.url` + method). Parse the body with `parseBody()`, validate
   with your schema (`schema.safeParse(body)`, `sendValidationError()` on
   failure), respond with `json(res, ..., status)` using the
   `appError()` envelope for error cases (`src/http/response-contract.ts`).
3. If the endpoint duplicates logic another transport already has (e.g.
   register, announce), extract or reuse a shared `*-workflow.ts` module
   (see "shared flow" below) instead of copy-pasting.

### MCP tool

1. Add `server.registerTool(name, { description, inputSchema, annotations }, handler)`
   inside the relevant `registerXTools()` function under `src/tools/`
   (one file per domain — see the directory map above). Use `z` from
   `zod` directly for the argument shape (no separate schema file for MCP
   — unlike REST, the shape is inline).
2. Resolve the caller's org via `getSessionClaims(extra.sessionId ?? "")`
   before touching any org-scoped data.
3. Set MCP tool annotations (`readOnlyHint`, `destructiveHint`,
   `idempotentHint`, `title`) to match the operation's actual semantics —
   clients use these as hints.
4. If the tool belongs to the announce workflow, add it to the server
   `instructions` in `src/mcp-instructions.ts`. With tool search on, that
   text plus bare tool names is all a client sees at session start — a tool
   absent from it is a tool the agent has no reason to look for. A test
   pins every name cited there against the real registrations, so an
   invented name fails the suite rather than the user.

### Shared flow between REST and MCP

When both transports need the same side effects, extract a
`run<X>Flow()` function into its own module at `src/` top level (see
`src/register-workflow.ts`'s `runRegisterFlow()` and
`src/announce-workflow.ts`'s `runCommonAnnounceFlow()`) that both
`handle-rest.ts` and the relevant `src/tools/*.ts` file call. Each
transport keeps its own pre/post steps (e.g. MCP-only conflict detection,
REST-only JSON response shaping) — only the common orchestration is
shared. Do **not** try to unify the REST and MCP response/event payload
shapes themselves if they've historically diverged (see the header
comment in `announce-workflow.ts` for why: external consumers may depend
on the existing field names).

## See also

- `CONTRIBUTING.md` — contribution process, coverage policy, Windows Git
  Bash note.
- `docs/operating-modes.md` — polling vs. push (Channels), and the
  multi-org experimental-status note.
- `docs/maintainer-notes.md` — standing decisions (Phase 2 frozen,
  perf/chaos out of CI, i18n policy).
- `README.md` — user-facing overview and quickstart.
