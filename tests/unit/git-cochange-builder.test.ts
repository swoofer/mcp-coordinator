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
    // Use files that each co-change in 2 of 5 commits (40% threshold not exceeded).
    // p.ts and q.ts share 2 commits; r.ts and s.ts share 2 commits; u.ts appears alone.
    const repo = createGitFixture([
      { files: { "p.ts": "1", "q.ts": "1" }, message: "1" },
      { files: { "p.ts": "2", "q.ts": "2" }, message: "2" },
      { files: { "r.ts": "3", "s.ts": "3" }, message: "3" },
      { files: { "r.ts": "4", "s.ts": "4" }, message: "4" },
      { files: { "u.ts": "5" }, message: "5" },
    ]);
    const builder = new GitCochangeBuilder({ repoRoot: repo });
    await builder.build();
    // p.ts and q.ts share 2 of 5 commits; neither exceeds the 40% predictor cap
    const row = getDb().prepare("SELECT count, total_commits FROM git_cochange WHERE file_a=? AND file_b=?")
      .get("p.ts", "q.ts") as any;
    expect(row).toBeDefined();
    expect(row.count).toBe(2);
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

  it("excludes a file co-changing with > 40% of commits as predictor", async () => {
    // 5 commits, hotspot.ts appears in 4 of them (80%). It should be excluded as a predictor.
    const repo = createGitFixture([
      { files: { "hotspot.ts": "1", "a.ts": "1" }, message: "1" },
      { files: { "hotspot.ts": "2", "b.ts": "2" }, message: "2" },
      { files: { "hotspot.ts": "3", "c.ts": "3" }, message: "3" },
      { files: { "hotspot.ts": "4", "d.ts": "4" }, message: "4" },
      { files: { "e.ts": "5" }, message: "5" },
    ]);
    const builder = new GitCochangeBuilder({ repoRoot: repo });
    await builder.build();
    const rows = getDb().prepare(
      "SELECT * FROM git_cochange WHERE file_a = ? OR file_b = ?"
    ).all("hotspot.ts", "hotspot.ts") as any[];
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
