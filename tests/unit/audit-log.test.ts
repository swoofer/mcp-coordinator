import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { auditLog } from "../../src/security/audit.js";
import fs from "fs";

const DIR = "data-test-audit";

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

describe("auditLog", () => {
  it("writes a row to audit_log", () => {
    auditLog({ user_id: "u1", org_id: "default", action: "auth.login.success" });
    const rows = getDb().prepare("SELECT * FROM audit_log").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("auth.login.success");
    expect(rows[0].actor_user_id).toBe("u1");
    expect(rows[0].actor_org_id).toBe("default");
  });

  it("accepts null user_id (unauthenticated actions)", () => {
    auditLog({ user_id: null, org_id: "default", action: "auth.login.failure" });
    const row = getDb().prepare("SELECT * FROM audit_log").get() as {
      actor_user_id: string | null;
    };
    expect(row.actor_user_id).toBeNull();
  });

  it("accepts null org_id (unauthenticated, identity not yet established)", () => {
    auditLog({ user_id: null, org_id: null, action: "auth.login.failure" });
    const row = getDb().prepare("SELECT * FROM audit_log").get() as { actor_org_id: string | null };
    expect(row.actor_org_id).toBeNull();
  });

  it("accepts omitted org_id (defaults to null)", () => {
    auditLog({ user_id: null, action: "auth.login.failure" });
    const row = getDb().prepare("SELECT * FROM audit_log").get() as { actor_org_id: string | null };
    expect(row.actor_org_id).toBeNull();
  });

  it("serializes metadata as JSON into metadata_json column", () => {
    auditLog({
      user_id: "u2",
      org_id: "default",
      action: "thread.create",
      target: "thread-abc",
      metadata: { round: 1, agents: ["a", "b"] },
    });
    const row = getDb().prepare("SELECT metadata_json FROM audit_log").get() as {
      metadata_json: string;
    };
    expect(JSON.parse(row.metadata_json)).toEqual({ round: 1, agents: ["a", "b"] });
  });

  it("captures actor_ip and actor_user_agent", () => {
    auditLog({
      user_id: "u3",
      org_id: "default",
      action: "auth.refresh.rotated",
      ip: "127.0.0.1",
      user_agent: "essaim/1.0",
    });
    const row = getDb().prepare("SELECT actor_ip, actor_user_agent FROM audit_log").get() as {
      actor_ip: string;
      actor_user_agent: string;
    };
    expect(row.actor_ip).toBe("127.0.0.1");
    expect(row.actor_user_agent).toBe("essaim/1.0");
  });
});
