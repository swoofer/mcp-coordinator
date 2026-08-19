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
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — refuser l'emprunt CMA ; le livrable est un bug P1 de fuseau (#346) |

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

*Pré-enregistrée le 2026-08-17, **avant** toute exécution.*

> 📌 **Leçon de `E03`, appliquée d'entrée.** Ce corpus vient de découvrir qu'une inférence non sourcée
> s'était propagée à travers trois fiches par citation croisée. Ici, **rien ne sera repris d'une autre
> fiche sans mesure ou source directe** — et les affirmations sur CMA seront marquées « lu » plutôt
> que « mesuré ».

**Ce que je crois qu'il va se passer.**

1. **La collision de curseur est réelle.** `since` en ISO milliseconde ne peut pas départager deux
   messages écrits dans la même milliseconde : soit on en perd, soit on en duplique. C'est un défaut
   de correction **indépendant de CMA**, et c'est le vrai livrable de cette fiche.
2. Le trou de replay existe aussi, mais il est **borné et connu** (`SSE_RESUME_CAP`) — la question est
   de savoir si le client peut le **détecter**.
3. Le renommage du vocabulaire d'événements sera **cher pour un gain nul** — `EventType` est une union
   fermée consommée par le dashboard et les tests.

**Verdict pressenti :** `adopter partiellement` — corriger le curseur (défaut propre), refuser
l'alignement de vocabulaire.

**Critères de mort.**

| # | Si… | …alors |
|---|---|---|
| **K1** | `get_thread_updates` **ne perd ni ne duplique** rien à la milliseconde | mon hypothèse principale est fausse, et le livrable disparaît. |
| **K2** | la troncature SSE est **déjà détectable** par le client | le second grief tombe. |
| **K3** | ajouter un `since_id` casse des tests existants | ce n'est plus un ajout non cassant : le coût monte et le verdict change. |
| **K4** | le renommage de `EventType` touche plus de **8 fichiers** | la branche « aligner le vocabulaire » est disqualifiée par le coût. |
| **K5** | aucun utilisateur n'a signalé de perte de messages | filtre YAGNI — **mais à peser** : `#236`, de `fosketer`, portait précisément sur des fenêtres de perte de messages. |

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

Proposition (non exécutée) :

- [ ] Reproduire le trou de replay : émettre > 1000 événements sur une org, reconnecter un `EventSource` avec un `Last-Event-ID` antérieur, vérifier si le client peut détecter la troncature imposée par `SSE_RESUME_CAP`.
- [ ] Reproduire la collision de curseur : poster deux messages dans le même thread dans la même milliseconde, appeler `get_thread_updates` avec `since` = ce timestamp, compter les messages perdus/dupliqués.
- [ ] Mesurer le coût d'un renommage : compter les sites d'usage de chaque valeur d'`EventType` (`src/`, `dashboard/public/dashboard.js`, tests) pour estimer si un ajout non cassant suffit.
- [ ] Vérifier le comportement retain MQTT : ouvrir deux threads consécutifs, s'abonner à `coordinator/<orgId>/consultations/new` et confirmer que seul le dernier est retenu.
- [ ] Prototyper un curseur d'id sur `getThreadUpdates` derrière un paramètre `since_id` optionnel, en gardant `since` accepté, et vérifier qu'aucun test existant ne casse.

### 6.4 Résultat observé

*Challenge du 2026-08-17.*

#### A. 🔴 Le vrai défaut n'est pas une collision de seconde — c'est un **décalage de fuseau**

Ma première mesure portait sur le **prédicat SQL** : horodatages stockés à la seconde
(`2026-08-17 04:12:50`, 19 caractères), cinq messages en rafale → **un seul** horodatage distinct,
donc doublons avec `>=`. Exact, mais **ce n'est pas le mode de défaillance dominant.**

La fonction **normalise d'abord** (`src/consultation.ts:601-605`) :

```js
const date = new Date(since);
… date.toISOString().replace("T", " ").slice(0, 19);
```

`new Date("2026-08-17 04:18:48")` — format SQLite, **sans `Z`** — est interprété comme de l'**heure
locale**. Mesuré **sur cette machine** (`America/Toronto`, offset −4 h) :

```
curseur rendu par get_thread_updates : 2026-08-17 04:18:48
normalisé par getThreadUpdates       : 2026-08-17 08:18:48   ← avancé de 4 h
```

Rejeu sur le vrai chemin de code (`dist/src/consultation.js`) :

```
TZ=UTC              -> ["msg-0".."msg-4"]   4 doublons
TZ=America/Toronto  -> []                   5 PERDUS
```

