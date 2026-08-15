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
| **Statut du challenge** | ⬜ à faire |

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
| `src/agent-registry.ts` | `INSERT INTO agents (…)` ligne ~38 à étendre ; `isGlobalAgentIdConflict` et le TTL `DEFAULT_ONLINE_TTL_SECONDS` (900 s) à réévaluer pour des subagents éphémères qui vivent quelques minutes. |
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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

Proposition — à valider ou remplacer pendant le challenge. Principe maison : on teste le vrai chemin de code.

- [ ] Lancer une vraie session Claude Code avec `options.agents` définissant 3 subagents écrivains, coordinator branché, et observer ce qui arrive réellement dans la table `agents` : 1 ligne ou 3 ? quels `agent_id` ?
- [ ] Vérifier si l'`Agent` tool result expose bien `agentId` et si `parent_tool_use_id` est visible côté serveur MCP (dans `extra` du handler MCP) — sinon la parenté n'est pas reconstructible sans que l'agent la déclare lui-même.
- [ ] Faire éditer le même fichier par deux subagents frères et lire la sortie de `src/conflict-detector.ts` : faux positif ou conflit légitime ?
- [ ] Confirmer le nom effectif du tool d'invocation (`Agent` vs `Task`) dans le `system:init` de la version installée, avant toute logique conditionnelle.
- [ ] Pour le volet SessionStore : implémenter un `InMemorySessionStore` de test, passer la suite de conformité officielle, et mesurer le volume écrit par `append()` sur une session réelle de 30 min (dimensionnement SQLite).

### 6.4 Résultat observé

<À remplir après exécution du protocole.>

### 6.5 Contre-arguments

- **Le volet SessionStore casse la portabilité.** `sessionStore` est une option du Claude Agent SDK, pas du protocole MCP. Un coordinateur qui tire sa valeur des transcripts ne fonctionne plus pour les clients non-Claude (Cline, Cursor, agents maison), alors que le positionnement actuel — un serveur MCP standard — marche partout. On échangerait de l'universalité contre de la profondeur sur un seul client.
- **Volume et vie privée.** Miroiter des transcripts complets, c'est stocker le code source, les secrets lus en passant et les prompts de l'utilisateur dans la base du coordinateur. Pour un auto-hébergeur, ça transforme une base de coordination légère (annonces, threads) en un dépôt de données sensibles avec des obligations RGPD — le projet a déjà `docs/gdpr.md`, la surface s'élargirait nettement.
- **Deux fonctionnalités sans lien réel dans une seule fiche.** (a) est une correction de modèle de données à effort S, (b) est un chantier d'architecture à effort M/L. Les traiter ensemble risque de faire porter à la correction utile le coût de décision du chantier ambitieux. Le challenge devrait probablement les scinder.
- **YAGNI sur le SessionStore.** `announce_work` existe précisément pour éviter d'avoir à lire les transcripts. Si les annonces sont insuffisantes, la réponse la moins chère est d'améliorer `src/announce-workflow.ts` et `src/plan-quality.ts`, pas d'ingérer tout le transcript.
- **Cible mouvante.** Les valeurs par défaut bougent vite (background par défaut en v2.1.198, tool renommé en v2.1.63, doc encore incohérente). Coder la parenté sur des champs non stabilisés, c'est s'engager à suivre le rythme de release de Claude Code.
- **La parenté peut n'être pas reconstructible côté serveur.** Si `parent_tool_use_id` / `agentId` n'atteignent pas le handler MCP, la seule voie est de demander au subagent de déclarer son parent — donc de faire confiance à un LLM pour une clé étrangère. À creuser avant tout schéma.

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
| 2026-08-14 | Vérification des faits : `mcpServers` est un tableau, `sessionStoreFlush` est une option Alpha, ARCHITECTURE.md corrigé. |
