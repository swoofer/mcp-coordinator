# Encryption at rest (v0.7.5 design)

**Status**: design (approved for implementation 2026-05-11, ships after v0.7 auth)
**Owner**: swoofer
**Target**: mcp-coordinator v0.7.5
**Companion**: builds on `2026-05-11-auth-saas-ready-design.md` (v0.7)

## Summary

Wrap the SQLite database with **SQLCipher** to encrypt the entire `coordinator.db` file at rest with AES-256, keyed by a master passphrase loaded from env, a file path, or a KMS-wrapped DEK. Encrypt tarball backups too. Replace the v0.7 Phase 1 `PassthroughEncryption` stub with a real implementation that also exposes the `encrypt`/`decrypt`/`hmac` interface for v0.8's column-level work.

Effort: ~1 week. Single phase, single release.

## Goals

1. **Backup theft scenario** (threat A) — if `coordinator.db` or its tarball backup leaks (laptop loss, cloud bucket misconfig, employee copy), the contents are unreadable without the key.
2. **Insider direct-read** (threat B partial) — a sysadmin with file system access cannot `sqlite3 coordinator.db .dump` and read messages without also having the master key.
3. **Compliance baseline** (threat G partial) — SOC 2 CC6.1 baseline coverage (encryption only — key management policy, access controls, audit logs of key access, and certification by an audit firm remain operational responsibilities outside this spec). GDPR Art. 32 "appropriate technical measures" addressed by encryption at rest, though Art. 32 compliance in full additionally requires organizational controls.
4. **Zero schema migration** — all v0.7 tables work as-is. SQLCipher is transparent at the SQL layer.
5. **Manageable key lifecycle** — master key from env, file, or KMS. Documented rotation procedure.

## Non-goals

- **Column-level encryption** — v0.8. Same column visible to anyone who has the master key.
- **Per-org keys (DEK-per-tenant)** — v0.8 + KMS integration with BYOK.
- **In-memory protection** — once decrypted into a query result, data sits in process RAM. Beyond at-rest scope.
- **Hardware HSM integration** — use cloud KMS services that expose KMS over HTTPS instead.
- **Key escrow / recovery** — operator's responsibility (backup the passphrase securely).
- **Encryption of MQTT broker state** — MQTT is ephemeral; no at-rest data.
- **Bun runtime support** — the `createBunSqlite` path is disabled when encryption is enabled. Bun does not support `better-sqlite3-multiple-ciphers`. Bun support deferred to v0.8 (where column-level encryption may use a different approach).
- **Online key rotation** — v0.7.5 requires daemon stop for key rotation. Online rotation (rolling, per-org DEK) is deferred to v0.8.
- **Salt rotation** — salt rotation requires re-deriving the key. This is done implicitly via `rotate-encryption-key` (new passphrase) or fresh install. It is not exposed as a separate CLI operation.

## Background

After v0.7 auth ships:

- `coordinator.db` is plaintext SQLite. Contains `thread_messages.content`, `threads.plan`, `action_summaries.summary`, `audit_log.metadata`, `file_activity.symbols_touched`, file paths, agent IDs, etc.
- File mode is now 0600 (set in v0.7 Phase 1) but contents are still readable by anyone with FS access at the user level.
- Backups via `mcp-coordinator server backup` produce `tar.gz` of the data directory — plaintext same as DB.

