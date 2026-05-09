# Solution (§3) — lead notes

## 1. Rationale for animation choice

The current `#why` block 2 ships a **static** mini-dashboard mock at `docs/index.html:1428-1443`. Nothing animates — the four timeline rows render at once. To honour the spec brief ("show the system working in 10 seconds") and the synthesis ownership rule ("solution owns live system demo / animation"), we promote the mock to an animated sequence:

- Each `.mini-dash-row` fades + slides in at `animation-delay: 0s, 1.5s, 3s, 4.5s` (~6s total run, matching the simulated `10:42:01 → 10:43:08` window).
- The cycle does NOT loop. Looping a "consensus reached" line is misleading and noisy on a long-scroll page.
- A `Play again` `<button>` toggles a `.is-playing` class on `#solution-mock`. The recommended JS recipe is one-shot: remove the class → force reflow → re-add. This restarts CSS animations without a timer and stays accessible.
- `prefers-reduced-motion` already disables all animations globally (`docs/index.html:1278-1288`). The button is still functional but the animation effectively no-ops, which is correct behaviour.

The animation choice avoids re-creating the hero terminal's typing effect (which is owned by `#hero` per the ownership table) and avoids any moving content that would compete with the solid `feature-highlight` claim below it.

## 2. Reused existing CSS

These classes are reused **as-is**, no changes needed:
- `.mini-dash`, `.mini-dash-agents`, `.mini-dash-agent`, `.mini-dash-timeline`, `.mini-dash-metrics` (lines 1034-1076)
- `.dot`, `.dot-blue`, `.dot-green`, `.dot-yellow`, `.dot-red` and the `pulse` keyframe (lines 401-414)
- `.feature-highlight`, `.feature-highlight h3`, `.feature-highlight p` (lines 909-932)
- `.btn`, `.btn-outline` (lines 235-247)
- `.section-title`, `.section-sub`, `.text-center`, `.fade-in`, `.container` (existing utilities)

## 3. New i18n keys (all `solution.*` — none absorbed from old)

```
solution.title              → "See it run live"
solution.subtitle           → "Four agents stay aligned in real time. No chat tools, no merge gymnastics, no shared spreadsheet."
solution.replay.label       → "Play again"
solution.highlight.title    → "Conflicts caught before code is written"
solution.highlight.desc     → "Every announcement gets an impact score (0–100) in under 5ms. The score is pushed to every concerned agent before they open a file."
solution.deeplink           → "Want the technical details? → How it works"
```

The mock's literal log lines (`10:42:01 Alpha announced src/api/auth.ts`, etc.) are intentionally **NOT** i18n-keyed — they read like terminal output and stay English across all locales (matches the existing pattern in `#hero`'s terminal at lines 1372-1379).

The `solution.replay` key on the outer button is a placeholder for screen-reader use if i18n-migrator wants to add an `aria-label` later; the visible label uses `solution.replay.label`.

## 4. No old keys absorbed

`solution` is a brand-new section ID. The previous content lived inside `#why` blocks 2 and 3 under keys `why.block2.*` and `why.block3.*`. Per the synthesis migration table (§5 of the spec), those keys are not preserved — `#why` is being absorbed into `#pain` as an anchor alias only.

## 5. New CSS classes / keyframes I propose (visual-designer should land these)

### 5.a — Existing CSS gap to flag

The selectors `.dash-timeline .tl-time`, `.dash-timeline .tl-green`, `.dash-timeline .tl-yellow`, `.dash-timeline .tl-blue` (lines 423-426) are scoped to `.dash-timeline` only. The current page already misuses them inside `.mini-dash-timeline` at lines 1436-1438, so the timeline rows render in plain muted grey today — the colour classes are no-ops.

**Proposed fix** (one-liner widening the selector list):

```css
.dash-timeline .tl-time,
.mini-dash-timeline .tl-time { color: rgba(148,163,184,0.5); margin-right: 0.75rem; }
.dash-timeline .tl-green,
.mini-dash-timeline .tl-green { color: var(--accent); }
.dash-timeline .tl-yellow,
.mini-dash-timeline .tl-yellow { color: var(--yellow); }
.dash-timeline .tl-blue,
.mini-dash-timeline .tl-blue { color: var(--blue); }
```

