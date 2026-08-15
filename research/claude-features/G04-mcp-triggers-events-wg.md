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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille — à valider ou remplacer en session.>

- [ ] Recompter l'activité réelle des deux repos WG au jour du challenge (`gh api repos/modelcontextprotocol/experimental-ext-triggers-events` → `pushed_at`, nombre de commits sur `main`, PR mergées ; idem `agents-wg`) et vérifier si le work item « SEP: Events in MCP v1 RFC » a quitté le statut *Ideating*.
- [ ] Mesurer le coût réel de l'abstraction : tracer dans le code tous les points d'émission d'un `CoordinatorEvent` (grep sur `sseEmitter.emit` et sur les publications MQTT) et compter combien de sites d'appel un registre unique devrait toucher.
- [ ] Vérifier la thèse « le SDK est une surface vierge » : confirmer par lecture que `sdk/src/client.ts` n'a aucun chemin d'événements, et estimer ce qu'ajouterait un consommateur d'événements côté SDK aujourd'hui (utile indépendamment du WG).
- [ ] Rejouer le trou stdio : lancer le serveur en transport stdio, appeler `wait_for_message`, constater le `isError` « MQTT broker not available », et décider si ce trou justifie à lui seul un transport d'événements unifié — indépendamment de toute spec future.
- [ ] Lire les 2 PR ouvertes du repo d'incubation (#1 design sketch Events, #2 Task Event Sources) et confronter leur modèle d'abonnement aux garanties déjà offertes par `docs/mqtt-topics.md` : où le projet est-il plus strict, où est-il plus faible ?

### 6.4 Résultat observé

<À remplir pendant le challenge.>

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
| 2026-08-14 | Vérification des faits : charte, repos WG et surface Tasks confirmés ; 3 corrections mineures ; fiche testable. |
