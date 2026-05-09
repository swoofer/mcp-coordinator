# Section 9 — Results — Critic review

## Verification summary

- 4 scenarios table preserved (S1-S4, scores 100/30/80/0): YES
- Perf metrics block present, four data points + GitHub link: YES
- "consultation thread" used (S1 outcome): YES
- "announce work" used (S1, S2, S3 descriptions): YES
- Subtitle word count: 22 words. PASS on count.
- Section ownership clean: results does not bleed into mechanism (no scoring rule explanation, no MQTT mechanics) and not into roadmap. PASS.
- "216 unit tests" claim: independently re-verified by lead via regex count of `it(`/`test(` over 18 `.test.ts` files. PASS.

## Issues (priority order)

### Issue 1 — Subtitle violates "single sentence" rule

Synthesis section 4 mandates `section-sub` ≤ 25 words AND single sentence. The lead's subtitle is TWO sentences (period after "test suite"). Hard violation of binding rules.

```
SEARCH: <p class="section-sub" data-i18n="results.subtitle">Four canonical conflict patterns from the test suite. Each runs end-to-end with two real agents and verifies score, thread state, and resolution.</p>
REPLACE: <p class="section-sub" data-i18n="results.subtitle">Four canonical conflict patterns, each run end-to-end with two real agents to verify score, thread state, and resolution.</p>
```

23 words, single sentence.

### Issue 2 — `&rarr;` HTML entity inside data-i18n textContent

The i18n script typically assigns to `textContent`, which renders `&rarr;` as literal four characters, not as the arrow glyph. Use the actual character.

```
SEARCH: <a href="https://github.com/swoofer/mcp-coordinator/tree/main/tests" rel="noopener noreferrer" data-i18n="results.perf.link">Browse the test suite on GitHub &rarr;</a>
REPLACE: <a href="https://github.com/swoofer/mcp-coordinator/tree/main/tests" rel="noopener noreferrer" data-i18n="results.perf.link">Browse the test suite on GitHub →</a>
```

### Issue 3 — "Gray zone" is internal jargon, not in glossary

S2 and S3 outcomes use "Gray zone" which is unexplained inline jargon. The reader has no anchor to "gray zone" — that vocabulary belongs in the mechanism section's scoring sub-block. Replace with a description that stands alone in the results context.

```
SEARCH: <td><span class="score-tag tag-yellow" data-i18n="results.s2.outcome">Gray zone: auto-resolved, both agents notified for awareness</span></td>
REPLACE: <td><span class="score-tag tag-yellow" data-i18n="results.s2.outcome">Auto-resolved, both agents notified for awareness</span></td>
```

```
SEARCH: <td><span class="score-tag tag-yellow" data-i18n="results.s3.outcome">Gray zone: dependency flagged, dependent agent waits or replans</span></td>
REPLACE: <td><span class="score-tag tag-yellow" data-i18n="results.s3.outcome">Dependency flagged, dependent agent waits or replans</span></td>
```

### Issue 4 — Inline styles in HTML violate CSS strategy

Spec section 6 keeps CSS in the dedicated stylesheet block. The `style="margin-top: 2rem;"` and `style="margin-top:0.75rem; color: var(--muted); font-size:0.9rem;"` should move to a `.perf-metrics` rule. Flagging for visual-designer; do NOT inline-edit unless visual-designer block is in same PR.

```
SEARCH: <div class="perf-metrics text-center" style="margin-top: 2rem;">
REPLACE: <div class="perf-metrics text-center">
```

```
SEARCH:       <p style="margin-top:0.75rem; color: var(--muted); font-size:0.9rem;">
REPLACE:       <p class="perf-metrics-link">
```

(Visual-designer must add `.perf-metrics { margin-top: 2rem }` and `.perf-metrics-link { margin-top: 0.75rem; color: var(--muted); font-size: 0.9rem }`.)

### Issue 5 — Score-tag color classes likely undefined

The cells use `tag-red` / `tag-yellow` / `tag-green` while the score-badge uses `t-red` / `t-yellow` / `t-green`. The split is suspicious — verify both class families exist in the page CSS. If `tag-*` is undefined, the cells render unstyled. Flag for visual-designer.

### Issue 6 — Mid-cell HTML mixing makes i18n.row brittle

`data-i18n="results.perf.row"` wraps content with four `<strong>` tags and `&middot;`. Translators receive raw HTML mixed with text. Split into 8 keys (4 labels + 4 values) or accept that i18n script must assign via `innerHTML`. Note for i18n-migrator. No SEARCH/REPLACE — defer to i18n-migrator decision.

## Tech-accuracy reviewer flags

The lead correctly flagged these. Re-flagging with more bite:

1. **"Detection <5ms"** — unattributed. Is this `impactScorer.score()` execution? Single-pair detection? Tech-accuracy must point to a specific benchmark or test-suite timing assertion. If unsupported, downgrade to "<10ms" or remove.
2. **"Full consensus 30-45s"** — NEW claim absent from current page. No evidence in lead-notes that this matches a measured trace from `tests/unit/consultation.test.ts`. If unverified at PR time, drop the line or replace with "tens of seconds (typical)".
3. **"216 unit tests across 18 files"** — verified at draft time. Tech-accuracy must re-run `find tests/unit -name '*.test.ts' | wc -l` and `grep -rE '^\s*(it|test)\(' tests/unit | wc -l` at PR merge to confirm no drift.

## DO NOT TOUCH

- 4 scenarios table structure (S1/S2/S3/S4 row order, score values 100/30/80/0).
- `<caption class="sr-only">` — required for table a11y.
- Anchor strategy: `#results` primary, no aliases. Per synthesis section 9.
- The `<a>` link `rel="noopener noreferrer"` (no `target="_blank"` to match page convention).
- Glossary terms: "consultation thread", "consensus", "announce work", "agent". Already correct.
- Number formatting: keep `216` (exact), not `200+`.
- The score-badge `t-red/t-yellow/t-green` classes — these are page tokens.
