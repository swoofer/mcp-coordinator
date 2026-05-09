# Section 9 — Results — Lead notes

## Summary of changes

The `results` section keeps its kept-for-this-redesign structure: title, tightened subtitle, the 4-scenario `.results-table`, and now a new performance-metrics block underneath. Subtitle was shortened from 39 words (with embedded link) to 25 words, with the GitHub link relocated under the new performance block to reduce visual noise above the table.

## Rationale for the new perf metrics row

The synthesis ownership table assigns "test scenarios + perf metrics" exclusively to `results` (§9). The current page has zero quantitative latency claims inside this section — the `<50ms push latency` pill lives only in the hero. Adding a four-item perf row here:

1. Closes the credibility loop for the team-lead (Tara) and tech-evaluator (Alex) personas: scenarios + scoring + measured timings + test-count in one block.
2. Lets the hero pill stand alone in its short form; the deep number lives where evaluators look for it.
3. The four numbers (Detection <5ms, MQTT push <50ms, Full consensus 30-45s, 216 unit tests across 18 files) match the spec section 4.9 brief verbatim.
4. The GitHub `tests/` link, previously embedded mid-paragraph, becomes a clear final CTA for the section.

## i18n keys

### New keys

- `results.perf.row` — content of the four-metric strong-tagged line
- `results.perf.link` — the "Browse the test suite on GitHub" anchor text

### Preserved keys (unchanged)

- `results.title`
- `results.subtitle` (text content tightened, key preserved)
- `results.caption`
- `results.th.scenario` / `results.th.desc` / `results.th.score` / `results.th.outcome`
- `results.s1.desc` / `results.s1.outcome`
- `results.s2.desc` / `results.s2.outcome`
- `results.s3.desc` / `results.s3.outcome`
- `results.s4.desc` / `results.s4.outcome`

### Dropped keys

None.

## Anchor IDs

- Primary: `#results` (kept)
- No anchor aliases needed (synthesis section 9 lists `#results` as primary, not absorbed)

## Brand-voice polish applied to `<td>` cells

- S1 desc: "Same file targeted by two agents simultaneously" → "Two agents announce work on the same file at the same moment" (uses glossary verb "announce work")
- S1 outcome: replaced em-dash chain ("Thread opened — both agents post context — consensus — both proceed") with comma list and used "consultation thread" verbatim per glossary
- S2 outcome: replaced em-dash with colon ("Gray zone: auto-resolved, both agents notified for awareness")
- S3 outcome: same em-dash → colon swap
- S4 outcome: em-dash → comma; phrasing kept neutral

No sentence exceeds 28 words. No paragraph exceeds 3 sentences. No forbidden phrases.

## Checklist (per synthesis section 16)

- [x] Section title <= 6 words ("Tested coordination scenarios" = 3 words)
- [x] Subtitle <= 25 words ("Four canonical conflict patterns from the test suite. Each runs end-to-end with two real agents and verifies score, thread state, and resolution." = 25 words)
- [x] No paragraph > 3 sentences
- [x] No sentence > 28 words
- [x] No more than one em-dash per sentence (zero used; replaced with colons/commas)
- [x] No forbidden phrases used
- [x] Glossary terms used verbatim: "agent", "consultation thread", "MQTT" (push), "announce work", "consensus"
- [x] All `data-i18n` attributes present on text-bearing elements
- [x] Anchor: `#results` primary, no aliases needed
- [x] No content overlapping ownership table (no scoring explanation, no MQTT mechanics, no install commands)
- [x] No CTA cluster required by synthesis section 8 for this section
- [x] Section visible word count excluding table: 67 (well under 220 cap)

## Open questions for the critic

1. **Are the perf claims verifiable as written?**
   - "Detection <5ms" — is this the impact-scorer execution time or the full announce->score pipeline? The hero already says "<5ms scoring" implicitly (via the synthesis cross-references). Suggest tech-accuracy reviewer pin this to a specific code path or benchmark (e.g., `tests/unit/impact-scorer.test.ts` timing assertions, or a benchmark script).
   - "MQTT push <50ms" — matches the hero pill (`<50ms push latency`). Good consistency; tech-accuracy can verify against MQTT broker config + real telemetry.
   - "Full consensus 30-45s" — this is a NEW claim, not in the current page. Need confirmation it reflects measured behaviour from `tests/unit/consultation.test.ts` or actual session traces. If unsupported, downgrade to "tens of seconds" or remove until benchmarked.

2. **The 216 unit tests claim — verified during drafting**
   - Source: `tests/unit/` directory contains exactly 18 `.test.ts` files. A regex count of `it(` and `test(` callsites totals 216. Numbers are accurate as of 2026-05-09. Tech-accuracy reviewer should re-run the count at PR time so the number does not drift. Suggested verification command (POSIX): `find tests/unit -name '*.test.ts' | wc -l` for file count, plus `grep -rE '^\s*(it|test)\(' tests/unit | wc -l` for case count.

3. **Should the perf block use a styled component instead of inline `style=` attributes?**
   - Spec section 4.9 dictates the inline-style snippet verbatim, so I kept it as-is. Visual-designer agent may want to extract `.perf-metrics`, `.perf-row`, and the muted-link paragraph into the CSS block for consistency. Flagging — not changing.

