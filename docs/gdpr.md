# GDPR procedures

mcp-coordinator stores limited personal data per user account. This
document describes how operators of self-hosted deployments can satisfy
the GDPR's data-subject-rights articles (15, 16, 17, 20) and how to
navigate the tension between Art. 17 erasure and SOC 2 / audit-log
immutability.

**Disclaimer**: this document is operational guidance, not legal advice.
Consult counsel for jurisdictional specifics (UK GDPR, CCPA/CPRA,
Brazilian LGPD, regional carve-outs). The procedures below codify the
technical building blocks; the legal interpretation of "erasure",
"retention", and "legitimate interest" is the controller's decision.

References:

- V3 §B-NEW-6 -- audit-log Tier 1 / Tier 2 durability split (the
  technical underpinning of the SOC 2 vs GDPR trade-off below)
- V3 NR13 -- two-tier audit retention
- V4 FIX 3 -- `user_orgs` ON DELETE CASCADE (makes erasure atomic)
- `scripts/lint-no-audit-mutation.sh` -- CI lint that forbids `UPDATE` /
  `DELETE audit_log` in application code; this doc documents the
  operator-action exception

## Scope: what PII does mcp-coordinator hold

Phase 2 (v0.8.0) stores:

### Identifying data

- `users.email` -- verified primary email from the IdP
- `users.name` -- optional display name from the IdP
- `users.idp_user_id` -- stable IdP identifier (e.g. GitHub user ID).
  Considered a pseudonymous identifier under Art. 4(5)
- `users.idp_access_token` -- the live IdP OAuth token (encrypted at
  rest in v0.7.5+ via the EncryptionProvider abstraction; today stored
  in plaintext on disk -- POSIX 0600 on the DB file is the only barrier)

### Behavioral / forensic data

- `audit_log.actor_user_id` -- the acting user's ID
- `audit_log.actor_ip` -- source IP
- `audit_log.actor_user_agent` -- User-Agent string
- `audit_log.metadata_json` -- per-event details; some events include
  hashed identifiers (e.g. SHA-256 of `idp_user_id`) instead of raw PII
  per the codebase's identifier_hash discipline
- `refresh_tokens.consumer_fingerprint` -- HMAC of IP+UA at token-issue
  time (V3 §B-NEW-2 stolen-token detection)
- `device_auth_requests.requester_ip` / `_ua` / `_country`

### Session state

- `refresh_tokens` rows -- per-session refresh-token state
- `oauth_state` rows -- short-lived PKCE state (auto-deleted after 10
  minutes by the sweeper; rarely a concern for erasure)

### Out of scope (operator-controlled)

- Thread / message content stored by Phase 1 features. If your
  deployment uses the consultation / introspection / agent-activity
  APIs, the message bodies are operator-stored and outside the scope of
  this doc's SQL recipes. Adapt the recipes to your data.

## Art. 15 -- Right of access

A data subject is entitled to a copy of their stored personal data.

### Self-serve

The user can call:

```
GET /api/auth/me
Cookie: __Host-coordinator_session=...
```

The response is their `users` row (id, idp_provider, idp_user_id, email,
name, role, primary_org_id, last_login_at).

### Operator SQL

For an Art. 15 SAR (Subject Access Request), an admin can extract a
JSON-friendly view:

```sql
.mode json

SELECT * FROM users WHERE id = ?;

SELECT * FROM refresh_tokens WHERE user_id = ?;

SELECT * FROM audit_log
WHERE actor_user_id = ? OR (metadata_json LIKE '%' || ? || '%')
ORDER BY ts ASC;

SELECT * FROM device_auth_requests WHERE requester_user_id = ?;

SELECT * FROM user_orgs WHERE user_id = ?;
```

Operators should additionally export any Phase 1 thread / message rows
created by the user, scoped by `org_id`.

## Art. 16 -- Right to rectification

The coordinator stores names and emails verbatim from the IdP. To
rectify:

1. The user updates their profile at the IdP (GitHub: Settings ->
   Public profile)
2. The user logs in again -- `exchangeCode` re-fetches IdpUserInfo and
   the OAuth callback updates `users.email` / `users.name` on the next
   sign-in

No operator action is required. If the user cannot re-authenticate (e.g.
account locked), an admin can `UPDATE users SET email = ?, name = ?
WHERE id = ?` directly.

## Art. 17 -- Right to erasure ("right to be forgotten")

The technical erasure path is:

