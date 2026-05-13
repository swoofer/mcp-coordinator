// tests/conflict-detector.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation } from "../../src/consultation.js";
import { DependencyMapper } from "../../src/dependency-map.js";
import { ConflictDetector } from "../../src/conflict-detector.js";
import { FileTracker } from "../../src/file-tracker.js";
import fs from "fs";

const TEST_DIR = "data-test-conflicts";
let registry: AgentRegistry;
let consultation: Consultation;
let depMap: DependencyMapper;
let fileTracker: FileTracker;
let detector: ConflictDetector;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM action_summaries");
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM dependency_map");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
  consultation = new Consultation();
  depMap = new DependencyMapper();
  fileTracker = new FileTracker();
  detector = new ConflictDetector(consultation, depMap, fileTracker);
  registry.register("default", "a1", "Agent A", ["src/auth"]);
  registry.register("default", "a2", "Agent B", ["src/users"]);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ConflictDetector", () => {
  it("detects module overlap", () => {
    // a2 has an open thread on src/auth
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    consultation.announceWork("default", {
      agent_id: "a2",
      subject: "Work on auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    const conflicts = detector.detect({
      org_id: "default",
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(conflicts.some((c) => c.type === "module_overlap")).toBe(true);
  });

  it("detects file overlap", () => {
    consultation.announceWork("default", {
      agent_id: "a2",
      subject: "Edit shared types",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });
    const conflicts = detector.detect({
      org_id: "default",
      agent_id: "a1",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });
    expect(conflicts.some((c) => c.type === "file_overlap")).toBe(true);
  });

  it("detects dependency chain conflict", () => {
    depMap.setMap({
      "src/shared": { module_id: "src/shared", depends_on: [], exports: ["User"], owners: [] },
      "src/auth": { module_id: "src/auth", depends_on: ["src/shared"], exports: [], owners: [] },
    });
    consultation.announceWork("default", {
      agent_id: "a2",
      subject: "Refactor shared types",
      target_modules: ["src/shared"],
      target_files: [],
    });
    const conflicts = detector.detect({
      org_id: "default",
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(conflicts.some((c) => c.type === "dependency_chain")).toBe(true);
  });

  it("no conflicts on unrelated modules", () => {
    consultation.announceWork("default", {
      agent_id: "a2",
      subject: "Work on users",
      target_modules: ["src/users"],
      target_files: ["src/users/service.ts"],
    });
    const conflicts = detector.detect({
      org_id: "default",
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("cancelled threads are excluded from conflict detection", () => {
    const thread = consultation.announceWork("default", {
      agent_id: "a2",
      subject: "Work on auth (will be cancelled)",
      target_modules: ["src/auth"],
      target_files: [],
    });
    consultation.cancelThread("default", thread.id, "a2", "no longer needed");
    const conflicts = detector.detect({
      org_id: "default",
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("own threads are excluded â€” agent does not conflict with itself", () => {
    consultation.announceWork("default", {
      agent_id: "a1",
      subject: "My own work on auth",
      target_modules: ["src/auth"],
      target_files: [],
    });
    const conflicts = detector.detect({
      org_id: "default",
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: [],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("hot file overlap from file activity â€” detect() reports file_overlap for recently edited file", () => {
    fileTracker.log({
      org_id: "default",
      session_id: "sess-a2",
      agent_id: "a2",
      agent_name: "Agent B",
      tool_name: "Edit",
      file_path: "src/auth/service.ts",
    });
    const conflicts = detector.detect({
      org_id: "default",
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/auth/service.ts"],
    });
    expect(conflicts.some((c) => c.type === "file_overlap" && c.agent_id === "a2")).toBe(true);
  });

  it("reverse dependency chain â€” a2 works on a module that depends on what a1 is modifying", () => {
    depMap.setMap({
      "src/shared": { module_id: "src/shared", depends_on: [], exports: ["User"], owners: [] },
      "src/auth": { module_id: "src/auth", depends_on: ["src/shared"], exports: [], owners: [] },
    });
    // a2 works on src/auth, which depends on src/shared (what a1 will modify)
    consultation.announceWork("default", {
      agent_id: "a2",
      subject: "Work on auth module",
      target_modules: ["src/auth"],
      target_files: [],
    });
    const conflicts = detector.detect({
      org_id: "default",
      agent_id: "a1",
      target_modules: ["src/shared"],
      target_files: [],
    });
    expect(conflicts.some((c) => c.type === "dependency_chain" && c.agent_id === "a2")).toBe(true);
  });

  it("no duplicate file_overlap â€” thread file overlap and hot file activity on same agent produce only one conflict", () => {
    // a2 announces work on the same file (thread-level overlap)
    consultation.announceWork("default", {
      agent_id: "a2",
      subject: "Work on shared types",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });
    // a2 also has file activity on the same file (hot file overlap)
    fileTracker.log({
      org_id: "default",
      session_id: "sess-a2",
      agent_id: "a2",
      agent_name: "Agent B",
      tool_name: "Edit",
      file_path: "src/shared/types.ts",
    });
    const conflicts = detector.detect({
      org_id: "default",
      agent_id: "a1",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });
    const fileOverlapConflicts = conflicts.filter(
      (c) => c.type === "file_overlap" && c.agent_id === "a2"
    );
    expect(fileOverlapConflicts).toHaveLength(1);
  });

  it("dependency chain â€” no crash when getModuleInfo returns null (unknown module)", () => {
    // No dependency map set â†’ getModuleInfo will return null for any module
    consultation.announceWork("default", {
      agent_id: "a2",
      subject: "Work on unknown module",
      target_modules: ["src/unknown"],
      target_files: [],
    });

    // a1 targets a module not in the dep map â€” getModuleInfo returns null, should skip gracefully
    expect(() => {
      const conflicts = detector.detect({
        org_id: "default",
        agent_id: "a1",
        target_modules: ["src/nonexistent"],
        target_files: [],
      });
      // No dependency_chain conflicts since modules are unknown
      expect(conflicts.filter(c => c.type === "dependency_chain")).toHaveLength(0);
    }).not.toThrow();
  });

  it("blast radius with indirect_dependents detects transitive dependency conflict", () => {
    // src/core â†’ src/shared â†’ src/auth (transitive: src/auth indirectly depends on src/core)
    depMap.setMap({
      "src/core": { module_id: "src/core", depends_on: [], exports: ["CoreUtil"], owners: [] },
      "src/shared": { module_id: "src/shared", depends_on: ["src/core"], exports: ["User"], owners: [] },
      "src/auth": { module_id: "src/auth", depends_on: ["src/shared"], exports: [], owners: [] },
    });

    // a2 works on src/auth (indirect dependent of src/core)
    consultation.announceWork("default", {
      agent_id: "a2",
      subject: "Work on auth",
      target_modules: ["src/auth"],
      target_files: [],
    });

    // a1 modifies src/core â€” blast radius includes src/shared (direct) and src/auth (indirect)
    const conflicts = detector.detect({
      org_id: "default",
      agent_id: "a1",
      target_modules: ["src/core"],
      target_files: [],
    });

    const depChainConflicts = conflicts.filter(
      (c) => c.type === "dependency_chain" && c.agent_id === "a2"
    );
    expect(depChainConflicts.length).toBeGreaterThanOrEqual(1);
    expect(depChainConflicts.some(c => c.description.includes("src/auth"))).toBe(true);
  });
});



