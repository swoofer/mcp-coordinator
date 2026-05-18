# Plan Round 1 — Dependency graph

**Verdict**: MISSING-EDGES

The DAG is mostly correct in spirit but understates several edges (T07/T09 dependencies), over-constrains a couple of tasks (T05 → T03, T11 → T06), and has one external-dep referenced by the wrong file extension. Phase ordering is sound. Below are 9 findings plus a proposed merge sequence.

## Findings

### 1. FALSE-EDGE: T07 → T06

**Issue**: The DAG shows T07 (`cli/server/start.ts` env forwarding) depending on T06. The plan text says "T06 (env vars defined)". But env vars are not "defined" in code — `fwd()` is a pure string passthrough that reads `process.env[NAME]` and conditionally adds it to the child env. The forwarding works whether or not `bootPhase2` reads the variable. T07 only needs the existing `fwd` infrastructure in `cli/server/start.ts:72-91` (verified present today).

**Recommendation**: Drop the T06 → T07 edge. T07 can land any time after the plan starts — it's effectively a Phase A task. Move it next to T01/T02 and ship it as the third small Phase A PR. This unblocks ops/release prep early and de-risks the 24h reminder + spawn-detached path that operators will hit immediately when v0.10.5 ships.

### 2. MISSING-EDGE: T11 (`encryption verify`) needs T08 (write path) for its happy-path tests

**Issue**: T11's test cases include "Encrypted DB + correct key: verify exit 0 with counts" and "Mixed pass/fail (corrupted row injected)". To produce an encrypted DB to verify against, the test must either (a) populate rows via T10's `migrate` CLI or (b) populate via the runtime write path (T08). T11 lists deps `T05, T06` only. With only T05+T06, there is no way to get an `enc:v1:` row into the DB except by hand-crafting the ciphertext — fragile and bypasses the very contract verify is asserting.

**Recommendation**: Add T08 (or T10) as a test-only dep for T11. Easiest fix: declare T11 depends on T10 (since `migrate encrypt` is the cleanest "populate-from-plaintext" path the verify CLI was designed to pair with).

### 3. MISSING-EDGE: T09 (refresh-rotation) implicitly depends on T02 (provisionUser options-object)

**Issue**: T09 only lists `T03, T06, T08`. But T09 modifies `src/auth/refresh-rotation.ts`, and the spec patches around T08/T09 share the same `encryption: EncryptionProvider` plumbing convention pioneered by T02. More concretely: T08 changes `provisionUser`'s signature and T09 ships immediately after T08 in the same area of the codebase. If T02 is reverted or not yet merged, T08's merge would fail in T09's PR. T02 is in fact a prerequisite of T08 (correctly noted) and thus a transitive prerequisite of T09 — but the DAG should make this explicit because T09 may be implemented in parallel with T08 by a different agent.

**Recommendation**: Add T02 → T09 as a documentation-level edge ("transitive via T08") to avoid confusion when an agent picks up T09 and reads only its dep list.

### 4. FALSE-EDGE (over-constrained): T05 → T03

**Issue**: T05 (`master-key.ts` — decode, entropy, fingerprint) only consumes Node's `node:crypto` and a `pino.Logger` interface. It does NOT use the `EncryptionContext`, `EncryptionProvider`, `DecryptionError` classes, or `encrypt-nullable` helpers added by T03. The current dep listing says T05 depends on T03; the plan body says "T03 unblocks T04 and T05 which can run in parallel" — but T05 itself has zero T03 imports based on the file shape described.

**Recommendation**: Drop the T03 → T05 edge. T05 can run fully in parallel with T03 (both Phase B). This pulls one PR off the critical path and lets master-key reviewers and crypto reviewers work concurrently.

### 5. EXTERNAL-DEP: T10 references `cli/server/backup.js`, actual file is `backup.ts`

**Issue**: T10's implementation summary references `getRunningCoordinatorPid()` "from `cli/server/backup.js`". Verified the actual file is `cli/server/backup.ts` (TypeScript). The `.js` extension is wrong. Also verified `getRunningCoordinatorPid` is exported from that file today.

**Recommendation**: Fix to `cli/server/backup.ts`. (Or, if the project uses extension-less imports per its tsconfig, drop the extension entirely.) Minor but agents will grep for the wrong file.

