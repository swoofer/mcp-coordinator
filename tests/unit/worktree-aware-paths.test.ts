import { describe, it, expect, afterEach } from "vitest";
import { normalizePath, normalizeDeclaredPaths } from "../../src/path-normalize.js";
import { repoRoots, resetRepoRootsCache } from "../../src/repo-roots.js";

/**
 * issue #379. The issue reports the loud half: an agent in a worktree OUTSIDE
 * COORDINATOR_REPO_ROOT sends an absolute path and gets a 400.
 *
 * Measuring it turned up a second, silent half the issue does not mention.
 * Claude Code's native worktrees live INSIDE the root, under
 * `.claude/worktrees/<name>/`, so their absolute paths never trip the
 * outside-root check — they normalize to a DIFFERENT key and are stored
 * happily. `hot_files`, `checkFileConflict` and Layer 1 all join by exact
 * string equality, so that agent silently stops existing to the coordinator,
 * with no error and nothing to grep for.
 *
 * Both halves come down to one root being asked to answer for many. Git
 * already knows the real set.
 */

const ROOT = "C:/repo";
const NATIVE = ROOT + "/.claude/worktrees/compassionate-lederberg-bc53e2"; // inside ROOT
const SIBLING = "C:/tmp/wt-346"; // outside ROOT
const ALL = [ROOT, NATIVE, SIBLING];

describe("one logical file, one key, whichever worktree declared it (#379)", () => {
  it("the silent case: an in-root native worktree no longer mints its own key", () => {
    // Before this, the second call returned
    // ".claude/worktrees/compassionate-lederberg-bc53e2/src/foo.ts" — accepted,
    // stored, and never equal to the first.
    expect(normalizePath(ALL, ROOT + "/src/foo.ts")).toBe("src/foo.ts");
    expect(normalizePath(ALL, NATIVE + "/src/foo.ts")).toBe("src/foo.ts");
  });

  it("the loud case: an out-of-root worktree is accepted instead of 400ing", () => {
    expect(normalizePath(ALL, SIBLING + "/src/foo.ts")).toBe("src/foo.ts");
  });

  it("all three agree with each other and with a relative declaration", () => {
    const keys = [
      normalizePath(ALL, ROOT + "/src/foo.ts"),
      normalizePath(ALL, NATIVE + "/src/foo.ts"),
      normalizePath(ALL, SIBLING + "/src/foo.ts"),
      normalizePath(ALL, "src/foo.ts"),
    ];
    expect(new Set(keys).size).toBe(1);
  });

  it("longest match wins, which is what makes the nested case work", () => {
    // NATIVE starts with ROOT, so both match. Taking ROOT would reproduce the
    // old bug, and the order of the array must not decide it.
    expect(normalizePath([ROOT, NATIVE], NATIVE + "/src/foo.ts")).toBe("src/foo.ts");
    expect(normalizePath([NATIVE, ROOT], NATIVE + "/src/foo.ts")).toBe("src/foo.ts");
  });
});

describe("what still gets rejected, and what the rejection says (#379)", () => {
  const thrown = (): Error => {
    try {
      normalizePath(ALL, "C:/somewhere/else/src/foo.ts");
      throw new Error("expected a throw");
    } catch (e) {
      return e as Error;
    }
  };

  it("a path under no known root is still refused", () => {
    expect(thrown().message).toMatch(/outside repoRoot/);
  });

  it("the message no longer tells worktree users to give up", () => {
    // The message shipped for #379 said "Paths in another checkout or worktree
    // cannot be expressed today". That was false even then — declaring
    // relative always produced the right key — and it is the one sentence a
    // reader in a worktree would act on.
    expect(thrown().message).not.toMatch(/cannot be expressed/);
    expect(thrown().message).toMatch(/repo-relative/);
    expect(thrown().message).toMatch(/always works/);
  });

  it("it lists the roots it actually tried", () => {
    const m = thrown().message;
    for (const r of ALL) expect(m).toContain(r);
  });
});

describe("the single-root and no-root behaviours are unchanged (#379)", () => {
  it("a bare string still works — every existing caller passes one", () => {
    expect(normalizePath(ROOT, ROOT + "/src/foo.ts")).toBe("src/foo.ts");
    expect(() => normalizePath(ROOT, SIBLING + "/src/foo.ts")).toThrow(/outside repoRoot/);
  });

  it("null still stores what it was given", () => {
    expect(normalizePath(null, "src/foo.ts")).toBe("src/foo.ts");
    expect(normalizePath([], "src/foo.ts")).toBe("src/foo.ts");
  });

  it("normalizeDeclaredPaths takes the same widened type", () => {
    expect(normalizeDeclaredPaths(ALL, [ROOT + "/a.ts", NATIVE + "/b.ts"])).toEqual({
      ok: true,
      paths: ["a.ts", "b.ts"],
    });
    expect(normalizeDeclaredPaths(ALL, ["C:/elsewhere/x.ts"]).ok).toBe(false);
  });
});

describe("repoRoots() reads the set from git (#379)", () => {
  afterEach(() => {
    delete process.env.COORDINATOR_REPO_ROOT;
    resetRepoRootsCache();
  });

  it("no configured root means no roots, exactly as before", () => {
    resetRepoRootsCache();
    expect(repoRoots()).toEqual([]);
  });

  it("a configured root is always present, even where git says nothing", () => {
    // A non-repo directory, git missing, a broken repo: all answer the same
    // way, and the configured root must survive all of them.
    process.env.COORDINATOR_REPO_ROOT = "/definitely/not/a/git/repo";
    resetRepoRootsCache();
    expect(repoRoots()).toContain("/definitely/not/a/git/repo");
  });

  it("a trailing slash does not produce a second, different root", () => {
    process.env.COORDINATOR_REPO_ROOT = "/definitely/not/a/git/repo/";
    resetRepoRootsCache();
    expect(repoRoots()).toEqual(["/definitely/not/a/git/repo"]);
  });

  it("results come back longest-first, which normalizePath relies on", () => {
    process.env.COORDINATOR_REPO_ROOT = process.cwd();
    resetRepoRootsCache();
    const lengths = repoRoots().map((r) => r.length);
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });

  it("and the checkout under test enumerates at least its own root", () => {
    // The repo under test IS a git repo. If this ever drops to zero the git
    // call is failing silently and every worktree fix above is inert.
    process.env.COORDINATOR_REPO_ROOT = process.cwd();
    resetRepoRootsCache();
    expect(repoRoots().length).toBeGreaterThanOrEqual(1);
  });
});
