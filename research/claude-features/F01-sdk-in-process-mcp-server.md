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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

Proposition — à amender pendant le challenge. Le principe maison : on teste le vrai chemin de code, on ne théorise pas.

- [ ] Identifier le nom exact du paquet npm du Agent SDK et lire la signature réelle de `createSdkMcpServer` / `tool()` dans ses `.d.ts` (positions des arguments, forme des `extras`, emplacement effectif de `alwaysLoad`), puis lever les `(à vérifier)` du §2.
- [ ] Vérifier si l'export est effectivement marqué `@alpha` dans les types publiés — trancher la contradiction GA/`@alpha` du §1 sur pièce, pas sur le changelog.
- [ ] Prototype « proxy mince » : un `createCoordinatorServer({ baseUrl })` exposant **3 outils seulement** (`coordinator_status`, `hot_files`, `announce_work`) qui appellent le daemon HTTP local, branché dans `options.mcpServers` d'un script SDK ; mesurer que les appels aboutissent et que `mcp__coordinator__*` dans `allowedTools` suffit.
- [ ] Prototype « embarqué » : appeler `createServices()` depuis le même process qu'un orchestrateur SDK, lancer **deux** orchestrateurs en parallèle, et observer si `list_agents` de l'un voit l'agent de l'autre. Résultat attendu par la lecture de `docs/ARCHITECTURE.md` : non.
- [ ] Mesurer le coût réel évité : latence d'un `coordinator_status` en HTTP local vs en appel de fonction, sur 100 itérations. Si l'écart est sous le bruit, l'argument « zéro latence » ne porte plus et il ne reste que l'argument d'ergonomie de packaging.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : contradiction `@alpha` infirmée, paquet et `alwaysLoad` tranchés, §2 complété, l. 195 corrigée. |
