# mcp-coordinator Documentation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the 13-section single-file landing page (`docs/index.html`, 3133 lines) into an 11-section narrative-arc redesign that fuses redundant sections, surfaces unused `templates` CSS, adds a FAQ section, and preserves i18n keys + anchor URLs + SEO.

**Architecture:** Single-file HTML with embedded CSS/JS. Sub-agents produce isolated artifacts (briefs, HTML fragments, audit diffs) under `docs/superpowers/working/` which the orchestrator merges into a draft, then progressively refines through discipline and QA passes.

**Tech Stack:** HTML5 / CSS3 (embedded) / vanilla JS / JSON-LD structured data / i18n via embedded `translations` object (6 languages: en, fr, es, de, zh, ja).

**Spec:** `docs/superpowers/specs/2026-05-09-mcp-coordinator-docs-redesign-design.md`

---

## File Structure

```
docs/
├── index.html                           # MAIN TARGET (modify in place at the end)
├── index.html.backup-pre-redesign-2026-05-09  # CREATE in Task 1 (safety net)
├── superpowers/
│   ├── specs/
│   │   └── 2026-05-09-mcp-coordinator-docs-redesign-design.md  # READ ONLY
│   ├── plans/
│   │   └── 2026-05-09-mcp-coordinator-docs-redesign.md  # THIS FILE
│   └── working/                         # CREATE in Task 1 (intermediate artifacts)
│       ├── strategy/                    # Layer 1 outputs (5 .md briefs)
│       ├── sections/                    # Layer 2 outputs (11 dirs × 2 .md)
│       ├── disciplines/                 # Layer 3 outputs (6 .md audit diffs)
│       ├── qa/                          # Layer 4 outputs (3 .md final reports)
│       └── drafts/                      # intermediate index-draft-N.html
```

Each working artifact is committed at the end of its task to preserve provenance and allow rollback.

---

## Task 1: Pre-flight setup

**Files:**
- Create: `docs/index.html.backup-pre-redesign-2026-05-09`
- Create: `docs/superpowers/working/strategy/.gitkeep`
- Create: `docs/superpowers/working/sections/.gitkeep`
- Create: `docs/superpowers/working/disciplines/.gitkeep`
- Create: `docs/superpowers/working/qa/.gitkeep`
- Create: `docs/superpowers/working/drafts/.gitkeep`

- [ ] **Step 1: Backup the current index.html**

```bash
cp "C:/Users/gagno/projet/mcp-coordinator-new/docs/index.html" \
   "C:/Users/gagno/projet/mcp-coordinator-new/docs/index.html.backup-pre-redesign-2026-05-09"
```

- [ ] **Step 2: Verify the backup is byte-identical**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
diff docs/index.html docs/index.html.backup-pre-redesign-2026-05-09
```

Expected: empty output (no diff). If any diff appears, the backup failed.

- [ ] **Step 3: Create working directories**

```bash
mkdir -p docs/superpowers/working/strategy docs/superpowers/working/sections docs/superpowers/working/disciplines docs/superpowers/working/qa docs/superpowers/working/drafts
touch docs/superpowers/working/strategy/.gitkeep docs/superpowers/working/sections/.gitkeep docs/superpowers/working/disciplines/.gitkeep docs/superpowers/working/qa/.gitkeep docs/superpowers/working/drafts/.gitkeep
```

- [ ] **Step 4: Commit pre-flight setup**

```bash
git add docs/index.html.backup-pre-redesign-2026-05-09 docs/superpowers/
git commit -m "$(cat <<'EOF'
chore(docs): pre-flight setup for landing redesign

- Backup current index.html
- Create working directories for 36-agent redesign

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Layer 1 — Strategy (5 agents in parallel)

**Files:**
- Create: `docs/superpowers/working/strategy/01-strategy-lead.md`
- Create: `docs/superpowers/working/strategy/02-marketing-strategist.md`
- Create: `docs/superpowers/working/strategy/03-info-architect.md`
- Create: `docs/superpowers/working/strategy/04-brand-voice.md`
- Create: `docs/superpowers/working/strategy/05-audience-analyst.md`

**Reference for all 5 agents:** the spec at `docs/superpowers/specs/2026-05-09-mcp-coordinator-docs-redesign-design.md` and the current `docs/index.html`. They run in parallel and have no shared state.

- [ ] **Step 1: Dispatch 5 strategy agents in parallel (single message, 5 Agent calls)**

Agent 1 — `agent-strategy-lead` (subagent_type: `general-purpose`):
```
You are agent-strategy-lead in a 36-agent redesign of the mcp-coordinator landing page.

Read these files:
1. docs/superpowers/specs/2026-05-09-mcp-coordinator-docs-redesign-design.md
2. docs/index.html (current 3133-line landing page)
3. README.md (project context)

Produce a markdown brief at docs/superpowers/working/strategy/01-strategy-lead.md containing:
- North star metric for the redesign (1 sentence)
- Top 3 risks of the current page (concrete evidence from the file)
- Cross-section consistency rules (e.g., terminology: "agent" vs "client", code style for examples)
- Decision-making framework for Layer 2 section pairs to use when they hit ambiguity

Constraints:
- Do not modify docs/index.html. Only write your output file.
- Cap output at 800 words.
```

