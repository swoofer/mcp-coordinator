# Audit — Dimension 10 : Documentation

- **Projet** : mcp-coordinator v0.13.0 (Embedded MQTT broker + MCP server for multi-agent coordination)
- **Date de l'audit** : 2026-07-03
- **Score** : **6.5 / 10**
- **Verdict global** : Une documentation d'une ampleur et d'une qualité rares pour un projet solo, mais minée par un problème de véracité — plusieurs variables d'environnement, endpoints et outils documentés n'existent pas dans le code, dont deux écarts à portée sécurité — et par une dérive de fraîcheur (README figé à v0.11.0, SECURITY.md à 0.10.x).

---

## 1. Résumé exécutif

La documentation de mcp-coordinator est exceptionnellement étendue pour un mainteneur solo : un README soigné avec une promesse claire et des tables d'outils exactes (les 26 outils MCP annoncés correspondent un à un au code), 24 documents utilisateur/ops denses et bien maillés (2 orphelins seulement), des runbooks d'incident, un threat model STRIDE, une spécification OpenAPI 3.1, un CHANGELOG release-please impeccable et un HANDOFF.md exemplaire pour la continuité de session.

Cependant, la vérification par échantillonnage révèle un **vrai problème de véracité** :

- plusieurs variables d'environnement documentées n'existent pas dans le code (`COORDINATOR_BIND`, `MAX_QUOTA_PCT`, `COORDINATOR_METRICS_BEARER`, famille `COORDINATOR_LOGIN_LOCKOUT_*`) ;
- l'endpoint `/metrics/auth`, documenté partout (README, OpenAPI, onboarding, runbooks, alertes, dashboards Grafana), n'est jamais routé et retourne 404 en déploiement réel ;
- l'outil MCP « introspection » vanté par le README n'existe pas ;
- le workflow multi-instances de `docs/usage.md` est cassé tel que décrit (le PID file ne suit pas `--data-dir`).

**Deux de ces écarts ont une portée sécurité** : le README et `.env.example` laissent croire que le serveur HTTP écoute sur `127.0.0.1` par défaut, alors qu'il écoute sur toutes les interfaces — et l'auth est désactivée par défaut.

S'y ajoute une dérive de fraîcheur : le README est resté à v0.11.0 (tags Docker recommandés « pour la production », compteurs de tests) et SECURITY.md déclare 0.10.x comme « current minor » alors que le projet est en 0.13.0 — pendant que la landing page et les exemples, eux, ont bien été mis à jour à 0.13.0.

Le score de 6.5/10 reflète cette tension : une base documentaire d'un niveau supérieur à la moyenne, mais dont la fiabilité factuelle exige une passe de réconciliation doc/code avant que la confiance des early adopters ne s'érode.

---

## 2. Points forts

