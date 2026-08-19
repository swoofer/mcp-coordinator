import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { audit } from "../../src/security/audit.js";
import { seedTestOrgs } from "../helpers/orgs.js";

/**
 * issue #317 — the Tier 1 chain write claimed to be wrapped in IMMEDIATE and
 * was wrapped in nothing: the tip SELECT and the INSERT were two separate
 * implicit transactions.
 *
 * The nesting case is the one that makes a naive fix wrong. handle-admin-users,
 * handle-admin-orgs, oauth-finalize and consultation all emit Tier 1 rows from
 * inside their own transaction, so anything that issues a bare BEGIN here would
 * throw on the common path rather than the rare one.
 */
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "audit-atomic-"));
  initDatabase(dataDir);
  seedTestOrgs(getDb(), ["org-a"]);
});

afterEach(() => {
  closeDb();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite handle briefly after close; treated as noise
    // elsewhere in the suite too.
  }
});

function chainIsIntact(): boolean {
  const rows = getDb()
    .prepare("SELECT prev_hash, row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY id ASC")
    .all() as Array<{ prev_hash: string; row_hash: string }>;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].prev_hash !== rows[i - 1].row_hash) return false;
  }
  return rows.length > 0;
}

describe("Tier 1 audit chain write (#317)", () => {
  // The one assertion that actually fails without the fix. A concurrent
  // second process cannot be simulated in-process -- the driver is
  // synchronous and nothing can interleave -- so the property under test is
  // structural: the tip SELECT and the INSERT must be issued inside a
  // transaction, not as two implicit ones.
  it("issues the tip read and the insert inside one transaction", () => {
    const db = getDb() as unknown as {
      transaction: <T>(fn: () => T) => () => T;
      prepare: (sql: string) => unknown;
    };
    const realTransaction = db.transaction.bind(db);
    const realPrepare = db.prepare.bind(db);

    let depth = 0;
    let sawTipRead = false;
    let sawInsert = false;

    db.transaction = <T>(fn: () => T) => {
      const wrapped = realTransaction(() => {
        depth++;
        try {
          return fn();
        } finally {
          depth--;
        }
      });
      return wrapped;
    };
    db.prepare = (sql: string) => {
      if (depth > 0 && sql.includes("SELECT row_hash FROM audit_log")) sawTipRead = true;
      if (depth > 0 && sql.includes("INSERT INTO audit_log")) sawInsert = true;
      return realPrepare(sql);
    };

    try {
      audit("config.boot", { tier: 1, metadata: { n: 1 } });
    } finally {
      db.transaction = realTransaction;
      db.prepare = realPrepare;
    }

    expect(sawTipRead).toBe(true);
    expect(sawInsert).toBe(true);
  });

  it("writes a linked chain for successive emissions", () => {
    audit("config.boot", { tier: 1, metadata: { n: 1 } });
    audit("config.boot", { tier: 1, metadata: { n: 2 } });
    audit("config.boot", { tier: 1, metadata: { n: 3 } });

    const count = (getDb().prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
    expect(count).toBe(3);
    expect(chainIsIntact()).toBe(true);
  });

  // The regression that matters: a caller transaction must still be able to
  // emit. Every admin mutation in this repo does exactly this.
  it("emits from inside a caller's transaction without throwing", () => {
    const db = getDb();
    const tx = db.transaction(() => {
      audit("admin.org.created", { tier: 1, metadata: { org_id: "org-a" } });
      audit("admin.org.updated", { tier: 1, metadata: { org_id: "org-a" } });
      return "done";
    });

    expect(() => tx()).not.toThrow();
    const count = (getDb().prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
    expect(count).toBe(2);
    expect(chainIsIntact()).toBe(true);
  });

  // A caller transaction that rolls back must not leave the audit row behind:
  // that is what being inside the same transaction means, and it is why the
  // write cannot open an independent one of its own.
  it("a rolled-back caller transaction takes its audit row with it", () => {
    const db = getDb();
    const tx = db.transaction(() => {
      audit("admin.org.created", { tier: 1, metadata: { org_id: "org-a" } });
      throw new Error("caller aborts");
    });

    expect(() => tx()).toThrow("caller aborts");
    const count = (getDb().prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
