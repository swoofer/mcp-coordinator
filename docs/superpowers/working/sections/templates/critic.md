# Templates section — critic review

Verdict: **mostly solid**, but several precise issues block merge. CSS-class audit passes (every `.tmpl-*` and `.fl-*` class used at lines 7-149 of `lead.html` is defined at `docs/index.html:1111-1212`). Glossary compliance passes — prose says "coordination pattern" only, never "template". The 4 patterns are well-explained and behavior-layer values map sensibly to each pattern. Issues below are sharp and actionable.

---

## Issues

### 1. Parallel and Hierarchy share the same icon glyph (visual bug)

Both `tmpl-icon parallel` (line 11) and `tmpl-icon hierarchy` (line 81) use `&#9783;` (U+2627 ☧). Four cards must look distinct. Hierarchy needs a tree/branch glyph.

```search
        <div class="tmpl-icon hierarchy" aria-hidden="true">&#9783;</div>
```
```replace
        <div class="tmpl-icon hierarchy" aria-hidden="true">&#9874;</div>
```
(`&#9874;` = ⚒ hammer-pick; alternatively `&#9776;` ☰ trigram, or `&#9700;` ◤ for a tree-ish look. Pick whatever the visual-designer prefers — the requirement is "not the same glyph as parallel".)

### 2. Subtitle violates "single sentence ≤ 25 words" (synthesis §4)

Current: `Pre-built coordination shapes for common multi-agent scenarios. Composable with essaim behaviors.` That's **two sentences**. Synthesis §4 mandates: `section-sub paragraph: ≤ 25 words, single sentence`.

```search
      <p class="section-sub" data-i18n="templates.subtitle">Pre-built coordination shapes for common multi-agent scenarios. Composable with essaim behaviors.</p>
```
```replace
      <p class="section-sub" data-i18n="templates.subtitle">Pre-built coordination shapes for common multi-agent scenarios, composable with essaim behaviors.</p>
```
(13 words, one sentence.)

### 3. Foundation layer drops "detect" — inconsistent with mechanism's 4-step protocol

Mechanism owns the canonical cycle: `announce → detect → consult → resolve`. All four foundation rows say `announce, consult, resolve` (3 of 4 steps). Either include all four or change the foundation prose to make the omission deliberate (e.g., "the 4-step protocol"). Easiest fix:

```search
            <div class="tmpl-layer-text"><strong data-i18n="templates.layer.foundation">Foundation</strong> <span data-i18n="templates.parallel.foundation">announce, consult, resolve</span></div>
```
```replace
            <div class="tmpl-layer-text"><strong data-i18n="templates.layer.foundation">Foundation</strong> <span data-i18n="templates.parallel.foundation">announce, detect, consult, resolve</span></div>
```
(Apply the same edit to sequential.foundation and hierarchy.foundation. Read-only's foundation legitimately differs — it's `subscribe, read events` — leave that one.)

### 4. Parallel description verb "consult" is loose; glossary couples consultation with "thread"

Glossary: `PREFER: "consultation thread"`. The current sentence "They consult through the MQTT broker..." reads as a verb without the noun phrase. The synthesis's footnote on §3 allows verb forms but the first occurrence in this section should still anchor on the noun. Suggest:

```search
        <p class="tmpl-desc" data-i18n="templates.parallel.desc">All agents start at once. They consult through the MQTT broker the moment two announcements overlap.</p>
```
```replace
        <p class="tmpl-desc" data-i18n="templates.parallel.desc">All agents start at once. The coordinator opens a consultation thread the moment two announcements overlap.</p>
```

### 5. Read-only flow viz has dangling word "working" (parses awkwardly)

Line 121: `[A] [B] [C] working` reads as "C working" rather than "all three are working". Move it to its own dim line or drop it — the flow already implies activity:

```search
        <pre class="tmpl-flow"><span class="fl-blue">[A]</span> <span class="fl-blue">[B]</span> <span class="fl-blue">[C]</span> <span class="fl-dim">working</span>
 <span class="fl-dim">|</span>   <span class="fl-dim">|</span>   <span class="fl-dim">|</span>
<span class="fl-green">[obs]</span> reads timeline
 <span class="fl-yellow">&rarr;</span> comment, warn</pre>
```
```replace
        <pre class="tmpl-flow"><span class="fl-blue">[A]</span> <span class="fl-blue">[B]</span> <span class="fl-blue">[C]</span>
 <span class="fl-dim">|</span>   <span class="fl-dim">|</span>   <span class="fl-dim">|</span>
<span class="fl-green">[obs]</span> reads timeline
 <span class="fl-yellow">&rarr;</span> posts comment or warning</pre>
```

### 6. Parallel flow viz drops `[C] [D]` mid-diagram without explanation

Lines 15-19 show 4 agents on row 1 with 4 bars on row 2, then on row 4 only 2 bars survive. Reader infers 2 of 4 collided, but the visual doesn't confirm. Suggest labeling:

```search
        <pre class="tmpl-flow"><span class="fl-blue">[A]</span> <span class="fl-blue">[B]</span> <span class="fl-blue">[C]</span> <span class="fl-blue">[D]</span>
 <span class="fl-dim">|</span>   <span class="fl-dim">|</span>   <span class="fl-dim">|</span>   <span class="fl-dim">|</span>
 <span class="fl-green">&rarr;</span> overlap on <span class="fl-yellow">types.ts</span>
 <span class="fl-dim">|</span>   <span class="fl-dim">|</span>
 <span class="fl-green">consultation</span></pre>
```
```replace
        <pre class="tmpl-flow"><span class="fl-blue">[A]</span> <span class="fl-blue">[B]</span> <span class="fl-blue">[C]</span> <span class="fl-blue">[D]</span>
 <span class="fl-dim">|</span>   <span class="fl-dim">|</span>   <span class="fl-dim">|</span>   <span class="fl-dim">|</span>
 <span class="fl-yellow">A &amp; C overlap</span> on <span class="fl-yellow">types.ts</span>
 <span class="fl-green">&rarr; consultation</span></pre>
```

---

## DO NOT TOUCH

- **CSS classes**: every `.tmpl-*` / `.fl-*` / `.tag-*` / `.foundation`/`.pattern`/`.mission`/`.safety` class is correctly used and exists in `docs/index.html:1111-1212`. No new classes proposed — keep it that way.
- **Section ID `templates`**: must stay `templates` (CSS-class compatibility per synthesis §15).
- **`<h2>` text "Coordination patterns"**: correct glossary application — do not change to "Templates".
- **Read-only's 4 tags vs others' 3**: intentional asymmetry, the `tag-rule` "no writes" *is* the defining constraint. Keep.
- **Footnote link to essaim/behaviors**: required by spec §4.5; keep `https://github.com/swoofer/essaim/tree/main/behaviors`.
- **All 4 behavior-layer rows** present on every card: required structure, do not collapse.
- **Tag verbatim values** (`4-8 agents`, `mode: parallel`, `profile: coder`, etc.): these come straight from spec §4.5 table — do not paraphrase.
- **No CTA in this section**: synthesis §8 places the next CTA at end of `mechanism`, not here. Don't add one.
- **No anchor alias `<span>`**: `templates` is a primary new section, not an alias host (synthesis §9). Correctly absent.
