# mcp-coordinator Documentation Redesign — Design Spec

**Date**: 2026-05-09
**Author**: Maxime Gagnon (swoofer) + Claude (Opus 4.7)
**Target file**: `docs/index.html` (3133 lines, 204K)
**Approach**: B — Restructure + rewrite (10 → 11 sections, narrative arc, 30+ parallel subagents)

---

## 1. Goals

1. **Make it clearer** — primary objective from the user. The current page (post-recent-redesign at commit `0f35f49`) still has structural redundancy and density issues that obscure the value prop.
2. **Strengthen marketing/conversion** — add social proof, FAQ, sharper differentiation. The hero is good, the conversion path after is unfocused.
3. **Modernize visual rendering** — keep dark theme but polish typography, spacing, real micro-interactions, and surface unused CSS (templates).
4. **Preserve i18n + SEO + external anchor URLs** — backwards-compat is non-negotiable.

## 2. Problems with the current page

| Problem | Evidence | Impact |
|---------|----------|--------|
| Redundancy A | "Why MCP Coordinator?" (block 1+2+3) + "The coordination problem" (3 cards) cover the same pain points twice | Wastes scroll, dilutes message |
| Redundancy B | "How it works" (4 steps) + "MQTT" (push flow) + "Scoring" (table) all describe the mechanism | Reader gets technical depth before they've understood the basics |
| Redundancy C | "Architecture" + "Deploy anywhere" (3 modes) both describe deployment topology | Should be 1 section with 2 facets |
| Missing — Coordination patterns | CSS classes `.tmpl-grid`, `.tmpl-card`, `.tmpl-icon.parallel/sequential/hierarchy/readonly`, `.tmpl-layer.foundation/pattern/mission/safety` exist (lines 1111-1212) but no HTML uses them | Major feature surface area unaddressed |
| Missing — FAQ | No section addressing common objections | Buyers leave without answers |
| Missing — Social proof | No testimonials, no usage metrics, no comparison with alternatives beyond the 4-card "Why not X?" | Trust gap for new visitors |
| Density | Each section averages 250-400 words of dense technical prose with limited progressive disclosure | Cognitive load too high |
| ASCII diagrams | Architecture, MQTT flow, dashboard timeline all use ASCII art | Looks dated, inaccessible to non-developers |

## 3. New section structure (11 sections, narrative arc)

**Arc**: Hook → Pain → Solution → Mechanism → Patterns → Differentiation → Tech → Action → Proof → Objections → Future

| # | Section ID | Title | Source(s) | Strategy |
|---|------------|-------|-----------|----------|
| 1 | `hero` | Hero | hero (kept) | Polish CTA, add secondary "See it live" |
| 2 | `pain` | The coordination pain | why-block1 + problem | Fusion — 3 punchy cards with concrete examples |
| 3 | `solution` | The solution running | why-block2 + why-block3 | Fusion — animated mini dashboard mock + live conflict catch |
| 4 | `mechanism` | How it works | how-it-works + mqtt + scoring | Triple fusion — 4 steps + scoring rows + collapsible MQTT detail |
| 5 | `templates` | Coordination patterns ⭐ NEW | (uses existing `.tmpl-*` CSS) | 4 cards: Parallel / Sequential / Hierarchy / Read-only with behavior layers |
| 6 | `compare` | Why not alternatives? | worktrees (kept, polish) | 5 cards: worktrees, Agent Teams, Slack, CI, orchestrators |
| 7 | `tech` | Architecture & deployment | architecture + deploy | Fusion — diagram + 3 modes (local/team/cloud) |
| 8 | `start` | Get started | install + dashboard | Fusion — 4 steps + dashboard preview animée |
| 9 | `results` | Tested scenarios | results (kept, polish) | Add performance metrics |
| 10 | `faq` | FAQ ⭐ NEW | (new) | 10 questions accordion + FAQPage structured data |
| 11 | `roadmap` | Roadmap | roadmap (kept, polish) | Add dates and GitHub issue links |

### Backwards-compatible anchors

External links may reference: `#install`, `#worktrees`, `#dashboard`, `#how-it-works`, `#mqtt`, `#scoring`, `#architecture`, `#deploy`, `#problem`, `#why`, `#results`, `#roadmap`. These are preserved as invisible `<span id="..." class="anchor-alias"></span>` placed inside the appropriate new section. Primary IDs become `#pain`, `#solution`, `#mechanism`, `#templates`, `#compare`, `#tech`, `#start`, `#faq`.

## 4. Per-section content briefs

