# E08 — Push et outils conditionnels côté Messages API (system messages, tool_addition)

| Champ | Valeur |
|---|---|
| **ID** | `mid-conversation-system-and-tools` |
| **Surface** | claude-api |
| **Statut** | mixte — mid-conversation system messages : **GA** ; tool_addition / tool_removal : **beta** |
| **Disponible depuis** | system messages : 2026-05-28 (Opus 4.8), élargi 2026-07-15 (Fable 5 / Mythos 5 / Opus 4.8) · tool changes : 2026-07-24 (Opus 5) |
| **Tier** | T2-fort-levier |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — PoC Messages API exige clé API + header beta |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — reporter ; la capacite GA equivalente appartient a A02 ; livrable #355 |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — le marqueur `(à vérifier)` sur `defer_loading` vs cache est tranché : la doc précise que l'inventaire complet est déclaré d'emblée dans `tools` et que « the `tools` array itself never changes, so the cached prefix stays intact ». Un outil `defer_loading: true` reste donc bien présent dans le préfixe haché ; il est seulement *non offert* au modèle. Ce que la doc ne dit pas : s'il est facturé en tokens d'entrée — `(non vérifiable — non documenté)`.
- §2 — la « contradiction entre chercheurs » est levée : l'annonce du 24 juillet 2026 figure bien dans les release notes API (`### July 24, 2026`), avec le header `mid-conversation-tool-changes-2026-07-01` et la liste Fable 5 / Mythos 5 / Opus 4.8 / Opus 5. Aucun écart d'API.
- §2 — précision ajoutée : la ligne « PAS Sonnet 5 » ne vaut que pour la beta `tool changes`. Les **messages système mid-conversation sont disponibles sur Sonnet 5** (doc actuelle). Cela affecte la portée du contre-argument de §6.5, sans le contredire.
- §5 — `CoordinatorEvent` est **déclaré dans `src/types.ts`**, pas dans `src/sse-emitter.ts` (qui l'importe et l'émet). Ligne corrigée.

