# Strategy Lead Brief — mcp-coordinator landing redesign

**Audience**: 22 section agents (Layer 2) + 6 discipline specialists (Layer 3).
**Status**: Input contract. Treat as binding.

---

## 1. North star metric

**Success = a first-time technical visitor (solo dev or team lead) can, within 90 seconds, (a) state the problem mcp-coordinator solves in one sentence, (b) name at least one of the four coordination patterns, and (c) reach the `Get Started` snippet without scrolling past redundant content.** Operationally: zero topic-duplication between section pairs, narrative arc Hook to Future intact, and the install command visible on the second meaningful scroll.

---

## 2. Top 3 risks of the current page

### Risk A — Triple coverage of the pain narrative
- **Evidence**: `#why` block 1 at lines 1389-1420 ("Multiple agents, one aligned process"), `#why` block 3 highlight at lines 1447-1450 ("Conflicts caught before code is written"), and `#problem` cards at lines 1463-1479 ("Silent regressions / Duplicated effort / No visibility") all describe the same three failure modes. The `<h2>` at line 1383 ("Why MCP Coordinator?") and the `<h2>` at line 1460 ("The coordination problem") are answering the same question.
- **Why it's a problem**: a reader hits the same conceptual wall three times in 100 lines of HTML. Trust drops; bounce risk spikes.
- **Heuristic**: **One concept, one section.** If two sections share a noun cluster (`regression`, `duplicate`, `visibility`), one of them must be reframed into a different layer of the arc (pain vs solution vs mechanism vs proof).

### Risk B — Mechanism described before basics are anchored
- **Evidence**: `#how-it-works` (lines 1483-1522) introduces the 4-step cycle, then `#mqtt` (lines 1524-1629) opens with topic tables and a push-flow ASCII diagram (lines 1614-1627), then `#scoring` (lines 1663-1694) drops a 4-row score grid. All three appear before the user has seen a single install command (`#install` does not begin until line 1844).
- **Why it's a problem**: 360 lines of dense protocol detail (MQTT topics, score thresholds, push delivery) precede any actionable CTA. Marketing conversion path is buried.
- **Heuristic**: **Progressive disclosure.** Steps come first, gauges second, transport details collapsible (`<details>/<summary>`) third. Per the spec section 4.4, MQTT becomes the advanced sub-block of `#mechanism`.

### Risk C — Architecture and Deploy describe the same topology twice
- **Evidence**: `#architecture` (lines 1697-1733) shows an `arch-diagram` with Dev A / Coordinator / Dev B / Aedes / Dashboard, then `#deploy` (lines 1735-1813) re-renders the same actors as three `deploy-diagram` blocks (local at 1749-1763, team at 1772-1785, cloud at 1794-1807). Two ASCII-style boxed diagrams of the same nodes, ~110 lines apart.
- **Why it's a problem**: visitors infer "I missed something" or "this is padding". File size grows; cognitive load doubles.
- **Heuristic**: **One diagram per topology.** Per spec section 4.7, `#tech` shows one canonical architecture diagram + three deployment cards (commands only, no redundant boxes).

---

## 3. Cross-section consistency rules

Every section must comply. Any deviation is grounds for the critic agent to reject the draft.

- **Terminology canon**:
  - Use **agent** (lowercase) for the autonomous unit. Never "AI agent", never "bot".
  - Use **MCP client** for the host process (Claude Code, Cursor, Cline, Aider). Never "vendor", never "tool".
  - Use **agent-loop** (hyphenated) for the wrapping process described in `#architecture`. Never "loop wrapper".
  - Use **coordinator** (lowercase) for the server. Capitalize **mcp-coordinator** only when referring to the package name.
  - Use **thread** (not "consultation thread" except on first use per section).
  - Use **announce** as the verb (not "register intent" or "declare").
- **Code style**:
  - Install command is exactly `npm install -g mcp-coordinator`. Never `npx`. Never bare `npm install`.
  - JSON examples: 2-space indent, double quotes, no trailing commas, keys quoted.
  - Inline shell tokens use `<code>`, never backticks-as-text. Comments inside terminal blocks use `# ` prefix and `t-dim` class.
  - Tool names always in `<code>`: `announce_work`, `coordinator_status`, `register_agent`.
- **Tone register**: **terse-technical**. Sentences <= 22 words. Active voice. No "you can simply" / "just" / "easily". Address the reader as "you" (singular).
- **Emoji policy**: Allowed only inside `<span aria-hidden="true">` decorating card icons (existing pattern, e.g., line 1393, 1465). Never in headings, prose, or CTAs. Never more than one emoji per card. New sections (`#templates`, `#faq`, `#solution`) use SVG or CSS icons, not emoji.
- **Length budget**:
  - Section title `<h2>`: <= 6 words.
  - Section subtitle (`section-sub`): <= 25 words, single sentence.
  - Card body `<p>`: <= 45 words.
  - No paragraph exceeds 3 sentences. No section exceeds 220 visible words excluding code blocks and tables.
  - Every `data-i18n` key from the existing dictionary must be preserved or aliased per spec section 5; never silently drop.

---

## 4. Decision-making framework

When a section pair (lead + critic) faces ambiguity about whether content belongs in their section or elsewhere, apply this 3-step tree without escalating:

1. **Locate on the arc.** Hook -> Pain -> Solution -> Mechanism -> Patterns -> Differentiation -> Tech -> Action -> Proof -> Objections -> Future. Ask: which arc node does this content advance? If the content advances the node your section owns, keep it. If it advances a different node, the content belongs in that node's section, not yours.
2. **Apply the abstraction-ladder test.** Pain = symptom (what hurts). Solution = behavior (what the system does). Mechanism = how (steps, score, transport). Tech = where it runs. If the candidate sentence answers "how does it work internally?" it must not appear in `#pain` or `#solution`. If it answers "what does the user feel?" it must not appear in `#mechanism` or `#tech`.
3. **Apply the duplication veto.** If the same noun phrase already appears in another section's draft (search the merged drafts dir before finalizing), one of the two sections must drop or reframe it. Default: the section earlier in the arc keeps the surface mention; the later section uses a deeper, more specific framing. Tie-breaker: spec section 3 table wins.

If after these three steps ambiguity persists, write the content in the section where the spec's section 4 brief explicitly names it. Do not invent new homes.

---

**Word count: 779.**