### 6. EXTERNAL-DEP: T12 references `getAuditQueue()` accessor — verified present, but redact censor string is wrong

**Issue**: T12 plans an `encryption` block in `/health/ready` and a `getEncryptionStatus()` accessor mirroring `getAuditQueue()`. Verified `getAuditQueue()` exists in `src/security/audit.ts:20`. The pattern is sound. **However**, T12's acceptance says "`*.idp_refresh_token` in a log object is redacted to `[Redacted]`". The existing `src/observability/logger.ts:55` uses censor string `"[REDACTED]"` (all caps). Tests written to the plan's "[Redacted]" expectation will fail.

**Recommendation**: Update T12 acceptance to `[REDACTED]` (all caps) to match the existing convention. Also: `REDACT_PATHS` already contains `"*.idp_access_token"` (line 22) — T12 only needs to add `*.idp_refresh_token`, not both. Plan text is fine on this point; just call out the censor string.

### 7. MISSING-EDGE: T12 needs T08 for the `coordinator_idp_encryption_enabled` gauge integration test, and T10 for `coordinator_idp_plaintext_rows`

**Issue**: T12 lists deps `T03, T06, T09, T10`. T08 is missing. The `coordinator_idp_encryption_enabled` gauge is set at boot (T06) — fine — but exercising it end-to-end with a real encrypted write requires T08 (the actual write site). Test "Each of the 5 audit events emits with the correct tier and metadata shape" includes `encryption.write.persisted` or similar which is emitted from T08's write path (per V2 §Observability).

**Recommendation**: Add T08 to T12's dep list. T12 is the integration-test consumer of everything from T06 onward; its dep list should be `T06, T08, T09, T10` (plus transitively T03).

### 8. FILE-CONFLICT: T03 + T05 + T04 all touch `src/security/` but different files — no conflict

**Issue**: Checked — T03 modifies `src/security/encryption.ts` + creates `encrypt-nullable.ts`; T04 creates `envelope-encryption.ts`; T05 creates `master-key.ts`. No file overlap. The `vitest.config.ts` per-file threshold block IS a shared edit hotspot — T03, T04, T05, T10, T11 each append a new entry, and three of them target the same `coverage.thresholds.perFile` map.

**Recommendation**: Land T03 first to establish the per-file threshold convention/format; T04 and T05 will rebase with trivial 3-line conflicts on the threshold map. Alternative: pre-land an empty entries block in T03 with TODO comments for each file, so later PRs only fill in numbers (no structural conflict). Worth a line in the plan.

### 9. MERGE-ORDER: Suggested merge sequence

The plan claims T01 and T02 can ship immediately and independently. True. But the implicit merge order matters because T08 needs both T02 + T06, and several PRs share the `system_config` row contract.

**Recommended merge order (12 PRs)**:

```
1.  T01 (system_config + bootPhase2 deps inj)        // unblocks T06
2.  T02 (provisionUser options-object)               // unblocks T08
3.  T07 (start.ts env fwd — Phase A per finding #1)  // operators-safe, ship early
4.  T03 (encryption.ts + helpers + error classes)    // unblocks T04, T08, T12
5.  T04 (envelope-encryption.ts) // parallel with —  // unblocks T06
6.  T05 (master-key.ts)          // — T04            // unblocks T06, T11
7.  T06 (bootPhase2 integration)                     // unblocks D, E, F
8.  T08 (oauth-finalize encrypt-at-write)            // unblocks T09, T11, T12
9.  T09 (refresh-rotation read + write + error map)
10. T10 (encryption migrate CLI)                     // unblocks T11 happy-path tests (per finding #2)
11. T11 (encryption verify + fingerprint CLI)        // parallel with —
12. T12 (metrics + audit + readiness + redact)       // — T11 (no overlap)
13. T13 (docs)                                       // after T12 settles names
14. T14 (release-please)                             // final
```

Critical path length: 9 PRs (T01 → T03 → T04 → T06 → T08 → T09 → T12 → T13 → T14). T02/T05/T07/T10/T11 collapse into parallel slots, saving ~3-4 wall-clock days vs strict serial. Phase A's three PRs (T01, T02, T07) can land same-day.

---

**No cycles detected.** **No wrong phases.** The DAG is structurally sound; the misses are at the edge-list granularity, not the topology.
