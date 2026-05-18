import { Command } from "commander";
import {
  decodeMasterKey,
  computeKeyFingerprint,
} from "../../src/security/master-key.js";

export interface FingerprintOpts {
  /** Test injection seam. */
  encryptionKey?: string;
}

export interface FingerprintResult {
  exitCode: 0 | 2;
  fingerprint: string;
  message: string;
}

/**
 * Core, exit-free fingerprint logic. Pure: no DB access, no FS access.
 *
 * Exit semantics:
 *   0 — key decoded successfully; `message` is the 16-hex-char fingerprint.
 *   2 — missing or malformed `COORDINATOR_ENCRYPTION_KEY`.
 */
export function runFingerprint(
  opts: FingerprintOpts = {},
): FingerprintResult {
  const rawKey = opts.encryptionKey ?? process.env.COORDINATOR_ENCRYPTION_KEY;
  if (!rawKey) {
    return {
      exitCode: 2,
      fingerprint: "",
      message: "COORDINATOR_ENCRYPTION_KEY not set",
    };
  }
  try {
    const key = decodeMasterKey(rawKey);
    const fingerprint = computeKeyFingerprint(key);
    return { exitCode: 0, fingerprint, message: fingerprint };
  } catch (err) {
    return {
      exitCode: 2,
      fingerprint: "",
      message: `Failed to decode master key: ${(err as Error).message}`,
    };
  }
}

export function createFingerprintCommand(): Command {
  return new Command("fingerprint")
    .description(
      "Print the 16-hex-char fingerprint of COORDINATOR_ENCRYPTION_KEY",
    )
    .action(() => {
      const result = runFingerprint();
      const stream = result.exitCode === 0 ? process.stdout : process.stderr;
      stream.write(result.message + "\n");
      process.exit(result.exitCode);
    });
}
