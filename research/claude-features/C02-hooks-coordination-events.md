# C02 — Les 31 hook events de Claude Code et le pack `@mcp-coordinator/hooks`

| Champ | Valeur |
|---|---|
| **ID** | `hooks-coordination-events` |
| **Surface** | claude-code · agent-sdk |
| **Statut** | **GA** pour le socle (PreToolUse, PostToolUse, PostToolBatch, FileChanged, SubagentStart/Stop, DirectoryAdded, CwdChanged, Worktree*) **et pour `TaskCreated` / `TaskCompleted`** — challenge 2026-08-15 : ils tirent **sans** flag Agent Teams, mesuré. ~~experimental pour les trois hooks d'équipe~~ → experimental pour le seul `TeammateIdle`. |
| **Disponible depuis** | `Elicitation`/`ElicitationResult` ≈ v2.1.76 (mars 2026) · correctif exit code 2 en v2.1.214 (18 juil. 2026) · `DirectoryAdded` en v2.1.219 (24 juil. 2026) · côté SDK : `additionalContext` non-erreur en 0.3.163, `DirectoryAdded` en 0.3.219 |
| **Tier** | T1-incontournable |
| **Nature** | integration |
| **Effort estimé** | ~~M~~ **L** (challenge 2026-08-15 : `C01` §7.4 compte ~15 fichiers pour un pack strictement plus petit) |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — tout est local, aucun accès fermé requis |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — `adopter partiellement` : `TaskCreated` bloquant + deux capteurs |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

Le socle tient : les **31 événements sont exacts, nom pour nom**, dans l'ordre de la doc
(`code.claude.com/docs/en/hooks.md`), et la table « exit code 2 par événement » confirme les cinq
contrats de blocage cités. En revanche **la majorité des noms de champs de payload étaient faux** —
ils ont été repris de mémoire plutôt que de la doc. Tous les numéros de ligne du §5 sont justes.

**Corrections apportées :**

- `FileChanged` : le champ est `event` avec les valeurs `"add"` / `"change"` / `"unlink"` — **pas**
  `change_type: created|modified|deleted`. Ajouté aussi le vrai rôle du `matcher` (il *construit*
  la liste de surveillance : valeur découpée sur `|`, chaque segment = un nom de fichier littéral
  dans le cwd, **aucun glob ni récursif**) et la sortie `watchPaths`.
- `PostToolBatch` : `tool_calls[]` contient `{ tool_name, tool_input, tool_use_id, tool_response }`
  — **pas** `{ succeeded, tool_result | error }`.
- `SubagentStart` : ne porte **que** `agent_id` et `agent_type`. Les champs `agent_description` et
  `instructions` **n'existent pas**. Corrigé aussi au §1 et au §4, où ils fondaient l'argument
  « capacité neuve ».
- `SubagentStop` : liste complétée (`stop_hook_active`, `agent_transcript_path`,
  `last_assistant_message`, `background_tasks`, `session_crons`).
- `TaskCreated` : `task_id` + `task_subject`, plus optionnels `task_description`, `teammate_name`,
  `team_name`. **Contradiction 2 du §5 tranchée** : ni `task_title` (inexistant) ni
  `task_description` seul — le champ requis est `task_subject`.
- `TaskCompleted` : même jeu de champs que `TaskCreated`, pas seulement `task_id`.
- `TeammateIdle` : `teammate_name` + `team_name`. **Contradiction 3 du §5 tranchée** en faveur de
  `teammate_name` ; `agent_id`/`agent_type` ne sont que les champs communs sous-agent.
- `DirectoryAdded` : `directory` et `source` — **pas** `directory_path` / `how_added`. Les valeurs
  `slash_command` / `register_repo_root` sont exactes.
- `InstructionsLoaded` : `file_path`, `memory_type`, `load_reason`, plus `globs`,
  `trigger_file_path`, `parent_file_path`. Le champ `instructions` **n'existe pas**.
- `ConfigChange` : `source` (+ `file_path` optionnel) — **pas** `config_source`.
- Hooks d'équipe : la doc dit « don't support matchers and fire on every occurrence » (et non
  « silencieusement ignoré »). `team_name` déprécié : confirmé mot pour mot dans `agent-teams.md`.
- Liste « TS-only » : très incomplète. **20 des 31 événements** sont TypeScript-only côté SDK,
  dont `SessionStart`, `SessionEnd`, `FileChanged`, `CwdChanged`, `DirectoryAdded`,
  `WorktreeCreate/Remove`, `ConfigChange` et les trois hooks d'équipe — c'est-à-dire *presque tout
  le pack envisagé*. Le SDK Python est hors-jeu ici.
- §5 `src/serve-http.ts` : l'affirmation « à trancher : nouvelle branche `/api/hook/...` ou appel
  MCP » ignorait l'existant. Une table de dispatch REST existe déjà
  (`src/http/handle-rest.ts:63`) et expose **déjà** `/api/check-conflict`, `/api/session-start`,
  `/api/session-stop`, `/api/log-file` — précisément les endpoints qu'un pack de hooks appellerait.
- §5 en-tête : le `grep -i hook` remonte aussi `src/http/rest-schemas.ts:49`
  (« essaim/hook telemetry only »), preuve qu'un chemin « hook » externe est déjà anticipé.
- §4 : « `FileChanged` remplace tout watcher maison » adouci — la surveillance est limitée à une
  liste de fichiers littéraux, elle ne remplace pas un watcher récursif de repo.

**Vérifications passées sans correction :** les 31 noms d'événements ; les 5 contrats de blocage ;
le socle commun (`session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`,
`hook_event_name`, `effort.level`, `agent_id`, `agent_type`) ; toute la surface Agent SDK
(`options.hooks`, `{ matcher?, hooks, timeout? }`, `(input, toolUseID, { signal })`,
`permissionDecision` allow|deny|ask|defer, `permissionDecisionReason`, `updatedInput`,
`additionalContext`, `updatedToolOutput`, `systemMessage`, `continue`, `{ async, asyncTimeout }`,
priorité `deny > defer > ask > allow`) ; `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` ; les jalons
v2.1.76 (Elicitation), v2.1.214 (exit code 2 non bloquant quand le JSON stdout échoue la
validation), v2.1.219 (DirectoryAdded) ; **tous** les numéros de ligne du §5 (`cli/init.ts`
225-247/290/102/110/338/691, `src/conflict-detector.ts:20`, `src/tools/files-tools.ts:20,50`,
`src/announce-workflow.ts:60`, `src/agent-registry.ts:32`, `src/tools/agents-tools.ts:21,68`,
`src/serve-http.ts:583,734,871`, `package.json` bin 38-40 / files 41-47) ; l'absence de
`pnpm-workspace.yaml` à la racine ; l'existence de tous les fichiers cités.

**Statut :** inchangé. `mixte` est correct — le socle est GA (aucun marqueur beta dans la doc), et
`agent-teams.md` ouvre sur un `<Warning>` : « Agent teams are experimental and disabled by
default ».

