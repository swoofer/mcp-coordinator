import { describe, it, expect } from "vitest";
import { TIER1_EVENTS, TIER2_EVENTS } from "../../src/security/audit-events.js";

/**
 * Tier-classification registry tests.
 *
 * The audit_log table has no `tier` column; the retention sweeper and the
 * Tier-1 sync emission path both classify rows by the `action` string against
 * TIER1_EVENTS / TIER2_EVENTS. New admin-* events (v0.10.6 T02) must be
 * registered here as Tier 1 so handlers landing in T05/T06 emit them on the
 * sync, never-drop path.
 */

describe("audit-events tier registry", () => {
  it("contains all v0.10.6 admin UI events as Tier 1", () => {
    const required = [
      "admin.org.created",
      "admin.org.updated",
      "admin.user.role_changed",
      "admin.orgs.duplicate_names_accepted",
    ];
    for (const ev of required) {
      expect(TIER1_EVENTS).toContain(ev);
    }
  });

  it("does not double-classify an event in both Tier 1 and Tier 2", () => {
    const overlap = TIER1_EVENTS.filter((e) => (TIER2_EVENTS as readonly string[]).includes(e));
    expect(overlap).toEqual([]);
  });

  it("has no duplicate entries within each tier", () => {
    expect(new Set(TIER1_EVENTS).size).toBe(TIER1_EVENTS.length);
    expect(new Set(TIER2_EVENTS).size).toBe(TIER2_EVENTS.length);
  });
});
