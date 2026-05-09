# FAQ — lead notes

**Section**: §10 (NEW) — `#faq`
**Owner**: agent-faq-lead
**Layer**: 2

---

## Rationale for FAQ ordering

The 10 Q/A are ordered by **conversion impact**, not by category. Each cluster pre-empts a different objection class:

| # | Question | Why this position |
|---|----------|-------------------|
| 1 | Does this replace git worktrees? | **First** because this is the #1 objection from technical evaluators (Tara/Alex). The answer must precede deployment questions or they will leave thinking "we already have worktrees". |
| 2 | Is it production-ready? | The trust-gap question. If we lose them on credibility, nothing below matters. Citing 216 tests + MIT + Pino + `doctor` answers Tara's "production-ready or hobby?" objection from synthesis §14.3. |
| 3 | What does it cost? | Removes the budget objection cheaply. MIT + self-hosted means no procurement loop. Surfaced early because cost gates further reading for decision-makers. |
| 4 | Which MCP clients work? | Compatibility question. Answering with concrete client names (Claude Code, Cursor, Cline, Aider) signals "we are agnostic" and converts visitors who arrived via a non-Claude-Code search. |
| 5 | Can multiple repos share one coordinator? | The team-scaling question for Tara. Honest answer (yes via shared deployment, cross-repo first-class on roadmap) avoids over-promising. |
| 6 | Is auth/JWT required? | Reduces perceived setup friction for Sam (solo dev) before he reads the team-mode docs. |
| 7 | How is this different from Aider/Cline's own coordination? | Pre-empts the "we already have X built-in" reflex. The differentiator: cross-session shared state. |
| 8 | Yet another tool to maintain? | The maintenance-fatigue objection from synthesis §14.1. Answered with concrete surface area (one npm package, embedded broker + SQLite + dashboard, symmetric uninstall). |
| 9 | What if the coordinator goes down? | The reliability question from synthesis §14.5. "Fail open" is the load-bearing phrase here. Placed late because the visitor is now committed enough to ask resilience questions. |
| 10 | Will my agent lose context between turns? | Last because it is the most technical and the answer ties directly to the `mechanism` section's MQTT push narrative. Closes the loop before the visitor scrolls to roadmap. |

**Conversion logic**: questions 1-4 are "should I keep reading?" filters. Questions 5-7 are "how does it fit?" sizing questions. Questions 8-10 are "will it last?" durability questions. The reader walks down the funnel.

---

## i18n keys

### New keys (12 total)

| Key | EN value |
|-----|----------|
| `faq.title` | `FAQ` |
| `faq.subtitle` | `Quick answers to common questions about coordination, deployment, and integration.` |
| `faq.q1` | `Does this replace git worktrees?` |
| `faq.a1` | `No. Worktrees solve filesystem isolation; mcp-coordinator solves intent coordination. Use both.` |
| `faq.q2` | `Is it production-ready?` |
| `faq.a2` | `216 unit tests across 4 conflict scenarios, MIT-licensed, semver, doctor command, structured Pino logs.` |
| `faq.q3` | `What does it cost?` |
| `faq.a3` | `MIT-licensed and free. Self-hosted on your machine, your LAN, or your cloud.` |
| `faq.q4` | `Which MCP clients work?` |
| `faq.a4` | `Any MCP 2024-11-05 client: Claude Code, Cursor, Cline, Aider, custom scripts. HTTP/SSE or stdio.` |
| `faq.q5` | `Can multiple repos share one coordinator?` |
| `faq.a5` | `Yes via shared LAN or self-hosted cloud deployment. Cross-repo first-class support is on the roadmap (v1.0).` |
| `faq.q6` | `Is auth or JWT required?` |
| `faq.a6` | `Local mode: no. Team or cloud mode: opt-in HS256 JWT via jose.` |
| `faq.q7` | `How is this different from Aider or Cline's own coordination?` |
| `faq.a7` | `Aider and Cline are single-process with no cross-session awareness. mcp-coordinator gives them shared state via the MQTT broker.` |
| `faq.q8` | `Yet another tool to maintain?` |
| `faq.a8` | `One npm install -g. Embedded MQTT broker, SQLite, and dashboard ship in the package. Zero sidecar. Symmetric uninstall removes everything cleanly.` |
| `faq.q9` | `What if the coordinator goes down?` |
| `faq.a9` | `Agents fail open and keep working as if uninstalled. Local SQLite resumes on restart, no replay required.` |
| `faq.q10` | `Will my agent lose context between turns?` |
| `faq.a10` | `No. Coordinator events arrive between turns via MQTT push or polling. Your agent reads them and re-enters its turn loop with new context appended.` |

