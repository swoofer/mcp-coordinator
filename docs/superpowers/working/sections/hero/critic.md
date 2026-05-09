# Hero (§1) — Critic review of lead.html

Scope: 7 issues. The lead's overall structure tracks synthesis §7/§8/§10 well; problems concentrate around (a) duplicate social-proof badges, (b) tool-name capitalization vs glossary, (c) the eyebrow "v0.2.x" vs synthesis copy, and (d) terminal accessibility decisions.

---

ISSUE 1 (must-fix): Duplicate shields.io badges on hero
LOCATION: lines 35-37 (eyebrow badge) and lines 63 (CTA badge)
WHY: Two live shields.io requests on a single first-paint hero bloat the perf budget (synthesis §6, success criteria Lighthouse >= 95 desktop) and visually shout the same number twice (eyebrow + tertiary CTA). Open question 1 + 4 in lead-notes both surface this risk. Resolution: keep ONE badge. The eyebrow placement reads as social-proof signal alongside "Open Source · MIT · v0.2.x"; the CTA badge is the better fit because the action and the proof live together. Drop the eyebrow badge.
SEARCH:
      <span data-i18n="hero.eyebrow">Open Source &middot; MIT &middot; v0.2.x</span>
      <a href="https://github.com/swoofer/mcp-coordinator/stargazers" target="_blank" rel="noopener noreferrer" class="hero-eyebrow-badge" aria-label="GitHub stars">
        <img src="https://img.shields.io/github/stars/swoofer/mcp-coordinator?style=flat-square&logo=github&label=stars&color=2a3144&labelColor=10131c" alt="GitHub stars" width="92" height="20" loading="lazy" decoding="async">
      </a>
REPLACE:
      <span data-i18n="hero.eyebrow">Open Source &middot; MIT &middot; v0.2.x</span>

ISSUE 2 (must-fix): Glossary violation — "Claude Code, Cursor, and Cline"
LOCATION: line 40, hero subtitle
WHY: Brand-voice §3 binds `MCP client` as the prefer-form and "MCP-compatible IDE" as a forbidden form. Naming three specific clients in the subtitle is fine for marketing punch, but synthesis §12 quotes the canonical text VERBATIM and that text is what's already used. Verify: the lead matches §12 exactly. CONFIRMED — keep as-is. Withdrawn from must-fix; promoting to nit-only documentation note. (No change required.)
SEARCH: (none)
REPLACE: (none — verified compliant)

ISSUE 3 (must-fix): GitHub CTA href inconsistency with eyebrow badge
LOCATION: line 60 vs line 35
WHY: The eyebrow badge points at `/stargazers` (a list) and the CTA points at the repo root. Once Issue 1 lands and only the CTA remains, the inconsistency disappears. Confirms the Issue 1 resolution direction. (No standalone change.)

ISSUE 4 (must-fix): Subtitle violates synthesis §16 single-sentence budget
LOCATION: line 40
WHY: Lead-notes question 3 raises this. Synthesis §16 says "Subtitle ≤ 25 words, single sentence." Synthesis §12 quotes a 2-sentence form as the binding rewrite. The two rules conflict; §16 is the per-section CHECKLIST every lead must tick, §12 is the per-section starting copy. The checklist wins because it is stated as required for ALL leads. Use the lead-notes' own single-sentence merge.
SEARCH:
    <p class="hero-subtitle" data-i18n="hero.subtitle">5 agents, 1 codebase, 0 merge conflicts. The MCP server that keeps parallel Claude Code, Cursor, and Cline agents aligned.</p>
REPLACE:
    <p class="hero-subtitle" data-i18n="hero.subtitle">5 agents, 1 codebase, 0 merge conflicts: the MCP server that keeps parallel Claude Code, Cursor, and Cline agents aligned.</p>

ISSUE 5 (must-fix): Terminal `aria-hidden="true"` makes the figcaption pointless
LOCATION: lines 48-55
WHY: The `<figure>` carries `role="img"` + `aria-label` describing the scene, then the inner `.terminal` is `aria-hidden="true"`. That is correct semantically — but the four lines contain real value (concrete tool names, the consensus time) that a screen reader user with the aria-label still won't hear in detail. Remove the `role="img"` pattern; let the terminal lines be readable by AT, and add an `aria-label` on the figure summarizing only what the visual conveys uniquely (color coding). The text content is already accessible.
SEARCH:
    <figure role="img" aria-label="Two coding agents detect a file conflict and reach consensus in 38 seconds" data-i18n-aria="hero.terminal.aria">
      <div class="terminal" id="hero-terminal" aria-hidden="true">
REPLACE:
    <figure aria-label="Live demo: two agents detect a conflict and reach consensus in 38 seconds" data-i18n-aria="hero.terminal.aria">
      <div class="terminal" id="hero-terminal">

ISSUE 6 (must-fix): `btn-ghost` forward-reference is fine — but document the fallback
LOCATION: line 60
WHY: Lead-notes question 2. Synthesis §8 hard-bans two side-by-side primaries; the lead correctly downgrades the GitHub link to a tertiary tier. `btn-ghost` is not in the current stylesheet, so visual-designer MUST add it. Acceptable as forward-reference. No HTML change. (Flagging for visual-designer handoff only.)

ISSUE 7 (must-fix): Eyebrow version string `v0.2.x` is brittle
LOCATION: line 34
WHY: Synthesis §7 specifies `Open Source · MIT · v0.2.x` verbatim — kept as-is. The `x` placeholder reads odd alongside the live star count badge (concrete number next to abstract version). Once Issue 1 removes the eyebrow badge, the tension dissolves. (No standalone change once Issue 1 lands.)

---

## DO NOT TOUCH

- **Nav rebuild (lines 2-27)**: 8 visible items + GitHub external + lang-switcher matches synthesis §10 row-for-row. Hamburger ARIA, `aria-controls="primary-nav"`, lang-switcher `aria-pressed` all preserved verbatim.
- **H1 (line 39)**: `Zero conflicts. Every agent aligned.` — synthesis §7 binds verbatim.
- **Stat pills (lines 42-46)**: tightened exactly per synthesis §7.
- **Terminal copy (lines 50-53)**: 4-line typing animation kept; HTML-entity safety upgrade (`&rarr;`, `&mdash;`, `&#9888;`, `&#10003;`) is correct for merged-file safety.
- **CTA tier ladder (lines 57-65)**: primary/outline/ghost progression matches synthesis §8 hard rule "one primary per CTA cluster."
- **Glossary compliance**: `MCP server`, `MCP client` used per brand-voice §3.