# Audit — Dimension 09 : Conformité MCP & API

- **Projet** : mcp-coordinator v0.13.0 (branche `main`)
- **Date de l'audit** : 2026-07-03
- **Score** : **6 / 10**
- **Verdict global** : une implémentation MCP fonctionnelle et sérieusement testée (harness SDK officiel sur les deux transports, sessions propres, auth par requête), mais entachée de deux violations « MUST » de la spécification (logs sur stdout en mode stdio, Origin jamais validé en HTTP) et d'un drift contractuel notable entre l'OpenAPI/SDK/doctor et le routeur réel.

---

## 1. Résumé exécutif

L'implémentation MCP de mcp-coordinator est fonctionnelle et testée à un niveau rare pour un serveur early-stage : le harness d'intégration exerce le client SDK officiel sur les **deux transports** (stdio et Streamable HTTP), la gestion de session est propre (UUID cryptographiques, 404 sur session inconnue, DELETE géré, éviction dans `onclose`), et l'authentification est vérifiée **à chaque requête** sur `/mcp`, avec support de la rotation JWT en cours de session. Le SDK résolu est à jour (1.29.0, protocoles 2024-10-07 → 2025-11-25, `initialize` vérifié en live en 2025-06-18) et les 26 outils exposent des JSON Schemas corrects (draft-07, `required` exacts, `additionalProperties:false`).

Deux violations « **MUST** » de la spécification subsistent néanmoins, toutes deux **confirmées** (la première reproduite en live) :

1. le mode stdio écrit des logs JSON non-protocole sur **stdout** — la bannière de démarrage précède même la réponse `initialize`, ce qui casse tout client strict dès le handshake ;
2. le transport Streamable HTTP ne valide **jamais l'en-tête Origin** (protection anti-DNS-rebinding exigée par la spec), tout en servant un CORS wildcard avec l'authentification **désactivée par défaut** et une écoute sur toutes les interfaces.

S'y ajoute un drift API sérieux : trois endpoints documentés dans l'OpenAPI, sondés par `mcp-coordinator doctor` et consommés par le SDK client (`/.well-known/oauth-authorization-server`, `/healthz`, `/health/ready`) ont leurs handlers écrits et testés unitairement… mais ne sont **jamais câblés dans le routeur** et retournent 404 — d'où un faux négatif systématique du `doctor` sur tout déploiement Phase 2.

Enfin, l'ergonomie des outils pour un LLM est correcte mais perfectible : un paramètre JSON double-encodé sans description (`set_dependency_map`), des lectures qui répondent le texte « null » sans explication, des outils MQTT qui no-op silencieusement en stdio (`mqtt_publish` répond « published » sans broker), et aucune annotation (`readOnlyHint`/`destructiveHint`), `title` ou `outputSchema` sur les 26 outils.

Le score de 6/10 reflète ce contraste : des fondations au-dessus de la moyenne des serveurs MCP, freinées par des non-conformités de spec corrigeables à faible coût.

---

## 2. Points forts

