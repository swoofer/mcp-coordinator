import { describe, it, expect } from "vitest";
import { parseDuration, levelToNum, matchesLogLine } from "../../cli/server/logs.js";

describe("parseDuration", () => {
  it("parses s/m/h/d units to milliseconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("2d")).toBe(172_800_000);
  });
  it("returns null on invalid input", () => {
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("10")).toBeNull();
    expect(parseDuration("1w")).toBeNull();
  });
});

describe("levelToNum", () => {
  it("maps level names (case-insensitive) to pino numbers", () => {
    expect(levelToNum("debug")).toBe(10);
    expect(levelToNum("info")).toBe(20);
    expect(levelToNum("WARN")).toBe(30);
    expect(levelToNum("Error")).toBe(40);
  });
  it("returns null for unknown levels", () => {
    expect(levelToNum("trace")).toBeNull();
  });
});

describe("matchesLogLine", () => {
  const line = (o: object) => JSON.stringify(o);

  it("drops empty lines", () => {
    expect(matchesLogLine("", {})).toBe(false);
    expect(matchesLogLine("   ", { grep: /x/ })).toBe(false);
  });

  it("no filters: keeps any non-empty line", () => {
    expect(matchesLogLine('{"msg":"hi"}', {})).toBe(true);
  });

  it("grep: matches the raw line", () => {
    expect(matchesLogLine('{"msg":"consultation opened"}', { grep: /consultation/ })).toBe(true);
    expect(matchesLogLine('{"msg":"nothing"}', { grep: /consultation/ })).toBe(false);
  });

  it("level: keeps entries at or above the threshold", () => {
    expect(matchesLogLine(line({ level: 30, msg: "w" }), { minLevel: 30 })).toBe(true);
    expect(matchesLogLine(line({ level: 40, msg: "e" }), { minLevel: 30 })).toBe(true);
    expect(matchesLogLine(line({ level: 20, msg: "i" }), { minLevel: 30 })).toBe(false);
  });

  it("since: keeps entries at or after the bound (numeric and ISO time)", () => {
    const bound = 1_000_000;
    expect(matchesLogLine(line({ level: 20, time: 1_000_001 }), { sinceMs: bound })).toBe(true);
    expect(matchesLogLine(line({ level: 20, time: 999_999 }), { sinceMs: bound })).toBe(false);
    const iso = "2026-07-21T00:00:00Z";
    expect(
      matchesLogLine(line({ time: iso }), { sinceMs: Date.parse("2026-07-20T00:00:00Z") }),
    ).toBe(true);
  });

  it("structured filter drops a non-JSON line (cannot evaluate)", () => {
    expect(matchesLogLine("not json at all", { minLevel: 30 })).toBe(false);
    // ...but grep alone still matches a non-JSON line
    expect(matchesLogLine("not json at all", { grep: /json/ })).toBe(true);
  });

  it("combines grep + level + since (all must pass)", () => {
    const l = line({ level: 40, time: 2_000_000, msg: "boom in consultation" });
    expect(matchesLogLine(l, { grep: /consultation/, minLevel: 30, sinceMs: 1_000_000 })).toBe(
      true,
    );
    expect(matchesLogLine(l, { grep: /consultation/, minLevel: 50, sinceMs: 1_000_000 })).toBe(
      false,
    );
  });
});
