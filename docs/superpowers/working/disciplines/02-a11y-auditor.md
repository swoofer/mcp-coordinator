# A11y Audit — index-draft-v1.html (WCAG 2.1 AA)

## Summary

| Check | Result |
|---|---|
| Single h1 + h2/h3/h4 hierarchy (no skips) | OK |
| Skip-link to `<main id="main" tabindex="-1">` | OK (line 1316 → 1346) |
| Emoji / icon-only elements have `aria-hidden="true"` or `aria-label` | OK |
| `<details>/<summary>` (FAQ + mechanism advanced) | OK — native semantics, focus-visible inherited |
| Score badges not color-only (text tag adjacent) | OK |
| Agent-status dots not color-only (each has text label) | OK |
| Language switcher uses `aria-pressed` + `lang` | OK |
| Reduced-motion media query disables animations | OK (line 1278) |
| Copy button labelled in JS (`aria-label="Copy code to clipboard"`) | OK |
| Tap targets ≥ 36×36 / 44×44 (lang-btn, copy-btn, hamburger) | OK |
| Figure captions via `aria-label` on `<figure>` | OK |
| **Color contrast — `.tl-time` / `.fl-dim` rgba(148,163,184,0.5)** | **FAIL ~3.0:1** |
| **Color contrast — `.copy-btn` resting state on terminal bg** | **FAIL ~4.0:1** |
| Hero figure (`<figure aria-label>`) lacks `role="img"` (still announced as figure, but inconsistent with dash-preview) | Minor |
| FAQ link to jose missing `target/rel` | Minor (security/parity) |

## Fixes

### Fix 1 — `.dash-timeline .tl-time` contrast (rgba 50% → 75%)

```
<<<<<<< SEARCH
    .dash-timeline .tl-time { color: rgba(148,163,184,0.5); margin-right: 0.75rem; }
=======
    .dash-timeline .tl-time { color: rgba(148,163,184,0.85); margin-right: 0.75rem; }
>>>>>>> REPLACE
```

### Fix 2 — `.tmpl-flow .fl-dim` contrast

```
<<<<<<< SEARCH
    .tmpl-flow .fl-dim { color: rgba(148,163,184,0.5); }
=======
    .tmpl-flow .fl-dim { color: rgba(148,163,184,0.85); }
>>>>>>> REPLACE
```

### Fix 3 — `.copy-btn` resting contrast (lift muted text + border)

```
<<<<<<< SEARCH
    .copy-btn {
      position: absolute; top: 8px; right: 8px;
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
      color: var(--muted); font-size: 0.7rem; padding: 0.2rem 0.5rem;
      border-radius: 4px; cursor: pointer; transition: all 0.2s;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
=======
    .copy-btn {
      position: absolute; top: 8px; right: 8px;
      background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.25);
      color: var(--text); font-size: 0.7rem; padding: 0.2rem 0.5rem;
      border-radius: 4px; cursor: pointer; transition: all 0.2s;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
>>>>>>> REPLACE
```

### Fix 4 — Hero `<figure>` consistency: add `role="img"` (parity with dash-preview)

```
<<<<<<< SEARCH
    <figure aria-label="Live demo: two agents detect a conflict and reach consensus in 38 seconds" data-i18n-aria="hero.terminal.aria">
=======
    <figure role="img" aria-label="Live demo: two agents detect a conflict and reach consensus in 38 seconds" data-i18n-aria="hero.terminal.aria">
>>>>>>> REPLACE
```

### Fix 5 — FAQ external link to jose: add `target` + `rel` (parity with all other external links)

```
<<<<<<< SEARCH
        <div class="faq-a" data-i18n="faq.a6">Not by default. Opt-in HS256 JWT via <a href="https://github.com/panva/jose">jose</a> for shared or internet-facing deployments.</div>
=======
        <div class="faq-a" data-i18n="faq.a6">Not by default. Opt-in HS256 JWT via <a href="https://github.com/panva/jose" target="_blank" rel="noopener noreferrer">jose</a> for shared or internet-facing deployments.</div>
>>>>>>> REPLACE
```

### Fix 6 — Add explicit `:focus-visible` rule for `<summary>` (FAQ + mechanism)

The global `:focus-visible` rule fires on summaries, but Safari/older Firefox behaviour around `summary` focus outlines is inconsistent. Add an explicit selector inside the existing utility block.

```
<<<<<<< SEARCH
    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
      border-radius: 3px;
    }
    button:focus-visible, a:focus-visible { outline-color: var(--accent); }
=======
    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
      border-radius: 3px;
    }
    button:focus-visible, a:focus-visible, summary:focus-visible { outline-color: var(--accent); }
    summary:focus-visible { outline-offset: 2px; }
>>>>>>> REPLACE
```

## Notes (no fix needed)

- Heading order is clean: one h1 (1354), h2 per section, h3 sub-blocks, h4 only in roadmap items + `details`-scoped flow title.
- All emoji icons (`card-icon`, `step-icon`, `tmpl-icon`, `arch-arrow`, `arch-down`, `dot`, `deploy-badge` glyphs, GitHub SVG) carry `aria-hidden="true"`.
- Score rows convey severity via three signals (numeric badge + colored badge + text tag) — passes 1.4.1 Use of Color.
- Reduced-motion guard strips fade-in, hero typing, pulse — passes 2.3.3.
- Tap targets meet 2.5.5 minimums via the utility block at line 1257-1259.
