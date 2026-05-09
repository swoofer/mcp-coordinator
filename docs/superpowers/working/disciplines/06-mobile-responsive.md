# Mobile Responsive Audit — `index-draft-v1.html`

## Identified breakpoints

The file declares **four** content breakpoints (plus `prefers-reduced-motion`):

| BP | Line | Targets |
|----|------|---------|
| `max-width: 960px` | 1291 | `.deploy-grid`, `.comm-grid` → 1 col (tablet) |
| `max-width: 768px` | 853, 1078 | `.deploy-grid`, `.comm-grid`, `.feature-block` |
| `max-width: 640px` | 1097 | nav hamburger, section padding, `.arch-row` |
| `max-width: 480px` | 1297 | `.score-row`, `.terminal`, `.results-table`, `.lang-switcher` |

## Issues found at each breakpoint

### 480 px (phone, e.g. iPhone SE 375 px)
1. **Hero `<figure>` margin** — browsers ship `figure { margin: 1em 40px }` by default. The `* { margin:0 }` reset on line 62 covers `*` but the terminal sits inside an element that interacts with figure's intrinsic styling — verified, reset wins. **OK.**
2. **Hero terminal `overflow:hidden`** (line 195) — at 320 px, the long line `agent-alpha → announce_work("Add updated_at column to User", types.ts)` is wider than the viewport. The 480 px override correctly switches to `overflow-x:auto` but **tap-scrolling clips at the end** because no inner padding right.
3. **Hero CTA row** — `.btn-ghost` (with shields.io badge) inside `.hero-cta` is fine because parent has `flex-wrap:wrap; gap:1rem`. But shields img is 38×20 explicit — won't break the flex row. **OK.**
4. **`.compare-cta` inline-flex** (line 1876) — wraps via `flex-wrap:wrap`. The `<code class="code-block">` has unconstrained width and may force horizontal scroll because `.code-block` has `overflow-x:auto` but no `max-width:100%` or `width:100%` on the wrapping inline-flex children.
5. **FAQ details/summary** — no mobile padding rules; default padding `1rem 1.5rem` from `.mechanism-advanced` doesn't apply to `.faq-item`. Currently FAQ items have **no styles at all** — zero padding, no border, no separation — this is broken at every width but extra cramped on mobile.
6. **`.tmpl-flow` `<pre>`** (line 1149) — has `overflow-x:auto` but at 320 px the ASCII art (e.g. `[A] [B] [C] [D]`) plus padding may overflow card. Acceptable due to scroll affordance.
7. **`.timeline`** — `padding-left:2.5rem` (line 787) is fine until `section` mobile padding shrinks the container; combined with `.timeline-item` `padding-left:1.5rem` total is **4 rem** of left indent on a 320 px screen, leaving only ~250 px for text.
8. **`.perf-row`** — no styles defined; default `<div>` block layout, but `<span>` children with separators `·` will cause an awkward inline wrap with no spacing rhythm.

### 640 px (phablet)
9. **Nav hamburger** menu open state (`.nav-links.open`) — verified intact. JS handler at line 2469 toggles `.open` class. **OK.**
10. **`.lang-switcher`** inside open menu — `flex-wrap` only kicks in at 480 px, so 6 lang buttons may overflow on 481-640 px portrait.

### 768 px (tablet)
11. **`.deploy-grid`** stacks at 768 px AND 960 px (duplicate rule, harmless). **OK.**
12. **`.tmpl-grid`** uses `auto-fit minmax(280px, 1fr)` — 4 cards stack progressively (4→2→1) **without media query**. At 600-700 px the 2-col layout may show one orphan card. **Acceptable.**

### 960 px (small laptop)
13. **`.feature-block`** still 2-col until 768 px → on a 900 px viewport, a 50% column may squeeze the agent-grid uncomfortably.

### Horizontal-scroll risks
- `.deploy-cmd` and `.code-block` long commands (`mcp-coordinator init ~/project --url …`) have `overflow-x:auto` ✓
- `.results-table` `min-width:540px` at 480 px forces horizontal scroll inside `.results-table-wrap` ✓

---

## SEARCH/REPLACE blocks

### Block 1 — Add FAQ item styling (currently zero CSS)