### Old keys deprecated by this section

**None.** FAQ is a new section. Nothing in the current page maps to it.

---

## Anchor IDs

- **Primary**: `#faq` only (declared on `<section id="faq">`)
- **No anchor aliases** required (FAQ is new — no old IDs route here)

The synthesis anchor map (§9) confirms FAQ has no legacy anchors to absorb.

---

## Proposed CSS

To be added to `docs/index.html` style block (~35 lines, fits in the FAQ section under a new `/* FAQ */` comment block):

```css
/* FAQ */
.faq-list {
  display: grid;
  gap: 0.75rem;
  max-width: 760px;
  margin: 0 auto;
}

.faq-item {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0 1.25rem;
  transition: border-color 0.2s;
}

.faq-item:hover { border-color: rgba(74,222,128,0.25); }
.faq-item[open] { border-color: rgba(74,222,128,0.35); }

.faq-q {
  font-size: 0.98rem;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  padding: 1rem 0;
  list-style: none;
  position: relative;
  padding-right: 2rem;
}

.faq-q::-webkit-details-marker { display: none; }

.faq-q::after {
  content: '+';
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  color: var(--accent);
  font-size: 1.25rem;
  font-weight: 400;
  transition: transform 0.2s;
}

.faq-item[open] .faq-q::after { content: '−'; }

.faq-a {
  color: var(--muted);
  font-size: 0.92rem;
  padding: 0 0 1rem 0;
  line-height: 1.65;
}

.faq-a code {
  background: rgba(74,222,128,0.08);
  border: 1px solid rgba(74,222,128,0.2);
  border-radius: 4px;
  padding: 0.05em 0.35em;
  font-size: 0.88em;
  color: var(--accent);
}
```

**Design rationale**:
- Reuses existing CSS variables (`--card-bg`, `--border`, `--accent`, `--text`, `--muted`) — zero new tokens
- Mirrors the `.card` border-radius (10-12px range) and hover treatment for visual consistency
- `+`/`−` toggle uses pure CSS via the `[open]` attribute selector — no JS needed
- `<summary>::-webkit-details-marker` reset hides the default disclosure triangle for clean rendering
- `max-width: 760px` keeps line length readable; centered via `margin: 0 auto`
- Inline `<code>` styling matches the accent palette for tool/command callouts

---

## Checklist (per synthesis §16)

- [x] Section title ≤ 6 words ("FAQ" — 1 word)
- [x] Subtitle ≤ 25 words, single sentence (12 words)
- [x] No paragraph > 3 sentences (longest answer is 3 sentences)
- [x] No sentence > 28 words (longest sentence: 24 words in a10)
- [x] No more than one em-dash per sentence (zero em-dashes used)
- [x] No forbidden phrases used
- [x] Glossary terms used verbatim (`agent`, `mcp-coordinator`, `MCP client`, `MQTT broker`, `between turns`, `self-hosted`, `consultation` not needed here)
- [x] All `data-i18n` attributes present (22 attrs)
- [x] Anchor aliases — N/A (no legacy IDs)
- [x] No content overlapping ownership table (§2): all answers stay in Q/A scope, no install commands as primary content, no architecture diagram
- [x] CTA placement — N/A (synthesis §8 places no CTA at end of FAQ)
- [x] Concrete rewrite (§12) — Q1 answer mirrors the §12 worktrees rewrite intent without duplicating it

