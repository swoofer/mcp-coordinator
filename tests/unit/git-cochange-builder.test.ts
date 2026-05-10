import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { GitCochangeBuilder } from "../../src/git-cochange-builder.js";
import { createGitFixture } from "../test-utils/git-fixture.js";

const TEST_DIR = mkdtempSync(path.join(tmpdir(), "gitcc-"));

describe("GitCochangeBuilder", () => {
  beforeEach(() => {
    initDatabase(TEST_DIR);
    getDb().exec("DELETE FROM git_cochange; DELETE FROM git_cochange_meta;");
  });
  afterAll(() => { closeDb(); rmSync(TEST_DIR, { recursive: true, force: true }); });

  it("computes ratios from a 5-commit fixture", async () => {
    const repo = createGitFixture([
      { files: { "a.ts": "1", "b.ts": "1" }, message: "1" },
      { files: { "a.ts": "2", "b.ts": "2" }, message: "2" },
      { files: { "a.ts": "3", "b.ts": "3" }, message: "3" },
      { files: { "a.ts": "4", "c.ts": "4" }, message: "4" },
      { files: { "a.ts": "5", "c.ts": "5" }, message: "5" },
    ]);
    const builder = new GitCochangeBuilder({ repoRoot: repo });
    await builder.build();
    // a.ts and b.ts share 3 of 5 commits → ratio 3/5 = 0.6 → score 60
    const row = getDb().prepare("SELECT count, total_commits FROM git_cochange WHERE file_a=? AND file_b=?")
      .get("a.ts", "b.ts") as any;
    expect(row).toBeDefined();
    expect(row.count).toBe(3);
  });

  it("denylists package-lock.json as a predictor", async () => {
    const repo = createGitFixture([
      { files: { "package-lock.json": "1", "src/foo.ts": "1" }, message: "1" },
      { files: { "package-lock.json": "2", "src/bar.ts": "2" }, message: "2" },
    ]);
    const builder = new GitCochangeBuilder({ repoRoot: repo });
    await builder.build();
    const rows = getDb().prepare(
      "SELECT * FROM git_cochange WHERE file_a LIKE '%package-lock%' OR file_b LIKE '%package-lock%'"
    ).all() as any[];
    expect(rows.length).toBe(0);
  });

  it("skips on shallow clone", async () => {
    const repo = createGitFixture([{ files: { "a.ts": "1" }, message: "1" }]);
    writeFileSync(path.join(repo, ".git/shallow"), "deadbeef\n");
    const builder = new GitCochangeBuilder({ repoRoot: repo });
    await builder.build();
    const meta = getDb().prepare("SELECT v FROM git_cochange_meta WHERE k='available'").get() as any;
    expect(meta?.v).toBe("false");
  });
});
