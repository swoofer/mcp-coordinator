# A06 — Surface d'outils moderne : outputSchema, annotations, ttlMs, progress

| Champ | Valeur |
|---|---|
| **ID** | `tool-metadata-modern-surface` |
| **Surface** | mcp-spec (+ claude-code pour les annotations `_meta` propriétaires) |
| **Statut** | GA |
| **Disponible depuis** | `structuredContent`, `resource_link`, `title`, `_meta` : rév. 2025-06-18 · `icons` : 2025-11-25 (SEP-973) · assouplissement des schémas : 2026-07-28 (SEP-2106) · `ttlMs`/`cacheScope` : 2026-07-28 (SEP-2549) · `anthropic/requiresUserInteraction` : Claude Code v2.1.199 |
| **Tier** | ~~T1-incontournable~~ **T3** — déclassée au challenge du 2026-08-15 : les trois volets décidables sont refusés (§7) ; ce qui reste (`ttlMs`/`cacheScope`) arrive gratuitement avec #286 |
| **Nature** | opportunity |
| **Effort estimé** | ~~M~~ **sans objet** — rien à coder |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ~~⚠️ partielle — `ttlMs`/`cacheScope` absents du SDK~~ → ✅ **testable** (corrigé au challenge du 2026-08-15 : le SDK v2 les émet d'office, mesuré en §6.4 (5)) |
| **Statut du challenge** | ✅ **tranché** — 2026-08-15, verdict `refuser` (§7) |

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

*Pré-enregistré le 2026-08-15, AVANT toute exécution.*

> 🔧 **La §0 est périmée sur `ttlMs`/`cacheScope`, comme celle d'`A05` l'était sur Tasks.** Elle les
> dit « absents du SDK » et « non exécutables ». Vrai pour `@modelcontextprotocol/sdk@1.30.0`, faux
> pour la ligne v2 : le PoC `createMcpHandler` du challenge
> [`A01`](A01-mcp-2026-07-28-stateless.md) (§6.4 (2), même journée) les a rendus **spontanément**
> dans les réponses `server/discover` **et** `tools/list` :
> `"resultType":"complete","ttlMs":0,"cacheScope":"private"`. Le SDK v2 les fournit sans qu'on
> écrive une ligne. Ce point sort donc du « non testable » et entre dans le protocole ci-dessous.

**Hypothèse.** La fiche a raison de dire que la moitié est déjà faite (`title`, `annotations`,
`isError`). Sur ce qui reste, je m'attends à un partage net :

- **`outputSchema` / `structuredContent`** : je m'attends à ce que ce soit un **coût en tokens, pas
  une économie**, parce que le client aura besoin du texte pour le modèle *et* recevra la structure
  — donc double injection. Si c'est le cas, équiper 26 outils est une régression.
- **`requiresUserInteraction`** : je m'attends à ce que ce soit le **seul gain réel** de la fiche,
  et le seul qui touche à la sécurité. C'est aussi le seul mesurable de bout en bout.
- **`ttlMs`/`cacheScope`** : fourni gratuitement par le SDK v2, donc sans décision à prendre — il
  arrivera avec [#286](https://github.com/swoofer/mcp-coordinator/issues/286).

**Critères de refus (ce qui me ferait conclure « non bénéfique maintenant ») :**

- **A06-R1 — `structuredContent` coûte au lieu de rapporter.** Si Claude Code ré-injecte **à la
  fois** `content` et `structuredContent` dans le contexte, équiper les outils **augmente** la
  consommation de tokens. Seuil : si le surcoût mesuré dépasse **+20 %** sur un appel d'outil
  représentatif, la généralisation est disqualifiée.
- **A06-R2 — le garde-fou ne tient pas.** Si `_meta["anthropic/requiresUserInteraction"]` ne
  provoque **pas** de prompt sous `--dangerously-skip-permissions`, le seul bénéfice sécurité de la
  fiche est un garde-fou fantôme de plus, et §4 point 2 est faux.
- **A06-R3 — la migration n'est pas mécanique.** Si convertir **un** outil vers `registerTool()`
  casse des tests ou demande plus qu'un changement de forme d'appel, l'estimation `M` pour 26 sites
  ne tient pas.
- **A06-R4 — `maxResultSizeChars` sans objet.** Si les sorties réelles de `get_blast_radius` et
  `announce_work` sont **très en dessous** du plafond (≤ 10 % de 500 000 caractères), l'annotation
  ne protège de rien.
- **A06-R5 — garde-fou à géométrie variable.** `_meta["anthropic/*"]` est propriétaire : si le gain
  n'existe que pour les utilisateurs Claude Code, il faut le dire et décider si un serveur qui se
  veut agnostique l'assume.

### 6.3 Protocole de vérification

*Amendé en session le 2026-08-15. Les cinq points de la veille sont conservés ; le point sur
`ttlMs`/`cacheScope` sort du « non exécutable » (voir l'encadré de §6.2) et devient le point (6).*

- [ ] **(1)** SDK 1.30.0 : `registerTool()` accepte-t-il `outputSchema`, `_meta` ?
      `CallToolResult` accepte-t-il `structuredContent` ? (§0 le dit — vérification de cohérence.)
- [ ] **(2)** Convertir **un seul** outil vers `registerTool()` + `outputSchema` +
      `structuredContent` **dans une copie jetable**, et lancer les tests. → A06-R3.
- [ ] **(3)** Brancher Claude Code et **mesurer les tokens** : que fait-il réellement de
      `structuredContent` — affiché, ré-injecté en double, ignoré ? → A06-R1, le point décisif.
- [ ] **(4)** Poser `_meta["anthropic/requiresUserInteraction"] = true` sur un outil destructif et
      l'appeler **sous `--dangerously-skip-permissions`** : le prompt apparaît-il ? → A06-R2.
- [ ] **(5)** Mesurer la taille réelle des sorties de `get_blast_radius` et `announce_work` sur ce
      dépôt. → A06-R4.
- [ ] **(6) NOUVEAU** — constater ce que le SDK v2 rend déjà en `ttlMs`/`cacheScope`, et sur
      quelles méthodes, pour savoir s'il reste une décision à prendre.

- [ ] Vérifier dans `node_modules/@modelcontextprotocol/sdk` (v1.29.x) que `registerTool()` accepte bien `outputSchema` et que `CallToolResult` accepte `structuredContent` ; vérifier si `ttlMs` / `cacheScope` sont typés dans le SDK ou s'il faut les injecter à la main comme dans `cli/channel.ts`.
- [ ] Convertir **un seul** outil (`coordinator_status`, le plus simple : pas d'arguments, 6 champs) vers `registerTool()` + `outputSchema` + `structuredContent`, lancer `pnpm test` et vérifier qu'aucun test de `tests/unit` ni `tests/integration` ne casse.
- [ ] Brancher Claude Code sur le serveur en stdio (`pnpm dev:stdio`) et observer ce que le client fait réellement de `structuredContent` : est-il affiché, ré-injecté dans le contexte en plus du texte (double coût en tokens), ou ignoré ?
- [ ] Poser `_meta["anthropic/requiresUserInteraction"] = true` sur `set_dependency_map` dans `cli/channel.ts` (liste construite à la main, donc `_meta` injectable directement) ou via l'échappatoire équivalente côté `McpServer`, puis appeler l'outil sous `--dangerously-skip-permissions` et vérifier que le prompt apparaît quand même.
- [ ] Mesurer la taille en caractères de la sortie de `get_blast_radius` et de `announce_work` sur le repo lui-même pour savoir si `maxResultSizeChars` a un objet, ou si on est très en dessous du seuil par défaut.

### 6.4 Résultat observé

*Session du 2026-08-15, Windows 11 / Node 22.21.0 / **Claude Code 2.1.233**. Tout ce qui suit a été
exécuté. Frontière exécuté / lu au (6).*

---

#### (1) `structuredContent` ne coûte rien — le client **remplace** le texte, il ne l'ajoute pas

Stub `scratchpad/v1probe/a06-stub.mjs` (SDK **1.30.0**, la version du dépôt) : trois outils qui
rendent **le même payload** sous trois formes. `--output-format stream-json` pour lire le
`tool_result` réellement injecté dans le contexte du modèle.

| Outil | Ce que le serveur renvoie | Ce que le client injecte |
|---|---|---|
| `status_text` | `content: [texte JSON]` | le JSON, **798 c.** |
| `status_structured` | `content: [texte JSON]` + `structuredContent` | le JSON, **une seule fois** |
| `status_structured_min` | `content: [{text:"ok"}]` + `structuredContent` | **le JSON complet** — pas `"ok"` |

Extrait brut du `tool_result` de `status_structured_min` — le serveur n'a mis que `"ok"` dans
`content` :

```json
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01VMumKH…","type":"tool_result",
"content":"{\"agents_online\":7,\"active_threads\":3,\"working_files\":12,\"conflicts_open\":1,
\"org\":\"default\",\"agents\":[{\"id\":\"agent-0\",…}]}"}]}}
```

**Claude Code sérialise `structuredContent` à la place du bloc texte.** → **A06-R1 non déclenché**,
et mon hypothèse était fausse : il n'y a **pas** de double injection.

Comptage de tokens (3 exécutions par forme, `--output-format json`, entrée totale = `input` +
`cache_creation` + `cache_read`) : `status_text` 108 446 · `status_structured` 108 437 ·
`status_structured_min` 108 431. L'écart (~15 tokens) est **noyé dans la variance inter-run
(±120)** — mesure non concluante en soi, mais cohérente avec l'observation directe ci-dessus, qui
elle est nette.

*Observation annexe :* les traces portent `"total_deferred_tools":21` et un premier `tool_result` de
type `tool_reference` (`"query":"select:mcp__a06__status_structured"`) — le **tool search de
[`C06`](C06-tool-search-defer-loading.md) en action**, confirmé sur un serveur tiers.

---

#### (2) `outputSchema` est un contrat **vérifié par le SDK**, pas une déclaration

`scratchpad/v1probe/a06-validate.mjs` — un serveur dont les handlers violent leur propre
`outputSchema`, appelés par un vrai client MCP via `InMemoryTransport` :

```
conforme           -> PASSE   isError=false  structuredContent={"agents_online":7,"org":"default"}
mauvais_type       -> PASSE   isError=true   structuredContent=undefined
champ_manquant     -> PASSE   isError=true   structuredContent=undefined
sans_structured    -> PASSE   isError=true   structuredContent=undefined
erreur_texte_seul  -> PASSE   isError=true   structuredContent=undefined
```

Trois enseignements :

1. **Le SDK valide vraiment.** Mauvais type, champ manquant : la sortie est transformée en
   `isError: true` et `structuredContent` est retiré. Sur 26 handlers qui font tous
   `JSON.stringify(x)` à la main, c'est un filet de correction réel.
2. **Piège :** déclarer un `outputSchema` **oblige** à toujours renvoyer un `structuredContent`
   conforme — `sans_structured` (schéma déclaré, texte seul) devient une erreur. Toute branche de
   succès doit être convertie, pas seulement la principale.
3. **Mais les chemins d'erreur existants ne cassent pas** : `erreur_texte_seul` reproduit la forme
   de `dependencies-tools.ts:42` (`isError: true` + texte) et ressort inchangé. La migration ne
   force pas à réécrire les 6 `isError` du dépôt.

---

#### (3) `requiresUserInteraction` : le garde-fou tient, mesuré, avec témoin

Deux outils **identiques** (mêmes annotations `destructiveHint: true`), l'un portant
`_meta["anthropic/requiresUserInteraction"]: true`, l'autre non. Appelés **sous
`--dangerously-skip-permissions`**, 3 exécutions chacun :

```
########## AVEC requiresUserInteraction, sous --dangerously-skip-permissions ##########
[wipe_dependency_map #1] outil appele: NON | EXECUTE: NON | « le harnais a bloqué l'appel »
[wipe_dependency_map #2] outil appele: OUI | EXECUTE: NON | « bloqué par la couche de permissions du harness »
[wipe_dependency_map #3] outil appele: NON | EXECUTE: NON | « Le harnais a b… »

########## TEMOIN : meme outil SANS l'annotation, meme mode ##########
[wipe_dependency_map_unguarded #1] outil appele: OUI | EXECUTE: OUI | « carte de default ecrasee »
[wipe_dependency_map_unguarded #2] outil appele: OUI | EXECUTE: OUI | « carte de default ecrasee »
[wipe_dependency_map_unguarded #3] outil appele: OUI | EXECUTE: OUI | « carte de default ecrasee »
```

**Séparation parfaite : 0/3 contre 3/3.** → **A06-R2 non déclenché.** La §4 point 2 dit vrai :
c'est le seul mécanisme qui résiste au mode où toutes les permissions sont désactivées, et
`destructiveHint` seul ne protège de rien (le témoin le prouve).

**Mais la forme du blocage compte** : en `-p`, l'outil n'est pas *soumis à confirmation*, il est
**refusé net**. Aucun chemin de passage pour un agent non surveillé — exactement la forme de
blocage mesurée en [`A03`](A03-mrtr-input-required.md) §6.4 (8).

---

#### (3 bis) …mais il n'y a rien à garder : le §4 point 2 de la fiche est **faux**

*Section ajoutée après la passe adversariale. Vérifiée ligne à ligne moi-même, parce qu'elle
renverse le seul argument sécurité de la fiche.*

La fiche justifie `requiresUserInteraction` par : *« `set_dependency_map` (écrase la carte de
dépendances de tout l'org) […] sous `--dangerously-skip-permissions`, un agent peut purger la carte
de dépendances d'une org sans confirmation »*. **C'est faux.**

**a. `setMap` est un upsert, pas un écrasement.** `src/dependency-map.ts:118-137` :

```sql
INSERT INTO dependency_map (org_id, module_id, depends_on, exports, owners)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(org_id, module_id) DO UPDATE SET
  depends_on = excluded.depends_on, exports = excluded.exports, owners = excluded.owners
```

Une boucle d'upsert dans une transaction. **Aucun `DELETE`.** Les modules absents du payload
survivent intacts. Le pire cas n'est pas « purger la carte de l'org », c'est « réécrire les modules
qu'on vient soi-même de nommer » — et c'est rejouable.

**b. Les deux autres outils destructifs sont des `UPDATE`, et ils sont déjà gardés — côté
serveur.** `src/consultation.ts` :

```ts
:343  cancelThread → if (thread.initiator_id !== agentId) throw new Error("Only the initiator can cancel");
:346                 UPDATE threads SET status = 'cancelled', resolved_at = ? …
:360  closeThread  → if (thread.initiator_id !== agentId) throw new Error(`Only the initiator (…) may close …`);
:365                 + refus de tout statut hors 'open' / 'resolving'
```

Zéro ligne supprimée, zéro message perdu — et une **autorisation serveur qui vaut pour tous les
clients**, pas seulement Claude Code.

**c. L'inventaire est complet et il n'y a pas de quatrième candidat.** Exactement **3** outils
portent `destructiveHint: true` :

```
src\tools\dependencies-tools.ts:32  { readOnlyHint: false, destructiveHint: true, title: "Set dependency map" }
src\tools\consultation-tools.ts:323 { readOnlyHint: false, destructiveHint: true, title: "Close thread" }
src\tools\consultation-tools.ts:341 { readOnlyHint: false, destructiveHint: true, title: "Cancel thread" }
```

**d. Et la seule opération réellement destructive du dépôt est hors de portée de toute annotation
MCP — mais déjà mieux gardée.** `src/http/rest-handlers.ts:729-741` : `/api/reset` fait
`DELETE FROM` sur **10 tables**, dont `dependency_map`, `threads` et `agents`. C'est une route
**REST**, sans équivalent outil MCP : aucun `_meta` ne pourrait la protéger. Elle porte déjà sa
propre garde, serveur et client-agnostique (`rest-handlers.ts:717-727`) :

```ts
if (!canResetDb(process.env, authEnabled)) → 403
  "requires NODE_ENV=test, COORDINATOR_ALLOW_RESET=true, or COORDINATOR_AUTH_ENABLED with admin token"
```

→ **Le mécanisme marche (3), mais il n'a rien à protéger.** La formule de §4 — « un garde-fou réel
là où il n'y en a pas » — est exactement l'inverse de la réalité : la garde existe déjà, elle est
serveur, et elle couvre les quatre clients que le README promet.

---

#### (4) `maxResultSizeChars` ne protège de rien

Daemon réel, peuplé de 8 agents et d'une carte de dépendances de 60 modules
(`scratchpad/v1probe/a06-sizes.mjs`) :

```
=== taille des sorties d'outils (daemon reel) ===
coordinator_status     :     633 caracteres  (0.127 % du plafond 500 000)
list_agents            :    1489 caracteres  (0.298 % du plafond 500 000)
get_blast_radius       :     150 caracteres  (0.030 % du plafond 500 000)
announce_work          :    1705 caracteres  (0.341 % du plafond 500 000)
```

La plus grosse sortie fait **0,34 %** du plafond. → **A06-R4 déclenché** : l'annotation n'a pas
d'objet. *Réserve :* `get_blast_radius` n'a rendu que 150 caractères — le format de carte que j'ai
injecté ne correspond peut-être pas à ce qu'il attend, donc ce chiffre-là est un plancher, pas une
mesure du pire cas.

---

#### (5) `ttlMs` / `cacheScope` : plus rien à décider

La §0 les dit non testables (absents du SDK 1.30.0). Vrai pour la ligne v1 — mais le PoC
`createMcpHandler` du challenge [`A01`](A01-mcp-2026-07-28-stateless.md) (§6.4 (2), même journée)
les a rendus **spontanément**, sans une ligne de configuration :

```
=== server/discover ===  {"supportedVersions":["2026-07-28"], … "resultType":"complete","ttlMs":0,"cacheScope":"private"}
=== tools/list ===       {"tools":[…],"resultType":"complete","ttlMs":0,"cacheScope":"private"}
```

Le SDK v2 les émet par défaut en `private` / `0`. Il n'y a donc **pas de décision à prendre** :
ils arriveront avec [#286](https://github.com/swoofer/mcp-coordinator/issues/286). Et le défaut
`private` désamorce d'office le piège inter-tenant que §6.5 signalait.

---

#### (5 bis) Combien des 26 outils peuvent réellement porter un `outputSchema` ? Mesuré.

*Section ajoutée après la seconde passe adversariale. C'est elle qui tue le volet `outputSchema`.*

`scratchpad/v1probe/a06-eligibilite.mjs` — cinq formes de retour, `registerTool` + SDK 1.30.0,
appelées par un vrai client :

```
=== outputSchema present dans tools/list ? ===
  objet           -> OUI (object)
  tableau         -> ABSENT          <-- disparait silencieusement de tools/list
  null_legitime   -> OUI (object)
  union           -> OUI (object)
  champ_en_trop   -> OUI (object)

=== appel de chaque outil ===
  objet           -> isError=false  sc={"a":1}
  tableau         -> isError=true   | Cannot read properties of undefined (reading '_zod')
  null_legitime   -> isError=true   | MCP error -32602: Output validation error: Tool null_legitime
                                       has an output schema but no structured content
  union           -> isError=false  sc={"resultat":{"timeout":true}}
  champ_en_trop   -> LANCE  MCP error -32602: Structured content does not match the tool's output
                            schema: data must NOT have additional properties
```

Trois faits, tous décisifs :

1. **Un retour tableau à la racine est structurellement inéligible.** Le schéma disparaît
   silencieusement de `tools/list`, **et l'appel plante** (`Cannot read properties of undefined`).
   Or c'est la forme de `list_agents` (`agents-tools.ts:63`), `agent_activity`, `list_hot_files`,
   `get_session_files`, `get_thread_updates`, `list_threads`, `get_queued_messages` — **sept
   outils**. Et `list_agents` est justement **la plus grosse sortie mesurée** au (4).
2. **Un `null` légitime devient une erreur dure.** `get_module_info` rend `null` quand le module
   n'existe pas (`dependencies-tools.ts:101`) : avec un `outputSchema`, « pas trouvé » se
   transforme en `-32602`.
3. **🔴 La dérive additive ne passe pas — elle lève.** `registerTool` génère un schéma **strict**
   (`additionalProperties: false`) : ajouter un champ à la sortie fait **échouer l'outil**.
   `src/database.ts` montre que la table `threads` a déjà gagné 5 colonnes par migration
   (`claimed_by`, `claimed_at`, `unclaim_count`, `assigned_to`, `run_id`), et `announce_work`
   renvoie l'objet `Thread` **brut** (`consultation-tools.ts:177`). Il n'existe aucun lien
   compile-time entre `src/types.ts` et un schéma zod écrit à la main : **la prochaine migration
   casserait `announce_work` en production, à l'exécution.**

*Note :* sur ce dernier point je contredis le sous-agent adversarial, qui avait mesuré la dérive
additive comme bénigne. Mon essai la trouve **fatale**. C'est la mesure ci-dessus qui fait foi.

#### (5 ter) `docs/openapi.yaml` ne peut rien fournir — la §4 le croit à tort

`docs/openapi.yaml`, lignes 1-9, texte du fichier :

```yaml
info:
  title: mcp-coordinator Phase 2 Auth API
  description: |
    OAuth 2.1 + RFC 8628 device flow + cookie sessions + service tokens.
    This spec covers the Phase 2 auth surface that activates when
    `COORDINATOR_OAUTH_ENABLED=true`. Phase 1 REST + MCP routes are
    documented elsewhere and are NOT in scope here.
```

Le document ne couvre **que l'auth**. Aucun des outils visés n'y a d'équivalent. Et
`src/http/rest-schemas.ts` ne contient que des schémas de **corps de requête**, jamais de réponse.
→ **§4 point 1 (« les schémas existent déjà pour la moitié de ces formes côté REST — c'est une
source réutilisable ») est faux.** Le premier terme de la question §6.1 (« générer les schémas
depuis `rest-schemas.ts` / `openapi.yaml` ») n'est pas un arbitrage : il est **impossible**.

#### (6) Frontière exécuté / lu

**Exécuté :** les trois formes de retour contre Claude Code 2.1.233 (9 lancements + 3 en
`stream-json`), la validation `outputSchema` par le SDK (5 cas), le garde-fou avec témoin
(6 lancements sous `--dangerously-skip-permissions`), les tailles de sortie contre le daemon réel.

**Lu, non exécuté :** la conversion des 26 sites `server.tool()` → `registerTool()`. La forme
d'appel réelle (`src/tools/status-tools.ts:32-36` :
`server.tool(nom, description, shape, { readOnlyHint: true, title: "…" }, handler)`) montre que
`title` vit **dans** l'objet d'annotations, alors que `registerTool` en fait deux clés distinctes —
donc la conversion n'est pas un pur renommage. Le codemod du challenge
[`A02`](A02-mcp-sdk-typescript-v2.md) a néanmoins réécrit ces 26 sites sans une seule erreur `tsc`
dans `src/`, ce qui borne le risque. **Aucun verdict ne repose sur ce point.**

### 6.5 Contre-arguments

*Repris le 2026-08-15 après l'expérience et deux passes adversariales. Barré = tombé.
**Deux sont tombés, et cinq sont apparus — dont trois qui tuent la fiche.***

- ~~**Aucun consommateur maison de `structuredContent`** … « si le client ré-injecte à la fois
  `content` et `structuredContent`, le coût en tokens augmente ».~~ **La seconde moitié TOMBE :**
  mesuré, Claude Code injecte `structuredContent` **à la place** du texte, pas en plus (§6.4 (1)).
  La première moitié tient : aucun consommateur maison.
- ~~**Incertitude SDK non levée** (`outputSchema`, `structuredContent`, `ttlMs`, `cacheScope`).~~
  **TOMBE.** `registerTool` accepte `outputSchema` et `_meta` en 1.30.0 ; le SDK **valide**
  (§6.4 (2)) ; et `ttlMs`/`cacheScope` sont émis d'office par le SDK v2 (§6.4 (5)).
- **La moitié de la fiche est déjà implémentée.** `title`, `annotations` et `isError` sont en place sur les 26 outils. Le delta réel est plus petit que ce que le bundle laisse croire — le tier T1 se justifie par `outputSchema` et `requiresUserInteraction`, pas par la fiche entière.
- **Doublement de la surface de schémas.** Chaque outil équipé d'un `outputSchema` ajoute un contrat à maintenir en plus du `inputSchema` inline et, pour les endpoints en double transport, du schéma REST correspondant. `docs/ARCHITECTURE.md` interdit déjà explicitement d'unifier les payloads REST et MCP — dériver l'`outputSchema` de l'OpenAPI contredit cette règle et risque de recréer le couplage qu'elle écarte.
- **Migration `server.tool()` → `registerTool()` sur 26 sites.** Diff mécanique mais large, qui touche les 6 fichiers de `src/tools/`, invalide la checklist de `docs/ARCHITECTURE.md` et potentiellement des tests. Coût réel non nul pour un gain que personne ne consomme aujourd'hui.
- **Aucun consommateur maison de `structuredContent`.** Ni `sdk/src/` (client OAuth) ni `dashboard/public/` (REST + SSE) ne lisent les résultats d'outils MCP. Le seul bénéficiaire est le client MCP externe — et son comportement face à `structuredContent` (affiche ? ré-injecte en double ? ignore ?) n'a pas été mesuré. Si le client ré-injecte à la fois `content` et `structuredContent`, le coût en tokens **augmente**.
- **`_meta["anthropic/*"]` casse la portabilité.** Ces deux clés sont propriétaires Claude Code. Un client MCP tiers les ignore silencieusement : le garde-fou de `set_dependency_map` n'existerait que pour les utilisateurs Claude Code. Pour un serveur qui se veut agnostique du client, c'est un garde-fou à géométrie variable — exactement le motif qu'on cherche à éviter.
- **`requiresUserInteraction` casse l'automatisation.** Le coordinateur sert des raids d'agents non supervisés. Un `set_dependency_map` qui exige une approbation humaine à chaque appel rend le bootstrap automatisé impossible en non-interactif avec `--permission-prompt-tool` (l'`allow` est converti en deny). Il faut d'abord établir que `set_dependency_map` n'est jamais appelé dans une boucle automatisée.
- **`ttlMs` / `cacheScope` : YAGNI et piège de sécurité.** `tools/list` est aujourd'hui identique pour toutes les orgs (les `register*Tools` sont statiques, indépendants de `claims.org`), donc `cacheScope: "public"` serait techniquement correct — mais le jour où un gating d'outils par org apparaît, un cache partagé devient une fuite inter-tenant. Le gain (26 entrées relistées à la connexion) ne justifie probablement pas d'introduire ce risque latent maintenant.
- **Pagination et `completion/complete` : pas de problème constaté.** Le repo est mono-utilisateur / petites orgs ; aucune liste d'agents ou de threads ne pose de problème de taille aujourd'hui. Ce sont des capacités à implémenter quand une plainte existe, pas par conformité.
- **Incohérence relevée dans la spec elle-même.** Le chercheur note que `server/utilities/logging` existe toujours comme page normative alors que Logging est au registre des dépréciés (SEP-2577) et que `logging/setLevel` a été supprimé (SEP-2575). Signe qu'une partie de la révision 2026-07-28 bouge encore ; ne pas s'y adosser aveuglément.

**Ajoutés par l'expérience — les trois premiers tuent la fiche :**

- **🔴 Sept outils sur 26 ne PEUVENT pas porter d'`outputSchema`.** Un retour tableau à la racine
  fait disparaître le schéma de `tools/list` **et plante l'appel** (§6.4 (5 bis)). Concerne
  `list_agents`, `agent_activity`, `list_hot_files`, `get_session_files`, `get_thread_updates`,
  `list_threads`, `get_queued_messages`. Plus `get_module_info` (un `null` légitime devient
  `-32602`) et `set_dependency_map` (rend `"ok"`). **La question de §6.1 — « les 26 outils ou
  4 ? » — repose donc sur un choix qui n'existe pas.**
- **🔴 `outputSchema` génère un schéma STRICT : la prochaine migration casse l'outil.** Ajouter un
  champ à la sortie lève `-32602 … data must NOT have additional properties`. La table `threads` a
  déjà pris 5 colonnes par migration et `announce_work` renvoie l'objet `Thread` brut, sans lien
  compile-time avec un schéma zod écrit à la main. On échangerait **zéro bug attrapé** contre un
  **nouveau mode de panne à l'exécution**.
- **🔴 Le volet sécurité repose sur un fait faux.** `setMap` est un **upsert**, pas un écrasement ;
  `close_thread`/`cancel_thread` sont des `UPDATE` déjà gardés par `initiator_id` **côté serveur**,
  donc pour tous les clients ; et la seule opération réellement destructive (`/api/reset`,
  10 `DELETE FROM`) est une route REST hors de portée de toute annotation MCP, et déjà gardée
  (§6.4 (3 bis)).
- **Le premier terme de §6.1 est impossible, pas discutable.** `docs/openapi.yaml` déclare
  lui-même : *« Phase 1 REST + MCP routes … are NOT in scope here »* — il ne couvre que l'auth. Et
  `rest-schemas.ts` n'a que des schémas d'entrée. **0 / 4** des outils visés a un schéma de réponse
  REST réutilisable (§6.4 (5 ter)).
- **Adopter partiellement rendrait `tools/list` incohérent.** Les 26 sites passent `title` **dans**
  l'objet d'annotations ; `registerTool` le remonte à la racine de l'entrée `tools/list`. Équiper
  4 outils produirait 4 entrées avec `title` racine et 22 avec `annotations.title` — et obligerait
  la checklist de `docs/ARCHITECTURE.md` (l.287-298) à décrire deux formes.
- **Conflit de calendrier avec [#286](https://github.com/swoofer/mcp-coordinator/issues/286).**
  L'issue ouverte le même jour exclut explicitement `registerTool`/`outputSchema` de son périmètre
  **et** fait passer un codemod sur les 6 mêmes fichiers `src/tools/*.ts`. Toucher ces fichiers
  avant, c'est les toucher deux fois.
- **Incertitude SDK non levée.** Le support de `outputSchema`, `structuredContent`, `ttlMs` et `cacheScope` par `@modelcontextprotocol/sdk@^1.29.0` n'a pas été vérifié. Si le SDK ne les expose pas, il faut retomber sur des handlers bruts à la `cli/channel.ts` — ce qui change complètement l'estimation d'effort (M → L).

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** |
| **Date** | 2026-08-15 |
| **Justification** | **Les trois volets décidables sont morts, chacun pour une raison mesurée.** (1) `outputSchema` : **7 outils sur 26 ne peuvent pas le porter** — un retour tableau fait disparaître le schéma de `tools/list` *et plante l'appel* — et le schéma généré est **strict**, donc la prochaine migration de `threads` casserait `announce_work` à l'exécution. Zéro bug historique qu'il aurait attrapé, zéro demande sur ~290 issues. (2) `requiresUserInteraction` : le mécanisme marche (0/3 contre 3/3 sous `--dangerously-skip-permissions`) mais **il n'a rien à garder** — `setMap` est un upsert, `close_thread`/`cancel_thread` sont des `UPDATE` déjà gardés par `initiator_id` côté serveur, et la seule vraie destruction (`/api/reset`) est hors de portée d'une annotation MCP. (3) `maxResultSizeChars` : la plus grosse sortie réelle fait **0,34 %** du plafond. |
| **Issue / PR** | — (aucune : rien à coder) |
| **Jalon visé** | — |

### 7.1 La réponse à la question de §6.1

**La question ne peut pas être posée telle quelle.** Elle propose un choix entre « générer les
`outputSchema` depuis l'OpenAPI » et « n'équiper que 4 outils ». Les deux termes s'effondrent :

- **Le premier est impossible**, pas discutable : `docs/openapi.yaml` déclare lui-même ne couvrir
  que l'auth (« Phase 1 REST + MCP routes … are NOT in scope here »), et `rest-schemas.ts` n'a que
  des schémas d'entrée. **0 / 4** des outils visés a un schéma de réponse REST réutilisable.
- **Le second suppose que « 26 outils » soit l'autre borne. Il ne l'est pas** : **7 outils rendent
  un tableau à la racine** et sont structurellement inéligibles — le SDK 1.30.0 laisse tomber le
  schéma silencieusement puis **plante l'appel**. Le plafond réel est ~17, pas 26. Et parmi les
  4 candidats de la question, trois sont mauvais : `check_file_conflict` rend deux champs dont un
  booléen (cérémonie pure), `get_blast_radius` imposerait de redéclarer les 24 champs de `Thread`
  pour une sortie mesurée à **150 caractères**, et `announce_work` renvoie l'objet `Thread` brut —
  c'est-à-dire précisément la structure qui bouge.

**Le vrai motif du refus n'est ni le coût ni le périmètre : c'est que le schéma est strict.**
Mesuré : un champ en trop dans `structuredContent` lève `-32602 … data must NOT have additional
properties`. `src/database.ts` montre 5 colonnes ajoutées à `threads` par migration. Il n'existe
aucun lien compile-time entre `src/types.ts` et un schéma zod écrit à la main. On introduirait donc
un mode de panne **à l'exécution, en production, au prochain `ALTER TABLE`** — contre un bénéfice
que rien ne documente : `git log -- src/tools/` depuis `v2.0.0` ne montre **aucun** bug de forme de
sortie, et ~290 issues n'en mentionnent **aucune** demande.

### 7.2 Ce qui n'est pas une décision — et qui arrive quand même

Deux éléments de cette fiche ne demandent aucun arbitrage :

- **`ttlMs` / `cacheScope`** : le SDK v2 les émet **d'office** sur `server/discover` et `tools/list`
  (`"resultType":"complete","ttlMs":0,"cacheScope":"private"` — mesuré en
  [`A01`](A01-mcp-2026-07-28-stateless.md) §6.4 (2)). Ils arriveront avec
  [#286](https://github.com/swoofer/mcp-coordinator/issues/286), et le défaut `private` désamorce
  d'office le risque de fuite inter-tenant que §6.5 signalait.
- **`title` / `annotations` / `isError`** : déjà en place sur les 26 outils, comme §4 le disait.

### 7.3 Ce qui est écarté, avec la raison précise

| Volet | Raison |
|---|---|
| `outputSchema` + `structuredContent` | 7/26 inéligibles ; schéma strict ⇒ panne au prochain `ALTER TABLE` ; 0 bug historique, 0 demande ; `title` migrerait sur le fil pour 4 outils sur 26 ; conflit de diff avec #286 |
| `_meta["anthropic/requiresUserInteraction"]` | Rien à garder (§6.4 (3 bis)) ; la garde utile existe déjà côté serveur et vaut pour tous les clients ; contredirait le « client-agnostic » imprimé dans `cli/init.ts:306` et le README |
| `_meta["anthropic/maxResultSizeChars"]` | Sortie maximale mesurée : **1 705 c. = 0,34 %** du plafond de 500 000 |
| Pagination, `completion/complete`, `resource_link` | YAGNI : aucune plainte, aucune liste problématique mesurée |
| `notifications/progress` | Hors périmètre de la question §6.1 ; à réexaminer seulement si un utilisateur signale une attente aveugle sur `git-cochange-builder` |

### 7.4 Ce qui rouvrirait le dossier

Le refus porte sur les faits d'aujourd'hui, pas sur un principe. Trois choses le rouvriraient :

1. **Un consommateur programmatique réel** des résultats d'outils apparaît — le candidat le plus
   probable est [#281](https://github.com/swoofer/mcp-coordinator/issues/281) (ressources MCP
   `coord://`), qui donnerait enfin un lecteur à un contrat de sortie.
2. **Un bug de forme de sortie survient** en production — il n'y en a eu aucun depuis `v2.0.0`.
3. **Un outil réellement destructif est exposé en MCP** (par exemple un `reset`), auquel cas
   `requiresUserInteraction` redeviendrait pertinent — mais il faudrait alors d'abord se demander
   pourquoi la garde n'est pas côté serveur, comme les trois autres.

### 7.5 Corrections apportées à la fiche par ce challenge

1. **§4 point 2 est factuellement faux.** `set_dependency_map` n'« écrase » pas la carte : `setMap`
   (`src/dependency-map.ts:118-137`) est une boucle d'`INSERT … ON CONFLICT … DO UPDATE` sans
   aucun `DELETE`. Et « un garde-fou réel là où il n'y en a pas » est l'inverse de la réalité :
   `close_thread`/`cancel_thread` portent déjà `if (thread.initiator_id !== agentId) throw`
   (`src/consultation.ts:343`, `:360`).
2. **§4 point 1 est faux** sur « les schémas existent déjà pour la moitié de ces formes côté REST » :
   `openapi.yaml` ne couvre que l'auth, `rest-schemas.ts` n'a que des schémas d'entrée.
3. **§4 point 3 est sans objet** : mesuré à 0,34 % du plafond.
4. **§6.5 se trompait sur le coût en tokens** : Claude Code remplace le texte par la charge
   structurée, il ne l'ajoute pas. Le contre-argument était juste de s'inquiéter, faux sur le fait.
5. **Fait absent de la fiche et décisif** : `registerTool` génère un schéma **strict**
   (`additionalProperties: false`).
6. **Fait absent de la fiche et décisif** : un `outputSchema` non-objet à la racine est
   silencieusement ignoré puis fait planter l'appel.
7. **Piège de migration non signalé** : `registerTool` déplace `title` des annotations vers la
   racine de l'entrée `tools/list`.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. Fusion de 4 fiches brutes (`tool-metadata-modern-surface`, `cacheable-results-ttlms`, `mcp-forgotten-server-utilities`, `cc-mcp-meta-annotations`). Vérification repo : `title`/`annotations`/`isError` déjà en place sur les 26 outils ; aucune occurrence de `outputSchema`, `structuredContent`, `resource_link`, `_meta`, `progressToken` ou pagination. |
| 2026-08-14 | Vérification des faits : SDK réel 1.30.0 (`registerTool` accepte `outputSchema` + `_meta`, `ttlMs`/`cacheScope` absents) ; 4 lignes de §5 corrigées. |
| 2026-08-15 | Challenge. 21 lancements de Claude Code 2.1.233 + 3 PoC SDK + mesures contre le daemon réel. **Verdict : refuser.** Mesuré : pas de surcoût de tokens (le client remplace le texte) ; le SDK valide vraiment ; le garde-fou `requiresUserInteraction` fonctionne (0/3 contre 3/3) **mais n'a rien à garder** ; sortie max à 0,34 % du plafond ; **7 outils sur 26 structurellement inéligibles** ; schéma **strict** ⇒ panne au prochain `ALTER TABLE`. Deux passes adversariales : la première a démoli le volet sécurité (le §4 point 2 est faux — `setMap` est un upsert), la seconde le volet `outputSchema`. |
