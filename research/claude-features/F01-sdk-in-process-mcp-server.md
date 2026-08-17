# F01 — Serveur MCP in-process : le paquet `@mcp-coordinator/agent-sdk`

| Champ | Valeur |
|---|---|
| **ID** | `sdk-in-process-mcp-server` |
| **Surface** | agent-sdk |
| **Statut** | GA — aucune marque `@alpha`/`@beta` sur `tool()` ni `createSdkMcpServer()` (référence TS + changelog vérifiés le 2026-08-14) |
| **Disponible depuis** | annotations dans `tool()` depuis `0.2.27` ; `alwaysLoad` depuis `0.3.172` (changelog SDK TS ; dernière version publiée : `0.3.232`) |
| **Tier** | T1-incontournable |
| **Nature** | integration |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — PoC local suffit, aucun accès fermé requis |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — refuser ; la porte existe deja et essaim l'utilise ; le levier restant est C06/#271 |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **Statut.** La contradiction « GA mais export tracé `@alpha` » ne tient pas : la référence TypeScript officielle ne marque ni `tool()` ni `createSdkMcpServer()` comme alpha/beta/expérimental, et la seule occurrence d'`alpha` au changelog du SDK TS concerne `resolveSettings()` (0.2.136), sans rapport. Ligne `Statut` corrigée. *(La réserve (a) du §1 et le 1ᵉʳ contre-argument du §6.5 reposent sur cette contradiction — non modifiés, hors de mon mandat, mais leur prémisse factuelle est infirmée.)*
- **Nom du paquet npm** (`(à vérifier)` du §1 et du §2) : tranché — `@anthropic-ai/claude-agent-sdk` (TS), `claude_agent_sdk` (Python).
- **Emplacement d'`alwaysLoad`** (ambiguïté du §1, `(à vérifier)` du §2) : tranché — les **deux** sont valides et documentés. Par outil dans l'argument `extras` de `tool()`, et globalement dans les options de `createSdkMcpServer()` (`alwaysLoad?: boolean`, se combine avec le réglage par outil).
- **`extras` de `tool()`** : la fiche ne listait que `annotations`. Le champ réel est `{ annotations?, searchHint?, alwaysLoad? }` — `searchHint` manquait ; §2 complété.
- **`createSdkMcpServer()`** : options réelles `{ name, version?, instructions?, tools?, alwaysLoad? }` — `instructions` manquait ; §2 complété. Signature complète de `tool()` ajoutée (schéma en 3ᵉ position, handler en 4ᵉ, `extras` en 5ᵉ).
- **`ToolAnnotations`** : champ `title?` absent de la fiche, ajouté au §2 (il est déjà utilisé dans le repo, cf. `src/tools/status-tools.ts`).
- **Version `alwaysLoad`** : `(version exacte à vérifier)` de l'en-tête tranché → `0.3.172`.
- **§5, `cli/init.ts`** : le snippet `.mcp.json` occupe les lignes **195-202**, pas 194-202. Corrigé.

Tout le reste du §5 a été rouvert et tient : `createServices()` bien en `src/server-setup.ts` l. 53 ; ré-exports en `src/index.ts` l. 7-8 ; `buildChannelServer()` en `cli/channel.ts` l. 277 ; `docs/ARCHITECTURE.md` l. 221 (« Process model ») et l. 266 (« How to add an endpoint or MCP tool ») ; `exports` limité à `.` et `./types`, `files` sans `sdk/` ; `zod ^4.4.3` et `@modelcontextprotocol/sdk ^1.29.0` présents. Le compte de 26 outils sur 6 fichiers est exact (4+11+3+3+3+2) et les 26 registrations portent bien `readOnlyHint` en 4ᵉ argument positionnel de `server.tool()` (12 `destructiveHint`, 2 `idempotentHint`). `sdk/package.json` est bien `@mcp-coordinator/sdk-js@0.8.1`, `private: true`.

**Marqueurs `(à vérifier)` restants :** aucun. Un point reste ouvert mais n'est pas un marqueur de la fiche : la compatibilité de `zod ^4.4.3` avec le `tool()` du Agent SDK (§5, `package.json`) se tranche par un `pnpm install` + `tsc`, pas par la doc.

**Testabilité :** ✅ testable
Rien dans cette fiche ne dépend d'un accès fermé : `@anthropic-ai/claude-agent-sdk` est un paquet npm public, sans header beta ni research preview. Les deux prototypes qui tranchent la question du §6.1 ne demandent même pas de tour de modèle — appeler `createServices()` deux fois dans deux process et comparer `list_agents`, et chronométrer 100 `coordinator_status` HTTP local vs appel direct. Seul le troisième volet (le modèle appelle réellement `mcp__coordinator__*` via `query()`) consomme l'authentification Claude Code locale.

## 1. Ce que c'est