### Section 1 — Hero
**Goal**: Hook in <5 seconds.
**Content**:
- Eyebrow: `Open Source · MIT · v0.2.x`
- H1: `Zero conflicts. Every agent aligned.` (kept)
- Subtitle: tightened to one breath
- Stats pills: `<50ms push latency`, `Zero sidecar`, `Any MCP client`
- Hero terminal: keep the 4-line typing animation
- CTAs: Primary `Get Started` → #start, Secondary `See it live` → #solution, Tertiary `GitHub`

### Section 2 — Pain
**Goal**: Make the reader feel the cost of un-coordinated parallel agents.
**Content**: 3 cards with concrete narrative examples (not abstract):
1. **Silent regressions** — "Tuesday 3pm, Alice's agent ships `updated_at`. Bob's agent renames `User.id` 4 minutes later. Tests pass, prod breaks at 2am."
2. **Duplicated effort** — "Two agents implement the same retry logic with different exponential backoff defaults. Code review surfaces the divergence after 800k tokens burned."
3. **No visibility** — "Tom asks his agent: 'is anyone else working on auth?' Agent answers: 'I have no way to know.'"
**Visual**: Keep current card layout, add subtle "incident timeline" decoration.

### Section 3 — Solution
**Goal**: Show the system working in 10 seconds.
**Content**:
- Hero card: animated mini dashboard mock (re-use existing `.mini-dash-*` CSS)
- Sub-cards: "Conflicts caught before code is written" (50ms scoring) — re-use existing `feature-highlight`
**Visual**: Keep existing dashboard preview animation; add a "play again" button.

### Section 4 — Mechanism
**Goal**: Make the technical reader nod "yes, this is real engineering".
**Content** organized as **3 vertical sub-blocks**:
1. **The 4 steps** — Announce / Detect / Consult / Resolve (kept from `how-it-works`)
2. **Impact scoring** — score grid 100/80/30/0 (kept from `scoring`) with a small SVG gauge
3. **Real-time push (advanced detail, collapsible)** — MQTT topics table, push flow terminal (kept from `mqtt`)

The collapsible advanced detail uses `<details>/<summary>` for accessibility and natural progressive disclosure.

### Section 5 — Templates ⭐ NEW
**Goal**: Surface the coordination patterns CSS that's already in the file.
**Content**: 4 `.tmpl-card` elements:

| Pattern | Icon class | Description | Tags |
|---------|-----------|-------------|------|
| **Parallel** | `tmpl-icon parallel` | All agents start simultaneously, coordinate via consultation when overlap detected | `4-8 agents` `mode: parallel` `profile: coder` |
| **Sequential** | `tmpl-icon sequential` | Agents work in declared order, each consumes prior output | `2-5 agents` `mode: sequential` `profile: pipeline` |
| **Hierarchy** | `tmpl-icon hierarchy` | Lead agent dispatches subtasks; subordinates report back | `1+N agents` `mode: hierarchy` `profile: lead-dispatch` |
| **Read-only** | `tmpl-icon readonly` | Observers watch the timeline, post warnings/comments without writing | `0..many` `mode: readonly` `profile: reviewer` |

Each card has:
- Header (icon + name)
- Description
- Mini flow visualization (using `.tmpl-flow .fl-green/.fl-blue/.fl-yellow`)
- Tags (`.tmpl-tag.tag-agents/tag-mode/tag-profile/tag-rule`)
- Behavior layer bars (foundation / pattern / mission / safety) using existing `.tmpl-layer-bar.*` classes

Tagline: "Pre-built coordination shapes for the most common multi-agent scenarios. Composable with [essaim](https://github.com/swoofer/essaim) behaviors."

### Section 6 — Compare
**Goal**: Pre-empt "isn't this solved by X?" objections.
**Content**: 5 cards (was 4):
1. `…git worktrees?` — kept
2. `…Claude Code Agent Teams?` — kept
3. `…Slack manual coordination?` — kept
4. `…CI gates / branch protection?` — kept
5. `…orchestrators (essaim, AutoGen, CrewAI)?` ⭐ NEW — "Orchestrators run agents; mcp-coordinator is the protocol they speak. essaim is built ON mcp-coordinator. AutoGen and CrewAI ship without conflict detection — pair them with mcp-coordinator and they suddenly stop colliding."

### Section 7 — Tech
**Goal**: Tech evaluator can validate the architecture and pick a deployment.
**Content** organized as **2 sub-blocks**:
1. **Architecture diagram** + 3 component cards (agent-loop / coordinator / dashboard)
2. **Deploy anywhere** — 3 deploy cards (local / team / cloud) with their command snippets

### Section 8 — Start
**Goal**: Get the visitor up and running in <60s.
**Content**:
- 4 install steps (kept from `install`)
- Below: "What you'll see in 60 seconds" — animated dashboard preview (moved from current `#dashboard` section)
**Note**: This consolidates `install` and `dashboard` into a single "action" section.

