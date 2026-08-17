# E12 — Qualité des payloads : strict tools, structured outputs, blocs `search_result`

| Champ | Valeur |
|---|---|
| **ID** | `structured-outputs-citations` |
| **Surface** | claude-api |
| **Statut** | GA (les deux mécanismes). `strict` / `output_config.format` : GA aussi sur Amazon Bedrock et Google Cloud ; sur Microsoft Foundry, support limité aux déploiements « Hosted on Anthropic » |
| **Disponible depuis** | Structured outputs : beta 2025-11-14, GA Claude API 2026-01-29. Blocs `search_result` : GA sur tous les modèles actifs sauf Claude Haiku 3 |
| **Tier** | T2-fort-levier |
| **Nature** | integration |
| **Effort estimé** | M |
| **Confiance veille** | medium (high sur structured outputs, medium sur `search_result` via MCP) |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — pas de credentials API pour tester `strict` |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — refuser ; search_result n'est pas un type MCP, et strict est deja gratuit (#363) |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **Fait central corrigé** — l'issue `anthropics/claude-agent-sdk-python#574` est **fermée** (COMPLETED, 2026-03-24), pas ouverte. Elle a été fermée en référence à la PR #650 (passthrough des blocs MCP non reconnus) ; un commentaire ultérieur signale que la PR n'était pas mergée au moment de la fermeture et décrit un **troisième blocage** non couvert : le CLI `claudecode` bundlé, par lequel le SDK parle à l'API, perd les citations en aval. Le drop reste donc plausible, mais la fiche ne peut plus s'appuyer sur « issue ouverte » comme preuve.
- Statut plateforme corrigé dans l'en-tête : la doc donne `structured outputs` / `strict` **GA sur Amazon Bedrock et Google Cloud** ; seul **Microsoft Foundry** est limité (déploiements « Hosted on Anthropic » uniquement). L'affirmation « beta publique sur Bedrock et Microsoft Foundry » était fausse. *(Le §6.5 étant gelé, il conserve cette formulation périmée — à corriger lors du challenge.)*
- §2 : marqueur `(à vérifier)` sur `mcp_tool_result` tranché en `(non vérifiable — …)`.
- §2 : `client.messages.parse()` existe aussi en TypeScript (avec `zodOutputFormat()` / `jsonSchemaOutputFormat()`), pas seulement en Python.
- §2 : ajout de la règle « citations désactivées par défaut, et tous les `search_result` d'une même requête doivent partager le même réglage ».
- §4 : « 32 occurrences vérifiées » → **21** retours `{type:"text", text: JSON.stringify(...)}` dans `src/tools/*.ts`.
- §5 : `announce_work` l. 36 → **l. 37** ; `check_file_conflict` l. 49 → **l. 50** ; « 12 sorties `JSON.stringify` » dans `consultation-tools.ts` → **8** retours de ce motif (10 `JSON.stringify` au total).

Faits confirmés sans changement : `output_config.format = {type:"json_schema", schema}`, `tools[].strict`, indisponibilité de `strict` sur `mcp_toolset`, absence de header beta (`structured-outputs-2025-11-13` maintenu en transition), cache de grammaire 24 h, schéma complet du bloc `search_result` (`source`/`title`/`content` requis, `citations`/`cache_control` optionnels), texte uniquement, règle du « tout ou rien » dans un `tool_result`, citations obligatoires si le web search tool est actif, GA sur tous les modèles actifs sauf Claude Haiku 3. Tous les fichiers cités en §5 existent, ainsi que `consultation-tools.ts` l. 122-125 et `cli/channel.ts` l. 340.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
La moitié « citations » se teste ici : on peut faire renvoyer au serveur MCP local un bloc `search_result` bien formé (via `cli/channel.ts` en stdio, ou le serveur principal) et observer depuis Claude Code si le bloc traverse, est droppé, ou lève une erreur — c'est le test direct de l'issue #574. La moitié « strict » ne se teste pas : elle exige des appels Messages API directs avec credentials Anthropic, ainsi qu'un accès au connecteur MCP distant (`mcp_toolset`) pour vérifier qu'il ignore bien `strict`. La mesure du surcoût de compilation de grammaire tombe dans le même trou.

## 1. Ce que c'est

Deux mécanismes distincts de la Messages API, réunis ici parce qu'ils concernent tous deux la **qualité du payload** échangé entre Claude et un serveur d'outils.

**(1) Sampling contraint par grammaire.** `output_config.format = {type:"json_schema", schema:{...}}` garantit que la réponse texte du modèle respecte un JSON Schema. Symétriquement, `strict: true` sur une définition d'outil garantit que le **nom** de l'outil appelé et ses **inputs** respectent le schéma déclaré — la contrainte s'applique pendant le sampling, donc avant que le serveur ne voie l'appel. La grammaire compilée est mise en cache 24 h : la première requête paie la latence de compilation, et un changement de structure de schéma réinitialise ce cache. La grammaire du mode strict se construit à partir du toolset complet, donc `strict` et `defer_loading` (tool search, cf. A06) composent sans recompilation.

