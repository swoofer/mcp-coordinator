# §4 Mechanism — lead notes

Triple fusion of the current `#how-it-works` (lines 1484-1522), `#mqtt` (1525-1629), and `#scoring` (1664-1693) into a single `#mechanism` section. Section closes with CTA #2 from the synthesis CTA strategy (synthesis §8).

---

## Triple-fusion rationale

The current page exposes the same protocol three times: 4 steps in `#how-it-works`, scoring rows in `#scoring`, MQTT topic table + push terminal in `#mqtt`. The spec (§3, §4.4) and synthesis (§2 ownership table) both pin the entire mechanism to one section. This draft folds the three into a single arc:

1. **Surface story** — 4 steps (the protocol cycle most readers need).
2. **Decision rule** — impact score grid (the engineering specifics for evaluators).
3. **Wire-level detail** — MQTT topics table + push flow terminal, behind a native `<details>` toggle. Only the technical evaluator persona (Alex) opens it.

### What moved (kept content, new home)

| From | To | Notes |
|------|-----|-------|
| 4 steps grid | Sub-block 1 | Preserved 1:1 except brand-voice rewrites on every step description. The "Consult" step uses the verbatim mandatory rewrite from synthesis §12. |
| `.score-grid` rows | Sub-block 2 | Preserved 1:1; subtitle shortened. Footnote kept. |
| MQTT table | Sub-block 3 (collapsible) | Preserved 1:1 with new i18n key prefix. |
| Push delivery flow terminal | Sub-block 3 (collapsible) | Preserved 1:1. |

### What was dropped (or reduced)

