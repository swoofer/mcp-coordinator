# Audit — Dimension 7 : Dépendances & supply chain

**Projet** : mcp-coordinator v0.13.0 — Embedded MQTT broker + MCP server for multi-agent coordination
**Date de l'audit** : 2026-07-03
**Score** : **6.5 / 10**
**Verdict global** : un socle de dépendances remarquablement sain (13 deps de production toutes utilisées, lockfile épinglé, licences 100 % permissives), terni par trois angles morts opérationnels — dont un mécanisme de correction de vulnérabilités que le mainteneur croit actif alors qu'il ne l'est plus depuis la migration vers pnpm.

---

## 1. Résumé exécutif

Le fond du dossier est bon. Les 13 dépendances de production ont été vérifiées **fichier par fichier** : chacune est réellement utilisée, aucune n'est morte ni redondante. Le lockfile `pnpm-lock.yaml` est committé, pnpm est épinglé via `packageManager` (honoré par Corepack dans le Dockerfile), et `--frozen-lockfile` est appliqué partout (CI et image Docker). Les licences du graphe de production sont 100 % permissives (aucun copyleft). L'intégration tree-sitter est exemplaire : 15 grammaires en `optionalDependencies` avec dégradation gracieuse, prebuilds 4 plateformes, un job CI dédié qui prouve que le serveur fonctionne sans elles, et des tests qui passent 17/17 sur Windows/Node 22.

Trois angles morts ternissent ce tableau :

1. **Le bloc `overrides` de `package.json` est au format npm et silencieusement ignoré depuis la migration vers pnpm** (dependances-01). L'override `uuid` ajouté pour « clear » un avis GHSA ne s'applique pas : `uuid@8.3.2` est toujours dans le lockfile et flaggé par `pnpm audit`. L'ajout de l'override et la migration npm→pnpm datent du même jour, à une heure d'intervalle — les overrides sont des no-ops depuis.
2. **10 avis de sécurité dorment dans le lockfile** (2 high, 7 moderate, 1 low — dont `tar`, dépendance directe utilisée pour extraire les archives de backup), alors qu'un simple `pnpm update` les corrigerait **tous** sans franchir de range de version (dependances-02).
3. **Aucune automatisation de veille** : ni Dependabot/Renovate, ni `pnpm audit` en CI (dependances-03). C'est ce qui a laissé les deux points précédents invisibles pendant plus d'un mois — un maillon particulièrement faible pour un mainteneur solo.

