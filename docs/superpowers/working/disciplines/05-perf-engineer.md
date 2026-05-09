# Performance Audit — index-draft-v1.html

## Measurements

| Item | Size | Notes |
|---|---|---|
| Total file | **220.6 KB** / 3517 lines | Under 250 KB target |
| `<style>` block 1 (L61–1312) | ~35.3 KB | Main cascade |
| `<style>` block 2 (L1612–1678) | ~2.0 KB | Marked `data-merge-target` — should be folded in |
| `<script>` runtime (L2375–2482) | ~4.0 KB | Five observers + listeners |
| `<script>` i18n object (L2483–3481) | **~117 KB (53% of file)** | 6 locales × ~40 keys |
| External images | 1 (shields.io) | `loading="lazy" decoding="async"` — OK |
| External fonts / CDNs | 0 | System font stack — OK |
| Render-blocking | 0 | All inline — OK |

Verdict: within budget, but contains dead JS, a splittable `<style>` block, and ~100 duplicated inline accent-code styles in the i18n payload that bloat every locale identically.

## Optimizations

### 1. Remove dead `statObserver` (lines 2394–2420; no `data-count` or `.hero-stats` element exists in markup — verified by grep)

Delete the entire `// --- Animated stat counters` block (`prefersReducedMotion` const, the `IntersectionObserver`, `heroStats` query, and the `if (heroStats) statObserver.observe(...)` line).
Saves ~1.0 KB and one IntersectionObserver.

### 2. Class-ify duplicated inline accent-code styles
```search
  /* MQTT topic code cell — class-ified from 8 inline duplicates */
  .mqtt-topic { color: var(--blue); font-size: 0.85em; }
```
```replace
  /* MQTT topic code cell — class-ified from 8 inline duplicates */
  .mqtt-topic { color: var(--blue); font-size: 0.85em; }
  .ic { color: var(--accent); font-size: 0.85em; }
  .ic-lg { color: var(--accent); font-size: 0.9em; }
  .il { color: var(--accent); }
```
Then sweep i18n: `style=\"color:var(--accent);font-size:0.85em;\"` → `class=\"ic\"`; `font-size:0.9em` variant → `class=\"ic-lg\"`; bare `color:var(--accent)` → `class=\"il\"`. Saves ~6–8 KB across ~100 occurrences in 6 locales.

### 3. Fold L1612–1678 into the main `<style>` cascade
Move the rules into the L61–1312 block and delete the second `<style>` tag. Eliminates an extra style recalc and the handoff comment.

### 4. Skip i18n DOM rewrite on first paint when language is English
```search
  setLanguage(supportedLangs.includes(savedLang) ? savedLang : 'en');
```
```replace
  const initLang = supportedLangs.includes(savedLang) ? savedLang : 'en';
  if (initLang === 'en') { document.documentElement.lang = 'en'; document.querySelector('.lang-btn[data-lang="en"]').classList.add('active'); }
  else { (window.requestIdleCallback || setTimeout)(() => setLanguage(initLang), 0); }
```
English (most common path) avoids a full-DOM `innerHTML` rewrite; non-English is deferred off the critical path.

## Stay-as-is

shields.io image, font strategy, fade-in observer, hero terminal `setTimeout` cascade — already optimal. The 220 KB total is acceptable for a single-asset GitHub Pages site; further trimming should come from gzip at delivery (GH Pages does this automatically), not source-level cuts.
