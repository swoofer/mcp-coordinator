import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import {
  FakeClock,
  IdGen,
  drainAuditQueue,
  findAuditRows,
  expectAuditRow,
  openReadCommitted,
  rawFetch,
  seedFourOrgs,
  createMockIdp,
  setupGitHubMsw,
} from "../helpers/index.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import {
  audit,
  initAuditQueue,
  resetAuditQueue,
} from "../../src/security/audit.js";
import type { Clock } from "../../src/auth/clock.js";

const require = createRequire(import.meta.url);
const DatabaseCtor = require("better-sqlite3") as new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => Database.Database;

describe("FakeClock", () => {
  it("starts at default 1_000_000 and now() returns it", () => {
    const c = new FakeClock();
    expect(c.now()).toBe(1_000_000);
  });

  it("advance() adds seconds; set() overrides absolute", () => {
    const c = new FakeClock();
    c.advance(60);
    expect(c.now()).toBe(1_000_060);
    c.set(2_000_000);
    expect(c.now()).toBe(2_000_000);
  });

  it("satisfies the Clock interface (compile-time + runtime)", () => {
    // Compile-time: TypeScript widening to Clock fails if FakeClock doesn't
    // implement the interface. Runtime: assert .now() is a function.
    const c: Clock = new FakeClock();
    expect(typeof c.now).toBe("function");
    expect(c.now()).toBe(1_000_000);
  });
});

describe("IdGen", () => {
  it("generates sequential padded ids with default prefix", () => {
    const g = new IdGen();
    expect(g.next()).toBe("test-000001");
    expect(g.next()).toBe("test-000002");
    expect(g.next()).toBe("test-000003");
  });

  it("respects a custom prefix", () => {
    const g = new IdGen("user");
    expect(g.next()).toBe("user-000001");
  });

  it("reset() returns the counter to 0 so the next() emits ...001", () => {
    const g = new IdGen();
    g.next();
    g.next();
    g.reset();
    expect(g.next()).toBe("test-000001");
  });
});

const DIR = "data-test-helpers";