Rien de tout cela n'est exploitable de façon réaliste aujourd'hui (aucune vulnérabilité critical, chemins d'attaque tous modérés ou théoriques). Le vrai problème est structurel : **le mécanisme de correction de vulnérabilités que le mainteneur croit actif ne l'est pas**, et rien ne l'aurait signalé.

---

## 2. Points forts

| # | Point fort | Preuves |
|---|------------|---------|
| 1 | **Empreinte de dépendances réduite et 100 % utilisée** — chaque dep de production vérifiée en usage réel : `cookie` → `src/auth/cookies.ts:1`, `lru-cache` → `src/auth/membership-cache.ts:1`, `tar` → `cli/server/backup.ts:4` + `restore.ts:4`, `ws` → `src/mqtt-broker.ts:5`, `mqtt` → `src/mqtt-bridge.ts:1` et `cli/channel.ts:42`. Aucune dépendance morte ni redondante. | Vérification fichier par fichier |
| 2 | **Reproductibilité solide** — `pnpm-lock.yaml` committé, `packageManager: pnpm@9.15.9` épinglé (`package.json:64`) honoré par Corepack dans le Dockerfile (ligne 16), `--frozen-lockfile` partout (`test.yml:29`, `Dockerfile:30`). | package.json, Dockerfile, CI |
| 3 | **Ingénierie tree-sitter exemplaire** — 15 grammaires en `optionalDependencies` avec import dynamique et échec silencieux (`src/tree-sitter-extractor.ts:227-240`), endpoint `status()` exposant `grammars_loaded`, job CI `build-no-native` (`test.yml:38-53`) installant avec `--ignore-scripts` pour garantir qu'aucun code ne dépend en dur d'une dep optionnelle. Prebuilds darwin-arm64/darwin-x64/linux-x64/win32-x64 (aucune compilation node-gyp requise sur ces plateformes), tests 17/17 sur Windows/Node 22, et fonctionnalité réellement servie (extraction de symboles pour la détection de conflits sémantiques v0.6). | src, CI, tests |
| 4 | **Licences 100 % compatibles MIT** — 184 MIT, 16 ISC, 5 BlueOak-1.0.0, 4 Apache-2.0, BSD-2/3-Clause, 0BSD. Aucun copyleft (GPL/LGPL/AGPL) dans le graphe de production. | `pnpm licenses list --prod` |
| 5 | **Aucune vulnérabilité critical** ; `@modelcontextprotocol/sdk` à jour (1.29.0, dernière version) ; zod maintenu en v3 en cohérence délibérée avec la peer range du SDK (`^3.25 \|\| ^4.0`). | pnpm audit / outdated |
| 6 | **Dockerfile discipliné côté deps** — build 2 étages, `pnpm prune --prod` (ligne 42), utilisateur non-root, tini, outils natifs (python3/make/g++) confinés au stage builder. | Dockerfile |
| 7 | **Permissions CI minimales** — `contents: read` sur test/lint, actions limitées à des éditeurs établis (`actions/`, `pnpm/`, `docker/`, `googleapis/`). | .github/workflows/ |

---

## 3. Constats détaillés

Aucun constat de sévérité **critical** ni **high** sur cette dimension. Statut de vérification : les constats de ce lot sont de sévérité medium ou inférieure et n'ont pas fait l'objet d'une contre-vérification adversariale individuelle (⚠️) ; leurs preuves citent toutefois des fichiers et lignes précis du dépôt.

### Sévérité : medium

---

#### dependances-01 — Le bloc « overrides » de package.json est silencieusement ignoré par pnpm — l'override uuid censé corriger un GHSA ne s'applique pas

- **Sévérité** : medium · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `package.json:110`

**Preuve.** `package.json:110-113` : `"overrides": { "ip-address": "^10.2.0", "uuid": "^11.1.1" }` — format npm, top-level. Preuve de non-application : `pnpm-lock.yaml:2810` résout toujours `hyperid → uuid@8.3.2`, et `pnpm audit` flagge GHSA-w5hq-g745-h8pq (« uuid <11.1.1, Paths: . > aedes@1.0.2 > hyperid@3.3.0 > uuid@8.3.2 »). Le bloc `settings` du lockfile ne contient aucune section `overrides`. Historique git : `d8fd6b1` (2026-05-22 19:15) « override uuid to ^11.1.1 to clear GHSA-w5hq-g745-h8pq » ajouté sous npm, puis `480e005` (2026-05-22 20:13) « migrate from npm to pnpm » **une heure après** — les overrides sont devenus des no-ops le jour même.

**Explication.** pnpm ne lit que `pnpm.overrides` (ou `resolutions`), jamais le champ top-level `overrides` de npm. Depuis la migration npm→pnpm (#117), les deux overrides sont de la configuration morte : `uuid@8.3.2` (déprécié upstream, cf. warning `pnpm-lock.yaml:1816`) reste dans le graphe et l'avis GHSA que le commit `d8fd6b1` prétendait résoudre est de nouveau ouvert. L'override `ip-address` ne « fonctionne » que par coïncidence : `socks@2.8.9` déclare déjà `ip-address ^10.1.1`, donc 10.2.0 se résout naturellement. Exploitabilité réelle quasi nulle (hyperid n'utilise que uuid v4 via `./uuid-node`, alors que la faille touche v3/v5/v6 avec `buf`) — mais un contrôle de sécurité que le mainteneur croit actif ne l'est pas : c'est le vrai problème.

**Recommandation.** Déplacer les overrides sous `"pnpm": { "overrides": { "uuid": "^11.1.1" } }` puis relancer `pnpm install` (le lockfile enregistrera la section `overrides`, preuve d'application). Supprimer l'override `ip-address` devenu inutile (socks requiert déjà `^10.1.1`). Vérifier avec `pnpm audit` + `grep uuid@8 pnpm-lock.yaml` que la résolution a bien changé.

---

#### dependances-02 — 10 avis pnpm audit ouverts (2 high, 7 moderate, 1 low) — tous corrigeables par un simple refresh du lockfile sans franchir de range

- **Sévérité** : medium · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `pnpm-lock.yaml:42`

**Preuve.** `pnpm audit` : « 10 vulnerabilities found — Severity: 1 low | 7 moderate | 2 high ». Détail :

| Package vulnérable | Chemin | Avis | Patché en |
|---|---|---|---|
| `tar@7.5.15` | **dépendance directe** | GHSA-vmf3-w455-68vh — tar parser interpretation differential / file smuggling | 7.5.16 |
| `hono@4.12.22` | via `@modelcontextprotocol/sdk` | 1 high GHSA-88fw-hqm2-52qc (CORS reflète toute Origin avec credentials) + 4 moderate | 4.12.25 |
| `vite@8.0.14` / `esbuild@0.28.0` | via vitest (dev-only) | 1 high + 1 moderate + 1 low | vite 8.0.16 |
| `uuid@8.3.2` | via hyperid | 1 moderate (cf. dependances-01) | via override |

**Explication.** Impact réel calibré : (a) `tar` est la seule dépendance directe touchée — utilisée dans `cli/server/restore.ts:4` (`import { extract as tarExtract, list as tarList } from "tar"`) pour extraire des archives de backup fournies par l'utilisateur, exactement le chemin visé par l'avis de smuggling ; le scénario reste modéré car l'admin restaure normalement ses propres backups. (b) `hono` est bien chargé au runtime (`src/serve-http.ts:13` importe `StreamableHTTPServerTransport`, qui importe `@hono/node-server`), mais le middleware CORS vulnérable n'est pas exercé par le projet — risque effectif faible, bruit d'audit réel. (c) vite/esbuild sont dev-only. Le point notable : **toutes les versions patchées sont dans les ranges actuels** (`tar ^7.4.3 ⊇ 7.5.16` ; le SDK déclare `hono ^4.11.4 ⊇ 4.12.25` ; vitest 4.1.9 tire vite 8.0.16). Aucun avis n'exige de changement de code.

**Recommandation.** Lancer `pnpm update` (ou ciblé : `pnpm update tar hono vitest @vitest/coverage-v8 tsx`) pour rafraîchir le lockfile dans les ranges existants, puis vérifier `pnpm audit` à zéro et relancer la suite de tests. Coût : quelques minutes ; corrige les 10 avis d'un coup (l'avis uuid tombe avec le fix de dependances-01).

---

#### dependances-03 — Aucune automatisation de veille dépendances : ni Dependabot/Renovate, ni pnpm audit en CI

- **Sévérité** : medium · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `.github/workflows/test.yml:1`

**Preuve.** Aucun fichier `.github/dependabot.yml` ni `renovate.json` (vérifié : « cannot access '.github/dependabot.yml' »), et `grep -i 'audit|dependabot|renovate|snyk|osv'` sur `.github/` ne retourne aucun match dans les 6 workflows.

**Explication.** Pour un mainteneur solo, l'absence totale d'automatisation est le maillon faible : les avis de dependances-02 (dont le CVE `tar` sur une dépendance directe, patché upstream depuis des semaines) dorment dans le lockfile sans que rien ne les remonte. C'est aussi ce qui a laissé l'échec silencieux des overrides (dependances-01) invisible pendant plus d'un mois : un job d'audit en CI l'aurait signalé dès la migration pnpm.

**Recommandation.** Deux ajouts à faible coût : (1) un `.github/dependabot.yml` avec groupement (ecosystems `npm` + `github-actions`, interval `weekly`, groupes « minor-and-patch » pour limiter le bruit de PR) ; (2) un step `pnpm audit --prod --audit-level high` en job non-bloquant (`continue-on-error`) ou en workflow `schedule` hebdomadaire, pour que les avis high sur les deps de production remontent sans casser les PR des contributeurs.

---

#### dependances-04 — pnpm 9 exécute les scripts d'installation de toutes les dépendances par défaut — vecteur supply-chain évitable avec pnpm 10

- **Sévérité** : medium · **Statut** : ⚠️ non contre-vérifié · **Effort** : M
- **Localisation** : `package.json:64`

**Preuve.** `package.json:64` : `"packageManager": "pnpm@9.15.9"`. Aucun `.npmrc` ni champ `pnpm.onlyBuiltDependencies` dans le dépôt. `pnpm audit` recense 414 dépendances totales, dont plusieurs avec scripts d'install natifs (better-sqlite3, tree-sitter core + kotlin construit localement — `build/Release/tree_sitter_kotlin_binding.node` présent —, esbuild, msw).

**Explication.** Sous pnpm 9, n'importe lequel des 414 packages du graphe peut exécuter un script `postinstall` arbitraire sur la machine du mainteneur, celles des nouveaux contributeurs externes (actifs depuis la v0.11) et les runners CI/Docker. C'est le vecteur exact des vagues d'attaques npm de 2025-2026 (compromission de packages populaires avec payload postinstall). pnpm 10 inverse le défaut : aucun script de dépendance n'est exécuté sans allowlist explicite `onlyBuiltDependencies`, et offre `minimumReleaseAge` pour se protéger des versions fraîchement publiées. Le projet est déjà bien positionné pour cette migration : le job `build-no-native` prouve que l'install fonctionne avec `--ignore-scripts`.

**Recommandation.** Monter `packageManager` vers pnpm@10.x et déclarer `"pnpm": { "onlyBuiltDependencies": ["better-sqlite3", "esbuild", "msw", "tree-sitter", …lister les 15 grammaires] }`. Envisager `minimumReleaseAge` (ex. 4320 = 3 jours) en bonus. Tester : install locale, CI (`pnpm/action-setup` lit `packageManager`), build Docker. À combiner avec le déplacement des overrides (dependances-01) puisque le champ `pnpm` sera créé.

---

### Sévérité : low

---

#### dependances-05 — Famille tree-sitter figée sur l'ABI 0.21 (début 2024) — montée de version coordonnée 15+1 packages à planifier

- **Sévérité** : low · **Statut** : ⚠️ non contre-vérifié · **Effort** : L
- **Localisation** : `package.json:94`

**Preuve.** `pnpm outdated` : tree-sitter 0.21.1 → 0.25.0, tree-sitter-bash 0.21.0 → 0.25.1, tree-sitter-go 0.21.2 → 0.25.0, tree-sitter-javascript 0.21.4 → 0.25.0, tree-sitter-python 0.21.0 → 0.25.0, etc. — 15 grammaires + core, toutes 2 à 4 majeurs en retard. Le lockfile montre le couplage : chaque grammaire est résolue « (tree-sitter@0.21.1) » en peer.

**Explication.** Les bindings Node tree-sitter 0.21 datent de début 2024 ; le core et les grammaires doivent monter ensemble (peer dependency + compatibilité ABI), et les node types des grammaires changent entre majeurs (ex. tree-sitter-php a réorganisé ses types en 0.23), ce qui impacterait le registre `HANDLERS` de `src/tree-sitter-extractor.ts:77-190`. Aujourd'hui tout fonctionne (tests 17/17, prebuilds présents pour Node 22) — aucune urgence. Le vrai risque est différé : plus l'écart grandit, plus la montée devient coûteuse, et les prebuilds 0.21 finiront par manquer pour les futures versions ABI de Node (Node 24+).

**Recommandation.** Planifier une montée coordonnée core 0.25 + 15 grammaires dans une branche dédiée, en s'appuyant sur `tests/unit/tree-sitter-extract.test.ts` comme harnais de non-régression des node types. Pas avant que ce soit nécessaire (nouveau Node LTS sans prebuilds 0.21, ou besoin d'une grammaire récente) — YAGNI s'applique, mais documenter le couplage dans un commentaire du package.json ou dans HANDOFF.md.

---

#### dependances-06 — ~292 Mo de grammaires tree-sitter installés par défaut chez chaque consommateur npm et embarqués dans l'image Docker

- **Sévérité** : low · **Statut** : ⚠️ non contre-vérifié · **Effort** : M
- **Localisation** : `package.json:93`

**Preuve.** Mesure du store pnpm : tree-sitter-c-sharp 55 Mo, tree-sitter-kotlin 46 Mo, tree-sitter-typescript 30 Mo, tree-sitter-cpp 29 Mo, tree-sitter-ruby 24 Mo, tree-sitter-cli 19 Mo, … total ≈ 292 Mo (node_modules total : 933 Mo). `tree-sitter-swift@0.6.0` déclare `tree-sitter-cli@0.23.2` (19 Mo) et `which` en dependencies runtime (`pnpm-lock.yaml:3534-3540`). `Dockerfile:42` (`pnpm prune --prod`) conserve les optionalDependencies, prebuilds darwin/win32 inclus dans l'image linux.

**Explication.** Chaque `npm install mcp-coordinator` télécharge par défaut les 15 grammaires avec leurs prebuilds 4 plateformes et leurs sources C — l'essentiel du poids d'installation, pour une fonctionnalité explicitement optionnelle. L'image Docker embarque de même ~250-290 Mo de grammaires dont 3/4 des prebuilds ciblent d'autres OS, ce qui contredit le commentaire « runtime image small (~150MB) » du `Dockerfile:4`. C'est un trade-off défendable (l'extraction sémantique marche out-of-the-box), mais il n'est documenté nulle part côté consommateur.

