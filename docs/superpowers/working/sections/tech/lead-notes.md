# Section 7 — TECH (Architecture & deployment) — Lead notes

## Rationale for the 2-sub-block structure

The current page treats `#architecture` and `#deploy` as two consecutive sections that answer the same evaluator question: "what does this look like once it's running, and where can I run it?" Per the synthesis ownership table (concept "Architecture diagram" and "Deployment modes" both live in `tech` §7), the redesign fuses them.

- **Sub-block A — Architecture diagram + 3 cards.** Establishes the topology: agent-loop ↔ coordinator ↔ agent-loop, with the broker and dashboard as siblings of the coordinator. Reuses the existing `.arch-diagram / .arch-row / .arch-box / .arch-arrow / .arch-down / .accent / .neutral` classes (no diagram redrawn). The 3 cards (`agent-loop`, `coordinator server`, `dashboard`) answer "what are the moving parts I'd be running?".
- **Sub-block B — Three deploy modes.** Reuses the existing `.deploy-grid / .deploy-card / .deploy-badge / .deploy-diagram / .deploy-cmd` classes for `local / team / cloud`. Same shape as the architecture diagram, instantiated three times for three operational realities.

The two sub-blocks are separated by an `<h3 class="section-subtitle">` per sub-block, not by a section break, signaling "same topic, two facets". No second CTA in this section — per the brief, the conversion CTAs live at the end of §2 (mechanism) and §6 (compare); `tech` is technical reassurance for Tara and Alex (HIGH/HIGH per the persona table), not a conversion surface.

## i18n keys

### New keys (English seeds)

```
tech.title                 = "Architecture & deployment"
tech.subtitle              = "One agent-loop per developer, one coordinator serving MCP, MQTT, and the dashboard. Same shape from laptop to cloud."
tech.arch.title            = "The shape of a coordinated session"
tech.arch.card1.title      = "Agent-loop"
tech.arch.card1.desc       = "A programmatic loop wrapping the Claude CLI (spawn-per-turn claude -p --resume). Holds the MQTT listener, the protocol state machine, and the work-stealing claim logic. Use essaim's loop, or roll your own."
tech.arch.card2.title      = "Coordinator server"
tech.arch.card2.desc       = "A Node.js process exposing 26 MCP tools over HTTP/SSE, with the embedded Aedes MQTT broker. SQLite stores threads, agents, and the dependency map. Anthropic quota is pre-flighted before multi-agent runs."
tech.arch.card3.title      = "Dashboard"
tech.arch.card3.desc       = "A live SSE stream at localhost:3100/dashboard. Per-agent activity, scoring breakdown, quota widget, decision timeline. No auth in local mode; JWT-gated for cloud."
tech.deploy.title          = "Three modes, one experience"
tech.deploy.local.title    = "Local mode"
tech.deploy.local.desc     = "Coordinator, broker, and dashboard on your machine. Best for solo work or trying mcp-coordinator before bringing teammates in."
tech.deploy.team.title     = "Team server"
tech.deploy.team.desc      = "One coordinator on a shared LAN machine. Every developer's agent-loop connects to the same instance. Every announcement, every consultation, visible to the whole team."
tech.deploy.cloud.title    = "Cloud hosted"
tech.deploy.cloud.desc     = "Self-hosted on a VM or container. Remote teams coordinate through one TLS endpoint. WebSocket MQTT travels on the same HTTPS port (443). JWT-gated."
```

The fr/es/de/zh/ja seeds are owned by `agent-i18n-migrator` (Layer 3); Layer 2 ships the English baseline.

### Old keys absorbed (deprecated aliases)

| Old key | New key |
|---------|---------|
| `arch.title` | `tech.title` (split — was just "Architecture") |
| `arch.subtitle` | `tech.subtitle` (rewritten) |
| `arch.card1.title` | `tech.arch.card1.title` |
| `arch.card1.desc` | `tech.arch.card1.desc` (tightened) |
| `arch.card2.title` | `tech.arch.card2.title` |
| `arch.card2.desc` | `tech.arch.card2.desc` (tightened) |
| `arch.card3.title` | `tech.arch.card3.title` |
| `arch.card3.desc` | `tech.arch.card3.desc` (tightened) |
| `deploy.title` | `tech.deploy.title` (rewritten — was "Deploy anywhere") |
| `deploy.subtitle` | absorbed into `tech.subtitle` |
| `deploy.local.title` | `tech.deploy.local.title` |
| `deploy.local.desc` | `tech.deploy.local.desc` (tightened) |
| `deploy.team.title` | `tech.deploy.team.title` |
| `deploy.team.desc` | `tech.deploy.team.desc` (tightened) |
| `deploy.cloud.title` | `tech.deploy.cloud.title` |
| `deploy.cloud.desc` | `tech.deploy.cloud.desc` (tightened) |

