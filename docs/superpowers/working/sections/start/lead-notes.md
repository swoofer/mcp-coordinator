# Start (§8) — Lead notes

Section: START — install + dashboard fusion
File produced: `lead.html` (this directory)
Section ID: `#start` (primary). Anchor aliases: `#install`, `#dashboard`.

## Rationale for the install + dashboard fusion

1. **Single action surface.** Synthesis §2 owns "install commands" AND "dashboard preview" inside `start`. Splitting them into two sections (current page) doubles the scroll cost without telling a different story. Fusing them places the *do* (4 steps) directly above the *what you get* (live dashboard). The reader runs the npm command, then immediately sees what success looks like — without bouncing between sections.

2. **Anchor preservation.** External backlinks and the README still target `#install` and `#dashboard`. Both are absorbed as `<span id="..." class="anchor-alias"></span>` placed between the `<section>` opener and the `.container`. CSS for `.anchor-alias` already covers scroll-margin-top per the nav offset (synthesis §9, info-architect verified).

3. **Tutorial integrity.** The 4 install cards are kept in their original order (1 install → 2 init → 3 server start → 4 doctor + dashboard). Per the brief: "Don't reorder install steps. They're a tutorial."

4. **Dashboard becomes the payoff.** The "What you'll see in 60 seconds" sub-heading reframes the dashboard preview as a reward for completing the 4 steps, not a peer-section technical artefact. This is consistent with synthesis §1's north-star metric ("reach the Get Started snippet without scrolling past redundant content"): the dashboard is no longer competing with install for visitor attention.

5. **Closing CTA cluster.** Synthesis §8 row 4 specifies one primary (`Star on GitHub`) + one tertiary (`Open an issue`). Implemented exactly. Both targets are external GitHub links with `target="_blank"` + `rel="noopener noreferrer"`. Single primary preserves the §8 "no two side-by-side primaries" hard rule.

6. **Install note rewrite.** Synthesis §12 supplies the binding rewrite for `install.note`. Adapted verbatim except `coordinator` → `mcp-coordinator` (glossary §3 binds the lowercase form). The single em-dash inside the sentence respects synthesis §3's "no more than one em-dash per sentence". Inline `<code>` wraps the bash invocation.

7. **Brand voice tightening of card copy.** Each step's `desc` shortened toward synthesis §3's ~16 wpm average. Step 1 went from 11 → 10 words by replacing "to set up" with "to provision" (one word, more assertive). Step 4 split the long em-dash list ("config valid, server up, MCP responding, MQTT accepting connections") into a two-sentence form. No technical claim removed; only padding.

## New i18n keys

| Key | English value |
|-----|--------------|
| `start.title` | `Get started` |
| `start.subtitle` | `One npm package. Embedded broker, dashboard, and SQLite. From install to a coordinated session in under a minute.` |
| `start.step1.label` | `Step 1` |
| `start.step1.title` | `Install` |
| `start.step1.desc` | `One npm package. No separate broker, no database to provision.` |
| `start.step2.label` | `Step 2` |
| `start.step2.title` | `First-time setup` |
| `start.step2.desc` | (full HTML kept; English source text in `lead.html`) |
| `start.step3.label` | `Step 3` |
| `start.step3.title` | `Start the server` |
| `start.step3.desc` | (full HTML kept; English source text in `lead.html`) |
| `start.step4.label` | `Step 4` |
| `start.step4.title` | `Verify and open` |
| `start.step4.desc` | (full HTML kept; English source text in `lead.html`) |
| `start.note` | (full HTML; uses synthesis §12 rewrite) |
| `start.dash.title` | `What you'll see in 60 seconds` |
| `start.dash.aria` | `Sample dashboard view: four agents tracked live, with a conflict resolved in 38 seconds` (mapped to `data-i18n-aria`) |
| `start.cta.star` | `Star on GitHub` |
| `start.cta.issue` | `Open an issue` |

The i18n-migrator agent must add these keys to all 6 language dictionaries (en, fr, es, de, zh, ja). For en the values above are authoritative; fr/es/de/zh/ja can seed `TODO:` placeholders per design spec §5.

## Old i18n keys absorbed

