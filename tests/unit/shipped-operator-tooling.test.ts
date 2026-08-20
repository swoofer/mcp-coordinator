import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * issue #348, connected defect — `scripts/verify-audit-chain.ts` was advertised
 * in README.md as operational tooling and wired into an hourly cron by
 * docs/ops/audit-integrity.md, with an absolute path. It shipped nowhere:
 * `package.json`'s `files` listed dist/src, dist/cli, dashboard, LICENSE and
 * README; the Dockerfile copied the same set. Only someone who had cloned the
 * repository had the tool the runbook told them to run.
 *
 * That is the kind of promise nothing checks, so nothing noticed. Four places
 * have to agree for the tool to exist where the docs say it does — tsconfig to
 * compile it, package.json to publish it, the Dockerfile to build and carry
 * it — and these tests make them agree.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PKG = JSON.parse(read("package.json")) as { files: string[] };
const TSCONFIG = JSON.parse(read("tsconfig.json")) as { include: string[] };
const DOCKERFILE = read("Dockerfile");

describe("the verifier reaches the people told to run it (#348)", () => {
  it("tsconfig compiles scripts/", () => {
    // Without this the other three are pointless: there is nothing to ship.
    expect(TSCONFIG.include).toContain("scripts/**/*.ts");
  });

  it("the npm package publishes the compiled script", () => {
    expect(PKG.files).toContain("dist/scripts/");
  });

  it("the Docker builder copies the source and the runtime keeps the output", () => {
    expect(DOCKERFILE).toContain("COPY scripts ./scripts");
    // The runtime stage copies dist wholesale, so dist/scripts rides along —
    // but only if the builder had the sources. Assert both halves.
    expect(DOCKERFILE).toMatch(/COPY[^\n]*\/build\/dist \.\/dist/);
  });

  it("the docs name the compiled path, not only the checkout one", () => {
    // An npm or Docker install has no tsx and no scripts/ directory, so a
    // runbook that only shows `tsx scripts/...` is unusable there.
    const runbook = read("docs/ops/audit-integrity.md");
    expect(runbook).toContain("node dist/scripts/verify-audit-chain.js");
    expect(read("README.md")).toContain("node dist/scripts/verify-audit-chain.js");
  });

  it("the cron recipe uses the invocation that works after an install", () => {
    // This is the line an operator copies into crontab. It named `tsx
    // scripts/...` — a path that does not exist on the machine running it.
    const runbook = read("docs/ops/audit-integrity.md");
    const cronLine = runbook.split("\n").find((l) => l.includes("/var/log/audit-tip-"));
    expect(cronLine, "the tip-attestation cron line is gone").toBeDefined();
    expect(cronLine).toContain("node dist/scripts/verify-audit-chain.js");
  });

  it("the script's own usage string offers both invocations", () => {
    // It is printed on a bad flag, which is exactly when someone is lost.
    const script = read("scripts/verify-audit-chain.ts");
    expect(script).toContain("node dist/scripts/verify-audit-chain.js");
    expect(script).toContain("tsx scripts/verify-audit-chain.ts");
  });
});