---

## Open questions for critic

1. **Is the production-ready answer (Q2) too defensive?** The current answer leans on test count + license + tooling. The synthesis §14.3 starting copy is similar but adds "MIT, semver, `doctor` command, Pino logs per component". Should we add a one-line lead-in like "Stable for solo and team use; v1.0 freezes the public API" (per spec §4.10) before the evidence list? Risk: makes the answer less crisp.

2. **Should we cite specific GitHub issues?** Q5 mentions "roadmap (v1.0)" and Q9 mentions "fail open" — both could link to the actual issue/PR if one exists. Critic should verify whether `swoofer/mcp-coordinator` issues exist for these claims and recommend specific issue links. Risk: dead links if issues are not yet filed.

3. **Q4 lists 4 client names. Is the list current?** README line 30 lists `Claude Code, Cursor, Cline, Aider`. README line 91 says "any MCP-compatible agent (Claude Code, Cursor, Cline, Aider, custom scripts)". Confirmed accurate, but should we add `Continue` or `Zed` if they ship MCP support by 2026-05-09? Critic to verify.

4. **Q6 mentions "HS256 JWT via jose"** — the README line 694 confirms this exactly. Should we link to the synthesis-listed `jose` library inline (already done) or just cite the algorithm? Current draft: linked to GitHub.

5. **Q8 says "Symmetric uninstall removes everything cleanly"** — the README §535 describes `uninstall --mcp-config` and `--claude-md` flags that selectively undo `init` actions. Is "removes everything cleanly" technically accurate, or should we say "Symmetric `uninstall` reverses the `init` actions"? Critic to decide which phrasing better matches reality.

6. **Q10 references "MQTT push or polling"** — the README §95-100 confirms MQTT push and §96 implies polling via `coordinator_status`. Acceptable abstraction or too vague? Spec §4.10 explicitly approves this phrasing.

7. **Should there be an 11th meta-question** like "Where do I report bugs?" → GitHub issues link? **Decision: no**, hard cap is 10 per spec §4.10. The 11th would push onto roadmap visibility which is the next section.

---

## Verification: technical claims map to README

| Claim in answer | Source in repo |
|----------------|----------------|
| 216 unit tests across 4 conflict scenarios | README §776 ("216 passing across 18 files"), §820 ("Vitest — 216 tests, 18 files"), §738 ("All four coordination scenarios") |
| MIT-licensed | README §846, badge §7 |
| semver | Implicit in npm releases; `0.2.x` versioning visible in spec §4 hero eyebrow |
| `doctor` command | README §504, §507, §513 |
| Structured Pino logs | README §673 ("Pino emits JSON per subsystem. Component loggers: ...") |
| MCP 2024-11-05 | Standard MCP protocol version; consistent with README §54's "26 tools" framing |
| Claude Code, Cursor, Cline, Aider | README §30, §91 |
| Any MCP client over HTTP/SSE or stdio | README §91 |
| HS256 JWT via jose | README §694 |
| Embedded Aedes MQTT broker | README §97 |
| Local SQLite | README §810 (`auth.ts`), implied throughout |
| `npm install -g mcp-coordinator` | README §38 |
| Cross-repo first-class on roadmap | Spec §4.10 explicit, synthesis §14 implicit |
| Fail open behavior | Synthesis §14.5 — confirms behavior in spec |
| Aider/Cline single-process | Synthesis §14 audience-analyst content |

All claims verifiable. None overreach beyond what README + spec already commit to.

---

## Revision diff

Applied all 6 critic issues to produce `final.html`. Each change mirrored in the FAQPage JSON-LD `text` strings; HTML accordion and JSON-LD remain in lockstep (10 Q/A intact).