Le Claude Agent SDK permet de déclarer un serveur MCP qui tourne **dans le process de l'application SDK**, sans sous-processus et sans transport : `createSdkMcpServer({ name, version, tools })` en TypeScript, `create_sdk_mcp_server(...)` en Python. Les outils sont déclarés avec `tool(name, description, zodSchema, handler, { annotations })` ; le handler retourne la forme MCP habituelle `{ content, structuredContent?, isError? }`. Le serveur ainsi construit se passe dans `options.mcpServers` sous une clé qui devient le premier segment du nom exposé au modèle : `mcp__{server_name}__{tool_name}`, à autoriser via `allowedTools` (le wildcard `mcp__coordinator__*` est accepté). Comme il n'y a ni spawn ni handshake de transport, il n'y a pas de délai de démarrage sur le premier tour de la conversation. Les annotations MCP standard sont supportées — `readOnlyHint` (qui autorise l'appel parallèle), `destructiveHint`, `idempotentHint`, `openWorldHint` — et `alwaysLoad: true` exempte un outil du *tool-search deferral*.

Deux réserves étaient portées par le bundle ; les deux sont levées par la vérification du 2026-08-14 (voir §0). **(a)** La contradiction « GA / export tracé `@alpha` » est infirmée : ni `tool()` ni `createSdkMcpServer()` ne portent de marque alpha/beta/expérimentale dans la référence TypeScript, et le changelog du SDK TS ne mentionne `alpha` que pour `resolveSettings()` (0.2.136). **(b)** L'ambiguïté sur `alwaysLoad` n'en est pas une : les deux emplacements sont valides et documentés — par outil dans l'argument `extras` de `tool()`, globalement dans les options de `createSdkMcpServer()`, et les deux se combinent. Le paquet npm à importer est `@anthropic-ai/claude-agent-sdk` (Python : `claude_agent_sdk`).

## 2. Surface d'API exacte

```ts
// Import
import { tool, createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
// Python : from claude_agent_sdk import tool, create_sdk_mcp_server, query

// Construction du serveur
createSdkMcpServer(options: {
  name: string;
  version?: string;
  instructions?: string;          // bloc d'instructions MCP renvoyé à l'initialize
  tools?: Array<SdkMcpToolDefinition<any>>;
  alwaysLoad?: boolean;           // tout le serveur exempté du tool-search deferral
}): McpSdkServerConfigWithInstance;
// Python : create_sdk_mcp_server(name=..., version=..., tools=[...])

// Déclaration d'un outil
tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,            // TS : toujours un schéma zod (raw shape)
  handler: (args, extra) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean }
): SdkMcpToolDefinition<Schema>;
// Python : décorateur @tool(name, description, schema, annotations=ToolAnnotations(...))
//          schema = dict {"lat": float} OU JSON Schema complet

// Retour du handler
{ content: [...], structuredContent?: ..., isError?: boolean }
// content : blocs type "text" | "image" | "audio" | "resource" | "resource_link"
// Python : "is_error" (snake_case) ; le décorateur @tool ne transmet PAS structuredContent

// Câblage côté appelant
options.mcpServers                // dict clé -> serveur ; la clé devient {server_name}
allowedTools                      // ex. "mcp__coordinator__*" (wildcard accepté)
mcp__{server_name}__{tool_name}   // nom vu par le modèle

// ToolAnnotations (ré-exporté de @modelcontextprotocol/sdk/types.js)
title?: string
readOnlyHint?: boolean     // défaut false — autorise l'appel parallèle
destructiveHint?: boolean  // défaut true  — informatif
idempotentHint?: boolean   // défaut false — informatif
openWorldHint?: boolean    // défaut true  — informatif

// Tool-search : actif par défaut, diffère les outils SDK MCP
alwaysLoad: true    // dans extras de tool() (par outil) ET/OU dans les options
                    // de createSdkMcpServer() (tout le serveur) — les deux se combinent
searchHint: string  // phrase d'une ligne affichée dans la liste des outils différés
```

Import du paquet : `@anthropic-ai/claude-agent-sdk` (TypeScript), `claude_agent_sdk` (Python).

## 3. Sources