**Limite qui décide de tout ici :** `strict` est disponible sur tous les types d'outils **sauf `mcp_toolset`**. Un agent qui atteint mcp-coordinator via le connecteur MCP ne bénéficie donc d'aucune garantie de forme ; un agent qui déclare les mêmes outils en direct (SDK, pont maison) en bénéficie.

**(2) Blocs `search_result`.** Un type de bloc de contenu qui permet à Claude de citer *votre* contenu avec attribution de source, exactement comme il cite les résultats de recherche web. Deux voies : renvoyé dans le `content` d'un `tool_result` d'outil personnalisé (RAG dynamique), ou fourni directement comme contenu top-level d'un message user. Les citations apparaissent automatiquement sur les blocs de texte qui s'appuient dessus, sans prompting particulier.

## 2. Surface d'API exacte

```
# Sampling contraint
output_config.format = { type: "json_schema", schema: {...} }
tools[].strict = true                      # indisponible sur mcp_toolset
client.messages.parse()                    # helper SDK Python ET TypeScript
zodOutputFormat() / jsonSchemaOutputFormat()   # fabriques de schéma, SDK TypeScript
# aucun header beta requis (l'ancien structured-outputs-2025-11-13 est en transition)

# Bloc de contenu search_result (Messages API, aucun header beta)
{ type: "search_result",
  source: "<url ou identifiant>",           # requis
  title: "<string>",                        # requis
  content: [ { type: "text", text: "..." } ],  # requis, TEXTE uniquement
  citations: { enabled: true },             # optionnel
  cache_control: { type: "ephemeral" } }    # optionnel
```

Contraintes de validation vérifiées :

- Dans un `tool_result`, si **un** bloc est `search_result`, **tous** doivent l'être — sinon erreur de validation. Le texte d'accompagnement doit être glissé dans le `content[]` d'un `search_result`.
- `content[]` n'accepte que des blocs `text` : pas d'image, pas de média.
- Si le web search tool est actif dans la même requête, `citations` doit être activé sur **tous** les blocs `search_result`.
- `citations` est **désactivé par défaut**, et tous les `search_result` d'une même requête doivent partager le même réglage.
- Les blocs `search_result` ne peuvent apparaître que dans des messages **user** (y compris à l'intérieur d'un `tool_result`) ; en message assistant ils sont rejetés.
- Le passage par un `mcp_tool_result` reste **non documenté** *(non vérifiable — la page `search-results` ne mentionne ni MCP ni `mcp_tool_result`)*. L'issue `anthropics/claude-agent-sdk-python#574` documentait un **drop silencieux** des blocs `search_result` par le handler de tool result MCP ; elle a été **fermée le 2026-03-24** en référence à la PR #650 (passthrough des types de blocs non reconnus), mais un commentaire ultérieur conteste la fermeture (PR non mergée à ce moment) et décrit un troisième blocage, en aval : le CLI `claudecode` bundlé par lequel le SDK parle à l'API. Le statut réel de la moitié « citations » de cette fiche est donc **à établir empiriquement**, pas à déduire de l'issue.

## 3. Sources

- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- https://platform.claude.com/docs/en/build-with-claude/search-results
- https://platform.claude.com/docs/en/release-notes/overview

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

*Côté entrée.* Les 26 outils MCP du serveur valident leurs arguments avec zod côté serveur (`src/tools/*.ts`). Cette validation arrive après coup : quand `announce_work` reçoit un `files_to_modify` mal formé ou un `plan` vide, l'agent a déjà brûlé des tokens à mal formuler, et `assessPlanQuality()` (`src/plan-quality.ts`) le rétrograde en mode `discovery`. Avec `strict: true`, la contrainte remonte dans le sampling : le modèle **ne peut pas** produire un appel hors schéma. Le code de validation défensive ne disparaît pas (le serveur reste exposé à des clients non-Claude), mais le taux d'annonces dégradées baisse sans travail de prompting.

*Côté sortie.* Les six fichiers d'outils renvoient tous la même chose : `{ content: [{ type: "text", text: JSON.stringify(x) }] }` (21 occurrences vérifiées dans `src/tools/*.ts`). Or mcp-coordinator produit des **affirmations qui demandent des preuves** : « ce fichier est en conflit » (`src/conflict-detector.ts`), « cette dépendance existe » (`src/dependency-map.ts`), « cet agent a annoncé ceci » (`src/consultation.ts`). En les renvoyant en blocs `search_result` — `source` = chemin de fichier ou id de thread, `title` = nature du conflit — Claude **cite** l'évidence au lieu de l'affirmer. Dans un contexte multi-agents où l'agent doit convaincre son humain d'arrêter d'éditer un fichier, l'attribution vaut plus que la formulation.

