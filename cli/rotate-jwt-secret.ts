// T52 -- CLI verb `mcp-coordinator rotate-jwt-secret`.
//
// Generates a fresh JWT signing secret, validates its entropy against
// the same floor as boot (assertSecretEntropy 128-bit minimum), and
// prints the operator workflow for rotating it into a live
// deployment.
//
// Out of scope:
//   - Writing to the operator's secrets manager (Vault / AWS SM /
//     Kubernetes Secret). The CLI prints the values and leaves
//     placement to the operator's existing tooling.
//   - Triggering a coordinator restart. Same reason.
//   - Service-token rotation. Service tokens have their own
//     issuance lifecycle (`service-token issue`) and are 90d-capped;
//     periodic re-issuance is operator-driven.
//
// The recommended automation around this command is documented in
// docs/ops/auto-rotation.md.

import { Command } from "commander";
import crypto from "node:crypto";
import { assertSecretEntropy } from "../src/auth/entropy.js";

interface RotateOpts {
  bits: string;
  format: "env" | "json" | "secret-only";
  iso: boolean;
}

export interface RotationPlan {
  /** Base64-encoded 32 bytes of crypto-random output. */
  new_secret: string;
  /** Number of randomness bits estimated by `assertSecretEntropy`. */
  estimated_entropy_bits: number;
  /** ISO 8601 timestamp the operator should pass as
   *  COORDINATOR_JWT_SECRET_PREV_ROTATED_AT to anchor the
   *  config.key_rotation audit row. */
  rotated_at_iso: string;
  /** Step-by-step text for the operator to follow. */
  steps: string[];
}

/**
 * Pure function: build a fresh rotation plan. Exposed so tests can
 * assert deterministically without spawning the CLI process.
 */
export function buildRotationPlan(
  byteLength: number,
  now: Date = new Date(),
  randomSource: (n: number) => Buffer = (n) => crypto.randomBytes(n),
): RotationPlan {
  if (byteLength < 16) {
    throw new Error(`rotate-jwt-secret: --bits ${byteLength * 8} below the 128-bit floor`);
  }
  const buf = randomSource(byteLength);
  const newSecret = buf.toString("base64");
  // Validate entropy of the generated secret as a defence-in-depth
  // check against a broken randomSource (e.g. in tests).
  // assertSecretEntropy works over the raw bytes, not the base64 form.
  assertSecretEntropy(buf, 128);

  // Recompute the entropy estimate so we can surface it in the plan.
  // This is the same calculation as assertSecretEntropy's internal,
  // duplicated here only to keep the plan output informative.
  const counts = new Map<number, number>();
  for (const b of buf) counts.set(b, (counts.get(b) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  const estimatedBits = Math.round(h * buf.length);

  const isoTimestamp = now.toISOString();

  return {
    new_secret: newSecret,
    estimated_entropy_bits: estimatedBits,
    rotated_at_iso: isoTimestamp,
    steps: [
      "1. Copy the CURRENT value of COORDINATOR_JWT_SECRET from your secrets manager.",
      "2. Set COORDINATOR_JWT_SECRET_PREV to that current value (so existing sessions stay valid during overlap).",
      `3. Set COORDINATOR_JWT_SECRET to the new value above.`,
      `4. Set COORDINATOR_JWT_SECRET_PREV_ROTATED_AT="${isoTimestamp}" so the config.key_rotation audit row captures the moment.`,
      "5. Restart every coordinator instance.",
      "6. Wait at least one refresh-token TTL (default 30d, see COORDINATOR_JWT_REFRESH_TTL) so every legitimate session has rotated onto the new kid.",
      "7. Unset COORDINATOR_JWT_SECRET_PREV and COORDINATOR_JWT_SECRET_PREV_ROTATED_AT.",
      "8. Run `mcp-coordinator doctor --phase2` to confirm the rotation observed cleanly.",
    ],
  };
}

function formatPlanEnv(plan: RotationPlan): string {
  return [
    `# Rotation plan -- ${plan.rotated_at_iso}`,
    `# Entropy: ~${plan.estimated_entropy_bits} bits (floor 128).`,
    `COORDINATOR_JWT_SECRET="${plan.new_secret}"`,
    `COORDINATOR_JWT_SECRET_PREV_ROTATED_AT="${plan.rotated_at_iso}"`,
    "",
    "# Operator workflow:",
    ...plan.steps.map((s) => `# ${s}`),
  ].join("\n");
}

function formatPlanJson(plan: RotationPlan): string {
  return JSON.stringify(plan, null, 2);
}

export function createRotateJwtSecretCommand(): Command {
  const cmd = new Command("rotate-jwt-secret");
  cmd.description(
    "Generate a fresh COORDINATOR_JWT_SECRET and print the operator rotation workflow",
  );

  cmd
    .option("--bits <bits>", "Total bits of randomness in the new secret. Must be >=128.", "256")
    .option(
      "--format <format>",
      "Output format: env (default, copy-pasteable env block), json (machine-readable), secret-only (just the new secret on stdout)",
      "env",
    )
    .option("--iso", "Use ISO 8601 timestamp (default)", true)
    .action((opts: RotateOpts) => {
      const requestedBits = Number.parseInt(opts.bits, 10);
      if (!Number.isFinite(requestedBits) || requestedBits <= 0) {
        process.stderr.write(`Invalid --bits value: ${opts.bits}\n`);
        process.exit(2);
      }
      if (requestedBits < 128) {
        process.stderr.write(
          `--bits ${requestedBits} is below the 128-bit floor enforced by boot.\n`,
        );
        process.exit(2);
      }
      // Round up to whole bytes (8 bits) for randomBytes.
      const byteLength = Math.ceil(requestedBits / 8);

      let plan: RotationPlan;
      try {
        plan = buildRotationPlan(byteLength);
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(2);
        return;
      }

      switch (opts.format) {
        case "json":
          process.stdout.write(formatPlanJson(plan) + "\n");
          break;
        case "secret-only":
          process.stdout.write(plan.new_secret + "\n");
          break;
        case "env":
        default:
          process.stdout.write(formatPlanEnv(plan) + "\n");
          break;
      }
    });

  return cmd;
}
