import { describe, it, expect } from "vitest";
import { missingClaimsError } from "../../src/tools/tool-errors.js";

/**
 * issue #99 — the 26 tool handlers used to throw
 * `"Session has no captured claims (auth bug)"`: internal jargon, no
 * remediation, and wrong about the cause. Nothing is broken when this fires.
 *
 * These assert on the PROPERTIES the message must have, not its exact prose,
 * so the wording stays free to improve.
 *
 * #325 split the function in two: called WITHOUT a session id it now describes
 * a sessionless transport, where reconnecting cannot help. These #99 assertions
 * are about the closed-or-swept session, so they pass the id that case has.
 * The sessionless half is covered in missing-claims-diagnosis.test.ts.
 */
describe("missingClaimsError (#99)", () => {
  const msg = missingClaimsError("sess-99").message;

  it("does not leak the old internal jargon", () => {
    expect(msg).not.toMatch(/auth bug/i);
    expect(msg).not.toMatch(/captured claims/i);
  });

  it("names the reachable cause: a closed or idle-swept MCP session", () => {
    expect(msg).toMatch(/session/i);
    expect(msg).toMatch(/idle|swept|closed/i);
  });

  it("names the knob an operator can actually turn", () => {
    expect(msg).toContain("COORDINATOR_MCP_SESSION_TTL_MS");
  });

  it("tells the caller what to do", () => {
    expect(msg).toMatch(/reconnect/i);
  });

  it("does not send anyone to a command that does not exist", () => {
    // The issue proposed "mcp-coordinator login". There is no such command.
    expect(msg).not.toMatch(/mcp-coordinator login/);
  });

  it("returns a fresh Error each call, so stack traces point at the real site", () => {
    expect(missingClaimsError("sess-99")).not.toBe(missingClaimsError("sess-99"));
    expect(missingClaimsError("sess-99")).toBeInstanceOf(Error);
  });
});
