# Start (§8) — Critic review

Reviewing `lead.html` against synthesis §4, §8, §12, §16, and spec §4.8.

## Issues

### 1. Subtitle violates §4 single-sentence rule
Synthesis §4: "`section-sub` ≤ 25 words, **single sentence**". Lead uses 3 sentences (its §16 self-check admits this). Fold to the single-sentence form lead-notes itself proposes.

```
SEARCH: <p class="section-sub" data-i18n="start.subtitle">One npm package. Embedded broker, dashboard, and SQLite. From install to a coordinated session in under a minute.</p>
REPLACE: <p class="section-sub" data-i18n="start.subtitle">Self-hosted from one npm package &mdash; embedded broker and dashboard, no cloud, ready in under a minute.</p>
```

### 2. Closing CTA "primary" rendered as `.btn-outline`
Synthesis §8 row 4 names `Star on GitHub` as primary; `.btn-outline` is secondary. The single-primary cluster needs the primary fill.

```
SEARCH: class="btn btn-outline" data-i18n="start.cta.star"
REPLACE: class="btn btn-primary" data-i18n="start.cta.star"
```

### 3. Install-note has both class AND inline styles
Open question 3 left both. Keep the class as forward-reference; drop inline duplicates so visual-designer owns the contract.

```
SEARCH: <p class="install-note text-center" style="color:var(--muted); font-size:0.88rem; margin-top:1.5rem;" data-i18n="start.note">
REPLACE: <p class="install-note text-center" data-i18n="start.note">
```

### 4. Step descs duplicate inline `style` 4×
Each step `<p>` repeats the same inline style. Hoist to a class so visual-designer can re-skin in one place.

```
SEARCH: <p style="color:var(--muted); font-size:0.88rem;" data-i18n="start.step1.desc">
REPLACE: <p class="install-desc" data-i18n="start.step1.desc">
```
Apply same pattern to steps 2/3/4.

### 5. Dashboard meta-line lacks `data-i18n`
`mcp-coordinator v0.2.1 · quota 62%` is translatable English leaking out of i18n.

```
SEARCH: <div class="agent-status" style="margin-left: auto; color: var(--muted); font-size: 0.8rem;">mcp-coordinator v0.2.1 &middot; quota 62%</div>
REPLACE: <div class="agent-status" style="margin-left: auto; color: var(--muted); font-size: 0.8rem;" data-i18n="start.dash.meta">mcp-coordinator v0.2.1 &middot; quota 62%</div>
```

### 6. Timeline rows have no `data-i18n` or `lang` fallback
8 timeline `<div>`s violate §16. Avoid 48 new keys (8 rows × 6 locales) by formalizing them as locale-neutral figure data.

```
SEARCH: <figure class="dash-preview fade-in" role="img" aria-label="Sample dashboard view: four agents tracked live, with a conflict resolved in 38 seconds" data-i18n-aria="start.dash.aria">
REPLACE: <figure class="dash-preview fade-in" role="img" lang="en" aria-label="Sample dashboard view: four agents tracked live, with a conflict resolved in 38 seconds" data-i18n-aria="start.dash.aria">
```

### 7. Step 4 desc capitalizes a CLI command name
Step 4 opens `Doctor checks config...`. The command is `doctor` (lowercase) per the code-block on the same card. Sentence-initial capitalization of a command name confuses.

```
SEARCH: data-i18n="start.step4.desc">Doctor checks config, server, MCP responses, and MQTT connections. Then it opens the dashboard at
REPLACE: data-i18n="start.step4.desc">The <code style="color:var(--accent);font-size:0.85em;">doctor</code> command checks config, server, MCP responses, and MQTT connections, then opens the dashboard at
```

## DO NOT TOUCH

- 4 install steps and their original order (Install → init → server start → doctor + dashboard) — spec §4.8 tutorial integrity.
- Anchor aliases `#install` and `#dashboard` at top — synthesis §9 binding.
- Dashboard preview classes (`.dash-preview`, `.dash-header`, `.dash-timeline`, `.tl-*`, `.dot-*`) — existing CSS.
- Synthesis §12 install-note copy used verbatim with `mcp-coordinator` lowercase per glossary — preserve sentence and single em-dash.
- Closing CTA link set (`Star on GitHub` + `Open an issue`) — synthesis §8 row 4. Issue #2 only changes the class.
- `data-i18n-aria="start.dash.aria"` mapping.
- 8 timeline rows' content (timestamps, agent names, scores) — moved verbatim per brief.
- Open question 4 (shields.io badge): correctly omitted.
- Open question 5 (`#install-note` anchor): correctly omitted; not in §9 map.
- "What you'll see in 60 seconds" h3 — spec §4.8 mandates this exact wording.
