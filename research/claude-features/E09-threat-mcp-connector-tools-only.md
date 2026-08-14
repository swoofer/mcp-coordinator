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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

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

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : doc et lignes de code exactes ; date du header corrigée ; §2 complété. |
