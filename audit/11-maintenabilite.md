# Audit — Dimension 11 : DX & maintenabilité solo

**Projet** : mcp-coordinator v0.13.0 — Embedded MQTT broker + MCP server for multi-agent coordination
**Date de l'audit** : 2026-07-03
**Score** : **6.5 / 10**
**Verdict global** : Une DX locale et un pipeline de release exemplaires pour un mainteneur solo, mais une soutenabilité opérationnelle fissurée — distribution binaires silencieusement cassée, contributeur externe ignoré, release bloquée — et une surface Phase 2 surdimensionnée qui constitue le principal risque de charge à long terme.

---

## 1. Résumé exécutif

La boucle de développement locale est exemplaire pour un mainteneur solo : build `tsc` en 15 s, suite de 2 337 tests en ~3,5 min en local (2 m 40 en CI), scripts pnpm clairs (`dev`, `dev:stdio`, `cli`, `test:watch`, `perf:*`, `chaos:*`), CONTRIBUTING.md précis, conventional commits irréprochables et pipeline release-please entièrement automatisé. Le HANDOFF.md couplé au système de mémoire persistante constitue une mitigation du bus factor rare et remarquable pour un flux de travail solo assisté par IA.

En revanche, la soutenabilité opérationnelle montre des fissures mesurables :

- le **canal de distribution binaires est silencieusement cassé depuis v0.11.0** (0 asset sur les 3 dernières releases alors que le README y renvoie) ;
- la **PR d'un contributeur externe dort sans réponse depuis 6,5 semaines** pendant que 23 « good first issues » semées attendent ;
- la **release 0.13.1**, contenant deux correctifs orientés utilisateurs, est **bloquée depuis 7 semaines** ;
- `pnpm test` **échoue sur Windows** (20 tests, exit 127) quand `bash` résout vers WSL — précisément l'environnement du mainteneur et de futurs contributeurs Windows.

Enfin, la surface Phase 2 (OAuth/multi-org/chiffrement enveloppe, ~50 fichiers épinglés à 100 % de couverture) est surdimensionnée par rapport à un runtime encore mono-tenant « default » : c'est le premier facteur de coût de maintenance à long terme pour une seule personne.

---

## 2. Points forts

