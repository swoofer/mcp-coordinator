# A04 — `subscriptions/listen` : le push standardisé face à `sse-emitter` et `mqtt-bridge`

| Champ | Valeur |
|---|---|
| **ID** | `subscriptions-listen` |
| **Surface** | mcp-spec |
| **Statut** | GA — le vocabulaire officiel de la spec est Draft/**Current**/Final : la révision `2026-07-28` est « current ». Nuance : `notifications/tasks` relève de l'extension optionnelle `io.modelcontextprotocol/tasks`, pas du cœur. |
| **Disponible depuis** | `2026-07-28` (révision de spec, SEP-2575) |
| **Tier** | T1-incontournable |
| **Nature** | replace-homemade-code |
| **Effort estimé** | L |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — PoC possible hors repo ; SDK v1 du repo ignore la méthode |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** ✅ saine

**Corrections apportées :**

- §2 — marqueur keep-alive tranché : la spec (Streamable HTTP, encadré *Note*) écrit « servers **are encouraged to** periodically emit an SSE comment line (a line beginning with a colon, e.g. `:\r\n`) as a keep-alive ». C'est bien non normatif (pas de MUST/SHOULD). La fiche avait raison.
- §2 — désaccord « ordre de l'accusé de réception » tranché : les deux lectures sont exactes et coexistent dans le texte. Citation ajoutée dans la fiche.
- §2 — ajout de `server/discover`, absent de la fiche : c'est le RPC **obligatoire** qui remplace `initialize` pour la découverte des capabilities serveur. `capabilities.resources.subscribe` / `.listChanged` y sont déclarées, pas dans le `_meta` des requêtes (le `_meta` ne porte que les métadonnées **client**). Sans ce point, §1 laisse croire que tout est passé dans `_meta`.
- §2 — `notifications/tasks` : nom de méthode confirmé mot pour mot sur la page Tasks (« Servers can push status updates via `notifications/tasks`. Clients opt into these through the `subscriptions/listen` mechanism »). En revanche le champ de filtre correspondant n'apparaît pas dans le tableau à 4 champs du cœur : marqué `(non vérifiable ici — voir ext-tasks)`.
- §2 — précision sur `notifications/cancelled` : en Streamable HTTP la spec dit explicitement qu'aucun `notifications/cancelled` n'est attendu, la fermeture du flux SSE **EST** l'annulation. La fiche disait « stdio » sans dire que c'est exclusif.
- §3 — ajout de la source SDK TypeScript v2, qui change la lecture de la faisabilité (voir Testabilité).

**Vérifications sans correction :** statut `current` de la révision `2026-07-28` confirmé ce jour sur `/specification/versioning` (« The **current** protocol version is **2026-07-28** »). Le périmètre du remplacement (`resources/subscribe` + endpoint GET, `resources/unsubscribe` non nommé) est exact au mot près. Les 9 lignes de §5 et les 14 fichiers cités ont tous été ouverts : **tous les numéros de ligne sont justes** (`sse-emitter.ts:87/116`, `serve-http.ts:324/326-402/384/801/1324`, `server-setup.ts:207/242-247`, `channel.ts:465`, `mqtt-bridge.ts:142-144`, `dashboard.js:647`, `index.ts:50`). L'absence totale de handler de ressources dans le repo est confirmée par grep (`ListResourcesRequestSchema`, `ReadResourceRequestSchema`, `registerResource`, `resources/subscribe` : 0 occurrence dans `src/`, `cli/`, `sdk/src/`). `sdk/src/client.ts` : 0 occurrence de `events`/`stream`, confirmé.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle

Ce qui se teste ici, tout de suite : les paquets `@modelcontextprotocol/server@2.0.0` et `@modelcontextprotocol/client@2.0.0` sont publiés sur npm en `latest` (depuis le 2026-07-28) et implémentent la révision. Aucun credential Anthropic, header beta ou allowlist n'est requis — c'est un protocole ouvert. Un PoC autonome (serveur v2 exposant une ressource `coord://default/working-files` alimentée par `WorkingFilesTracker`, client v2 ouvrant un `subscriptions/listen`) tranche la question §6.1 et mesure la perte de résumabilité, sur ce poste Windows avec Node 22 + pnpm.

