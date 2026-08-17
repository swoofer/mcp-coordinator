# F03 — Subagents programmatiques et SessionStore : voir les transcripts, pas que les annonces

> **Fiche de veille.** Sections 1 à 5 remplies par la veille. Sections 6 à 8 remplies
> pendant la session de challenge dédiée.

| Champ | Valeur |
|---|---|
| **ID** | `sdk-subagents-sessionstore` |
| **Surface** | agent-sdk |
| **Statut** | GA |
| **Disponible depuis** | `options.agents` ≥ SDK 0.1.0 · `sessionStore` ≥ SDK 0.2.113 · background par défaut depuis Claude Code v2.1.198 · caps documentés TS SDK v0.3.219 / Python v0.2.127 · copie de `settings.json` TS depuis Agent SDK v0.3.222 |
| **Tier** | T2-fort-levier |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — tout tourne en local, aucun accès fermé requis |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — (a) adopter partiellement : câbler `threads.run_id`, pas migrer ; (b) refuser |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**
- `AgentDefinition.mcpServers` est typé `(string | object)[]` — un **tableau** de noms de serveurs ou de configs inline, **pas** un `Record<string, config>`. L'exemple TS du §2 utilisait la forme objet ; il est corrigé.
- `sessionStoreFlush` n'est pas un helper exporté mais une **option** de `query()`, `'batched' | 'eager'` (défaut `'batched'`), marquée *Alpha* dans la référence TS. Le §2 le listait à côté de `InMemorySessionStore` comme un export.
- `projectKey` : marqueur `(à vérifier)` tranché — c'est « un encodage stable et filesystem-safe du répertoire de travail ». L'algorithme exact d'encodage n'est pas publié.
- `mcpServers` remplace-t-il ou fusionne-t-il avec les serveurs du parent : la doc ne le dit pas → marqué `(non vérifiable)`, à trancher par test.
- §5, `docs/ARCHITECTURE.md` : le document ne décrit **pas** de modèle « un agent = un process ». Il ne mentionne l'agent qu'en l.34 (« Agent registry ») et l.143 ; il n'y a aucun modèle de parenté à réviser, il y en a un à écrire. Ligne du tableau reformulée.
- Précision de version : les caps de profondeur/concurrence/dépense supposent un SDK embarquant Claude Code **v2.1.219 ou plus** (TS SDK v0.3.219 / Python v0.2.127) — sur des versions antérieures certaines limites sont absentes ou par défaut différentes.

Vérifiés et **exacts** : `options.agents: Record<string, AgentDefinition>` ; les 14 champs d'`AgentDefinition` ; les alias de `model` ; les patterns `mcp__server` / `mcp__server__*` / `mcp__*` de `disallowedTools` ; tool `Agent` (ex-`Task`, renommé en v2.1.63) avec l'incohérence assumée par la doc elle-même (`system:init` et `result.permission_denials[].tool_name` disent encore `Task`) ; `agentId` dans le résultat du tool ; `parent_tool_use_id` ; `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (3) et `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (20) ; `maxBudgetUsd` / `max_budget_usd` → `error_max_budget_usd` ; background par défaut depuis v2.1.198 ; liste des agents nommés pour un subagent doté de `SendMessage` (v2.1.206+) ; toute la surface `SessionStore` (méthodes requises/optionnelles, `SessionKey`, `foldSessionSummary`, `InMemorySessionStore`, dédup sur `entry.uuid`, 3 tentatives max puis `{ type: "system", subtype: "mirror_error" }`, `subpath: "subagents/agent-<id>"`, incompatibilités `persistSession: false` et `enableFileCheckpointing`, suite de conformité officielle). Statut **GA** confirmé.
Fichiers du §5 : tous existent, lignes citées exactes (`src/database.ts:90`, `src/agent-registry.ts:38`, `src/security/audit.ts:171`/`191`, `cli/init.ts` ~225), `better-sqlite3` et `redis` bien en dépendances, et `sdk/src/client.ts` n'expose effectivement aucune primitive de session/transcript.

**Marqueurs `(à vérifier)` restants :** aucun. Un point reste `(non vérifiable)` : la sémantique remplace/fusionne de `mcpServers` au niveau `AgentDefinition`.

**Testabilité :** ✅ testable
Tout se joue en local : Claude Code installé + daemon local suffisent pour le volet (a) — lancer une session avec 3 subagents écrivains branchés sur le coordinateur et lire la table `agents` ainsi que l'`extra` du handler MCP pour voir si `parent_tool_use_id`/`agentId` arrivent. Le volet (b) est testable aussi : le SDK TS et la suite de conformité (`examples/session-stores/shared/conformance.ts`) sont publics, aucun header beta ni preview fermée n'est requis. Seule friction : la dépense API d'une session réelle à 3 subagents.

---

## 1. Ce que c'est

Deux mécanismes du Claude Agent SDK, indépendants mais qui se renforcent.

**(a) Subagents programmatiques.** `options.agents` est un `Record<string, AgentDefinition>` passé à l'appel SDK : chaque entrée définit un subagent avec son prompt, son modèle, ses outils autorisés/interdits et — point clé pour nous — ses **propres serveurs MCP** (`mcpServers`). Le subagent est invoqué par le tool `Agent` (renommé depuis `Task` en v2.1.63). Depuis Claude Code v2.1.198 les subagents tournent **en background par défaut**, et ils peuvent se nicher : la profondeur d'engendrement est plafonnée par `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (défaut 3) et la concurrence par `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (défaut 20). Un budget `maxBudgetUsd` termine la session avec le subtype `error_max_budget_usd`. Conséquence directe : une seule session Claude Code peut aujourd'hui produire des dizaines d'écrivains concurrents dans un même repo, chacun avec un `agentId` distinct.

**(b) SessionStore.** Interface d'adaptateur permettant de miroiter les transcripts de session vers un backend externe. Le sous-process écrit d'abord son transcript en local, puis le SDK réplique via `append()` (dual-write) ; en cas d'échec, 3 tentatives puis un message `{ type: "system", subtype: "mirror_error" }` remonte dans l'itérateur — la déduplication se fait sur `entry.uuid`. Les transcripts de subagents sont miroités sous `subpath: "subagents/agent-<id>"`, ce qui rend l'arbre parent/enfant lisible depuis le store. Une suite de conformité officielle valide toute implémentation.

## 2. Surface d'API exacte

