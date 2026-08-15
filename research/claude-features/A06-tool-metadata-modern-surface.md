# A06 — Surface d'outils moderne : outputSchema, annotations, ttlMs, progress

| Champ | Valeur |
|---|---|
| **ID** | `tool-metadata-modern-surface` |
| **Surface** | mcp-spec (+ claude-code pour les annotations `_meta` propriétaires) |
| **Statut** | GA |
| **Disponible depuis** | `structuredContent`, `resource_link`, `title`, `_meta` : rév. 2025-06-18 · `icons` : 2025-11-25 (SEP-973) · assouplissement des schémas : 2026-07-28 (SEP-2106) · `ttlMs`/`cacheScope` : 2026-07-28 (SEP-2549) · `anthropic/requiresUserInteraction` : Claude Code v2.1.199 |
| **Tier** | T1-incontournable |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — `ttlMs`/`cacheScope` absents du SDK, reste testable localement |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — le marqueur `(à vérifier)` sur le SDK est tranché. Version **réellement installée : `@modelcontextprotocol/sdk` 1.30.0** (la plage `^1.29.0` de `package.json` résout vers 1.30.0). `registerTool(name, config, cb)` existe et son `config` accepte `{ title, description, inputSchema, outputSchema, annotations, _meta }` — donc `outputSchema` **et** `_meta` sont exprimables directement via `McpServer`, sans passer par un handler brut. `structuredContent` est typé dans `CallToolResult`. En revanche **`ttlMs` et `cacheScope` n'apparaissent nulle part dans `node_modules/@modelcontextprotocol/sdk/dist/`** : zéro occurrence, ils devraient être injectés à la main.
- §2 — fait nouveau : dans le SDK 1.30.0, les six surcharges de **`server.tool()` sont marquées `@deprecated` (« Use `registerTool` instead »)**. La migration des 26 sites n'est donc pas seulement un prérequis d'`outputSchema`, c'est aussi une sortie d'API dépréciée.
- §5 — `get_blast_radius` : la ligne citée (l.86) est le corps du handler ; la déclaration `server.tool()` est à **l.73** (annotations l.81). Corrigé.
- §5 — `close_thread` / `cancel_thread` : les lignes citées (323, 341) sont les lignes d'annotations ; les déclarations sont à **l.313** et **l.333**. Corrigé pour rester cohérent avec les autres entrées du tableau.

Tous les autres faits ont été confrontés à la source et tiennent :

- Spec 2026-07-28 `server/utilities/caching` : `ttlMs` (entier ms, sémantique `Cache-Control: max-age`, `>= 0` obligatoire, absent = 0, négatif = ignoré), `cacheScope` `"public"`/`"private"`, sur `resultType: "complete"` des 6 méthodes listées, résultats MRTR non cachables. Exact au mot près.
- Spec 2026-07-28 `server/tools` : noms 1–128 caractères, `[A-Za-z0-9_.-]`, sensibles à la casse (tous en SHOULD) ; ordre déterministe de `tools/list` SHOULD, motivé par le cache client et le cache de prompt LLM ; `structuredContent` accepte n'importe quelle valeur JSON ; `outputSchema` en 2020-12 par défaut ; champs de `resource_link` (`type`, `uri`, `name`, `description`, `mimeType`) ; annotations `audience`/`priority`/`lastModified` ; distinction erreur protocole / `isError: true` normative.
- Spec 2026-07-28 `basic/index` §`icons` : `Icon { src, mimeType, sizes, theme: light|dark }` et rejet obligatoire des schèmes `javascript:`, `file:`, `ftp:`, `ws:`. Exact.
- `code.claude.com/docs/en/mcp` : `_meta["anthropic/requiresUserInteraction"]` (booléen JSON strict, prompt à chaque appel y compris en `acceptEdits`/`auto`/`bypassPermissions`, pas de « ne plus demander », allow rules inopérantes, deny en `dontAsk`, `allow` converti en deny sous `--permission-prompt-tool` avec le message exact cité, `canUseTool` peut approuver, one-tap retiré depuis v2.1.214, annotation requiert v2.1.199+) ; `_meta["anthropic/maxResultSizeChars"]` plafonné à 500 000 caractères ; `MAX_MCP_OUTPUT_TOKENS` indépendant. Tout confirmé, y compris les numéros de version.
- Repo : 26 `server.tool()` et 26 `title:` sur 6 fichiers ; `isError` aux 6 emplacements cités ; `createMcpServer()` l.207 + 6 `register*Tools` l.242-247 ; `treeSitter.load()` `src/server-setup.ts:85` ; `cli/channel.ts` `new Server(` l.298, `ListToolsRequestSchema` l.340 ; checklist « MCP tool » `docs/ARCHITECTURE.md` l.287-298 ; `docs/openapi.yaml` 43,8 Ko.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
Quatre des cinq points du protocole §6.3 sont exécutables ici tels quels : l'inspection du SDK est déjà faite, la conversion de `coordinator_status` vers `registerTool()` + `pnpm test` est locale, l'observation du comportement de `structuredContent` se fait en branchant Claude Code (v2.1.219 installée) sur `pnpm dev:stdio`, et `requiresUserInteraction` est testable de bout en bout puisque la version installée dépasse les deux planchers documentés (v2.1.199 / v2.1.214) — et `_meta` passe directement par `registerTool`, sans détour par `cli/channel.ts`. Ce qui ne se teste pas : `ttlMs` / `cacheScope`, que le SDK 1.30.0 n'expose pas et qu'aucun client MCP disponible ici n'est connu pour honorer — il faudrait à la fois les injecter dans un handler brut et disposer d'un client instrumenté pour observer le cache.

