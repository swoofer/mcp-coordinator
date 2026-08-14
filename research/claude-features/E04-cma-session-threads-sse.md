# E04 — Modèle d'API à copier : session threads et sémantique de reconnexion SSE

| Champ | Valeur |
|---|---|
| **ID** | `cma-session-threads-sse` |
| **Surface** | managed-agents |
| **Statut** | beta |
| **Disponible depuis** | `2026-05-19` (threads) · `2026-07-22` (`event_deltas` étendus aux streams de thread) |
| **Tier** | T2-fort-levier |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — tout le protocole §6.3 tourne en local |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** ✅ saine

**Corrections apportées :**

- §2 : header beta tranché — `anthropic-beta: managed-agents-2026-04-01` est requis sur toutes les requêtes Managed Agents (exception : endpoints memory store ⇒ `agent-memory-2026-07-22`). Les SDK le posent automatiquement. Les exemples cURL des docs ajoutent aussi `?beta=true` sur les endpoints de stream.
- §2 : `GET /v1/sessions/{session_id}/threads/{thread_id}` (GetThread) confirmé indirectement — la référence d'API expose `sessions.threads.list / retrieve / archive` et `sessions.threads.events.list / stream`. Le endpoint n'apparaît pas en cURL dans les pages guides.
- §5 : `get_thread_updates` déclare `since: z.string().optional()` (et non `z.string()`) — le paramètre est facultatif ; la rupture d'API en cas de curseur d'id reste réelle.

Vérifié sans changement : les six endpoints de §2, les noms d'événements (`session.thread_created`, `session.thread_status_running|_idle|_rescheduled|_terminated`, `agent.thread_message_sent|_received`, `agent.thread_context_compacted`, `event_start`, `event_delta`), les champs `from_/to_session_thread_id`, `from_/to_agent_name`, `parent_thread_id`, `processed_at`, `stop_reason`, le paramètre `event_deltas[]` (`agent.message` / `agent.thinking`, max 100), la non-persistance et l'absence de replay des deltas, le plafond de 25 threads concurrents avec exemption des threads advisor, l'interruption ciblée `user.interrupt` + `session_thread_id`. Statut **beta** toujours exact. Tous les fichiers de §5 existent et les plages de lignes citées pointent bien sur ce que la fiche affirme (`src/types.ts:94-110`, `src/sse-emitter.ts:87-114`, `src/serve-http.ts:305-402` avec `SSE_RESUME_CAP=1000`, `SSE_RECENT_EVENTS_LIMIT=50`, heartbeat 30 s, `src/mqtt-bridge.ts:50-57`, `dashboard/public/dashboard.js:647-656`, `sdk/src/client.ts` sans aucune occurrence de `stream`/`events`).

Non corroboré par la doc : les dates « disponible depuis » (`2026-05-19`, `2026-07-22`) ; les pages officielles ne datent pas ces mises en service — le seul repère daté est le header beta `managed-agents-2026-04-01`.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ✅ testable
Les cinq points du protocole §6.3 ne touchent que notre code : émission massive d'événements + reconnexion `EventSource` avec `Last-Event-ID`, collision de timestamp sur `get_thread_updates`, comptage des sites d'usage d'`EventType`, retain MQTT (le repo embarque son propre broker `src/mqtt-broker.ts` via aedes) et prototype `since_id`. Aucun accès à l'API Managed Agents n'est nécessaire — les faits CMA sont établis par la doc, qui est vérifiable publiquement ; seule une observation de première main du comportement CMA exigerait des credentials avec le header beta, et le protocole n'en a pas besoin.

## 1. Ce que c'est

Dans les Claude Managed Agents, chaque agent d'une session multiagent tourne dans son propre *session thread* : un flux d'événements isolé qui porte son historique de conversation. Le thread primaire est le flux de session ; des threads supplémentaires sont créés à la volée quand le coordinateur délègue, et ils sont **persistants** — relancer un agent déjà sollicité lui rend tout son historique. Les messages inter-agents ne sont pas des effets de bord : ce sont des événements de premier ordre (`agent.thread_message_sent` / `agent.thread_message_received`) portant `from_agent_name`, `to_agent_name` et `to_session_thread_id`. Un thread est adressable : on le liste, on le lit, on l'archive, on s'y abonne en SSE, et on peut l'interrompre seul (`user.interrupt` + `session_thread_id`) ou interrompre toute la session en omettant l'id. Plafond de 25 threads concurrents, les threads *advisor* étant exemptés.

Le second volet est la sémantique de streaming, qui est le vrai apport pour nous. Le flux SSE livre des événements persistés, plus deux événements **stream-only jamais persistés** (`event_start`, `event_delta`), activés par connexion via `event_deltas[]`. La doc pose des règles explicites : accumulation clée sur `(event_id, delta.index)`, la concaténation des deltas ne donne qu'un **préfixe** du texte final, les deltas sont best-effort et peuvent être abandonnés sous charge, l'événement bufferisé fait autorité et constitue la dernière livraison pour cet id. Point critique : **aucun replay à la reconnexion** — la procédure recommandée est d'ouvrir le stream, *puis* lister l'historique, *puis* suivre le live en dédupliquant. Chaque connexion a son propre accumulateur.