Ce qui ne se teste **pas** dans le vrai chemin de code du repo : le serveur MCP du projet tourne sur `@modelcontextprotocol/sdk` v1 (déclaré `^1.29.0`, installé `1.30.0`), où `subscriptions/listen` et `subscriptionId` sont **absents** (grep sur `node_modules` : 0 occurrence). Le principe maison « on teste le vrai chemin de code » suppose donc au préalable une migration v1 → paquets v2 (`@modelcontextprotocol/server` / `@modelcontextprotocol/client`, renommage de paquet, pas un bump de version) — soit déjà l'essentiel de l'effort L. Second point non testable : la thèse de portabilité (« un client MCP non-Claude-Code s'abonne ») demande un autre client MCP parlant 2026-07-28 ; aucun n'est installé ici.

---

## 1. Ce que c'est

La révision MCP `2026-07-28` supprime l'endpoint HTTP GET du transport Streamable HTTP ainsi que le RPC `resources/subscribe`, et les remplace par une méthode unique : `subscriptions/listen`. Le client POST une requête `subscriptions/listen` dont les `params` portent un filtre `notifications` à quatre champs ; la réponse est un flux long (SSE en HTTP, messages entrelacés sur stdio) sur lequel le serveur pousse uniquement les types demandés — il NE DOIT PAS émettre un type non souscrit. Le serveur envoie d'abord `notifications/subscriptions/acknowledged`, dont le `params.notifications` reflète le sous-ensemble réellement honoré (le serveur peut refuser une partie du filtre). Chaque message du flux, réponse finale incluse, porte `_meta["io.modelcontextprotocol/subscriptionId"]` dont la valeur est l'ID JSON-RPC de la requête `listen` elle-même — ce n'est pas un identifiant opaque généré par le serveur, et c'est ce qui permet de démultiplexer plusieurs souscriptions sur un même canal stdio.

Deux choses ne passent PAS par ce flux : `notifications/progress` et `notifications/message` (logging), qui restent sur le flux de réponse de la requête qui les a déclenchés. La fermeture est asymétrique : côté client on ferme le flux SSE (HTTP) ou on envoie `notifications/cancelled` référençant l'ID du `listen` (stdio) ; côté serveur, une fin d'initiative propre répond au `listen` par un résultat `resultType: "complete"` (SHOULD, pas MUST). Deux points d'implémentation lourds : la même révision a supprimé le handshake `initialize`, donc les métadonnées de session (`protocolVersion`, `clientInfo`, `clientCapabilities`) voyagent dans le `_meta` de chaque requête ; et la résumabilité SSE (`Last-Event-ID`, event IDs) a été retirée — après une reconnexion, le client DOIT ré-émettre `subscriptions/listen`, le serveur ne conservant aucun état de souscription.

## 2. Surface d'API exacte

```
subscriptions/listen                                  (méthode JSON-RPC, POST)
  params.notifications.toolsListChanged               boolean
  params.notifications.promptsListChanged             boolean
  params.notifications.resourcesListChanged           boolean
  params.notifications.resourceSubscriptions          string[]  (URIs)
  params._meta["io.modelcontextprotocol/protocolVersion"]
  params._meta["io.modelcontextprotocol/clientInfo"]
  params._meta["io.modelcontextprotocol/clientCapabilities"]

notifications/subscriptions/acknowledged              (params.notifications = sous-ensemble honoré)
_meta["io.modelcontextprotocol/subscriptionId"]       (= id JSON-RPC de la requête listen ; sur TOUS les messages du flux)

notifications/tools/list_changed
notifications/prompts/list_changed
notifications/resources/list_changed
notifications/resources/updated
notifications/tasks                                   (extension io.modelcontextprotocol/tasks, opt-in ; nom confirmé
                                                       mot pour mot — champ de filtre correspondant :
                                                       non vérifiable ici, voir le dépôt ext-tasks)

server/discover                                       (RPC OBLIGATOIRE ; remplace initialize pour la
                                                       découverte des capabilities et versions du serveur)
capabilities.resources.subscribe / capabilities.resources.listChanged
                                                      (déclarées dans le résultat de server/discover — le
                                                       _meta des requêtes ne porte que le côté CLIENT)
notifications/cancelled                               (fermeture côté client, stdio UNIQUEMENT : en Streamable
                                                       HTTP la spec dit qu'aucun notifications/cancelled n'est
                                                       attendu, fermer le flux SSE EST l'annulation)
{ resultType: "complete", _meta: { subscriptionId } } (réponse JSON-RPC vide à la requête listen elle-même ;
                                                       fermeture côté serveur, SHOULD)
```

Payload minimal :

```json
{
  "jsonrpc": "2.0", "id": 42, "method": "subscriptions/listen",
  "params": {
    "notifications": {
      "toolsListChanged": true,
      "resourceSubscriptions": ["coord://default/working-files"]
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "…", "version": "…" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

Le schéma d'URI `coord://…` ci-dessus est un **exemple**, pas une API existante : le repo n'expose aujourd'hui aucune ressource MCP (voir §5).

**Désaccords entre chercheurs, non tranchés :**
- Périmètre du remplacement : une fiche dit que `listen` remplace `resources/subscribe` **et** `resources/unsubscribe` ; le vérificateur note que la spec ne nomme explicitement que « the former `resources/subscribe` RPC and the HTTP GET endpoint » — `resources/unsubscribe` disparaît de fait (absent de la page Resources 2026-07-28) sans être nommé comme remplacé.
- Ordre de l'accusé de réception : **tranché le 2026-08-14, les deux lectures sont exactes et coexistent dans la même phrase de la spec.** Verbatim : « The server **MUST** send `notifications/subscriptions/acknowledged` as the first message […] and **MUST NOT** send any notification on the subscription before it. On stdio, where every subscription shares one channel, this ordering is defined per subscription ID and not per channel: messages belonging to other subscriptions **MAY** be interleaved before it. » Donc : premier message obligatoire *de cette souscription*, mais pas forcément premier octet du canal.
- Statut : `GA` vs `Current` — question de vocabulaire, même réalité. Le cœur est ratifié ; `notifications/tasks` ne l'est pas au même niveau.
- Keep-alive : **tranché le 2026-08-14 — non normatif, la fiche avait raison.** Verbatim (encadré *Note* de Streamable HTTP) : « servers are **encouraged** to periodically emit an SSE comment line (a line beginning with a colon, e.g. `:\r\n`) as a keep-alive ». Aucun MUST/SHOULD. La même page conclut sèchement : « Resumable SSE streams via `Last-Event-ID` are not supported. »

## 3. Sources

- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md — source de référence
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://blog.modelcontextprotocol.io/posts/2026-07-28/ — annonce (une seule phrase sur le sujet)
- https://modelcontextprotocol.io/extensions/tasks/overview
- https://modelcontextprotocol.io/specification/versioning — confirme le 2026-08-14 que `2026-07-28` est la révision **current**
- https://modelcontextprotocol.io/specification/2026-07-28/server/resources — capabilities `resources.subscribe` / `.listChanged`
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28 — le support SDK passe par les paquets **v2** `@modelcontextprotocol/server` et `@modelcontextprotocol/client` (2.0.0, `latest` npm depuis le 2026-07-28), PAS par une montée de `@modelcontextprotocol/sdk` (v1, dernière : 1.30.0). Côté client : `client.listen(filter)`. Côté serveur : `createMcpHandler` + `.notify.{toolsChanged, promptsChanged, resourcesChanged, resourceUpdated(uri)}`, avec un `ServerEventBus` fournissable pour un déploiement multi-processus.

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

Le projet a trois mécanismes de push maison, aucun n'étant du MCP :

1. `src/sse-emitter.ts` (144 l.) + `handleSse` dans `src/serve-http.ts` (l. 326-402) : un flux SSE propriétaire sur `GET /api/events`, avec sa table SQLite `events`, sa reprise par `Last-Event-ID` (cap 1000), son rattrapage à 50 événements, son heartbeat `:keep-alive` toutes les 30 s et son plafond `MAX_SSE_CLIENTS`.
2. `src/mqtt-broker.ts` + `src/mqtt-bridge.ts` : le bus interne (`coordinator/<org>/…`), avec retained messages.
3. `cli/channel.ts` : un serveur MCP stdio dédié dont l'unique raison d'être est de traduire les messages MQTT en une notification **hors spec**, `notifications/claude/channel` (l. 465), comprise seulement par Claude Code.

`subscriptions/listen` donne un canal de push **du protocole**. Ce qui apparaît : n'importe quel client MCP conforme — pas seulement Claude Code — peut s'abonner à l'état de coordination sans passer par MQTT ni par une convention maison. Ce qui peut disparaître à terme : la raison d'être de `cli/channel.ts` en tant que traducteur, et une partie du flux SSE propriétaire pour les consommateurs MCP. Ce qui reste : le broker aedes pour le fan-out inter-processus et le dashboard `EventSource` (`dashboard/public/dashboard.js:647`), qui est un navigateur, pas un client MCP.

L'utilisateur qui en profite : l'auto-hébergeur qui n'utilise pas Claude Code (Cursor, Zed, un agent maison via `sdk/src/`) et qui aujourd'hui doit soit poller les outils MCP, soit implémenter un client MQTT.

**Risque si on ne fait rien :**

Modéré mais réel. Le serveur MCP du repo est construit sur `@modelcontextprotocol/sdk ^1.29.0` et utilise `StreamableHTTPServerTransport` (`src/serve-http.ts:801`) et `StdioServerTransport` (`src/index.ts:50`). Le jour où le SDK bascule sur `2026-07-28`, la suppression du GET HTTP et du handshake `initialize` touche le transport, pas notre code applicatif — mais elle touche la couche sur laquelle les 26 outils sont enregistrés. Le risque n'est pas la perte du push maison (il continue de fonctionner, c'est du HTTP brut hors MCP), c'est de rester avec un mécanisme d'abonnement non standard alors que la spec en fournit un.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/sse-emitter.ts` | Le candidat direct au remplacement pour les consommateurs MCP. `addListener(orgId, listener)` (l. 116) devient la source d'alimentation d'un flux `subscriptions/listen` au lieu d'un `res.write` SSE. `getEventsSince` / `Last-Event-ID` (l. 87) n'ont **plus d'équivalent** : la résumabilité SSE a été supprimée dans 2026-07-28, il faudrait soit garder ce chemin pour le dashboard, soit le porter en logique de re-souscription. |
| `src/serve-http.ts` | `handleSse` (l. 326-402) : flux `text/event-stream` maison sur `GET /api/events`, heartbeat (l. 384), `SSE_RESUME_CAP` (l. 324). À conserver pour le dashboard, mais il devient le doublon non standard du flux MCP. `StreamableHTTPServerTransport` (l. 801) et la `Map` de sessions (l. 1324) sont ce qui bougera si le SDK adopte 2026-07-28. |
| `src/server-setup.ts` | `createMcpServer` (l. 207) n'enregistre **que des outils** (`registerAgentTools` … `registerMqttTools`, l. 242-247). Aucun handler de ressources : `ListResourcesRequestSchema` / `resources/subscribe` sont absents de tout le repo (grep). Adopter `resourceSubscriptions` suppose donc d'abord de **créer** une couche `resources` (URIs, `capabilities.resources.subscribe`), pas de migrer une couche existante. |
| `cli/channel.ts` | `notifications/claude/channel` (l. 465), notification hors spec émise depuis `client.on("message")` du bridge MQTT. C'est le morceau que `subscriptions/listen` rend redondant sur le principe — sous réserve que Claude Code implémente la nouvelle révision. |
| `src/mqtt-bridge.ts` / `src/mqtt-broker.ts` | Restent en place comme bus interne. Leurs topics (`coordinator/<org>/agents/+/status`, `/consultations/#`, `/broadcast`, l. 142-144) sont la cartographie naturelle vers des URIs de ressources abonnables. |
| `src/working-files-tracker.ts`, `src/agent-registry.ts`, `src/consultation.ts` | Les trois états qui changent en continu — donc les trois candidats à devenir des ressources avec `notifications/resources/updated`. Aucun n'expose aujourd'hui d'URI. |
| `sdk/src/client.ts` | Aucune méthode de streaming (grep `events`/`stream` : 0 occurrence). Un client `subscriptions/listen` serait un ajout, pas un remplacement. |
| `dashboard/public/dashboard.js` | `new EventSource(.../api/events)` (l. 647). Un navigateur ne parle pas MCP : ce consommateur garde le SSE maison quoi qu'il arrive. |
| `docs/ARCHITECTURE.md`, `docs/mqtt-topics.md`, `docs/openapi.yaml` | À réviser si un second canal de push est introduit — sinon la doc décrit un modèle de push qui n'est plus le seul. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Faut-il créer une couche `resources` MCP (URIs `coord://<org>/agents`, `/working-files`, `/threads/<id>`) — aujourd'hui totalement absente du repo — pour que `subscriptions/listen` ait quelque chose à quoi s'abonner, ou bien n'utiliser `listen` que pour `toolsListChanged` et garder SSE + MQTT comme unique canal d'état, en assumant que `cli/channel.ts` reste une extension propriétaire Claude Code ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Vérifié le 2026-08-14 : le PoC est exécutable ici via `@modelcontextprotocol/server@2.0.0` / `@modelcontextprotocol/client@2.0.0` (npm `latest`, aucun credential requis), mais **pas dans le vrai chemin de code du repo** — le serveur tourne sur `@modelcontextprotocol/sdk` v1, qui ignore `subscriptions/listen` ; l'y tester suppose d'abord la migration vers les paquets v2. La branche « portabilité vers un autre client MCP » n'est pas testable : aucun client MCP tiers parlant 2026-07-28 n'est installé.

