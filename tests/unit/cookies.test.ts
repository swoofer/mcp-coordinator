import { describe, it, expect, afterEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  parseCookies,
  serializeCookie,
  hostCookie,
  setCookies,
  getCookieSecureFlag,
} from "../../src/auth/cookies.js";

function makeReq(cookieHeader?: string): IncomingMessage {
  const headers: Record<string, string | undefined> = {};
  if (cookieHeader !== undefined) headers.cookie = cookieHeader;
  return { headers } as unknown as IncomingMessage;
}

function makeRes(): ServerResponse {
  const store: Record<string, string | string[] | number | undefined> = {};
  const res = {
    getHeader(name: string) {
      return store[name.toLowerCase()];
    },
    setHeader(name: string, value: string | string[] | number) {
      store[name.toLowerCase()] = value;
    },
  } as unknown as ServerResponse;
  return res;
}

describe("parseCookies", () => {
  it("parses a single cookie", () => {
    const req = makeReq("a=1");
    expect(parseCookies(req)).toEqual({ a: "1" });
  });

  it("parses multiple semicolon-separated cookies", () => {
    const req = makeReq("a=1; b=2; c=3");
    expect(parseCookies(req)).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("returns empty object when header is absent", () => {
    const req = makeReq(undefined);
    expect(parseCookies(req)).toEqual({});
  });

  it("parses cookie with quoted value", () => {
    // cookie@1 keeps wrapping DQUOTEs in the value; callers strip if needed.
    const req = makeReq('a="hello"');
    const parsed = parseCookies(req);
    expect(parsed.a).toBe('"hello"');
  });

  it("filters undefined entries (defensive contract for cookie.parse type)", async () => {
    // cookie.parse's TS return type is Record<string, string | undefined>.
    // The implementation never emits undefined in practice, but the filter
    // guards against future package releases that might. Mock parse to
    // inject undefined and assert the filter drops that key.
    vi.resetModules();
    vi.doMock("cookie", () => ({
      parse: (_: string) => ({ good: "1", bad: undefined as unknown as string }),
      serialize: (n: string, v: string) => `${n}=${v}`,
    }));
    const mod = await import("../../src/auth/cookies.js");
    const req = makeReq("good=1; bad=x");
    const parsed = mod.parseCookies(req);
    expect(parsed).toEqual({ good: "1" });
    vi.doUnmock("cookie");
    vi.resetModules();
  });
});

describe("serializeCookie", () => {
  it("emits all attributes: httpOnly, secure, sameSite, path, domain, maxAge", () => {
    const s = serializeCookie("k", "v", {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/x",
      domain: "example.com",
      maxAge: 60,
    });
    expect(s).toMatch(/^k=v/);
    expect(s).toMatch(/HttpOnly/);
    expect(s).toMatch(/Secure/);
    expect(s).toMatch(/SameSite=Strict/);
    expect(s).toMatch(/Path=\/x/);
    expect(s).toMatch(/Domain=example\.com/);
    expect(s).toMatch(/Max-Age=60/);
  });

  it("handles sameSite undefined (no SameSite attribute emitted)", () => {
    const s = serializeCookie("k", "v", { httpOnly: true });
    expect(s).toMatch(/^k=v/);
    expect(s).not.toMatch(/SameSite/);
  });

  it("lowercases sameSite Lax and None for the cookie package", () => {
    expect(serializeCookie("k", "v", { sameSite: "Lax" })).toMatch(/SameSite=Lax/);
    expect(serializeCookie("k", "v", { sameSite: "None" })).toMatch(/SameSite=None/);
  });
});

describe("hostCookie", () => {
  it("rejects names without __Host- prefix", () => {
    expect(() => hostCookie("session", "v", {})).toThrow(/__Host-/);
  });

  it("accepts names with __Host- prefix and emits Secure + Path=/", () => {
    const s = hostCookie("__Host-session", "abc", { httpOnly: true, sameSite: "Strict", maxAge: 3600 });
    expect(s).toMatch(/^__Host-session=abc/);
    expect(s).toMatch(/Secure/);
    expect(s).toMatch(/Path=\//);
    expect(s).toMatch(/HttpOnly/);
    expect(s).toMatch(/SameSite=Strict/);
    expect(s).toMatch(/Max-Age=3600/);
    // __Host- forbids Domain attribute.
    expect(s).not.toMatch(/Domain=/);
  });

  it("never emits Domain even though caller has no way to pass one", () => {
    // The Pick<> type forbids passing domain at compile time; this test
    // pins the runtime contract too — hostCookie's serializeCookie call
    // must not pass through a domain attribute regardless of opts shape.
    const s = hostCookie("__Host-x", "1", {});
    expect(s).not.toMatch(/Domain=/);
    expect(s).toMatch(/Secure/);
    expect(s).toMatch(/Path=\//);
  });
});

describe("setCookies", () => {
  it("appends to existing Set-Cookie array without clobbering", () => {
    const res = makeRes();
    res.setHeader("Set-Cookie", ["first=1"]);
    setCookies(res, ["second=2", "third=3"]);
    const out = res.getHeader("Set-Cookie");
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual(["first=1", "second=2", "third=3"]);
  });

  it("converts a single pre-existing string Set-Cookie to array", () => {
    const res = makeRes();
    res.setHeader("Set-Cookie", "first=1");
    setCookies(res, ["second=2"]);
    const out = res.getHeader("Set-Cookie");
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual(["first=1", "second=2"]);
  });

  it("sets cookies array when no prior Set-Cookie header", () => {
    const res = makeRes();
    setCookies(res, ["only=1"]);
    expect(res.getHeader("Set-Cookie")).toEqual(["only=1"]);
  });

  it("is a no-op when given empty array", () => {
    const res = makeRes();
    res.setHeader("Set-Cookie", ["prior=1"]);
    setCookies(res, []);
    expect(res.getHeader("Set-Cookie")).toEqual(["prior=1"]);
  });
});

describe("getCookieSecureFlag", () => {
  const original = process.env.COORDINATOR_INSECURE_COOKIES;
  afterEach(() => {
    if (original === undefined) delete process.env.COORDINATOR_INSECURE_COOKIES;
    else process.env.COORDINATOR_INSECURE_COOKIES = original;
  });

  it("returns true when env unset", () => {
    delete process.env.COORDINATOR_INSECURE_COOKIES;
    expect(getCookieSecureFlag()).toBe(true);
  });

  it('returns false when COORDINATOR_INSECURE_COOKIES="true"', () => {
    process.env.COORDINATOR_INSECURE_COOKIES = "true";
    expect(getCookieSecureFlag()).toBe(false);
  });

  it("returns true when env set to any other value", () => {
    process.env.COORDINATOR_INSECURE_COOKIES = "1";
    expect(getCookieSecureFlag()).toBe(true);
  });
});
