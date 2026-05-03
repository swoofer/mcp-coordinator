import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { DependencyMapper } from "../../src/dependency-map.js";
import fs from "fs";

const TEST_DIR = "data-test-depmap";
let depMap: DependencyMapper;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM dependency_map");
  depMap = new DependencyMapper();
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("DependencyMapper", () => {
  it("stores and retrieves module info", () => {
    depMap.setMap({
      "src/auth": { module_id: "src/auth", depends_on: ["src/shared"], exports: ["AuthMiddleware"], owners: ["agent-a"] },
      "src/shared": { module_id: "src/shared", depends_on: [], exports: ["User", "Token"], owners: [] },
    });
    const info = depMap.getModuleInfo("src/auth");
    expect(info?.depends_on).toContain("src/shared");
    expect(info?.exports).toContain("AuthMiddleware");
  });

  it("calculates blast radius", () => {
    depMap.setMap({
      "src/shared": { module_id: "src/shared", depends_on: [], exports: ["User"], owners: [] },
      "src/auth": { module_id: "src/auth", depends_on: ["src/shared"], exports: ["AuthMiddleware"], owners: [] },
      "src/api": { module_id: "src/api", depends_on: ["src/auth"], exports: ["routes"], owners: [] },
    });
    const radius = depMap.getBlastRadius("src/shared");
    expect(radius.direct_dependents).toContain("src/auth");
    expect(radius.indirect_dependents).toContain("src/api");
  });

  it("returns null for unknown module", () => {
    expect(depMap.getModuleInfo("nonexistent")).toBeNull();
  });

  it("getBlastRadius returns empty indirect_dependents when none exist", () => {
    depMap.setMap({
      "src/shared": { module_id: "src/shared", depends_on: [], exports: ["User"], owners: [] },
      "src/auth": { module_id: "src/auth", depends_on: ["src/shared"], exports: ["AuthMiddleware"], owners: [] },
    });
    const radius = depMap.getBlastRadius("src/shared");
    expect(radius.direct_dependents).toEqual(["src/auth"]);
    expect(radius.indirect_dependents).toEqual([]);
    expect(radius.affected_exports).toEqual(["User"]);
  });

  it("getBlastRadius returns empty exports when module has none", () => {
    depMap.setMap({
      "src/utils": { module_id: "src/utils", depends_on: [], exports: [], owners: [] },
      "src/auth": { module_id: "src/auth", depends_on: ["src/utils"], exports: ["login"], owners: [] },
    });
    const radius = depMap.getBlastRadius("src/utils");
    expect(radius.affected_exports).toHaveLength(0);
    expect(radius.direct_dependents).toContain("src/auth");
  });

  it("getBlastRadius for unknown module returns empty arrays", () => {
    depMap.setMap({
      "src/auth": { module_id: "src/auth", depends_on: [], exports: ["login"], owners: [] },
    });
    const radius = depMap.getBlastRadius("src/nonexistent");
    expect(radius.affected_exports).toHaveLength(0);
    expect(radius.direct_dependents).toHaveLength(0);
    expect(radius.indirect_dependents).toHaveLength(0);
  });
});


