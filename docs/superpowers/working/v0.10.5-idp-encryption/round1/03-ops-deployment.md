# Round 1 review — Ops / Deployment

**Reviewer lens**: deployment, migration, rotation, backup/restore, observability, ops UX
**Spec under review**: `docs/superpowers/specs/2026-05-17-idp-token-encryption-design.md`
**Overall verdict**: NEEDS-OPS-WORK

The cryptographic design is sound and the lazy-migration story is plausible for a single-instance daemon. But the spec leaves several real-world deployment paths unaddressed — most importantly, the env var is not propagated by `mcp-coordinator server start --daemon` (silently producing an unencrypted daemon), and the interaction with `server backup`/`server restore` is undocumented in a way that will get an operator into trouble the first time they restore in a different shell. Below are the concerns ranked by severity.

---

## Concerns

### 1. `server start --daemon` does not forward `COORDINATOR_ENCRYPTION_KEY` to the child — CRITICAL

`cli/server/start.ts` line 66–91 builds `childEnv` explicitly (with a comment explicitly forbidding bulk-copy of `process.env` to avoid leaking unrelated secrets like `AWS_*`). Each forwarded var has its own `fwd(...)` line. The spec never updates this list. Result: an operator who runs

```bash
export COORDINATOR_ENCRYPTION_KEY=...
mcp-coordinator server start --daemon
```

