# Audit complet — mcp-coordinator v0.13.0

**Synthèse exécutive**
**Date :** 2026-07-04
**Périmètre :** dépôt complet (`src/`, `cli/`, `sdk/`, `dashboard/`, `docs/`, `.github/`, tests) à la branche `main`
**Méthode :** 11 auditeurs spécialisés en lecture seule → contre-vérification adversariale de chaque constat High/Critical (mission : *réfuter*) → un rapport détaillé par dimension → critique de complétude transversal.

---

## 1. Verdict global

> **mcp-coordinator est un projet solo d'une maturité d'ingénierie inhabituelle — discipline de typage, couverture de tests et documentation dignes d'une équipe. Sa faiblesse n'est pas la qualité du code, c'est la vérification *bout-en-bout* : plusieurs garde-fous sont écrits, testés unitairement et documentés… mais jamais réellement branchés. Résultat : une installation par défaut plus exposée que ce que la doc promet, et des canaux (binaires, correctifs de vulnérabilités) silencieusement morts.**

**Score global pondéré : 6,9 / 10** — « solide avec des lacunes ciblées et corrigeables ».

| # | Dimension | Score | Critical | High | Medium | Low/Info |
|---|-----------|:-----:|:--------:|:----:|:------:|:--------:|
| 01 | Architecture & structure | 6,5 | 0 | 1 | 7 | 7 |
| 02 | Qualité du code | **8,0** | 0 | 0 | 3 | 5 |
| 03 | Sécurité — auth & tokens | 7,0 | 0 | 1 | 0 | 4 |
| 04 | Sécurité — surface d'attaque | 7,0 | 0 | 1 | 2 | 4 |
| 05 | Tests & couverture | **8,0** | 0 | 1 | 4 | 6 |
| 06 | CI/CD & release | 7,0 | 0 | 1 | 4 | 6 |
| 07 | Dépendances & supply chain | 6,5 | 0 | 0 | 4 | 6 |
| 08 | Performance & scalabilité | 7,0 | 0 | 1 | 5 | 5 |
| 09 | Conformité MCP & API | **6,0** | 0 | 3 | 4 | 7 |
| 10 | Documentation | 6,5 | 0 | 2 | 8 | 5 |
| 11 | DX & maintenabilité solo | 6,5 | 0 | 2 | 5 | 5 |
| | **Total** | **6,9** | **0** | **13** | **46** | **60** |

**Fiabilité de l'audit :** les 13 constats High ont été soumis à un vérificateur adversarial chargé de les réfuter. **13/13 ont été CONFIRMÉS**, aucun réfuté. Ce ne sont pas des hypothèses : chacun est ancré dans un `fichier:ligne` relu.

---

## 2. Ce qui est exemplaire

Un audit crédible reconnaît d'abord ce qui est bien fait — et ici, beaucoup l'est :

