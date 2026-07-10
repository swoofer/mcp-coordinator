# Spec — Remédiation complète de l'audit v0.13.0

**Date :** 2026-07-04
**Statut :** approuvé (design validé le 2026-07-04)
**Auteur :** Maxime Gagnon (+ assistance IA)
**Source :** `audit/` (11 rapports + `00-SYNTHESE.md`)
**Plan d'implémentation :** `docs/superpowers/specs/2026-07-04-audit-remediation-plan.md`
**Suivi :** `audit/TRACKING.md`

---

## 1. Objectif

Corriger **l'intégralité des 119 constats** de l'audit (13 high, 46 medium, 42 low, 18 info — 0 critical) et **prouver**, constat par constat, que chacun est résolu et vérifié. Le critère de succès n'est pas « le code est modifié » mais « chaque constat est fermé avec une preuve reproductible ».

### Non-objectifs

- Réécriture architecturale (le noyau Phase 1 singleton reste ; on le durcit, on ne le remplace pas).
- Publier le SDK sur npm (YAGNI : on aligne sa version et on le documente comme non publié).
- Ajouter des fonctionnalités produit. Cet effort est purement remédiation.

---

## 2. Principe directeur — tuer le « garde-fou fantôme »

Le constat systémique n°1 de l'audit : **sept contrôles écrits, testés unitairement et documentés, mais jamais vérifiés bout-en-bout, donc silencieusement inopérants** (bind jamais lu, endpoints jamais montés, overrides pnpm ignorés, provenance npm absente, binaires morts, couverture non appliquée en CI, garde `:latest` inopérant).

**Conséquence sur la méthode :** un fix n'est « fait » que lorsqu'il est vérifié **au point d'entrée public réel** (HTTP / stdio / CLI / pipeline CI), pas au niveau du module. C'est la raison d'être du protocole de vérification à 5 rounds (§4).

---

## 3. Décomposition — 7 PRs thématiques + PR 0 socle

Livraison en **PRs incrémentales par thème**, ordonnées par risque décroissant. Chaque PR est reviewable et mergeable seule ; conventional commits → release-please regroupe les versions. Chaque PR obtient son propre plan détaillé au moment de l'attaquer ; le plan maître (`…-plan.md`) enumère les 119 constats répartis.

| PR | Thème | Constats | dont High |
|----|-------|:--------:|:---------:|
| **0** | Socle : committer l'audit, gate couverture CI, TRACKING.md, répondre PR #151 | (transverse) | — |
| **1** | Sécurité durcissement | 17 | 4 |
| **2** | Conformité MCP & endpoints fantômes | 13 | 4 |
| **3** | CI/CD & dépendances | 24 | 3 |
| **4** | Performance & scalabilité | 11 | 1 |
| **5** | Qualité & refactoring | 30 | 0 |
| **6** | Documentation | 13 | 0 |
| **7** | DX & angles morts (+ investigations backup/RGPD/lock) | 11 | 1 |
| | **Total** | **119** | **13** |

**Ordonnancement et justification :**
1. **PR 0 en premier** — le gate de couverture CI (`tests-01`) doit exister *avant* tout le reste pour protéger chaque PR suivant contre les régressions. La réponse à la PR #151 est urgente (contributeur externe, 6,5 semaines).
2. **PR 1 puis PR 2** — le risque n°1 (exposition LAN par défaut) et le cluster de sécurité/conformité qui le recoupe.
3. **PR 3** — durcit le pipeline (release-binaires, provenance, veille deps) et rend la CI fiable.
4. **PR 4 → 6** — perf, refactoring, doc, par ROI décroissant.
5. **PR 7 en dernier** — DX + les trois **angles morts** signalés par le critique de complétude (correction backup/restore, RGPD/effacement PII, lock mono-instance) qui requièrent une *investigation* avant tout fix, pas juste un correctif.

### Forks YAGNI tranchés (défauts validés)

- **`release-binaries`** → **réparer** (le README y renvoie). [`ci-cd-01`, `maintenabilite-02`]
- **`/metrics/auth` + `COORDINATOR_METRICS_BEARER`** → **câbler** (documenté partout). [`documentation-02`, `securite-surface-02`]
- **SDK 0.8.1 « private »** → **aligner la version sur 0.13, documenter comme non publié**, ne pas publier sur npm. [`maintenabilite-06`, `tests-02`]

---

## 4. Protocole de vérification — 5 rounds par constat