- https://code.claude.com/docs/en/agent-sdk/custom-tools.md
- https://code.claude.com/docs/en/agent-sdk/mcp.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.** Aujourd'hui, les trois seules portes d'entrée du coordinateur sont vérifiables dans le repo : le transport HTTP (`cli/init.ts` écrit `{ mcpServers: { coordinator: { type: "http", url } } }` dans `.mcp.json`), le transport stdio (`src/index.ts`, `StdioServerTransport`), et le serveur de channels (`cli/channel.ts`, `buildChannelServer()`). Les trois supposent un client MCP configuré par fichier. Un paquet `@mcp-coordinator/agent-sdk` exportant un `createCoordinatorServer()` prêt à *spread* dans `options.mcpServers` ouvre une quatrième porte : celle des gens qui écrivent leur propre orchestrateur avec le Agent SDK, sans jamais toucher un `.mcp.json`. C'est le seul public que le projet ne peut pas atteindre aujourd'hui. Aucun code n'est supprimé par cette fiche : les 26 outils, leurs schémas zod et leurs annotations restent le même code — `readOnlyHint` / `destructiveHint` / `idempotentHint` sont **déjà** posés sur les 26 registrations (`src/tools/*.ts`, 4ᵉ argument positionnel de `server.tool()`), donc la sémantique d'annotation se transporte telle quelle. Ce qui apparaît, c'est un point d'attache : une fabrique publiable, et un premier usage réel pour le paquet `sdk/` (`@mcp-coordinator/sdk-js@0.8.1`) qui est aujourd'hui `private: true` et purement OAuth (`McpCoordinatorClient` : device code, refresh, `whoami`, `logout` — zéro méthode de domaine coordinateur).