---

## 1. Ce que c'est

Un ensemble de champs de métadonnées que la spec MCP permet d'attacher aux outils et à leurs résultats, adoptables individuellement sans migrer la révision de protocole négociée. Le cœur est `outputSchema` / `structuredContent` : l'outil déclare un JSON Schema de sortie, et le résultat porte une valeur JSON typée (objet, tableau ou scalaire depuis SEP-2106) à côté — ou à la place — du bloc `content` textuel, ce qui rend la sortie validable et consommable par du code. Autour : `title` (libellé affichable distinct de `name`, l'identifiant programmatique), `icons` (tableau d'objets `Icon` — le client DOIT rejeter les schèmes `javascript:`, `file:`, `ftp:`, `ws:`), `annotations` de contenu (`audience`, `priority`, `lastModified`) et le type de contenu `resource_link` qui retourne un pointeur URI vers une ressource au lieu de l'embarquer dans le contexte. La distinction erreur d'exécution (`isError: true`, que le modèle peut lire et corriger) contre erreur JSON-RPC (protocole) est normative : SEP-1303 impose que les erreurs de validation d'entrée soient des erreurs d'exécution. SEP-2549 ajoute `ttlMs` (entier de millisecondes, sémantique `Cache-Control: max-age`) et `cacheScope` (`"public"` / `"private"`) sur les résultats `resultType: "complete"` des méthodes de liste et de `resources/read` — le serveur DOIT fournir une valeur `>= 0`, l'absence vaut 0, et les résultats issus d'un retry MRTR ne doivent pas être cachés. Enfin quatre utilitaires normatifs jamais utilisés ici : `completion/complete` (autocomplétion des arguments), la pagination par curseur opaque, les notifications de progression et l'annulation. Côté Claude Code s'ajoutent deux annotations propriétaires posées dans l'entrée `tools/list` : `_meta["anthropic/requiresUserInteraction"]` et `_meta["anthropic/maxResultSizeChars"]`.

## 2. Surface d'API exacte

```
Tool.title
Tool.icons                → Icon { src, mimeType, sizes, theme: "light"|"dark" }
Tool.outputSchema         → JSON Schema 2020-12 (tous mots-clés depuis SEP-2106)
Tool.annotations          → readOnlyHint, destructiveHint, idempotentHint, openWorldHint
CallToolResult.structuredContent
CallToolResult.isError
content type "resource_link" { type, uri, name, description, mimeType }
annotations { audience, priority, lastModified }   (sur tout type de contenu)

CacheableResult.ttlMs           (entier ms, >= 0 ; 0 ou absent = périmé ; négatif = ignorer)
CacheableResult.cacheScope      "public" | "private"
  → sur server/discover, tools/list, prompts/list, resources/list,
    resources/templates/list, resources/read

completion/complete                        (server/utilities/completion)
curseur opaque sur les méthodes de liste    (server/utilities/pagination)
notifications/progress + progressToken dans _meta   (basic/patterns/progress)
notifications/cancelled                     (basic/patterns/cancellation)

_meta["anthropic/requiresUserInteraction"]  booléen JSON strict
_meta["anthropic/maxResultSizeChars"]       plafonné à 500 000
MAX_MCP_OUTPUT_TOKENS                       (variable d'env, indépendante)
```