**Marqueurs `(à vérifier)` restants :** aucun. Les deux marqueurs du §2 sont tranchés.
Une seule zone non vérifiée : les versions **SDK** (`0.3.163`, `0.3.219`) — le changelog du SDK
n'est pas publié au même endroit que celui de Claude Code (`(non vérifiable ici)`).

**Testabilité :** ✅ testable
Claude Code 2.1.219 et Node 22.21.0 sont installés sur ce poste — donc `DirectoryAdded`,
`prompt_id` et l'ensemble de la surface sont disponibles localement. Un `.claude/settings.json`
déclarant un hook shell qui dumpe stdin en JSONL tranche les cinq points du §6.3 sans aucun accès
privilégié : les hooks d'équipe ne sont derrière **qu'une variable d'environnement**
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), pas derrière une allowlist d'org ni une preview fermée.
Seule réserve pratique : les scénarios multi-sessions et Agent Teams consomment du quota API réel.

---

## 1. Ce que c'est

La surface de hooks de Claude Code est passée des 9 événements classiques à une trentaine, dont une bonne partie décrit désormais le cycle de vie **multi-agents** et l'**observabilité fichier** — exactement le domaine de mcp-coordinator. Un hook est un process externe déclaré dans `settings.json` (ou un callback JS via `options.hooks` de l'Agent SDK) qui reçoit un payload JSON sur stdin et peut **bloquer** l'action en sortant avec le code 2, son stderr étant renvoyé au modèle comme feedback.

Trois familles nous intéressent. (a) Les hooks de **garde-fou** : `PreToolUse` sur `Write|Edit|MultiEdit`, et surtout `TaskCreated` / `TaskCompleted` / `TeammateIdle` qui permettent respectivement d'empêcher la création d'une tâche, sa clôture, ou l'endormissement d'un teammate. (b) Les hooks d'**alimentation** : `FileChanged` (le matcher liste des noms de fichiers **littéraux**, qui sont aussi la liste surveillée ; champ `event` = add|change|unlink), `PostToolBatch` qui livre en une passe le lot d'appels parallèles résolus, `CwdChanged` et `DirectoryAdded`. (c) Les hooks d'**identité** : `SubagentStart` porte `agent_id` et `agent_type`, `SubagentStop` y ajoute `agent_transcript_path` et `last_assistant_message` — les subagents deviennent des acteurs nommables, alors qu'ils sont aujourd'hui invisibles pour le coordinateur.

Tous les payloads portent un socle commun : `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, plus `agent_id` / `agent_type` quand le hook tire à l'intérieur d'un subagent. Côté Agent SDK, la même surface est exposée programmatiquement : `options.hooks` est un `Partial<Record<HookEvent, HookCallbackMatcher[]>>`, chaque callback reçoit `(input, toolUseID, { signal })` et renvoie `hookSpecificOutput` ; pour `PreToolUse` on retourne `permissionDecision` (`allow`|`deny`|`ask`|`defer`) avec `permissionDecisionReason` et éventuellement `updatedInput`. Le mode `{ async: true, asyncTimeout }` permet les effets de bord non bloquants — un hook de télémétrie n'ajoute alors aucune latence au tour de boucle.

## 2. Surface d'API exacte

Événements (liste complète relevée par la veille, 31 entrées) :

```
SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse,
PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure,
PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop,
TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle,
InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged,
WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, Elicitation,
ElicitationResult, SessionEnd
```

Champs de payload pertinents :

```
FileChanged        { file_path, event: "add" | "change" | "unlink" }
                   # le matcher a DEUX rôles : il construit la liste surveillée (valeur découpée
                   # sur `|`, chaque segment = un nom de fichier LITTÉRAL dans le cwd — pas de
                   # glob, pas de récursif) puis filtre les groupes de hooks sur le basename.
                   # Sortie possible : { watchPaths: string[] } pour étendre la liste à chaud.
PostToolBatch      { tool_calls[]: { tool_name, tool_input, tool_use_id, tool_response } }
                   # tool_response = le contenu tool_result sérialisé vu par le modèle
                   # (shape différente de PostToolUse, qui passe l'objet Output structuré)
SubagentStart      { agent_id, agent_type }        # RIEN d'autre : ni agent_description ni instructions
                   # sortie : hookSpecificOutput.additionalContext injecte du contexte au subagent
SubagentStop       { stop_hook_active, agent_id, agent_type, agent_transcript_path,
                     last_assistant_message, background_tasks[], session_crons[] }
TaskCreated        { task_id, task_subject, task_description?, teammate_name?, team_name? }
                   # fire via l'outil `TaskCreate`
TaskCompleted      { task_id, task_subject, task_description?, teammate_name?, team_name? }
TeammateIdle       { teammate_name, team_name }    # team_name déprécié
DirectoryAdded     { directory, source: "slash_command" | "register_repo_root" }
InstructionsLoaded { file_path, memory_type: User|Project|Local|Managed,
                     load_reason: session_start|nested_traversal|path_glob_match|include|compact,
                     globs?, trigger_file_path?, parent_file_path? }
ConfigChange       { source: user_settings|project_settings|local_settings|policy_settings|skills,
                     file_path? }
socle commun       { session_id, prompt_id, transcript_path, cwd, permission_mode, agent_id, agent_type, effort.level }
```

Contrats de blocage :

```
exit code 2  = bloquer + renvoyer stderr comme feedback au modèle
  TeammateIdle   -> le teammate reste au travail
  TaskCreated    -> la tâche n'est pas créée
  TaskCompleted  -> la tâche n'est pas marquée terminée
  PostToolBatch  -> stoppe la boucle agentique
  WorktreeCreate -> exit non-zéro avorte la création
```

Les trois hooks d'équipe **n'acceptent pas de matcher** (« don't support matchers and fire on every occurrence »), et leur champ `team_name` est **déprécié** (nom dérivé de la session, « will be removed in a future release »). Prérequis confirmé : `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, en variable d'environnement ou dans `settings.json` — sans lui, aucune équipe n'est montée au démarrage de session.

Surface Agent SDK :

```ts
options.hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>
// { matcher?, hooks: HookCallback[], timeout? }
// HookCallback = (input, toolUseID, { signal }) => HookOutput

// PreToolUse
{ hookSpecificOutput: {
    permissionDecision: "allow" | "deny" | "ask" | "defer",
    permissionDecisionReason: string,
    updatedInput?: unknown } }
// PostToolUse
{ hookSpecificOutput: { additionalContext?, updatedToolOutput? } }
// top-level : systemMessage, continue
// non bloquant : { async: true, asyncTimeout }
// priorité : deny > defer > ask > allow
```

**TS-only côté SDK — bien plus large que prévu.** La table « Python SDK / TypeScript SDK » de
`agent-sdk/hooks.md` marque `Python: No` pour **20 des 31 événements**, dont `PostToolBatch`,
`UserPromptExpansion`, `InstructionsLoaded`, mais aussi `SessionStart`, `SessionEnd`, `FileChanged`,
`CwdChanged`, `DirectoryAdded`, `WorktreeCreate`, `WorktreeRemove`, `ConfigChange`, `MessageDisplay`,
`PostCompact`, `StopFailure`, `PermissionDenied`, `Setup`, `Elicitation`, `ElicitationResult`, et les
trois hooks d'équipe. Seuls `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`,
`Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`, `Notification` sont
disponibles dans les deux SDK. Autrement dit, quasiment tout le pack envisagé ici est TypeScript-only.

