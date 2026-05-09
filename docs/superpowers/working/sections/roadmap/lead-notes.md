# Roadmap (§11) — Lead notes

## Rationale for date claims

| Item | Date claim | Evidence |
|------|------------|----------|
| v0.1 — Server extraction | "Shipped May 2026" | Tag `v0.1.0` created 2026-05-03 (`git log --tags --simplify-by-decoration`). Release commit `e8e12c4 docs: full v0.1.0 README` (2026-05-03). |
| v0.2 — Standalone autonomy | "Shipped May 2026" | Tag `v0.2.0` created 2026-05-05. Release-please commits `f3fcf48`, `a9ed1e7` (chore(main): release 0.2.0). v0.2.1 also May 2026 (commit `f44d59d`). |
| v0.3 — Semantic conflict detection | "Target Q3 2026" | **No milestone exists on GitHub** (`gh api repos/swoofer/mcp-coordinator/milestones` returns `[]`). ETA inferred from a ~3-month cadence after v0.2 (May 2026 → Aug-Sep 2026). Flagging for critic — see open question 1. |
| v1.0 — Stable API + cross-repo | "Date TBD" | No milestone, no concrete commits. Honest "Date TBD" used. |
| Server-gated push | "Date TBD · upstream-gated" | Depends on Anthropic shipping the `tengu_harbor` channel. Not under project control. |

## Subtitle change

- Old: "What's shipped, what's next, what's after that."
- New: "Shipped, in flight, and what comes after." (8 words; tighter, same meaning, removes the contraction stack)
- New `roadmap.subtitle` value replaces old (single-key change, no rename).

## i18n keys

### Preserved (unchanged values, kept for backwards-compat with translations)
- `roadmap.title`
- `roadmap.badge.done`, `roadmap.badge.planned`, `roadmap.badge.future`, `roadmap.badge.progress` (unused but kept)
- `roadmap.v01.title`, `roadmap.v01.desc`
- `roadmap.v02.title`, `roadmap.v02.desc` (note: `<code>` style attributes simplified — see "CSS note" below; visible text and key unchanged)
- `roadmap.v03.title`, `roadmap.v03.desc`
- `roadmap.v10.title`, `roadmap.v10.desc`
- `roadmap.harbor.title`, `roadmap.harbor.desc`

### Modified value (key kept)
- `roadmap.subtitle` — new English string per above

### Added (new keys, English first; placeholder TODO for fr/es/de/zh/ja)
- `roadmap.v01.date` — "Shipped May 2026"
- `roadmap.v01.link` — "v0.1.0 release"
- `roadmap.v02.date` — "Shipped May 2026"
- `roadmap.v02.link` — "v0.2.0 release"
- `roadmap.v03.date` — "Target Q3 2026"
- `roadmap.v03.link` — "Track on GitHub"
- `roadmap.v10.date` — "Date TBD"
- `roadmap.v10.link` — "Track on GitHub"
- `roadmap.harbor.date` — "Date TBD · upstream-gated"
- `roadmap.harbor.link` — "Track on GitHub"

i18n-migrator owns the parity migration into fr/es/de/zh/ja.

### Dropped
- None.

## Anchor IDs

- Primary `#roadmap` only (per synthesis §9, this is one of the three anchors that stays primary).
- **No anchor-alias `<span>` needed** — `#roadmap` was the original ID and remains the host.

## CSS note

Removed the per-element inline styles (`style="color:var(--accent);font-size:0.85em;"`) on `<code>` tags inside `roadmap.v02.desc` and `roadmap.harbor.desc`. The visible token text is identical and the visual-designer agent should add this rule to the SECTIONS block:

```css
.timeline-item p code {
  color: var(--accent);
  font-size: 0.85em;
}
.timeline-meta {
  margin-top: 0.5rem;
  font-size: 0.78rem;
  color: var(--muted);
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.timeline-meta a {
  color: var(--muted);
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 3px;
}
.timeline-meta a:hover { color: var(--accent); }
```

If visual-designer rejects extracting the code style, restore the inline `style=` attributes (no semantic change).

## Checklist (synthesis §16)

- [x] Section title ≤ 6 words ("Roadmap" — 1 word)
- [x] Subtitle ≤ 25 words, single sentence ("Shipped, in flight, and what comes after." — 8 words)
- [x] No paragraph > 3 sentences
- [x] No sentence > 28 words
- [x] No more than one em-dash per sentence (existing em-dashes in titles are inherited; the harbor `desc` was previously one sentence with two em-dashes — split into two sentences)
- [x] No forbidden phrases used
- [x] Glossary terms used verbatim ("agent", "MQTT broker", "mcp-coordinator", "MCP client")
- [x] All `data-i18n` attributes present (every visible string has one)
- [x] Anchor aliases — N/A (primary anchor)
- [x] No content overlap with other sections (roadmap-only ownership per synthesis §2)
- [x] CTA placement — N/A (synthesis §8 places CTAs in hero / mechanism / compare / start, not roadmap)
- [x] 5 timeline items (no 6th added)
- [x] Visible word count: ~190 words (under 220 cap)