This also fixes the existing live page silently. No new class names needed.

### 5.b — New animation classes

```css
.mini-dash-row {
  opacity: 0;
  transform: translateY(4px);
}
.mini-dash.is-playing .mini-dash-row {
  animation: solutionRowIn 0.5s ease-out forwards;
}
.mini-dash.is-playing .mini-dash-row:nth-child(1) { animation-delay: 0.2s; }
.mini-dash.is-playing .mini-dash-row:nth-child(2) { animation-delay: 1.6s; }
.mini-dash.is-playing .mini-dash-row:nth-child(3) { animation-delay: 3.0s; }
.mini-dash.is-playing .mini-dash-row:nth-child(4) { animation-delay: 4.4s; }

@keyframes solutionRowIn {
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .mini-dash-row { opacity: 1; transform: none; }
  .mini-dash.is-playing .mini-dash-row { animation: none; }
}

.btn-replay { font-size: 0.85rem; padding: 0.45rem 1rem; }
.text-link { color: var(--blue); text-decoration: underline; text-underline-offset: 3px; }
.text-link:hover { color: var(--accent); }
.solution-deeplink { font-size: 0.9rem; color: var(--muted); }
```

### 5.c — Replay button JS (~6 lines, drop into existing `<script>` block)

```js
(function () {
  var btn = document.getElementById('solution-replay');
  var mock = document.getElementById('solution-mock');
  if (!btn || !mock) return;
  btn.addEventListener('click', function () {
    mock.classList.remove('is-playing');
    void mock.offsetWidth; // force reflow
    mock.classList.add('is-playing');
  });
})();
```

## 6. Glossary terms used (verbatim)

- "agent" / "agents" (4 mentions)
- "consultation thread" (1 mention)
- "consensus" (1 mention)
- "impact score" (2 mentions, including the highlight)
- "announcement" / "announced" (1 mention)

No banned synonyms used.

## 7. Open questions for critic

1. **Timeline content choice.** I added an `impact score 84` line and the `consultation thread opened` line that the original block 2 lacked, because the synthesis ownership table says solution must show the system working — including the score being pushed and a thread opening. The previous "Reviewer signed off — merge cleared" line is dropped because it implies a separate "Reviewer" actor that is not part of the 4-agent demo and was confusing. **OK with critic?**
2. **`role="log"` + `aria-live="polite"`** on the timeline announces each new row to screen readers as it animates in. This may be excessive for a marketing page demo. Alternative: drop `aria-live` and rely on the `aria-label="Live dashboard demo"` on the parent. **a11y-auditor's call.**
3. **Replay button placement.** Currently below the mock, centred. Alternative: top-right corner of `.mini-dash` itself (would need `position: absolute` + a `position: relative` parent). **visual-designer's call.**
4. **Tertiary deep-link to `#mechanism`.** The brief says "subtle CTA, text-link, not a button — primary CTA goes at end of mechanism per synthesis section 8". Confirmed correct, but flagging in case marketing-strategist wants the link to stand out more (e.g., right-aligned with arrow icon). Current implementation is the lowest-key option.
5. **Should the section subtitle be tightened further?** Current: 16 words. Alternative (12 words): "Four agents stay aligned in real time. No chat, no merge gymnastics." Drop "shared spreadsheet" if too colloquial.

## 8. Synthesis checklist

- [x] Section title ≤ 6 words ("See it run live" — 4)
- [x] Subtitle ≤ 25 words, single sentence (16 words across two sentences — flagging: technically two sentences. Will collapse to one if critic insists.)
- [x] No paragraph > 3 sentences
- [x] No sentence > 28 words (max is 13)
- [x] No more than one em-dash per sentence (3 total entities, distributed across 3 different sentences in the timeline log)
- [x] No forbidden phrases used (verified by string scan)
- [x] Glossary terms used verbatim (agent, consultation thread, consensus, impact score, announcement)
- [x] All `data-i18n` attributes present (6 keys, all `solution.*`)
- [x] Anchor aliases — N/A (solution is a new primary anchor)
- [x] No content overlapping ownership table (no protocol explanation, no scoring tables, no install commands)
- [x] CTA placement matches §8 (no primary CTA in this section; tertiary text-link to `#mechanism`)
- [x] ≤220 visible words (94 actual)

