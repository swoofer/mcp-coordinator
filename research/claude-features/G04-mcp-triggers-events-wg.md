# G04 — MCP Triggers & Events WG : le pub/sub entre-t-il dans la spec ?

| Champ | Valeur |
|---|---|
| **ID** | `mcp-triggers-events-wg` |
| **Surface** | mcp-spec |
| **Statut** | experimental — incubation pré-SEP. Ni GA, ni beta, ni preview : **rien de normatif n'existe**. (Le label `research-preview` employé par un des chercheurs n'est pas un statut du projet MCP.) |
| **Disponible depuis** | Charte publiée `2026-03-24` ; repo `experimental-ext-triggers-events` créé `2026-04-09` |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | S — la seule action possible à date est de la veille active et une contribution de retour d'expérience. Un alignement réel sur une future primitive `Events` serait L, mais il n'y a rien sur quoi s'aligner. |
| **Confiance veille** | medium |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — tout se vérifie en local, aucun accès fermé requis |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — recadrage ; le broker reste, la question laissée ouverte par `A04` se ferme ici |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** ✅ saine

**Corrections apportées :**
- §1 : le README d'`agents-wg` annonce « **Pending charter backfill** », pas « Coming soon » (corrigé).
- §2 : les deux marqueurs `(a verifier)` sont tranchés — contenu des PR #1 et #2 confirmé par leur description et leurs fichiers ; les deux sont toujours **ouvertes et non mergées** au 2026-08-14.
- §5 : `handleSse` s'étend en réalité des lignes **326 à 408** de `src/serve-http.ts` (la fiche disait ~326-400).

**Faits confrontés et confirmés (aucune correction nécessaire) :**
- Charte du WG : mission, périmètre, hors-périmètre (`notifications/resources/updated`, `notifications/tools/list_changed`), leads Clare Liguori (AWS, `@clareliguori`) et Peter Alexander (Anthropic, `@pja-ant`), critères de succès « reference implementations in at least two Tier-1 SDKs », renvoi à SEP-1686, changelog `2026-03-24`.
- Work item « SEP: Events in MCP v1 RFC » toujours **Ideating**, cible « End April ».
- `experimental-ext-triggers-events` : créé `2026-04-09`, `pushed_at` `2026-06-15`, **1 commit** sur `main` (README, CONTRIBUTING, LICENSE, `.github/CODEOWNERS`), 2 PR ouvertes, 0 mergée. `updated_at` = `2026-08-14` confirme bien la lecture « métadonnée, pas activité de code ».
- `agents-wg` : créé `2026-02-24`, `pushed_at` `2026-07-20` ; issue #7 *Agents as MCP Clients* ouverte ; PR #18 et #20 ouvertes, titres exacts ; code d'erreur `-32005` (*Unsupported Extension Version*) présent dans le diff de PR #18.
- Surface Tasks (§2) : `io.modelcontextprotocol/tasks`, `_meta["io.modelcontextprotocol/clientCapabilities"].extensions`, `server/discover`, `tasks/get` · `tasks/update` · `tasks/cancel`, `notifications/tasks`, `CreateTaskResult { resultType: "task", taskId, ttlMs, pollIntervalMs }`, statuts `working | input_required | completed | failed | cancelled` — tous exacts.
- §5 : les 11 fichiers cités existent ; `MAX_LISTENER_QUEUE = 1000` (`src/mqtt-bridge.ts:22`), `MQTT_WS_MAX_PAYLOAD_BYTES` 1 MiB (`src/mqtt-broker.ts:14`), hooks `authorizeSubscribe`/`authorizePublish`, `MAX_WAIT_TIMEOUT_SECONDS = 300`, garde-fou « MQTT broker not available — stdio mode », `MAX_SSE_CLIENTS = 100`, `getRecentEvents`/`getEventsSince`, `SSE_RESUME_CAP = 1000`, fallback `?token=` documenté en commentaire, `EventType` 16 valeurs + `CoordinatorEvent` en `src/types.ts` l. 94-117, `notifications/claude/channel` en `cli/channel.ts:465`, `dashboard.js:647` seul consommateur de `/api/events`, `sdk/src/client.ts` : 0 occurrence de `events|SSE|EventSource|stream`.

**Signalé sans correction (section gelée) :** §6.5 parle de « réunions bimensuelles » ; la charte du Triggers & Events WG prévoit une **Working Session hebdomadaire de 30 min** (c'est l'Agents WG qui est biweekly). Le mainteneur tranchera en session.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ✅ testable
Les cinq items du protocole §6.3 sont exécutables ici : l'état des deux repos WG et le contenu des PR se lisent via `gh api` (déjà fait pour cette vérification), le comptage des points d'émission et la lecture de `sdk/src/client.ts` sont de simples greps locaux, et le trou stdio se rejoue en lançant le daemon en transport stdio avec Node 22 puis en appelant `wait_for_message`. Aucun credential Anthropic, header beta ou research preview n'est requis — le sujet est un WG public sans surface normative.

## 1. Ce que c'est

