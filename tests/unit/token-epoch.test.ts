import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  readTokenEpoch,
  bumpTokenEpoch,
  bumpTokenEpochAllUsers,
  setTokenEpochBus,
  noteEpochBump,
  getEpochFloor,
  resetEpochFloorForTest,
  type TokenEpochBus,
} from "../../src/auth/token-epoch.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id           TEXT PRIMARY KEY,
      token_epoch  INTEGER NOT NULL DEFAULT 0
    );
  `);
});

afterEach(() => {
  db.close();
});

describe("readTokenEpoch", () => {
  it("returns 0 for a fresh user (default value)", () => {
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u1");
    expect(readTokenEpoch(db, "u1")).toBe(0);
  });

  it("returns the stored value after a bump", () => {
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u1");
    const bumped = bumpTokenEpoch(db, "u1");
    expect(readTokenEpoch(db, "u1")).toBe(bumped);
  });

  it("returns 0 for a non-existent user (no row -> ?? 0)", () => {
    expect(readTokenEpoch(db, "ghost")).toBe(0);
  });
});

describe("bumpTokenEpoch", () => {
  it("increments monotonically (second call > first)", () => {
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u1");
    const first = bumpTokenEpoch(db, "u1");
    const second = bumpTokenEpoch(db, "u1");
    expect(second).toBeGreaterThan(first);
  });

  it("is NTP-safe: pre-set far-future epoch stays monotonic (current+1, not wall-clock)", () => {
    const future = 9999999999;
    db.prepare("INSERT INTO users (id, token_epoch) VALUES (?, ?)").run("u1", future);
    const bumped = bumpTokenEpoch(db, "u1");
    expect(bumped).toBe(future + 1);
  });

  it("throws when userId doesn't exist", () => {
    expect(() => bumpTokenEpoch(db, "missing")).toThrow(/user not found/);
  });

  it("followed immediately by readTokenEpoch returns the bumped value (txn visibility)", () => {
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u1");
    const bumped = bumpTokenEpoch(db, "u1");
    expect(readTokenEpoch(db, "u1")).toBe(bumped);
  });
});

describe("bumpTokenEpochAllUsers", () => {
  it("updates ALL rows and returns count", () => {
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u1");
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u2");
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u3");
    const changed = bumpTokenEpochAllUsers(db);
    expect(changed).toBe(3);
    expect(readTokenEpoch(db, "u1")).toBeGreaterThan(0);
    expect(readTokenEpoch(db, "u2")).toBeGreaterThan(0);
    expect(readTokenEpoch(db, "u3")).toBeGreaterThan(0);
  });

  it("is NTP-safe on each row (mix of low and far-future epochs)", () => {
    const future = 9999999999;
    db.prepare("INSERT INTO users (id, token_epoch) VALUES (?, ?)").run("low", 0);
    db.prepare("INSERT INTO users (id, token_epoch) VALUES (?, ?)").run("future", future);
    bumpTokenEpochAllUsers(db);
    // "low" row -> takes wall-clock seconds (much larger than 0+1)
    const lowEpoch = readTokenEpoch(db, "low");
    expect(lowEpoch).toBeGreaterThan(1_000_000_000); // sane wall-clock
    // "future" row -> stays monotonic at future+1 (wall-clock can't beat it)
    expect(readTokenEpoch(db, "future")).toBe(future + 1);
  });

  it("returns 0 when there are no users", () => {
    expect(bumpTokenEpochAllUsers(db)).toBe(0);
  });
});

// ── Phase 5 multi-instance: epoch bump pub/sub ──────────────────────────────
//
// setTokenEpochBus / noteEpochBump / getEpochFloor / resetEpochFloorForTest
// and the publish-side seam (exercised indirectly via bumpTokenEpoch /
// bumpTokenEpochAllUsers, since publishBump itself isn't exported).

class FakeBus implements TokenEpochBus {
  calls: Array<{ userId: string; epoch: number }> = [];
  throwOnPublish = false;
  publish(userId: string, epoch: number): void {
    if (this.throwOnPublish) throw new Error("bus unavailable");
    this.calls.push({ userId, epoch });
  }
}

afterEach(() => {
  // The bus and floor are module-level singletons — never leak between
  // tests (this suite's cases and token-epoch-floor.test.ts both mutate
  // them).
  setTokenEpochBus(null);
  resetEpochFloorForTest();
});

describe("noteEpochBump / getEpochFloor", () => {
  beforeEach(() => {
    resetEpochFloorForTest();
  });

  it("getEpochFloor is 0 for an unknown user with no bumps observed", () => {
    expect(getEpochFloor("nobody")).toBe(0);
  });

  it("records a per-user floor", () => {
    noteEpochBump("user-1", 5);
    expect(getEpochFloor("user-1")).toBe(5);
    // Unrelated user unaffected.
    expect(getEpochFloor("user-2")).toBe(0);
  });

  it("is monotonic per-user: a lower epoch does not lower the floor", () => {
    noteEpochBump("user-1", 10);
    noteEpochBump("user-1", 3);
    expect(getEpochFloor("user-1")).toBe(10);
  });

  it("a higher epoch raises the floor", () => {
    noteEpochBump("user-1", 3);
    noteEpochBump("user-1", 10);
    expect(getEpochFloor("user-1")).toBe(10);
  });

  it('the "*" sentinel sets the GLOBAL floor, applied to every user', () => {
    noteEpochBump("*", 42);
    expect(getEpochFloor("user-1")).toBe(42);
    expect(getEpochFloor("anyone")).toBe(42);
  });

  it('the "*" sentinel is also monotonic (never decreases)', () => {
    noteEpochBump("*", 42);
    noteEpochBump("*", 7);
    expect(getEpochFloor("user-1")).toBe(42);
  });

  it("getEpochFloor returns the MAX of the global floor and the per-user floor", () => {
    noteEpochBump("*", 10);
    noteEpochBump("user-1", 25);
    expect(getEpochFloor("user-1")).toBe(25);
    // A different user only sees the global floor.
    expect(getEpochFloor("user-2")).toBe(10);

    noteEpochBump("user-1", 5); // lower than current per-user floor: no-op
    expect(getEpochFloor("user-1")).toBe(25);
  });

  it("ignores non-finite epochs (NaN, Infinity) — guards against malformed pub/sub payloads", () => {
    noteEpochBump("user-1", NaN);
    noteEpochBump("user-1", Infinity);
    noteEpochBump("user-1", -Infinity);
    expect(getEpochFloor("user-1")).toBe(0);
  });

  it("ignores a non-finite epoch on the * sentinel too", () => {
    noteEpochBump("*", NaN);
    expect(getEpochFloor("anyone")).toBe(0);
  });

  it("resetEpochFloorForTest clears both per-user and global floors", () => {
    noteEpochBump("user-1", 5);
    noteEpochBump("*", 9);
    resetEpochFloorForTest();
    expect(getEpochFloor("user-1")).toBe(0);
    expect(getEpochFloor("anyone")).toBe(0);
  });
});

describe("publishBump (via bumpTokenEpoch / bumpTokenEpochAllUsers)", () => {
  beforeEach(() => {
    resetEpochFloorForTest();
  });

  it("with no bus set (default/single-instance): bumping does not throw and publishes nothing", () => {
    setTokenEpochBus(null);
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u1");
    expect(() => bumpTokenEpoch(db, "u1")).not.toThrow();
  });

  it("with a bus set: bumpTokenEpoch publishes (userId, newEpoch) to the bus", () => {
    const bus = new FakeBus();
    setTokenEpochBus(bus);
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u1");
    const bumped = bumpTokenEpoch(db, "u1");
    expect(bus.calls).toEqual([{ userId: "u1", epoch: bumped }]);
  });

  it("with a bus set: bumpTokenEpochAllUsers publishes under the * sentinel with a wall-clock epoch", () => {
    const bus = new FakeBus();
    setTokenEpochBus(bus);
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u1");
    const before = Math.floor(Date.now() / 1000);
    bumpTokenEpochAllUsers(db);
    expect(bus.calls.length).toBe(1);
    expect(bus.calls[0].userId).toBe("*");
    expect(bus.calls[0].epoch).toBeGreaterThanOrEqual(before);
  });

  it("a bus that throws on publish() does not propagate — the DB write already succeeded", () => {
    const bus = new FakeBus();
    bus.throwOnPublish = true;
    setTokenEpochBus(bus);
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u1");
    let bumped: number | undefined;
    expect(() => {
      bumped = bumpTokenEpoch(db, "u1");
    }).not.toThrow();
    expect(bumped).toBeGreaterThan(0);
    // The publish attempt is swallowed, not recorded.
    expect(bus.calls).toEqual([]);
  });

  it("setTokenEpochBus(null) after setting a bus reverts to the single-instance no-op", () => {
    const bus = new FakeBus();
    setTokenEpochBus(bus);
    setTokenEpochBus(null);
    db.prepare("INSERT INTO users (id) VALUES (?)").run("u1");
    expect(() => bumpTokenEpoch(db, "u1")).not.toThrow();
    expect(bus.calls).toEqual([]);
  });
});