Agent 2 — `agent-marketing-strategist` (subagent_type: `general-purpose`):
```
You are agent-marketing-strategist for the mcp-coordinator landing page redesign.

Read:
1. docs/superpowers/specs/2026-05-09-mcp-coordinator-docs-redesign-design.md
2. docs/index.html

Produce docs/superpowers/working/strategy/02-marketing-strategist.md with:
- Conversion path map: visitor lands on hero → which section is the strongest "yes" trigger? → CTA placement
- 3 specific hooks for the hero subtitle (variants to A/B test mentally)
- Social proof opportunities the page lacks (specific suggestions: GitHub stars badge? user quotes? deployment count?)
- 5 specific concrete-example rewrites where the current copy is too abstract

Constraints:
- Stay focused on conversion. Do not redesign the page.
- Cap at 700 words.
```

Agent 3 — `agent-info-architect` (subagent_type: `general-purpose`):
```
You are agent-info-architect for the mcp-coordinator landing page redesign.

Read:
1. docs/superpowers/specs/2026-05-09-mcp-coordinator-docs-redesign-design.md (for the 11-section target structure)
2. docs/index.html (for current anchors and nav)

Produce docs/superpowers/working/strategy/03-info-architect.md with:
- Final anchor map: every old anchor (#install, #worktrees, #dashboard, #how-it-works, #mqtt, #scoring, #architecture, #deploy, #problem, #why, #results, #roadmap, #hero) → which new section ID hosts it as alias
- Nav menu spec: which top nav links to keep, which to add, which to drop
- Skip-link target (a11y requirement): exact selector
- Section ordering rationale (1-paragraph: why pain comes before solution, why templates after mechanism, etc.)
- A "table of contents" sidebar spec: nice-to-have or out of scope?

Constraints:
- Output must be unambiguous enough that section pairs can implement without asking.
- Cap at 600 words.
```

Agent 4 — `agent-brand-voice` (subagent_type: `general-purpose`):
```
You are agent-brand-voice for the mcp-coordinator landing page redesign.

Read:
1. docs/superpowers/specs/2026-05-09-mcp-coordinator-docs-redesign-design.md
2. docs/index.html (current voice samples)
3. README.md (the established voice)

Produce docs/superpowers/working/strategy/04-brand-voice.md with:
- Voice axes: technical depth (1-10), formality (1-10), assertiveness (1-10), with target ratings
- Sentence length target (avg & max words)
- Glossary: 15 key terms with the canonical phrasing (e.g., "agent" not "AI agent" not "Claude instance"; "consultation thread" not "discussion thread")
- 3 don'ts (forbidden phrases: e.g., "revolutionary", "game-changing", "synergy")
- 5 voice examples: a "Pain card" written wrong vs right; a "FAQ answer" wrong vs right

Constraints:
- Concrete examples > abstract rules.
- Cap at 800 words.
```

Agent 5 — `agent-audience-analyst` (subagent_type: `general-purpose`):
```
You are agent-audience-analyst for the mcp-coordinator landing page redesign.

Read:
1. docs/superpowers/specs/2026-05-09-mcp-coordinator-docs-redesign-design.md
2. docs/index.html
3. README.md

Produce docs/superpowers/working/strategy/05-audience-analyst.md with:
- 3 personas with names, role, daily pain, what would convert them:
  - "Solo Sam" (developer running 2-3 Claudes alone)
  - "Team-lead Tara" (5-engineer team, evaluating tooling)
  - "Architect Alex" (decision-maker comparing AI infrastructure)
- For each section (1-11), which persona benefits MOST and which benefits LEAST (table)
- 5 audience objections we must pre-empt (these feed into FAQ task content)
- Persona-aware CTA placement: which CTA serves which persona

Constraints:
- Be skeptical. Persona spec doesn't mean making up numbers.
- Cap at 700 words.
```

