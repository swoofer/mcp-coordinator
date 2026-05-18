# Plan Round 1 synthesis

**Date**: 2026-05-17
**Reviews synthesized**: 01-task-atomicity, 02-dependency-graph, 03-missing-tasks, 04-acceptance-tests
**Total findings**: ~46 (10 atomicity + 9 dep-graph + 12 missing + 17 acceptance, some overlap)
**Outcome**: plan V2 patches doc (`2026-05-17-idp-encryption-plan-V2-patches.md`) — supersedes specific sections of plan V1

## Convergent findings (2+ reviewers)

| # | Finding | Reviewers | Severity | Decision |
|---|---|---|---|---|
| P1 | `tests/helpers/encryption.ts` orphaned — referenced but not owned by any task; consumes `computeKeyFingerprint` from T05 (not T03) | Atomicity#7, Missing#1, Acceptance#1, Dep-graph (implicit) | BLOCKING | ACCEPT — extract as **T05b**, owned by T05's reviewer, after T05 lands (has fingerprint helper) |
| P2 | T06 too large (350 LOC + 25-test matrix); concurrent test untestable in vitest | Atomicity#1, Acceptance#3,#4 | BLOCKING | ACCEPT — split into T06a (load+guards+forwarding), T06b (wrapped provider), T06c (reminder+teardown). Extract encryption boot code into `src/boot-encryption.ts` for per-file coverage gate. |
| P3 | T07 false dep on T06; should be Phase A (or fold into T06a per atomicity) | Atomicity#2, Dep-graph#1 | MAJOR | ACCEPT atomicity view — fold into T06a (env-var contract co-located) |
| P4 | T05 has false dep on T03 (master-key.ts uses only `node:crypto`) | Dep-graph#4 | MAJOR | ACCEPT — drop edge; T05 parallel with T03 |
| P5 | `vitest.config.ts` per-file thresholds inconsistent: T03 has it; T04/T05 acceptance say "100% coverage" but don't mandate the entry | Missing#2, Acceptance#2 | BLOCKING | ACCEPT — add explicit "add per-file threshold entry" to T04, T05 acceptance |
| P6 | Fingerprint persistence test duplicated T06+T08; T06 owns the invariant | Missing#redundancy1, Acceptance#8 | MAJOR | ACCEPT — drop from T08; T06b is canonical |
| P7 | Concurrent/multi-process tests not runnable in vitest (T06 first-encrypt race, T10 two-process race) | Acceptance#3,#11 | MAJOR | ACCEPT — demote to single-process simulation (T06b), OR explicit harness task (T10 — keep as worker_threads test with helper) |
| P8 | "Lint clean" / "tests pass" / "coverage gate met" boilerplate without bound commands | Acceptance#17 | MAJOR | ACCEPT — preamble defines: lint=`npm run lint`, tests=`npm test`, coverage=embedded in `npm test`; tasks inherit |

## Single-reviewer findings — ACCEPTED

### From atomicity
| # | Finding | Decision |
|---|---|---|
| A1 | SPLIT T04: extract T04b "Pinned wire-format test vectors" (~50 LOC) | ACCEPT — protects against silent wire-format drift |
| A2 | SPLIT T10: extract T10a "PID-in-content lock utility" (~100 LOC reusable primitive) | ACCEPT — clean for future v0.10.6 rotation |
| A3 | SPLIT T13: T13a (reference updates) + T13b (new runbook) | ACCEPT — runbook quality materially higher with dedicated review |
| A4 | SPLIT T12: T12a (logger redact ~20 LOC, parallel-after-T03) + T12b (metrics+audit) + T12c (/health/ready) | ACCEPT — PII-leak fix lands days earlier |
| A5 | CLEAR keep: T01/T02 separate, T02/T08 refactor-then-extend separation | NOTE — keep as-is |
| A6 | RE-SCOPE T14: release procedure, not coding task; no LOC estimate | ACCEPT |

### From dep-graph
| # | Finding | Decision |
|---|---|---|
| D1 | MISSING T11→T10 (verify happy-path needs encrypted rows) | ACCEPT — add edge |
| D2 | MISSING T09→T02 (transitive via T08, document explicit) | ACCEPT — explicit edge |
| D3 | `backup.js` → `backup.ts` typo | ACCEPT — trivial fix |
| D4 | `[Redacted]` → `[REDACTED]` casing in T12 acceptance | ACCEPT — match existing convention |
| D5 | MISSING T12→T08 (some metrics need write site for end-to-end) | ACCEPT — add edge |
| D6 | vitest.config.ts shared edit hotspot — land T03 first with stubs | ACCEPT — pre-stub TODO entries in T03; later tasks fill in numbers |
| D7 | Merge sequence (12 PRs critical path) | ACCEPT — incorporate into V2 |