### A2 — added spec §4.10 lead-in

- **Before**: `216 unit tests across 4 conflict scenarios, MIT-licensed, semver, <code>doctor</code> command, structured Pino logs.`
- **After**: `Stable for solo and team use; v1.0 freezes the public API. 216 unit tests across 4 conflict scenarios, MIT-licensed, <code>doctor</code> command, structured Pino logs.`
- **Why**: critic Issue 1. The question "Is it production-ready?" needed a stance before the evidence list. Spec §4.10 supplies it. Dropped "semver" to keep the answer crisp after the lead-in (still ≤45 words).

### A6 — reframed to auth axis

- **Before**: `Local mode: no. Team or cloud mode: opt-in HS256 JWT via <a href="https://github.com/panva/jose">jose</a>.`
- **After**: `Not by default. Opt-in HS256 JWT via <a href="https://github.com/panva/jose">jose</a> for shared or internet-facing deployments.`
- **Why**: critic Issue 5. README uses LAN-host / internet-facing language, never "Local mode" / "Team mode" as named modes. New copy matches README §332 ("internet-facing or multi-tenant deployments") and the auth axis described in §692-694.

### A7 — dropped "single-process" claim

- **Before**: `Aider and Cline are single-process with no cross-session awareness. mcp-coordinator gives them shared state via the MQTT broker.`
- **After**: `Aider and Cline have no cross-session awareness. mcp-coordinator gives them shared state via the MQTT broker.`
- **Why**: critic Issue 4. README says agents "work in isolation" but never asserts "single-process" about Aider or Cline specifically. Removed the unverifiable architectural claim; kept the verifiable cross-session claim.

### A8 — accurate uninstall surface

- **Before**: `Symmetric <code>uninstall</code> removes everything cleanly.`
- **After**: `Symmetric <code>uninstall</code> reverses the <code>init</code> actions; <code>--purge</code> wipes the data dir.`
- **Why**: critic Issue 2. README §523-535 confirms `--mcp-config` and `--claude-md` are surgical (delimited block only); full wipe requires `--purge`. New copy distinguishes the two surfaces honestly.

### A9 — removed unverifiable "no replay required"

- **Before**: `Agents fail open and keep working as if uninstalled. Local SQLite resumes on restart, no replay required.`
- **After**: `Agents fail open and keep working as if uninstalled. Local SQLite resumes on restart.`
- **Why**: critic Issue 3. README never mentions replay (presence or absence). Spec §14.5 commits only to "fail open + restart resumes". Dropped the unsupported clause.

### Issue 6 — no GitHub issue links added

- **Decision**: did NOT add issue links to Q5 ("roadmap (v1.0)") or Q9 ("fail open").
- **Why**: critic Issue 6 confirmed dead-link risk outweighs SEO gain. Closed the open question from lead-notes §"Open questions for critic" #2.

### Untouched per critic's "DO NOT TOUCH"

- Q1, Q3, Q4, Q5, Q10 wording — fully verified, kept verbatim.
- FAQ ordering (1-10) — conversion-funnel rationale preserved.
- `<details>/<summary>` native pattern, inline `<code>` styling, no new CSS variables.
- No anchor aliases (FAQ has no legacy IDs per spec §4.10).
- JSON-LD structure: only `text` strings updated for Q2, Q6, Q7, Q8, Q9. Keys and nesting unchanged.

### Verification

- 10 Q/A in HTML, 10 Q/A in JSON-LD `mainEntity[]`. Match.
- All 22 `data-i18n` attributes preserved.
- All revised answers ≤ 45 words (longest: A8 at 27 words; A2 at 26 words after lead-in).
- Glossary terms (`mcp-coordinator`, `MCP client`, `MQTT broker`, `between turns`, `self-hosted`) unchanged.
- No em-dashes added; no forbidden phrases introduced.

Final output: `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\sections\faq\final.html`.
