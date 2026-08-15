# A01 — MCP 2026-07-28 : cœur stateless, HTTP+SSE déprécié, `server/discover`

> **Fiche de veille.** Les sections 1 à 5 sont remplies par la veille.
> Les sections 6.2 à 6.4 et 7 sont remplies **pendant le challenge** (session dédiée).

| Champ | Valeur |
|---|---|
| **ID** | `mcp-2026-07-28-stateless` |
| **Surface** | mcp-spec |
| **Statut** | **Current** (terme officiel de la spec ; « GA » n'est pas employé — voir §2 point 1). Confirmé sur /specification/versioning au 2026-08-14 : « The **current** protocol version is 2026-07-28 ». |
| **Disponible depuis** | `2026-07-28` (révision de protocole `2026-07-28`, remplace `2025-11-25`) |
| **Tier** | ~~T1-incontournable~~ **T2** — déclassée au challenge du 2026-08-15 : le repli legacy fonctionne (mesuré), aucune échéance de retrait n'existe. Remonte en T1 si la mesure §7.2 (1) tourne mal. |
| **Nature** | threat |
| **Effort estimé** | XL |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — SDK 2.0.0 public sur npm, tout se joue en local |
| **Statut du challenge** | ✅ **tranché** — 2026-08-15, verdict `reporter` (§7) |

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

*Pré-enregistré le 2026-08-15, AVANT toute exécution. Challenge groupé avec [`A02`](A02-mcp-sdk-typescript-v2.md).*

**Hypothèse.** La révision existe et le SDK v2 l'implémente (déjà confirmé : les 10 paquets
`@modelcontextprotocol/*@2.0.0` répondent sur npm, `@modelcontextprotocol/sdk` reste sur `latest =
1.30.0`, publié le **même jour**, 2026-07-27). Mais **aucun client réel du projet ne parle
2026-07-28** : le challenge `A04` du 2026-08-15 a déjà mesuré que Claude Code 2.1.219 envoie
`initialize` en `2025-11-25` et que le SDK 1.30.0 a zéro occurrence de la révision. Je m'attends
donc à un chantier XL dont le bénéfice utilisateur immédiat est **nul**, et à ce que la vraie
question de §6.1 — l'identité d'agent — se révèle **indépendante de la révision** : les claims sont
déjà revérifiés à chaque requête (`serve-http.ts:765` et `:777`), la `Map` de sessions n'étant
qu'un contournement du fait que `RequestHandlerExtra` n'expose pas `IncomingMessage`
(commentaire explicite `serve-http.ts:413-415`).

**Critères de refus (ce qui me ferait conclure « non bénéfique maintenant ») :**

- **A01-R1 — pas de client.** Si aucun client MCP installé ici n'émet `2026-07-28` (Claude Code,
  `cli/doctor.ts`, le harness de test), migrer maintenant, c'est écrire du code que personne
  n'appelle. → verdict au mieux `reporter`.
- **A01-R2 — pas d'horloge.** Si le retrait de HTTP+SSE reste une *éligibilité* non datée (§2
  point 2) et que la ligne v1 continue d'être publiée, l'argument « urgence » tombe.
- **A01-R3 — effort.** Si la bascule stateless impose de toucher **plus de 10 fichiers** ou de
  réécrire les 26 handlers, c'est un cycle de release entier pour zéro fonctionnalité visible :
  disqualifiant pour un mainteneur unique.
- **A01-R4 — la session porte-t-elle quelque chose ?** Si `extra.sessionId` apporte une information
  que le JWT de la requête ne contient pas, la bascule d'identité est coûteuse et risquée. Si elle
  n'apporte **rien**, alors ce sous-chantier est faisable **hors** de la migration protocole — et
  c'est lui, pas la révision, qui mérite d'être retenu.
- **A01-R5 — régression SSE.** Si couper `/api/events` en cours montre que la branche
  `last-event-id` rejoue réellement des événements que le dashboard perdrait sinon, alors
  s'aligner sur la suppression de `Last-Event-ID` est une régression : `/api/events` est un
  endpoint REST maison, pas un transport MCP.
- **A01-R6 — la fiche s'effondre.** Si `server/discover` / `resultType` / `subscriptions/listen`
  sont absents du code réel du SDK 2.0.0, la §2 est de la fiction → `refuser`.

### 6.3 Protocole de vérification

*Amendé en session le 2026-08-15. Le point « dernière version publiée de `@modelcontextprotocol/sdk` »
est reformulé : le modèle stateless vit dans les paquets `@modelcontextprotocol/{core,server,client}@2.0.0`,
pas dans la ligne 1.x (cf. §0).*

