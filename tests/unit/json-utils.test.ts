import { describe, it, expect, vi, afterEach } from "vitest";
import { safeJsonParse } from "../../src/json-utils.js";

describe("safeJsonParse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses valid JSON and returns the parsed value", () => {
    expect(safeJsonParse<string[]>('["a","b"]', [])).toEqual(["a", "b"]);
    expect(safeJsonParse<Record<string, unknown>>('{"x":1}', {})).toEqual({ x: 1 });
  });

  it("returns fallback (no warning) for null", () => {
    const logger = { warn: vi.fn() };
    expect(safeJsonParse<string[]>(null, ["fallback"], logger)).toEqual(["fallback"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns fallback (no warning) for undefined", () => {
    const logger = { warn: vi.fn() };
    expect(safeJsonParse<string[]>(undefined, ["fallback"], logger)).toEqual(["fallback"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns fallback and warns for a non-string value", () => {
    const logger = { warn: vi.fn() };
    expect(safeJsonParse<string[]>(42, [], logger, "ctx")).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = logger.warn.mock.calls[0];
    expect(payload).toMatchObject({ context: "ctx" });
    expect(msg).toContain("malformed JSON");
  });

  it("returns fallback and warns for truncated JSON", () => {
    const logger = { warn: vi.fn() };
    expect(safeJsonParse<string[]>('["a","b"', [], logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("returns fallback and warns for an empty string", () => {
    const logger = { warn: vi.fn() };
    expect(safeJsonParse<string[]>("", [], logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("returns fallback and warns for non-JSON garbage text", () => {
    const logger = { warn: vi.fn() };
    expect(safeJsonParse<string[]>("not json at all", [], logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("never throws for any corrupted input shape", () => {
    const cases: unknown[] = [null, undefined, "", "{bad", "undefined", "[1,2,", 123, true, {}];
    for (const c of cases) {
      expect(() => safeJsonParse<unknown[]>(c, [])).not.toThrow();
    }
  });

  it("falls back to console.warn when no logger is provided", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = safeJsonParse<string[]>("{not valid", [], undefined, "no-logger-ctx");
    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("no-logger-ctx");
  });

  it("valid JSON still parses correctly when a logger is supplied", () => {
    const logger = { warn: vi.fn() };
    expect(safeJsonParse<number[]>("[1,2,3]", [], logger)).toEqual([1, 2, 3]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error throw from JSON.parse without crashing", () => {
    const spy = vi.spyOn(JSON, "parse").mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "not an Error instance";
    });
    const logger = { warn: vi.fn() };
    expect(safeJsonParse<string[]>("[1,2]", [], logger, "ctx")).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload] = logger.warn.mock.calls[0];
    expect(payload.reason).toBe("not an Error instance");
    spy.mockRestore();
  });
});
