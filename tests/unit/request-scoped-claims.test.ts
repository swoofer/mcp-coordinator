import { describe, it, expect } from "vitest";
import { requestClaims, resolveClaims } from "../../src/serve-http.js";
import type { AuthClaims } from "../../src/auth.js";

/**
 * issue #325 — identity reached a tool handler only through `sessionClaims`, a
 * Map keyed by the `mcp-session-id` this process minted. All 26 tools open with
 * `getSessionClaims(ctx.sessionId ?? "")`, so anything that breaks the key
 * breaks every one of them at once:
 *
 *  - `sessionIdGenerator: undefined` — the SDK's own stateless idiom, and the
 *    default for 2025 traffic in `createMcpHandler` — leaves `ctx.sessionId`
 *    undefined, `getSessionClaims("")` misses, and every tool throws.
 *  - a second instance misses too, because the id was minted elsewhere.
 *
 * The claims were never the scarce thing: both branches of the /mcp dispatch
 * call `authenticateMcpRequest` and hold verified claims immediately before
 * `handleRequest`. The Map was a delivery mechanism keyed on something fragile.
 *
 * What is pinned here is the resolution ORDER and the property the whole thing
 * rests on — that an AsyncLocalStorage store survives the awaits and timers a
 * request handler goes through before a tool body runs. That is the part that
 * could silently degrade: if the store were lost, `resolveClaims` would fall
 * back to the Map and every existing test would still pass, which is exactly
 * why it is asserted here rather than left to the integration suite.
 */

const CLAIMS = (sub: string): AuthClaims => ({
  sub,
  user_id: sub,
  org: "org-1",
  role: "agent",
  jti: "j-" + sub,
});

describe("resolution order (#325)", () => {
  it("falls back to the session map when there is no request scope", () => {
    // stdio, and anything the SDK invokes outside a request.
    expect(resolveClaims(CLAIMS("from-map"))?.sub).toBe("from-map");
  });

  it("null stays null rather than becoming undefined", () => {
    // The 26 tools test `if (!claims)`, and the getter's contract is
    // `AuthClaims | null`.
    expect(resolveClaims(null)).toBeNull();
    expect(resolveClaims(undefined)).toBeNull();
  });

  it("the request scope WINS over the session map", () => {
    // Not a tie-break detail. The map can hold claims from an earlier request
    // on the same session; the request scope holds what was verified for THIS
    // one. Session-first would let a stale entry beat a rotated JWT.
    requestClaims.run(CLAIMS("from-request"), () => {
      expect(resolveClaims(CLAIMS("from-map"))?.sub).toBe("from-request");
    });
  });

  it("and answers even when the map has nothing — the sessionless case", () => {
    requestClaims.run(CLAIMS("from-request"), () => {
      expect(resolveClaims(null)?.sub).toBe("from-request");
    });
  });
});

describe("the store survives what a request handler actually does (#325)", () => {
  it("crosses awaits", async () => {
    await requestClaims.run(CLAIMS("alice"), async () => {
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
      expect(resolveClaims(null)?.sub).toBe("alice");
    });
  });

  it("crosses a timer, which is how the SDK defers work", async () => {
    await requestClaims.run(CLAIMS("alice"), async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(resolveClaims(null)?.sub).toBe("alice");
    });
  });

  it("reaches a callback several frames deep", async () => {
    const deep = async () => {
      await Promise.resolve();
      return resolveClaims(null);
    };
    const middle = async () => deep();
    await requestClaims.run(CLAIMS("alice"), async () => {
      expect((await middle())?.sub).toBe("alice");
    });
  });

  it("does not leak out of its own scope", async () => {
    await requestClaims.run(CLAIMS("alice"), async () => {
      await Promise.resolve();
    });
    // A leak here would be worse than the bug being fixed: one request's
    // identity answering for the next.
    expect(resolveClaims(null)).toBeNull();
  });

  it("concurrent requests do not see each other's identity", async () => {
    const one = requestClaims.run(CLAIMS("alice"), async () => {
      await new Promise((r) => setTimeout(r, 5));
      return resolveClaims(null)?.sub;
    });
    const two = requestClaims.run(CLAIMS("bob"), async () => {
      await new Promise((r) => setTimeout(r, 1));
      return resolveClaims(null)?.sub;
    });
    expect(await Promise.all([one, two])).toEqual(["alice", "bob"]);
  });
});