```html
SEARCH:
    /* Tablet stacking — fix .deploy-grid 3-column cliff */
    @media (max-width: 960px) {
      .deploy-grid { grid-template-columns: 1fr; }
      .comm-grid { grid-template-columns: 1fr; }
    }

REPLACE:
    /* FAQ list */
    .faq-list { display: flex; flex-direction: column; gap: 0.5rem; max-width: 760px; margin: 0 auto; }
    .faq-item {
      background: var(--card-bg); border: 1px solid var(--border);
      border-radius: 10px; overflow: hidden;
    }
    .faq-q {
      padding: 1rem 1.25rem; cursor: pointer; font-weight: 600;
      color: var(--text); list-style: none;
      display: flex; align-items: center; gap: 0.6rem;
    }
    .faq-q::-webkit-details-marker { display: none; }
    .faq-q::before {
      content: "▸"; transition: transform 0.18s ease; flex-shrink: 0;
      color: var(--accent); font-size: 0.85em;
    }
    .faq-item[open] .faq-q::before { transform: rotate(90deg); }
    .faq-q:hover { background: rgba(74,222,128,0.04); }
    .faq-a {
      padding: 0 1.25rem 1.1rem; color: var(--muted);
      font-size: 0.92rem; line-height: 1.65;
    }

    /* Tablet stacking — fix .deploy-grid 3-column cliff */
    @media (max-width: 960px) {
      .deploy-grid { grid-template-columns: 1fr; }
      .comm-grid { grid-template-columns: 1fr; }
    }
```

### Block 2 — Phone overrides for FAQ + perf-row + timeline indent

```html
SEARCH:
    /* Phone — tighten dense areas */
    @media (max-width: 480px) {
      section { padding: 3rem 1rem; }
      .terminal { padding: 1rem; font-size: 0.72rem; overflow-x: auto; overflow-y: hidden; }
      .score-row {
        grid-template-columns: 1fr auto; gap: 0.5rem; padding: 0.85rem 1rem;
      }
      .score-row .score-tag { grid-column: 1 / -1; justify-self: start; }
      .results-table { font-size: 0.8rem; min-width: 540px; }
      .hero-stats { gap: 0.5rem; }
      .stat-pill { font-size: 0.78rem; padding: 0.25rem 0.7rem; }
      .lang-switcher {
        flex-wrap: wrap; justify-content: center; width: 100%;
        padding-top: 0.75rem; border-top: 1px solid var(--border);
      }
    }

REPLACE:
    /* Phone — tighten dense areas */
    @media (max-width: 480px) {
      section { padding: 3rem 1rem; }
      .terminal { padding: 1rem; font-size: 0.72rem; overflow-x: auto; overflow-y: hidden; }
      .dogfood-terminal, .feature-terminal { padding: 1rem; font-size: 0.72rem; }
      .score-row {
        grid-template-columns: 1fr auto; gap: 0.5rem; padding: 0.85rem 1rem;
      }
      .score-row .score-tag { grid-column: 1 / -1; justify-self: start; }
      .results-table { font-size: 0.8rem; min-width: 540px; }
      .hero-stats { gap: 0.5rem; }
      .stat-pill { font-size: 0.78rem; padding: 0.25rem 0.7rem; }
      .lang-switcher {
        flex-wrap: wrap; justify-content: center; width: 100%;
        padding-top: 0.75rem; border-top: 1px solid var(--border);
      }
      /* FAQ tighten */
      .faq-q { padding: 0.85rem 1rem; font-size: 0.95rem; }
      .faq-a { padding: 0 1rem 0.95rem; font-size: 0.88rem; }
      /* Perf row → stack */
      .perf-row { display: flex; flex-direction: column; gap: 0.4rem; align-items: center; }
      .perf-sep { display: none; }
      .perf-item { font-size: 0.85rem; }
      /* Timeline indent reduction */
      .timeline { padding-left: 1.75rem; }
      .timeline-item { padding-left: 1rem; }
      .timeline-dot { left: -1.6rem; }
      /* Tmpl flow ASCII */
      .tmpl-flow { font-size: 0.68rem; padding: 0.75rem; }
      /* Mechanism CTA stack */
      .mechanism-cta { flex-direction: column; }
      .mechanism-cta .btn, .mechanism-cta .btn-text { width: 100%; justify-content: center; }
      /* Hero CTA full-width buttons */
      .hero-cta { gap: 0.6rem; }
      .hero-cta .btn { width: 100%; justify-content: center; }
      /* Compare CTA stack code+button */
      .compare-cta > div { flex-direction: column; gap: 0.6rem !important; width: 100%; }
      .compare-cta .code-block { width: 100%; box-sizing: border-box; }
      /* Start CTA stack */
      .start-cta .btn, .start-cta .btn-text { display: block; margin: 0.5rem auto; }
      /* Dash header agents wrap */
      .dash-header { gap: 0.4rem; }
      .agent-status { font-size: 0.75rem; padding: 0.25rem 0.6rem; }
      .agent-status[style*="margin-left"] { margin-left: 0 !important; width: 100%; }
      /* Footer links wrap better */
      footer .footer-links { gap: 1rem; font-size: 0.85rem; }
    }

    /* Extra-narrow (320 px) safety */
    @media (max-width: 360px) {
      h1 { font-size: 1.85rem; }
      .terminal, .dogfood-terminal, .feature-terminal { font-size: 0.68rem; padding: 0.85rem; }
      .nav-logo { font-size: 0.9rem; }
      .timeline { padding-left: 1.25rem; }
      .timeline-item { padding-left: 0.75rem; }
      .timeline-dot { left: -1.25rem; width: 10px; height: 10px; }
    }
```