describe("audit helpers", () => {
  beforeAll(() => {
    fs.mkdirSync(DIR, { recursive: true });
    initDatabase(DIR);
  });
  beforeEach(() => {
    getDb().exec("DELETE FROM audit_log");
    resetAuditQueue();
  });
  afterAll(() => {
    resetAuditQueue();
    closeDb();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it("drainAuditQueue() returns null when no queue is initialized", () => {
    expect(drainAuditQueue()).toBeNull();
  });

  it("drainAuditQueue() returns metrics when queue is initialized", () => {
    initAuditQueue(getDb() as unknown as Database.Database);
    const metrics = drainAuditQueue();
    expect(metrics).not.toBeNull();
    expect(metrics?.enqueued).toBe(0);
    expect(metrics?.flushed).toBe(0);
  });

  it("findAuditRows() returns rows matching action", () => {
    // Tier 1 = sync direct insert, no queue needed.
    audit("helpers.test.action", { tier: 1, target: "t1" });
    audit("helpers.test.action", { tier: 1, target: "t2" });
    audit("other.action", { tier: 1 });
    const rows = findAuditRows("helpers.test.action");
    expect(rows.length).toBe(2);
    expect(rows[0].target).toBe("t1");
    expect(rows[1].target).toBe("t2");
  });

  it("expectAuditRow() throws when action has no matching row", () => {
    expect(() => expectAuditRow("nonexistent.action", { outcome: "success" })).toThrow(
      /No audit row with action="nonexistent.action"/,
    );
  });

  it("expectAuditRow() throws when a field mismatches", () => {
    audit("helpers.mismatch.action", { tier: 1, outcome: "success" });
    expect(() =>
      expectAuditRow("helpers.mismatch.action", { outcome: "failure" }),
    ).toThrow(/Audit row mismatch on outcome/);
  });

  it("expectAuditRow() succeeds when latest row matches", () => {
    audit("helpers.match.action", { tier: 1, outcome: "success", target: "x" });
    expect(() =>
      expectAuditRow("helpers.match.action", { outcome: "success", target: "x" }),
    ).not.toThrow();
  });
});

describe("openReadCommitted", () => {
  const ORC_DIR = "data-test-helpers-orc";
  let dbPath: string;

  beforeAll(() => {
    fs.mkdirSync(ORC_DIR, { recursive: true });
    initDatabase(ORC_DIR);
    dbPath = path.join(ORC_DIR, "coordinator.db");
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(ORC_DIR, { recursive: true, force: true });
  });

  it("opens a 2nd connection that sees data committed via the primary handle", () => {
    // Write via the primary connection (better-sqlite3 auto-commits run()).
    getDb()
      .prepare("INSERT INTO audit_log (action, outcome) VALUES (?, ?)")
      .run("helpers.orc.test", "success");

    const ro = openReadCommitted(dbPath);
    try {
      const rows = ro
        .prepare("SELECT action, outcome FROM audit_log WHERE action = ?")
        .all("helpers.orc.test") as Array<{ action: string; outcome: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0].outcome).toBe("success");
    } finally {
      ro.close();
    }
  });
});

describe("rawFetch", () => {
  it("calls global fetch with the supplied method/url/headers/body", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

    const res = await rawFetch("POST", "https://example.test/x", {
      headers: { "x-custom": "v" },
      body: "payload",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://example.test/x");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toEqual({ "x-custom": "v" });
    expect((init as RequestInit).body).toBe("payload");
    expect(res.status).toBe(200);

    spy.mockRestore();
  });
});

describe("seedFourOrgs", () => {
  const SEED_DIR = "data-test-helpers-seed";

  beforeAll(() => {
    fs.mkdirSync(SEED_DIR, { recursive: true });
    initDatabase(SEED_DIR);
  });
  beforeEach(() => {
    // Clear only the seeded rows — other suites' DELETE FROM patterns rely on
    // having FK-clean state, so we touch users + orgs explicitly.
    getDb().exec("DELETE FROM user_orgs");
    getDb().exec("DELETE FROM users");
    getDb().exec("DELETE FROM orgs WHERE id != 'default'");
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(SEED_DIR, { recursive: true, force: true });
  });

  it("creates 4 orgs and 8 users with deterministic ids", () => {
    const result = seedFourOrgs(getDb() as unknown as Database.Database);
    expect(result.length).toBe(4);
    expect(result[0].orgId).toBe("org-acme-001");
    expect(result[3].orgId).toBe("org-delta-004");

    const orgCount = (getDb()
      .prepare("SELECT COUNT(*) AS n FROM orgs WHERE id LIKE 'org-%'")
      .get() as { n: number }).n;
    expect(orgCount).toBe(4);

    const userCount = (getDb()
      .prepare("SELECT COUNT(*) AS n FROM users")
      .get() as { n: number }).n;
    expect(userCount).toBe(8);

    // Spot-check role assignment.
    const adminRole = (getDb()
      .prepare("SELECT role FROM users WHERE id = ?")
      .get("u-admin-acme") as { role: string }).role;
    expect(adminRole).toBe("admin");

    const memberRole = (getDb()
      .prepare("SELECT role FROM users WHERE id = ?")
      .get("u-member-beta") as { role: string }).role;
    expect(memberRole).toBe("member");
  });

  it("is idempotent: second call doesn't error or duplicate rows", () => {
    seedFourOrgs(getDb() as unknown as Database.Database);
    seedFourOrgs(getDb() as unknown as Database.Database);
    const orgCount = (getDb()
      .prepare("SELECT COUNT(*) AS n FROM orgs WHERE id LIKE 'org-%'")
      .get() as { n: number }).n;
    const userCount = (getDb()
      .prepare("SELECT COUNT(*) AS n FROM users")
      .get() as { n: number }).n;
    expect(orgCount).toBe(4);
    expect(userCount).toBe(8);
  });
});

describe("createMockIdp / setupGitHubMsw", () => {
  it("exposes the fluent facade and installs handlers on a server", async () => {
    const server = setupGitHubMsw();
    server.listen({ onUnhandledRequest: "error" });
    try {
      createMockIdp()
        .respondTokenWith({ access_token: "tok-helpers", token_type: "bearer" })
        .respondUserWith({ id: 99, login: "helpers", email: "helpers@x", name: "H" })
        .apply(server);

      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
      });
      expect(tokenRes.status).toBe(200);
      const tokenBody = (await tokenRes.json()) as { access_token: string };
      expect(tokenBody.access_token).toBe("tok-helpers");

      const userRes = await fetch("https://api.github.com/user");
      const userBody = (await userRes.json()) as { login: string };
      expect(userBody.login).toBe("helpers");
    } finally {
      server.close();
    }
  });

  it("failNextN flips status for N calls then reverts to defaults", async () => {
    const server = setupGitHubMsw();
    server.listen({ onUnhandledRequest: "error" });
    try {
      createMockIdp().failNextN("token", 2, 503).apply(server);

      const r1 = await fetch("https://github.com/login/oauth/access_token", { method: "POST" });
      expect(r1.status).toBe(503);
      const r2 = await fetch("https://github.com/login/oauth/access_token", { method: "POST" });
      expect(r2.status).toBe(503);
      const r3 = await fetch("https://github.com/login/oauth/access_token", { method: "POST" });
      expect(r3.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
