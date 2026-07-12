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