| # | Point fort |
|---|---|
| 1 | **README remarquable** : promesse claire, table de personas, quickstart en 4 commandes, matrice d'installation (npm/npx/Docker/binaire), et la liste des 26 outils MCP vérifiée exacte contre `src/tools/*.ts` (26/26 noms corrects). |
| 2 | **Maillage interne dense et quasi sans orphelins** : sur 24 docs utilisateur/ops, seules `docs/openapi-README.md` et `docs/ops/perf-bench.md` ne sont référencées nulle part. |
| 3 | **Suite ops/sécurité rare à ce stade** : 17 runbooks (rotation de clés, incidents refresh-leak/signing-key-leak, backup Litestream, GDPR Art. 17, audit-integrity), threat model STRIDE de 25 Ko, OpenAPI 3.1 dont les 17 paths correspondent au chiffre annoncé dans le README. |
| 4 | **`docs/idp-providers.md` vérifié exact** : 100 % des variables `COORDINATOR_*` citées existent dans le code (diff doc/code vide). |
| 5 | **CHANGELOG généré par release-please**, précis, chaque entrée liée aux PR/commits ; `docs/operating-modes.md` (polling vs push) est à jour et exact sur `cli/channel.ts`. |
| 6 | **Exemples mis à jour lors de la release** : `examples/docker-compose/docker-compose.yml` pinne `ghcr.io/...:0.13.0` et la landing `docs/index.html` affiche 0.13.0. |
| 7 | **HANDOFF.md exemplaire** pour la continuité de session : état exact, tentatives échouées à ne pas refaire, prochaines étapes vérifiables. |
| 8 | **JSDoc de qualité dans `sdk/`** (options du client documentées, README SDK de 12,8 Ko avec snippets vérifiés : `McpCoordinatorClient`/`FileTokenStore`/`ProactiveRefresh`/`whoami` existent bien) et commentaires d'en-tête de fichiers `src/` expliquant les décisions avec références de spec. |
| 9 | **SECURITY.md complet** (canal GitHub privé, délais de divulgation, périmètre in/out, recommandations de durcissement) + `.well-known/security.txt` conforme RFC 9116. |
| 10 | **Chaque exemple (6) a son README** ; `channels-quickstart` documente précisément le statut research-preview et les flags requis. |

---

## 3. Constats détaillés

### Sévérité HIGH

#### documentation-01 — `COORDINATOR_BIND` documenté mais inexistant, et le bind par défaut annoncé (127.0.0.1) est faux

- **Sévérité** : High — **Statut** : ✅ Confirmé (contre-vérification adversariale)
- **Fichier** : `docs/usage.md:49` (aussi `docs/usage.md:84`, `.env.example:250-251`)
- **Effort** : S

**Preuve.** `docs/usage.md:48-49` : « Bind to all interfaces; default is 127.0.0.1 » avec `COORDINATOR_BIND=0.0.0.0 mcp-coordinator server start` ; `.env.example:251` : « Bind address (default 127.0.0.1) ». Or un grep de `COORDINATOR_BIND` sur `src/` et `cli/` ne retourne **zéro occurrence** — la variable n'est lue nulle part et n'apparaît que dans docs, `.env.example`, `docker-compose.yml` et tests de doc. Elle est également absente de l'allowlist d'env forwardée au daemon (`cli/server/start.ts:66-96`). Et `src/serve-http.ts:660` fait `httpServer.listen(port, cb)` **sans argument host** → Node écoute sur toutes les interfaces (0.0.0.0/::). Seul le broker MQTT TCP est explicitement lié à 127.0.0.1 (`src/mqtt-broker.ts:164`), pas la surface HTTP (MCP, REST, dashboard, MQTT-over-WS).

**Explication.** Un utilisateur qui suit la doc croit son coordinateur confiné à sa machine (ou croit le restreindre avec `COORDINATOR_BIND=127.0.0.1`) alors qu'il est **exposé au LAN sans auth par défaut** : l'authentification est opt-in (`src/serve-http.ts:54`, `COORDINATOR_AUTH_ENABLED === "true"`, défaut false = mode ouvert avec claims legacy synthétiques), et aucun autre mécanisme (flag CLI `--bind`, variable `HOST`, garde au démarrage) ne restreint l'écoute. Promesse de sécurité documentée fausse + exposition réseau non authentifiée par défaut — sévérité limitée au LAN (pas d'exposition Internet directe) pour un public d'early adopters.

