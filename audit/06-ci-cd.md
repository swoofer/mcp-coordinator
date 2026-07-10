# Audit — Dimension 06 : CI/CD & Release

**Projet** : mcp-coordinator v0.13.0 — broker MQTT embarqué + serveur MCP pour coordination multi-agents
**Date de l'audit** : 2026-07-03
**Score** : **7 / 10**
**Verdict** : Un pipeline solide et bien raisonné pour un mainteneur solo, mais un canal de distribution (binaires GitHub Releases) est silencieusement mort depuis trois releases et plusieurs protections revendiquées n'existent que sur le papier.

---

## 1. Résumé exécutif

Le pipeline CI/CD est globalement bien conçu : permissions minimales explicites sur les six workflows, Dockerfile multi-stage exemplaire (utilisateur non-root, tini en PID 1, healthcheck, `pnpm prune --prod`), publication Docker multi-arch avec provenance et SBOM, et gates de tests réels avant chaque publication npm (`prepublishOnly = build + test`). Le chaînage release-please → npm → Docker via `workflow_call` contourne correctement le piège anti-récursion du `GITHUB_TOKEN`.

Ce même piège n'a en revanche **pas** été corrigé pour `release-binaries` : vérification faite sur GitHub, **aucun binaire n'a été publié depuis v0.10.7** — v0.11.0, v0.12.0 et v0.13.0 n'ont aucun asset, alors que le README pointe explicitement les utilisateurs « single-file binary / no Node available » vers les tarballs des GitHub Releases. Un canal de distribution documenté est donc mort depuis trois releases mineures, sans que personne ne s'en aperçoive — ce qui révèle aussi l'absence de vérification post-release de ce canal. C'est le seul constat **high** de la dimension, intégralement confirmé par la contre-vérification adversariale.

Autres écarts notables entre « croyance » et « réalité » :

- la **provenance npm** est revendiquée en commentaire mais absente sur le registre (pnpm 9.15.9 ne supporte pas `--provenance` ; `id-token: write` est accordé mais inutilisé) ;
- **aucun status check n'est requis sur main** malgré l'arrivée de contributeurs externes depuis la v0.11 ;
- le garde-fou « `:latest` non promu sur retry » du workflow Docker est **inopérant** (le flavor par défaut `latest=auto` de metadata-action le court-circuite, prouvé par les logs du run v0.13.0) ;
- les actions GitHub sont épinglées par **tags majeurs mutables**, sans Dependabot pour maintenir des pins.

Solide sur les fondamentaux, plombé par le canal binaires cassé et les protections fantômes — d'où le 7/10. L'ensemble des correctifs est à effort S/M, aucun chantier lourd.

---

## 2. Points forts

| Domaine | Constat |
|---|---|
| Permissions | Blocs `permissions:` explicites et minimaux partout — `contents: read` sur test/lint/e2e (test.yml:9-10, lint.yml:9-10, e2e.yml:9-10) ; permissions élevées confinées au workflow release ; le job docker chaîné redéclare ses propres permissions réduites (release.yml:78-81). |
| Dockerfile | Multi-stage exemplaire : utilisateur non-root uid 1001, tini en PID 1 pour le SIGTERM, `HEALTHCHECK` wget `/health` (endpoint vérifié dans src/serve-http.ts:515), `pnpm prune --prod`, `.dockerignore` soigné, image ~99 MiB compressée sur GHCR — chaque choix est commenté et justifié. |
| Publication Docker | Multi-arch amd64/arm64, `provenance: true` + `sbom: true` (docker-publish.yml:102-103), cache `type=gha`, `concurrency` sans cancel-in-progress avec raisonnement documenté (l. 32-34). |
| Gates de tests | `prepublishOnly = "pnpm build && pnpm test"` (package.json:62) conditionne le publish npm aux tests ; release-binaries exécute aussi `pnpm test` avant compilation (release-binaries.yml:45). |
| Chaînage release | release-please → npm → Docker via `workflow_call`, contournant l'anti-récursion `GITHUB_TOKEN` ; gate sur `release_created`, outputs propagés (release.yml:28-30, 75-85) — vérifié fonctionnel sur le run v0.13.0 (tags 0.13.0/0.13/latest sur GHCR). |
| Reproductibilité | pnpm épinglé via `packageManager` (pnpm@9.15.9) lu par pnpm/action-setup, corepack dans le Dockerfile, `--frozen-lockfile` partout, cache pnpm via setup-node. |
| Deps natives | Job `build-no-native` astucieux (test.yml:40-55) : garantit qu'un contributeur sans toolchain natif peut builder — protège les `optionalDependencies` tree-sitter contre les dépendances dures accidentelles. |
| Hygiène CI | `timeout-minutes` sur tous les jobs, concurrency groups avec cancel-in-progress sur les workflows de test, rapport Playwright uploadé uniquement en cas d'échec avec rétention 7 jours (e2e.yml:41-46). |
| Reprise manuelle | `workflow_dispatch publish_only` sur release.yml, `workflow_dispatch` avec tag sur docker-publish.yml — documentés et effectivement utilisés (runs dispatch observés). |
| Intégrité des releases | Ruleset de protection des tags `v*` (deletion + non_fast_forward interdits) — l'historique des releases ne peut pas être réécrit. |
| Sécurité workflows | Aucun vecteur d'injection de script détecté : pas de `pull_request_target`, aucune interpolation d'input non fiable dans les blocs `run`. |

