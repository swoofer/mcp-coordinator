import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { WorkingFilesTracker } from "../../src/working-files-tracker.js";
import { seedTestOrgs } from "../helpers/orgs.js";

/**
 * issue #371 — the README described the coordinator as doing "coordination"
 * and said nothing about what a working_files claim actually guarantees. It
 * guarantees nothing: two agents can hold the same file, the claim cannot be
 * refused, and no verdict blocks a write. That is a deliberate design (the v0.6
 * spec pins `200 { ok: true }` as the contract) but it lived only in an
 * internal spec, so a user's reasonable reading was the wrong one.
 *
 * Documenting a property makes it a promise. These tests hold the code to it,
 * so the docs cannot quietly become false.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the advisory-claim documentation matches the code (#371)", () => {
  it("a file can be claimed by more than one agent at a time", () => {
    // The whole advisory model rests on this. Demonstrated through the real
    // API rather than asserted against the DDL: the base schema in
    // database.ts says PRIMARY KEY (agent_id, file_path), but a migration
    // rebuilt the table with org_id in the key, so any text match on the
    // stored SQL tests the wrong thing.
    const dir = mkdtempSync(join(tmpdir(), "advisory-"));
    try {
      closeDb();
    } catch {
      /* nothing open */
    }
    initDatabase(dir);
    const db = getDb();
    seedTestOrgs(db, ["default"]);

    const tracker = new WorkingFilesTracker();
    tracker.start("default", "agent-a", "src/shared.ts", 30);
    tracker.start("default", "agent-b", "src/shared.ts", 30);

    const holders = db
      .prepare("SELECT agent_id FROM working_files WHERE file_path = ?")
      .all("src/shared.ts") as Array<{ agent_id: string }>;
    expect(holders.map((h) => h.agent_id).sort()).toEqual(["agent-a", "agent-b"]);

    // And the index hands back a set of holders, not a single owner.
    const index = tracker.getIndex("default", ["src/shared.ts"], "nobody");
    expect(index.get("src/shared.ts")?.size).toBe(2);

    closeDb();
  });

  it("starting a claim cannot report a refusal", () => {
    // A signature that returns void has nowhere to put "no". If this ever
    // becomes a boolean or throws, the documented promise changed.
    const tracker = read("src/working-files-tracker.ts");
    expect(tracker).toMatch(/start\([^)]*\): void/s);
  });

  it("there is no way to take a claim away from another agent", () => {
    // The docs say an abandoned claim ages out rather than being revoked, so
    // no client-reachable surface may grow a force-release.
    for (const file of [
      "src/http/rest-handlers.ts",
      "src/working-files-tracker.ts",
      "src/tools/files-tools.ts",
      "docs/openapi.yaml",
    ]) {
      expect(read(file), `${file} exposes a force-release`).not.toContain("force_release");
    }
  });

  it("the README and the usage guide both state the advisory property", () => {
    const readme = read("README.md");
    const usage = read("docs/usage.md");
    expect(readme).toContain("File claims are advisory");
    expect(usage).toContain("It does not stop them");
    // The permission half of the same surprise.
    expect(readme).toContain("mcp__coordinator__*");
    expect(usage).toContain("does not auto-approve MCP tools");
  });

  it("the README's cross-links resolve to real headings", () => {
    const usage = read("docs/usage.md");
    const readme = read("README.md");
    const anchors = [...readme.matchAll(/\.\/docs\/usage\.md#([a-z0-9_-]+)/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(0);

    const slugs = [...usage.matchAll(/^#{2,3} (.+)$/gm)].map((m) =>
      m[1]
        .toLowerCase()
        .replace(/`/g, "")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s/g, "-"),
    );
    for (const anchor of anchors) {
      expect(slugs, `README links to #${anchor}, which no heading produces`).toContain(anchor);
    }
  });
});