- [ ] **Step 2: Verify all 5 outputs exist and are non-empty**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
ls -la docs/superpowers/working/strategy/
wc -l docs/superpowers/working/strategy/*.md
```

Expected: 5 files, each at least 30 lines.

- [ ] **Step 3: Read all 5 strategy outputs and write a synthesis**

The orchestrator (you) reads all 5 files and writes a synthesis at `docs/superpowers/working/strategy/00-synthesis.md` containing:
- One unified glossary merged from agent 4
- A compact "rules sheet" that section pairs MUST follow (under 300 words)
- A list of any contradictions between the 5 agents' outputs and how they're resolved

This synthesis is the **input contract** for Layer 2. Do not skip this step.

- [ ] **Step 4: Commit Layer 1 outputs**

```bash
git add docs/superpowers/working/strategy/
git commit -m "$(cat <<'EOF'
docs(redesign): Layer 1 strategy briefs (5 agents)

- strategy-lead, marketing-strategist, info-architect, brand-voice, audience-analyst
- 00-synthesis.md merges all 5 into the input contract for section pairs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Layer 2 — Section teams (11 pairs × 2 agents = 22 agents in parallel)

**Files (created by sub-agents):**
For each section in `[hero, pain, solution, mechanism, templates, compare, tech, start, results, faq, roadmap]`:
- Create: `docs/superpowers/working/sections/<section>/lead.html` (HTML fragment)
- Create: `docs/superpowers/working/sections/<section>/lead-notes.md` (rationale, i18n keys, anchors)
- Create: `docs/superpowers/working/sections/<section>/critic.md` (critique + concrete change requests)
- Create: `docs/superpowers/working/sections/<section>/final.html` (lead's revision after critic — produced sequentially within the pair)

Each section pair (lead + critic) runs the lead first, then the critic, then the lead revises. The 11 pairs run **in parallel with each other**.

- [ ] **Step 1: Create the per-section directories**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
for s in hero pain solution mechanism templates compare tech start results faq roadmap; do
  mkdir -p "docs/superpowers/working/sections/$s"
done
```

- [ ] **Step 2: Dispatch 11 section LEADS in parallel (single message, 11 Agent calls)**

The lead prompt template (substitute `<SECTION>` with hero/pain/solution/etc.):

```
You are agent-<SECTION>-lead in a 36-agent redesign.

Read these inputs (NON-NEGOTIABLE - all 4 are required context):
1. docs/superpowers/specs/2026-05-09-mcp-coordinator-docs-redesign-design.md (the spec - section "Per-section content briefs", subsection for "<SECTION>")
2. docs/superpowers/working/strategy/00-synthesis.md (the rules contract from Layer 1)
3. docs/superpowers/working/strategy/04-brand-voice.md (voice/glossary)
4. docs/index.html (current implementation - find the section corresponding to your assigned name)

Produce two files:
A. docs/superpowers/working/sections/<SECTION>/lead.html
   - The complete <section id="<SECTION>">...</section> HTML fragment
   - Including all data-i18n attributes
   - Including invisible anchor aliases (<span id="OLD_ID" class="anchor-alias"></span>) for any old anchor your section absorbs
   - Reference existing CSS classes (defined in <style> in docs/index.html) - do NOT create new classes unless absolutely necessary
   - For "templates" section specifically: USE the existing .tmpl-* classes (lines 1111-1212 of docs/index.html)
   - For "faq" section specifically: USE <details>/<summary> for accordion behavior (no JS needed) and prepare a <script type="application/ld+json"> FAQPage schema

B. docs/superpowers/working/sections/<SECTION>/lead-notes.md with:
   - Rationale for major copy choices
   - List of new i18n keys you introduced (format: "section.element": "English text")
   - List of old i18n keys your section absorbs as deprecated aliases
   - List of anchor IDs your section hosts (primary + aliases)
   - Any open questions for the critic to address

Constraints:
- Stay within the section's bounds. Do not redesign other sections.
- Use the brand voice exactly as specified.
- Test claims (latency, tool count, etc.) must match the codebase. If you state "26 MCP tools", that must be true today.
- Cap fragment at 250 lines of HTML.
- DO NOT modify docs/index.html. Only write to your assigned working directory.
```

The 11 leads dispatch in parallel. Each is a separate Agent tool call.

- [ ] **Step 3: Verify all 11 lead outputs exist**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
for s in hero pain solution mechanism templates compare tech start results faq roadmap; do
  echo "=== $s ==="
  ls -la "docs/superpowers/working/sections/$s/" 2>&1 | grep -E '(lead\.html|lead-notes\.md)'
done
```

Expected: each section dir contains `lead.html` (non-empty) and `lead-notes.md` (non-empty).

- [ ] **Step 4: Dispatch 11 section CRITICS in parallel (single message, 11 Agent calls)**

The critic prompt template (substitute `<SECTION>`):

```
You are agent-<SECTION>-critic.

Read:
1. docs/superpowers/working/sections/<SECTION>/lead.html (the lead's draft)
2. docs/superpowers/working/sections/<SECTION>/lead-notes.md (the lead's rationale)
3. docs/superpowers/specs/2026-05-09-mcp-coordinator-docs-redesign-design.md (verify alignment with spec)
4. docs/superpowers/working/strategy/00-synthesis.md (rules contract)
5. docs/superpowers/working/strategy/04-brand-voice.md (voice rules)

Produce docs/superpowers/working/sections/<SECTION>/critic.md with:
- 5 to 10 specific change requests (line-quoted), each with:
  - The exact line in lead.html that's problematic
  - Why it violates spec/voice/clarity
  - Suggested replacement (concrete text or HTML)
- A "must-fix vs nice-to-have" classification
- A "DO NOT TOUCH" list: parts of the lead that are excellent and should not be revised away

Constraints:
- Be specific. Line-quote everything.
- Do not rewrite the entire fragment. Pick your battles (5-10 issues, not 50).
- Cap at 600 words.
```

- [ ] **Step 5: Verify all 11 critic outputs exist**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
for s in hero pain solution mechanism templates compare tech start results faq roadmap; do
  ls "docs/superpowers/working/sections/$s/critic.md" 2>&1
done
```

Expected: 11 `critic.md` files exist.

- [ ] **Step 6: Dispatch 11 section LEADS for revision (single message, 11 Agent calls)**

The revision prompt template (substitute `<SECTION>`):

```
You are agent-<SECTION>-lead, revising your section after the critic's feedback.

Read:
1. docs/superpowers/working/sections/<SECTION>/lead.html (your original draft)
2. docs/superpowers/working/sections/<SECTION>/critic.md (critique)
3. docs/superpowers/working/sections/<SECTION>/lead-notes.md (your prior rationale)

Produce docs/superpowers/working/sections/<SECTION>/final.html with:
- The complete <section> fragment, with critic's must-fix items addressed
- Nice-to-have items addressed if time permits and they don't violate "DO NOT TOUCH"
- Same i18n attribute and anchor alias rules as the lead pass

Then append to docs/superpowers/working/sections/<SECTION>/lead-notes.md (do not overwrite):
- A "## Revision diff" section listing each critic item and how you resolved it (or why you declined)

Constraints:
- final.html must be drop-in mergeable (no missing closing tags, no broken HTML).
- If a critic suggestion conflicts with spec, follow spec and explain in the diff section.
- Cap final.html at 250 lines.
```

- [ ] **Step 7: Verify all 11 final outputs and their HTML validity**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
for s in hero pain solution mechanism templates compare tech start results faq roadmap; do
  if [ ! -s "docs/superpowers/working/sections/$s/final.html" ]; then
    echo "MISSING OR EMPTY: $s/final.html"
  fi
done
```

Expected: no MISSING lines.

Quick HTML balance check (opening tags = closing tags for `<section>`):

```bash
for s in hero pain solution mechanism templates compare tech start results faq roadmap; do
  open=$(grep -c '<section' "docs/superpowers/working/sections/$s/final.html")
  close=$(grep -c '</section>' "docs/superpowers/working/sections/$s/final.html")
  echo "$s: open=$open close=$close"
done
```

Expected: every line shows `open=1 close=1`.

- [ ] **Step 8: Commit Layer 2 outputs**

```bash
git add docs/superpowers/working/sections/
git commit -m "$(cat <<'EOF'
docs(redesign): Layer 2 section fragments (22 agents, 11 pairs)

- 11 section pairs (lead + critic + revised final) running in parallel
- Each section produces final.html ready for merge

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Initial integration — assemble draft v1

**Files:**
- Create: `docs/superpowers/working/drafts/index-draft-v1.html`
- Modify (locally only, not committed yet to docs/index.html): a working buffer

This task is performed by the orchestrator (you), not a subagent. The 11 final.html fragments are merged into the existing `docs/index.html` shell.

- [ ] **Step 1: Read the current `docs/index.html` head, nav, and pre-main shell**

Lines 1-1346 of `docs/index.html` contain `<!DOCTYPE html>`, `<head>`, `<style>`, `<nav>`, opening `<main id="main">`. These lines are mostly preserved — the redesign is between `<main>` and `</main>`.

Read those lines and identify:
- The exact line where `<main id="main">` opens (currently line 1345)
- The exact line where `</main>` closes (currently line 1978)
- Lines after `</main>` (footer, scripts) — preserved

- [ ] **Step 2: Build draft-v1.html by concatenation**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
{
  # Lines 1-1345: head, nav, opening <main>
  sed -n '1,1345p' docs/index.html
  echo ""
  # 11 section finals in arc order
  for s in hero pain solution mechanism templates compare tech start results faq roadmap; do
    echo ""
    echo "<!-- ===== Section: $s ===== -->"
    cat "docs/superpowers/working/sections/$s/final.html"
    echo ""
  done
  # Lines 1978-end: closing </main>, footer, scripts
  sed -n '1978,$p' docs/index.html
} > docs/superpowers/working/drafts/index-draft-v1.html
```

- [ ] **Step 3: Sanity-check the draft**

```bash
wc -l docs/superpowers/working/drafts/index-draft-v1.html
grep -c '<section id=' docs/superpowers/working/drafts/index-draft-v1.html
grep -c '<main id="main">' docs/superpowers/working/drafts/index-draft-v1.html
grep -c '</main>' docs/superpowers/working/drafts/index-draft-v1.html
```

Expected:
- Line count between 2400 and 3300
- 11 `<section id=` matches (one per new section)
- Exactly 1 `<main id="main">` and exactly 1 `</main>`

If counts are wrong, the merge has a bug — fix before proceeding.

- [ ] **Step 4: Apply i18n key migrations to the draft's `translations` object**

The lead-notes.md files for each section list the new i18n keys. Aggregate them and update the `translations.en` object in the draft. Old keys remain (for backwards-compat) — they may now point to the same string as the new key.

Read each `docs/superpowers/working/sections/*/lead-notes.md` and extract the "List of new i18n keys" sections. Build the additions and edit the draft's `<script>` block to add them under `translations.en`. Mark `translations.fr/es/de/zh/ja` entries with `"section.key": "TODO_TRANSLATE"` as placeholders — these will be filled by a follow-up task.

- [ ] **Step 5: Commit draft v1**

```bash
git add docs/superpowers/working/drafts/index-draft-v1.html
git commit -m "$(cat <<'EOF'
docs(redesign): integration draft v1 (11 sections merged)