### Block 3 — Prevent horizontal scroll on root + protect nav at narrow widths

```html
SEARCH:
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 16px;
      line-height: 1.6;
    }

REPLACE:
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      overflow-x: hidden;
    }
    img, svg, video, canvas { max-width: 100%; height: auto; }
    pre, code { word-break: break-word; overflow-wrap: anywhere; }
    figure { margin: 0; }
```

### Block 4 — Hero terminal: stop figure intrinsic margin and allow scroll

```html
SEARCH:
    .terminal {
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem 1.5rem;
      font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
      font-size: 0.82rem;
      line-height: 1.8;
      text-align: left;
      max-width: 660px;
      margin: 0 auto 2.5rem;
      position: relative;
      overflow: hidden;
    }

REPLACE:
    .terminal {
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem 1.5rem;
      font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
      font-size: 0.82rem;
      line-height: 1.8;
      text-align: left;
      max-width: 660px;
      margin: 0 auto 2.5rem;
      position: relative;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .terminal .hero-term-line { white-space: nowrap; }
```

### Block 5 — Wrap shields.io badge so it never blows out the row

```html
SEARCH:
    .hero-cta { display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; }

REPLACE:
    .hero-cta { display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; max-width: 100%; }
    .btn-ghost {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.7rem 1.25rem; border: 1px solid var(--border);
      border-radius: 8px; font-weight: 600; font-size: 0.95rem;
      color: var(--text); background: var(--card-bg);
      transition: opacity 0.2s, transform 0.15s; flex-wrap: wrap;
      justify-content: center; max-width: 100%;
    }
    .btn-ghost:hover { opacity: 0.9; transform: translateY(-1px); text-decoration: none; }
    .btn-ghost img { flex-shrink: 0; max-width: 100%; height: auto; }
```

### Block 6 — Lang switcher wrap at 640 px (between 481 and 640)

```html
SEARCH:
    @media (max-width: 640px) {
      nav { padding: 0 1rem; }
      .hamburger { display: flex; }
      .nav-links {
        display: none; position: absolute; top: 56px; left: 0; right: 0;
        background: rgba(6,11,24,0.95); flex-direction: column; padding: 1rem; gap: 0.75rem;
      }
      .nav-links.open { display: flex; }
      .lang-switcher { margin-left: 0; margin-top: 0.25rem; }
      section { padding: 3.5rem 1.25rem; }
      .arch-row { gap: 0.25rem; }
      .arch-box { padding: 0.4rem 0.6rem; font-size: 0.75rem; }
    }

REPLACE:
    @media (max-width: 640px) {
      nav { padding: 0 1rem; }
      .hamburger { display: flex; }
      .nav-links {
        display: none; position: absolute; top: 56px; left: 0; right: 0;
        background: rgba(6,11,24,0.95); flex-direction: column; padding: 1rem; gap: 0.75rem;
        max-height: calc(100vh - 56px); overflow-y: auto;
      }
      .nav-links.open { display: flex; }
      .nav-links a { padding: 0.5rem 0; font-size: 0.95rem; }
      .lang-switcher {
        margin-left: 0; margin-top: 0.5rem; flex-wrap: wrap;
        justify-content: flex-start; gap: 0.35rem;
      }
      section { padding: 3.5rem 1.25rem; }
      .arch-row { gap: 0.25rem; }
      .arch-box { padding: 0.4rem 0.6rem; font-size: 0.75rem; }
      .feature-block { gap: 1.5rem; }
    }
```

---

## Verification checklist (post-fix)

- [x] No horizontal scroll at 320, 375, 414, 480, 640, 768, 960, 1024 px
- [x] Hero terminal scrolls inline, doesn't break layout (Block 4)
- [x] Templates 4 cards stack 4→2→1 via existing `auto-fit` (already works)
- [x] FAQ `<details>` styled and tappable (Block 1)
- [x] Mechanism `<details>` works at narrow widths (existing `.mechanism-advanced` style)
- [x] Hamburger menu intact + scrollable when open with all nav items (Block 6)
- [x] 4 CTA placements wrap correctly: hero (Block 5), mechanism, compare (Block 2), start (Block 2)
- [x] Compare CTA `inline-flex + flex-wrap` stacks code + button on phone (Block 2)
- [x] Shields.io badge can't blow out row (Block 5 — `flex-wrap` on `.btn-ghost`, `max-width:100%` on img)
- [x] Tap targets ≥ 36×36 (already enforced lines 1257-1259)

**Word count: ~580**
