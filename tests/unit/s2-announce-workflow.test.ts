import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDb } from "../../src/database.js";
import { createServices, type CoordinatorServices } from "../../src/server-setup.js";
import { runCommonAnnounceFlow } from "../../src/announce-workflow.js";

let dataDir: string;
let services: CoordinatorServices;

// P3: SseEmitter now fans out via setImmediate so listeners don't block
// emit() or each other. Tests that subscribe-then-emit-then-assert must
// drain the queue before reading.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "s2-announce-"));
  services = createServices({ dataDir });
});

afterEach(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("S2 fix - runCommonAnnounceFlow extracts shared orchestration", () => {
  it("auto-resolves when initiator is alone", () => {
    services.registry.register("default", "a1", "Agent A", ["src/auth"]);
    const thread = services.consultation.announceWork("default", {
      agent_id: "a1", subject: "alone", target_modules: ["src/auth"], target_files: [],
    });
    const result = runCommonAnnounceFlow(services, thread.id, {
      org_id: "default", agent_id: "a1", subject: "alone", target_modules: ["src/auth"], target_files: [],
    });
    expect(result.updated.status).toBe("resolved");
    expect(result.respondents).toEqual([]);
    expect(result.categorized.concerned).toHaveLength(0);
  });

  it("keeps thread open and scorer flags concerned agents on file overlap", () => {
    services.registry.register("default", "a1", "Agent A", ["src/auth"]);
    services.registry.register("default", "a2", "Agent B", ["src/auth"]);
    // First, a2 announces work on a file — this populates file_activity so
    // a1's subsequent announce sees the overlap as Layer 0 (score 100 = concerned).
    services.consultation.announceWork("default", {
      agent_id: "a2", subject: "a2 first", target_modules: ["src/auth"], target_files: ["src/auth/types.ts"],
      keep_open: true, // keep open so we can match against it
    });

    const thread = services.consultation.announceWork("default", {
      agent_id: "a1", subject: "a1 then", target_modules: ["src/auth"], target_files: ["src/auth/types.ts"],
    });
    const result = runCommonAnnounceFlow(services, thread.id, {
      org_id: "default", agent_id: "a1", subject: "a1 then", target_modules: ["src/auth"], target_files: ["src/auth/types.ts"],
    });
    expect(result.updated.status).toBe("open");
    expect(result.respondents).toContain("a2");
  });

  it("emits impact_scored SSE for every scored agent", async () => {
    services.registry.register("default", "a1", "Agent A", ["src/auth"]);
    services.registry.register("default", "a2", "Agent B", ["src/auth"]);
    services.registry.register("default", "a3", "Agent C", ["src/web"]);
    const events: { type: string; payload: string }[] = [];
    services.sseEmitter.addListener("default", (e) => events.push({ type: e.type, payload: e.payload }));

    const thread = services.consultation.announceWork("default", {
      agent_id: "a1", subject: "scored", target_modules: ["src/auth"], target_files: [],
    });
    runCommonAnnounceFlow(services, thread.id, {
      org_id: "default", agent_id: "a1", subject: "scored", target_modules: ["src/auth"], target_files: [],
    });

    await flush();
    const impactEvents = events.filter((e) => e.type === "impact_scored");
    // a2 (gray_zone via module match) and a3 (pass, no overlap) both get scored events.
    expect(impactEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("does not auto-resolve when keep_open=true even if alone", () => {
    services.registry.register("default", "a1", "Agent A", ["src/auth"]);
    const thread = services.consultation.announceWork("default", {
      agent_id: "a1", subject: "keep", target_modules: ["src/auth"], target_files: [], keep_open: true,
    });
    const result = runCommonAnnounceFlow(services, thread.id, {
      org_id: "default", agent_id: "a1", subject: "keep", target_modules: ["src/auth"], target_files: [], keep_open: true,
    });
    expect(result.updated.status).toBe("open");
  });

  it("returns plan quality assessment", () => {
    services.registry.register("default", "a1", "Agent A", ["src/auth"]);
    const thread = services.consultation.announceWork("default", {
      agent_id: "a1", subject: "with plan", plan: "do something", target_modules: ["src/auth"], target_files: [],
    });
    const result = runCommonAnnounceFlow(services, thread.id, {
      org_id: "default", agent_id: "a1", subject: "with plan", plan: "do something", target_modules: ["src/auth"], target_files: [],
    });
    expect(result.planQuality).toBeDefined();
    expect(result.planQuality.mode).toBeDefined();
  });

  it("emits plan-quality downgrade event when plan is vague", async () => {
    services.registry.register("default", "a1", "Agent A", ["src/auth"]);
    const events: { type: string; payload: string }[] = [];
    services.sseEmitter.addListener("default", (e) => events.push({ type: e.type, payload: e.payload }));

    const thread = services.consultation.announceWork("default", {
      agent_id: "a1", subject: "vague", plan: "do thing", target_modules: ["src/auth"], target_files: [],
    });
    runCommonAnnounceFlow(services, thread.id, {
      org_id: "default", agent_id: "a1", subject: "vague", plan: "do thing", target_modules: ["src/auth"], target_files: [],
    });

    await flush();
    const downgrade = events.find((e) => {
      if (e.type !== "impact_scored") return false;
      const parsed = JSON.parse(e.payload) as { category?: string };
      return parsed.category === "plan_quality";
    });
    expect(downgrade).toBeDefined();
  });
});