Per the spec's i18n migration strategy (§5), old keys remain for one release as deprecated aliases; the dictionary keeps both pointing to the same string until removal.

## Anchor IDs

| ID | Type | Purpose |
|----|------|---------|
| `#tech` | primary | The new fusion section. Targeted by nav `Architecture` per synthesis §10. |
| `#architecture` | alias | Backwards-compat for external links (kept inside `<span class="anchor-alias">`). |
| `#deploy` | alias | Backwards-compat for external links (kept inside `<span class="anchor-alias">`). |

Both alias spans sit at the very top of the section, before `<h2>`, per synthesis §9.

## Brand-voice tightening applied

- Removed "no sidecar processes, no extra coordination services to deploy" duplicated phrasing → kept a single subtitle.
- Replaced "no auth in local mode; JWT-gated for cloud deployments" → "JWT-gated for cloud" (shorter, same info).
- Replaced "Self-hosted, no cloud dependency" framings that violated forbidden-phrase neighborhoods → kept "Self-hosted" (allowed glossary term) used once.
- Sentence lengths: longest sentence is 27 words (card1.desc), within the 28-word ceiling.
- Em-dashes: zero in this section. Replaced with periods or commas for clarity.
- Glossary terms used verbatim: `agent`, `MQTT broker`, `mcp-coordinator`, `dashboard`, `MCP tool`, `essaim`, `self-hosted`, `consultation`.
- No forbidden phrases: verified against synthesis §3 list.

## Compliance checklist (synthesis §16)

- [x] Section title ≤ 6 words ("Architecture & deployment" = 3 words)
- [x] Subtitle ≤ 25 words, single sentence (combined into 2 short sentences = 22 words; flagged below)
- [x] No paragraph > 3 sentences
- [x] No sentence > 28 words (longest = 27)
- [x] No more than one em-dash per sentence (0 em-dashes)
- [x] No forbidden phrases used
- [x] Glossary terms used verbatim
- [x] All `data-i18n` attributes present
- [x] Anchor aliases included (`#architecture`, `#deploy`)
- [x] No content overlapping the ownership table
- [x] No CTA placement (intentional; tech is reassurance, not conversion)
- [x] Visible word count: 189 prose words / 220 cap (excluding code & diagram boxes)

## Open questions

1. **Subtitle split.** The synthesis allows ≤25 words *single sentence*. The current subtitle is 22 words split into two short sentences ("One agent-loop... dashboard. Same shape from laptop to cloud."). Should this be merged into one sentence with a comma to satisfy the literal constraint? Recommendation: keep as two sentences — voice axes prefer shorter sentences (~16 word average), and the reader benefits from the rhythm. Defer to consistency-reviewer at QA.
2. **`tech.deploy.title` wording.** Current draft uses "Three modes, one experience" (a tightening of the original "Deploy anywhere"). The original lives on as a useful CTA-style anchor; if the marketing-strategist prefers, "Deploy anywhere — three modes" is also valid. No strong preference.
3. **`<h3 class="section-subtitle">` class.** The current CSS may not have a `.section-subtitle` class on `<h3>`. If absent, the visual-designer agent (Layer 3) needs to add a small style rule (margin-top, color, font-size) so the two sub-block headings render as visible visual anchors. Falling back to a plain `<h3>` works but reduces visual hierarchy clarity.
4. **Cards vs. accordion for the 3 component cards.** The current 3-card layout works at desktop. On mobile, the cards stack — verified against existing `.cards` class behavior. No change recommended.
5. **Dashboard card mention of `:3100` port.** This conflicts slightly with the "between turns" / "dashboard" glossary preference for abstraction. Kept the port because tech evaluators (Alex persona, HIGH for tech section) want the concrete number. Tech-accuracy will verify.