*Bénéficiaire concret.* L'utilisateur qui lit le dashboard ou la sortie de son agent et veut savoir *d'où sort* une alerte de conflit, sans relire les logs du coordinateur.

**Risque si on ne fait rien :** aucun risque de rupture. Le coût est un coût d'occasion : les payloads restent des blobs JSON opaques, et la qualité des inputs continue de dépendre du prompting des agents clients.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/tools/consultation-tools.ts` | 11 outils (`announce_work` → `log_action_summary`). Le plus gros gisement : `announce_work` (l. 37) a le schéma d'entrée le plus riche et donc le plus à gagner de `strict` ; les 8 sorties `{type:"text", text: JSON.stringify(...)}` sont candidates à `search_result` (thread comme source citable). |
| `src/tools/files-tools.ts` | `check_file_conflict` (l. 50) renvoie un verdict de conflit en texte brut ; candidat n°1 pour `search_result` avec `source` = `file_path`. |
| `src/tools/dependencies-tools.ts` | `get_blast_radius` / `get_module_info` : réponses factuelles adossées à une carte de dépendances, donc citables par module. |
| `src/tools/agents-tools.ts`, `src/tools/status-tools.ts`, `src/tools/mqtt-tools.ts` | 9 outils restants, mêmes retours `{type:"text"}`. Impact faible côté citations, mais concernés si on change le contrat de sortie globalement. |
| `src/conflict-detector.ts` | Produit les objets `conflicts` persistés en base (`consultation-tools.ts` l. 122-125). C'est la source de vérité qu'il faudrait enrichir d'un `source` / `title` exploitables. |
| `src/announce-workflow.ts` | Orchestration partagée MCP + REST. Tout changement de forme de payload doit passer par ici pour ne pas re-diverger entre les deux transports (le fichier documente déjà que les payloads `thread_opened` MCP et REST diffèrent). |
| `src/plan-quality.ts` | `assessPlanQuality()` compense aujourd'hui l'absence de contrainte à la saisie. `strict` ne le remplace pas (il contraint la forme, pas la qualité sémantique) mais réduit le nombre de plans vides. |
| `src/http/rest-schemas.ts` | 16 schémas zod côté REST. Si on exporte des JSON Schema pour usage `strict` en direct, c'est le point où les deux surfaces doivent rester alignées. |
| `sdk/src/client.ts` | `McpCoordinatorClient` : seul endroit d'où l'on pourrait exposer les schémas d'outils en JSON Schema exportable, pour les agents qui déclarent les outils en direct et veulent `strict` (impossible via `mcp_toolset`). |
| `cli/channel.ts` | Serveur MCP stdio des Channels — enregistre ses outils via `setRequestHandler(ListToolsRequestSchema)` (l. 340) et non `server.tool()`. Surface distincte : toute décision doit être répliquée ici manuellement. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Étant donné que `strict` est indisponible sur `mcp_toolset` et que les blocs `search_result` sont apparemment droppés par le handler de tool result MCP, mcp-coordinator doit-il exporter ses schémas d'outils et ses payloads « citables » via `sdk/src/client.ts` pour les agents en connexion directe — au prix d'un second contrat à maintenir en parallèle des 26 outils MCP — ou rester strictement MCP et considérer ces deux mécanismes comme hors de portée tant qu'ils ne traversent pas le connecteur ?

### 6.2 Hypothèse

**Ce que je pense avant de mesurer.** §6.1 et §6.5 débattent tous deux du même niveau : est-ce que `search_result` **traverse** le connecteur MCP, et l'issue upstream #574 est-elle la preuve ? Je pense que la question se règle **un étage plus bas**, et localement.

`search_result` est un type de bloc de la **Messages API d'Anthropic**. MCP a son propre jeu de types de contenu pour un résultat d'outil (`text`, `image`, `audio`, `resource`, `resource_link`). Un serveur MCP qui renverrait `{type: "search_result", …}` renverrait donc un type **qui n'existe pas dans le protocole qu'il parle**. Si le schéma de `CallToolResult` du SDK installé le rejette, alors la moitié « citations » de cette fiche est morte **avant** d'atteindre le handler dont #574 parle — et tout le débat sur le drop silencieux est hors sujet.

C'est mesurable ici, sans credentials, et c'est le seul ordre honnête : vérifier que le bloc est **émissible** avant de discuter de son transport.