**Risque si on ne fait rien.** Faible mais réel, et pas de nature technique : mcp-coordinator reste un outil que l'on *configure*, pas une bibliothèque que l'on *importe*. Les orchestrateurs multi-agents écrits au-dessus du Agent SDK — le public dont le besoin recouvre exactement le nôtre — réimplémentent leur coordination maison, ou paient un aller-retour HTTP local pour des lectures (`coordinator_status`, `hot_files`, `list_agents`) qui pourraient être des appels de fonction.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/server-setup.ts` | `createMcpServer(services, getSessionClaims)` construit un `McpServer` du SDK MCP ; c'est la fabrique à dupliquer ou à généraliser. `createServices()` (l. 53) instancie registry, SQLite, MQTT bridge, sweeper, scheduler git — tout ce qu'un serveur in-process embarquerait s'il ne proxifie pas. |
| `src/tools/*.ts` (6 fichiers, 26 outils) | Chaque `registerXTools(server, services, mcpLog, getSessionClaims)` type son 1ᵉʳ paramètre `McpServer` et appelle `server.tool(name, desc, zodShape, annotations, handler)`. La signature du `tool()` du Agent SDK diffère (schéma et handler à des positions différentes) : soit un adaptateur exposant `.tool()`, soit une 2ᵉ passe de registration. |
| `src/index.ts` | Ré-exporte déjà `createServices`, `createMcpServer` et `startServer` comme surface npm publique (l. 7-8) — c'est le point d'export naturel, ou celui à ne surtout pas surcharger. |
| `cli/channel.ts` (l. 277) | Précédent maison exact : `buildChannelServer()` retourne un handle et laisse **l'appelant** connecter le transport. La forme à imiter pour une fabrique in-process. |
| `sdk/src/client.ts`, `sdk/src/index.ts`, `sdk/package.json` | `@mcp-coordinator/sdk-js@0.8.1`, `private: true`, non publié. Contient toute la plomberie de jeton (`McpCoordinatorClient`, discovery `.well-known`, refresh proactif, lock multi-process) qu'un serveur in-process en mode proxy réutiliserait pour parler à un daemon distant authentifié. |
| `cli/init.ts` (l. 195-202) | Écrit le snippet `.mcp.json` `{ type: "http", url }`. Un chemin in-process court-circuite ce fichier : la doc CLI et `--write-mcp-config` doivent dire quel mode s'applique. |
| `package.json` | `exports` ne publie que `.` et `./types` ; `files` ne liste que `dist/src/`, `dist/cli/`, `dashboard/`. Un nouveau sous-chemin ou un paquet workspace supplémentaire est à ajouter. `zod ^4.4.3` et `@modelcontextprotocol/sdk ^1.29.0` sont déjà des dépendances — compatibilité de version zod avec le `tool()` du Agent SDK à vérifier. |
| `docs/ARCHITECTURE.md` (l. 221, « Process model: mono-instance-per-process, DB as a process singleton ») | Contrainte structurante : l'état module-level de `src/serve-http.ts` impose un coordinateur vivant par process OS. Deux orchestrateurs SDK embarquant chacun `createServices()` auraient chacun leur SQLite — donc zéro coordination entre eux. |
| `docs/operating-modes.md` | Documente polling vs push avec le snippet HTTP ; un 3ᵉ mode « in-process » y appartient si la fiche est adoptée. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le serveur in-process doit-il **embarquer** les services (`createServices()` → SQLite, registry, MQTT bridge) dans le process de l'orchestrateur SDK, ou n'être qu'un **proxy mince** de 26 `tool()` qui rappellent un daemon via `McpCoordinatorClient` — sachant que `docs/ARCHITECTURE.md` établit un coordinateur par process OS, et donc qu'un serveur embarqué ne coordonne rien au-delà de son propre process ?

### 6.2 Hypothèse

**Premier réflexe appliqué — grepper la doc du dépôt avant de parler de manque** (leçon d'`E09`). Et il y a une trouvaille : `README.md:354` porte déjà une section **« In-process from your own Node app »**, et `docs/usage.md:263` note qu'`essaim` « uses Strategy A (**in-process**) and starts its own ephemeral coordinator per `essaim run` ».

**La nuance est décisive et je ne veux pas la rater.** Ce qui existe est `startServer({ port, dataDir })` : cela embarque le **daemon HTTP** dans le process de l'appelant, avec un port. Ce n'est **pas** un serveur MCP in-process au sens du Agent SDK. Ce que F01 ajouterait, c'est de supprimer aussi le **saut de transport**. Donc §4 n'est pas faux — mais le delta réel est bien plus étroit que « ouvrir une quatrième porte » : c'est « retirer un aller-retour loopback à une porte qui existe déjà et qu'un consommateur utilise déjà ».

**Ce que je pense avant de mesurer.** Les deux branches de §6.1 se referment l'une sur l'autre :

- Le mode **embarqué** ne coordonne rien. `docs/ARCHITECTURE.md:221` pose « mono-instance-per-process, DB as a process singleton », et `docs/ops/single-instance-constraints.md` (mesuré en `E15`) dit **« Run exactly one coordinator process per data directory »** — partager le répertoire est donc *interdit par contrat*, et ne pas le partager veut dire que chaque orchestrateur ne se coordonne qu'avec lui-même. Le fait qu'`essaim` prenne « an isolated dir by default » le confirme depuis l'usage.
- Le mode **proxy mince** n'économise aucun spawn : la configuration `type: "http"` n'en fait déjà aucun. Il n'économise que le saut loopback, et **c'est mesurable**.

Donc mon hypothèse est que le verdict ne se joue pas sur §6.1 mais sur ce que le saut loopback coûte réellement. Si c'est sous le bruit, il ne reste qu'un argument d'ergonomie de packaging — pour un public dont §6.5 note qu'il n'est pas démontré.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **Le mode embarqué ne coordonne rien.** Deux orchestrateurs SDK embarquant chacun `createServices()` ne se voient pas, et partager un `dataDir` est interdit par contrat. | `list_agents` de l'un ne voit **pas** l'agent de l'autre, **démontré par exécution** |
| **K2** | **Le gain de latence est sous le bruit.** L'argument « zéro latence » est le seul avantage technique du proxy mince. | écart HTTP local vs appel direct < **1 ms** en médiane sur 100 itérations |
| **K3** | **Le mode in-process existe déjà en partie.** Si `startServer()` est documenté et déjà utilisé, le delta de F01 se réduit au saut de transport. | `README.md` documente un chemin in-process **et** un consommateur l'utilise |
| **K4** | **Nouvelle dépendance fournisseur, non installée.** Le serveur ne dépend d'aucun paquet Anthropic aujourd'hui. | `@anthropic-ai/claude-agent-sdk` absent de `node_modules` **et** des dépendances déclarées |
| **K5** | **Deux chemins de registration pour 26 outils.** La signature de `tool()` du Agent SDK diffère de `server.tool()`. | positions d'arguments **différentes**, donc adaptateur ou seconde passe obligatoires |
| **K6** | **YAGNI et coût de packaging.** | **0** demande, et `sdk/` est `private: true` sans jamais avoir été publié |

**Règle que je m'impose :** §0 classe la fiche ✅ **testable** — aucune excuse pour conclure sur du raisonnement sur K1 et K2, qui doivent être **exécutés**. Et j'applique le reste des leçons : ne pas mesurer la mauvaise branche (`E11`, `E14`), vérifier une absence plutôt que la supposer (`E08`, `E10`, `E12`), distinguer une dérive de dépendance d'un défaut de vérification (`E13`, `E14`), et **réduire le périmètre plutôt que d'argumenter un seuil atteint** (`E15`).

### 6.3 Protocole de vérification

Proposition — à amender pendant le challenge. Le principe maison : on teste le vrai chemin de code, on ne théorise pas.

- [ ] Identifier le nom exact du paquet npm du Agent SDK et lire la signature réelle de `createSdkMcpServer` / `tool()` dans ses `.d.ts` (positions des arguments, forme des `extras`, emplacement effectif de `alwaysLoad`), puis lever les `(à vérifier)` du §2.
- [ ] Vérifier si l'export est effectivement marqué `@alpha` dans les types publiés — trancher la contradiction GA/`@alpha` du §1 sur pièce, pas sur le changelog.
- [ ] Prototype « proxy mince » : un `createCoordinatorServer({ baseUrl })` exposant **3 outils seulement** (`coordinator_status`, `hot_files`, `announce_work`) qui appellent le daemon HTTP local, branché dans `options.mcpServers` d'un script SDK ; mesurer que les appels aboutissent et que `mcp__coordinator__*` dans `allowedTools` suffit.
- [ ] Prototype « embarqué » : appeler `createServices()` depuis le même process qu'un orchestrateur SDK, lancer **deux** orchestrateurs en parallèle, et observer si `list_agents` de l'un voit l'agent de l'autre. Résultat attendu par la lecture de `docs/ARCHITECTURE.md` : non.
- [ ] Mesurer le coût réel évité : latence d'un `coordinator_status` en HTTP local vs en appel de fonction, sur 100 itérations. Si l'écart est sous le bruit, l'argument « zéro latence » ne porte plus et il ne reste que l'argument d'ergonomie de packaging.

### 6.4 Résultat observé

> **Note de méthode.** La passe adversariale par sous-agent a échoué **deux fois** sur une erreur serveur 529. Je l'ai donc conduite moi-même, en attaquant explicitement mes quatre points les plus faibles. Elle a servi : elle a trouvé une **sur-affirmation de ma part sur K1** et un **bénéfice que je m'apprêtais à ignorer**. Les deux sont ci-dessous.

#### A. La porte in-process existe déjà, et son consommateur est nommé

`README.md:354` porte une section **« In-process from your own Node app »** — `startServer({ port, dataDir })`. Ce n'est pas un serveur MCP-SDK : cela embarque le **daemon HTTP avec un port**. Le delta de F01 se réduit donc au **saut de transport**.

Et le public que §4 décrit comme « le seul que le projet ne peut pas atteindre aujourd'hui » **existe, il est nommé, et il est externe** :

> `docs/usage.md:159` — « **An orchestrator with its own agent loop**, e.g. [essaim](https://github.com/swoofer/essaim), which **subscribes to the MQTT broker itself** and injects events into the turn flow. »
> `docs/usage.md:263` — « `essaim`, which uses **Strategy A (in-process)** and starts its own ephemeral coordinator per `essaim run` ».

**Donc §4 se trompe deux fois** : ce public n'est pas inatteignable, et il a déjà résolu le problème — par `startServer()` plus un abonnement MQTT direct, sans avoir besoin de `createSdkMcpServer()`. **K6 est affaibli** (le public existe) mais **K3 est renforcé** (il est déjà servi).

#### B. K1 — j'avais écrit trop fort, et je me suis corrigé par exécution

**Ce que j'avais mesuré d'abord**, deux coordinateurs à `dataDir` distincts :

```
orchestrateur A (dataDir=data-test-f01-a) : list_agents -> [agent-A]
orchestrateur B (dataDir=data-test-f01-b) : list_agents -> [agent-B]
  B voit-il agent-A ? false
  A voit-il agent-B ? false
```

J'allais en conclure « le mode embarqué ne coordonne **rien** ». **Contre-épreuve, deux vrais process séparés partageant un `dataDir` :**

```
process 1 : enregistre agent-A -> [agent-A]
process 2 (node dist) : list_agents -> ["agent-A","agent-B"]
  le process 2 voit-il agent-A ? true
retour process 1 : list_agents -> [agent-A, agent-B]
  le process 1 voit-il agent-B ? true
```

**Le registre coordonne bel et bien.** Le contrat mono-instance n'est donc **pas** une impossibilité technique — c'est une interdiction motivée par d'**autres** dangers, que `docs/ops/single-instance-constraints.md` énumère : doublement des garanties de rate-limit et de lockout, course sur la lecture d'epoch de jeton, course de migration, contention du circuit-breaker du sweeper.

**K1 se déclenche, reformulé** : avec des répertoires isolés — le défaut d'`essaim` — le mode embarqué ne coordonne rien entre orchestrateurs ; avec un répertoire partagé il coordonne le registre mais **hérite de tous ces dangers**. « Ça marche, mais toutes les garanties de sécurité doublent » n'est pas une histoire de produit tenable. Ce qui reste vrai, mais pour une raison plus honnête que celle que j'allais écrire.

#### C. K2 — le saut de transport coûte 0,415 ms

Travail utile **identique des deux côtés** (`registry.listOnline()` sur 20 agents), serveur HTTP minimal pour isoler le coût du transport et non celui de la requête :

```
appel direct      : median 0.088 ms | p95 0.114 ms
via HTTP loopback : median 0.504 ms | p95 0.839 ms
ecart median (= le cout du transport) : 0.415 ms
=> 2 409 sauts loopback pour egaler UNE seconde
```

**K2 se déclenche.** Réserve honnête, que je m'impose parce que j'ai mesuré un serveur **minimal écrit pour l'occasion** : c'est un **plancher** du coût de transport, le vrai `POST /mcp` ajoutant la session, le handshake JSON-RPC et l'éventuelle auth. Mais la direction n'est pas ambiguë — on compare du sous-milliseconde à un tour de modèle qui se compte en secondes, et l'argument « pas de délai sur le premier tour » de §1 vise de toute façon le coût de **spawn**, que `type: "http"` évite déjà.

#### D. Le bénéfice que j'allais ignorer — et il joue contre F01

Je m'apprêtais à ne retenir que « latence » et « ergonomie de packaging ». Or le Agent SDK apporte aussi `alwaysLoad` et `searchHint`, qui exemptent un outil du *tool-search deferral* — et sous tool search, `C06` a mesuré que seuls les **noms** d'outils entrent en contexte au premier tour. Ce serait un levier réel.

**Sauf qu'il n'est pas propre au Agent SDK.** `C06:118` documente :

> `"anthropic/alwaysLoad": true` — dans le `_meta` d'un outil : **le SERVEUR marque lui-même un** outil comme toujours chargé.

Et `C06:38` précise qu'`alwaysLoad` est disponible sur **tous** les types de serveurs. **Le coordinateur peut donc déjà marquer ses propres outils, depuis le côté MCP, avec zéro dépendance fournisseur.** Vérifié : le dépôt n'utilise **jamais** `_meta` à cette fin — les seules occurrences sont la table `git_cochange_meta`, sans rapport.

Donc le seul bénéfice technique que F01 pouvait revendiquer au-delà de la latence est **déjà atteignable sans elle** — et il a un propriétaire : `C06` est tranchée depuis le 2026-08-15, périmètre versé dans **#271**. **Cela renforce le refus** au lieu de l'affaiblir.

#### E. K4, K5, K6

- **K4 se déclenche.** `@anthropic-ai/claude-agent-sdk` est absent de `node_modules` **et** des dépendances déclarées. Le serveur ne dépend aujourd'hui d'aucun paquet Anthropic.
- **K5 se déclenche, aggravé par la dérive.** Aujourd'hui : `server.registerTool(` × **26**, `server.tool(` × **0**. La forme est `registerTool(name, { description, inputSchema, annotations }, handler)` — un objet à 3 arguments — contre le `tool(name, description, schema, handler, extras)` du Agent SDK, positionnel à 5. Deux formes totalement différentes : un adaptateur ou une seconde passe de registration est **obligatoire**, pour 26 outils.
- **K6 se déclenche, mais affaibli sur un point.** 0 issue correspondante, et `sdk/` est toujours `@mcp-coordinator/sdk-js@0.8.1`, `private: true`, jamais publié. Mais le public n'est **pas** inexistant : `essaim` est nommé, externe, et écrit son propre orchestrateur. Ce qui manque n'est pas le public — c'est le besoin, puisqu'il est déjà servi.

#### F. §0 était exacte à sa date — troisième fiche propre d'affilée

J'ai relevé trois écarts. Vérifiés à `605c082`, dernier commit du **2026-08-14** :

| §5 dit | HEAD | À `605c082` |
|---|---|---|
| `createServices()` l. 53 | **54** | **53** ✓ |
| `buildChannelServer()` l. 277 | **280** | **277** ✓ |
| « `@modelcontextprotocol/sdk ^1.29.0` déjà une dépendance » | **ABSENT** | **présent** ✓ |

Les trois sont de la **dérive de dépendance**, causée par la migration `@modelcontextprotocol/*@2` du 2026-08-15. `src/index.ts:7-8`, `exports` (`.` et `./types`) et `zod ^4.4.3` sont exacts aujourd'hui encore. **Aucun défaut de vérification** — après `E14` et `E15`, c'est la **troisième** fiche propre consécutive, et le motif « §0 dérivée » de la série `E08`–`E13` semble clos.

#### G. Adjudication des six critères

| # | Seuil | Mesure | Verdict |
|---|---|---|---|
| **K1** | isolation démontrée par exécution | isolée avec des répertoires distincts (**prouvé**) ; **mais deux vrais process partageant un répertoire se voient** (prouvé) — l'interdiction vient des autres dangers de `single-instance-constraints.md` | **SE DÉCLENCHE, reformulé** — ma première formulation était trop forte |
| **K2** | écart < 1 ms | **0,415 ms** médian ; 2 409 sauts par seconde de tour de modèle | **SE DÉCLENCHE** (plancher : serveur minimal, pas le vrai `/mcp`) |
| **K3** | chemin in-process documenté + un consommateur | `README.md:354` + `essaim` (Strategy A), qui prend ses événements par **MQTT** | **SE DÉCLENCHE** |
| **K4** | SDK absent des deps | absent de `node_modules` et de `package.json` | **SE DÉCLENCHE** |
| **K5** | positions d'arguments différentes | `registerTool(name, {objet}, handler)` × 26 contre `tool(name, desc, schema, handler, extras)` | **SE DÉCLENCHE** |
| **K6** | 0 demande, `sdk/` jamais publié | 0 issue ; `private: true` — **mais le public existe et est nommé** (`essaim`), il est simplement déjà servi | **SE DÉCLENCHE, affaibli** |

**Six sur six**, dont deux avec une réserve explicite (K1 reformulé, K6 affaibli).

### 6.5 Contre-arguments

- **La contradiction GA / `@alpha` porte exactement sur ce qui compte.** Publier un paquet npm public dont la surface repose sur un export tracé `@alpha` transfère l'instabilité amont à nos utilisateurs, avec une obligation de suivi que le projet n'a pas les moyens d'absorber (mainteneur solo).
- **Le mode embarqué détruit la proposition de valeur.** `docs/ARCHITECTURE.md` (l. 221) est explicite : un coordinateur vivant par process, DB en singleton de process. Un serveur in-process qui embarque `createServices()` coordonne un seul agent avec lui-même. Si la seule variante viable est le proxy mince, alors « in-process » ne fait plus économiser un spawn — juste un fichier `.mcp.json`.
- **Le gain de latence est probablement nul en pratique.** Le daemon tourne en local ; l'aller-retour HTTP se compte en fractions de milliseconde, à comparer aux secondes d'un tour de modèle. L'argument « pas de délai sur le premier tour » vise le coût de *spawn*, que la configuration `type: "http"` évite déjà.
- **Nouvelle dépendance orientée fournisseur.** Le serveur actuel ne dépend d'aucun paquet Anthropic. Ajouter le Agent SDK, fût-ce en `peerDependency`, entame la revendication « serveur MCP standard, tout client » et complique l'audit de dépendances pour l'auto-hébergeur.
- **`alwaysLoad` et le tool-search deferral n'existent pas dans la spec MCP.** Les encoder dans les déclarations d'outils crée un chemin de code qui n'a de sens que sous le harnais Claude, et qui n'a aucun analogue dans `src/tools/*.ts` aujourd'hui.
- **Deux chemins de registration pour 26 outils = dérive garantie.** Le 27ᵉ outil, ou un changement de schéma zod, devra être fait deux fois. `docs/ARCHITECTURE.md` a déjà une section « How to add an endpoint or MCP tool » (l. 266) qu'il faudrait dédoubler.
- **YAGNI et coût de packaging.** Aucune demande utilisateur ne pointe vers ce besoin. `sdk/` est `private: true` depuis 0.8.1 et n'a jamais été publié : ajouter un **deuxième** paquet scopé implique organisation npm, configuration release-please, matrice CI et cycle de release supplémentaires — pour un public dont l'existence reste à démontrer.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** |
| **Date** | 2026-08-17 |
| **Justification** | **Six critères sur six se déclenchent, et les deux branches de §6.1 se referment l'une sur l'autre.** ⭑ **La porte in-process existe déjà, et son consommateur est nommé.** `README.md:354` documente « In-process from your own Node app » (`startServer({port, dataDir})`), et `docs/usage.md:159`/`:263` nomment **`essaim`** — un orchestrateur externe avec sa propre boucle d'agent, qui utilise « Strategy A (in-process) » et **prend ses événements directement sur le broker MQTT**. Donc §4 se trompe deux fois : ce public n'est pas « le seul que le projet ne peut pas atteindre », et il a **déjà résolu le problème autrement**. Le delta réel de F01 se réduit au **saut de transport**. ⭑ **Et ce saut coûte 0,415 ms** — mesuré, travail utile identique des deux côtés : **2 409 sauts pour égaler une seconde**, c'est-à-dire un tour de modèle. L'argument « pas de délai sur le premier tour » de §1 vise de toute façon le coût de **spawn**, que `type: "http"` évite déjà. ⭑ **Le seul bénéfice technique restant n'est pas propre au Agent SDK.** `alwaysLoad` serait un vrai levier sous tool search — mais `C06:118` documente `"anthropic/alwaysLoad": true` **dans le `_meta` d'un outil, posé par le serveur lui-même**, disponible sur tous les types de serveurs. Le coordinateur peut donc déjà le faire **depuis le côté MCP, avec zéro dépendance fournisseur** — et vérifié, il ne l'a **jamais** fait. Ce levier a un propriétaire : `C06`, tranchée le 2026-08-15, périmètre dans **#271**. **Cela renforce le refus** au lieu de l'affaiblir. ⭑ **K4/K5/K6** : le SDK est absent des dépendances (le serveur ne dépend d'aucun paquet Anthropic) ; la forme de registration a divergé au point de rendre un adaptateur **obligatoire** pour 26 outils (`registerTool(name, {objet}, handler)` × 26 contre `tool(name, desc, schema, handler, extras)`) ; et `sdk/` est `private: true` depuis 0.8.1 sans avoir jamais été publié. **Corrections de méthode.** **Ma formulation de K1 était trop forte, et je l'ai corrigée par exécution** : j'allais écrire que le mode embarqué « ne coordonne rien », mais deux **vrais process** partageant un `dataDir` **se voient** (`["agent-A","agent-B"]` de part et d'autre). Le contrat mono-instance n'est donc pas une impossibilité technique mais une interdiction motivée par d'**autres** dangers — doublement du rate-limit et du lockout, courses sur l'epoch et la migration, contention du circuit-breaker. La conclusion tient, sur un motif plus honnête : « ça marche mais toutes les garanties de sécurité doublent » n'est pas une histoire de produit. **Réserve sur K2** : j'ai mesuré un serveur HTTP minimal, donc **0,415 ms est un plancher** — le vrai `POST /mcp` ajoute session et handshake JSON-RPC. La direction reste sans ambiguïté. **Et la passe adversariale par sous-agent a échoué deux fois sur une erreur 529** : je l'ai conduite moi-même, et elle a servi — elle a trouvé la sur-affirmation sur K1 **et** le bénéfice `alwaysLoad`/`_meta` que j'allais ignorer. ⭑ **§0 était exacte à sa date** : les trois écarts relevés (`createServices` 53→54, `buildChannelServer` 277→280, `@modelcontextprotocol/sdk` présent→absent) sont de la **dérive de dépendance** due à la migration du 2026-08-15, vérifiée à `605c082`. **Troisième fiche propre d'affilée** après `E14` et `E15` — le motif « §0 dérivée » de la série `E08`–`E13` semble clos. |
| **Issue / PR** | Aucune issue neuve. Le seul levier exploitable trouvé — marquer les outils de coordination `alwaysLoad` via le `_meta` MCP, **sans** le Agent SDK — appartient à **`C06` / #271**, déjà tranchée et dotée d'un propriétaire. À signaler là-bas plutôt qu'à dupliquer ici. |
| **Jalon visé** | Aucun. Reconsidérer **uniquement** si un intégrateur nommé demande un serveur MCP in-process que `startServer()` plus un abonnement MQTT ne satisfait pas — c'est précisément la combinaison qu'`essaim` utilise déjà. Corrections de la fiche à porter : `@modelcontextprotocol/sdk` n'est plus une dépendance, et la forme de registration n'est plus `server.tool()`. |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : contradiction `@alpha` infirmée, paquet et `alwaysLoad` tranchés, §2 complété, l. 195 corrigée. |
| 2026-08-17 | **Challenge — verdict `refuser` ; les deux branches de §6.1 se referment l'une sur l'autre.** **La porte in-process existe déjà** (`README.md:354`, « In-process from your own Node app » via `startServer({port, dataDir})`) **et son consommateur est nommé** : `docs/usage.md:159`/`:263` désignent **`essaim`**, orchestrateur externe avec sa propre boucle d'agent, qui utilise « Strategy A (in-process) » et **prend ses événements directement sur MQTT**. §4 se trompe donc deux fois — ce public n'est pas inatteignable, et il a **déjà résolu le problème autrement**. Le delta de F01 se réduit au **saut de transport**, mesuré à **0,415 ms** (appel direct 0,088 ms, HTTP loopback 0,504 ms, travail utile identique des deux côtés) : **2 409 sauts pour égaler une seconde**. **Et le seul bénéfice technique restant n'est pas propre au Agent SDK** : `C06:118` documente `"anthropic/alwaysLoad": true` **dans le `_meta` d'un outil, posé par le serveur**, disponible sur tous les types de serveurs — le coordinateur peut donc le faire depuis MCP, **sans dépendance fournisseur**, et vérifié il ne l'a jamais fait. Ce levier appartient à `C06`/#271, déjà tranchée. Cela **renforce** le refus. **K4/K5/K6** : SDK absent des dépendances ; forme de registration divergée au point de rendre un adaptateur **obligatoire** (`registerTool(name, {objet}, handler)` × 26 contre `tool(name, desc, schema, handler, extras)`) ; `sdk/` `private: true` depuis 0.8.1, jamais publié — mais le public **existe et est nommé**, il est simplement déjà servi. **Corrections de méthode. Ma formulation de K1 était trop forte et je l'ai corrigée par exécution** : j'allais écrire que le mode embarqué « ne coordonne rien », or deux **vrais process** partageant un `dataDir` **se voient** (`["agent-A","agent-B"]` de part et d'autre) — le contrat mono-instance est une interdiction motivée par d'**autres** dangers (doublement du rate-limit et du lockout, courses sur l'epoch et la migration, contention du circuit-breaker), pas une impossibilité technique. La conclusion tient sur un motif plus honnête. **Réserve sur K2** : serveur HTTP minimal, donc **0,415 ms est un plancher** — le vrai `POST /mcp` ajoute session et handshake. **Et la passe adversariale par sous-agent a échoué deux fois sur une erreur 529** : conduite moi-même, elle a servi — elle a trouvé la sur-affirmation sur K1 **et** le bénéfice `alwaysLoad`/`_meta` que j'allais ignorer. **§0 était exacte à sa date** : les trois écarts (`createServices` 53→54, `buildChannelServer` 277→280, `@modelcontextprotocol/sdk` présent→**absent**) sont de la **dérive de dépendance** due à la migration du 2026-08-15, vérifiée à `605c082`. **Troisième fiche propre d'affilée** après `E14` et `E15`. |
