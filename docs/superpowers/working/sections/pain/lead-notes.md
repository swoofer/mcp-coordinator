# §2 PAIN — lead notes

## Rationale for fusion

The synthesis (section 2 ownership table) gives `pain` exclusive ownership of "the pain" — regressions, duplicated work, no visibility. The current page splits this across two sections:

- `#why` (lines 1380-1454): three feature blocks (block1 agent grid, block2 mini-dashboard, block3 conflict catch).
- `#problem` (lines 1457-1481): three abstract pain cards.

Layer 1 strategy declared `#why`/`#problem` redundant (Redundancy A in spec §2). I fused both into a single 3-card pain section.

### What was kept (reframed)

- **Three-card layout** — kept verbatim from `#problem` (`.cards.fade-in` + three `.card` elements). The CSS class names match what already ships in the page, so no new styles required.
- **Card titles** — kept the existing three names (`Silent regressions`, `Duplicated effort`, `No visibility`). They are the right hooks; only the descriptions needed concrete examples.
- **Card emojis** — re-used 💥 (`&#128165;`), 🔁 (`&#128257;`), 👀 (`&#128064;`) from the current `#problem` cards (lines 1465, 1470, 1475).
- **Section heading framing** — `The coordination pain` echoes the spec's section 4.2 brief title and `#problem`'s "The coordination problem" heading, but sharpens "problem" to "pain" to match the arc step (Hook → Pain → Solution).

### What was dropped

- **`why.block1` (Multiple agents, one aligned process) and the 4-card agent grid** (lines 1389-1420) — describes the *system* serving four named agents. That belongs to `solution` (§3), not `pain`. The agent grid is a system-running visual.
- **`why.block2` (See everything, miss nothing) and the mini-dashboard timeline** (lines 1423-1444) — pure dashboard demo. The synthesis ownership table forbids dashboard mention in `pain`. Moved to `solution`.
- **`why.block3` (Conflicts caught before code is written) and the 50ms scorer claim** (lines 1447-1450) — describes the mechanism. Forbidden in `pain` per ownership table. Moved to `solution` and `mechanism`.
- **`problem.subtitle`** ("AI agents accelerate individual work — and create new team-level problems the moment they run in parallel.") — uses "AI agents" (forbidden by glossary; PREFER "agent"). Replaced by a tighter, glossary-clean subtitle.
- **`problem.card1.desc`, `card2.desc`, `card3.desc`** — abstract and passive. Replaced wholesale by the synthesis section 12 mandatory rewrites with concrete actors (Alice/Bob/Tom/Carol), wall-clock times, and specific code identifiers.

### What was reframed

- The section now opens with anchor aliases (`#why`, `#problem`) so external links to either survive. Both former IDs land on the same content.
- Subtitle moves from "AI agents accelerate individual work…" (which praised agents before pivoting) to a direct statement: parallel agents without shared awareness produce three repeating failure modes. Sets up the section's three cards rhetorically.

## New i18n keys

```
pain.title: "The coordination pain"
pain.subtitle: "Run agents in parallel without shared awareness and three failure modes recur on every project."
pain.card1.title: "Silent regressions"
pain.card1.desc: "Tuesday 3pm. Alice's agent ships User.updated_at. Four minutes later, Bob's agent renames User.id. Tests pass. Prod breaks at 2am because the migration order was wrong."
pain.card2.title: "Duplicated effort"
pain.card2.desc: "Two agents both implement retry logic. Agent A picks exponential backoff (250ms→8s). Agent B picks linear (500ms×5). Code review surfaces the divergence — 800k tokens in."
pain.card3.title: "No visibility"
pain.card3.desc: "Tom asks his agent: \"is anyone else working on auth?\" The agent answers: \"I have no way to know.\" Tom shrugs and proceeds. Carol's agent did the same thing 20 minutes ago."
```

Note: card descriptions contain inline HTML (`<code>`, `&rarr;`, `&times;`, `&mdash;`, `&ldquo;`/`&rdquo;`) in `lead.html`. The i18n dictionary entries above represent the visible-text equivalents; the i18n-migrator agent decides whether to store the HTML form or interpolate at render time.

## Deprecated alias keys (absorbed)

The i18n-migrator should keep these as deprecated aliases pointing at their `pain.*` equivalents for one release, per design spec §5:

