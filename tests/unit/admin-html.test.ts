// T10 — smoke tests for dashboard/public/admin.html.
//
// These are structural regex/string assertions, not DOM parsing. The file
// is shipped as a static asset (served by src/serve-http.ts under the
// admin-asset CSP regex) so what matters is that the bytes contain the
// expected references and DO NOT contain inline-script/style violations.
//
// Why no jsdom: package.json devDeps has neither jsdom nor happy-dom
// (per admin-common.test.ts §"DOM polyfill decision"). Pulling one in for
// a 4-line landing page is unjustified. Regex is sufficient — we're
// asserting policy compliance ("no <script> with text inside", "links to
// admin-orgs.html exist"), not behavior.
//
// admin.js coverage rationale: admin.js does fetch-then-paint with no
// branching logic worth unit-testing in isolation. The 401 path is owned
// by admin-common.fetchJSON (already 100%-covered by admin-common.test.ts).
// We deliberately skip the per-file coverage threshold in vitest.config.ts
// for admin.js — see the comment block above the threshold table.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = resolve(__dirname, "../../dashboard/public/admin.html");
const JS_PATH = resolve(__dirname, "../../dashboard/public/admin.js");

describe("admin.html (T10 landing page)", () => {
  let html: string;

  beforeAll(() => {
    html = readFileSync(HTML_PATH, "utf-8");
  });

  describe("required asset references", () => {
    it("loads the shared admin.css", () => {
      expect(html).toMatch(/<link\s+rel="stylesheet"\s+href="admin\.css">/);
    });

    it("loads admin.js as an external ES module", () => {
      // The script MUST be `type="module"` so that admin.js's ESM imports
      // (admin-common.js, admin-strings.js) resolve, and MUST have src=
      // — no inline body — to satisfy CSP `script-src 'self'`.
      expect(html).toMatch(/<script\s+type="module"\s+src="admin\.js"><\/script>/);
    });
  });

  describe("CSP compliance (T08)", () => {
    it("contains no inline <script>...</script> blocks", () => {
      // Match an opening <script> with any attrs followed by NON-empty body.
      // A self-closing or src-only `<script src="..."></script>` MUST not
      // trip this — only scripts whose body has content.
      // Strategy: find every <script ...>...</script> and ensure the body
      // (between > and </script>) is empty after whitespace trim.
      const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const body = (m[1] ?? "").trim();
        expect(body, `Inline script body found: ${body.slice(0, 60)}`).toBe("");
      }
    });

    it("contains no inline <style>...</style> blocks", () => {
      // CSP `style-src 'self'` rejects inline <style>. admin.html may only
      // reference external stylesheets via <link rel="stylesheet">.
      expect(html).not.toMatch(/<style\b[^>]*>[\s\S]*?<\/style>/i);
    });

    it("contains no inline style=\"...\" attributes", () => {
      // CSP `style-src 'self'` (no `'unsafe-inline'`, no `style-src-attr`)
      // also rejects style attributes. Asserting their absence is the
      // simplest way to guarantee the page renders under the admin-asset
      // CSP defined in src/serve-http.ts:492.
      expect(html).not.toMatch(/\sstyle\s*=\s*"/i);
    });

    it("contains no on*= event handler attributes", () => {
      // onclick, onload, etc. count as inline scripts and would be blocked.
      // (Matches a space-or-newline followed by `on<letters>=` to avoid
      // false positives on words like "version" or "actions".)
      expect(html).not.toMatch(/\son[a-z]+\s*=\s*"/i);
    });
  });

  describe("navigation tiles", () => {
    it("has a link to admin-orgs.html", () => {
      expect(html).toMatch(/href="admin-orgs\.html"/);
    });

    it("has a link to admin-users.html", () => {
      expect(html).toMatch(/href="admin-users\.html"/);
    });
  });

  describe("structural smoke", () => {
    it("is a valid HTML5 document", () => {
      expect(html).toMatch(/^<!DOCTYPE html>/i);
      expect(html).toMatch(/<html\b/);
      expect(html).toMatch(/<\/html>\s*$/);
    });

    it("has a header and a footer", () => {
      expect(html).toMatch(/<header\b/);
      expect(html).toMatch(/<footer\b/);
    });

    it("has a placeholder for user info that admin.js will populate", () => {
      expect(html).toMatch(/id="user-info"/);
    });

    it("declares the page title", () => {
      expect(html).toMatch(/<title>[^<]*Admin[^<]*<\/title>/);
    });
  });
});

describe("admin.js (T10 landing controller)", () => {
  let js: string;

  beforeAll(() => {
    js = readFileSync(JS_PATH, "utf-8");
  });

  it("imports from admin-common.js (no re-implementation of fetchJSON)", () => {
    // V3 PATCH 15 + T10 constraint: do not re-implement T09 helpers.
    expect(js).toMatch(/from\s+["']\.\/admin-common\.js["']/);
    expect(js).toMatch(/fetchJSON/);
  });

  it("calls GET /api/auth/me to fetch the session user", () => {
    expect(js).toMatch(/['"]\/api\/auth\/me['"]/);
  });

  it("does not use innerHTML or insertAdjacentHTML (V3 PATCH 15)", () => {
    expect(js).not.toMatch(/\binnerHTML\b/);
    expect(js).not.toMatch(/\binsertAdjacentHTML\b/);
    expect(js).not.toMatch(/\beval\s*\(/);
  });
});