Nommage des outils : 1 à 128 caractères, `[A-Za-z0-9_.-]`, sensible à la casse. `tools/list` DEVRAIT être retourné dans un ordre déterministe (cache client + cache de prompt du LLM).

Exemple d'entrée `tools/list` telle qu'elle pourrait être servie pour `cancel_thread` :

```json
{
  "name": "cancel_thread",
  "title": "Cancel thread",
  "description": "...",
  "inputSchema": { "type": "object", "properties": { "thread_id": { "type": "string" } } },
  "outputSchema": { "type": "object", "properties": { "thread_id": {"type":"string"}, "status": {"type":"string"} } },
  "annotations": { "readOnlyHint": false, "destructiveHint": true },
  "_meta": { "anthropic/requiresUserInteraction": true }
}
```

Note d'implémentation (vérifiée le 2026-08-14 sur `node_modules`, SDK **1.30.0** résolu depuis `^1.29.0`) : `outputSchema` passe par `server.registerTool()` et non par la signature `server.tool(name, description, shape, annotations, handler)` utilisée partout dans ce repo. Signature réelle :

```ts
registerTool(name: string, config: {
  title?: string; description?: string;
  inputSchema?: …; outputSchema?: …;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}, cb): RegisteredTool
```

Conséquences : `outputSchema` **et** `_meta` (donc les deux clés `anthropic/*`) sont exprimables directement via `McpServer`, sans handler brut. `structuredContent` est typé dans `CallToolResult`. Les six surcharges de `server.tool()` sont marquées `@deprecated` dans ce SDK. En revanche `ttlMs` et `cacheScope` **n'existent nulle part dans le SDK 1.30.0** (0 occurrence dans `dist/`) : ils devraient être injectés à la main dans un handler écrit à la main.

`anthropic/requiresUserInteraction` force le prompt de permission à **chaque** appel, y compris en `acceptEdits`, `auto` et `bypassPermissions`, sans option « ne plus demander », et les allow rules ne le contournent pas. En mode `dontAsk` l'appel est refusé. En non-interactif avec `--permission-prompt-tool`, un `allow` est converti en deny avec le message `MCP tool requires user interaction; not supported via --permission-prompt-tool` ; en revanche le callback `canUseTool` de l'Agent SDK peut approuver. Sur Remote Control, l'approbation one-tap est retirée (depuis v2.1.214).

## 3. Sources

- https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/index.md
- https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching.md
- https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/completion.md
- https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation.md
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2025-06-18/changelog
- https://modelcontextprotocol.io/specification/2025-11-25/changelog
- https://code.claude.com/docs/en/mcp.md

## 4. Pourquoi ça concerne mcp-coordinator

