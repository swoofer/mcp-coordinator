import { describe, it, expect } from "vitest";
import { normalizePath } from "../../src/path-normalize.js";

/**
 * issue #379 — a coordinator has one COORDINATOR_REPO_ROOT, so an agent
 * working in a second worktree has every declared path rejected. The fix for
 * that is a scoping decision (per-agent root? a repo axis? server-side
 * inference?) and it is open.
 *
 * This is the part that needs no decision: the message. It used to read
 *
 *     path is outside repoRoot: /other/checkout/src/foo.ts
 *
 * which names the rule and not the way out. A reader had to go find
 * COORDINATOR_REPO_ROOT to learn what "outside" meant here — and if they were
 * in a second worktree, that they could not comply at all. Behaviour is
 * unchanged: same inputs, same rejection.
 */

const ROOT = "/home/dev/repo";

describe("the out-of-root rejection explains itself (#379)", () => {
  const thrown = () => {
    try {
      normalizePath(ROOT, "/home/dev/other-worktree/src/foo.ts");
      return null;
    } catch (err) {
      return err as Error;
    }
  };

  it("still rejects — this is a diagnostic change, not a policy one", () => {
    expect(thrown()).not.toBeNull();
  });

  it("names the configured root, not just the offending path", () => {
    // Without it the reader cannot tell whether their path is wrong or the
    // server is configured somewhere they did not expect.
    const message = thrown()!.message;
    expect(message).toContain("/home/dev/other-worktree/src/foo.ts");
    expect(message).toContain(ROOT);
  });

  it("states the accepted form", () => {
    // The same convention the tool schemas already state.
    expect(thrown()!.message).toMatch(/repo-relative/i);
  });

  it("tells a worktree reader how to comply, instead of that they cannot", () => {
    // INVERTED, not deleted. This used to assert the message said a second
    // worktree "cannot be expressed today", and called that "the honest part".
    // It was not honest, it was wrong — and the last case in this same file
    // proved it wrong: a relative declaration has always produced the same key
    // as the main checkout. A reader in a worktree who believed that sentence
    // gave up for no reason.
    //
    // Since #379's fix it is out of date as well: absolute paths from any
    // worktree `git worktree list` knows about now normalize.
    const message = thrown()!.message;
    expect(message).toMatch(/worktree/i);
    expect(message).not.toMatch(/cannot be expressed/i);
    expect(message).toMatch(/always works/i);
  });

  it("keeps the phrase the existing assertions match on", () => {
    // tests/unit/path-normalize.test.ts, path-contract and
    // path-join-contract all match /outside repoRoot/ or /outside/i. Breaking
    // that would be a silent test rewrite hiding inside a message change.
    expect(thrown()!.message).toMatch(/outside repoRoot/);
  });

  it("a path under the root is still normalised, not rejected", () => {
    expect(normalizePath(ROOT, "/home/dev/repo/src/foo.ts")).toBe("src/foo.ts");
    expect(normalizePath(ROOT, "src/foo.ts")).toBe("src/foo.ts");
  });
});
