# Compare (§6) — Lead Notes

## Rationale

### 5th card placement
The orchestrator card lands at position 5 (last) intentionally. Cards 1–4 reject things the reader already has on their stack (worktrees, Agent Teams, Slack, CI). Card 5 reframes the question: "what about competing multi-agent frameworks?" The answer flips the comparison from rivalry to layering — orchestrators consume mcp-coordinator. Closing on this point sets up the CTA: there is nothing left to compare against, so install it.

### Card 5 copy
Adopted the suggested copy almost verbatim. Two micro-changes: (1) lowercased "essaim" per glossary; (2) removed "suddenly" from "they suddenly stop colliding" → "they stop colliding" — the adverb softens the assertion and trips the assertiveness 8/10 budget. Icon is musical-score (🎼, `&#127932;`) — orchestrators conduct, mcp-coordinator is the score they read. Cards 1–4 keep their existing emojis (📂 👥 💬 🛡️) wrapped in `aria-hidden` spans inside the `card-icon` div per existing pattern.

### Card 1 copy
Replaced the current ALL-CAPS "CAN" / em-dash-heavy version with the synthesis §12 rewrite verbatim:
> No. Worktrees isolate filesystems. mcp-coordinator coordinates intent. A clean merge of two incompatible designs still ships a broken runtime. Use both.

### Cards 2–4 copy tightening
- **Card 2**: removed "MCP-compatible agent" → "MCP client" (glossary). Trimmed final clause for assertiveness.
- **Card 3**: removed "AI agent" → "agent" (glossary). Replaced "the coordinator" → "mcp-coordinator". Trimmed redundant clause.
- **Card 4**: replaced "the coordinator" → "mcp-coordinator". Otherwise tight already.

### Subtitle tightening
Original: "Worktrees, lockfiles, Slack, CI — none of them know your agent's intent. The coordinator is the missing layer." (22 words, two sentences, two em-dashes overall.)
Rewrite: "Worktrees, Slack, CI, orchestrators — none of them know your agent's intent." (12 words, one sentence, one em-dash, list aligns with the 5 cards now that card 5 is added; dropped "lockfiles" since no card covers them, swapped in "orchestrators".)

### Title
"Why not alternatives?" matches the spec section title and stays at 3 words.

## i18n keys

### NEW
| Key | Value |
|-----|-------|
| `compare.title` | "Why not alternatives?" |
| `compare.subtitle` | "Worktrees, Slack, CI, orchestrators — none of them know your agent's intent." |
| `compare.card1.title` | "…git worktrees?" |
| `compare.card1.desc` | (synthesis §12 verbatim) |
| `compare.card2.title` | "…Claude Code Agent Teams?" |
| `compare.card2.desc` | (tightened, see HTML) |
| `compare.card3.title` | "…Slack and manual coordination?" |
| `compare.card3.desc` | (tightened, see HTML) |
| `compare.card4.title` | "…CI gates and branch protection?" |
| `compare.card4.desc` | (tightened, see HTML) |
| `compare.card5.title` | "…orchestrators (essaim, AutoGen, CrewAI)?" |
| `compare.card5.desc` | (see HTML) |
| `compare.cta.lede` | "One command to start coordinating:" |
| `compare.cta.button` | "Install in one command" |

### Old key compatibility (`worktrees.*` → `compare.*`)
The synthesis i18n migration plan (spec §5) renames keys but keeps old aliases for one release. Action for `agent-i18n-migrator`: alias every `worktrees.cardN.{title,desc}` to its `compare.cardN.{title,desc}` equivalent. Cards 1–4 retain their original visible text (where unchanged) so already-translated `worktrees.*` values remain valid; cards whose copy was tightened (2, 3, 4) need re-translation, but the old `worktrees.cardN.*` keys can keep their old strings as deprecated fallbacks. Card 5 has no old key — fr/es/de/zh/ja get TODO placeholders. The `compare.title`/`compare.subtitle`/`compare.cta.*` keys are also new; same TODO treatment for non-English.

## Anchor IDs

- **Primary**: `#compare`
- **Alias**: `#worktrees` — placed as `<span id="worktrees" class="anchor-alias"></span>` immediately inside the `<section>` and before the `<div class="container">`, per synthesis §9.

## CTA

End-of-section CTA is synthesis §8 CTA #3: "Install in one command" linking to `#start`, with the literal `npm install -g mcp-coordinator` snippet inline. One primary button — no competing secondary action — per the "one primary per CTA cluster" hard rule.

## Checklist (synthesis §16)

