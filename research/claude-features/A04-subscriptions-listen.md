# A04 — `subscriptions/listen` : le push standardisé face à `sse-emitter` et `mqtt-bridge`

| Champ | Valeur |
|---|---|
| **ID** | `subscriptions-listen` |
| **Surface** | mcp-spec |
| **Statut** | GA — le vocabulaire officiel de la spec est Draft/**Current**/Final : la révision `2026-07-28` est « current ». Nuance : `notifications/tasks` relève de l'extension optionnelle `io.modelcontextprotocol/tasks`, pas du cœur. |
| **Disponible depuis** | `2026-07-28` (révision de spec, SEP-2575) |
| **Tier** | ~~T1-incontournable~~ → **T3** (déclassé au challenge du 2026-08-15, §7.4) |
| **Nature** | ~~replace-homemade-code~~ → **opportunity** (corrigé au challenge : le dépôt n'a aucune ressource MCP, §7.4) |
| **Effort estimé** | L |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — PoC possible hors repo ; SDK v1 du repo ignore la méthode |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — reporter sur `subscriptions/listen` seul, voir §7 |

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

**Pré-enregistré le 2026-08-15, avant toute exécution.** Claude Code **2.1.219**, Node 22.21.0,
Windows 11, `@modelcontextprotocol/sdk` **1.30.0** installé.

**Hypothèse.** La question de §6.1 est **prématurée**. Elle demande quelle forme donner à
`subscriptions/listen` alors que ni notre SDK, ni le client majoritaire ne parlent la révision qui
l'introduit. Je m'attends à ce que la chaîne soit bloquée en amont de nous, et donc à un verdict
`reporter` avec une condition de réveil nommée — pas à un arbitrage entre les deux branches.

Je m'attends aussi à ce que la **nature** de la fiche soit fausse : elle est classée
`replace-homemade-code`, mais le dépôt n'a **aucune** ressource MCP. On n'y remplacerait rien, on
ajouterait une quatrième voie de push.

**Critères de refus, posés avant de mesurer :**

| # | Ce qui tue quoi | Seuil |
|---|---|---|
| K1 | Si `@modelcontextprotocol/sdk@1.30.0` ignore `subscriptions/listen`, la fiche est bloquée sur le SDK, pas sur nous → `reporter`, jamais `adopter`. | grep sur `node_modules` |
| K2 | Si notre transport négocie une révision **antérieure** à `2026-07-28`, le chemin de code réel ne peut pas porter la feature. | `protocolVersion` observé |
| K3 | Si Claude Code envoie toujours `initialize` (et non `server/discover`), le client majoritaire n'est pas prêt non plus — les deux bouts de la chaîne sont bloqués. | trafic observé |
| K4 | Si `@modelcontextprotocol/server@2.0.0` / `client@2.0.0` ne sont pas publiés, la §0 surestime la testabilité et le verdict devient `reporter` sur blocage total. | `npm view` |
| K5 | Si adopter suppose de **créer** une couche `resources` inexistante, la nature `replace-homemade-code` est fausse et l'effort L est un plancher, pas une estimation. | grep sur le dépôt |
| K6 | Si la perte de résumabilité (`Last-Event-ID` supprimé en 2026-07-28) fait régresser un chemin qui marche aujourd'hui, l'adoption a un coût fonctionnel net. | lecture du code de reprise |

### 6.3 Protocole de vérification

Amendé le 2026-08-15. **Deux mesures sont déjà en main** — faites pendant le challenge de
[`C06`](C06-tool-search-defer-loading.md) sur ce même dépôt — et sont réutilisées au lieu d'être
refaites.

- [x] **T1 — le SDK.** Chercher `subscriptions/listen`, `subscriptionId`, `server/discover` dans
      `node_modules/@modelcontextprotocol/sdk`. Tranche K1.
- [x] **T2 — la révision négociée.** Déjà mesurée en `C06` : sonde JSON-RPC sur le serveur stdio du
      dépôt. Tranche K2.
- [x] **T3 — ce que parle Claude Code.** Déjà observé en `C06` et `C01` : sessions réelles contre le
      serveur du dépôt. Tranche K3.
- [x] **T4 — les paquets v2.** `npm view @modelcontextprotocol/server` et `client`. Tranche K4.
- [x] **T5 — la couche `resources`.** Grep sur `src/`, `cli/`, `sdk/src/`. Tranche K5.
- [x] **T6 — le coût de la perte de résumabilité.** Lire le chemin de reprise réel
      (`sse-emitter.ts`, `SSE_RESUME_CAP`) et chiffrer ce qui serait perdu. Tranche K6.
- [ ] **Écarté faute de valeur décisionnelle** — le PoC autonome en paquets v2 hors dépôt. Il
      prouverait que la spec fonctionne (ce dont personne ne doute) sans rien dire de notre chemin de
      code, qui est le seul objet de la question §6.1. À rouvrir le jour où K1/K2/K3 changent.

> ⚠️ Vérifié le 2026-08-14 : le PoC est exécutable ici via `@modelcontextprotocol/server@2.0.0` / `@modelcontextprotocol/client@2.0.0` (npm `latest`, aucun credential requis), mais **pas dans le vrai chemin de code du repo** — le serveur tourne sur `@modelcontextprotocol/sdk` v1, qui ignore `subscriptions/listen` ; l'y tester suppose d'abord la migration vers les paquets v2. La branche « portabilité vers un autre client MCP » n'est pas testable : aucun client MCP tiers parlant 2026-07-28 n'est installé.

- [ ] Vérifier si `@modelcontextprotocol/sdk` (aujourd'hui `^1.29.0` dans `package.json`) expose `subscriptions/listen` : chercher la méthode et `subscriptionId` dans `node_modules/@modelcontextprotocol/sdk`. Si absent, la fiche est bloquée sur le SDK, pas sur nous.
- [ ] Vérifier quelle révision de protocole `StreamableHTTPServerTransport` négocie réellement dans `src/serve-http.ts:801` (log du `protocolVersion` sur une session de test) — 2025-x ou 2026-07-28.
- [ ] Vérifier ce que Claude Code envoie : lancer `npx mcp-coordinator channel` et tracer les requêtes entrantes sur stdio ; observer s'il y a un `subscriptions/listen` ou toujours un `initialize`.
- [ ] PoC minimal : enregistrer UNE ressource `coord://default/working-files` sur `createMcpServer` (`src/server-setup.ts:207`) alimentée par `WorkingFilesTracker`, et mesurer si un client conforme reçoit `notifications/resources/updated` sans passer par MQTT.
- [ ] Mesurer le coût de la perte de résumabilité : simuler une coupure de 30 s et comparer ce que voit un client `listen` (re-souscription, pas de rattrapage) contre `Last-Event-ID` sur `/api/events` (jusqu'à 1000 événements rejoués).

### 6.4 Résultat observé

Exécuté le 2026-08-15. Claude Code **2.1.219**, Node 22.21.0, Windows 11,
`@modelcontextprotocol/sdk` **1.30.0**.

> **Frontière exécuté / lu.** Tout ce qui suit est **exécuté**, sauf mention contraire. Le PoC
> autonome en paquets v2 a été **écarté volontairement** (voir §6.3) : il aurait prouvé que la spec
> fonctionne, ce dont personne ne doute, sans rien dire du chemin de code du dépôt — seul objet de
> la question §6.1.

**(A) T1 — le SDK du projet ignore totalement la révision.**

```
subscriptions/listen     -> 0 fichier(s)
subscriptionId           -> 0 fichier(s)
server/discover          -> 0 fichier(s)
2026-07-28               -> 0 fichier(s)

LATEST_PROTOCOL_VERSION    = '2025-11-25'
SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']
```

`2026-07-28` **n'est pas dans la liste**. K1 est déclenché.

**(B) T2 — le plafond réel de notre serveur.**

> ⚠️ **Correction d'une mesure de ma part.** J'ai d'abord lu `protocolVersion: "2025-06-18"` dans
> l'`InitializeResult` et j'allais en conclure que le serveur plafonnait là. **Faux** : ma sonde
> proposait `2025-06-18` en dur, la réponse reflétait donc ma requête. Mesure refaite en faisant
> varier la proposition du client :

```
client propose 2026-07-28   -> serveur repond : "protocolVersion": "2025-11-25"
client propose 2025-11-25   -> serveur repond : "protocolVersion": "2025-11-25"
client propose 2025-06-18   -> serveur repond : "protocolVersion": "2025-06-18"
```

Le serveur **plafonne à `2025-11-25`** et rétrograde proprement une demande en `2026-07-28`.
K2 est déclenché.

**(C) T3 — ce que Claude Code envoie réellement sur le fil.** Serveur stdio jetable journalisant
chaque message entrant :

```
methode: initialize                   protocolVersion=2025-11-25
methode: notifications/initialized
methode: tools/list
```

**`initialize`, pas `server/discover`. `2025-11-25`, pas `2026-07-28`.** Le client majoritaire n'est
pas prêt non plus. K3 est déclenché — **les deux bouts de la chaîne sont bloqués**.

**(D) T4 — les paquets v2 existent bien.**

```
@modelcontextprotocol/server     2.0.0
@modelcontextprotocol/client     2.0.0
@modelcontextprotocol/sdk        1.30.0
```

K4 **n'est pas** déclenché : la §0 a raison, un PoC hors dépôt serait exécutable. C'est sa valeur
décisionnelle qui est nulle, pas sa faisabilité.

**(E) T5 — il n'y a rien à remplacer.**

```
ListResourcesRequestSchema  -> 0 occurrence(s)
ReadResourceRequestSchema   -> 0 occurrence(s)
registerResource            -> 0 occurrence(s)
resources/subscribe         -> 0 occurrence(s)
```

K5 est déclenché. **La nature `replace-homemade-code` de l'en-tête est fausse** : on n'y remplace
rien, on ajoute une quatrième voie de push. Le premier contre-argument de §6.5 est confirmé mot pour
mot.

**(F) Le canal standard existe déjà — sous son ancien nom.** Point que la fiche n'examine pas.
Dans le SDK 1.30.0, donc dans la révision que **les deux bouts parlent** :

```
resources/subscribe          -> 4 fichier(s)
SubscribeRequestSchema       -> 2 fichier(s)
resources/updated            -> 4 fichier(s)
ResourceUpdatedNotification  -> 4 fichier(s)
registerResource             -> 5 fichier(s)
```

Autrement dit, un canal de push **du protocole** est disponible aujourd'hui, sans attendre
`2026-07-28`. La question §6.1 (« faut-il créer une couche `resources` ? ») n'est donc **pas**
bloquée par la révision — seul le *nom* du RPC d'abonnement l'est.

**(G) Mais personne ne s'abonne.** Serveur stdio annonçant
`capabilities.resources = { subscribe: true, listChanged: true }` et exposant
`coord://default/working-files`, avec un prompt demandant **explicitement** de s'abonner :

```
initialize                     1
notifications/initialized      1
tools/list                     1
resources/list                 1
resources/read                 1

resources/subscribe appele ? NON
resources/list appele ?      OUI
```

**Claude Code lit les ressources, il ne s'y abonne pas.** Le versant *lecture* d'une couche
`resources` a donc un consommateur réel ; le versant *abonnement* — le sujet de cette fiche — n'en a
aucun, ni sous le nouveau nom (non parlé) ni sous l'ancien (non appelé).

*Limite de cette mesure : n = 1 client, 1 prompt, 1 version.*

---

### 6.4-bis Ce que la passe adversariale a trouvé — et que cette fiche n'aurait pas dû manquer

La fiche est présentée dans l'ordre de travail du projet comme celle qui décide **« garde-t-on le
broker MQTT ? »**. Mon verdict n'en disait rien. Deux faits, vérifiés ici, montrent que cette
question se tranche **aujourd'hui** et qu'elle ne dépend pas de `subscriptions/listen`.

**(H) Le broker embarqué est sur le chemin critique du démarrage, sans garde.**
`src/serve-http.ts:1386` :

```ts
const { broker, resolvedMqttTcpPort } = await wireMqtt({
  mqttTcpPort, mqttWsPath, httpServer, log, redis,
});
```

Aucun `try`/`catch`. Et `src/mqtt-broker.ts:297` fait `tcpServer.once("error", reject)`. Donc
**port 1883 occupé ⇒ le coordinateur HTTP ne démarre pas du tout** — alors que le mode stdio prouve
que le produit fonctionne sans MQTT (`src/index.ts:53` : « no MQTT broker in stdio mode »), et que
les 3 outils MQTT dégradent proprement. Correctif de robustesse de l'ordre de dix lignes,
indépendant de tout le reste de cette fiche.

**(I) Le consommateur externe de référence est désabonné depuis la v0.7.0.** Le README désigne
**essaim** comme l'implémentation de référence du bus. Ses filtres
(`essaim-new/src/agent-loop/mqtt-listener.ts:109`) :

```
coordinator/consultations/new
coordinator/consultations/+/messages
coordinator/agents/+/status
```

Ce que le coordinateur publie (`src/mqtt-bridge.ts:260,279,319`) :

```
coordinator/${orgId}/agents/${agentId}/status
coordinator/${orgId}/consultations/new
coordinator/${orgId}/consultations/${threadId}/messages
```

Un `+` MQTT ne matche **qu'un seul** niveau : `coordinator/consultations/new` (3 segments) ne peut
pas matcher `coordinator/default/consultations/new` (4 segments). **Aucun message ne peut
arriver.** Le `CHANGELOG.md:1313` documente pourtant la rupture en v0.7.0 : *« MQTT topic namespace
changed […] External MQTT consumers must update subscription patterns »*.

> Le bus dont cette fiche discute le remplacement **n'alimente plus son consommateur phare depuis
> la v0.7.0**, et personne ne s'en est aperçu. C'est la mesure la plus honnête de ce que le broker
> apporte aujourd'hui — et c'est un fait daté d'aujourd'hui, qui n'attend ni le SDK v2 ni
> Claude Code.

### 6.5 Contre-arguments

- **Il n'y a rien à migrer.** Le repo n'a aucune ressource MCP. « Remplacer du code maison » est trompeur : on ne supprime pas `sse-emitter.ts`, on **ajoute** une couche `resources` + un handler `subscriptions/listen` par-dessus. Effort L, gain immédiat nul pour l'utilisateur actuel.
- **Dépendance au SDK, pas à nous.** Tant que `@modelcontextprotocol/sdk` (`^1.29.0`) et Claude Code n'ont pas basculé sur 2026-07-28, écrire un handler `subscriptions/listen` à la main revient à contourner le SDK sur son propre terrain. Fenêtre de risque : maintenir du code protocolaire qui sera réécrit par le SDK trois mois plus tard.
- **Régression fonctionnelle sur la reprise.** `Last-Event-ID` + `getEventsSince` donnent aujourd'hui un rattrapage borné à 1000 événements après coupure. La révision 2026-07-28 a **supprimé** la résumabilité SSE : après reconnexion, le client re-souscrit et ne rejoue rien. Pour un coordinateur d'agents, perdre les événements d'une coupure de 20 s est une régression, pas une amélioration.
- **Aucun des trois canaux existants ne disparaît vraiment.** Le dashboard reste sur `EventSource` (navigateur), MQTT reste nécessaire au fan-out inter-processus, et `cli/channel.ts` reste utile tant que Claude Code parle `notifications/claude/channel`. On passerait de 3 canaux de push à 4.
- **Complexité pour l'auto-hébergeur.** Un quatrième chemin de notification à comprendre, diagnostiquer dans `cli/doctor.ts` et documenter, pour un public (clients MCP non-Claude-Code s'abonnant à l'état de coordination) dont on n'a pas la preuve qu'il existe.
- **YAGNI.** Le besoin réel — « un agent est notifié qu'un fichier est pris » — est déjà couvert par MQTT et par les outils MCP. La valeur ajoutée est la portabilité, pas une capacité nouvelle.
- **Le `_meta` stateless est un coût caché.** La disparition d'`initialize` change la façon dont l'auth par session fonctionne (`getSessionClaims` dans `src/server-setup.ts:207`, la `Map` de sessions `src/serve-http.ts:1324`). Ce n'est pas dans le périmètre de cette fiche, mais on ne peut pas adopter `listen` sans y toucher.

---

**(J) Le piège que personne n'avait vu : `subscribe: true` est un garde-fou fantôme en puissance.**
PoC jetable sur le SDK **du dépôt** (1.30.0), `InMemoryTransport` :

```
capabilities annoncees par le serveur : {"resources":{"subscribe":true,"listChanged":true}}
resources/list      -> OK, 1 ressource(s)
resources/read      -> OK, 1 contenu(s)
resources/subscribe -> REFUSE : -32601 MCP error -32601: Method not found
```

L'API haut niveau `McpServer` — **celle qu'utilise `src/server-setup.ts:207`** — laisse déclarer
`capabilities.resources.subscribe: true` et **n'installe aucun handler**. Il faut redescendre sur
`server.server.setRequestHandler(SubscribeRequestSchema, …)`. C'est exactement le motif
« garde-fou fantôme » de l'audit v0.13.0 : une capability annoncée que le code ne peut pas honorer.

**(K) A06 et A09 ne couvrent pas la couche `resources`.** Vérifié :

```
A06-tool-metadata-modern-surface.md   registerResource=0  resources/read=2  resources/subscribe=0
A09-extensions-grouping-skills.md     registerResource=1  resources/read=7  resources/subscribe=0
```

A09 ne parle de `resources/read` que comme véhicule de **skills** (SEP-2640, experimental, T2).
**Zéro occurrence de `resources/subscribe` dans les deux.** Y renvoyer le sujet serait un
enterrement.

**(L) K6 — la « régression de résumabilité » est théorique.** Base vivante du dépôt :

```
data/coordinator.db -> events: 0   agents: 0
```

Zéro événement à rejouer, contre un `SSE_RESUME_CAP = 1000`. Et le chemin de reprise
(`Last-Event-ID`) n'a qu'un consommateur, `dashboard/public/dashboard.js:647`, **un navigateur** —
que personne ne propose de toucher. Le contre-argument de §6.5 oppose une nouveauté à un chemin qui
ne bouge pas.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** (sur `subscriptions/listen` seul) · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | Bloqué aux **deux bouts**, mesuré. Mais la fiche mélangeait trois questions : voir §7.2 et §7.3. |
| **Issue / PR** | à créer — trois constats extraits, §7.3 |
| **Tier** | ~~T1~~ → **T3** pour `subscriptions/listen` lui-même |
| **Effort** | ~~L~~ → l'essentiel du L est **compté deux fois** avec `A01`/`A02` (voir §7.4) |

### 7.1 Ce qui est reporté, et la condition de réveil

`subscriptions/listen` est inaccessible, et le blocage n'est pas chez nous :

- `@modelcontextprotocol/sdk@1.30.0` : **0 occurrence** de `subscriptions/listen`,
  `subscriptionId`, `server/discover`, `2026-07-28`. `LATEST_PROTOCOL_VERSION = '2025-11-25'`.
- Notre serveur **rétrograde** une demande en `2026-07-28` vers `2025-11-25`.
- Claude Code 2.1.219 envoie `initialize` en `2025-11-25`, **jamais** `server/discover`.

**Condition de réveil, en deux temps :** (a) le projet migre vers les paquets v2
(`@modelcontextprotocol/{server,client}`, publiés en 2.0.0) — c'est le sujet de
[`A02`](A02-mcp-sdk-typescript-v2.md), pas de celui-ci ; (b) un client que nos utilisateurs
emploient réellement parle `2026-07-28`. Aucun des deux n'est vrai aujourd'hui.

### 7.2 La question §6.1 est mal posée — elle en mélange trois

Elle demande « créer une couche `resources` **ou** garder SSE + MQTT ». Ce sont trois décisions
indépendantes, et les confondre est ce qui a failli me faire écrire un `reporter` global :

| Question | Bloquée par la révision ? | Verdict |
|---|---|---|
| Un handler `subscriptions/listen` | **oui**, aux deux bouts | reporter (§7.1) |
| Une couche `resources` (URIs, lecture, `resources/subscribe`) | **non** — tout existe dans le SDK 1.30.0 | à instruire, §7.3 (2) |
| Le sort du broker MQTT | **non**, aucun rapport | à trancher séparément, §7.3 (1) |

**Correction à ma propre §6.4 (G).** J'y ai écrit que `resources/subscribe` « n'est consommé par
personne ». C'est une généralisation depuis **n = 1 client, 1 prompt**. La passe adversariale
rapporte — par lecture du code source de ces clients, **non revérifiée par moi ici** — que
VS Code / Copilot Chat l'appelle réellement (`mcpServerRequestHandler.ts`, consommé par un FS
provider), que le MCP Inspector l'expose en bouton, et que Cursor l'envoie **même quand le serveur
déclare `subscribe: false`**. À traiter comme indicatif, mais suffisant pour retirer l'affirmation
absolue : la mesure a été faite contre le seul des quatre clients cités par le README qui ne
s'abonne pas.

### 7.3 Les trois constats extraits — le vrai livrable

1. **Le broker MQTT bloque le démarrage, sans garde.** `src/serve-http.ts:1386` fait
   `await wireMqtt(...)` sans `try`/`catch`, et `src/mqtt-broker.ts:297` rejette sur port occupé :
   **port 1883 pris ⇒ le coordinateur HTTP ne démarre pas**, alors que le mode stdio prouve que le
   produit tourne sans MQTT. Correctif de robustesse de l'ordre de dix lignes. **Ne dépend de rien.**
2. **La couche `resources` n'a de fiche nulle part** — vérifié, A06 et A09 ont zéro
   `resources/subscribe`. Elle n'est **pas** bloquée par la révision, elle a un consommateur nommé
   (lecture : mesurée ici avec Claude Code ; abonnement : rapporté pour VS Code), et son périmètre
   propre est **S/M**, pas L. Mérite son propre dossier.
3. **`subscribe: true` sans handler renvoie `-32601`** (§6.4 J). Le jour où une ressource apparaît
   — par cette fiche, par A09 ou par une autre porte — déclarer la capability sans installer
   `SubscribeRequestSchema` créerait un garde-fou fantôme, et casserait les clients qui s'abonnent
   sans regarder la capability. À écrire dans la fiche qui portera la couche `resources`.

**Et l'essaim est déjà cassé.** Le consommateur externe de référence, nommé dans le README, souscrit
à des topics d'avant la v0.7.0 et **ne reçoit plus rien depuis** (§6.4 I). C'est un constat sur le
bus, pas sur cette fiche, mais il pèse sur le point (1).

### 7.4 Trois corrections de classement

- **Nature `replace-homemade-code` : fausse.** Le dépôt n'a aucune ressource MCP — on n'y remplace
  rien. Et « on ajoute une quatrième voie de push » est faux aussi : **en stdio c'est la première**,
  et pour un client MCP en HTTP c'est la première **in-band**. Nature juste : `opportunity`.
- **Effort L : compté deux fois.** L'essentiel du L, c'est la migration v1 → v2 (sujet d'`A02`, XL)
  et le coût du `_meta` stateless (sujet d'`A01`, XL). Ce qui est propre à A04 est bien plus petit.
- **L'ordre de travail est inversé.** A04 est présentée comme conditionnant `A01`, `A05`, `C03`,
  `C05`, `E04`. C'est le contraire : **A04 est conditionnée par `A01`/`A02`**, qui portent la
  migration sans laquelle `subscriptions/listen` n'existe pas.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : spec et §5 exacts, 2 marqueurs tranchés, `server/discover` ajouté, SDK v2 identifié. |
| 2026-08-15 | **Challenge tranché : reporter, mais sur `subscriptions/listen` seul.** Bloqué aux deux bouts, mesuré : le SDK 1.30.0 a **0 occurrence** de la révision `2026-07-28` (`LATEST = 2025-11-25`), notre serveur rétrograde une demande en 2026-07-28 vers 2025-11-25, et Claude Code envoie `initialize` en 2025-11-25. **La §6.1 mélangeait trois questions** : le handler `listen` (bloqué), la couche `resources` (**pas** bloquée — `resources/subscribe`, `resources/updated`, `registerResource` existent tous dans le SDK installé), et le sort du broker MQTT (sans rapport). Corrections de classement : nature `replace-homemade-code` **fausse** (zéro ressource dans le dépôt), effort L **compté deux fois** avec A01/A02, tier T1 → **T3**, et l'ordre de travail est **inversé** — A04 est conditionnée par A01/A02, pas l'inverse. **Trois constats extraits, tous indépendants de la révision** : `wireMqtt` non gardé au boot (port 1883 occupé ⇒ le coordinateur ne démarre pas) ; la couche `resources` n'a de fiche nulle part (A06 et A09 : zéro `resources/subscribe`) ; et déclarer `capabilities.resources.subscribe: true` sans handler renvoie **-32601** — garde-fou fantôme en puissance. Constat annexe : **essaim**, le consommateur de référence du bus cité par le README, souscrit à des topics d'avant v0.7.0 et ne reçoit plus rien depuis. Deux corrections de mes propres mesures : la révision négociée (ma sonde imposait sa propre valeur) et « personne ne consomme `resources/subscribe` » (n=1, contredit par des sources externes non revérifiées ici). |