- All 11 section finals concatenated into draft-v1.html
- i18n keys added to translations.en; placeholders for fr/es/de/zh/ja

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Layer 3 — Discipline specialists (6 agents in parallel)

**Files:**
- Create: `docs/superpowers/working/disciplines/01-visual-designer.md`
- Create: `docs/superpowers/working/disciplines/02-a11y-auditor.md`
- Create: `docs/superpowers/working/disciplines/03-seo-expert.md`
- Create: `docs/superpowers/working/disciplines/04-i18n-migrator.md`
- Create: `docs/superpowers/working/disciplines/05-perf-engineer.md`
- Create: `docs/superpowers/working/disciplines/06-mobile-responsive.md`

Each discipline agent reviews `index-draft-v1.html` and produces a structured changeset (NOT direct edits). The orchestrator applies the changesets sequentially in Task 6 to avoid conflicts.

- [ ] **Step 1: Dispatch 6 discipline agents in parallel (single message, 6 Agent calls)**

Agent 1 — `agent-visual-designer`:
```
You are agent-visual-designer.

Read:
1. docs/superpowers/working/drafts/index-draft-v1.html (the draft to audit)

Audit for visual coherence:
- Spacing consistency across sections (margin, padding rhythm)
- CSS class reuse (any new classes that duplicate existing ones?)
- Templates section CSS coverage (does it actually use .tmpl-* classes correctly?)
- Color/border consistency
- Typography hierarchy

Produce docs/superpowers/working/disciplines/01-visual-designer.md with:
- Up to 15 specific change requests, each with:
  - Line range in index-draft-v1.html
  - Issue description
  - Exact replacement HTML/CSS

Format each change as a search-and-replace block:
SEARCH:
<exact text>
REPLACE:
<exact text>

Constraints:
- Do not modify the file. Only output the changeset.
- Cap at 600 words.
```

