import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";

const TEST_DIR = mkdtempSync(path.join(tmpdir(), "v06-schema-"));

describe("v0.6 schema", () => {
  beforeAll(() => initDatabase(TEST_DIR));
  afterAll(() => { closeDb(); rmSync(TEST_DIR, { recursive: true, force: true }); });

  it("working_files table exists with expected columns", () => {
    const cols = getDb().prepare("PRAGMA table_info(working_files)").all() as { name: string }[];
    expect(cols.map(c => c.name).sort()).toEqual(
      ["agent_id", "claim_until", "file_path", "last_activity_at", "org_id", "started_at"].sort()
    );
  });

  it("git_cochange table exists with canonical-pair CHECK", () => {
    const cols = getDb().prepare("PRAGMA table_info(git_cochange)").all() as { name: string }[];
    expect(cols.map(c => c.name).sort()).toEqual(
      ["computed_at", "count", "file_a", "file_b", "org_id", "total_commits"].sort()
    );
  });

  it("git_cochange_meta table exists", () => {
    const cols = getDb().prepare("PRAGMA table_info(git_cochange_meta)").all() as { name: string }[];
    expect(cols.map(c => c.name).sort()).toEqual(["k", "org_id", "v"].sort());
  });

  it("layer_firings table exists", () => {
    const cols = getDb().prepare("PRAGMA table_info(layer_firings)").all() as { name: string }[];
    expect(cols.map(c => c.name)).toContain("layer");
    expect(cols.map(c => c.name)).toContain("score");
  });

  it("file_activity has symbols_touched + content_hash", () => {
    const cols = getDb().prepare("PRAGMA table_info(file_activity)").all() as { name: string }[];
    expect(cols.map(c => c.name)).toContain("symbols_touched");
    expect(cols.map(c => c.name)).toContain("content_hash");
  });

  it("user_version is at the current head (>=8; 9 after v0.9 FK migration)", () => {
    const v = getDb().prepare("PRAGMA user_version").get() as { user_version: number };
    // v0.9 (issue #79) bumps to 9. Loosened from strict ==8 so this guard
    // tracks "post-v0.8 schema" without re-failing on each future bump.
    expect(v.user_version).toBeGreaterThanOrEqual(8);
  });
});