**K1 tient, mais pas pour la raison que j'avais écrite.** Ce n'est pas une seconde qui se perd, c'est
**tout ce qui est plus récent que l'offset de l'hôte**, à chaque appel.

#### B. Et c'est le cas nominal

`get_thread_updates` renvoie `created_at` **brut**, au format SQLite. Un agent qui repasse le curseur
qu'on vient de lui remettre tape exactement ce chemin — et c'est ce que notre doc lui demande
(« fetch only new posts since a timestamp »). **Le format que nous renvoyons et celui que nous
acceptons ne sont pas le même.**

Le silence des utilisateurs s'explique : sur un hôte **UTC** (Docker, CI), le `>=` produit des
**doublons** plutôt que des pertes, et un agent absorbe un doublon sans le signaler.

#### C. 🔴 Le défaut touche le chemin que nous vendons comme fiable — et #236 en dépend

`src/tools/mqtt-tools.ts` dit deux fois : *« For delivery you can rely on, use `get_thread_updates`
instead »*. Et **#236** (`fosketer`, ouverte, « Message loss windows ») reçoit la même réponse — le
chemin durable serait `thread_messages`.

**Ce n'est donc pas une quatrième fenêtre de perte MQTT : c'est un trou dans le remède proposé pour
les trois premières.** Vérifié : #236 ne décrit que des causes MQTT, celle-ci n'y figure pas.
→ **issue #346**.

#### D. Ma seconde mesure décrivait du **code mort**

J'avais écrit « 2 messages perdus » pour `getActionSummaries`. Son seul appelant
(`src/context-provider.ts:42`) **ne passe pas de `since`** — la branche n'est exercée que par un test.
Le défaut y est pire (aucune normalisation, `>` strict, donc 100 % perdu quel que soit le format),
mais **inatteignable aujourd'hui**. À corriger ou retirer avant qu'un appelant n'arrive.

#### E. K2 se déclenche à moitié : la troncature est silencieuse mais **détectable**

Aucun marqueur de troncature n'est émis. **Mais le client peut la déduire** : chaque événement porte
`id: <rowid>`, et le rejeu part contigu au curseur — le trou est donc **à la fin**, visible comme un
saut d'id. En mono-org (le cas de l'auto-hébergeur solo) les ids sont contigus, donc la détection est
**exacte**. Le grief se réduit à **une ligne de documentation**, pas à un défaut de correction.

Deux notes trouvées en passant : le dashboard ne persiste jamais `lastEventId` (le rejeu ne survit pas
à un rechargement), et le sweeper purge `events` à 7 jours.

#### F. K4 se déclenche à 2,9× — et le vocabulaire n'est pas aligné **avec lui-même**

Renommer l'union `EventType` sur le vocabulaire CMA : **23 fichiers, 139 occurrences** (9 dans `src/`,
2 dans `dashboard/`, 12 dans `tests/`). Seuil 8.

Et l'argument d'alignement s'effondre de lui-même : le dashboard écoute `'run_config'`, qui **n'est
pas** dans l'union `EventType` — il est émis via un cast. Symétriquement, `task_claimed` est dans
l'union et **n'a aucun listener**. On n'aligne pas sur un tiers un vocabulaire qui n'est pas aligné
sur son propre consommateur.

#### G. K3 ne se déclenche pas · §0 se prétend vérifiée et ne l'est pas

**K3 :** un `since_id` optionnel ne casse rien — sur 15 références aux tests, **aucune** n'assertit
sur la forme de l'`inputSchema` de `get_thread_updates`. Coût : 2 fichiers en version rowid, 5 en
version honnête (colonne `seq`, parce que `thread_messages.id` est un UUID non ordonnable et que les
migrations recréent la table).

