import { describe, it, expect, vi } from "vitest";
import {
  withTransaction,
  type DatabaseAdapter,
  type Statement,
  type RunResult,
} from "../../src/db-adapter.js";

describe("DatabaseAdapter interface", () => {
  it("is importable and has correct shape", () => {
    // Type-level test: verify the interface exists and can be referenced
    const adapter: DatabaseAdapter = {
      prepare: (_sql: string) => ({
        run: (..._params: unknown[]) => ({ changes: 0, lastInsertRowid: 0 }),
        get: (..._params: unknown[]) => undefined,
        all: (..._params: unknown[]) => [],
      }),
      exec: (_sql: string) => {},
      close: () => {},
      transaction: <T>(fn: () => T) => fn,
    };
    expect(adapter).toBeDefined();
    expect(typeof adapter.prepare).toBe("function");
    expect(typeof adapter.exec).toBe("function");
    expect(typeof adapter.close).toBe("function");
    expect(typeof adapter.transaction).toBe("function");
  });

  it("RunResult and Statement are usable shapes", () => {
    const result: RunResult = { changes: 1, lastInsertRowid: 42 };
    const stmt: Statement = {
      run: () => result,
      get: () => undefined,
      all: () => [],
    };
    expect(stmt.run().lastInsertRowid).toBe(42);
  });
});

describe("withTransaction", () => {
  function makeAdapter(): DatabaseAdapter {
    return {
      prepare: () => ({
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => undefined,
        all: () => [],
      }),
      exec: () => {},
      close: () => {},
      // The fake transaction simply runs the function — better-sqlite3 / bun:sqlite
      // semantics are tested at integration level (b1-transactions.test.ts).
      transaction: <T>(fn: () => T) => fn,
    };
  }

  it("returns the inner function's value", () => {
    const db = makeAdapter();
    const out = withTransaction(db, () => 7);
    expect(out).toBe(7);
  });

  it("propagates errors from the inner function", () => {
    const db = makeAdapter();
    expect(() =>
      withTransaction(db, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });

  it("invokes the underlying db.transaction wrapper", () => {
    const db = makeAdapter();
    const txSpy = vi.spyOn(db, "transaction");
    const out = withTransaction(db, () => "ok");
    expect(txSpy).toHaveBeenCalledOnce();
    expect(out).toBe("ok");
  });
});