| # | Point fort |
|---|------------|
| 1 | **Boucle locale rapide et fiable** : `tsc` 15,3 s, suite complète de 2 337 tests en 211 s local / ~2 m 40 en CI, scripts pnpm bien nommés (`dev`, `dev:stdio`, `cli`, `test:watch`, `perf:*`, `chaos:*`). |
| 2 | **HANDOFF.md + mémoire persistante** (état du code, tentatives échouées à ne pas refaire, prochaine étape) : mitigation du bus factor exceptionnelle pour un flux solo assisté par IA. |
| 3 | **Hygiène de commits exemplaire** : conventional commits scopés et descriptifs, références PR/issues systématiques, release-please + CHANGELOG automatisés. |
| 4 | **CI intelligente** : job `build-no-native` garantissant qu'un contributeur sans toolchain native peut builder (`test.yml:40-55`), `concurrency` avec cancel-in-progress, timeouts partout, artefacts Playwright sur échec. |
| 5 | **Lints d'invariants maison ciblés et eux-mêmes testés** (`scripts/lint-*.sh` + `tests/unit/lint-scripts.test.ts`) — protégés contre les régressions de sécurité spécifiques au projet. |
| 6 | **Dette TODO quasi nulle** : 12 occurrences dans `src/`, toutes annotées avec un ID de tâche et un contexte (ex. `TODO(Task 22)`). |
| 7 | **Onboarding contributeur documenté et honnête** : CONTRIBUTING.md avec corepack/pnpm, `.env.example` de 11,9 Ko richement commenté, templates issue/PR présents. |
| 8 | **Discipline YAGNI déjà active** : fermeture documentée de la famille Postgres (#103/#85/#104/#84), descoping public des issues (#98), requalification des labels (#94). |

---

## 3. Constats détaillés

### Sévérité HIGH

#### maintenabilite-01 — PR d'un contributeur externe (#151) sans aucune réponse depuis 6,5 semaines

- **Sévérité** : high — **Statut** : ✅ confirmé (contre-vérification adversariale via `gh` CLI)
- **Localisation** : `CONTRIBUTING.md:37`
- **Effort** : S

**Preuve** : `gh pr view 151` : `{"checks":[],"comments":[],"createdAt":"2026-05-26T19:15:10Z","reviews":[]}` — zéro review, zéro commentaire, CI jamais approuvée pour un first-time contributor. La contre-vérification confirme : PR « feat: add JSON logging flag » de nanookclaw, OPEN depuis le 26 mai, `gh pr checks 151` → « no checks reported », aucun run sur la branche `fix/log-json-flag`.

**Explication** : La PR #151 (contributeur nanookclaw, répondant à l'issue #71 étiquetée good first issue, avec « Closes #71 » dans le corps) est ouverte depuis le 26 mai sans le moindre accusé de réception, et les workflows CI n'ont même pas été approuvés (nanookclaw a 0 commit dans le repo : l'approbation manuelle du mainteneur est requise). Le constat est aggravé par `CONTRIBUTING.md:37` (« CI must pass before review ») : le processus exige que la CI passe avant review, alors que seul le mainteneur peut débloquer les workflows d'un premier contributeur — **la PR est structurellement bloquée sans son action**. Le projet a semé 20+ good first issues pour attirer des contributeurs ; le premier qui livre est ignoré. C'est le moyen le plus sûr de tuer le pipeline de contributeurs naissant (2 externes depuis v0.11).

**Recommandation** : Poster un commentaire d'accusé de réception aujourd'hui, approuver l'exécution des workflows, faire la review (le scope est petit : un flag de logging). En parallèle, se fixer une règle de triage : toute PR externe reçoit une réponse sous 72 h, même « je regarde ce week-end ».

---

#### maintenabilite-02 — Canal de distribution binaires silencieusement cassé depuis v0.11.0

- **Sévérité** : high — **Statut** : ✅ confirmé
- **Localisation** : `.github/workflows/release-binaries.yml:5`
- **Effort** : M

**Preuve** : `on: push: tags: ["v*"]` — or v0.13.0 → 0 asset, v0.12.0 → 0, v0.11.0 → 0 (la contre-vérification relève aussi v0.10.8 et v0.10.9 sans assets, soit 5 releases touchées), tandis que v0.10.5 porte 3 tarballs. Dernier run du workflow : tag v0.10.7 (2026-05-20). `README.md:86` pointe « Single-file binary … GitHub Release tarball » pour les utilisateurs « sans Node ».

**Explication** : `release-binaries.yml` se déclenche sur push de tag, mais les tags créés par release-please avec `GITHUB_TOKEN` ne déclenchent pas d'autres workflows (politique anti-récursion GitHub) — exactement le problème déjà diagnostiqué et corrigé pour docker-publish dans #142 (le commentaire `release.yml:66-70` documente lui-même la cause). Le fix #142 a chaîné docker-publish en reusable workflow **mais pas release-binaries**. Résultat : les dernières releases n'ont aucun tarball, alors que le tableau d'installation du README envoie les utilisateurs vers la page Releases, où le tarball le plus récent est v0.10.7. Aucune mitigation en place (pas de PAT, pas de `workflow_dispatch`, pas de job chaîné).

**Recommandation** : Appliquer le même correctif que #142 : convertir `release-binaries.yml` en workflow réutilisable (`workflow_call` avec input `tag`) et le chaîner dans `release.yml` derrière `release_created` — ou décider en YAGNI d'abandonner le canal binaires et retirer la ligne du README. Dans les deux cas, publier manuellement les binaires v0.13.x manquants (`gh workflow run` après ajout d'un `workflow_dispatch`).

---

### Sévérité MEDIUM

#### maintenabilite-03 — Release 0.13.1 bloquée depuis 7 semaines avec des correctifs utilisateurs mergés mais non publiés

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié
- **Localisation** : `package.json:3`
- **Effort** : S

**Preuve** : PR #149 « chore(main): release 0.13.1 » ouverte depuis le 2026-05-24 ; derniers commits main : `809cc2f` (fix UTC created_at) et `94cd92d` (fix Reset destructif gated) des 26-28 mai, jamais releasés ; aucun commit depuis le 28 mai.

**Explication** : Deux correctifs de bugs orientés utilisateurs (parsing UTC des timestamps SQLite, séparation Clear/Reset destructif du dashboard) sont sur main depuis fin mai mais jamais livrés sur npm/GHCR : la PR release-please #149 attend un merge depuis 7 semaines. La cadence est passée de 17 tags en 11 jours (13-24 mai) à zéro activité — un rythme en rafale-puis-silence est normal en solo, mais laisser des fixes mergés non publiés annule le bénéfice du pipeline automatisé.

**Recommandation** : Merger #149 pour couper v0.13.1 (et vérifier au passage la chaîne Docker + le constat maintenabilite-02). Adopter la règle : tout fix mergé est releasé sous une semaine — release-please rend cela quasi gratuit.

---

#### maintenabilite-04 — `pnpm test` échoue sur Windows (20 tests, exit 127) quand `bash` résout vers WSL

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié (mesuré empiriquement par l'auditeur)
- **Localisation** : `tests/unit/lint-scripts.test.ts:20`
- **Effort** : S

**Preuve** : Run local mesuré : « Tests 20 failed | 2317 passed » — tous dans `lint-scripts.test.ts` avec exit 127 ; pourtant `bash scripts/lint-run-all.sh` en Git Bash direct sort `EXIT: 0`. Le garde `BASH_AVAILABLE` ne teste que `execFileSync("bash", ["-c", "echo ok"])`.

**Explication** : La sonde `BASH_AVAILABLE` (lignes 20-31) valide seulement que `bash -c "echo ok"` fonctionne. Quand `bash` sur le PATH résout vers WSL (`System32\bash.exe`, cas fréquent car System32 précède `Git\bin`), la sonde passe mais l'exécution d'un script par chemin Windows (`C:\...\scripts\lint-*.sh`) échoue en 127 : le `skipIf` ne se déclenche pas et 20 tests virent au rouge. Un contributeur Windows qui suit CONTRIBUTING (« pnpm install puis pnpm test pour confirmer la baseline ») conclut à tort que le repo est cassé — le commentaire du fichier montre que le problème WSL était connu mais la sonde ne le couvre qu'à moitié.

**Recommandation** : Renforcer la sonde : exécuter un script réel par chemin absolu Windows (ex. `bash ${SCRIPTS_DIR}/lint-run-all.sh --probe` ou un mini-script temporaire) et skipper si le status n'est pas 0. Documenter dans CONTRIBUTING que Git Bash doit précéder WSL dans le PATH pour cette suite.

---

#### maintenabilite-05 — Aucun formatter ni linter généraliste : le style repose entièrement sur la review manuelle

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié
- **Localisation** : `.github/workflows/lint.yml:33`
- **Effort** : M

**Preuve** : Le job lint exécute `bash scripts/lint-run-all.sh` (5 scripts grep d'invariants projet) puis `pnpm exec tsc --noEmit`. Aucun `.prettierrc`, `eslint.config` ou `biome.json` à la racine du dépôt.

**Explication** : Le workflow « Lint » ne fait aucun linting généraliste : ce sont 5 gardes d'invariants métier (excellents en soi) plus un type-check. Tant que le mainteneur était seul, l'absence de formatter était du YAGNI défendable — le style est de fait cohérent. Mais avec des PR externes qui arrivent (#151, #132), chaque divergence de style devient un point de friction en review et du diff-noise, sans outil pour trancher automatiquement.

**Recommandation** : Ajouter le strict minimum : Prettier (ou Biome, plus rapide et sans dépendances) en mode check dans `lint.yml` + un script `pnpm format`. Formater tout le repo en un commit dédié (à référencer dans `.git-blame-ignore-revs`). Ne pas ajouter ESLint complet — tsc strict + les lints maison couvrent déjà l'essentiel du risque.

---

#### maintenabilite-06 — `sdk/` est un sous-paquet orphelin : jamais testé en CI, lockfile npm dans un repo pnpm, aimant à PR Dependabot

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié
- **Localisation** : `sdk/package.json:3`
- **Effort** : M

**Preuve** : `"version": "0.8.1"`, `"private": true` ; `sdk/package-lock.json` (npm) coexiste avec le `pnpm-lock.yaml` racine ; grep « sdk » dans `.github/workflows` → aucun match ; 7 fichiers de tests (`sdk/tests/*.test.ts`) jamais exécutés ; PR Dependabot #152 (bump vite, groupe sécurité) ouverte depuis le 16 juin.

**Explication** : Le SDK TypeScript (client OAuth Phase 2) a sa propre chaîne npm, ses propres tests et sa propre version (0.8.1, figée alors que le serveur est en 0.13.0), mais aucun workflow ne le build ni ne le teste : ses 7 suites de tests ne tournent nulle part. Il génère pourtant du travail réel — PR Dependabot de sécurité en attente, run « Dependabot Updates » en échec le 23 juin. C'est du coût d'entretien sans filet de sécurité ni utilisateur avéré (`private: true`, non publié).

**Recommandation** : Trancher en YAGNI : soit l'intégrer (job CI « sdk-test » de 10 lignes + migration vers pnpm workspace pour un seul lockfile), soit le déplacer dans `examples/` ou un repo séparé et exclure `sdk/` de Dependabot. L'état actuel — maintenu en apparence, jamais vérifié — est le pire des deux mondes.

---

#### maintenabilite-07 — Surface Phase 2 (OAuth/multi-org/chiffrement) surdimensionnée par rapport au runtime mono-tenant réel

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié
- **Localisation** : `src/server-setup.ts:89`
- **Effort** : S

**Preuve** : « TODO(Task 22): boot-time builder uses 'default' org because no auth context exists at startup » ; idem `src/metrics.ts:225` (« cross-org leak window — single-tenant only ») et `serve-http.ts:640,650`. `src/auth/` = 41 fichiers, ~50 fichiers épinglés à 100 % de couverture (`vitest.config.ts:30-107`).

**Explication** : Le projet embarque une pile d'authentification de calibre entreprise (OIDC multi-providers, device flow, rotation de refresh tokens, chiffrement enveloppe, admin multi-org, pseudonymisation d'audit, doc GDPR) alors que les TODO du code confirment que tout tourne en mono-tenant « default » et que le profil utilisateur est « early adopters coordonnant des agents locaux ». Ces ~22 000 LOC src + 46 500 LOC tests sont bien testés, mais chaque évolution transverse (schéma DB, contrat HTTP, montée de version jose/zod) doit désormais traverser cette surface — pour une seule personne, c'est le premier facteur de coût de maintenance à long terme.

**Recommandation** : Ne rien réécrire (le code existe et est couvert), mais geler explicitement : déclarer Phase 2 « stable/frozen » dans la doc mainteneur, refuser les phases suivantes (multi-org réel, Task 22/23.5) sans demande concrète d'un opérateur, et concentrer l'effort sur le cœur coordination/MQTT qui est la proposition de valeur. Les `TODO(Task 22)` devraient renvoyer à une issue unique « multi-org: deferred until demand » plutôt que de suggérer un travail en attente.

---

### Sévérité LOW / INFO

#### maintenabilite-08 — Tracker figé depuis le 23 mai : 23 issues semées sans triage ni lien avec la PR qui en résout une

- **Sévérité** : low — **Statut** : ⚠️ non contre-vérifié
- **Localisation** : `.github/ISSUE_TEMPLATE/feature_request.md:1`
- **Effort** : S

**Preuve** : `gh issue list` : 23 issues ouvertes, toutes créées les 19-20 mai (lots #67-#101), dernière activité de triage 2026-05-23 ; l'issue #71 (`--log-json`) a une PR ouverte (#151) qui ne lui est pas liée dans l'interface et n'est pas reviewée.

**Explication** : Le lot de good first issues créé mi-mai était une bonne stratégie d'amorçage, mais sans passe de triage depuis 7 semaines le tracker envoie le signal d'un projet dormant : aucune issue fermée/commentée depuis, la seule contribution effective (#151 pour #71) n'est ni liée ni traitée. Des GFI qui vieillissent sans réaction du mainteneur découragent les candidats contributeurs plus efficacement que l'absence de GFI.

**Recommandation** : Passe de triage de 30 min : lier #151 à #71, vérifier que chaque GFI est toujours pertinente post-v0.13 (certaines `examples/*` peuvent être regroupées), épingler une issue « roadmap » indiquant le rythme réel du projet. Ensuite, un rituel léger : 15 min de triage à chaque session de travail sur le repo.

#### maintenabilite-09 — 169 artefacts de travail IA internes commités dans le dépôt public (`docs/superpowers/working`)

- **Sévérité** : low — **Statut** : ⚠️ non contre-vérifié
- **Localisation** : `docs/superpowers/working/audit/04-security.md:1`
- **Effort** : S

**Preuve** : 201 fichiers sous `docs/`, dont 169 sous `docs/superpowers/` : notes de stratégie marketing, critiques de sections de landing page, audits internes (`01-cto.md` … `20-mcp-spec.md`), `lighthouse-scores.md`.

**Explication** : Les notes de travail des sessions agents représentent 84 % des fichiers de `docs/`. Elles ont une vraie valeur de continuité pour le flux solo+IA (les specs sont référencées par HANDOFF.md), mais noient la documentation utilisateur réelle (~15 fichiers utiles) et exposent publiquement des auto-audits — dont un volet sécurité — que des utilisateurs peuvent confondre avec l'état actuel du produit.

**Recommandation** : Séparer les niveaux : garder `docs/superpowers/specs/` (décisions durables, référencées), déplacer `docs/superpowers/working/` hors du dépôt public (branche archive, repo notes séparé, ou .gitignore + stockage local). Petit gain immédiat : les docs utilisateur redeviennent trouvables par un contributeur.

#### maintenabilite-10 — Déclencheurs CI incohérents : tests absents des branches, lint/e2e exécutés en double sur les PR

- **Sévérité** : info — **Statut** : ⚠️ non contre-vérifié
- **Localisation** : `.github/workflows/test.yml:5`
- **Effort** : S

**Preuve** : `test.yml` : on push/pull_request branches `[main]` ; `lint.yml` et `e2e.yml` : branches `["**"]` sur push ET pull_request.

**Explication** : Un push sur une branche de travail déclenche Lint + E2E mais pas les tests unitaires (qui n'arrivent qu'à l'ouverture de la PR), tandis que Lint et E2E tournent deux fois sur toute PR interne (événements push + pull_request), le groupe `concurrency` ne dédoublonnant que par workflow+ref. Coût mineur en minutes CI et signal partiel sur les branches.

**Recommandation** : Aligner les trois workflows sur le même couple de triggers : push sur main + pull_request vers main (le motif le plus standard). Un push de branche sans PR ne déclenche alors rien, acceptable pour ce profil de projet.

#### maintenabilite-11 — Seuils de couverture 100 % sur ~50 fichiers : garde-fou puissant mais friction non documentée pour les contributeurs

- **Sévérité** : info — **Statut** : ⚠️ non contre-vérifié
- **Localisation** : `vitest.config.ts:30`
- **Effort** : S

**Preuve** : ~50 entrées `{ branches: 100, lines: 100, statements: 100, functions: 100 }` couvrant `src/auth/**`, `src/security/**`, `cli/encryption/**`, jusqu'à `dashboard/public/admin-common.js`.

**Explication** : Exiger 100 % de branches sur les fichiers de sécurité est un choix défendable et bien exécuté (mécanisme de pre-stub commenté pour éviter les conflits de merge). Mais un contributeur externe qui touche un de ces fichiers découvrira l'exigence au premier échec CI, sans qu'elle soit mentionnée dans CONTRIBUTING.md — et la liste grandit à chaque tâche, ce qui alourdit chaque refactor transverse pour le mainteneur lui-même.

**Recommandation** : Une phrase dans CONTRIBUTING.md (« les fichiers auth/security sont épinglés à 100 % de couverture — voir vitest.config.ts ») et, à terme, remplacer la liste énumérative par un pattern glob par répertoire pour stopper la croissance du fichier de config.

#### maintenabilite-12 — Landing page maintenue à la main en 6 locales : toil récurrent à chaque release

- **Sévérité** : info — **Statut** : ⚠️ non contre-vérifié
- **Localisation** : `HANDOFF.md:89`
- **Effort** : M

**Preuve** : « Add a v0.13.0 entry to the landing-page roadmap timeline … Translate the 4 keys into the 5 non-EN locales (FR, ES, DE, ZH, JA) or rely on EN fallback » ; commits `8028a2c`, `86495ad` dédiés à la traduction de cartes roadmap.

**Explication** : Chaque release implique de mettre à jour les références de version et les cartes roadmap de `docs/index.html` dans 6 locales — plusieurs commits récents ne font que cela. Pour un projet early-stage dont l'audience est anglophone technique, c'est un coût par release qui ne rapporte probablement pas son entretien (filtre YAGNI).

**Recommandation** : S'appuyer systématiquement sur le fallback EN pour le contenu versionné (roadmap, versions) et ne traduire que les sections stables (hero, pitch), ou générer les références de version depuis `package.json` au build de la page. Réévaluer les locales ZH/JA/DE si les analytics ne montrent pas de trafic.

---

## 4. Recommandations priorisées

### Quick wins (effort S — la « journée de dégel » : une session suffit pour les 5 premiers)

1. **Débloquer #151** (maintenabilite-01, S) : accusé de réception, approbation des workflows CI, review — aujourd'hui. Puis règle des 72 h pour toute PR externe.
2. **Merger #149 → publier v0.13.1** (maintenabilite-03, S) : livre deux fixes utilisateurs en attente depuis 7 semaines et sert de test de non-régression pour la chaîne Docker.
3. **Passe de triage 30 min du tracker** (maintenabilite-08, S) : lier #151 ↔ #71, dépoussiérer les 23 GFI, épingler une issue « roadmap/rythme du projet ».
4. **Corriger la sonde WSL de `lint-scripts.test.ts`** (maintenabilite-04, S) : exécuter un script réel par chemin Windows dans la sonde `BASH_AVAILABLE` + note PATH dans CONTRIBUTING — supprime le faux « repo cassé » pour tout contributeur Windows.
5. **Geler explicitement la Phase 2** (maintenabilite-07, S) : statut « stable/frozen » dans la doc mainteneur, issue unique « multi-org: deferred until demand » remplaçant les TODO(Task 22) dispersés.
6. **Documenter les seuils 100 %** dans CONTRIBUTING.md (maintenabilite-11, S) et **déplacer `docs/superpowers/working/`** hors du dépôt public (maintenabilite-09, S).

### Chantiers M

7. **Réparer ou abandonner le canal binaires** (maintenabilite-02, M) : même correctif que #142 (`workflow_call` chaîné derrière `release_created` dans `release.yml`) + `workflow_dispatch` de secours + publication rétroactive des binaires v0.13.x — ou retrait assumé de la ligne du README. Le pire état est l'actuel : promis et mort.
8. **Trancher le sort de `sdk/`** (maintenabilite-06, M) : job CI + pnpm workspace, ou déclassement vers `examples/`/repo séparé avec exclusion Dependabot.
9. **Introduire Prettier ou Biome en mode check** (maintenabilite-05, M) : un commit de formatage dédié + `.git-blame-ignore-revs`, avant que le flux de PR externes ne grossisse.
10. **Réduire le toil i18n de la landing page** (maintenabilite-12, M) : fallback EN pour le contenu versionné, génération des versions depuis `package.json`.
11. **Harmoniser les triggers CI** (maintenabilite-10, S/M) : push main + pull_request main sur les trois workflows.

### Chantiers L

Aucun constat de cette dimension ne requiert un chantier L : le principal risque long terme (surface Phase 2) se traite par un gel documentaire (S), pas par une réécriture.

---

## 5. Annexe — Constats écartés après contre-vérification

Aucun constat n'a été réfuté par la passe adversariale sur cette dimension. Les deux constats de sévérité high (maintenabilite-01 et maintenabilite-02) ont été contre-vérifiés indépendamment via `gh` CLI et le code des workflows, et **confirmés** — la vérification de maintenabilite-02 a même révélé que le périmètre était légèrement sous-estimé (5 releases sans assets, v0.10.8 à v0.13.0, et non 3). Les constats medium et inférieurs n'ont pas fait l'objet d'une contre-vérification systématique et sont signalés comme tels (⚠️) dans le corps du rapport.