---

## 3. Constats détaillés

Aucun constat de sévérité **critical**.

### Sévérité HIGH

#### ci-cd-01 — release-binaries ne se déclenche plus depuis que release-please crée les tags : aucun binaire publié depuis v0.10.7

- **Sévérité** : high · **Statut** : ✅ confirmé (contre-vérification adversariale) · **Effort** : M
- **Fichier** : `.github/workflows/release-binaries.yml:4`

**Preuve** : `on: push: tags: ["v*"]` est le seul déclencheur — aucun `workflow_call` ni `workflow_dispatch`. Vérifié via `gh release view` : v0.11.0, v0.12.0 et v0.13.0 → `assets: []`, alors que v0.10.7 (2026-05-20) porte 3 tarballs ; dernier run release-binaries = tag v0.10.7 (event push).

**Explication** : les tags créés par release-please via le `GITHUB_TOKEN` par défaut (release.yml:32-37, sans paramètre `token`) ne déclenchent pas les workflows `on: push: tags` — politique anti-récursion de GitHub. Ce piège est explicitement documenté dans le dépôt et contourné pour Docker via `workflow_call` (release.yml:66-74), mais release-binaries n'a jamais reçu le même traitement, et ne dispose même pas d'un `workflow_dispatch` de secours. Résultat : le canal « binaires GitHub Releases » est silencieusement mort depuis trois releases mineures, alors que README.md:86 renvoie explicitement les utilisateurs « Single-file binary / No Node available » vers ces tarballs — trois releases pointent donc vers des pages sans assets. Personne ne l'a remarqué, ce qui révèle aussi l'absence de vérification post-release de ce canal. Pas critical : npm et Docker (les canaux principaux) fonctionnent, aucun impact sécurité/intégrité.

**Recommandation** : répliquer le pattern Docker — ajouter un déclencheur `workflow_call` avec input `tag` à release-binaries.yml et le chaîner depuis release.yml (`needs: release`, `if: release_created`). **Attention** : l'étape « Package tarball » dérive la version de `GITHUB_REF_NAME` (l. 78), qui vaudra `main` sous `workflow_call` — la dériver de `inputs.tag`. Ajouter aussi un `workflow_dispatch(tag)` de secours. Alternative YAGNI si le canal n'a pas d'utilisateurs réels : supprimer le workflow et le canal (et la mention du README), plutôt que de le laisser mentir.

---

### Sévérité MEDIUM

#### ci-cd-02 — Provenance npm revendiquée mais jamais activée (id-token: write inutilisé, aucune attestation sur le registre)

- **Sévérité** : medium · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Fichier** : `.github/workflows/release.yml:61`