### From missing
| # | Finding | Decision |
|---|---|---|
| M1 | SIGINT/SIGTERM lock cleanup not in T10 | ACCEPT BLOCKING — add to T10b implementation summary + test |
| M2 | PATCH 3 grep audit step (`enc:v_:` literal usage) has no owner | ACCEPT — add to T06a acceptance (one-line grep) |
| M3 | PATCH 6 5-substep bootPhase2 ordering collapsed to one line | ACCEPT — enumerate in T06a/b/c distribution |
| M4 | PATCH 17 HMAC label `mcc-audit-pseudonym-v1` not pinned in test | ACCEPT — add to T12b implementation summary |
| M5 | `tests/perf/bench-refresh-rotation.ts` preservation note for T09 | ACCEPT — one-line acceptance bullet |
| M6 | Plan task numbering "T20" typo | ACCEPT — editorial fix |

### From acceptance
| # | Finding | Decision |
|---|---|---|
| AC1 | T06 "100% coverage on new boot.ts lines" not enforceable | ACCEPT — extract `src/boot-encryption.ts` (per P2) → per-file threshold works |
| AC2 | T06 boot tests "unchanged behavior" not verifiable | ACCEPT — acceptance: `git diff` of existing boot tests shows only additions |
| AC3 | T07 `fwd()` exact-set drift detection | ACCEPT — add `grep -c` acceptance |
| AC4 | T09 `bumpTokenEpoch` reuse not verified | ACCEPT — `vi.spyOn` or grep acceptance |
| AC5 | T09 concurrent refresh during plaintext lazy-migration not tested | ACCEPT — add test bullet (single-process via interleave at SELECT/UPDATE boundary) |
| AC6 | T10 `--force` audit emission unclear | ACCEPT — decide: drop "(with audit warning)" — no event added to PATCH 17 |
| AC7 | T11 exit-code constants vs magic numbers | ACCEPT — Open question #5 resolved: 0=ok (including "no rows yet"), 1=warnings, 2=fatal. Add `EXIT_OK`/`EXIT_FATAL` constants if doctor.ts has them. |
| AC8 | T12 `decrypt_failures_5m` semantics never tested | ACCEPT — drop "_5m" suffix; field becomes `decrypt_failures_total` (lifetime counter) per Open question #6 |
| AC9 | T13 "no broken internal links" gate | ACCEPT — add markdown-link-check OR drop the criterion. Decide: drop, eyeball check in review. |
| AC10 | T14 `prepublishOnly` may not run integration tests | ACCEPT — pre-T14 verification step: `npm test 2>&1 | tee /tmp/test.log; grep -c "tests/integration" /tmp/test.log` returns expected count |
| AC11 | T06 second-override-run TOKEN_LOSS branch matrix gap | ACCEPT — add row #13 to matrix |
| AC12 | Open question #5 resolved in AC7 | RESOLVED |
| AC13 | Open question #6 resolved in AC8 | RESOLVED |

## Single-reviewer findings — DEFERRED / REJECTED

| # | Finding | Decision |
|---|---|---|
| M7 | Decoded master-key intermediate buffer zeroization | REJECTED — V2 §Risks accepted defers to v0.10.6 |

## New task layout (V2)

V1 had 14 tasks. After atomicity splits + extracts:

```
Phase A — Foundation (3 tasks, parallel)
  T01  system_config + bootPhase2 deps inj          (~150 LOC)
  T02  provisionUser options-object refactor         (~150 LOC)
  T12a Logger redact `idp_refresh_token`             (~20 LOC, can ship as hotfix)

Phase B — Encryption primitives (5 tasks, T03/T05 parallel, T04 after T03, T04b after T04, T05b after T05+T04)
  T03  encryption.ts types + helpers + error classes (~200 LOC)
  T04  envelope-encryption.ts                        (~250 LOC)
  T04b Wire-format regression vectors                (~50 LOC)
  T05  master-key.ts (decode + entropy + fingerprint)(~200 LOC)
  T05b tests/helpers/encryption.ts                   (~80 LOC)

Phase C — Boot wiring (3 tasks, sequential)
  T06a Load + guards + daemon env forwarding         (~200 LOC, includes T07 fold)
  T06b Wrapped provider + first-encrypt persistence  (~120 LOC)
  T06c Plaintext reminder + shutdown teardown        (~80 LOC)

Phase D — Read/write integration (2 tasks, parallel)
  T08  oauth-finalize.ts encrypt at write            (~100 LOC)
  T09  refresh-rotation.ts read + write + error map  (~150 LOC)

Phase E — CLI (4 tasks)
  T10a PID-in-content lock utility                   (~100 LOC)
  T10b encryption migrate command                    (~200 LOC, depends on T10a)
  T11  encryption verify + fingerprint              (~150 LOC)

Phase F — Observability + docs + ship
  T12b Metrics + audit events                        (~120 LOC)
  T12c /health/ready encryption block                (~60 LOC)
  T13a Reference doc updates (README, .env.example, onboarding, threat-model) (~150 LOC)
  T13b docs/ops/encryption-key-management.md runbook (~450 LOC)
  T14  Release v0.10.5                               (release procedure)
```

