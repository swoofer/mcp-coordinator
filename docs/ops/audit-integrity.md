# Operations -- audit log integrity (v0.9.1+)

mcp-coordinator's `audit_log` table is append-only and protected by a
SHA-256 hash chain. Every row carries:

- `prev_hash`: the previous row's `row_hash`, or `GENESIS_HASH`
  (`"0".repeat(64)`) for the very first row in the chain.
- `row_hash`: `SHA-256(prev_hash || canonical(this row's fields))`,
  hex-encoded.

Tampering with any committed row's content (action, actor, target,
outcome, metadata) breaks the row's `row_hash`. Insertion of a forged
row in the middle breaks the next row's `prev_hash` linkage. The
`scripts/verify-audit-chain.ts` script walks the chain and reports
every break it finds.

> **Two invocations, depending on where you are.** From an npm or Docker
> install the compiled script is at `dist/scripts/verify-audit-chain.js` and
> runs on plain `node` — no `tsx`, no devDependencies. From a repository
> checkout you can run the TypeScript source directly with `tsx`. Both are
> shown below; they are the same program.
>
> Until #348 the script shipped **nowhere** — `package.json`'s `files` and the
> Dockerfile both omitted `scripts/`, so the cron this runbook sets up named a
> file only a repo cloner had.

What this gives you:

- **In-place tamper detection.** Any database-level edit of row content
  is caught by the next verification run.
- **Insertion detection.** Forging a row between two committed rows
  desyncs the chain at the following row.
- **Forward provenance from migration.** All rows written after the
  T50 migration (v0.9.1) chain back to either the on-table `GENESIS`
  marker or to a row whose `row_hash` was computed at insert time.

What this does **not** give you on its own:

- **Timestamp integrity.** `created_at` is set by SQLite's
  `CURRENT_TIMESTAMP` default and is intentionally NOT part of the
  hash. An attacker with write access to the database file can
  rewrite timestamps without invalidating any `row_hash`. Pair this
  feature with TLS-protected log shipping or an external trusted
  timestamp authority (RFC 3161) for time integrity.
- **Deletion detection.** The retention sweeper (`src/sweeper/`)
  legitimately deletes audit rows past their TTL bucket, and those
  deletions leave gaps in the `id` sequence that look identical to
  malicious deletions of recent rows. The verifier reports
  `id_gap_before` findings informationally; pairing the chain with
  the **tip-attestation workflow** below distinguishes legitimate
  from suspicious.
- **Pre-migration tampering.** The T50 backfill assumes rows that
  existed before the migration are pristine. Operators upgrading from
  v0.9.0 or earlier should run a one-time verification immediately
  after upgrading to lock in the baseline tip, then start the
  ongoing attestation cycle from there.

## Running the verifier

From an npm or Docker install:

```sh
# Human-readable output (default DB path = data/coordinator.db)
node dist/scripts/verify-audit-chain.js

# Custom DB path
node dist/scripts/verify-audit-chain.js --db /var/lib/coordinator/coordinator.db

# JSON output for piping into a monitoring system
node dist/scripts/verify-audit-chain.js --json
```

From a repository checkout, the same three with `tsx scripts/verify-audit-chain.ts`.

Exit codes:

| code | meaning |
|------|---------|
| 0    | Chain is intact -- every `row_hash` recomputes correctly and every `prev_hash` links to the previous row's `row_hash`. Informational `id_gap_before` findings may appear but are not failures. |
| 1    | One or more rows fail verification (`missing_hash`, `wrong_row_hash`, or `wrong_prev_hash`). |
| 2    | Could not open the database, malformed CLI args, or some other operational error before verification ran. |

### Finding types

- `missing_hash`: a row has NULL `prev_hash` or `row_hash`. This
  should never happen in normal operation -- it indicates either an
  incomplete migration backfill (unlikely; the backfill is
  transactional) or direct DB write that bypassed `audit()`.
- `wrong_row_hash`: the row's `row_hash` does not equal
  `SHA-256(prev_hash || canonical(this row))`. The row content has
  been mutated in place after the original insert.
