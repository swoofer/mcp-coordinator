# Plan Round 1 — Dependency graph (v0.10.6)

**Verdict**: OVER-CONSTRAINED (with 1 missing edge + 2 false edges)

The DAG correctly captures the core dependencies the user listed as guardrails (T03→T05, T04→T05+T06, T07→T13, T09→T10/T11/T12). The required edges from the prompt are all present in the V1 DAG (plan lines 33-56). However the graph **over-constrains in two places** (serializes work that could parallelize), has **one false test edge**, and **misses one frontend edge for T14**. No cycles. No phase-ordering inversions. No file-conflict landmines (T01/T02/T03 touch disjoint files; T11/T12 touch disjoint files).

## Findings

### 1. FALSE EDGE: T11 + T12 → T13
**Issue**: DAG line 53 (`T07 + T11 + T12 ──→ T13`) lists T13 (backend integration tests for `handle-admin-orgs`/`handle-admin-users`) as depending on T11 + T12 (frontend HTML/JS bundles). T13's own task spec (plan line 691) correctly lists deps as **T03, T04, T05, T06, T07 only** — no T11/T12. The integration tests hit the JSON API directly via `adminFetchClient`; they never load the static pages. The frontend pages are irrelevant to backend integration coverage.
**Recommendation**: Strike `T11 + T12` from the T13 ancestor list in the DAG diagram. T13 should run as soon as T07 lands, in parallel with the Phase C frontend work.

### 2. OVER-CONSTRAINT: T13 → T14
**Issue**: DAG line 54 sequentializes T14 (Playwright e2e) after T13 (backend integration). T14's task spec lists deps as `T07, T08, T11, T12, T13` — the T13 edge is gratuitous. T14 boots a fresh coordinator fixture and exercises the browser-side flow; it does not consume T13's test artifacts. The only real reason to gate e2e on integration is "fail fast on cheap tests first," which is a CI policy concern, not a code-dependency.
**Recommendation**: Drop the `T13 → T14` edge. T13 and T14 can land as parallel PRs after T07+T08+T11+T12 are in. If you want a "fast tests first" CI gate, encode it in CI ordering, not in PR merge order.

### 3. MISSING EDGE: T10 → T14
**Issue**: T14 explicitly tests the landing page (plan line 783: "Landing page: login → visit `/dashboard/admin.html` → admin email visible, nav links present, Logout works") and tests incognito redirect against `/dashboard/admin.html` (line 800). That page is created in T10, not T11/T12. T14's task-spec dep list (plan line 770) names `T07, T08, T11, T12, T13` — **T10 is omitted**. Without T10, the landing-page assertions fail.
**Recommendation**: Add `T10 → T14` to the DAG diagram and to T14's dependency list (plan line 770).

### 4. OVER-CONSTRAINT: T11 → T05, T12 → T06 (frontend page blocked by backend handler PR)
**Issue**: T11's deps (line 593) and T12's deps (line 643) list backend handler tasks ("T05 for backend handlers to test against in T14"). But the *files* in T11/T12 (HTML + JS bundles) don't import T05/T06 — they call the JSON API at runtime. The page PRs can land standalone and exercise mocked responses. The actual blocking constraint is `T05 + T06 → T14` (e2e needs working endpoints), which is already covered.
**Recommendation**: Demote T05/T06 from T11/T12's direct deps; move the constraint to T14 alone (it already lives there via T07). This unblocks the frontend track to run fully parallel with backend handler implementation after T09/T10 land.

### 5. SOFT-EDGE INFLATION: T01 → T03
**Issue**: T01's task body says BootValidationError hoisting "may" be needed only if the symbol is not already importable from a stable path (plan lines 103, 176). The DAG hard-codes T01→T03. If `BootValidationError` is already exported from `src/security/encryption.ts` or `src/boot.ts` (an open question the plan flags), T03 has no dependency on T01 and could ship as a single-file PR immediately.
**Recommendation**: Either (a) resolve the existence check before plan finalization and remove the edge if BootValidationError is already importable, or (b) note the edge as "conditional on T01 hoist sub-task" so it doesn't gate T03 unnecessarily.

