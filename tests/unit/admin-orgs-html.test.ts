// T11 — light smoke test for dashboard/public/admin-orgs.html.
//
// Why a regex test, not a jsdom test?
//   - The repo's devDependencies do NOT include jsdom or happy-dom (verified
//     against package.json at T11 time). Parsing HTML for *structural*
//     assertions would force a new heavy dependency just to express
//     "has a New-org button + table".
//   - The interesting invariants are CSP-related: zero inline JS, zero inline
//     styles, zero on* event handlers. These are easy + reliable to check
//     with anchored regexes over the file contents, and they're exactly the
//     checks a security reviewer would re-run by hand.
//
// What we assert:
//   1. The file exists and parses as text.
//   2. References the external admin-orgs.js module + admin.css stylesheet.
//   3. NO inline <script>...</script> blocks (only `<script type="module"
//      src="...">` self-closed-style is allowed).
//   4. NO `style="..."` attributes anywhere.
//   5. NO `on<event>="..."` inline handlers (onclick, onchange, etc.).
//   6. NO `javascript:` URLs anywhere.
//   7. Contains the documented skeleton: New-org button + orgs-tbody table.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HTML_PATH = join(__dirname, "..", "..", "dashboard", "public", "admin-orgs.html");

const html = readFileSync(HTML_PATH, "utf-8");

describe("admin-orgs.html — T11 smoke", () => {
  describe("external asset wiring", () => {
    it("links the shared admin.css stylesheet", () => {
      expect(html).toMatch(
        /<link\s+rel="stylesheet"\s+href="admin\.css"\s*>/,
      );
    });

    it("loads admin-orgs.js as an external ES module", () => {
      expect(html).toMatch(
        /<script\s+type="module"\s+src="admin-orgs\.js"\s*><\/script>/,
      );
    });
  });

  describe("CSP compliance — zero inline JS/CSS/handlers", () => {
    it("has NO inline <script>...</script> blocks (only external module)", () => {
      // Match any <script> element that has inline content between its tags.
      // The external module form is `<script ... src="..."></script>` which
      // has an empty body — that's allowed. Anything with non-whitespace
      // between the opening and closing tags is a violation.
      const inlineScript = /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i;
      expect(html).not.toMatch(inlineScript);
    });

    it("has NO style='...' or style=\"...\" inline attributes", () => {
      // Match `style=` attribute on any element. The leading space prevents
      // false positives like `data-style="..."`.
      expect(html).not.toMatch(/\sstyle\s*=/i);
    });

    it("has NO on<event>='...' inline event handlers", () => {
      // CSP `script-src 'self'` rejects inline handlers; the project also
      // hard-bans them in code review. Matches onclick=, onchange=, onload=
      // anywhere in the markup.
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    });

    it("has NO javascript: URLs", () => {
      expect(html.toLowerCase()).not.toContain("javascript:");
    });

    it("has NO inline <style>...</style> blocks", () => {
      // CSS lives in admin.css (T09). Local <style> blocks are banned by
      // CSP `style-src 'self'` on admin assets (T08).
      expect(html).not.toMatch(/<style\b[^>]*>[\s\S]*?<\/style>/i);
    });
  });

  describe("page skeleton", () => {
    it("contains the + New org button with the documented id", () => {
      // Plan: `id="new-org-btn"` is the hook for admin-orgs.js wiring.
      expect(html).toMatch(/id="new-org-btn"/);
      // The visible label includes "New org" (allow leading +).
      expect(html).toMatch(/New org/);
    });

    it("contains the orgs table with the documented tbody id", () => {
      expect(html).toMatch(/id="orgs-tbody"/);
      expect(html).toMatch(/<table[^>]*class="[^"]*data-table[^"]*"/);
    });

    it("ships an initially-hidden modal for create/edit", () => {
      // `hidden` boolean attribute is the canonical CSS-less hide. The
      // admin-orgs.js modal toggles it via element.hidden = true|false.
      expect(html).toMatch(/id="org-modal"[^>]*\bhidden\b/);
    });

    it("ships the shared create/edit form with required fields", () => {
      expect(html).toMatch(/id="org-form"/);
      expect(html).toMatch(/id="org-edit-id"/);
      expect(html).toMatch(/id="org-name"/);
      expect(html).toMatch(/id="org-allow-github"/);
      expect(html).toMatch(/id="org-allow-idp"/);
      expect(html).toMatch(/id="org-save-btn"/);
      expect(html).toMatch(/id="org-cancel-btn"/);
    });

    it("links back to the admin home page in the nav", () => {
      // Helps catch a typo where the back-link points at the wrong place.
      expect(html).toMatch(/href="admin\.html"/);
    });
  });
});