Hypothèse secondaire : la voie de contournement que §6.1 envisage — « exporter les schémas via `sdk/src/client.ts` » — est déjà réfutée par le challenge d'`E10`, qui a mesuré que ce fichier est **intégralement** de la plomberie OAuth, sans aucune méthode de données de coordination. Il n'y a rien d'où exporter : il faudrait d'abord construire une API de données.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

Ici, « adopter » signifie **exporter les schémas et des payloads citables pour les agents en connexion directe**. Un seul critère qui se déclenche le tue.

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **Le bloc n'est pas émissible depuis un serveur MCP.** Si le schéma de résultat d'outil du SDK MCP installé rejette `type: "search_result"`, la moitié « citations » est morte sous le niveau où la fiche argumente. | le schéma `CallToolResult` **rejette** `type: "search_result"`, vérifié par exécution |
| **K2** | **Le chemin d'accès principal ne bénéficie pas de `strict`.** | `strict` confirmé indisponible sur `mcp_toolset` sur la doc du jour |
| **K3** | **Il n'y a rien d'où exporter.** La voie de §6.1 passe par `sdk/src/client.ts`. | **0** méthode de données de coordination dans `sdk/src/client.ts` |
| **K4** | **Une troisième surface à répliquer à la main.** `cli/channel.ts` écrit son schéma à la main via `setRequestHandler(ListToolsRequestSchema)`. | ≥ **3** endroits où une décision de forme doit être répliquée |
| **K5** | **Aucune demande.** | **0** issue ou discussion réclamant des payloads citables ou des schémas stricts |
| **K6** | **Rupture de portabilité.** Un bloc propre à Anthropic renvoyé à tout client MCP. | `search_result` **absent** du jeu de types de contenu du protocole MCP |

