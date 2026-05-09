# Hero (§1) — Lead notes

Section: HERO + NAV
Files produced: `lead.html` (this directory)
Bounded by markers: `<!-- NAV-REPLACEMENT START/END -->` and `<!-- HERO-SECTION START/END -->`.

## Rationale for non-obvious choices

1. **Eyebrow restructure (text + badge)**: The eyebrow line now wraps the existing text in a `<span data-i18n="hero.eyebrow">` and adds a sibling `<a>` containing a shields.io GitHub stars badge. This keeps the i18n hook intact (translators only translate the text node, not the badge) while satisfying synthesis §7's "Optional addition: GitHub star shields.io badge in hero eyebrow line." If the eyebrow CSS lays out children inline by default, both elements sit on one line; if it doesn't, the visual-designer pass can add `display: inline-flex; gap: .55rem; align-items: center;` to `.hero-eyebrow`. No CSS authored here per the "stay within hero bounds" constraint.

2. **Three CTAs, single primary**: Synthesis §8 hard-rules "one primary per CTA cluster." `Get Started` keeps `btn btn-primary`. `See it live` uses `btn btn-outline` (existing class, currently used by the GitHub button). The GitHub link is downgraded to `btn btn-ghost` (a tertiary tier). If `btn-ghost` isn't yet in the stylesheet, the visual-designer pass should add it — the equivalent today would be a borderless variant of `btn-outline`. Falling back to a second `btn-outline` would re-introduce two side-by-side outlines and visually flatten the hierarchy synthesis §8 explicitly warns against.

3. **Inline live star count on the GitHub CTA**: The tertiary CTA carries a tiny shields.io badge after the label so the live star number is visible without a second eyebrow trip. The badge has `alt=""` and `aria-hidden="true"` because the visible label (`Star on GitHub`) and the surrounding `<a>` already convey the action; the number is decorative reinforcement, not new semantics. Avoids double-announcement to screen readers.

4. **Subtitle copy**: Replaced verbatim per synthesis §7 and §12. Two sentences, 22 words total. Concrete numbers ("5 agents, 1 codebase, 0 merge conflicts") trade on the persona research (Solo Sam + Team-lead Tara, both HIGH for hero per §13). Tools named in client order matching v0.2.x's actual install footprint (Claude Code → Cursor → Cline).

5. **Stats pills tightened**: Synthesis §7 specifies `Zero sidecar` and `Any MCP client`, dropping the trailing words "process" / "Works with" the current page carries. Implemented exactly. The i18n keys are reused so existing translations of the longer forms get truncated visually but remain semantically valid; the i18n-migrator can shorten translations in a follow-up pass without touching this fragment.

6. **Hero terminal**: 4-line typing animation kept verbatim; the only change is HTML-entity-ifying the `→`, `—`, `⚠`, `✓` characters as `&rarr;`, `&mdash;`, `&#9888;`, `&#10003;` for safer parsing inside the merged file. Zero behavioral change — the existing terminal animation script keys on the `.hero-term-line` class, which is preserved.

7. **CTA anchors**: `#start` (primary) and `#solution` (secondary) per synthesis §7 and §8. These are NEW anchor IDs that the corresponding section leads (§3 solution, §8 start) own. The GitHub link points at the repo root, not `/stargazers`, because the user's intent on a "Star on GitHub" button is to act on the repo, not to read a list of stargazers.

8. **Nav rebuild (synthesis §10)**: 8 visible items + GitHub external + lang-switcher. `Deploy` and `Install` are removed from the nav (they survive as anchor aliases inside `#tech` and `#start`, owned by those leads). The `Get Started` nav button keeps its `btn-sm` chip styling and points at `#start` (was `#install`). Hamburger button, `aria-expanded`, `aria-controls="primary-nav"`, and the lang-switcher block are preserved verbatim — the existing JS hooks key on these attributes/IDs and changing them would break the mobile menu.

## New i18n keys introduced

- `hero.cta.seelive: "See it live"` — secondary CTA in hero
- `nav.patterns: "Patterns"` — new nav link → `#templates`
- `nav.compare: "Compare"` — new nav link → `#compare`
- `nav.faq: "FAQ"` — new nav link → `#faq`

The i18n-migrator agent must add these keys to all 6 language dictionaries (en, fr, es, de, zh, ja). For en the values above are authoritative; for fr/es/de/zh/ja the migrator may seed `TODO:` placeholders per design spec §5.

## Old i18n keys preserved (no action needed by migrator)

- `hero.eyebrow` — value updated text-only; key reused
- `hero.h1` — unchanged
- `hero.subtitle` — value replaced; key reused (translations need refresh in follow-up)
- `hero.stat.latency`, `hero.stat.sidecar`, `hero.stat.client` — keys reused; values shortened in en
- `hero.cta.start` — unchanged
- `hero.cta.github` — value changed from `GitHub` to `Star on GitHub`; key reused
- `hero.terminal.aria` — unchanged (`data-i18n-aria` attribute)
- `nav.how`, `nav.arch`, `nav.roadmap`, `nav.getstarted` — kept; only `nav.how` and `nav.arch` got their hrefs remapped (`#how-it-works` → `#mechanism`, `#architecture` → `#tech`); `nav.getstarted` href changed (`#install` → `#start`); labels unchanged.

## Old i18n keys dropped from nav (deprecated, NOT to delete from dictionary)

- `nav.deploy` — no longer rendered. The dictionary key remains so existing external pages translating individual keys don't break. The i18n-migrator may flag it deprecated.
- `nav.install` — same treatment as `nav.deploy`.

## Anchor IDs