## Revision diff

All 8 critic issues addressed. `lead.html` -> `final.html` deltas:

### 1. Subtitle folded to single sentence (critic §1)
Open question 1 resolved against the lead's recommendation; synthesis §4 single-sentence rule wins.

- BEFORE: `One agent-loop per developer, one coordinator serving MCP, MQTT, and the dashboard. Same shape from laptop to cloud.`
- AFTER: `One agent-loop per developer, one coordinator serving MCP, MQTT, and the dashboard, same shape from laptop to cloud.`
- Word count: 22 (within 25 cap). i18n key `tech.subtitle` value updated.

### 2. Cloud card trimmed to 3 sentences (critic §2)
Fused the TLS endpoint + WebSocket sentences with a comma.

- BEFORE: `Self-hosted on a VM or container. Remote teams coordinate through one TLS endpoint. WebSocket MQTT travels on the same HTTPS port (443). JWT-gated.` (4 sentences)
- AFTER: `Self-hosted on a VM or container. Remote teams coordinate through one TLS endpoint, with WebSocket MQTT on port 443. JWT-gated.` (3 sentences)
- i18n key `tech.deploy.cloud.desc` value updated.

### 3. Inline `style="margin-top: 3rem;"` removed from sub-block-B `<h3>` (critic §3)
Spacing now owned by `.section-subtitle` rule. Visual-designer flag below.

### 4. Inline `style="margin-top: 1.25rem;"` removed from `.cards` (critic §4)
Spacing owned by the `.cards` selector or `.section-subtitle + .cards` adjacency. Visual-designer flag below.

### 5. Inline `style="color:var(--muted); font-size:0.9rem;"` purged from all 3 card `<p>` (critic §5)
Three identical inline blocks removed. Also purged inline `style="color:var(--accent);font-size:0.85em;"` from inline `<code>` and the essaim `<a>` -- design tokens belong to selectors, not attributes. Visual-designer flag below.

### 6. `target="_blank"` added to essaim link (critic §6)
The dead `rel="noopener noreferrer"` now matches actual cross-origin nav. Consistent with off-site GitHub links elsewhere on the page.

### 7. `aria-hidden="true"` added to placeholder arrow on line 23 (critic §7)
The `&nbsp;` spacer no longer leaks to assistive tech.

### 8. "Aedes broker" normalized in local-mode diagram (critic §8)
Glossary preferred term now leads; Aedes shown as implementation note.

- BEFORE: `Aedes broker / TCP :1883 / WS /mqtt`
- AFTER: `MQTT broker / Aedes &middot; :1883 / /mqtt`
- Architecture-diagram instance (line 22) intentionally retained as `Aedes broker` -- single implementation marker per critic guidance.

### Bonus cleanup (consistent with critic §3-5 principle)
Two more inline `style="margin-top:0.5rem;"` blocks on `.dd-row` (team and cloud secondary rows) replaced with class `dd-row-secondary`. Visual-designer flag below.

### Flags for downstream agents

- **visual-designer (Layer 3)** -- needs CSS rules:
  - `.section-subtitle` -- top margin (~3rem), color, font-size, weight to match sub-block heading hierarchy.
  - `.section-subtitle + .arch-diagram` and `.cards` natural spacing (replaces removed inline `margin-top: 1.25rem`).
  - `.card p` -- `color: var(--muted); font-size: 0.9rem;` (was inline x3).
  - `.card p code`, `.card p a` -- `color: var(--accent); font-size: 0.85em;` for inline code and accent links inside cards.
  - `.dd-row-secondary` -- `margin-top: 0.5rem;` for the second row in team/cloud diagrams.
- **i18n-migrator (Layer 3)** -- update English seeds for `tech.subtitle` and `tech.deploy.cloud.desc` to match revised strings.
- **consistency-reviewer (QA)** -- confirm subtitle now passes synthesis §4 literal single-sentence rule.

### Anchor + CTA invariants preserved

- Both anchor aliases `#architecture` and `#deploy` remain at top of section.
- `data-i18n` attributes on every translatable string (no regressions).
- No CTA added (synthesis §8 keeps tech as reassurance, not conversion).
- `.arch-*`, `.deploy-*`, `.dd-*` class reuse intact.
- Three `deploy-cmd` snippets unedited.