For Team-PME deployments under a compliance regime (SOC 2 / GDPR / enterprise client demand), this is insufficient. SOC 2 CC6.1 explicitly requires "encryption at rest". GDPR Art. 32(1)(a) recommends it as an appropriate technical measure for personal data.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Process startup                                                    │
│   ├─ Load master key (env / file / KMS)                             │
│   ├─ Open DB via better-sqlite3-multiple-ciphers (drop-in)          │
│   │   • db.pragma("cipher = 'aes256gcm'")          // default       │
│   │   • db.pragma("key = '<derived-from-master>'")                  │
│   │   • db.pragma("cipher_page_size = 4096")                        │
│   │   • db.pragma("kdf_iter = 600000")              // OWASP 2026   │
│   │   • db.pragma("cache_size = -64000")            // 64 MB        │
│   └─ All subsequent SQL transparent — application code unchanged    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  Backup (server backup → tar.gz)                                    │
│   ├─ DB file is already encrypted (drop-in to tar)                  │
│   ├─ Other plaintext files (logs, PID, etc.) → age-encrypted layer  │
│   │   via `age` library, passphrase-protected                       │
│   └─ Output: coordinator-backup-YYYY-MM-DD.tar.gz.age               │
└────────────────────────────────────────────────────────────────────┘
```

## Components

### A. Drop-in SQLite replacement

Replace `better-sqlite3` with `better-sqlite3-multiple-ciphers` (or alternative SQLCipher binding). API is identical — the swap is in `package.json` + maybe one line in `src/database.ts`.

Alternative candidates evaluated:
- **`better-sqlite3-multiple-ciphers`** — drop-in replacement, supports SQLCipher4, ChaCha20, AES-256-GCM. **Recommended.**
- `@journeyapps/sqlcipher` — Node-API binding for SQLCipher. Older, less maintained.
- Application-level encryption (write to plain SQLite but encrypt blob columns) — defers to v0.8; doesn't cover this phase's threats.

Cost: native rebuild. The existing Dockerfile builder stage (`apk add python3 make g++` from v0.5.0) already handles this.

**KMS SDK dependencies**: `aws-sdk`, `@google-cloud/kms`, and `node-vault` move to `optionalDependencies` in `package.json`. They are only installed when the respective `COORDINATOR_DB_KEY_SOURCE=kms` is selected. This keeps the default install lightweight for operators using `env` or `file` key sources.

**age package**: the `age-encryption` npm package (community-maintained Node.js bindings for the age format). Pin the version in `optionalDependencies` (used only when `COORDINATOR_BACKUP_PASSPHRASE` is set).

### B. Master-key sources (pluggable)

```typescript
// src/security/master-key.ts
export interface MasterKeyProvider {
  /** Returns the 32-byte master key. Called once at startup. */
  load(): Promise<Buffer>;
}

export class EnvVarKeyProvider implements MasterKeyProvider {
  // Reads COORDINATOR_DB_PASSPHRASE, derives via PBKDF2-HMAC-SHA256
  // 600k iterations (OWASP 2026). Salt is fixed per-install (in coordinator.salt file).
  // Startup blocks ~500-1500ms for derivation — this is expected and documented.
}

export class FileKeyProvider implements MasterKeyProvider {
  // Reads raw 32 bytes from COORDINATOR_DB_KEY_FILE (mode 0600 required).
}

export class KMSKeyProvider implements MasterKeyProvider {
  // Reads encrypted DEK from COORDINATOR_DB_KEY_FILE, decrypts via:
  //   - AWS KMS: COORDINATOR_KMS_ARN
  //   - GCP KMS: COORDINATOR_KMS_GCP_KEYNAME
  //   - HashiCorp Vault: COORDINATOR_VAULT_TRANSIT_KEY + COORDINATOR_VAULT_URL
}
```

Selection: env var `COORDINATOR_DB_KEY_SOURCE` ∈ `env | file | kms` (default `env`).

### C. Backup encryption

Existing `mcp-coordinator server backup` produces `tar.gz`. New behavior in v0.7.5:

1. Run `PRAGMA wal_checkpoint(TRUNCATE)` before creating the tarball to flush the WAL.
2. Include `coordinator.db`, `coordinator.db-wal`, and `coordinator.db-shm` in the tarball (all three files are needed for a consistent restore).
3. Include a `coordinator.db.sha256` file alongside the DB in the tarball; `server restore` verifies the SHA-256 before extracting.
4. Optionally pipe through `age` (npm package: `age-encryption`) with a recipient or passphrase for a second encryption layer.

```bash
# Existing behavior (still works, DB is already SQLCipher-encrypted)
mcp-coordinator server backup --out backup.tar.gz

# New: age-encrypted outer layer
mcp-coordinator server backup --out backup.tar.gz.age --passphrase-from-env COORDINATOR_BACKUP_PASSPHRASE
mcp-coordinator server backup --out backup.tar.gz.age --recipient age1xyz...

# Restore mirror
mcp-coordinator server restore --in backup.tar.gz.age --passphrase-from-env COORDINATOR_BACKUP_PASSPHRASE
```

The DB file inside the tarball is already encrypted by SQLCipher. The `age` layer adds passphrase-protection so even the encrypted DB is wrapped in a second layer for transit (offsite backup, email, etc.).

**Backup retention**: operator's responsibility. Recommended: 7 daily + 4 weekly + 12 monthly backups, managed via OS-level cron invoking `mcp-coordinator server backup`. The coordinator does not implement retention policies itself.

### D. CLI commands

The `--passphrase <secret>` flag is **not supported** on any command (shell history leak). Use one of:
- `--passphrase-stdin` — read passphrase from stdin; supports piping (`echo 'secret' | mcp-coordinator init-encryption --passphrase-stdin`)
- `--passphrase-file <path>` — read passphrase from file (mode 0600 recommended)
- `COORDINATOR_DB_PASSPHRASE` env var (note: visible in `/proc/PID/environ`; prefer file or KMS in production)

On a TTY (`init-encryption`, `migrate-to-encrypted`), passphrase is prompted twice and rejects mismatches. On piped stdin (scripting mode), passphrase is accepted once.

```bash
# Initialize encryption on a fresh install
mcp-coordinator init-encryption [--passphrase-stdin] [--passphrase-file <path>] [--key-source env|file|kms]