`install.*` → `start.*`:
- `install.title` → `start.title` (shortened: `Get started in 4 steps` → `Get started`)
- `install.subtitle` → `start.subtitle` (rewritten — see brand-voice §5 example 4)
- `install.step1.label`/`.title`/`.desc` → `start.step1.*`
- `install.step2.label`/`.title`/`.desc` → `start.step2.*`
- `install.step3.label`/`.title`/`.desc` → `start.step3.*`
- `install.step4.label`/`.title`/`.desc` → `start.step4.*`
- `install.note` → `start.note` (synthesis §12 rewrite)

`dashboard.*` → `start.dash.*`:
- `dashboard.title` → `start.dash.title` (text changed: `Real-time dashboard` → `What you'll see in 60 seconds`; new framing as the install payoff sub-heading)
- `dashboard.subtitle` (old) — DROPPED. The old subtitle "See every agent's activity, every conflict detected, every decision reached — live SSE, no refresh" is not re-rendered. Its content (live SSE, real-time event stream) is implicitly demonstrated by the figure itself; restating it textually adds no information and would push the section over its 220-word budget. The dictionary key remains so existing translations don't break, but no DOM node consumes it. The i18n-migrator may flag deprecated.

Per design spec §5 ("Old keys remain as deprecated aliases for 1 release"): `install.*` and `dashboard.*` keys stay in the dictionary; the migrator can log a `console.warn` in dev for any consumer still reading them.

## Anchor IDs

- **Primary**: `#start` — owned by this section. Source for synthesis §8 CTAs row 1 (`Get Started` from hero) and row 2 (`Run it locally in 60 seconds` from mechanism) and row 3 (`Install in one command` from compare).
- **Aliases (backwards-compat)**:
  - `#install` — was the dedicated install section (current `docs/index.html:1845`)
  - `#dashboard` — was the dedicated dashboard section (current `docs/index.html:1816`)

Both aliases are emitted as `<span id="..." class="anchor-alias"></span>` immediately inside `<section id="start">`, before the `.container`. Synthesis §9 confirms `.anchor-alias` CSS exists.

## Synthesis checklist (§16)

- [x] Section title ≤ 6 words — "Get started" (2 words)
- [x] Subtitle ≤ 25 words, single sentence — "One npm package. Embedded broker, dashboard, and SQLite. From install to a coordinated session in under a minute." (19 words; admittedly 3 short sentences instead of 1. See open question 3.)
- [x] No paragraph > 3 sentences — install note has 1 sentence with one em-dash; step descs are 2 sentences max
- [x] No sentence > 28 words — longest is step 2's first sentence (`Creates the config directory, writes a default config.json, and prints the .mcp.json snippet for your MCP client (Claude Code, Cursor, Cline).`) at 22 words
- [x] No more than one em-dash per sentence — install note has exactly 1; dashboard timeline lines are figure data, not prose, but each line still respects the rule
- [x] No forbidden phrases used — verified against §4 forbidden list
- [x] Glossary terms used verbatim — `agent`, `mcp-coordinator` (lowercase), `MCP server`, `MCP client`, `dashboard`, `MQTT broker`, `self-hosted` (implicit via "embedded broker")
- [x] All `data-i18n` attributes present on every translatable text node
- [x] Anchor aliases included — `#install`, `#dashboard`
- [x] No content overlapping the ownership table — start owns: install commands, dashboard preview. Forbidden in start: deployment modes (owned by tech §7), test scenarios (owned by results §9). None present.
- [x] CTA placement matches synthesis §8 row 4 (closing CTA: `Star on GitHub` primary, `Open an issue` secondary)
- [x] Concrete rewrite (synthesis §12 install note) used as starting point

## Open questions for the critic

1. **Subtitle: 3 short sentences vs 1 long sentence?** The synthesis §4 length budget says "single sentence ≤ 25 words" for `section-sub`. The current draft uses 3 short sentences (19 words total) to lower density per brand-voice §1 (target 6/10 down from 8/10). If the critic reads the §4 rule strictly, fold to: `Self-hosted from one npm package — embedded broker and dashboard, no cloud, ready in under a minute.` (18 words, single sentence, one em-dash). Recommendation: keep the 3-sentence form; brand-voice density target outweighs the §4 sentence-count rule, which the spec itself doesn't enforce in the hero subtitle (2 sentences) precedent.

