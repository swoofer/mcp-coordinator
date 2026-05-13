import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, closeDb } from "../../src/database.js";
import fs from "fs";
import path from "path";
import os from "os";

const DIR = "data-test-db-mode";

describe("DB file permissions", () => {
  beforeAll(() => { fs.mkdirSync(DIR, { recursive: true }); initDatabase(DIR); });
  afterAll(() => { closeDb(); fs.rmSync(DIR, { recursive: true, force: true }); });

  it("coordinator.db is mode 0600 (owner read/write only)", () => {
    if (os.platform() === "win32") return; // POSIX modes don't apply on NTFS
    const stat = fs.statSync(path.join(DIR, "coordinator.db"));
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