```
// (a) subagents
options.agents: Record<string, AgentDefinition>
AgentDefinition: { description (requis), prompt (requis), tools, disallowedTools,
                   model, skills, memory, mcpServers, initialPrompt, maxTurns,
                   background, effort, permissionMode }
model: "fable" | "opus" | "sonnet" | "haiku" | "inherit" | <model-id>
mcpServers: (string | object)[]   // TABLEAU de noms ou de configs inline (pas un Record)
disallowedTools accepte: "mcp__server" | "mcp__server__*" | "mcp__*"
tool d'invocation: Agent          // ex-"Task"
résultat du tool: { agentId: <id>, ... }   // reprise: resume: sessionId + id dans le prompt
champ de corrélation: parent_tool_use_id
CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH      // défaut 3   (via options.env)
CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS      // défaut 20  (via options.env ; refus = "Concurrent subagent limit reached")
// les deux caps supposent un SDK embarquant Claude Code v2.1.219+
maxBudgetUsd / max_budget_usd  →  subtype de résultat: error_max_budget_usd

// (b) session store
options.sessionStore: SessionStore
SessionKey = { projectKey, sessionId, subpath? }
SessionStore.append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>   // requis
SessionStore.load(key: SessionKey): Promise<SessionStoreEntry[] | null>             // requis
SessionStore.listSessions(projectKey)          // optionnel
SessionStore.listSessionSummaries(projectKey)  // optionnel
SessionStore.delete(key)                       // optionnel
SessionStore.listSubkeys({ projectKey, sessionId })  // optionnel
foldSessionSummary / fold_session_summary      // à appeler dans append()
InMemorySessionStore (classe exportée)
options.sessionStoreFlush: 'batched' | 'eager'   // option, défaut 'batched', marquée Alpha
SessionStoreEntry, SessionSummaryEntry, entry.uuid
subpath des subagents: "subagents/agent-<id>"
message d'échec de miroir: { type: "system", subtype: "mirror_error" }
apparentés sessions: deleteSession, forkSession, listSubagents, getSubagentMessages
incompatibilités: persistSession: false, enableFileCheckpointing
```

```ts
// exposition sélective de mcp-coordinator, par rôle de subagent
agents: {
  writer: {
    description: "Modifie le code",
    prompt: "…",
    // mcpServers est un TABLEAU : nom d'un serveur déjà configuré, ou config inline
    mcpServers: [{ type: "http", url: "http://localhost:8765/mcp" }],
  },
  reviewer: {
    description: "Lit seulement",
    prompt: "…",
    disallowedTools: ["mcp__coordinator__*"],
  },
}
```

Points non tranchés par le bundle, à confirmer avant implémentation :
- `projectKey` : la doc le définit comme « un encodage stable et filesystem-safe du répertoire de travail » — donc la clé de partitionnement est le cwd, pas le repo ni la session. L'algorithme d'encodage exact n'est pas publié *(non vérifiable — non documenté ; à lire dans le SDK ou à observer)*. Conséquence acquise : pour reprendre depuis le store, il faut repartir d'un cwd identique à celui du run d'origine.
- Si `mcpServers` au niveau `AgentDefinition` **remplace** ou **fusionne** avec les serveurs de la session parente : *(non vérifiable — la doc dit seulement « MCP servers available to this agent, by name or inline config »)*. À trancher par test.
- Un subagent disposant de `SendMessage` reçoit au premier tour la liste des autres agents nommés de la session (v2.1.206+) : ce mécanisme recoupe partiellement `list_agents` (voir D01/C13).

Signalé tel quel par la veille, et **confirmé par la doc elle-même** : le tool s'appelle `Agent` depuis Claude Code v2.1.63 et c'est ce nom qui apparaît dans les blocs `tool_use`, mais `system:init` et `result.permission_denials[].tool_name` énumèrent encore « Task ». La doc recommande explicitement de tester les deux valeurs. Ne pas coder en dur sur l'un des deux.

## 3. Sources

- https://code.claude.com/docs/en/agent-sdk/subagents.md
- https://code.claude.com/docs/en/agent-sdk/session-storage.md
- https://code.claude.com/docs/en/agent-sdk/sessions.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.**

*Volet (a), immédiat et défensif.* Le modèle de données actuel est plat : `src/database.ts:90` déclare `agents(id, name, modules, status, registered_at, last_seen_at)`, auquel une migration ajoute `org_id` (la PK effective est `(org_id, id)`, cf. `src/agent-registry.ts:38`) — **aucune notion de parent**. Un arbre de subagents jusqu'à 3 niveaux de profondeur et 20 en parallèle se présente donc au coordinateur soit comme un seul agent (si l'`agent_id` est réutilisé, et les annonces se marchent dessus), soit comme 20 agents anonymes sans lien de parenté (et `list_agents` devient illisible, `conflict-detector` signale des conflits entre un parent et sa propre descendance). Ajouter `parent_agent_id` + `session_id` à la table et les propager depuis `register_agent` rend l'arbre visible dans le dashboard et permet au conflict-detector de ne pas opposer des agents du même sous-arbre. C'est aussi l'argument commercial le plus concret du projet : le nombre d'écrivains concurrents par repo n'est plus un choix de l'utilisateur, c'est un défaut du SDK.

*Volet (b), stratégique.* Le projet embarque déjà `better-sqlite3` **et** `redis` (`package.json`, deps) et un adaptateur DB (`src/db-adapter.ts`). Écrire un `CoordinatorSessionStore` publié comme paquet JS ferait basculer le coordinateur d'une vision « déclarative » (ce que les agents veulent bien annoncer via `announce_work`) à une vision « factuelle » (les transcripts complets). Concrètement : détection de conflit sur les fichiers **réellement** touchés plutôt que déclarés, reprise de contexte après crash, et vue multi-hôtes. Bonus conformité : la chaîne de hachage d'audit existante (`src/security/audit.ts`, colonnes `prev_hash`/`row_hash`) pourrait couvrir les transcripts — argument SOC 2 réel, pas décoratif. Une suite de conformité officielle existe pour valider l'implémentation, ce qui réduit le risque.

**Risque si on ne fait rien.**

