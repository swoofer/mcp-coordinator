# Plan Round 1 — Task atomicity

**Reviewer lens**: PR shape, task size, cohesion
**Plan under review**: docs/superpowers/plans/2026-05-17-idp-encryption-plan.md
**Verdict**: NEEDS-RESHAPE (mostly splits — 1 merge, 6 splits, 1 clear-keep, 1 re-scope)

The plan is structurally sound: phases follow the dependency DAG, refactors are correctly separated from feature work (T02 vs T08 is clean), and the LOC budget order-of-magnitude is right. The main issues are (a) two oversized tasks (T06, T13) that hide multiple logical changes behind one PR boundary, (b) one task that has been over-fragmented (T07 should fold into T06), and (c) test scaffolding (`tests/helpers/encryption.ts`) tucked into T03 as an implementation footnote when it is itself a small reviewable unit consumed by 6+ downstream tasks.

---

## Recommended task changes

### 1. SPLIT: T06 (`bootPhase2` encryption integration)
**Current**: 350 LOC + 25-test branch matrix in one PR. Mixes (a) key load + decode, (b) GLOB-based strict-mode guards with two override env vars + an INVALIDATED-tokens stash table, (c) wrapped-provider fingerprint persistence with race semantics, (d) 24h reminder interval + shutdown teardown, (e) DI wiring of `AuthHandlerContext`. Plan itself flags this in Open Question #2.
**Issue**: Five logical changes share one PR. Reviewer must hold key-decode semantics, two-key concurrent INSERT-OR-IGNORE race reasoning, fake-timer reminder behavior, and SQL-glob guard branch matrix in their head simultaneously. The 25-test matrix dwarfs the impl. A regression in (c) blocks merging (a)/(b)/(d). PATCH 10's `encryption_invalidated_tokens` table + per-user audit alone is ~80 LOC of disaster-recovery code that warrants its own focused review.
**Recommendation**: Split into three:
- **T06a — Load + guards** (~150 LOC): decode key, fingerprint compare, both `ALLOW_*` env-var override paths, INVALIDATED-tokens stash table + per-user audit. Branch matrix rows 1-12 + the entropy rows. Attaches a stub `PassthroughEncryption` to context so downstream T08/T09 can be reviewed against it.
- **T06b — Wrapped provider + first-encrypt persistence** (~120 LOC): PATCH 7 wrapped-provider class, `INSERT OR IGNORE` on first encrypt, concurrent-encrypt race test, `encryption.config.loaded` audit. Replaces the T06a stub with the real provider in `AuthHandlerContext`.
- **T06c — Plaintext reminder + shutdown teardown** (~80 LOC): PATCH 11 pino logger reminder, `Phase2Bootstrap.shutdown` interval clearing, fake-timer tests, NODE_ENV-conditioned log levels.
**New layout**: T06a → T06b → T06c, sequential. T08/T09 depend on T06b (need the real provider in context).
**Effort delta**: +0 net LOC; +1 PR overhead per split = +2 PRs; review time *decreases* per PR by ~3x, total ~same.

### 2. MERGE: T07 (`cli/server/start.ts` env forwarding) into T06a
**Current**: 50 LOC, 3 `fwd(...)` lines + one test file. Standalone PR.
**Issue**: This is 3 lines of pass-through code that *only makes sense* because T06 introduced 4 env vars. Reviewers will need to re-page T06's env-var contract to assess T07. Bloats the PR queue without adding review signal. Tests are mocking `child_process.spawn` shape — independent verification adds little.
**Recommendation**: Fold the 3 `fwd()` lines + the env-forwarding test file into **T06a** (where the env-var contract is defined). Same reviewer evaluates "these are the strict-mode env vars" and "these are the env vars forwarded to the daemon child" in one sitting.
**New layout**: T07 deleted; T06a grows ~50 LOC to ~200 LOC.
**Effort delta**: −1 PR; T06a still well under 250 LOC.