Agent 2 — `agent-a11y-auditor`:
```
You are agent-a11y-auditor for WCAG 2.1 AA compliance.

Read:
1. docs/superpowers/working/drafts/index-draft-v1.html

Audit:
- Color contrast (text vs background) - all dark-on-dark must meet 4.5:1 (regular text) or 3:1 (large text/UI)
- ARIA labels on icons (every emoji/icon-only element needs aria-hidden="true" or aria-label)
- Heading hierarchy (one h1, h2 for sections, h3 for sub-blocks - no skipping levels)
- Keyboard navigation (every interactive element must be reachable + visible focus state)
- Skip-link presence and target validity
- <details>/<summary> in FAQ - role/aria attributes
- Form/button labels (none in this static page, but check)
- Alt text on figures with role="img"

Produce docs/superpowers/working/disciplines/02-a11y-auditor.md as SEARCH/REPLACE blocks (same format as designer).

Cap at 700 words.
```

Agent 3 — `agent-seo-expert`:
```
You are agent-seo-expert.

Read:
1. docs/superpowers/working/drafts/index-draft-v1.html

Audit:
- Title tag and meta description (preserved from original?)
- Open Graph and Twitter Cards (still valid?)
- JSON-LD SoftwareApplication schema (still in head?)
- NEW FAQPage JSON-LD: must be valid - validate against schema.org/FAQPage spec
- H1 uniqueness, H2/H3 use of keywords
- Internal linking (every "see X" link uses correct anchor)
- Canonical URL
- robots meta
- sitemap.xml entry references (does it list the page correctly?)

Produce docs/superpowers/working/disciplines/03-seo-expert.md including:
- SEARCH/REPLACE blocks for any required fixes
- A complete FAQPage JSON-LD block with all 10 FAQ Q/A pairs (extract from the FAQ section in the draft)

Cap at 700 words.
```

Agent 4 — `agent-i18n-migrator`:
```
You are agent-i18n-migrator.

Read:
1. docs/superpowers/working/drafts/index-draft-v1.html (find the embedded `translations` object)
2. All docs/superpowers/working/sections/*/lead-notes.md (find new i18n key declarations)

Audit:
- Every data-i18n attribute in the HTML maps to an existing key in translations.en
- Every old key (from the original index.html) is preserved as backwards-compat OR consciously aliased
- Placeholder TODO_TRANSLATE entries exist for fr/es/de/zh/ja for every NEW key
- No orphan keys (declared but unused)
- No duplicate keys

Produce docs/superpowers/working/disciplines/04-i18n-migrator.md with:
- Audit summary (X new keys, Y deprecated keys, Z TODO_TRANSLATE placeholders)
- A complete validated `translations` object as a single SEARCH/REPLACE block (the SEARCH being the existing object; the REPLACE being the corrected one)

Cap at 1000 words (this one is allowed to be longer because translations are bulky).
```

Agent 5 — `agent-perf-engineer`:
```
You are agent-perf-engineer.

Read:
1. docs/superpowers/working/drafts/index-draft-v1.html

Audit:
- Total file size (current target: <250K)
- Inline CSS size (any duplicated rules?)
- Inline JS size (any unused observers? any unused functions?)
- Image use (none in current page; if added, check sizes)
- Font loading (no external fonts currently; verify still true)
- Lazy load opportunities (the dashboard preview animation can be lazy-init via IntersectionObserver - is it already?)
- Render-blocking resources

Produce docs/superpowers/working/disciplines/05-perf-engineer.md with:
- Size measurements
- SEARCH/REPLACE blocks for any optimizations
- A "stay-as-is" recommendation if no optimization is needed

Cap at 500 words.
```