**Total**: 19 tasks. PR avg ~120 LOC. Critical path ~10 PRs.

## New dependency DAG (V2)

```
T01 ─┬─→ T06a  (system_config needed by guards)
     └─→ (no other dependents)

T02 ─→ T08

T03 ─┬─→ T04 ──→ T04b
     │      └─→ T05b
     ├─→ T08
     ├─→ T09
     ├─→ T10b
     ├─→ T11
     ├─→ T12b
     └─→ T12c

T04 ─┬─→ T04b
     ├─→ T05b
     ├─→ T06b
     └─→ T08

T05 ──→ T05b (uses computeKeyFingerprint)
     └─→ T06a (uses decodeMasterKey)

T05b ─→ T06b, T08, T09, T10b, T11, T12b, T12c   (all need test helpers)

T06a ─→ T06b ──→ T06c
        └─→ T08, T09

T08 ─┬─→ T09  (test setup uses oauth-finalize-encrypted)
     ├─→ T11  (verify happy-path needs encrypted rows)
     └─→ T12b

T10a ──→ T10b

T10b ─→ T11  (verify happy-path needs encrypted rows; alternative to T08)

T12a (orphan — Phase A parallel)

T12b ──→ T12c

T13a, T13b ──→ T14
T12c ──→ T14
T11 ──→ T14
```

No cycles. Critical path: T01 → T03 → T04 → T05b → T06a → T06b → T08 → T09 → T12b → T13b → T14 (11 PRs).

## Recommended merge sequence (~3-4 days wall-clock with parallelism)

```
Day 1 (parallel-doable):
  T01, T02, T03, T05, T12a    — 5 PRs land (all Phase A + early Phase B)

Day 2:
  T04, T05b, T13a              — 3 PRs (T05b needs T04+T05)

Day 3:
  T06a, T06b, T06c, T08         — 4 PRs sequential
  T04b, T10a, T13b              — 3 PRs parallel anywhere after T04/T05

Day 4:
  T09, T10b, T11, T12b, T12c   — 5 PRs
  T14                          — release
```

## Plan V2 changes summary

| Area | V1 | V2 |
|---|---|---|
| Total tasks | 14 | 19 |
| Largest PR | 600 LOC (T13) | 250 LOC (T04) |
| Average PR | ~200 LOC | ~120 LOC |
| Test helpers | footnote orphan | T05b owns it |
| T06 | 350 LOC monolith with branch matrix | T06a + T06b + T06c |
| T07 | standalone 50 LOC | folded into T06a |
| T10 | 300 LOC | T10a (lock util) + T10b (migrate) |
| T12 | 200 LOC | T12a (redact) + T12b (metrics+audit) + T12c (/health) |
| T13 | 600 LOC | T13a (refs) + T13b (runbook) |
| Acceptance commands | "lint clean" | preamble pins `npm run lint`, `npm test` |
| bootPhase2 lines | mixed in `src/boot.ts` | extracted to `src/boot-encryption.ts` for per-file gate |
| Open Q #5 | unresolved | exit codes: 0=ok (incl no-rows), 1=warnings, 2=fatal |
| Open Q #6 | unresolved | drop `_5m` suffix, lifetime counter |

## Round 2 plan review needed?

NO. V2 patches are mostly mechanical (task splits, dependency edges, command pinning). The remaining risk:
- Mechanical bugs caught at implementation time (CI gates each PR).
- Operational issues caught in field feedback after v0.10.5 ships.

A second plan-review round would consume ~80k tokens for diminishing returns. The 19-task layout is concrete and atomic enough to implement against.

## Path forward

1. Write `2026-05-17-idp-encryption-plan-V2-patches.md` (next step).
2. Mark plan V2 as approved.
3. Begin implementation, starting with Phase A (T01, T02, T03, T05, T12a in parallel).
4. Use `subagent-driven-development` skill per the plan preamble.
