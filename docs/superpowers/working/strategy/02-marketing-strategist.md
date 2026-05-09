# Marketing Strategy — mcp-coordinator landing page

**Author**: agent-marketing-strategist
**Date**: 2026-05-09
**Scope**: conversion path, hero copy, social proof, concrete rewrites, CTA placement.

---

## 1. Conversion path map

`hero` (hook in <5s) → `pain` (feel the cost) → `solution` (see it work) → **`mechanism` is the closer** → `start` (act).

The visitor's strongest yes-trigger is **`mechanism`**, not `solution`. Reason: the audience is technical (devs running parallel agents); they convert when the engineering looks real. The 4 steps + 50ms scoring + collapsible MQTT detail let them mentally validate "yes, this is buildable, and someone built it correctly." `solution` warms them; `mechanism` closes them.

Action: place a primary CTA **at the bottom of `mechanism`** ("Run it locally in 60 seconds → #start"), not just at the top hero and bottom of page. Currently there is no inline CTA between hero and the very end — that is the conversion leak.

Secondary close: `compare` (Section 6). Skeptics who survived `mechanism` need the "why-not-X" objection cleared before they install. Add a tertiary CTA there.

---

## 2. Three hero subtitle variants

Current: *"Drop-in MCP server that lets parallel Claude Code, Cursor, or Cline agents announce their work, detect conflicts, and reach consensus — before they touch your code."* (33 words, three commas, buries the verb.)

- **A — PAIN**: *"Stop your agents from overwriting each other. mcp-coordinator detects file and intent conflicts before any code is written."*
- **B — OUTCOME**: *"5 agents, 1 codebase, 0 merge conflicts. The MCP server that keeps parallel Claude Code, Cursor, and Cline agents aligned."*
- **C — MECHANISM**: *"Conflict detection in <50ms via embedded MQTT. The MCP server parallel agents use to announce work and reach consensus before they edit."*

**Recommendation: Variant B.** Reason: the H1 already names the outcome ("Zero conflicts. Every agent aligned."), and B doubles down with the specific shape — *"5 agents, 1 codebase, 0 merge conflicts"* — which is Twitter-quotable, screenshot-friendly, and addresses the buyer's mental image (multiple agents on one repo). A repeats the H1's framing in negative form (redundant). C is too narrow — sells the "how" before the "what." B gives the visitor a concrete picture in 6 words, then explains.

---

## 3. Social proof gaps (5 opportunities)

1. **GitHub star badge** — Place top-right of hero, beside the `Open Source · MIT · v0.2.x` eyebrow. Use shields.io live badge (`https://img.shields.io/github/stars/swoofer/mcp-coordinator?style=social`). Honest, automatic, zero-maintenance.
2. **"Used by N teams" claim** — Not feasible yet (no telemetry, no opt-in usage signal). Substitute: **"X downloads/week on npm"** (live `https://img.shields.io/npm/dw/mcp-coordinator`). Place in the new `start` section above the install command. If npm number is small (<50/week), suppress it for now.
3. **User testimonials** — Three viable sources, in priority order: (a) GitHub Discussions on `swoofer/mcp-coordinator` and `swoofer/essaim` — pull 2-3 quotes from issue threads where users describe their setup; (b) Twitter/X — search `from: + "mcp-coordinator"` and DM authors for permission; (c) seed via the swoofer/essaim Discord (if exists) or the `r/ClaudeAI` subreddit. Place between `solution` and `mechanism` as a thin 3-card strip, OR right before the `start` CTA as a closer. Prefer the latter — testimonials work best as the last nudge.
4. **Comparison shop** — Section 6 (`compare`) already does 4 cards. Add a fifth card explicitly: **"…vs Aider/Cline's built-in coordination?"** with the answer "Aider and Cline are single-process — no cross-session awareness. mcp-coordinator gives them the missing layer." This is more conversion-leverage than a standalone comparison page because it pre-empts the exact objection an Aider/Cline user has at the moment they consider installing.
5. **Logo bar** — Don't fake one. Real options: (a) Anthropic + MCP spec logos ("speaks MCP 2024-11-05") in a "compatible with" strip below the hero stats — honest signal of standards-compliance; (b) "Built with: Aedes · jose · SQLite · Node.js" tech-stack strip in `tech` section — credibility, not social proof, but cheap to add and authentic.