### Section 9 — Results
**Goal**: Validate that the claims are tested.
**Content**:
- 4 scenarios table (kept)
- Add performance row: "Detection <5ms · Push <50ms · Full consensus 30-45s · 216 unit tests"
- Link to `tests/` on GitHub

### Section 10 — FAQ ⭐ NEW
**Goal**: Address remaining objections.
**Content**: 10 accordion questions (using `<details>/<summary>` for native a11y + no-JS fallback):

1. **Does this replace git worktrees?** — "No. Worktrees solve filesystem isolation; mcp-coordinator solves *intent* coordination. Use both."
2. **Is it production-ready?** — "v0.2.x is stable for solo and team use. v1.0 freezes the public API. The protocol is tested across 216 unit tests covering all 4 conflict scenarios."
3. **What does it cost?** — "MIT-licensed, free. Self-hosted on your machine, your LAN, or your cloud."
4. **Which MCP clients work?** — "Any client speaking MCP 2024-11-05: Claude Code, Cursor, Cline, Aider, custom scripts. HTTP/SSE or stdio."
5. **Can multiple repos share one coordinator?** — "Today: yes via shared LAN/cloud deployment. Cross-repo first-class support is on the roadmap (v1.0)."
6. **Is auth/JWT required?** — "Local mode: no. Team/cloud mode: opt-in JWT (HS256 via jose)."
7. **How is this different from Aider/Cline's own coordination?** — "Aider and Cline have no cross-session coordination — they're single-process. mcp-coordinator gives them shared awareness."
8. **Can I run it on my laptop only?** — "Yes. `mcp-coordinator server start --daemon` and you have an embedded MQTT broker + MCP server + dashboard locally. No cloud dependency."
9. **Are coordination behaviors customizable?** — "Yes. The behaviors are YAML configs assembled by [@swoofer/promptweave](https://github.com/swoofer/promptweave); see [essaim's catalog](https://github.com/swoofer/essaim/tree/main/behaviors) for examples."
10. **Will my agent lose context between turns?** — "No. Coordinator events arrive between turns via MQTT (push) or polling (`coordinator_status`). Your agent reads them and re-enters its turn loop with the new context appended."

Add `FAQPage` JSON-LD structured data for SEO.

### Section 11 — Roadmap
**Goal**: Show momentum and direction.
**Content**: Existing 5 timeline items + add:
- Concrete dates where applicable (e.g., v0.3 ETA Q3 2026)
- Link each item to its GitHub issue/milestone

## 5. i18n migration strategy

The current dictionary covers 6 languages: `en`, `fr`, `es`, `de`, `zh`, `ja`. Total ~120 keys. Migration plan:

| Action | Keys | Notes |
|--------|------|-------|
| **Preserve** | `hero.*`, `roadmap.*`, `mqtt.topics.*` (moved into `mechanism.advanced.*`), `results.*` | Same key names |
| **Rename** | `why.* + problem.*` → `pain.*`, `how.* + scoring.*` → `mechanism.*`, `arch.* + deploy.*` → `tech.*`, `install.* + dashboard.*` → `start.*` | Old keys remain as deprecated aliases for 1 release |
| **Add** | `solution.*`, `templates.*`, `faq.*`, `compare.card5.*` | New strings, English first; placeholder TODO for fr/es/de/zh/ja |
| **Drop** | None | Backwards-compat preferred |

The `agent-i18n-migrator` agent owns this migration and produces a single PR-ready diff for the `translations` object in the `<script>` block.

## 6. Architecture decisions

### Single-file vs multi-file

The current `index.html` is a single 3133-line file with embedded CSS and JS. We **keep this single-file architecture** for these reasons:
- Simplifies GitHub Pages deployment (no build step)
- Improves first-paint performance (no network waterfall)
- Matches the rest of the project's lightweight ethos
- Aligns with the recent commit history (`docs(landing): redesign for clarity`)

### CSS strategy

The CSS is structured into clear blocks (NAV, SECTIONS, HERO, TERMINAL, etc., …). The `templates` CSS block already exists. The redesign adds:
- New `.faq-*` block (~40 lines): `.faq-item`, `.faq-question`, `.faq-answer`
- Tweaks to existing blocks (no removal — to keep i18n keys & anchor compatibility)

### JavaScript strategy

Existing scripts (fade-in observer, hero terminal animation, copy buttons, nav active link, hamburger, i18n) are **kept as-is**. New additions:
- `<details>/<summary>` for FAQ — no JS needed (native HTML)
- Templates flow animation — pure CSS keyframes (no JS)