Faits vérifiés sans correction nécessaire : header beta, noms de blocs `tool_addition` / `tool_removal`, les trois types de référence (`tool_reference`, `mcp_tool_reference` avec `server_name`+`name`, `mcp_toolset_reference` avec `server_name`), `defer_loading`, absence de header pour les messages système, règles de placement et 400, avertissement sécurité, dates 2026-05-28 / 2026-07-15 / 2026-07-24, statut mixte GA + beta. Côté repo : les 26 outils (11/4/3/3/3/2 dans l'ordre cité), les 6 `register*Tools` de `src/server-setup.ts` (l. 242-247), les routes de `src/serve-http.ts` (`/api/auth/*`, `/api/events`, `/mcp`, `/health`, `/healthz`, `/health/ready` — aucun endpoint d'inventaire d'outils), `notifications/claude/channel` à `cli/channel.ts:465`, et l'existence de `sdk/src/client.ts` et `docs/ARCHITECTURE.md`.

**Marqueurs `(à vérifier)` restants :** un seul, requalifié en `(non vérifiable — non documenté)` : la facturation en tokens d'un outil `defer_loading: true`. Mesurable par PoC, pas par la doc.

**Testabilité :** ⚠️ partielle
Ce qui est exécutable ici : dumper `tools/list` sur le daemon local via `/mcp` et mesurer le poids du bloc des 26 outils, ce qui suffit à trancher l'argument YAGNI de §6.5 sur `defer_loading`. Ce qui ne l'est pas sans accès supplémentaire : tout le reste du protocole §6.3 (cache miss, `tool_addition`, 400 de placement, `mcp_toolset_reference`) passe par la boucle Messages API et exige une clé API Anthropic autorisée pour le header `mid-conversation-tool-changes-2026-07-01` sur un modèle non-Sonnet — Claude Code ne donne pas accès à cette boucle.

## 1. Ce que c'est

Deux mécanismes complémentaires de la Messages API qui permettent de modifier le contexte opérateur **en cours de conversation** sans invalider le prompt cache.

Le premier : on peut insérer une entrée `{"role": "system"}` au milieu du tableau `messages[]`, au lieu d'éditer le champ `system` de haut niveau. Comme le champ `system` est en tête du préfixe haché, le modifier provoque un cache miss total ; un message système inséré en fin de tableau laisse le préfixe byte-identique. L'instruction conserve l'autorité opérateur (elle prime sur les messages `user`). Les règles de placement sont strictes : jamais en position 0 ; le message doit suivre immédiatement un tour `user` (y compris un tour `user` ne portant que des `tool_result`) ou un tour assistant se terminant par un résultat d'outil serveur ; il doit précéder un tour assistant ou clore le tableau ; il ne peut jamais s'intercaler entre un `tool_use` et son `tool_result` (sinon 400). La documentation cite explicitement comme cas d'usage « des fichiers ont changé sur le disque », « les outils disponibles ont changé » et « l'utilisateur a envoyé un message pendant que tu travaillais ».

Le second, sous header beta, réutilise ce véhicule : des blocs `tool_addition` / `tool_removal` placés dans le `content` d'un message `role: "system"` font apparaître ou disparaître des outils entre deux tours, sans toucher au tableau `tools` (qui est le tout début du préfixe et invaliderait tout le cache). On déclare tout l'inventaire en amont — un outil marqué `defer_loading: true` reste retiré tant qu'un `tool_addition` ne le fait pas apparaître — et on ne manipule ensuite que des références. Référencer un nom non déclaré renvoie 400.

Avertissement de sécurité explicite dans la doc : ne jamais placer dans un message système du contenu non fiable (sortie d'outil, document récupéré), puisque cela lui confère l'autorité opérateur.

## 2. Surface d'API exacte

```
messages[] : {"role": "system", "content": <string | blocs text / tool_addition / tool_removal>}
             — aucun header beta ; interdit en position 0
             — modèles : Fable 5, Mythos 5, Opus 4.8, Opus 5 ET Sonnet 5

anthropic-beta: mid-conversation-tool-changes-2026-07-01
  blocs : tool_addition | tool_removal
  champ `tool` :
    {"type": "tool_reference",         "name": "<outil déclaré dans tools[]>"}
    {"type": "mcp_tool_reference",     "server_name": "...", "name": "..."}
    {"type": "mcp_toolset_reference",  "server_name": "..."}
  déclaration : tools[].defer_loading: true
  modèles (beta tool changes uniquement) : Fable 5, Mythos 5, Opus 4.8, Opus 5 — PAS Sonnet 5
```

Payload minimal (orchestrateur qui relaie un événement de coordination et ferme les écritures) :

```json
{
  "role": "system",
  "content": [
    { "type": "text", "text": "L'agent B a réservé src/api/routes.ts il y a 12 s. Les outils d'écriture sur ce chemin sont retirés jusqu'à libération." },
    { "type": "tool_removal", "tool": { "type": "mcp_tool_reference", "server_name": "io.github.swoofer/mcp-coordinator", "name": "announce_work" } }
  ]
}
```

Surfaces connexes citées par les sources, hors périmètre de cette fiche : `tool search tool` GA sans header depuis 2026-02-17, `requiresUserInteraction` côté outil MCP dans Claude Code, diagnostics de cache via `diagnostics.previous_message_id` + `cache_miss_reason` sous `anthropic-beta: cache-diagnosis-2026-04-07`.

**Contradiction entre chercheurs à noter :** deux fiches brutes datent le lancement de `mid-conversation-tool-changes` du 2026-07-24 avec Opus 5 mais l'une place l'annonce dans les release notes API et l'autre dans la page build-with-claude ; le nom du header est identique dans les deux (`mid-conversation-tool-changes-2026-07-01`), donc l'écart porte seulement sur la source citée, pas sur l'API. **Tranché le 2026-08-14 :** l'entrée `### July 24, 2026` des release notes API porte bien l'annonce, avec ce header et cette liste de modèles.

Comportement de `defer_loading` vis-à-vis du cache — **tranché le 2026-08-14 :** l'outil différé est déclaré dans `tools` comme les autres et le tableau `tools` ne change jamais, donc il est bien haché dans le préfixe ; `defer_loading: true` ne fait que le retenir hors de l'inventaire offert au modèle jusqu'à un `tool_addition`. La doc ne dit pas s'il est facturé en tokens d'entrée — *(non vérifiable — non documenté ; mesurable par PoC)*.

## 3. Sources

- https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
- https://platform.claude.com/docs/en/release-notes/api
- https://platform.claude.com/docs/en/release-notes/overview
- https://code.claude.com/docs/en/tools-reference

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

1. *Un second canal de push, sans MQTT.* Aujourd'hui le push temps réel passe par `src/mqtt-broker.ts` + `src/mqtt-bridge.ts` et se termine en `notifications/claude/channel` émis par `cli/channel.ts`, ou par SSE sur `/api/events` (`src/sse-emitter.ts`, `src/serve-http.ts`). Ces deux chemins n'existent que pour Claude Code. Pour un intégrateur qui pilote lui-même la boucle Messages API (le mode « avec orchestrateur »), le message système inséré est l'équivalent exact : il peut injecter « l'agent B vient de réserver `src/api/routes.ts` » comme fait opérateur juste après les `tool_result`, sans cache miss et sans attendre que l'agent pense à appeler `coordinator_status`. Aucun code serveur ne disparaît — c'est une recette d'intégration à documenter, alimentée par les données que `src/agent-registry.ts`, `src/working-files-tracker.ts` et `src/conflict-detector.ts` produisent déjà.

2. *La coordination peut devenir structurelle plutôt que consultative.* `tool_removal` permet de rendre la disponibilité d'un outil dépendante de l'état de coordination : tant qu'un autre agent tient un verrou sur `src/auth/`, l'orchestrateur retire les outils d'écriture ; à la libération, `tool_addition`. L'agent ne peut plus « oublier » de demander : l'outil n'existe pas. `mcp_toolset_reference` permet de couper ou rouvrir tout le serveur mcp-coordinator d'un bloc.

3. *Réponse au coût des 26 outils.* Le serveur enregistre 26 outils (vérifié : 11 dans `src/tools/consultation-tools.ts`, 4 dans `agents-tools.ts`, 3 dans `dependencies-tools.ts`, 3 dans `files-tools.ts`, 3 dans `mqtt-tools.ts`, 2 dans `status-tools.ts`), tous exposés en permanence via `src/server-setup.ts`. Avec `defer_loading` + `tool_addition`, un orchestrateur peut n'offrir que le noyau (`announce_*`, `coordinator_status`) et faire apparaître consultation / dépendances / conflits seulement quand le contexte l'exige, sans payer d'invalidation de cache. C'est un argument d'adoption concret face aux serveurs MCP obèses.

Ce qui manquerait côté serveur pour rendre ça exploitable : un endpoint qui répond « quels outils devraient être offerts à l'agent X maintenant », dérivé de l'état des verrous et des threads ouverts. Rien de tel n'existe aujourd'hui dans `src/serve-http.ts` (les routes présentes sont `/api/auth/*`, `/api/events`, `/mcp`, `/health*`).

**Risque si on ne fait rien :** faible mais réel. Les intégrateurs qui n'utilisent pas Claude Code n'ont aujourd'hui aucun chemin de push documenté ; ils polleront `coordinator_status`, ce qui coûte des tours et donne une coordination en retard. Le risque n'est pas une menace concurrentielle, c'est un angle mort de la doc.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/server-setup.ts` | Point d'enregistrement des 6 familles d'outils (`registerConsultationTools`, `registerAgentTools`, `registerFilesTools`, `registerDependenciesTools`, `registerStatusTools`, `registerMqttTools`). C'est ici que se déciderait un découpage noyau / différé. |
| `src/tools/consultation-tools.ts` (11 outils) | Le plus gros bloc : premier candidat à `defer_loading`. |
| `src/tools/dependencies-tools.ts` (3), `src/tools/files-tools.ts` (3), `src/tools/mqtt-tools.ts` (3) | Familles secondaires, activables à la demande. |
| `src/tools/agents-tools.ts` (4), `src/tools/status-tools.ts` (2, dont `coordinator_status`) | Noyau à garder toujours chargé. |
| `src/serve-http.ts` | Routes existantes : `/mcp`, `/api/events` (SSE), `/api/auth/*`, `/health*`. Emplacement d'un futur endpoint « inventaire d'outils recommandé pour l'agent X ». |
| `src/sse-emitter.ts` | Source des événements de coordination qu'un orchestrateur convertirait en message système inséré. Le type `CoordinatorEvent` est déclaré dans `src/types.ts` et importé ici (l. 2). |
| `src/mqtt-bridge.ts`, `src/mqtt-broker.ts` | Chemin de push actuel, spécifique Claude Code ; à comparer, pas à remplacer. |
| `cli/channel.ts` | Émet `notifications/claude/channel` (ligne ~465). Illustre la traduction événement → push ; le format de phrase y est déjà normalisé et réutilisable. |
| `src/agent-registry.ts`, `src/working-files-tracker.ts`, `src/conflict-detector.ts` | Fournissent l'état « qui détient quoi » qui déciderait des `tool_removal`. |
| `sdk/src/client.ts` | Le SDK client TypeScript : lieu naturel d'un helper `buildSystemMessage(events)` pour les intégrateurs orchestrateurs. |
| `docs/ARCHITECTURE.md` | À compléter avec la section « mode orchestrateur » si la recette est retenue. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> mcp-coordinator doit-il se contenter de **documenter** une recette d'orchestrateur (le client insère lui-même les messages système et les `tool_addition` à partir du flux SSE), ou doit-il **exposer côté serveur** un endpoint d'inventaire d'outils dérivé de l'état des verrous — c'est-à-dire assumer une dépendance à une beta Messages API et à un modèle non-Sonnet dans son propre code ?

### 6.2 Hypothèse

**Ce que je pense avant de mesurer.** §6.1 oppose « documenter une recette » à « exposer un endpoint d'inventaire ». Je pense que la seconde branche est morte-née pour une raison que la fiche énonce elle-même en §6.5 sans en tirer la conséquence : **mcp-coordinator ne construit jamais `messages[]`**. Un endpoint qui répondrait « quels outils offrir à l'agent X » ne serait consommé par personne, puisque le seul consommateur possible est un orchestrateur qui, par construction, connaît déjà l'état qu'il a demandé au coordinateur.

Reste la première branche — la recette — et c'est là que le challenge doit trancher, sur deux points chiffrables :

1. **Le coût des 26 outils.** §4.3 en fait un « argument d'adoption concret face aux serveurs MCP obèses », et §6.5 réplique que « le vrai coût n'a jamais été mesuré ». C'est le seul point exécutable ici (§0), et il décide seul de l'intérêt de `defer_loading`. S'il pèse peu, le point 3 de §4 tombe.
2. **La sécurité de la recette.** La doc Anthropic interdit explicitement le contenu non fiable dans un message système, qui porte l'autorité opérateur. Or ce qu'un orchestrateur relaierait vient d'**autres agents**. Si nos payloads d'événements portent du texte libre d'origine agent, la recette telle que §4.1 la décrit est une recette d'injection à autorité opérateur — et il faut le dire, pas la documenter.

Hypothèse secondaire : `tool_removal` comme mécanisme de verrou (§4.2) est contournable trivialement, puisqu'il n'est exécutable que si l'orchestrateur coopère. Ce n'est pas un contrôle d'accès, c'est une convention — et la présenter autrement serait un « garde-fou fantôme » de plus.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **Ce n'est pas notre couche.** Si la feature ne fait disparaître ni apparaître aucune ligne dans `src/`, « adopter » ne veut rien dire : il ne reste que de la documentation. | **0** ligne de `src/` que la feature ajoute ou supprime |
| **K2** | **Le coût des 26 outils est négligeable.** `defer_loading` n'a d'intérêt que si le bloc `tools` pèse assez pour qu'un intégrateur le remarque. | bloc `tools` < **5 000** tokens estimés |
| **K3** | **La population n'existe pas.** Le bénéfice vise « l'intégrateur qui pilote lui-même la boucle Messages API ». | **0** issue, discussion ou exemple attestant un intégrateur hors Claude Code |
| **K4** | **La primitive exclut le modèle le plus probable.** Un swarm à coût contenu tourne sur Sonnet ; si `tool changes` en est exclu, bâtir la coordination dessus est fragile. | Sonnet 5 absent de la liste `mid-conversation-tool-changes`, **reconfirmé sur la doc du jour** |
| **K5** | **La recette est une recette d'injection.** Si les payloads que l'orchestrateur relaierait portent du texte libre d'origine agent, les placer en message système leur donne l'autorité opérateur — ce que la doc Anthropic interdit explicitement. | ≥ **1** champ de texte libre d'origine agent dans les payloads d'événements |
| **K6** | **Le découpage noyau/différé a un coût réel.** | > **3** fichiers de tests à réécrire pour un enregistrement en deux temps |

**Règle que je m'impose :** §0 classe la fiche ⚠️ **partielle** — seul le point 1 du protocole est exécutable. Tout ce qui passe par la boucle Messages API ne peut donc **jamais** recevoir `adopter` : au mieux `reporter`, et la frontière entre mesuré et non mesuré doit être explicite en §6.4.

### 6.3 Protocole de vérification

> ⚠️ Vérification 2026-08-14 : seul le premier point (mesure du poids des 26 outils via `tools/list` sur le daemon local) est exécutable ici. Les quatre autres passent par la boucle Messages API et exigent une clé API autorisée pour `mid-conversation-tool-changes-2026-07-01` sur un modèle non-Sonnet.

<Proposition de la veille — non exécutée.>

- [ ] Mesurer le coût contexte réel des 26 outils : compter les tokens du bloc `tools` produit par `src/server-setup.ts` (dump `tools/list` via `/mcp` puis `count_tokens`). Sans chiffre, le gain de `defer_loading` est une hypothèse.
- [ ] PoC minimal hors repo : une boucle Messages API avec deux outils déclarés dont un en `defer_loading: true`, un `tool_addition` inséré au tour 2, et vérification de `cache_read_input_tokens` avant/après pour confirmer qu'il n'y a pas de cache miss.
- [ ] Vérifier les règles de placement contre le vrai flux : insérer un message système juste après un tour `user` portant des `tool_result` et confirmer l'absence de 400.
- [ ] Brancher `src/sse-emitter.ts` sur ce PoC : convertir un `CoordinatorEvent` réel (réservation de fichier) en message système et observer si l'agent change de comportement sans appel à `coordinator_status`.
- [ ] Tester le retrait complet via `mcp_toolset_reference` sur `server_name: "mcp-coordinator"` et vérifier que l'agent ne tente plus d'appeler les outils retirés.

### 6.4 Résultat observé

#### A. Défaut dans la fiche, corrigé avant tout le reste

L'unique payload concret de §2 était **garanti 400**. Il émettait un `tool_removal` sur `mcp_tool_reference` de nom `announce_intent` — un outil qui n'existe pas :

```
$ grep -rn "announce_intent" src/ cli/ docs/ tests/ research/
research/claude-features/E08-mid-conversation-system-and-tools.md:72   <- l'unique occurrence du dépôt
```

Et §1 de cette même fiche énonce la règle : « Référencer un nom non déclaré renvoie 400 ». Le `server_name` était faux aussi — le serveur s'enregistre comme `io.github.swoofer/mcp-coordinator` (`src/server-setup.ts:235`), pas `mcp-coordinator`. **Corrigé.** C'est exactement la faute que `src/mcp-instructions.ts:19-22` consigne comme déjà commise une fois par le projet, et contre laquelle un test de non-régression existe désormais.

#### B. §4.3 s'effondre : l'argument du « coût des 26 outils » vise une dépense que personne ne fait

**Mesure du bloc `tools`.** Serveur construit en mémoire, handler `tools/list` interne appelé, réponse sérialisée :

```
outils      : 26
caracteres  : 16 064
estimation  : 4 016 a 5 020 tokens   (ratio 4,0 a 3,2 car./token)
METHODE     : aucun tokenizer Anthropic installe ici -> ENCADREMENT, pas mesure.

les 6 plus lourds :
   1974 car.  announce_work
   1021 car.  post_to_thread
    794 car.  mqtt_publish
    785 car.  register_agent
    743 car.  list_threads
    743 car.  wait_for_peers

noyau (agents+status, 6 outils) : 2 971 car.
economie max de defer_loading   : 13 093 car. ~= 3 273 a 4 092 tokens
```

Vérifié au passage : les 26 sont enregistrés inconditionnellement (`server-setup.ts:252-257`), `getSessionClaims` n'est consommé que dans les handlers, et **aucune interception de `tools/list`** n'existe dans `src/` — l'inventaire n'est donc réduit ni par org ni par claims.

**Mais ce chiffre n'est pas payé.** Le dépôt le dit lui-même, à trois endroits, dont `src/mcp-instructions.ts:5-8` :

> « issue #271: **Claude Code defers MCP tool definitions by default (tool search). At session start only tool NAMES and the server's `instructions` enter context; schemas are materialised on demand.** »

Et `docs/operating-modes.md:59-64` porte un **ancrage mesuré** : forcer le chemin bloquant avec `MCP_CONNECTION_NONBLOCKING=0` coûte « about **+678 tokens** on the first-turn prefix ».

Donc, sur le client dominant, l'empreinte de premier tour est ≈ 26 **noms** + `MCP_INSTRUCTIONS` (1 348 caractères, plafonné à 2 ko par `mcp-instructions.test.ts:125`) — pas 16 064 caractères. **L'« économie maximale » de 13 093 caractères est de l'argent que personne ne dépense**, et le besoin auquel §4.3 prétend répondre est déjà couvert **en GA, par la plateforme, gratuitement**. C'est nettement plus fort que le « le `tool search tool` *pourrait* couvrir le même besoin » de §6.5.

#### C. La recette de §4.1 est interdite par la doc qu'elle cite — mais il en existe une version licite

Doc fetchée le 2026-08-17, deux interdictions distinctes :

> « This pattern is for relaying input from **the conversation's own end user**. **Do not use it to pass tool output, retrieved documents, or other third-party content**; keep that content in `tool_result` blocks. »

> « **Not a place for untrusted content.** Claude treats system content as operator instructions and follows it. … doing so gives that text **operator-level authority**. »

§4.1 propose de relayer « l'agent B vient de réserver `src/api/routes.ts` » — contenu venant d'**un autre agent**, donc du *third-party content*, pas de l'end user de la conversation.

Et nos payloads portent bien du texte libre d'origine agent. Mesuré :

```
champ      declarations   avec .max()
subject         2              0
plan            2              0
content         2              0
summary         3              0
reason          3              0
```

Cinq champs, douze déclarations (`consultation-tools.ts` + `rest-schemas.ts`), **zéro borne**.

**Mais la même doc autorise explicitement la version dérivée** :

> « **State changes your application observes.** Your application notices something Claude should treat as an operator-level fact: files changed on disk, the user toggled an auto-approve setting, **available tools changed** … »

Un orchestrateur qui **énonce un fait qu'il a lui-même dérivé** de l'état du coordinateur (« l'agent B détient un verrou sur `src/api/routes.ts` depuis 12 s ») est dans le cas béni. Un orchestrateur qui **recopie `subject` ou `content`** est dans le cas interdit. **La frontière n'est pas dans la fiche, et c'est le seul apport réel de ce challenge côté doc.**

#### D. Ma jambe « ce n'est pas notre couche » est fausse — le serveur a un levier, et il est GA

J'allais écrire que mcp-coordinator ne peut rien faire pour retirer un outil, puisque `defer_loading` vit dans le `tools[]` de la Messages API. **C'est faux**, et le levier est dans un paquet déjà installé. Mesuré :

```
outils offerts avant                          : 26
outils offerts apres disable("mqtt_publish")  : 25
notification list_changed disponible           : true
```

Le SDK MCP expose `disable()` / `enable()` sur chaque outil enregistré, `tools/list` filtre sur `enabled`, et toute mutation déclenche `notifications/tools/list_changed`. **Aucun header beta, aucune exclusion de modèle, et c'est du côté serveur** — donc non contournable par un orchestrateur non coopératif, contrairement à `tool_removal`.

*Frontière honnête :* le filtrage de `tools/list` est **prouvé par exécution** ci-dessus. Le rejet d'un `tools/call` sur un outil désactivé est **lu dans le bundle du SDK** (`@modelcontextprotocol/server`, branche `Tool ${name} disabled`) mais **mon banc ne l'a pas exécuté** — il a échoué sur un contexte de requête incomplet, pas sur la logique.

Et l'architecture s'y prête déjà : `createMcpServer` est **une instance par session** (`server-setup.ts:193-208`, appelée en `serve-http.ts:808`) avec les claims de session, donc un inventaire par agent ne demande aucune plomberie nouvelle. La veille l'avait d'ailleurs noté : `A02:34` relève « zéro occurrence de `listChanged` / `sendToolListChanged` dans `src/` ».

**Conséquence pour §6.1 : la question oppose deux mauvaises réponses.** L'endpoint HTTP d'inventaire est mort-né — mais pas parce que « ce n'est pas notre couche » : parce que la bonne forme côté serveur est `disable()` + `list_changed`, et qu'elle appartient à `A02` / `A04`, pas à E08.

#### E. Ce que je dois corriger dans mon propre raisonnement

- **Ma jambe 1 était trop rapide dans les deux sens.** L'endpoint est bien inutile — mais pas parce que la jointure serait facile côté client : elle est **déjà faite et déjà renvoyée**. `conflictDetector.detect()` (`src/conflict-detector.ts:43-186`) tourne à l'intérieur d'`announce_work` et son résultat part dans la réponse. Un client n'a jamais besoin de N appels.
- **« Garde-fou fantôme » était mal employé pour §4.2.** Un garde-fou fantôme promet une protection qu'il ne délivre pas. Ici le produit **ne promet rien** : `announce_work` calcule les conflits, les écrit, les émet, les renvoie — et ne renvoie **jamais** `isError` pour un conflit ; `check_file_conflict` est `readOnlyHint: true` ; `wait_for_peers` ne bloque que sur un **nombre** de pairs, jamais sur un verrou. Tout est consultatif. `tool_removal` serait donc un **renforcement de zéro**, pas un affaiblissement. L'argument valable contre §4.2 est celui du **positionnement** (§6.5 dernier point), pas un argument technique.

#### F. Adjudication des six critères pré-enregistrés

| # | Seuil | Mesure | Verdict |
|---|---|---|---|
| **K1** | 0 ligne de `src/` ajoutée/supprimée | **faux** — `disable()` + `sendToolListChanged` sont un vrai levier serveur, GA, sur une instance déjà par session | **NE SE DÉCLENCHE PAS** — et c'est ma jambe qui tombe, pas la fiche |
| **K2** | bloc `tools` < 5 000 tokens | encadrement **4 016 – 5 020** — il **chevauche** le seuil, et aucun tokenizer Anthropic n'est installé | **INMESURABLE au seuil que j'ai fixé.** Rendu sans objet par B : sous *tool search*, le bloc n'est pas payé d'avance |
| **K3** | 0 issue/discussion/**exemple** attestant un intégrateur | un orchestrateur est attesté par le produit lui-même (`cli/init.ts:86`, `docs/usage.md:159`, `operating-modes.md:69`) — mais il orchestre des **sessions Claude Code par hooks**, jamais `messages[]` | **NE SE DÉCLENCHE PAS comme écrit.** La forme étroite qui tient : aucun intégrateur ne pilote la boucle Messages API, donc personne ne peut insérer un `role: "system"` |
| **K4** | Sonnet 5 exclu, reconfirmé sur la doc du jour | verbatim, 2026-08-17 : « They are **not available on Claude Sonnet 5**. » | **SE DÉCLENCHE** |
| **K5** | ≥ 1 champ de texte libre agent dans les payloads | 5 champs, 12 déclarations, **0 borne** ; et `cli/channel.ts` les interpole déjà **bruts** (l. 94, 110-112, 130-132), `strField` (l. 146-149) n'échappe rien | **SE DÉCLENCHE — et sur du code livré**, pas sur une recette hypothétique |
| **K6** | > 3 fichiers de tests à réécrire | **indécidable au seuil** : avec `disable()` (les 26 restent enregistrés) seuls **2** fichiers smoke cassent ; avec un enregistrement conditionnel, **6** | **INMESURABLE au seuil que j'ai fixé** — il dépend de la stratégie, que le critère ne fixait pas |

**Bilan : un seul critère se déclenche proprement (K4), un se déclenche mais sur une autre cible que prévu (K5), deux ne se déclenchent pas — dont l'un contre moi (K1) — et deux sont inmesurables aux seuils que j'avais posés.** Deux de mes six seuils étaient mal calibrés ; je le note plutôt que de choisir un côté après coup.

### 6.5 Contre-arguments

- **Ce n'est pas notre couche.** Les deux mécanismes vivent dans la boucle Messages API, côté client. mcp-coordinator est un serveur MCP : il ne construit pas `messages[]` et ne verra jamais ces blocs. Tout ce qu'on peut livrer, c'est de la documentation et éventuellement un helper SDK — soit un gain qui n'enlève aucune ligne de code au serveur.
- **Dépendance beta + exclusion de modèle.** `mid-conversation-tool-changes-2026-07-01` est en beta et absent de Sonnet 5, le modèle le plus probable pour un swarm d'agents à coût contenu. Bâtir une capacité de coordination sur une primitive indisponible sur le modèle le plus utilisé est fragile.
- **Deux chemins de push à maintenir.** MQTT + `notifications/claude/channel` existent déjà et fonctionnent. Ajouter une recette message-système crée un second contrat à tenir cohérent (même vocabulaire d'événements, même sémantique), pour une population d'utilisateurs — les intégrateurs orchestrateurs hors Claude Code — dont on n'a aucune preuve qu'elle existe aujourd'hui.
- **Risque de sécurité mal placé.** La doc interdit explicitement de mettre du contenu non fiable dans un message système. Or les payloads que relaierait un orchestrateur viennent d'autres agents : contenu tiers. Documenter « prends le payload MQTT et mets-le dans un message système » est une recette d'injection à autorité opérateur. Il faudrait imposer une reformulation en fait constaté, ce qui suppose une couche de normalisation côté SDK — coût non trivial.
- **YAGNI sur `defer_loading`.** 26 outils, c'est beaucoup, mais le vrai coût n'a jamais été mesuré. Découper `src/server-setup.ts` en noyau / différé complique l'enregistrement, l'auto-hébergeur, et les tests, pour une économie inconnue. Le `tool search tool` (GA, sans header) pourrait couvrir le même besoin sans toucher au serveur.
- **La coordination structurelle change la nature du produit.** Retirer un outil parce qu'un pair tient un verrou transforme mcp-coordinator d'assistant de coordination en autorité de contrôle d'accès. C'est un choix de positionnement, pas une optimisation, et il n'est exécutable que si l'orchestrateur coopère — donc contournable trivialement.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** · ⬜ refuser |
| **Date** | 2026-08-17 |
| **Justification** | **§6.1 oppose deux mauvaises réponses**, et le challenge en fait apparaître une troisième. ⭑ **L'endpoint HTTP d'inventaire est mort-né** — mais pas pour la raison que j'allais écrire : la jointure coûteuse est **déjà faite et déjà renvoyée**, `conflictDetector.detect()` tourne dans `announce_work` et part dans sa réponse. ⭑ **La recette de §4.1 est interdite par la doc qu'elle cite** : relayer « l'agent B vient de réserver X » met du *third-party content* dans un message système, ce que la doc du 2026-08-17 proscrit deux fois — et nos payloads portent **5 champs de texte libre agent, 12 déclarations, 0 borne**. Mais la même doc **autorise explicitement** la version dérivée (*« state changes your application observes »*) : la frontière est entre **énoncer un fait qu'on a dérivé** et **recopier du texte d'agent**. Elle n'est pas dans la fiche, et c'est le seul apport doc du challenge. ⭑ **§4.3 s'effondre.** Le bloc `tools` mesuré fait 16 064 caractères, mais `src/mcp-instructions.ts:5-8` et `docs/operating-modes.md:59-64` établissent que sous *tool search* — le défaut de Claude Code — **seuls les NOMS entrent en contexte au premier tour**, avec un ancrage mesuré à **+678 tokens** pour le chemin bloquant. L'« économie maximale » de 13 093 caractères est de l'argent que personne ne dépense : le besoin est couvert **en GA, par la plateforme, gratuitement**. ⭑ **Et ma propre jambe « ce n'est pas notre couche » est fausse.** Mesuré : le SDK MCP expose `disable()` / `enable()`, `tools/list` passe de **26 à 25** après un `disable()`, et `sendToolListChanged` existe. C'est **GA, sans header beta, sans exclusion de modèle, et côté serveur** — donc non contournable par un orchestrateur non coopératif, contrairement à `tool_removal`. `createMcpServer` étant déjà **une instance par session**, un inventaire par agent ne demande aucune plomberie nouvelle. **Pourquoi `reporter` et non `refuser` :** la primitive Messages API est bien hors de portée (beta, Sonnet 5 exclu — K4 —, et aucun intégrateur ne pilote `messages[]`), mais le challenge a identifié une **capacité GA équivalente et supérieure** qui appartient à `A02` / `A04`. Refuser fermerait la question ; elle doit rester ouverte sur la bonne fiche. **Corrections de méthode :** deux de mes six seuils étaient mal calibrés — K2 (encadrement 4 016-5 020 tokens **chevauchant** le seuil de 5 000, faute de tokenizer) et K6 (indécidable : 2 fichiers avec `disable()`, 6 avec un enregistrement conditionnel). Je les rends **inmesurables** plutôt que de choisir un côté après coup. K1 et K3 ne se déclenchent pas, K1 contre moi. Et j'employais « garde-fou fantôme » à tort pour §4.2 : le produit ne promet **rien** aujourd'hui (`announce_work` ne renvoie jamais `isError` sur conflit, `check_file_conflict` est `readOnlyHint`, `wait_for_peers` ne bloque que sur un nombre de pairs), donc `tool_removal` serait un renforcement de zéro. **Défaut de la fiche corrigé :** son unique payload concret était garanti **400** — il référençait `announce_intent`, dont l'unique occurrence du dépôt était cette ligne, avec en prime un `server_name` faux. |
| **Issue / PR** | **#355** — `cli/channel.ts` (l. 94, 110-112, 130-132) recopie brut du texte d'agent non borné et non échappé dans le contexte d'un autre agent ; `strField` (l. 146-149) n'échappe rien et les 5 champs n'ont aucune `.max()`. Sévérité cadrée : c'est le corps d'une balise `<channel>`, **pas** le prompt système — injection entre pairs, pas élévation de privilège. |
| **Jalon visé** | Aucun pour la primitive Messages API tant que Sonnet 5 en est exclu et qu'aucun intégrateur ne pilote `messages[]`. **La suite appartient à `A02`** (`disable()` + `notifications/tools/list_changed`, GA) : c'est la même capacité, en mieux, et elle est exécutable aujourd'hui. #355 est indépendant et sans urgence. |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : API et dates confirmées, `defer_loading` tranché, Sonnet 5 précisé, `CoordinatorEvent` recorrigé. |
| 2026-08-17 | **Challenge — verdict `reporter` ; §6.1 oppose deux mauvaises réponses.** **§4.3 s'effondre** : le bloc `tools` mesuré fait **16 064 caractères** (26 outils ; `announce_work` 1 974 à lui seul), mais `src/mcp-instructions.ts:5-8` et `docs/operating-modes.md:59-64` établissent que sous *tool search* — le défaut de Claude Code — **seuls les NOMS entrent en contexte au premier tour**, avec un ancrage mesuré de **+678 tokens** pour le chemin bloquant. L'« économie maximale » de 13 093 caractères que `defer_loading` promet est de l'argent que personne ne dépense : le besoin est déjà couvert **en GA, par la plateforme**. **§4.1 est interdite par la doc qu'elle cite** (fetchée ce jour) : relayer un payload d'agent dans un `role: "system"` est du *third-party content*, proscrit deux fois — et nos payloads portent **5 champs libres, 12 déclarations, 0 borne**. Mais la même doc **autorise** la version dérivée (« state changes your application observes ») : la frontière est entre *énoncer un fait dérivé* et *recopier du texte d'agent*, et elle manquait à la fiche. **Ma jambe « ce n'est pas notre couche » est fausse** : mesuré, le SDK MCP expose `disable()`/`enable()`, `tools/list` passe de **26 à 25** après un `disable()`, et `sendToolListChanged` existe — **GA, sans header beta, sans exclusion de modèle, côté serveur**, donc non contournable par un orchestrateur non coopératif, contrairement à `tool_removal`. `createMcpServer` étant déjà une instance par session, un inventaire par agent ne demande aucune plomberie. D'où `reporter` et non `refuser` : la question doit rester ouverte, **sur `A02`**. **Adjudication : un seul critère se déclenche proprement (K4, Sonnet 5 exclu, verbatim du jour), un se déclenche sur une autre cible que prévu (K5, sur du code livré), deux ne se déclenchent pas — dont K1 contre moi — et deux sont inmesurables aux seuils que j'avais posés** (K2 : encadrement 4 016-5 020 chevauchant le seuil de 5 000, sans tokenizer ; K6 : 2 fichiers avec `disable()`, 6 avec un enregistrement conditionnel). Je les laisse inmesurables plutôt que de choisir un côté après coup. **« Garde-fou fantôme » employé à tort pour §4.2** : le produit ne promet rien aujourd'hui (`announce_work` ne renvoie jamais `isError` sur conflit, `check_file_conflict` est `readOnlyHint`, `wait_for_peers` ne bloque que sur un nombre de pairs) — `tool_removal` serait un renforcement de zéro, et le seul argument valable contre §4.2 est celui du positionnement. **Défaut de la fiche corrigé** : son unique payload concret était garanti **400**, référençant `announce_intent` — dont l'unique occurrence du dépôt était cette ligne — avec un `server_name` faux. C'est la faute que `src/mcp-instructions.ts:19-22` consigne comme déjà commise une fois. Livrable : **#355**. |