- **Discipline TypeScript rare** : `strict` partout, `tsc --noEmit` propre, 2 `any` réels dans tout `src/`, 0 `@ts-ignore`. (dim. 02)
- **Culture de test « integration-first »** : 2 337 tests, 0 échec, ~88 % lignes / ~81 % branches, avec de la vraie SQLite, un vrai broker aedes et le vrai client MCP SDK ; `vi.mock` n'apparaît que dans 3 fichiers. Plus de 40 modules sécurité verrouillés à 100 % de branches. (dim. 05)
- **Sous-système OAuth Phase 2 de niveau professionnel** : composition root avec injection de dépendances, `Clock` injectable, PKCE S256, nonce OIDC, rotation de refresh-tokens avec détection de réutilisation, chiffrement enveloppe AES-256-GCM, comparaisons à temps constant. (dim. 01, 03)
- **Fondations sécurité saines** : SQL 100 % paramétré, anti-path-traversal robuste (`safeJoinUnderRoot`), JWT HS256 épinglé (pas de confusion d'algorithme), ACL MQTT par org, plafonds anti-DoS. Aucune injection SQL, injection de commande ni zip-slip exploitable trouvée. (dim. 04)
- **Dockerfile & pipeline release exemplaires** : multi-stage, non-root, tini, healthcheck ; release-please → npm → Docker multi-arch avec SBOM ; gate de tests avant publication. (dim. 06)
- **Documentation dense et globalement exacte** : les 26 outils MCP annoncés correspondent un-à-un au code ; runbooks, threat model, OpenAPI, CHANGELOG impeccable, `HANDOFF.md` remarquable. (dim. 10)
- **Mitigation consciente du bus factor** : `HANDOFF.md` + système de mémoire — rare et précieux pour un flux solo assisté par IA. (dim. 11)

---

## 3. Le fil rouge : le « garde-fou fantôme »

Le constat le plus important de cet audit n'est aucun bug isolé, c'est **un mode de défaillance qui se répète sept fois** — mis en évidence en recoupant les 11 dimensions. À chaque fois : un contrôle est *écrit, testé unitairement, documenté*, mais **jamais vérifié en intégration réelle**, donc silencieusement inopérant :

1. Deux/trois endpoints (`/.well-known/oauth-authorization-server`, `/metrics/auth`, `/healthz`, `/health/ready`) implémentés + testés + dans l'OpenAPI + consommés par le SDK et `doctor` → **jamais montés** dans le routeur (404).
2. `COORDINATOR_BIND` documenté avec défaut `127.0.0.1` → **jamais lu** ; le serveur écoute sur toutes les interfaces.
3. Bloc `overrides` de `package.json` au format npm → **ignoré par pnpm** ; le correctif de vulnérabilité `uuid` que le mainteneur croit actif ne s'applique pas.
4. Provenance npm revendiquée en commentaire → **absente** sur le registre.
5. Canal de distribution binaires → **mort depuis v0.10.7** (0 asset sur 3 releases).
6. Seuils de couverture 100 % → **non appliqués en CI** (`pnpm test` sans `--coverage`).
7. Garde « `:latest` non promu au retry » du workflow Docker → **inopérant** (`latest=auto` le court-circuite).

**Implication :** ce n'est pas « sept bugs à corriger », c'est **une lacune de méthode**. Tant que les contrats ne sont pas vérifiés bout-en-bout (tests d'intégration qui démarrent le vrai serveur et frappent le vrai endpoint ; CI qui exécute réellement les gates), le prochain garde-fou écrit a la même probabilité d'être fictif. **La recommandation transversale la plus rentable de tout l'audit :** pour chaque contrôle de sécurité/qualité, ajouter *un* test qui l'exerce à travers le point d'entrée public, pas au niveau du module.

---

## 4. Top 3 des risques

### 🔴 Risque 1 — Installation par défaut dangereuse, contredite par la doc
Sur un simple `npx mcp-coordinator`, le serveur HTTP écoute sur **toutes les interfaces**, **auth désactivée**, **CORS wildcard**, **Origin non validé**, **`/metrics` ouvert** — alors que `README`/`.env.example` promettent `127.0.0.1`. C'est le **seul cluster exploitable par un tiers sur un LAN**, et il est activé par défaut. Les constats `securite-surface-01`, `documentation-01`, `protocole-mcp-02` décrivent la même racine.
**→ Correctif principal : 1 ligne** (lire `COORDINATOR_BIND`, défaut `127.0.0.1`) + validation d'Origin.

### 🟠 Risque 2 — Le pattern « garde-fou fantôme » (cf. §3)
Sept contrôles inopérants faute de vérification d'intégration. Danger réel : **fausse confiance**. Le mainteneur croit protégé ce qui ne l'est pas (vulnérabilités, couverture, provenance, bind).
**→ Correctif : mentalité « tester au point d'entrée public » + câbler/supprimer chaque garde-fou fantôme.**

### 🟡 Risque 3 — Soutenabilité solo vs surface embarquée
Le projet accumule de la surface (code Phase 2 multi-org sur un runtime encore mono-tenant `default`, ~200 docs, canaux de distribution) **plus vite que la capacité d'exploitation d'une seule personne** : PR externe (#151) sans réponse depuis 6,5 semaines, release corrective 0.13.1 bloquée 7 semaines, canaux déjà morts (binaires, SDK figé en 0.8.1), tables Phase 1 sans rétention qui dégraderont un serveur laissé tourner.
**→ Correctif : triage (répondre aux contributeurs sous 72 h), appliquer YAGNI à la surface, débloquer 0.13.1.**

---

## 5. Plan d'action priorisé

### 🥇 Quick wins — effort S, à faire cette semaine (fort ratio impact/coût)

| Action | Dim. | Constat | Impact |
|--------|:----:|---------|--------|
| Lire `COORDINATOR_BIND` (défaut `127.0.0.1`) et le passer à `listen()` | 04/10 | `securite-surface-01`, `documentation-01` | **Ferme l'exposition LAN par défaut** — 1 ligne |
| Rediriger les logs stdio vers **stderr** (violation « MUST NOT » du transport MCP) | 09 | `protocole-mcp-01` | Corrige la conformité MCP stdio |
| Câbler les endpoints fantômes (`/.well-known/...`, `/healthz`, `/health/ready`, `/metrics/auth`) + test d'intégration HTTP | 01/09/10 | `architecture-01`, `protocole-mcp-03`, `documentation-02` | Résout 3 constats High d'un coup |
| CI : `pnpm test` → `pnpm vitest run --coverage` (runtime ~4 min, budget 15 min) | 05 | `tests-01` | Rend les seuils de couverture réels |
| Répondre à la PR externe #151 (accusé + review, scope minime) | 11 | `maintenabilite-01` | Rétention des contributeurs |
| `pnpm update` pour purger les 10 avis (dont `tar` high) + corriger le bloc `overrides` (format pnpm) | 07 | dépendances | Ferme des vulnérabilités *réellement* |
| Rafraîchir README (v0.11→v0.13, tags Docker, compteurs) + SECURITY.md (0.10.x→0.13.x) | 10 | documentation | Véracité de la doc publique |

### 🥈 Chantiers ciblés — effort M, prochaines semaines

| Action | Dim. | Constat |
|--------|:----:|---------|
| Ajouter un claim `typ` (access vs refresh) au mint et le vérifier — **ferme la confusion de type de jeton** | 03 | `securite-auth-01` |
| Valider l'en-tête `Origin` sur `/mcp` + restreindre le CORS (via `allowedHosts`/`enableDnsRebindingProtection`) | 09 | `protocole-mcp-02` |
| Réparer `release-binaries` (convertir en `workflow_call`, chaîner derrière `release_created`) **ou** l'abandonner en YAGNI et retirer du README | 06/11 | `ci-cd-01`, `maintenabilite-02` |
| Étendre le Sweeper existant aux 5 tables Phase 1 (`file_activity`, `events`, `thread_messages`, `action_summaries`, `layer_firings`) | 08 | `performance-01` |
| Valider les corps REST avec zod (le schéma existe déjà côté MCP) | 02/04 | qualité/surface |

### 🥉 Refactorings de fond — effort L, quand le temps le permet

- Découper les trois fonctions géantes (`handleRest` ~505 l., `refreshTokenGrant` ~450 l., `startServer` ~390 l.) et le god-module `serve-http.ts` (763 l., 62 % du churn). (dim. 01, 02)
- Introduire une backpressure WebSocket, borner les structures mémoire non bornées (queues MqttBridge, buckets RateLimiter, sessions MCP), plafonner la cardinalité Prometheus. (dim. 08)
- Adopter un vrai linter (ESLint) — le « lint » actuel est 5 scripts bash grep + `tsc` ; ne détecte pas les promesses flottantes. (dim. 02, 11)

---

## 6. Angles morts de l'audit (à traiter dans une passe ultérieure)

Le critique de complétude a identifié des sujets qu'**aucune** des 11 dimensions n'a couverts et qui mériteraient leur propre audit :

- **Durabilité des données & reprise après sinistre** — le sous-système backup/restore (`cli/server/backup.ts`, `restore.ts`) et les 9 migrations `PRAGMA user_version` n'ont pas été audités pour leur *correction* (chiffrement des archives ? restauration inter-versions ? corruption WAL ?). C'est la seule chose *irréversible* du projet.
- **Vie privée / RGPD** — `docs/gdpr.md` décrit un effacement Art. 17 en tension avec l'immutabilité de l'audit-log ; personne n'a vérifié que ces procédures fonctionnent ni cartographié les fuites de PII (logs Phase 1 sans redaction, `audit_log`, backups).
- **Le frontend comme produit** — `docs/index.html` (445 Ko monolithique **avec deux backups de ~200 Ko committés** dans le dépôt), accessibilité (116 attributs `aria-` jamais audités), XSS dans le JS inline, pas de build front.
- **Le SDK comme livrable** — `sdk/package.json` figé en **0.8.1 « private »** avec un `package-lock.json` npm dans un dépôt pnpm ; drift de version (0.8.1 vs 0.13.0) et d'outillage.
- **Verrouillage mono-instance** — aucun lock du data-dir vérifié ; risque de deux instances sur le même répertoire.
- **Matrice runtime réelle** — Node 20/22/24 × OS pour les modules natifs (`better-sqlite3`) hors du cas tree-sitter.

Incohérences de notation relevées par le critique (à garder en tête) : Tests (8) affirme « 0 échec » quand DX (6,5) note l'échec Windows de `pnpm test` — l'environnement de référence n'est pas fixé ; Dépendances retient « 0 High » alors que `tar` (high) est sur un chemin d'entrée réel (extraction de backup).

---

## 7. Comment lire ce rapport

Chaque dimension a son fichier détaillé dans `audit/` avec l'intégralité des constats (preuve `fichier:ligne`, explication, recommandation, effort S/M/L) et le statut de contre-vérification. Voir `audit/README.md` pour l'index.

*Audit produit par orchestration multi-agents : 11 auditeurs + contre-vérification adversariale + critique de complétude. ~3 M tokens, 66 agents, 0 constat High non vérifié.*