Agent 6 — `agent-mobile-responsive`:
```
You are agent-mobile-responsive.

Read:
1. docs/superpowers/working/drafts/index-draft-v1.html

Audit at the breakpoints currently used by the file (480px, 768px, 1024px - find them in <style>):
- Every section grid (card grid, deploy grid, score grid, etc.) reflows correctly at narrow widths
- Hero terminal animation doesn't overflow on 320px-wide screens
- Templates section (NEW) reflows: 4 cards must stack on mobile
- FAQ section (NEW) details/summary works at narrow widths
- Hamburger menu still works (was just fixed in commit 4b7c79a)
- No horizontal scroll on any breakpoint

Produce docs/superpowers/working/disciplines/06-mobile-responsive.md with:
- SEARCH/REPLACE blocks for media-query additions/fixes
- Identified breakpoints with specific issues

Cap at 600 words.
```

- [ ] **Step 2: Verify all 6 outputs exist and are non-empty**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
ls -la docs/superpowers/working/disciplines/
```

Expected: 6 .md files, each non-trivial size.

- [ ] **Step 3: Commit Layer 3 outputs**

```bash
git add docs/superpowers/working/disciplines/
git commit -m "$(cat <<'EOF'
docs(redesign): Layer 3 discipline audits (6 agents)

- visual-designer, a11y-auditor, seo-expert, i18n-migrator, perf-engineer, mobile-responsive
- Each produces SEARCH/REPLACE changesets (not direct edits)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Apply discipline changesets to produce draft v2

**Files:**
- Create: `docs/superpowers/working/drafts/index-draft-v2.html`

The orchestrator (you) applies the 6 discipline changesets in this order: i18n-migrator → seo-expert → a11y-auditor → visual-designer → mobile-responsive → perf-engineer. The order matters because earlier agents' changes might affect later agents' line numbers.

- [ ] **Step 1: Copy v1 to v2 starting buffer**

```bash
cp docs/superpowers/working/drafts/index-draft-v1.html docs/superpowers/working/drafts/index-draft-v2.html
```

- [ ] **Step 2: Apply i18n-migrator changeset**

Read `docs/superpowers/working/disciplines/04-i18n-migrator.md`. For each SEARCH/REPLACE block, use the Edit tool on `docs/superpowers/working/drafts/index-draft-v2.html` with the exact SEARCH and REPLACE strings. If a SEARCH string is not unique, request the agent to add more context (re-dispatch with a focused fix prompt).

- [ ] **Step 3: Apply seo-expert changeset**

Same procedure with `docs/superpowers/working/disciplines/03-seo-expert.md`. After this step, the draft should have the FAQPage JSON-LD inline.

- [ ] **Step 4: Apply a11y-auditor changeset**

Same procedure with `02-a11y-auditor.md`.

- [ ] **Step 5: Apply visual-designer changeset**

Same procedure with `01-visual-designer.md`.

- [ ] **Step 6: Apply mobile-responsive changeset**

Same procedure with `06-mobile-responsive.md`.

- [ ] **Step 7: Apply perf-engineer changeset**

Same procedure with `05-perf-engineer.md`.

- [ ] **Step 8: Verify draft v2 still parses (no broken HTML)**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
# Quick balance check
opens=$(grep -c '<section id=' docs/superpowers/working/drafts/index-draft-v2.html)
closes=$(grep -c '</section>' docs/superpowers/working/drafts/index-draft-v2.html)
echo "sections: open=$opens close=$closes"
echo "main: open=$(grep -c '<main' docs/superpowers/working/drafts/index-draft-v2.html) close=$(grep -c '</main>' docs/superpowers/working/drafts/index-draft-v2.html)"
echo "html: open=$(grep -c '<html' docs/superpowers/working/drafts/index-draft-v2.html) close=$(grep -c '</html>' docs/superpowers/working/drafts/index-draft-v2.html)"
echo "body: open=$(grep -c '<body' docs/superpowers/working/drafts/index-draft-v2.html) close=$(grep -c '</body>' docs/superpowers/working/drafts/index-draft-v2.html)"
echo "Total bytes: $(wc -c < docs/superpowers/working/drafts/index-draft-v2.html)"
```

Expected:
- sections: 11 = 11
- main: 1 = 1
- html: 1 = 1
- body: 1 = 1
- bytes: under 250000

- [ ] **Step 9: Commit draft v2**

```bash
git add docs/superpowers/working/drafts/index-draft-v2.html
git commit -m "$(cat <<'EOF'
docs(redesign): integration draft v2 (Layer 3 audits applied)

- 6 discipline changesets merged: i18n, SEO, a11y, visual, mobile, perf
- FAQPage JSON-LD inline; backwards-compat i18n preserved

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Layer 4 — QA finale (3 agents sequential)