**Recommandation.** Au minimum, documenter dans le README l'option `npm install mcp-coordinator --omit=optional` (et l'équivalent pnpm) pour les installs légères. Si le poids devient un point de friction remonté par les utilisateurs, envisager un package compagnon (`mcp-coordinator-grammars`) ou un sous-ensemble par défaut (ts/js/py/go) — pas avant : YAGNI.

---

#### dependances-07 — Retards de versions majeures contrôlés mais non suivis : zod 3→4, fast-check 3→4, commander 14→15, cookie 1→2, TypeScript 5.9→6

- **Sévérité** : low · **Statut** : ⚠️ non contre-vérifié · **Effort** : M
- **Localisation** : `package.json:78`

**Preuve.** `pnpm outdated` (28 packages) : zod 3.25.76 → 4.4.3, fast-check 3.23.2 → 4.8.0 (dev), commander 14.0.3 → 15.0.0, cookie 1.1.1 → 2.0.1, typescript 5.9.3 → 6.0.3 (dev), @types/node 22.19.19 → 26.1.0 (dev), aedes 1.0.2 → 1.1.1, @playwright/test 1.60.0 → 1.61.1.

**Explication.** Aucun de ces retards n'est un défaut aujourd'hui : zod 3 reste dans la peer range du SDK (`^3.25 || ^4.0`) et zod 4 est une migration de code réelle ; TypeScript 6.0 vient de sortir ; les autres sont des majeurs mineurs en portée. Mais sans suivi (cf. dependances-03), ces écarts s'accumulent silencieusement — zod est le plus structurant car il traverse toutes les définitions de tools MCP, et le SDK finira par exiger v4 dans un futur majeur.

