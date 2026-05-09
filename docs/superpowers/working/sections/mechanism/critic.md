# §4 Mechanism — critic review

**Verdict**: Strong fusion. Synthesis §12 Consult rewrite verbatim. CTA matches §8 #2. Anchor aliases correctly placed before `<h2>`. `<details>` is native (no JS). No overlap with solution or templates.

## Open questions — rulings

- **Q1**: §4 "single sentence" is binding. Use option (b). See Issue 1.
- **Q2**: Score grid is flexbox prose, not `<table>`. Strict reading. ~243 words, trim ~25. See Issue 3.
- **Q3**: Embedded `<style>` OK for review; mark for visual-designer. See Issue 5.
- **Q4**: h2 → h3 → h4 order is correct. The wrapping `<div>` is dead weight. See Issue 4.
- **Q5**: `var(--accent)` blue on blue tint is borderline. Use `var(--text)`. See Issue 6.
- **Q6**: Hard-delete `mqtt.card.*` confirmed. No semantic mapping.
- **Q7**: Out of scope here. Hand `how.modes.*` to faq-lead.

## Issues

### 1. Subtitle violates single-sentence rule

```
SEARCH: <p class="section-sub" data-i18n="mechanism.subtitle">Four steps run before any code is written. A score decides who consults.</p>
REPLACE: <p class="section-sub" data-i18n="mechanism.subtitle">Four steps run before any code is written, then a score decides who consults.</p>
```

Update i18n key value in lead-notes.md to match.

### 2. Step 2 factual mismatch — "six layers" enumerates four

Text claims six but lists four. Footnote correctly lists six. Drop the partial enumeration.

```
SEARCH: <p data-i18n="mechanism.step2.desc">The scorer checks every active announcement across six layers: paths, dependencies, modules, recent edits.</p>
REPLACE: <p data-i18n="mechanism.step2.desc">The scorer checks every active announcement across six layers and returns a 0-to-100 impact score.</p>
```

### 3. Trim footnote to meet 220-word cap

```
SEARCH: <p class="text-center" style="color: var(--muted); font-size: 0.85rem; margin-top: 1.5rem;" data-i18n="mechanism.scoring.footnote">Six layers evaluated: file, dependency-out, dependency-in, recent-edit, dep-recent-edit, module-prefix. The most severe wins. <a href="https://github.com/swoofer/mcp-coordinator#impact-scoring" style="color:var(--accent);" rel="noopener noreferrer">Full details on GitHub →</a></p>
REPLACE: <p class="text-center" style="color: var(--muted); font-size: 0.85rem; margin-top: 1.5rem;" data-i18n="mechanism.scoring.footnote">Six layers, most severe wins. <a href="https://github.com/swoofer/mcp-coordinator#impact-scoring" style="color:var(--accent);" rel="noopener noreferrer">Full details on GitHub →</a></p>
```

### 4. Empty wrapper around `<h4>` — flatten

```
SEARCH:       <div class="text-center" style="margin-top: 2rem;">
        <h4 style="font-size: 1.1rem; margin-bottom: 1rem;" data-i18n="mechanism.advanced.flow.title">Push delivery flow</h4>
      </div>
REPLACE:       <h4 class="text-center" style="font-size: 1.1rem; margin: 2rem 0 1rem;" data-i18n="mechanism.advanced.flow.title">Push delivery flow</h4>
```

### 5. Annotate embedded `<style>` for merge handoff

```
SEARCH: <!-- Proposed CSS additions (place in main stylesheet block) -->
<style>
REPLACE: <!-- HANDOFF[visual-designer]: fold into main <style> cascade at merge. -->
<style data-merge-target="main-cascade">
```

### 6. Triangle contrast — switch to `var(--text)`

```
SEARCH:     color: var(--accent);
    font-size: 0.9em;
REPLACE:     color: var(--text);
    font-size: 0.9em;
```

### 7. De-duplicate inline styles on 8 `<code>` cells

Eight identical `style="color: var(--blue); font-size: 0.85em;"` repeats. Class-ify.

```
SEARCH (replace_all): <code style="color: var(--blue); font-size: 0.85em;">
REPLACE: <code class="mqtt-topic">
```

Add to `<style>`:

```css
.mqtt-topic { color: var(--blue); font-size: 0.85em; }
```

## DO NOT TOUCH

- **Step 3 Consult prose** — verbatim synthesis §12. Rewriting voids contract.
- **Closing CTA pair** — exact synthesis §8 CTA #2 match.
- **Anchor alias `<span>`s** — placement correct per §9.
- **Score grid rows, badges, tags** — preserved 1:1; tag em-dashes within budget.
- **MQTT table content + push terminal** — preserved 1:1; reusing `.results-table.dense` and `.terminal` is correct.
- **Native `<details>/<summary>`** — do not propose JS.
- **Glossary terms** — `agent`, `consultation thread`, `MQTT broker`, `between turns`, `consensus` verbatim.
