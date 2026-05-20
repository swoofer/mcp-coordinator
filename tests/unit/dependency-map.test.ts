import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { DependencyMapper } from "../../src/dependency-map.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import fs from "fs";

const TEST_DIR = "data-test-depmap";
let depMap: DependencyMapper;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  // v0.9 (issue #79): FK on dependency_map.org_id → orgs(id).
  seedTestOrgs(getDb(), ["org-a", "org-b"]);
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
    depMap.setMap("default", {
      "src/auth": { module_id: "src/auth", depends_on: ["src/shared"], exports: ["AuthMiddleware"], owners: ["agent-a"] },
      "src/shared": { module_id: "src/shared", depends_on: [], exports: ["User", "Token"], owners: [] },
    });
    const info = depMap.getModuleInfo("default", "src/auth");
    expect(info?.depends_on).toContain("src/shared");
    expect(info?.exports).toContain("AuthMiddleware");
  });

  it("calculates blast radius", () => {
    depMap.setMap("default", {
      "src/shared": { module_id: "src/shared", depends_on: [], exports: ["User"], owners: [] },
      "src/auth": { module_id: "src/auth", depends_on: ["src/shared"], exports: ["AuthMiddleware"], owners: [] },
      "src/api": { module_id: "src/api", depends_on: ["src/auth"], exports: ["routes"], owners: [] },
    });
    const radius = depMap.getBlastRadius("default", "src/shared");
    expect(radius.direct_dependents).toContain("src/auth");
    expect(radius.indirect_dependents).toContain("src/api");
  });

  it("returns null for unknown module", () => {
    expect(depMap.getModuleInfo("default", "nonexistent")).toBeNull();
  });

  it("getBlastRadius returns empty indirect_dependents when none exist", () => {
    depMap.setMap("default", {
      "src/shared": { module_id: "src/shared", depends_on: [], exports: ["User"], owners: [] },
      "src/auth": { module_id: "src/auth", depends_on: ["src/shared"], exports: ["AuthMiddleware"], owners: [] },
    });
    const radius = depMap.getBlastRadius("default", "src/shared");
    expect(radius.direct_dependents).toEqual(["src/auth"]);
    expect(radius.indirect_dependents).toEqual([]);
    expect(radius.affected_exports).toEqual(["User"]);
  });

  it("getBlastRadius returns empty exports when module has none", () => {
    depMap.setMap("default", {
      "src/utils": { module_id: "src/utils", depends_on: [], exports: [], owners: [] },
      "src/auth": { module_id: "src/auth", depends_on: ["src/utils"], exports: ["login"], owners: [] },
    });
    const radius = depMap.getBlastRadius("default", "src/utils");
    expect(radius.affected_exports).toHaveLength(0);
    expect(radius.direct_dependents).toContain("src/auth");
  });

  it("getBlastRadius for unknown module returns empty arrays", () => {
    depMap.setMap("default", {
      "src/auth": { module_id: "src/auth", depends_on: [], exports: ["login"], owners: [] },
    });
    const radius = depMap.getBlastRadius("default", "src/nonexistent");
    expect(radius.affected_exports).toHaveLength(0);
    expect(radius.direct_dependents).toHaveLength(0);
    expect(radius.indirect_dependents).toHaveLength(0);
  });
});

describe("dependency-map org_id scoping", () => {
  beforeEach(() => { getDb().exec("DELETE FROM dependency_map"); });

  it("setDependencies writes org_id", () => {
    depMap.setDependencies("org-a", "moduleX", { depends_on: ["a"], exports: ["b"], owners: ["c"] });
    const row = getDb().prepare("SELECT org_id FROM dependency_map WHERE module_id = 'moduleX'").get() as { org_id: string };
    expect(row.org_id).toBe("org-a");
  });

  it("getDependencies scopes by org", () => {
    depMap.setDependencies("org-a", "moduleX", { depends_on: ["a"], exports: [], owners: [] });
    depMap.setDependencies("org-b", "moduleX", { depends_on: ["b"], exports: [], owners: [] });
    expect(depMap.getDependencies("org-a", "moduleX")?.depends_on).toEqual(["a"]);
    expect(depMap.getDependencies("org-b", "moduleX")?.depends_on).toEqual(["b"]);
  });

  it("listOwners scopes by org", () => {
    depMap.setDependencies("org-a", "modA", { depends_on: [], exports: [], owners: ["alice"] });
    depMap.setDependencies("org-b", "modB", { depends_on: [], exports: [], owners: ["bob"] });
    const owners = depMap.listOwners("org-a");
    expect(owners).toContain("alice");
    expect(owners).not.toContain("bob");
  });
});