- [ ] Lire le `CHANGELOG` et les types de `@modelcontextprotocol/sdk` à la dernière version publiée : `server/discover`, `resultType`, `CacheableResult` et `InputRequiredResult` sont-ils exposés côté serveur, et `StreamableHTTPServerTransport` accepte-t-il encore `sessionIdGenerator` ?
- [ ] Lancer le daemon actuel et POSTer sur `/mcp` une requête sans `initialize`, avec `Mcp-Method: tools/list` et un `_meta.io.modelcontextprotocol/protocolVersion: "2026-07-28"` : observer si le SDK 1.29 répond, rejette, ou renvoie le 404 « Session not found » de `serve-http.ts:847`.
- [ ] Instrumenter `getSessionClaims` pour tracer, sur une session réelle de Claude Code, si `extra.sessionId` apporte quoi que ce soit que le JWT de la requête ne contient pas déjà — c'est le cœur de la question 6.1.
- [ ] Couper un flux `/api/events` en cours et vérifier ce que fait réellement l'`EventSource` du dashboard (`dashboard.js:647`) : mesurer combien d'événements sont rejoués par la branche `last-event-id` de `handleSse` avant d'accepter de la supprimer.
- [ ] Écrire un `server/discover` minimal dans une branche jetable et le sonder depuis `cli/doctor.ts` en parallèle de `mcpInitialize` : chiffrer l'effort réel du RPC obligatoire, indépendamment du reste de la migration.

### 6.4 Résultat observé

*Session du 2026-08-15, poste Windows 11 / Node 22.21.0 / Claude Code 2.1.219. Challenge groupé avec
[`A02`](A02-mcp-sdk-typescript-v2.md) : les sorties du codemod et du daemon migré sont en §6.4 d'A02.*

**Frontière exécuté / lu.** Tout ce qui suit a été **exécuté** sur ce poste, sauf mention contraire.
Rien dans cette fiche n'a été conclu sur de la lecture de doc seule.

---

#### (1) La fiche ne s'effondre pas : la révision et son SDK existent et fonctionnent

Les 10 paquets `2.0.0` répondent sur npm, et la ligne v1 est vivante — publiée le **même jour** :

```
$ npm view @modelcontextprotocol/sdk dist-tags --json
{ "latest": "1.30.0" }
$ npm view @modelcontextprotocol/sdk time --json | grep 1.29/1.30
  "1.29.0": "2026-03-30T16:50:42.718Z",
  "1.30.0": "2026-07-27T17:56:01.640Z"
$ npm view @modelcontextprotocol/{server,client,core,node,codemod,server-legacy,express} dist-tags
server = 2.0.0 · client = 2.0.0 · core = 2.0.0 · node = 2.0.0
codemod = 2.0.0 · server-legacy = 2.0.0 · express = 2.0.0 (+ alpha 2.0.0-alpha.4)
```

Grep sur les 110 fichiers `dist` des paquets v2 installés (`scratchpad/v2probe`) :

```
2026-07-28 : 942 lignes      server/discover           : 160     resultType   : 304
2025-11-25 : 336 lignes      subscriptions/listen      : 146     inputRequired: 437
                             createMcpHandler          :  62     authInfo     : 152
                             NodeStreamableHTTPServerTransport : 38
                             createRequestStateCodec   :  30     versionNegotiation : 52
```

→ **A01-R6 non déclenché.** Toute la §2 de cette fiche est du code réel, pas de la fiction.

---

#### (2) `createMcpHandler` : la révision 2026-07-28 servie pour de vrai (PoC exécuté)

PoC `scratchpad/v2probe/poc-handler.mjs` — `createMcpHandler(factory)` + `toNodeHandler`, sur un
`node:http` nu, exactement la forme de `src/serve-http.ts` :

```
=== 1. server/discover (2026-07-28) ===
HTTP 200 | mcp-session-id: null
{"result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{"listChanged":true}},
 "resultType":"complete","ttlMs":0,"cacheScope":"private",
 "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"poc-v2","version":"0.0.0"}}},"jsonrpc":"2.0","id":1}

=== 2. tools/list stateless 2026-07-28, SANS initialize ===
HTTP 200 | mcp-session-id: null
{"result":{"tools":[...],"resultType":"complete","ttlMs":0,"cacheScope":"private",...}}

=== 3. tools/call whoami stateless 2026-07-28 -> ctx.http.authInfo ? ===
HTTP 200
"httpAuthInfo": { "token": "poc-token", "clientId": "poc-client", "scopes": ["coordinator:write"],
                  "extra": { "sub": "agent-alpha", "org": "acme", "role": "admin", "jti": "j-1" } }
"sessionId": null

=== 4. initialize 2025-11-25 (le meme handler sert-il l'ere legacy ?) ===
HTTP 200 | mcp-session-id: null
data: {"result":{"protocolVersion":"2025-11-25", ...}}

=== 5. GET (la revision dit SHOULD 405) ===
HTTP 405 {"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}
```

Quatre faits mesurés, tous nouveaux par rapport à la fiche :

