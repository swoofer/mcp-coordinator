import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * issue #374 — `threads.run_id` exists end to end on the REST side and was
 * unreachable from MCP. The column is in the schema (src/database.ts) with its
 * own migration, `announceWork` writes `params.run_id ?? null`, `Thread`
 * carries it, `listThreads` filters on it, and `POST /api/announce` accepts
 * it — but `announce_work`, the MCP tool 26 agents actually call, had no such
 * field. A value the whole stack was built to carry could only be set by the
 * transport almost nobody uses.
 *
 * This is step 1 of the issue and only step 1: plumbing the parameter through.
 * It deliberately does NOT touch `detect()`. What run-scoping should MEAN for
 * conflict detection is the issue's open question, and the three options it
 * lists prescribe different — in two cases opposite — behaviours. Passing the
 * value cannot be wrong under any of them; choosing a semantics can.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("announce_work reaches the run_id sink that already exists (#374)", () => {
  const TOOL = read("src/tools/consultation-tools.ts");

  it("the MCP tool declares run_id", () => {
    const schema = TOOL.slice(TOOL.indexOf('"announce_work"'), TOOL.indexOf("annotations:"));
    expect(schema, "run_id absent from the announce_work inputSchema").toContain("run_id");
  });

  it("and passes it to announceWork rather than declaring it decoratively", () => {
    // A schema field that never reaches the call is the shape of the bug this
    // repo keeps finding: declared, accepted, silently dropped.
    const call = TOOL.slice(TOOL.indexOf("consultation.announceWork("));
    expect(call.slice(0, 400)).toContain("run_id");
  });

  it("MCP and REST now describe the same field", () => {
    // The REST schema is the one that already worked; MCP borrows its wording
    // so the two transports cannot drift into meaning different things.
    const rest = read("src/http/rest-schemas.ts");
    for (const phrase of ["Omitted = un-scoped", "visible to every run"]) {
      expect(rest, `REST no longer says: ${phrase}`).toContain(phrase);
      expect(TOOL, `MCP does not say: ${phrase}`).toContain(phrase);
    }
  });

  it("the value now reaches detect(), which is #374 step 2", () => {
    // This assertion used to be its inverse: "conflict-detector contains no
    // run_id", guarding against a later change quietly answering the
    // semantics question while parity was the stated scope. It fired exactly
    // as designed when step 2 landed — deliberately, not by accident — so it
    // is inverted here rather than deleted, and the behaviour it now stands
    // for is covered in conflict-detector-run-scope.test.ts.
    expect(read("src/conflict-detector.ts")).toContain("run_id");
  });

  it("the sink it feeds is real", () => {
    // Cheap proof that this is parity, not new machinery: every layer below
    // the tool already handled run_id before this change.
    expect(read("src/consultation.ts")).toContain("params.run_id ?? null");
    expect(read("src/types.ts")).toContain("run_id");
    expect(read("src/http/rest-handlers.ts")).toContain("run_id");
  });
});
