# Consistency Review — index-draft-v3.html

Audited cross-section consistency against `04-brand-voice.md` glossary and `00-synthesis.md` rules.
All 14 fixes were applied directly to the draft via the Edit tool.

---

FIX 1: Lowercase "Coordinator" comment in MQTT terminal block
WHERE: line 1836 (mechanism advanced terminal)
ISSUE: Comment `# Coordinator publishes an event` capitalizes a glossary term that MUST be lowercase ("mcp-coordinator" / "coordinator") per brand-voice glossary.
RESOLUTION: applied via Edit tool — changed to `# coordinator publishes an event`

FIX 2: "Coordinator," sentence-start in tech.deploy.local.desc
WHERE: line 2115
ISSUE: "Coordinator, broker, and dashboard on your machine." Capitalized term + verb-less fragment. Glossary forbids capitalized "Coordinator".
RESOLUTION: applied via Edit tool — rewrote as "The coordinator, broker, and dashboard run on your machine." (adds verb, lowercases per glossary)

FIX 3: EN translation sync for tech.deploy.local.desc
WHERE: line 2795 (translations.en)
ISSUE: Same string as FIX 2 lived in the i18n table; would re-introduce the violation when the language switcher fired.
RESOLUTION: applied via Edit tool — synced to match FIX 2

FIX 4: "Coordinator events" in faq.a10
WHERE: line 2372 (and i18n key + JSON-LD schema)
ISSUE: Capitalized "Coordinator" violates glossary. Sentence-start required either lowercase + restructure or use of canonical "mcp-coordinator".
RESOLUTION: applied via Edit tool — changed to "mcp-coordinator events arrive between turns…" (canonical glossary form)

FIX 5: EN translation sync for faq.a10
WHERE: line 2866 (translations.en)
ISSUE: i18n value mirrored the violation in FIX 4.
RESOLUTION: applied via Edit tool — synced to match FIX 4

FIX 6: JSON-LD FAQ schema sync for q10
WHERE: line 2460 (FAQPage structured data)
ISSUE: SEO/structured data carried the capitalized form, which would surface in search results.
RESOLUTION: applied via Edit tool — synced to match FIX 4

FIX 7: Architecture diagram label "Coordinator"
WHERE: line 2081 (.arch-box accent)
ISSUE: Diagram box rendered "Coordinator" as a label. Glossary mandates lowercase.
RESOLUTION: applied via Edit tool — changed to "coordinator"

FIX 8: Local-mode deploy diagram labels
WHERE: lines 2122, 2127 (.dd-box dd-accent)
ISSUE: Two "Coordinator" / "Dashboard" labels in the local-mode diagram capitalized glossary terms ("dashboard" is also in the binding glossary).
RESOLUTION: applied via Edit tool — both lowercased to "coordinator" / "dashboard"

FIX 9: Team-server deploy diagram labels
WHERE: line 2143 (.dd-box dd-accent in team mode)
ISSUE: Server box used capitalized "Coordinator" and "Dashboard" inside its small-text breakdown.
RESOLUTION: applied via Edit tool — both lowercased to match glossary

FIX 10: Cloud-mode deploy diagram label
WHERE: line 2165 (.dd-box dd-violet)
ISSUE: "Coordinator + Aedes" capitalized the glossary term.
RESOLUTION: applied via Edit tool — changed to "coordinator + Aedes"

FIX 11: tech.arch.card2.title "Coordinator server"
WHERE: line 2098 (and EN translation line 2789)
ISSUE: Card heading used capitalized "Coordinator". Sentence-case heading guideline + glossary both ban this form.
RESOLUTION: applied via Edit tool — changed to "mcp-coordinator server" (canonical glossary form, more explicit)

FIX 12: Inline `<code style="font-size:0.8em">` -> `<code class="ic">`
WHERE: lines 1792-1827 (8 MQTT-table payload cells), plus 8 mirrored values in the EN translations table
ISSUE: Eight `<td>` payload cells used inline `style="font-size:0.8em"` instead of the pre-existing `.ic` (inline-code) class defined at line 1448. Created two divergent inline-code styles in the same section. Synthesis §5 says "Inline shell tokens use `<code>`" with a unified styling; the existing `.ic` class is the canonical mechanism (already used by start.step2/3/4 and arch.card3).
RESOLUTION: applied via Edit tool — replaced all 8 visible occurrences and 8 i18n string occurrences (16 total) with `<code class="ic">`

FIX 13: Hero subtitle separator (":" -> ".")
WHERE: line 1603 + EN translation line 2656
ISSUE: Visible HTML used "0 merge conflicts: the MCP server…" while synthesis §12 explicitly mandates "0 merge conflicts. The MCP server…" as the binding hero rewrite. Two-sentence form also matches the brand-voice density rule (shorter sentences).
RESOLUTION: applied via Edit tool — replaced colon with period and capitalized "The" in both surfaces

FIX 14: JSON-LD `text` for q10 sync (counted as part of FIX 6 above)
N/A — folded into FIX 6.

---

## Cross-section verification (no fix needed)

- **CTA button labels**: "Get Started" (nav + hero CTA) vs "Get started" (h2) — distinct contexts (button label vs sentence-case heading). Internally consistent across CTAs and across headings. No change.
- **Code style for install snippets**: `npm install -g mcp-coordinator` is used uniformly (start.step1, compare.cta, faq.a8). No `npx`. No bare `npm install`. Consistent.
- **MCP tool names**: `announce_work`, `coordinator_status`, `register_agent`, `post_to_thread`, `propose_resolution` — all snake_case throughout (no camelCase variants found). Consistent.
- **"you" voice**: scanned for "we / users / developers" in body prose; only matches were inside the deprecated/legacy zone (line 2912+) flagged as backwards-compat. No live-content violations.
- **Forbidden phrases**: scanned for "revolutionary, game-changing, AI-powered, AI-native, intelligent coordination, seamless, supercharge, effortlessly, magically, empower". Zero matches in live content. Two stale "AI agent" strings live only in the deprecated translation zone — preserved per backwards-compat note.
- **Em-dashes**: spot-checked; pain card 2 and score-row labels use single em-dash per sentence (within budget). No violation.
- **Emoji policy**: card icons all wrapped in `<span aria-hidden="true">` or `aria-hidden` containers. No emoji in headings, prose, or CTAs.
- **"consultation thread"**: glossary verbatim use confirmed in mechanism.step3, solution mock, compare.card2, templates.parallel.

---

DONE.

**Fixes applied: 14**
**Final byte count: 459,128 bytes** (5,887 lines)