**Preuve** : `run: pnpm publish --no-git-checks` (sans `--provenance` ; pas de `.npmrc`, pas de `publishConfig.provenance`). docker-publish.yml:101 affirme « Same posture as npm publish provenance ». Vérifié : `npm view mcp-coordinator@0.13.0 dist` → aucune clé `attestations` ; `pnpm help publish | grep provenance` → vide (pnpm 9.15.9 ne supporte pas ce flag).

**Explication** : le workflow release accorde `id-token: write` (l. 20) et le commentaire du workflow Docker prétend une parité de provenance avec npm, mais aucune attestation n'est effectivement publiée. Le paquet npm est signé par le registre mais sans provenance de build — les utilisateurs ne peuvent pas vérifier que le tarball provient bien de ce repo/workflow. Par ailleurs, le `NPM_TOKEN` est un secret long-lived classique.

**Recommandation** : option la plus simple — remplacer l'étape de publish par `npm publish --provenance --access public` (npm est présent via setup-node, le tarball packé est identique, `prepublishOnly` s'exécutera toujours). Alternative : passer au Trusted Publishing npm (OIDC), qui élimine aussi le secret `NPM_TOKEN`. Sinon, mettre à jour pnpm vers une version supportant la provenance. Dans tous les cas, aligner le commentaire de docker-publish.yml:100-101 avec la réalité.

#### ci-cd-03 — Aucun status check requis sur main : les tests ne bloquent pas les merges de PR

- **Sévérité** : medium · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Fichier** : `.github/workflows/test.yml:1`

**Preuve** : `gh api repos/swoofer/mcp-coordinator/branches/main/protection` → la réponse ne contient ni `required_status_checks` ni `required_pull_request_reviews` (seuls `allow_force_pushes`/`allow_deletions` sont désactivés).

**Explication** : les workflows Tests/Lint/E2E tournent sur les PR mais rien n'empêche de merger un PR rouge. Tant que le mainteneur était seul, le risque était théorique ; avec les premiers contributeurs externes depuis v0.11, merger un PR dont la CI échoue (ou n'a pas fini) devient un scénario réaliste — et main est la branche d'où release-please coupe les releases : un main rouge peut se retrouver publié sur npm si le défaut n'est pas couvert par `prepublishOnly` (ex. échec e2e ou lint, non exécutés par celui-ci).

**Recommandation** : activer les required status checks sur main pour les jobs `test`, `build-no-native`, `lint` et `e2e` (Settings → Branches ou ruleset, ~10 minutes). Laisser `enforce_admins` désactivé conserve la souplesse solo (push direct possible) tout en gateant les PR externes.

#### ci-cd-04 — Le garde-fou « :latest non promu sur workflow_dispatch/workflow_call » est inopérant (latest=auto le court-circuite)

- **Sévérité** : medium · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Fichier** : `.github/workflows/docker-publish.yml:84`

**Preuve** : `type=raw,value=latest,enable=${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}` — mais le run chaîné v0.13.0 (`workflow_call`, ref=`refs/heads/main`) a quand même dérivé `ghcr.io/swoofer/mcp-coordinator:latest` (logs run 26359891716 : « Docker tags: …:0.13.0, …:0.13, …:latest ») ; digest `:latest` == digest `0.13.0`.