### 3. SPLIT: T04 (`envelope-encryption.ts`) — extract test vectors
**Current**: ~250 LOC, 11 enumerated test cases including a 3-row AAD swap matrix, format-injection forcing-function test, and "deterministic decode of fixed test vectors" (regression pins). Plan estimates "test file ~300 LOC" alongside ~150-200 LOC impl, so test:impl ~1.5-2x in one PR.
**Issue**: The test:impl ratio is realistic for a crypto primitive, but two distinct test concerns are bundled: (a) behavioral correctness (round-trip, error routing, AAD swap), and (b) **regression test vectors** — fixed `enc:v1:` ciphertexts with known plaintexts that pin the wire format forever. Vectors are a separate artifact: if they ever need regenerating (e.g., AAD encoding change), that PR should be its own conversation, not buried in routine behavior tests.
**Recommendation**: Keep T04 as the provider impl + behavioral tests (round-trip, error-routing, AAD swap matrix, format-injection). Add **T04b — Pinned wire-format test vectors** (~50 LOC) as a separate small PR after T04 merges: a single test file with 3-4 hand-computed `enc:v1:...` strings + expected plaintexts under a fixed test key. This PR exists *specifically* to be the canary for unintended wire-format changes.
**New layout**: T04 (impl + behavior, ~250 LOC) → T04b (regression vectors, ~50 LOC).
**Effort delta**: +1 small PR; protects against silent wire-format drift.

### 4. SPLIT: T13 (Documentation) — separate net-new from updates
**Current**: ~600 LOC across 5 files: README, two `.env.example`, onboarding doc, a brand-new `docs/ops/encryption-key-management.md`, and a threat-model update.
**Issue**: Net-new operational runbook (`encryption-key-management.md` covers generation, rotation, key escrow, ALLOW_TOKEN_LOSS DR procedure, verify CLI usage) is a substantive standalone artifact that benefits from a dedicated review — operators are the audience and the procedure-correctness review is qualitatively different from "did we mention the env var in README". Bundling it with one-liner README updates means doc-eng reviewers either rubber-stamp the runbook or block trivial README fixes.
**Recommendation**: Split into two:
- **T13a — Reference updates** (~150 LOC): README compliance matrix, both `.env.example` files, onboarding-self-host section + gotcha entry, threat-model residual-risk update.
- **T13b — `docs/ops/encryption-key-management.md` runbook** (~450 LOC): the new file. Dedicated review by an operator-mindset reviewer. Can land in parallel with T13a after T06c.
**New layout**: T13a and T13b parallel after T06c; both must merge before T14.
**Effort delta**: +1 PR; runbook quality materially higher.

