# Layer 1 Synthesis — Input Contract for 22 Section Agents

**Status**: BINDING. Layer 2 leads and critics MUST follow these rules verbatim. Deviations are grounds for rejection.

This synthesis merges the 5 Layer 1 briefs into a single non-contradictory rules-sheet. Where briefs disagreed, the resolution is explicit below.

---

## 1. North star metric (from strategy-lead)

A first-time technical visitor (Solo Sam or Team-lead Tara) can within 90 seconds:
1. State the problem mcp-coordinator solves in one sentence
2. Name at least one of the four coordination patterns (templates section)
3. Reach the `Get Started` snippet without scrolling past redundant content

---

## 2. Section ownership table — what each section MUST and MUST NOT cover

To prevent the redundancy that broke the current page, each concept gets exactly ONE section.

| Concept | Owner | Forbidden in |
|---------|-------|--------------|
| The pain (regressions, duplicate work, no visibility) | `pain` (§2) | hero, solution, mechanism, FAQ |
| Live system demo / screenshot / animation | `solution` (§3) | hero (terminal stays), pain |
| 4-step protocol cycle | `mechanism` (§4) | how it works belongs nowhere else |
| Impact scoring (100/80/30/0) | `mechanism` (§4) sub-block | NOT in solution |
| MQTT topics / push delivery | `mechanism` (§4) collapsible | NOT a separate section |
| 4 coordination patterns | `templates` (§5) | NOT in mechanism |
| Alternatives ("why not X?") | `compare` (§6) | hero, FAQ |
| Architecture diagram | `tech` (§7) | NOT redrawn elsewhere |
| Deployment modes (local/team/cloud) | `tech` (§7) | NOT in start, NOT in install |
| Install commands | `start` (§8) | NOT in tech, NOT in mechanism |
| Dashboard preview | `start` (§8) | NOT a separate section |
| Test scenarios + perf metrics | `results` (§9) | NOT in mechanism |
| Q&A / objections | `faq` (§10) | NOT spread across sections |
| Future versions / shipped milestones | `roadmap` (§11) | NOT in start, NOT in compare |

