# A05 — Extension MCP Tasks : la consultation inter-agents comme opération longue

| Champ | Valeur |
|---|---|
| **ID** | `mcp-tasks-extension` |
| **Surface** | mcp-spec |
| **Statut** | experimental (extension officielle en cours de stabilisation — voir §1) |
| **Disponible depuis** | expérimental dans le cœur MCP en `2025-11-25` ; sorti du cœur vers l'extension `io.modelcontextprotocol/tasks` avec la spec `2026-07-28` (SEP-2663 mergé le 2026-05-15) |
| **Tier** | T2-fort-levier |
| **Nature** | replace-homemade-code |
| **Effort estimé** | L (probablement sous-estimé tant que les SDK ne l'exposent pas) |
| **Confiance veille** | medium |
| **Vérification** | PLAUSIBLE |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — aucun client tiers implémente l'extension |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **§2, côté SDK — affirmation centrale fausse, corrigée.** La fiche affirmait « aucune implémentation TypeScript ni Python à ce jour — seulement des issues d'implémentation ouvertes (`#1060`, `#1546`) ». Vérification directe : le `@modelcontextprotocol/sdk` **déjà installé dans ce repo (1.30.0)** expose `TaskSchema`, `TaskStatusSchema`, `CreateTaskResultSchema`, `GetTaskRequestSchema` (`tasks/get`), `CancelTaskRequestSchema` (`tasks/cancel`), `ListTasksRequestSchema` (`tasks/list`), `GetTaskPayloadRequestSchema` (`tasks/result`), `TaskStatusNotificationSchema` (`notifications/tasks`), `TaskAugmentedRequestParamsSchema`, `ClientTasksCapabilitySchema` / `ServerTasksCapabilitySchema`. Mais c'est la **version SEP-1686 du cœur MCP**, pas l'extension : négociation via `capabilities.tasks` (`{list, cancel}`) et non `capabilities.extensions`, opt-in **par requête et côté client** (`TaskAugmentedRequest`), `tasks/list` et `tasks/result` toujours présents, et **ni `tasks/update`, ni `resultType`, ni `subscriptions/listen`** (0 occurrence). Le SDK est donc en retard d'un redesign sur la spec décrite en §1-§2.
- **§2, issues** : `#1060` (`modelcontextprotocol/typescript-sdk`) et `#1546` (`modelcontextprotocol/python-sdk`) s'intitulent tous deux « Implement SEP-1686: Tasks » et sont **CLOSED**, pas ouvertes. (`#1546` sur le dépôt *typescript-sdk* est une PR TypeDoc sans rapport — la fiche mélangeait deux dépôts.)
- **§4 et §5, numéros de ligne** : `get_thread_updates` est en `src/tools/consultation-tools.ts:377`, pas 398. `cancel_thread` est en **l.333**, pas 313.
- **§5, `sdk/src/client.ts`** : le poll device-code est `deviceCodePoll` en **l.224** (l.223 est son commentaire), pas l.223.

**Marqueurs `(à vérifier)` restants :** aucun — le seul marqueur (`#1060` / `#1546`) a été tranché par lecture directe des deux dépôts.

**Faits confirmés (non modifiés) :** statut `experimental` (bannière README `ext-tasks` verbatim : « Experimental Extension … not an official extension and may change significantly or be discontinued ») ; absence totale de Tasks dans `/extensions/client-matrix`, qui ne liste que MCP Apps, OAuth Client Credentials et Enterprise-Managed Authorization ; toute la surface §2 (méthodes, `resultType: "task"` / `"complete"`, champs `Task`, `inputRequests`/`inputResponses`, négociation `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` ↔ `capabilities.extensions` de `server/discover`, `tools/call` seul augmentable, `tasks/cancel` coopératif, disparition de `tasks/list` et `tasks/result`) ; tous les fichiers de §5 existent, avec `src/types.ts:26`, `src/consultation.ts:586`, `src/server-setup.ts:207-250` et `new McpServer({…})` en l.226 sans aucune `capabilities`, `src/sse-emitter.ts` à 144 lignes, `aedes ^1.1.1` / `mqtt ^5.15.2`, `mqttBridge.publishMessage(...)` (`src/mqtt-bridge.ts:309`), `sseEmitter.emit("thread_cancelled", …)` (`consultation-tools.ts:347`) et le topic `coordinator/<org>/consultations/<thread_id>/messages` dans `cli/channel.ts`.

**Testabilité :** ⚠️ partielle
Testable ici sans credential : l'inspection du SDK installé (déjà faite), le boot du daemon en stdio pour lire la réponse d'initialisation réelle de `createMcpServer`, le log des `clientCapabilities` envoyées par Claude Code, le prototypage du mapping `ThreadStatus` → statuts Tasks, et la mesure de latence MQTT bout-en-bout. Non testable ici : tout aller-retour réel `CreateTaskResult` → `tasks/update` → `inputResponses`, car aucun client MCP n'implémente l'extension et le SDK vendored n'expose ni `tasks/update` ni `resultType` — il faudrait écrire soi-même les deux bouts, ce qui prouverait qu'on sait coder, pas que l'extension est adoptable.

## 1. Ce que c'est

`io.modelcontextprotocol/tasks` est une extension MCP qui standardise les opérations longues sans exiger de connexion longue. Au lieu de bloquer sur un `tools/call`, le serveur répond par un `CreateTaskResult` (identifié par `resultType: "task"`) portant un `taskId`, un statut initial, un `ttlMs` et un `pollIntervalMs` ; le client pilote ensuite la suite avec `tasks/get`, `tasks/update` et `tasks/cancel`. Le statut `input_required` expose une map `inputRequests` que le client satisfait en renvoyant des `inputResponses` via `tasks/update` — c'est de l'élicitation sans connexion serveur→client. Le serveur peut aussi pousser `notifications/tasks` (état complet, ce qui évite un `tasks/get` supplémentaire), le client s'y abonnant via le mécanisme `subscriptions/listen`. La négociation est opt-in des deux côtés : le client déclare l'extension dans `_meta["io.modelcontextprotocol/clientCapabilities"].extensions`, le serveur dans les `capabilities.extensions` de sa réponse `server/discover`. La redesign 2026 (SEP-2663) a supprimé `tasks/list` et le blocage `tasks/result`, et permet au serveur de retourner un handle sans opt-in par requête — la création reste **server-directed**, un client ne peut pas exiger qu'un appel devienne une task, et seul `tools/call` est aujourd'hui documenté comme requête augmentable. Le dépôt de référence `ext-tasks` cite explicitement « Agent communication » parmi les cas d'usage.

**Divergence entre chercheurs, à noter explicitement** : une source du bundle donne le statut `GA`. Les trois vérifications suivantes le réfutent : bannière « Experimental Extension — not an official extension » sur le README de `modelcontextprotocol/ext-tasks`, spec servie sous `/specification/draft/`, aucune release taguée sur le dépôt, et surtout **absence totale de Tasks dans la matrice de support client officielle** (`/extensions/client-matrix` ne liste que MCP Apps, OAuth Client Credentials et Enterprise-Managed Authorization). Aucun client conforme n'est recensé : ni Claude, ni VS Code, ni Cursor. La fiche retient `experimental`.

## 2. Surface d'API exacte

```
Extension id : io.modelcontextprotocol/tasks

Méthodes       : tasks/get, tasks/update, tasks/cancel
Notification   : notifications/tasks   (souscription via subscriptions/listen)
Résultats      : CreateTaskResult  → resultType: "task"
                 GetTaskResult / UpdateTaskResult / CancelTaskResult → resultType: "complete"

Champs Task    : taskId (string)
                 status : "working" | "input_required" | "completed" | "failed" | "cancelled"
                          (les trois derniers sont terminaux)
                 statusMessage (optionnel)
                 createdAt / lastUpdatedAt (ISO 8601)
                 ttlMs (number | null)
                 pollIntervalMs (optionnel)
                 inputRequests (map, quand status = input_required)
                 result | error (selon l'état terminal)
Réponse client : inputResponses (map), envoyée via tasks/update

Négociation    : client  → _meta["io.modelcontextprotocol/clientCapabilities"].extensions
                 serveur → capabilities.extensions dans la réponse server/discover
                 déclaration : "io.modelcontextprotocol/tasks": {}
```

Portée : seul `tools/call` est documenté comme augmentable en task. `tasks/cancel` est coopératif (le serveur n'est pas obligé d'interrompre immédiatement).

Côté SDK (vérifié le 2026-08-14) : les SDK TypeScript et Python implémentent bien Tasks, mais **la version SEP-1686 du cœur MCP, pas cette extension**. Le `@modelcontextprotocol/sdk` installé ici (1.30.0) expose `TaskSchema`, `TaskStatusSchema` (les cinq mêmes statuts), `CreateTaskResultSchema`, `tasks/get`, `tasks/cancel`, `notifications/tasks`, `TaskAugmentedRequestParamsSchema` — mais aussi `tasks/list` et `tasks/result`, supprimés par SEP-2663, et **ni `tasks/update`, ni `resultType`, ni `subscriptions/listen`**. La négociation y passe par `capabilities.tasks` (`ClientTasksCapabilitySchema` = `{list?, cancel?}`) et non par `capabilities.extensions`, et l'opt-in est **par requête, côté client** (`TaskAugmentedRequest`) — l'inverse du modèle server-directed décrit ci-dessus. Les issues d'implémentation `#1060` (typescript-sdk) et `#1546` (python-sdk), toutes deux intitulées « Implement SEP-1686: Tasks », sont **fermées**. Autrement dit : le support SDK existe mais correspond au design d'avant le redesign ; adopter l'extension telle que spécifiée aujourd'hui reste du travail à la main. Le pendant côté agent Claude Code — la famille `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate`, qui a déprécié `TodoWrite` et se réactive avec `CLAUDE_CODE_ENABLE_TASKS=0` — est une surface **distincte** : c'est de l'outillage d'agent, pas l'extension de protocole. Ne pas confondre les deux dans le challenge.

## 3. Sources

- https://modelcontextprotocol.io/extensions/tasks/overview
- https://raw.githubusercontent.com/modelcontextprotocol/ext-tasks/main/specification/draft/tasks.md
- https://github.com/modelcontextprotocol/ext-tasks
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/
- https://code.claude.com/docs/en/tools-reference.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

Le thread de consultation est déjà, exactement, une task. `announce_work` ouvre un thread dont `ThreadStatus` vaut `"open" | "resolving" | "resolved" | "cancelled" | "poisoned"` (`src/types.ts:26`) — une machine à états qui se mappe presque un pour un sur `working | input_required | completed | failed | cancelled`. L'attente d'une réponse d'un pair est aujourd'hui gérée par `get_thread_updates(agent_id, since)` (`src/tools/consultation-tools.ts:377`), c'est-à-dire du polling maison à base de timestamp ISO, doublé d'un push propriétaire (`sse-emitter.ts` + `mqtt-bridge.ts` + broker aedes embarqué). Sur Tasks, cette attente devient : `announce_work` renvoie un `CreateTaskResult`, le thread passe en `input_required` avec les questions posées aux pairs en `inputRequests`, `post_to_thread` devient un `tasks/update` avec `inputResponses`, `cancel_thread` devient `tasks/cancel`, et `pollIntervalMs` remplace la cadence de polling devinée par le client. Ce qui disparaît potentiellement : le couple `get_thread_updates` + `since`, une partie du contrat SSE, et l'argument « il faut MQTT pour savoir qu'on vous a répondu ». Ce qui apparaît : un handle `taskId` durable, avec `ttlMs` explicite (aujourd'hui la durée de vie est implicite, gérée hors bande par `src/sweeper/index.ts`), lisible par n'importe quel client MCP conforme — le jour où il en existe un.

**Risque si on ne fait rien :**

Modéré, et pas immédiat. Si le push d'événements devient une primitive de protocole (`notifications/tasks` + `subscriptions/listen`), le broker MQTT embarqué (`aedes ^1.1.1`, `mqtt ^5.15.2`, ~34 Ko de code entre `mqtt-broker.ts` et `mqtt-bridge.ts`) passe de différenciateur à dette : deux dépendances lourdes et une surface d'attaque à justifier auprès de l'auto-hébergeur. À l'inverse, tant qu'aucun client n'implémente Tasks, ne rien faire ne coûte rien. Le risque réel est celui d'un mauvais timing, pas d'un décrochage.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/tools/consultation-tools.ts` | Cœur de l'impact. `announce_work` (l.36) deviendrait le point de création de task ; `post_to_thread` (l.189) → `tasks/update` + `inputResponses` ; `cancel_thread` (l.333) → `tasks/cancel` ; `get_thread_updates` (l.377) potentiellement supprimé au profit de `tasks/get` / `notifications/tasks`. `propose_resolution` / `approve_resolution` / `contest_resolution` n'ont pas d'équivalent Tasks : ce sont des transitions métier à conserver comme outils. |
| `src/types.ts` (l.26, `ThreadStatus`) | Mapping `open→working`, `resolving→working|input_required`, `resolved→completed`, `cancelled→cancelled`, `poisoned→failed`. `poisoned` perd son sémantisme spécifique en route — à trancher. |
| `src/consultation.ts` | Détient l'état des threads et `getThreadUpdates` (l.586). Deviendrait le store de tasks : ajout de `taskId`, `ttlMs`, `lastUpdatedAt` à côté des colonnes existantes. |
| `src/server-setup.ts` (`createMcpServer`, l.207-250) | Point unique de déclaration de capacités. `new McpServer({...})` (l.226) ne déclare aujourd'hui aucune `capabilities.extensions` — c'est là qu'il faudrait annoncer `"io.modelcontextprotocol/tasks": {}` et lire la capacité côté client. |
| `src/sse-emitter.ts` (144 lignes) | Concurrent direct de `notifications/tasks`. Les `sseEmitter.emit("thread_cancelled", …)` etc. deviennent redondants pour les clients Tasks-aware, à garder pour le dashboard. |
| `src/mqtt-bridge.ts`, `src/mqtt-broker.ts` | Même arbitrage, à plus fort enjeu : `mqttBridge.publishMessage(org, thread_id, agent_id, type, content)` recouvre exactement une transition de task. Décision « garder MQTT pour le cross-machine, exposer Tasks pour les clients standards » à instruire ici. |
| `cli/channel.ts` | Consomme les topics `coordinator/<org>/consultations/<thread_id>/messages` et réexpose un `post_to_thread` en stdio. Si la consultation devient une task, ce pont est soit à réécrire, soit à conserver comme adaptateur legacy. |
| `sdk/src/client.ts` | Le SDK client TS n'a aujourd'hui aucune boucle de polling de threads (seul un poll device-code, `deviceCodePoll` l.224). Une adoption Tasks implique d'y ajouter la boucle `tasks/get` + respect de `pollIntervalMs` : le `@modelcontextprotocol/sdk` (déclaré `^1.29.0`, résolu en 1.30.0) expose bien `tasks/get` et `tasks/cancel`, mais dans leur forme SEP-1686 et sans `tasks/update` — voir §2. |
| `src/sweeper/index.ts` | Gère les rétentions/TTL hors bande. `ttlMs` par task recouvre partiellement cette responsabilité : risque de double source de vérité sur l'expiration. |
| `docs/ARCHITECTURE.md` | À mettre à jour si le modèle « thread » devient « task ». |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> La consultation inter-agents doit-elle devenir une MCP Task (`announce_work` → `CreateTaskResult`, `post_to_thread` → `tasks/update`/`inputResponses`), en acceptant de dépendre d'une extension expérimentale qu'aucun client MCP n'implémente aujourd'hui — ou faut-il garder le modèle propriétaire thread + MQTT/SSE et se limiter à aligner le vocabulaire de `ThreadStatus` sur les statuts Tasks pour préparer une bascule ultérieure sans coût ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille — non exécutée.>

> ⚠️ Non exécutable ici : tout aller-retour réel `CreateTaskResult` → `tasks/update` → `inputResponses` avec un vrai client, aucun client MCP n'implémentant l'extension et le SDK vendored n'exposant ni `tasks/update` ni `resultType`. Les quatre autres points sont exécutables en local.

- [ ] Vérifier dans `node_modules/@modelcontextprotocol/sdk` (v1.29.x) si `tasks/get`, `tasks/update`, `tasks/cancel`, `CreateTaskResult` ou `resultType` apparaissent dans les types générés — si non, le coût d'adoption inclut d'écrire le transport à la main.
- [ ] Lancer le serveur en stdio et inspecter la réponse d'initialisation réelle envoyée par `createMcpServer` : y a-t-il un champ `capabilities.extensions` exploitable, ou faut-il patcher le SDK ?
- [ ] Brancher Claude Code sur le serveur et logger les `clientCapabilities` reçues : confirmer par observation directe que le client ne déclare pas `io.modelcontextprotocol/tasks` (le bundle l'affirme via la matrice officielle ; le tester nous-mêmes).
- [ ] Prototyper le mapping `ThreadStatus` → statuts Tasks sur un thread réel (announce → post → propose → approve) et compter combien de transitions métier n'ont pas d'équivalent (`poisoned`, `contest_resolution`).
- [ ] Mesurer la latence actuelle bout-en-bout d'une réponse de pair via MQTT, pour la comparer au plancher imposé par `pollIntervalMs` — vérifier que la bascule ne dégrade pas ce qui marche.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Aucun client en face.** L'extension est opt-in des deux côtés et la matrice de support client officielle ne recense aucun client la supportant. Un serveur qui l'implémente parle dans le vide : le code maison (SQLite + polling) reste nécessaire en parallèle. On paierait deux implémentations pour une seule capacité.
- **Statut expérimental assumé.** README `ext-tasks` : « may change significantly or be discontinued ». Spec en `/specification/draft/`, zéro release taguée. La feature a déjà été redessinée substantiellement une fois (retrait de `tasks/list` et de `tasks/result` bloquant) ; rien ne dit que c'est la dernière.
- **Effort L sous-estimé.** Sans support SDK, il faut écrire le handling de méthodes hors-schéma, la négociation de capacités et le store de tasks à la main, puis suivre les breaking changes de la draft. C'est du travail de plomberie protocolaire, pas de la valeur produit.
- **MQTT reste meilleur là où il compte.** Le push temps réel bat le polling en latence, et couvre le multi-machine et les clients non-MCP (le dashboard, `cli/channel.ts`). Tasks ne remplace pas ça ; au mieux il double la surface d'événements. « Supprimer MQTT grâce à Tasks » n'est pas sur la table à court terme.
- **Perte de sémantique métier.** `propose_resolution` / `approve_resolution` / `contest_resolution` / `poisoned` n'ont pas d'équivalent dans le modèle Tasks. Forcer le thread dans `working | input_required | completed | failed | cancelled` aplatit un état riche, ou impose de maintenir les deux vues en cohérence.
- **YAGNI immédiat.** Aucun utilisateur ne demande à piloter une consultation depuis un client MCP tiers. Le bénéfice « lisible par n'importe quel client conforme » est aujourd'hui hypothétique.
- **Coût pour l'auto-hébergeur : nul dans les deux sens.** Tasks n'allège pas le déploiement tant que MQTT reste en place ; il ajoute juste un chemin de code de plus à comprendre en cas de panne.

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
| 2026-08-14 | Vérification des faits : SDK implémente Tasks (SEP-1686, pas l'extension) ; issues fermées ; 3 lignes corrigées. |