# Migrate an existing PLAINTEXT v0.7 database to encrypted (one-shot)
mcp-coordinator migrate-to-encrypted [--passphrase-stdin] [--passphrase-file <path>]
# Internally: ATTACH 'plain.db' AS plain; ATTACH 'enc.db' AS enc KEY '...'; sqlcipher_export('enc');

# Rotate the master key (generates new key, re-encrypts DB)
mcp-coordinator rotate-encryption-key [--passphrase-stdin] [--passphrase-file <path>]

# Verify encryption is active (reads first page of DB, checks magic)
mcp-coordinator verify-encryption

# Open an encrypted DB and dump tables to stdout (debugging when daemon fails to start)
mcp-coordinator inspect-encrypted [--passphrase-stdin] [--passphrase-file <path>]
# Attempts to dump each table individually, skipping corrupt pages.
# Used when mcp-coordinator fails to start due to suspected key or corruption issue.
```

### E. Replace the v0.7 `PassthroughEncryption` stub

v0.7 Phase 1 shipped:

```typescript
export class PassthroughEncryption implements EncryptionProvider {
  encrypt(p: string) { return p; }
  decrypt(c: string) { return c; }
  hmac(v: string) { return v; }
}
```

v0.7.5 wires the SQLCipher-backed implementation as the default when the DB is encrypted, but its `encrypt`/`decrypt`/`hmac` methods are still no-ops (because SQLCipher already handles encryption at the DB level — column ops are passthrough). The interface stays in place for v0.8's per-column work.

## Schema

No new tables. SQLCipher operates transparently. The audit_log table created in v0.7 Phase 1 starts populating with `data.access.*` events when v0.8 lands.

A new small file `coordinator.salt` (16 bytes, random per-install, mode 0600) lives next to `coordinator.db`. Used by `EnvVarKeyProvider` for PBKDF2 salt.

**Salt lifecycle**:
- **First start with empty/no DB**: generate 16 random bytes, write to `coordinator.salt` with mode 0600.
- **Subsequent starts with existing DB**: if `coordinator.salt` is missing, refuse to start with: `"salt file missing, cannot derive decryption key — restore salt from backup or recovery documentation"`. Do NOT generate a new salt (would produce a different key and fail to open the DB).
- The salt is not secret by design; it is unique per install. Backup it alongside the DB.

## Operational config

| Variable | Default | Effect |
|---|---|---|
| `COORDINATOR_DB_KEY_SOURCE` | `env` | `env` \| `file` \| `kms` |
| `COORDINATOR_DB_PASSPHRASE` | (unset) | When `env` source, the passphrase string. **Must be set** before first start. **Security note**: env vars are visible in `/proc/PID/environ` to all users with read access. Prefer `file` or `kms` source in production. |
| `COORDINATOR_DB_KEY_FILE` | (unset) | When `file` or `kms` source, path to the key/wrapped-DEK file. |
| `COORDINATOR_DB_CIPHER` | `aes256gcm` | Cipher selection: `aes256gcm` (default, AES-NI accelerated on x86_64) or `chacha20` (fallback for ARM without AES-NI or older hardware). |
| `COORDINATOR_DB_CACHE_SIZE_KB` | `64000` | SQLite cache size in KB (`PRAGMA cache_size`). Tune for available RAM. |
| `COORDINATOR_KMS_ARN` | (unset) | AWS KMS key ARN for unwrapping DEK |
| `COORDINATOR_KMS_GCP_KEYNAME` | (unset) | GCP KMS keyName |
| `COORDINATOR_VAULT_TRANSIT_KEY` | (unset) | Vault transit key name |
| `COORDINATOR_VAULT_URL` | (unset) | Vault endpoint |
| `COORDINATOR_KMS_FALLBACK_KEY_FILE` | (unset) | When set and `--allow-kms-fallback` CLI flag is present, loads a locally-wrapped DEK from this file if KMS is unreachable at startup. **Risk**: reduces security to file-level protection if KMS is permanently unreachable. Use only for non-production resilience. |
| `COORDINATOR_BACKUP_PASSPHRASE` | (unset) | When set, `server backup` produces `.age`-encrypted output |

## Migration & rollback

### Fresh v0.7.5 install

1. Operator runs `mcp-coordinator init-encryption --passphrase-stdin` (or sets `COORDINATOR_DB_PASSPHRASE` and lets the daemon init on first start).
2. Daemon initializes encrypted DB.
3. `coordinator.salt` (16 random bytes, mode 0600) is created on first start if absent. On subsequent starts, if `coordinator.salt` is missing alongside a non-empty DB, the daemon refuses to start with: `"salt file missing, cannot derive key — restore from backup or provide salt"`.
4. All subsequent operations transparent.

### Existing v0.7 plaintext DB → v0.7.5 encrypted

Migration is **mandatory** before enabling encryption on an existing deployment. The procedure is atomic within the same filesystem:

1. **Mandatory backup**: `mcp-coordinator migrate-to-encrypted` requires `--with-backup` flag. Fails without it. The backup is created first, before any modification.
2. Stop daemon.
3. Run migration tool: reads `coordinator.db` (plaintext), writes `coordinator.db.new` (encrypted) in the same directory using `sqlcipher_export`. Progress is reported every 10 MB.
4. **Atomic rename**: `coordinator.db.new` → `coordinator.db`. The rename must be within the same filesystem (cross-filesystem rename is rejected with a clear error message).
5. Start daemon with passphrase configured.
6. Verify with `mcp-coordinator verify-encryption`.

**Crash recovery**: if the daemon starts and `coordinator.db.new` exists alongside `coordinator.db`, it logs an error and refuses to start: `"Incomplete migration detected: coordinator.db.new exists. Inspect state and remove manually."` The daemon does NOT auto-recover (this is intentional — safer to require operator decision).

### Rotate the master key

1. Take a mandatory backup first.
2. Stop daemon. (Key rotation requires daemon to be stopped in v0.7.5; online rotation is a v0.8 feature.)
3. Disable WAL mode: `PRAGMA journal_mode = DELETE` (WAL must be disabled before rekey to avoid WAL file inconsistency).
4. Run `mcp-coordinator rotate-encryption-key --passphrase-stdin` (applies `PRAGMA rekey` with the new passphrase).
5. Re-enable WAL: `PRAGMA journal_mode = WAL`.
6. Run `mcp-coordinator verify-encryption` — mandatory before exiting the rotation procedure.
7. An audit log entry `auth.jwt_secret.rotated` (or a new `db.encryption_key.rotated` event) is written to the audit log.
8. Update env config with new passphrase. Restart.

### Rollback v0.7.5 → v0.7 (decrypt back to plaintext)

Not supported in CLI directly (would defeat the purpose). Manual procedure: backup the encrypted DB, use SQLCipher CLI to `ATTACH plain.db; sqlcipher_export('plain')`, replace `coordinator.db`. **Operator's responsibility.**

## Testing

- `tests/unit/master-key-providers.test.ts` — verify env/file/KMS impls round-trip
- `tests/unit/encryption-migration.test.ts` — v0.7 plaintext DB → v0.7.5 encrypted (smoke test the migrate tool, including `--with-backup` flag requirement and crash recovery scenario where `coordinator.db.new` exists)
- `tests/unit/encryption-readback.test.ts` — write data with key A, attempt read with key B → assert SQLite error
- `tests/unit/backup-age-encryption.test.ts` — `server backup` produces `.age`, `server restore` round-trips; WAL checkpoint included; `.sha256` integrity verified on restore
- `tests/unit/cli-init-encryption.test.ts` — fresh init via CLI command; passphrase confirmation (mismatch → rejected); piped stdin accepted once
- `tests/unit/perf-encryption-overhead.test.ts` — measure SQLCipher overhead vs plain on ~50 agents, ~200 file activities, ~100 threads; assert overhead <50% (documents realistic numbers)
- `tests/unit/salt-lifecycle.test.ts` — salt created on first start; missing salt on non-empty DB → daemon refuses to start with correct error message
- `tests/unit/inspect-encrypted.test.ts` — `inspect-encrypted` command opens DB and dumps tables; cross-verify output against expected row counts

## Performance impact

SQLCipher adds overhead on most workloads depending on cipher choice and PRAGMA settings. Specifically for mcp-coordinator's profile:

- Hot path is `getFileToAgentsIndex` + scorer queries (small, frequent)
- Tested baseline: 0.48ms p50 (v0.5 perf benchmark)
- Estimated with AES-256-GCM + 600k KDF iter: 0.55-0.70ms p50 (~15-30% slower, based on SQLCipher community benchmarks). Actual numbers validated by `tests/unit/perf-encryption-overhead.test.ts` which asserts <50% overhead on a realistic fixture (~50 agents, ~200 file activities, ~100 threads). The 15-30% figure is an estimate, not a guarantee.

This still preserves the marketing `<5ms detection` claim with margin.

**AES-NI hardware acceleration**: assumed available on x86_64 servers. On ARM without AES-NI or older hardware, use `COORDINATOR_DB_CIPHER=chacha20` for better performance (runtime selection, no rekey required on a fresh DB).

**GCM vs CBC**: default cipher is `aes256gcm` (SQLCipher 4). GCM provides an authentication tag per page, detecting both corruption and tampering at the page level. If the runtime environment lacks AES-NI support, ChaCha20 is the fallback.

**KDF startup latency**: key derivation (600k PBKDF2-HMAC-SHA256 iterations) blocks the daemon for approximately 500–1500ms at startup. This is a one-time cost. Configure Kubernetes liveness probes accordingly: `livenessProbe.initialDelaySeconds: 5` minimum, `failureThreshold: 3`.

**KDF iterations only happen once** at process start. Per-query overhead is just the cipher itself (page-level AES-256-GCM or ChaCha20).

**Cache size**: `PRAGMA cache_size = -64000` (64 MB) set by default for production workloads. Configurable via `COORDINATOR_DB_CACHE_SIZE_KB`. Larger cache reduces disk I/O and amortizes cipher overhead.

## Corruption recovery

With AES-256-GCM (the default cipher), SQLCipher authenticates each page independently via GCM auth tags. A corrupt or tampered page is detected at the page level — reads from non-affected pages continue to work.

**Recovery procedure** when a page fails GCM authentication:
1. SQLite's `.recover` command does **not** work on encrypted databases. Do not attempt it.
2. Use `mcp-coordinator inspect-encrypted` — opens the DB with the key and attempts to dump each table individually, skipping pages that fail GCM authentication. Output goes to stdout.
3. If `inspect-encrypted` recovers enough data, export to a new plaintext DB and re-encrypt via `migrate-to-encrypted`.
4. If corruption is extensive, restore from the most recent backup (`.sha256` integrity file verifies the backup before extract).

Document this procedure in the runbook alongside the verify-encryption command.

## What was cut and why (for v0.7.5 specifically)

| Cut | Reason |
|---|---|
| Per-org DEK | v0.8. Requires KMS integration architecture per tenant. |
| Column-level encryption | v0.8. Adds `encrypt(...)`/`decrypt(...)` per-column complexity, HMAC indexing, schema migration. Whole-DB encryption gets us 80% of the value in 20% of the work. |
| Bring-your-own-key | v0.8 enterprise tier. |
| Automatic key rotation | v0.8. Manual procedure for now. |
| Memory protection (`mlock`, secure-erase) | Beyond at-rest scope. |
| Encrypted secondary indexes for HMAC search | v0.8. |
| Compliance certification deliverables (SOC 2 audit, GDPR DPA template) | Operational, not code. |

## Risks accepted

- **Passphrase loss = data loss.** No key recovery. Operator must back up the passphrase securely.
- **15-30% estimated perf overhead** on SQLite operations (AES-256-GCM with AES-NI). Documented; can swap to ChaCha20 if a perf issue surfaces on non-AES-NI hardware.
- **No defense against process-memory dump** by an attacker with root. Out of scope.
- **`coordinator.salt` next to `coordinator.db`** — both in same dir, same backup. The salt is not secret (it's by design public-but-unique). The compromise is if someone steals BOTH `coordinator.db` AND `coordinator.salt`, they have one PBKDF2 derivation to attempt. The cost of 600k iter (OWASP 2026) slows brute force significantly (~1.2s per attempt); a strong passphrase (20+ random chars) makes it infeasible. Document strong-passphrase requirement. Startup latency of ~500-1500ms is the trade-off.

## References

- SQLCipher: https://www.zetetic.net/sqlcipher/
- better-sqlite3-multiple-ciphers: https://github.com/m4heshd/better-sqlite3-multiple-ciphers
- age (modern encrypted file format): https://age-encryption.org/
- SOC 2 CC6.1: Implement encryption to protect data at rest
- GDPR Art. 32(1)(a): pseudonymisation and encryption of personal data
- `src/database.ts:10-180` — inline `SCHEMA` const + try/catch ALTER pattern (preserved in v0.7.5)
- `cli/server/backup.ts` / `cli/server/restore.ts` — v0.4 backup commands, extended with age layer