## 9. Subtitle 2-sentence flag — resolution

The subtitle currently reads: *"Four agents stay aligned in real time. No chat tools, no merge gymnastics, no shared spreadsheet."* — that is technically two sentences. The synthesis says "≤25 words, single sentence". If the critic enforces single-sentence strictly, replace with:

> *"Four agents stay aligned in real time without chat tools, merge gymnastics, or shared spreadsheets."* (15 words, one sentence)

I prefer the two-sentence version because the rhythm hits harder on a marketing page. Critic decides.

## Revision diff

Applied all 5 critic issues into `final.html`:

1. **Issue 1 — ownership leak (impact score)** — accepted. Timeline row 17 now reads `&#9888; overlap detected — Beta paused` (drops the `impact score 84` numeric). Highlight desc rewritten to `Every announcement reaches every concerned agent before they open a file. Overlaps surface as a paused turn, not a midnight rollback.` — no scoring numerics, no 5ms claim. Mechanism keeps full ownership of impact-score mechanics.
2. **Issue 2 — drop `aria-live`** — accepted. `<div class="mini-dash-timeline" role="log" aria-live="polite">` collapsed to `<div class="mini-dash-timeline">`. Parent `aria-label="Live dashboard demo"` carries the announcement.
3. **Issue 3 — single-sentence subtitle** — accepted. New copy: *"Four agents stay aligned in real time without chat tools, merge gymnastics, or shared spreadsheets."* (15 words, one sentence). Updates §3 i18n entry for `solution.subtitle`.
4. **Issue 4 — dead `data-i18n="solution.replay"` key** — accepted. Outer attribute renamed to `data-i18n-aria-label="solution.replay.aria"` with a literal `aria-label="Replay the dashboard demo"` fallback. Inner span keeps `data-i18n="solution.replay.label"`. §3 key list: rename `solution.replay` → `solution.replay.aria`.
5. **Issue 5 — lightning emoji** — accepted. Highlight title is now `Conflicts caught before code is written` with no leading icon span. Headline carries on its own.

### i18n key list (revised)

```
solution.title              → "See it run live"
solution.subtitle           → "Four agents stay aligned in real time without chat tools, merge gymnastics, or shared spreadsheets."
solution.replay.aria        → "Replay the dashboard demo"  (was: solution.replay)
solution.replay.label       → "Play again"
solution.highlight.title    → "Conflicts caught before code is written"
solution.highlight.desc     → "Every announcement reaches every concerned agent before they open a file. Overlaps surface as a paused turn, not a midnight rollback."
solution.deeplink           → "Want the technical details? → How it works"
```

### Untouched (per critic "DO NOT TOUCH")

- `.mini-dash-row` keyframe + delays + `prefers-reduced-motion` block.
- Replay JS reflow pattern.
- `.tl-*` selector widening fix in §5.a.
- Deep-link `<a href="#mechanism">` placement, copy, styling.
- Four agent dots and `Alpha/Beta/Gamma/Delta` labels.
- Glossary terms `agent`, `consultation thread`, `consensus`, `announcement` — preserved verbatim. Note: `impact score` is no longer used in solution copy (moved to mechanism's exclusive ownership), which is the intended outcome of Issue 1.

### Synthesis checklist (revised)

- [x] Subtitle ≤ 25 words, single sentence (15 words, 1 sentence — fixed).
- [x] §6 emoji policy respected (no emoji in highlight title; only `&#9888;` and `&#10003;` glyph entities remain inside terminal-style log lines, which read as monospace output).
- [x] §2 ownership: no impact-scoring numerics or latency claims in solution copy.
- [x] All `data-i18n*` attributes resolve to a translatable target (no orphan keys).
- [x] No `aria-live` on demo timeline.