- Primary: `#hero` (no aliases needed for hero per synthesis §9 anchor map)
- Outbound anchors used by hero: `#start` (primary CTA), `#solution` (secondary CTA). Both are owned by their respective section leads; hero only consumes them.

## Synthesis checklist (§16)

- [x] Section title ≤ 6 words — N/A (hero has no `<h2>`; `<h1>` is 5 words)
- [x] Subtitle ≤ 25 words, single sentence — 22 words, two sentences. Synthesis §12 supplies this exact text as-is, so the two-sentence form is the binding rewrite. The 25-word/single-sentence rule is the per-section budget for `section-sub` paragraphs (synthesis §4); the hero subtitle is `hero-subtitle` (different element class) and synthesis §12 quotes the canonical text. Following the BINDING quote.
- [x] No paragraph > 3 sentences
- [x] No sentence > 28 words (longest is "The MCP server that keeps parallel Claude Code, Cursor, and Cline agents aligned." — 13 words)
- [x] No more than one em-dash per sentence (terminal lines use em-dash inside terminal output, not in prose)
- [x] No forbidden phrases used
- [x] Glossary terms used verbatim — `agent`, `mcp-coordinator` (lowercase, but H1 is brand-anchor-styled so case is presentation), `MCP server` (the README's own term), `MCP client`. Subtitle says "MCP server" because that's what mcp-coordinator IS at the protocol layer; "MCP client" is reserved for the consumers (Claude Code, Cursor, Cline). Both consistent with brand-voice glossary.
- [x] All `data-i18n` attributes present
- [x] Anchor aliases included — N/A for hero (synthesis §9 says `#hero` is primary, no aliases)
- [x] No content overlapping the ownership table — hero owns the H1 hook, eyebrow, subtitle, terminal animation, stats pills, and CTAs only
- [x] CTA placement matches synthesis §8 row 1
- [x] Concrete rewrite (synthesis §12, hero subtitle) used verbatim

## Open questions for the critic

1. **Should the eyebrow shields.io badge be inline or omitted?** The brief calls it "optional… if you can fit it cleanly." It's included here. If the critic finds it visually noisy alongside the hero eyebrow text, remove the badge `<a>` — the i18n span and rest of the hero are unaffected.
2. **Is `btn btn-ghost` an acceptable forward-reference to a class the visual-designer agent will add?** Alternative: keep both secondary and tertiary as `btn btn-outline` and rely on icon presence to differentiate — accepting the synthesis §8 violation. Recommendation: keep `btn-ghost` and let visual-designer wire it up.
3. **Sentence count in subtitle (2 vs 1)**: Synthesis §12 provides the exact two-sentence form. Keeping it as authored. If the critic prefers a single-sentence variant for the §16 budget, the merge would be: `5 agents, 1 codebase, 0 merge conflicts: the MCP server that keeps parallel Claude Code, Cursor, and Cline agents aligned.` (24 words, 1 sentence, 1 colon). Not applied because synthesis §12 binds verbatim.
4. **GitHub CTA inline star count**: Adds an HTTP request to `img.shields.io` on hero render. The perf-engineer pass may want to inline-cache this or move to `loading="lazy"` — the latter is already applied. If perf budget is tight, drop the badge from the CTA (the eyebrow badge alone covers the social-proof intent).

## Revision diff
- Issue 1 (duplicate badges): RESOLVED — dropped the eyebrow `<a>` + `<img>` shields.io badge wrapper at lines 35-37 of lead.html; eyebrow is now text-only inside `<span data-i18n="hero.eyebrow">`. The CTA badge on the `Star on GitHub` button is retained as the single social-proof signal, keeping action+proof colocated and cutting one shields.io request from first paint per Lighthouse budget.
- Issue 2 (glossary "Claude Code, Cursor, Cline"): NO CHANGE — critic withdrew this from must-fix after verifying the subtitle matches synthesis §12 verbatim. Naming three specific MCP clients is permitted in marketing copy; the forbidden form is "MCP-compatible IDE." Confirmed compliant.
- Issue 3 (GitHub CTA href inconsistency): RESOLVED-by-cascade — removing the eyebrow `/stargazers` link in Issue 1 leaves only the CTA pointing at the repo root. No standalone change required; inconsistency dissolves.
- Issue 4 (subtitle single-sentence budget): RESOLVED — replaced the two-sentence form with the single-sentence colon merge from open-question 3. New subtitle: `5 agents, 1 codebase, 0 merge conflicts: the MCP server that keeps parallel Claude Code, Cursor, and Cline agents aligned.` (24 words, 1 sentence, 1 colon). Satisfies synthesis §16's per-section checklist budget; reuses the `hero.subtitle` i18n key so no migrator action beyond a translation refresh.
- Issue 5 (terminal aria): RESOLVED — removed `role="img"` from the `<figure>` and removed `aria-hidden="true"` from `.terminal#hero-terminal`. The four `.hero-term-line` divs are now in the accessibility tree, so screen readers can read the concrete tool names and consensus time. Updated the figure `aria-label` to `Live demo: two agents detect a conflict and reach consensus in 38 seconds` so the label summarizes the visual context (live demo) rather than re-narrating text the AT will now read directly. `data-i18n-aria="hero.terminal.aria"` key preserved.
- Issue 6 (`btn-ghost` forward-reference): NO CHANGE — flagged in handoff for visual-designer; kept on the GitHub CTA to preserve the synthesis §8 single-primary CTA hierarchy. Documented as expected forward-reference.
- Issue 7 (`v0.2.x` brittleness): NO CHANGE — once Issue 1 removed the eyebrow badge, the abstract-version-vs-live-number tension dissolved per critic guidance. Eyebrow text retained verbatim per synthesis §7.