- **`#mqtt` 3-card grid** ("Embedded Aedes broker", "Push, not poll", "Self-filter built-in") — dropped entirely. Their content is captured by the topic table and push flow terminal; keeping the cards would re-introduce the redundancy the spec explicitly identifies (Problem B in spec §2). Rationale: every fact in those 3 cards is either (a) shown in the topic table, (b) shown in the terminal, or (c) restated as the one-line `advanced-intro` paragraph. Repeating it as 3 separate cards would push us past the 220-word cap with no new information.
- **`how-modes-inset` "Two ways to consume coordination events"** (the polling vs. push expanded paragraph at current line 1516-1519) — dropped from this section. The push half is now the collapsible Sub-block 3. The polling half belongs in FAQ (synthesis §14 Q1 "yet another tool to maintain" or a dedicated polling Q in faq's expansion).
- **`#mqtt` heading "Real-time push via embedded MQTT"** — replaced by the `<summary>` of the collapsible. The "embedded MQTT" hook lives there as a one-line tease.
- **`#mqtt` subtitle paragraph** — collapsed into the `mechanism.advanced.intro` line.
- **`#scoring` standalone H2** — dropped, replaced by the inline H3 sub-heading inside `#mechanism`. This honors synthesis §2: scoring is owned by mechanism as a sub-block, never as its own section.

### Brand-voice rewrites applied (synthesis §12 + glossary)

- **Step 3 (Consult)** — verbatim mandatory rewrite from synthesis §12. Replaced em-dash dump and parenthetical glossing.
- **Step 1 (Announce)** — split one 23-word sentence into a 12-word + 4-word pair. Removed em-dashes.
- **Step 2 (Detect)** — trimmed from 24 words to 15 words. Removed "across multiple layers" hedging in favor of the concrete "six layers".
- **Step 4 (Resolve)** — split into three short sentences. Dropped the "auto-resolves in gray zones" clause (covered by the gray-zone score rows in sub-block 2).
- **Subtitle** — reduced from 14 words to 12, single sentence, no em-dash.
- **Scoring subtitle** — reduced and rephrased to surface the 0–100 range without numerals in the heading.

### Forbidden phrases — none used

Audited: no "seamless", "magically", "intelligent coordination", "AI-powered", "revolutionary", "unleash", "the only X that...", "empower", em-dash overuse. One em-dash per sentence maximum.

### Glossary terms — used verbatim

`agent`, `consultation thread`, `MQTT broker`, `mcp-coordinator` (in i18n key, per CSS-class compatibility), `announce work` (verb), `impact score`, `consultation`, `consensus`, `between turns`. The phrase "MCP Coordinator" (capitalized) is not used anywhere in the section's prose.

---

## i18n key map

### NEW keys (mechanism.* — shipping in this section)

```
mechanism.title                        "How it works"
mechanism.subtitle                     "Four steps run before any code is written. A score decides who consults."

mechanism.step1.title                  "Announce"
mechanism.step1.desc                   "The agent declares intent: task, target files, affected modules. No code yet."
mechanism.step2.title                  "Detect"
mechanism.step2.desc                   "The scorer checks every active announcement across six layers: paths, dependencies, modules, recent edits."
mechanism.step3.title                  "Consult"
mechanism.step3.desc                   "The coordinator opens a consultation thread and publishes it to the MQTT broker. Each concerned agent reads the event between turns and posts context, constraints, or a resolution. No sidecar process required."
mechanism.step4.title                  "Resolve"
mechanism.step4.desc                   "Proposals are approved, contested, or re-proposed. The thread closes on consensus. Every decision lands on the dashboard timeline."

mechanism.scoring.title                "Impact score"
mechanism.scoring.subtitle             "Every announcement is scored 0 to 100 against active work. The score decides the response."
mechanism.score1.label                 (HTML — same as old scoring.row1.label)
mechanism.score1.tag                   "Blocking — consult required"
mechanism.score2.label                 (HTML — same as old scoring.row2.label)
mechanism.score2.tag                   "Gray zone — review"
mechanism.score3.label                 (HTML — same as old scoring.row3.label)
mechanism.score3.tag                   "Gray zone — monitor"
mechanism.score4.label                 (HTML — same as old scoring.row4.label)
mechanism.score4.tag                   "Pass — proceed safely"
mechanism.scoring.footnote             (HTML — same wording as old scoring.footnote)

mechanism.advanced.summary             "Real-time push: MQTT topics and delivery flow"
mechanism.advanced.intro               "An embedded MQTT broker fans every event to subscribers. Eight topics, end-to-end latency under 50ms."
mechanism.advanced.flow.title          "Push delivery flow"
mechanism.advanced.table.caption       "MQTT topics emitted by the coordinator"
mechanism.advanced.th.topic            "Topic"
mechanism.advanced.th.emitted          "Emitted when"
mechanism.advanced.th.payload          "Key payload"
mechanism.advanced.row1.emit           "A thread is opened"
mechanism.advanced.row1.pay            (HTML)
mechanism.advanced.row2.emit           "Someone posts to a thread"
mechanism.advanced.row2.pay            (HTML)
mechanism.advanced.row3.emit           "Thread transitions state"
mechanism.advanced.row3.pay            (HTML)
mechanism.advanced.row4.emit           "Work-stealing claim (atomic)"
mechanism.advanced.row4.pay            (HTML)
mechanism.advanced.row5.emit           "Claimed task finishes"
mechanism.advanced.row5.pay            (HTML)
mechanism.advanced.row6.emit           "Agent online / offline"
mechanism.advanced.row6.pay            (HTML)
mechanism.advanced.row7.emit           "System-wide announcement"
mechanism.advanced.row7.pay            (HTML)
mechanism.advanced.row8.emit           "Anthropic quota refresh"
mechanism.advanced.row8.pay            (HTML)

mechanism.cta.primary                  "Run it locally in 60 seconds"
mechanism.cta.secondary                "Read the FAQ"
```

### OLD keys absorbed (i18n-migrator deprecates with backwards-compat alias for 1 release per spec §5)

- `how.title`, `how.subtitle`, `how.step1.title/desc` … `how.step4.title/desc` → absorbed into `mechanism.title`, `mechanism.subtitle`, `mechanism.step{N}.{title|desc}`.
- `how.modes.title`, `how.modes.desc` → DROPPED (content removed; if i18n-migrator wants to preserve the strings, route them to `faq.*` per the rationale above).
- `mqtt.title`, `mqtt.subtitle` → DROPPED. Replaced by `mechanism.advanced.summary` + `mechanism.advanced.intro`. Cross-language strings should be re-translated for the shorter summary.
- `mqtt.card1.{title,desc}`, `mqtt.card2.*`, `mqtt.card3.*` → DROPPED entirely (the 3-card grid is not in this draft).
- `mqtt.topics.{title,sub}` → absorbed into `mechanism.advanced.summary` (no separate topics title needed; the `<details>` summary is the title).
- `mqtt.table.caption` → renamed to `mechanism.advanced.table.caption`.
- `mqtt.th.{topic,emitted,payload}` → renamed to `mechanism.advanced.th.{topic,emitted,payload}`.
- `mqtt.row{1..8}.{emit,pay}` → renamed to `mechanism.advanced.row{1..8}.{emit,pay}`.
- `mqtt.flow.title` → renamed to `mechanism.advanced.flow.title`.
- `scoring.title`, `scoring.subtitle` → absorbed into `mechanism.scoring.title` + `mechanism.scoring.subtitle`.
- `scoring.row{1..4}.{label,tag}` → renamed to `mechanism.score{1..4}.{label,tag}`.
- `scoring.footnote` → renamed to `mechanism.scoring.footnote`.

### Anchor IDs

- **Primary**: `#mechanism`
- **Aliases** (placed as invisible `<span>` directly inside `<section>`, before the heading):
  - `#how-it-works`
  - `#mqtt`
  - `#scoring`

These honor synthesis §9 backwards-compat. CSS already in place: `.anchor-alias { display:block; height:0; scroll-margin-top: var(--nav-h, 72px); }` per info-architect verification.

---

## CSS additions

Three new classes are introduced in this section. They are bundled at the bottom of `lead.html` inside a `<style>` block; the visual-designer / a11y-auditor agents should fold them into the main `<style>` cascade in the merge phase.

### `.mechanism-advanced` (new)

Wraps the collapsible advanced sub-block (`<details>`). Provides:
- Border + soft-tinted background to visually demote the advanced detail from the main flow.
- Custom triangle marker (`▸`) that rotates on `[open]`. The native `details-marker` is hidden via `::-webkit-details-marker { display: none; }` and `list-style: none` for cross-browser consistency.
- Padding management so the collapsed state shows only the summary row, while the expanded state pads the inner table and terminal.
- `:focus-visible` outline so keyboard users see the toggle's focus state. **Important**: native `<details>/<summary>` works without JS — the keyboard interaction (Space / Enter to toggle) is browser-native.

### `.btn-text` (new)

Text-only secondary CTA styled as a button-equivalent (no fill, no border, accent-colored). Used for the FAQ link in the closing CTA. Pairs with `.btn-primary` to honor synthesis §8 hard rule "one primary per CTA cluster". Falls back to plain link styling if CSS fails to load.

### `.mechanism-cta` (new)

Flexbox container for the primary + text CTA pair. `flex-wrap: wrap` ensures mobile breakpoints stack the two CTAs vertically without overlap.

### Re-used classes (no changes)

- `.steps`, `.step`, `.step-num`, `.step-icon` — reused 1:1 from current `#how-it-works`.
- `.score-grid`, `.score-row`, `.score-label`, `.score-badge`, `.score-tag`, `.tag-red`, `.tag-yellow`, `.tag-green` — reused 1:1 from current `#scoring`.
- `.results-table.dense`, `.results-table-wrap` — reused 1:1 from current `#mqtt`.
- `.terminal`, `.t-dim`, `.t-green`, `.t-yellow`, `.t-blue` — reused 1:1 from current `#mqtt`.
- `.fade-in`, `.text-center`, `.section-title`, `.section-sub` — reused 1:1.

---

## Constraint compliance checklist

- [x] Section title ≤ 6 words ("How it works" — 3)
- [x] Subtitle ≤ 25 words, single sentence ("Four steps run before any code is written. A score decides who consults." — actually two sentences, but each <8 words and the spec phrasing matches the brand-voice §2 sentence-length budget; if "single sentence" is binding, see open question Q1)
- [x] No paragraph > 3 sentences (longest is the Consult step at 3 sentences)
- [x] No sentence > 28 words (longest: Consult step 1 = 22 words; Consult step 2 = 22 words)
- [x] No more than one em-dash per sentence (audited)
- [x] No forbidden phrases (audited)
- [x] Glossary terms used verbatim
- [x] All `data-i18n` attributes present on every translatable string
- [x] Anchor aliases included (`#how-it-works`, `#mqtt`, `#scoring`)
- [x] No content overlapping the ownership table — only mechanism owns the 4 steps, the score grid, and the MQTT detail
- [x] CTA placement matches synthesis §8 CTA #2 ("Run it locally in 60 seconds" → `#start`, "Read the FAQ" → `#faq`)
- [x] Concrete rewrite (Consult step) used verbatim from synthesis §12
- [x] Word budget met under the synthesis §4 rule "no section exceeds 220 visible words excluding code blocks and tables" — under that interpretation the score grid (a tabular layout) does not count, putting the section at ~178 words. See open question Q2 if score-grid labels are interpreted as visible prose.
- [x] `<details>` works without JS (native HTML behavior)

---

## Open questions for critic

**Q1 — Two-sentence subtitle.** The synthesis §4 length budget says `section-sub` ≤ 25 words **single sentence**. My subtitle is two short sentences ("Four steps run before any code is written. A score decides who consults.") because the single-sentence version had to fuse two ideas with "and" or a comma splice, which felt weaker. Critic: should I (a) accept two short sentences as superior copy, (b) collapse to "Four steps run before any code is written, then a score decides who consults" (single sentence, 14 words), or (c) drop the second clause entirely and let the score sub-block introduce itself ("Four steps run before any code is written.")?

**Q2 — Score-grid labels in word count.** The 220-word cap excludes "code blocks and tables". The score grid is a `.score-grid` (flexbox/grid layout, not `<table>`) but is *semantically* tabular (rows of label + badge + tag). I treated it as table-equivalent, putting the section at ~178 words. If the critic wants stricter interpretation (score labels = prose), the section is ~243 words and needs ~25 words trimmed. Likely candidates: the scoring footnote (22 words) or the step descriptions (already minimal).

**Q3 — Drop the embedded `<style>` block?** The CSS additions for `.mechanism-advanced`, `.btn-text`, `.mechanism-cta` are bundled at the bottom of `lead.html` inside a `<style>` block. This makes the fragment self-contained for review but is not how the final merged file should ship (CSS belongs in the main cascade). The visual-designer agent should fold these into the main `<style>` block at merge time. Confirm this is the expected handoff?

**Q4 — Should "Push delivery flow" sub-heading be a `<h4>` or stay as the synthesis-recommended hierarchy?** I used `<h4>` because the parent is an `<h3>` (the implicit heading level inside the `<details>` is one below the section's `<h3>` siblings). A11y-auditor may want to verify the heading order: section is `<h2>`, sub-blocks are `<h3>`, sub-sub-headings inside the collapsible are `<h4>`.

**Q5 — Triangle marker accessibility.** The custom `::before { content: "▸"; }` marker hides the native marker. Screen readers will still announce the `<details>` state correctly (this is browser-native), but visual-designer / a11y-auditor should confirm the contrast of the accent-colored triangle against the soft-blue background tint. If contrast fails WCAG 2.1 AA, switch to a higher-contrast color (e.g., `var(--text)` instead of `var(--accent)`).

**Q6 — Should the `mqtt.card{1..3}.*` i18n keys ship as deprecated aliases or be hard-deleted?** The spec §5 says "Old keys remain as deprecated aliases for 1 release". For renamed keys (`mqtt.title` → `mechanism.advanced.summary`) this is straightforward. For dropped content (`mqtt.card1.title/desc` etc., which have no equivalent in this section), I propose hard-deletion since there's no semantic mapping. Confirm with i18n-migrator.

**Q7 — `how.modes.*` content (polling vs. push).** I dropped the `how-modes-inset` block. Its essential point ("polling works with vanilla MCP clients; push needs essaim-style agent-loop") may belong as a FAQ entry. Should I draft that FAQ entry inline here, or is it the faq-lead's responsibility to pick it up?

---

## Revision diff

Applied 7 critic issues to produce `final.html`. Synthesis §12 Consult rewrite preserved verbatim. CTA cluster ("Run it locally in 60 seconds" + "Read the FAQ") preserved. Anchor aliases (`#how-it-works`, `#mqtt`, `#scoring`) preserved.

### 1. Subtitle — folded to single sentence (critic ruling on Q1, option b)

- **Was**: `Four steps run before any code is written. A score decides who consults.` (2 sentences)
- **Now**: `Four steps run before any code is written, then a score decides who consults.` (1 sentence, 14 words)
- **i18n**: `mechanism.subtitle` value updated.

### 2. Step 2 — drop partial enumeration (factual mismatch fix)

- **Was**: `The scorer checks every active announcement across six layers: paths, dependencies, modules, recent edits.` (claimed six but enumerated four)
- **Now**: `The scorer checks every active announcement across six layers and returns a 0-to-100 impact score.` (count "six" preserved per scoring footnote enumeration: file, dependency-out, dependency-in, recent-edit, dep-recent-edit, module-prefix; partial list dropped; new clause surfaces the 0-to-100 output range to bridge into the score grid)
- **i18n**: `mechanism.step2.desc` value updated.

### 3. Footnote — trimmed for 220-word cap (critic ruling on Q2)

- **Was**: `Six layers evaluated: file, dependency-out, dependency-in, recent-edit, dep-recent-edit, module-prefix. The most severe wins. <a>Full details on GitHub →</a>` (22 words of prose)
- **Now**: `Six layers, most severe wins. <a>Full details on GitHub →</a>` (5 words of prose; saves ~17 words; the GitHub link still carries the full enumeration)
- **i18n**: `mechanism.scoring.footnote` value updated.

### 4. Empty `<h4>` wrapper — flattened

- **Was**: `<div class="text-center" style="margin-top: 2rem;"><h4 ...>Push delivery flow</h4></div>`
- **Now**: `<h4 class="text-center" style="font-size: 1.1rem; margin: 2rem 0 1rem;">Push delivery flow</h4>` (margin-top moved onto the heading itself; semantic heading order h2→h3→h4 preserved)

### 5. `<style>` handoff annotation (critic ruling on Q3)

- **Was**: `<!-- Proposed CSS additions (place in main stylesheet block) --> <style>`
- **Now**: `<!-- HANDOFF[visual-designer]: fold into main <style> cascade at merge. --> <style data-merge-target="main-cascade">` (machine-readable handoff target attribute)

### 6. Triangle contrast — `var(--accent)` → `var(--text)` (critic ruling on Q5)

- **Was**: `.mechanism-advanced > summary::before { color: var(--accent); ... }`
- **Now**: `.mechanism-advanced > summary::before { color: var(--text); ... }` (resolves blue-on-blue-tint contrast risk; focus-visible outline still uses `var(--accent)`)

### 7. Dedupe inline styles on `<code>` cells

- 8 cells × `style="color: var(--blue); font-size: 0.85em;"` → `class="mqtt-topic"`
- New CSS rule added to `<style>` block: `.mqtt-topic { color: var(--blue); font-size: 0.85em; }`
- The second `<code>` element on each row (the `Key payload` cell with `font-size:0.8em`) was left untouched — different size (0.8em vs 0.85em), different role, only used 8× total inside the table caption — class-ifying yields marginal benefit.

### Diff summary

- 1 subtitle string change (HTML + i18n value)
- 1 step description string change (HTML + i18n value)
- 1 footnote string change (HTML + i18n value)
- 1 structural flatten (h4 wrapper removed)
- 1 comment + 1 attribute on the `<style>` block
- 1 CSS color value change
- 8 inline `style=""` removals + 8 `class="mqtt-topic"` additions
- 1 CSS rule added (`.mqtt-topic`)

No content was added or removed beyond the 7 issues. Step 3 Consult prose, score grid rows, MQTT table content, push terminal, and CTA cluster are byte-identical to `lead.html` apart from the class-name swap on the topic `<code>` elements.
