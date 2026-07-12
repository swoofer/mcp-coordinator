# Maintainer notes

Decisions that don't belong in code comments or the README, but that a
future maintainer (including future-me) needs to find quickly.

## Phase 2 (auth/multi-org): frozen

The OAuth / multi-org / encryption stack (`src/auth/**`, `src/security/**`,
`cli/encryption/**`) is stable and considered **frozen**. The runtime is,
and is expected to remain, single-tenant (`org = "default"`) at every MQTT
and quota boundary. The `TODO(Task 22)` comments scattered across
`src/server-setup.ts`, `src/metrics.ts`, `src/serve-http.ts`, and
`src/working-files-tracker.ts` document exactly where and why the
single-tenant assumption is baked in — they are notes for *if* multi-org
ever ships, not a queued backlog.

**Policy**: no further multi-org work (a real Task 22/23.5 — per-org boot,
per-org MQTT topic scoping, etc.) starts without a concrete request from an
operator who actually needs multiple orgs in one deployment. Until then,
those TODOs stay as-is; do not "clean them up" by ripping out the org
plumbing, and do not start implementing multi-org speculatively.

The project's core value is the coordination/MQTT layer, not multi-tenancy.
Effort goes there by default.

## Perf/chaos scripts: manual, not CI-gated

`tests/perf/` (`bench-refresh-rotation.ts`, `bench-audit-queue.ts`,
`bench-token-epoch.ts`) and `tests/perf/chaos/`
(`idp-failure-injection.ts`, `audit-queue-overflow.ts`) are run via
`pnpm perf:rotation` / `perf:audit` / `perf:token-epoch` /
`chaos:idp` / `chaos:audit` (see `package.json`). Each prints a
`JSON_SUMMARY: {...}` line as its final stdout output.

**Policy**: these scripts are **not wired into CI** — deliberately, not
an oversight. Running them on every PR would add cost (wall-clock time)
and instability (perf numbers are noisy on shared CI runners) for
signal that mostly matters ahead of a release, not per-commit. There is
no automated tracking/diffing of the `JSON_SUMMARY` output across runs
today — a maintainer runs them manually and eyeballs the numbers.
**Risk accepted**: a perf/chaos regression can land without CI catching
it. Mitigation: run these scripts manually before cutting a major/minor
release, not as a per-PR gate.

## Binary releases (GitHub Releases channel): known gaps, deferred

`.github/workflows/release-binaries.yml` builds Bun-compiled binaries
(`bun build --compile`) for macOS arm64/x64 and Linux x64, and publishes
them as GitHub Release assets. Two gaps in that workflow are known and
currently deferred rather than fixed:

- **`oven-sh/setup-bun` has no `bun-version` pinned** — the workflow gets
  whatever Bun version `setup-bun`'s default resolves to at run time,
  which can drift between releases without anyone noticing (and without
  a way to reproduce a past build's exact toolchain).
- **The "smoke test" is shallow**: the `Verify binary` step only runs
  `./bin/mcp-coordinator --version` and `./bin/mcp-coordinator server
  --help` — it never actually starts the server, hits `/health`, or
  exercises a real request/response cycle. A binary that starts and
  responds to `--version` but crashes on `server start` would ship
  undetected.

**Disposition**: deferred, tracked together with the broader binary-
channel decision (does this channel have real users; should it be
promoted, kept as-is, or dropped). When that decision lands, do both
fixes in the same pass: pin `bun-version` explicitly, and replace the
smoke test with `server start` (backgrounded) + `curl /health` + a
clean kill. Until then, this is a known, accepted gap in the binary
channel's release quality bar — it does not block npm/Docker releases,
which have their own (separate) verification.

## Landing i18n

`docs/index.html` is maintained by hand across 6 locales. Retranslating the
roadmap/version cards on every release is pure toil and a translation-drift
risk (stale strings survive longer than the English source).

**Policy**:
- Versioned content (roadmap items, version numbers, changelog-adjacent
  copy) relies on the English fallback. Do not hand-translate these per
  release — translate once retired from "current" if it becomes worth it.
- Only stable sections (hero, pitch, high-level value proposition) get
  full translation maintenance across all 6 locales.
- Reevaluate whether ZH/JA/DE are worth maintaining at all based on
  analytics (traffic share per locale) rather than assumption. If a locale
  isn't earning its translation cost, let it fall back to EN rather than
  keeping it half-translated.

This is a documented decision, not a change to `docs/index.html` itself —
implement it opportunistically as content is touched, not as a one-off
migration.

## MCP Streamable HTTP: no eventStore / resumability

`src/serve-http.ts`'s `StreamableHTTPServerTransport` instances are
constructed without an `eventStore`, so the transport does not support
SSE-stream resumability (`Last-Event-ID` replay after a dropped
connection). This is intentional (YAGNI), not an oversight: server-pushed
events already have a dedicated, reliable channel — the embedded MQTT
broker / SSE emitter (`src/mqtt-broker.ts`, the SSE endpoints) — so MCP
clients that need durable event delivery use that path rather than relying
on Streamable HTTP replay.

**Policy**: implement the SDK's `EventStore` interface (on SQLite, mirroring
the rest of the persistence layer) only if a concrete client need emerges
that MQTT/SSE can't already satisfy. Don't build it speculatively.

## MCP registry publication: deferred

`package.json`'s `mcpName` (`io.github.swoofer/mcp-coordinator`) is
declared and `serverInfo.name` (`src/server-setup.ts`) is aligned to it,
but publication to the official MCP registry is **not automated** — there
is no `server.json` and no `mcp-publisher` workflow. Publishing to a public
registry is a maintainer decision/action (registry ownership verification,
ongoing upkeep commitments), not something to bootstrap speculatively from
an audit finding. Deferred until the maintainer decides to publish.
