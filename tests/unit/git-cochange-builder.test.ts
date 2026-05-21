import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, promises as fsp } from "fs";
import { tmpdir } from "os";
import path from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { GitCochangeBuilder } from "../../src/git-cochange-builder.js";
import { createGitFixture } from "../test-utils/git-fixture.js";
import { seedTestOrgs } from "../helpers/orgs.js";

type CochangeRow = { org_id: string; file_a: string; file_b: string; count: number; total_commits: number; computed_at: string };

const TEST_DIR = mkdtempSync(path.join(tmpdir(), "gitcc-"));

describe("GitCochangeBuilder", () => {
  beforeEach(() => {
    // Close any previous connection before re-init: initDatabase() reassigns the
    // module-level db without closing the old handle, which on Windows leaks
    // handles to the same .db file and causes EBUSY on rmSync in afterAll.
    try { closeDb(); } catch { /* nothing to close yet */ }
    initDatabase(TEST_DIR);
    getDb().exec("DELETE FROM git_cochange; DELETE FROM git_cochange_meta;");
    // v0.9 (issue #79): FK on git_cochange*.org_id → orgs(id).
    seedTestOrgs(getDb(), ["org-a", "org-b"]);
  });
  afterAll(async () => {
    try { closeDb(); } catch { /* already closed */ }
    // Windows can hold .db handles for many seconds after better-sqlite3 close()
    // (Defender / indexer / WAL teardown). Retry generously so cleanup wins
    // once the OS releases the file.
    await fsp.rm(TEST_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 750 });
  }, 30000);

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
    await builder.build("default");
    // p.ts and q.ts share 2 of 5 commits; neither exceeds the 40% predictor cap
    const row = getDb().prepare("SELECT count, total_commits FROM git_cochange WHERE org_id = ? AND file_a=? AND file_b=?")
      .get("default", "p.ts", "q.ts") as any;
    expect(row).toBeDefined();
    expect(row.count).toBe(2);
  });

  it("denylists package-lock.json as a predictor", async () => {
    const repo = createGitFixture([
      { files: { "package-lock.json": "1", "src/foo.ts": "1" }, message: "1" },
      { files: { "package-lock.json": "2", "src/bar.ts": "2" }, message: "2" },
    ]);
    const builder = new GitCochangeBuilder({ repoRoot: repo });
    await builder.build("default");
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
    await builder.build("default");
    const rows = getDb().prepare(
      "SELECT * FROM git_cochange WHERE file_a = ? OR file_b = ?"
    ).all("hotspot.ts", "hotspot.ts") as any[];
    expect(rows.length).toBe(0);
  });

  it("skips on shallow clone", async () => {
    const repo = createGitFixture([{ files: { "a.ts": "1" }, message: "1" }]);
    writeFileSync(path.join(repo, ".git/shallow"), "deadbeef\n");
    const builder = new GitCochangeBuilder({ repoRoot: repo });
    await builder.build("default");
    const meta = getDb().prepare("SELECT v FROM git_cochange_meta WHERE org_id = ? AND k = ?").get("default", "available") as any;
    expect(meta?.v).toBe("false");
  });
});

describe("git-cochange-builder org_id scoping", () => {
  beforeEach(() => {
    initDatabase(TEST_DIR);
    getDb().exec("DELETE FROM git_cochange; DELETE FROM git_cochange_meta");
    // v0.9 (issue #79): FK on git_cochange*.org_id → orgs(id).
    seedTestOrgs(getDb(), ["org-a", "org-b"]);
  });

  it("build writes org_id on every cochange row", async () => {
    // 5 commits; x.ts and y.ts co-change in 2 of 5 (40% threshold not exceeded for pairs)
    const repo = createGitFixture([
      { files: { "x.ts": "1", "y.ts": "1" }, message: "c1" },
      { files: { "x.ts": "2", "y.ts": "2" }, message: "c2" },
      { files: { "a.ts": "3" }, message: "c3" },
      { files: { "b.ts": "4" }, message: "c4" },
      { files: { "c.ts": "5" }, message: "c5" },
    ]);
    const builder = new GitCochangeBuilder({ repoRoot: repo });
    await builder.build("org-a");
    const rows = getDb().prepare("SELECT org_id FROM git_cochange").all() as { org_id: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.org_id === "org-a")).toBe(true);
  });

  it("query scopes by org_id", async () => {
    // Seed rows directly for org-a and org-b for the same file to test isolation
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO git_cochange (org_id, file_a, file_b, count, total_commits, computed_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("org-a", "shared.ts", "z.ts", 3, 5, now);
    db.prepare(
      "INSERT INTO git_cochange (org_id, file_a, file_b, count, total_commits, computed_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("org-b", "shared.ts", "w.ts", 2, 5, now);

    const repo = createGitFixture([{ files: { "dummy.ts": "1" }, message: "init" }]);
    const builder = new GitCochangeBuilder({ repoRoot: repo });
    const aResults = builder.query("org-a", "shared.ts");
    expect(aResults.length).toBe(1);
    expect((aResults[0] as CochangeRow).org_id).toBe("org-a");
    expect((aResults[0] as CochangeRow).file_b).toBe("z.ts");
  });

  it("build with org-a does not clear org-b rows", async () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO git_cochange (org_id, file_a, file_b, count, total_commits, computed_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("org-b", "b1.ts", "b2.ts", 1, 2, now);

    const repo = createGitFixture([
      { files: { "x.ts": "1", "y.ts": "1" }, message: "c1" },
    ]);
    const builder = new GitCochangeBuilder({ repoRoot: repo });
    await builder.build("org-a");

    const orgBRows = db.prepare("SELECT * FROM git_cochange WHERE org_id = ?").all("org-b") as CochangeRow[];
    expect(orgBRows.length).toBe(1);
    expect(orgBRows[0].file_a).toBe("b1.ts");
  });
});