Modéré mais réel sur le volet (a) : les subagents en background par défaut sont déjà GA. Un utilisateur qui lance une session avec 5 subagents écrivains verra `list_agents` afficher soit 1 ligne, soit 5 lignes déconnectées, et `conflict-detector` produira des faux positifs internes à la session. C'est une dégradation silencieuse de la valeur du produit, pas une panne — donc difficile à diagnostiquer côté utilisateur. Sur le volet (b), aucun risque à ne rien faire : c'est une opportunité, pas une menace.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/database.ts` | Schéma `agents` (ligne ~90) sans `parent_agent_id` ni `session_id` : migration additive requise pour représenter l'arbre. `idx_agents_id` (UNIQUE global) reste la contrainte pivot. |
| `src/agent-registry.ts` | `INSERT INTO agents (…)` ligne ~38 à étendre — et c'est un **upsert** (`ON CONFLICT(org_id, id) DO UPDATE`, l.32-40), donc deux subagents partageant un `agent_id` fusionnent silencieusement. TTL `DEFAULT_ONLINE_TTL_SECONDS` (900 s) à réévaluer pour des subagents éphémères. ~~`isGlobalAgentIdConflict`~~ — **symbole mort**, 0 occurrence dans `src/`, `cli/`, `tests/` (challenge du 2026-08-17). |
| `src/tools/agents-tools.ts` | `register_agent`, `list_agents`, `heartbeat`, `agent_activity` : ajouter les paramètres de parenté et rendre `list_agents` arborescent. |
| `src/conflict-detector.ts` | Ne pas signaler de conflit entre agents d'un même sous-arbre (même `session_id`) ; le parent et son subagent partagent l'intention. |
| `src/sse-emitter.ts` / `dashboard/public/dashboard.js` | `CoordinatorEvent` et le rendu du dashboard : afficher la hiérarchie plutôt qu'une liste plate. |
| `src/security/audit.ts` | Chaîne `prev_hash`/`row_hash` (lignes ~171 et ~191) : extension possible aux entrées de transcript si le SessionStore est implémenté. |
| `src/db-adapter.ts` + `src/infra/redis.ts` | Backends existants réutilisables pour le stockage des transcripts ; c'est là que se brancherait `append()`/`load()`. |
| `sdk/src/client.ts` | Le SDK client TS n'expose aujourd'hui aucune primitive de transcript ; c'est le point de publication naturel d'un `CoordinatorSessionStore`. |
| `cli/init.ts` | Écrit le snippet `.mcp.json` (ligne ~225) : devrait pouvoir générer aussi des `AgentDefinition` types (writer/reviewer) avec `mcpServers` ciblé. |
| `src/serve-http.ts` | Endpoints REST/MCP : surface d'ingestion des transcripts si le store est distant. |
| `docs/ARCHITECTURE.md` | Vérifié : le document ne décrit **aucun** modèle de parenté ni « un agent = un process » — il ne mentionne l'agent que via « Agent registry » (l.34) et `src/tools/agents-tools.ts` (l.143). Il n'y a donc pas une section à réviser mais un modèle à y écrire si la parenté est adoptée. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Un arbre de subagents doit-il apparaître dans `agents` comme N lignes reliées par `parent_agent_id` (le conflict-detector devant alors apprendre à ignorer les conflits intra-sous-arbre), ou comme UNE seule ligne « session » dont les subagents ne sont qu'un attribut d'activité — et dans ce cas, qui déclare quoi quand deux subagents frères éditent le même fichier ?

### 6.2 Hypothèse

**Terrain vérifié avant de commencer.** Aucune fiche voisine ne bloque : `D01` et `C13` sont encore ⬜. Et le dépôt ne mentionne **jamais** les subagents — 0 occurrence de `subagent` / `sub-agent` / `parent_agent` dans `README.md`, `docs/`, `src/` et `cli/`. Le manque est donc réel et non documenté, contrairement à ce que la leçon d'`E09` m'a appris à vérifier d'abord.

**Ce que je pense avant de mesurer.** §6.5 porte déjà le point qui décide tout, et personne ne l'a exécuté : *« La parenté peut n'être pas reconstructible côté serveur. Si `parent_tool_use_id` / `agentId` n'atteignent pas le handler MCP, la seule voie est de demander au subagent de déclarer son parent — donc de faire confiance à un LLM pour une clé étrangère. »*

Or le préalable jumeau est déjà établi : **`AuthClaims` ne porte aucun `agent_id`**, et `register_agent` reçoit l'`agent_id` dans le **corps** de la requête. La paternité de ce constat revient à [`C01`](C01-hook-mcp-tool-gate.md) §7.2 (1), tranchée le 2026-08-15 — *« `AuthClaims` ne porte aucun `agent_id`, et rien dans le dépôt ne lie une session MCP à un agent enregistré »* — qui l'a ensuite légué à `F02` (§7.3 : *« partagée avec `F02` »*). `F02` a été tranchée le 2026-08-17, mais sur une branche non encore fusionnée : quand je la cite plus bas, c'est de la PR qu'il s'agit, pas de `main`. Même remarque pour `F01`.

L'identité d'agent est donc **déjà** déclarative aujourd'hui — le serveur croit ce que l'agent lui dit. Mon hypothèse est que la parenté hériterait de ce défaut, et qu'une clé étrangère déclarée par un LLM serait pire qu'un identifiant déclaré par un LLM, parce qu'une erreur y contaminerait tout un sous-arbre au lieu d'une ligne.

*(Cette hypothèse a été réfutée par la passe adversariale — voir la fin du §6.4. Je la laisse telle quelle : c'est le pré-enregistrement, il n'a pas à être rétrospectivement embelli.)*

Second point : §6.5 recommande elle-même de **scinder** les deux volets — (a) une correction de modèle de données, (b) un chantier d'architecture. Je les adjuge séparément, comme en `E11`, `E14` et `E15`.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

| # | Volet | Critère de mort | Seuil chiffré |
|---|---|---|---|
| **K1** | (a) | **La parenté n'est pas reconstructible côté serveur.** Si le contexte que reçoit un handler MCP ne porte ni identifiant d'agent ni identifiant de parent, la seule voie est de la faire déclarer par le modèle. | **0** champ de parenté ou d'identité d'agent dans le contexte du handler, **vérifié** et non supposé |
| **K2** | (a) | **La table ne peut pas porter l'arbre sans migration.** | `agents` sans `parent_agent_id` **ni** `session_id` |
| **K3** | (a) | **Les faux positifs intra-sous-arbre sont réels.** Deux subagents frères éditant le même fichier doivent produire un conflit que rien ne peut distinguer d'un vrai. | `conflict-detector` n'a **aucune** notion de session ou de sous-arbre |
| **K4** | (b) | **Le SessionStore casse la portabilité.** C'est une option du Agent SDK, pas du protocole MCP. | `sessionStore` **absent** du protocole MCP, comme `search_result` l'était en `E12` |
| **K5** | (b) | **Volume et vie privée.** Miroiter des transcripts, c'est stocker code source et secrets dans la base du coordinateur. | le dépôt a déjà une surface RGPD (`docs/gdpr.md`) que cela élargirait |
| **K6** | (b) | **YAGNI.** | **0** issue réclamant l'ingestion de transcripts |
| **K7** | (a)(b) | **Les deux volets n'ont pas le même coût de décision.** | efforts annoncés différents, et §6.5 recommande elle-même la scission |

**Règle que je m'impose :** §0 classe la fiche ✅ **testable**, mais le PoC à trois subagents coûte une session réelle facturée. Je mesure tout ce qui est local et décisif — K1, K2, K3 se tranchent sans appel API. Si je ne lance pas la session réelle, je le dis et je n'en tire aucune conclusion. J'applique aussi : vérifier une absence plutôt que la supposer (`E08`, `E10`, `E12`, `F01`), ne pas décrire une spécification comme un bug (`E09`, `F02`), distinguer dérive de dépendance et défaut de vérification (`E13`, `E14`, `F02`), et **réduire le périmètre plutôt que d'argumenter un seuil atteint** (`E15`).

### 6.3 Protocole de vérification

Proposition — à valider ou remplacer pendant le challenge. Principe maison : on teste le vrai chemin de code.

- [ ] Lancer une vraie session Claude Code avec `options.agents` définissant 3 subagents écrivains, coordinator branché, et observer ce qui arrive réellement dans la table `agents` : 1 ligne ou 3 ? quels `agent_id` ?
- [ ] Vérifier si l'`Agent` tool result expose bien `agentId` et si `parent_tool_use_id` est visible côté serveur MCP (dans `extra` du handler MCP) — sinon la parenté n'est pas reconstructible sans que l'agent la déclare lui-même.
- [ ] Faire éditer le même fichier par deux subagents frères et lire la sortie de `src/conflict-detector.ts` : faux positif ou conflit légitime ?
- [ ] Confirmer le nom effectif du tool d'invocation (`Agent` vs `Task`) dans le `system:init` de la version installée, avant toute logique conditionnelle.
- [ ] Pour le volet SessionStore : implémenter un `InMemorySessionStore` de test, passer la suite de conformité officielle, et mesurer le volume écrit par `append()` sur une session réelle de 30 min (dimensionnement SQLite).

### 6.4 Résultat observé

**Ce qui a été exécuté, et ce qui ne l'a pas été.** Les quatre premières cases du §6.3 se ramènent à une seule question — *que voit un handler MCP ?* — et elle se tranche sans dépenser une session à trois subagents. Je l'ai tranchée sur le type que le SDK déclare et sur le vrai chemin de code du détecteur. La session réelle facturée n'a **pas** été lancée : je dis en fin de section ce qu'elle seule pourrait établir, et je n'en conclus rien.

#### K1 — la parenté n'atteint pas le serveur (se déclenche, avec une nuance qui compte)

Le contexte qu'un handler d'outil reçoit est `ServerContext = BaseContext & { mcpReq: {log, elicitInput, requestSampling}, http? }`, et `BaseContext` est déclaré en clair dans `@modelcontextprotocol/server` (`dist/createMcpHandler-CLhGwQTn.d.mts:2073`) :

```ts
type BaseContext = {
  sessionId?: string;
  mcpReq: { id; method; _meta?: RequestMeta; envelope?; inputResponses?;
            droppedInputResponseKeys?; requestState; signal; send; notify };
  http?: { authInfo?: AuthInfo };
};
```

Aucun `agentId`, aucun `parentToolUseId`. C'est cohérent avec la §0 : `agentId` est un champ du **résultat du tool `Agent`** et `parent_tool_use_id` un champ des **messages du flux SDK** — deux surfaces côté *hôte* du SDK. Un serveur MCP n'est pas l'hôte ; il ne les voit pas.

La nuance : `_meta` est un canal **ouvert**, et je l'ai vérifié plutôt que supposé —

```
_meta avec cles custom : ACCEPTE
cles conservees apres validation : ["anthropic/parentToolUseId","anthropic/agentId"]
=> _meta est OUVERT (passthrough)
```

Le canal existe donc. Mais rien ne le remplit avec une parenté d'agent, et le protocole ne nomme que dix clés :

```
BAGGAGE_META_KEY             = "baggage"
CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities"
CLIENT_INFO_META_KEY         = "io.modelcontextprotocol/clientInfo"
LOG_LEVEL_META_KEY           = "io.modelcontextprotocol/logLevel"
PROTOCOL_VERSION_META_KEY    = "io.modelcontextprotocol/protocolVersion"
RELATED_TASK_META_KEY        = "io.modelcontextprotocol/related-task"
SERVER_INFO_META_KEY         = "io.modelcontextprotocol/serverInfo"
SUBSCRIPTION_ID_META_KEY     = "io.modelcontextprotocol/subscriptionId"
TRACEPARENT_META_KEY         = "traceparent"
TRACESTATE_META_KEY          = "tracestate"