**Ce qui est déjà fait (le bundle le sous-estime).** Vérification faite dans le repo : les 26 outils passent tous des `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) et un `title` via le 4ᵉ argument de `server.tool()`, et `docs/ARCHITECTURE.md` (§ « MCP tool », lignes 287-298) en fait une étape obligatoire de la checklist d'ajout d'outil. `isError: true` est déjà utilisé aux bons endroits : `src/tools/dependencies-tools.ts:42` et `:56` (JSON invalide dans `set_dependency_map`), `src/tools/consultation-tools.ts:369`, `src/tools/mqtt-tools.ts:39` (broker injoignable), et trois fois dans `cli/channel.ts`. Le sous-ensemble `title` + `annotations` + `isError` de cette fiche est donc **déjà couvert**, contrairement à ce que suppose la fiche brute `tool-metadata-modern-surface`.

**Bénéfice attendu — ce qui manque réellement.** Aucune occurrence de `outputSchema`, `structuredContent`, `resource_link`, `_meta`, `progressToken` ni de curseur de pagination dans `src/`, `cli/` ou `sdk/src/`. Les 26 handlers retournent tous la même forme : `{ content: [{ type: "text", text: JSON.stringify(x) }] }` — la sortie est un objet JS sérialisé à la main, sans contrat déclaré. Trois gains concrets :

1. **`outputSchema` + `structuredContent`** : `announce_work` retourne aujourd'hui `{ thread, conflicts, context, impact }` stringifié (`src/tools/consultation-tools.ts:173-185`), `coordinator_status` retourne 6 champs agrégés (`src/tools/status-tools.ts:44-53`). Déclarer ces formes rend le contrat vérifiable par le client au lieu d'être documenté nulle part, et le code de sérialisation manuelle devient un `structuredContent: x` direct. Les schémas existent déjà pour la moitié de ces formes côté REST (`src/http/rest-schemas.ts`, `docs/openapi.yaml`, 43 Ko) — c'est une source réutilisable, pas un chantier ex nihilo.
2. **`_meta["anthropic/requiresUserInteraction"]`** : trois outils portent `destructiveHint: true` — `set_dependency_map` (écrase la carte de dépendances de tout l'org), `close_thread`, `cancel_thread`. Aujourd'hui `destructiveHint` n'est qu'un indice consultatif : sous `--dangerously-skip-permissions`, un agent peut purger la carte de dépendances d'une org sans confirmation. `requiresUserInteraction` est le seul mécanisme qui résiste à ce mode. C'est un garde-fou réel là où il n'y en a pas — et le pattern « garde-fou fantôme » identifié à l'audit de juillet.
3. **`_meta["anthropic/maxResultSizeChars"]`** : `get_blast_radius` (graphe de dépendances transitives), `coordinator_status` (liste complète des agents en ligne + modules) et `announce_work` (thread + conflits + contexte de chaque répondant + impact) peuvent rendre gros. Sans annotation, Claude Code applique son seuil par défaut de persistance-sur-disque ; le mainteneur ne sait pas si ces sorties sont tronquées ou spillées.

Secondairement : `ttlMs` + `cacheScope` sur `tools/list`, avec 26 outils re-listés à chaque connexion d'agent ; `notifications/progress` pour `src/git-cochange-builder.ts` (jusqu'à 2000 commits, `COORDINATOR_LAYER4_MAX_COMMITS`) et `src/tree-sitter-extractor.ts` (15 grammaires chargées en `optionalDependencies`) ; `completion/complete` pour compléter les `agent_id`, `thread_id` et chemins de fichiers que le modèle doit aujourd'hui deviner.

**Réserve sur le bénéfice annoncé par le bundle.** La fiche brute justifie `structuredContent` par « consommable par du code (SDK JS, dashboard) ». C'est faux dans ce repo : `sdk/src/client.ts` est un client OAuth/device-code (`McpCoordinatorClient`, `deviceCodePoll`, refresh de jetons), il ne consomme aucun résultat d'outil MCP ; `dashboard/public/` consomme REST + SSE. Le consommateur réel de `structuredContent` serait le client MCP (Claude Code), pas le code maison. Le bénéfice est donc « contrat déclaré et validé côté client », pas « le dashboard peut enfin lire la sortie ».

**Risque si on ne fait rien :** faible côté protocole (tout est additif et rétrocompatible). Le seul risque non nul est le point 2 : les outils destructifs restent sans garde-fou opposable en mode permissions désactivées.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/tools/consultation-tools.ts` | 11 outils, tous en `server.tool(...)` + `JSON.stringify`. `announce_work` (l.173-185) et `get_thread` sont les meilleurs candidats `outputSchema`. `close_thread` (l.313) et `cancel_thread` (l.333) portent `destructiveHint: true` → candidats `requiresUserInteraction`. |
| `src/tools/agents-tools.ts` | 4 outils (`register_agent`, `list_agents`, `heartbeat`, `agent_activity`), 4 `JSON.stringify`. `list_agents` est le candidat pagination si les registres grossissent. |
| `src/tools/dependencies-tools.ts` | 3 outils. `set_dependency_map` (l.32, `destructiveHint: true`) → `requiresUserInteraction`. `get_blast_radius` (l.73) → `maxResultSizeChars`. Les deux `isError` (l.42, l.56) sont déjà conformes à SEP-1303. |
| `src/tools/status-tools.ts` | 2 outils. `coordinator_status` (l.32-70) retourne un objet à 6 champs stringifié — cas d'école pour `outputSchema` + `structuredContent`. |
| `src/tools/files-tools.ts` | 3 outils (`list_hot_files`, `get_session_files`, `check_file_conflict`), tous `readOnlyHint`. `check_file_conflict` → candidat `structuredContent`. |
| `src/tools/mqtt-tools.ts` | 3 outils. `mqtt_publish` (l.95, `openWorldHint: true`) ; `mqttNotConnectedResult()` (l.31-40) fait déjà un `isError` propre. |
| `src/server-setup.ts` | `createMcpServer()` (l.207-250) instancie le `McpServer` et appelle les 6 `register*Tools`. Point d'entrée si l'on ajoute un ordre déterministe de `tools/list` ou des indices de cache. |
| `cli/channel.ts` | `new Server(...)` (l.298) + handler `ListToolsRequestSchema` écrit à la main (l.340-348) : `post_to_thread` y est déclaré **sans** `title`, sans `annotations` et sans `_meta`. C'est l'endroit le plus direct pour poser `ttlMs`/`cacheScope`/`_meta` puisque la liste est construite littéralement. |
| `src/http/rest-schemas.ts` + `docs/openapi.yaml` | Schémas REST déjà maintenus ; source candidate pour dériver les `outputSchema` MCP au lieu de les écrire une seconde fois. |
| `src/git-cochange-builder.ts` | `startScheduler()`, jusqu'à `COORDINATOR_LAYER4_MAX_COMMITS` (défaut 2000) commits — candidat `notifications/progress`. |
| `src/tree-sitter-extractor.ts` | `treeSitter.load()` lancé en fire-and-forget dans `createServices()` (`src/server-setup.ts:84-87`), 15 grammaires — candidat `notifications/progress`. |
| `src/agent-registry.ts`, `src/consultation.ts`, `src/working-files-tracker.ts` | Sources de valeurs pour `completion/complete` : identifiants d'agents, de threads, chemins de fichiers suivis. |
| `docs/ARCHITECTURE.md` (l.287-298) | La checklist « MCP tool » impose déjà les annotations ; à étendre si `outputSchema` devient obligatoire. |
| `package.json` | `@modelcontextprotocol/sdk: ^1.29.0` — détermine ce qui est réellement exprimable (`registerTool`, `ttlMs`). |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Équiper les 26 outils d'un `outputSchema` impose de migrer de `server.tool()` vers `registerTool()` et de maintenir un second schéma par outil : faut-il générer ces schémas depuis `src/http/rest-schemas.ts` / `docs/openapi.yaml` pour garder une seule source de vérité par domaine, ou n'équiper que les 4 outils dont la sortie est structurée et réellement relue (`announce_work`, `coordinator_status`, `check_file_conflict`, `get_blast_radius`) et laisser les 22 autres en `content` texte ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ `ttlMs` / `cacheScope` ne sont pas exécutables ici : absents du SDK 1.30.0, et aucun client MCP disponible localement ne permet d'observer son comportement de cache.

