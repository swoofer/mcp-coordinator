import { describe, it, expect } from "vitest";
import type { DatabaseAdapter, Statement, RunResult } from "../../src/db-adapter.js";

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
});

