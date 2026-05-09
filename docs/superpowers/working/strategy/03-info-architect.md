# Information Architecture — mcp-coordinator landing redesign

## 1. Final anchor map

13 old anchors mapped to the new 11-section structure. Primary IDs are owned by the host `<section>`; aliases are invisible `<span id="…" class="anchor-alias"></span>` placed inside the host section so existing inbound links (e.g. README, blog posts) keep resolving.

| Old anchor       | New host section ID | Type    |
|------------------|---------------------|---------|
| `#hero`          | `#hero`             | primary |
| `#why`           | `#pain`             | alias   |
| `#problem`       | `#pain`             | alias   |
| `#how-it-works`  | `#mechanism`        | alias   |
| `#mqtt`          | `#mechanism`        | alias   |
| `#scoring`       | `#mechanism`        | alias   |
| `#worktrees`     | `#compare`          | alias   |
| `#architecture`  | `#tech`             | alias   |
| `#deploy`        | `#tech`             | alias   |
| `#install`       | `#start`            | alias   |
| `#dashboard`     | `#start`            | alias   |
| `#results`       | `#results`          | primary |
| `#roadmap`       | `#roadmap`          | primary |

New primary IDs (no legacy redirect needed): `#solution`, `#templates`, `#faq`.

Implementation rule: place each `anchor-alias` span at the very top of its host section, immediately before the section's heading, so browser scroll lands on the right context. CSS `.anchor-alias { display:block; height:0; scroll-margin-top: var(--nav-h, 72px); }`.

## 2. Nav menu spec

Current nav lives at `docs/index.html` lines 1319–1343. Six content links + GitHub + "Get Started" CTA + lang switcher.

| Label        | href              | Action  | Note |
|--------------|-------------------|---------|------|
| How          | `#mechanism`      | remap   | was `#how-it-works`; same `nav.how` i18n key |
| Patterns     | `#templates`      | add     | new section, drives discovery of the templates feature |
| Compare      | `#compare`        | add     | replaces former absent comparison entry; surfaces objection-handling |
| Architecture | `#tech`           | remap   | was `#architecture`; keep `nav.arch` key |
| Deploy       | —                 | drop    | folded into `#tech`; kept as alias only, redundant in nav |
| Install      | —                 | drop    | replaced by `Get Started` CTA below |
| FAQ          | `#faq`            | add     | new |
| Roadmap      | `#roadmap`        | keep    | href and label unchanged |
| GitHub       | `https://github.com/swoofer/mcp-coordinator` | keep | unchanged |
| Get Started  | `#start`          | remap   | was `#install`; same `nav.getstarted` key |

Net: 6 content links → 6 content links (How, Patterns, Compare, Architecture, FAQ, Roadmap) + GitHub + Get Started CTA + lang switcher. Same horizontal weight, no overflow at ≥1024px.

## 3. Skip-link target

A skip-link **already exists** at line 1316: `<a href="#main" class="skip-link">Skip to main content</a>` targeting `<main id="main">` at line 1345. CSS `.skip-link` is defined (lines 1242–1248). No a11y issue here — the brief's premise is incorrect; verify before changing.

Action: **keep as-is**. Confirm that after restructure, the first focusable element inside `<main>` is the hero H1 (it is, after the eyebrow `div`). Ensure `<main id="main" tabindex="-1">` so keyboard focus lands inside on activation. If `tabindex="-1"` is missing, add it on line 1345 — that is the only change required.

## 4. Section ordering rationale

The arc `hero → pain → solution → mechanism → templates → compare → tech → start → results → faq → roadmap` follows the canonical PAS-then-proof persuasion pattern (Problem-Agitation-Solution) extended with technical validation gates the buyer requires before installing. Hero hooks attention; pain establishes shared reality; solution shows the system working; mechanism earns engineering trust; templates demonstrate composability; compare neutralizes alternative-evaluation; tech satisfies the architect; start removes friction; results provide evidence; FAQ closes residual objections; roadmap signals momentum.

**Pain before solution**: a solution-first opening forces the reader to retrofit relevance ("why do I need this?") and risks bouncing skim-readers who haven't yet acknowledged a problem worth solving. Pain-first is 5–10 seconds of recognition that primes every later claim with concrete stakes (Tuesday-3pm regression, 800k tokens burned). This trades nothing — the hero already carries the value prop, so pain is amplification not delay.

**Templates after mechanism (not inside it)**: mechanism answers "how does conflict detection work?" — a single coherent technical narrative (announce/detect/consult/resolve + scoring + push). Templates answer a different question: "what coordination shapes can I compose?" Embedding patterns inside mechanism would conflate the protocol (mandatory) with the patterns (optional, plug-in). Keeping them sequential lets the reader fully grok the protocol, then see patterns as a layer ON the protocol — which mirrors the actual code architecture (essaim ON mcp-coordinator).

## 5. TOC sidebar

**Recommendation: NO.** The page is 11 sections with strong narrative ordering; readers benefit from the linear arc. A sticky TOC fragments attention, competes with the hero/section visuals, and adds maintenance cost (re-render on i18n switch, scroll-spy JS, mobile collapse). The existing top nav already exposes the 6 most-jumped-to sections; the rest are sequentially discovered. If discoverability data later shows users hunting for `#faq` or `#templates`, revisit — but ship without.

DONE. File written to `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\strategy\03-info-architect.md`.
