# E09 — MENACE : le MCP connector ne voit que les tool calls, tout le temps réel est invisible

| Champ | Valeur |
|---|---|
| **ID** | `threat-mcp-connector-tools-only` |
| **Surface** | claude-api |
| **Statut** | **beta** — header `anthropic-beta: mcp-client-2025-11-20` (version précédente `mcp-client-2025-04-04` dépréciée) |
| **Disponible depuis** | limitation **constante depuis l'introduction du connector**, redocumentée sur le header courant `mcp-client-2025-11-20` (la doc ne date pas la publication du header ; seul son nom porte la date 2025-11-20) |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — exposition publique HTTPS + clé API beta manquantes |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — refuser le tool runner ; le vrai prealable est #325 ; livrable #357 |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** ✅ saine

**Corrections apportées :**

- `Disponible depuis` : la mention « août 2026 » pour le header `mcp-client-2025-11-20` n'est étayée par aucune source — la doc ne date pas sa publication. Remplacée par un constat factuel.
- §2 : ajout du champ `server_name` dans le bloc `mcp_tool_use` et des champs `tool_use_id` / `is_error` / `content` dans `mcp_tool_result` (présents dans la doc, absents de la fiche).
- §2 : précision sur `authorization_token` — la doc le décrit comme un **jeton d'accès OAuth** que l'appelant doit obtenir *et rafraîchir* lui-même ; « bearer statique » est vrai au niveau d'une requête, pas au niveau du cycle de vie du jeton.
- §2 : note sur la disponibilité Microsoft Foundry, conditionnée à un déploiement « Hosted on Anthropic ».

**Vérifié sans correction :**

