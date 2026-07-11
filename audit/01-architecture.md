# Audit — Dimension 1 : Architecture & structure

**Projet** : mcp-coordinator v0.13.0 — Embedded MQTT broker + MCP server for multi-agent coordination
**Date de l'audit** : 2026-07-03
**Score** : **6.5 / 10**
**Verdict global** : une architecture à deux vitesses — un sous-système OAuth (Phase 2) exemplaire cohabite avec un noyau Phase 1 à singletons et un point d'entrée HTTP monolithique, et le défaut le plus grave (deux endpoints implémentés mais jamais montés) révèle que les contrats entre modules ne sont jamais vérifiés en intégration bout-en-bout.

---

## 1. Résumé exécutif

L'architecture du projet présente un contraste marqué entre deux générations de code.

D'un côté, le **sous-système Phase 2 OAuth** (`src/auth/`, `src/boot.ts`) est exemplaire : composition root avec injection de dépendances, `Clock` injectable, registre de providers en pattern stratégie, discipline de configuration imposée par des scripts de lint custom, couverture 100 % branch imposée fichier par fichier. De l'autre, le **noyau Phase 1** repose sur des singletons au niveau module — base de données globale via `getDb()`, état mutable dans `serve-http.ts` — et un god-module d'entrée HTTP de 763 lignes qui concentre 62 % du churn des commits.

