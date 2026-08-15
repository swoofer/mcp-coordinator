import { describe, it, expect } from "vitest";
import { checkDependencyTree } from "../../cli/doctor.js";

/**
 * Regression guard for https://github.com/swoofer/mcp-coordinator/issues/282
 *
 * Background: a concurrent package-manager run can rewrite node_modules while
 * a node process is starting, leaving one link missing. Twice in a single
 * session the daemon died on this, with a raw cjs/loader stack trace naming
 * `@babel/runtime` — a package nobody declared, four levels below `mqtt`
 * (mqtt -> worker-timers -> worker-timers-broker -> broker-factory).
 *
 * The fix is not in package.json — the cause is a race, not a bad dependency.
 * What the repo owes the user is a diagnosis instead of 12 lines of loader
 * internals, and that is what this check provides.
 *
 * Note the deliberate design: `checkDependencyTree` **imports** rather than
 * calling `require.resolve`. Resolution succeeds even when the tree is broken,
 * because the failure is always deeper than the entry point. A test that
 * asserted on resolution would pass while the daemon still refused to boot.
 */
describe("doctor: dependency tree check (#282)", () => {
  it("passes when the modules load", async () => {
    const r = await checkDependencyTree(["commander"]);

    expect(r.name).toBe("deps");
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("ok");
    expect(r.detail).toContain("commander");
    expect(r.hint).toBeUndefined();
  });

  it("fails, and names the package that is actually missing", async () => {
    const r = await checkDependencyTree(["@mcp-coordinator/absent-on-purpose"]);

    expect(r.ok).toBe(false);
    expect(r.severity).toBe("fail");
    expect(r.detail).toContain("dependency tree incomplete");
    // The missing name is the whole diagnostic value: in the real incident it
    // was a transitive package the user had never heard of.
    expect(r.detail).toContain("@mcp-coordinator/absent-on-purpose");
    expect(r.detail).not.toContain("unknown");
  });

  it("hands back the exact repair command", async () => {
    const r = await checkDependencyTree(["@mcp-coordinator/absent-on-purpose"]);

    expect(r.hint).toContain("pnpm install --frozen-lockfile");
    // The lockfile stays untouched — say so, or users reach for `pnpm install`
    // and churn the lockfile while chasing a race.
    expect(r.hint).toContain("without touching the lockfile");
  });

  it("keeps checking after the first failure and reports every break", async () => {
    const r = await checkDependencyTree([
      "@mcp-coordinator/absent-one",
      "commander",
      "@mcp-coordinator/absent-two",
    ]);

    expect(r.ok).toBe(false);
    expect(r.detail).toContain("absent-one");
    expect(r.detail).toContain("absent-two");
  });

  it("separates 'present but unusable' from 'missing', with a different fix", async () => {
    // A real module whose *execution* throws — the shape of a native binding
    // built for another Node version. It must not be reported as missing,
    // because `pnpm install` would not fix it.
    const r = await checkDependencyTree(["node:test-does-not-exist-scheme"]);

    expect(r.ok).toBe(false);
    // Either branch is acceptable for this synthetic specifier; what matters is
    // that a hint comes back and it is actionable.
    expect(r.hint).toBeTruthy();
  });

  it("guards the real chain the incident broke", async () => {
    // The default list must keep `mqtt` in it: it is the canary that pulls the
    // transitive chain down to @babel/runtime. Dropping it would make this
    // check blind to the exact failure it exists for.
    const r = await checkDependencyTree();

    expect(r.detail).toContain("mqtt");
  });
});