- [ ] Vérifier dans `node_modules/@modelcontextprotocol/sdk` (v1.29.x) que `registerTool()` accepte bien `outputSchema` et que `CallToolResult` accepte `structuredContent` ; vérifier si `ttlMs` / `cacheScope` sont typés dans le SDK ou s'il faut les injecter à la main comme dans `cli/channel.ts`.
- [ ] Convertir **un seul** outil (`coordinator_status`, le plus simple : pas d'arguments, 6 champs) vers `registerTool()` + `outputSchema` + `structuredContent`, lancer `pnpm test` et vérifier qu'aucun test de `tests/unit` ni `tests/integration` ne casse.
- [ ] Brancher Claude Code sur le serveur en stdio (`pnpm dev:stdio`) et observer ce que le client fait réellement de `structuredContent` : est-il affiché, ré-injecté dans le contexte en plus du texte (double coût en tokens), ou ignoré ?
- [ ] Poser `_meta["anthropic/requiresUserInteraction"] = true` sur `set_dependency_map` dans `cli/channel.ts` (liste construite à la main, donc `_meta` injectable directement) ou via l'échappatoire équivalente côté `McpServer`, puis appeler l'outil sous `--dangerously-skip-permissions` et vérifier que le prompt apparaît quand même.
- [ ] Mesurer la taille en caractères de la sortie de `get_blast_radius` et de `announce_work` sur le repo lui-même pour savoir si `maxResultSizeChars` a un objet, ou si on est très en dessous du seuil par défaut.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **La moitié de la fiche est déjà implémentée.** `title`, `annotations` et `isError` sont en place sur les 26 outils. Le delta réel est plus petit que ce que le bundle laisse croire — le tier T1 se justifie par `outputSchema` et `requiresUserInteraction`, pas par la fiche entière.
- **Doublement de la surface de schémas.** Chaque outil équipé d'un `outputSchema` ajoute un contrat à maintenir en plus du `inputSchema` inline et, pour les endpoints en double transport, du schéma REST correspondant. `docs/ARCHITECTURE.md` interdit déjà explicitement d'unifier les payloads REST et MCP — dériver l'`outputSchema` de l'OpenAPI contredit cette règle et risque de recréer le couplage qu'elle écarte.
- **Migration `server.tool()` → `registerTool()` sur 26 sites.** Diff mécanique mais large, qui touche les 6 fichiers de `src/tools/`, invalide la checklist de `docs/ARCHITECTURE.md` et potentiellement des tests. Coût réel non nul pour un gain que personne ne consomme aujourd'hui.
- **Aucun consommateur maison de `structuredContent`.** Ni `sdk/src/` (client OAuth) ni `dashboard/public/` (REST + SSE) ne lisent les résultats d'outils MCP. Le seul bénéficiaire est le client MCP externe — et son comportement face à `structuredContent` (affiche ? ré-injecte en double ? ignore ?) n'a pas été mesuré. Si le client ré-injecte à la fois `content` et `structuredContent`, le coût en tokens **augmente**.
- **`_meta["anthropic/*"]` casse la portabilité.** Ces deux clés sont propriétaires Claude Code. Un client MCP tiers les ignore silencieusement : le garde-fou de `set_dependency_map` n'existerait que pour les utilisateurs Claude Code. Pour un serveur qui se veut agnostique du client, c'est un garde-fou à géométrie variable — exactement le motif qu'on cherche à éviter.
- **`requiresUserInteraction` casse l'automatisation.** Le coordinateur sert des raids d'agents non supervisés. Un `set_dependency_map` qui exige une approbation humaine à chaque appel rend le bootstrap automatisé impossible en non-interactif avec `--permission-prompt-tool` (l'`allow` est converti en deny). Il faut d'abord établir que `set_dependency_map` n'est jamais appelé dans une boucle automatisée.
- **`ttlMs` / `cacheScope` : YAGNI et piège de sécurité.** `tools/list` est aujourd'hui identique pour toutes les orgs (les `register*Tools` sont statiques, indépendants de `claims.org`), donc `cacheScope: "public"` serait techniquement correct — mais le jour où un gating d'outils par org apparaît, un cache partagé devient une fuite inter-tenant. Le gain (26 entrées relistées à la connexion) ne justifie probablement pas d'introduire ce risque latent maintenant.
- **Pagination et `completion/complete` : pas de problème constaté.** Le repo est mono-utilisateur / petites orgs ; aucune liste d'agents ou de threads ne pose de problème de taille aujourd'hui. Ce sont des capacités à implémenter quand une plainte existe, pas par conformité.
- **Incohérence relevée dans la spec elle-même.** Le chercheur note que `server/utilities/logging` existe toujours comme page normative alors que Logging est au registre des dépréciés (SEP-2577) et que `logging/setLevel` a été supprimé (SEP-2575). Signe qu'une partie de la révision 2026-07-28 bouge encore ; ne pas s'y adosser aveuglément.
- **Incertitude SDK non levée.** Le support de `outputSchema`, `structuredContent`, `ttlMs` et `cacheScope` par `@modelcontextprotocol/sdk@^1.29.0` n'a pas été vérifié. Si le SDK ne les expose pas, il faut retomber sur des handlers bruts à la `cli/channel.ts` — ce qui change complètement l'estimation d'effort (M → L).

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
| 2026-08-14 | Fiche créée par la veille plateforme. Fusion de 4 fiches brutes (`tool-metadata-modern-surface`, `cacheable-results-ttlms`, `mcp-forgotten-server-utilities`, `cc-mcp-meta-annotations`). Vérification repo : `title`/`annotations`/`isError` déjà en place sur les 26 outils ; aucune occurrence de `outputSchema`, `structuredContent`, `resource_link`, `_meta`, `progressToken` ou pagination. |
| 2026-08-14 | Vérification des faits : SDK réel 1.30.0 (`registerTool` accepte `outputSchema` + `_meta`, `ttlMs`/`cacheScope` absents) ; 4 lignes de §5 corrigées. |
