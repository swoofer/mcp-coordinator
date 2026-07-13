import { Command } from "commander";
import * as path from "node:path";
import Database from "better-sqlite3";
import { decodeMasterKey, computeKeyFingerprint } from "../../src/security/master-key.js";
import { EnvelopeEncryption } from "../../src/security/envelope-encryption.js";
import { decryptNullable } from "../../src/security/encrypt-nullable.js";
import {
  MalformedCiphertext,
  DEKUnwrapFailed,
  DataDecryptFailed,
  UnknownCipherVersion,
} from "../../src/security/encryption.js";
import { ensureConfigDir, loadConfig } from "../config.js";

const DEFAULT_SAMPLES = 10;

export interface VerifyOpts {
  samples?: number;
  /** Test injection seam. */
  configDir?: string;
  /** Test injection seam. */
  dataDir?: string;
  /** Test injection seam. */
  encryptionKey?: string;
}

export interface VerifyResult {
  exitCode: 0 | 2;
  storedFingerprint: string | null;
  currentFingerprint: string;
  decryptable: number;
  undecryptable_dek: number;
  undecryptable_data: number;
  malformed: number;
  unknown_version: number;
  plaintext: number;
  nullCount: number;
  message: string;
}

/**
 * Core, exit-free verify logic used by both the CLI action and unit tests.
 *
 * Exit semantics:
 *   0 — current key matches stored fingerprint (or fresh DB with no
 *       encrypted rows), and all sampled rows decrypt successfully.
 *   2 — fingerprint mismatch, sampled decryption failure, or fatal config
 *       error (missing/malformed key).
 *
 * Note: "no encrypted rows yet" is exit 0, per Open Q #5 — fresh installs
 * with `COORDINATOR_ENCRYPTION_KEY` set but no migration run should pass.
 */
export function runVerify(opts: VerifyOpts = {}): VerifyResult {
  const samples = Math.max(1, opts.samples ?? DEFAULT_SAMPLES);
  const configDir = opts.configDir ?? ensureConfigDir();
  const rawKey = opts.encryptionKey ?? process.env.COORDINATOR_ENCRYPTION_KEY;
  if (!rawKey) {
    return {
      exitCode: 2,
      storedFingerprint: null,
      currentFingerprint: "",
      decryptable: 0,
      undecryptable_dek: 0,
      undecryptable_data: 0,
      malformed: 0,
      unknown_version: 0,
      plaintext: 0,
      nullCount: 0,
      message: "COORDINATOR_ENCRYPTION_KEY not set",
    };
  }
  const key = decodeMasterKey(rawKey);
  const currentFingerprint = computeKeyFingerprint(key);
  const provider = new EnvelopeEncryption(key);

  const dataDir = opts.dataDir ?? loadConfig(configDir).server.data_dir;
  const db = new Database(path.join(dataDir, "coordinator.db"));
  try {
    const stored = db
      .prepare("SELECT value FROM system_config WHERE key = 'encryption.key_fingerprint'")
      .get() as { value: string } | undefined;
    const storedFingerprint = stored?.value ?? null;

    if (storedFingerprint && storedFingerprint !== currentFingerprint) {
      return {
        exitCode: 2,
        storedFingerprint,
        currentFingerprint,
        decryptable: 0,
        undecryptable_dek: 0,
        undecryptable_data: 0,
        malformed: 0,
        unknown_version: 0,
        plaintext: 0,
        nullCount: 0,
        message: `Fingerprint mismatch: stored=${storedFingerprint} current=${currentFingerprint}`,
      };
    }

    const rows = db
      .prepare(
        "SELECT id, primary_org_id, idp_access_token, idp_refresh_token FROM users " +
          "WHERE idp_access_token GLOB 'enc:v[0-9]*:*' OR idp_refresh_token GLOB 'enc:v[0-9]*:*' " +
          "ORDER BY RANDOM() LIMIT ?",
      )
      .all(samples) as Array<{
      id: string;
      primary_org_id: string;
      idp_access_token: string | null;
      idp_refresh_token: string | null;
    }>;

    if (rows.length === 0) {
      return {
        exitCode: 0,
        storedFingerprint,
        currentFingerprint,
        decryptable: 0,
        undecryptable_dek: 0,
        undecryptable_data: 0,
        malformed: 0,
        unknown_version: 0,
        plaintext: 0,
        nullCount: 0,
        message: "No encrypted rows present yet (this is OK for fresh installs)",
      };
    }

    let decryptable = 0;
    let dek = 0;
    let data = 0;
    let mal = 0;
    let unk = 0;
    let plain = 0;
    let nullC = 0;
    for (const row of rows) {
      for (const col of ["idp_access_token", "idp_refresh_token"] as const) {
        const value = row[col];
        if (value === null) {
          nullC++;
          continue;
        }
        if (!value.startsWith("enc:v")) {
          plain++;
          continue;
        }
        try {
          decryptNullable(provider, value, {
            org_id: row.primary_org_id,
            column: col,
            user_id: row.id,
          });
          decryptable++;
        } catch (err) {
          if (err instanceof MalformedCiphertext) mal++;
          else if (err instanceof DEKUnwrapFailed) dek++;
          else if (err instanceof DataDecryptFailed) data++;
          else if (err instanceof UnknownCipherVersion) unk++;
          else throw err;
        }
      }
    }
    const failures = dek + data + mal + unk;
    const exitCode: 0 | 2 = failures > 0 ? 2 : 0;
    return {
      exitCode,
      storedFingerprint,
      currentFingerprint,
      decryptable,
      undecryptable_dek: dek,
      undecryptable_data: data,
      malformed: mal,
      unknown_version: unk,
      plaintext: plain,
      nullCount: nullC,
      message:
        failures > 0
          ? `Verification FAILED: ${failures} of ${decryptable + failures} sampled rows did not decrypt`
          : `Verification OK: ${decryptable} rows decrypted, ${plain} plaintext (lazy-migration pending), ${nullC} null`,
    };
  } finally {
    db.close();
  }
}

export function formatVerifyResult(r: VerifyResult): string {
  const lines = [r.message];
  if (r.currentFingerprint) lines.push(`current fingerprint:  ${r.currentFingerprint}`);
  if (r.storedFingerprint) lines.push(`stored fingerprint:   ${r.storedFingerprint}`);
  if (
    r.decryptable +
      r.undecryptable_dek +
      r.undecryptable_data +
      r.malformed +
      r.unknown_version +
      r.plaintext +
      r.nullCount >
    0
  ) {
    lines.push(
      `counts: decryptable=${r.decryptable} dek_fail=${r.undecryptable_dek} data_fail=${r.undecryptable_data} malformed=${r.malformed} unknown_version=${r.unknown_version} plaintext=${r.plaintext} null=${r.nullCount}`,
    );
  }
  return lines.join("\n");
}

export function createVerifyCommand(): Command {
  return new Command("verify")
    .description("Verify the current encryption key can decrypt sampled rows")
    .option("--samples <n>", "number of random rows to sample", String(DEFAULT_SAMPLES))
    .action((opts: { samples: string }) => {
      const samples = Math.max(1, parseInt(String(opts.samples), 10));
      let result: VerifyResult;
      try {
        result = runVerify({ samples });
      } catch (err) {
        process.stderr.write(`verify error: ${(err as Error).message}\n`);
        process.exit(2);
        return;
      }
      const stream = result.exitCode === 0 ? process.stdout : process.stderr;
      stream.write(formatVerifyResult(result) + "\n");
      process.exit(result.exitCode);
    });
}