- `server/discover`, `resultType`, `ttlMs`/`cacheScope`, `_meta.serverInfo` : **fournis par le SDK**,
  zéro ligne à écrire. Le point 5 du §6.3 (« chiffrer l'effort du RPC obligatoire ») est répondu :
  l'effort est **nul** si on adopte `createMcpHandler`.
- Le **même** handler sert l'ère 2025 (`legacy: 'stateless'` par défaut). → le contre-argument
  « rétrocompatibilité obligatoire = porter les deux modèles = plus de code » de §6.5 **tombe**.
- **`mcp-session-id: null` même sur l'`initialize` legacy** : les trois Maps de session et le sweeper
  n'ont plus rien à garder, dans les deux ères.
- `ctx.http.authInfo` porte les claims vérifiés, `extra` compris. → réponse directe à §6.1.

---

#### (3) Le fait qui recadre §6.1 : `extra.authInfo` marche **déjà** sur le SDK 1.30.0 installé

`src/serve-http.ts:413-415` justifie la `Map` de claims par : *« RequestHandlerExtra in the MCP SDK
does not expose IncomingMessage to tool handlers. Task 23.5 will populate a sessionClaims Map
instead. »* **Ce commentaire est périmé.** Dans la version installée ici :

```
node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0_zod@4.4.3/.../dist/esm/shared/protocol.d.ts
  181:    authInfo?: AuthInfo;        // "Information about a validated access token"
  201:    requestInfo?: RequestInfo;  // "The original HTTP request."
dist/esm/server/streamableHttp.js:131   const authInfo = req.auth;
dist/esm/shared/protocol.js:349         authInfo: extra?.authInfo,
```

PoC `scratchpad/v1probe/poc.mjs` — serveur `node:http` + `McpServer` **1.30.0** + **vrai client MCP**,
un outil `whoami` qui ne consulte AUCUNE map :

```
### Q1 — extra vu par le handler d'outil (aucune Map de claims) :
{
  "authInfo": { "token": "poc-token", "clientId": "poc-client",
                "scopes": ["coordinator:write"],
                "extra": { "sub": "agent-alpha", "org": "acme", "role": "admin", "jti": "j-1" } },
  "sessionId": "f8d5fab0-9fd1-430e-8a19-5680e05940cb",
  "hasRequestInfo": true,
  "authorizationHeader": "Bearer poc-token"
}
```

→ **A01-R4 tranché, et dans le sens qui coûte le moins.** `extra.sessionId` n'apporte **rien** que la
requête ne porte déjà : `authenticateMcpRequest` est de toute façon appelée à chaque requête
(`serve-http.ts:765` et `:777`) et ses claims écrasent la map à chaque tour (`:769`). La bascule
d'identité de §6.1 **ne dépend pas de la révision 2026-07-28 ni du SDK v2** — elle se fait sur la
ligne v1, aujourd'hui.

---

#### (4) Le daemon réel face à 2026-07-28 : rejet net, pas dégradation gracieuse

Daemon courant lancé sur `PORT=39412`, `AUTH_ENABLED=false` (`scratchpad/probe-daemon.mjs`) :

```
=== 0. /health ===
HTTP 200 {"status":"alive","uptime_seconds":117,"version":"2.0.1","auth_enabled":false,...}

=== A. POST /mcp stateless 2026-07-28, sans initialize ===
HTTP 400 | mcp-session-id: null
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}

=== B. POST /mcp initialize protocolVersion 2026-07-28 ===
HTTP 200 | mcp-session-id: 34a9503a-c08f-4904-8826-e79a13e368dd
data: {"result":{"protocolVersion":"2025-11-25", ... "serverInfo":{"name":"io.github.swoofer/mcp-coordinator","version":"2.0.1"}}}

=== C. POST /mcp server/discover ===
HTTP 400 {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}

=== D. GET /mcp (la revision dit SHOULD 405) ===
HTTP 404 {"error":"Session not found. Send a request without mcp-session-id to start a new session."}

=== E. DELETE /mcp ===
HTTP 404 (idem)
```

Point 2 du §6.3 répondu : ce n'est **ni** le 404 « Session not found » de `serve-http.ts:847`, **ni**
une négociation — c'est le transport SDK qui rend `-32000` avant d'atteindre notre routage. Un client
2026-07-28 ne « retombe » pas en legacy : il échoue. Sur `initialize`, en revanche, la rétrogradation
vers `2025-11-25` est silencieuse.

---

#### (5) Un client moderne existe — et il retombe proprement sur nous. Mesuré.

> ⚠️ **Cette sous-section a été réécrite en cours de session.** Ma première rédaction concluait
> « aucun client n'émet 2026-07-28 » ; un sous-agent adversarial l'a réfutée, et **il avait raison**.
> Le fait est corrigé ci-dessous, et il a fallu une mesure de plus pour trancher.

**Ce qui est faux dans ma première lecture.** `claude --version` rend `2.1.219 (Claude Code)` sur ce
poste — une version publiée **avant** la sortie de la révision. Le changelog officiel
(`raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`, fetché le 2026-08-15, dernière
version listée **2.1.233**) porte deux entrées vérifiées mot pour mot :

> **2.1.232** — « Fixed MCP connections hanging for the full 30-second connect timeout when a server
> fails to answer or sends a malformed reply to the **protocol-version probe** »
>
> **2.1.233** — « Fixed **MCP v2** connections endlessly reopening the **subscriptions/listen**
> stream against servers that terminate long-held streams on a fixed timeout »

`subscriptions/listen` n'existe que dans `2026-07-28`. **Claude Code est donc un client de la
révision**, et il **sonde**. La mesure de Claude Code en `2025-11-25` (challenge
[`A04`](A04-subscriptions-listen.md)) porte sur un binaire pré-spec : elle est périmée, ici comme
dans `A04`.

**Ce qui reste vrai, mais ne prouvait rien.** Les constantes du SDK v2 —
`LATEST_PROTOCOL_VERSION = 2025-11-25`, `DEFAULT_NEGOTIATED = 2025-03-26`,
`SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`
dans `@modelcontextprotocol/{client,server}@2.0.0` — ne décrivent **que le handshake `initialize`
legacy**, par conception. En déduire que le SDK v2 « ne parle pas 2026-07-28 » est un contresens ;
l'ère moderne passe par `versionNegotiation` et `server/discover`, pas par cette liste.
**Cet argument est retiré.**

**La mesure qui tranche pour de bon** (`scratchpad/v2probe/poc-auto.mjs`) : un client
`@modelcontextprotocol/client@2.0.0` lancé dans les trois modes contre les deux daemons —
le daemon courant (SDK 1.30.0, port 39412) et le même code migré par codemod (SDK v2, port 39413).

```
=== daemon COURANT (sdk 1.30.0) | versionNegotiation: undefined  (defaut = 'legacy') ===
OK en 104 ms | era = legacy | serverVersion = {"name":"io.github.swoofer/mcp-coordinator","version":"2.0.1"}
outils listes : 26

=== daemon COURANT (sdk 1.30.0) | versionNegotiation: {"mode":"auto"}   <-- LE MODE QUI SONDE ===
OK en 33 ms | era = legacy | serverVersion = {"name":"io.github.swoofer/mcp-coordinator","version":"2.0.1"}
outils listes : 26

=== daemon COURANT (sdk 1.30.0) | versionNegotiation: {"mode":{"pin":"2026-07-28"}} ===
ECHEC en 7 ms | SdkError: Version negotiation failed: the server did not offer pinned protocol
version 2026-07-28 via server/discover (no fallback in pin mode)

=== daemon MIGRE par codemod (v2) : resultats IDENTIQUES aux trois lignes ci-dessus ===
```

Trois faits, tous mesurés :

1. **Un client moderne qui sonde se connecte à notre daemon actuel — en 33 ms, avec ses 26 outils.**
   Le `-32000` que notre serveur rend sur `server/discover` est une réponse JSON-RPC bien formée :
   le client la lit, conclut « serveur legacy », et bascule. Ce n'est ni un hang, ni une erreur.
2. Le seul mode qui casse est `{ pin: '2026-07-28' }` — un client qui **refuse explicitement** tout
   repli. Ce n'est le défaut de personne.
3. Le daemon migré par codemod se comporte **exactement** comme le daemon actuel : le renommage
   n'achète rien ici non plus.

→ **A01-R1 n'est PAS déclenché tel qu'il était écrit** (« aucun client n'émet 2026-07-28 » : faux).
Mais son intention — *migrer maintenant sert-il un utilisateur réel ?* — est tranchée par la mesure,
et dans le même sens : **non, parce que le repli fonctionne**. Ce n'est plus « personne ne nous
appelle en 2026-07-28 », c'est « ceux qui le peuvent nous appellent quand même, sans perte ».

**Limite honnête de cette mesure :** j'ai éprouvé le client du SDK v2, **pas** le binaire Claude Code
≥ 2.1.232, qui n'est pas installé ici (poste en 2.1.219). L'entrée 2.1.232 dit que Claude Code
pouvait *pendre 30 s* face à un serveur qui « ne répond pas ou répond de façon malformée » à la
sonde — notre `-32000` en 7 ms n'est ni l'un ni l'autre pour le SDK, mais cela n'a pas été vérifié
contre le binaire lui-même. **C'est la mesure à refaire après mise à jour de Claude Code**, et elle
est nommée comme telle en §7.

---

#### (5 bis) La mesure de rattrapage : Claude Code **2.1.233** sur le fil

*Faite en fin de session, après mise à jour du poste (2.1.219 → **2.1.233**, `claude update`), pour
lever la limite reconnue au (5). C'est la mesure qui ferme la fiche.*

Montage : le daemon réel sur 39412, un **proxy d'écoute** sur 39415 qui journalise chaque requête,
et un `.mcp.json` jetable pointant Claude Code sur le proxy.

```
$ claude -p "Appelle l'outil MCP coordinator list_agents…" \
    --mcp-config …/mcp.json --strict-mcp-config --allowedTools mcp__coordinator__list_agents
duree: 9 s | reponse: 3
```

Ce que Claude Code **2.1.233** a réellement mis sur le fil :

```
>>> POST /mcp  method=initialize
    headers: {"accept":"application/json, text/event-stream"}
    body: {"method":"initialize","params":{"protocolVersion":"2025-11-25",
           "capabilities":{"roots":{"listChanged":true},"elicitation":{}},
           "clientInfo":{"name":"claude-code","version":"2.1.233",…}},"jsonrpc":"2.0","id":0}
<<< 200 OK   data: {"result":{"protocolVersion":"2025-11-25", …}}

>>> POST /mcp  method=notifications/initialized
    headers: {…,"mcp-protocol-version":"2025-11-25","mcp-session-id":"b688aca8-…"}
<<< 202 Accepted

>>> GET /mcp   headers: {"accept":"text/event-stream","mcp-protocol-version":"2025-11-25",
                         "mcp-session-id":"b688aca8-…"}

>>> POST /mcp  method=tools/list      <<< 200 OK  (les 26 outils)
>>> POST /mcp  method=tools/call      body: {"name":"list_agents", …}   <<< 200 OK
```

Quatre faits, tous sur le fil :

1. **`protocolVersion: "2025-11-25"`.** Le binaire dont le changelog annonce « MCP v2 » et
   `subscriptions/listen` négocie l'ère **legacy** avec notre serveur.
2. **Aucun `server/discover`.** Il n'y a **pas de sonde du tout** dans cette trace. La capacité
   v2 existe côté Claude Code ; elle ne se traduit par aucun octet 2026-07-28 ici.
3. **Il utilise tout ce que la révision supprime** : `Mcp-Session-Id`,
   `notifications/initialized`, et l'**endpoint GET** — auquel notre serveur répond 404 sans que
   cela empêche quoi que ce soit.
4. **Le parcours complet marche** : 26 outils listés, `list_agents` appelé, réponse en 9 s.

→ **La conclusion de A01-R1 est confirmée par la mesure directe, sur le binaire courant** : migrer
le cœur en 2026-07-28 aujourd'hui ne servirait **aucun** client réel de ce projet. Ce qui était faux
était ma justification (« aucun client ne parle la révision »), pas la conclusion.

→ **Et la mesure de [`A04`](A04-subscriptions-listen.md) n'est donc PAS périmée** : `initialize` en
`2025-11-25` se re-mesure à l'identique sur 2.1.233. Seul le raisonnement « Claude Code est un
binaire pré-spec, donc la mesure ne vaut rien » était faux — la mesure, elle, tient.

#### (6) `/api/events` : supprimer `Last-Event-ID` serait une régression chiffrée

`scratchpad/probe-sse.mjs`, contre le daemon réel : 3 agents enregistrés, 120 annonces, coupure du
flux, 80 annonces pendant la coupure, reconnexion avec et sans `Last-Event-ID`.

```
annonces acceptees : 120/120

### Sans Last-Event-ID   : 50 evenements rejoues | ids 554 -> 603
80 annonces supplementaires apres la coupure (dernier id vu : 603)
### Avec Last-Event-ID=603 : 400 evenements rejoues | ids 604 -> 1003
### Sans Last-Event-ID   : 50 evenements rejoues | ids 954 -> 1003

### DELTA = 350 evenements perdus si Last-Event-ID disparait, sur une coupure de 80 evenements.
```

→ **A01-R5 déclenché**, et le contre-argument correspondant de §6.5 passe de « plausible » à
**mesuré** : sur une coupure banale (80 annonces → 400 événements), la branche `Last-Event-ID`
rejoue 400 événements là où le repli `getRecentEvents` en rend 50. `/api/events` est un endpoint
REST maison, pas un transport MCP : SEP-2575 ne s'y applique pas.

---

#### (7) Effort réel

| Mesure | Valeur |
|---|---|
| Fichiers du dépôt important `@modelcontextprotocol/sdk` | **21** (7 dans `src/`, 1 dans `cli/`, 13 dans `tests/`) |
| Appels `server.tool(` | **26**, tous dans `src/tools/*.ts` |
| `extra.sessionId` en code | **26** (1 par outil), forme invariante `getSessionClaims(extra.sessionId ?? "")` |
| `authInfo` dans le dépôt | **0 occurrence** |
| Littéraux de version de protocole dans `src/` | **0** — déléguée au SDK ; les 3 littéraux du dépôt sont dans `cli/doctor.ts:66` (`2024-11-05`) et 2 tests |
| Plomberie de session supprimable dans `serve-http.ts` | l. 751-851 (branche `/mcp` à 3 cas), l. 1323-1375 (3 Maps + TTL + sweeper), l. 512-514, l. 1377-1383 → **> 130 lignes** |

→ **A01-R3 déclenché** au sens strict (21 fichiers > 10) pour la migration complète. Le
sous-ensemble « identité » seul touche **8 fichiers** (`serve-http.ts` + 6 `src/tools/*.ts` +
`server-setup.ts`), plus 5 fichiers de test.

### 6.5 Contre-arguments

*Repris le 2026-08-15 après l'expérience et après trois passes adversariales. Barré = tombé.*

- ~~**La date de retrait n'est pas datable.**~~ → **tient, et c'est vérifié aujourd'hui.**
  `/specification/2026-07-28/deprecated` fetchée le 2026-08-15 : section **« Removed » vide** (« No
  features have been removed under this policy yet »), HTTP+SSE en « Three months after SEP-2596
  reaches Final », Roots/Sampling/Logging/DCR en « First revision released on or after
  **2027-07-28** ». Et : « the actual removal is a Core Maintainer decision taken during release
  preparation and may happen later ». **Aucune échéance calendaire n'existe.**
- **Effort XL sur un projet à un mainteneur** → **tient, mais il fallait le couper en deux.**
  Mesuré : le changement de *paquets* n'est pas XL (6 erreurs `tsc`, 48/49 tests — voir §6.4 d'A02).
  C'est l'adoption de `createMcpHandler` + la réécriture de l'identité qui l'est.
- **Le SDK fera une partie du travail** → **confirmé, et plus fort que prévu.** `createMcpHandler`
  livre `server/discover`, `resultType`, `ttlMs`/`cacheScope`, le `405` sur GET et l'enveloppe
  `_meta.serverInfo` **sans une ligne de notre code** (§6.4 (2)).
- **Perdre la résumabilité SSE est une régression fonctionnelle** → **confirmé et chiffré :
  350 événements perdus** sur une coupure de 80 annonces (§6.4 (6)). `/api/events` est un endpoint
  REST maison ; SEP-2575 ne s'y applique pas. À ne pas toucher.
- ~~**Rétrocompatibilité obligatoire pendant longtemps : porter les deux modèles = plus de code.**~~
  **TOMBE.** Mesuré : `createMcpHandler` avec son défaut `legacy: 'stateless'` sert les **deux**
  ères depuis **un seul** handler (§6.4 (2), essai 4). Il n'y a pas deux modèles à porter.
- **`subscriptions/listen` ne remplace pas MQTT** → hors périmètre ici, tranché en
  [`A04`](A04-subscriptions-listen.md).
- **Le gain multi-instance est théorique aujourd'hui** → **renforcé, et on sait maintenant pourquoi.**
  Tant que `sessionIdGenerator` est fourni (`serve-http.ts:801-805`), l'affinité de session reste
  obligatoire : porter les claims par requête ne débloque **aucun** round-robin. Pour l'obtenir il
  faut passer le transport en stateless, donc **un transport + un `McpServer` neufs par requête
  HTTP**. Et SQLite + le broker MQTT embarqué restent les vrais points de sérialisation.

**Ajoutés par l'expérience — contre la bascule d'identité de §6.1 :**

- **stdio n'a pas d'`authInfo`, et ce n'est pas contournable.**
  `@modelcontextprotocol/sdk@1.30.0`, `dist/esm/server/stdio.js:47` : `this.onmessage?.(message)` —
  **sans second argument**. Le mode stdio (`src/index.ts:43-51`) n'a ni `IncomingMessage` ni
  `req.auth`. Le résolveur injecté `createMcpServer(services, getSessionClaims)` **ne disparaît
  donc pas** : au mieux il change de signature. On ne unifie pas l'identité sur un seul chemin.
- **`AuthInfo` est un mauvais véhicule pour `AuthClaims`.** `dist/esm/server/auth/types.d.ts` :
  `token: string`, `clientId: string`, `scopes: string[]` sont **obligatoires**, et
  `extra?: Record<string, unknown>` n'est **pas typé**. Or `src/auth.ts` ne retourne jamais le token
  brut, le mode cookie n'a pas de bearer du tout, et sous `AUTH_ENABLED=false`
  (`serve-http.ts:421-424`) il n'y a aucun token. On fabriquerait donc un faux `AuthInfo` sur 2
  chemins d'auth sur 3, et les 26 handlers passeraient d'un `AuthClaims | null` **typé** à un
  `extra.authInfo?.extra as AuthClaims` — **26 casts non vérifiés**. C'est une régression de sûreté
  de types, pas un gain.
- **Seule `sessionClaims` meurt — les deux autres Maps survivent.** `sessions` reste le registre de
  transports (`serve-http.ts:763`, `:774`) : sans lui, impossible de router une requête vers le
  transport qui tient le flux. `sessionLastActivity` reste le garde anti-fuite
  (`serve-http.ts:1335-1370`), exporté sur le handle et **couvert par un test qui passe**. Il n'a
  jamais porté l'identité. → **la promesse de §4 (« la couche de session disparaît ») est fausse**
  tant qu'on ne passe pas le transport en stateless.
- **Coût de test : 43 sites, pas « quelques tests ».** Compté dans `tests/unit/*.test.ts` :
  `mcp-tool-handlers` 28, `mcp-tool-org-scoping` 11, `mcp-tool-ergonomics` 2, `mqtt-tools` 2 =
  **43 appels `fakeExtra(`**, dont **13 `fakeExtra(undefined)`** qui encodent la régression #133.
  Ces 13-là ne se réécrivent pas mécaniquement : ils changent de sens.
- **Le mode de défaillance s'inverse, et dans le mauvais sens.** Aujourd'hui `getSessionClaims`
  rend `null` et le handler lève `"Session has no captured claims (auth bug)"`
  (`src/tools/agents-tools.ts:37`) — *fail-closed*. `extra.authInfo` absent est **silencieusement
  `undefined`**. Si un `?? claimsParDéfaut` s'installe pour couvrir stdio, une régression de
  transport dégraderait l'identité en silence.

**Ajouté par l'expérience — en faveur de ne rien faire :**

- **Le repli fonctionne, mesuré.** Un client v2 en `mode: 'auto'` — celui qui sonde
  `server/discover` — se connecte au daemon actuel **en 33 ms et liste ses 26 outils** (§6.4 (5)).
  Le « risque si on ne fait rien » de §4 (« serveur legacy que les clients traiteront en
  rétrocompatibilité ») est réel mais **sans perte fonctionnelle** : la rétrocompatibilité, ici,
  marche.

**Ajouté par l'expérience — en défaveur de ne rien faire :**

- **Claude Code sonde désormais, et ça n'a pas été mesuré contre notre daemon.** Le changelog
  officiel donne « protocol-version probe » en **2.1.232** et « MCP v2 … subscriptions/listen » en
  **2.1.233**. Le poste est en 2.1.219. L'entrée 2.1.232 corrige un cas où Claude Code *pendait
  30 s* face à un serveur qui répond mal à la sonde. Notre daemon répond `-32000` en 7 ms — bien
  formé pour le SDK, **non vérifié contre le binaire**. C'est le seul risque non éteint de cette
  fiche, et c'est une **mesure**, pas un chantier.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | **Claude Code 2.1.233 — le binaire « MCP v2 » — négocie `2025-11-25` avec notre daemon et n'envoie aucun `server/discover`. Mesuré sur le fil.** Il utilise même l'endpoint GET que la révision supprime. En parallèle, un client SDK qui *sonde* réellement (`mode: 'auto'`) se replie proprement en **33 ms avec les 26 outils**. Aucune échéance de retrait n'existe (`/deprecated` : section « Removed » vide). Et la bascule d'identité de §6.1, seule partie qui paraissait faisable tout de suite, **ne livre pas ce que la fiche lui prête** : stdio n'a pas d'`authInfo`, seule `sessionClaims` mourrait, et le prix est de 26 casts non typés + 43 sites de test. |
| **Issue / PR** | — (aucune : rien à faire aujourd'hui) |
| **Jalon visé** | Réveil conditionnel, voir §7.2 |

### 7.1 La réponse à la question de §6.1

**Ni l'un ni l'autre des deux termes proposés.** La question posait un choix entre « migrer
l'identité vers des claims par requête » et « garder une couche de session maison au-dessus d'un
transport stateless ». L'expérience montre que le premier terme **ne fait pas ce qu'on lui demande**
et que le second **n'est pas le sujet** :

1. **Le mécanisme existe déjà, sur le SDK installé.** `RequestHandlerExtra.authInfo`
   (`protocol.d.ts:181`), alimenté par `req.auth` (`streamableHttp.js:131`), atteint le handler
   d'outil — prouvé avec un vrai client MCP v1 (§6.4 (3)). Le commentaire de `serve-http.ts:413-415`
   qui justifie la `Map` de claims (« RequestHandlerExtra … does not expose IncomingMessage ») est
   **périmé** et devrait être corrigé, même sans rien changer d'autre.
2. **Mais il ne supprime pas la couche de session.** `sessions` (registre de transports) et
   `sessionLastActivity` (garde anti-fuite, testé et passant) survivent. Seule `sessionClaims`
   meurt. La promesse de §4 — « ce qui reste est un handler qui vérifie un JWT et route » —
   n'est vraie **que** si le transport passe en stateless, ce qui impose un transport + un
   `McpServer` neufs **par requête HTTP**.
3. **Et il coûte plus qu'il ne rapporte aujourd'hui.** `AuthInfo` exige `token`/`clientId`/`scopes`
   qu'on n'a pas sur 2 chemins d'auth sur 3, son `extra` n'est pas typé (26 casts non vérifiés
   remplaçant un `AuthClaims | null` typé), stdio ne le reçoit pas du tout, et 43 sites de test
   changent — dont 13 qui encodent la régression #133 et changent de *sens*, pas de forme.

**Conséquence de cadrage :** le vrai levier n'est pas l'identité, c'est `createMcpHandler`. Il rend
la question de §6.1 caduque (plus de session du tout, dans les deux ères) au lieu de la trancher.
Il appartient donc à [`A02`](A02-mcp-sdk-typescript-v2.md), et il y est reporté.

### 7.2 Conditions de réveil

Trois, dont une est une **mesure à faire, pas un chantier** :

| # | Condition | Ce qu'on regarde |
|---|---|---|
| ~~1~~ | ~~Mettre Claude Code à jour et refaire la mesure~~ | ✅ **FAIT le 2026-08-15.** Poste passé en **2.1.233**, trace capturée au proxy (§6.4 (5 bis)) : `initialize` en `2025-11-25`, **zéro `server/discover`**, endpoint GET utilisé, parcours complet en 9 s. Aucune dégradation. **Le report est confirmé par la mesure**, pas seulement par le raisonnement. |
| 2 | Claude Code se met à envoyer `server/discover` à notre daemon | Se re-mesure en 5 minutes avec le même proxy (`scratchpad/wire-proxy.mjs`). C'est le signal le plus précoce et le moins coûteux à surveiller. |
| 3 | Un client réellement utilisé passe en `{ pin: '2026-07-28' }` ou perd le repli legacy | C'est le seul mode qui casse aujourd'hui (mesuré, §6.4 (5)). |
| 4 | Une ligne apparaît dans la section **« Removed »** de `/specification/*/deprecated` | Elle est vide au 2026-08-15. C'est le seul signal calendaire qui existera jamais. |

### 7.3 Ce qui est écarté explicitement, et pourquoi

- **Supprimer la branche `Last-Event-ID` de `/api/events`** — écarté. Mesuré : **−350 événements**
  sur une coupure banale. `/api/events` est un endpoint REST maison, SEP-2575 ne le concerne pas.
  À ne pas confondre avec le transport MCP, sous aucun prétexte.
- **La bascule d'identité seule** — écartée, voir §7.1. Elle sera faite *par* `createMcpHandler`
  ou pas du tout.
- **`server/discover` écrit à la main sur la ligne v1** — écarté : `createMcpHandler` le fournit
  gratuitement, l'écrire nous-mêmes serait du code jeté à la bascule.

### 7.4 Corrections apportées à la fiche par ce challenge

1. **§4 « Risque si on ne fait rien » était trop noir.** « Les clients récents traiteront le daemon
   en rétrocompatibilité » est exact — mais la rétrocompatibilité **fonctionne**, mesurée à 33 ms
   avec les 26 outils. Ce n'est pas un risque, c'est le comportement nominal.
2. **§4 « ce qui reste est un handler qui vérifie un JWT et route » est faux** tant que le transport
   n'est pas stateless : deux Maps sur trois survivent à la bascule d'identité (§7.1 point 2).
3. **§5 `serve-http.ts` — le commentaire du code, pas la fiche, est en cause.**
   `serve-http.ts:413-415` affirme que le SDK n'expose pas la requête HTTP aux handlers d'outils.
   C'est faux depuis au moins 1.30.0 (`authInfo` **et** `requestInfo`).
4. **Une erreur commise pendant ce challenge, corrigée, puis re-tranchée par la mesure.**
   J'ai d'abord écrit « aucun client ne parle 2026-07-28 » (faux : le changelog Claude Code donne
   « protocol-version probe » en 2.1.232 et « MCP v2 … subscriptions/listen » en 2.1.233), puis
   conclu que la mesure « Claude Code parle 2025-11-25 » était périmée. **Elle ne l'est pas.** Le
   poste a été mis à jour en 2.1.233 et la trace au proxy (§6.4 (5 bis)) montre le même
   `initialize` en `2025-11-25`, sans aucune sonde. À retenir : *capacité v2 ≠ trafic v2*, et
   [`A04`](A04-subscriptions-listen.md) n'a **pas** besoin d'être re-mesurée — sa mesure est
   re-confirmée sur le binaire courant.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : 4 marqueurs tranchés, SEP-2596 daté, SDK 2.0.0, 3 corrections §1/§2/§5. |
| 2026-08-15 | Poste mis à jour en Claude Code **2.1.233** et session rejouée au proxy d'écoute : `initialize` en `2025-11-25`, **aucun `server/discover`**, endpoint GET utilisé, 26 outils, `tools/call` OK en 9 s. Condition de réveil §7.2 (1) **levée** ; la mesure de `A04` est re-confirmée, pas périmée. |
| 2026-08-15 | Challenge groupé avec `A02`. PoC v1 et v2 exécutés, daemon réel sondé, `/api/events` mesuré, 3 passes adversariales. **Verdict : reporter**, tier T1 → T2. §6.1 tranché en §7.1 : la bascule d'identité ne supprime pas la couche de session et coûte plus qu'elle ne rapporte ; le vrai levier est `createMcpHandler`, reporté avec `A02`. Corrigé en séance : « aucun client ne parle 2026-07-28 » était faux (Claude Code 2.1.232/2.1.233). |
