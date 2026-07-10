# Audit complet — mcp-coordinator v0.13.0

Audit multi-dimensions réalisé le **2026-07-04** sur la branche `main`, par orchestration de 11 auditeurs spécialisés avec **contre-vérification adversariale** de chaque constat High/Critical et un critique de complétude transversal.

## 👉 Commencer ici

**[`00-SYNTHESE.md`](00-SYNTHESE.md)** — synthèse exécutive : verdict global, scorecard, top 3 des risques, plan d'action priorisé (quick wins → chantiers → refactorings), angles morts. **Lire en premier.**

## Score global : 6,9 / 10

Aucun constat *critical*. **13 constats *high*, tous confirmés** par contre-vérification (0 réfuté). 46 *medium*. Fil rouge : le pattern « garde-fou fantôme » (des contrôles écrits et testés mais jamais branchés).

## Rapports par dimension

| # | Rapport | Score | High | Résumé en une ligne |
|---|---------|:-----:|:----:|---------------------|
| 01 | [Architecture & structure](01-architecture.md) | 6,5 | 1 | Deux générations de code ; endpoints implémentés mais jamais montés |
| 02 | [Qualité du code](02-qualite-code.md) | **8,0** | 0 | TypeScript strict exemplaire ; dette localisée (3 fonctions géantes) |
| 03 | [Sécurité — auth & tokens](03-securite-auth.md) | 7,0 | 1 | OAuth solide ; confusion de type de jeton (access vs refresh) |
| 04 | [Sécurité — surface d'attaque](04-securite-surface.md) | 7,0 | 1 | Fondations saines ; bind toutes interfaces par défaut |
| 05 | [Tests & couverture](05-tests.md) | **8,0** | 1 | 2337 tests, ~88 % ; seuils non appliqués en CI |
| 06 | [CI/CD & release](06-ci-cd.md) | 7,0 | 1 | Pipeline soigné ; canal binaires mort depuis v0.10.7 |
| 07 | [Dépendances & supply chain](07-dependances.md) | 6,5 | 0 | Socle sain ; `overrides` pnpm ignorés, 10 avis dormants |
| 08 | [Performance & scalabilité](08-performance.md) | 7,0 | 1 | Vrai travail de perf ; tables Phase 1 sans rétention |
| 09 | [Conformité MCP & API](09-protocole-mcp.md) | **6,0** | 3 | Bien testé ; 2 violations « MUST » + endpoints 404 |
| 10 | [Documentation](10-documentation.md) | 6,5 | 2 | Dense et exacte à 95 % ; env vars documentées inexistantes |
| 11 | [DX & maintenabilité solo](11-maintenabilite.md) | 6,5 | 2 | DX locale exemplaire ; PR externe et release corrective bloquées |

## Méthode

1. **Audit** — 11 agents en lecture seule, un par dimension, chaque constat ancré dans un `fichier:ligne`.
2. **Vérification** — chaque constat High/Critical soumis à un agent adversarial chargé de le *réfuter* ; les faux positifs écartés, les sévérités recalibrées.
3. **Rédaction** — un rapport markdown par dimension (constats groupés par sévérité, statut de vérification ✅/⚠️/❓, effort S/M/L).
4. **Critique** — un agent transversal cherche les angles morts et les incohérences de notation.

Légende sévérité : **critical** = exploitable ou perte de données aujourd'hui · **high** = risque réel / défaut majeur · **medium** = dette notable · **low/info** = amélioration.
Effort : **S** < 1 h · **M** < 1 jour · **L** plusieurs jours.