**§0** affirme que « les plages de lignes citées pointent bien sur ce que la fiche affirme ».
`get_thread_updates` est en **431-452**, pas 378-396 — cette dernière plage tombe sur
`close_thread`/`cancel_thread`. Et la fiche `A05` en donne encore une troisième valeur. **Trois
fiches, trois numéros, aucun juste** — le motif exact que `E03` vient de dénoncer, reproduit dans la
fiche qui le cite.

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** l'emprunt à CMA |
| **Date** | 2026-08-17 |
| **Justification** | **Rien de CMA ne survit.** K4 se déclenche à 2,9× (23 fichiers, 139 occurrences) pour aligner un vocabulaire qui n'est **pas aligné avec son propre consommateur** — le dashboard écoute un événement absent de l'union, et un membre de l'union n'a aucun listener. K2 se réduit à une ligne de doc : la troncature SSE est silencieuse mais **déductible** par contiguïté d'id. Et le seul livrable réel de cette fiche **n'est pas un emprunt** : c'est un bug de fuseau horaire dans notre propre curseur → **#346**. |
| **Issue / PR** | [#346](https://github.com/swoofer/mcp-coordinator/issues/346) — P1, ouvert par ce challenge |
| **Jalon visé** | aucun pour la fiche ; #346 est prioritaire |

### Le vrai livrable : un bug P1, et il n'a rien à voir avec CMA

`get_thread_updates` réinterprète en **heure locale** le curseur qu'il a lui-même rendu au format
SQLite. Sur tout hôte à offset négatif, le curseur est **avancé** et la requête ne matche plus rien :
**perte totale de tout message plus récent que l'offset, à chaque appel**. Mesuré sur cette machine
(−4 h) et rejoué sur le vrai chemin de code.

C'est un trou dans le chemin que nous documentons comme la garantie de livraison — celui-là même que
la réponse à **#236** oppose à MQTT.

### Ce qui est refusé

- **L'alignement du vocabulaire d'événements sur CMA** (K4).
- **Le curseur `(event_id, index)` emprunté à CMA** : notre problème n'est pas la forme du curseur,
  c'est que nous renvoyons un format que nous n'acceptons pas. Un `since_id` reste une option — non
  cassante, mesurée — mais elle relève de #346, pas d'un emprunt.

### Ce qui n'est pas refusé

**Une ligne de documentation** sur la troncature du replay SSE : elle est déductible côté client par
saut d'id, mais rien ne le dit.

### Corrections obligatoires

- **§4 point 3 est faux de trois ordres de grandeur et sur la nature du défaut** : « deux messages
  dans la même **milliseconde** » → c'est la **seconde**, et le mode dominant est un décalage de
  **fuseau entier**.
- **§0 se prétend vérifiée** : `get_thread_updates` est en 431-452, pas 378-396.
- Le schéma du paramètre `since` **ment** : il annonce « only messages **after** this time » alors que
  le SQL est `>=`.

### Note de méthode

**J'ai mesuré le prédicat, pas la fonction.** Mon banc reproduisait le schéma et testait `>=` contre
`>` — le résultat était exact et la conclusion incomplète, parce que la vraie fonction **normalise
avant de comparer**, et c'est la normalisation qui casse. Un banc qui reproduit le stockage sans
reproduire le chemin d'appel mesure la moitié du problème.

C'est la même famille de faute que `E02` (« j'ai lu une ligne de log sans la lire ») et `E01` (« j'ai
testé le mauvais harnais ») : **l'instrument fonctionnait, il n'était pas branché au bon endroit.**

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : header beta tranché, endpoints et événements confirmés, §5 exact, fiche testable en local. |
| 2026-08-17 | **Challenge — verdict `refuser` l'emprunt à CMA, et découverte d'un bug P1.** Le vrai défaut n'est pas la collision de seconde que §4 envisageait : `getThreadUpdates` **réinterprète en heure locale** le curseur qu'il a lui-même rendu au format SQLite (`new Date("2026-08-17 04:18:48")` sans `Z`). Mesuré sur cette machine (`America/Toronto`, −4 h) : curseur `04:18:48` → normalisé `08:18:48`, **avancé de 4 h**. Rejoué sur le vrai chemin : `TZ=UTC` → 4 doublons, `TZ=America/Toronto` → **5 messages perdus sur 5**. C'est le cas nominal, puisque nous renvoyons `created_at` brut et que la doc demande de le repasser — **le format rendu et le format accepté ne sont pas le même**. Et cela troue le chemin que `mqtt-tools.ts` et la réponse à **#236** présentent comme la garantie de livraison → **issue #346**. Ma seconde mesure (`getActionSummaries`) décrivait du **code mort** : son seul appelant ne passe pas de `since`. **K4 déclenché à 2,9×** (23 fichiers, 139 occurrences) — et l'alignement s'effondre de lui-même, le dashboard écoutant `run_config`, absent de l'union `EventType`, tandis que `task_claimed` n'a aucun listener. **K2 à moitié** : la troncature SSE est silencieuse mais **déductible** par contiguïté d'id, donc une ligne de doc suffit. K3 non déclenché : un `since_id` optionnel ne casse aucun test. **§0 se prétend vérifiée** alors que `get_thread_updates` est en 431-452 et non 378-396 — et `A05` en donne une troisième valeur. |
