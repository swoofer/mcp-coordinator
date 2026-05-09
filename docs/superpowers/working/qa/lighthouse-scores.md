# Lighthouse Verification

**Status**: Manual verification needed.

The orchestrator cannot run Lighthouse directly (no browser available in this environment). The site owner should run the following manual checks before announcing the redesign live.

## Manual checks

### 1. Lighthouse (Chrome DevTools)
1. Open `docs/index.html` in Chrome (or serve via `npx serve docs/`)
2. Open DevTools → Lighthouse panel
3. Check: Performance, Accessibility, Best Practices, SEO
4. Run on Desktop AND Mobile

**Targets**:
- Performance: ≥ 95 desktop, ≥ 85 mobile
- Accessibility: ≥ 95 (a11y-auditor pre-empted contrast & ARIA issues)
- Best Practices: ≥ 95
- SEO: ≥ 95 (seo-expert verified meta + JSON-LD)

### 2. Google Rich Results Test
1. Visit https://search.google.com/test/rich-results
2. Paste the FAQPage JSON-LD block (search for `"@type": "FAQPage"` in `docs/index.html`)
3. Expect: 0 errors

### 3. Visual smoke test
- All 11 sections render without broken layouts
- Templates section shows 4 cards correctly styled
- FAQ accordion expands/collapses
- Mechanism section's collapsible MQTT detail expands
- Anchor links jump to correct sections (test #install, #worktrees, #dashboard which are now aliases)
- Mobile view (DevTools responsive mode at 375px wide) reflows
- i18n switcher still works (try EN→FR)

### 4. Anchor URL preservation (programmatic — already PASSED)

All 13 legacy anchors + 8 new anchors resolve exactly once in the file (verified by orchestrator pre-commit).

## Pre-flight summary

| Check | Status |
|-------|--------|
| 11/11 sections present | ✅ |
| 11/11 FAQ details/summary balanced | ✅ |
| 21/21 anchors (13 legacy + 8 new) resolve once each | ✅ |
| FAQPage JSON-LD present | ✅ (manual rich-results test recommended) |
| SoftwareApplication JSON-LD preserved | ✅ |
| 247 data-i18n attributes present | ✅ |
| Templates `.tmpl-*` CSS surfaced (4 cards × 4 components) | ✅ |
| Tech accuracy: 8 claims verified against codebase | ✅ |
| Backup `docs/index.html.backup-pre-redesign-2026-05-09` exists | ✅ |

**Rollback path**: `cp docs/index.html.backup-pre-redesign-2026-05-09 docs/index.html`