- Statut **beta** et header `anthropic-beta: mcp-client-2025-11-20` : confirmés (« Status: Beta »). `mcp-client-2025-04-04` est bien déprécié, avec guide de migration.
- Limitations, verbatim doc : « only tool calls are currently supported » + « The server must be publicly exposed through HTTP (supports both Streamable HTTP and SSE transports). Local STDIO servers cannot be connected directly. » La fiche cite ce point correctement, y compris la distinction « SSE = transport supporté, pas un canal de push ».
- Note des helpers client-side : « local stdio servers, MCP prompts, or MCP resources » — verbatim conforme à §1/§2.
- Formes `mcp_servers` (`type`/`url`/`name`/`authorization_token`) et `mcp_toolset` (`mcp_server_name`/`default_config`/`configs`/`cache_control`, options `enabled`/`defer_loading`) : exactes.
- Noms des helpers SDK, tous langages (TS, Python, Go, Java, C#, PHP, Ruby) : exacts, y compris les noms Python `async_mcp_tool` / `mcp_message` / `mcp_resource_to_content` / `mcp_resource_to_file`.
- ZDR : « The MCP connector is not covered by ZDR arrangements. » Plateformes : Claude API, Claude Platform on AWS, Microsoft Foundry ; **pas** Amazon Bedrock ni Google Cloud. Conformes.
- §5, tous les fichiers existent et **toutes les lignes citées sont exactes** : `src/server-setup.ts` l. 237-247 (les 6 `register*Tools`), `src/tools/mqtt-tools.ts` l. 22 / 53 / 80 / 96, `cli/channel.ts` l. 465, `src/serve-http.ts` l. 349 / 732 / 740 / 801, `src/http/origin.ts` l. 15, `README.md` l. 44 / 415 / 511, `MAX_SSE_CLIENTS` dans `src/sse-emitter.ts` (l. 24, défaut 100).
- Le décompte « 26 outils » est exact (`grep -c "server.tool(" src/tools/*.ts` → 26) et **aucun `registerResource` / `registerPrompt`** dans `src/` ni `cli/` : la surface est bien tools-only.

**Marqueurs `(à vérifier)` restants :** aucun (la fiche n'en contenait aucun).

**Testabilité :** ⚠️ partielle
Le volet repo se teste intégralement en local (démarrer le daemon HTTP, appeler `/mcp` sans en-tête `Origin` pour confirmer le passage, lister les 26 outils, chronométrer `wait_for_message` jusqu'au cap 300 s côté serveur). Le volet connector ne l'est pas ici : il exige une instance **publiquement joignable en HTTPS** (recette `examples/fly-io/` → compte Fly, ou reverse proxy + certificat) **et** une clé API Anthropic autorisée à envoyer `anthropic-beta: mcp-client-2025-11-20`. Sans ces deux accès, les trois mesures décisives — seuil de coupure HTTP du connector sur le long-poll, invisibilité empirique des notifications, coût du PoC `toolRunner()` — restent hors de portée.

---

## 1. Ce que c'est

Le **MCP connector** de la Claude API permet d'attacher un serveur MCP distant directement à un appel `/v1/messages`, sans client MCP côté appelant : Anthropic héberge le client, ouvre la connexion et renvoie les appels d'outils dans des blocs `mcp_tool_use` / `mcp_tool_result`. La section « Limitations » de la doc est explicite : de tout le jeu de fonctionnalités de la spécification MCP, **seuls les appels d'outils sont supportés**. Le serveur doit être **exposé publiquement en HTTP** (Streamable HTTP ou SSE), les serveurs STDIO locaux ne peuvent pas être connectés directement.

Ce que cela exclut concrètement : la Note de la doc sur les helpers cite littéralement « local stdio servers, MCP prompts, or MCP resources » comme cas non couverts — donc **resources et prompts sont confirmés hors périmètre**. Pour les **notifications serveur→client**, le **sampling** et l'**elicitation**, la doc ne les énumère pas nommément ; leur exclusion est une déduction directe de « only tool calls », correcte mais non littérale — à traiter comme telle. Point à ne pas confondre : **SSE est bien supporté comme transport** du connector, ce qui ne donne aucun canal de push applicatif vers le modèle.

Anthropic documente un contournement : les **client-side MCP helpers** des SDK. On garde son propre client MCP (donc les notifications, resources et prompts restent accessibles côté application), et les helpers convertissent les types MCP vers les types de la Claude API. Deux contraintes de déploiement complètent le tableau : le connector est disponible sur Claude API, Claude Platform on AWS et Microsoft Foundry mais **pas sur Amazon Bedrock ni Google Cloud**, et il **n'est pas couvert par les accords ZDR** (zero data retention).

## 2. Surface d'API exacte

```
Header beta :
  anthropic-beta: mcp-client-2025-11-20        (mcp-client-2025-04-04 = deprecated)

Corps de requête /v1/messages :
  mcp_servers: [ { type: "url", url, name, authorization_token } ]
    // type : seul "url" est supporté ; url doit commencer par https://
    // authorization_token : optionnel, jeton d'accès OAuth — la doc précise que
    //   l'appelant obtient ET rafraîchit le jeton lui-même
  tools: [ {
    type: "mcp_toolset",
    mcp_server_name: "<name>",
    default_config: { enabled, defer_loading },
    configs: { ... },
    cache_control: { ... }
  } ]

Blocs de réponse :
  mcp_tool_use    { type, id: "mcptoolu_…", name, server_name, input }
  mcp_tool_result { type, tool_use_id, is_error, content: [...] }

Disponibilité : Claude API (beta), Claude Platform on AWS (beta),
  Microsoft Foundry (beta — uniquement en déploiement « Hosted on Anthropic ») ;
  PAS Amazon Bedrock, PAS Google Cloud. Non éligible ZDR.
```

Contournement documenté — **Client-side MCP helpers** (on garde SON client MCP) :

```ts
// TypeScript — @anthropic-ai/sdk/helpers/beta/mcp
mcpTools(tools, mcpClient)
mcpMessages(messages)
mcpResourceToContent(resource)
mcpResourceToFile(resource)
// puis : anthropic.beta.messages.toolRunner({ ... })
```

```python
# Python — pip install "anthropic[mcp]" ; module anthropic.lib.tools.mcp
async_mcp_tool, mcp_message, mcp_resource_to_content, mcp_resource_to_file
# puis : client.beta.messages.tool_runner(...)
```

Équivalents dans les autres SDK : Go `anthropic-sdk-go/mcp` (`mcp.NewBetaTools`, `mcp.ToMessage`, `mcp.ResourceToBlock`, `mcp.ResourceToFile`), Java `anthropic-java-mcp` (`BetaMcp.mcpTools` / `mcpMessages` / `mcpResourceContents` / `mcpResourceFiles`), C# `Anthropic.Mcp` (`BetaMcp.ListToolsAsync` / `Messages` / `ResourceToContent` / `ResourceToFile`), PHP `Anthropic\Lib\Tools\BetaMcp`, Ruby `Anthropic::Mcp`.

**Écart entre la fiche brute et la doc, signalé par la vérification :** la fiche de recherche énumérait « ni resources, ni prompts, ni notifications, ni sampling, ni elicitation » comme si la doc le listait ; elle dit seulement « only tool calls ». Elle datait aussi la limitation du header `mcp-client-2025-11-20`, alors qu'elle existait déjà sur `mcp-client-2025-04-04`. Les noms des helpers Python de la fiche brute étaient ceux du SDK TypeScript ; corrigés ci-dessus.

## 3. Sources

- https://platform.claude.com/docs/en/agents-and-tools/mcp-connector

## 4. Pourquoi ça concerne mcp-coordinator

**Risque si on ne fait rien :**

C'est la contrainte la plus structurante du bloc E pour ce projet. Tout le pilier « temps réel » — broker MQTT embarqué (`src/mqtt-broker.ts`), bridge (`src/mqtt-bridge.ts`), SSE (`src/sse-emitter.ts`), et surtout les `notifications/claude/channel` émises par `cli/channel.ts` — est **structurellement invisible** à travers le connector. Un agent piloté par la Messages API ne reçoit **aucun push** : il ne voit que ce qu'il va chercher par appel d'outil. Le README affirme aujourd'hui, ligne 44, que « agents see each other's actions in real-time » et, ligne 415, « All events arrive via SSE on `/api/events`. No polling. » — ces deux phrases sont vraies pour Claude Code / Cursor / Cline et **fausses pour tout agent Messages API**. `docs/operating-modes.md` présente deux modes (polling / push Channels) ; le connector en impose un troisième régime, encore plus contraint, qui n'est documenté nulle part.

Trois conséquences de déploiement s'ajoutent au silence du push : (a) le connector exige une **exposition publique en HTTP**, ce qui sort du profil « daemon localhost » que vend `cli/init.ts` et déplace le projet vers les recettes `examples/fly-io/`, `examples/nginx-reverse-proxy/`, `examples/traefik-reverse-proxy/` ; (b) l'authentification se réduit au champ `authorization_token`, un **bearer statique** — tout l'appareillage `src/auth/device-flow.ts` + `src/auth/refresh-rotation.ts` est court-circuité, et le seul chemin viable devient les service tokens (`src/auth/service-tokens.ts`, `cli/service-tokens.ts`) ; (c) **pas de ZDR**, ce qui touche précisément le segment régulé que visent le multi-org et la chaîne d'audit (`src/security/audit-chain.ts`).

**Bénéfice attendu (ce qui joue en notre faveur) :**

La bonne nouvelle est vérifiable dans le code : **le serveur MCP de mcp-coordinator n'expose aujourd'hui que des outils**. Aucun `registerResource`, aucun `registerPrompt` dans `src/` ni `cli/` ; les 26 outils sont enregistrés par les six modules de `src/tools/` (`src/server-setup.ts` l. 237-247). La surface d'outils est donc **déjà 100 % compatible connector**, sans portage. Le transport `/mcp` est du Streamable HTTP (`src/serve-http.ts` l. 740, l. 801) et `src/http/origin.ts` l. 15 laisse passer les appels serveur-à-serveur sans en-tête `Origin` — le connector devrait se connecter tel quel.

Surtout, le pont push→pull existe déjà : `wait_for_message` (`src/tools/mqtt-tools.ts` l. 53) est un **long-poll** — bloquant, défaut 15 s, plafonné à `MAX_WAIT_TIMEOUT_SECONDS = 300` (l. 22) — doublé de `get_queued_messages` (l. 80) pour le drainage non bloquant. C'est exactement la forme qu'un agent Messages API peut consommer. La question n'est donc pas « comment porter le push », mais « ce long-poll survit-il au timeout HTTP du connector, et à quel seuil ». À défaut, le chemin documenté par Anthropic est le **tool runner client-side** : l'utilisateur garde son propre client MCP, reçoit les notifications, et injecte les événements dans la conversation — un pattern à coder et documenter, pas une simple config.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/server-setup.ts` | L. 237-247 : les 26 outils sont enregistrés via les six `register*Tools` de `src/tools/`. Aucun `registerResource` / `registerPrompt` dans tout le repo → la surface MCP est **déjà tools-only**, donc nativement compatible connector. Rien à porter. |
| `src/tools/mqtt-tools.ts` | Le pont push→pull. `wait_for_message` l. 53 (long-poll, défaut 15 s, cap `MAX_WAIT_TIMEOUT_SECONDS = 300` l. 22), `get_queued_messages` l. 80, `mqtt_publish` l. 96. C'est la seule façon dont un agent Messages API peut « recevoir » un événement. À tester contre le timeout réel du connector. |
| `cli/channel.ts` | L. 465 : émission de `notifications/claude/channel`. Notification serveur→client, **hors périmètre du connector par construction**. Le mode push reste réservé aux clients MCP complets. |
| `src/sse-emitter.ts` | Canal de push interne (listeners bornés, `MAX_SSE_CLIENTS`). Alimente le dashboard, jamais le modèle via connector. |
| `src/serve-http.ts` | L. 349 `text/event-stream` et l. 732 route `GET /api/events` : SSE applicatif, hors MCP. L. 740 route `/mcp` + l. 801 `StreamableHTTPServerTransport` : le transport attendu par le connector est déjà là. |
| `src/mqtt-broker.ts`, `src/mqtt-bridge.ts` | ~34 Ko de bus. Invisible depuis la Messages API sauf à passer par `wait_for_message`. Argument à assumer dans le positionnement. |
| `src/http/origin.ts` | L. 15 : absence d'`Origin` → autorisé. Les appels serveur-à-serveur d'Anthropic passent la validation DNS-rebinding sans changement. |
| `src/auth/service-tokens.ts`, `cli/service-tokens.ts` | Seul mécanisme d'auth compatible avec `authorization_token` (bearer statique). Question de TTL et de scope à trancher pour ce cas d'usage. |
| `src/auth/device-flow.ts`, `src/auth/refresh-rotation.ts` | Court-circuités : le connector ne fait pas de device flow ni de refresh. Le chemin d'auth « riche » du projet ne sert pas ici. |
| `src/security/audit-chain.ts` | Chaîne d'audit — argument de conformité affaibli par la non-éligibilité ZDR du connector. À mentionner dans la doc plutôt qu'à corriger dans le code. |
| `README.md` | L. 44 (« see each other's actions in real-time »), l. 415 (« All events arrive via SSE on `/api/events`. No polling. »), l. 511 (« Any MCP client »). Ces claims doivent être qualifiés : vrais pour les clients MCP complets, faux via le MCP connector. |
| `docs/operating-modes.md` | Tableau polling vs push. Manque une troisième colonne ou une note « MCP connector (Messages API) » : polling forcé, exposition publique, bearer statique, pas de ZDR. |
| `docs/ARCHITECTURE.md` | Description des transports ; à compléter avec le régime connector. |
| `examples/fly-io/`, `examples/nginx-reverse-proxy/`, `examples/traefik-reverse-proxy/` | Recettes d'exposition publique déjà présentes — prérequis du connector, donc pas de travail neuf d'infra à produire. |
| `sdk/src/client.ts` | SDK client TS. Si on code le chemin « tool runner client-side », c'est le voisin naturel — mais c'est un second client MCP à maintenir, pas une extension du SDK actuel. |
| `cli/doctor.ts` | Aucun diagnostic d'exposition publique / joignabilité externe aujourd'hui. Candidat pour un check « ce daemon est-il atteignable par le MCP connector ? ». |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Assume-t-on que la Messages API restera en **polling forcé** — en faisant de `wait_for_message` (long-poll, cap 300 s) le contrat officiel côté API et en requalifiant explicitement le claim « temps réel » comme réservé aux clients MCP complets — ou code-t-on un **chemin de première classe** basé sur le tool runner client-side du SDK (`mcpTools` + `toolRunner()`), qui suppose de maintenir un second client MCP et un injecteur d'événements MQTT en messages mid-conversation, en doublon fonctionnel de `cli/channel.ts` ?

### 6.2 Hypothèse

**Cadrage.** Fiche de **menace** (`Nature: threat`) : je ne cherche rien à adopter. Le livrable est une **frontière factuelle** — ce que le connector voit, ce qu'il ne voit pas, ce qui reste défendable — et le verdict porte sur la **réponse**, pas sur l'adoption.

**Ce que je pense avant de mesurer.** La menace est réelle mais la fiche se trompe de gravité, dans les deux sens.

*Moins grave qu'annoncé* : la surface MCP du projet est déjà 100 % tools-only (§0 l'a vérifié), donc rien à porter. Et le public visé n'existe pas — `E08` vient de mesurer qu'aucun intégrateur ne pilote la boucle Messages API ; l'orchestrateur attesté par le produit (`cli/init.ts:86`, `docs/usage.md:159`) orchestre des **sessions Claude Code par hooks**, jamais `messages[]`.

*Plus grave qu'annoncé* : la fiche traite les claims du README comme un détail de §5 (« ces claims doivent être qualifiés »). Or ce sont des affirmations **publiées** qui sont fausses pour une classe entière de clients, dans un fichier lu avant toute autre chose. C'est le même motif que #333 (la page produit affichait quinze fois une version inexistante) et que la famille des « garde-fous fantômes » : **le dépôt promet plus qu'il ne tient.**

**Et la question que la fiche ne pose pas.** §4 fait de `wait_for_message` le pont push→pull et déclare : « la question n'est donc pas *comment porter le push*, mais *ce long-poll survit-il au timeout HTTP du connector* ». C'est présupposer que le long-poll fonctionne. Je ne peux pas mesurer le timeout du connector, mais je peux mesurer ce que la fiche saute : **`wait_for_message` tient-il réellement sa promesse en local ?** Vu ce que ce corpus a produit jusqu'ici — `get_thread_updates` qui perd tous les messages hors UTC (#346), le sweeper qui casse sa propre chaîne (#348), les refus SSE invisibles (#353) — vérifier le pont avant de discuter de son timeout est le seul ordre honnête.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

Ici, « adopter » signifie **coder le chemin de première classe** (tool runner client-side + injecteur d'événements). Un seul critère qui se déclenche le tue.

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **Aucune audience.** Coder un second client MCP pour une population vide. | **0** issue, discussion ou exemple attestant un agent Messages API branché sur le coordinateur |
| **K2** | **Le doublon est réel.** Si l'injecteur d'événements réimplémente ce que `cli/channel.ts` fait déjà, c'est un second runtime à maintenir pour la même fonction. | ≥ **50 %** de la logique de `cli/channel.ts` à réécrire |
| **K3** | **Le pont existant est cassé.** Si `wait_for_message` ne tient pas sa promesse en local, discuter de son comportement derrière le connector est prématuré — et le livrable change de nature. | comportement observé ≠ contrat annoncé, **démontré par exécution** |
| **K4** | **Le prérequis d'exposition publique contredit le produit.** | `cli/init.ts` vend un daemon localhost **et** le connector exige HTTPS public — les deux vérifiés dans le dépôt |
| **K5** | **Le régime connector n'est documenté nulle part**, alors que le README affirme le contraire. | ≥ **2** claims du `README.md` faux pour un agent Messages API, **cités verbatim** |
| **K6** | **La beta bouge.** Un header déjà remplacé une fois. | `mcp-client-2025-04-04` déprécié, confirmé sur la doc du jour |

**Règle que je m'impose :** §0 classe la fiche ⚠️ **partielle** — les trois mesures côté connector (seuil de coupure, invisibilité empirique des notifications, coût du `toolRunner()`) exigent une exposition HTTPS publique et une clé API beta. Elles ne peuvent donc **jamais** recevoir `adopter`, et la frontière entre exécuté et non exécuté doit être explicite en §6.4.

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Vérification 2026-08-14 : les quatre premières cases exigent une instance publiquement joignable en HTTPS et une clé API Anthropic autorisée sur `anthropic-beta: mcp-client-2025-11-20` — indisponibles sur le poste actuel. Seule la dernière case (et le cap 300 s côté serveur) est exécutable en local.

- [ ] Exposer une instance publiquement (recette `examples/fly-io/` ou `examples/nginx-reverse-proxy/`), émettre un service token via `cli/service-tokens.ts`, et appeler `/v1/messages` avec `anthropic-beta: mcp-client-2025-11-20` + `mcp_servers: [{type:"url", url:"…/mcp", authorization_token:"<token>"}]`. Confirmer que les 26 outils sont listés et qu'un `mcp_tool_use` aboutit.
- [ ] Mesurer par dichotomie (15 s / 60 s / 120 s / 300 s) le seuil auquel `wait_for_message` est coupé par le timeout HTTP du connector. C'est le chiffre qui décide si le long-poll est un vrai substitut au push ou un gadget.
- [ ] Vérifier empiriquement qu'aucune `notifications/claude/channel` ni aucune notification MCP serveur→client n'atteint le modèle via le connector — la doc ne l'énonce pas littéralement, l'exclusion est une déduction (cf. §2).
- [ ] Monter un PoC minimal du chemin alternatif : `@anthropic-ai/sdk/helpers/beta/mcp` + `anthropic.beta.messages.toolRunner()` contre le serveur stdio `cli/channel.ts`, pour chiffrer le coût réel du « client-side MCP helper » (lignes de code, dépendances, surface de maintenance).
- [ ] Vérifier que `src/http/origin.ts` ne bloque effectivement pas l'appel entrant d'Anthropic (absence d'`Origin`), et relever ce que `cli/doctor.ts` devrait diagnostiquer pour cette topologie.

### 6.4 Résultat observé

#### A. Ma mesure principale reproduisait le contrat publié — je la retire comme découverte

J'ai simulé une boucle Messages API tour par tour contre le vrai `MqttBridge` (harnais `FakeMqttClient` du dépôt) :

```
avant tout appel : 2 messages publies, listeners=0
TOUR 1 -> null (timeout)
  les 2 d'avant sont PERDUS ; listeners=1
entre les tours : 5 messages publies (3..7)
TOUR 2 -> {"n":3}
TOUR 3 -> {"n":4}
  reste apres 2 tours : 3 -> 5,6,7
offline : listeners 1 -> 0
  file au retour : 0 => backlog DETRUIT
```

**Trois de ces quatre faits sont écrits verbatim dans le README que j'accusais de mentir**, aux lignes 295-313, sous le titre *« MQTT here is best-effort push, not the record of truth »* :

> - « Nothing is buffered for an agent with no live listener — a message that arrives before `wait_for_message`/`get_queued_messages` registers **is gone**. »
> - « `get_queued_messages` **drains**: the messages are removed as you read them, so a second call returns nothing and a crash mid-processing loses them. »
> - « Listener queues are capped and **drop oldest-first** under load. »
>
> et la conclusion : « For delivery you can rely on, use the thread APIs — `post_to_thread` + `get_thread_updates` are backed by SQLite and survive restarts. »

Le quatrième — la destruction du backlog au passage offline — n'est pas au README mais est **délibéré et testé** : commentaire `performance-05` à `src/mqtt-bridge.ts:183-188`, et test nommé *« drops the departed agent's backlog (no residual growth across reconnects) »* (`tests/unit/mqtt-bridge-bounded.test.ts:129-140`).

**K3 ne se déclenche donc pas** : son seuil était « comportement observé ≠ contrat annoncé ». Les quatre observations **égalent** le contrat annoncé. J'ai mesuré la liste de mises en garde du projet et je l'ai prise pour une découverte.

#### B. Et un de mes quatre faits était simplement faux

J'allais écrire que `wait_for_message` rend un message par tour, donc N tours pour N messages. **Faux, et je l'ai vérifié :**

```
file remplie : 5 messages (3..7)
APPEL 1  wait_for_message    -> {"n":3}
APPEL 2  get_queued_messages -> [4,5,6,7]
reste : 0
=> 5 messages recuperes en 2 appels, pas en 5 tours.
```

`waitForMessage` fait un `shift()` (`src/mqtt-bridge.ts:430`) et **laisse le reste en file** ; `getQueuedMessages` (`:445-451`) le draine. Le motif correct pour un agent connector est donc `wait_for_message` → `get_queued_messages` : **deux appels quelle que soit la taille du lot**, et il est déjà disponible.

Corollaire qui atténue la destructivité : dans une boucle `/v1/messages`, le `mcp_tool_result` est persisté dans `messages[]` **par l'appelant**. Le régime connector est le seul où le drain destructif est le moins grave.

#### C. Le seul défaut réel, et il est petit — mais il coûte un appel API par message

`src/tools/mqtt-tools.ts:75-80` :

```ts
const msg = await mqttBridge.waitForMessage(claims.org, agent_id, timeoutMs);
if (msg) {
  return { content: [{ type: "text", text: JSON.stringify(msg) }] };
}
return { content: [{ type: "text", text: JSON.stringify({ timeout: true }) }] };
```

**Rien n'indique au modèle qu'il reste 4 messages en file.** Un agent qui reçoit un message nu ne peut pas savoir que `get_queued_messages` en récupérerait quatre autres d'un coup : il rebouclera sur `wait_for_message`, un tour par message — c'est-à-dire qu'il produira **exactement le comportement N-tours que j'ai cru mesurer**. Dans le régime connector, où chaque tour est un appel `/v1/messages` facturé, c'est le seul endroit où la menace de cette fiche a une conséquence chiffrable.

Deux champs suffisent : `queued_remaining` sur le retour de succès, et un indice d'enregistrement sur le `{ timeout: true }`. **Non couvert par #236**, qui demande une persistance SQLite, `clean:false` et une consommation à ack avec `batch_id` — un design bien plus lourd.

#### D. La menace est réelle, et la surface est bien compatible — mais pas pour la raison que dit §4

Vérifié : **aucun `registerResource` ni `registerPrompt`** dans `src/` ni `cli/` (les seules occurrences du dépôt sont dans `research/` et `audit/`). Et `src/http/origin.ts:15` laisse bien passer une requête sans en-tête `Origin` (« client non-navigateur (curl, SDK MCP) »), donc le connector se connecterait.

**Mais §4 appelle cette surface tools-only « la bonne nouvelle, rien à porter » — et c'est le point aveugle de la fiche.** L'issue **#325** (ouverte) établit qu'en mode *sessionless*, `ctx.sessionId` est `undefined` et **les 26 outils lèvent** : panne totale, pas dégradation. Le client MCP hébergé par Anthropic ouvre une session par requête, et le SDK v2 sert le trafic 2025 en `'stateless'` par défaut. Si le connector n'honore pas le round-trip `mcp-session-id`, la menace n'est pas « pas de push » mais **aucun outil appelable**. Ce risque domine tout le reste de la fiche et n'y figure ni en §4, ni en §5, ni dans mes propres critères.

#### E. Le problème de documentation est réel mais quatre fois plus petit que je l'écrivais

Adjudication ligne par ligne des quatre claims que je comptais citer :

| Ligne | Section | Verdict honnête |
|---|---|---|
| `README.md:44` « agents see each other's actions in **real-time** » | pitch, `## The Problem` | **Surpromesse réelle** — mais **pas** connector-spécifique (voir ci-dessous) |
| `README.md:162` « receive every coordination event in real-time — no polling » | `### MQTT layer` | **Hors sujet** : conditionné à « Agents *subscribe* once ». Un agent connector ne souscrit pas à MQTT ; la phrase décrit le contrat de la couche pour ses abonnés (`examples/python-mqtt`, `go-mqtt`, `node-mqtt`) |
| `README.md:436` « All events arrive via SSE on `/api/events`. No polling. » | `## Dashboard` | **Hors sujet et vrai** : c'est le client navigateur du dashboard |
| `README.md:532` « **Any MCP client** — connect to `http://localhost:3100/mcp` » | `## Integration patterns` | Pas un claim temps réel. Ce qui est faux, c'est `http://localhost` (le connector exige `https://` public) et surtout « The server speaks **MCP 2024-11-05** », périmé — famille **#333** |

**Un claim sur quatre, pas quatre. K5 ne se déclenche donc pas à son seuil de ≥ 2.**

Et `README.md:76` **contredit** ma thèse plutôt que de la nuancer. Verbatim : *« agents can either poll the daemon's MCP tools (**default**, works since v0.6) or accept push events through the Channels sidecar (v0.12+, **research preview**) »* — le push est un research preview derrière `--dangerously-load-development-channels` (`README.md:119`). Donc **`README.md:44` est déjà faux pour une session Claude Code stock**, pas seulement via le connector. La phrase de §5 de cette fiche — « vrais pour les clients MCP complets, faux via le MCP connector » — est **fausse dans ses deux moitiés**.

De même, « le régime connector n'est documenté nulle part » est faux : `docs/clients.md:209` dit « Remote connector: needs a **publicly reachable URL**, and `static_headers` for the token — that field is a **beta you have to request** », et `:111-114` avertit que tunneler met « the whole 26-tool surface on the public internet, writes included ». Ce qui reste réellement absent est plus étroit : le chemin `/v1/messages` + `mcp_servers` en tant que tel, l'énoncé explicite « aucun push n'atteint un agent connector », et la **non-éligibilité ZDR**.

Note enfin que `docs/operating-modes.md:3` est **explicitement scopé à Claude Code** (« your **Claude Code session** can consume coordination state in one of two ways ») : il n'est pas faux, il est silencieux. Et son mode « Polling » désigne `coordinator_status` / `list_threads`, **jamais `wait_for_message`**.

#### F. Adjudication des six critères pré-enregistrés

| # | Seuil | Mesure | Verdict |
|---|---|---|---|
| **K1** | 0 agent Messages API / connector attesté | **0** issue mentionne le connector ou `/v1/messages`. *Réserve honnête :* #236 atteste un consommateur programmatique **non-Claude-Code** réel (org Mekova, 2026-07-23, workers k8s pollant les outils MCP toutes les 30 s) — donc « audience nulle » vaut pour le **connector**, pas pour le chemin polling | **SE DÉCLENCHE** (pour le connector) |
| **K2** | ≥ 50 % de la logique de `cli/channel.ts` à réécrire | `buildChannelNotification` fait **78 lignes sur 570** (14 %) | **NE SE DÉCLENCHE PAS à son seuil.** Ce qui serait dupliqué est un **second runtime de client MCP**, pas une fonction de traduction — mon critère mesurait la mauvaise chose |
| **K3** | comportement ≠ contrat annoncé | les 4 observations **égalent** le contrat, 3 verbatim au `README.md:295-313`, la 4ᵉ délibérée et testée | **NE SE DÉCLENCHE PAS** |
| **K4** | localhost par défaut **et** HTTPS public exigé | `cli/init.ts:140` par défaut sur `http://localhost:3100` ; le connector exige `https://` public. *Mais* `cli/init.ts:637` propose `https://coord.acme.example` et `docs/clients.md:50` documente `--url https://…` | **SE DÉCLENCHE au sens littéral** — « contredit le produit » est trop fort : localhost n'est qu'un **défaut**, pas une contrainte |
| **K5** | ≥ 2 claims faux, verbatim | **1** sur 4 (`README.md:44`), et il est faux pour le **mode par défaut**, pas seulement pour le connector | **NE SE DÉCLENCHE PAS à son seuil** |
| **K6** | header déjà remplacé une fois | `mcp-client-2025-04-04` déprécié, `mcp-client-2025-11-20` courant | **SE DÉCLENCHE** |

**Deux critères se déclenchent proprement (K1, K6), un au sens littéral avec une réserve (K4), trois ne se déclenchent pas (K2, K3, K5).** Trois de mes six seuils étaient mal posés : K2 mesurait une fonction là où le coût est un runtime, K3 et K5 accusaient le dépôt d'un silence qu'il ne garde pas.

#### G. Dérive des références de la fiche

§0 affirme « **toutes les lignes citées sont exactes** ». Au HEAD, non :

| Fiche | Réel |
|---|---|
| `src/tools/mqtt-tools.ts` l. 22 / 53 / 80 / 96 | **24** / **55** / **85** / **109** |
| `src/server-setup.ts` l. 237-247 (les 6 `register*Tools`) | **252-257** (237-247 est le bloc `instructions` de #271) |
| `README.md` l. 415 / 511 | **436** / **532** (415 = `## Token Observability`) |
| `grep -c "server.tool(" src/tools/*.ts` → 26 | **0** partout — le code utilise `registerTool` depuis la migration SDK v2 (#286). Le total de 26 est juste, la **commande** citée ne l'est pas |

`src/http/origin.ts:15` est la seule référence exacte.

### 6.5 Contre-arguments

- **Beta mouvante.** Le header courant est `mcp-client-2025-11-20` et son prédécesseur `mcp-client-2025-04-04` est déjà déprécié. Documenter et coder pour une surface qui a changé une fois en sept mois, c'est s'engager à la resuivre.
- **Le public visé n'est peut-être pas là.** Les utilisateurs réels du projet sont sur des clients MCP complets (Claude Code, Cursor, Cline), qui reçoivent le push sans effort. Aucun signal de demande pour un agent Messages API branché sur le coordinateur. YAGNI franc.
- **Non disponible sur Bedrock ni Google Cloud.** Une part significative des déploiements entreprise ne pourra de toute façon pas utiliser le connector : l'effort ne sert qu'un sous-ensemble d'un sous-ensemble.
- **Exposition publique obligatoire.** Elle contredit le profil d'auto-hébergement « daemon localhost » vendu par `cli/init.ts`, élargit la surface d'attaque et transfère à l'utilisateur la charge du TLS, du reverse proxy et du durcissement.
- **Auth régressive.** `authorization_token` est un bearer statique : cela rend inutiles `src/auth/device-flow.ts` et `src/auth/refresh-rotation.ts` et pousse vers des service tokens à longue durée de vie — un recul de posture par rapport à ce que le projet a construit.
- **Pas de ZDR.** Le connector n'est pas couvert par les accords zero data retention, ce qui contredit frontalement l'argumentaire conformité (multi-org, `src/security/audit-chain.ts`) adressé aux équipes régulées.
- **Le chemin alternatif est un doublon.** Coder un tool runner client-side avec injection d'événements MQTT revient à réimplémenter, dans un second runtime, ce que `cli/channel.ts` fait déjà pour Claude Code — pour une audience aujourd'hui nulle.
- **Une simple mise à jour de doc peut suffire.** Corriger les claims « real-time / no polling » du README et ajouter une ligne à `docs/operating-modes.md` traite l'essentiel du risque de crédibilité pour un coût quasi nul. Tout ce qui va au-delà doit se justifier par un utilisateur nommé.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** |
| **Date** | 2026-08-17 |
| **Justification** | Fiche de **menace** : le verdict porte sur la **réponse**, pas sur l'adoption. ⭑ **Refusé — le chemin de première classe** (tool runner client-side + injecteur d'événements). K1 : **zéro** issue mentionne le connector ou `/v1/messages`, et le seul consommateur programmatique attesté (#236, org Mekova, workers k8s toutes les 30 s) **polle déjà très bien** les outils MCP sans tool runner. K6 : la beta a déjà changé de header une fois. ⭑ **La frontière factuelle, qui est le livrable de cette fiche.** Le connector se connecterait sans changement — surface **100 % tools-only** vérifiée (aucun `registerResource`/`registerPrompt` dans `src/` ni `cli/`) et `src/http/origin.ts:15` laisse passer une requête sans `Origin`. Et le chemin de réception existe déjà, en **deux appels quelle que soit la taille du lot** : `wait_for_message` (qui `shift()` un message) puis `get_queued_messages` (qui draine le reste) — mesuré. ⭑ **Le point aveugle de la fiche domine tout le reste** : §4 appelle la surface tools-only « la bonne nouvelle, rien à porter », mais **#325** établit qu'en mode *sessionless* `ctx.sessionId` est `undefined` et **les 26 outils lèvent**. Si le connector n'honore pas le round-trip `mcp-session-id`, la menace n'est pas « pas de push » mais **aucun outil appelable**. Cela n'apparaît ni en §4, ni en §5. ⭑ **Corrections de méthode — trois de mes six seuils étaient mal posés.** **K3 ne se déclenche pas** : mes quatre « découvertes » (premier tour vide, file plafonnée drop-oldest, drain destructif, backlog détruit à l'offline) sont **trois puces verbatim du `README.md:295-313`** — *« MQTT here is best-effort push, not the record of truth »* — plus un comportement délibéré et testé (`performance-05`). **J'ai mesuré la liste de mises en garde du projet et je l'ai prise pour une découverte.** **Un de mes faits était simplement faux** : `wait_for_message` ne coûte pas N tours pour N messages, mais 2 appels. **K5 ne se déclenche pas** : **un** claim faux sur quatre (`README.md:44`), pas deux ; et il est faux pour le **mode par défaut** — le push est un *research preview* derrière un flag (`README.md:76`, `:119`) — donc la phrase de §5 « vrais pour les clients MCP complets, faux via le connector » est fausse dans ses **deux** moitiés. « Documenté nulle part » est faux aussi : `docs/clients.md:209` et `:111-114` documentent l'URL publique, le `static_headers` en beta sur demande, et le risque des 26 outils exposés. **K2 ne se déclenche pas à son seuil** (78 lignes sur 570, soit 14 %) : mon critère mesurait une fonction de traduction là où le coût réel est un second runtime de client MCP. **K4 se déclenche au sens littéral** mais « contredit le produit » est trop fort — localhost n'est qu'un défaut (`cli/init.ts:637` propose déjà une URL publique). |
| **Issue / PR** | **#357** — `wait_for_message` ne renvoie pas la profondeur de file, donc un agent facturé au tour rebouclera un tour par message au lieu d'appeler `get_queued_messages` une fois. Non couvert par #236. Reste non traité, à ne pas oublier : le régime `/v1/messages` + `mcp_servers`, l'énoncé explicite « aucun push n'atteint un agent connector », la **non-éligibilité ZDR**, et `README.md:44` qui surpromet du temps réel que le mode par défaut ne rend pas (famille #333 pour le `MCP 2024-11-05` périmé de `README.md:532`). |
| **Jalon visé** | Aucun pour le tool runner. #357 est petit et sans urgence. **Le vrai préalable est #325** : tant qu'on ne sait pas si le connector honore `mcp-session-id`, la compatibilité tools-only que §4 présente comme acquise n'est pas établie. Corriger les références dérivées de §0/§5 de cette fiche au passage. |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : doc et lignes de code exactes ; date du header corrigée ; §2 complété. |
| 2026-08-17 | **Challenge — verdict `refuser` le chemin de première classe ; la frontière factuelle est le livrable.** K1 : **zéro** issue mentionne le connector ou `/v1/messages`, et le seul consommateur programmatique attesté (#236, org Mekova, workers k8s toutes les 30 s) polle déjà les outils MCP sans tool runner. Frontière établie : le connector se connecterait sans changement — surface **100 % tools-only** (aucun `registerResource`/`registerPrompt`) et `src/http/origin.ts:15` passe sans `Origin` — et la réception existe en **deux appels quelle que soit la taille du lot** : `wait_for_message` (`shift()`) puis `get_queued_messages` (drain), mesuré. **Point aveugle de la fiche, qui domine tout le reste** : §4 appelle la surface tools-only « la bonne nouvelle, rien à porter », mais **#325** établit qu'en mode *sessionless* `ctx.sessionId` est `undefined` et **les 26 outils lèvent** — si le connector n'honore pas `mcp-session-id`, la menace n'est pas « pas de push » mais « aucun outil appelable ». **Trois de mes six seuils étaient mal posés, et je les retire.** **K3 ne se déclenche pas** : mes quatre « découvertes » sont **trois puces verbatim du `README.md:295-313`** (« MQTT here is best-effort push, not the record of truth ») plus un comportement délibéré et testé (`performance-05`, `mqtt-bridge-bounded.test.ts:129-140`) — j'ai mesuré la liste de mises en garde du projet et je l'ai prise pour une découverte. **Et un de mes faits était faux** : `wait_for_message` ne coûte pas N tours pour N messages mais **2 appels**. **K5 ne se déclenche pas** : **un** claim faux sur quatre (`README.md:44`), et il l'est pour le **mode par défaut** — le push est un research preview derrière un flag (`:76`, `:119`) — donc la phrase de §5 « vrais pour les clients MCP complets, faux via le connector » est fausse dans ses deux moitiés ; et `docs/clients.md:209` / `:111-114` documentent déjà l'URL publique et le `static_headers` en beta. **K2 ne se déclenche pas à son seuil** (78 lignes sur 570 = 14 %) : mon critère mesurait une fonction là où le coût est un second runtime. **K4** se déclenche littéralement mais « contredit le produit » est trop fort (localhost n'est qu'un défaut, `cli/init.ts:637`). **Dérive des références corrigée** : `mqtt-tools.ts` 22/53/80/96 → **24/55/85/109** ; `server-setup.ts` 237-247 → **252-257** ; `README.md` 415/511 → **436/532** ; et `grep -c "server.tool("` rend **0** partout depuis la migration SDK v2 (#286) — le total de 26 est juste, la commande citée par §0 ne l'est pas. Livrable : **#357**. Restent non traités : le régime `/v1/messages` + `mcp_servers`, l'énoncé « aucun push n'atteint un agent connector », la non-éligibilité **ZDR**, et le `MCP 2024-11-05` périmé de `README.md:532` (famille #333). |
