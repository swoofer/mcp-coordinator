import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { audit } from "../../src/security/audit.js";
import {
  withAuditContext,
  setActor,
  getCurrentActor,
  getCurrentRequest,
} from "../../src/auth/audit-context.js";
import { withRequestId } from "../../src/auth/request-id.js";

const require = createRequire(import.meta.url);

const DIR = "data-test-audit-tier1";

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
});
beforeEach(() => {
  getDb().exec("DELETE FROM audit_log");
});
afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

interface AuditRow {
  id: number;
  actor_user_id: string | null;
  actor_org_id: string | null;
  action: string;
  target: string | null;
  actor_ip: string | null;
  actor_user_agent: string | null;
  request_id: string | null;
  outcome: string | null;
  metadata_json: string | null;
  created_at: string;
}

describe("audit() Tier 1 sync path", () => {
  it("Tier 1 INSERT is visible from a fresh 2nd connection (proves sync, no batching)", () => {
    audit("auth.test.tier1", { tier: 1 });

    // Open a *separate* better-sqlite3 connection on the same file.
    // If audit() were async-batched, the row would not yet be flushed and the
    // SELECT below would return zero rows.
    const Database = require("better-sqlite3");
    const reader = new Database(path.join(DIR, "coordinator.db"), { readonly: true });
    try {
      const rows = reader.prepare("SELECT * FROM audit_log WHERE action = ?").all("auth.test.tier1") as AuditRow[];
      expect(rows).toHaveLength(1);
    } finally {
      reader.close();
    }
  });

  it("outside withAuditContext: actor + network columns are NULL", () => {
    audit("test.no.context", { tier: 1 });
    const row = getDb().prepare("SELECT * FROM audit_log").get() as AuditRow;
    expect(row.actor_user_id).toBeNull();
    expect(row.actor_org_id).toBeNull();
    expect(row.actor_ip).toBeNull();
    expect(row.actor_user_agent).toBeNull();
  });

  it("inside withAuditContext: actor + network columns populated", () => {
    withAuditContext(
      { userId: "u-42", orgId: "org-7" },
      { ip: "10.0.0.1", userAgent: "essaim/2.0" },
      () => {
        audit("test.with.context", { tier: 1 });
      },
    );
    const row = getDb().prepare("SELECT * FROM audit_log").get() as AuditRow;
    expect(row.actor_user_id).toBe("u-42");
    expect(row.actor_org_id).toBe("org-7");
    expect(row.actor_ip).toBe("10.0.0.1");
    expect(row.actor_user_agent).toBe("essaim/2.0");
  });

  it("inside withRequestId: request_id is the wrapped id", () => {
    withRequestId("req-abc-123", () => {
      audit("test.with.reqid", { tier: 1 });
    });
    const row = getDb().prepare("SELECT * FROM audit_log").get() as AuditRow;
    expect(row.request_id).toBe("req-abc-123");
  });

  it("outside withRequestId: request_id is NULL", () => {
    audit("test.no.reqid", { tier: 1 });
    const row = getDb().prepare("SELECT * FROM audit_log").get() as AuditRow;
    expect(row.request_id).toBeNull();
  });

  it("tier omitted defaults to 2 (sync-fallback today; does not throw)", () => {
    expect(() => audit("test.default.tier")).not.toThrow();
    const row = getDb().prepare("SELECT * FROM audit_log").get() as AuditRow;
    expect(row.action).toBe("test.default.tier");
    // Until T11b, Tier 2 has identical storage shape to Tier 1.
    expect(row.outcome).toBe("success");
  });

  it("metadata is serialized as JSON into metadata_json column", () => {
    audit("test.metadata", {
      tier: 1,
      metadata: { foo: "bar", n: 42, arr: [1, 2] },
    });
    const row = getDb().prepare("SELECT metadata_json FROM audit_log").get() as AuditRow;
    expect(JSON.parse(row.metadata_json!)).toEqual({ foo: "bar", n: 42, arr: [1, 2] });
  });

  it("outcome defaults to 'success' when omitted", () => {
    audit("test.outcome.default", { tier: 1 });
    const row = getDb().prepare("SELECT outcome FROM audit_log").get() as AuditRow;
    expect(row.outcome).toBe("success");
  });

  it("explicit outcome 'denied' is stored as-is", () => {
    audit("test.outcome.denied", { tier: 1, outcome: "denied" });
    const row = getDb().prepare("SELECT outcome FROM audit_log").get() as AuditRow;
    expect(row.outcome).toBe("denied");
  });

  it("target is stored when provided", () => {
    audit("test.target", { tier: 1, target: "thread-xyz" });
    const row = getDb().prepare("SELECT target FROM audit_log").get() as AuditRow;
    expect(row.target).toBe("thread-xyz");
  });

  it("setActor updates actor mid-context: emit, setActor, emit → 2 rows with different actors", () => {
    withAuditContext(
      { userId: "u-before", orgId: "org-x" },
      { ip: "127.0.0.1", userAgent: "ua-1" },
      () => {
        audit("test.before.setactor", { tier: 1 });
        setActor({ userId: "u-after", orgId: "org-y" });
        audit("test.after.setactor", { tier: 1 });
      },
    );
    const rows = getDb()
      .prepare("SELECT action, actor_user_id, actor_org_id FROM audit_log ORDER BY id")
      .all() as Pick<AuditRow, "action" | "actor_user_id" | "actor_org_id">[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: "test.before.setactor",
      actor_user_id: "u-before",
      actor_org_id: "org-x",
    });
    expect(rows[1]).toMatchObject({
      action: "test.after.setactor",
      actor_user_id: "u-after",
      actor_org_id: "org-y",
    });
  });

  it("setActor outside withAuditContext throws", () => {
    expect(() => setActor({ userId: "u-orphan", orgId: "org-orphan" })).toThrow(
      "setActor: no active audit context",
    );
  });

  it("concurrent withAuditContext calls do not bleed", async () => {
    const runOne = (tag: string) =>
      withAuditContext(
        { userId: `u-${tag}`, orgId: `org-${tag}` },
        { ip: `ip-${tag}`, userAgent: `ua-${tag}` },
        async () => {
          await Promise.resolve();
          await new Promise((r) => setTimeout(r, 0));
          // Verify context is still ours after async boundaries.
          expect(getCurrentActor()).toEqual({ userId: `u-${tag}`, orgId: `org-${tag}` });
          expect(getCurrentRequest()).toEqual({ ip: `ip-${tag}`, userAgent: `ua-${tag}` });
          audit(`test.concurrent.${tag}`, { tier: 1 });
        },
      );

    await Promise.all([runOne("alpha"), runOne("bravo")]);

    const rows = getDb()
      .prepare("SELECT action, actor_user_id, actor_org_id, actor_ip FROM audit_log ORDER BY action")
      .all() as Pick<AuditRow, "action" | "actor_user_id" | "actor_org_id" | "actor_ip">[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.action === "test.concurrent.alpha")).toMatchObject({
      actor_user_id: "u-alpha",
      actor_org_id: "org-alpha",
      actor_ip: "ip-alpha",
    });
    expect(rows.find((r) => r.action === "test.concurrent.bravo")).toMatchObject({
      actor_user_id: "u-bravo",
      actor_org_id: "org-bravo",
      actor_ip: "ip-bravo",
    });
  });
});