Les frontières entre `src/`, `cli/`, `sdk/` et `dashboard/` sont nettes, et **aucun cycle d'import runtime n'existe** (vérifié par analyse du graphe d'imports sur 139 fichiers) : les 8 cycles détectés passent tous par des `import type`, effacés à la compilation.

Le défaut le plus grave est un **problème de câblage inter-composants** : deux endpoints (`/.well-known/oauth-authorization-server` et `/metrics/auth`) sont implémentés, testés unitairement, documentés dans l'OpenAPI et consommés par le SDK et la commande `doctor`, mais **ne sont jamais montés sur le serveur HTTP**. Plusieurs dérives de duplication (allowlist env du daemon, divergence REST vs MCP, défauts de data-dir contradictoires) confirment le même motif structurel : les contrats entre modules ne sont vérifiés que par des tests unitaires isolés, jamais en intégration à travers un serveur réellement démarré.

L'architecture supporte la croissance sans réécriture majeure. En revanche, la sérialisation forcée des tests (`fileParallelism: false`, conséquence directe du singleton DB) et l'entrée HTTP monolithique deviendront des points de friction croissants pour les contributeurs externes que le projet accueille depuis la v0.11.

---

## 2. Points forts

| # | Point fort | Détail |
|---|-----------|--------|
| 1 | **Zéro cycle d'import à l'exécution** | Les 8 cycles du graphe (139 fichiers src/cli/sdk) passent tous par des `import type` de `CoordinatorServices`, effacés à la compilation. Le pattern « les tools importent le type, `server-setup` importe les fonctions » est appliqué uniformément aux 6 modules de `src/tools/`. |
| 2 | **Composition root Phase 2 exemplaire** (`src/boot.ts`) | Validation fail-closed des variables d'environnement, `AuthHandlerContext` injecté dans chaque handler, `Clock` injectable pour les tests, `ProviderRegistry` en pattern stratégie (GitHub / GitHub App / Google / OIDC), `BootPhase2Deps` optionnel pour injecter db/env/logger en test. |
| 3 | **Discipline de configuration outillée** | `scripts/lint-no-direct-env-in-auth.sh` interdit les lectures `process.env.COORDINATOR_*` hors `boot.ts` et du shim `org-settings.ts` ; 4 autres lints bash custom (html-escape, no-audit-mutation, no-current-timestamp, no-users-org-id). |
| 4 | **Abstraction de persistance minimale et documentée** (`src/db-adapter.ts`) | Contrat strict sous-ensemble de better-sqlite3 également satisfait par bun:sqlite, helper `withTransaction` canonique ; migrations versionnées (`PRAGMA user_version=9`) avec garde anti-downgrade et backfill idempotent transactionnel (`database.ts:55-88`). |
| 5 | **Extraction du code partagé entre transports avec rationale écrite** | `src/announce-workflow.ts` documente pourquoi l'orchestration est partagée mais pas les shapes de réponse (des consommateurs downstream dépendent des payloads exacts). |
| 6 | **`startServer()` proprement embeddable** | `ServerHandle.stop()` idempotent avec séquence de teardown ordonnée (HTTP → bridge MQTT → broker → timers → DB), opt-out `registerSignalHandlers`, ports MQTT paramétrables par appel (`serve-http.ts:363-752`). |
| 7 | **Hygiène des points d'entrée** | `src/index.ts` utilise `pathToFileURL` pour le guard `isMainModule` (correct sous Windows) ; les claims stdio synthétiques sont documentés comme contrat de confiance explicite. |
| 8 | **Dette connue systématiquement balisée** | Les hardcodes `org='default'` aux frontières MQTT/quota portent tous un `TODO(Task 22)` avec explication du plan de résorption. |
| 9 | **Investissement test massif** | Ratio tests/code de 2,6:1 (51 k lignes de tests pour 20 k de src), seuils de couverture 100 % branch imposés fichier par fichier sur ~50 fichiers sécurité-critiques dans `vitest.config.ts`. |
| 10 | **Choix de frontière documenté dans le CLI channel** | `cli/channel.ts` explique explicitement pourquoi MQTT est le bus canonique plutôt qu'un couplage à la surface HTTP du daemon, diagramme ASCII à l'appui. |

---

## 3. Constats détaillés

Légende des statuts de vérification :
✅ confirmé par contre-vérification adversariale · ⚠️ non contre-vérifié (sévérité medium ou moins) · ❓ incertain

### 3.1 Sévérité HIGH

#### architecture-01 — Endpoints implémentés et documentés mais jamais montés sur le serveur (`/.well-known/oauth-authorization-server` et `/metrics/auth`)

- **Sévérité** : HIGH · **Statut** : ✅ confirmé · **Effort** : M
- **Localisation** : `src/discovery.ts:40` et `src/http/metrics.ts:61`

**Preuve.** `src/discovery.ts:40` exporte `handleDiscovery(` et `src/http/metrics.ts:61` exporte `handleMetrics(` — un grep sur tout `src/` montre qu'aucun fichier n'importe ces handlers hors de leurs propres tests unitaires. `auth-routes.ts:73` affirme « Discovery doc (T14) is wired separately by serve-http.ts at boot », mais `serve-http.ts` ne l'importe pas ; `tests/unit/auth-routes.test.ts:161` teste même que le dispatcher retourne `false` « (wired separately) ». Le dispatcher `dispatchAuthRoutes` n'est appelé que pour `url.startsWith("/api/auth/")` (`serve-http.ts:526`), donc `/.well-known` est structurellement inatteignable par ce chemin.

**Explication.** Deux handlers HTTP complets, testés unitairement à 100 % de couverture, ne sont raccordés à aucune route. Or ils ont des consommateurs réels :

- `sdk/src/discovery.ts:6` fetch `/.well-known/oauth-authorization-server` ;
- `cli/doctor.ts:188-222` sonde l'URL et retourne severity `fail` sur tout statut non-2xx — le check `doctor` échouera **toujours** sur un déploiement OAuth réel ;
- `docs/openapi.yaml:867/901` et `docs/onboarding-self-host.md:489` documentent `/metrics/auth` ;
- `.env.example:143` documente `COORDINATOR_METRICS_BEARER`, qui n'est lu **nulle part** dans `src/`.

Toute requête vers ces URLs tombe dans le catch-all de `serve-http.ts` → 401/404. Conséquence aggravante côté sécurité : un opérateur qui suit la doc croit protéger ses métriques par bearer alors que le `/metrics` réellement servi (`serveMetrics`, `src/metrics.ts`) reste **sans contrôle d'accès** — le contrôle documenté est un no-op.

Le défaut a survécu parce que chaque composant est testé isolément (handler en unit, dispatcher en unit) mais **aucun test d'intégration ne fait un GET sur ces chemins via un serveur démarré**. Échec garanti (non probabiliste) sur trois surfaces livrées (OAuth discovery du SDK, doctor, contrat OpenAPI) : la sévérité high est justifiée.

**Recommandation.** Monter les deux routes dans `serve-http.ts` (avant le dispatch Phase 2 : `if (url === "/.well-known/oauth-authorization-server") return handleDiscovery(req, res, publicUrl)` quand `phase2Bootstrap` est actif ; idem pour `/metrics/auth` avec `COORDINATOR_METRICS_BEARER`), puis ajouter un test d'intégration qui démarre `startServer` avec OAuth activé et vérifie les deux endpoints en HTTP réel.

---

### 3.2 Sévérité MEDIUM

#### architecture-02 — État mutable au niveau module dans `serve-http.ts` contredit le contrat d'embedding multi-instance documenté

- **Sévérité** : MEDIUM · **Statut** : ⚠️ non contre-vérifié · **Effort** : L
- **Localisation** : `src/serve-http.ts:67`

**Preuve.** `let services: CoordinatorServices; let httpLog: Logger; ... let currentRunConfig: ... | null = null;` (lignes 67-71), réassignés à chaque appel de `startServer` (ligne 370). Or la docstring de `ServerOptions` (ligne 343) annonce : « essaim's orchestrator runs many in-process coordinators per session », et `src/metrics.ts` justifie son `Registry` par-instance par ce même scénario multi-instance.

**Explication.** Le handler de requêtes créé par chaque `startServer()` référence les variables module-level `services`, `httpLog`, `currentRunConfig`. Un deuxième appel à `startServer()` dans le même process réassigne ces variables : les requêtes du premier serveur utilisent alors les services (et la DB, voir architecture-03) du second. Le scénario multi-instance en-process est explicitement revendiqué par les commentaires, mais structurellement cassé. Les constantes env (PORT, AUTH_ENABLED, secrets — lignes 49-65) sont aussi figées à l'import du module, ce que le code reconnaît lui-même comme problème (ligne 366 : « Resolve MQTT ports per-call so tests/embedders can override module-load env values ») sans l'appliquer aux autres variables.

**Recommandation.** Deux options selon l'ambition : (a) **pragmatique** — déclarer officiellement `startServer` mono-instance-par-process (assert + throw au 2e appel sans `stop()`, retirer les mentions multi-instance des commentaires) ; (b) **structurelle** — déplacer `services`/`httpLog`/`currentRunConfig` dans une closure de `startServer` et passer le contexte aux handlers, comme le fait déjà `RestContext` pour `handle-rest.ts` (le pattern d'extraction S1 existe déjà). L'option (a) coûte une heure et lève l'ambiguïté ; (b) est la vraie correction si l'embedding essaim est un cas d'usage réel.