4. **Should the GitHub link open in a new tab?**
   - Current page anchor (line 1886) does not use `target="_blank"`. Kept consistent: only `rel="noopener noreferrer"` is set, matching the rest of the page.

5. **Subtitle tightening — risk of losing the link discoverability**
   - The current page has the GitHub link embedded inside the subtitle paragraph. I moved it to the perf block. Critic should validate that this does not hurt SEO / link-equity for the `tests/` directory (only one link to it on the landing now, instead of two). If concern, easiest fix is to keep the link inline in the subtitle as well; the i18n key already renders fine either way.

6. **Number formatting — 216 vs "200+"**
   - Used the exact figure (216) per the spec brief. Some marketing teams round up; the brand voice ("make claims with evidence") favours the exact number. Critic may push back if the count fluctuates frequently across releases.

## Revision diff

Applied all 6 critic issues to produce `final.html`. Summary of edits relative to `lead.html`:

### Issue 1 — Subtitle folded to single sentence
- Before: `Four canonical conflict patterns from the test suite. Each runs end-to-end with two real agents and verifies score, thread state, and resolution.` (2 sentences, 25 words)
- After: `Four canonical conflict patterns, each run end-to-end with two real agents to verify score, thread state, and resolution.` (1 sentence, 20 words)
- `data-i18n="results.subtitle"` key preserved.

### Issue 2 — `&rarr;` HTML entity replaced with literal arrow inside `data-i18n` text
- Before: `Browse the test suite on GitHub &rarr;`
- After: `Browse the test suite on GitHub →` (literal U+2192). Now renders correctly through `textContent`-based i18n binding.

### Issue 3 — "Gray zone" jargon removed from results outcomes
- S2 outcome: `Gray zone: auto-resolved, both agents notified for awareness` → `Auto-resolved, both agents notified for awareness`
- S3 outcome: `Gray zone: dependency flagged, dependent agent waits or replans` → `Dependency flagged, dependent agent waits or replans`
- The "gray zone" vocabulary now lives exclusively in the mechanism section's scoring sub-block (already present at `index.html:1583` and `1588`), preserving section ownership boundaries.

### Issue 4 — Inline styles moved to CSS classes
- `<div class="perf-metrics text-center" style="margin-top: 2rem;">` → `<div class="perf-metrics text-center">`
- `<p style="margin-top:0.75rem; color: var(--muted); font-size:0.9rem;">` → `<p class="perf-metrics-link">`
- Visual-designer agent must add to the page stylesheet block:
  ```css
  .perf-metrics { margin-top: 2rem; }
  .perf-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem 1rem; align-items: center; }
  .perf-sep { color: var(--muted); }
  .perf-metrics-link { margin-top: 0.75rem; color: var(--muted); font-size: 0.9rem; }
  ```
  (The `.perf-row` / `.perf-sep` rules are needed because the row was restructured per Issue 6.)

### Issue 5 — Class-family verification (`tag-*` vs `t-*`)
- Verified against `docs/index.html.backup-2026-05-09` lines 182-185 and 305-307. BOTH families are defined:
  - `.t-red` / `.t-yellow` / `.t-green` — text-color tokens (used on `.score-badge`)
  - `.tag-red` / `.tag-yellow` / `.tag-green` — pill backgrounds with border (used on `.score-tag`)
- Current usage in lead is CORRECT. No change required. Classes left as-is.

### Issue 6 — `results.perf.row` split into per-cell i18n keys
The single `data-i18n="results.perf.row"` value mixed `<strong>` HTML with text, which forces an `innerHTML` assignment for translators. Replaced with one key per label and one key per value (8 keys total):
- New keys: `results.perf.label.detection` / `.value.detection`, `results.perf.label.mqtt` / `.value.mqtt`, `results.perf.label.consensus` / `.value.consensus`, `results.perf.label.tests` / `.value.tests`
- Dropped key: `results.perf.row` (was unshipped — only existed in the lead draft, never in `index.html`)
- Each cell now binds plain text content. The `<strong>` markup, `&middot;` separators, and layout live in the HTML structure, not in the translation values.
- `216 unit tests across 18 files` is preserved verbatim as the value of `results.perf.value.tests` (exact number unchanged).

### Untouched (per critic "DO NOT TOUCH")
- 4-row table structure with S1/S2/S3/S4 ordering and scores 100/30/80/0
- `<caption class="sr-only">` for table accessibility
- `#results` anchor (no aliases)
- `rel="noopener noreferrer"` (no `target="_blank"`)
- Glossary terms ("consultation thread", "consensus", "announce work", "agent")
- Exact `216` figure (no rounding to "200+")
- Score-badge `t-red/t-yellow/t-green` page tokens

### i18n keys delta (final state)
- Preserved (unchanged): `results.title`, `results.subtitle`, `results.caption`, `results.th.*` (4), `results.s{1,2,3,4}.desc`, `results.s{1,2,3,4}.outcome`, `results.perf.link`
- Added: `results.perf.label.detection`, `results.perf.value.detection`, `results.perf.label.mqtt`, `results.perf.value.mqtt`, `results.perf.label.consensus`, `results.perf.value.consensus`, `results.perf.label.tests`, `results.perf.value.tests`
- Dropped: `results.perf.row`
