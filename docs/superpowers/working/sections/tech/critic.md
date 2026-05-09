# Section 7 — TECH — Critic review

Verified: 2 sub-blocks separated via `<h3 class="section-subtitle">`. Anchor aliases `#architecture` and `#deploy` at top (lines 2-3). Reuses `.arch-*` and `.deploy-*` classes — no reinvention. No CTA — correct per synthesis §8. Brand voice tightened: zero em-dashes, no forbidden phrases.

## Issues

### 1. Subtitle violates single-sentence rule (synthesis §4)
Lead's open question 1 defers; spec is explicit. Use a comma.

```
SEARCH: <p class="section-sub" data-i18n="tech.subtitle">One agent-loop per developer, one coordinator serving MCP, MQTT, and the dashboard. Same shape from laptop to cloud.</p>
REPLACE: <p class="section-sub" data-i18n="tech.subtitle">One agent-loop per developer, one coordinator serving MCP, MQTT, and the dashboard, same shape from laptop to cloud.</p>
```

### 2. Cloud card has 4 sentences (synthesis §4: max 3)
Fuse two short ones.

```
SEARCH: <p data-i18n="tech.deploy.cloud.desc">Self-hosted on a VM or container. Remote teams coordinate through one TLS endpoint. WebSocket MQTT travels on the same HTTPS port (443). JWT-gated.</p>
REPLACE: <p data-i18n="tech.deploy.cloud.desc">Self-hosted on a VM or container. Remote teams coordinate through one TLS endpoint, with WebSocket MQTT on port 443. JWT-gated.</p>
```

### 3. Inline `margin-top` on sub-block heading
The `.section-subtitle` rule (open question 3) owns spacing. Drop inline.

```
SEARCH:     <h3 class="section-subtitle" style="margin-top: 3rem;" data-i18n="tech.deploy.title">Three modes, one experience</h3>
REPLACE:     <h3 class="section-subtitle" data-i18n="tech.deploy.title">Three modes, one experience</h3>
```

### 4. Inline `margin-top` on `.cards`
Same fix.

```
SEARCH:     <div class="cards" style="margin-top: 1.25rem;">
REPLACE:     <div class="cards">
```

### 5. Inline color/size on card `<p>` — bypasses design tokens
Three card paragraphs duplicate `style="color:var(--muted); font-size:0.9rem;"`. Move to `.card p` selector. Inline styles also clutter i18n extraction.

```
SEARCH:         <p style="color:var(--muted); font-size:0.9rem;" data-i18n="tech.arch.card1.desc">A programmatic loop wrapping the Claude CLI (spawn-per-turn <code style="color:var(--accent);font-size:0.85em;">claude -p --resume</code>). Holds the MQTT listener, the protocol state machine, and the work-stealing claim logic. Use <a href="https://github.com/swoofer/essaim" style="color:var(--accent);" rel="noopener noreferrer">essaim</a>'s loop, or roll your own.</p>
REPLACE:         <p data-i18n="tech.arch.card1.desc">A programmatic loop wrapping the Claude CLI (spawn-per-turn <code>claude -p --resume</code>). Holds the MQTT listener, the protocol state machine, and the work-stealing claim logic. Use <a href="https://github.com/swoofer/essaim" target="_blank" rel="noopener noreferrer">essaim</a>'s loop, or roll your own.</p>
```

Apply the same purge to card2 and card3 paragraphs.

### 6. `rel="noopener"` without `target="_blank"` is dead code
The `rel` only matters with `target="_blank"`. Add the target — consistent with off-site GitHub links elsewhere (also folded into Issue 5 above).

### 7. `arch-arrow` with `&nbsp;` lacks `aria-hidden`
Line 23 placeholder for grid alignment leaks to AT.

```
SEARCH:         <div class="arch-arrow">&nbsp;</div>
REPLACE:         <div class="arch-arrow" aria-hidden="true">&nbsp;</div>
```

### 8. Local diagram's "Aedes broker" — glossary says "MQTT broker"
Glossary PREFER `MQTT broker`. Architecture diagram (line 22) keeps "Aedes broker" once as implementation marker — fine. Second instance in local mode normalizes.

```
SEARCH:               <div class="dd-box dd-muted">Aedes broker<br/><small>TCP :1883 / WS /mqtt</small></div>
REPLACE:               <div class="dd-box dd-muted">MQTT broker<br/><small>Aedes · :1883 / /mqtt</small></div>
```

## DO NOT TOUCH

- The 2-sub-block structure with `<h3 class="section-subtitle">` separator — correct per spec §4.7.
- Both anchor aliases `#architecture` and `#deploy` at top — synthesis §9 verbatim.
- Reuse of `.arch-*`, `.deploy-*`, `.dd-*`, `.deploy-cmd`, `.deploy-badge` classes.
- Absence of CTA — synthesis §8 places closer CTAs in §4 and §6, not §7.
- "Three modes, one experience" h3 — punchier than "Deploy anywhere"; open question 2 deferred to marketing-strategist; current form acceptable.
- Port `:3100` disclosure — Alex persona is HIGH and wants the concrete number (open question 5 resolved correctly).
- Mobile card stacking via `.cards` — verified (open question 4 resolved).
- Three `deploy-cmd` snippets — do not edit.
- All `data-i18n` attributes — i18n-migrator owns these next.
- The `tech.title` / `tech.subtitle` / `tech.deploy.title` key names — i18n migration table is fixed.