**Recommandation.** Soit implémenter `COORDINATOR_BIND` (passer le host à `httpServer.listen` et à l'allowlist du forward daemon), soit retirer la variable de `usage.md` et `.env.example` et corriger la phrase sur le défaut. Vu la portée sécurité, **implémenter la variable avec défaut `127.0.0.1` est le bon choix** ; à minima, corriger la doc immédiatement.

---

#### documentation-02 — `/metrics/auth` et `COORDINATOR_METRICS_BEARER` documentés partout mais l'endpoint n'est jamais routé

- **Sévérité** : High — **Statut** : ✅ Confirmé (contre-vérification adversariale)
- **Fichier** : `README.md:217` (aussi `docs/openapi.yaml:867`, `docs/onboarding-self-host.md:141`, `.env.example:138-143`, runbooks `docs/ops/*`, alertes, dashboard Grafana)
- **Effort** : M

**Preuve.** `README.md:217` : « 29 metrics on /metrics/auth, Grafana dashboard JSON » ; `docs/openapi.yaml:867` déclare le path ; `docs/onboarding-self-host.md:141` et `.env.example:138-143` prescrivent `COORDINATOR_METRICS_BEARER` ; les runbooks (`sweeper-circuit-recovery`, `audit-queue-policy`, `access-review`, `feature-flag-rollout`), les alertes `coordinator-alerts.yaml` et le dashboard Grafana `coordinator.json` scrappent tous `/metrics/auth`. Or le handler `handleMetrics` (`src/http/metrics.ts:61`, avec contrôle loopback + comparaison bearer constant-time) n'est importé nulle part dans `src/` — seul `tests/unit/observability-metrics.test.ts:37` l'utilise. `src/serve-http.ts:521-522` ne route que « /metrics » (registre Phase 1, sans auth) ; `src/http/auth-routes.ts` ne contient aucune route metrics. `GET /metrics/auth` tombe dans le 404 final, et `COORDINATOR_METRICS_BEARER` n'est lu nulle part dans `src/` ni `cli/`.

**Explication.** Toute la chaîne documentaire d'observabilité Phase 2 (README, OpenAPI, onboarding, runbooks opérationnels, alerting, dashboards) décrit une surface **qui n'existe pas à l'exécution**. Un opérateur qui suit `onboarding-self-host.md` ne verra jamais ses métriques auth. Le handler existant, complet et testé, suggère un oubli de wiring plutôt qu'un choix.

**Recommandation.** Câbler `handleMetrics` dans `serve-http.ts` (ou le dispatcher Phase 2) avec un test d'intégration HTTP qui scrape réellement `/metrics/auth`. Sinon, retirer l'endpoint de README/openapi.yaml/onboarding/.env.example et des runbooks/alertes.

---

### Sévérité MEDIUM

#### documentation-03 — Section « Anthropic Quota Pre-flight » du README : `MAX_QUOTA_PCT` inexistant, mécanisme inexact, limitation macOS-only passée sous silence

- **Sévérité** : Medium — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `README.md:379` (aussi `README.md:456`, `.env.example:247`)
- **Effort** : S

**Preuve.** `README.md:379` : « Threshold via MAX_QUOTA_PCT env var (default 95) » et table env ligne 456 — grep de `MAX_QUOTA_PCT` dans `src/` + `cli/` : zéro occurrence (seul le README le contient). `README.md:378` : « Reads usage from the Anthropic API using the key in the environment » — en réalité `src/quota/credential-reader.ts:27-31` lit le credential OAuth Claude via `security find-generic-password` (Keychain macOS), et le même fichier (lignes 4-6) documente : « macOS is the only platform with a real implementation; Linux and Windows [stub] — the quota endpoint simply returns 503 ».

**Explication.** Une feature mise en avant du README est décrite de façon triplement inexacte : la variable de seuil n'existe pas, la source du credential est fausse, et rien n'indique que sur Linux/Windows — donc dans le déploiement Docker « recommandé pour la production » — le quota renvoie systématiquement 503. Les utilisateurs Docker/Windows chercheront en vain pourquoi le widget quota ne marche pas.

**Recommandation.** Réécrire la section : supprimer `MAX_QUOTA_PCT` (ou l'implémenter), documenter que la lecture du credential est macOS-only (Keychain) et que les autres plateformes reçoivent 503 « quota unknown = continue ». Ajouter la mention dans la table env du README et dans `.env.example` (ligne 247).

---

#### documentation-04 — `usage.md` : le workflow multi-instances documenté est faux (le PID file ne suit pas `--data-dir`)

- **Sévérité** : Medium — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `docs/usage.md:230`
- **Effort** : M

**Preuve.** `usage.md:230` : « pass --data-dir explicitly to each instance — the PID file lives next to the data dir, so multiple instances don't fight over the same file. To stop a specific instance, cd to its data dir's parent and run server stop from there ». Or `cli/server/start.ts:104` : `writeFileSync(join(configDir, "server.pid"), ...)` où `configDir = ensureConfigDir()` = `~/.mcp-coordinator` (`cli/config.ts:25-27`), indépendant de `--data-dir` et du cwd.

**Explication.** Le PID file est toujours écrit dans `~/.mcp-coordinator/server.pid` : le second daemon écrase le PID du premier, et `server stop` (peu importe le cwd) arrête la mauvaise instance. La recette « cd to its data dir's parent » est inopérante puisque `getConfigDir()` est basé sur `homedir()`, pas sur le cwd. La variante `kill $(cat ...)` de la doc pointe d'ailleurs vers un chemin qui n'existe pas (`./.mcp-coordinator-A/../server.pid`).

**Recommandation.** Soit faire suivre le PID file au `--data-dir` dans `start.ts`/`stop.ts` (aligner le code sur la doc), soit corriger `usage.md` : documenter qu'une seule instance daemonisée est gérée par `server start/stop` et proposer le lancement foreground + gestionnaire de process pour le multi-instance.

---

#### documentation-05 — Le README promet un outil MCP « introspection » qui n'existe pas

- **Sévérité** : Medium — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `README.md:236`
- **Effort** : S

**Preuve.** `README.md:236` : « The in-server `introspection` tool returns the live schema for every tool — point any MCP client at it for runtime discovery. » Aucun `server.tool("introspection"...)` dans `src/` ; `src/introspection.ts` est un `IntrospectionManager` de persistance des auto-évaluations d'agents (table `introspections`), sans rapport avec la découverte de schémas.

**Explication.** Un client MCP qui appelle `introspection` reçoit une erreur tool-not-found. La découverte des schémas passe en réalité par le standard MCP `tools/list`, pas par un outil dédié. La phrase induit en erreur et entretient une collision de vocabulaire avec le concept interne d'« introspection » (réponse gray-zone des agents).

**Recommandation.** Supprimer ou reformuler la phrase (« les schémas sont exposés via la découverte standard MCP `tools/list` »). Vérifier qu'aucune autre doc ne mentionne cet outil.

---

#### documentation-06 — SECURITY.md : table des versions supportées périmée de trois minors

- **Sévérité** : Medium — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `SECURITY.md:15`
- **Effort** : S

**Preuve.** « | 0.10.x | Yes (current minor) | 0.9.x | Yes | < 0.9 | No » alors que `package.json:3` indique 0.13.0 et que le CHANGELOG liste 0.11/0.12/0.13 livrées.

**Explication.** Le document affiché dans l'onglet Security de GitHub affirme que 0.10.x est la minor courante et que les correctifs visent « the latest minor release » — un chercheur ou un utilisateur ne peut pas savoir si 0.11-0.13 sont couvertes. Pour un projet qui met en avant OAuth/audit/SOC 2, c'est une incohérence visible.

**Recommandation.** Remplacer la table par une politique auto-portante qui ne périme pas (« latest minor + N-1 ») ou ajouter la mise à jour de SECURITY.md à la checklist de release (release-please ne touche pas ce fichier).

---

#### documentation-07 — README figé à v0.11.0 : tags Docker, compteurs de tests et section Support périmés

- **Sévérité** : Medium — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `README.md:96` (aussi lignes 48, 85, 97-98, 542)
- **Effort** : S

**Preuve.** `README.md:85/96-98` recommandent `docker pull ghcr.io/swoofer/mcp-coordinator:0.11.0` (« Pinned exact version — recommended for production ») et ligne 97 « Auto-bumps within the 0.11.x patch series » ; ligne 48 « 1740+ tests across 170 files » ; ligne 542 « v0.11.0 shipped with 1740+ tests ». Le projet est en 0.13.0 (2 minors livrées depuis), avec 177 fichiers de test et ~2317 tests (`HANDOFF.md:18`) ; la landing `docs/index.html` et `examples/docker-compose` ont, eux, été mis à jour à 0.13.0.

**Explication.** Le README (page npm + GitHub, document le plus lu) fait pinner aux utilisateurs une image deux minors en retard — donc sans les fix stdio (#135) ni Channels — pendant que la landing page et les exemples disent 0.13.0. Les statistiques de tests, argument de confiance mis en avant, sont également périmées.

**Recommandation.** Passer les références de version du README en 0.13.0 et, mieux, remplacer les versions en dur par des tournures stables (lien vers Releases) ; ajouter « grep des versions dans README » à la checklist post-release déjà décrite dans HANDOFF.md (qui couvrait la landing mais pas le README).

---

#### documentation-08 — `usage.md` « Push vs polling » contredit le README et `operating-modes.md` : Channels (v0.12) y est absent

- **Sévérité** : Medium — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `docs/usage.md:154`
- **Effort** : S

**Preuve.** `usage.md:154` : « If you want real-time push ... use essaim. ... mcp-coordinator alone supports the polling model » — aucune mention de `mcp-coordinator channel` ni de `docs/operating-modes.md` dans tout `usage.md`, alors que `README.md:76` et `operating-modes.md:5` présentent le push Channels (v0.12+) comme le second mode officiel.

**Explication.** Le guide d'usage — document vers lequel le README renvoie 5 fois comme « the usage guide » — affirme que le seul chemin push est un projet externe (essaim), ce qui est faux depuis v0.12. Un lecteur qui entre par `usage.md` ignore l'existence du mode push natif et de son guide de décision.

**Recommandation.** Mettre à jour la section « Push vs polling » : mentionner `mcp-coordinator channel` (research preview) et pointer vers `docs/operating-modes.md` et `examples/channels-quickstart/`, en gardant essaim comme option orchestrateur.

---

#### documentation-09 — Variables `COORDINATOR_LOGIN_LOCKOUT_*` documentées mais codées en dur (le JSDoc du module affirme lui-même le contraire)

- **Sévérité** : Medium — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `.env.example:111` (aussi `src/auth/login-lockout.ts:8`, `docs/ops/audit-integrity.md:158`)
- **Effort** : S

**Preuve.** `.env.example:110-113` documente `COORDINATOR_LOGIN_LOCKOUT_THRESHOLD/WINDOW/DURATION`. `src/auth/login-lockout.ts:8` : « Env overrides flow through T44 getOrgSetting » — mais le fichier n'appelle jamais `getOrgSetting` : lignes 57-58 et 79-80 utilisent les constantes `DEFAULT_LOCKOUT_THRESHOLD=5` / `DEFAULT_LOCKOUT_WINDOW_SECONDS` en dur. Idem `docs/ops/audit-integrity.md:158` qui évoque `COORDINATOR_SWEEPER_ENABLED=false` (« if you have that toggle ») : le toggle n'existe pas (`src/sweeper/index.ts`, aucune lecture d'env).

**Explication.** Un opérateur régulé qui règle le seuil de lockout via .env croit durcir sa politique alors que rien ne change. Le commentaire d'en-tête du module documente lui-même un branchement env jamais écrit — contrairement aux retentions du sweeper (`refresh/audit_retention_days`) où le pattern `getOrgSetting` est bien implémenté (`src/sweeper/index.ts:129-135`, vérifié).

**Recommandation.** Brancher les trois valeurs sur `getOrgSetting` (pattern déjà en place, ~3 lignes) ou commenter les variables dans `.env.example` comme « planned » ; corriger le JSDoc de `login-lockout.ts` et la mention de `audit-integrity.md`.

---

#### documentation-10 — Les commandes `server backup` / `server restore` existent mais ne sont documentées nulle part — pas même dans le runbook backup-restore

- **Sévérité** : Medium — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `docs/ops/backup-restore.md:1`
- **Effort** : S

**Preuve.** `cli/server/backup.ts:102` : `new Command("backup").description("Snapshot the coordinator config + SQLite database to a tar.gz...")` ; `backup.ts` et `restore.ts` sont enregistrés dans `cli/server/index.ts:6-7`. Grep « server backup/restore » : absent du README (table CLI lignes 303-313), de `docs/usage.md`, et de `docs/ops/backup-restore.md` (le runbook ne parle que de Litestream).

**Explication.** Une feature de sauvegarde intégrée, livrée et testée (`tests/unit/backup-restore.test.ts`), est invisible pour l'utilisateur : le runbook officiel de backup oriente vers Litestream sans mentionner l'outil natif adapté au profil solo/petite équipe. C'est exactement le genre d'écart qui fait perdre des données à un early adopter (« je ne savais pas qu'il y avait un backup intégré »).

**Recommandation.** Ajouter les deux commandes à la table CLI du README, une section « Backup rapide » dans `usage.md`, et un paragraphe « option intégrée vs Litestream » en tête de `docs/ops/backup-restore.md`.

---

### Sévérité LOW / INFO

#### documentation-11 — Exemple `custom-idp-provider` périmé et auto-contradictoire (parle de v0.9, « GitHub only », référence un fichier absent)

- **Sévérité** : Low — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `examples/custom-idp-provider/google-provider.ts:6`
- **Effort** : S

**Preuve.** `google-provider.ts:6-7` : « Phase 2 ships with GitHubProvider only; multi-provider registration is Phase 4 » et ligne 10 : « see oidc-provider.ts (not included here) » — alors que le README du même dossier (ligne 9) dit « v0.9.0 ships with GitHubProvider AND GoogleProvider built in », et que `src/auth/providers/` contient `github.ts`, `github-app.ts`, `google.ts` ET `oidc.ts` (4 IdPs livrés, conformes au README racine).

**Explication.** Trois strates de fraîcheur se contredisent dans le même dossier : l'en-tête du .ts (époque « GitHub only »), le README de l'exemple (époque v0.9), et la réalité v0.13 (OIDC livré). L'exemple est explicitement « documentation-by-code » non compilée (hors tsconfig), donc aucune CI ne le fait vieillir correctement.

**Recommandation.** Rafraîchir l'en-tête de `google-provider.ts` et le statut du README de l'exemple (les 4 providers sont livrés ; l'exemple ne sert plus qu'à « écrire un 5e IdP »), et supprimer la référence à `oidc-provider.ts` ou pointer vers `src/auth/providers/oidc.ts`.

---

#### documentation-12 — `docs/` pollué : 132 fichiers internes (superpowers) publiés sur GitHub Pages + backup HTML de 204 Ko versionné, sans index de navigation

- **Sévérité** : Low — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `docs/superpowers`
- **Effort** : S

**Preuve.** `find docs -name '*.md'` : 132 fichiers sous `docs/superpowers/` (plans, specs, audits internes du type « working/audit/code/07-security.md ») contre 24 docs utilisateur/ops ; `git ls-files` confirme `docs/index.html.backup-pre-redesign-2026-05-09` (204 Ko) versionné et servi par Pages ; `docs/robots.txt` « Allow: / » rend le tout crawlable ; aucun `docs/README.md` d'index.

**Explication.** 85 % du contenu de `docs/` est du matériau de travail interne (dont d'anciens rapports d'audit sécurité) publié tel quel sur le site. Pour un nouveau contributeur, distinguer la doc de référence des brouillons demande de connaître la convention « superpowers = interne ». Le backup HTML versionné gonfle le repo et le site pour rien (la vraie sauvegarde est l'historique git).

**Recommandation.** Supprimer le fichier `.backup-*` du suivi git ; ajouter un `docs/README.md` de ~15 lignes qui liste les docs utilisateur/ops et marque `superpowers/` comme archives internes (ou déplacer `superpowers/` hors de la racine Pages et l'exclure du sitemap/robots).

---

#### documentation-13 — Petits chiffres périmés disséminés : « 23 MCP tools » en commentaire, « 16 routes » vs 17, « ~70 variables » vs 55, « 29 metrics » vs 32

- **Sévérité** : Low — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `src/server-setup.ts:179`
- **Effort** : S

**Preuve.** `src/server-setup.ts:179` : « S1: all 23 MCP tools registered » (il y en a 26) ; `docs/openapi-README.md:4` « 16 routes » alors que `openapi.yaml` compte 17 paths (et `README.md:359` dit 17) ; `README.md:458` « ~70 variables » alors que `.env.example` en contient 55 ; `README.md:217` « 29 metrics » vs 32 dans `src/observability/metrics.ts`.

**Explication.** Aucun de ces écarts n'est bloquant, mais les compteurs en dur vieillissent systématiquement mal et érodent la confiance quand un lecteur vérifie — ce qu'un contributeur consciencieux fera.

**Recommandation.** Corriger les quatre valeurs en une passe ; préférer des formulations non chiffrées (« tous les outils MCP », « la référence env complète ») partout où le chiffre n'apporte rien.

---

#### documentation-14 — CONTRIBUTING.md n'explique pas comment reproduire localement le job Lint de la CI

- **Sévérité** : Low — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `CONTRIBUTING.md:41`
- **Effort** : S

**Preuve.** La section Development liste install/test/build/cli, mais `.github/workflows/lint.yml:31-35` exécute `bash scripts/lint-run-all.sh` puis `pnpm exec tsc --noEmit` — ni l'un ni l'autre n'est mentionné, et il n'existe pas de script `pnpm lint` dans `package.json`. `pnpm test:e2e` (Playwright) n'est pas mentionné non plus.

**Explication.** Un contributeur externe (le projet en a depuis v0.11) découvre les lint gates seulement quand la CI échoue, et doit fouiller les workflows pour comprendre quoi lancer. Friction faible mais récurrente, facile à éliminer.

**Recommandation.** Ajouter à CONTRIBUTING : `bash scripts/lint-run-all.sh && pnpm exec tsc --noEmit` (ou créer un script `pnpm lint` agrégateur, référencé par la CI et la doc), plus une ligne sur `pnpm test:e2e`.

---

#### documentation-15 — La roadmap du README liste comme futures des features SDK déjà livrées (keytar, profils TOML)

- **Sévérité** : Info — **Statut** : ⚠️ Non contre-vérifié
- **Fichier** : `README.md:527`
- **Effort** : S

**Preuve.** `README.md:527` : « SDK polish — keytar keychain integration, ... named-profile TOML config » présenté comme roadmap, alors que `sdk/README.md` décrit T40c (profils TOML + cache discovery) et T40d (KeytarTokenStore) comme livrés, et que `sdk/src/keytar-store.ts` et `sdk/src/profiles.ts` existent avec leurs tests.

**Explication.** La roadmap sous-vend le SDK : deux des trois items annoncés « à venir » sont déjà implémentés et documentés. Seul Windows DPAPI reste réellement futur.

**Recommandation.** Mettre à jour l'item roadmap : ne garder que DPAPI (et éventuellement la publication npm du SDK, aujourd'hui `private: true`), et pointer vers `sdk/README.md` pour ce qui est livré.

---

## 4. Recommandations priorisées

### Quick wins (effort S)

1. **[documentation-01 — High]** À minima immédiatement : corriger `usage.md` et `.env.example` sur `COORDINATOR_BIND` et le défaut de bind (la promesse « default is 127.0.0.1 » est fausse et à portée sécurité). L'implémentation de la variable (défaut loopback) est le vrai fix, mais la correction doc ne doit pas attendre.
2. **[documentation-07 — Medium]** Passe de version sur le README : tags Docker 0.11.0 → 0.13.0, compteurs de tests, section Support ; ajouter « grep des versions dans README » à la checklist post-release de HANDOFF.md.
3. **[documentation-06 — Medium]** SECURITY.md : remplacer la table de versions par une politique auto-portante (« latest minor + N-1 »).
4. **[documentation-03 — Medium]** Réécrire la section Quota Pre-flight du README : supprimer `MAX_QUOTA_PCT`, documenter macOS-only/Keychain et le 503 sur Linux/Windows/Docker.
5. **[documentation-05 — Medium]** Supprimer/reformuler la phrase sur l'outil MCP « introspection » (pointer vers `tools/list`).
6. **[documentation-08 — Medium]** Mettre à jour « Push vs polling » de `usage.md` (mentionner `mcp-coordinator channel` + `operating-modes.md`).
7. **[documentation-09 — Medium]** Brancher les lockout sur `getOrgSetting` (~3 lignes, pattern existant) ou marquer les variables « planned » ; corriger le JSDoc.
8. **[documentation-10 — Medium]** Documenter `server backup`/`server restore` (table CLI du README, `usage.md`, en-tête de `docs/ops/backup-restore.md`).
9. **[documentation-11 à -15 — Low/Info]** Passe de nettoyage groupée : en-têtes de `custom-idp-provider`, dé-versionner le backup HTML + `docs/README.md` d'index, corriger les quatre compteurs, compléter CONTRIBUTING (lint local, e2e), rafraîchir la roadmap SDK.

### Chantiers (effort M)

10. **[documentation-02 — High]** Câbler `handleMetrics` sur `/metrics/auth` dans `serve-http.ts` + test d'intégration HTTP qui scrape réellement l'endpoint (le handler complet existe déjà ; c'est probablement un oubli de wiring). Alternative : purger l'endpoint de toute la chaîne documentaire (README, OpenAPI, onboarding, runbooks, alertes, Grafana).
11. **[documentation-04 — Medium]** Multi-instances : faire suivre le PID file au `--data-dir` dans `cli/server/start.ts`/`stop.ts`, ou réécrire la section de `usage.md` (une seule instance daemonisée gérée ; foreground + gestionnaire de process pour le reste).

### Mesures structurelles

- **Checklist de release** : étendre la checklist post-release (HANDOFF.md) au README (versions, compteurs) et à SECURITY.md — release-please ne touche ni l'un ni l'autre.
- **Test de véracité doc/env** : un test qui grep les `COORDINATOR_*` de `.env.example` et vérifie qu'elles sont lues quelque part dans `src/`+`cli/` aurait attrapé les constats 01, 02 (bearer), 03 et 09 d'un coup.

---

## 5. Annexe — Constats écartés après contre-vérification

Aucun constat n'a été réfuté (verdict REFUTED) lors de la contre-vérification adversariale. Les deux constats de sévérité high (documentation-01 et documentation-02) ont été vérifiés point par point et **confirmés** ; les constats de sévérité medium et inférieure n'ont pas fait l'objet d'une contre-vérification systématique et sont marqués en conséquence dans le corps du rapport.

Note de précision issue de la contre-vérification de documentation-02 : la description mentionnait « 32 métriques » là où le README en annonce 29 — écart sans incidence sur le constat (l'endpoint n'existe pas quel que soit le compte ; le décompte 29 vs 32 est traité dans documentation-13).
