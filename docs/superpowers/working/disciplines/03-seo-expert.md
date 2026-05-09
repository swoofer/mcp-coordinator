# SEO Audit — index-draft-v1.html

## Summary

| Item | Status |
|---|---|
| `<title>` tag preserved | OK |
| `<meta description>` preserved | OK |
| Open Graph tags present | OK (description copy is acceptable but stale vs hero) |
| Twitter Card tags present | OK (same) |
| `SoftwareApplication` JSON-LD in `<head>` | OK (lines 30-60) |
| `FAQPage` JSON-LD valid | **OK — parses cleanly, all 10 Q/A present** |
| H1 uniqueness | OK (single H1 line 1354) |
| H2/H3 keyword usage | OK |
| Internal anchor links resolve | OK (every `href="#…"` matches a real `id`) |
| Canonical URL | OK (line 10) |
| `robots` meta | OK (line 13) |
| `sitemap.xml` lists page | OK (only entry, root URL) |
| New section IDs work as anchors | OK (`#hero`, `#pain`, `#solution`, `#mechanism`, `#templates`, `#compare`, `#tech`, `#start`, `#results`, `#faq`, `#roadmap`, plus `#install`, `#dashboard`, `#why`, `#main`) |

## FAQPage JSON-LD validation

Parsed cleanly against schema.org/FAQPage:
- `@context` = `https://schema.org` — OK
- `@type` = `FAQPage` — OK
- `mainEntity` = array of 10 `Question` objects — OK
- Each `Question` has `name` + `acceptedAnswer` of `@type: Answer` with `text` — OK
- All 10 questions present (Q1 worktrees, Q2 production-ready, Q3 cost, Q4 clients, Q5 multi-repo, Q6 JWT, Q7 Aider/Cline, Q8 maintenance, Q9 down, Q10 turn-context) — OK
- Inline `<code>` and `<a>` elements stripped from JSON `text` (per Google guidance) — OK
- No errors; ready for Rich Results test.

## Required fixes

### Fix 1 — Tighten OG / Twitter description to match new hero subtitle

The current OG/Twitter description still emphasises "announce work / detect conflicts / reach consensus", but the merged hero subtitle now leads with "5 agents, 1 codebase, 0 merge conflicts". Align them so social previews echo the new H1+subtitle pair.

```
<<<<<<< SEARCH
  <meta property="og:title" content="MCP Coordinator — Zero conflicts. Every agent aligned." />
  <meta property="og:description" content="Drop-in MCP server that lets parallel Claude Code, Cursor, or Cline agents announce their work, detect conflicts, and reach consensus before they touch your code." />
=======
  <meta property="og:title" content="MCP Coordinator — Zero conflicts. Every agent aligned." />
  <meta property="og:description" content="5 agents, 1 codebase, 0 merge conflicts. The MCP server that keeps parallel Claude Code, Cursor, and Cline agents aligned — embedded MQTT broker, MIT, no sidecar." />
>>>>>>> REPLACE
```

```
<<<<<<< SEARCH
  <meta name="twitter:title" content="MCP Coordinator — Zero conflicts. Every agent aligned." />
  <meta name="twitter:description" content="Drop-in MCP server that lets parallel Claude Code, Cursor, or Cline agents announce their work, detect conflicts, and reach consensus before they touch your code." />
=======
  <meta name="twitter:title" content="MCP Coordinator — Zero conflicts. Every agent aligned." />
  <meta name="twitter:description" content="5 agents, 1 codebase, 0 merge conflicts. The MCP server that keeps parallel Claude Code, Cursor, and Cline agents aligned — embedded MQTT broker, MIT, no sidecar." />
>>>>>>> REPLACE
```

### Fix 2 — Update sitemap.xml `<lastmod>` (currently missing)

Search engines weight `<lastmod>` for re-crawl scheduling; the merged page is a substantial rewrite. File: `docs/sitemap.xml`.

```
<<<<<<< SEARCH
  <url>
    <loc>https://swoofer.github.io/mcp-coordinator/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
=======
  <url>
    <loc>https://swoofer.github.io/mcp-coordinator/</loc>
    <lastmod>2026-05-09</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
>>>>>>> REPLACE
```

### Fix 3 — Add `softwareVersion` bump in SoftwareApplication JSON-LD

The schema currently shows `0.2.1`; the footer references `v0.2.x`. If the merge ships alongside a release, bump to the actual published version. Verify before merge — if still 0.2.1 in package.json, skip this fix.

## Notes (no fix required)

- `<title>` length: 78 characters — slightly over Google's ~60-char display cap but content is keyword-dense; acceptable.
- `<meta description>`: 264 chars — over the ~160 display cap but text is good; Google will truncate, no penalty.
- H1 is unique (only `hero.h1` line 1354). All H2s use `section-title` class with semantic keywords (How it works, Architecture & deployment, Tested coordination scenarios, FAQ, Roadmap).
- Footer `href="#install"` resolves to `<span id="install" class="anchor-alias">` inside `#start` (line 2003) — OK.
- All nav links (`#mechanism`, `#templates`, `#compare`, `#tech`, `#faq`, `#roadmap`, `#start`) resolve to existing section IDs.
- `lang="en"` on `<html>` matches the default-rendered text; the i18n switcher swaps content client-side, so the static lang attribute is correct for first paint.
- `inLanguage` array in SoftwareApplication schema correctly lists all 6 supported locales.

DONE — `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\disciplines\03-seo-expert.md`