```
why.title              -> deprecated (subsumed by pain.title; was distinct value, now removed)
why.subtitle           -> deprecated (subsumed by pain.subtitle; was distinct value, now removed)
why.block1.title       -> deprecated (block dropped; content moved to solution)
why.block1.desc        -> deprecated (block dropped; content moved to solution)
why.block1.agent1.role -> deprecated (agent grid moved to solution)
why.block1.agent2.role -> deprecated
why.block1.agent3.role -> deprecated
why.block1.agent4.role -> deprecated
why.block2.title       -> deprecated (block moved to solution)
why.block2.desc        -> deprecated
why.block3.title       -> deprecated (block moved to solution/mechanism)
why.block3.desc        -> deprecated
problem.title          -> alias of pain.title
problem.subtitle       -> deprecated (replaced; old value used "AI agents", banned)
problem.card1.title    -> alias of pain.card1.title (same string)
problem.card1.desc     -> deprecated (replaced by concrete narrative)
problem.card2.title    -> alias of pain.card2.title (same string)
problem.card2.desc     -> deprecated (replaced by concrete narrative)
problem.card3.title    -> alias of pain.card3.title (same string)
problem.card3.desc     -> deprecated (replaced by concrete narrative)
```

Card titles 1/2/3 string values are unchanged across `problem.*` and `pain.*` — the migrator can either point the old key at the new key, or duplicate the value.

## Anchor IDs

- **Primary**: `#pain`
- **Aliases (placed at top of section, before heading)**:
  - `<span id="why" class="anchor-alias"></span>`
  - `<span id="problem" class="anchor-alias"></span>`

CSS already in place per synthesis §9: `.anchor-alias { display:block; height:0; scroll-margin-top: var(--nav-h, 72px); }`.

## Visible word count

Counted manually from rendered prose (excluding HTML tags, code spans counted as their literal text):

| Element | Words |
|---------|-------|
| Title `The coordination pain` | 3 |
| Subtitle | 15 |
| Card 1 title `Silent regressions` | 2 |
| Card 1 desc | 28 |
| Card 2 title `Duplicated effort` | 2 |
| Card 2 desc | 27 |
| Card 3 title `No visibility` | 2 |
| Card 3 desc | 33 |
| **Total** | **112** |

Well under the 220-word section cap.

## Synthesis checklist (§16)