## Open questions for critic

1. **"Target Q3 2026" for v0.3 — is this OK without a milestone?** I claimed it because (a) v0.2 shipped May 2026 and a ~3-month cadence is consistent with the May 3 → May 5 v0.1→v0.2 spike followed by a feature-dev window; (b) "Q3" is a 3-month bucket that absorbs slippage; (c) the alternative "Date TBD" understates project momentum. If the critic prefers "Date TBD" everywhere unplanned, I'll revert v0.3 to "Date TBD". **Recommend keeping "Target Q3 2026" with critic sign-off.**

2. **GitHub link strategy.** No milestones exist. I used `issues?q=is:issue+label:v0.3` and `label:v1.0` filters — these will currently return empty results because no issues carry those labels. Two alternatives:
   - (a) Link to the bare repo URL `https://github.com/swoofer/mcp-coordinator` (less informative).
   - (b) Drop the link entirely for `Planned`/`Future` items.
   - (c) **My pick**: keep the filtered URL — it's a forward-compatible promise; the moment swoofer creates an issue with `v0.3` or `v1.0` label, the link starts working without an HTML edit.
   Critic to confirm.

3. **`tengu_harbor` link.** Linked to `issues?q=is:issue+tengu_harbor` (text search, no label dependency). Currently returns nothing. Same forward-compat reasoning as #2. Acceptable?

4. **Should the "Shipped" badge include a checkmark icon?** Currently styled by a colored dot only. If visual-designer wants a small SVG checkmark inside `.badge-done`, that's a styling pass — flagged as a non-blocker.

5. **`<a href>` on releases.** I linked to `releases/tag/v0.1.0` and `releases/tag/v0.2.0` directly. These pages exist (verified via `git tag --sort=-creatordate`). Tech-accuracy can confirm by hitting the URLs.

## Revision diff

Applied critic feedback to produce `final.html`. Summary of deltas vs `lead.html`:

### Issue 1 — v0.3 link text (Issue 1 in critic.md)
- Before: `>Track on GitHub</a>` (v0.3 anchor)
- After:  `>Follow on GitHub</a>`
- Rationale: filtered query returns empty list today; "Follow" doesn't overpromise activity while preserving forward-compat (link auto-lights-up the moment swoofer labels an issue).

### Issue 2 — v1.0 link text (Issue 2 in critic.md)
- Before: `>Track on GitHub</a>` (v1.0 anchor)
- After:  `>Follow on GitHub</a>`
- Rationale: same as Issue 1.

### Issue 3 — tengu_harbor link text (Issue 3 in critic.md)
- Before: `>Track on GitHub</a>` (harbor anchor)
- After:  `>Follow on GitHub</a>`
- Rationale: same as Issue 1; text-search query is currently empty.

### Issue 4 — v0.2 description sentence split (Issue 4 in critic.md)
- Before: `…coordinate via polling out of the box; essaim's agent-loop adds push.`
- After:  `…coordinate via polling out of the box. essaim's agent-loop adds push.`
- Rationale: original second sentence sat at the §16 28-word ceiling. Replaced semicolon with a period to split into two shorter sentences, eliminating brittleness against future copy edits.

### i18n key value updates (downstream of Issues 1-3)

The English values for three i18n keys change (the keys themselves are preserved):
- `roadmap.v03.link`   — was `"Track on GitHub"`, now `"Follow on GitHub"`
- `roadmap.v10.link`   — was `"Track on GitHub"`, now `"Follow on GitHub"`
- `roadmap.harbor.link` — was `"Track on GitHub"`, now `"Follow on GitHub"`

i18n-migrator: please re-propagate these three keys into fr/es/de/zh/ja.

### Confirmed-OK (no change)

- **Q3 2026 ETA on v0.3** — kept per critic verdict (spec §4.11 authority).
- **Conservative-mode rejection** — dates kept as in `lead.html` ("Shipped May 2026", "Target Q3 2026", "Date TBD", "Date TBD · upstream-gated").
- **Issue 5** (harbor em-dash count) — verified clean, no edit.
- **Issue 6** (release-link aria-label redundancy) — acceptable, no edit.
- **Issue 7** (`Q3 2026` data-i18n semantics) — handled via `roadmap.v03.date` key, no edit.

### Structural invariants verified post-revision

- 5 timeline items (count unchanged)
- `.timeline-item` / `.timeline-dot` / `.timeline-badge` / `.timeline-meta` classes preserved
- `dot-done` / `dot-planned` / `dot-future` / `badge-done` / `badge-planned` / `badge-future` modifiers preserved
- Primary `#roadmap` anchor preserved (no alias span)
- `<code>tengu_harbor</code>` token wrapping preserved
- All `data-i18n` attributes present on visible strings
- Release-tag URLs unchanged