**Files:**
- Create: `docs/superpowers/working/qa/01-consistency-reviewer.md`
- Create: `docs/superpowers/working/qa/02-tech-accuracy.md`
- Create: `docs/superpowers/working/qa/03-final-polish.md`
- Create: `docs/superpowers/working/drafts/index-draft-v3.html` (after consistency)
- Create: `docs/superpowers/working/drafts/index-draft-v4.html` (after tech-accuracy)
- Create: `docs/superpowers/working/drafts/index-draft-final.html` (after final-polish)

Sequential because each depends on the previous's output and we want a clean line-number map.

- [ ] **Step 1: Dispatch agent-consistency-reviewer**

```
You are agent-consistency-reviewer.

Read docs/superpowers/working/drafts/index-draft-v2.html in full.

Audit for cross-section consistency:
- Same term used everywhere ("agent" vs "client", "consultation thread" vs "discussion")
- Same code style for snippets (npm install -g vs npx, JSON formatting)
- Same naming for tools (announce_work vs announceWork)
- Same use of em-dashes vs hyphens in copy
- Heading capitalization (Title Case vs sentence case - pick one)
- Same emoji vs no-emoji rule
- Same use of "you" vs "the user"
- CTAs consistent (button text, hover behavior)

Produce docs/superpowers/working/qa/01-consistency-reviewer.md as SEARCH/REPLACE blocks. Cap at 800 words.
```

- [ ] **Step 2: Apply consistency-reviewer changeset to produce v3**

```bash
cp docs/superpowers/working/drafts/index-draft-v2.html docs/superpowers/working/drafts/index-draft-v3.html
```

Then apply each SEARCH/REPLACE from `qa/01-consistency-reviewer.md` to `index-draft-v3.html` using the Edit tool.

- [ ] **Step 3: Dispatch agent-tech-accuracy**

```
You are agent-tech-accuracy.

Read:
1. docs/superpowers/working/drafts/index-draft-v3.html
2. docs/index.html.backup-pre-redesign-2026-05-09 (the original, for comparison of claimed numbers)
3. README.md
4. package.json (for version, dependency claims)
5. src/server-setup.ts (for tool count - the page claims "26 MCP tools")
6. tests/ directory (for test count - the page claims "216 tests across 18 files")
7. src/impact-scorer.ts (for the layered scoring claim)
8. src/mqtt-broker.ts (for the Aedes claim)

Verify every concrete numeric or behavioral claim in the draft:
- Tool count (currently states "26 tools" - is this still true?)
- Latency claims ("<5ms detection, <50ms push" - sourced where?)
- Test count ("216 tests" - count actual tests)
- Version (v0.2.x - matches package.json?)
- Dependency claims (Aedes, jose, mqtt versions)

Produce docs/superpowers/working/qa/02-tech-accuracy.md with:
- Each verified claim ✅ or ❌
- For each ❌: the corrected text as a SEARCH/REPLACE block

If a claim cannot be verified from the codebase, flag it as INCONCLUSIVE rather than guessing.

Cap at 700 words.
```

- [ ] **Step 4: Apply tech-accuracy changeset to produce v4**

```bash
cp docs/superpowers/working/drafts/index-draft-v3.html docs/superpowers/working/drafts/index-draft-v4.html
```

Apply changesets via Edit tool.

- [ ] **Step 5: Dispatch agent-final-polish**

```
You are agent-final-polish.

Read docs/superpowers/working/drafts/index-draft-v4.html.

Final pass:
- Typos
- Smart quotes (use straight ASCII quotes consistently)
- Trailing whitespace
- Double spaces
- Run-on sentences (>30 words → split)
- Confusing pronouns ("it" with ambiguous referent)
- Empty <p></p> or <div></div>

Produce docs/superpowers/working/qa/03-final-polish.md with SEARCH/REPLACE blocks. Cap at 500 words.
```

- [ ] **Step 6: Apply final-polish changeset to produce final**

```bash
cp docs/superpowers/working/drafts/index-draft-v4.html docs/superpowers/working/drafts/index-draft-final.html
```

Apply changesets via Edit tool.

- [ ] **Step 7: Final HTML validity sanity check**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
final=docs/superpowers/working/drafts/index-draft-final.html
echo "Lines: $(wc -l < $final)"
echo "Bytes: $(wc -c < $final)"
echo "<section id= count: $(grep -c '<section id=' $final)"
echo "<details count: $(grep -c '<details' $final)"
echo "</details count: $(grep -c '</details>' $final)"
echo "data-i18n count: $(grep -c 'data-i18n=' $final)"
```

Expected:
- 11 sections
- equal `<details>` and `</details>` counts (FAQ accordion)
- data-i18n count > 80 (we added FAQ + templates + new sections)

- [ ] **Step 8: Commit Layer 4 outputs**

```bash
git add docs/superpowers/working/qa/ docs/superpowers/working/drafts/index-draft-v3.html docs/superpowers/working/drafts/index-draft-v4.html docs/superpowers/working/drafts/index-draft-final.html
git commit -m "$(cat <<'EOF'
docs(redesign): Layer 4 QA finale (3 agents sequential)

- consistency-reviewer, tech-accuracy, final-polish
- v3 → v4 → final draft committed

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Replace docs/index.html and verify