**Duplication veto rule** (from strategy-lead's decision tree): if a noun phrase already appears in another section's draft, the section earlier in the arc keeps the surface mention; the later section uses a deeper, more specific framing. Tie-breaker: the spec's section 4 brief.

---

## 3. Brand voice — the glossary is binding

### Glossary (from brand-voice). Section leads MUST use the PREFER form verbatim.

```
PREFER: "agent" / DON'T USE: "AI agent", "Claude instance", "LLM agent", "bot"
PREFER: "consultation thread" / DON'T USE: "discussion", "chat thread", "conversation"
PREFER: "MQTT broker" / DON'T USE: "message bus", "event bus", "pub/sub layer"
PREFER: "mcp-coordinator" / DON'T USE: "MCP Coordinator", "the Coordinator", "MCP-coordinator"
PREFER: "MCP client" / DON'T USE: "agent runtime", "AI tool", "MCP-compatible IDE"
PREFER: "announce work" / "announcement" / DON'T USE: "register intent", "declare task", "post job"
PREFER: "impact score" / DON'T USE: "conflict score", "risk score", "overlap rating"
PREFER: "consultation" / DON'T USE: "negotiation", "sync", "handshake"
PREFER: "consensus" / DON'T USE: "agreement", "approval", "sign-off"
PREFER: "between turns" / DON'T USE: "asynchronously", "in the background", "out-of-band"
PREFER: "self-hosted" / DON'T USE: "on-prem", "private cloud", "self-managed"
PREFER: "MCP tool" / DON'T USE: "API endpoint", "function", "RPC method"
PREFER: "dashboard" / DON'T USE: "UI", "console", "control panel", "web app"
PREFER: "coordination pattern" / DON'T USE: "template", "blueprint", "recipe"
PREFER: "essaim" / DON'T USE: "Essaim", "ESSAIM", "swarm framework"
```

**Note on apparent contradiction**: section 5 is named `templates` (the section ID stays for backwards-compat with CSS class names `.tmpl-*`), but the user-facing prose MUST say "coordination pattern" or "pattern", never "template". The section's `<h2>` is `Coordination patterns`, not `Templates`.

### Forbidden phrases (hard ban):

- "revolutionary", "game-changing", "next-generation", "best-in-class", "world-class"
- "AI-powered", "AI-native", "intelligent coordination"
- "seamless", "seamlessly"
- "unleash", "supercharge", "turbocharge", "rocket"
- "effortlessly", "magically", "out of the box magic"
- "the only X that...", "the first X to..."
- "empower(s)", "empowering"

### Voice axes (target):

| Axis | Target | Practical effect |
|------|--------|------------------|
| Technical depth | 7/10 | Keep credibility for tech evaluators; pain/solution/FAQ readable without glossary |
| Formality | 5/10 | Engineer-to-engineer; no exclamation marks |
| Assertiveness | 8/10 | Make claims with evidence; replace hedging with crisp answers |
| Density | 6/10 | LOWER than current; shorter sentences, more whitespace |

### Sentence-length budget:

- **Average**: ~16 words/sentence
- **Maximum**: 28 words. Anything longer must be split.
- **No sentence may contain more than one em-dash.** Current page abuses em-dashes.

---

## 4. Length budget per element

- `<h2>` section title: ≤ 6 words
- `section-sub` paragraph: ≤ 25 words, single sentence
- Card body `<p>`: ≤ 45 words
- No paragraph exceeds 3 sentences
- No section exceeds 220 visible words excluding code blocks and tables

---

## 5. Code & terminology style

- Install command: exactly `npm install -g mcp-coordinator`. Never `npx`. Never bare `npm install`.
- JSON examples: 2-space indent, double quotes, no trailing commas, keys quoted.
- Inline shell tokens use `<code>`. Comments inside terminal blocks use `# ` prefix and `t-dim` class.
- Tool names always wrapped in `<code>`: `announce_work`, `coordinator_status`, `register_agent`.
- Address the reader as "you" (singular). Never "we", never "users", never "developers" (third-person).

---

## 6. Emoji policy

- Allowed only inside `<span aria-hidden="true">` decorating card icons (existing pattern, e.g., `docs/index.html:1393`, 1465).
- Never in headings, prose, or CTAs.
- Never more than one emoji per card.
- New sections (`templates`, `faq`, `solution`) prefer SVG/CSS icons over emoji.

---

## 7. Hero — locked decisions

From marketing-strategist + brand-voice:

- **Eyebrow**: keep `Open Source · MIT · v0.2.x`
- **H1**: `Zero conflicts. Every agent aligned.` (kept)
- **Subtitle (REPLACE)**: `5 agents, 1 codebase, 0 merge conflicts. The MCP server that keeps parallel Claude Code, Cursor, and Cline agents aligned.`
- **Stats pills**: `<50ms push latency` · `Zero sidecar` · `Any MCP client` (kept)
- **Hero terminal animation**: kept (4 lines)
- **CTAs in hero**:
  - Primary: `Get Started` → `#start`
  - Secondary: `See it live` → `#solution` (NEW)
  - Tertiary: `Star on GitHub` (with shields.io live star count) → GitHub
- **Optional addition**: GitHub star shields.io badge in hero eyebrow line

---

## 8. CTA strategy — 4 placements (was 2)

| # | Location | Primary text | Secondary | Links to |
|---|----------|--------------|-----------|----------|
| 1 | Hero | `Get Started` | `See it live`, `Star on GitHub` | `#start`, `#solution`, github |
| 2 | End of `mechanism` (§4) — NEW | `Run it locally in 60 seconds` | `Read the FAQ` | `#start`, `#faq` |
| 3 | End of `compare` (§6) — NEW | `Install in one command` (with inline `npm install -g mcp-coordinator`) | — | `#start` |
| 4 | End of `start` / footer | `Star on GitHub` | `Open an issue` | github, github/issues |

**Hard rule**: one primary per CTA cluster. Two primaries side-by-side dilute conversion.

---

## 9. Anchor map (from info-architect) — REQUIRED for backwards compatibility

Every section that absorbs an old anchor MUST place an `<span id="OLD_ID" class="anchor-alias"></span>` at its top, immediately before the section's heading.

| Old anchor | New host section | Type |
|------------|------------------|------|
| `#hero` | `#hero` | primary |
| `#why` | `#pain` | alias |
| `#problem` | `#pain` | alias |
| `#how-it-works` | `#mechanism` | alias |
| `#mqtt` | `#mechanism` | alias |
| `#scoring` | `#mechanism` | alias |
| `#worktrees` | `#compare` | alias |
| `#architecture` | `#tech` | alias |
| `#deploy` | `#tech` | alias |
| `#install` | `#start` | alias |
| `#dashboard` | `#start` | alias |
| `#results` | `#results` | primary |
| `#roadmap` | `#roadmap` | primary |

CSS already in place (info-architect verified): `.anchor-alias { display:block; height:0; scroll-margin-top: var(--nav-h, 72px); }` — if not, add it.

---

## 10. Nav menu (from info-architect) — REPLACES current nav

| Label | href | Action | i18n key |
|-------|------|--------|----------|
| How | `#mechanism` | remap | `nav.how` (kept) |
| Patterns | `#templates` | add | `nav.patterns` (NEW) |
| Compare | `#compare` | add | `nav.compare` (NEW) |
| Architecture | `#tech` | remap | `nav.arch` (kept) |
| FAQ | `#faq` | add | `nav.faq` (NEW) |
| Roadmap | `#roadmap` | keep | `nav.roadmap` (kept) |
| GitHub | github URL | keep | unchanged |
| Get Started | `#start` | remap | `nav.getstarted` (kept) |

`Deploy` and `Install` are dropped from nav (kept as anchor aliases inside their absorbing sections).

---

## 11. Skip-link — already correct (info-architect verified)

The skip-link at `docs/index.html:1316` (`<a href="#main">`) targets `<main id="main">` at line 1345 — both already exist. CSS at lines 1242-1248. **The only required change**: add `tabindex="-1"` to the `<main>` opening tag.

---

## 12. Per-section concrete rewrites (from marketing-strategist)

These are the EXACT rewrites Layer 2 leads must use as their starting copy. They override the current page.

### Pain card 1 (was `problem.card1.desc`):
> Tuesday 3pm. Alice's agent ships `User.updated_at`. Four minutes later, Bob's agent renames `User.id`. Tests pass. Prod breaks at 2am because the migration order was wrong.

### Pain card 2 (was `problem.card2.desc`):
> Two agents both implement retry logic. Agent A picks exponential backoff (250ms→8s). Agent B picks linear (500ms×5). Code review surfaces the divergence — 800k tokens in.

### Pain card 3 (was `problem.card3.desc`):
> Tom asks his agent: "is anyone else working on auth?" The agent answers: "I have no way to know." Tom shrugs and proceeds. Carol's agent did the same thing 20 minutes ago.

### Hero subtitle (was `hero.subtitle`):
> 5 agents, 1 codebase, 0 merge conflicts. The MCP server that keeps parallel Claude Code, Cursor, and Cline agents aligned.

### `start` install note (was `install.note`):
> `git worktree add ../feature-x main` and run each agent in its own worktree — coordinator handles "who's editing types.ts"; worktrees handle "no two agents fighting the same inode."

### `mechanism` "Consult" step rewrite (was `how.step3.desc`):
> The coordinator opens a consultation thread and publishes it to the MQTT broker. Each concerned agent reads the event between turns and posts context, constraints, or a resolution. No sidecar process required.

### `compare` rewrite of "git worktrees?" answer (was `worktrees.card1.desc`):
> No. Worktrees isolate filesystems. mcp-coordinator coordinates intent. A clean merge of two incompatible designs still ships a broken runtime. Use both.

---

## 13. Personas — who each section serves (from audience-analyst)

| # | Section | Sam | Tara | Alex |
|---|---------|-----|------|------|
| 1 | Hero | HIGH | HIGH | MED |
| 2 | Pain | HIGH | HIGH | LOW |
| 3 | Solution | HIGH | HIGH | MED |
| 4 | Mechanism | MED | HIGH | HIGH |
| 5 | Templates | LOW | MED | HIGH |
| 6 | Compare | MED | MED | HIGH |
| 7 | Tech | LOW | HIGH | HIGH |
| 8 | Start | HIGH | HIGH | LOW |
| 9 | Results | LOW | HIGH | HIGH |
| 10 | FAQ | MED | HIGH | HIGH |
| 11 | Roadmap | LOW | MED | HIGH |

**Reading the table**: section leads writing for sections where one persona is HIGH and the others are LOW must avoid alienating the LOW personas (no excluding language) but should optimize for the HIGH persona.

---

## 14. FAQ content — these 5+ objections must be addressed

From audience-analyst. The FAQ section lead uses these as starting Q/A:

1. **"Yet another tool to maintain."** → One `npm i -g`. Embedded broker + SQLite + dashboard. Zero sidecar. `uninstall` is symmetric.
2. **"I don't run multiple agents — does this matter?"** → One agent + you = two actors. Dashboard surfaces what your agent touched and when. Adding teammates later is config-only.
3. **"Production-ready or hobby?"** → 216 unit tests across 4 conflict scenarios, MIT, semver, `doctor` command, Pino logs per component.
4. **"Will my team adopt YET ANOTHER coordination tool?"** → Surface = one `.mcp.json` + a CLAUDE.md block scaffolded by `init --write-claude-md`. No new chat tool, no login, no dashboard to babysit.
5. **"What if the coordinator goes down?"** → Agents fail open — keep working as if uninstalled. Local SQLite; restart resumes.

The faq-lead is responsible for adding the 5 additional Q/A from the spec section 4.10 (Q1, Q3, Q4, Q5, Q9 from spec are not duplicated above).

---

## 15. Resolved contradictions

| Contradiction | Resolution |
|---------------|------------|
| Strategy-lead says "consultation thread" only after first use; brand-voice says PREFER "consultation thread" verbatim | Brand-voice wins on first use; subsequent uses within same section may shorten to "thread" if context is unambiguous |
| Marketing says "closer = mechanism"; spec section 8 made `start` the action target | Both are true — `mechanism` ends with a CTA pointing to `#start`; `start` is the action target |
| Info-architect says skip-link already exists; spec section 11 implied it was missing | Info-architect wins (verified file). Action: `tabindex="-1"` on `<main>` only |
| Brand-voice says glossary term is "coordination pattern"; section 5 has CSS classes `.tmpl-*` | Section ID stays `templates` (CSS compatibility); user-facing prose says "coordination pattern" |

---

## 16. Quick-reference checklist for section leads

Every section lead MUST tick all of these in their `lead-notes.md`:
- [ ] Section title ≤ 6 words
- [ ] Subtitle ≤ 25 words, single sentence
- [ ] No paragraph > 3 sentences
- [ ] No sentence > 28 words
- [ ] No more than one em-dash per sentence
- [ ] No forbidden phrases used
- [ ] Glossary terms used verbatim
- [ ] All `data-i18n` attributes present
- [ ] Anchor aliases included (per section 9 above)
- [ ] No content overlapping the ownership table (section 2 above)
- [ ] CTA placement (if any) matches section 8 above
- [ ] Concrete rewrite (if applicable from section 12) used as starting point

---

**End of synthesis. This is the binding contract for Layer 2.**
