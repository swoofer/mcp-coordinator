# Solution (§3) — critic

Verdict on lead's 5 open questions, plus 5 issues.

## Open-question rulings

1. **Timeline content** — Dropping "Reviewer signed off" was correct. BUT line 17's `impact score 84` violates ownership (issue 1).
2. **`role="log"` + `aria-live="polite"`** — REMOVE. A replay-button-driven demo should not push four log lines into a screen-reader buffer. The parent `aria-label` suffices.
3. **Replay button placement** — Keep below mock, centred. Absolute-positioning collides with the metrics row on mobile.
4. **Deep-link prominence** — Keep low-key. Synthesis §8 forbids a primary CTA here; mechanism owns the next CTA.
5. **Subtitle sentence count** — ENFORCE single sentence per synthesis §16 (issue 3).

## Verified sound

- `@keyframes solutionRowIn` — correct; `to`-only keyframe with initial state on `.mini-dash-row` is canonical.
- Replay JS `void mock.offsetWidth` reflow trick — canonical and accessible.
- `.tl-*` selector widening — correct; silently fixes the live page.
- Em-dashes — 3 total across 3 distinct sentences. Compliant.

## Issues

### Issue 1 — Section ownership violation (impact score)

Synthesis §2: "Impact scoring … NOT in solution". Both the timeline row and the highlight desc disclose scoring numerics owned by mechanism.

SEARCH:
```
        <div class="mini-dash-row"><span class="tl-time">10:42:01</span> <span class="tl-yellow">&#9888; impact score 84 &mdash; Beta paused on overlap</span></div>
```
REPLACE:
```
        <div class="mini-dash-row"><span class="tl-time">10:42:01</span> <span class="tl-yellow">&#9888; overlap detected &mdash; Beta paused</span></div>
```

SEARCH:
```
      <p data-i18n="solution.highlight.desc">Every announcement gets an impact score (0&ndash;100) in under 5ms. The score is pushed to every concerned agent before they open a file.</p>
```
REPLACE:
```
      <p data-i18n="solution.highlight.desc">Every announcement reaches every concerned agent before they open a file. Overlaps surface as a paused turn, not a midnight rollback.</p>
```

### Issue 2 — Drop `aria-live` on the timeline

SEARCH:
```
      <div class="mini-dash-timeline" role="log" aria-live="polite">
```
REPLACE:
```
      <div class="mini-dash-timeline">
```

### Issue 3 — Subtitle must be one sentence

SEARCH:
```
      <p class="section-sub" data-i18n="solution.subtitle">Four agents stay aligned in real time. No chat tools, no merge gymnastics, no shared spreadsheet.</p>
```
REPLACE:
```
      <p class="section-sub" data-i18n="solution.subtitle">Four agents stay aligned in real time without chat tools, merge gymnastics, or shared spreadsheets.</p>
```

Update `lead-notes.md` §3 i18n entry for `solution.subtitle`.

### Issue 4 — Replay button: dead `data-i18n` key

`data-i18n="solution.replay"` is on the button but no text node binds to it; only the inner span carries `solution.replay.label`. Convert the outer key to `aria-label`.

SEARCH:
```
      <button type="button" class="btn btn-outline btn-replay" id="solution-replay" aria-controls="solution-mock" data-i18n="solution.replay">
        <span aria-hidden="true">&#x21BB;</span> <span data-i18n="solution.replay.label">Play again</span>
      </button>
```
REPLACE:
```
      <button type="button" class="btn btn-outline btn-replay" id="solution-replay" aria-controls="solution-mock" data-i18n-aria-label="solution.replay.aria" aria-label="Replay the dashboard demo">
        <span aria-hidden="true">&#x21BB;</span> <span data-i18n="solution.replay.label">Play again</span>
      </button>
```

Rename `solution.replay` to `solution.replay.aria` in lead-notes §3.

### Issue 5 — Lightning emoji in highlight title

Synthesis §6: solution prefers SVG/CSS icons over emoji. Drop it; the headline is strong without.

SEARCH:
```
      <h3 data-i18n="solution.highlight.title"><span aria-hidden="true">&#9889;</span> Conflicts caught before code is written</h3>
```
REPLACE:
```
      <h3 data-i18n="solution.highlight.title">Conflicts caught before code is written</h3>
```

## DO NOT TOUCH

- `.mini-dash-row` keyframe, delays (0.2s / 1.6s / 3.0s / 4.4s), `prefers-reduced-motion` block.
- Replay JS reflow pattern (`remove → void offsetWidth → add`).
- `.tl-*` scoping fix in §5.a (fixes a live bug).
- Deep-link `<a href="#mechanism">` — placement, copy, styling all correct per synthesis §8.
- Four agent dots and `Alpha/Beta/Gamma/Delta` labels.
- Glossary terms `agent`, `consultation thread`, `consensus`, `announcement` — used verbatim.
- Anchor aliases — N/A; solution is a new primary anchor.