```sql
BEGIN;
  -- Refresh-token state (no FK on users.id, must delete explicitly)
  DELETE FROM refresh_tokens WHERE user_id = ?;

  -- Multi-org membership (FK CASCADE per V4 FIX 3 -- redundant but
  -- explicit for documentation)
  DELETE FROM user_orgs WHERE user_id = ?;

  -- Device auth requests
  DELETE FROM device_auth_requests WHERE requester_user_id = ?;

  -- Anonymize audit log -- see "GDPR vs SOC 2 tension" below
  UPDATE audit_log
     SET actor_user_id = 'erased-' || ?,
         actor_ip = NULL,
         actor_user_agent = NULL,
         metadata_json = json_set(metadata_json, '$.erased', 1)
   WHERE actor_user_id = ?;

  -- Finally remove the users row
  DELETE FROM users WHERE id = ?;
COMMIT;
```

The `actor_user_id = 'erased-' || ?` pattern leaves a tombstone keyed to
the original ID. The original is irrecoverable (no reverse mapping), but
sequenced events remain distinguishable from each other in the audit
log. This is the GDPR-compliant compromise discussed in the next section.

### Per-table notes

- `users` -- the primary record. Deleting cascades to `user_orgs` via
  the V4 FIX 3 `ON DELETE CASCADE`. The deletion itself is final.
- `refresh_tokens` -- no FK to `users.id` (intentional, so revocation
  audit trails survive user deletion). Must be deleted explicitly.
- `audit_log` -- NOT deleted; anonymized in place. See the tension
  section below.
- `oauth_state` -- typically already swept (10-min TTL); no per-user
  action needed.
- Phase 1 `threads`, `messages`, `agents`, etc. -- operator-specific.
  The right-to-erasure SQL must extend to any Phase 1 tables that
  carry `created_by` or analogous user references.

### Cascading deletes (V4 FIX 3)

The schema declares `ON DELETE CASCADE` on the FK from `user_orgs.user_id`
to `users.id`. Other Phase 2 tables intentionally do NOT cascade so that
admin force-revoke audit trails are preserved past the user's lifetime.
This is a deliberate split:

| Table                  | On user DELETE | Rationale                              |
|------------------------|----------------|----------------------------------------|
| `user_orgs`            | CASCADE        | No useful data without the user        |
| `refresh_tokens`       | manual         | Revocation audit trail value           |
| `device_auth_requests` | manual         | Forensic trail (denied/approved_at)    |
| `audit_log`            | ANONYMIZE      | SOC 2 immutability conflict (below)    |

## Art. 17 vs SOC 2 audit-log immutability

The conflict: GDPR Art. 17 grants the data subject the right to
erasure. SOC 2 CC4.1 and §7.2 (and similar ISO 27001 / PCI DSS clauses)
require complete, immutable audit logs for security-critical events.
Per V3 §B-NEW-6, the coordinator's Tier 1 audit-log durability
contract makes Tier 1 events non-mutable in the application code path.

### Codebase enforcement

`scripts/lint-no-audit-mutation.sh` is a CI lint that fails the build
if any application source file (under `src/`) contains `UPDATE audit_log`
or `DELETE FROM audit_log`. Only the sweeper (which runs the retention
window deletion) is exempted via path allowlist. This makes accidental
audit-log mutation impossible to merge.

