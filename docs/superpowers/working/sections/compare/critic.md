# Compare (§6) — Critic

## Verification summary

- Card 1 desc: synthesis §12 verbatim. PASS.
- All 5 cards: Q-style "…X?" title + A-style desc. PASS.
- Closing CTA: matches synthesis §8 CTA #3 (`Install in one command` → `#start`, inline `npm install -g mcp-coordinator`). PASS.
- Anchor alias `#worktrees` at top of section, before `.container`. PASS.
- Brand voice: assertive, no hedging. PASS overall (one tweak below).

## Issues

### 1. Card 5 icon ambiguity (🎼 reads as "music", not "orchestration")
The musical-score glyph is too abstract for a hostile-skim reader. A compass conveys "directs / orchestrates" without the musical detour and is widely used for orchestration UIs.

```search
        <div class="card-icon" aria-hidden="true"><span aria-hidden="true">&#127932;</span></div>
        <h3 data-i18n="compare.card5.title">…orchestrators (essaim, AutoGen, CrewAI)?</h3>
```
```replace
        <div class="card-icon" aria-hidden="true"><span aria-hidden="true">&#129517;</span></div>
        <h3 data-i18n="compare.card5.title">…multi-agent orchestrators?</h3>
```

(`&#129517;` = 🧭 compass; title also generalised — see issue 2.)

### 2. Card 5 title dates the page with vendor names
Per audience-analyst, Alex Googles "AutoGen vs mcp-coordinator" — but the names belong in the body where they remain searchable, not in the H3 that ages with each new framework. Generalizing the title also restores "≤6 words" parity with cards 1–4. (Replacement combined with issue 1 above.)

### 3. Third-party brand casing — "Claude Code Agent Teams" is invented
Anthropic's feature is named **subagents** in Claude Code's official docs, not "Agent Teams". Shipping an invented product name reads as careless to Alex (HIGH on this section). Title becomes more accurate AND more concise.

```search
        <h3 data-i18n="compare.card2.title">…Claude Code Agent Teams?</h3>
        <p data-i18n="compare.card2.desc">Agent Teams coordinate Claude subagents inside one session. mcp-coordinator coordinates any MCP client across any session, machine, or vendor. Cursor and Claude Code on different laptops can share one consultation thread.</p>
```
```replace
        <h3 data-i18n="compare.card2.title">…Claude Code subagents?</h3>
        <p data-i18n="compare.card2.desc">Subagents coordinate inside one Claude Code session. mcp-coordinator coordinates any MCP client across any session, machine, or vendor. Cursor and Claude Code on different laptops can share one consultation thread.</p>
```

### 4. Mobile CTA: `margin-left: 1rem` wastes whitespace when the button wraps below the code block
Under 480px the inline `<code>` + `<a>` stack vertically; the left-margin then adds dead space above the button. Use a flex container with gap so spacing collapses cleanly on wrap.

```search
    <div class="compare-cta text-center" style="margin-top: 3rem;">
      <span data-i18n="compare.cta.lede" style="display:block; margin-bottom: 0.75rem; color: var(--muted); font-size: 0.9rem;">One command to start coordinating:</span>
      <code class="code-block" style="display:inline-block;">npm install -g mcp-coordinator</code>
      <a href="#start" class="btn btn-primary" data-i18n="compare.cta.button" style="margin-left: 1rem;">Install in one command</a>
    </div>
```
```replace
    <div class="compare-cta text-center" style="margin-top: 3rem;">
      <span data-i18n="compare.cta.lede" style="display:block; margin-bottom: 0.75rem; color: var(--muted); font-size: 0.9rem;">One command to start coordinating:</span>
      <div style="display:inline-flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:1rem;">
        <code class="code-block">npm install -g mcp-coordinator</code>
        <a href="#start" class="btn btn-primary" data-i18n="compare.cta.button">Install in one command</a>
      </div>
    </div>
```

### 5. Essaim dependency direction — unverified claim
Card 5 asserts "essaim is built on mcp-coordinator." Lead flagged this for tech-accuracy. Until verified against the essaim repo's `package.json` / imports, soften to a weaker claim that is true regardless of direction. If tech-accuracy confirms the dependency, revert.

```search
        <p data-i18n="compare.card5.desc">Orchestrators run agents; mcp-coordinator is the protocol they speak. essaim is built on mcp-coordinator. AutoGen and CrewAI ship without conflict detection — pair them with mcp-coordinator and they stop colliding.</p>
```
```replace
        <p data-i18n="compare.card5.desc">Orchestrators run agents; mcp-coordinator is the protocol they speak. essaim composes with mcp-coordinator natively. AutoGen and CrewAI ship without conflict detection — pair them with mcp-coordinator and they stop colliding.</p>
```

### 6. Subtitle drops "lockfiles" but the term still resonates with Tara
Lead's reasoning ("no card covers them") is sound, but Tara's mental list of failed coordination tools includes lockfiles. Keep the rhythm and add it back without lengthening the list past four nouns by swapping "Slack" → "lockfiles" — Slack is already implicit in card 3's title and remains addressed there.

```search
      <p class="section-sub" data-i18n="compare.subtitle">Worktrees, Slack, CI, orchestrators — none of them know your agent's intent.</p>
```
```replace
      <p class="section-sub" data-i18n="compare.subtitle">Worktrees, lockfiles, CI, orchestrators — none of them know your agent's intent.</p>
```

## DO NOT TOUCH

- Card 1 description (synthesis §12 verbatim — binding).
- Anchor alias placement: `<span id="worktrees" class="anchor-alias">` immediately inside `<section>` before `.container`.
- CTA text "Install in one command" and target `#start` (synthesis §8 CTA #3 — binding).
- Install command literal `npm install -g mcp-coordinator` (synthesis §5 — binding).
- Cards 3 and 4 prose. Both are tight, assertive, within sentence and em-dash budgets.
- "essaim" lowercase, "mcp-coordinator" lowercase-hyphen (glossary — binding).
- Title "Why not alternatives?" (3 words, matches spec §3 row 6).
- The 5-card count and ordering (worktrees → subagents → Slack → CI → orchestrators). The arc closes the layer-flip in card 5; reordering breaks the CTA setup.
- Q-style "…X?" title pattern across all 5 cards.
