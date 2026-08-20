import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * issue #359 — two documents claimed the sweeper had "6 retention buckets"
 * while it ran 11 DELETE passes over 9 tables, and five of the seven
 * configurable windows were documented nowhere at all. The undocumented ones
 * were the coordination data: consultation messages and action summaries at 30
 * days, the SSE event feed at 7.
 *
 * The counts were hand-written prose, so they drifted the moment the sweeper
 * grew a pass. These tests derive the truth from src/sweeper/index.ts and fail
 * if the documentation stops matching it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SWEEPER = read("src/sweeper/index.ts");
const SWEEPER_BODY = SWEEPER.slice(SWEEPER.indexOf("private sweepAll"));

/** Tables the sweeper actually deletes from, from the DELETE statements. */
const sweptTables = [...SWEEPER_BODY.matchAll(/DELETE FROM ([a-z0-9_]+)/g)].map((m) => m[1]);

/**
 * Retention keys actually read, from the getOrgSetting callsites. The digit
 * class matters: audit_tier2_retention_days is one of them.
 */
const retentionKeys = [...SWEEPER_BODY.matchAll(/"([a-z0-9_]+_retention_days)"/g)].map((m) => m[1]);

const envVar = (key: string) => `COORDINATOR_${key.toUpperCase()}`;

describe("retention documentation matches the sweeper (#359)", () => {
  const UPGRADE = read("docs/ops/upgrade-phase1-to-phase2.md");
  const README = read("README.md");
  const ONBOARDING = read("docs/onboarding-self-host.md");
  const ENV_EXAMPLE = read(".env.example");

  it("the sweeper is the shape the docs claim", () => {
    // Guards the numbers written in prose. If this fails, the sweeper changed
    // and both documents need the new figures -- that is the point.
    expect(sweptTables).toHaveLength(11);
    expect(new Set(sweptTables).size).toBe(9);
    expect(new Set(retentionKeys).size).toBe(8);
  });

  it("the bucket table names every table the sweeper touches", () => {
    const section = UPGRADE.slice(UPGRADE.indexOf("### Sweeper retention bucket choice"));
    for (const table of new Set(sweptTables)) {
      expect(section, `${table} missing from the bucket table`).toContain(table);
    }
  });

  it("every configurable window is documented as an env var", () => {
    // .env.example is the reference every other doc points at, so a window
    // that is settable but absent there is settable by nobody.
    for (const key of new Set(retentionKeys)) {
      expect(ENV_EXAMPLE, `${envVar(key)} missing from .env.example`).toContain(envVar(key));
    }
  });

  it("the five coordination windows are surfaced where a self-hoster will look", () => {
    // These are the ones #359 found undocumented. The auth windows were
    // already covered by the Phase 2 guide; these belong in the README,
    // because they apply whether or not you ever enable auth.
    const coordination = [
      "file_activity_retention_days",
      "events_retention_days",
      "thread_messages_retention_days",
      "action_summaries_retention_days",
      "layer_firings_retention_days",
    ];
    // Sanity: these must still be windows the sweeper reads.
    expect(coordination.every((k) => retentionKeys.includes(k))).toBe(true);

    for (const key of coordination) {
      expect(README, `${envVar(key)} missing from the README`).toContain(envVar(key));
      expect(ONBOARDING, `${envVar(key)} missing from the onboarding guide`).toContain(envVar(key));
    }
  });

  it("no document still claims six buckets", () => {
    for (const [name, doc] of [
      ["upgrade guide", UPGRADE],
      ["onboarding guide", ONBOARDING],
    ] as const) {
      expect(doc, `${name} still says six`).not.toMatch(/6 retention (buckets|tables)/);
      expect(doc, `${name} still says six`).not.toMatch(/over 6 retention/);
    }
  });

  it("the README's never-swept claim holds", () => {
    // The README tells readers that a thread's decision outlives its
    // messages. That is only true while `threads` stays out of the sweeper.
    expect(sweptTables).not.toContain("threads");
    expect(sweptTables).toContain("thread_messages");
    for (const table of ["git_cochange", "dependency_map", "agents"]) {
      expect(sweptTables, `${table} is swept -- the README says it is not`).not.toContain(table);
    }
  });
});
