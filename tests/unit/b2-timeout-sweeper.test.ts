import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { Consultation } from "../../src/consultation.js";
import { AgentRegistry } from "../../src/agent-registry.js";

let dataDir: string;
let registry: AgentRegistry;
let consultation: Consultation;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "b2-sweeper-"));
  initDatabase(dataDir);
  registry = new AgentRegistry();
  consultation = new Consultation();
  registry.register("default", "a1", "Agent A", ["src/auth"]);
});

afterEach(() => {
  consultation.stopTimeoutSweeper(); // safe even if not started
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("B2 fix - timeout sweeper as background worker (no read side-effect)", () => {
  it("getThread no longer triggers timeout check (bug B2)", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "B2 read no-mutate", target_modules: ["src/auth"], target_files: [],
    });
    const db = getDb();
    db.prepare("UPDATE threads SET created_at=datetime('now', '-5 minutes'), timeout_seconds=1 WHERE id=?").run(thread.id);

    // Read should NOT change status now
    const read1 = consultation.getThread(thread.id);
    expect(read1!.status).toBe("open");

    // Explicit checkTimeouts must transition it
    consultation.checkTimeouts();
    const read2 = consultation.getThread(thread.id);
    expect(read2!.status).toBe("resolved");
  });

  it("listThreads no longer triggers timeout check", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "B2 list no-mutate", target_modules: ["src/auth"], target_files: [],
    });
    const db = getDb();
    db.prepare("UPDATE threads SET created_at=datetime('now', '-5 minutes'), timeout_seconds=1 WHERE id=?").run(thread.id);

    const list1 = consultation.listThreads({});
    expect(list1.find(t => t.id === thread.id)!.status).toBe("open");

    consultation.checkTimeouts();
    const list2 = consultation.listThreads({});
    expect(list2.find(t => t.id === thread.id)!.status).toBe("resolved");
  });

  it("checkTimeouts emits exactly one event per timed-out thread (no double-emit on repeat call)", () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const events: unknown[] = [];
    consultation.onResolve((e) => events.push(e));
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "B2 single-emit", target_modules: ["src/auth"], target_files: [],
    });
    const db = getDb();
    db.prepare("UPDATE threads SET created_at=datetime('now', '-5 minutes'), timeout_seconds=1 WHERE id=?").run(thread.id);

    consultation.checkTimeouts(); // 1 emit
    consultation.checkTimeouts(); // already resolved, 0 emits
    consultation.checkTimeouts(); // still 0

    expect(events).toHaveLength(1);
    expect((events[0] as { resolution_type: string }).resolution_type).toBe("timeout");
  });

  it("startTimeoutSweeper is idempotent (second call is no-op)", () => {
    consultation.startTimeoutSweeper(50);
    consultation.startTimeoutSweeper(50); // should not throw or stack timers
    consultation.stopTimeoutSweeper();
  });

  it("stopTimeoutSweeper is safe to call when sweeper not started", () => {
    expect(() => consultation.stopTimeoutSweeper()).not.toThrow();
  });

  it("background sweeper times out threads on its own (integration)", async () => {
    registry.register("default", "a2", "Agent B", ["src/auth"]);
    const events: unknown[] = [];
    consultation.onResolve((e) => events.push(e));
    const thread = consultation.announceWork({
      agent_id: "a1", subject: "B2 bg sweeper", target_modules: ["src/auth"], target_files: [],
    });
    const db = getDb();
    db.prepare("UPDATE threads SET created_at=datetime('now', '-5 minutes'), timeout_seconds=1 WHERE id=?").run(thread.id);

    consultation.startTimeoutSweeper(50); // tick every 50ms
    // Wait long enough for at least 2 ticks
    await new Promise((r) => setTimeout(r, 200));
    consultation.stopTimeoutSweeper();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(1); // exactly 1, not double-emitted across ticks
    const updated = consultation.getThread(thread.id);
    expect(updated!.status).toBe("resolved");
  });
});