| # | Point fort |
|---|-----------|
| 1 | **Tests d'intégration MCP réels** avec le client SDK officiel sur les DEUX transports (`tests/helpers/mcp-client-harness.ts` + `tests/integration/mcp-stdio-smoke.test.ts` / `mcp-http-smoke.test.ts`), pinnant le contrat `isError` et la survie de la connexion après un appel invalide. |
| 2 | **Authentification par requête sur `/mcp`** sur les deux branches (nouvelle session ET session existante, `serve-http.ts:535-547`), avec rotation JWT mid-session via `sessionClaims` et 401 accompagné d'un `WWW-Authenticate` conforme RFC 6750 — largement au-dessus de la moyenne des serveurs MCP. |
| 3 | **Cycle de vie de session Streamable HTTP conforme** : `sessionIdGenerator = randomUUID` (exigence « cryptographically secure » de la spec), 404 sur session inconnue avec message guidant la ré-initialisation, DELETE délégué au SDK, éviction dans `transport.onclose`. |
| 4 | **SDK à jour** : `@modelcontextprotocol/sdk` résolu en 1.29.0 (déclaré `^1.12.0`), négociation de version déléguée au SDK, `initialize` vérifié en live (protocolVersion 2025-06-18, capability `tools.listChanged`, `serverInfo` correct). |
| 5 | **Schémas zod → JSON Schema propres**, vérifiés en live via `tools/list` : `required` exacts, `additionalProperties:false`, draft-07 — la validation d'entrée du SDK retourne des erreurs zod détaillées et actionnables (`-32602`). |
| 6 | **Erreurs métier bien canalisées** : exceptions converties en `isError:true` par le SDK (pas d'erreurs JSON-RPC protocole), avec messages contextualisés (« Thread X not found », « Thread is resolved, not resolving », `consultation.ts:196-331`). |
| 7 | **Bonnes descriptions `.describe()`** sur les paramètres non triviaux d'`announce_work` (chemins repo-relatifs forward-slash, dispatch dirigé `assigned_to`, `target_symbols` avec limites max) — exactement ce dont un LLM a besoin. |
| 8 | **Pédagogie soignée** : `mcpName` « io.github.swoofer/mcp-coordinator » déclaré (`package.json:4`), README documentant les 26 outils par domaine avec un tableau « les 3 outils à 90 % d'usage ». |

---

## 3. Constats détaillés

Aucun constat de sévérité **critical**. Légende du statut de vérification : ✅ confirmé par contre-vérification adversariale · ⚠️ non contre-vérifié (sévérité medium ou moins, hors procédure de contre-vérification).

### 3.1 Sévérité HIGH

#### [protocole-mcp-01] Mode stdio : logs applicatifs écrits sur stdout, en violation du transport stdio MCP (« MUST NOT »)

- **Sévérité** : high — **Statut** : ✅ confirmé (reproduit en live) — **Effort** : S
- **Fichier** : `src/logger.ts:33`

**Preuve.** `console.log(JSON.stringify({ level: num, time: ts, ...data, msg }));` — reproduit en live : la ligne `{"level":20,...,"msg":"mcp-coordinator running on stdio..."}` apparaît sur stdout **avant** la réponse `initialize` (`src/index.ts:37`), et chaque tool handler logge `mcpLog.info("Tool called")` via le même chemin.

**Explication.** La spec MCP stdio exige que le serveur n'écrive **rien** sur stdout qui ne soit un message MCP valide. Le logger console — fallback systématique en dist ESM, car `require("pino")` (`src/logger.ts:50`) lève une ReferenceError sous `"type":"module"`, et pino écrit de toute façon sur stdout par défaut — émet ses lignes JSON de log sur stdout : bannière au démarrage + un log info par appel d'outil (`announce_work`, `register_agent`, `post_to_thread`…). Seuls `error`/`fatal` vont sur stderr. Le client SDK officiel tolère ces lignes (elles échouent la validation `JSONRPCMessage` et sont ignorées via `onerror`), ce qui explique que les smoke tests passent ; mais un client strict échoue **dès le handshake** (la bannière précède la réponse `initialize`), et chaque log devient un message d'erreur côté client. Le mode stdio est un mode supporté et documenté (README, `main` du package = `dist/src/index.js`), et le mainteneur applique correctement la règle ailleurs (`cli/channel.ts:295` logge sur stderr « so it surfaces under stdio ») — c'est donc bien une omission, non un choix.

**Recommandation.** Rediriger tous les logs vers stderr quand le process sert le transport stdio : dans `createConsoleLogger`, remplacer `console.log` par `console.error` (ou `process.stderr.write`) pour tous les niveaux, et passer une destination stderr à pino (`pino(opts, pino.destination(2))`). Ajouter au smoke test stdio une assertion « aucune ligne stdout non-JSON-RPC » pour verrouiller la régression.

---

#### [protocole-mcp-02] Streamable HTTP : aucune validation de l'en-tête Origin (« MUST » de la spec) + CORS wildcard avec auth désactivée par défaut

- **Sévérité** : high — **Statut** : ✅ confirmé — **Effort** : M
- **Fichier** : `src/serve-http.ts:421`

**Preuve.** Le preflight OPTIONS répond `Access-Control-Allow-Origin: *` avec `Access-Control-Allow-Headers: Content-Type, mcp-session-id, Authorization` (`serve-http.ts:421-428`) ; aucune occurrence de `req.headers.origin` dans tout `src/` ; `httpServer.listen(port)` (`serve-http.ts:660`) écoute sur toutes les interfaces ; `AUTH_ENABLED = process.env.COORDINATOR_AUTH_ENABLED === "true"` — off par défaut (`serve-http.ts:54`). `src/http/utils.ts:38` pose aussi `ACAO:*` sur les réponses REST.

**Explication.** La spec du transport Streamable HTTP (2025-03-26+) impose : « Servers MUST validate the Origin header on all incoming connections to prevent DNS rebinding attacks ». Ici non seulement Origin n'est jamais vérifié, mais le preflight CORS répond wildcard, ce qui autorise n'importe quelle page web visitée par l'utilisateur à piloter le coordinateur local (POST `/mcp`, REST `/api/*`, `mqtt_publish` arbitraire) quand l'auth est désactivée — le mode par défaut : `authenticateMcpRequest` (`serve-http.ts:315-318`) renvoie alors des claims synthétiques `role:admin`, sans aucune barrière. L'option `enableDnsRebindingProtection`/`allowedHosts` du `StreamableHTTPServerTransport` — disponible dans le SDK 1.29 installé — n'est pas utilisée (`serve-http.ts:550`). Détail révélateur : le broker MQTT se lie explicitement à `127.0.0.1` (`mqtt-broker.ts:164`), preuve que le bind restrictif a été pensé mais pas appliqué au HTTP. Sévérité high (et non critical) : le défaut cible un service local de dev par défaut, le compose recommandant un reverse proxy en frontal.

**Recommandation.**
1. Rejeter les requêtes `/mcp` (et idéalement `/api/*`) dont l'Origin est présent et non allowlisté (localhost + `COORDINATOR_PUBLIC_URL`) ; le plus simple est de passer `allowedHosts`/`enableDnsRebindingProtection` au `StreamableHTTPServerTransport`.
2. Restreindre `Access-Control-Allow-Origin` à une allowlist configurable au lieu de `*`.
3. Envisager un bind `127.0.0.1` par défaut quand `AUTH_ENABLED=false`.

---

#### [protocole-mcp-03] Endpoints documentés, testés et consommés par le SDK/doctor jamais câblés dans le routeur : `/.well-known/oauth-authorization-server`, `/healthz`, `/health/ready`

- **Sévérité** : high — **Statut** : ✅ confirmé — **Effort** : S
- **Fichier** : `src/discovery.ts:40`

**Preuve.** `handleDiscovery` (`src/discovery.ts:40`), `handleHealthz`/`handleHealthReady` (`src/http/health.ts:24,44`) n'ont **aucun** import côté routing : ni `serve-http.ts` ni `dispatchAuthRoutes` (`KNOWN_AUTH_PATHS`, `auth-routes.ts:205`) ne les référencent — seuls des tests les appellent directement. Pourtant `docs/openapi.yaml:813/834/901` les déclare « Implemented by T36/T14 », `sdk/src/discovery.ts:6` fetch `/.well-known/oauth-authorization-server`, et `cli/doctor.ts:188` (`probeDiscoveryDoc`) sonde l'endpoint. Le commentaire `auth-routes.ts:73-74` prétend même que le discovery doc est « wired separately by serve-http.ts at boot » — câblage introuvable dans `serve-http.ts` et `boot.ts` : branchement prévu, jamais réalisé.

**Explication.** Drift majeur entre le contrat d'API publié et le serveur réel : ces trois routes tombent dans le fallback du routeur et retournent 404 (le path ne commence pas par `/api/` ; `/health` est matché en égalité stricte, donc `/healthz` non plus). Conséquences concrètes : (a) `mcp-coordinator doctor` sur un déploiement Phase 2 affiche un échec « Coordinator not serving discovery endpoint » — **faux négatif systématique** que l'utilisateur va déboguer pour rien (probes lancées par `runPhase2Probes`, `doctor.ts:688`, dont un `HEAD /healthz`, `doctor.ts:151`) ; (b) l'option `discovery` du SDK client (`DiscoveryCache`) ne peut jamais fonctionner contre ce serveur ; (c) l'OpenAPI et les types SDK `HealthzResponse`/`HealthReadyResponse` (`sdk/src/types.ts:45-58`) décrivent des endpoints fantômes. Les handlers sont pourtant écrits et couverts par des tests unitaires (`tests/unit/discovery.test.ts`, `tests/unit/health.test.ts`). Pas d'impact sécurité ni perte de données, mais un contrat publié et cassé en production.

**Recommandation.** Câbler les trois routes dans `serve-http.ts` : `if (url === "/.well-known/oauth-authorization-server") return handleDiscovery(req, res, publicUrl)` (gaté sur `phase2Bootstrap`, `publicUrl` venant du boot), et `/healthz` + `/health/ready` à côté de `/livez`/`/readyz`. Ajouter un test d'intégration bout-en-bout (serveur réel → GET) pour empêcher ce type de drift entre handler testé unitairement et routeur.

---

### 3.2 Sévérité MEDIUM

#### [protocole-mcp-04] Les outils MCP ignorent `claims.sub` : n'importe quel appelant authentifié peut agir au nom de n'importe quel `agent_id` de son org

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié — **Effort** : M
- **Fichier** : `src/tools/consultation-tools.ts:127`

**Preuve.** `approve_resolution({ thread_id, agent_id })` — l'identité vient du paramètre. Grep confirmé : aucune occurrence de `claims.sub` ni `claims.role` dans `src/tools/` ; seul `claims.org` est utilisé.

**Explication.** L'auth par requête (Task 23) capture des claims complets (`sub` = agent authentifié), mais la couche outils fait confiance au paramètre `agent_id` fourni par le client. En mode `AUTH_ENABLED`, un agent peut approuver une résolution, contester, annuler un thread ou poster des messages en se faisant passer pour un autre agent de la même org — l'authentification ne se traduit pas en autorisation au niveau de l'API des outils. Acceptable en mode mono-utilisateur open-coordinator (claims synthétiques), mais incohérent dès que l'auth est activée : le champ existe précisément pour ça.

**Recommandation.** Quand `AUTH_ENABLED` (`claims.jti !== "legacy"`), vérifier `agent_id === claims.sub` (ou une table de mapping agent→token) dans les outils mutateurs (`post_to_thread`, `propose/approve/contest_resolution`, `close/cancel_thread`, `register_agent`, `heartbeat`) et retourner un `isError` explicite en cas de mismatch. Documenter le contrat dans les descriptions d'outils.

---

#### [protocole-mcp-05] `set_dependency_map` : paramètre JSON double-encodé, sans description de schéma, erreur brute non actionnable

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié (reproduit en live) — **Effort** : S
- **Fichier** : `src/tools/dependencies-tools.ts:20`

**Preuve.** `modules: z.string(), // JSON DependencyMap` — schéma exposé au LLM : `{"modules":{"type":"string"}}` sans description. Reproduit en live : `arguments {modules:'{not json'}` → `isError` avec le texte « Expected property name or '}' in JSON at position 1 (line 1 column 2) ».

**Explication.** Anti-pattern d'ergonomie LLM : le seul indice que `modules` doit être une `DependencyMap` sérialisée est un commentaire TypeScript invisible du client. Un agent n'a aucun moyen de découvrir la forme attendue (clés = module id ? `deps` ? `files` ?), et en cas d'erreur il reçoit un `SyntaxError` V8 brut sans mention de l'outil, du paramètre ni du format attendu. `JSON.parse` est de plus appelé sans validation de la forme parsée avant `depMap.setMap`.

**Recommandation.** Remplacer par un schéma zod structuré (p. ex. `z.record(z.object({ depends_on: z.array(z.string()).optional(), files: z.array(z.string()).optional() }))` selon le type `DependencyMap`) pour que le JSON Schema documente la forme — le SDK gère la validation. À défaut, ajouter `.describe()` avec un exemple complet et wrapper `JSON.parse` dans un try/catch retournant un `isError` du type « modules must be a JSON object mapping module ids to {...}; got: \<err\> ».

---

#### [protocole-mcp-06] Mode stdio : les outils MQTT sont exposés mais mentent silencieusement (`mqtt_publish` répond « published » sans broker)

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié — **Effort** : S
- **Fichier** : `src/mqtt-bridge.ts:278`

**Preuve.** `mqttPublish(): if (this.client && this.connected) { ... }` — no-op silencieux sinon ; le tool retourne toujours `{ text: "published" }` (`mqtt-tools.ts:48-56`). `src/index.ts` ne démarre ni broker ni bridge (« no MQTT broker in stdio mode », `index.ts:37`).

**Explication.** En transport stdio, les 3 outils MQTT (`mqtt_publish`, `wait_for_message`, `get_queued_messages`) et le publish de `register_agent` sont des no-ops : le bridge n'est jamais connecté. Un LLM qui appelle `mqtt_publish` reçoit « published » (faux), et `wait_for_message` expire systématiquement après le timeout sans indice sur la cause. C'est trompeur pour l'agent comme pour l'utilisateur qui débogue une coordination qui « ne passe pas ».

**Recommandation.** Dans les handlers MQTT, tester `mqttBridge.isConnected()` et retourner un `isError` explicite (« MQTT broker not available — stdio mode runs without MQTT; use the HTTP transport for push messaging ») au lieu du succès silencieux. Alternative plus propre : ne pas enregistrer les outils MQTT en mode stdio (paramètre de `createMcpServer`), la liste d'outils reflétant alors les capacités réelles.

---

#### [protocole-mcp-07] Sessions Streamable HTTP jamais expirées : fuite des Maps `sessions`/`sessionClaims` quand le client disparaît sans DELETE

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié — **Effort** : M
- **Fichier** : `src/serve-http.ts:409`

**Preuve.** `const sessions = new Map<string, StreamableHTTPServerTransport>();` … éviction uniquement dans `transport.onclose` (`serve-http.ts:555-562`), qui ne se déclenche que sur DELETE `/mcp` ou arrêt du serveur.

**Explication.** Chaque session MCP alloue un `StreamableHTTPServerTransport` + un `McpServer` complet (26 outils). Un agent tué (SIGKILL, crash, VM éteinte) n'envoie jamais DELETE ; sa session reste indéfiniment dans les deux Maps. Sur un coordinateur long-running orchestrant des fleets d'agents CLI éphémères — le cas d'usage nominal du projet — la mémoire croît sans borne. Pas de cap non plus sur le nombre de sessions créées par un même client.

**Recommandation.** Ajouter un sweeper d'inactivité : timestamp `lastSeen` mis à jour à chaque `handleRequest`, tick périodique (déjà le pattern des autres sweepers du projet) qui appelle `transport.close()` au-delà d'un TTL (p. ex. 30 min, configurable). Le `onclose` existant fait déjà l'éviction des Maps.

---

### 3.3 Sévérité LOW / INFO

#### [protocole-mcp-08] `get_thread` (et lectures similaires) retourne le texte « null » pour une ressource absente, sans `isError` ni explication

- **Sévérité** : low — **Statut** : ⚠️ non contre-vérifié (reproduit en live) — **Effort** : S
- **Fichier** : `src/tools/consultation-tools.ts:183`

**Preuve.** `const result = consultation.getThreadWithMessages(claims.org, thread_id); ... text: JSON.stringify(result)` — reproduit en live : `tools/call get_thread{thread_id:'missing'}` → `{"content":[{"type":"text","text":"null"}]}` sans `isError`.

**Explication.** Un LLM qui reçoit « null » n'a aucun signal exploitable : thread inexistant ? mauvaise org ? thread purgé ? Même motif pour `get_module_info` (`dependencies-tools.ts:38-45`). Le contraste est net avec les mutateurs, qui lèvent des erreurs explicites (« Thread X not found ») — incohérence de contrat au sein de la même API.

**Recommandation.** Pour les lectures, retourner `isError:true` avec un message actionnable (« Thread 'missing' not found in your org — list_threads to see available ids ») quand le résultat est null, ou un objet `{ found: false, hint }` si l'on préfère éviter `isError` sur les lectures.

---

#### [protocole-mcp-09] README documente un outil MCP « introspection » qui n'existe pas ; commentaire « 23 tools » périmé

- **Sévérité** : low — **Statut** : ⚠️ non contre-vérifié — **Effort** : S
- **Fichier** : `README.md:236`

**Preuve.** « The in-server `introspection` tool returns the live schema for every tool — point any MCP client at it for runtime discovery. » — aucun `server.tool("introspection")` dans `src/tools/` (26 outils comptés, aucun de ce nom). `src/server-setup.ts:179` dit « all 23 MCP tools » (il y en a 26).

**Explication.** L'`IntrospectionManager` (`src/introspection.ts`) est un service interne de scoring gray-zone, pas un outil MCP. Un utilisateur qui suit le README cherchera un outil inexistant — d'autant plus inutile que `tools/list` fait déjà la découverte runtime nativement dans MCP.

**Recommandation.** Supprimer la phrase du README (ou la remplacer par « la découverte runtime passe par `tools/list`, natif MCP ») et corriger le commentaire de `server-setup.ts:179` à 26 outils. Optionnel : un petit test qui compare la liste des outils du serveur au tableau du README.

---

#### [protocole-mcp-10] Aucun outil n'a d'annotations (`readOnlyHint`/`destructiveHint`), de `title` ni d'`outputSchema` ; descriptions de paramètres majoritairement absentes

- **Sévérité** : low — **Statut** : ⚠️ non contre-vérifié (vérifié en live sur `tools/list`) — **Effort** : M
- **Fichier** : `src/tools/agents-tools.ts:19`

**Preuve.** Vérifié en live sur `tools/list` : 0/26 outils avec `annotations`, 0 avec `outputSchema`, 0 avec `title`. `register_agent` expose `agent_id`/`name`/`modules` sans aucune description ; l'API utilisée est `server.tool()` (forme legacy) et non `registerTool()`.

**Explication.** Les hints d'annotation permettent aux clients MCP (Claude Code inclus) de distinguer lectures (`list_agents`, `get_thread`, `coordinator_status` → `readOnlyHint`) et mutations (`cancel_thread`, `mqtt_publish`), d'auto-approuver les lectures et de demander confirmation sur le destructif. Les `outputSchema`/`structuredContent` amélioreraient la consommation des résultats JSON (tout est aujourd'hui du `JSON.stringify` dans un bloc `text`). Optionnel dans la spec, mais peu coûteux et à fort levier pour l'ergonomie agent — le cœur de métier de ce projet.

**Recommandation.** Migrer progressivement vers `server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint, destructiveHint, idempotentHint } }, cb)` en commençant par marquer les ~10 outils de lecture `readOnlyHint:true`. Ajouter `.describe()` sur les paramètres ambigus (`since` ISO-8601 de `get_thread_updates`, `session_id`, `within_minutes`).

---

#### [protocole-mcp-11] Résumabilité Streamable HTTP absente (pas d'`eventStore`) et `Mcp-Session-Id` non exposé au CORS

- **Sévérité** : low — **Statut** : ⚠️ non contre-vérifié — **Effort** : M
- **Fichier** : `src/serve-http.ts:550`

**Preuve.** `new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })` — pas d'option `eventStore` ; le handler OPTIONS (`serve-http.ts:421-428`) ne définit pas `Access-Control-Expose-Headers`, donc un client navigateur ne peut pas lire l'en-tête `mcp-session-id` de la réponse `initialize`.

**Explication.** Sans `eventStore`, un client qui perd la connexion SSE ne peut pas rejouer les messages manqués via `Last-Event-ID` (la résumabilité est optionnelle dans la spec — les événements de coordination passent de toute façon par MQTT/SSE dédié, donc l'impact réel est faible). L'absence d'`Expose-Headers` casse en revanche tout client MCP s'exécutant dans un navigateur, qui ne pourra jamais établir de session.

**Recommandation.** Ajouter `Access-Control-Expose-Headers: mcp-session-id` aux réponses `/mcp` (une ligne). Pour la résumabilité, implémenter l'interface `EventStore` du SDK sur SQLite seulement si un besoin client concret émerge (YAGNI sinon — à documenter comme limitation connue).

---

#### [protocole-mcp-14] Outils bloquants (`wait_for_peers`, `wait_for_message`) sans borne supérieure de timeout ni notifications de progression

- **Sévérité** : low — **Statut** : ⚠️ non contre-vérifié — **Effort** : S
- **Fichier** : `src/tools/status-tools.ts:43`

**Preuve.** `timeout_seconds: z.number().optional()` — aucun `.max()` ; `const timeoutMs = (timeout_seconds ?? 30) * 1000` puis boucle de polling. Idem `wait_for_message` (`mqtt-tools.ts:25-37`).

**Explication.** Un LLM peut passer `timeout_seconds: 3600` et bloquer la requête MCP une heure : le timeout par défaut du client SDK (60 s) annulera l'appel côté client alors que la boucle serveur continue de tourner, et aucune `notifications/progress` n'est émise pour maintenir les timeouts resettables (`resetTimeoutOnProgress`). Valeurs négatives ou NaN acceptées par le schéma (`z.number()` sans `int`/`positive`).

**Recommandation.** Contraindre le schéma : `z.number().int().min(1).max(120)` avec `.describe()` indiquant la borne, et mentionner dans la description de l'outil que le client doit prévoir un timeout supérieur. Optionnel : émettre `extra.sendNotification` progress à chaque tick de polling pour les clients qui resettent leur timeout sur progression.

---

#### [protocole-mcp-12] Auth du endpoint `/mcp` non conforme à la spec d'autorisation MCP : pas de `resource_metadata` dans `WWW-Authenticate`, pas de `/.well-known/oauth-protected-resource`

- **Sévérité** : info — **Statut** : ⚠️ non contre-vérifié — **Effort** : M
- **Fichier** : `src/http/utils.ts:58`

**Preuve.** `jsonAuthError` renvoie `WWW-Authenticate: Bearer realm="mcp-coordinator"` (sans paramètre `resource_metadata` RFC 9728) ; aucune route `oauth-protected-resource` dans `src/`.

**Explication.** La spec d'autorisation MCP (2025-06-18) prévoit que le serveur de ressources pointe vers ses métadonnées OAuth via `WWW-Authenticate` + RFC 9728, permettant aux clients MCP génériques (Claude, VS Code) de découvrir et dérouler le flow OAuth automatiquement. Ici le provisioning de token est propriétaire (`/api/auth/register` avec secret partagé, ou device flow Phase 2), donc un client MCP tiers spec-compliant ne peut pas s'authentifier sans configuration manuelle. Acceptable pour le profil actuel (les clients sont les propres agents du mainteneur), d'autant que le serveur possède déjà un AS OAuth Phase 2 qui rendrait le câblage réaliste plus tard.

**Recommandation.** Documenter la limitation dans le README (section auth). Si des clients MCP tiers deviennent un cas d'usage : servir `/.well-known/oauth-protected-resource` et ajouter `resource_metadata="..."` au `WWW-Authenticate` des 401 de `/mcp` — le gros du travail (AS, device flow, discovery doc) existe déjà en Phase 2.

---

#### [protocole-mcp-13] `mcpName` déclaré mais aucune trace de publication au registre MCP (pas de `server.json` ni workflow), et `serverInfo.name` incohérent

- **Sévérité** : info — **Statut** : ⚠️ non contre-vérifié — **Effort** : S
- **Fichier** : `package.json:4`

**Preuve.** `"mcpName": "io.github.swoofer/mcp-coordinator"` — aucun `server.json` dans le dépôt, aucun step `mcp-publisher` dans les 6 workflows CI ; `serverInfo.name = "mcp-coordinator-v3"` (`src/server-setup.ts:175`), différent du nom de registre et du nom npm.

**Explication.** Le champ `mcpName` sert de preuve de propriété du paquet npm pour le registre officiel MCP, mais sans `server.json` ni étape de publication le serveur n'apparaît vraisemblablement pas dans le registre (ou n'est publié que manuellement, de façon non reproductible). Par ailleurs le nom annoncé à l'`initialize` (« mcp-coordinator-v3 ») ne correspond ni au `mcpName` ni au nom npm, ce qui complique la corrélation client/registre et fuit un détail d'implémentation interne (« v3 »).

**Recommandation.** Aligner `serverInfo.name` sur « io.github.swoofer/mcp-coordinator » (recommandation du registre) — changement d'une ligne. Si la présence au registre officiel est souhaitée : ajouter `server.json` et un step `mcp-publisher` dans `release.yml` ; sinon retirer `mcpName` pour ne pas suggérer une publication qui n'existe pas.

---

## 4. Recommandations priorisées

### Quick wins (effort S) — à faire en premier

| Priorité | Constat | Action | Impact |
|---|---|---|---|
| 1 | mcp-01 (high) | Logs → stderr en mode stdio (`console.error` + `pino.destination(2)`) + assertion de non-régression dans le smoke test | Lève une violation « MUST NOT » ; handshake fiable pour tout client strict |
| 2 | mcp-03 (high) | Câbler `/.well-known/oauth-authorization-server`, `/healthz`, `/health/ready` dans `serve-http.ts` + test d'intégration bout-en-bout | Supprime le faux négatif systématique du `doctor` et répare le contrat OpenAPI/SDK |
| 3 | mcp-05 | Schéma zod structuré (ou `.describe()` + try/catch) pour `set_dependency_map` | Ergonomie LLM directe |
| 4 | mcp-06 | `isError` explicite (ou non-enregistrement) des outils MQTT en mode stdio | Élimine un succès mensonger |
| 5 | mcp-08 | `isError` (ou `{ found:false, hint }`) sur les lectures qui retournent null | Contrat cohérent lectures/mutations |
| 6 | mcp-14 | Borner `timeout_seconds` (`int().min(1).max(120)`) | Robustesse des outils bloquants |
| 7 | mcp-09, mcp-13 | Corriger README (outil « introspection », « 23 tools » → 26) ; aligner `serverInfo.name` sur le `mcpName` | Hygiène documentaire |
| 8 | mcp-11 (volet CORS) | Une ligne : `Access-Control-Expose-Headers: mcp-session-id` | Débloque les clients navigateur |

### Chantiers moyens (effort M)

| Priorité | Constat | Action |
|---|---|---|
| 1 | mcp-02 (high) | Validation Origin/Host (`enableDnsRebindingProtection` + `allowedHosts` du SDK), allowlist CORS configurable, bind `127.0.0.1` par défaut quand auth off |
| 2 | mcp-07 | Sweeper d'inactivité des sessions HTTP (TTL configurable, pattern sweeper existant) |
| 3 | mcp-04 | Vérifier `agent_id === claims.sub` dans les outils mutateurs quand l'auth est activée |
| 4 | mcp-10 | Migration progressive vers `registerTool()` avec annotations (`readOnlyHint` sur ~10 outils de lecture d'abord) et `.describe()` manquants |
| 5 | mcp-12 | Documenter la limitation d'auth propriétaire ; câbler RFC 9728 seulement si des clients MCP tiers émergent |
| 6 | mcp-11 (résumabilité) | `EventStore` SQLite uniquement sur besoin concret (YAGNI — documenter comme limitation connue) |

Aucun chantier L identifié dans cette dimension : la totalité des corrections tient en efforts S et M. Les trois « high » corrigés lèvent les deux violations « MUST » et le drift de contrat — un passage de 6/10 à 8+/10 est réaliste sur une itération courte.

---

## 5. Annexe — Constats écartés après contre-vérification

Aucun constat n'a été réfuté (REFUTED) lors de la passe de contre-vérification adversariale sur cette dimension. Les trois constats de sévérité high (mcp-01, mcp-02, mcp-03) ont tous été **CONFIRMED** (code vérifié ligne à ligne ; reproduction en live pour mcp-01) ; les constats de sévérité medium et inférieure n'ont pas fait l'objet d'une contre-vérification systématique — procédure réservée aux sévérités élevées — et sont signalés comme tels (⚠️) dans le corps du rapport, plusieurs ayant néanmoins été reproduits ou vérifiés en live (mcp-05, mcp-08, mcp-10).