cles nommant une parente ou un agent : TRACEPARENT_META_KEY
```

`traceparent` est la seule dont le *nom* évoque un parent — et c'est un parent de **span** W3C Trace Context, pas un agent : son `parentid` n'a aucune correspondance avec une ligne de `agents`. Deux nuances que la passe adversariale a ajoutées et que je retiens : `io.modelcontextprotocol/related-task` porte un `taskId`, c'est-à-dire le pointeur de hiérarchie de travail du protocole lui-même, et `baggage` est le canal W3C prévu pour propager des paires clé/valeur arbitraires. Si quelqu'un voulait transporter une identité d'agent dans `_meta` sans inventer de clé, c'est `baggage` qu'il citerait.

Et `src/` ne lit **jamais** le champ `_meta` : les 26 handlers ne touchent qu'une seule chose sur leur contexte, `ctx.sessionId`, sur 27 sites, tous de la forme `getSessionClaims(ctx.sessionId ?? "")`. *(Correction : j'avais écrit « 0 occurrence de `_meta` dans les `.ts` ». C'est faux tel quel — il y en a 9, dans `src/database.ts`, `src/git-cochange-builder.ts:64` et `src/http/handle-health.ts:111`, mais toutes sont le nom de table `git_cochange_meta`. Zéro concerne le champ MCP.)*

**K1 se déclenche, mais uniquement sur ce qu'il énonce : l'ascendance.** Rien dans le contexte serveur ne porte de lien parent → enfant, donc un `parent_agent_id` reposerait sur une clé étrangère **déclarée par le modèle**. C'est le prolongement du préalable de `C01` §7.2 (1), repris par `F02`.

**Mais j'ai surgénéralisé, et la passe adversariale l'a attrapé.** Le type que je viens de coller porte `sessionId?: string` — et cette valeur-là n'est pas déclarative : `src/serve-http.ts:803` la fabrique côté serveur (`sessionIdGenerator: () => randomUUID()`), dans le profil que `cli/init.ts` écrit par défaut. Les handlers la lisent déjà. Or le détecteur n'a pas besoin de savoir *qui est mon parent* ; il a besoin de savoir *sommes-nous la même unité de travail*. Pour ce besoin-là, un identifiant **observé** existe déjà. K1 tue l'arbre ; il ne tue pas le regroupement.

Une réserve décisive sur cet identifiant, que je n'aurais pas vue sans la passe : en transport stdio, le `sessionId` est la **chaîne vide** — c'est le sentinel documenté dans `src/index.ts` (« the empty-string sessionId is the stdio sentinel; see fix #133 »). Tous les appels d'un poste stdio partagent donc la même valeur. Un regroupement qui **détecte** et **avertit** y échoue proprement (`"" == ""` ne signale rien) ; un regroupement qui **supprime** y ferait taire absolument tout. Le bon axe de sûreté n'est pas déclaré-contre-dérivé, c'est **échec ouvert contre échec fermé**.

**Ce que je ne peux pas mesurer ici :** si Claude Code injecte de son propre chef une clé propriétaire `anthropic/*` dans le `_meta` des appels d'un subagent. Le canal l'autorise. Seule une session réelle branchée sur le daemon le dirait. Je ne tranche pas ce point et je ne le compte pas dans le verdict.

#### K2 — la table ne porte pas l'arbre (se déclenche, mais l'argument est plus faible que la fiche ne le croit)

```
K2 — agents porte parent_agent_id ? false
     agents porte session_id ?      false
```

Et aucun `ALTER TABLE agents` du dépôt ne les ajoute (0 occurrence). **K2 se déclenche.**

Mais en cherchant je suis tombé sur un fait que la fiche ne mentionne pas et qui affaiblit son propre §4 : **la notion de session existe déjà dans le schéma**, juste pas sur `agents`.

```sql
CREATE TABLE IF NOT EXISTS action_summaries ( id, session_id TEXT NOT NULL, agent_id, … );
CREATE TABLE IF NOT EXISTS file_activity   ( id, session_id TEXT NOT NULL, agent_id, … );
CREATE INDEX IF NOT EXISTS idx_summaries_session ON action_summaries(session_id);
```

`session_id` y est **`NOT NULL` et indexé**. Or `file_activity` est exactement la table que lit le chemin « fichier chaud » du détecteur — et ce chemin **ignore la colonne** (`src/file-tracker.ts:73-79`) :

```sql
SELECT DISTINCT agent_id FROM file_activity
 WHERE org_id = ? AND file_path = ? AND agent_id != ?
   AND created_at > datetime('now', '-' || ? || ' minutes')
```

**Et j'en ai tiré une conclusion fausse, que je retire intégralement.** J'ai écrit que « la moitié *fichier chaud* du problème de K3 se corrige avec un `AND session_id != ?`, sans migration ». C'est faux quatre fois, et chaque raison suffit :

1. **Ça ne corrige rien de ce que K3 mesure.** Mes empreintes ne contiennent que `Module overlap on:` (`conflict-detector.ts:89`) et `File overlap on:` (`:102`) — les deux jambes **déclaratives**, qui lisent `threads`. La jambe fichier chaud écrit `Hot file: … recently edited by …` (`:165`) : cette chaîne est **absente de mes quatre scénarios**. Le patch visait du code qui a produit 0 % de mes conflits.
2. **Le dédoublonnage l'aurait éclipsée de toute façon.** `conflict-detector.ts:159` n'ajoute un `file_overlap` fichier-chaud que si aucun `file_overlap` du même agent n'existe déjà — donc précisément jamais dans le scénario frère.
3. **La table est vide dans le profil où le détecteur tourne.** `detect()` a **un seul** site d'appel, `src/tools/consultation-tools.ts:140`, c'est-à-dire MCP. Or `fileTracker.log` n'est appelée que depuis REST (`rest-handlers.ts:187` et `:981`). Et ce n'est même pas une découverte : **`C01` §7.2 (2), tranchée le 2026-08-15, l'écrit déjà** — *« La table interrogée est vide en MCP… Le gate serait un no-op garanti. »* J'ai remesuré ce qu'une fiche voisine avait déjà enterré.
4. **Le patch serait une régression de sûreté.** `session_id` est déclaré dans le corps, `rest-schemas.ts:51` est un `z.string()` sans `.min(1)` — donc `""` est légal. Transformer une chaîne auto-déclarée en critère de **suppression** de conflit, c'est offrir un bouton « faire taire l'avertissement » à qui renvoie le `session_id` du détenteur.

Une correction factuelle au passage : j'avais écrit « `NOT NULL` **et indexé** » pour les deux tables. Seul `action_summaries` a son index (`idx_summaries_session`). `file_activity` n'en a aucun sur `session_id` — la colonne y serait un post-filtre hors index.

Ce qui **reste** vrai de K2, et qui compte : le schéma porte déjà une notion de regroupement, elle est simplement débranchée. Mais ce n'est pas `session_id` qu'il fallait regarder — voir la fin de section.

#### K3 — les faux positifs intra-session sont réels et indistinguables (se déclenche)

Mesuré sur le vrai chemin, avec un `dependency_map` non vide (leçon d'`E14` : un map vide court-circuite `getBlastRadius`).

```
SCENARIO A — sub-2, frere de sub-1, annonce src/auth.ts
  conflits : 2
    module_overlap / warning / vs sub-1 — Module overlap on: src/auth
    file_overlap   / warning / vs sub-1 — File overlap on: src/auth.ts

SCENARIO B — sub-1 re-annonce son propre fichier (contre-test)
  conflits : 0  (auto-exclusion OK)

SCENARIO C — un agent etranger annonce src/auth.ts
  conflits : 2   (module_overlap + file_overlap, vs sub-1)

SCENARIO D — le parent annonce le fichier que son propre enfant tient
  conflits : 2   (module_overlap + file_overlap, vs sub-1)

empreinte frere    : ["file_overlap/warning/vs:sub-1","module_overlap/warning/vs:sub-1"]
empreinte etranger : ["file_overlap/warning/vs:sub-1","module_overlap/warning/vs:sub-1"]
empreinte parent   : ["file_overlap/warning/vs:sub-1","module_overlap/warning/vs:sub-1"]

frere indistinguable d'un etranger  : true
parent indistinguable d'un etranger : true
```

**K3 se déclenche**, et plus fort que la fiche ne l'annonçait. Le §4 prédisait que « `conflict-detector` signale des conflits entre un parent et sa propre descendance » : c'est exact, scénario D le montre. Ce que le §4 ne dit pas, c'est que les trois empreintes sont **identiques octet pour octet** — le détecteur n'a pas une notion de parenté imprécise, il n'en a aucune. La seule granularité d'exclusion est un `agent_id` unique (`conflict-detector.ts:66` et `:150-153`), et le contre-test B prouve que cette exclusion-là fonctionne. Le bug n'est donc pas dans le détecteur : il est dans le fait que personne ne lui dit que deux agents appartiennent au même travail.

#### K4 — le SessionStore n'est pas du MCP (se déclenche)

```
@modelcontextprotocol/core   -> AUCUN export sessionStore/transcript
@modelcontextprotocol/server -> AUCUN export sessionStore/transcript
@modelcontextprotocol/client -> AUCUN export sessionStore/transcript
```

La vérification adversariale est allée plus loin que la mienne : grep insensible à la casse de `sessionstore|transcript` sur l'**intégralité** des fichiers des quatre paquets (`core`, `server`, `client` **et `node`**), pas seulement leurs exports — zéro occurrence partout.

**K4 se déclenche**, et le §6.5 sous-estimait le problème. Ce n'est pas seulement une perte de portabilité : `sessionStore` est une option passée à `query()` par l'**hôte** du SDK. `mcp-coordinator` est un serveur MCP — il ne peut pas s'installer lui-même dans la session d'un utilisateur. Au mieux il **publie un paquet** que l'utilisateur câble dans son propre harnais.

C'est le motif que [`F01`](F01-sdk-in-process-mcp-server.md) a tranché le 2026-08-17 (`refuser` — *« la porte existe déjà et essaim l'utilise »*), **sur une branche non fusionnée** : je cite une PR, pas `main`, et je le dis. Mais l'argument le plus solide contre (b) n'est pas celui-là, c'est une **domination mesurée** : le §4 vend (b) comme la « vision factuelle — les fichiers réellement touchés plutôt que déclarés ». Or ce bénéfice-là est déjà servi par le hook `PreToolUse` dont `C01` §7.1 a retenu le mécanisme (mesuré, il bloque avant le disque), qui alimente `file_activity` avec `symbols_touched` et `content_hash` — **sans stocker un seul prompt ni une ligne de code source**, donc sans rien ajouter à la surface de K5.

#### K5 — la surface RGPD (se déclenche)

`docs/gdpr.md:57-63` place explicitement le contenu des threads et messages **hors périmètre**, « operator-controlled », sans recette SQL : *« Adapt the recipes to your data. »* Le document décline donc déjà de couvrir le contenu **léger**. Miroiter des transcripts complets y verserait du code source et des secrets lus en passant. **K5 se déclenche.**

#### K6 — YAGNI (se déclenche)

```
"transcript"    -> 0 issue
"subagent"      -> 0 issue
"session store" -> 2 issues, aucune sur le sujet (#236 perte de messages, #282 node_modules)
"parent agent"  -> 2 issues, aucune sur le sujet (#285 message de migration, #130 Claude Code Channel)
```

**K6 se déclenche sur le volet (b)** — zéro demande d'ingestion de transcripts, sans ambiguïté.

**Sur le volet (a), K6 ne se déclenche pas, et ma mesure était trompeuse.** Elle cherchait des mots (`subagent`, `parent agent`) là où le dépôt décrit le symptôme autrement. **#279 est OPEN, étiquetée `bug`** : *« Scoping: aucun axe "dépôt" — `wait_for_peers` compte des agents d'un autre repo et `hot_files` produit des conflits fantômes »* — et elle est née du challenge de `C08`, donc de ma main. L'axe n'est pas le même (dépôt, pas run), mais la famille de panne est identique : le détecteur oppose des agents qui n'avaient pas à être opposés, faute d'un axe de regroupement. Il y a donc une demande enregistrée pour (a) ; elle ne dit simplement pas « subagent ».

#### K7 — les deux volets n'ont pas le même coût (se déclenche)

L'en-tête annonce un effort **M** global ; le §6.5 chiffre (a) à **S** et (b) à **M/L** et recommande la scission. **K7 se déclenche** — et j'adjuge séparément à partir d'ici.

#### Ce que la passe adversariale a trouvé et que je n'avais pas vu

Trois découvertes, toutes vérifiées par moi-même après coup, et toutes plus importantes que ce que j'avais mesuré.

**1. La clé de regroupement existe déjà, elle s'appelle `run_id`, et la maison a déjà tranché la question que je croyais poser.**

```sql
-- src/database.ts:121  (table threads)
run_id TEXT,
-- src/database.ts:448  (migration)
db.exec("ALTER TABLE threads ADD COLUMN run_id TEXT");
```

Et `listThreads` sait déjà filtrer dessus. Le commentaire de conception, `src/consultation.ts:535-545`, énonce **mot pour mot** la peur que j'opposais à `parent_agent_id` — puis y répond par le design au lieu de refuser :

> *« The "OR IS NULL" is the whole design. A strict equality would hide the threads of a human working the same repo from the swarm's agents — and they would cheerfully edit files out from under them, which is precisely what this coordinator exists to prevent. So: hide other RUNS (an aborted one leaking its stale threads into the next), never other SESSIONS. »*

Une clé de regroupement **déclarée par le client**, dont la fonction est de **masquer** des threads au détecteur, livrée, documentée, et volontairement en **échec ouvert**. Mon refus de principe ne survit pas à ce précédent.

Le défaut est alors bien plus précis que « il manque une colonne » :

| Ce qui existe | Ce qui manque |
|---|---|
| `threads.run_id` en base, filtrable par `listThreads` | `detect()` appelle `listThreads` **trois fois sans jamais passer `run_id`** (`conflict-detector.ts:56-63`) |
| Le chemin REST transmet `run_id` (`rest-handlers.ts:228`, `:267`) | L'`inputSchema` du `announce_work` **MCP** ne l'accepte pas — **0 occurrence** de `run_id` dans `src/tools/consultation-tools.ts` |

Le seul site d'appel de `detect()` est MCP (`consultation-tools.ts:140`). Donc la clé de regroupement est inaccessible **exactement** là où le détecteur tourne. Rien à migrer : il faut câbler ce qui est déjà là.

**2. Mon asymétrie de gravité n'existe pas.** Je soutenais qu'une parenté fausse serait plus grave qu'un `agent_id` faux, parce qu'elle sert à taire. Faux : on peut déjà tout taire aujourd'hui, de deux façons, sans mentir sur aucune parenté.

- Annoncer avec l'`agent_id` d'un autre suffit : `conflict-detector.ts:66` (`if (thread.initiator_id === params.agent_id) continue;`) saute **tous** ses threads, et `file-tracker.ts:76` (`agent_id != ?`) exclut **toute** son activité. Les deux jambes, muettes, pour une chaîne dans le corps de la requête.
- Moins cher encore : **sous-déclarer**. Le détecteur ne compare que `params.target_modules` et `params.target_files`. `target_files: []` donne 0 conflit, gratuitement, sans usurper quoi que ce soit.

La surface de conflit est déjà *opt-in par omission*. Un `parent_agent_id` faux n'ajouterait aucune capacité de suppression qu'un tableau vide ne donne déjà. Je retire l'argument.

**3. Le vrai mode de panne est l'inverse d'un faux positif.** `register` est un **upsert** (`src/agent-registry.ts:32-40`, `ON CONFLICT(org_id, id) DO UPDATE`). Le gabarit d'amorçage dit « *(Once per session) Call `register_agent`* » (`cli/init.ts:39`) et ne mentionne pas les subagents — cohérent avec le §6.2 : le dépôt les ignore, 0 occurrence. Le scénario probable n'est donc pas « 20 agents anonymes », c'est **N subagents partageant un seul `agent_id`**, silencieusement fusionnés en une ligne. Et alors `conflict-detector.ts:66` + `file-tracker.ts:76` les taisent **tous entre eux** : faux négatifs totaux, dans précisément le scénario que le §4 appelle « l'argument commercial le plus concret du projet ». La fiche a diagnostiqué le bruit ; le risque réel est le silence.

**4. Un symbole mort a survécu à une vérification `CONFIRMED`.** Le §5 cite `isGlobalAgentIdConflict`. **0 occurrence** dans `src/`, `cli/` et `tests/` — l'unique occurrence du dépôt est cette ligne de la fiche. Le §0 du 2026-08-14 déclare pourtant « tous les fichiers du §5 existent, lignes citées exactes ». La vérification a porté sur les fichiers et les lignes, pas sur les symboles.

#### Ce que la session réelle facturée aurait ajouté

Trois choses, et seulement trois : si Claude Code met une clé `anthropic/*` dans `_meta` ; si trois subagents produisent une ou trois lignes dans `agents` ; et le nom effectif du tool (`Agent` vs `Task`) dans le `system:init` installé. Les deux dernières ne changent pas le verdict — K3 vaut à deux agents distincts quelle qu'en soit l'origine, et le nom du tool est une précaution d'implémentation, pas un argument d'adoption. La première pourrait rouvrir K1 : elle est nommée comme telle en §7.

### 6.5 Contre-arguments

- **Le volet SessionStore casse la portabilité.** `sessionStore` est une option du Claude Agent SDK, pas du protocole MCP. Un coordinateur qui tire sa valeur des transcripts ne fonctionne plus pour les clients non-Claude (Cline, Cursor, agents maison), alors que le positionnement actuel — un serveur MCP standard — marche partout. On échangerait de l'universalité contre de la profondeur sur un seul client.
- **Volume et vie privée.** Miroiter des transcripts complets, c'est stocker le code source, les secrets lus en passant et les prompts de l'utilisateur dans la base du coordinateur. Pour un auto-hébergeur, ça transforme une base de coordination légère (annonces, threads) en un dépôt de données sensibles avec des obligations RGPD — le projet a déjà `docs/gdpr.md`, la surface s'élargirait nettement.
- **Deux fonctionnalités sans lien réel dans une seule fiche.** (a) est une correction de modèle de données à effort S, (b) est un chantier d'architecture à effort M/L. Les traiter ensemble risque de faire porter à la correction utile le coût de décision du chantier ambitieux. Le challenge devrait probablement les scinder.
- **YAGNI sur le SessionStore.** `announce_work` existe précisément pour éviter d'avoir à lire les transcripts. Si les annonces sont insuffisantes, la réponse la moins chère est d'améliorer `src/announce-workflow.ts` et `src/plan-quality.ts`, pas d'ingérer tout le transcript.
- **Cible mouvante.** Les valeurs par défaut bougent vite (background par défaut en v2.1.198, tool renommé en v2.1.63, doc encore incohérente). Coder la parenté sur des champs non stabilisés, c'est s'engager à suivre le rythme de release de Claude Code.
- **La parenté peut n'être pas reconstructible côté serveur.** Si `parent_tool_use_id` / `agentId` n'atteignent pas le handler MCP, la seule voie est de demander au subagent de déclarer son parent — donc de faire confiance à un LLM pour une clé étrangère. À creuser avant tout schéma.

---

## 7. Décision

Les deux volets sont adjugés séparément : **K7 se déclenche**, le §6.5 le recommandait, et les mesures leur donnent des conclusions opposées.

| | |
|---|---|
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** (volet a) · ⬜ reporter · ✅ **refuser** (volet b) |
| **Date** | 2026-08-17 |
| **Justification** | (a) Le défaut est réel et mesuré, mais la fiche se trompe de remède et **moi aussi** : la clé de regroupement existe déjà (`threads.run_id`), elle est simplement inaccessible depuis MCP. (b) Trois critères de mort se déclenchent, et le bénéfice annoncé est déjà servi sans stocker de transcript. |
| **Issue / PR** | à ouvrir sur le câblage de `run_id` ; périmètre versé à **#279** (même famille de panne) |
| **Jalon visé** | (a) prochain jalon ; (b) réveil conditionné, voir §7.3 |

### 7.1 Volet (a) — ce qui est retenu : câbler ce qui existe, pas ajouter une colonne

Le défaut mesuré est réel et le §4 l'avait correctement prédit — le détecteur oppose un parent à sa propre descendance. Ce que la mesure ajoute, c'est que les empreintes sont **identiques octet pour octet** pour un frère, un étranger et le parent : il n'a pas une notion de parenté imprécise, il n'en a aucune. Le contre-test (un agent se re-annonçant : 0 conflit) prouve que la seule granularité d'exclusion est un `agent_id` unique.

Retenu, dans cet ordre :

1. **Câbler `run_id` jusqu'au détecteur.** L'exposer dans l'`inputSchema` du `announce_work` MCP (il y est absent, alors que REST le transmet), le passer aux trois `listThreads` de `detect()`, et n'exclure un thread que si les deux `run_id` sont **non nuls et égaux** — la doctrine `OR run_id IS NULL` est déjà écrite en `src/consultation.ts:535-545`. Aucune colonne neuve, aucune migration : une feature livrée en v1.1 et documentée en six langues qui n'est simplement pas branchée sur le seul consommateur qui en a besoin.
2. **Écrire le `ctx.sessionId` observé par le serveur sur la ligne `agents`** au moment du `register_agent`, et s'en servir pour **détecter** une reprise d'`agent_id` depuis une autre session et **avertir**. Jamais pour supprimer : le sentinel stdio est la chaîne vide, une suppression y ferait taire tout le poste.
3. **Une ligne de doctrine** dans le `CLAUDE_MD_TEMPLATE` (`cli/init.ts`) et dans l'`instructions` retenu par `C06` : chaque subagent s'enregistre sous **son propre** identifiant ; en réutiliser un vous fusionne dans cet agent. La description de l'outil le dit déjà (`src/tools/agents-tools.ts:26-30`) ; le « once per session » du gabarit la contredit dès qu'il y a des subagents.

Le point 3 est le plus urgent des trois, parce qu'il vise le mode de panne réel — le silence par fusion d'`agent_id`, pas le bruit.

### 7.2 Volet (a) — ce qui est écarté : l'arbre `parent_agent_id`

Écarté, mais **pas** pour la raison que j'avais pré-enregistrée. « On ne confie pas une clé étrangère à un LLM » n'est une exigence que le projet n'applique nulle part : `run_id` et `assigned_to` sont déclarés par le client, `register` est un upsert, et on peut déjà faire taire les deux jambes du détecteur avec un `target_files: []`. L'argument était un double standard et je le retire.

La vraie raison est plus simple et plus solide : **le détecteur n'a besoin d'aucune ascendance, seulement d'un regroupement.** Un arbre est une façon strictement plus chère d'exprimer un regroupement que le schéma porte déjà. S'ajoute la mesure de K1 — l'ascendance n'atteint pas le serveur (`agentId` et `parent_tool_use_id` sont des surfaces de l'hôte SDK, pas du protocole MCP) — donc elle coûterait en plus une déclaration que rien ne vérifie, pour un besoin que `run_id` couvre.

Écarté aussi : **faire du regroupement un critère de suppression sans réserve.** Deux frères ont été engendrés en parallèle parce que l'orchestrateur les a jugés indépendants ; leur collision sur le même fichier est la preuve qu'il s'est trompé, et c'est l'avertissement le plus actionnable que ce coordinateur puisse produire. Le seul couple réellement parasite est parent-contre-son-propre-enfant, et il coûte un avertissement de trop — en échec ouvert. On ne troque pas ça contre un silence.

### 7.3 Volet (b) — refuser, avec une condition de réveil

Trois critères de mort se déclenchent. **K4** : `sessionStore` est absent des quatre paquets MCP ; c'est une option que l'**hôte** du SDK passe à `query()`, donc un serveur MCP ne peut pas se l'installer — au mieux il publie un paquet, motif que `F01` a tranché en `refuser`. **K5** : `docs/gdpr.md:57-63` place déjà le contenu des threads hors périmètre, « operator-controlled », sans recette SQL ; y verser des transcripts complets ajouterait code source et secrets à une surface que le document décline de couvrir pour du contenu bien plus léger. **K6** : zéro demande.

Et surtout, le bénéfice annoncé est **dominé**. Le §4 vend (b) comme la vision factuelle des fichiers réellement touchés : le hook `PreToolUse` dont `C01` §7.1 a retenu le mécanisme fournit déjà exactement ça, avec `symbols_touched` et `content_hash`, sans stocker un prompt.

**Réveil conditionné** : si le projet décide un jour de publier un paquet à destination des hôtes SDK — c'est-à-dire si la conclusion de `F01` est renversée — le `SessionStore` redevient une question ouverte, et la suite de conformité officielle en réduit le risque d'implémentation. Tant que `F01` tient, (b) reste fermé.

### 7.4 Ce que cette fiche corrige dans le corpus

- Le §5 cite `isGlobalAgentIdConflict`, **symbole mort** : 0 occurrence dans `src/`, `cli/`, `tests/`. Le §0 du 2026-08-14, classé `CONFIRMED`, a vérifié les fichiers et les numéros de ligne mais pas les symboles.
- Le §0 dit la fiche ✅ testable et chiffre le PoC à « une session réelle à 3 subagents ». La session n'était pas nécessaire : la question décisive — *que voit un handler MCP ?* — se tranche sur le type déclaré par le SDK. Ce que la session seule pourrait encore établir est nommé en fin de §6.4, et n'entre pas dans ce verdict.
- L'effort annoncé **M** ne correspond à aucun des deux volets : (a) tombe à **S** une fois qu'on câble `run_id` au lieu de migrer, (b) sort du périmètre.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : `mcpServers` est un tableau, `sessionStoreFlush` est une option Alpha, ARCHITECTURE.md corrigé. |
| 2026-08-17 | Challenge. Volets scindés (K7). **(a) adopter partiellement, (b) refuser.** Mesuré : le contexte d'un handler MCP (`BaseContext`) ne porte ni `agentId` ni `parent_tool_use_id` ; le détecteur produit des empreintes identiques octet pour octet pour un frère, un étranger et le parent contre son propre enfant ; `sessionStore` est absent des quatre paquets MCP. La passe adversariale a démoli quatre de mes affirmations — le pointeur `file_activity.session_id` (visait du code produisant 0 % des conflits mesurés, et `C01` §7.2 l'avait déjà enterré comme no-op MCP), l'asymétrie de gravité (on peut déjà tout taire avec `target_files: []`), la surgénéralisation de K1 (le `sessionId` est généré par le serveur), et « 0 issue » (**#279** est OPEN, même famille de panne). Découverte décisive : **`threads.run_id` existe déjà** avec sa doctrine d'échec ouvert (`consultation.ts:535-545`) et n'est pas branché sur `detect()` ni exposé dans le `announce_work` MCP. Le remède retenu câble l'existant ; l'arbre `parent_agent_id` est écarté. Symbole mort relevé dans le §5 : `isGlobalAgentIdConflict`. |