- [x] Section title `The coordination pain` (3 words) — ≤ 6 words
- [x] Subtitle 15 words, single sentence — ≤ 25 words
- [x] No paragraph > 3 sentences (longest card desc has 4 short sentences each ≤ 11 words; this is below the 3-sentence rule's intent because the 3-sentence rule is per *paragraph*; will flag for critic — see open question 1)
- [x] No sentence > 28 words (longest is card 1's "Tuesday 3pm." through "migration order was wrong" — three sentences, longest 11 words)
- [x] No more than one em-dash per sentence (only card 2 has an em-dash, and only one)
- [x] No forbidden phrases used (verified against §3 list)
- [x] Glossary terms used verbatim (`agent`, no "AI agent"/"bot"; "mcp-coordinator" not mentioned, intentional — pain section avoids product naming)
- [x] All `data-i18n` attributes present (title, subtitle, 3 card titles, 3 card descs = 8 keys)
- [x] Anchor aliases included (`#why`, `#problem` at top)
- [x] No content overlapping the ownership table (no mechanism, no dashboard, no scoring, no MQTT)
- [x] CTA placement — N/A (synthesis §8 places no CTA at end of `pain`)
- [x] Concrete rewrite from §12 used verbatim as starting copy (3 card descs match synthesis §12 pain card 1/2/3 verbatim)

## Open questions for critic

1. **Card descriptions exceed the "no paragraph > 3 sentences" rule.** Card 1 has 4 sentences ("Tuesday 3pm." / "Alice's agent ships User.updated_at." / "Four minutes later, Bob's agent renames User.id." / "Tests pass." / "Prod breaks at 2am because the migration order was wrong." — actually 5 short sentences). Card 3 has 4 sentences. The mandatory copy from synthesis §12 is what produces this; we cannot paraphrase. Does the synthesis §16 "no paragraph > 3 sentences" rule yield to §12's "starting copy is verbatim" rule? Recommended interpretation: §12 wins because the sentences are deliberately fragment-style (≤11 words each) for rhythm, and the rule's spirit (avoid wall-of-text) is preserved. Critic to confirm.
2. **Subtitle phrasing.** The synthesis ownership table forbids `pain` from naming the mechanism, so the subtitle cannot say "the coordinator solves this." I phrased it as a setup ("…three failure modes recur on every project") to teleport into the three cards. Alternative: "Parallel agents without shared awareness produce three failure modes that ship to production." (15 words too, slightly more punchy?). Critic to pick.
3. **`User.updated_at` and `User.id` rendered as `<code>` in card 1.** The mandatory copy uses backticks in markdown context but card markup is HTML. I rendered them as `<code>` spans for technical authenticity. Acceptable, or strip to plain text for translatability?
4. **Card 3 uses curly quotes (`&ldquo;`/`&rdquo;`) for the dialog.** Better readability than straight quotes inside HTML attributes. Acceptable?
5. **Section title `The coordination pain` reuses "coordination" from the original `#problem` title `The coordination problem`.** It's also the section concept word in the spec. The brand-voice glossary doesn't list "coordination" as forbidden, but the synthesis §3 doesn't list it as preferred either. Is this a glossary collision risk?
6. **No CTA at the end** — `pain` ends mid-arc; the next scroll lands on `solution`. Confirm no CTA needed (synthesis §8 lists 4 CTA placements, none at end of `pain`).
7. **Should `#why` come before `#problem` in the anchor alias order?** Current order matches the order they appear in the existing index.html (1380 then 1457). Either way works for `:target` matching.

## Revision diff

Final HTML written to `final.html` after critic review. Each of the critic's six issues addressed below.

### Issue 1 — Subtitle comma-splice (RESOLVED, edit applied)

- **Before**: `Run agents in parallel without shared awareness and three failure modes recur on every project.`
- **After**: `Parallel agents without shared awareness produce three failure modes that ship to production.`
- **Rationale**: Critic's recommended replacement. Eliminates the comma-splice (two clauses joined by `and`), 15 words, single declarative clause, glossary-clean, more assertive. Matches lead's open question 2 alternative.
- **i18n key impact**: `pain.subtitle` value updated; deprecation table unchanged.

### Issue 2 — Card 2 `&times;` reads as multiplication (RESOLVED, edit applied)

- **Before**: `Agent B picks linear (500ms&times;5)`
- **After**: `Agent B picks linear (500ms, 5 retries)`
- **Rationale**: `×` parses as `500ms × 5 = 2500ms`; intended meaning is "5 retries at 500ms intervals" — count, not product. Edit clarifies semantics. **Deviation from §12 verbatim**, flagged for strategy-lead approval before merge.
- **i18n key impact**: `pain.card2.desc` value updated.

### Issue 3 — `<code>` collides with i18n string swap (RESOLVED in policy, no edit)

- **Decision**: Keep `<code>User.updated_at</code>` and `<code>User.id</code>` in Card 1.
- **Rationale**: Critic confirmed precedent in `docs/index.html` allows HTML inside dictionary values. i18n-migrator must store the HTML form (not strip tags or interpolate at render time).
- **Action for downstream**: Open question 3 in lead-notes is resolved as "store HTML form." i18n-migrator agent: dictionary entries for `pain.card1.desc` must include the `<code>` tags verbatim.

### Issue 4 — Anchor alias order (RESOLVED as-is, no edit)

- **Decision**: Order `#why` then `#problem` is correct per synthesis §9. Open question 7 is closed.
- **Action**: No code change. Drop question 7 from open-questions tracking.

### Issue 5 — Glossary status of word "coordination" (RESOLVED as-is, no edit)

- **Decision**: `coordination` is not on the §3 forbidden list and is used throughout the spec. Section title `The coordination pain` is glossary-clean. Open question 5 is closed.
- **Action**: No code change. Drop question 5 from open-questions tracking.

### Issue 6 — Em-dash audit (RESOLVED as-is, no edit)

- **Decision**: Section contains exactly one em-dash (Card 2, before "800k tokens in"). Synthesis §3 caps em-dashes at one per sentence. Compliant.
- **Action**: No code change.

---

### Summary of edits applied to `final.html`

1. Subtitle text replaced (Issue 1).
2. Card 2 `(500ms&times;5)` replaced with `(500ms, 5 retries)` (Issue 2).

All other content (anchor aliases, emojis, card titles, fragment cadence, curly quotes, em-dash count, `<code>` tags) preserved verbatim from `lead.html` per "DO NOT TOUCH" list and resolutions above.

### Cross-reference: §16 checklist update

Per critic's resolution at top of `critic.md`, the §16 entry "no paragraph > 3 sentences" is satisfied via fragment cadence (≤11 words/sentence, ≤33 words/card). Downstream agents must not paraphrase to "fix" sentence count — that would break §12 verbatim mandate.

DONE.