Le **Triggers & Events Working Group** du projet MCP, co-dirigé par Clare Liguori (AWS, `@clareliguori`) et Peter Alexander (Anthropic, `@pja-ant`), a pour mission exactement le problème que mcp-coordinator résout aujourd'hui avec un broker MQTT embarqué : définir comment un serveur MCP notifie proactivement un client d'un changement d'état. Le constat de la charte est que les clients apprennent aujourd'hui les mises à jour par polling, ou en maintenant une connexion SSE ouverte ; le WG veut spécifier un mécanisme de callback standardisé — webhooks ou équivalent — avec des garanties d'ordre valables sur **tous** les transports. Sont dans le périmètre : des SEP sur le mécanisme de trigger/callback, le cycle de vie d'abonnement, la sémantique de livraison et l'ordre des événements ; des implémentations de référence dans les SDK ; la coordination avec le Transports WG et avec l'Agents WG là où les notifications de fin de tâche croisent les triggers (SEP-1686 identifie les notifications de complétion de tâche par webhook comme relevant de ce WG). Est explicitement **hors périmètre** : l'infrastructure pub/sub généraliste au-delà de ce que le protocole exige.

L'état réel au 2026-08-14 tempère tout cela. Le repo d'incubation compte **1 seul commit sur `main`** (README, CONTRIBUTING, LICENSE, `.github` — aucun contenu de spec), dernier push `2026-06-15`, 2 PR ouvertes non mergées, aucun SEP soumis. Le work item « SEP: Events in MCP v1 RFC » est toujours au statut *Ideating* alors que la cible de la charte était « End April » : ~4 mois de retard. Le WG voisin (**Agents WG**, repo `modelcontextprotocol/agents-wg`, créé 2026-02-24, dernier push 2026-07-20) n'a même pas de charte finalisée — son README annonce « Pending charter backfill » — mais son issue #7 *Agents as MCP Clients* propose de modéliser une équipe d'agents comme un serveur MCP où chaque agent est un outil, les pairs se découvrant via les descriptions d'outils. C'est le second front de la même menace.

**Contradiction entre chercheurs, signalée explicitement.** Un chercheur conclut que « le pub/sub généraliste est hors périmètre, donc un broker embarqué avec garanties d'ordre est un candidat naturel d'implémentation de référence ». Le vérificateur retourne l'inférence : la charte met le pub/sub généraliste hors périmètre pour dire que le protocole ne standardisera **pas** d'infrastructure pub/sub — c'est un argument *contre* l'idée de faire d'aedes une implémentation de référence, d'autant que les critères de succès de la charte visent des « reference implementations in at least two Tier-1 SDKs », c'est-à-dire des composants SDK, pas un broker. La fiche retient la lecture du vérificateur, mais la question reste ouverte et vaut d'être posée au WG plutôt que tranchée ici. Deuxième désaccord : « repo expérimental actif / dernière activité 2026-08-14 » provient du champ `updated_at` de l'API GitHub (touché par une métadonnée de type star), pas d'une activité de code ; le WG est lent, voire dormant.

## 2. Surface d'API exacte

Aucune surface normative. `unknown` est la réponse exacte. Les seuls identifiants nommés proviennent de PR ouvertes non mergées :

```
# Repo d'incubation : modelcontextprotocol/experimental-ext-triggers-events
PR #1  "Add Events design sketch proposal"
       → primitive `Events` : modèle d'abonnement, modes de livraison poll / push / webhook
         (vérifié 2026-08-14 : ouverte, non mergée ; 1 fichier docs/design-sketch-proposal.md)
PR #2  "Draft: Task Event Sources"
       → champ optionnel `eventSource` sur `CreateTaskResult`, extension de Tasks
         (vérifié 2026-08-14 : ouverte, non mergée ; 1 fichier proposals/XXXX-task-event-sources.md)

# Cités par la charte comme EXISTANTS et explicitement HORS périmètre :
notifications/resources/updated
notifications/tools/list_changed
```

