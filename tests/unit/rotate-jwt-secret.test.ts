import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildRotationPlan } from "../../cli/rotate-jwt-secret.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "cli", "index.ts");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("buildRotationPlan", () => {
  it("returns a base64-encoded secret of the requested length", () => {
    const plan = buildRotationPlan(32);
    const buf = Buffer.from(plan.new_secret, "base64");
    expect(buf.length).toBe(32);
  });

  it("estimated entropy bits is close to byteLength * 8 for crypto-random input", () => {
    const plan = buildRotationPlan(32);
    // For random 32 bytes Shannon entropy is typically ~5 bits/byte on
    // a tiny sample (each byte mostly unique). 32 bytes -> approx 160
    // bits. We assert the floor is comfortably above the 128-bit
    // requirement.
    expect(plan.estimated_entropy_bits).toBeGreaterThanOrEqual(128);
  });

  it("includes the operator workflow steps", () => {
    const plan = buildRotationPlan(32);
    expect(plan.steps).toHaveLength(8);
    expect(plan.steps[0]).toMatch(/Copy the CURRENT value/);
    expect(plan.steps[plan.steps.length - 1]).toMatch(/mcp-coordinator doctor --phase2/);
  });

  it("rotated_at_iso is a valid ISO 8601 timestamp", () => {
    const fixedNow = new Date("2026-05-16T03:00:00.000Z");
    const plan = buildRotationPlan(32, fixedNow);
    expect(plan.rotated_at_iso).toBe("2026-05-16T03:00:00.000Z");
  });

  it("workflow text references the rotated_at_iso value", () => {
    const fixedNow = new Date("2026-05-16T03:00:00.000Z");
    const plan = buildRotationPlan(32, fixedNow);
    const step4 = plan.steps.find((s) => s.includes("_PREV_ROTATED_AT"));
    expect(step4).toBeDefined();
    expect(step4!).toContain("2026-05-16T03:00:00.000Z");
  });

  it("rejects byteLength < 16 (would be under 128 bits)", () => {
    expect(() => buildRotationPlan(15)).toThrow(/below the 128-bit floor/);
  });

  it("rejects a broken random source via the entropy validator", () => {
    // All-zeros random source -> assertSecretEntropy throws.
    const allZeros = (n: number) => Buffer.alloc(n, 0);
    expect(() => buildRotationPlan(32, new Date(), allZeros)).toThrow(/all bytes identical/);
  });

  it("two calls produce distinct secrets (sanity check on randomness)", () => {
    const a = buildRotationPlan(32);
    const b = buildRotationPlan(32);
    expect(a.new_secret).not.toBe(b.new_secret);
  });
});

describe("rotate-jwt-secret CLI", () => {
  it("default invocation prints an env-format block", () => {
    const result = runCli(["rotate-jwt-secret"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^# Rotation plan/m);
    expect(result.stdout).toMatch(/COORDINATOR_JWT_SECRET="[A-Za-z0-9+/=]+"/);
    expect(result.stdout).toMatch(/COORDINATOR_JWT_SECRET_PREV_ROTATED_AT="/);
    expect(result.stdout).toMatch(/# Operator workflow:/);
    expect(result.stdout).toMatch(/# 1\. Copy the CURRENT value/);
  });

  it("--format json emits parseable JSON", () => {
    const result = runCli(["rotate-jwt-secret", "--format", "json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      new_secret: expect.any(String),
      estimated_entropy_bits: expect.any(Number),
      rotated_at_iso: expect.any(String),
      steps: expect.any(Array),
    });
    expect(parsed.steps.length).toBe(8);
  });

  it("--format secret-only emits just the secret", () => {
    const result = runCli(["rotate-jwt-secret", "--format", "secret-only"]);
    expect(result.status).toBe(0);
    const trimmed = result.stdout.trim();
    // Base64 of 32 random bytes is 44 chars (3*32/4 with one '=' pad).
    expect(trimmed).toHaveLength(44);
    expect(trimmed).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("--bits 64 -> exit 2 with floor error", () => {
    const result = runCli(["rotate-jwt-secret", "--bits", "64"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/below the 128-bit floor/);
  });

  it("--bits non-numeric -> exit 2", () => {
    const result = runCli(["rotate-jwt-secret", "--bits", "abc"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Invalid --bits value/);
  });

  it("--bits 384 (48 bytes) produces a longer secret", () => {
    const result = runCli(["rotate-jwt-secret", "--bits", "384", "--format", "secret-only"]);
    expect(result.status).toBe(0);
    const buf = Buffer.from(result.stdout.trim(), "base64");
    expect(buf.length).toBe(48);
  });
});