## 3. Sources

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/hooks.md
- https://code.claude.com/docs/en/agent-sdk/hooks.md
- https://code.claude.com/docs/en/agent-teams.md
- https://code.claude.com/docs/en/worktrees.md
- https://code.claude.com/docs/en/changelog
- https://github.com/anthropics/claude-code/issues/23545

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.** Aujourd'hui le produit est *déclaratif* : `announce_work` (`src/tools/consultation-tools.ts:37`) et `check_file_conflict` (`src/tools/files-tools.ts:50`) ne servent à rien si le modèle ne les appelle pas. `ConflictDetector.detect()` est un excellent détecteur branché sur un déclencheur facultatif. Un hook `PreToolUse` sur `Write|Edit|MultiEdit` qui appelle le daemon et retourne `deny` + `permissionDecisionReason` quand un autre agent détient le fichier transforme cette détection en **garde-fou réel**, sans une ligne de prompt engineering. Même logique un cran plus haut : un hook `TaskCreated` qui refuse (exit 2) une tâche empiétant sur des fichiers déjà revendiqués repositionne mcp-coordinator en *quality gate de l'orchestrateur natif d'Anthropic* plutôt qu'en concurrent d'Agent Teams — la doc Agent Teams laisse explicitement le partitionnement du travail à la charge du lead.

Du code disparaît aussi. `FileChanged` alimente `FileTracker` sans polling — **mais ne remplace pas un watcher de repo** : la liste surveillée est une énumération de noms de fichiers littéraux dans le cwd (pas de glob, pas de récursif), extensible seulement à chaud via la sortie `watchPaths`, ce qui pour un repo entier est un tout autre chantier. `PostToolBatch` livre les N écritures parallèles en un seul appel là où N `PostToolUse` seraient nécessaires ; `CwdChanged` et `DirectoryAdded` tiennent `WorkingFilesTracker` à jour ; `SessionStart`/`SessionEnd` font le register/unregister que l'agent doit aujourd'hui appeler à la main (`register_agent`, `src/tools/agents-tools.ts:21`). Enfin `SubagentStart` apporte une **capacité neuve**, quoique plus mince qu'annoncé : `agent_id` + `agent_type` (et rien d'autre — pas de description ni d'instructions) donnent au registry l'identité des subagents, aujourd'hui totalement absents du modèle de données ; `SubagentStop` complète avec `agent_transcript_path` et `last_assistant_message`. Le tout livré comme un pack posé par `mcp-coordinator init` : l'utilisateur qui en profite est celui qui lance trois Claude Code sur le même repo et qui, actuellement, doit faire confiance à trois modèles pour respecter un protocole.

**Risque si on ne fait rien.** Modéré mais réel. Agent Teams livre déjà l'orchestration multi-agents dans Claude Code ; si mcp-coordinator ne s'y branche pas par les hooks, il reste un serveur MCP que le modèle peut ignorer, tandis que d'autres outils occuperont le point de contrôle. Le second risque est la fenêtre : ces hooks sont récents et documentés maintenant ; une intégration tardive arrive après que les utilisateurs se soient écrit leurs propres scripts.

## 5. Points d'intégration dans le repo

Aucune trace de hook Claude Code dans le repo à ce jour : un `grep -i hook` sur `src/` ne remonte que les hooks Aedes/MQTT (`src/mqtt-broker.ts`), les hooks d'audit/boot internes et `node:async_hooks` ; `cli/` n'en contient aucun. Une seule mention anticipe le sujet — `src/http/rest-schemas.ts:49`, « POST /api/log-file — no MCP equivalent (essaim/hook telemetry only) » : un chemin d'entrée « hook » externe est déjà envisagé côté REST. Le reste est à construire.

| Fichier / module | Impact |
|---|---|
| `cli/init.ts` | Point d'entrée naturel du pack. Écrit déjà `.mcp.json` (l.225-247, avec merge si le fichier existe) et un extrait `CLAUDE.md` (l.290), avec `--dir` (l.102) et `--dry-run` (l.110), et une IO injectable (`writeFile`, l.338 et l.691). Ajouter l'écriture/merge de `.claude/settings.json` suit exactement le chemin existant. |
| `cli/channel.ts` | Précédent direct : sous-commande stdio, spécifique Claude Code, découplée du daemon (parle MQTT). Un `mcp-coordinator hook <event>` lisant le payload sur stdin suivrait le même schéma — process court, pas de nouveau service. |
| `src/conflict-detector.ts` | `ConflictDetector.detect({ org_id, agent_id, target_modules, target_files })` (l.20) est déjà la signature dont un `PreToolUse`/`TaskCreated` a besoin. Cible principale de la traduction payload → verdict. |
| `src/tools/files-tools.ts` | `check_file_conflict` (l.50) et `hot_files` (l.20) exposent déjà la logique côté MCP ; un hook doit soit les appeler, soit passer par la même couche `FileTracker`. |
| `src/announce-workflow.ts` | `runCommonAnnounceFlow` (l.60) est le chemin partagé annonce → conflits. `TaskCreated` doit s'y brancher, pas dupliquer. |
| `src/agent-registry.ts` | `AgentRegistry` (l.32) n'a aucune notion de subagent. `SubagentStart`/`SubagentStop` imposent de décider si `agent_id`/`agent_type` créent des entrées distinctes ou des sous-entrées. |
| `src/tools/agents-tools.ts` | `register_agent` (l.21) et `heartbeat` (l.68) deviennent redondants avec `SessionStart`/`SessionEnd` pour les utilisateurs Claude Code — mais restent indispensables aux autres clients MCP. |
| `src/file-tracker.ts` · `src/working-files-tracker.ts` | Consommateurs de `FileChanged`, `PostToolBatch`, `CwdChanged`, `DirectoryAdded`. |
| `src/serve-http.ts` · `src/http/handle-rest.ts` | `serve-http.ts` aiguille à la main les grandes familles (`/dashboard` l.583, `/api/auth/` l.734, `/api/` l.871) puis délègue à une **table de dispatch REST** (`handle-rest.ts:63`). Celle-ci expose déjà `/api/check-conflict`, `/api/session-start`, `/api/session-stop`, `/api/log-file`, `/api/announce`, `/api/hot-files` — soit exactement les endpoints qu'un pack de hooks appellerait. Il n'y a donc **rien de nouveau à router** : le point ouvert n'est plus « quel endpoint créer » mais la latence d'un `PreToolUse` synchrone, payée à chaque édition. |
| `src/sse-emitter.ts` · `src/mqtt-bridge.ts` | Les événements issus des hooks doivent ressortir sur le bus existant, sinon dashboard et channels ne les voient pas. |
| `cli/doctor.ts` | Devrait vérifier que `.claude/settings.json` référence des hooks pointant vers un binaire existant et un daemon joignable — sinon l'échec est silencieux. |
| `sdk/src/client.ts` | N'est qu'un client OAuth/token (refresh, device code) : il n'expose aucune méthode de coordination. Un pack SDK-side (`options.hooks`) devrait donc parler HTTP/MCP directement, ou le SDK doit grossir. |
| `package.json` | Un seul `bin` (`mcp-coordinator`, l.38-40) et un `files` restreint (l.41-47). Pas de `pnpm-workspace.yaml` à la racine, alors que `sdk/package.json` existe : publier un paquet distinct `@mcp-coordinator/hooks` suppose d'abord de créer un vrai workspace. Une sous-commande du binaire existant évite ce chantier. |
| `docs/ARCHITECTURE.md` | À compléter : les hooks introduisent un troisième chemin d'entrée à côté de MCP et MQTT. |