### 6. MISSING EXTERNAL DEPENDENCY: `/api/auth/me` (T10 open question #1)
**Issue**: T10 plan (lines 562-579) bootstraps the landing page by calling `/api/auth/me`, but open question #1 (plan line 910) flags that this endpoint may not exist. If absent, a ride-along ~30 LOC addition is needed. This is an unresolved external dep that should be a precondition / sub-task, not an open question — otherwise T10 cannot complete its acceptance criteria.
**Recommendation**: Promote to a Phase A sub-task `T10a: verify /api/auth/me exists or add it`. Block T10 on T10a. Alternative: have T10's first acceptance criterion be the existence check + ride-along if needed.

### 7. UNDOCUMENTED FILE-CONFLICT FOR T03 + open-question #3 (`updated_at` columns)
**Issue**: Open question #3 (plan line 914) proposes adding `updated_at` columns + triggers to `orgs` and `users`, folded into T03 (~50 LOC). T05's PATCH response (plan line 298) and V3 PATCH 13 depend on the column being present. If answered "ship in v0.10.6," T05/T06 silently gain a dependency on T03's expanded scope. Currently the graph treats T05 → T03 as only "UNIQUE INDEX for 409." If updated_at lands in T03, that edge widens.
**Recommendation**: Resolve open question #3 before plan freeze. If "yes," document T03's expanded scope and the (still single) T03 → T05 edge keeps its weight. If "no," confirm T05 falls back to `new Date().toISOString()` and remove updated_at from T05's response shape.

### 8. OVER-CONSTRAINT: T15 → T16 is fine; T15 sequentialization vs T13/T14 is suspect
**Issue**: T15 (docs) deps list T13 + T14 (plan line 820). Docs describe API contracts, audit events, runbook recovery — none of which require test PRs to have landed first. T15 can be written from the spec and merged in parallel with T13/T14.
**Recommendation**: Loosen to `T07 → T15` (route wiring stable enough that doc paths/methods are final). Keep `T15 → T16` for the release. Saves one critical-path slot.

## Required-edges verification (per prompt)

| Edge | Present in V1 DAG? | Location | Verdict |
|---|---|---|---|
| T03 → T05 (UNIQUE INDEX before POST 409) | Yes | Plan line 39 | OK |
| T04 → T05 + T06 (validate.ts blocks handlers) | Yes | Plan lines 37-38 | OK |
| T07 → T13 (integration tests need dispatch) | Yes | Plan line 43, 53 | OK |
| T08 → frontend pages | Partial — DAG says T08 → e2e (T14), not T11/T12 directly | Plan line 44, 64 | OK as-is (T11/T12 files don't import T08; only browser-runtime CSP matters, validated in T14) |
| T09 → T10 / T11 / T12 (shared infra) | Yes | Plan lines 47-51 | OK |

All five guardrail edges are correctly present.

## Recommended merge sequence

Optimal critical path = 6 sequential slots (was 9 in V1):

```
Slot 1 (parallel): T01, T02, T03, T04, T08          ← Phase A + T04 + T08 all independent
Slot 2 (parallel): T05, T06, T09                    ← T05/T06 need T01+T02+T03+T04; T09 needs nothing
Slot 3 (parallel): T07, T10                         ← T07 needs T05+T06; T10 needs T09
Slot 4 (parallel): T11, T12, T13, T15               ← T11/T12 need T09 (+ runtime API which exists post-T07); T13 needs T07; T15 needs T07
Slot 5:            T14                              ← needs T07+T08+T10+T11+T12 (T13 dropped per finding #2)
Slot 6:            T16                              ← release after T14+T15
```

Key wins vs V1:
- **T04 promoted to Slot 1**: V1 implied T04 came after Phase A (Phase B header). It has zero deps — ship it in parallel with T01/T02/T03.
- **T08 promoted to Slot 1**: Static-handler patch is fully independent of everything else.
- **T13 in Slot 4**: V1 sequentialized T13 after T11/T12 (false edge per finding #1). Drop the edge and T13 runs parallel.
- **T15 in Slot 4**: Docs unblocked from T13/T14 per finding #8.
- **T10 added to T14 ancestors**: per finding #3 (missing edge).

Result: 14-16 PRs land in 6 merge waves instead of the implicit 9, with no increase in coordination overhead (all parallelism is within-wave, no cross-wave file conflicts since T01/T02/T03/T04/T08 touch disjoint files).