Le seul voisinage réellement livré est l'extension **Tasks** — qui n'est pas spécifique aux agents et dont la spec canonique vit dans `modelcontextprotocol/ext-tasks`, pas dans les WG (les fichiers `proposals/1686-tasks.md` et `proposals/2663-tasks-extension.md` d'`agents-wg` sont des copies portées, cf. PR #12/#14/#16) :

```
capability   io.modelcontextprotocol/tasks
  côté client : _meta["io.modelcontextprotocol/clientCapabilities"].extensions
  côté serveur : capabilities de `server/discover`
méthodes     tasks/get · tasks/update · tasks/cancel
notification notifications/tasks
résultat     CreateTaskResult { resultType: "task", taskId, ttlMs, pollIntervalMs }
statuts      working | input_required | completed | failed | cancelled
```

Divers : `agents-wg` PR #18 « SEP-XXXX: Extension Versioning » propose un code d'erreur `-32005` (*Unsupported Extension Version*) — versionnage semver des extensions et négociation, sans rapport avec les agents. PR #20 est une PR de recherche (« Research: Mapping Production Deep-Agent capabilities to MCP Agents »), pas une issue : elle cherche « where protocol gaps may exist for agent-oriented systems » et cite comme pistes « future agent definitions, delegation primitives, capability discovery, or orchestration-related extensions ».

## 3. Sources

- https://modelcontextprotocol.io/community/working-groups/triggers-events — charte du WG (source primaire)
- https://raw.githubusercontent.com/modelcontextprotocol/experimental-ext-triggers-events/main/README.md
- https://raw.githubusercontent.com/modelcontextprotocol/agents-wg/main/README.md
- https://github.com/modelcontextprotocol/agents-wg/issues/7 — *Agents as MCP Clients*
- https://modelcontextprotocol.io/extensions/tasks/overview
- https://modelcontextprotocol.io/docs/extensions/overview — décrit le processus générique des repos `experimental-ext-` ; **ne mentionne jamais** triggers-events (source citée à tort comme primaire par un chercheur)

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.** Le WG travaille exactement sur les deux garanties que le projet a codées à la main : le cycle de vie d'abonnement et l'ordre de livraison. Si une primitive `Events` sort avec ces garanties sur tous les transports, ce qui peut disparaître est identifiable ligne à ligne : la file d'attente par agent de `MqttBridge` (`MAX_LISTENER_QUEUE = 1000`, drop du plus ancien), les 3 outils `wait_for_message` / `get_queued_messages` / `mqtt_publish` qui existent uniquement parce que le protocole n'a pas de push (`src/tools/mqtt-tools.ts`), et la mécanique de reprise maison de `handleSse` (`Last-Event-ID`, `SSE_RESUME_CAP = 1000`, `?token=` en fallback parce qu'`EventSource` n'envoie pas d'`Authorization`). Le bénéficiaire direct est l'auto-hébergeur : plus de broker aedes à exposer en TCP + WebSocket, plus de `docs/mqtt-topics.md` à tenir à jour, un seul canal MCP. Bénéfice secondaire : le trou fonctionnel actuel — en transport stdio aucun broker n'est démarré, donc les 3 outils MQTT retournent `isError` avec un message d'excuse — disparaîtrait, puisque le WG vise des garanties d'ordre valables **y compris** sur stdio.

**Risque si on ne fait rien.** Deux risques, d'échéances très différentes. À court terme, aucun : le WG n'a produit aucune spec en 4 mois et ses jalons sont dépassés. À moyen terme, mcp-coordinator se retrouve avec un transport propriétaire (topics MQTT documentés maison + SSE maison + `notifications/claude/channel` pour Claude Code) face à un mécanisme standard que tous les clients MCP parleront nativement — le projet devient le composant qu'il faut apprendre en plus. Le second front est l'Agents WG : si des « delegation primitives » et de la « capability discovery » entrent dans la spec, `agent-registry`, `consultation` et la découverte de pairs deviennent des primitives de plateforme. Ni l'un ni l'autre WG ne traite la détection de conflits sur fichiers ni l'impact-scoring — c'est une absence constatée dans les documents ouverts, pas une garantie, mais c'est l'axe sur lequel le projet garde de la valeur propre. Ne pas suivre ces WG, c'est apprendre la nouvelle spec le jour où elle est votée, sans avoir pesé sur ses garanties d'ordre — alors que le projet a précisément l'expérience terrain qui manque au groupe.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/mqtt-broker.ts` | Broker aedes embarqué (TCP + WebSocket, `MQTT_WS_MAX_PAYLOAD_BYTES` 1 MiB, hooks `authenticate` / `authorizeSubscribe` / `authorizePublish`). C'est l'actif directement concurrencé par une primitive `Events` standardisée — et, selon la lecture du vérificateur, ce que la charte exclut de son périmètre. |
| `src/mqtt-bridge.ts` | Client MQTT unique multi-org, files d'attente par `(org, agent_id)`, `MAX_LISTENER_QUEUE = 1000`. Implémente à la main le cycle de vie d'abonnement et la sémantique de livraison que le WG veut spécifier. |
| `src/tools/mqtt-tools.ts` | Les 3 outils `wait_for_message` (`MAX_WAIT_TIMEOUT_SECONDS = 300`), `get_queued_messages`, `mqtt_publish`. Contournement explicite de l'absence de push dans MCP ; premiers candidats à la suppression. Contient déjà le garde-fou « pas de broker en stdio ». |
| `src/sse-emitter.ts` | Fan-out en mémoire, `MAX_SSE_CLIENTS = 100`, `getRecentEvents` / `getEventsSince`. Le mécanisme de replay maison. |
| `src/serve-http.ts` (`handleSse`, l. 326-408) | `GET /api/events`, `text/event-stream`, reprise par `Last-Event-ID` plafonnée à `SSE_RESUME_CAP = 1000`, heartbeat `:keep-alive`, auth par `?token=`. À remplacer si un transport d'événements standard arrive. |
| `src/types.ts` (l. 94-117) | `EventType` — 16 valeurs (`agent_online` … `quota_update`) et `CoordinatorEvent { id, type, payload, created_at }`. C'est le vocabulaire d'événements du projet ; c'est lui qu'il faudrait mapper sur une primitive `Events` future. |
| `cli/channel.ts` | Traduit chaque événement de coordination en `notifications/claude/channel` (l. 465). Troisième chemin de push, spécifique à Claude Code — la fragmentation que le WG veut supprimer. |
| `dashboard/public/dashboard.js` | Seul consommateur de `/api/events` dans le repo. Toute bascule de transport casse le dashboard en premier. |
| `sdk/src/client.ts` | **Aucune** consommation d'événements (grep `events|SSE|EventSource|stream` : 0 occurrence). Le SDK client TypeScript est aujourd'hui purement requête/réponse — un standard d'événements arriverait sur une surface vierge, ce qui rend la migration moins coûteuse qu'il n'y paraît. |
| `docs/mqtt-topics.md` | Référence canonique des topics, triggers, schémas de payload, QoS et flags retained. C'est la spec maison que le WG rendrait redondante — et le document à porter en retour d'expérience si le projet contribue. |
| `docs/ARCHITECTURE.md` | À amender dès qu'une décision est prise sur la stratégie de transport d'événements. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Faut-il regrouper dès maintenant les trois chemins de push (SSE `/api/events`, topics MQTT, `notifications/claude/channel`) derrière un registre d'événements unique adossé aux 16 valeurs d'`EventType`, pour pouvoir brancher une future primitive `Events` sans toucher au métier — ou est-ce une abstraction spéculative pour un WG à 1 commit dont le SEP est encore *Ideating*, auquel cas la seule action justifiée est d'aller porter `docs/mqtt-topics.md` au WG comme retour d'expérience sur l'ordre de livraison ?

### 6.2 Hypothèse

**Terrain vérifié avant de commencer.** [`A04`](A04-subscriptions-listen.md), tranchée le 2026-08-15 **sur `main`**, porte sur le push standardisé face à `sse-emitter` et `mqtt-bridge` — la même famille. Son verdict est `reporter` sur `subscriptions/listen` seul, et son §7.2 range explicitement **le sort du broker MQTT** dans la colonne *« à trancher séparément »*, sans rapport avec la révision du protocole. G04 hérite donc d'une question ouverte, pas d'une question déjà close — et son §6.1 (unifier les trois chemins de push) en est le prolongement légitime.

**Ce que je pense avant de mesurer.** Que le §6.1 est bien posé mais que ses deux termes ne s'excluent pas, et surtout que sa branche « registre unique » ne dépend en rien du WG. Si le regroupement se justifie, c'est par un défaut mesurable d'aujourd'hui — le trou stdio, où les trois outils MQTT renvoient une excuse — et non par une primitive imaginaire. Inversement, s'il ne se justifie que par le WG, il ne se justifie pas : `A04` a déjà montré qu'on ne construit pas contre une révision dont on est bloqué aux deux bouts.

Je m'attends aussi à ce que le §4 surestime ce qui disparaîtrait. Il énumère « ce qui peut disparaître » ligne à ligne — files d'attente, trois outils, reprise SSE — mais une primitive `Events` MCP ne serait consommable que par un client MCP à jour, alors que le broker sert aussi `mosquitto_sub` et la supervision maison. Le §6.5 le dit en dernière ligne ; le §4 l'ignore.

Fiche **menace** : verdict sur la **réponse** — *contre-mesure technique*, *recadrage*, ou *acceptation assumée*. Testabilité ✅ : les cinq items du §6.3 sont exécutables, donc **aucune excuse pour conclure sur du raisonnement**.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **Le WG est dormant.** | toujours **1 commit** sur `main`, **0 PR mergée**, SEP toujours *Ideating* au 2026-08-17 |
| **K2** | **Le registre unique est cher.** Mesurer, pas supposer. | si l'unification touche **> 20 sites d'appel**, l'abstraction est un chantier, pas un refactor |
| **K3** | **Le trou stdio justifie-t-il à lui seul l'unification ?** | il doit être **reproduit** ; s'il ne se reproduit pas, la moitié du bénéfice du §4 tombe |
| **K4** | **Le SDK est une surface vierge.** | **0** occurrence de `events\|SSE\|EventSource\|stream` dans `sdk/src/client.ts` |
| **K5** | **La lecture « place laissée libre » est fausse.** | la charte met le pub/sub généraliste hors périmètre **et** vise des implémentations de référence dans deux SDK Tier-1 ⇒ positionner aedes est du travail perdu |
| **K6** | **Une primitive `Events` MCP serait une régression de portabilité.** | le broker sert aujourd'hui des clients non-MCP ; une primitive MCP ne le ferait pas |
| **K7** | **Ce qui reste défendable est-il non vide ?** | ni ce WG ni l'Agents WG ne traitent la détection de conflit ni l'impact-scoring |

**Ce que je m'interdis**, et la liste s'allonge à chaque passe : vérifier la **nature** d'un objet GitHub avant de conclure à une absence — `gh api issues/N` sur une PR rend la description, pas le contenu, et cette erreur m'a fait accuser la veille de fabrication en `G03` ; ne pas publier un chiffre que je n'ai pas produit (`G01`) ; ne pas déclarer « inmesurable » ce qui est seulement « non exécutable » (`G02`) ; et préciser si une fiche citée vit sur `main` ou sur une branche non fusionnée.

### 6.3 Protocole de vérification

<Proposition de la veille — à valider ou remplacer en session.>

- [ ] Recompter l'activité réelle des deux repos WG au jour du challenge (`gh api repos/modelcontextprotocol/experimental-ext-triggers-events` → `pushed_at`, nombre de commits sur `main`, PR mergées ; idem `agents-wg`) et vérifier si le work item « SEP: Events in MCP v1 RFC » a quitté le statut *Ideating*.
- [ ] Mesurer le coût réel de l'abstraction : tracer dans le code tous les points d'émission d'un `CoordinatorEvent` (grep sur `sseEmitter.emit` et sur les publications MQTT) et compter combien de sites d'appel un registre unique devrait toucher.
- [ ] Vérifier la thèse « le SDK est une surface vierge » : confirmer par lecture que `sdk/src/client.ts` n'a aucun chemin d'événements, et estimer ce qu'ajouterait un consommateur d'événements côté SDK aujourd'hui (utile indépendamment du WG).
- [ ] Rejouer le trou stdio : lancer le serveur en transport stdio, appeler `wait_for_message`, constater le `isError` « MQTT broker not available », et décider si ce trou justifie à lui seul un transport d'événements unifié — indépendamment de toute spec future.
- [ ] Lire les 2 PR ouvertes du repo d'incubation (#1 design sketch Events, #2 Task Event Sources) et confronter leur modèle d'abonnement aux garanties déjà offertes par `docs/mqtt-topics.md` : où le projet est-il plus strict, où est-il plus faible ?

### 6.4 Résultat observé

Les cinq items du §6.3 sont exécutables et **quatre ont été exécutés**. Le cinquième — lire les deux PR ouvertes et confronter leur modèle d'abonnement à `docs/mqtt-topics.md` — est traité en fin de section, avec sa limite.

#### K1 — le WG est dormant, mais la fiche se trompe de front (se déclenche, et retourne le cadrage)

```
experimental-ext-triggers-events   (le sujet de la fiche)
  cree 2026-04-09 · pushed 2026-06-15 · 17 etoiles · 4 forks
  commits sur main : 1
  PR : 2 ouvertes / 0 mergees sur 2

agents-wg                          (le « second front » du §1)
  cree 2026-02-24 · pushed 2026-07-20 · 9 etoiles · 8 forks
  commits sur main : 21
  PR : 3 ouvertes / 15 mergees sur 20
```

**K1 se déclenche** sur le sujet principal : toujours **1 commit**, **0 PR mergée**, dernier push il y a plus de deux mois. Rien n'a bougé depuis la vérification du §0.

Mais la mesure fait apparaître une asymétrie que la fiche ne capture pas : **le WG dont elle porte le nom est mort, et celui qu'elle traite en note de bas de page est vivant** — 21 commits, 15 PR mergées, deux fois plus de forks. Le §1 décrit `agents-wg` comme n'ayant « même pas de charte finalisée » ; c'est vrai de sa charte et faux de son activité.

#### K2 — le registre unique est un chantier, pas un refactor (se déclenche)

```
sites d'emission sseEmitter.emit : 24
  src/http/rest-handlers.ts        10
  src/tools/consultation-tools.ts   5
  src/announce-workflow.ts          4
  src/server-setup.ts               2
  src/register-workflow.ts          1
  src/serve-http.ts                 1
  src/tools/agents-tools.ts         1

publications MQTT                : 11
```

**35 sites au total**, contre un seuil pré-enregistré de 20. **K2 se déclenche.**

Et le détail dit quelque chose de plus intéressant que le total : **les deux chemins ne sont pas co-localisés.**

```
src/announce-workflow.ts        sse:4   mqtt:0
src/http/rest-handlers.ts       sse:10  mqtt:2
src/tools/consultation-tools.ts sse:5   mqtt:3
```

Les trois chemins de push ne sont donc pas trois vues d'un même flux d'événements : ils sont émis **indépendamment, à des endroits différents**. C'est ce qui explique leur dérive, et c'est ce qui rend l'unification chère — il ne s'agit pas de rerouter un flux existant mais de réconcilier deux inventaires qui ne se recouvrent pas.

#### K3 — le trou stdio est réel, reproduit, et plus large que ce que la fiche décrit (se déclenche)

Serveur lancé en transport stdio, appels réels :

```
initialize : OK
wait_for_message    : isError=true -> "MQTT broker not available — stdio mode runs without
                      MQTT. Use the HTTP transport for push messaging (mqtt_publish /
                      wait_for_message / get_queued_messages)."
get_queued_messages : isError=true -> meme message

stderr : "mcp-coordinator running on stdio (no MQTT broker in stdio mode)"
```

Le trou existe, et le message d'erreur est **honnête** : il nomme la cause et le contournement. Ce n'est pas un garde-fou fantôme.

Mais la même sonde montre le vrai défaut, que ni le §4 ni le §6.3 ne relèvent :

```
outils annonces en stdio  : 26
dont outils MQTT annonces : 3  -> wait_for_message, get_queued_messages, mqtt_publish
payload tools/list        : 16 074 caracteres
```

**Le serveur sait qu'il est en stdio — il le journalise — et publie quand même les trois outils qui ne peuvent qu'échouer.** Trois outils sur 26, soit 11,5 % de la surface annoncée, sont garantis en erreur dans ce transport. Un client les découvre, le modèle peut les appeler, et il reçoit une excuse.

*(Le payload de 16 074 caractères recoupe les 16 064 qu'`E08` a mesurés — fiche tranchée le 2026-08-17 **sur une branche non fusionnée**. L'écart de 10 caractères est de la dérive de dépendance.)*

**K3 se déclenche**, mais pas dans le sens que le §6.3 envisageait. Il demandait si ce trou « justifie à lui seul un transport d'événements unifié ». Non : réconcilier 35 sites d'émission pour réparer 3 outils dans un transport est disproportionné. Ce que le trou justifie est bien plus petit et entièrement local.

#### K4 — le SDK est une surface vierge (se déclenche)

```
sdk/src/client.ts : 329 lignes
occurrences de events|SSE|EventSource|stream : 0
```

**K4 se déclenche.** Le §5 avait raison, et l'implication qu'il en tire tient : un standard d'événements arriverait sur une surface vierge, donc sans dette de migration côté SDK.

#### K5 — la lecture du vérificateur tient (se déclenche)

La charte met le pub/sub généraliste hors périmètre **et** fixe comme critère de succès des « reference implementations in at least two Tier-1 SDKs ». Ce sont des composants de SDK, pas un broker. **K5 se déclenche** : positionner aedes en implémentation de référence serait du travail perdu, et la fiche a eu raison de retenir la lecture du vérificateur contre celle du premier chercheur.

#### K6 — la régression de portabilité (se déclenche)

Le broker embarqué est consommable par `mosquitto_sub`, un script Python, n'importe quel client MQTT — sans SDK MCP. Une primitive `Events` MCP ne le serait que depuis un client MCP à jour. **K6 se déclenche**, et il contredit le §4 : celui-ci énumère « ce qui peut disparaître » (files d'attente, trois outils, reprise SSE) sans jamais dire ce que la disparition coûterait à l'auto-hébergeur qui branche de la supervision existante. Le §6.5 le dit en dernière ligne ; le §4 l'ignore.

#### K7 — ce qui reste défendable (ne se déclenche pas)

Ni la charte du Triggers & Events WG ni les travaux de l'Agents WG ne traitent la détection de conflit sur fichiers ni le scoring d'impact. **K7 ne se déclenche pas.** Réserve d'honnêteté, déjà posée par le §4 : c'est une absence constatée dans des documents ouverts, pas une garantie.

#### Ce que la passe adversariale a démoli — quatre rétractations

**1. Ma « vraie trouvaille » sur les outils annoncés en stdio n'en est pas une : c'est une décision d'audit instruite, et j'allais l'annuler en la présentant comme un oubli.**

```
audit/09-protocole-mcp.md:118   [protocole-mcp-06] Mode stdio : les outils MQTT sont exposes
                                mais mentent silencieusement
audit/TRACKING.md:66            5 rounds, tous ✅, clos par 23c5098
23c5098                         fix(mcp): return isError from MQTT tools when bridge is not
                                connected (stdio) (protocole-mcp-06)
```

Et le comportement est documenté **par nom d'outil**, `docs/clients.md` :

> *« **No MQTT.** The embedded broker is not started, so `wait_for_message`, `get_queued_messages` and `mqtt_publish` are unavailable. »*

Garder les 26 outils annoncés et renvoyer `isError` **est** le remède retenu, après cinq rounds de revue. Ma liste d'interdits pré-enregistrée disait pourtant, mot pour mot : *« grepper les docs avant de crier à la découverte »*. Troisième récidive sur le même axe, et cette fois la piste était plus large qu'un README : un identifiant d'audit, une ligne de tracking, un commit et une page de doc.

**2. `cli/channel.ts` n'est pas un troisième chemin de push — c'est un abonné MQTT.**

```
cli/channel.ts : mqtt.connect / client.subscribe -> 2 occurrences
occurrences de server.notification( dans src/  -> 0
```

Le daemon n'émet **jamais** de notification MCP. Tout le trafic `notifications/claude/channel` naît d'un message MQTT traduit en aval. Il y a donc **deux émetteurs** (SSE, MQTT) et **un traducteur**, pas trois chemins. **La prémisse du §6.1 est structurellement fausse** : on ne « regroupe » pas un abonné avec deux émetteurs. Et le §5, qui appelle ce fichier « la fragmentation que le WG veut supprimer », décrit exactement l'inverse — c'est déjà une unification en aval.

**3. Mes comptes d'émission étaient faux dans les deux sens.** Sur les 24 `sseEmitter.emit`, deux sont des **annotations de type** (`Parameters<typeof sseEmitter.emit>`), dont une comptée en double à l'intérieur d'un emit déjà compté : **22** sites réels. Côté MQTT, mon motif ramassait un commentaire et trois **définitions** de méthode, et manquait trois appels réels (`registerAgent`, `clearRetainedConsultation`, `mqttPublish`) : **10**. Total **32**, pas 35. **K2 se déclenche quand même** — le seuil était 20 — mais aucun de mes chiffres publiés n'était bon.

**4. K4 ne pouvait pas échouer.** `sdk/src/client.ts` est bien vierge d'événements, mais `sdk/package.json` le décrit comme *« TypeScript SDK for mcp-coordinator Phase 2 OAuth API (minimal) »* et sa classe n'expose que des méthodes OAuth — **aucune** méthode de coordination. Un composant hors du chemin de migration ne renseigne rien sur le coût de migration. Le chiffre tient, l'implication que j'en tirais est vide.

#### Le fait qui renforce K1 bien plus que mon comptage de commits

L'Agents WG **a** une charte finalisée depuis le **2026-08-04** — leads **Luca Chang** (AWS) et **Caitie McCaffrey** (Microsoft), trois work items `In Progress`, session hebdomadaire de 30 min. Le §1 de la fiche écrit qu'il « n'a même pas de charte finalisée » : il lisait le README GitHub, périmé. Ma propre conclusion (« le second front est le vivant ») s'appuyait sur la même erreur, en sens inverse.

Et cette charte contient le fait décisif, verbatim, en **Out of Scope** :

> *« General event delivery and callback mechanisms, which are owned by the Triggers and Events WG. »*

et en **Related Groups** :

> *« **Triggers and Events WG** — Proactive task-status and completion notifications are event-delivery concerns owned by that group. »*

**Le WG vivant refuse formellement le territoire des événements et le renvoie au WG dormant.** Ce n'est donc pas « la fiche s'est trompée de front » : il n'y a pas de second front sur les événements, par charte. C'est un K1 beaucoup plus solide que 1 commit contre 21, et il pointe dans le même sens.

#### Le cinquième item, et sa limite

Les deux PR ouvertes du repo d'incubation portent bien, l'une un croquis de design de la primitive `Events`, l'autre un champ `eventSource` sur `CreateTaskResult`. Je n'en tire **aucune comparaison** avec `docs/mqtt-topics.md` : confronter nos garanties d'ordre à un croquis non mergé dans un repo à un commit reviendrait à mesurer contre une spec imaginaire, ce que le §6.5 reproche à juste titre. La leçon de `G03` s'applique aussi — un document non ratifié peut être restructuré entre deux passes.

### 6.5 Contre-arguments

- **Il n'y a rien à adopter.** Aucune surface normative n'existe : 1 commit sans contenu de spec, dernier push il y a deux mois, 2 PR non mergées, 0 SEP soumis, jalons de charte dépassés de ~4 mois. Toute décision d'architecture prise maintenant l'est contre une spec imaginaire.
- **L'inférence « place laissée libre » est probablement fausse.** Le hors-périmètre « pub/sub généraliste » signifie que le protocole ne standardisera pas d'infrastructure pub/sub, pas qu'il attend un broker communautaire. Les critères de succès de la charte visent des implémentations de référence dans deux SDK Tier-1 — pas un broker. Positionner aedes comme candidat serait probablement du travail perdu.
- **YAGNI sur le registre d'événements unique.** Les trois chemins de push existent parce qu'ils servent trois publics différents (dashboard, agents, session Claude Code). Les unifier maintenant, c'est ajouter une indirection pour un besoin qui n'est pas encore formulé.
- **Coût récurrent pour un mainteneur solo.** Participer sérieusement à un WG (réunions bimensuelles, revues de SEP, contributions) est une charge continue, sans garantie que le WG aboutisse ni que le retour d'expérience soit retenu.
- **Risque de re-travail.** S'aligner tôt sur une PR de design sketch non mergée, c'est s'exposer à un pivot complet du modèle (poll / push / webhook ne survivront pas tous) et à devoir maintenir en parallèle l'ancien transport pour les clients existants.
- **Portabilité.** Le MQTT embarqué fonctionne avec `mosquitto_sub`, un script Python ou n'importe quel client MQTT, sans dépendre d'un SDK MCP. Une primitive `Events` MCP, elle, n'est utilisable que depuis un client MCP à jour — pour l'auto-hébergeur qui branche de la supervision existante, ce serait une régression.
- **La menace Agents WG est encore plus lointaine.** Ce WG n'a pas même de charte finalisée ; parler de « delegation primitives » qui remplaceraient `agent-registry` relève de la prospective, pas de la planification.

---

## 7. Décision

Fiche menace : le verdict porte sur la **réponse** (`_CHALLENGE-PROMPT.md:126-127`).

| | |
|---|---|
| **Verdict** | **Réponse : recadrage — et fermeture d'une question qu'`A04` avait laissée ouverte.** ⬜ contre-mesure technique · ✅ **recadrage** · ⬜ acceptation assumée |
| **Date** | 2026-08-17 |
| **Justification** | Le WG qui **possède** les événements est dormant (1 commit, 0 PR mergée, SEP toujours *Ideating*, champion `TBD`), et le WG vivant lui a **formellement rendu le territoire par charte**. Il n'y a donc rien à quoi s'aligner, et le §6.1 pose sa question sur une prémisse fausse : il n'y a pas trois chemins de push mais deux émetteurs et un traducteur. Le livrable est un recadrage, plus une décision explicite sur le broker. |
| **Issue / PR** | une issue documentaire bornée, voir §7.3 |
| **Jalon visé** | aucun ; conditions de réveil en §7.4 |

### 7.1 Le broker MQTT reste — et cette question se ferme ici

[`A04`](A04-subscriptions-listen.md) §7.2, tranchée sur `main`, rangeait *« le sort du broker MQTT »* dans la colonne **« à trancher séparément »**. G04 le tranche, et dans le sens du maintien. Trois raisons mesurées, aucune spéculative :

1. **Le broker a des consommateurs non-MCP livrés.** Le dépôt embarque six exemples (`python-mqtt`, `go-mqtt`, `node-mqtt`, `slack-webhook`, `discord-webhook`, `github-actions-mqtt-bridge`). Ce n'est pas une hypothèse d'auto-hébergeur, c'est de la surface produit. Une primitive `Events` MCP ne serait consommable que depuis un client MCP à jour : **K6 se déclenche**, et c'est une régression, pas une migration.
2. **Notre propre intégration Claude Code est un client MQTT.** `cli/channel.ts` s'abonne au broker et traduit ; supprimer le broker le tue.
3. **Personne ne vient prendre la place.** Le WG propriétaire est dormant avec un champion `TBD`, et le WG actif a écrit noir sur blanc que les événements ne sont pas à lui.

### 7.2 Le recadrage — six corrections, dont deux structurelles

1. **§6.1 : la prémisse est fausse.** Il n'y a pas trois chemins de push. `src/` n'émet **aucune** notification MCP (0 occurrence de `server.notification(`) ; `cli/channel.ts` est un **abonné MQTT** qui traduit en aval. Deux émetteurs, un traducteur.
2. **§5 : `cli/channel.ts` n'est pas « la fragmentation que le WG veut supprimer »** — c'est déjà une unification en aval, exactement le motif que le WG cherche.
3. **§1 : l'Agents WG a une charte finalisée** depuis le 2026-08-04 (leads Luca Chang / Caitie McCaffrey, trois work items `In Progress`). Le « Pending charter backfill » est un README périmé.
4. **§1 et §4 : le « second front » n'existe pas sur les événements.** La charte Agents les met explicitement hors périmètre et les rend au Triggers & Events WG. Ce qui a durci chez eux est l'axe *Tasks / délégation / capability discovery* — pas le push.
5. **§4 énumère ce qui disparaîtrait sans dire ce que ça coûterait.** Files d'attente, trois outils, reprise SSE : oui. Mais le §4 ne mentionne jamais les six consommateurs non-MCP que la disparition casserait. Le §6.5 le dit en dernière ligne ; le §4 doit le porter.
6. **§0 et §6.5 : la cadence.** Les deux WG tiennent une **Working Session hebdomadaire de 30 min**. Le §6.5 dit « bimensuelles » et le §0 attribue le biweekly à l'Agents WG : les deux chartes disent *Weekly*.

### 7.3 La seule correction de code retenue, et pourquoi pas celle que j'avais choisie

**Écarté : ne plus enregistrer les trois outils MQTT en stdio.** C'était mon livrable en formation, et c'est un revirement déguisé en correction. La décision inverse a été prise après cinq rounds de revue sous l'identifiant **`protocole-mcp-06`**, close par `23c5098`, et documentée par nom d'outil dans `docs/clients.md`. S'y ajoutent trois coûts que je n'avais pas vus : `createMcpServer()` ne reçoit **aucune information de transport** (la plomberie n'existe pas), plusieurs documents affirment « 26 tools » y compris en stdio, et surtout — contradiction interne à mon propre §6.4 — je louais le message d'erreur pour sa pédagogie tout en proposant de faire en sorte que personne ne le lise jamais.

**Retenu à la place, et c'est trois chaînes :** porter le caveat dans les **descriptions** des trois outils (`src/tools/mqtt-tools.ts`), par exemple « (HTTP transport only — unavailable in stdio) ». Le modèle est prévenu **avant** l'appel perdu au lieu d'après ; les 26 outils restent ; tous les documents restent vrais ; aucune décision d'audit n'est annulée ; aucune plomberie de transport n'est requise.

### 7.4 Conditions de réveil — observables

| Signal | Ce qu'il changerait |
|---|---|
| Le work item « SEP: Events in MCP v1 RFC » quitte *Ideating*, ou gagne un champion | il existe enfin quelque chose à lire |
| Une PR mergée sur `experimental-ext-triggers-events` | le repo cesse d'être à un commit |
| La charte Agents retire les événements de son Out of Scope | le territoire se rouvre, et le front change vraiment |

### 7.5 Ce qui n'est pas tranché ici, et que je ne masque pas

**Contribuer un retour d'expérience au WG.** `K1` justifie de ne pas *s'aligner* ; il ne justifie pas le silence sur *contribuer*. Porter `docs/mqtt-topics.md` — nos garanties d'ordre, nos QoS, nos flags retained — à un WG dont le champion du SEP est `TBD` est l'action la moins chère et la plus réversible du lot, et c'est précisément le moment où un rapport de terrain isolé a le plus de prise. Je ne la tranche pas parce qu'elle engage le temps du mainteneur et non le code, mais je refuse de la faire disparaître derrière `K1`.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : charte, repos WG et surface Tasks confirmés ; 3 corrections mineures ; fiche testable. |
| 2026-08-17 | Challenge. **Réponse : recadrage**, plus la fermeture d'une question qu'`A04` avait laissée ouverte : **le broker MQTT reste** (six exemples non-MCP livrés, `cli/channel.ts` est lui-même un client MQTT, et personne ne vient prendre la place). Mesuré : le WG propriétaire est dormant (**1** commit, **0** PR mergée, SEP toujours *Ideating*, champion `TBD`) ; l'unification coûterait **32** sites d'émission ; le trou stdio est reproduit (`wait_for_message`, `get_queued_messages` et `mqtt_publish` renvoient `isError`, et les 26 outils restent annoncés). **Quatre rétractations après la passe adversariale** : ma « trouvaille » sur les outils annoncés en stdio est la décision d'audit `protocole-mcp-06`, instruite sur 5 rounds, close par `23c5098` et documentée dans `docs/clients.md` — j'allais l'annuler en la présentant comme un oubli, troisième récidive du « grepper les docs avant de crier à la découverte » ; `cli/channel.ts` est un **abonné** MQTT et non un troisième chemin de push, ce qui rend **la prémisse du §6.1 fausse** ; mes comptes d'émission étaient faux (32, pas 35) ; et K4 ne pouvait pas échouer, le SDK étant un client OAuth hors du chemin de migration. **Fait décisif trouvé en fin de passe :** l'Agents WG a une charte du **2026-08-04** qui met *« General event delivery and callback mechanisms »* **hors périmètre** et les rend au Triggers & Events WG — le §1 le décrivait comme sans charte, en lisant un README périmé. |