- [ ] Vérifier si `@modelcontextprotocol/sdk` (aujourd'hui `^1.29.0` dans `package.json`) expose `subscriptions/listen` : chercher la méthode et `subscriptionId` dans `node_modules/@modelcontextprotocol/sdk`. Si absent, la fiche est bloquée sur le SDK, pas sur nous.
- [ ] Vérifier quelle révision de protocole `StreamableHTTPServerTransport` négocie réellement dans `src/serve-http.ts:801` (log du `protocolVersion` sur une session de test) — 2025-x ou 2026-07-28.
- [ ] Vérifier ce que Claude Code envoie : lancer `npx mcp-coordinator channel` et tracer les requêtes entrantes sur stdio ; observer s'il y a un `subscriptions/listen` ou toujours un `initialize`.
- [ ] PoC minimal : enregistrer UNE ressource `coord://default/working-files` sur `createMcpServer` (`src/server-setup.ts:207`) alimentée par `WorkingFilesTracker`, et mesurer si un client conforme reçoit `notifications/resources/updated` sans passer par MQTT.
- [ ] Mesurer le coût de la perte de résumabilité : simuler une coupure de 30 s et comparer ce que voit un client `listen` (re-souscription, pas de rattrapage) contre `Last-Event-ID` sur `/api/events` (jusqu'à 1000 événements rejoués).

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Il n'y a rien à migrer.** Le repo n'a aucune ressource MCP. « Remplacer du code maison » est trompeur : on ne supprime pas `sse-emitter.ts`, on **ajoute** une couche `resources` + un handler `subscriptions/listen` par-dessus. Effort L, gain immédiat nul pour l'utilisateur actuel.
- **Dépendance au SDK, pas à nous.** Tant que `@modelcontextprotocol/sdk` (`^1.29.0`) et Claude Code n'ont pas basculé sur 2026-07-28, écrire un handler `subscriptions/listen` à la main revient à contourner le SDK sur son propre terrain. Fenêtre de risque : maintenir du code protocolaire qui sera réécrit par le SDK trois mois plus tard.
- **Régression fonctionnelle sur la reprise.** `Last-Event-ID` + `getEventsSince` donnent aujourd'hui un rattrapage borné à 1000 événements après coupure. La révision 2026-07-28 a **supprimé** la résumabilité SSE : après reconnexion, le client re-souscrit et ne rejoue rien. Pour un coordinateur d'agents, perdre les événements d'une coupure de 20 s est une régression, pas une amélioration.
- **Aucun des trois canaux existants ne disparaît vraiment.** Le dashboard reste sur `EventSource` (navigateur), MQTT reste nécessaire au fan-out inter-processus, et `cli/channel.ts` reste utile tant que Claude Code parle `notifications/claude/channel`. On passerait de 3 canaux de push à 4.
- **Complexité pour l'auto-hébergeur.** Un quatrième chemin de notification à comprendre, diagnostiquer dans `cli/doctor.ts` et documenter, pour un public (clients MCP non-Claude-Code s'abonnant à l'état de coordination) dont on n'a pas la preuve qu'il existe.
- **YAGNI.** Le besoin réel — « un agent est notifié qu'un fichier est pris » — est déjà couvert par MQTT et par les outils MCP. La valeur ajoutée est la portabilité, pas une capacité nouvelle.
- **Le `_meta` stateless est un coût caché.** La disparition d'`initialize` change la façon dont l'auth par session fonctionne (`getSessionClaims` dans `src/server-setup.ts:207`, la `Map` de sessions `src/serve-http.ts:1324`). Ce n'est pas dans le périmètre de cette fiche, mais on ne peut pas adopter `listen` sans y toucher.

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
| 2026-08-14 | Vérification des faits : spec et §5 exacts, 2 marqueurs tranchés, `server/discover` ajouté, SDK v2 identifié. |
