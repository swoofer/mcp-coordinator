import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { Consultation } from "../../src/consultation.js";
import { DependencyMapper } from "../../src/dependency-map.js";
import { ConflictDetector } from "../../src/conflict-detector.js";
import { FileTracker } from "../../src/file-tracker.js";
import type { DependencyMap } from "../../src/types.js";
import fs from "fs";

/**
 * issue #366 — detect() is on the hot path of announce_work, and it re-read the
 * whole dependency_map once per (thread × target module).
 *
 * The cost is invisible on an empty map: getModuleInfo returns null, the
 * `continue` short-circuits the expensive half, and detect() measures in
 * milliseconds. Every existing test in the suite is in that state, which is
 * exactly why this went unnoticed — so this file populates the map first.
 *
 * The assertion counts table reads rather than wall-clock. A timing threshold
 * would be flaky on a loaded machine and would say nothing about *why* it got
 * faster; the scan count is the defect itself.
 */
const TEST_DIR = "data-test-conflicts-perf";
const MODULES = 60;
const THREADS = 12;

let registry: AgentRegistry;
let consultation: Consultation;
let depMap: DependencyMapper;
let fileTracker: FileTracker;
let detector: ConflictDetector;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  for (const t of [
    "events",
    "thread_messages",
    "threads",
    "file_activity",
    "dependency_map",
    "agents",
  ]) {
    db.exec(`DELETE FROM ${t}`);
  }
  registry = new AgentRegistry();
  consultation = new Consultation();
  depMap = new DependencyMapper();
  fileTracker = new FileTracker();
  detector = new ConflictDetector(consultation, depMap, fileTracker);

  // A populated map: each module depends on the three before it, so the blast
  // radius of an early module reaches most of the graph.
  const map: DependencyMap = {};
  for (let i = 0; i < MODULES; i++) {
    const deps: string[] = [];
    for (let k = 1; k <= 3; k++) if (i - k >= 0) deps.push(`mod-${i - k}`);
    map[`mod-${i}`] = { module_id: `mod-${i}`, depends_on: deps, exports: [], owners: [] };
  }
  depMap.setMap("default", map);

  registry.register("default", "announcer", "Announcer", []);
  for (let t = 0; t < THREADS; t++) {
    registry.register("default", `peer-${t}`, `Peer ${t}`, []);
    consultation.announceWork("default", {
      agent_id: `peer-${t}`,
      subject: `work ${t}`,
      target_modules: [`mod-${t + 5}`],
      target_files: [],
    });
  }
});

describe("detect() cost against a populated dependency map (#366)", () => {
  it("reads dependency_map a bounded number of times, not threads x modules", () => {
    const targets = ["mod-1", "mod-2", "mod-3", "mod-4", "mod-5"];

    let getMapCalls = 0;
    const realGetMap = depMap.getMap.bind(depMap);
    depMap.getMap = (orgId: string) => {
      getMapCalls++;
      return realGetMap(orgId);
    };

    detector.detect({
      org_id: "default",
      agent_id: "announcer",
      target_modules: targets,
      target_files: [],
    });

    depMap.getMap = realGetMap;

    // One read per target module is the shape after the hoist. Before it, the
    // call sat inside the thread loop: 12 threads x 5 modules = 60 reads of the
    // full table. The bound is deliberately generous -- what must never come
    // back is growth with the number of open threads.
    expect(getMapCalls).toBeLessThanOrEqual(targets.length);
  });

  it("still reports the dependency-chain conflicts it did before", () => {
    // peer-5 announced mod-10, which depends on mod-7..mod-9; mod-5 is in the
    // transitive blast radius of mod-2. The hoist must not change what is found.
    const result = detector.detect({
      org_id: "default",
      agent_id: "announcer",
      target_modules: ["mod-2"],
      target_files: [],
    });

    const chain = result.filter((c) => c.type === "dependency_chain");
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every((c) => c.agent_id !== "announcer")).toBe(true);
  });
});