gets a daemon **without** the variable — it will boot in plaintext mode, log the warning into `server.log` (which operators usually don't tail in detached mode), happily continue serving, and silently downgrade the security posture the operator intentionally enabled. After the next OAuth login, plaintext tokens are written to the DB.

Worse: if the operator subsequently restarts foreground with the env set and runs `migrate-idp-tokens`, the previously-encrypted rows decrypt fine, but the rows written during the no-env window are still plaintext — they will be re-encrypted by the migration, masking the bug.

**Recommendation**: add a section "Wiring into `server start`" to the spec that explicitly requires:
- `fwd("COORDINATOR_ENCRYPTION_KEY", process.env.COORDINATOR_ENCRYPTION_KEY)` in `start.ts`.
- A boot-time check: if the foreground process has the env set but the daemon-spawn path did not forward it, fail loudly rather than warn. Easier: assert at boot that env-state matches the encryption-provider selection and write a `config.boot` audit row recording `encryption=on|off`.

### 2. Boot warning at WARN level disappears in production log aggregators — MAJOR

The spec says boot logs `log.warn("IdP tokens stored plaintext. Set COORDINATOR_ENCRYPTION_KEY...")`. Reality:

- Many log shippers (loki, default filebeat) filter or rate-limit `warn` separately from `error`.
- Operators running with `LOG_LEVEL=error` (a common production setting) will **never see** this warning.
- The Docker `healthcheck` reports `200 OK` regardless. Status page green.
- It's a one-shot at boot, so no recurring alarm.

`docs/onboarding-self-host.md` already documents "16 redact paths pre-configured" and recommends shipping pino logs to a SIEM — meaning operators legitimately have log levels tuned high. A one-shot WARN in a million-line audit stream is invisible.

**Recommendation**: 
- Log at `error` level when encryption is OFF in production (`NODE_ENV=production`), `warn` only in dev.
- Re-log periodically (every N hours) while plaintext mode is active.
- Add a `coordinator_encryption_enabled` gauge to `/metrics` (0|1) and a `coordinator_plaintext_idp_rows` gauge — let Prometheus alert on it.
- Surface in `/readyz` payload (without failing readiness — see #6).

### 3. Backup/restore interaction is silently broken across hosts — CRITICAL

I read `cli/server/backup.ts` and `cli/server/restore.ts`. Both operate purely on `config.json` + `data/`. Neither touches the env. The spec section "Backups remain plaintext" is misleading — backups are **ciphertext** for encrypted rows; only the operator's responsibility for OS-level encryption of *unencrypted* columns is offloaded.

Concrete operator failure mode:
1. Host A: encryption ON, `COORDINATOR_ENCRYPTION_KEY=ABC`, runs `server backup`, ships `coordinator-backup-*.tar.gz` to S3.
2. Host A dies. Operator provisions Host B from `.env.example` (which doesn't even mention `COORDINATOR_ENCRYPTION_KEY` — see #11), runs `server restore`, starts the daemon.
3. Restore succeeds. Daemon boots fine (PassthroughEncryption). `/healthz` and `/readyz` both green.
4. First user logs in via OAuth — works fine, since the OAuth flow rewrites tokens.
5. First user with a previously-stored refresh token (long-lived session) attempts a request → refresh-rotation runs → `decrypt()` is invoked on an `enc:v1:...` blob with `PassthroughEncryption` → spec says decrypt errors return `null` and force re-auth → silent mass logout.

Or, worse, Host B is set up with a *different* key `XYZ` — now decrypt errors are logged at ERROR (good), users are kicked (recoverable), but the operator has no procedure to recover the original tokens. The backup is now a useless ciphertext blob.

**Recommendation**:
- `server backup` MUST refuse (or warn loudly with `--force`) if `COORDINATOR_ENCRYPTION_KEY` is set but no companion key-escrow procedure is documented. At minimum, write a `BACKUP_README.txt` into the tarball noting "this backup contains ciphertext rows; you need the COORDINATOR_ENCRYPTION_KEY used at backup time to read IdP tokens."
- `server restore` should detect encrypted rows post-extraction (`SELECT 1 FROM users WHERE idp_access_token LIKE 'enc:v1:%' LIMIT 1`) and refuse to start unless the env var is set, with a clear message: "Restored DB contains encrypted IdP tokens. Set COORDINATOR_ENCRYPTION_KEY before starting, or pass --accept-token-loss to NULL them out."
- Add a `mcp-coordinator server verify-encryption-key` (the spec proposes `verify-encryption-key` already — extend it) to the post-restore checklist in `docs/onboarding-self-host.md`'s Restore section.

### 4. Key rotation procedure ("redeploy + re-migrate") is wishful — MAJOR

The spec says:
> Online key rotation deferred… v0.10.5 workaround: invalidate all existing tokens (`UPDATE users SET idp_access_token = NULL, idp_refresh_token = NULL`), users re-login with new key active.

This is not a rotation procedure — it's a **fleet-wide forced re-auth**. For a 200-developer org, that means 200 simultaneous OAuth round-trips at the moment the operator flips the key, plus on-call pages from every workflow that depended on a refresh token mid-flight. There's also a race: between "UPDATE users SET … NULL" and the daemon restart with new key, in-flight requests will see NULL tokens and may take unintended branches (the spec's "decrypt error → force re-auth" path will trigger en masse, but only for users whose tokens were already encrypted; users not yet migrated will skip cleanly — inconsistent).

The "deferred to v0.10.6 if demand surfaces" `--rotate --new-key=<...>` flag is **the** rotation feature; without it there is no rotation, only mass invalidation. Calling that "manual rotation" is misleading.

**Recommendation**:
- Either rename "Rotation" to "Forced re-auth (use as last resort)" and explicitly mark rotation as a v0.10.6 follow-up, OR ship the `--rotate --old-key --new-key` mode in v0.10.5. It's a small CLI on top of the existing migration loop and avoids a downstream "we shipped encryption but can't rotate the key" embarrassment.
- Document the rotation runbook step-by-step: announce → quiesce write traffic → run rotate CLI → restart with new key → verify with `verify-encryption-key`.
- Specify what happens if a rotation crashes halfway (mixed-key rows) — needs the wrapped DEK design extended with a key-id byte (`enc:v1:<keyId>:<blob>`), which v0.10.5 lacks. Without that byte, a half-rotated DB is unrecoverable. **This alone may justify slipping v0.10.5 or adding a key-id field now**.

### 5. `migrate-idp-tokens` crash mid-batch leaves no replay safety — MAJOR

Spec: "Wrapped in a single transaction per batch. Resumable (idempotent)." Per-batch transaction is good. But:

- No mention of acquiring an advisory lock — what happens if the operator runs the CLI twice concurrently, or runs it while the daemon is also rotating a token via `refresh-rotation.ts`?
- The CLI is described as running standalone (it must open its own DB handle), but the daemon also has the DB open with WAL. SQLite WAL allows concurrent readers + one writer, but a long-running migration writer will block the daemon's writer for the duration of each batch — under load, refresh flows may time out.
- "Resumable" assumes the CLI can be re-run safely. True for idempotency, but the spec doesn't say whether the CLI exits 0 on partial progress (so the operator can detect partial completion in a script) or just continues silently.

**Recommendation**:
- Either require the daemon to be stopped while `migrate-idp-tokens` runs (matching the `server backup` safety check) or document the WAL-contention behavior and recommend off-hours runs.
- Reuse the `getRunningCoordinatorPid()` helper from `cli/server/backup.ts` to emit a warning when the daemon is alive ("the daemon is running; refresh-rotation flows may briefly stall during migration; pass --force to continue").
- Document exit codes: 0 = done, 2 = partial (no rows to do or interrupted), 1 = error. Mirror `verify-encryption-key`'s exit-code scheme.

### 6. Encryption status not surfaced in `/healthz` or `/health/ready` — MAJOR

`src/http/health.ts` returns `{status: "alive"}` for `/healthz` and a checks payload for `/health/ready`. Neither reflects encryption state. An ops dashboard wired to readiness can't tell:
- whether the daemon is running encrypted or plaintext
- whether the master key was loaded successfully on the last boot
- whether decrypt failures are happening

**Recommendation** (don't fail readiness on encryption-off — backward-compat — but **do** expose it):
- Add an `encryption` block to the `/health/ready` payload: `{ enabled: bool, key_source: "env"|"none", decrypt_failures_5m: N }`.
- Don't make encryption status block readiness in v0.10.5 (avoids breaking existing plaintext deploys), but make it a configurable strict mode for v0.10.6 (`COORDINATOR_ENCRYPTION_REQUIRED=true` → fail readiness if encryption is off).

### 7. No metrics for decrypt failures, plaintext-row count, migration progress — MAJOR

The project already has prom-client wired (`src/observability/metrics.ts`, `src/http/metrics.ts`, `/metrics/auth` mentioned in onboarding doc). The spec adds no metrics. Operators have no telemetry for:
- `coordinator_idp_encryption_enabled` (gauge, 0|1)
- `coordinator_idp_decrypt_failures_total` (counter, labeled by reason: wrong_key, malformed, etc.)
- `coordinator_idp_encrypt_total` / `coordinator_idp_decrypt_total` (counters)
- `coordinator_idp_plaintext_rows` (gauge — populated by sweeper or migration)
- `coordinator_idp_migration_progress` (gauge during migration)

Without these, the "decrypt error → force re-auth" path becomes a silent user-impacting incident discovered by support tickets. Wrong-key disasters during a botched restore are invisible until users complain.

**Recommendation**: spec a small metrics section adding the five gauges/counters above. The `coordinator_idp_plaintext_rows` gauge in particular gives ops a closed-loop signal: "did `migrate-idp-tokens` actually finish?"

### 8. Encryption events should land in `audit_log` — MAJOR

Confirmed: `audit_log` table exists in `src/database.ts:300-313`, with org_id/user_id/action/metadata fields. The codebase already writes routinely via `src/security/audit.ts`. The spec writes none of these:

- `encryption.config.loaded` (boot, masterkey loaded successfully; metadata: key_fingerprint = SHA-256(masterKey) first 8 hex chars — never the key itself)
- `encryption.decrypt.failed` (user_id, column name, error class)
- `encryption.migration.started` / `encryption.migration.completed` (with row counts)
- `encryption.token.invalidated` (when the rotation workaround NULLs tokens en masse)

The audit trail is the operator's forensic record. Decrypt failures in particular tied to a user_id are essential for "did we just lose data on user X" investigation.

**Recommendation**: enumerate the encryption audit actions and add them to the spec. Reuse existing audit insert helpers.

### 9. Master-key fingerprint should be exposed for "is this the right key?" checks — MAJOR

`verify-encryption-key` only confirms the key decrypts *some* existing encrypted row. That works post-migration but: (a) what about disaster recovery scenarios where the operator is staring at a backup tarball and a set of three env files from different stages and needs to know which key matches — without running the daemon? (b) After rotation (when it lands), there are two valid keys. Which is current?

**Recommendation**:
- Add a `mcp-coordinator key-fingerprint` CLI: reads `COORDINATOR_ENCRYPTION_KEY`, prints `key_fingerprint=<first 16 hex of SHA-256>`. Log the same fingerprint at boot. Now operators can grep `coordinator.log` for the fingerprint and compare to the env they have.
- Store the fingerprint in a `config_kv` row (or new `encryption_metadata` row) at first encrypted write, so `verify-encryption-key` can give a richer message: "DB was encrypted with key fingerprint `abc123…`; current env has `xyz789…` — MISMATCH".

### 10. Multi-instance footgun — MAJOR

Spec says "Per-org DEK… Multi-tenant comes with multi-instance which comes with Postgres which is v1.x". But operators run multi-instance today (HA pair, blue/green deploys, region failover) even on single-tenant SQLite — typically with a replicated DB volume or DRBD/litestream. Concrete scenarios:

- Two coordinator instances, both pointed at same volume via NFS, different `COORDINATOR_ENCRYPTION_KEY`s (typo in one .env): one instance writes ciphertext-A, the other writes ciphertext-B, both fail to decrypt each other's writes. The "decrypt error → re-auth" path fires for half of all requests at random.
- litestream replica restored to a standby: same key required (see #3) but standby has its own `.env` and may diverge.

**Recommendation**:
- Spec should explicitly state "single writer; do not run two coordinator processes against the same DB" and link to the existing single-instance constraint.
- The key-fingerprint suggestion in #9 helps: at boot, if the DB has a stored fingerprint and the env key disagrees, refuse to start with a clear "DB encrypted with different key — abort" message. Cheap, prevents most multi-instance disasters.

### 11. `.env.example` not updated; Docker `docker inspect` exposure undocumented — MAJOR

The spec says ".env.example mentioned" but never enumerates the change. Checked: `examples/docker-compose/.env.example` and `.env.example` at repo root do not list `COORDINATOR_ENCRYPTION_KEY`. Operators copying the template won't know it exists.

Additionally, `docker-compose.yml` uses `env_file: .env`. Env vars set via `env_file` ARE visible to `docker inspect <container>` (under `Config.Env`) — anyone with docker socket access on the host reads the master key in plaintext. This is a meaningful operational caveat that the spec elides.

**Recommendation**:
- Add `COORDINATOR_ENCRYPTION_KEY=` entry to all three `.env.example` files with the `openssl rand -base64 32` hint and a security note.
- Add a "Docker secrets handling" subsection to the spec: recommend mounting the value via Docker secret / Kubernetes Secret rather than env, OR clearly document that `docker inspect` exposes it. Reference: `start.ts` currently reads from `process.env` only; supporting a `_FILE` convention (`COORDINATOR_ENCRYPTION_KEY_FILE=/run/secrets/encryption_key`) is ~10 lines and matches industry norm (Postgres, MySQL images do this).

### 12. Malformed env var — boot-time UX is acceptable but unspecified — MAJOR

`EnvVarMasterKeyProvider.load()` throws if length ≠ 32, with a hint about `openssl rand -base64 32`. Good. But:
- What level does this surface to the operator? Stack trace? One-line error?
- Does it write a `config.boot` audit row before throwing (so operators auditing failed boots can see why)?
- What if the value contains a stray newline (`COORDINATOR_ENCRYPTION_KEY=$(cat keyfile)` with trailing `\n`)? `decodeKey()` behavior is unspecified — base64-decoding `…=\n` produces a 33-byte buffer and the wrong-length check fires; the operator's error message will be `must decode to exactly 32 bytes (got 33)` which is correct but doesn't explain "trim trailing whitespace".

**Recommendation**:
- Specify `decodeKey()` semantics: trims surrounding whitespace, accepts both `+/=` (base64) and `-_` (base64url), rejects invalid chars with a precise message.
- Boot-time error path must: log at ERROR with the env var name (NOT the value), exit non-zero (1), and write `config.boot` audit row with `outcome=encryption_key_invalid`.
- Add a "common gotchas" entry to `docs/onboarding-self-host.md` covering this.

### 13. Bun runtime — no ops difference, but verify metric pipeline — MINOR

The spec correctly notes Bun is preserved (uses `node:crypto`, which Bun implements). `tests/integration/bun-encryption.test.ts` covers the runtime. Two operational follow-ups not in the spec:

- Bun's `process.env` semantics match Node, so env-var loading is identical.
- The metrics/audit-log writes proposed in #7 and #8 should be verified under both runtimes (the existing prom-client + audit queue setup works under Bun, but adding new counters with new label dimensions can occasionally trip up the Bun path).

**Recommendation**: add a checkbox in `tests/integration/bun-encryption.test.ts` scope: "metrics counters increment under Bun".

### 14. CLI command names — inconsistent with existing `server <subcommand>` style — MINOR

Existing commands are namespaced: `mcp-coordinator server start | stop | status | logs | backup | restore`. The spec proposes top-level commands:
- `mcp-coordinator migrate-idp-tokens`
- `mcp-coordinator verify-encryption-key`

This breaks the existing pattern. There's also no help-text grouping; an operator running `mcp-coordinator --help` will see a flat list with mixed concerns (server lifecycle, OAuth, encryption).

**Recommendation**:
- Move under a subcommand: `mcp-coordinator encryption migrate` / `mcp-coordinator encryption verify` / `mcp-coordinator encryption fingerprint` (per #9) / `mcp-coordinator encryption rotate` (future).
- Mirror `server backup`'s ergonomics: `--force`, `--data-dir`, exit-code documentation.
- Refuse to run while daemon is up by default (see #5).

### 15. Rollback story is "operator's responsibility" — MINOR

> "No CLI for downgrade — operator's responsibility."

Pragmatically OK for v0.10.5 if migration is opt-in and most operators won't downgrade. But the spec should at minimum ship a `--decrypt-all` flag on the migration CLI for symmetry, even if undocumented for general use. Without it, the rollback path is "write a SQL script invoking the decrypt logic" — and the decrypt logic lives in TypeScript, not in SQL. An operator following this advice will not succeed.

**Recommendation**: add `mcp-coordinator encryption migrate --direction=decrypt` (uses current key to decrypt all `enc:v1:` rows back to plaintext). Document it under "Rollback v0.10.5 → v0.10.4". Same code path as encrypt-direction, just reversed; ~30 LOC.

### 16. Documentation gaps vs `docs/onboarding-self-host.md` — MINOR

The onboarding doc has dedicated sections for: JWT secret entropy, restore-from-backup boot refusal (NR12), HTTPS expectation, Docker. The encryption spec needs counterpart documentation:
- A section under "3. Configure environment" introducing `COORDINATOR_ENCRYPTION_KEY` next to `COORDINATOR_JWT_SECRET`.
- A "Common gotchas" entry for "decrypt errors after restore" (linking to #3).
- A note in "Backup" section: "If `COORDINATOR_ENCRYPTION_KEY` is set, the backup tarball contains encrypted IdP tokens. Store the key separately from the backup — losing the key while keeping the backup loses all stored sessions, but coordinator data and audit log remain intact."
- The "Restore-from-backup boot refused" gotcha should call out the additional encryption-key requirement.

**Recommendation**: spec should include a checklist of doc updates that ship in the same PR (`docs/onboarding-self-host.md`, `docs/security/threat-model.md`, both `.env.example` files, a new `docs/ops/encryption-key-management.md` mirroring `docs/ops/key-rotation.md`).

### 17. `verify-encryption-key` ergonomics — NIT

Exit code 2 when "no encrypted rows present yet, cannot verify" is non-standard (operators expect 0 = success, 1 = failure, others rare). Exit 2 from a verify command will trip "fail on non-zero" CI scripts (`set -e`, GitHub Actions).

**Recommendation**: use exit 0 for "no rows to verify (this is expected on first boot)" with a clear stderr message, or add a `--require-rows` flag for ops who want strict mode.

---

## Summary of must-have changes before tagging v0.10.5

Tier-1 (blocking):
- Fix `start.ts` env forwarding (#1)
- Restore-side detection and refusal-to-boot guard against missing key (#3)
- `.env.example` updates (#11)
- Key fingerprint stored in DB + checked at boot (#9 / #10)
- Decide rotation story honestly: ship `--rotate` or mark "rotation not supported in v0.10.5" (#4)

Tier-2 (should land but could ship as v0.10.5.1):
- Audit log events for encryption lifecycle (#8)
- Decrypt-failure metric + `coordinator_encryption_enabled` gauge (#7)
- Encryption status in `/health/ready` payload (#6)
- Boot warning at ERROR in production (#2)
- Migration CLI safety check against running daemon (#5)
- Doc updates (#16)
- `--decrypt-all` for rollback (#15)
- CLI command grouping under `encryption` (#14)
