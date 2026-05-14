import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { escapeHtml, render, sendHtml } from "../../src/auth/html.js";

function makeRes() {
  return {
    headers: undefined as Record<string, string> | undefined,
    status: 0,
    body: "",
    writeHead(s: number, h: Record<string, string>) {
      this.status = s;
      this.headers = h;
    },
    end(b: string) {
      this.body = b;
    },
  };
}

describe("escapeHtml", () => {
  it("escapes all 5 HTML special chars (&<>\"')", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("leaves safe input unchanged", () => {
    expect(escapeHtml("hello world 123 _-.")).toBe("hello world 123 _-.");
  });

  it("coerces numbers via String(...)", () => {
    expect(escapeHtml(42)).toBe("42");
  });

  it("coerces booleans via String(...)", () => {
    expect(escapeHtml(true)).toBe("true");
    expect(escapeHtml(false)).toBe("false");
  });

  it("coerces null and undefined via String(...)", () => {
    expect(escapeHtml(null)).toBe("null");
    expect(escapeHtml(undefined)).toBe("undefined");
  });

  it("escapes & first to avoid double-escape (e.g. 'A&B' → 'A&amp;B')", () => {
    expect(escapeHtml("A&B")).toBe("A&amp;B");
    // Confirms the regex does a single pass — '&amp;' would not become '&amp;amp;'
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("render", () => {
  it("substitutes a single placeholder", () => {
    expect(render("Hello, ${name}!", { name: "world" })).toBe("Hello, world!");
  });

  it("escapes the substituted value", () => {
    expect(render("<p>${msg}</p>", { msg: "<b>hi</b>" })).toBe("<p>&lt;b&gt;hi&lt;/b&gt;</p>");
  });

  it("substitutes multiple placeholders in one template", () => {
    expect(render("${a}+${b}=${c}", { a: 1, b: 2, c: 3 })).toBe("1+2=3");
  });

  it("missing key → empty string", () => {
    expect(render("[${missing}]", {})).toBe("[]");
  });

  it("explicit undefined ctx value → empty string", () => {
    expect(render("[${x}]", { x: undefined })).toBe("[]");
  });

  it("null ctx value → empty string (?? collapses null same as undefined)", () => {
    // `??` only fires on null/undefined; this verifies the null branch:
    // ctx[key] ?? "" gives "" for null. (This is intentional per the JSDoc
    // contract: undefined → ""; null → also "" because ?? matches both.)
    expect(render("[${x}]", { x: null })).toBe("[]");
  });

  it("falsy non-nullish values (0, false, '') are stringified, not blanked", () => {
    expect(render("${a}-${b}-${c}", { a: 0, b: false, c: "" })).toBe("0-false-");
  });

  it("non-identifier placeholder syntax ${user.name} passes through unchanged", () => {
    expect(render("Hi ${user.name}!", { "user.name": "X" } as Record<string, unknown>)).toBe(
      "Hi ${user.name}!",
    );
  });

  it("placeholder with surrounding whitespace ${ msg } does not match", () => {
    expect(render("[${ msg }]", { msg: "x" })).toBe("[${ msg }]");
  });

  it("numeric-leading placeholder ${1} does not match", () => {
    expect(render("[${1}]", { "1": "x" } as Record<string, unknown>)).toBe("[${1}]");
  });

  it("identifier-style keys with underscore + digits match", () => {
    expect(render("${_priv}/${user_name}/${a1}", { _priv: "p", user_name: "u", a1: "x" })).toBe(
      "p/u/x",
    );
  });

  it("malicious payload is fully escaped", () => {
    const out = render("<div>${x}</div>", { x: '<script>alert("xss")</script>' });
    expect(out).toBe("<div>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</div>");
    expect(out).not.toContain("<script>");
  });
});

describe("sendHtml", () => {
  it("writes Content-Type: text/html; charset=utf-8", () => {
    const r = makeRes();
    sendHtml(r as unknown as ServerResponse, 200, "<p>hi</p>");
    expect(r.headers!["Content-Type"]).toBe("text/html; charset=utf-8");
  });

  it("writes the CSP header with all 5 directives", () => {
    const r = makeRes();
    sendHtml(r as unknown as ServerResponse, 200, "");
    const csp = r.headers!["Content-Security-Policy"]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("writes X-Frame-Options: DENY", () => {
    const r = makeRes();
    sendHtml(r as unknown as ServerResponse, 200, "");
    expect(r.headers!["X-Frame-Options"]).toBe("DENY");
  });

  it("writes Referrer-Policy: no-referrer", () => {
    const r = makeRes();
    sendHtml(r as unknown as ServerResponse, 200, "");
    expect(r.headers!["Referrer-Policy"]).toBe("no-referrer");
  });

  it("writes Cache-Control: no-store", () => {
    const r = makeRes();
    sendHtml(r as unknown as ServerResponse, 200, "");
    expect(r.headers!["Cache-Control"]).toBe("no-store");
  });

  it("writes the body via res.end(body)", () => {
    const r = makeRes();
    sendHtml(r as unknown as ServerResponse, 200, "<h1>ok</h1>");
    expect(r.body).toBe("<h1>ok</h1>");
  });

  it("honors the status code (403)", () => {
    const r = makeRes();
    sendHtml(r as unknown as ServerResponse, 403, "forbidden");
    expect(r.status).toBe(403);
  });

  it("CSP includes script-src 'none' (XSS defense-in-depth)", () => {
    const r = makeRes();
    sendHtml(r as unknown as ServerResponse, 200, "");
    expect(r.headers!["Content-Security-Policy"]).toContain("script-src 'none'");
  });

  it("CSP includes frame-ancestors 'none' (clickjacking defense alongside XFO)", () => {
    const r = makeRes();
    sendHtml(r as unknown as ServerResponse, 200, "");
    expect(r.headers!["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });
});
