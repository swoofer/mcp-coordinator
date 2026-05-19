// T12 — static-text guards for dashboard/public/admin-users.html.
//
// We deliberately do NOT require a DOM polyfill (no jsdom in devDeps —
// mirrors the T10/T11 approach). Instead we read the file as text and
// assert structural invariants with regex / substring checks. This is
// sufficient for the CSP-compliance guarantees we care about:
//
//   - external admin-users.js + admin.css references present
//   - NO inline <script> body (only the type="module" src=... loader)
//   - NO <style> block
//   - NO on* HTML event handler attributes (onclick=, onload=, …)
//   - filter dropdown + table skeleton present
//
// If/when jsdom is added, this file can be extended with a real DOMParser
// boot of admin-users.js and assertions against rendered rows.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let html = "";

beforeAll(() => {
  const p = resolve(process.cwd(), "dashboard/public/admin-users.html");
  html = readFileSync(p, "utf8");
});

describe("admin-users.html — static structure", () => {
  it("references the external admin-users.js module", () => {
    // Must be type="module" + src — never inline body — per CSP `script-src 'self'`.
    expect(html).toMatch(
      /<script\s+type="module"\s+src="admin-users\.js"\s*><\/script>/,
    );
  });

  it("references the shared admin.css stylesheet", () => {
    expect(html).toMatch(/<link\s+rel="stylesheet"\s+href="admin\.css"\s*>/);
  });
});

describe("admin-users.html — CSP compliance", () => {
  it("has no inline <script> body", () => {
    // An inline script would be `<script>...non-empty...</script>` with no
    // src= attribute. The loader tag has src=, so this regex excludes it.
    // We strip all `<script ... src="..."></script>` tags first, then look
    // for any remaining `<script>`.
    const stripped = html.replace(
      /<script\b[^>]*\bsrc\s*=\s*"[^"]*"[^>]*>\s*<\/script>/gi,
      "",
    );
    expect(stripped).not.toMatch(/<script\b/i);
  });

  it("has no <style> block", () => {
    // All styling lives in admin.css. Inline <style> would require
    // `style-src 'unsafe-inline'` which the deployment refuses to grant.
    expect(html).not.toMatch(/<style\b/i);
  });

  it("has no inline on* event handler attributes", () => {
    // e.g. onclick=, onload=, onchange=, onsubmit=, onerror=. Banned
    // because they execute as inline JS under CSP.
    // Regex: a whitespace boundary, then `on<word>=`, anywhere in the doc.
    const matches = html.match(/\son[a-z]+\s*=/gi);
    expect(matches, JSON.stringify(matches)).toBeNull();
  });

  it("has no inline style attributes", () => {
    // Same reasoning as the <style> rule — `style="..."` requires
    // `style-src 'unsafe-inline'`.
    expect(html).not.toMatch(/\sstyle\s*=\s*"/i);
  });
});

describe("admin-users.html — required skeleton", () => {
  it("declares an org filter <select> with id=org-filter", () => {
    expect(html).toMatch(/<select\b[^>]*\bid="org-filter"/);
  });

  it('includes an "All orgs" option as the default filter value', () => {
    // Empty value so admin-users.js sends no ?org= when this is selected.
    expect(html).toMatch(/<option\s+value=""[^>]*>All orgs<\/option>/);
  });

  it("renders the users table skeleton (thead + empty tbody)", () => {
    expect(html).toMatch(/<table\b[^>]*\bid="users-table"/);
    expect(html).toMatch(/<tbody\b[^>]*\bid="users-tbody"/);
  });

  it("includes all six required column headers", () => {
    // Order matches admin-users.js renderTable() columns.
    const headers = ["ID", "Email", "Name", "Role", "Primary org", "Last login"];
    for (const h of headers) {
      expect(html).toMatch(new RegExp("<th>" + h + "</th>"));
    }
  });

  it("includes the last-admin notice banner (hidden by default)", () => {
    // admin-users.js toggles the `hidden` attribute based on meta.admin_count.
    expect(html).toMatch(/<p\b[^>]*\bid="last-admin-notice"[^>]*\bhidden\b/);
  });

  it("provides a back-link to admin.html", () => {
    expect(html).toMatch(/<a\s+href="admin\.html"/);
  });

  it("marks the Users nav entry as active", () => {
    expect(html).toMatch(/<a\s+href="admin-users\.html"\s+class="active">/);
  });
});
