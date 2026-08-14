# A01 — MCP 2026-07-28 : cœur stateless, HTTP+SSE déprécié, `server/discover`

> **Fiche de veille.** Les sections 1 à 5 sont remplies par la veille.
> Les sections 6.2 à 6.4 et 7 sont remplies **pendant le challenge** (session dédiée).

| Champ | Valeur |
|---|---|
| **ID** | `mcp-2026-07-28-stateless` |
| **Surface** | mcp-spec |
| **Statut** | **Current** (terme officiel de la spec ; « GA » n'est pas employé — voir §2 point 1). Confirmé sur /specification/versioning au 2026-08-14 : « The **current** protocol version is 2026-07-28 ». |
| **Disponible depuis** | `2026-07-28` (révision de protocole `2026-07-28`, remplace `2025-11-25`) |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | XL |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — SDK 2.0.0 public sur npm, tout se joue en local |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

Le fond tient : la révision existe, elle est **Current**, et tous les noms d'API affirmés en §2
(clés `_meta`, `server/discover`, `subscriptions/listen`, `resultType`, `CacheableResult`,
headers `Mcp-Method`/`Mcp-Name`/`Mcp-Param-{Name}`, sentinelle `=?base64?…?=`, codes `-32020`
`-32021` `-32022`, renumérotation `-32002` → `-32602`) sont confirmés mot pour mot par le
changelog officiel et la page Streamable HTTP. Les numéros de ligne de §5 sont exacts, y compris
la ventilation des 26 `getSessionClaims` par fichier. Trois faits ont bougé.

**Corrections apportées :**

- **§2 point 2 — le compte à rebours HTTP+SSE est datable, contrairement à ce qu'affirmait la
  fiche.** SEP-2596 est mergée depuis le **2026-05-18** et porte aujourd'hui le label `final`
  (« SEP finalized »). La fenêtre « trois mois après que SEP-2596 atteigne Final » situe donc
  l'*éligibilité* au retrait vers le **2026-08-18**, soit quatre jours après cette vérification.
  Le registre continue néanmoins de formuler la date de façon relationnelle et rappelle que
  l'éligibilité n'est pas le retrait : celui-ci reste une décision des Core Maintainers prise en
  préparation de release, et ne peut intervenir que dans une révision future.
- **§2 point 5 — les quatre `(à vérifier)` sont tranchés, tous par l'affirmative.** Le
  verrouillage de la RC au 2026-05-21 est bien dans le billet officiel (« The release candidate is
  locked as of May 21, 2026 »), et non absent comme l'écrivait la fiche. Les PR SDK TS #2538
  (mergée 2026-07-23) et #2547 (2026-07-27) portent bien le keep-alive SSE. La PR spec #3002
  (2026-07-16) et la PR SDK TS #2513 (2026-07-20) portent bien le déplacement de `serverInfo`
  vers `_meta`. La granularité `ttlMs`/`cacheScope` est explicite au changelog.
- **§5 `package.json` — la description du chantier SDK était fausse.** Le support 2026-07-28
  n'est pas « annoncé », il est **publié depuis le 2026-07-27**, et pas sous forme de bump de
  `@modelcontextprotocol/sdk` : c'est une **nouvelle famille de paquets scopés en 2.0.0**.
  Accessoirement, `^1.29.0` résout déjà vers 1.30.0, déjà installé ici.
- **§1 — force normative du 405.** La spec dit **SHOULD**, pas MUST, pour la réponse
  `405` sur GET/DELETE. La fiche écrivait « doivent ».
- **§2 — `InputRequiredResult` était mal découpé.** `inputResponses` et `requestState` ne sont
  pas des champs du résultat serveur : ils voyagent sur le *rejeu* de la requête par le client.
- **§5 `oauth-callback.ts` — nuance normative.** RFC 9207 n'est pas « obligatoire » sans
  condition : l'AS **SHOULD** émettre `iss`, le client **MUST** valider un `iss` *présent*
  (changelog minor change 7, SEP-2468). L'observation sur le code reste exacte : le callback ne
  lit pas `iss` du tout.

*Note de passe :* une première passe de vérification avait rédigé cette section §0 puis avait été
interrompue **avant** d'appliquer les corrections au corps de la fiche. Les six corrections
ci-dessus ont été revérifiées à la source, puis **effectivement reportées** dans §1, §2, §4 et §5
le 2026-08-14. §6.2/§6.4/§6.5, §7 et le statut du challenge n'ont pas été touchés.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ✅ testable

Rien ici ne dépend d'un accès fermé : la spec est publique, et le SDK qui l'implémente est publié
sur npm (`@modelcontextprotocol/server@2.0.0`, Node ≥ 20 — le poste est en Node 22.21.0). Les cinq
points du protocole §6.3 se jouent tous en local, sans credentials Anthropic ni header beta :
lire les types du SDK 2.0.0, POSTer une requête stateless sur le `/mcp` du daemon courant,
instrumenter `getSessionClaims` sous une vraie session Claude Code, couper un `/api/events`, et
écrire un `server/discover` jetable. Seul un point du §6.3 est à reformuler en session : il vise
« la dernière version publiée » de `@modelcontextprotocol/sdk`, alors que le modèle stateless vit
dans les paquets `@modelcontextprotocol/{core,server,client}@2.0.0` — c'est là qu'il faut aller
lire, pas dans la ligne 1.x.

---

## 1. Ce que c'est

La révision `2026-07-28` fait passer MCP d'un protocole bidirectionnel avec état à un protocole
requête/réponse sans état. Le handshake `initialize` / `notifications/initialized` et le header
`Mcp-Session-Id` sont supprimés : chaque requête s'auto-décrit via son `_meta`
(`io.modelcontextprotocol/protocolVersion` et `/clientCapabilities` sont requis,
`/clientInfo` est un SHOULD), et chaque résultat porte `/serverInfo` (SHOULD) et un champ
obligatoire `resultType` valant `"complete"` ou `"input_required"`. Un RPC `server/discover`
que tout serveur DOIT implémenter remplace la négociation de session : il retourne
`supportedVersions`, `capabilities` (dont `extensions`) et `instructions`, et il est cacheable.
Sur Streamable HTTP, deux headers recopient des champs du corps JSON-RPC pour que gateways et
WAF routent sans parser le body : `Mcp-Method` (requis partout) et `Mcp-Name` (requis sur les
appels qui nomment une cible : `tools/call`, `resources/read`, `prompts/get`) ; une discordance
header/corps DOIT être rejetée en HTTP 400 avec l'erreur `-32020`.

Le push change de forme. L'endpoint GET, `resources/subscribe|unsubscribe`, la résumabilité SSE
(`Last-Event-ID` et les ids d'événements SSE) et le DELETE disparaissent ; un serveur qui ne parle
que cette révision **SHOULD** (et non MUST) répondre `405 Method Not Allowed` aux GET et DELETE. Un unique flux long `POST subscriptions/listen` avec opt-in par type
(`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`) les
remplace. Les requêtes serveur→client (`roots/list`, `sampling/createMessage`,
`elicitation/create`) sont remplacées par le pattern MRTR : le serveur répond
`resultType: "input_required"` avec des `inputRequests`, et le client rejoue la requête en y
joignant `inputResponses` et `requestState`. Enfin, les réponses de listes et de ressources
deviennent cacheables via `ttlMs` et `cacheScope`, `ping` / `logging/setLevel` /
`notifications/roots/list_changed` sont purement supprimés (le niveau de log passe en `_meta`
par requête), et Roots / Sampling / Logging / HTTP+SSE / DCR sont dépréciés.

## 2. Surface d'API exacte

```
_meta['io.modelcontextprotocol/protocolVersion']    (requis)
_meta['io.modelcontextprotocol/clientCapabilities'] (requis)
_meta['io.modelcontextprotocol/clientInfo']         (SHOULD ; champs name, version)
_meta['io.modelcontextprotocol/serverInfo']         (SHOULD, dans le _meta du résultat)
_meta['io.modelcontextprotocol/logLevel']
_meta['io.modelcontextprotocol/subscriptionId']

server/discover  → DiscoverResult { supportedVersions, capabilities, instructions, ttlMs, cacheScope }
subscriptions/listen  (POST long-lived ; opt-in : toolsListChanged, promptsListChanged,
                       resourcesListChanged, resourceSubscriptions)

resultType : "complete" | "input_required"
InputRequiredResult { inputRequests }   (résultat serveur ; MRTR, SEP-2322)
  → le client rejoue la requête d'origine en y joignant inputResponses (et requestState
    si le serveur a besoin de corréler l'interaction entre deux essais)
CacheableResult { ttlMs, cacheScope: "public" | "private" }
  requis sur tools/list, prompts/list, resources/list, resources/read, resources/templates/list
extension io.modelcontextprotocol/tasks  (tasks/get, tasks/update)

Headers : Mcp-Method (requis), Mcp-Name (requis sur tools/call | resources/read | prompts/get),
          MCP-Protocol-Version (doit égaler _meta protocolVersion),
          Mcp-Param-{Name} via annotation x-mcp-header sur inputSchema,
          sentinelle =?base64?<valeur>?= pour les valeurs non-ASCII,
          réponse SSE : X-Accel-Buffering: no (SHOULD), keep-alive par ligne « : » (encouragé)

Erreurs : HeaderMismatch -32020 · MissingRequiredClientCapability -32021
          UnsupportedProtocolVersion -32022 · resource-not-found renuméroté -32002 → -32602

Supprimés : Mcp-Session-Id, initialize, notifications/initialized, ping, logging/setLevel,
            notifications/roots/list_changed, resources/subscribe, resources/unsubscribe,
            GET HTTP, DELETE, Last-Event-ID, ids d'événements SSE, tasks/result, tasks/list
```

**Contradictions et points non tranchés entre chercheurs — à ne pas lisser :**

1. **Label de statut.** Trois fiches disent « GA ». Un vérificateur objecte que la spec MCP
   n'emploie pas GA/beta : elle classe les *révisions* en Draft/Current/Final et les
   *fonctionnalités* en Active/Deprecated/Removed. `2026-07-28` est **Current**. « GA » reste
   une traduction acceptable mais n'est pas le terme documentaire.
2. **Fenêtre de retrait de HTTP+SSE.** Une source annonce « fenêtre minimale de 12 mois ».
   Une autre corrige : les 12 mois valent pour Roots/Sampling/Logging ; HTTP+SSE (déjà déprécié
   depuis 2025-03-26, seulement *reclassé* en 2026-07-28 sous SEP-2596) est éligible au retrait
   **trois mois après que SEP-2596 atteigne Final** — la fenêtre la plus courte du registre.
   *Tranché au 2026-08-14 :* la page `/deprecated` formule bien la date de façon relationnelle
   (« Three months after SEP-2596 reaches Final ») et ne la date pas, mais la PR SEP-2596 est
   **mergée le 2026-05-18** et porte le label `final` sur GitHub. L'*éligibilité* au retrait
   tombe donc vers le **2026-08-18**. Le registre rappelle toutefois que « the earliest removal
   marks when a feature becomes *eligible* for removal ; the actual removal is a Core Maintainer
   decision taken during release preparation and may happen later » — et un retrait ne peut de
   toute façon intervenir que dans une révision future. **Le compte à rebours est daté, mais
   l'échéance qu'il ouvre est une éligibilité, pas une date de retrait.**
3. **SEP-1699 vs SEP-2575.** Une fiche décrit SEP-1699 (Final) : le serveur PEUT fermer un flux
   SSE avant la réponse s'il a émis un événement d'amorçage `id: <token>` + `data:` vide, le
   client reconnectant via `Last-Event-ID`, cadencé par le champ SSE `retry:`. Une autre fiche
   documente SEP-2575, qui **supprime `Last-Event-ID` et les ids d'événements** de Streamable
   HTTP en `2026-07-28`. Les deux sont vérifiées ; leur interaction exacte est le point à
   trancher avant de toucher au transport.
4. **Keep-alive SSE.** Un chercheur présente le commentaire SSE `:` et `X-Accel-Buffering: no`
   comme une compensation à la perte de résumabilité. Correction du vérificateur : ce sont deux
   exigences indépendantes de « Receiving Messages », visant les timeouts d'intermédiaires sur
   les flux longs (`subscriptions/listen`), pas la reprise après coupure. Force normative :
   `X-Accel-Buffering` = SHOULD, keep-alive = simple « encouraged ».
5. **Points anciennement `(à vérifier)` — tous tranchés au 2026-08-14, par l'affirmative.**
   Le verrouillage de la RC au `2026-05-21` **est** dans le billet officiel
   (« The release candidate is locked as of May 21, 2026 ») et non absent comme l'écrivait la
   fiche. Les PR SDK TS `#2538` (mergée 2026-07-23) et `#2547` (2026-07-27) portent bien le
   keep-alive SSE. La PR spec `#3002` (2026-07-16) et la PR SDK TS `#2513` (2026-07-20) portent
   bien le déplacement de `serverInfo` vers `_meta`. La granularité de `ttlMs`/`cacheScope` est
   explicite au changelog (minor change 5) : les deux champs sont **requis** sur `tools/list`,
   `prompts/list`, `resources/list`, `resources/read` et `resources/templates/list`.

## 3. Sources

- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/ *(antérieure, contexte des Working Groups uniquement)*
- https://modelcontextprotocol.io/specification/versioning
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2026-07-28/basic/index.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md
- https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md
- https://modelcontextprotocol.io/seps/1699-support-sse-polling-via-server-side-disconnect.md
- https://modelcontextprotocol.io/docs/extensions/overview

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
Le passage au stateless supprime la couche de session maison de `src/serve-http.ts` : les trois
Maps `sessions` / `sessionClaims` / `sessionLastActivity`, le sweeper d'inactivité ajouté par
`performance-07`, le `McpServer` complet (26 outils) instancié par session, le `transport.onclose`
qui évince trois entrées, et l'exposition CORS de `mcp-session-id`. Ce qui reste est un handler
qui vérifie un JWT et route. Conséquence directe : le daemon devient déployable derrière un
round-robin banal, sans affinité de session ni store partagé — c'est exactement ce qui bloque
aujourd'hui le mode HTTP/Docker multi-instance pour l'auto-hébergeur.

Deux gains secondaires concrets. `ttlMs` + `cacheScope` sur `tools/list` stabilisent une liste de
26 outils côté client sans travail supplémentaire. `Mcp-Method` / `Mcp-Name` donnent à
`src/metrics.ts` (prom-client) une ventilation par opération sans parser le JSON, et l'annotation
`x-mcp-header` sur un paramètre comme `agent_id` produirait un `Mcp-Param-Agent-Id` exploitable
par un reverse-proxy pour sharder un daemon partagé multi-dépôt. Enfin `DiscoverResult.instructions`
est l'endroit canonique pour porter le protocole d'annonce (« annonce tes fichiers avant d'écrire »)
au lieu de le répéter dans les descriptions d'outils et dans `src/announce-workflow.ts`.

**Risque si on ne fait rien :**
`package.json` déclare `@modelcontextprotocol/sdk: ^1.29.0`, antérieur à la révision. Chaque
handler d'outil dépend de `getSessionClaims(extra.sessionId ?? "")` — 26 occurrences dans
`src/tools/*.ts` — c'est-à-dire que **l'identité d'agent du coordinateur est portée par l'état de
connexion MCP**, la seule chose que la révision supprime. Le chemin SSE
(`handleSse`, `SseEmitter.getEventsSince`, la reprise par `last-event-id`) implémente une
capacité retirée du cœur. Sans migration, le daemon devient un serveur « legacy 2025 » que les
clients récents traiteront en rétrocompatibilité, avec une éligibilité au retrait de HTTP+SSE qui
s'ouvre vers le 2026-08-18 — le retrait effectif restant une décision des Core Maintainers, non
datée (voir §2 point 2). C'est un chantier de release, pas un patch — et une bump
majeure du SDK est à prévoir de toute façon.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/serve-http.ts` | Cœur du chantier. L. 751 lit `mcp-session-id` ; l. 801-805 `new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), … })` ; l. 763-851 les trois branches session-existante / nouvelle-session / 404 disparaissent ; l. 819-827 `transport.onclose` évince 3 Maps ; l. 548-555 et 761 exposent `mcp-session-id` via CORS. À remplacer par un handler sans état + validation `Mcp-Method`/`Mcp-Name` (rejet `-32020`) et `405` sur GET/DELETE. |
| `src/serve-http.ts` (`handleSse`, l. 326-402) | Chemin `/api/events`. L. 366 `req.headers["last-event-id"]` et `SSE_RESUME_CAP` (l. 324) deviennent morts. Le heartbeat `":keep-alive\n\n"` (l. 384-390) est déjà conforme à la Note SSE ; il manque `X-Accel-Buffering: no` dans le `writeHead` l. 348-353. |
| `src/serve-http.ts` (l. 512, 1324, `sessionLastActivity`) | `Map<string, StreamableHTTPServerTransport>` + le sweeper d'inactivité issu de `performance-07` : supprimables si l'identité migre hors de la session. |
| `src/sse-emitter.ts` (l. 87-97) | `getEventsSince(orgId, lastId, limit)` n'a plus qu'un seul appelant, le chemin `Last-Event-ID`. Si celui-ci meurt, seule `getRecentEvents` survit. |
| `src/server-setup.ts` (l. 207-250) | `createMcpServer(services, getSessionClaims)` est « un `McpServer` par session MCP » (JSDoc l. 192-206). En stateless il n'y a plus de session : soit un serveur unique et des claims par requête, soit une réécriture de la signature. C'est le point de bascule architectural. |
| `src/tools/*.ts` (26 outils) | 26 occurrences de `getSessionClaims(extra.sessionId ?? "")`, réparties : `consultation-tools.ts` (11), `agents-tools.ts` (4), `mqtt-tools.ts` (3), `files-tools.ts` (3), `dependencies-tools.ts` (3), `status-tools.ts` (2). Toutes à rebrancher sur une source de claims par requête. |
| `src/index.ts` (l. 43-51) | Mode stdio : `getSessionClaims` renvoie des claims synthétiques et le sentinel de session est la chaîne vide (fix #133). Devient sans objet, mais stdio doit gagner `server/discover` (et le fallback `initialize` côté clients mixtes). |
| `src/auth.ts`, `src/auth/oauth-callback.ts` | `oauth-callback.ts` ne lit pas du tout le paramètre `iss` du retour IdP. Nuance normative (SEP-2468) : l'AS **SHOULD** émettre `iss`, le client **MUST** valider un `iss` *présent* contre l'issuer enregistré avant d'échanger le code — ce n'est donc pas une obligation inconditionnelle, mais l'absence totale de lecture est bien non conforme. Chantier isolé, indépendant du transport. |
| `src/discovery.ts` | Document RFC 8414 : pas de `authorization_response_iss_parameter_supported`, pas de `registration_endpoint`. Le coordinateur n'implémente donc **pas** de DCR — la dépréciation DCR→CIMD ne casse rien, mais CIMD est à évaluer si on veut publier au registre MCP. |
| `src/auth/providers/oidc.ts` (l. 109-113) | Découverte `/.well-known/openid-configuration` côté IdP amont : point d'ancrage pour la validation `iss`. |
| `src/mqtt-bridge.ts`, `src/mqtt-broker.ts` | `subscriptions/listen` est la primitive standard de push. Question ouverte : remplace-t-elle une partie du bridge MQTT→SSE maison, ou reste-t-elle orthogonale (MQTT sert aussi `cli/channel.ts`, hors MCP) ? Nuance : `notifications/progress` et `notifications/message` restent request-scoped, ils ne passent PAS par `subscriptions/listen`. |
| `cli/doctor.ts` (l. 59-80, 933-938) | La sonde `mcpInitialize` POST un `initialize` avec `protocolVersion: "2024-11-05"` et le check nommé `/mcp initialize`. À doubler d'une sonde `server/discover` avec repli sur `initialize`. |
| `cli/channel.ts` (l. 298, 465, 536) | `new Server(...)` sur stdio qui pousse `notifications/claude/channel` vers Claude Code. Contrat propriétaire Claude Code, hors cœur MCP, mais c'est un flux serveur→client : à revalider contre le modèle MRTR. |
| `dashboard/public/dashboard.js` (l. 647) | `new EventSource(\`${COORDINATOR_URL}/api/events\`)` — `EventSource` gère `Last-Event-ID` tout seul. Si le serveur cesse de l'honorer, la reprise après coupure du dashboard change de comportement silencieusement. |
| `package.json` (l. 69) | `"@modelcontextprotocol/sdk": "^1.29.0"` (résout déjà vers 1.30.0, la version installée ici). Le support 2026-07-28 n'est pas « annoncé » : il est **publié depuis le 2026-07-27**, et pas sous forme de bump de `@modelcontextprotocol/sdk` — c'est une **nouvelle famille de paquets scopés** `@modelcontextprotocol/{core,server,client}@2.0.0` (npm, `engines.node >= 20`). La migration est donc un changement de dépendance, pas un `pnpm up`. |
| `docs/ARCHITECTURE.md`, `docs/mqtt-topics.md`, `docs/troubleshooting.md` | Documentent le modèle de session, `?token=` sur `/api/events` et la comparaison MQTT vs SSE. À reprendre après décision. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> L'identité d'agent doit-elle migrer de `getSessionClaims(extra.sessionId)` — 26 occurrences dans
> `src/tools/*.ts`, adossées aux Maps `sessions`/`sessionClaims`/`sessionLastActivity` de
> `serve-http.ts` — vers des claims portés par chaque requête (JWT + `_meta.clientInfo`), ce qui
> supprime la couche de session et le `McpServer`-par-session ; ou garde-t-on une couche de session
> maison au-dessus d'un transport devenu stateless, pour préserver le modèle `agent_id` sans
> réécrire les 26 handlers ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille — à valider ou remplacer en session. Principe maison : on teste le vrai
chemin de code, on ne théorise pas.>

- [ ] Lire le `CHANGELOG` et les types de `@modelcontextprotocol/sdk` à la dernière version publiée : `server/discover`, `resultType`, `CacheableResult` et `InputRequiredResult` sont-ils exposés côté serveur, et `StreamableHTTPServerTransport` accepte-t-il encore `sessionIdGenerator` ?
- [ ] Lancer le daemon actuel et POSTer sur `/mcp` une requête sans `initialize`, avec `Mcp-Method: tools/list` et un `_meta.io.modelcontextprotocol/protocolVersion: "2026-07-28"` : observer si le SDK 1.29 répond, rejette, ou renvoie le 404 « Session not found » de `serve-http.ts:847`.
- [ ] Instrumenter `getSessionClaims` pour tracer, sur une session réelle de Claude Code, si `extra.sessionId` apporte quoi que ce soit que le JWT de la requête ne contient pas déjà — c'est le cœur de la question 6.1.
- [ ] Couper un flux `/api/events` en cours et vérifier ce que fait réellement l'`EventSource` du dashboard (`dashboard.js:647`) : mesurer combien d'événements sont rejoués par la branche `last-event-id` de `handleSse` avant d'accepter de la supprimer.
- [ ] Écrire un `server/discover` minimal dans une branche jetable et le sonder depuis `cli/doctor.ts` en parallèle de `mcpInitialize` : chiffrer l'effort réel du RPC obligatoire, indépendamment du reste de la migration.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **La date de retrait n'est pas datable.** Voir §2 point 2 : HTTP+SSE est éligible au retrait
  trois mois après que SEP-2596 atteigne Final, mais ce passage n'est pas daté publiquement et le
  retrait effectif reste une décision des Core Maintainers. Migrer « avant l'échéance » revient à
  courir après une échéance qui n'existe pas encore formellement.
- **Effort XL sur un projet à un mainteneur.** Le chantier touche le transport, l'auth, les 26
  handlers d'outils, le CLI, le SDK client et le dashboard. C'est un cycle de release entier
  consacré à ne rien ajouter de visible pour l'utilisateur.
- **Le SDK fera une partie du travail.** Une bonne moitié de la révision (headers, `_meta`,
  négociation, `resultType`) relève du transport, donc de `@modelcontextprotocol/sdk`. Attendre
  une version qui expose le modèle stateless coûte moins cher que de le préempter à la main —
  et évite d'écrire du code qui sera jeté à la bump.
- **Perdre la résumabilité SSE est une régression fonctionnelle.** `handleSse` sait aujourd'hui
  rejouer jusqu'à 1000 événements après reconnexion (`SSE_RESUME_CAP`). Le dashboard et les
  tailers CLI en bénéficient. La spec retire cette capacité du cœur MCP — mais `/api/events` est
  un endpoint REST maison, pas un transport MCP : rien n'oblige à s'aligner sur ce point précis.
  Confondre les deux ferait perdre une fonctionnalité qui marche.
- **Rétrocompatibilité obligatoire pendant longtemps.** Les clients réels du projet (Claude Code
  installé chez les utilisateurs, `cli/channel.ts`, `sdk/src/`) ne basculeront pas en bloc. Il
  faudra faire cohabiter `initialize` et `server/discover`, donc porter **les deux** modèles
  pendant toute la transition — plus de code, pas moins, sur la durée intermédiaire.
- **`subscriptions/listen` ne remplace pas MQTT.** Le bridge MQTT sert aussi `cli/channel.ts` et
  des clients non-MCP. Croire qu'on supprime `mqtt-bridge.ts` en adoptant `subscriptions/listen`
  serait une erreur de périmètre.
- **Le gain multi-instance est théorique aujourd'hui.** Le profil de déploiement réel est un
  daemon unique par machine (SQLite via `better-sqlite3`, broker MQTT embarqué). Le stateless
  débloque le scale-out, mais la base de données et le broker restent les vrais points de
  sérialisation : le bénéfice ne se matérialise pas tant que ces deux-là n'ont pas bougé.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : 4 marqueurs tranchés, SEP-2596 daté, SDK 2.0.0, 3 corrections §1/§2/§5. |