### 5. SPLIT: T10 (`cli/encryption/migrate.ts`) — extract lock primitive
**Current**: ~300 LOC. Bundles (a) subcommand group factory, (b) PID-in-content lock per PATCH 15 with stale-PID recovery, (c) batched bidirectional (encrypt/decrypt) migration with CAS, (d) daemon-detection refusal, (e) 11 test cases including a real two-process race test.
**Issue**: The PID-in-content lock with stale-PID recovery is a reusable primitive (T11's `verify` arguably wants it too if it ever writes, and v0.10.6 rotation will need it). Burying it inside `migrate` couples primitive evolution to migration semantics. The two-process real-race test is also expensive infrastructure that justifies its own focused review.
**Recommendation**: Split into two:
- **T10a — PID-in-content lock utility + tests** (~100 LOC): `cli/encryption/lock.ts` (or `cli/lib/pid-lock.ts`) with acquire/release/stale-recovery, dedicated tests including the two-process race. Pure utility, reviewable in isolation.
- **T10b — `migrate` command using the lock** (~200 LOC): subcommand group factory, bidirectional migration with CAS, daemon refusal, batched loop tests. Depends on T10a.
**New layout**: T10a → T10b. T11 (verify/fingerprint) does not need the lock (read-only); unaffected.
**Effort delta**: +1 PR; lock primitive becomes a clean reusable building block for v0.10.6 rotation.

### 6. RE-SCOPE: T12 (Observability) — split logger redact + readiness
**Current**: ~200 LOC bundling (a) 3 Prometheus metrics + emission sites in 3 other modules, (b) 5 audit-event types wired at emission points, (c) `/health/ready` payload extension with `getEncryptionStatus()` module accessor, (d) `REDACT_PATHS` append for `idp_refresh_token`, (e) two test files.
**Issue**: (d) is a one-line config change with security-sensitive implications (PII leak prevention) that should NOT wait on metrics-wiring review to merge. (c) introduces a module-level accessor with boot-coupling subtlety (returns empty when accessor not set) that warrants its own review eye separate from prom-counter plumbing.
**Recommendation**: Split into three:
- **T12a — Logger redact** (~20 LOC): one-line append to `REDACT_PATHS` + redact assertion test. Standalone, shippable immediately after T03. (Could even ship in Phase A as a parallel hotfix.)
- **T12b — Metrics + audit events** (~120 LOC): 3 prom registries, emission sites in refresh-rotation/boot/migrate, 5 audit-event wirings, observability test file.
- **T12c — `/health/ready` encryption block** (~60 LOC): `getEncryptionStatus()` accessor, readiness payload extension, integration test. Depends on T12b for the `decrypt_failures_5m` counter source.
**New layout**: T12a parallel-with-anything after T03. T12b after T09+T10b. T12c after T12b.
**Effort delta**: +2 PRs; PII-leak fix lands days earlier.

### 7. SPLIT (small): Extract `tests/helpers/encryption.ts` as its own task
**Current**: Footnoted under T03 ("Place this file early in implementation; created as part of T03"). Required by T04, T06a/b/c, T08, T09, T10b, T11, T12b.
**Issue**: This helper is the test-infrastructure backbone for the entire encryption work. Tucking it into T03 means T03's review must also evaluate test ergonomics that T03 itself does not consume. Worse, if T03 lands without the helper (forgotten in the PR), every downstream task hits the gap. Conversely, if reviewers nit the helper in T03, they block T03's interface review.
**Recommendation**: Promote to **T03b — Test helpers (`tests/helpers/encryption.ts`)** (~80 LOC): `makeTestEncryption`, `withEncryptionEnv`, `selectIdpToken`, plus self-tests of each helper. Depends on T03 (uses the interface) and T04 (instantiates `EnvelopeEncryption`). Lands between T04 and T06a.
**New layout**: T03 → T04 → **T03b** → T06a.
**Effort delta**: +1 small PR; explicit gate ensures helpers exist before any task consumes them.

### 8. CLEAR: T02 / T08 refactor-vs-feature separation is correct — keep as-is
**Current**: T02 changes `provisionUser` to options-object signature with no `encryption` field; T08 later adds `encryption: EncryptionProvider` to `ProvisionUserArgs` and wires it at write sites.
**Issue**: None. This is exemplary separation. T02 is a pure mechanical refactor (compiler-enforced, three call sites updated), reviewable as a no-behavior-change PR. T08 is the semantic change. If T08 were bundled with T02, reviewers couldn't disentangle "did the signature refactor break anything?" from "did the encryption write semantics get right?".
**Recommendation**: No change. Document this as a pattern for future refactor-then-extend work.

### 9. CLEAR: T01 + T02 should remain separate PRs (Open Question #1)
**Current**: Plan asks whether to combine.
**Issue**: T02 touches three call sites + multiple tests; T01 touches database schema + boot signature. They share no files. Combining would force reviewers to context-switch between SQL DDL semantics and call-site refactor mechanics in one PR.
**Recommendation**: Ship separately, parallelizable. Resolve Open Question #1 as "2 separate PRs".

### 10. RE-SCOPE: T14 (Release v0.10.5) — confirm release-please bundling
**Current**: 50 LOC, ~all auto-generated. Listed as a task with acceptance criteria.
**Issue**: Not a code-review-shaped task — it's a release procedure. Treating it as a task with LOC estimate is mildly misleading. The "PR" here is the release-please-bot PR, which reviewers approve based on CHANGELOG content, not on the code (which is just a version bump).
**Recommendation**: Keep T14, but reframe acceptance as "release-please PR approved + npm publish verified + GitHub release published" — no LOC estimate. Note explicitly that the human work is CHANGELOG augmentation (operator-facing summary), not coding. Also: confirm T13a + T13b have both merged before approving the release PR (the docs must be on `main` for the published version to reference them).
**Effort delta**: 0 LOC; clearer expectations.

---

## Summary of changes

| Change | Old task | New tasks | Net PRs |
|---|---|---|---|
| Split boot integration | T06 | T06a, T06b, T06c | +2 |
| Merge daemon env forwarding | T07 | (folded into T06a) | -1 |
| Split crypto behavior vs wire vectors | T04 | T04, T04b | +1 |
| Split docs | T13 | T13a, T13b | +1 |
| Split CLI migrate lock | T10 | T10a, T10b | +1 |
| Split observability | T12 | T12a, T12b, T12c | +2 |
| Extract test helpers | (T03 footnote) | T03b | +1 |
| **Total** | 14 tasks | **21 tasks** | **+7 PRs** |

LOC budget unchanged (~2450). PR count rises from 11-13 to ~18-20. Average PR size drops from ~200 LOC to ~120 LOC — well inside the 100-400 LOC sweet spot. The largest remaining PR (T10b at ~200 LOC) is well-bounded. Parallelism within phases improves (T06a/b/c sequential, but T13a/b parallel; T12a parallelizable after T03).