## 7. Sub-agent dispatch architecture

### Layer 1 — Strategy (5 agents, parallel, dispatched first)
- `agent-strategy-lead` — orchestrate, validate global coherence
- `agent-marketing-strategist` — conversion, hooks, CTAs
- `agent-info-architect` — flow, navigation, anchor strategy
- `agent-brand-voice` — tone, voice, glossary
- `agent-audience-analyst` — personas (solo dev, team lead, decision-maker)

### Layer 2 — Section teams (11 sections × 2 agents = 22 agents, parallel, dispatched after strategy)
For each section: 1 lead writer + 1 critic. Sections: hero, pain, solution, mechanism, templates, compare, tech, start, results, faq, roadmap.

### Layer 3 — Discipline specialists (6 agents, parallel, cross-cutting)
- `agent-visual-designer` — CSS coherence, micro-interactions
- `agent-a11y-auditor` — WCAG 2.1 AA, contrast, ARIA, keyboard nav
- `agent-seo-expert` — meta tags, structured data, headings
- `agent-i18n-migrator` — i18n keys migration
- `agent-perf-engineer` — render time, lazy load, font loading
- `agent-mobile-responsive` — responsive across breakpoints

### Layer 4 — QA finale (3 agents, sequential after merge)
- `agent-consistency-reviewer` — cross-section coherence
- `agent-tech-accuracy` — verifies claims (latency, tool count, etc.)
- `agent-final-polish` — typos, spacing, last details

**Total: 36 agents.**

## 8. Risks & mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Breaking external anchor links | High if not handled | Anchor aliases (invisible `<span id>`) for all old IDs |
| Translation drift after key rename | Medium | i18n-migrator agent maintains backwards-compat in dictionary; deprecated alias keys log a console warning in dev |
| Sub-agents producing inconsistent voice | High without strategy layer | Layer 1 (brand-voice agent) ships a glossary + voice guide before Layer 2 dispatches |
| FAQ structured data SEO penalty if claims unverified | Low but real | tech-accuracy agent verifies every FAQ answer maps to actual code behavior |
| Templates section feels "fake" if not backed by real essaim/promptweave content | Medium | templates-lead agent cross-references essaim's behaviors/ catalog and links concretely |
| File size growth (currently 204K) | Low | perf-engineer agent monitors output size; target <250K final |

## 9. Success criteria

- [ ] Page tells a single coherent story from top to bottom (validated by strategy-lead agent)
- [ ] No section duplicates content from another section (validated by consistency-reviewer)
- [ ] All 6 i18n languages have valid (or marked-TODO) entries for every new key (validated by i18n-migrator)
- [ ] All existing anchor URLs resolve to a meaningful section (validated by info-architect)
- [ ] WCAG 2.1 AA passes (validated by a11y-auditor)
- [ ] Lighthouse performance >= 95 desktop, >= 85 mobile (validated by perf-engineer)
- [ ] FAQPage JSON-LD validates with Google's Rich Results Test (validated by seo-expert)
- [ ] Templates section uses every CSS class already defined in `.tmpl-*` (validated by visual-designer)
- [ ] All technical claims verified against the codebase (validated by tech-accuracy)
- [ ] User accepts the final result without requesting structural changes

## 10. Out of scope

- Refactoring the project's other docs (`README.md`, `CONTRIBUTING.md`, etc.)
- Building a docs site beyond the single landing page
- Adding a blog or changelog page
- Adding analytics or tracking pixels
- Adding a newsletter signup
- Adding GitHub OAuth or any login flow
- Translating new strings into all 6 languages (i18n-migrator only ensures key parity; actual translation deferred to a follow-up task)

## 11. Implementation sequence

The implementation plan (next step, via `writing-plans`) will sequence the 36 agents as:

1. **Phase 0** — Backup current `index.html` to `index.html.backup-pre-redesign-2026-05-09`
2. **Phase 1 — Strategy** — Dispatch Layer 1 (5 agents). Output: brand voice guide + audience personas + IA map.
3. **Phase 2 — Section parallel** — Dispatch Layer 2 (22 agents) using the Layer 1 outputs as context. Each pair (lead + critic) produces a section HTML/copy fragment.
4. **Phase 3 — Discipline cross-cutting** — Dispatch Layer 3 (6 agents) on the merged draft.
5. **Phase 4 — Merge & QA** — Sequential Layer 4 (3 agents). Output: final `index.html`.
6. **Phase 5 — Verify** — Run Lighthouse, validate i18n, validate FAQPage JSON-LD, verify all anchors resolve.

## 12. Open questions (none — all resolved during brainstorming)

All design decisions were validated by the user during the 4-section brainstorming review. The implementation plan can proceed.