- `wrong_prev_hash`: the row's `prev_hash` does not equal the
  immediately previous row's `row_hash`. Either a row was inserted
  in the middle, a middle row was deleted, or the prev_hash field
  was rewritten.

  > ⚠️ **On a two-tier deployment this fires on a healthy database, and
  > it is not rare.** The sweeper runs two DELETEs on `audit_log` with two
  > TTLs (Tier 1 at 365 days, Tier 2 at 90), discriminated by action name.
  > It therefore removes rows from the **middle** of the chain, not a
  > prefix. Measured: purging 25 Tier-2 rows out of 50 produces 24
  > `wrong_prev_hash` findings — roughly one per surviving row.
  >
  > Past day 91, a two-tier deployment's verification is noise. Do NOT
  > wire the cron below to a pager until
  > [#348](https://github.com/swoofer/mcp-coordinator/issues/348) is fixed;
  > a detector that pages hourly on routine retention trains the operator
  > to ignore the only audit-tampering signal there is.
  >
  > Phase-1 mono-tenant escapes it: that profile writes a single tier, so
  > the purge is a strict prefix. One row of another tier — a single
  > `migration.audit_backfill` from an upgrade — is enough to break it.
- `id_gap_before`: the `id` sequence skips at least one value
  before this row. Informational only -- legitimate sweeper
  deletions look the same. Pair with the tip-attestation workflow
  to distinguish.

## Tip-attestation workflow (recommended for SOC 2 Type II)

The hash chain proves no tampering relative to the **current tip**.
To prove no tampering relative to a **past tip**, the operator must
record the tip externally on a schedule:

1. Run the verifier in JSON mode and record `report.tip_row_hash`:

   ```sh
   node dist/scripts/verify-audit-chain.js --json > /var/log/audit-tip-$(date -Iseconds).json
   ```

2. Sign the recorded value (e.g., with `gpg --detach-sign`) and
   upload it to a write-once external store -- an S3 bucket with
   Object Lock in Compliance mode, an immutable Azure Blob container,
   or a hardware-backed timestamp authority.

3. Cron the script on a cadence matching your audit-evidence
   policy. For most SOC 2 Type II engagements, hourly is sufficient.

4. On each verification run, compare the **current first row's
   `prev_hash`** against the **previous attestation's `tip_row_hash`**.
   If they match, every row written since the last attestation is
   forward-verifiable. If they don't match, an unrecorded chain
   advance occurred -- either rows were added and then deleted
   (consistent with sweeper retention crossing the attestation
   window), or someone rewrote the chain.

   > ⚠️ **This check does not distinguish a legitimate purge from
   > tampering in the middle of the chain**, which is what
   > [#348](https://github.com/swoofer/mcp-coordinator/issues/348) is about.
   > It compares the FIRST row's `prev_hash` to the previous tip. Deleting a
   > row from the middle changes neither of those, so the comparison passes
   > either way. It catches front-truncation and rewrites, not middle
   > deletion — and middle deletion is exactly what the two-tier sweeper
   > does on every pass.

   The match check is a single `jq`-or-grep comparison against the
   prior attestation's signed JSON:

   ```sh
   PREV_TIP=$(jq -r '.tip_row_hash' /var/log/audit-tip-prev.json)
   CURR_FIRST_PREV=$(jq -r '.findings[0]' /var/log/audit-tip-curr.json)  # not quite -- see below
   ```

   In practice the verifier should be extended to surface the first
   row's `prev_hash` directly; today operators can read it via SQLite
   directly:

   ```sh
   sqlite3 -readonly /var/lib/coordinator/coordinator.db \
     "SELECT prev_hash FROM audit_log ORDER BY id ASC LIMIT 1;"
   ```

   When this value differs from your last attested tip AND the
   sweeper has not advanced past your attestation window (check
   `audit_retention.md` for the policy), investigate.

## Integration with existing monitoring

The verifier is intended to run on the coordinator host (where the
SQLite file lives) under a systemd timer or k8s CronJob. A failing
verification (exit 1) should page the on-call engineer immediately --
this is a Tier 1 security signal.

Recommended cron entry:

```cron
0 * * * * /opt/mcp-coordinator/bin/tsx /opt/mcp-coordinator/scripts/verify-audit-chain.ts --db /var/lib/coordinator/coordinator.db --json | tee /var/log/coordinator/audit-tip-$(date +\%Y\%m\%dT\%H).json >/dev/null
```

Pair with a `journalctl`-based alert: if the JSON's `"ok": false` ever
appears, page.

## Recovery

If verification fails:

1. **Do not run the sweeper or any retention deletion until the
   incident is investigated.** Use
   `COORDINATOR_SWEEPER_ENABLED=false` if you have that toggle (or
   disable the cron) so further legitimate deletions don't blur the
   forensic timeline.
2. Export the entire `audit_log` table (`sqlite3 coordinator.db
   ".dump audit_log" > audit-snapshot.sql`) for forensic analysis.
3. Compare current state against the most recent signed
   tip-attestation. The first row's `prev_hash` after the
   attestation point should match the attested `tip_row_hash`.
4. If the chain is broken AT a known boundary, every row before
   the boundary remains verifiable; every row after the boundary
   should be treated as untrusted until corroborated against
   external logs (load balancer access logs, application logs,
   etc.).
5. File an incident per `docs/security/SECURITY.md`.

## References

- `src/security/audit-chain.ts` -- the canonical serialization +
  hash function.
- `src/database.ts` `backfillAuditChain` -- T50 migration backfill.
- `src/security/audit.ts` `insertAuditRowWithChain` -- Tier 1 sync
  insertion path.
- `src/security/audit-queue.ts` `writeBatchSync` -- Tier 2 batched
  insertion path.
- `docs/ops/audit-retention.md` -- sweeper TTL configuration; the
  per-tier retention window bounds how far back the chain can
  reasonably extend.
- `docs/security/threat-model.md` -- audit log mutability residual
  risk now superseded.