**Exigence explicite : chaque constat passe 5 rounds de vérification distincts et non redondants avant d'être marqué fermé.** Aucun constat n'est « fait » tant que ses 5 cases ne sont pas cochées dans `audit/TRACKING.md`.

| Round | Nom | Ce qu'il prouve | Comment |
|:-----:|-----|-----------------|---------|
| **R1** | **Reproduction (rouge)** | Le défaut existe *à la bonne altitude* | Écrire un test qui échoue et démontre le constat (TDD). Pour un fix non testable par code (doc, config CI, action process), R1 = capture de l'état défaillant actuel (commande + sortie, ou lien). |
| **R2** | **Correction unitaire (vert)** | Le fix règle le cas + ses bords | Implémenter ; le test R1 passe ; ajouter les cas limites. `tsc --noEmit` propre. |
| **R3** | **Intégration bout-en-bout** | Le contrôle est *réellement câblé* | Test qui exerce le point d'entrée public : vrai serveur HTTP (démarré via `startServer`), vrai stdio (client MCP SDK), vraie commande CLI, ou vrai run CI. **C'est le round anti-« garde-fou fantôme ».** |
| **R4** | **Régression & statique** | Rien de voisin n'est cassé | Suite complète verte : `pnpm vitest run --coverage` + gate de couverture + `tsc --noEmit` + les 5 lints bash custom. Aucune baisse de couverture. |
| **R5** | **Adversarial / réel** | Le comportement tient face à un sceptique | Piloter le système réel (skill `/verify`) **et** poser l'assertion négative : prouver que ce qui *doit* désormais échouer échoue (ex. un refresh-token présenté comme cookie de session est **rejeté** ; `curl` sur l'interface LAN est **refusé** ; `pnpm audit` est **propre**). |

**Vérification de niveau programme (une fois, à la fin) :**
- **R-méta 1 — Réconciliation TRACKING :** les 119 lignes cochées 5/5, chacune reliée à un commit + un test nommé.
- **R-méta 2 — Revue indépendante :** skill `superpowers:requesting-code-review` / `/code-review` sur le diff cumulé, pour attraper ce que l'auteur a manqué.

Pour les constats **info/low non testables par code** (ex. « épingler l'image Docker par digest »), R1/R3/R5 s'adaptent : R1 = preuve de l'état actuel, R3 = vérification que le changement prend effet dans l'artefact réel (image buildée, page rendue), R5 = contrôle adverse (rebuild reproductible, lien mort re-testé). Aucun constat n'est exempté des 5 rounds ; leur *forme* s'adapte à la nature du constat.

---

## 5. Architecture des artefacts

```
audit/
  00-SYNTHESE.md … 11-*.md   (l'audit, source de vérité des constats)
  TRACKING.md                (matrice 119 × 5 rounds — l'artefact de certitude)
docs/superpowers/specs/
  2026-07-04-audit-remediation-design.md   (ce fichier)
  2026-07-04-audit-remediation-plan.md     (plan maître, 7 PRs, tâches détaillées)
```

`TRACKING.md` est le tableau de bord unique : une ligne par constat, colonnes R1–R5 + statut, groupées par PR. À la fin, 119/119 à 5/5 = preuve que « tout est bon ».

---

## 6. Contraintes & risques

- **Environnement Windows du mainteneur** : `pnpm test` échoue actuellement (exit 127, bash→WSL — `maintenabilite-04`). L'environnement de référence pour R4 doit être fixé (CI Linux fait foi ; le fix Windows est lui-même un constat de PR 7). À trancher tôt dans PR 0.
- **Sérialisation des tests** (singletons de module) : la suite tourne en série ; ne pas introduire de parallélisme qui casse l'isolation (`tests-10`).
- **Gate de couverture 100 % par fichier** : tout nouveau code sur les ~50 fichiers sous seuil doit rester à 100 % de branches, sinon R4 échoue. C'est voulu.
- **Risque de régression inter-PR** : PR 5 (refactoring des fonctions géantes) touche du code partagé avec PR 1/2 ; ordonner PR 5 *après* les PRs sécurité pour rebaser sur un socle durci.

---

## 7. Critère de « terminé »

Le programme est terminé quand **`audit/TRACKING.md` affiche 119/119 constats à 5 rounds cochés**, les 7 PRs sont mergées, la CI est verte avec le gate de couverture actif, une release release-please a livré les correctifs, et la revue indépendante de niveau programme (R-méta 2) ne remonte aucun constat high/critical résiduel.
