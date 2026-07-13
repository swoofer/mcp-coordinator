import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  readTokenEpoch,
  bumpTokenEpoch,
  bumpTokenEpochAllUsers,
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
