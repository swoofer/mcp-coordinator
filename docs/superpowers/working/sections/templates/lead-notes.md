# Templates section (§5) — lead notes

Section ID stays `templates` for CSS-class compatibility (`.tmpl-*` is already defined at lines 1111-1212 of `docs/index.html`). User-facing prose says "coordination pattern" or "pattern" only — never "template" — per the brand-voice glossary. The `<h2>` is "Coordination patterns".

## Rationale per pattern

### Parallel
- **Description**: emphasizes the simultaneous start and the fact that consultation only kicks in on overlap (matches actual coordinator behavior — no traffic when nothing collides).
- **Flow viz**: 4 boxed agents in blue, vertical bars, an overlap label on `types.ts` (concrete file), then a green "consultation" arrow. Picks up the running narrative the rest of the page builds (announce → detect → consult → resolve).
- **Tags**: `4-8 agents` matches realistic squad size for solo/team usage. `mode: parallel` and `profile: coder` come straight from spec section 4.5.
- **Behaviors**: Foundation (announce/consult/resolve = the 4-step cycle), Pattern (contend on overlap), Mission (ship feature batch), Safety (block on impact >= 80, the same threshold called out in mechanism's scoring sub-block).

### Sequential
- **Description**: declared order + handoff between turns. "between turns" is glossary-binding.
- **Flow viz**: linear chain `A -> B -> C` labeled `spec / code / test`, the canonical 3-step pipeline familiar to any engineer.
- **Tags**: `2-5 agents`, `mode: sequential`, `profile: pipeline` — verbatim from spec.
- **Behaviors**: Pattern (wait for upstream resolve), Mission (`spec -> code -> test`), Safety (stop chain on failed step) — matches a typical CI-style chain.

### Hierarchy
- **Description**: lead splits and dispatches; subordinates announce, consult, and report. Reuses glossary verbs.
- **Flow viz**: tree shape with `[lead]` at the top fanning to A/B/C, with upward arrows showing reporting — most legible ASCII shape that fits 280px-wide cards.
- **Tags**: `1+N agents`, `mode: hierarchy`, `profile: lead-dispatch` — verbatim from spec.
- **Behaviors**: Pattern (lead dispatches, workers report), Mission (decompose then assemble), Safety (lead vetoes risky merges) — captures the coordination value-add of having a lead.

### Read-only
- **Description**: observers reading the timeline, posting warnings/comments without announcing. The `tag-rule` "no writes" tag highlights the constraint.
- **Flow viz**: 3 working agents at top, an `[obs]` agent below reading the timeline and posting comments/warnings.
- **Tags**: `0..many`, `mode: readonly`, `profile: reviewer`, plus the unique `tag-rule` `no writes` (only this card uses `tag-rule` — every other card has 3 tags, this one has 4 to surface the hard constraint).
- **Behaviors**: Pattern (observe without announcing), Safety (refuse all write tools) — matches the readonly profile's MCP tool whitelist.

## i18n keys (all NEW — section is brand new, no old keys to alias)

Approximately 40 keys. Naming follows `templates.<pattern>.<field>` pattern with shared `templates.layer.*` keys for the 4 behavior-layer labels (foundation/pattern/mission/safety) since those repeat across all 4 cards.

```
templates.title
templates.subtitle
templates.footnote
templates.footnoteLink

templates.layer.foundation
templates.layer.pattern
templates.layer.mission
templates.layer.safety

templates.parallel.name
templates.parallel.desc
templates.parallel.tagAgents
templates.parallel.tagMode
templates.parallel.tagProfile
templates.parallel.foundation
templates.parallel.pattern
templates.parallel.mission
templates.parallel.safety

templates.sequential.name
templates.sequential.desc
templates.sequential.tagAgents
templates.sequential.tagMode
templates.sequential.tagProfile
templates.sequential.foundation
templates.sequential.pattern
templates.sequential.mission
templates.sequential.safety

templates.hierarchy.name
templates.hierarchy.desc
templates.hierarchy.tagAgents
templates.hierarchy.tagMode
templates.hierarchy.tagProfile
templates.hierarchy.foundation
templates.hierarchy.pattern
templates.hierarchy.mission
templates.hierarchy.safety

templates.readonly.name
templates.readonly.desc
templates.readonly.tagAgents
templates.readonly.tagMode
templates.readonly.tagProfile
templates.readonly.tagRule
templates.readonly.foundation
templates.readonly.pattern
templates.readonly.mission
templates.readonly.safety
```

## Anchor IDs

- Primary: `#templates` only.
- No old anchor aliases — this is a brand-new section per synthesis section 9 (anchor-aliases table only lists existing IDs).

## CSS classes used (all pre-existing, none proposed)

- Layout: `.container`, `.text-center`, `.section-title`, `.section-sub`, `.tmpl-grid`, `.fade-in`
- Card: `.tmpl-card`, `.tmpl-header`, `.tmpl-icon` + `.parallel/.sequential/.hierarchy/.readonly`, `.tmpl-name`, `.tmpl-desc`
- Flow: `.tmpl-flow`, `.fl-green`, `.fl-blue`, `.fl-yellow`, `.fl-dim`
- Tags: `.tmpl-meta`, `.tmpl-tag` + `.tag-agents/.tag-mode/.tag-profile/.tag-rule`
- Behaviors: `.tmpl-behaviors`, `.tmpl-layer`, `.tmpl-layer-bar` + `.foundation/.pattern/.mission/.safety`, `.tmpl-layer-text`

**No new CSS classes proposed.** Every `.tmpl-*` and `.fl-*` class defined at lines 1111-1212 is now used by this section.

The footnote uses an inline `style="margin-top: 1.5rem; color: var(--muted); font-size: 0.9rem;"` rather than a new class. If the visual-designer agent prefers to extract this into a `.tmpl-footnote` class, that's a reasonable polish — but it is one paragraph and I did not want to introduce a new class for a single use.

## Brand-voice checklist (per synthesis section 16)

- [x] Section title `Coordination patterns` — 2 words (<= 6)
- [x] Subtitle 1 sentence, 14 words (<= 25)
- [x] Each card description <= 2 sentences, max 22 words
- [x] No sentence > 28 words
- [x] No paragraph > 3 sentences
- [x] No more than one em-dash per sentence (zero used)
- [x] Forbidden phrases avoided (no "seamless", "revolutionary", "AI-powered", "magically", etc.)
- [x] Glossary terms verbatim: "agent", "consultation", "MQTT broker", "between turns", "essaim" (lowercase), "announce work" (verb form: "announce", "announcing")
- [x] No "template" / "blueprint" / "recipe" in user-facing prose
- [x] All `data-i18n` attributes present
- [x] No content overlap with `mechanism` (no scoring grid, no MQTT topics, no 4-step protocol explanation here — only references via behavior-layer labels)
- [x] No CTA (synthesis section 8 doesn't place a CTA cluster here; mechanism owns the next CTA)
- [x] Word count: ~190 visible words (excluding flow code blocks and tags), under the 220-word ceiling
- [x] Reader address: never used "we" / "users" / "developers" — patterns are described in third person about agents

## Open questions for critic

1. **Behavior-layer values appropriateness** — I made judgement calls on what each layer "is" per pattern (e.g., Hierarchy Pattern = "lead dispatches, workers report"). The spec gives the layer names but not the per-pattern values. Are these values accurate to how essaim actually composes behaviors? If essaim's catalog has canonical names for these layer compositions (e.g., a specific "contention" behavior name for parallel's pattern layer), we should use those verbatim. The footnote already links to `https://github.com/swoofer/essaim/tree/main/behaviors` — critic should cross-check.

2. **Flow viz density** — The ASCII flow diagrams use `<pre>` inside `.tmpl-flow`. The CSS sets `font-size: 0.72rem` which is small. On 280px-wide cards (the grid's `minmax(280px, 1fr)`), the parallel and hierarchy flows might wrap awkwardly. Consider replacing `<pre>` with `<div>` + `<br>` if word-wrap becomes an issue, or trimming the flow content. I kept `<pre>` because the existing `.tmpl-flow` selector implies preformatted content (`font-family: monospace`, `line-height: 1.6`, `overflow-x: auto`).

3. **Read-only's 4 tags vs others' 3** — Only the readonly card uses `tag-rule` ("no writes"), making it visually heavier than the other three. This was intentional (the rule IS the defining characteristic of the pattern), but if the visual-designer prefers uniform tag count, we'd need to either drop the rule tag or add a similar safety/rule tag to the other three patterns. My take: the asymmetry is correct because the constraint IS the message.

4. **Footnote link style** — Inline `<p>` with arrow link versus a styled CTA-like component. I chose the lighter footnote treatment per synthesis section 8 (no CTA cluster placement here) and because the spec calls it a "tagline / footnote", not a CTA.

5. **`section-title` and `section-sub` classes** — I followed the pattern from `pain/lead.html` which uses `<h2 class="section-title">` and `<p class="section-sub">`. If the canonical structure for new sections elsewhere uses different wrapper classes, please flag.

## Revision diff

Applied all 6 critic issues. No new CSS classes introduced. Glossary discipline preserved — prose still says "coordination pattern" only, never "template".

### 1. Hierarchy icon glyph (critic issue 1)
- **Before**: `<div class="tmpl-icon hierarchy" aria-hidden="true">&#9783;</div>` (same `&#9783;` ☧ as parallel)
- **After**: `<div class="tmpl-icon hierarchy" aria-hidden="true">&#9874;</div>` (`&#9874;` ⚒ hammer-pick)
- **Why**: Four cards must be visually distinct; sharing a glyph between parallel and hierarchy was a duplication bug. Picked the hammer-pick suggestion from the critic's first option for clarity.

### 2. Subtitle folded to single sentence (critic issue 2)
- **Before**: `Pre-built coordination shapes for common multi-agent scenarios. Composable with essaim behaviors.` (2 sentences)
- **After**: `Pre-built coordination shapes for common multi-agent scenarios, composable with essaim behaviors.` (1 sentence, 13 words — well under the 25-word ceiling from synthesis §4)
- **Why**: Synthesis §4 mandates `section-sub paragraph: ≤ 25 words, single sentence`.

### 3. Foundation layer includes "detect" (critic issue 3)
- **Before**: `announce, consult, resolve` (3 of the 4 canonical steps) on parallel/sequential/hierarchy
- **After**: `announce, detect, consult, resolve` (full 4-step protocol) on parallel/sequential/hierarchy
- **Why**: Mechanism owns the canonical cycle; truncating it here was inconsistent. Read-only's foundation `subscribe, read events` legitimately differs and was left untouched per critic note.

### 4. Parallel description anchors on "consultation thread" noun (critic issue 4)
- **Before**: `All agents start at once. They consult through the MQTT broker the moment two announcements overlap.`
- **After**: `All agents start at once. The coordinator opens a consultation thread the moment two announcements overlap.`
- **Why**: Glossary `PREFER: "consultation thread"`. First occurrence in this section now anchors on the glossary noun phrase. The verb form remains acceptable for later occurrences per synthesis §3 footnote, but the leading mention should establish the noun.

### 5. Read-only flow viz cleaned up (critic issue 5)
- **Before**: `[A] [B] [C] working` on row 1 (parses awkwardly as "C working") and `&rarr; comment, warn` on the last row.
- **After**: `[A] [B] [C]` (dropped the dangling "working" — flow already implies activity) and `&rarr; posts comment or warning` (full clause instead of comma fragment).
- **Why**: The dangling `working` token attached visually to `[C]` only. Flow + bars already convey activity without the extra word.

### 6. Parallel flow viz labels the [C] [D] overlap (critic issue 6)
- **Before**: 4 boxed agents with 4 bars, then 2 bars and an unattributed `&rarr; overlap on types.ts`, then 2 more bars and `consultation` — reader had to infer which 2 of 4 collided.
- **After**: 4 boxed agents with 4 bars, then `A & C overlap` on `types.ts`, then `&rarr; consultation` — collision pair is now explicit.
- **Why**: ASCII flows must be self-evident. The visual now confirms what the description says rather than relying on inference.

### Untouched (per critic "DO NOT TOUCH")

CSS classes (no new classes added; every `.tmpl-*` and `.fl-*` class was already used correctly), section ID `templates`, `<h2>` text "Coordination patterns", read-only's 4 tags vs others' 3, footnote link to `github.com/swoofer/essaim/tree/main/behaviors`, all 4 behavior-layer rows on every card, verbatim spec §4.5 tag values, no CTA in this section, no anchor alias span.