> **⚠️ The SQL in this runbook breaks the audit hash chain. Do not run it as
> written.** `actor_user_id` and `metadata_json` are both inputs to
> `canonicalRowFields` (`src/security/audit-chain.ts`), so updating them in
> place invalidates the stored `row_hash` of every row touched.
>
> Replayed verbatim against a seeded database, `scripts/verify-audit-chain.ts`
> goes from `exit 0` to `exit 1` with `wrong_row_hash` on every affected row --
> which `docs/ops/audit-integrity.md` defines as *"the row content has been
> mutated in place after the original insert"* and instructs the operator to
> treat as a Tier 1 security signal.
>
> Until [#349](https://github.com/swoofer/mcp-coordinator/issues/349) lands a
> redaction path that preserves the chain, an erasure request has to be handled
> with that consequence understood and recorded, not by following these two
> statements as if they were safe.
>
> This was latent while `actor_user_id` was NULL on every row -- the `WHERE`
> clause matched nothing. [#319](https://github.com/swoofer/mcp-coordinator/issues/319)
> populates that column, so the runbook now bites.

GDPR erasure REQUIRES mutation. The reconciliation is:

1. **Anonymize, do not delete**. The `UPDATE audit_log SET
   actor_user_id = 'erased-' || ?` pattern above replaces the identifier
   with a tombstone keyed to the original. The event itself
   (action, ts, outcome, request_id, tier) is preserved. SOC 2's
   "complete audit trail" requirement is satisfied; GDPR's
   "no identifying data" requirement is satisfied (the tombstone is
   not reversible).
2. **Operator-action exception**. The `lint-no-audit-mutation.sh`
   guard applies to application code only. Operator admin SQL --
   executed manually as part of a documented runbook -- is permitted.
   This runbook (the SQL above) IS the operator-action exception;
   keep a record of every execution alongside the SAR ticket for
   SOC 2 auditor review.
3. **Tier choice matters**. Tier 1 events (security-critical) default
   to 365-day retention; Tier 2 (operational) to 90 days. Operators
   pursuing strict GDPR data minimization can shorten Tier 2 retention
   (`COORDINATOR_AUDIT_TIER2_RETENTION_DAYS=30`) so naturally-aged-out
   rows do not require erasure SQL. Tier 1 events stay the full
   `COORDINATOR_AUDIT_RETENTION_DAYS` window for SOC 2; anonymize per
   above when an erasure request arrives.

### Documenting the trade-off externally

Your privacy policy and Data Processing Agreement (DPA) must disclose:

- The operator anonymizes the audit-log on erasure rather than deleting
  outright
- The anonymization is irreversible (no key escrow)
- The retention period for the anonymized rows is the standard audit
  retention (default 365 days for Tier 1)
- The legal basis for the retained audit data is "compliance with legal
  obligation" / "legitimate interest in security and incident
  investigation" (Art. 6(1)(c) and (f))

Most regulators accept this anonymize-don't-delete pattern. Document it
explicitly before deploying.

## Art. 20 -- Right to data portability

Export the user's data as JSON. The SQL queries from Art. 15 above are
sufficient -- pipe through `.mode json` in the sqlite3 CLI or
`json_object()` in a wrapper:

```sql
SELECT json_object(
  'user',           (SELECT json_object('id', id, 'email', email, 'name', name,
                                         'idp_provider', idp_provider,
                                         'idp_user_id', idp_user_id,
                                         'role', role,
                                         'primary_org_id', primary_org_id,
                                         'created_at', created_at,
                                         'last_login_at', last_login_at)
                     FROM users WHERE id = ?),
  'org_memberships', (SELECT json_group_array(org_id) FROM user_orgs WHERE user_id = ?),
  'audit_events',   (SELECT json_group_array(json_object(
                       'ts', ts, 'action', action, 'outcome', outcome,
                       'tier', tier, 'metadata', metadata_json))
                     FROM audit_log WHERE actor_user_id = ?
                     ORDER BY ts ASC)
) AS export;
```

The output is JSON, machine-readable, and includes everything the
coordinator stores about the user (Phase 1 thread / message exports are
operator-specific).

## Data controller vs processor split

For self-hosted deployments:

- **Operator** (the entity running mcp-coordinator) is the **data
  controller**. They decide what data is collected and why.
- **mcp-coordinator** the software is a **data processor** running on
  the controller's infrastructure. It processes only what the
  controller's configuration tells it to.
- The **IdP** (GitHub today; Google / OIDC / Entra in Phase 4) is a
  **sub-processor**. The controller must disclose this in their privacy
  policy and DPA.

For SaaS deployments where mcp-coordinator is offered as a hosted
service, the hosting entity is a processor; the customer organizations
remain controllers of their users' data.

### Sub-processors to disclose

Phase 2 (v0.8.0):

- **GitHub, Inc.** -- OAuth IdP (US-based; relies on GitHub's GDPR DPA
  for trans-Atlantic data flow under the EU-US Data Privacy Framework)

Phase 4 (when activated):

- **Google LLC** -- if Google IdP is configured
- **Microsoft Corporation** -- if Entra ID is configured
- Any other configured generic OIDC IdP

The coordinator does not communicate with any third party other than
the configured IdP. No telemetry, no error-reporting service.

## Operator runbook

For every Art. 17 request:

1. **Verify identity**. Re-authenticate the requester or otherwise
   confirm the request is genuine (e.g. cross-check with HR records).
2. **Open a ticket**. Record the request, the user_id, the requester's
   verification method, and the timestamp. Required for SOC 2.
3. **Run the export** (Art. 15 + 20 above) for your records.
4. **Run the erasure SQL** above inside an explicit transaction.
5. **Confirm with the user** that the erasure completed.
6. **Append the ticket reference** to the audit-log tombstone metadata
   so future SOC 2 audits can correlate the anonymization back to the
   approved request:

```sql
UPDATE audit_log
   SET metadata_json = json_set(metadata_json, '$.gdpr_ticket', 'SAR-2026-0123')
 WHERE actor_user_id = 'erased-' || ?;
```

The runbook produces a paper trail (the SAR ticket + the anonymized
audit rows pointing back to it) that satisfies both regulator inquiry
and SOC 2 auditor review.

## Out of scope

- HIPAA / region-specific health-data requirements
- PCI DSS payment-card requirements (the coordinator handles no
  payment data)
- Cookie consent banners -- not required for the strictly-necessary
  `__Host-coordinator_session` cookie under ePrivacy Directive, but
  confirm with counsel for your jurisdiction
- Data Processing Agreement template -- consult counsel; the IAPP and
  EDPB publish reference templates