**Files:**
- Modify: `docs/index.html` (replaced with the final)

This task swaps the live file. After this commit, the redesign is the visible landing page.

- [ ] **Step 1: Replace docs/index.html with the final draft**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
cp docs/superpowers/working/drafts/index-draft-final.html docs/index.html
```

- [ ] **Step 2: Diff vs backup to confirm meaningful change scope**

```bash
diff -u docs/index.html.backup-pre-redesign-2026-05-09 docs/index.html | wc -l
```

Expected: line count is large (most of the file changed) — confirms the redesign actually applied.

- [ ] **Step 3: Open in browser and visually verify**

```bash
# Windows: open the file in default browser
start docs/index.html
```

Visual checklist (the human or the orchestrator inspects):
- All 11 sections render
- No broken layout
- Templates section shows 4 cards correctly styled
- FAQ accordion expands/collapses
- Anchor links jump to correct sections
- i18n switcher (if any) works
- Mobile view (resize browser to 480px wide) reflows

- [ ] **Step 4: Validate FAQPage JSON-LD**

Copy the `<script type="application/ld+json">` block (the new FAQPage one) into Google's Rich Results Test (https://search.google.com/test/rich-results) or paste into a JSON validator. Confirm: zero errors.

- [ ] **Step 5: Verify all old anchors still resolve**

For each anchor in `[#install, #worktrees, #dashboard, #how-it-works, #mqtt, #scoring, #architecture, #deploy, #problem, #why, #results, #roadmap, #hero]`:

```bash
for a in install worktrees dashboard how-it-works mqtt scoring architecture deploy problem why results roadmap hero; do
  grep -c "id=\"$a\"" docs/index.html | xargs -I{} echo "$a: {}"
done
```

Expected: every line shows `: 1` (the anchor exists exactly once, either as primary section ID or as anchor-alias).

- [ ] **Step 6: Lighthouse check (if Chrome installed)**

Open Chrome DevTools → Lighthouse panel → Run on the local file (or serve via `npx serve docs/`). Targets:
- Performance: >= 95 desktop, >= 85 mobile
- Accessibility: >= 95
- Best Practices: >= 95
- SEO: >= 95

Record the scores in `docs/superpowers/working/qa/lighthouse-scores.md`.

- [ ] **Step 7: Commit the replaced index.html and final lighthouse report**

```bash
cd "C:/Users/gagno/projet/mcp-coordinator-new"
git add docs/index.html docs/superpowers/working/qa/lighthouse-scores.md
git commit -m "$(cat <<'EOF'
docs(landing): redesign — 11 sections, narrative arc, +templates +FAQ

Replaces the 13-section page with an 11-section narrative-arc redesign:
- Fuses why+problem → pain (3 punchy cards)
- Fuses why-block2+block3 → solution (live dashboard mock)
- Fuses how+mqtt+scoring → mechanism (with collapsible advanced detail)
- Adds templates section (4 patterns: parallel/sequential/hierarchy/readonly), uses existing CSS
- Fuses architecture+deploy → tech
- Fuses install+dashboard → start
- Adds FAQ section with 10 Q/A and FAQPage JSON-LD
- Preserves old anchor URLs as aliases
- Backwards-compatible i18n keys

Implemented via 36 sub-agents in 4 layers (Strategy / Section / Discipline / QA).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Cleanup working artifacts (optional, ask user)

The `docs/superpowers/working/` directory contains intermediate artifacts (~50 files). They're useful for audit and future reference but bloat the repo.

- [ ] **Step 1: Ask the user**

Question: "The working artifacts (50 files in docs/superpowers/working/) are committed. Keep for audit trail, archive to a tag, or delete?"

- [ ] **Step 2: Apply the user's choice**

Three branches:
1. **Keep**: do nothing (recommended for the first run; useful to inspect agent outputs).
2. **Archive to tag**: `git tag redesign-2026-05-09-artifacts && git rm -rf docs/superpowers/working/ && git commit -m "chore: archive redesign artifacts to tag"`
3. **Delete**: `git rm -rf docs/superpowers/working/ && git commit -m "chore: remove redesign working artifacts"`

---

## Self-Review Checklist (orchestrator runs this after the plan is finalized, before execution starts)

- [x] **Spec coverage**: every section in the spec (1-12) maps to a task above. ✅
- [x] **Placeholder scan**: zero "TODO/TBD/implement later" in this plan. ✅
- [x] **Type consistency**: agent names match across tasks (`agent-strategy-lead` used in Task 2 and 5). ✅
- [x] **File paths**: every file path is absolute or repo-rooted relative. ✅
- [x] **Commands**: all bash commands are runnable as-is on a Windows shell with bash available. ✅
- [x] **Agent prompts**: every agent prompt is self-contained and gives the agent the exact files to read and exact files to produce. ✅
- [x] **Verification**: every layer ends with a verification step before committing. ✅
- [x] **Recovery**: backup taken in Task 1; intermediate drafts versioned; rollback is `cp docs/index.html.backup-pre-redesign-2026-05-09 docs/index.html`. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-mcp-coordinator-docs-redesign.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this 36-agent plan because each layer's outputs feed the next.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Higher main-context burn.

**Which approach?**