#### architecture-03 — Base de données en singleton global (service locator) : couple tout le domaine à un état de process et force les tests en série

- **Sévérité** : MEDIUM · **Statut** : ⚠️ non contre-vérifié · **Effort** : L
- **Localisation** : `src/database.ts:17`

**Preuve.** `let db: DatabaseAdapter;` (ligne 17), réassigné par `initDatabase(dataDir)` (lignes 357-362) ; `getDb()` appelé **82 fois dans 22 fichiers** (agent-registry, consultation, file-tracker, auth, audit, sse-emitter…). `vitest.config.ts:10` : `fileParallelism: false`.

**Explication.** Toutes les classes domaine (`AgentRegistry`, `Consultation`, `FileTracker`…) reçoivent leurs collaborateurs par constructeur mais accèdent à la DB via le locator global `getDb()`. Conséquences concrètes : (1) impossible d'avoir deux coordinateurs en-process avec des `dataDir` différents — le second `initDatabase` repointe la DB du premier ; (2) la suite de 203 fichiers de tests tourne en série, ce qui allongera linéairement le temps de CI à mesure que le projet grossit ; (3) chaque test doit initialiser l'état global dans le bon ordre. Point atténuant : le pattern est appliqué uniformément (une seule façon d'accéder à la DB), ce qui rendrait la migration mécanique.

**Recommandation.** Ne pas tout réécrire (YAGNI), mais arrêter l'hémorragie : ajouter `db: DatabaseAdapter` à `CoordinatorServices`, l'injecter dans les constructeurs des classes domaine au fil des retouches (elles ont déjà des constructeurs), et réserver `getDb()` comme fallback legacy. Objectif de moyen terme : réactiver `fileParallelism` pour la CI.

#### architecture-04 — Les handlers SIGINT/SIGTERM du CLI en mode foreground court-circuitent le graceful shutdown du serveur

- **Sévérité** : MEDIUM · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `cli/server/start.ts:122`

**Preuve.** `process.on("SIGINT", () => { cleanup(); process.exit(0); });` (lignes 122-123), enregistré **avant** `await startServer({ port, dataDir })` (ligne 127), qui enregistre ses propres handlers gracieux via `process.once` (`serve-http.ts:747-748`).

**Explication.** Les listeners d'un même signal s'exécutent dans l'ordre d'enregistrement : le handler du CLI (supprimer `server.pid` puis `process.exit(0)`) s'exécute en premier et termine le process immédiatement. Le `stop()` gracieux de `serve-http.ts` (drain de la queue d'audit Phase 2, déconnexion MQTT propre, fermeture DB, arrêt des sweepers) ne s'exécute donc **jamais** quand le serveur est lancé via `mcp-coordinator server start` en foreground. La séquence de teardown soigneusement construite (fix B6) n'est effective que pour `pnpm start`/node direct et les embedders. Perte potentielle : événements d'audit Tier 2 en batch non écrits à l'arrêt Ctrl+C.