**Contradictions entre chercheurs, non arbitrées ici :**
1. ~~**Statut.**~~ **Tranchée le 2026-08-14** : le troisième chercheur avait raison. `agent-teams.md` s'ouvre sur « Agent teams are experimental and disabled by default », le flag `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` est bien requis, et la page liste des limitations connues sur la reprise de session, la coordination des tâches et l'arrêt. Le `mixte` du tableau d'en-tête est confirmé. Reste décisif : le garde-fou le plus intéressant est bien le moins stable.
2. ~~**Payload `TaskCreated`.**~~ **Tranchée le 2026-08-14** : la doc donne `task_id` + `task_subject`, avec `task_description` optionnel. `task_title` n'existe pas ; les deux chercheurs majoritaires avaient tort.
3. ~~**Payload `TeammateIdle`.**~~ **Tranchée le 2026-08-14** : `{ teammate_name, team_name }`. `agent_id`/`agent_type` ne sont que les champs communs sous-agent, pas des champs propres à l'événement.
4. **Effort.** Estimé S par les deux chercheurs orientés « hooks d'équipe », M par les deux orientés « pack complet ». Les deux sont probablement justes pour des périmètres différents.

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le pack de hooks doit-il être un **garde-fou bloquant** (`PreToolUse` → `deny` + `TaskCreated` → exit 2), qui rend `announce_work` obligatoire mais couple mcp-coordinator au chemin critique de chaque édition et à une surface Agent Teams encore expérimentale — ou un **capteur passif** (`FileChanged`, `PostToolBatch`, `SubagentStart` en `async: true`), qui enrichit le registry sans jamais bloquer et reste vrai si Anthropic change les contrats de blocage ?

### 6.2 Hypothèse

