import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { missingClaimsError } from "../../src/tools/tool-errors.js";

/**
 * issue #325 — every tool resolves its claims with
 * `getSessionClaims(ctx.sessionId ?? "")`, so two different failures collapse
 * into one empty result and one message:
 *
 *   - the transport gave no session id at all (sessionless mode), and
 *   - it gave one this process has never seen (closed, swept, or opened
 *     against another replica).
 *
 * The advice that fits one does not fit the other. "Reconnect and retry" is
 * right for the second and useless for the first: under a sessionless
 * transport every tool fails permanently and no amount of reconnecting
 * changes it.
 *
 * This does not fix either failure. That is #325's open question — and it is
 * larger than the issue frames it, see the last test here.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the two claim failures are told apart (#325)", () => {
  it("no session id points at the deployment, not at reconnecting", () => {
    const message = missingClaimsError(undefined).message;
    expect(message).toContain("no session id");
    expect(message).toContain("sessionIdGenerator: undefined");
    // The critical half: it must NOT advise the thing that cannot work.
    expect(message).toContain("reconnecting will not help");
  });

  it("an empty string is the same case as absent", () => {
    // Handlers pass `ctx.sessionId ?? ""`, so absent arrives as "".
    expect(missingClaimsError("").message).toContain("no session id");
  });

  it("an unknown session id still advises reconnecting", () => {
    const message = missingClaimsError("sess-abc").message;
    expect(message).toContain("Reconnect your MCP client");
    expect(message).toContain("COORDINATOR_MCP_SESSION_TTL_MS");
  });

  it("and names the replica case, which looks identical", () => {
    // sessionClaims is an in-process Map while COORDINATOR_REDIS_URL shipped.
    // A valid token against instance B produces this exact error, and nothing
    // used to say so.
    const message = missingClaimsError("sess-abc").message;
    expect(message).toMatch(/replicated/i);
    expect(message).toContain("not shared between instances");
  });

  it("both point at the issue rather than leaving the reader to search", () => {
    for (const arg of [undefined, "sess-abc"]) {
      expect(missingClaimsError(arg).message).toContain("issues/325");
    }
  });

  it("every tool passes its session id, so the distinction is reachable", () => {
    // 26 call sites. One left on the no-arg form would silently give the
    // wrong advice for its tool.
    let bare = 0;
    for (const f of [
      "agents-tools",
      "consultation-tools",
      "dependencies-tools",
      "files-tools",
      "mqtt-tools",
      "status-tools",
    ]) {
      bare += (read("src/tools/" + f + ".ts").match(/missingClaimsError\(\)/g) ?? []).length;
    }
    expect(bare, "a tool still throws the undiagnosed error").toBe(0);
  });

  it("the replacement the issue names is not wired here", () => {
    // #325 says "le remplaçant est déjà livré : BaseContext.http.authInfo".
    // It exists in the SDK types, but this server never populates it — it
    // authenticates at its own HTTP gate and injects claims itself. Building
    // a fallback on authInfo today would produce code that never runs, which
    // is the ghost-guardrail shape this repo keeps finding.
    //
    // If this test ever fails, someone wired it, and the fallback becomes
    // buildable — which is the real precondition for closing #325.
    for (const file of ["src/serve-http.ts", "src/server-setup.ts", "src/index.ts"]) {
      expect(read(file), file + " now populates authInfo").not.toContain("authInfo");
    }
  });
});
