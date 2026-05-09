# §2 PAIN — critic notes

## Resolution: §16 "no paragraph > 3 sentences" vs §12 verbatim mandate

**§12 wins.** §16's intent (avoid wall-of-text) is preserved: every sentence is ≤11 words; total card body ≤33 words, well under §4's 45-word cap. These are **fragment-rhythm** sentences, not run-on prose. Open question 1 resolved: keep verbatim §12 copy. Update the §16 checklist entry to "satisfied via fragment cadence" so downstream agents do not paraphrase and break §12 fidelity.

---

## Issues

### Issue 1 — Subtitle reads as a comma-splice and softens assertiveness (8/10 target)

Line 7: `Run agents in parallel without shared awareness and three failure modes recur on every project.`

Two independent clauses joined with `and`, no comma. The lead's open question 2 already flagged the alternative.

```
SEARCH:  Run agents in parallel without shared awareness and three failure modes recur on every project.
REPLACE: Parallel agents without shared awareness produce three failure modes that ship to production.
```

15 words, single declarative clause, glossary-clean, more punch.

### Issue 2 — Card 2 `&times;` reads as multiplication, not retry-count

Line 18: `Agent B picks linear (500ms&times;5)`

`×` parses as `500ms × 5 = 2500ms`. Intended meaning is "5 retries at 500ms intervals" — count, not product.

```
SEARCH:  Agent B picks linear (500ms&times;5)
REPLACE: Agent B picks linear (500ms, 5 retries)
```

This is a **deliberate deviation from §12 verbatim** for comprehension. Flag for strategy-lead approval before merge.

### Issue 3 — `<code>` in Card 1 collides with i18n string swap

Line 13: `Alice's agent ships <code>User.updated_at</code>. ... renames <code>User.id</code>.`

The `data-i18n` attribute targets the whole `<p>`. Locale swaps drop the `<code>` tags unless the engine renders HTML in dictionary values. Lead's open question 3 flagged this.

**Resolution: keep `<code>`; require i18n-migrator to store HTML in dictionary values.** Precedent in `docs/index.html` allows this. Amend question 3 to "resolved — store HTML form."

### Issue 4 — Open question 7 (anchor alias order) is over-cautious

Lines 2-3 show `#why` then `#problem`. Synthesis §9 lists them in that order. **Resolved as-written.** Drop the question from lead-notes.

### Issue 5 — Open question 5 (the word "coordination") is a non-issue

Section title `The coordination pain`. Glossary §3 does not list "coordination" as forbidden, and the spec uses it throughout. **Resolved.** Drop the question.

### Issue 6 — Em-dash audit

Section total: **1 em-dash** (Card 2, before "800k tokens in"). Synthesis §3 caps em-dashes at one per sentence. Compliant. No change.

---

## DO NOT TOUCH

- **Card titles** (`Silent regressions`, `Duplicated effort`, `No visibility`) — punchy, parallel, mapped to §2 ownership.
- **Card 1 fragment cadence** (`Tuesday 3pm.` / `Tests pass.` / `Prod breaks at 2am…`) — rhetorical engine. Do not "smooth."
- **Curly quotes in Card 3** (`&ldquo;`/`&rdquo;`) — typographically correct, no HTML-attribute collision.
- **Emoji choices** (💥 / 🔁 / 👀) — comply with §6 (one per card, `aria-hidden`). §6 prefers SVG only for **new** sections.
- **Section title `The coordination pain`** — 3 words, on-arc, glossary-clean.
- **No CTA at section end** — §8 omits `pain` from CTA placements.
- **`data-i18n` key naming** (`pain.*`) — matches §5 migration plan.
- **Anchor aliases inside `<section>` before `<h2>`** — verbatim §9 placement.
- **Concrete actors and timestamps** (Alice, Bob, Tom, Carol; Tuesday 3pm, 2am, 4 min, 20 min) — §12 mandatory specifics. Do not generalize.

---

**Word count**: ~570.

DONE.
