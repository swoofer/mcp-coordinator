# Roadmap (§11) — Critic review

## Verdict on lead's open questions

1. **"Target Q3 2026" for v0.3** — DEFENSIBLE. Spec §4.11 explicitly authorizes "v0.3 ETA Q3 2026" as the example. A 3-month bucket is appropriately conservative; reverting to "Date TBD" would contradict the spec. Keep.
2. **Label-filtered URLs (v0.3, v1.0)** — ACCEPTABLE but not pristine. They render an empty issues list today, which is mildly unprofessional. The forward-compat argument is sound (auto-light-up the moment swoofer labels an issue). Keep, but soften link text from "Track on GitHub" to "Follow on GitHub" for the empty-state cases (less misleading promise of activity).
3. **`tengu_harbor` text-search link** — ACCEPTABLE. Text search is the only label-free option; same forward-compat logic.

## Verification (synthesis §16)

- [x] 5 timeline items, no 6th
- [x] Re-uses `.timeline-item`, `.timeline-dot`, `.timeline-badge`, `.timeline-meta` (no new structural classes)
- [x] Subtitle 8 words ("Shipped, in flight, and what comes after.")
- [x] No forbidden phrases
- [x] Glossary terms preserved (`mcp-coordinator`, `MCP client`, `MQTT broker`, `essaim`, `agent`)
- [x] No em-dash overload (titles inherit existing em-dashes)

## Issues to fix

### Issue 1 — "Track on GitHub" overpromises for empty filtered queries

The link text implies activity exists. Soften for v0.3, v1.0, and tengu_harbor where filtered results are empty today.

SEARCH:
```
data-i18n="roadmap.v03.link" aria-label="v0.3 issues on GitHub">Track on GitHub</a>
```
REPLACE:
```
data-i18n="roadmap.v03.link" aria-label="v0.3 issues on GitHub">Follow on GitHub</a>
```

### Issue 2 — Same softening for v1.0

SEARCH:
```
data-i18n="roadmap.v10.link" aria-label="v1.0 issues on GitHub">Track on GitHub</a>
```
REPLACE:
```
data-i18n="roadmap.v10.link" aria-label="v1.0 issues on GitHub">Follow on GitHub</a>
```

### Issue 3 — Same softening for tengu_harbor

SEARCH:
```
data-i18n="roadmap.harbor.link" aria-label="tengu_harbor issues on GitHub">Track on GitHub</a>
```
REPLACE:
```
data-i18n="roadmap.harbor.link" aria-label="tengu_harbor issues on GitHub">Follow on GitHub</a>
```

(Update the three `roadmap.*.link` i18n values from "Track on GitHub" to "Follow on GitHub" in lead-notes.md.)

### Issue 4 — v0.2 description has 47 words in one sentence cluster, brushing the §16 28-word ceiling

The second sentence (after "uninstall.") runs 28 words exactly counting the em-dash clause. It's at the ceiling. Acceptable but brittle. Split for safety.

SEARCH:
```
Vanilla MCP clients (Claude Code, Cursor, Cline) coordinate via polling out of the box; essaim's agent-loop adds push.
```
REPLACE:
```
Vanilla MCP clients (Claude Code, Cursor, Cline) coordinate via polling out of the box. essaim's agent-loop adds push.
```

### Issue 5 — Harbor description uses two em-dashes across two sentences

Synthesis §3 limits each sentence to one em-dash. The current text has none in the visible prose (em-dashes are in titles). VERIFIED CLEAN. No change needed — flagging as confirmed-OK to prevent regression.

### Issue 6 — `aria-label` on v0.1 / v0.2 release links is redundant with link text

Link text "v0.1.0 release" already announces the destination. `aria-label="v0.1.0 release on GitHub"` is mildly redundant but not harmful. Acceptable; no change required.

### Issue 7 — Date span lacks explicit `data-i18n` semantics for "Q3 2026"

The string "Target Q3 2026" mixes a label ("Target") with a date ("Q3 2026"). Translators will have to render both. Already handled via `roadmap.v03.date` key. Confirmed-OK.

## DO NOT TOUCH

- The 5-item count (synthesis §16, spec §4.11)
- The `.timeline-item` / `.timeline-dot` / `.timeline-badge` / `.timeline-meta` class structure
- The `dot-done` / `dot-planned` / `dot-future` / `badge-done` / `badge-planned` / `badge-future` modifier classes
- Section ID `#roadmap` (primary anchor per synthesis §9; no anchor-alias span)
- Glossary terms `mcp-coordinator`, `MCP client`, `MQTT broker`, `essaim` (synthesis §3)
- The `<code>tengu_harbor</code>` token wrapping (it's a real upstream identifier)
- Release tag URLs (verified by lead via `git tag --sort=-creatordate`)
- The h2 "Roadmap" (1 word, well under §4 budget)
- All existing `data-i18n` keys (i18n-migrator owns parity)
- The "Date TBD · upstream-gated" qualifier on harbor (it's the honest signal)
