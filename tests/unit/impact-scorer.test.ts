import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { FileTracker } from "../../src/file-tracker.js";
import { ImpactScorer } from "../../src/impact-scorer.js";
import { Consultation } from "../../src/consultation.js";
import fs from "fs";

const TEST_DIR = "data-test-scorer";
let registry: AgentRegistry;
let tracker: FileTracker;
let scorer: ImpactScorer;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM action_summaries");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
  tracker = new FileTracker();
  scorer = new ImpactScorer(registry, tracker);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ImpactScorer", () => {
  it("scores 100 for same file recently modified", () => {
    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/users"]);
    tracker.log({ session_id: "s1", agent_id: "a2", tool_name: "Edit", file_path: "src/shared/types.ts" });
    const scores = scorer.score({
      agent_id: "a1",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });
    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    expect(a2Score!.score).toBe(100);
    expect(a2Score!.reason).toContain("same file");
  });

  it("scores 80 for depends_on file modified by other agent", () => {
    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/api"]);
    tracker.log({ session_id: "s1", agent_id: "a2", tool_name: "Edit", file_path: "config/jwt.yml" });
    const scores = scorer.score({
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
      depends_on_files: ["config/jwt.yml"],
    });
    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    expect(a2Score!.score).toBe(80);
    expect(a2Score!.reason).toContain("depends on");
  });

  it("scores 30 for module overlap only", () => {
    registry.register("a1", "Agent A", ["src/shared"]);
    registry.register("a2", "Agent B", ["src/shared"]);
    const scores = scorer.score({
      agent_id: "a1",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });
    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    expect(a2Score!.score).toBe(30);
  });

  it("scores 0 for unrelated agent", () => {
    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/users"]);
    const scores = scorer.score({
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
    });
    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    expect(a2Score!.score).toBe(0);
  });

  it("categorizes into concerned, gray_zone, pass", () => {
    registry.register("a1", "Agent A", ["src/shared"]);
    registry.register("a2", "Agent B", ["src/shared"]);
    registry.register("a3", "Agent C", ["src/users"]);
    tracker.log({ session_id: "s1", agent_id: "a2", tool_name: "Edit", file_path: "src/shared/types.ts" });
    const result = scorer.categorize({
      agent_id: "a1",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });
    expect(result.concerned.map(s => s.agent_id)).toContain("a2");  // score 100
    expect(result.pass.map(s => s.agent_id)).toContain("a3");       // score 0
  });

  it("takes highest score when multiple layers match", () => {
    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/shared"]);  // module overlap = 30
    tracker.log({ session_id: "s1", agent_id: "a2", tool_name: "Edit", file_path: "src/shared/types.ts" }); // same file = 100
    const scores = scorer.score({
      agent_id: "a1",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });
    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score!.score).toBe(100);  // highest wins
    expect(a2Score!.reasons.length).toBeGreaterThanOrEqual(2);  // both reasons present
  });

  // â”€â”€ Layer 0 tests (Consultation-based announced intent) â”€â”€

  it("Layer 0a: scores 100 when other agent announced the same target file", () => {
    const consultation = new Consultation();
    const scorerWithConsultation = new ImpactScorer(registry, tracker, consultation);

    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/shared"]);

    // a2 announces work on types.ts
    consultation.announceWork({
      agent_id: "a2",
      subject: "Refactor shared types",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });

    // a1 scores â€” it also targets the same file
    const scores = scorerWithConsultation.score({
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/shared/types.ts"],
    });

    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    expect(a2Score!.score).toBe(100);
    expect(a2Score!.reason).toContain("announced same file");
  });

  it("Layer 0b: scores 80 when other agent announced a file that I depend on", () => {
    const consultation = new Consultation();
    const scorerWithConsultation = new ImpactScorer(registry, tracker, consultation);

    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/shared"]);

    // a2 announces it will modify types.ts as a target
    consultation.announceWork({
      agent_id: "a2",
      subject: "Update types",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });

    // a1 scores â€” it depends on types.ts
    const scores = scorerWithConsultation.score({
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
      depends_on_files: ["src/shared/types.ts"],
    });

    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    expect(a2Score!.score).toBe(80);
    expect(a2Score!.reason).toContain("modifies my dependency");
  });

  it("Layer 0c: scores 80 when other agent depends on a file I am targeting", () => {
    const consultation = new Consultation();
    const scorerWithConsultation = new ImpactScorer(registry, tracker, consultation);

    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/shared"]);

    // a2 announces work that depends on types.ts
    consultation.announceWork({
      agent_id: "a2",
      subject: "Build feature using types",
      target_modules: ["src/shared"],
      target_files: ["src/shared/feature.ts"],
      depends_on_files: ["src/shared/types.ts"],
    });

    // a1 scores â€” it will modify types.ts (what a2 depends on)
    const scores = scorerWithConsultation.score({
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/shared/types.ts"],
    });

    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    expect(a2Score!.score).toBe(80);
    expect(a2Score!.reason).toContain("they depend on my target");
  });

  // â”€â”€ Module prefix matching â”€â”€

  it("module prefix: parent module matches child module (startsWith)", () => {
    registry.register("a1", "Agent A", ["src/auth"]);
    // a2 is registered on the child module
    registry.register("a2", "Agent B", ["src/auth/middleware"]);

    // a1 targets parent â€” should match a2's child
    const scores = scorer.score({
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/auth/login.ts"],
    });

    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    expect(a2Score!.score).toBe(30);
    expect(a2Score!.reason).toContain("module overlap");
  });

  it("module prefix: child module matches parent module (startsWith reverse)", () => {
    registry.register("a1", "Agent A", ["src/auth/middleware"]);
    // a2 is registered on the parent module
    registry.register("a2", "Agent B", ["src/auth"]);

    // a1 targets child â€” should match a2's parent
    const scores = scorer.score({
      agent_id: "a1",
      target_modules: ["src/auth/middleware"],
      target_files: ["src/auth/middleware/jwt.ts"],
    });

    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    expect(a2Score!.score).toBe(30);
    expect(a2Score!.reason).toContain("module overlap");
  });

  // â”€â”€ Edge cases â”€â”€

  it("returns empty array when no other agents are online", () => {
    // Only a1 is registered â€” no peers
    registry.register("a1", "Agent A", ["src/auth"]);

    const scores = scorer.score({
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
    });

    expect(scores).toHaveLength(0);
  });

  it("reason is 'no link detected' when score is 0", () => {
    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/users"]);

    const scores = scorer.score({
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
    });

    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    expect(a2Score!.score).toBe(0);
    expect(a2Score!.reasons).toHaveLength(0);
    expect(a2Score!.reason).toBe("no link detected");
  });

  it("skips Layer 0 gracefully when scorer has no consultation", () => {
    // scorer (no consultation) â€” should not throw and should still compute layers 1-3
    registry.register("a1", "Agent A", ["src/shared"]);
    registry.register("a2", "Agent B", ["src/shared"]);
    tracker.log({ session_id: "s1", agent_id: "a2", tool_name: "Edit", file_path: "src/shared/types.ts" });

    let scores: ReturnType<typeof scorer.score>;
    expect(() => {
      scores = scorer.score({
        agent_id: "a1",
        target_modules: ["src/shared"],
        target_files: ["src/shared/types.ts"],
      });
    }).not.toThrow();

    const a2Score = scores!.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    expect(a2Score!.score).toBe(100); // Layer 1 still fires
  });

  it("Layer 0: handles thread with target_files=null without crashing", () => {
    const consultation = new Consultation();
    const scorerWithConsultation = new ImpactScorer(registry, tracker, consultation);

    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/shared"]);

    // Create a thread then force target_files to null in DB to simulate null/missing data
    const thread = consultation.announceWork({
      agent_id: "a2",
      subject: "Partial announce",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });
    const db = getDb();
    db.prepare("UPDATE threads SET target_files = NULL WHERE id = ?").run(thread.id);

    expect(() => {
      const scores = scorerWithConsultation.score({
        agent_id: "a1",
        target_modules: ["src/auth"],
        target_files: ["src/shared/types.ts"],
      });
      expect(scores).toBeDefined();
    }).not.toThrow();
  });

  it("Layer 0: handles thread with depends_on_files=null without crashing", () => {
    const consultation = new Consultation();
    const scorerWithConsultation = new ImpactScorer(registry, tracker, consultation);

    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/shared"]);

    // Create a thread then force depends_on_files to null in DB
    const thread = consultation.announceWork({
      agent_id: "a2",
      subject: "Announce without deps",
      target_modules: ["src/shared"],
      target_files: ["src/shared/feature.ts"],
    });
    const db = getDb();
    db.prepare("UPDATE threads SET depends_on_files = NULL WHERE id = ?").run(thread.id);

    expect(() => {
      const scores = scorerWithConsultation.score({
        agent_id: "a1",
        target_modules: ["src/auth"],
        target_files: ["src/shared/feature.ts"],
      });
      expect(scores).toBeDefined();
    }).not.toThrow();
  });

  it("Layer 0b: skips depends_on check when params.depends_on_files is undefined", () => {
    const consultation = new Consultation();
    const scorerWithConsultation = new ImpactScorer(registry, tracker, consultation);

    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/shared"]);

    consultation.announceWork({
      agent_id: "a2",
      subject: "Update types",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });

    // No depends_on_files â†’ Layer 0b should be skipped, no crash
    const scores = scorerWithConsultation.score({
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/auth/middleware.ts"],
      // depends_on_files intentionally omitted
    });

    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    // No depends_on overlap possible, so no 80 score from Layer 0b
    expect(a2Score!.reasons.every(r => !r.includes("modifies my dependency"))).toBe(true);
  });

  it("Layer 0b: no score when depends_on does not overlap thread target_files", () => {
    const c = new Consultation();
    const scorerWithConsult = new ImpactScorer(registry, tracker, c);
    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/shared"]);
    // a2 announces work on a specific file
    c.announceWork({
      agent_id: "a2", subject: "Work on shared", target_modules: ["src/shared"], target_files: ["src/shared/utils.ts"],
    });
    // a1 depends on a DIFFERENT file than what a2 targets
    const scores = scorerWithConsult.score({
      agent_id: "a1", target_modules: ["src/auth"], target_files: ["src/auth/login.ts"],
      depends_on_files: ["src/config/env.ts"],
    });
    const a2Score = scores.find(s => s.agent_id === "a2");
    // Should NOT have score 80 from Layer 0b â€” the dependency doesn't overlap
    expect(a2Score).toBeDefined();
    expect(a2Score!.reasons.some(r => r.includes("modifies my dependency"))).toBe(false);
  });

  // â”€â”€ Bug: stale resolved threads cause false positives (Chasseur Bravo) â”€â”€

  it("Layer 0: old resolved threads should not trigger scoring", () => {
    const consultation = new Consultation();
    const scorerWithConsultation = new ImpactScorer(registry, tracker, consultation);

    registry.register("a1", "Agent A", ["src/auth"]);
    registry.register("a2", "Agent B", ["src/shared"]);

    // a2 creates a thread that targets types.ts â€” auto-resolves because a1's
    // modules (src/auth) don't overlap with src/shared.
    const thread = consultation.announceWork({
      agent_id: "a2",
      subject: "Old work on types",
      target_modules: ["src/shared"],
      target_files: ["src/shared/types.ts"],
    });

    // Simulate the thread being from hours ago
    const db = getDb();
    db.prepare("UPDATE threads SET created_at = datetime('now', '-2 hours'), resolved_at = datetime('now', '-2 hours') WHERE id = ?")
      .run(thread.id);

    // a1 now announces work on the same file â€” old resolved thread should NOT trigger score 100
    // BUG: scorer includes ALL resolved threads without time boundary
    const scores = scorerWithConsultation.score({
      agent_id: "a1",
      target_modules: ["src/auth"],
      target_files: ["src/shared/types.ts"],
    });

    const a2Score = scores.find(s => s.agent_id === "a2");
    expect(a2Score).toBeDefined();
    // Old resolved thread should not cause false positive scoring
    const hasStaleReason = a2Score!.reasons.some(r => r.includes("announced same file"));
    expect(hasStaleReason).toBe(false);
  });
});