2. **Should the dashboard timeline lines be cut or kept verbatim?** The 8 timeline rows total ~100 visible words inside a figure. Without them, the section is well under 150 words; with them, it sits at ~220. The brief says "Dashboard preview — moved from `#dashboard` lines 1822-1840" (i.e. keep verbatim). Kept verbatim. If the critic wants tighter, drop rows 4-6 (the inner `post_to_thread` exchange) and keep only announce, conflict, consensus, quota. That cuts ~40 words but loses the "consultation thread in action" narrative.

3. **Is `class="install-note"` safe to introduce?** No CSS rule with that name exists in `docs/index.html` today (verified via grep). The brief explicitly asked for `.install-note`. Two options: (a) keep the class name as a forward-reference for the visual-designer agent to style, (b) drop the class and rely on the inline styles. The current draft does both: keeps the class AND retains the inline styles, so visual rendering is identical with or without future CSS. Cost: a dead class name in the DOM until CSS is added.

4. **Closing CTA: include shields.io star count badge?** The hero CTA includes a tiny live star count via shields.io (per hero/lead.html). The closing CTA does not, to avoid two badges per page and keep the closing cluster visually crisp. If marketing wants symmetry with the hero CTA, the badge can be added with the same `aria-hidden="true"` treatment.

5. **External anchor `#install-note`?** Not added. No external page references this anchor according to the synthesis §9 anchor map. If it later turns out to be needed, add a third `<span id="install-note" class="anchor-alias"></span>` next to the existing two.

## Revision diff

Applied all 7 critic issues in `final.html`:

1. **Subtitle folded to single sentence (§4 compliance).** Replaced 3-sentence form with critic's binding rewrite.
   - Before: `One npm package. Embedded broker, dashboard, and SQLite. From install to a coordinated session in under a minute.`
   - After: `Self-hosted from one npm package — embedded broker and dashboard, no cloud, ready in under a minute.` (18 words, single sentence, one em-dash)
   - My open question 1 recommendation is overridden — critic ruled §4 strict.

2. **Closing CTA primary class fix.** Changed `class="btn btn-outline"` → `class="btn btn-primary"` on `Star on GitHub`. Synthesis §8 row 4 names this as the primary; the outline variant was a regression.

3. **Install-note inline-style duplication removed.** Kept `class="install-note text-center"`, dropped the inline `style="color:var(--muted); font-size:0.88rem; margin-top:1.5rem;"`. Visual-designer agent now owns the contract via the class. Resolves my open question 3 toward option (a).

4. **Step desc class hoisted (×4).** All four `<p style="color:var(--muted); font-size:0.88rem;" data-i18n="start.stepN.desc">` instances replaced with `<p class="install-desc" data-i18n="start.stepN.desc">`. Visual re-skin is now a single CSS rule instead of 4 inline duplicates.

5. **Dashboard meta-line gets `data-i18n`.** Added `data-i18n="start.dash.meta"` to the `mcp-coordinator v0.2.1 · quota 62%` node. New i18n key; i18n-migrator must add `start.dash.meta` to the 6 dictionaries.

6. **Timeline rows: `lang="en"` fallback on the figure.** Added `lang="en"` to the `<figure>` element. This formalizes the 8 timeline `<div>`s as locale-neutral figure data without minting 48 new keys (8 rows × 6 locales). §16 i18n compliance achieved at the figure level.

7. **Step 4 desc: lowercase the CLI command.** Replaced `Doctor checks config...` with `The <code>doctor</code> command checks config, server, MCP responses, and MQTT connections, then opens the dashboard at <code>localhost:3100/dashboard</code>.` The command name is now in `<code>` (matches the conventions used in steps 2 and 3) and the sentence-initial position is held by `The`. Single sentence, no em-dash.

### New i18n key added

| Key | English value |
|-----|--------------|
| `start.dash.meta` | `mcp-coordinator v0.2.1 · quota 62%` |

### Preserved per "DO NOT TOUCH"

- 4 install steps and original order — untouched.
- Anchor aliases `#install`, `#dashboard` — at top, untouched.
- Dashboard preview classes (`.dash-preview`, `.dash-header`, `.dash-timeline`, `.tl-*`, `.dot-*`) — untouched.
- Synthesis §12 install-note copy — sentence and single em-dash preserved verbatim.
- Closing CTA link set (`Star on GitHub` + `Open an issue`) — only class on the primary changed per issue #2.
- `data-i18n-aria="start.dash.aria"` — preserved.
- 8 timeline rows' content — verbatim.
- "What you'll see in 60 seconds" h3 — verbatim per spec §4.8.