**Recommandation.** Dans `cli/server/start.ts`, remplacer les handlers : récupérer le handle retourné (`const handle = await startServer({ ..., registerSignalHandlers: false })`) puis enregistrer un unique handler qui fait `await handle.stop(); cleanup(); process.exit(0)`.

#### architecture-05 — L'allowlist env du mode daemon a dérivé : OAuth Phase 2 et rotation JWT silencieusement désactivés

- **Sévérité** : MEDIUM · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `cli/server/start.ts:66`

**Preuve.** Le `childEnv` explicite (lignes 66-96) forwarde `COORDINATOR_JWT_SECRET`, `AUTH_ENABLED`, les vars Layer4 et encryption, mais **pas** : `COORDINATOR_OAUTH_ENABLED`, `COORDINATOR_PUBLIC_URL`, `COORDINATOR_GITHUB_CLIENT_ID/SECRET`, `COORDINATOR_GITHUB_ORG`, `COORDINATOR_JWT_PREV_SECRET`, `COORDINATOR_SSE_HEARTBEAT_MS` (tous lus par `serve-http.ts`/`boot.ts`).

**Explication.** L'approche allowlist (justifiée par un bon motif de sécurité : ne pas transmettre `AWS_*`/`GITHUB_TOKEN` au daemon) duplique la surface env du serveur dans le CLI, et cette duplication a déjà dérivé : un opérateur qui lance `mcp-coordinator server start --daemon` avec OAuth configuré dans son environnement obtient un daemon en mode Phase 1 **sans aucun message d'erreur** (`bootPhase2` retourne `null` quand `OAUTH_ENABLED` n'est pas `'true'`). Idem pour la rotation de secret JWT Phase 1 (`JWT_PREV_SECRET` absent → les anciens tokens 401 immédiatement). C'est le symptôme classique d'une liste de config dupliquée sans source de vérité partagée.

**Recommandation.** Extraire la liste des vars serveur dans un module partagé (ex. `src/config-env.ts` exportant `COORDINATOR_ENV_KEYS`) consommé à la fois par le forward du daemon et par la doc `.env.example` ; à défaut, forwarder tout préfixe `COORDINATOR_*` + `PORT`/`LOG_LEVEL`/`NODE_ENV` (le préfixe est déjà un namespace sûr) et garder l'exclusion des secrets tiers.

#### architecture-06 — Défauts de répertoire de données divergents entre points d'entrée, et contraires au README

- **Sévérité** : MEDIUM · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `src/serve-http.ts:50`

**Preuve.** `serve-http.ts:50` et `index.ts:16` : `process.env.COORDINATOR_DATA_DIR || "./data"` (relatif au cwd) ; `cli/config.ts:18` : `join(homedir(), ".mcp-coordinator", "data")` ; `README.md:450` documente le défaut comme `~/.mcp-coordinator/data`.

**Explication.** Trois vérités coexistent pour l'emplacement des données. Un utilisateur qui suit le README et lance `pnpm start`, `node dist/src/serve-http.js` ou l'entrée stdio via son `.mcp.json` obtient une base SQLite dans `./data` relatif au cwd du process (imprévisible pour un serveur MCP spawné par un client), pas dans `~/.mcp-coordinator/data`. Résultat concret : bases de données orphelines éparpillées, et impression de perte de données quand on change de méthode de lancement (le CLI et le direct-node ne voient pas la même base). Docker est protégé (`ENV COORDINATOR_DATA_DIR=/data/data` dans le Dockerfile) mais les autres chemins non-CLI ne le sont pas.

**Recommandation.** Unifier le fallback : faire pointer les deux entry points src sur le même défaut que le CLI (petite fonction partagée `defaultDataDir()` retournant `~/.mcp-coordinator/data`), ou a minima corriger le README pour documenter le vrai défaut `./data` hors CLI et logger un warning au boot quand le fallback cwd-relatif est utilisé.

#### architecture-07 — Dérive comportementale entre les transports REST et MCP sur le flux d'enregistrement d'agent

- **Sévérité** : MEDIUM · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `src/http/handle-rest.ts:59`

**Preuve.** REST `/api/register` (`handle-rest.ts:59-63`) : `registry.register` + `sseEmitter.emit` seulement. Tool MCP `register_agent` (`tools/agents-tools.ts:27-29`) : `registry.register` + `sseEmitter.emit` + `mqttBridge.registerAgent(agent_id, name)` qui publie le statut retained sur `coordinator/<org>/agents/<id>/status`.

**Explication.** Le même geste métier (enregistrer un agent) produit des effets différents selon le transport : un agent enregistré via REST n'a pas de statut retained MQTT, donc les abonnés MQTT (dont `mcp-coordinator channel`) ne le voient pas online. Le projet a déjà identifié et résolu ce problème de duplication pour le flux announce (`src/announce-workflow.ts`, extrait avec rationale documentée), mais les flux register/session-stop restent dupliqués dans les deux transports. Chaque nouvel endpoint bi-transport recrée le risque.

**Recommandation.** Appliquer le pattern announce-workflow existant : extraire un `runRegisterFlow(services, org, agentId, name, modules)` partagé (registry + SSE + MQTT retained) appelé par les deux transports, et trancher explicitement si l'absence de publish MQTT côté REST était voulue (si oui, le documenter au call site comme announce-workflow le fait).

#### architecture-08 — Org `'default'` codé en dur aux frontières MQTT et quota alors que le multi-org est livré

- **Sévérité** : MEDIUM · **Statut** : ⚠️ non contre-vérifié · **Effort** : M
- **Localisation** : `src/serve-http.ts:644`

**Preuve.** `services.registry.setOffline("default", agentId);` dans le handler `onOffline` MQTT (`serve-http.ts:644`), avec TODO explicite : « becomes a correctness bug the moment multi-org goes live » ; idem quota/SSE dans `server-setup.ts:101-119` (`quota_update` émis uniquement vers `org_id` `'default'`).

**Explication.** La création d'orgs supplémentaires est livrée (admin UI orgs v0.10.6, provisioning OAuth), mais les chemins MQTT (offline/LWT) et quota ne portent pas d'`org_id` : un agent d'un org non-default qui se déconnecte du broker reste « online » indéfiniment dans son registre (`setOffline('default', id)` ne matche rien), et les événements quota ne parviennent qu'au dashboard de l'org default. La dette est connue et balisée (TODO Task 22 systématiques), mais la fenêtre entre « multi-org activable » et « multi-org correct » est ouverte aujourd'hui.

**Recommandation.** Prioriser Task 22 (scoping des topics MQTT par org + ACL Aedes) avant toute promotion du multi-org dans la doc utilisateur ; à court terme, documenter dans `docs/operating-modes.md` que le multi-org est expérimental côté MQTT/quota, ou refuser la création d'un 2e org tant que le scoping MQTT n'est pas livré (fail-closed, cohérent avec la posture boot).

---

### 3.3 Sévérité LOW / INFO

#### architecture-09 — Double pile logger/metrics Phase 1 vs Phase 2 : la redaction Pino ne couvre pas le chemin de requêtes principal

- **Sévérité** : LOW · **Statut** : ⚠️ non contre-vérifié · **Effort** : M
- **Localisation** : `src/observability/logger.ts:51`

**Preuve.** Deux modules Logger incompatibles : `src/logger.ts` (interface Logger maison, hybride console/pino, **pas de redaction**) utilisé par `serve-http`/`httpLog`/`authLog` ; `src/observability/logger.ts` (`PinoLogger` avec 17 chemins de redaction NR4 : `authorization`, `cookie`, `*.access_token`…) utilisé seulement par `boot.ts` Phase 2. Idem métriques : `src/metrics.ts` (Registry par instance, injecté) vs `src/observability/metrics.ts` (compteurs singletons module, « SEPARATE Registry per V2 patches §B T37 »).

**Explication.** La séparation des deux registres Prometheus est documentée comme délibérée, mais la coexistence de deux types Logger crée deux régimes de sécurité de logs : le `httpLog`/`authLog` du chemin Phase 1 (qui loggue des URLs, IPs, agent_names sur chaque requête) n'a aucune redaction Pino, alors que la Phase 2 en a 17 chemins. Un futur `httpLog.info({ headers: req.headers })` ajouté par un contributeur fuiterait les tokens sans filet. Les deux patterns de métriques (instance vs singleton) envoient aussi des signaux contradictoires aux contributeurs sur « la » façon de faire.

**Recommandation.** Converger vers `src/observability/logger.ts` comme logger unique (ajouter l'option level/destination du logger Phase 1 et le fallback console pour Bun), en conservant les chemins de redaction pour tout le monde ; déprécier `src/logger.ts` avec un re-export temporaire.

#### architecture-10 — La Phase 2 contourne l'abstraction `DatabaseAdapter` par un double cast : portabilité Bun non garantie pour tout le sous-système OAuth

- **Sévérité** : LOW · **Statut** : ⚠️ non contre-vérifié · **Effort** : M
- **Localisation** : `src/serve-http.ts:402`

**Preuve.** `db: getDb() as unknown as DatabaseT.Database` (`serve-http.ts:402`) passé à `bootPhase2` ; tout `src/auth/` et `src/admin/` type ensuite `ctx.db` en better-sqlite3 natif et utilise `ctx.db.transaction(fn).immediate()` (`handle-admin-orgs.ts:276`). Les binaires GitHub Releases sont compilés Bun (`bun build --compile cli/index.ts`, `release-binaries.yml:50`) et utilisent bun:sqlite (`database.ts:358`).

**Explication.** `src/db-adapter.ts` définit soigneusement le contrat portable Node/Bun (« strict subset of better-sqlite3's API that Bun:sqlite also satisfies »), mais l'intégralité de la Phase 2 (auth, admin, sweeper, audit-queue) le contourne via un cast en `Database.Database` complet. Rien n'empêche donc un handler Phase 2 d'utiliser une API better-sqlite3 absente de bun:sqlite (`pragma()`, `iterate()`, `pluck()`…) : le type-checker validera, et l'échec n'apparaîtra qu'à l'exécution dans un binaire Bun avec `OAUTH_ENABLED=true` — combinaison qu'aucun test CI n'exerce aujourd'hui.

**Recommandation.** Au choix : (a) ajouter un job CI smoke qui lance le binaire Bun compilé avec `COORDINATOR_OAUTH_ENABLED=true` et déroule un flux token (protège le contrat au coût le plus bas) ; (b) documenter officiellement que les binaires Bun ne supportent pas OAuth (fail-fast au boot : si Bun && oauth → `BootValidationError`) ; (c) long terme, élargir `DatabaseAdapter` (transaction avec `.immediate`) et typer `AuthHandlerContext` dessus.

#### architecture-11 — Inversion de couche : `src/` importe `cli/version.ts`

- **Sévérité** : LOW · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `src/server-setup.ts:29`

**Preuve.** `import { getVersion } from "../cli/version.js";` (`server-setup.ts:29` et `serve-http.ts:25`) — les deux seuls imports src→cli du dépôt.

**Explication.** La direction de dépendance saine est cli → src (le CLI orchestre la lib serveur), respectée partout ailleurs (`cli/init.ts` → `src/boot.js`, `cli/doctor.ts` → `src/auth/entropy.js`). `getVersion` est un utilitaire feuille sans dépendance, donc pas de risque de cycle aujourd'hui, mais l'inversion brouille la règle pour les contributeurs et empêcherait de publier `src/` seul (le `package.json` inclut d'ailleurs `dist/cli/` dans `files` en partie pour cette raison).

**Recommandation.** Déplacer `getVersion` vers `src/version.ts` et faire de `cli/version.ts` un simple re-export (les chemins de résolution `package.json` `../..` fonctionnent à l'identique depuis `dist/src/`).

#### architecture-13 — Pas de carte d'architecture pour les contributeurs externes malgré 108 fichiers src et des conventions non évidentes

- **Sévérité** : LOW · **Statut** : ⚠️ non contre-vérifié · **Effort** : M
- **Localisation** : `CONTRIBUTING.md:47`

**Preuve.** Section Architecture de `CONTRIBUTING.md` : « See README.md for the high-level model. The server is in src/, the CLI in cli/, and the static dashboard in dashboard/public/ » — trois phrases pour ~26 000 lignes de code et des règles réelles mais implicites (env lu uniquement dans `boot.ts`, `DatabaseAdapter` obligatoire hors Phase 2, `import type` pour `CoordinatorServices`, seuils coverage 100 % dans `vitest.config.ts`).

**Explication.** Le projet a des conventions architecturales fortes et outillées (lints custom, patterns d'extraction documentés dans les en-têtes de fichiers) mais leur documentation est éclatée dans des commentaires de code et des références à des specs internes (« V3 §4.4 », « T29 », « S1 ») dont la légende n'est nulle part. Un contributeur externe — le projet en accueille depuis la v0.11 — ne peut pas découvrir où ajouter un endpoint (`handle-rest` ? `auth-routes` ? les deux conventions coexistent) ni pourquoi son PR échoue sur `lint-no-direct-env-in-auth` sans lire le script bash.

**Recommandation.** Écrire un `docs/ARCHITECTURE.md` d'une page : carte des répertoires, les deux générations (Phase 1 / Phase 2) et leurs conventions respectives, les règles imposées par les lints, le glossaire des références de specs (Txx/Vx/S1), et « comment ajouter un endpoint / un tool MCP ». Lier depuis `CONTRIBUTING.md`.

#### architecture-15 — Posture de validation d'entrée incohérente entre transports : zod côté MCP, casts bruts côté REST

- **Sévérité** : LOW · **Statut** : ⚠️ non contre-vérifié · **Effort** : M
- **Localisation** : `src/http/handle-rest.ts:60`

**Preuve.** `const { agent_id, name, modules } = body as { agent_id: string; name: string; modules: string[] };` (`handle-rest.ts:60`) — pattern répété sur ~15 endpoints REST ; les tools MCP valident les mêmes champs via zod (`agents-tools.ts:19-23` : `agent_id: z.string(), modules: z.array(z.string())`).

**Explication.** Les mêmes opérations métier ont deux niveaux de garantie selon le transport : un `modules` non-tableau posté sur `/api/register` traverse le cast TypeScript (fiction à l'exécution) jusqu'à `JSON.stringify`/DB, alors que le tool MCP équivalent le rejette proprement. Au-delà de la robustesse (dimension sécurité), c'est un problème de cohérence de pattern : un contributeur qui ajoute un endpoint REST n'a aucun schéma existant à imiter, alors que zod est déjà dans les dépendances et utilisé trois répertoires plus loin.

**Recommandation.** Définir des schémas zod partagés par opération (réutilisables par les tools MCP et les endpoints REST — les shapes sont quasi identiques) et remplacer progressivement les casts de `handle-rest.ts` par `safeParse` + 400 structuré, en commençant par les endpoints de mutation.

#### architecture-12 — `CoordinatorConfig` porte des champs de configuration morts (`authEnabled`, `jwtSecret`, `jwtExpiry`)

- **Sévérité** : INFO · **Statut** : ⚠️ non contre-vérifié · **Effort** : S
- **Localisation** : `src/types.ts:176`

**Preuve.** `export interface CoordinatorConfig { dataDir: string; authEnabled?: boolean; jwtSecret?: string; jwtExpiry?: string; }` — `createServices` (`server-setup.ts:53`) ne lit que `config.dataDir` ; l'auth est configurée exclusivement via env dans `serve-http.ts`.

**Explication.** Un embedder qui passe `createServices({ dataDir, authEnabled: true, jwtSecret })` croit configurer l'authentification alors que ces champs sont ignorés silencieusement — la vraie config passe par les constantes env module-level de `serve-http.ts`. Le type ment sur le contrat de l'API publique (`createServices` est réexporté par `src/index.ts`, donc surface npm). À noter aussi : `cli/config.ts` définit un second type nommé `CoordinatorConfig` de forme différente, source de confusion pour la navigation.

**Recommandation.** Supprimer les trois champs morts (ou les brancher réellement dans `startServer`, ce qui résoudrait au passage une partie d'architecture-02) et renommer l'un des deux types `CoordinatorConfig` (ex. `CliConfig` côté cli/).

#### architecture-14 — Dashboard principal : 63 Ko de HTML avec un unique script inline, contrastant avec les pages admin modulaires

- **Sévérité** : INFO · **Statut** : ⚠️ non contre-vérifié · **Effort** : L
- **Localisation** : `dashboard/public/index.html:238`

**Preuve.** `dashboard/public/index.html` : 63,2 Ko, un seul bloc `<script>` (ligne 238) contenant ~47 fonctions inline ; à côté, les pages admin sont éclatées en modules testés (`admin-common.js`, `admin-strings.js` avec seuils coverage 100 % dans `vitest.config.ts:106-107`).

**Explication.** Le dashboard historique est un monolithe HTML/JS inline non testable (aucune couverture possible sans extraction), tandis que les pages admin livrées en v0.10.6 suivent un pattern modulaire avec tests unitaires et CSP durcie. L'écart est cohérent avec l'histoire du projet, mais toute évolution du dashboard principal (le composant le plus visible du produit) se fait sans filet.

**Recommandation.** Pas urgent (YAGNI pour un mainteneur solo) ; lors de la prochaine évolution substantielle du dashboard, extraire le script inline vers `dashboard/public/app.js` sur le modèle admin (ce qui permettrait au passage de lui appliquer la même CSP sans `'unsafe-inline'`).

---

## 4. Recommandations priorisées

### Priorité immédiate

| Ordre | Constat | Action | Effort |
|-------|---------|--------|--------|
| 1 | architecture-01 (HIGH, ✅) | Monter `/.well-known/oauth-authorization-server` et `/metrics/auth` dans `serve-http.ts` + test d'intégration HTTP réel avec OAuth activé | M |

### Quick wins (S)

| Ordre | Constat | Action | Effort |
|-------|---------|--------|--------|
| 2 | architecture-04 | `registerSignalHandlers: false` + handler unique `await handle.stop()` dans `cli/server/start.ts` | S |
| 3 | architecture-05 | Source de vérité partagée pour l'allowlist env du daemon (ou forward par préfixe `COORDINATOR_*`) | S |
| 4 | architecture-06 | Unifier `defaultDataDir()` sur `~/.mcp-coordinator/data` (ou corriger README + warning au boot) | S |
| 5 | architecture-07 | Extraire `runRegisterFlow()` partagé REST/MCP sur le modèle announce-workflow | S |
| 6 | architecture-11 | Déplacer `getVersion` vers `src/version.ts`, re-export depuis `cli/` | S |
| 7 | architecture-12 | Supprimer (ou câbler) les champs morts de `CoordinatorConfig`, renommer le doublon CLI | S |

### Chantiers moyens (M)

| Ordre | Constat | Action | Effort |
|-------|---------|--------|--------|
| 8 | architecture-08 | Prioriser Task 22 (scoping MQTT/quota par org) ou fail-closed sur la création d'un 2e org | M |
| 9 | architecture-13 | Rédiger `docs/ARCHITECTURE.md` (carte, conventions Phase 1/2, glossaire des specs, how-to endpoint/tool) | M |
| 10 | architecture-10 | Job CI smoke : binaire Bun + OAuth, ou fail-fast documenté Bun∧OAuth | M |
| 11 | architecture-09 | Converger sur le logger Pino avec redaction pour toute la codebase | M |
| 12 | architecture-15 | Schémas zod partagés MCP/REST, remplacement progressif des casts (mutations d'abord) | M |

### Chantiers de fond (L)

| Ordre | Constat | Action | Effort |
|-------|---------|--------|--------|
| 13 | architecture-03 | Injecter `db` via `CoordinatorServices` au fil des retouches ; objectif : réactiver `fileParallelism` en CI | L |
| 14 | architecture-02 | Trancher : mono-instance assumé (1 h) ou closure `startServer` (structurel) selon la réalité du cas d'usage essaim | L |
| 15 | architecture-14 | Extraire le script inline du dashboard vers `app.js` lors de la prochaine évolution substantielle | L |

**Fil conducteur** : au-delà des correctifs individuels, la cause racine commune aux constats 01, 05, 06 et 07 est l'absence de **tests d'intégration à travers un serveur réellement démarré** (et à travers le spawn daemon). Un petit socle de tests « boot réel + requêtes HTTP réelles + env réaliste » rentabiliserait chacun de ces correctifs et empêcherait leur réapparition.

---

## 5. Annexe — Constats écartés après contre-vérification

Aucun constat n'a été réfuté (verdict REFUTED) par le passage de contre-vérification adversariale sur cette dimension : rien n'a donc été écarté du corps du rapport.

Pour transparence : un seul constat a fait l'objet d'une contre-vérification complète (architecture-01, sévérité high) et en est sorti **CONFIRMED** sur l'ensemble de ses affirmations (handlers jamais importés, dispatcher limité à `/api/auth/`, doctor en échec garanti, `COORDINATOR_METRICS_BEARER` jamais lu, aucune mitigation trouvée). Les constats de sévérité medium et inférieure (marqués ⚠️) reposent sur des preuves fichier:ligne relevées lors de l'audit mais n'ont pas été soumis au passage adversarial.
