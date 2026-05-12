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
3. **Compliance baseline** (threat G partial) — SOC 2 CC6.1 "Implement encryption at rest" satisfied. GDPR Art. 32 "appropriate technical measures" satisfied.
4. **Zero schema migration** — all v0.7 tables work as-is. SQLCipher is transparent at the SQL layer.
5. **Manageable key lifecycle** — master key from env, file, or KMS. Documented rotation procedure.

## Non-goals

- **Column-level encryption** — v0.8. Same column visible to anyone who has the master key.
- **Per-org keys (DEK-per-tenant)** — v0.8 + KMS integration with BYOK.
- **In-memory protection** — once decrypted into a query result, data sits in process RAM. Beyond at-rest scope.
- **Hardware HSM integration** — use cloud KMS services that expose KMS over HTTPS instead.
- **Key escrow / recovery** — operator's responsibility (backup the passphrase securely).
- **Encryption of MQTT broker state** — MQTT is ephemeral; no at-rest data.

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
│   │   • db.pragma("cipher = 'aes256cbc'")                           │
│   │   • db.pragma("key = '<derived-from-master>'")                  │
│   │   • db.pragma("cipher_page_size = 4096")                        │
│   │   • db.pragma("kdf_iter = 256000")                              │
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
- **`better-sqlite3-multiple-ciphers`** — drop-in replacement, supports SQLCipher4, ChaCha20, AES-256-CBC. **Recommended.**
- `@journeyapps/sqlcipher` — Node-API binding for SQLCipher. Older, less maintained.
- Application-level encryption (write to plain SQLite but encrypt blob columns) — defers to v0.8; doesn't cover this phase's threats.

Cost: native rebuild. The existing Dockerfile builder stage (`apk add python3 make g++` from v0.5.0) already handles this.

### B. Master-key sources (pluggable)

```typescript
// src/security/master-key.ts
export interface MasterKeyProvider {
  /** Returns the 32-byte master key. Called once at startup. */
  load(): Promise<Buffer>;
}

export class EnvVarKeyProvider implements MasterKeyProvider {
  // Reads COORDINATOR_DB_PASSPHRASE, derives via PBKDF2-HMAC-SHA256
  // 100k iterations. Salt is fixed per-install (in coordinator.salt file).
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

Existing `mcp-coordinator server backup` produces `tar.gz`. New behavior in v0.7.5: pipe through `age` (Go-style, has Node bindings) with a recipient or passphrase.

```bash
# Existing
mcp-coordinator server backup --out backup.tar.gz

# New flags
mcp-coordinator server backup --out backup.tar.gz.age --passphrase-from-env COORDINATOR_BACKUP_PASSPHRASE
mcp-coordinator server backup --out backup.tar.gz.age --recipient age1xyz...

# Restore mirror
mcp-coordinator server restore --in backup.tar.gz.age --passphrase-from-env COORDINATOR_BACKUP_PASSPHRASE
```

The DB file inside the tarball is already encrypted by SQLCipher. The `age` layer adds passphrase-protection so even the encrypted DB is wrapped in a second layer for transit (offsite backup, email, etc.).

### D. CLI commands

```bash
# Initialize encryption on a fresh install (generates a passphrase if not provided)
mcp-coordinator-cli init-encryption [--passphrase <secret>] [--key-source env|file|kms]

# Migrate an existing PLAINTEXT v0.7 database to encrypted (one-shot)
mcp-coordinator-cli migrate-to-encrypted --passphrase <secret>
# Internally: ATTACH 'plain.db' AS plain; ATTACH 'enc.db' AS enc KEY '...'; sqlcipher_export('enc');

# Rotate the master key (generates new key, re-encrypts DB)
mcp-coordinator-cli rotate-encryption-key --new-passphrase <secret>

# Verify encryption is active (reads first page of DB, checks magic)
mcp-coordinator-cli verify-encryption
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

A new small file `coordinator.salt` (16 bytes, random per-install) lives next to `coordinator.db`. Used by `EnvVarKeyProvider` for PBKDF2 salt. Created on first init.

## Operational config

