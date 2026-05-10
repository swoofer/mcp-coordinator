# Marketing & Conversion Audit — `docs/index.html`

**Verdict: Conversion-readiness 5/10.**

Strong craft, sharp positioning vs. alternatives, beautiful animation. But the page is built for technical *admiration*, not *action*. It reads like a technical README dressed in CSS, not a landing page. The buyer's emotional arc (pain → cost → relief → proof → easy yes) is weak: there is no human social proof, no quantified outcome ("saved X hours / dollars / tokens"), 4 install steps gate "Get Started," and 11 sections push the only real CTA (npm install) below the GitHub-stars-badge fold.

---

## 5 conversion issues (with quotes)

1. **Hero promise is unverifiable hyperbole.** `"Zero conflicts. Every agent aligned."` and `"5 agents, 1 codebase, 0 merge conflicts"` make absolute claims a skeptic will instantly reject. "Zero" is a marketing tell. The dev reading this thinks: *Prove it.* But there's no number, no logo, no testimonial above the fold — just `<50ms push latency`, which is a feature stat, not an outcome stat. The terminal animation is great theater but tells the same story the headline already told.

2. **Zero human social proof.** The only signal is `Star on GitHub` badge and `216 unit tests across 18 files` (line 2291). No "Used by N teams," no developer quote, no "Built by the author of essaim," no Show HN, no Discord member count, no installation count from npm. For a v0.2.x MIT project, this is the single biggest trust gap. Skeptics need *someone else* vouching.

3. **Pain cards name strangers, not the reader.** `"Tuesday 3pm. Alice's agent ships User.updated_at. Four minutes later, Bob's agent…"` (line 1642) — the cards are vivid but third-person. The reader has to *translate* Alice & Bob into themselves. Worse, the third pain card ends `"Tom shrugs and proceeds. Carol's agent did the same thing 20 minutes ago"` — that's *the agent's* failure narrative; the developer-reader experiences no direct cost (lost weekend, broken deploy, manager Slack).

4. **CTA fragmentation dilutes the funnel.** Hero has 3 CTAs (`Get Started`, `See it live`, `Star on GitHub`) — none labeled with the actual action (`npm install`). Then `Install in one command` (line 2048), `Star on GitHub` again at line 2232, plus `Open an issue`. Five CTAs across 4 sections, and "Get Started" is anchor-link to a 4-step `install` section — that's friction, not conversion. The single highest-intent action (`npm install -g mcp-coordinator`) appears 3 times but is never the primary hero CTA.

5. **"Get Started" is 4 steps, not 1.** Lines 2181–2204: install → init → server start --daemon → doctor && dashboard. Each step has prose explaining flags. The headline at line 2176 brags `"ready in under a minute"` but the section visually communicates *four things to learn*. Compare to Tailscale, Vercel, Resend — they show **one** copyable command above the fold. The 4-card grid screams "this is complex."

**Bonus issue: 11 sections is a scroll grave on mobile.** Hero → pain → solution → mechanism → templates → compare → tech → start → results → faq → roadmap. Templates (4 cards × 4 layer-bars each) and Tech (3 deploy modes × ASCII diagrams) are pure documentation, not conversion content. A mobile bouncer who scrolls 5 seconds sees: hero terminal → pain cards. They never reach proof.

---

## 3 high-leverage rewrites

### Rewrite 1 — Hero (replace lines 1600–1607)

> **H1:** Stop your parallel Claude agents from overwriting each other.
> **Subtitle:** An MCP server that detects file conflicts *before* agents write code. One npm install. No sidecar.
> **Single primary CTA:** `npm i -g mcp-coordinator` (one-click copy) + secondary `See 38-second demo →`

Why: replaces "zero" hyperbole with a verb the reader feels (*overwriting*), names the deliverable (no sidecar = no DevOps), collapses 3 CTAs to 1 + 1.

### Rewrite 2 — Add a proof strip immediately under hero

A horizontal band: *"Built by the author of [essaim] · 216 tests · 26 MCP tools · used in production by [team]"* + 1 developer quote + npm-weekly-installs counter (live shield). Even one quote moves the needle. If no users yet, swap in: *"Read what changed in v0.2 → CHANGELOG."*

### Rewrite 3 — Collapse install to ONE command above the fold of the install section

Hero's install section becomes a single hero command in a giant code-block:

```
npx mcp-coordinator init && mcp-coordinator server start
```

Then a *details/summary* expandable for "What this does" (the current 4 cards become disclosure content). The user sees `1 command, ready in 60s`, not `4 steps to learn`.

---

DONE — `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\06-marketing.md`