> Pré-enregistrée le 2026-08-15, **avant** tout PoC. Faits déjà acquis, non re-testés ici :
> [`C01`](C01-hook-mcp-tool-gate.md) a **prouvé le mécanisme** `PreToolUse` (un `deny` bloque
> l'écriture avant le disque), chiffré son effort à **L (~15 fichiers)**, et posé un **préalable
> d'identité bloquant** — *« d'où vient l'`agent_id` ? […] elle doit être tranchée avant d'écrire
> une ligne de gate »*, partagé avec [`F02`](F02-canusetool-distributed-lock.md).

**Hypothèse.** La question de §6.1 est déjà à moitié tranchée ailleurs, et je ne dois pas la
rejouer :

- **La branche « garde-fou bloquant » est bloquée en amont**, pas par son coût mais par le
  préalable d'identité de `C01` §7.3. Et [`B05`](B05-token-passthrough-state-handles.md) vient de
  mesurer **exactement** ce préalable : `agent_id` est fourni par le client, sans aucun liage au
  principal authentifié. Un hook qui refuse une écriture « parce qu'un autre agent détient le
  fichier » s'appuierait donc sur une identité que n'importe qui peut revendiquer.
- **La branche « capteur passif » est mon vrai périmètre**, et personne ne l'a testée. Je m'attends
  à ce qu'elle soit plus faible que §4 ne l'annonce : `FileChanged` ne surveille qu'une liste de
  **noms littéraux** (la §0 l'a déjà corrigé), et `SubagentStart` ne porte que `agent_id` +
  `agent_type`.

**Verdict attendu :** `adopter partiellement` (un sous-ensemble étroit de capteurs) ou `reporter`
si l'identité des subagents s'avère instable.

**Critères de refus, chiffrés (pré-enregistrés) :**

| # | Le résultat qui tue |
|---|---|
| **K1** | Les noms de champs réels **diffèrent** de ceux que la §0 a corrigés le 2026-08-14 → la fiche n'est pas fiable et tout le §2 doit être re-vérifié avant d'être utilisable. |
| **K2** | **`agent_id` n'est pas stable** entre `SubagentStart` et `SubagentStop` → l'enregistrement des subagents dans `AgentRegistry` est impossible, et la « capacité neuve » de §4 s'effondre. |
| **K3** | (rappel du critère) Les hooks d'équipe tirent **sans** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` → le statut `experimental` de l'en-tête est faux ; ou l'inverse, ils ne tirent **pas même avec** → le volet est intestable et donc non adoptable. |
| **K4** | Un `PreToolUse` synchrone interrogeant le daemon ajoute **> 150 ms** par édition → la branche bloquante est morte telle quelle, indépendamment de `C01`. |
| **K5** | Le pack impose de créer un **workspace pnpm** ou dépasse **6 fichiers** → ce n'est plus « une sous-commande », et l'effort M de l'en-tête est faux. |
| **K6** | Zéro demande utilisateur pour une intégration hooks. |

**Critère d'adoption :** au moins un capteur dont le payload est **vérifié par exécution**, dont
l'identité est **stable**, et dont le branchement tient sous K5 — sans dépendre du préalable
d'identité de `C01` §7.3.

**Ce que je m'engage à trancher :** si le capteur passif tient, dire lesquels des 31 événements
méritent d'être câblés — la fiche en propose une dizaine, et §6.5 soupçonne que « le besoin réel
n'est peut-être pas 31 events mais 2 ».

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

- [ ] Écrire un hook `PreToolUse` minimal (script Node lisant stdin) déclaré dans `.claude/settings.json`, qui dumpe le payload brut sur disque, et confirmer **les noms de champs réels** de `PreToolUse`, `FileChanged`, `SubagentStart`, `TaskCreated`, `TeammateIdle` — pour trancher les contradictions 2 et 3 de la §5.
- [ ] Vérifier si `TaskCreated`/`TaskCompleted`/`TeammateIdle` tirent sans `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (contradiction 1 sur le statut).
- [ ] Mesurer la latence ajoutée par un `PreToolUse` qui interroge le daemon local : 20 `Edit` consécutifs avec et sans hook, comparer le temps de tour. Si le surcoût dépasse ~150 ms par édition, l'option garde-fou synchrone est morte telle quelle.
- [ ] Faire tourner deux sessions Claude Code sur le même repo, l'une annonçant un fichier via `announce_work`, l'autre tentant de l'éditer : vérifier qu'un exit 2 produit bien un feedback exploitable dans la seconde session (et pas juste un échec opaque).
- [ ] Vérifier que `SubagentStart` fournit un `agent_id` **stable** entre `SubagentStart` et `SubagentStop`, sans quoi l'enregistrement des subagents dans `AgentRegistry` n'est pas fiable.

### 6.4 Résultat observé

> Exécuté le 2026-08-15 contre **Claude Code 2.1.233** (la §0 en annonçait 2.1.219 — le poste a
> avancé). Hook `command` déclaré sur 15 événements dans un `.claude/settings.json` jetable,
> dumpant chaque payload brut en JSONL.

#### (A) K1 — Les payloads réels confirment les corrections de la §0

Deux sessions réelles, **21 lignes capturées**, 8 événements distincts en session simple :

```
SessionStart, InstructionsLoaded, UserPromptSubmit, PreToolUse,
PostToolUse, PostToolBatch, Stop, SessionEnd
```

Champs réels, relevés à l'exécution :

```
PreToolUse         session_id, transcript_path, cwd, prompt_id, permission_mode, effort,
                   hook_event_name, tool_name, tool_input, tool_use_id
PostToolUse        … + tool_response, duration_ms
PostToolBatch      … + tool_calls
  tool_calls[0]    tool_name, tool_input, tool_use_id, tool_response
InstructionsLoaded session_id, transcript_path, cwd, hook_event_name,
                   file_path, memory_type, load_reason
                   -> memory_type: "User" | load_reason: "session_start"
SessionEnd         session_id, transcript_path, cwd, prompt_id, hook_event_name, reason
Stop               … stop_hook_active, last_assistant_message, background_tasks, session_crons
```

**K1 ne se déclenche pas.** `tool_calls[0]` est bien
`{tool_name, tool_input, tool_use_id, tool_response}` — la correction que la §0 avait portée contre
le `{succeeded, tool_result|error}` de la fiche d'origine est **vérifiée par exécution**. Idem pour
`InstructionsLoaded` et les valeurs `memory_type` / `load_reason`.

**Trois écarts que la fiche n'a pas, et qu'il faut porter en §2 :**

1. **Le « socle commun » n'est pas commun.** §2 le présente comme un bloc unique
   (`session_id, prompt_id, transcript_path, cwd, permission_mode, hook_event_name, effort.level, …`).
   Mesuré : `SessionStart` et `InstructionsLoaded` ne portent **ni `prompt_id`, ni
   `permission_mode`, ni `effort`** — seulement `session_id, transcript_path, cwd,
   hook_event_name` (+ `source` pour `SessionStart`). Le socle réel est plus mince, et le reste
   n'apparaît que sur les événements liés à un tour d'outil.
2. **`PostToolUse` porte `duration_ms`** — absent de la fiche.
3. **`SessionEnd` porte `reason`** — absent de la fiche.

#### (B) K2 — L'identité des subagents est stable, la capacité neuve est réelle

Session lançant un sous-agent via l'outil `Task` :

```
SubagentStart | agent_id = "adbed4d255bc080ca" | agent_type = "general-purpose"
SubagentStop  | agent_id = "adbed4d255bc080ca" | agent_type = "general-purpose"

payloads portant agent_id : 12 sur 21
```

**K2 ne se déclenche pas.** L'`agent_id` est **identique** entre start et stop, et **12 payloads
sur 21** le portent — donc les appels d'outils du sous-agent sont eux aussi attribuables. C'est le
seul point où §4 promettait une capacité que le coordinateur n'a pas, et **elle est confirmée** :
`AgentRegistry` (`src/agent-registry.ts:32`) n'a aujourd'hui aucune notion de subagent.

#### (C) K4 — La branche bloquante est morte, pour une raison que la fiche n'avait pas vue

§6.5 pose le problème comme un budget de réponse du daemon : *« Le daemon doit répondre en quelques
dizaines de millisecondes »*. **C'est le mauvais goulot.** Mesuré, un hook `command` qui interroge
le daemon :

```
run 1 : 256 ms    run 2 : 248 ms    run 3 : 240 ms    run 4 : 268 ms    run 5 : 233 ms
```

Puis le **plancher**, un script Node qui ne fait *rien* d'autre que lire stdin et sortir :

```
spawn nu : 246 ms    spawn nu : 224 ms    spawn nu : 263 ms
```

**Le coût est le spawn du process Node lui-même, pas l'aller-retour HTTP** — qui n'ajoute rien de
mesurable. **~240 ms par édition, avant toute logique.** Seuil pré-enregistré : 150 ms.

> ⚠️ **Correction majeure, imposée par la passe adversariale : j'ai mesuré le mauvais mécanisme,
> et j'en tirais la conclusion inverse de ce que la mesure établit.**
>
> La doc (fetchée aujourd'hui) donne **cinq** types de hook déclarables dans `settings.json` :
> `command`, **`http`**, `mcp_tool`, `prompt`, `agent`. Et pour `http`, verbatim :
> *« send the event's JSON input as an HTTP POST request to a URL »* — **sans ouvrir de process**.
> Ma mesure établissait que le goulot **est** le spawn ; le type `http` le supprime.
>
> Mesuré à mon tour, hook `type: "http"` réellement déclaré sur `PreToolUse` et récepteur local :
>
> ```
> session « cree trois fichiers » -> appels http recus : 3   (un par ecriture)
> aller-retour POST loopback (10 mesures) :
>   min 1.58 ms | median 2.32 ms | max 3.98 ms
> ```
>
> **2,3 ms contre 240 ms — un facteur ~100.** Et `handle-rest.ts:63` expose **déjà**
> `/api/check-conflict`, précisément la cible qu'un tel hook appellerait, avec
> `Authorization: Bearer $TOKEN` supporté nativement via `headers` + `allowedEnvVars`.
>
> **K4 doit donc être scoré par mécanisme :** **non déclenché** sur `type: "http"` (2,3 ms) ·
> **réfuté** sur `mcp_tool` par [`C01`](C01-hook-mcp-tool-gate.md), qui n'ouvre pas de process non
> plus.
>
> **La phrase « la branche bloquante est morte » est retirée.**

> 🔴 **Et mes 240 ms étaient faux. C'est mon erreur de mesure la plus grave de cette fiche.**
> J'avais chronométré en bash avec deux `node -e "console.log(Date.now())"` autour de l'appel :
> **j'ai mesuré trois démarrages de Node et tout attribué au hook.** Re-mesuré proprement, depuis
> Node, avec `child_process.spawn` :
>
> ```
> spawn node noop, mesure DANS node (n=12) :
>   min 63.1 | median 65.4 | max 67.3 ms
> ```
>
> **65 ms, pas 240.** Et la passe adversariale a mesuré le coût *in situ* dans Claude Code
> (résidu `(PostToolUse − PreToolUse) − duration_ms`) à **~90 ms par hook**. Seuil pré-enregistré :
> 150 ms. **K4 ne se déclenche donc sur AUCUN mécanisme, `command` compris.**
>
> Conséquence sur mon raisonnement : l'argument latence ne tue pas la branche bloquante, et il est
> **encore plus faible ailleurs** — le spawn est moins cher sur Linux/macOS que sur ce poste. Ce
> qui tue le gate par édition reste ce que [`C01`](C01-hook-mcp-tool-gate.md) §7.3 a établi (le
> préalable d'identité) et ce que [`B05`](B05-token-passthrough-state-handles.md) a mesuré
> (`agent_id` revendicable par n'importe qui) — **pas la latence**.
>
> *Preuve que le hook est bien synchrone, obtenue par la passe :* un `PreToolUse` qui attend
> 1 500 ms fait passer le résidu de 192 ms à 1 677 ms — Δ ≈ +1 480 ms. L'appel d'outil **attend**
> le hook. Le blocage est donc réel ; c'est son coût qui ne l'est pas.

**Réserve d'honnêteté, et elle compte** : c'est mesuré sur **Windows**, la plateforme du
mainteneur. Le spawn de process y est notoirement plus cher que sur Linux/macOS. Ce résultat
**n'est pas transposable** tel quel aux autres plateformes, et je ne l'ai pas mesuré ailleurs.
Ce qui est transposable, c'est le constat de cadrage : le goulot est le **spawn**, pas le daemon.

*(À ne pas confondre avec [`C01`](C01-hook-mcp-tool-gate.md) : son hook est de type `mcp_tool`,
qui n'ouvre pas de process. Les deux mesures ne se contredisent pas — elles portent sur deux
mécanismes différents.)*

#### (D) K5 — Le packaging, et K6 — la demande

```
pnpm-workspace.yaml a la racine : absent (confirme)
bin du package.json            : mcp-coordinator   (un seul)
```

Le pack `@mcp-coordinator/hooks` comme paquet distinct exigerait donc bien de créer un workspace.
**K5 se déclenche sur cette branche**, pas sur la sous-commande.

```
hook -> 4     hooks -> 2     PreToolUse -> 1     settings.json -> 1     subagent -> 0
```

Signal faible mais non nul. **K6 ne se déclenche pas franchement** — à dépouiller avant d'en tirer
un argument.

#### (E) K3 — Les hooks d'équipe : mesuré, et ils ne tirent pas

> Testé après coup, sur demande explicite du mainteneur de ne pas laisser le quota comme excuse.

Flag posé **des deux façons** que la doc autorise — variable d'environnement **et**
`settings.json` (`{"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}`) — et les trois hooks
déclarés **sans matcher**, comme la doc l'exige pour cette famille. Deux sessions :

```
session 1 — « cree deux taches avec TaskCreate, puis marque la premiere terminee »
  evenements tires : {"SessionStart":1,"Stop":1}
  reponse : « L'outil `TaskCreate` n'existe pas dans cette session »

session 2 — inventaire des outils Task*/Team*/Teammate*
  evenements tires : {"SessionStart":1,"Stop":1}
  reponse : TaskOutput, TaskStop — aucun TaskCreate, aucun outil « Teammate »
```

**`TaskCreated`, `TaskCompleted` et `TeammateIdle` n'ont jamais tiré**, et l'outil `TaskCreate`
qui les déclenche est **absent de la session**. **K3 se déclenche sous sa seconde forme** : le
volet est intestable ici, donc non adoptable — et c'est précisément celui que §4 présente comme le
plus intéressant (« repositionne mcp-coordinator en *quality gate* de l'orchestrateur natif »).

> 🔴 **Ce test était mal configuré, et sa conclusion est fausse.** `TaskCreated` et `TaskCompleted`
> **n'ont rien à voir avec Agent Teams** : ils tirent via l'outil `TaskCreate`, dont la
> disponibilité est gouvernée par le **modèle et un opt-in** (`--allowedTools TaskCreate` ou
> `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`), pas par le flag expérimental. Mes deux sessions n'avaient pas
> activé les Task tools — d'où l'absence de `TaskCreate`, que j'ai prise pour une absence d'équipe.
>
> Re-testé par moi, **sans aucun flag Agent Teams**, avec les Task tools activés :
>
> ```
> evenements: {"SessionStart":1,"TaskCreated":1,"TaskCompleted":1}
>   >> TaskCreated   | {"task_id":"1","task_subject":"sonde hook C02"}
>   >> TaskCompleted | {"task_id":"1","task_subject":"sonde hook C02"}
> ```
>
> **Les payloads confirment la correction de la §0** (`task_id` + `task_subject`, `task_title`
> n'existe pas), et `teammate_name` / `team_name` sont **absents** hors équipe — cohérent avec leur
> statut optionnel.
>
> **K3 se déclenche donc sur sa PREMIÈRE branche**, telle que pré-enregistrée : *« Les hooks
> d'équipe tirent **sans** le flag → le statut `experimental` de l'en-tête est faux »*. **Deux des
> trois le font.** Le `mixte` de l'en-tête et le contre-argument de §6.5 (*« les trois hooks les
> plus intéressants sont liés à Agent Teams, derrière un flag »*) sont **faux** pour `TaskCreated`
> et `TaskCompleted`. Seul `TeammateIdle` est réellement lié aux équipes, et reste non testé.
>
> **Et le contrat de blocage est prouvé** (mesuré par la passe adversariale) : un hook `TaskCreated`
> sortant en code 2 empêche la création — `TaskList` affiche `No tasks found` — et le stderr
> remonte **mot pour mot** au modèle comme erreur d'outil.
>
> **Contrainte réelle, absente de la fiche :** la disponibilité dépend du **modèle** — sur Sonnet 5
> par défaut, les Task tools sont retirés et `TaskCreated` ne tire jamais sans opt-in explicite.

#### (F) Bilan des six critères — et trois qui ne portent pas ce que j'ai écrit

| # | Statut honnête |
|---|---|
| **K1** | ⚠️ **non déclenché sur 4 événements, indéterminé sur 6.** Vérifiés par exécution : `PostToolBatch`, `InstructionsLoaded`, `SubagentStart`, `SubagentStop`. **Non vérifiés** : `FileChanged`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `DirectoryAdded`, `ConfigChange` — les contradictions 2 et 3 de §5 restent donc tranchées **par la doc seule**, ce que l'expérience devait dépasser. |
| **K2** | ❌ non déclenché — `agent_id` stable, 12 payloads sur 21. |
| **K3** | ✅ **déclenché sur sa PREMIÈRE branche** : `TaskCreated` et `TaskCompleted` tirent **sans** flag Agent Teams — le `mixte` de l'en-tête est faux pour eux. Mes deux premières sessions concluaient l'inverse **parce qu'elles n'avaient pas activé les Task tools**. Motif initial (« le quota ») indéfendable : la §0 disait déjà que le volet n'est derrière « qu'une variable d'environnement », et le protocole n'autorise `reporter` que sur une barrière d'**accès**. |
| **K4** | ❌ **ne se déclenche sur aucun mécanisme.** Mes 240 ms étaient une **erreur de mesure** — trois démarrages de Node comptés pour un. Réel : **65 ms** de spawn (n=12), **~90 ms** in situ, **2,3 ms** en `http`. Seuil : 150 ms. |
| **K5** | ⚠️ **à moitié mesuré, et la moitié mesurée était acquise.** L'absence de `pnpm-workspace.yaml` figurait déjà dans les « vérifications passées sans correction » de la §0. Le **second bras — « ou dépasse 6 fichiers » — n'a jamais été compté**, alors que c'est lui qui gouverne la branche retenue. [`C01`](C01-hook-mcp-tool-gate.md) §7.4 a compté **~15 fichiers** pour un pack **strictement plus petit** (un seul hook) ; C02 est nécessairement au-dessus. **L'effort `M` de l'en-tête est donc faux, comme il l'était pour C01.** |
| **K6** | ❌ non déclenché — signal faible mais non nul. |

**Un item du §6.3 a été décoché en silence, et il faut le dire** : la 4ᵉ puce — *« deux sessions
Claude Code sur le même repo […] vérifier qu'un exit 2 produit bien un feedback exploitable »* —
n'a été ni exécutée ni listée comme non exécutée. Elle l'est maintenant, ci-dessous.

#### (G) Un effet de bord qui disqualifie le capteur que j'allais adopter

`SubagentStart` → `AgentRegistry` n'est **pas un capteur passif**. Vérifié :

```ts
// src/announce-workflow.ts:107-110
const otherOnlineCount = registry.listOnline(params.org_id)
  .filter((a) => a.id !== params.agent_id).length;
const shouldAutoResolve = concernedIds.length === 0 && otherOnlineCount === 0;
```

Enregistrer un sous-agent fait passer `otherOnlineCount` de 0 à 1. **Un mainteneur solo dont la
session lance un seul sous-agent verrait ses threads cesser d'auto-résoudre**, et rester ouverts en
attendant un sous-agent éphémère qui ne répondra jamais. `listOnline` filtre par
`last_seen_at <= 900 s` **sans sweeper** — le fantôme survit 15 minutes.

Et la question de fond n'appartient pas à cette fiche : [`F03`](F03-sdk-subagents-sessionstore.md)
§6.1 la pose mot pour mot — *« N lignes reliées par `parent_agent_id` ou UNE seule ligne
session ? »* — et elle est **⬜ non challengée**. `grep -rn "parent_agent_id\|subagent" src/ cli/`
→ **0 occurrence**.

#### (E bis) Ce qui n'a PAS été exécuté

- **`FileChanged`, `CwdChanged`, `DirectoryAdded`, `WorktreeCreate/Remove`** : déclarés mais non
  déclenchés par mes scénarios. Leur payload reste non vérifié par exécution.
- **La latence sur une autre plateforme que Windows.**
- **Une session interactive** avec Agent Teams — voir la frontière ci-dessus.
- **`FileChanged`, `CwdChanged`, `DirectoryAdded`, `WorktreeCreate/Remove`** : déclarés mais non
  déclenchés par mes scénarios. Leur payload reste non vérifié par exécution.
- **La latence sur une autre plateforme que Windows.**

### 6.5 Contre-arguments

- **Portabilité.** Un pack de hooks est du code 100 % Claude Code. mcp-coordinator est un serveur MCP, donc théoriquement client-agnostique ; il possède déjà une sous-commande spécifique à Claude Code (`cli/channel.ts`). En ajouter une seconde ancre le produit sur un seul client, et crée deux chemins de coordination à maintenir en parallèle (MCP déclaratif pour tout le monde, hooks impératifs pour Claude Code) — avec le risque de divergence de comportement entre les deux.
- **Dépendance à une surface instable.** Les trois hooks les plus intéressants sont liés à Agent Teams, classés `experimental` par un des chercheurs, derrière un flag `CLAUDE_CODE_EXPERIMENTAL_*`. Le champ `team_name` est déjà déprécié, et le comportement de l'exit code 2 a dû être corrigé en v2.1.214 — signe que le contrat bouge encore. Construire le garde-fou principal dessus, c'est accepter une casse en amont.
- **Latence sur le chemin critique.** Un `PreToolUse` bloquant s'exécute à chaque `Write`/`Edit`. Le daemon doit répondre en quelques dizaines de millisecondes ou l'utilisateur ressent le coordinateur comme un ralentissement — et le désactive. Le mode `async: true` du SDK évite cela mais ne bloque justement rien.
- **Mode d'échec asymétrique.** Un faux positif de `ConflictDetector` était jusqu'ici un avertissement ignorable ; en hook bloquant, il devient un agent bloqué. Le détecteur n'a jamais été évalué sous ce régime de responsabilité.
- **Coût de packaging.** Pas de `pnpm-workspace.yaml` à la racine : publier `@mcp-coordinator/hooks` comme paquet distinct implique de restructurer le repo (`sdk/package.json` est déjà dans cette zone grise). Une sous-commande évite le chantier mais alourdit un `bin` unique déjà chargé.
- **Complexité pour l'auto-hébergeur.** `init` écrirait désormais dans `.claude/settings.json` du repo de l'utilisateur — fichier partagé, versionné, possiblement déjà rempli. Merge, désinstallation propre (`cli/uninstall.ts`) et diagnostic (`cli/doctor.ts`) sont autant de surfaces nouvelles ; un hook mal configuré échoue silencieusement et laisse croire à une protection inexistante — le pattern « garde-fou fantôme » déjà relevé dans l'audit interne.
- **YAGNI.** Le besoin réel n'est peut-être pas 31 events mais 2 : `PreToolUse` et `SessionEnd`. Livrer un pack exhaustif parce que la surface existe est le contraire d'une intégration ciblée.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** (périmètre réduit à ce qui est prouvé et sans effet de bord) · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | **Le capteur que j'allais adopter introduit une régression, et la branche que j'allais tuer est vivante.** `SubagentStart` → `AgentRegistry` n'est pas passif : `announce-workflow.ts:107-110` fait basculer `shouldAutoResolve` dès qu'un agent de plus est en ligne, donc un solo qui lance un sous-agent verrait ses threads cesser d'auto-résoudre — et la question de fond appartient à [`F03`](F03-sdk-subagents-sessionstore.md), non challengée. À l'inverse, ma mesure de 240 ms portait sur `type: "command"` ; le type **`http`**, qui n'ouvre aucun process, coûte **2,3 ms** — et `handle-rest.ts:63` expose déjà la cible. Reste donc adoptable ce qui est **prouvé par exécution et sans effet de bord** : consommer `SessionEnd` et `PostToolBatch` vers les endpoints REST existants, en `type: "http"`. |
| **Issue / PR** | Aucune créée. Périmètre en §7.2, renvois en §7.3. |
| **Jalon visé** | après `F03` pour le volet sous-agents |

### 7.1 La réponse à la question de §6.1

**§6.1 oppose « garde-fou bloquant » à « capteur passif ». Les deux termes sont mal posés, et pour
des raisons opposées.**

*Terme 1 — le garde-fou bloquant.* **Il n'appartient pas à cette fiche.**
[`C01`](C01-hook-mcp-tool-gate.md) l'a tranché le 2026-08-15 : mécanisme prouvé, effort **L**, et un
**préalable d'identité** qui bloque tout gate. **C02 ne le rouvre pas.** Ce que C02 ajoute, et qui
corrige un contre-argument de §6.5, c'est que **la latence n'est pas l'obstacle** : elle vaut
240 ms en `command` et **2,3 ms en `http`**. §6.5 posait la question comme un budget de réponse du
daemon (*« quelques dizaines de millisecondes »*) — c'était le mauvais goulot dans les deux sens.

*Terme 2 — le capteur passif.* **« Passif » est faux pour le capteur le plus intéressant.**
Enregistrer les sous-agents modifie la sémantique de `agents`, que quatre chemins métier lisent —
dont `shouldAutoResolve`. Ce n'est pas un capteur, c'est un changement de modèle de données.

**Réponse : ni l'un ni l'autre tel que posé.** Ce qui reste est un troisième terme, plus étroit et
entièrement prouvé : **des capteurs qui écrivent dans des endpoints déjà existants et ne touchent
pas au registre**.

### 7.2 Ce qui est retenu — et le périmètre s'élargit, il ne se réduit pas

**1. `TaskCreated` comme garde-fou bloquant, à granularité tâche.** C'est le point le plus fort de
la fiche, et j'avais failli le reporter sur une mesure mal configurée. Il est prouvé de bout en
bout : le hook tire **sans aucun flag expérimental**, l'exit 2 **empêche** la création de la tâche,
et le stderr remonte **mot pour mot** au modèle. Surtout, il tire **une fois par tâche**, pas par
édition — donc l'objection de coût qui pèse sur un gate d'écriture ne s'y applique pas, et
`ConflictDetector.detect()` (`src/conflict-detector.ts:20`) a déjà exactement la signature requise.
C'est le seul endroit où mcp-coordinator obtient un **vrai pouvoir de refus** sans être sur le
chemin critique de chaque `Write`.
**Réserve à documenter** : la disponibilité dépend du modèle et d'un opt-in
(`--allowedTools TaskCreate` / `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`). Un utilisateur Sonnet 5 par
défaut ne verra jamais le hook tirer — il faut le dire, sinon c'est un garde-fou fantôme de plus.

**2. `SessionEnd` → `/api/session-stop` et `PostToolBatch` → `/api/log-file`**, en
**`type: "http"`** (2,3 ms, aucun process) ou en `command` avec `async: true` — champ qui existe
bien pour les hooks `command` dans `settings.json`, contrairement à ce que §2 laisse croire. Les
deux endpoints existent déjà (`src/http/handle-rest.ts:63`) : **rien de nouveau à router**.
Payloads vérifiés par exécution.

**3. Livré comme sous-commande**, pas comme paquet : `pnpm-workspace.yaml` est absent.

### 7.3 Ce qui est renvoyé, et à qui

| Volet | Renvoi | Pourquoi |
|---|---|---|
| Le gate bloquant | [`C01`](C01-hook-mcp-tool-gate.md) §7.1/§7.3 | Déjà tranché ; préalable d'identité. C02 apporte seulement que la latence n'est pas l'obstacle. |
| `SubagentStart/Stop` → registre | [`F03`](F03-sdk-subagents-sessionstore.md) | Sa §6.1 pose exactement la question (« N lignes ou une ? »), et elle est **non challengée**. L'`agent_id` est stable (mesuré) — le blocage est le modèle de données, pas l'identité. |
| Hooks d'équipe | — | **Reporté**, motif : non exécutables ici (mesuré, §6.4 E). Réveil : une session **interactive** avec Agent Teams, ou l'apparition de `TaskCreate` dans une version ultérieure. |

### 7.4 Corrections à porter dans les sections 1 à 5, et chez moi

**Dans la fiche :**

1. **§2, socle commun** — il n'est pas commun. `SessionStart` et `InstructionsLoaded` ne portent ni
   `prompt_id`, ni `permission_mode`, ni `effort`.
2. **§2** — ajouter `duration_ms` (`PostToolUse`) et `reason` (`SessionEnd`), tous deux mesurés.
3. **§2, `SubagentStart`** — la clause *« sortie : `hookSpecificOutput.additionalContext` injecte
   du contexte au subagent »* est **contredite par la doc** : la table *Exit code 2 behavior* donne
   `SubagentStart | No | Shows stderr to user only`. À vérifier ou retirer.
4. **§2** — le champ `async` est documenté pour les hooks **`command` dans `settings.json`**, pas
   seulement dans l'Agent SDK où §2 le range.
5. **§2** — la liste des types de hook manque : il y en a **cinq** (`command`, `http`, `mcp_tool`,
   `prompt`, `agent`), et l'absence de `http` est ce qui m'a fait mesurer le mauvais mécanisme.
6. **En-tête, effort** — `M` est faux. `C01` a compté ~15 fichiers pour un pack plus petit.

**Chez moi :**

7. **J'ai tué une branche sur le mauvais mécanisme**, et ma propre mesure disait pourquoi : elle
   établissait que le goulot est le **spawn**, et je n'ai pas cherché le type de hook qui ne
   spawne pas.
8. **J'ai invoqué le quota pour ne pas tester K3**, alors que la §0 disait que le volet n'est
   derrière qu'une variable d'environnement. Le protocole n'autorise `reporter` que sur une
   barrière d'accès. Testé après coup, il se déclenche — mais le motif initial était indéfendable.
9. **J'ai déclaré K1 « non déclenché » sur 4 événements vérifiés sur 10.**
10. **J'ai laissé une puce de §6.3 décochée en silence** (le test à deux sessions).
11. **J'allais adopter un capteur qui casse `shouldAutoResolve`** pour le profil de déploiement
    dominant, sans avoir regardé ses consommateurs.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : 31 events exacts, mais 10 payloads corrigés ; contradictions 1-3 tranchées ; testable localement. |
| 2026-08-15 | Challenge, Claude Code 2.1.233. **Verdict : `adopter partiellement`** — `TaskCreated` comme garde-fou bloquant à granularité tâche, plus `SessionEnd` et `PostToolBatch` en capteurs vers les endpoints REST existants. **Trois erreurs de mesure de ma part, toutes corrigées par la passe adversariale :** (1) mes **240 ms** de latence étaient faux — j'avais chronométré en bash avec deux `node -e` autour de l'appel, donc **trois démarrages de Node comptés pour un** ; le réel est **65 ms** de spawn et **~90 ms** in situ, sous le seuil de 150 ms, donc **K4 ne se déclenche pas** ; (2) j'avais tué la branche bloquante sur `type: "command"` en ignorant le type **`http`**, qui n'ouvre aucun process et coûte **2,3 ms** ; (3) mon test des hooks d'équipe était **mal configuré** — `TaskCreated` tire **sans** flag Agent Teams dès que les Task tools sont activés, et son contrat de blocage exit-2 est vérifié de bout en bout (tâche non créée, stderr rendu mot pour mot au modèle). **K3 se déclenche donc sur sa première branche**, ce qui invalide le `mixte` de l'en-tête. Écarté en revanche : `SubagentStart` → `AgentRegistry`, qui n'est **pas passif** — `announce-workflow.ts:107-110` fait basculer `shouldAutoResolve` dès qu'un agent de plus est en ligne, donc un solo verrait ses threads cesser d'auto-résoudre ; renvoyé à [`F03`](F03-sdk-subagents-sessionstore.md), non challengée. Effort **M → L**. |
