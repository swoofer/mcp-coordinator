import { Command } from "commander";
import { createMigrateCommand } from "./migrate.js";
import { createVerifyCommand } from "./verify.js";
import { createFingerprintCommand } from "./fingerprint.js";

/**
 * Subcommand group for at-rest encryption tooling.
 *
 * - `encryption migrate` encrypts/decrypts IdP tokens in the users table.
 * - `encryption verify` samples encrypted rows and confirms the current key
 *   can decrypt them (fast-fail on stored fingerprint mismatch).
 * - `encryption fingerprint` prints the 16-hex-char fingerprint of the
 *   current `COORDINATOR_ENCRYPTION_KEY`.
 */
export function createEncryptionCommand(): Command {
  const cmd = new Command("encryption").description("Manage at-rest encryption of IdP tokens");
  cmd.addCommand(createMigrateCommand());
  cmd.addCommand(createVerifyCommand());
  cmd.addCommand(createFingerprintCommand());
  return cmd;
}