- [x] Section title ≤ 6 words ("Why not alternatives?" = 3 words)
- [x] Subtitle ≤ 25 words, single sentence (12 words, 1 sentence)
- [x] No paragraph > 3 sentences (all cards: 2–3 sentences)
- [x] No sentence > 28 words (longest is 21)
- [x] No more than one em-dash per sentence
- [x] No forbidden phrases used
- [x] Glossary terms used verbatim ("agent", "mcp-coordinator", "MCP client", "consultation thread", "essaim")
- [x] All `data-i18n` attributes present (15 keys)
- [x] Anchor alias `#worktrees` included
- [x] No content overlapping ownership table (compare owns alternatives; FAQ owns Q&A; pain owns the pain)
- [x] CTA matches synthesis §8 CTA #3
- [x] Concrete rewrite (synthesis §12 "git worktrees?" answer) used verbatim in card 1

## Visible word count

Approx. 195 visible words (excluding `data-i18n` attribute values, code block content, anchor alias). Under the 220 cap.

## Open questions for critic

1. **Icon for card 5** — picked 🎼 (musical-score, U+1F3BC). Alternatives considered: 🎯 (target — feels combative, off-tone), 🪡 (needle — too obscure), 🧩 (puzzle piece — used elsewhere). Confirm 🎼 reads as "orchestration" and not "music" out of context.
2. **Card 5 specificity** — naming "essaim, AutoGen, CrewAI" is concrete but dates the page. Should the title generalize ("…multi-agent orchestrators?") with the names only in the body? Current choice keeps the names in the title because the audience-analyst (Alex persona, HIGH) Googles those names directly.
3. **CTA inline layout on mobile** — the inline `<code>` + `<a>` next to each other may wrap awkwardly under 480px. The visual-designer agent should confirm responsive behavior; if it stacks, the `margin-left: 1rem` on the button becomes wasted on the second line. Optional: add a `@media` rule, or accept stacking as acceptable.
4. **Card 2 — "Claude Code Agent Teams" capitalization** — kept as proper noun (Anthropic's feature name). Glossary covers `mcp-coordinator` casing but is silent on third-party product names; current choice matches Anthropic's docs.
5. **"essaim is built on mcp-coordinator"** — claim verification. The brand-voice spec says "essaim" is the orchestrator and is owned by the same author. Tech-accuracy agent should confirm the dependency direction (essaim depends on mcp-coordinator, not vice versa) before the page ships.

## Revision diff

Applied all 6 critic issues to produce `final.html`.

### 1. Card 5 icon: 🎼 → 🧭
- `&#127932;` (musical score) → `&#129517;` (compass)
- Rationale: "music" reading was too abstract for skim readers; compass reads as "directs/orchestrates" without the musical detour.

### 2. Card 5 title: generalize, names move to body
- `…orchestrators (essaim, AutoGen, CrewAI)?` → `…multi-agent orchestrators?`
- Names remain searchable in the body (Alex's Google query still hits). Title now matches ≤6-word parity with cards 1–4 and won't age as new frameworks ship.

### 3. Card 2 title: Anthropic's official term
- `…Claude Code Agent Teams?` → `…Claude Code subagents?`
- Body opener also revised: `Agent Teams coordinate Claude subagents inside one session.` → `Subagents coordinate inside one Claude Code session.` Removes the invented product name; aligns with Anthropic's official docs.

### 4. Mobile CTA: inline-flex + gap + flex-wrap
- Removed `style="display:inline-block;"` on `<code>` and `style="margin-left: 1rem;"` on the button.
- Wrapped both in `<div style="display:inline-flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:1rem;">`.
- Spacing now collapses cleanly on wrap (no dead margin above the stacked button under 480px).

### 5. Card 5: dependency-direction claim softened
- `essaim is built on mcp-coordinator.` → `essaim composes with mcp-coordinator natively.`
- Claim is now true regardless of import direction; reverts to stronger version once tech-accuracy verifies the `package.json` dependency.

### 6. Subtitle: Slack → lockfiles
- `Worktrees, Slack, CI, orchestrators — none of them know your agent's intent.` → `Worktrees, lockfiles, CI, orchestrators — none of them know your agent's intent.`
- Tara's mental list of failed coordination tools includes lockfiles; Slack is already addressed in card 3's title so removing it from the subtitle avoids duplication.

### Preserved (unchanged)

- Card 1 description: synthesis §12 verbatim (binding).
- Anchor alias `<span id="worktrees" class="anchor-alias"></span>` placement: immediately inside `<section>`, before `.container`.
- CTA copy "Install in one command" → `#start` (synthesis §8 CTA #3, binding).
- Install command literal `npm install -g mcp-coordinator` (synthesis §5, binding).
- Cards 3 and 4 prose; section title "Why not alternatives?"; 5-card count and ordering; Q-style "…X?" title pattern.

### i18n key impact
- `compare.subtitle` value updated (lockfiles).
- `compare.card2.title` value updated (subagents).
- `compare.card2.desc` value updated (opener rewritten).
- `compare.card5.title` value updated (generalized).
- `compare.card5.desc` value updated (composes with).
- All `data-i18n` keys themselves unchanged — only English values shift; non-English locales need re-translation for these five keys.
