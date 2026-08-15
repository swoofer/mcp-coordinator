# A05 — Extension MCP Tasks : la consultation inter-agents comme opération longue

| Champ | Valeur |
|---|---|
| **ID** | `mcp-tasks-extension` |
| **Surface** | mcp-spec |
| **Statut** | experimental (extension officielle en cours de stabilisation — voir §1) |
| **Disponible depuis** | expérimental dans le cœur MCP en `2025-11-25` ; sorti du cœur vers l'extension `io.modelcontextprotocol/tasks` avec la spec `2026-07-28` (SEP-2663 mergé le 2026-05-15) |
| **Tier** | ~~T2-fort-levier~~ **T3** — déclassée au challenge du 2026-08-15 : zéro client des deux côtés du fil, à suivre sans agir (§7.2) |
| **Nature** | ~~replace-homemade-code~~ **opportunity** — elle ne remplace rien : le handle durable (`thread.id`) et le TTL (`timeout_seconds`) existent déjà, et `pollIntervalMs` est dominé par `wait_for_message` (§7.4) |
| **Effort estimé** | L (probablement sous-estimé tant que les SDK ne l'exposent pas) |
| **Confiance veille** | medium |
| **Vérification** | PLAUSIBLE |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — aucun client tiers implémente l'extension |
| **Statut du challenge** | ✅ **tranché** — 2026-08-15, verdict `reporter` (§7) |

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

*Pré-enregistré le 2026-08-15, AVANT toute exécution.*

**Hypothèse.** La fiche décrit une extension dont personne ne veut. Je m'attends à trouver pire que
« pas encore adoptée » : que la ligne SDK vers laquelle le projet **vient de décider de migrer**
([#286](https://github.com/swoofer/mcp-coordinator/issues/286), fiche
[`A02`](A02-mcp-sdk-typescript-v2.md) tranchée le même jour) ait **retiré le runtime Tasks**. Si
c'est le cas, adopter l'extension signifierait écrire le protocole à la main **contre** le sens du
SDK, pour une spec en `draft` qui annonce elle-même pouvoir être abandonnée. Je m'attends aussi à ce
que le point 3 du §6.3 soit déjà répondu : la capture au proxy du même jour
([`A01`](A01-mcp-2026-07-28-stateless.md) §6.4 (5 bis)) montre les capacités réelles de Claude Code
2.1.233.

**Critères de refus (ce qui me ferait conclure « non bénéfique maintenant ») :**

- **A05-R1 — personne en face.** Si aucun client réel ne déclare `io.modelcontextprotocol/tasks`
  (ni `capabilities.tasks`, ni `extensions`), le serveur parlerait dans le vide et devrait garder
  le code maison en parallèle : deux implémentations pour une capacité.
- **A05-R2 — le SDK va dans l'autre sens.** Si `@modelcontextprotocol/server@2.0.0` — la cible de
  #286 — a **retiré** le runtime Tasks, alors adopter, c'est ramer à contre-courant du SDK et
  réécrire à la main ce que la v1 fournissait. → disqualifiant.
- **A05-R3 — perte de sémantique.** Si le mapping `ThreadStatus` → statuts Tasks laisse **2
  transitions métier ou plus** sans équivalent, le modèle aplatit un état riche.
- **A05-R4 — régression de latence.** Si le push MQTT actuel bat nettement le plancher imposé par
  `pollIntervalMs`, basculer dégrade ce qui marche.
- **A05-R5 — cible mouvante.** Si la spec est toujours en `draft` sans release taguée et porte la
  mention « may be discontinued », l'effort de plomberie protocolaire n'est pas amortissable.
- **A05-R6 — la fiche s'effondre.** Si l'extension n'existe plus, ou si le dépôt `ext-tasks` est
  archivé → `refuser` immédiat.

### 6.3 Protocole de vérification

*Amendé en session le 2026-08-15. Les cinq points de la veille sont conservés ; le point 3 est
**déjà répondu** par une mesure du même jour et devient une vérification de cohérence. Un sixième
point est ajouté : il porte le critère A05-R2, que la veille ne pouvait pas anticiper puisque `A02`
n'était pas encore tranchée.*

> ⚠️ Reste non exécutable : l'aller-retour réel `CreateTaskResult` → `tasks/update` →
> `inputResponses` avec un **client tiers**, faute de client implémentant l'extension. Écrire les
> deux bouts moi-même prouverait que je sais coder, pas que l'extension est adoptable — la §0 a
> raison sur ce point et je ne le contourne pas.

- [ ] **(1)** Inspecter le SDK **1.30.0 installé** : `tasks/get`, `tasks/update`, `tasks/cancel`,
      `CreateTaskResult`, `resultType`.
- [ ] **(2)** Lancer le serveur en stdio et lire la **réponse d'initialisation réelle** de
      `createMcpServer` : y a-t-il un `capabilities.extensions` exploitable ?
- [ ] **(3)** *(déjà mesuré)* Confronter les `clientCapabilities` réellement envoyées par
      Claude Code 2.1.233 à l'affirmation de la matrice officielle.
- [ ] **(4)** Prototyper le mapping `ThreadStatus` → statuts Tasks et **compter** les transitions
      métier sans équivalent (`poisoned`, `contest_resolution`).
- [ ] **(5)** Mesurer la latence bout-en-bout d'une réponse de pair via MQTT, à comparer au plancher
      `pollIntervalMs`.
- [ ] **(6) NOUVEAU — l'état de Tasks dans `@modelcontextprotocol/server@2.0.0`**, la cible de
      [#286](https://github.com/swoofer/mcp-coordinator/issues/286). C'est le point qui décide :
      si le runtime a disparu de la ligne v2, l'extension est un cul-de-sac pour ce projet.

- [ ] Vérifier dans `node_modules/@modelcontextprotocol/sdk` (v1.29.x) si `tasks/get`, `tasks/update`, `tasks/cancel`, `CreateTaskResult` ou `resultType` apparaissent dans les types générés — si non, le coût d'adoption inclut d'écrire le transport à la main.
- [ ] Lancer le serveur en stdio et inspecter la réponse d'initialisation réelle envoyée par `createMcpServer` : y a-t-il un champ `capabilities.extensions` exploitable, ou faut-il patcher le SDK ?
- [ ] Brancher Claude Code sur le serveur et logger les `clientCapabilities` reçues : confirmer par observation directe que le client ne déclare pas `io.modelcontextprotocol/tasks` (le bundle l'affirme via la matrice officielle ; le tester nous-mêmes).
- [ ] Prototyper le mapping `ThreadStatus` → statuts Tasks sur un thread réel (announce → post → propose → approve) et compter combien de transitions métier n'ont pas d'équivalent (`poisoned`, `contest_resolution`).
- [ ] Mesurer la latence actuelle bout-en-bout d'une réponse de pair via MQTT, pour la comparer au plancher imposé par `pollIntervalMs` — vérifier que la bascule ne dégrade pas ce qui marche.

### 6.4 Résultat observé

*Session du 2026-08-15, Windows 11 / Node 22.21.0 / Claude Code 2.1.233. Frontière exécuté / lu
au (6).*

---

#### (1) SDK 1.30.0 installé : la méthode centrale de l'extension n'existe pas

```
=== SDK v1.30.0 installe : vocabulaire Tasks ===
tasks/get                : 6        tasks/list           : 6
tasks/update             : 0   <--  tasks/result         : 7
tasks/cancel             : 6        notifications/tasks  : 4
CreateTaskResult         : 6        resultType           : 0
TaskAugmentedRequest     : 13
```

La §0 avait raison : c'est la version **SEP-1686 du cœur**, pas l'extension. `tasks/list` et
`tasks/result` — supprimés par SEP-2663 — sont là ; `tasks/update` et `resultType` n'y sont pas.

**Trouvaille annexe, réelle :** la forme attendue par `ClientTasksCapabilitySchema` est
`list?: object` / `cancel?: object`, **pas** des booléens. Un client qui envoie
`capabilities.tasks: { list: true, cancel: true }` se fait rejeter par notre daemon :

```
{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"[{\"code\":\"custom\",
 \"path\":[\"params\",\"capabilities\",\"tasks\",\"list\"],\"message\":\"Invalid input\"}, …]"}}
```

C'est un piège d'interopérabilité qui existe **aujourd'hui**, indépendamment de toute adoption.

---

#### (2) `capabilities.extensions` : le canal existe, mais nous ne déclarons rien

`InitializeResult` **réel** de `createMcpServer`, lu en stdio sur le daemon du dépôt, en réponse à
un client qui déclare pourtant `tasks` **et** `extensions: {"io.modelcontextprotocol/tasks": {}}` :

```json
{ "protocolVersion": "2025-11-25",
  "capabilities": { "tools": { "listChanged": true } },
  "serverInfo": { "name": "io.github.swoofer/mcp-coordinator", "version": "2.0.1" } }

capabilities.extensions present ? -> false
capabilities.tasks present ?      -> false
cles de capabilities              -> tools
```

À noter, contre une intuition facile : le champ `extensions` **existe bien** dans les schémas de
capacités des deux SDK (11 occurrences en 1.30.0, dont `InitializeRequestParams`). Le canal de
négociation n'est donc pas le blocage — c'est qu'il n'y a rien à négocier avec personne.

---

#### (3) Personne en face — mesuré des deux côtés

**Côté matrice officielle** (`modelcontextprotocol.io/extensions/client-matrix`, fetchée le
2026-08-15) : trois extensions listées — `io.modelcontextprotocol/ui` (MCP Apps),
`io.modelcontextprotocol/oauth-client-credentials`,
`io.modelcontextprotocol/enterprise-managed-authorization`. **Tasks n'y figure pas du tout**, ni
dans la liste des extensions, ni dans les colonnes des 11 clients recensés.

**Côté client réel** : la capture au proxy du même jour
([`A01`](A01-mcp-2026-07-28-stateless.md) §6.4 (5 bis)) montre ce que Claude Code 2.1.233 envoie :

```
"capabilities":{"roots":{"listChanged":true},"elicitation":{}}
```

Ni `tasks`, ni `extensions`. → **A05-R1 déclenché**, et pas sur la foi de la matrice : sur le fil.

---

#### (4) L'état de Tasks dans la cible de #286 — le point qui décide

```
=== SDK v2.0.0 : que reste-t-il de Tasks ? ===
tasks/get       : 18     tasks/list          : 14     CreateTaskResult : 41
tasks/update    :  0     tasks/result        : 14     taskStore        :  1
tasks/cancel    : 14     notifications/tasks : 10
io.modelcontextprotocol/tasks : 0

--- mention portee par les types Task ---
/** @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only. */
```

Trois faits, à ne pas confondre :

1. Le vocabulaire **SEP-1686 du cœur** est conservé importable mais **sans runtime** — c'est la
   version que le SDK 1.30.0 implémentait vraiment. La ligne v2, cible de
   [#286](https://github.com/swoofer/mcp-coordinator/issues/286), l'a donc **désimplémentée**.
2. `tasks/update`, la méthode centrale de l'**extension**, a **0 occurrence dans les deux SDK**.
   Elle n'est implémentée nulle part.
3. `io.modelcontextprotocol/tasks` — l'identifiant même de l'extension — a **0 occurrence** dans
   toute la famille v2.

→ **A05-R2 déclenché.** Adopter l'extension signifierait écrire le protocole entier à la main, sur
une ligne SDK qui vient de retirer le peu qu'elle en avait.

---

#### (5) Ce que le modèle Tasks ferait perdre, compté

`src/types.ts` :

```ts
// l.24-25 : "poisoned" = a work-stealing task that was unclaimed too many times without
//           reaching DONE. Filtered out of the claim pool so it doesn't churn indefinitely.
l.26  export type ThreadStatus = "open" | "resolving" | "resolved" | "cancelled" | "poisoned";
l.27  export type ResolutionType =
l.28    "consensus" | "auto_resolved" | "timeout" | "closed" | "max_rounds" | "agent_departure";
```

| Ce qu'on a | Équivalent Tasks |
|---|---|
| `ThreadStatus` × 5 | mapping plausible, sauf `poisoned` → `failed` (perd la sémantique work-stealing) |
| **`ResolutionType` × 6** | **aucun** — les six s'écrasent sur `completed` |
| `propose_resolution` / `approve_resolution` / `contest_resolution` | **aucun** — transitions métier à conserver comme outils |

→ **A05-R3 déclenché**, et largement au-dessus du seuil de 2 : **6 types de résolution + 3
transitions + 1 statut** sans destination.

---

#### (6) Latence : le push actuel est deux ordres de grandeur sous n'importe quel polling

`scratchpad/probe-latency.mjs`, contre le daemon réel : 10 annonces, mesure du délai entre le
`POST /api/announce` et l'arrivée de l'événement sur un `/api/events` déjà ouvert (ce que fait un
pair qui attend).

```
echantillons recus : 9/10
latence POST /api/announce -> evenement sur /api/events (ms) :
  min 4.3 | median 5.1 | p90 8.0 | max 8.0
  brut : 4.3, 4.3, 4.3, 4.4, 5.1, 5.4, 5.6, 7.1, 8.0
```

**Médiane 5,1 ms.** Un `pollIntervalMs` réaliste (≥ 500 ms) dégraderait d'un facteur ~100.
→ **A05-R4 déclenché.**

---

#### (7) Statut de l'extension elle-même

`github.com/modelcontextprotocol/ext-tasks`, fetché le 2026-08-15. Bannière verbatim :

> ⚠️ **Experimental Extension** — This repository contains an experimental extension to the Model
> Context Protocol (MCP). It is **not an official extension** and may change significantly or **be
> discontinued**.

Dépôt **non archivé**, 17 commits, **aucune release taguée**, spec servie sous
`/specification/draft/`. → **A05-R5 déclenché**, et **A05-R6 non déclenché** : l'extension existe
toujours, elle n'est simplement adoptée par personne.

---

#### (8) L'extension n'est pas morte — elle dort, et son schéma a des défauts ouverts

*Section ajoutée après la passe adversariale, qui m'a repris sur deux points. Vérifié moi-même via
`gh` le 2026-08-15.*

```
$ gh pr view 2663 --repo modelcontextprotocol/modelcontextprotocol
{"title":"SEP-2663: Tasks Extension","state":"MERGED","mergedAt":"2026-05-15T19:46:44Z"}

$ gh api repos/modelcontextprotocol/ext-tasks/commits
2026-07-15  Bump hono in the npm_and_yarn group (#6)      <- dependabot
2026-06-09  Set up Vitepress deployment (#7)              <- outillage
2026-06-03  Bump qs in the npm_and_yarn group (#3)        <- dependabot
2026-05-29  Port #2756 (#5)                               <- dernier commit de FOND
2026-05-28  chore: port ResultType fix (#4)
2026-05-22  Write updated docs and port SEP-2663 content (#2)

$ gh issue list --repo modelcontextprotocol/ext-tasks --state open
#14 2026-08-10  Generated schema leaves input unions unconstrained and omits required
                resultType discriminators
#12 2026-08-02  Should Readme still say experimental?
#11 2026-08-01  Stalled tasks

$ gh pr list --repo modelcontextprotocol/ext-tasks --state open
#13 2026-08-02  Update Tasks extension docs to reflect official MCP status
#10 2026-07-31  fix: correct MISSING_REQUIRED_CLIENT_CAPABILITY error code to -32021
#9  2026-07-31  fix: restore auth binding requirement dropped during SEP-2663 port
#8  2026-07-15  Bump the npm_and_yarn group
```

Ce que ça change, dans les deux sens :

- **Contre `refuser` :** le SEP est **mergé** dans le dépôt de spec principal, le contenu est **figé
  depuis le 2026-05-29**, et la bannière « experimental » est elle-même contestée en interne
  (issue #12 sans réponse, PR #13 ouverte et intitulée « … to reflect official MCP status »).
  Ce n'est pas un cadavre. *Nuance honnête :* ni #12 ni #13 ne sont autoritatives — la bannière que
  je cite en (7) reste, aujourd'hui, le texte en vigueur.
- **Contre `adopter` :** l'artefact n'est pas fini. **#14, ouverte il y a 5 jours**, dit que le
  schéma généré « leaves input unions unconstrained and omits required `resultType` discriminators »
  — un défaut sur le mécanisme même qu'on adopterait. Et **#9** répare une *« auth binding
  requirement **dropped during SEP-2663 port** »* : le portage a perdu une exigence de sécurité.
  → **A05-R5 : maintenu, mais reformulé** — le grief n'est pas « ça bouge tout le temps », c'est
  « ça ne bouge plus et ça a des trous ouverts, dont un sur l'auth ».

**Et je dois corriger mon propre critère A05-R2.** Je l'avais formulé « si le SDK v2 a retiré le
runtime Tasks, adopter c'est ramer à contre-courant du SDK ». **C'est une erreur de catégorie**, et
ma propre mesure (2) la contredisait déjà : le `@deprecated` du SDK v2 vise le vocabulaire
**SEP-1686 du cœur** — précisément le design que l'extension **remplace** — tandis que
`capabilities.extensions` est présent et **non déprécié** sur `ClientCapabilities` **et**
`ServerCapabilities`, et que v2 exporte `SubscriptionsListenRequestSchema` et
`DiscoverRequest/ResultSchema`. Une extension ne vit pas dans le SDK cœur, par construction : les
« 0 occurrence de `io.modelcontextprotocol/tasks` » ne mesurent aucun retrait.

**Ce qui survit de A05-R2, et qui compte :** `tasks/update` a **0 occurrence dans les deux SDK**.
Adopter, c'est écrire la méthode centrale et son store à la main. C'est un **coût**, pas une
contre-indication de direction. → **A05-R2 : retiré comme argument de direction, conservé comme
chiffrage d'effort.**

#### (9) Frontière exécuté / lu

**Exécuté :** l'inspection des deux SDK, l'`InitializeResult` réel du daemon en stdio (y compris
le rejet `-32603` sur la forme booléenne), la mesure de latence contre le daemon réel.

**Fetché aujourd'hui :** la matrice de support client, le README `ext-tasks`.

**Non exécuté, et assumé :** l'aller-retour `CreateTaskResult` → `tasks/update` → `inputResponses`
avec un **client tiers**. La §0 le disait et elle a raison : aucun client n'implémente l'extension,
et `tasks/update` n'existe dans aucun SDK. Écrire les deux bouts moi-même aurait prouvé que je sais
coder, pas que l'extension est adoptable. **Aucun verdict ci-dessous ne repose sur cette partie** —
les cinq critères déclenchés le sont tous par de l'exécuté ou de la doc officielle fetchée.

### 6.5 Contre-arguments

*Repris le 2026-08-15 après l'expérience et une passe adversariale. Barré = tombé.*

- **Le « lot de consolation » de §6.1 n'est pas gratuit — et il est déjà là.** La question propose,
  en repli, « aligner le vocabulaire de `ThreadStatus` sur les statuts Tasks pour préparer une
  bascule ultérieure **sans coût** ». Les trois apports supposés existent déjà ou sont dominés :
  le **handle durable**, c'est `thread.id`, déjà retourné par `announce_work`
  (`consultation-tools.ts:173-186`) ; le **TTL explicite**, c'est `timeout_seconds`
  (`src/types.ts:43`, défaut 600, appliqué en `src/consultation.ts:448-449` et `462-463`) ; et
  `pollIntervalMs` est **strictement inférieur** à `wait_for_message`
  (`src/tools/mqtt-tools.ts:52-77`), un long-poll bloquant plafonné à 300 s — sans parler de la
  **médiane à 5,1 ms** mesurée en (6). Reste le renommage de l'enum : il est dupliqué dans
  `list_threads` (`consultation-tools.ts:403`) et en colonne SQLite, donc il coûte une **migration
  de schéma** — pour zéro gain, et en perdant les 6 valeurs de `ResolutionType`. **« Sans coût » est
  faux dans les deux sens : ça coûte, et ça ne rapporte rien.**
- **Aucun client en face.** L'extension est opt-in des deux côtés et la matrice de support client officielle ne recense aucun client la supportant. Un serveur qui l'implémente parle dans le vide : le code maison (SQLite + polling) reste nécessaire en parallèle. On paierait deux implémentations pour une seule capacité.
- **Statut expérimental assumé.** README `ext-tasks` : « may change significantly or be discontinued ». Spec en `/specification/draft/`, zéro release taguée. La feature a déjà été redessinée substantiellement une fois (retrait de `tasks/list` et de `tasks/result` bloquant) ; rien ne dit que c'est la dernière.
- **Effort L sous-estimé.** Sans support SDK, il faut écrire le handling de méthodes hors-schéma, la négociation de capacités et le store de tasks à la main, puis suivre les breaking changes de la draft. C'est du travail de plomberie protocolaire, pas de la valeur produit.
- **MQTT reste meilleur là où il compte.** Le push temps réel bat le polling en latence, et couvre le multi-machine et les clients non-MCP (le dashboard, `cli/channel.ts`). Tasks ne remplace pas ça ; au mieux il double la surface d'événements. « Supprimer MQTT grâce à Tasks » n'est pas sur la table à court terme.
- **Perte de sémantique métier.** `propose_resolution` / `approve_resolution` / `contest_resolution` / `poisoned` n'ont pas d'équivalent dans le modèle Tasks. Forcer le thread dans `working | input_required | completed | failed | cancelled` aplatit un état riche, ou impose de maintenir les deux vues en cohérence.
- **YAGNI immédiat.** Aucun utilisateur ne demande à piloter une consultation depuis un client MCP tiers. Le bénéfice « lisible par n'importe quel client conforme » est aujourd'hui hypothétique.
- **Coût pour l'auto-hébergeur : nul dans les deux sens.** Tasks n'allège pas le déploiement tant que MQTT reste en place ; il ajoute juste un chemin de code de plus à comprendre en cas de panne. → **tient**, et la mesure de latence le renforce.

**Repris après vérification — deux contre-arguments à corriger, un à ajouter :**

- ~~**Statut expérimental assumé** (« la feature a déjà été redessinée une fois ; rien ne dit que
  c'est la dernière »).~~ **AFFAIBLI.** SEP-2663 est **mergé** dans le dépôt de spec principal
  (2026-05-15) et le contenu d'`ext-tasks` est **figé depuis le 2026-05-29** — 2,5 mois sans commit
  de fond. Ce n'est pas une cible mouvante. Le vrai grief est ailleurs, voir ci-dessous.
- ~~**Effort L sous-estimé « sans support SDK »**, au sens « il faut aussi la négociation de
  capacités ».~~ **PARTIELLEMENT TOMBÉ.** La négociation, elle, est fournie :
  `capabilities.extensions` est présent et **non déprécié** dans les deux SDK, et v2 exporte
  `SubscriptionsListenRequestSchema` et `DiscoverRequest/ResultSchema`. Ce qui reste à écrire à la
  main est réel mais plus étroit : **`tasks/update` (0 occurrence dans les deux SDK)** et le store
  de tasks.
- **AJOUTÉ — l'artefact a des trous ouverts, dont un sur l'auth.** `ext-tasks` #14 (2026-08-10) :
  le schéma généré « leaves input unions unconstrained and omits required `resultType`
  discriminators ». `ext-tasks` #9 : *« restore auth binding requirement **dropped during SEP-2663
  port** »*. Adopter aujourd'hui, ce serait implémenter à la main une spec dont les mainteneurs
  réparent encore le portage — y compris une exigence de sécurité perdue en route.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | **Zéro client, des deux côtés du fil.** La matrice officielle ne liste que trois extensions et Tasks n'y figure pas ; Claude Code 2.1.233 annonce `{roots, elicitation}` — mesuré. Et l'extension elle-même n'est pas prête : `tasks/update`, sa méthode centrale, a **0 occurrence dans les deux SDK**, et son dépôt porte des défauts ouverts sur le schéma (#14) et sur une exigence d'auth perdue au portage (#9). Mais elle n'est pas morte non plus — SEP-2663 est mergé, la spec est figée depuis mai, et le SDK v2 fournit déjà le canal de négociation. **Endormie, pas enterrée.** |
| **Issue / PR** | — (aucune : rien à coder) |
| **Jalon visé** | Réveil conditionnel, voir §7.2 |

### 7.1 La réponse à la question de §6.1

**Les deux termes sont mauvais, mais pas pour les mêmes raisons.**

- *« La consultation devient une MCP Task »* → non, et pas d'abord à cause du statut expérimental :
  parce que **personne n'écoute**. Un serveur qui implémente une extension opt-in que zéro client
  déclare parle dans le vide, et devrait garder le chemin maison en parallèle — deux
  implémentations pour une capacité. S'y ajoutent une perte de sémantique chiffrée (**6
  `ResolutionType` + 3 transitions de résolution + `poisoned` sans destination**) et une régression
  de latence d'environ deux ordres de grandeur (**5,1 ms mesurés** contre le plancher d'un polling).
- *« Se limiter à aligner le vocabulaire de `ThreadStatus`, sans coût »* → non plus, et c'est le
  résultat le moins attendu de ce challenge : **la prémisse « sans coût » est fausse dans les deux
  sens.** Le handle durable (`thread.id`) et le TTL (`timeout_seconds`) **existent déjà** ;
  `pollIntervalMs` est dominé par `wait_for_message` ; et le renommage de l'enum impose une
  **migration SQLite** (l'enum est dupliqué en colonne et dans `list_threads`) tout en écrasant les
  6 valeurs de `ResolutionType`. On paierait une migration pour perdre de l'information.

**Ce qui reste vrai de la fiche :** le thread *est* conceptuellement une task, et le mapping des
5 statuts tient. Ce n'est simplement pas une raison d'agir.

### 7.2 Condition de réveil

**Une seule, et elle est observable sans effort :**

> **Un premier client déclare l'extension** — soit une ligne `Tasks` apparaît dans
> `modelcontextprotocol.io/extensions/client-matrix`, soit Claude Code envoie
> `extensions: {"io.modelcontextprotocol/tasks": {}}` dans ses `clientCapabilities`.
> Ce second cas se re-mesure en 5 minutes avec le proxy d'écoute déjà écrit
> (`scratchpad/wire-proxy.mjs`, cf. [`A01`](A01-mcp-2026-07-28-stateless.md) §6.4 (5 bis)).

Deux signaux secondaires à surveiller au passage, parce qu'ils sont gratuits :
`ext-tasks` **#14** (défaut de schéma sur les discriminants `resultType`) et **#9** (exigence
d'auth perdue au portage de SEP-2663) — tant qu'ils sont ouverts, l'artefact n'est pas
implémentable sérieusement, même si un client apparaissait.

**Le jour du réveil, l'adoption coûtera moins cher que ne le dit cette fiche :**
`capabilities.extensions` est déjà présent et non déprécié dans le SDK v2 vers lequel
[#286](https://github.com/swoofer/mcp-coordinator/issues/286) fait migrer.

### 7.3 Ce qui est écarté explicitement

- **Déclarer `capabilities.extensions` « pour se préparer »** — écarté : déclarer une extension
  qu'on n'implémente pas, c'est le patron du **garde-fou fantôme** que le challenge de
  [`A04`](A04-subscriptions-listen.md) a déjà relevé sur `resources.subscribe` (déclarer sans
  installer le handler → `-32601`). On ne refait pas la même erreur volontairement.
- **Renommer `ThreadStatus`** — écarté, voir §7.1.
- **Remplacer MQTT/SSE par `notifications/tasks`** — écarté : mesuré à 5,1 ms de médiane, le push
  actuel n'a aucun concurrent crédible côté polling, et MQTT couvre en plus le multi-machine et les
  clients non-MCP (dashboard, `cli/channel.ts`).

### 7.4 Corrections apportées à la fiche par ce challenge

1. **§6.1 affirme que l'alignement de vocabulaire serait « sans coût ». Faux** — migration SQLite,
   et perte des 6 `ResolutionType`. C'est la correction la plus utile de ce challenge, parce que
   c'était le repli présenté comme évident.
2. **§4 « ce qui apparaît : un handle `taskId` durable, avec `ttlMs` explicite » est faux** : les
   deux existent déjà (`thread.id` ; `timeout_seconds`, appliqué en `consultation.ts:448-463`).
3. **§4 « `pollIntervalMs` remplace la cadence de polling devinée par le client » est une
   régression, pas un gain** : `wait_for_message` est déjà un long-poll bloquant à 300 s, et le
   push mesure 5,1 ms.
4. **§2 et §5 sous-estiment ce qui est déjà fourni** : `capabilities.extensions` est présent et non
   déprécié dans les **deux** SDK. Ce qui manque est plus étroit que « tout » : `tasks/update` et
   le store.
5. **Piège d'interopérabilité non documenté, trouvé en séance** : `ClientTasksCapabilitySchema`
   attend `list?: object` / `cancel?: object`. Un client qui envoie `{ list: true }` reçoit un
   `-32603` de notre daemon. Vrai aujourd'hui, sans rapport avec l'extension.
6. **Une erreur commise pendant ce challenge, corrigée par la passe adversariale** : mon critère
   A05-R2 traitait le `@deprecated` du SDK v2 comme une prise de position contre l'extension.
   Erreur de catégorie — il vise le vocabulaire SEP-1686 du **cœur**, que l'extension remplace.
   Détail en §6.4 (8).

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : SDK implémente Tasks (SEP-1686, pas l'extension) ; issues fermées ; 3 lignes corrigées. |
| 2026-08-15 | Challenge. Mesuré : matrice officielle sans Tasks, Claude Code 2.1.233 sans `extensions`, `tasks/update` à 0 occurrence dans les deux SDK, `InitializeResult` réel du daemon sans `extensions`, latence du push actuel à **5,1 ms** de médiane, 6 `ResolutionType` sans équivalent. **Verdict : reporter** — endormie, pas enterrée (SEP-2663 mergé, spec figée depuis mai, défauts ouverts #9/#14). Passe adversariale : mon critère A05-R2 était une erreur de catégorie, retiré comme argument de direction ; le « lot de consolation sans coût » de §6.1 est faux. |