## 2. Surface d'API exacte

```
GET  /v1/sessions/{session_id}/threads                      (ListThreads)
GET  /v1/sessions/{session_id}/threads/{thread_id}          (GetThread)
POST /v1/sessions/{session_id}/threads/{thread_id}/archive
GET  /v1/sessions/{session_id}/threads/{thread_id}/events
GET  /v1/sessions/{session_id}/threads/{thread_id}/stream   (et non /events/stream)
GET  /v1/sessions/{session_id}/events/stream?event_deltas[]=agent.message
```

Événements :

```
session.thread_created
session.thread_status_running | _idle | _rescheduled | _terminated
agent.thread_message_sent      { to_session_thread_id, to_agent_name, content }
agent.thread_message_received  { from_session_thread_id, from_agent_name, content }
agent.thread_context_compacted
event_start                    { event: { type, id } }              (stream-only)
event_delta                    { event_id, delta: { type: "content_delta", index, content } }  (stream-only)
```

Champs : `session_thread_id`, `parent_thread_id`, `agent_name`, `from_agent_name`, `to_agent_name`, `processed_at`, `stop_reason.type`, `stop_reason.event_ids`.

Paramètre `event_deltas[]` : valeurs acceptées `agent.message` et `agent.thinking`, max 100 par requête, toute autre valeur ⇒ 400.

SDK :

```ts
client.beta.sessions.events.stream(session_id, { event_deltas: ["agent.message"] })
```

Header beta requis : `anthropic-beta: managed-agents-2026-04-01` sur toutes les requêtes Managed Agents (exception : endpoints memory store ⇒ `agent-memory-2026-07-22`). Les SDK le posent automatiquement. Les exemples cURL des docs passent en plus `?beta=true` sur les endpoints de stream. `GET /v1/sessions/{session_id}/threads/{thread_id}` correspond à `sessions.threads.retrieve` dans la référence SDK.

## 3. Sources

- https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration
- https://platform.claude.com/docs/en/managed-agents/reference
- https://platform.claude.com/docs/en/managed-agents/events-and-streaming

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :** mcp-coordinator a déjà l'abstraction — `src/consultation.ts` manipule des `threads` et des `thread_messages`, et onze outils MCP gravitent autour (`announce_work`, `post_to_thread`, `get_thread`, `get_thread_updates`, `list_threads`, `propose/approve/contest_resolution`, `close/cancel_thread`, `log_action_summary`). Ce qui manque est le vocabulaire et le contrat de flux. Trois gains concrets :

1. **Nommage.** Nos `EventType` sont `thread_opened`, `message_posted`, `thread_resolved`… mais il n'existe aucun événement de message dirigé agent→agent (`from_agent`/`to_agent`). Un développeur qui vient de la doc CMA ne retrouve pas ses repères, et le dashboard ne peut pas afficher « qui parle à qui » sans reconstruire l'info depuis le payload.
2. **Contrat de reconnexion documenté.** `handleSse` (`src/serve-http.ts:326`) fait déjà mieux que CMA sur un point — il *rejoue* via `Last-Event-ID` (`getEventsSince`, plafonné à `SSE_RESUME_CAP = 1000`) ou envoie les 50 derniers (`SSE_RECENT_EVENTS_LIMIT`). Mais ces plafonds créent un **trou silencieux** : un client absent plus de 1000 événements reprend au mauvais endroit sans le savoir, et un client sans `Last-Event-ID` reçoit 50 événements sans marqueur indiquant que c'est un extrait. CMA rend ce contrat explicite (« pas de replay, listez l'historique vous-même, dédupliquez »). Adopter la même honnêteté — ou au minimum signaler la troncature — supprime une classe de bug côté `dashboard/public/dashboard.js:647`.
3. **Curseur de mise à jour.** `get_thread_updates` prend un `since` en **timestamp ISO**. Deux messages postés dans la même milliseconde peuvent être perdus ou dupliqués. CMA cle sur `(event_id, index)` : un curseur monotone d'identifiants, pas une horloge. Le passage à un curseur d'id est un changement petit et à bénéfice direct.

L'opt-in par connexion (`event_deltas[]`) est aussi un bon modèle pour laisser un dashboard demander un flux verbeux là où un agent en tâche de fond veut le minimum — sans multiplier les endpoints.