**Règle que je m'impose :** §0 classe la fiche ⚠️ **partielle** — tout ce qui touche `strict` exige des credentials. Cela ne peut **jamais** recevoir `adopter`. Et j'applique les leçons accumulées : **grepper la doc du dépôt avant de crier à la découverte** (`E09`), **vérifier une absence au lieu de la supposer** (`E08`, `E10`), et **ne pas laisser un seul seuil décider de plusieurs changements indépendants** (`E11`).

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Non exécutable ici : tout ce qui touche `strict` (déclaration directe en Messages API, vérification que `mcp_toolset` l'ignore, mesure de la latence de compilation de grammaire) exige des credentials API Anthropic et un accès au connecteur MCP distant, dont on ne dispose pas sur ce poste.

- [ ] Appeler `check_file_conflict` depuis un vrai client Claude via le connecteur MCP, en faisant renvoyer au serveur un `content[]` contenant un bloc `search_result` bien formé ; observer si le bloc arrive au modèle, est droppé silencieusement, ou déclenche une erreur de validation (test direct de l'issue `claude-agent-sdk-python#574`).
- [ ] Même test via `cli/channel.ts` (stdio) pour savoir si le comportement diffère entre transport HTTP/connecteur et stdio.
- [ ] Vérifier empiriquement qu'un client passant par `mcp_toolset` ignore bien tout `strict` déclaré côté serveur : déclarer un schéma volontairement restrictif sur `announce_work` et tenter un appel hors schéma.
- [ ] Depuis `sdk/src/client.ts`, exporter le JSON Schema de `announce_work` et le déclarer en direct avec `strict: true` dans une requête Messages API ; mesurer le taux de plans rétrogradés par `assessPlanQuality()` avec et sans, sur un échantillon d'annonces.
- [ ] Mesurer le surcoût de latence de la première requête (compilation de grammaire) et vérifier la persistance du cache 24 h sur un schéma stable.

### 6.4 Résultat observé

#### A. La moitié « citations » est morte deux étages sous le niveau où la fiche argumente

`ContentBlockSchema` du protocole (paquet **`@modelcontextprotocol/core`**, « public Zod schemas (spec + OAuth/OpenID) ») est une union **fermée de cinq options**, toutes sans `catchall` :

```
type d'union : union | options : 5
  ["text"]           catchall: false
  ["image"]          catchall: false
  ["audio"]          catchall: false
  ["resource_link"]  catchall: false
  ["resource"]       catchall: false

CallToolResult text          : ACCEPTE
CallToolResult search_result : REJETE
```

`search_result` a **0 occurrence** dans tout le SDK. Ce n'est pas un type de contenu MCP.

**Et la voie de contrebande est fermée aussi.** Un bloc `text` portant des clés supplémentaires est accepté — mais les clés sont **retirées** :

```
bloc text + source/title : ACCEPTE -> {"type":"text","text":"conflit"}
```

Aucun canal latéral d'attribution.

**Correction de ma propre méthode :** j'avais cherché dans `@modelcontextprotocol/server` et conclu d'une **absence dans un bundle** que le protocole n'admettait pas le bloc. C'est le mauvais paquet et une inférence non fondée. La mesure correcte est celle ci-dessus : l'union est fermée, mesurée sur les schémas publics du protocole.

**Formulation précise, pour ne pas se faire renvoyer un contre-exemple.** Le bloc *peut* traverser MCP — mais uniquement comme **paramètres opaques d'une notification personnalisée**, sur le modèle de `cli/channel.ts:467`, où les params ne sont pas validés. Or l'hôte rend cela comme une balise `<channel>` textuelle, pas comme un bloc de contenu de la Messages API. Donc : **non émissible comme contenu de résultat d'outil ; émissible seulement comme params opaques, sans nulle part où atterrir en citation.**

Conséquence pour la fiche : l'issue upstream `claude-agent-sdk-python#574`, sur laquelle §2 et §6.5 s'appuient, porte sur un *handler* qui droppe le bloc. C'est **hors sujet** : le problème est deux couches plus tôt.

Vérifié aussi : aucun chemin non-MCP du dépôt ne produit de contenu de message user. `cli/channel.ts` n'émet que `notifications/claude/channel` ; `src/http/rest-handlers.ts` rend du JSON à un appelant HTTP ; `sdk/src/client.ts` ne fait que de l'OAuth. Un grep de `search_result|output_config|structured.output|toJSONSchema` sur `src/ cli/ sdk/ docs/ specs/` rend **une seule** occurrence : le commentaire périmé de `cli/channel.ts:247`.

#### B. Et la moitié « strict » : §6.1 se trompe de prix — c'est déjà gratuit

§5 affirme que `sdk/src/client.ts` est « seul endroit d'où l'on pourrait exposer les schémas d'outils en JSON Schema exportable », et §6.1 chiffre l'adoption « au prix d'un second contrat ». **Les deux sont faux.** Les 26 outils s'enregistrent via `McpServer.registerTool(name, {inputSchema: z.object(…)}, handler)`, le SDK v2 convertit le zod lui-même, et **`tools/list` publie déjà le JSON Schema complet** :

```
tools/list publie un inputSchema pour announce_work : true
taille du schema publie                             : 1 786 car.
```

Un agent qui veut `strict: true` n'a besoin d'aucun export, d'aucune méthode SDK et d'aucun second contrat : il lit `tools/list` et recopie `inputSchema`. **Coût : zéro ligne.**

**Mais la version gratuite n'est pas conforme à `strict`**, et c'est le point chiffrable :

```
additionalProperties present : false      <- la doc l'exige a false pour les objets
maxItems             PRESENT              <- non supporte par strict
maxLength            PRESENT              <- non supporte par strict
minItems             absent
$ref                 absent
```

Les deux mots-clés non supportés viennent de `consultation-tools.ts:81-82` (`z.array(z.string().max(256)).max(200)` sur `target_symbols`) — **le seul schéma contraint** de tout `src/tools/`, les 25 autres n'ayant que des types nus et des `.describe()`. Et c'est précisément `announce_work`, que §5 désigne comme « le plus gros gisement ».

**La réponse honnête à §6.1 est donc : l'adoption n'est pas coûteuse, elle est déjà gratuite, et la version gratuite demande un post-traitement côté appelant** (retirer `maxLength`/`maxItems`, injecter `additionalProperties: false`). Ce post-traitement appartient à l'agent appelant, pas à mcp-coordinator. Le verdict reste `refuser` — il n'y a rien à construire ici — mais **pas pour la raison que la fiche avance**.

#### C. Le livrable : un schéma dupliqué à la main, dont la justification est périmée et qui a déjà divergé

```
zod declare    : ^4.4.3
zod installe   : 4.4.3
z.toJSONSchema : function
-> le commentaire de cli/channel.ts:246 est PERIME
```

Le commentaire dit « the project's zod-v3 surface doesn't ship a `toJSONSchema` helper ». Faux sur les deux moitiés. Et la vraie cause n'est pas la version de zod : `cli/channel.ts:343` utilise le `Server` bas niveau avec `setRequestHandler("tools/list", …)`, donc rien ne convertit son zod.

**La divergence est live, pas théorique :**

```
z.toJSONSchema(PostToThreadArgsSchema) contient minLength : true
le schema ECRIT A LA MAIN contient minLength              : false
zod refuse content:"" ?                                    true
```

Un modèle lit `tools/list`, voit `content: {type:"string"}` sans contrainte, envoie `content: ""`, et reçoit un `isError` (`cli/channel.ts:366-372`) pour une valeur que le contrat annoncé autorisait. → **#363**

#### D. Adjudication des six critères

| # | Seuil | Mesure | Verdict |
|---|---|---|---|
| **K1** | le schéma de résultat d'outil rejette `search_result` | union **fermée** de 5 options, `catchall: false` partout ; `CallToolResult` **REJETTE** ; clés supplémentaires **retirées** d'un bloc `text` | **SE DÉCLENCHE**, par une mesure plus forte que celle que j'avais pré-enregistrée |
| **K2** | `strict` indisponible sur `mcp_toolset` | confirmé par §0 contre la doc ; à noter que `mcp_toolset` est lui-même en **beta** (`mcp-client-2025-11-20`), ce qui durcit l'argument du « chemin principal » | **SE DÉCLENCHE** |
| **K3** | 0 méthode de données dans `sdk/src/client.ts` | **9 méthodes async, toutes OAuth** (`loadFromStore`, `persistTokens`, `whoami`, `logout`, `logoutAll`, `revoke`, `refresh`, `deviceCodeStart`, `deviceCodePoll`) sur 329 lignes | **SEUIL ATTEINT MAIS NON DÉCISIF** — l'export n'a jamais eu besoin de `client.ts` ; `tools/list` publie déjà les schémas |
| **K4** | ≥ 3 surfaces à répliquer | 3 : `src/tools/*.ts` (zod → dérivé), `src/http/rest-schemas.ts` (**16** schémas exportés), `cli/channel.ts:250` (JSON Schema à la main, **déjà divergé** sur `minLength`) | **SE DÉCLENCHE**, avec une dérive **mesurée** |
| **K5** | 0 demande | **0** sur les issues du dépôt | **SE DÉCLENCHE** |
| **K6** | `search_result` absent du protocole MCP | 0 occurrence dans le SDK ; union fermée | **SE DÉCLENCHE** |

**Cinq critères se déclenchent, un atteint son seuil sans porter d'inférence.**

#### E. §0 s'est corrigée de travers — cinquième fiche d'affilée, mais un cran plus grave

Les quatre fiches précédentes (`E08`–`E11`) avaient une §0 aux références **périmées**. Ici, §0 a **corrigé** deux numéros et les deux corrections sont fausses, et elle a **certifié** deux références qui pointent sur autre chose.

| §5 / §0 affirme | Réel |
|---|---|
| `announce_work` **l.37** (§0 : « 36 → 37 ») | `registerTool(` à **39**, le nom à **40** |
| `check_file_conflict` **l.50** (§0 : « 49 → 50 ») | **60** |
| conflits persistés à `consultation-tools.ts` **l.122-125** (§0 : « existent ») | **l.159** (`UPDATE threads SET conflicts = ? WHERE id = ?`). L.122-125 est une branche de validation de chemin — **du code sans rapport** |
| `cli/channel.ts` enregistre via `setRequestHandler(ListToolsRequestSchema)` **l.340** | handler à **343**, et l'API v2 prend la **chaîne** `"tools/list"` — §5 nomme une API qui n'existe pas ici |
| « **21** retours `{type:"text", …JSON.stringify}` » (§0 : « 32 → 21 ») | **24** (agents 4, consultation 9, dependencies 2, files 3, mqtt 3, status 3). Mon propre comptage de 21 était faux aussi : mon motif à une ligne rate 3 cas où les deux propriétés sont sur des lignes séparées |
| « **8** retours dans `consultation-tools.ts` » | **9** |
| « **16** schémas zod côté REST » | **16 ✓** — c'est mon « 14 » qui était faux, j'avais compté les `z.object(` et raté deux `z.record(` |
| « 11 outils dans `consultation-tools.ts` », « 26 outils » | **exacts** |

### 6.5 Contre-arguments

- **Le chemin d'accès principal est justement celui qui n'en bénéficie pas.** mcp-coordinator est un serveur MCP ; ses utilisateurs arrivent par `mcp_toolset` ou par un client MCP. Or `strict` est explicitement indisponible sur `mcp_toolset`, et les blocs `search_result` sont documentés comme droppés par le handler de tool result MCP. Les deux moitiés de la fiche ne s'appliquent donc, en l'état, qu'à un usage *hors* MCP.
- **Ça pousse à créer un second contrat.** Exposer des schémas JSON Schema depuis le SDK pour contourner la limite `mcp_toolset` revient à maintenir deux définitions des mêmes outils (zod dans `src/tools/*.ts`, JSON Schema exporté dans `sdk/src/`), plus une troisième surface dans `cli/channel.ts`. Le repo a déjà payé ce prix avec la divergence MCP/REST documentée dans `src/announce-workflow.ts`.
- **Casse la portabilité.** Les blocs `search_result` sont un type de contenu propre à la Messages API d'Anthropic. Un serveur MCP censé parler à n'importe quel client (Cline, Zed, un agent maison) qui renverrait des blocs `search_result` produirait du bruit non interprétable ailleurs — sauf à conditionner le format de sortie au client, ce qui est une nouvelle branche à tester.
- **Divergence de statut selon la plateforme.** GA sur la Claude API, Amazon Bedrock, Google Cloud Vertex AI et Claude Platform on AWS ; **GA sur Microsoft Foundry aussi**, mais restreint aux déploiements « Hosted on Anthropic ». *(Corrigé pendant le challenge du 2026-08-17 : la formulation d'origine — « beta publique sur Bedrock et Microsoft Foundry » — était fausse, comme §0 l'avait signalé. À noter que `mcp_toolset`, le chemin d'accès principal, est lui-même en **beta** : `mcp-client-2025-11-20`.)*
- **YAGNI sur les citations.** Personne n'a demandé que les alertes de conflit soient citables. Le bénéfice est réel mais spéculatif ; les **24** retours `{type:"text", text: JSON.stringify(...)}` fonctionnent et sont lisibles. *(Corrigé pendant le challenge : ni « 32 » ni le « 21 » de §0 — c'est 24.)*
- **Coût de compilation de grammaire.** Sur 26 outils déclarés, la première requête après tout changement de schéma paie une latence de compilation. Pour un coordinateur dont l'argument est la réactivité (SSE, MQTT, `wait_for_peers`), ce n'est pas neutre et doit être mesuré avant adoption.
- **Contradiction entre chercheurs :** aucune sur les faits. Le seul point non résolu est la compatibilité `search_result` × MCP — un chercheur la donne comme « à vérifier empiriquement, la doc du connecteur ne le dit pas », le vérificateur la donne comme *plus* pessimiste encore (issue upstream ouverte documentant un drop silencieux). La fiche retient la version pessimiste sans la traiter comme définitive.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** |
| **Date** | 2026-08-17 |
| **Justification** | **Cinq critères sur six se déclenchent** — mais la raison qui compte n'est aucune de celles que la fiche avance. ⭑ **La moitié « citations » est morte deux étages sous le niveau où §2 et §6.5 argumentent.** `ContentBlockSchema` du protocole (paquet `@modelcontextprotocol/core`) est une union **fermée de cinq options** — `text | image | audio | resource_link | resource` — toutes sans `catchall` ; `CallToolResultSchema` **rejette** un bloc `search_result`, et `search_result` a **0 occurrence** dans tout le SDK. La contrebande est fermée aussi : les clés supplémentaires posées sur un bloc `text` sont **retirées** à la validation. L'issue upstream `#574`, sur laquelle la fiche s'appuie, porte sur un *handler* qui droppe le bloc — **hors sujet**, le problème est deux couches plus tôt. Formulation précise à retenir : **non émissible comme contenu de résultat d'outil ; émissible seulement comme params opaques de notification, sans nulle part où atterrir en citation.** ⭑ **Et sur la moitié « strict », §6.1 se trompe de prix.** Elle chiffre l'adoption « au prix d'un second contrat », et §5 désigne `sdk/src/client.ts` comme « seul endroit d'où l'on pourrait exposer les schémas ». **Les deux sont faux** : `tools/list` publie **déjà** le JSON Schema complet (1 786 caractères pour `announce_work`), dérivé du zod par le SDK v2. Un agent voulant `strict` n'a besoin d'aucun export — **coût zéro ligne**. Mais la version gratuite **n'est pas conforme à `strict`** : `additionalProperties` est **absent** (la doc l'exige à `false`) et `maxItems`/`maxLength` sont **présents** (non supportés), tous deux venant de `consultation-tools.ts:81-82`, le seul schéma contraint du dépôt — sur `announce_work`, précisément ce que §5 appelle « le plus gros gisement ». Le post-traitement appartient donc à l'agent appelant, pas à nous. **Refuser reste juste ; la justification change entièrement.** ⭑ **Corrections de méthode.** J'avais cherché `search_result` dans `@modelcontextprotocol/**server**` et conclu d'une **absence dans un bundle** que le protocole n'admettait pas le bloc : mauvais paquet, inférence non fondée. La mesure correcte est l'union fermée sur les schémas publics. Et **K3 atteint son seuil sans porter d'inférence** (9 méthodes async, toutes OAuth, dans `sdk/src/client.ts`) : l'export n'a jamais eu besoin de ce fichier. Enfin, deux de mes propres chiffres étaient faux — « 21 retours » (c'est **24** ; mon motif à une ligne ratait 3 cas) et « 14 schémas REST » (c'est **16** ; j'avais oublié deux `z.record(`). ⭑ **§0 s'est corrigée de travers**, un cran plus grave que les quatre fiches précédentes : elle a **corrigé** deux numéros et les deux corrections sont fausses (`announce_work` l.37 → **39** ; `check_file_conflict` l.50 → **60**), elle a **certifié** deux références qui pointent sur autre chose (les conflits persistent à **l.159**, pas 122-125 ; le handler channel est à **343** et l'API v2 prend la chaîne `"tools/list"`, pas `ListToolsRequestSchema`), et son « 32 → 21 » remplaçait un mauvais chiffre par un autre. §6.5 corrigé au passage sur les deux points que §0 avait signalés comme gelés. |
| **Issue / PR** | **#363** — le JSON Schema écrit à la main de `cli/channel.ts:250` a **divergé** du zod voisin (`minLength: 1` absent des trois champs), avec une conséquence observable : un modèle lit `tools/list`, envoie `content: ""`, et reçoit un `isError` pour une valeur que le contrat annoncé autorisait. Et le commentaire qui justifie l'écriture à la main — « the project's zod-v3 surface doesn't ship a `toJSONSchema` helper » — est **périmé** (zod 4.4.3, `z.toJSONSchema` est une fonction) ; la vraie cause est l'usage du `Server` bas niveau. |
| **Jalon visé** | Aucun pour les deux mécanismes. #363 est petit et sans urgence. **À ne pas oublier :** si un jour un agent en connexion directe veut `strict`, le prérequis n'est pas un export mais un post-traitement du schéma déjà publié — et le seul schéma qui pose problème est `target_symbols` sur `announce_work`. Les six références fausses de §5/§0 sont à recaler. |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : issue #574 fermée (pas ouverte), statut Bedrock corrigé, 3 numéros de ligne rectifiés. |
| 2026-08-17 | **Challenge — verdict `refuser` ; la moitié « citations » est morte deux étages sous le débat.** `ContentBlockSchema` du protocole (paquet **`@modelcontextprotocol/core`**) est une union **fermée de cinq options** — `text \| image \| audio \| resource_link \| resource` — toutes sans `catchall` ; `CallToolResultSchema` **rejette** un bloc `search_result`, qui a **0 occurrence** dans tout le SDK. Et la contrebande est fermée : `{type:"text", text:"conflit", source:"a.ts", title:"T"}` est accepté mais reparsé en `{"type":"text","text":"conflit"}` — les clés sont **retirées**, aucun canal latéral d'attribution. L'issue upstream `#574`, sur laquelle §2 et §6.5 s'appuient, porte sur un *handler* qui droppe le bloc : **hors sujet**. Formulation précise : **non émissible comme contenu de résultat d'outil ; émissible seulement comme params opaques de notification** (les params ne sont pas validés, cf. `cli/channel.ts:467`), **sans nulle part où atterrir en citation**. **Et §6.1 se trompe de prix sur la moitié « strict ».** Elle chiffre l'adoption « au prix d'un second contrat » et §5 désigne `sdk/src/client.ts` comme seul point d'export : **les deux sont faux**. `tools/list` publie **déjà** le JSON Schema complet (**1 786 car.** pour `announce_work`), dérivé du zod par le SDK v2 — coût **zéro ligne**. Mais la version gratuite n'est **pas conforme à `strict`** : `additionalProperties` **absent** (la doc l'exige à `false`), `maxItems` et `maxLength` **présents** (non supportés), tous deux issus de `consultation-tools.ts:81-82` — le **seul** schéma contraint du dépôt, et il est sur `announce_work`. Le post-traitement appartient à l'agent appelant. **Corrections de méthode :** j'avais cherché dans `@modelcontextprotocol/**server**` et conclu d'une **absence dans un bundle** que le protocole rejetait le bloc — mauvais paquet, inférence non fondée ; la mesure juste est l'union fermée. **K3 atteint son seuil sans porter d'inférence** (9 méthodes async, toutes OAuth, sur 329 lignes) : l'export n'a jamais eu besoin de `client.ts`. Et deux de mes chiffres étaient faux : « 21 retours » → **24** (mon motif à une ligne ratait 3 cas sur 2 lignes), « 14 schémas REST » → **16** (deux `z.record(` oubliés). **§0 s'est corrigée de travers** — un cran plus grave que `E08`–`E11` : ses deux corrections sont fausses (`announce_work` l.37 → **39**, `check_file_conflict` l.50 → **60**), elle certifie deux références qui pointent ailleurs (conflits persistés à **l.159** et non 122-125 ; handler channel à **343**, et l'API v2 prend la chaîne `"tools/list"`, pas `ListToolsRequestSchema`), et son « 32 → 21 » échangeait un mauvais chiffre contre un autre. §6.5 corrigé sur les deux points que §0 avait laissés gelés (statut plateforme, et le décompte). Livrable : **#363** — le JSON Schema à la main de `cli/channel.ts:250` a **divergé** (`minLength: 1` absent), avec conséquence observable, et son commentaire justificatif est périmé (zod **4.4.3**, `z.toJSONSchema` existe). |