**Recommandation.** Ne rien migrer maintenant. Ajouter une carte roadmap « migration zod 4 » (le SDK l'accepte déjà, la fenêtre est ouverte) et laisser Dependabot (dependances-03) gérer les minors/patches, aedes 1.1.1 et @playwright inclus. Traiter commander 15 / cookie 2 / fast-check 4 de façon opportuniste lors d'un cycle de maintenance.

---

#### dependances-08 — Actions CI épinglées par tag mutable, et binaires release construits avec une version Bun non déterminée

- **Sévérité** : low · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `.github/workflows/release-binaries.yml:34`

**Preuve.** `release-binaries.yml:34` : `uses: oven-sh/setup-bun@v2` sans `bun-version`, puis ligne 50 `bun build --compile cli/index.ts` et ligne 90 `uses: softprops/action-gh-release@v2` (workflow avec `permissions: contents: write`). Les 29 `uses:` des 6 workflows sont tous en tag `@vN`, aucun en SHA.

**Explication.** Deux actions hors organisations à forte gouvernance interviennent dans la chaîne de release avec droits d'écriture : `softprops/action-gh-release` (compte personnel, uploade les tarballs binaires que les utilisateurs téléchargent) et `oven-sh/setup-bun`. Un tag `@v2` est mutable : une compromission du repo de l'action (précédent réel : tj-actions/changed-files, 2025) publierait du code exécuté avec le token `contents: write` du job release. De plus, sans `bun-version`, chaque release est compilée avec le Bun du jour — build non reproductible et exposition au risque d'une régression/compromission Bun fraîchement publiée.

**Recommandation.** Épingler par SHA complet au moins les actions des workflows à permissions élevées (`softprops/action-gh-release`, `oven-sh/setup-bun`, `googleapis/release-please-action`) avec le tag en commentaire, et fixer `bun-version: "1.x.y"` dans setup-bun. Les actions `actions/*`, `docker/*`, `pnpm/*` peuvent rester en tag majeur — compromis raisonnable pour un mainteneur solo. Dependabot (ecosystem `github-actions`, cf. dependances-03) maintiendra les SHA à jour.

---

### Sévérité : info

---

#### dependances-09 — engines ">=20" autorise toujours Node 20, en fin de vie depuis avril 2026

- **Sévérité** : info · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `package.json:115`

**Preuve.** `package.json:114-116` : `"engines": { "node": ">=20" }`. Node 20 a atteint sa fin de vie le 30 avril 2026 ; le Dockerfile (ligne 12) et les 6 workflows CI sont déjà sur Node 22.

**Explication.** Les utilisateurs npm sous Node 20 (plus de correctifs de sécurité runtime) installent sans avertissement. L'écart est purement déclaratif : rien dans le code ne requiert 22, et resserrer `engines` est un breaking change semver.

**Recommandation.** Bump `engines` vers `">=22"` au prochain major (ou v1.0), et aligner `@types/node` en conséquence. D'ici là, mentionner Node 22+ comme version recommandée dans le README.

---

#### dependances-10 — Concentration de mainteneurs sur les briques critiques (better-sqlite3, jose, écosystème aedes) — risque assumé, surveillance passive suffisante

- **Sévérité** : info · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `package.json:66`

**Preuve.** Graphe de production : better-sqlite3 (WiseLibs, mainteneur quasi unique, module natif), jose (panva, mainteneur unique, brique JWT/OIDC de toute l'authentification), aedes et sa constellation mcollina (hyperid, mqemitter, fastfall, fastseries, fastparallel, retimer — packages matures mais à faible activité ; hyperid dépend encore de `uuid@8.3.2`, déprécié upstream, `pnpm-lock.yaml:1816`). tree-sitter-kotlin (fwcd) et tree-sitter-swift (alex-pinkus) sont des grammaires de comptes personnels.

**Explication.** Ce profil de risque est normal pour la stack choisie et ces mainteneurs sont parmi les plus réputés de l'écosystème Node — il n'y a rien à remplacer. Le point de vigilance concret est **aedes** : c'est le cœur du produit (broker embarqué), sa cadence de release est lente, et ses utilitaires internes vieillissent (uuid 8). Un abandon d'aedes serait le scénario de migration le plus coûteux du projet.

**Recommandation.** Aucune action immédiate. Monter aedes 1.0.2 → 1.1.1 au prochain cycle (via Dependabot), et garder un œil sur l'activité du repo moscajs/aedes lors des releases. Les protections systémiques (pnpm 10 + `onlyBuiltDependencies` + `minimumReleaseAge`, cf. dependances-04) couvrent le risque de compromission bien mieux qu'un remplacement de packages.

---

## 4. Recommandations priorisées

### Quick wins (effort S — à faire dès le prochain cycle)

| Priorité | Action | Constats | Effort |
|---|--------|----------|--------|
| 1 | Déplacer les overrides sous `pnpm.overrides` (garder `uuid`, supprimer `ip-address`), relancer `pnpm install`, vérifier `pnpm audit` + `grep uuid@8 pnpm-lock.yaml` | dependances-01 | S |
| 2 | `pnpm update` (ou ciblé : tar, hono, vitest, @vitest/coverage-v8, tsx) — corrige les 10 avis d'un coup dans les ranges existants, puis relancer la suite de tests | dependances-02 | S |
| 3 | Ajouter `.github/dependabot.yml` (npm + github-actions, weekly, groupes minor-and-patch) et un step `pnpm audit --prod --audit-level high` non-bloquant en CI | dependances-03 | S |
| 4 | Épingler par SHA les actions des workflows `contents: write` (action-gh-release, setup-bun, release-please) et fixer `bun-version` | dependances-08 | S |

Les actions 1 à 3 forment un ensemble cohérent : elles ferment le trou immédiat (overrides morts + avis dormants) **et** installent le garde-fou qui empêchera la récidive.

### Effort moyen (M — prochain cycle de maintenance)

| Priorité | Action | Constats | Effort |
|---|--------|----------|--------|
| 5 | Migrer vers pnpm 10 + `onlyBuiltDependencies` (better-sqlite3, esbuild, msw, tree-sitter + 15 grammaires) ; envisager `minimumReleaseAge` — à combiner avec l'action 1 (même champ `pnpm`) | dependances-04, dependances-10 | M |
| 6 | Documenter dans le README l'install légère sans grammaires (`--omit=optional` / équivalent pnpm) et la recommandation Node 22+ | dependances-06, dependances-09 | S–M |
| 7 | Ajouter une carte roadmap « migration zod 4 » ; laisser Dependabot gérer les minors/patches (aedes 1.1.1, @playwright, etc.) | dependances-07 | M |

### Chantiers (L — planifier, ne pas engager maintenant)

| Priorité | Action | Constats | Effort |
|---|--------|----------|--------|
| 8 | Montée coordonnée tree-sitter core 0.25 + 15 grammaires en branche dédiée, avec `tests/unit/tree-sitter-extract.test.ts` comme harnais. Déclencheur : nouveau Node LTS sans prebuilds 0.21, ou besoin d'une grammaire récente. En attendant, documenter le couplage ABI/peer | dependances-05 | L |

---

## 5. Annexe — Constats écartés après contre-vérification

Aucun constat n'a été réfuté (REFUTED) lors de la passe de contre-vérification adversariale sur cette dimension : les 10 constats retenus figurent tous dans le corps du rapport.