**Risque si on ne fait rien :** aucun risque de casse. Le coût est de la friction : divergence de vocabulaire avec la plateforme de référence, et deux bugs latents (troncature SSE silencieuse, curseur `since` par timestamp) qui n'apparaîtront que sous charge ou sur un swarm bavard.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/types.ts:94-110` | `EventType` : ajouter un couple dirigé (`thread_message_sent`/`_received` avec `from_agent`/`to_agent`) ou renommer l'existant. Union fermée ⇒ tout ajout est un changement typé, propagé partout. |
| `src/consultation.ts` | Tient déjà `threads` + `thread_messages` ; `getThreadUpdates(orgId, agentId, since)` est le curseur timestamp à remplacer par un curseur d'id. |
| `src/tools/consultation-tools.ts:378-396` | `get_thread_updates` expose `since: z.string().optional()` (ISO). C'est le point de rupture d'API si on passe à un curseur d'id. |
| `src/sse-emitter.ts:87-114` | `getEventsSince(orgId, lastId, limit)` / `getRecentEvents(orgId, limit)` : les deux bornes SQL sont là, mais rien ne signale au client que le résultat a été tronqué. |
| `src/serve-http.ts:305-402` (`handleSse`) | `Last-Event-ID` + `SSE_RESUME_CAP=1000` + `SSE_RECENT_EVENTS_LIMIT=50` + heartbeat 30s. Endroit unique où documenter/émettre le contrat de reconnexion. |
| `src/mqtt-bridge.ts` | Topics `coordinator/<orgId>/consultations/new` retenus **par org, pas par thread** (commentaire ligne 52) : retain ne garde que le dernier thread. Un topic par thread alignerait sur l'adressage CMA. |
| `dashboard/public/dashboard.js:647-656` | `new EventSource('/api/events')` + `e.lastEventId` ; consommateur direct de toute évolution du contrat. |
| `sdk/src/client.ts` | Le SDK ne couvre **pas** les événements ni le streaming aujourd'hui (aucune occurrence de `stream`/`events`). Une méthode client alignée sur `sessions.events.stream` serait un ajout, pas une refonte. |
| `docs/ARCHITECTURE.md` | Section transports/événements à mettre à jour si le vocabulaire change. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Faut-il aligner le vocabulaire d'événements et le curseur de mcp-coordinator sur le modèle CMA (messages dirigés `from_agent`/`to_agent`, curseur `(event_id, index)` au lieu du `since` ISO de `get_thread_updates`, troncature SSE explicitement signalée), sachant que cela casse l'API de `get_thread_updates` et l'union `EventType` — ou bien se limite-t-on à documenter notre contrat SSE existant, qui rejoue déjà via `Last-Event-ID` là où CMA ne rejoue pas du tout ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

Proposition (non exécutée) :

- [ ] Reproduire le trou de replay : émettre > 1000 événements sur une org, reconnecter un `EventSource` avec un `Last-Event-ID` antérieur, vérifier si le client peut détecter la troncature imposée par `SSE_RESUME_CAP`.
- [ ] Reproduire la collision de curseur : poster deux messages dans le même thread dans la même milliseconde, appeler `get_thread_updates` avec `since` = ce timestamp, compter les messages perdus/dupliqués.
- [ ] Mesurer le coût d'un renommage : compter les sites d'usage de chaque valeur d'`EventType` (`src/`, `dashboard/public/dashboard.js`, tests) pour estimer si un ajout non cassant suffit.
- [ ] Vérifier le comportement retain MQTT : ouvrir deux threads consécutifs, s'abonner à `coordinator/<orgId>/consultations/new` et confirmer que seul le dernier est retenu.
- [ ] Prototyper un curseur d'id sur `getThreadUpdates` derrière un paramètre `since_id` optionnel, en gardant `since` accepté, et vérifier qu'aucun test existant ne casse.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **C'est une beta.** Les deux volets sont marqués beta, et l'un des deux (`event_deltas` sur les streams de thread) a bougé en juillet 2026. Copier un vocabulaire encore mouvant, c'est risquer de renommer deux fois.
- **On copierait un modèle plus faible sur le replay.** CMA ne rejoue rien à la reconnexion ; `handleSse` rejoue via `Last-Event-ID`. S'aligner par mimétisme sur « stream + list + dedup » serait une régression fonctionnelle. Seule la *documentation* du contrat mérite d'être copiée, pas le contrat lui-même.
- **Rupture d'API pour un bug théorique.** La collision de timestamp dans `get_thread_updates` n'a jamais été observée en production. Changer la signature d'un outil MCP casse les agents déjà déployés, et le remède peut être disproportionné (YAGNI).
- **Aucune interopérabilité réelle à la clé.** Ce n'est pas une intégration : rien ne circule entre mcp-coordinator et l'API Managed Agents. Le seul gain est cognitif — un développeur qui a lu la doc CMA se repère plus vite. C'est un bénéfice difficile à mesurer.
- **Coût pour l'auto-hébergeur.** Un renommage d'`EventType` invalide les tableaux de bord, alertes et scripts que les utilisateurs ont construits sur les noms actuels, sans qu'ils obtiennent quoi que ce soit en échange.
- **Le plafond de 25 threads concurrents de CMA n'a pas d'équivalent chez nous** et ne doit surtout pas être copié : notre modèle n'a pas la même contrainte de ressources.

**Contradiction à noter :** les deux sources brutes ne divergent pas sur les faits, mais leurs conclusions tirent dans des directions opposées — la première pousse à *copier* la forme d'API CMA, la seconde constate implicitement que notre `sse-emitter` fait déjà plus que CMA sur la reprise. À trancher au challenge.

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
| 2026-08-14 | Vérification des faits : header beta tranché, endpoints et événements confirmés, §5 exact, fiche testable en local. |