---

## 4. Five concrete-example rewrites

```
Section: pain (problem.card1.desc, line 1467)
Original: "Two agents touch the same file at the same time. One silently overwrites the other. The bug surfaces in review — or in production."
Concrete: "Tuesday 3pm: Alice's agent ships User.updated_at. Bob's agent renames User.id 4 minutes later. Tests pass. Prod breaks at 2am because the migration order was wrong."
```

```
Section: pain (problem.card2.desc, line 1472)
Original: "With no visibility into each other's intent, agents reimplement the same feature with different APIs, schemas, and assumptions."
Concrete: "Two agents both implement retry logic. Agent A picks exponential backoff (250ms→8s). Agent B picks linear (500ms×5). Code review surfaces the divergence — 800k tokens in."
```

```
Section: pain (problem.card3.desc, line 1477)
Original: "Nobody knows what the other agents are doing. Plans stay local, decisions stay invisible. Misalignment compounds until it ships."
Concrete: "Tom asks his agent: 'is anyone else working on auth?' The agent answers: 'I have no way to know.' Tom shrugs and proceeds. Carol's agent did the same thing 20 minutes ago."
```

```
Section: install.note (line 1877)
Original: "Sessions still need git worktrees for filesystem isolation. The coordinator handles intent, not files."
Concrete: "git worktree add ../feature-x main and run each agent in its own worktree — coordinator handles 'who's editing types.ts'; worktrees handle 'no two agents fighting the same inode.'"
```

```
Section: hero subtitle (line 1352)
Original: "Drop-in MCP server that lets parallel Claude Code, Cursor, or Cline agents announce their work, detect conflicts, and reach consensus — before they touch your code."
Concrete: see Variant B in section 2 — "5 agents, 1 codebase, 0 merge conflicts. The MCP server that keeps parallel Claude Code, Cursor, and Cline agents aligned."
```

---

## 5. CTA strategy

**Count: 4 CTAs total** (currently 2 — both in hero. That is the leak.)

| # | Location | Primary text | Secondary text | Style | Links to |
|---|----------|--------------|----------------|-------|----------|
| 1 | Hero (kept) | `Get Started` | `See it live` + `GitHub` | btn-primary + btn-outline ×2 | `#start`, `#solution`, github |
| 2 | End of `mechanism` (NEW) | `Run it locally in 60 seconds` | `Read the FAQ` | btn-primary + text-link | `#start`, `#faq` |
| 3 | End of `compare` (NEW) | `Install in one command` | — | btn-primary inline with `npm install -g mcp-coordinator` shown beside | `#start` |
| 4 | End of `start` / page footer | `Star on GitHub` | `Open an issue` | btn-outline + text-link | github, github/issues |

**"Get Started" exact link**: keep `#start` (will replace today's `#install` after the section rename — the spec preserves `#install` as an invisible alias). Do NOT link `Get Started` directly to GitHub — landing on a 200KB README is the highest-friction outcome. Onsite anchor lets the visitor scan the 4 install steps in-context, then leave for GitHub on their own terms.

**Primary vs secondary**: primary is always `Get Started` / `Run it locally` — verb + outcome. Secondary is always navigational (`See it live`, `GitHub`, `Read the FAQ`) — never a competing call. One primary per CTA cluster; two primaries side-by-side dilute conversion.

**Hero CTA tweak**: change current `btn-outline` `GitHub` to read `Star on GitHub` with the star count badge inline. Same destination, higher information density, social proof and CTA in one element.

---

**Word count: 692.**