**Explication** : docker/metadata-action applique par défaut le flavor `latest=auto`, qui ajoute `:latest` à toute entrée de type semver/match qui matche — indépendamment de la condition `enable` de l'entrée `type=raw`. Le long commentaire (l. 71-75) affirmant que `:latest` est protégé contre un retour en arrière lors d'un retry `workflow_dispatch` d'une ancienne release décrit une protection qui n'existe pas : re-dispatcher docker-publish avec `tag=v0.10.9` (le cas d'usage documenté l. 6-7) repousserait `:latest` sur v0.10.9 et ferait rétrograder tous les utilisateurs de `:latest`. Sur le chemin nominal, le comportement actuel est « correct par accident » (c'est ce qui met à jour `:latest` aujourd'hui), ce qui rend le bug invisible.

**Recommandation** : ajouter `flavor: latest=false` à l'étape metadata-action, puis gérer `:latest` explicitement — garder l'entrée `type=raw` avec une condition couvrant le chemin chaîné (ex. input booléen `promote_latest`, positionné à `true` par release.yml et `false` par défaut sur `workflow_dispatch`). Tester en dispatch sur un ancien tag pour vérifier que `:latest` ne bouge pas.

#### ci-cd-05 — Actions GitHub épinglées par tags mutables (pas de SHA), sans Dependabot pour les maintenir

- **Sévérité** : medium · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Fichier** : `.github/workflows/release-binaries.yml:90`

**Preuve** : `uses: softprops/action-gh-release@v2` (workflow avec `contents: write`) ; idem partout : `actions/checkout@v4`, `pnpm/action-setup@v4`, `oven-sh/setup-bun@v2`, `googleapis/release-please-action@v4`, `docker/*@v3-v6`. Aucun `.github/dependabot.yml` dans le repo.

**Explication** : tous les workflows référencent des tags majeurs mutables. Une compromission d'un tag (précédent réel : tj-actions/changed-files, mars 2025) donnerait au code malveillant accès aux contextes les plus sensibles du pipeline : `NPM_TOKEN` dans release.yml, `contents: write` + `packages: write` (GITHUB_TOKEN) dans release-binaries et docker-publish. Le risque est le plus élevé pour les actions hors organisations à forte gouvernance : softprops/action-gh-release (mainteneur individuel, tourne avec `contents: write`), pnpm/action-setup, oven-sh/setup-bun.

**Recommandation** : filtre pragmatique solo — épingler par SHA complet au moins les actions tierces (softprops, pnpm, oven-sh) avec le tag en commentaire, et ajouter un `.github/dependabot.yml` minimal (`ecosystem: github-actions`, monthly) pour maintenir les pins sans effort. Épingler aussi `actions/*` et `docker/*` est un bonus peu coûteux une fois Dependabot en place.

---

### Sévérité LOW

#### ci-cd-06 — Node 20 déclaré supporté (engines >=20) mais jamais testé en CI

- **Sévérité** : low · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Fichier** : `.github/workflows/test.yml:27`

**Preuve** : `node-version: "22"` (unique valeur, tous workflows) alors que package.json:114-116 déclare `"engines": { "node": ">=20" }`.

**Explication** : toute la CI (test, lint, e2e, release, binaires) tourne exclusivement sur Node 22 / ubuntu-latest, alors que le paquet npm annonce la compatibilité Node >= 20 : une régression spécifique à Node 20 (API absente, comportement V8 différent, prébuilt better-sqlite3) serait publiée sans détection. La couverture Windows est assurée de facto par le développement local du mainteneur — une matrice OS complète serait du sur-engineering ici.

**Recommandation** : ajouter une matrice `node-version: [20, 22]` au seul job test (coût : un job de plus, ~5 min). Alternative zéro-coût : abaisser la promesse à `"node": ">=22"` dans engines si Node 20 n'est pas un vrai besoin utilisateur.

#### ci-cd-07 — Déclencheurs incohérents : lint et e2e tournent en double sur chaque PR interne, test.yml ne couvre que main

- **Sévérité** : low · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Fichier** : `.github/workflows/lint.yml:3`

**Preuve** : `on: push: branches: ["**"]` / `pull_request: branches: ["**"]` (lint.yml:3-7 et e2e.yml:3-7) vs test.yml:3-7 qui ne vise que main.

**Explication** : pour un PR ouvert depuis une branche du repo, lint et e2e s'exécutent deux fois (événement push sur la branche + événement pull_request), les groupes concurrency étant distincts par ref. Doublon de minutes CI et de bruit dans les checks. Inversement, test.yml ne tourne pas sur les pushes de branches non-PR — asymétrie sans justification apparente.

**Recommandation** : harmoniser les trois workflows de qualité sur le modèle de test.yml : `push: branches: [main]` + `pull_request: branches: [main]`. Les branches sans PR restent testables localement.

#### ci-cd-08 — secrets: inherit transmet NPM_TOKEN au workflow Docker qui n'en a pas besoin

- **Sévérité** : low · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Fichier** : `.github/workflows/release.yml:85`

**Preuve** : `secrets: inherit` — docker-publish.yml n'utilise que `secrets.GITHUB_TOKEN` (l. 56).

**Explication** : le job docker chaîné hérite de tous les secrets du repo, dont `NPM_TOKEN`, alors que docker-publish.yml ne référence que `GITHUB_TOKEN`. Ce n'est pas exploitable aujourd'hui, mais toute modification future de docker-publish.yml (ou compromission d'une action qu'il utilise — cf. ci-cd-05) aurait accès au token npm sans raison.

**Recommandation** : supprimer `secrets: inherit` (le `GITHUB_TOKEN` est fourni automatiquement aux workflows réutilisables du même repo). Si un secret devient nécessaire plus tard, le déclarer explicitement dans le bloc `secrets` du `workflow_call`.

#### ci-cd-09 — Binaires compilés avec un Bun non versionné et jamais démarrés réellement avant publication

- **Sévérité** : low · **Statut** : ⚠️ non contre-vérifié · **Effort** : M
- **Fichier** : `.github/workflows/release-binaries.yml:34`

**Preuve** : `uses: oven-sh/setup-bun@v2` (sans `bun-version` → dernière version au moment du run) ; l'étape Verify (l. 71-74) se limite à `--version` et `server --help`.

**Explication** : les tests vitest tournent sous Node, mais le binaire embarque le runtime Bun (`bun build --compile`), dont la version flotte d'un release à l'autre. Le seul smoke test n'exerce ni better-sqlite3 ni aedes sous Bun : un binaire qui crasherait au `server start` passerait la CI. La matrice omet aussi windows et linux-arm64, alors que le mainteneur et une partie des early adopters sont sous Windows (npm couvre ces plateformes, donc omission acceptable mais à documenter). Constat secondaire tant que ci-cd-01 n'est pas réglé — le workflow ne publie de toute façon rien.

**Recommandation** : épingler `bun-version` dans setup-bun, et remplacer/compléter l'étape Verify par un vrai smoke : démarrer `./bin/mcp-coordinator server start` en arrière-plan, `curl http://127.0.0.1:3100/health`, puis kill. À traiter en même temps que ci-cd-01.

---

### Sévérité INFO

#### ci-cd-10 — Image de base Docker non épinglée par digest

- **Sévérité** : info · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Fichier** : `Dockerfile:12`

**Preuve** : `FROM node:22-alpine AS builder` (idem runtime l. 48) ; `# syntax=docker/dockerfile:1.7` également flottant.

**Explication** : `node:22-alpine` est un tag mutable : deux builds du même commit peuvent produire des images différentes, et une compromission du tag upstream serait absorbée silencieusement. Pour ce profil (solo, early adopters), c'est une amélioration d'hygiène plutôt qu'un risque pressant — la provenance/SBOM déjà activées compensent partiellement en traçabilité.

**Recommandation** : épingler `node:22-alpine@sha256:…` et laisser le Dependabot docker (à ajouter avec ci-cd-05) rafraîchir le digest. À ne faire que si Dependabot est mis en place, sinon le pin rouillera.

#### ci-cd-11 — Navigateurs Playwright retéléchargés à chaque run e2e

- **Sévérité** : info · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Fichier** : `.github/workflows/e2e.yml:34`

**Preuve** : `- run: pnpm exec playwright install --with-deps chromium` (aucun `actions/cache` associé).

**Explication** : Chromium (~130 Mo) est retéléchargé à chaque exécution du workflow e2e, soit ~1-2 minutes par run sur un workflow qui tourne sur toutes les branches (cf. ci-cd-07). Pur coût de latence, aucun risque.

**Recommandation** : ajouter `actions/cache` sur `~/.cache/ms-playwright` avec une clé dérivée de la version de `@playwright/test` dans pnpm-lock.yaml, et ne lancer `playwright install` que sur cache miss (les deps système via `playwright install-deps` restent nécessaires à chaque run).

---

## 4. Recommandations priorisées

### Quick wins (effort S)

| # | Action | Constats | Impact |
|---|---|---|---|
| 1 | Activer les required status checks sur main (test, build-no-native, lint, e2e) — ~10 minutes | ci-cd-03 | Gate réel des PR externes avant la branche de release |
| 2 | Passer le publish npm à `npm publish --provenance --access public` (ou Trusted Publishing OIDC, qui supprime aussi `NPM_TOKEN`) et corriger le commentaire de docker-publish.yml | ci-cd-02 | Aligne la réalité sur la revendication ; provenance vérifiable |
| 3 | Ajouter `flavor: latest=false` + gestion explicite de `:latest` (input `promote_latest`) dans docker-publish.yml ; tester en dispatch sur un ancien tag | ci-cd-04 | Élimine le risque de rétrogradation de `:latest` lors d'un retry |
| 4 | Épingler par SHA les actions tierces (softprops, pnpm, oven-sh) + `.github/dependabot.yml` (github-actions, monthly) | ci-cd-05, prépare ci-cd-10 | Réduit la surface supply-chain sur les contextes à secrets |
| 5 | Supprimer `secrets: inherit` du job docker chaîné | ci-cd-08 | Moindre privilège, une ligne |
| 6 | Harmoniser les déclencheurs lint/e2e sur le modèle de test.yml ; matrice Node `[20, 22]` sur le job test (ou resserrer engines à `>=22`) ; cache Playwright | ci-cd-07, ci-cd-06, ci-cd-11 | Moins de minutes CI, promesse engines honorée |

### Chantiers (effort M)

| # | Action | Constats | Impact |
|---|---|---|---|
| 7 | **Décider du sort du canal binaires (priorité n°1 de la dimension)** : soit répliquer le pattern `workflow_call` depuis release.yml (avec dérivation de version via `inputs.tag` au lieu de `GITHUB_REF_NAME`, et un `workflow_dispatch(tag)` de secours), soit supprimer le workflow et sa mention README (option YAGNI défendable si le canal n'a pas d'utilisateurs). Si le canal est conservé : épingler `bun-version` et ajouter un vrai smoke test (`server start` + curl `/health` + kill) | ci-cd-01 (high), ci-cd-09 | Ressuscite — ou enterre proprement — un canal de distribution mort depuis trois releases |
| 8 | Ajouter une vérification post-release légère (checklist ou step final du workflow release : assets présents sur la Release, attestation npm visible, digest `:latest` attendu sur GHCR) | ci-cd-01 (cause racine), ci-cd-02, ci-cd-04 | Ferme la classe de problèmes « protection affirmée mais jamais vérifiée » |

Aucun chantier L : l'ensemble des correctifs tient dans une ou deux sessions de travail.

**Ordre suggéré** : #7 (canal cassé) → #1/#2/#3 (protections fantômes) → #4/#5 (supply chain) → #6 et #8 au fil de l'eau.

---

## 5. Annexe — Constats écartés après contre-vérification

Aucun constat n'a été réfuté (verdict REFUTED) lors de la passe de contre-vérification adversariale.

Le seul constat contre-vérifié en profondeur, **ci-cd-01** (high), a été intégralement **CONFIRMÉ** : (1) déclencheur unique `on: push: tags` dans release-binaries.yml, sans `workflow_dispatch` ni `workflow_call` ; (2) release-please tourne avec le `GITHUB_TOKEN` par défaut (release.yml:32-37), dont les pushes de tags ne déclenchent pas les workflows `push: tags` — piège documenté et contourné pour Docker uniquement ; (3) preuve live via `gh` : trois releases consécutives (v0.11.0 → v0.13.0) à zéro asset contre trois tarballs sur v0.10.7 ; (4) aucun mécanisme alternatif d'upload d'assets dans `.github/`, pas de PAT, pas de cron ; (5) canal documenté côté utilisateurs (README.md:86). Sévérité high jugée justifiée — canal documenté silencieusement mort sans levier de secours — mais pas critical, les canaux principaux (npm, Docker) fonctionnant et aucun impact sécurité/intégrité n'étant en jeu.

Les constats de sévérité medium et inférieure n'ont pas fait l'objet d'une contre-vérification systématique (statut ⚠️ dans le corps du rapport), mais chacun est accompagné d'une preuve directement vérifiable dans le code, sur le registre npm/GHCR ou via l'API GitHub.