| Variable | Default | Effect |
|---|---|---|
| `COORDINATOR_DB_KEY_SOURCE` | `env` | `env` \| `file` \| `kms` |
| `COORDINATOR_DB_PASSPHRASE` | (unset) | When `env` source, the passphrase string. **Must be set** before first start. |
| `COORDINATOR_DB_KEY_FILE` | (unset) | When `file` or `kms` source, path to the key/wrapped-DEK file. |
| `COORDINATOR_KMS_ARN` | (unset) | AWS KMS key ARN for unwrapping DEK |
| `COORDINATOR_KMS_GCP_KEYNAME` | (unset) | GCP KMS keyName |
| `COORDINATOR_VAULT_TRANSIT_KEY` | (unset) | Vault transit key name |
| `COORDINATOR_VAULT_URL` | (unset) | Vault endpoint |
| `COORDINATOR_BACKUP_PASSPHRASE` | (unset) | When set, `server backup` produces `.age`-encrypted output |

## Migration & rollback

### Fresh v0.7.5 install

1. Operator runs `mcp-coordinator-cli init-encryption --passphrase <secret>` (or sets `COORDINATOR_DB_PASSPHRASE` and lets the daemon init on first start).
2. Daemon initializes encrypted DB. `coordinator.salt` file created.
3. All subsequent operations transparent.

### Existing v0.7 plaintext DB → v0.7.5 encrypted

1. Stop daemon.
2. Run `mcp-coordinator-cli migrate-to-encrypted --passphrase <secret>`. Tool reads plaintext DB, writes encrypted DB, swaps files.
3. Start daemon with passphrase configured.
4. Verify with `mcp-coordinator-cli verify-encryption`.

### Rotate the master key

1. `mcp-coordinator-cli rotate-encryption-key --new-passphrase <new>` while daemon is **stopped**.
2. Tool re-encrypts every page with the new key.
3. Update env config with new passphrase. Restart.

### Rollback v0.7.5 → v0.7 (decrypt back to plaintext)

Not supported in CLI directly (would defeat the purpose). Manual procedure: backup the encrypted DB, use SQLCipher CLI to `ATTACH plain.db; sqlcipher_export('plain')`, replace `coordinator.db`. **Operator's responsibility.**

## Testing

- `tests/unit/master-key-providers.test.ts` — verify env/file/KMS impls round-trip
- `tests/unit/encryption-migration.test.ts` — v0.7 plaintext DB → v0.7.5 encrypted (smoke test the migrate tool)
- `tests/unit/encryption-readback.test.ts` — write data with key A, attempt read with key B → assert SQLite error
- `tests/unit/backup-age-encryption.test.ts` — `server backup` produces `.age`, `server restore` round-trips
- `tests/unit/cli-init-encryption.test.ts` — fresh init via CLI command
- `tests/unit/perf-encryption-overhead.test.ts` — measure SQLCipher overhead vs plain (expect ~20-40%, document)

## Performance impact

SQLCipher adds 5-30% overhead on most workloads depending on cipher choice and PRAGMA settings. Specifically for mcp-coordinator's profile:

- Hot path is `getFileToAgentsIndex` + scorer queries (small, frequent)
- Tested baseline: 0.48ms p50 (v0.5 perf benchmark)
- Expected with AES-256-CBC + 256k KDF iter: 0.55-0.65ms p50 (~15-30% slower)

This still preserves the marketing `<5ms detection` claim with margin. If perf becomes the bottleneck, swap to ChaCha20 (faster on platforms without AES-NI).

The KDF iterations only happen ONCE at process start (key derivation). Per-query overhead is just the cipher itself.

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
- **5-30% perf overhead** on SQLite operations. Documented; can swap ciphers if a perf issue surfaces.
- **No defense against process-memory dump** by an attacker with root. Out of scope.
- **`coordinator.salt` next to `coordinator.db`** — both in same dir, same backup. The salt is not secret (it's by design public-but-unique). The compromise is if someone steals BOTH `coordinator.db` AND `coordinator.salt`, they have one PBKDF2 derivation to attempt. The cost of 256k iter slows brute force; a strong passphrase makes it infeasible. Document strong-passphrase requirement.

## References

- SQLCipher: https://www.zetetic.net/sqlcipher/
- better-sqlite3-multiple-ciphers: https://github.com/m4heshd/better-sqlite3-multiple-ciphers
- age (modern encrypted file format): https://age-encryption.org/
- SOC 2 CC6.1: Implement encryption to protect data at rest
- GDPR Art. 32(1)(a): pseudonymisation and encryption of personal data
- `src/database.ts:10-180` — inline `SCHEMA` const + try/catch ALTER pattern (preserved in v0.7.5)
- `cli/server/backup.ts` / `cli/server/restore.ts` — v0.4 backup commands, extended with age layer
