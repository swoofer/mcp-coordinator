# D02 — MENACE : Agent Teams (task list partagée, mailbox, file locking)

| Champ | Valeur |
|---|---|
| **ID** | `threat-agent-teams` |
| **Surface** | claude-code |
| **Statut** | **experimental** — désactivé par défaut, derrière `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Warning et section « Limitations » explicites dans la doc. Aucun canal GA / beta ; annoncé « research preview » au CHANGELOG v2.1.32, documenté « experimental » depuis. |
| **Disponible depuis** | livré ~v2.1.32 (fév. 2026, cycle Opus 4.6) · la page doc se déclare « as of v2.1.178 » mais documente déjà des comportements jusqu'à v2.1.207 · toujours experimental en août 2026 |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | L (un pack de hooks `TaskCreated`/`TaskCompleted`/`TeammateIdle` seul est en M) |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — split-pane impossible sous Windows Terminal, session interactive obligatoire |
| **Statut du challenge** | ✅ **tranché** (2026-08-16) — frontière assumée ; Agent Teams n'a AUCUN verrou de fichier |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

Le cœur factuel tient : `code.claude.com/docs/en/agent-teams.md` confirme mot pour mot le flag
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, le statut experimental, les chemins d'état
(`~/.claude/teams/{team-name}/config.json`, `inboxes/{agent-name}.json`, `~/.claude/tasks/{team-name}/`),
la dérivation `session-` + 8 caractères, la suppression du config en fin de session, `SendMessage`,
les trois hooks, la dépréciation de `team_name`, la disparition de `TeamCreate`/`TeamDelete` en
v2.1.178, le file locking sur le claim de tâche et la phrase « Avoid file conflicts ». Le CHANGELOG
confirme l'introduction en **v2.1.32** (« Added research preview agent teams feature ») et la mention
v2.1.207. Tous les fichiers cités en §5 existent.

**Corrections apportées :**
- §5 `cli/init.ts` : les trois flags cités étaient **inventés**. Ce ne sont pas `--dir` / `--claude-md` /
  `--dry-run` mais `--write-mcp-config <path>` (l.101), `--write-claude-md <path>` (l.105) et
  `--print-only` (l.109). Les lignes d'écriture (l.225 `.mcp.json`, l.258 `CLAUDE.md`) étaient justes.
- §5 `src/http/handle-rest.ts` : la table `ROUTES` va de la l.63 à la l.85 (et non l.64-84) ;
  `/api/check-conflict` est bien à la l.67.
- §2 : ajout des **noms de champs réels** des payloads `TaskCreated` / `TaskCompleted` / `TeammateIdle`,
  jusqu'ici absents de la fiche, et de l'alternative JSON `{"continue": false, "stopReason": …}`.
- §2 : le « aucun matcher supporté » de `TeammateIdle` est confirmé et étendu — les **trois** hooks
  sont dans la liste « no matcher support » de `hooks.md` (l.322 du doc).
- Statut : précision que la feature a été annoncée comme « research preview » dans le CHANGELOG
  v2.1.32 avant d'être documentée comme « experimental ».

Vérifiés et laissés inchangés : `rest-handlers.ts` l.349/367/392/412/418, `conflict-detector.ts`
l.20/l.115 (fenêtre 60 min), `impact-scorer.ts` l.42, `announce-workflow.ts` l.60,
`consultation-tools.ts` l.37, `files-tools.ts` l.20/50, `agent-registry.ts` l.32,
`agents-tools.ts` l.21/68, `mqtt-bridge.ts` l.319/351/366, `cli/channel.ts` l.277,
`cli/uninstall.ts` l.51/84, `package.json` (`bin` unique, `files` restreint). L'affirmation centrale
« aucune trace de hook Claude Code dans le repo » est vraie : un grep sur `settings.json` dans `src/`
et `cli/` ne remonte **rien**, et les seules occurrences de « hook » sont les hooks ACL Aedes de
`src/mqtt-broker.ts` et des commentaires.

**Marqueurs `(à vérifier)` restants :** aucun (la fiche n'en contenait aucun).

**Testabilité :** ⚠️ partielle
Testable localement sans aucun accès privilégié : le flag est une simple variable d'environnement, tout
l'état est sur disque, et les hooks `TaskCreated`/`TaskCompleted` se déclarent dans `.claude/settings.json`
— on peut donc lancer une team de 2, capturer les payloads réels, brancher `/api/check-conflict` sur le
daemon local et mesurer la latence. Deux limites : le point §6.3 sur les split panes n'est **pas**
vérifiable ici (Windows Terminal est explicitement non supporté, tmux/iTerm2 requis), et le spawn de
teammates exige une **session interactive** — la doc précise qu'en mode `-p`/headless aucun teammate
n'est créé, donc le PoC ne peut pas être scripté de bout en bout.

---

## 1. Ce que c'est

Agent Teams est l'orchestration multi-sessions native de Claude Code : une session « lead » spawne des « teammates » qui sont des sessions Claude Code complètes (contexte propre, `CLAUDE.md`, serveurs MCP, skills chargés). L'équipe partage une **task list avec dépendances** — quand un teammate termine une tâche dont d'autres dépendent, celles-ci sont débloquées automatiquement — et une **messagerie directe** via l'outil `SendMessage`. La revendication d'une tâche est protégée par du **file locking**, textuellement : « Task claiming uses file locking to prevent race conditions when multiple teammates try to claim the same task simultaneously. »

L'état vit sur disque dans le home : `~/.claude/teams/{team-name}/config.json` (tableau `members`, le lead porte le type `team-lead`), un mailbox JSON par agent dans `inboxes/{agent-name}.json`, et la task list dans `~/.claude/tasks/{team-name}/`. Le nom d'équipe est dérivé de la session (`session-` + les 8 premiers caractères du session ID). Le répertoire de config est **supprimé en fin de session** ; seul `~/.claude/tasks/` persiste (rétention via `cleanupPeriodDays`). La doc interdit l'édition manuelle de ces fichiers : « your changes are overwritten on the next state update ».

Un teammate peut être instancié depuis une définition de subagent (`.claude/agents/*.md`, scopes project/user/plugin/CLI) référencée par nom au spawn ; `SendMessage` et les outils de tâche restent disponibles même quand le frontmatter `tools` restreint le reste. Trois hooks spécifiques encadrent le cycle de vie — `TeammateIdle`, `TaskCreated`, `TaskCompleted` — avec la sémantique exit code 2 = bloquer + renvoyer stderr comme feedback.

**Le point décisif :** Anthropic ne résout pas le conflit de fichiers, il l'évite par découpage humain. La doc écrit noir sur blanc « Avoid file conflicts — Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files. », et ajoute « Agent teams don't isolate teammates in worktrees, so partition the work » et « For sequential tasks, same-file edits, or work with many dependencies, a single session or subagents are more effective. » Le locking couvre le **claim de tâche**, pas les fichiers.

## 2. Surface d'API exacte

Activation et modes :

```
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1     # shell, ou bloc `env` de settings.json
teammateMode                                # ~/.claude/settings.json
  "in-process"   (défaut depuis v2.1.179 ; "auto" avant)
  | "auto" | "tmux" | "iterm2" (v2.1.186+, requiert le CLI `it2`)
claude --teammate-mode <mode>               # experimental, absent de `claude --help`
```

État sur disque (lecture seule de fait — la doc interdit l'édition manuelle) :

```
~/.claude/teams/{team-name}/config.json              # tableau `members`, lead = type "team-lead"
                                                     # SUPPRIMÉ en fin de session
~/.claude/teams/{team-name}/inboxes/{agent-name}.json  # mailbox JSON par agent
~/.claude/tasks/{team-name}/                         # persiste, rétention cleanupPeriodDays
team-name = "session-" + 8 premiers caractères du session ID
```

Outils et hooks :

```
SendMessage            # nommé explicitement ; toujours dispo pour un teammate,
                       # même quand l'allowlist `tools` du subagent restreint le reste
TeammateIdle           # exit 2 → le teammate reste au travail
TaskCreated            # exit 2 → « rolls back the task creation »
TaskCompleted          # exit 2 → la tâche n'est pas marquée terminée
                       # les TROIS sont dans la liste « no matcher support » de hooks.md
                       # alternative à exit 2 : {"continue": false, "stopReason": "…"}
                       # → arrête le teammate, sémantique du hook Stop
team_name (outil Agent)  # accepté mais ignoré
```

Champs de payload réels (`hooks.md`, en plus des champs communs `session_id`, `transcript_path`,
`cwd`, `permission_mode`, `hook_event_name`) :

```
TaskCreated / TaskCompleted  task_id, task_subject, task_description (peut manquer),
                             teammate_name (peut manquer), team_name (DÉPRÉCIÉ,
                             « will be removed in a future release »)
TeammateIdle                 agent_id, agent_type, team_name (DÉPRÉCIÉ)
```

Le champ de titre est `task_subject`, pas `task_title` ni `task_name`. `TaskCreated` se déclenche
sur l'appel de l'outil `TaskCreate` ; `TaskCompleted` se déclenche sur `TaskUpdate` **ou** quand un
teammate finit son tour avec des tâches en cours. Corrélation à une session : `session_id` des
champs communs (le `team_name` en est dérivé mais est déprécié).

Limitations documentées, à citer telles quelles dans toute analyse de positionnement : une seule équipe par session, pas d'équipes imbriquées, lead figé, pas de reprise de session avec des teammates in-process, pas de partage d'équipe entre sessions, permissions fixées au spawn, split panes hors tmux/iTerm2 non supportés (ni terminal intégré VS Code, ni Windows Terminal, ni Ghostty). Il n'existe pas d'équivalent projet : `.claude/teams/teams.json` est traité comme un fichier ordinaire.

Deux points explicitement **retirés** par la vérification :
- `isolation: worktree` **n'est pas** une surface Agent Teams — c'est du frontmatter de *subagent* (`docs/en/sub-agents#supported-frontmatter-fields`). Son comportement pour un teammate n'est pas documenté (la page précise au contraire que `skills` et `mcpServers` ne sont pas appliqués quand une définition tourne comme teammate).
- `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` **ne sont pas** propres aux teams : ce sont les outils de tâche généraux de Claude Code (successeurs de `TodoWrite` depuis ~v2.1.142). La page agent-teams ne les nomme pas et parle de « the task management tools ».
- `TeamCreate` / `TeamDelete` : supprimés depuis v2.1.178 (« Both tools no longer exist »). Le setup manuel a disparu, pas la feature.

## 3. Sources

- https://code.claude.com/docs/en/agent-teams.md
- https://code.claude.com/docs/en/agents.md
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/sub-agents
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.** Anthropic vient de livrer nativement trois briques que mcp-coordinator implémente en interne : le claim de tâche atomique (`handleClaimTask`, `src/http/rest-handlers.ts:392` — un `UPDATE threads SET claimed_by = ? … WHERE claimed_by IS NULL AND status = 'open'`), la messagerie inter-agents (le bus MQTT `coordinator/{org}/consultations/{id}/messages`, `src/mqtt-bridge.ts:319`) et la notification de claim (`publishTaskClaimed`, `src/mqtt-bridge.ts:351`). Sur ce terrain-là, la partie est perdue : Anthropic est dans le produit, sans daemon, sans broker, sans inscription.

Ce qui reste est exactement ce qu'Anthropic refuse de faire. La doc délègue la partition des fichiers au prompt humain ; mcp-coordinator l'automatise avec `ConflictDetector.detect()` (`src/conflict-detector.ts:20` : chevauchement de modules, chevauchement de fichiers, chaîne de dépendances via `getBlastRadius`, et hot files issus de l'activité réelle), `ImpactScorer` (`src/impact-scorer.ts:42`) et le flux `runCommonAnnounceFlow` (`src/announce-workflow.ts:60`). Le positionnement qui survit n'est plus « faire parler les agents » mais « savoir quels fichiers vont casser **avant** l'écriture ». Deux capacités neuves apparaissent si on s'y branche : (a) un hook `TaskCreated` qui refuse (exit 2) la création d'une tâche empiétant sur des fichiers déjà revendiqués, ce qui transforme le détecteur en garde-fou de l'orchestrateur natif ; (b) un hook `TaskCompleted`/`TeammateIdle` qui fait remonter la task list d'une équipe dans `AgentRegistry` (`src/agent-registry.ts:32`) et donc dans le dashboard, aujourd'hui aveugle aux teammates. L'utilisateur qui en profite est celui qui lance une team de 4 sur un monorepo et découvre au merge que deux teammates ont réécrit le même fichier.

La doc impose aussi la **forme** de l'intégration : puisque les fichiers d'état ne doivent pas être lus/écrits (config supprimé en fin de session, réécrit à chaque state update), toute approche par surveillance de `~/.claude/teams/` est invalide. Le seul point d'entrée légitime est le hook.

**Risque si on ne fait rien.** Élevé et structurel. Agent Teams couvre déjà ~70 % du concept de coordination vendu par mcp-coordinator, gratuitement et sans installation. Trois amortisseurs, tous temporaires : la feature est experimental et désactivée par défaut ; elle est scopée à **une seule session** (impossible de coordonner deux développeurs humains, ou Claude Code avec Cursor/Cline/Aider) ; elle n'a aucune détection de conflit. Le premier amortisseur disparaîtra mécaniquement — la vitesse d'itération de la page (v2.1.178 → v2.1.207 en quelques semaines) l'annonce. Le troisième est le seul qui tienne à long terme, et il n'est défendable que si mcp-coordinator se branche **dans** Agent Teams plutôt qu'à côté. Réserve honnête : le cross-session n'est pas non plus un pré carré, Anthropic documente une feature distincte `cross-session-messaging`. Il ne reste en propre que le **cross-outil** et la **détection de conflit fichier**.

## 5. Points d'intégration dans le repo

Aucune trace de hook Claude Code dans le code : un grep sur `src/` et `cli/` ne remonte que les hooks ACL Aedes (`src/mqtt-broker.ts`) et `node:async_hooks`. Tout le chemin d'intégration est à construire.

| Fichier / module | Impact |
|---|---|
| `src/http/rest-handlers.ts` | `handleClaimTask` (l.392) et `handleUnclaimTask` (l.349) sont le **doublon frontal** du claim d'Agent Teams : claim atomique par `UPDATE … WHERE claimed_by IS NULL AND status = 'open'`, dispatch dirigé via `assigned_to`, et un `POISON_THRESHOLD = 2` qui marque une tâche `poisoned` après deux abandons. Anthropic n'a ni dispatch dirigé ni poisoning ; à l'inverse sa task list est native. C'est le point de décision central de la fiche. |
| `src/http/handle-rest.ts` | Table de routes explicite `ROUTES` (l.63-85) : `/api/claim-task`, `/api/unclaim-task`, `/api/check-conflict`, `/api/session-start`, `/api/log-file`. Un hook process a besoin d'un endpoint synchrone rapide ; `/api/check-conflict` (l.67) est le candidat existant, à évaluer en latence. |
| `src/conflict-detector.ts` | `ConflictDetector.detect({ org_id, agent_id, target_modules, target_files })` (l.20) — la signature dont un `TaskCreated` a exactement besoin. C'est la capacité qu'Agent Teams n'a pas. |
| `src/impact-scorer.ts` | `ImpactScorer` (l.42) produit `concerned` / `gray_zone` / `pass`. À trancher : un `gray_zone` doit-il bloquer un claim de teammate ou seulement l'avertir ? |
| `src/announce-workflow.ts` | `runCommonAnnounceFlow` (l.60) est le chemin partagé annonce → scoring → conflits. Un hook `TaskCreated` doit s'y brancher, pas dupliquer la logique. |
| `src/tools/consultation-tools.ts` | `announce_work` (l.37) est déclaratif : sans appel du modèle, rien ne se passe. Un teammate n'a aucune raison de l'appeler — la doc Agent Teams ne le mentionne évidemment pas. C'est la faiblesse que le hook comble. |
| `src/tools/files-tools.ts` | `hot_files` (l.20) et `check_file_conflict` (l.50) exposent déjà la détection côté MCP ; un hook doit passer par la même couche `FileTracker`, pas par une seconde implémentation. |
| `src/working-files-tracker.ts` | Le commentaire de tête (l.6-14) décrit déjà un cycle `PreToolUse → start()` / `PostToolUse → stop()` avec TTL et sweeper. L'infrastructure de claim de fichier existe donc ; **rien ne l'alimente** aujourd'hui côté Claude Code. |
| `src/agent-registry.ts` | `AgentRegistry` (l.32) ne connaît que des agents plats. Un teammate a un `agent-name` dans le mailbox et un type (`team-lead` ou non) : à décider s'il devient une entrée à part entière ou une sous-entrée. Le `team_name` est déprécié — la corrélation doit passer par le `session_id`. |
| `src/tools/agents-tools.ts` | `register_agent` (l.21) et `heartbeat` (l.68) deviennent redondants pour un teammate, dont la présence est déjà connue de la team. Restent nécessaires pour tout autre client MCP. |
| `src/mqtt-bridge.ts` | `publishTaskClaimed` (l.351) → `coordinator/{org}/consultations/{id}/claimed`, `publishTaskCompleted` (l.366) → `/completed`, messages (l.319). Si les hooks Task* alimentent le broker, la task list d'une team devient visible pour tous les clients MQTT — y compris les non-Claude-Code. C'est le vrai levier cross-outil. |
| `src/sse-emitter.ts` | Émet déjà `task_claimed` (`rest-handlers.ts:418`). Les événements de team doivent ressortir sur ce bus, sinon le dashboard ne les voit pas. |
| `cli/channel.ts` | Précédent direct : sous-commande stdio spécifique à Claude Code, découplée du daemon, qui parle MQTT (`buildChannelServer`, l.277). Une commande `mcp-coordinator hook <event>` lisant le payload sur stdin suivrait le même schéma. |
| `cli/init.ts` | Écrit aujourd'hui `.mcp.json` (l.225, avec merge) et une section `CLAUDE.md` (l.258), avec `--write-mcp-config <path>` (l.101), `--write-claude-md <path>` (l.105) et `--print-only` (l.109). **N'écrit jamais dans `.claude/settings.json`** — c'est ce qu'il faudrait ajouter pour poser les hooks Task*, plus l'`env` block portant `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. |
| `cli/uninstall.ts` | Sait retirer l'entrée `coordinator` d'un `.mcp.json` (l.51) et la section d'un `CLAUDE.md` (l.84). Toute écriture dans `.claude/settings.json` doit avoir sa désinstallation symétrique ici. |
| `cli/doctor.ts` | Devrait vérifier que les hooks déclarés pointent vers un binaire existant et un daemon joignable, sinon l'échec est silencieux — le pattern « garde-fou fantôme » déjà relevé en audit interne. |
| `sdk/src/client.ts` | Purement OAuth/token (refresh, device code) : aucune méthode de coordination. Un hook devra parler HTTP/MCP directement, ou le SDK doit grossir. |
| `package.json` | Un seul `bin` (`mcp-coordinator` → `./dist/cli/index.js`) et un `files` restreint (`dist/src/`, `dist/cli/`, `dashboard/`). Une sous-commande `hook` s'y insère sans chantier ; un paquet séparé imposerait un vrai workspace. |
| `dashboard/public/` | Statique, sans notion de team ni de teammate. Afficher une task list Agent Teams à côté des threads est une décision UI à part entière. |
| `docs/ARCHITECTURE.md` | À compléter : les hooks d'équipe ouvrent un troisième chemin d'entrée à côté de MCP et MQTT, et un second modèle de tâche à côté des threads. |

**Contradictions entre chercheurs, non arbitrées ici :**
1. **Date d'introduction.** Deux chercheurs donnent `since = v2.1.178` ; deux autres corrigent : v2.1.178 est la version où `TeamCreate`/`TeamDelete` ont été supprimés (changement de contrat), pas la naissance de la feature, livrée ~v2.1.32 en février 2026. Le tableau d'en-tête retient la seconde lecture.
2. **Nature.** Trois chercheurs classent `threat`, un classe `opportunity` (angle « pack de hooks anti-collision »). La fiche retient `threat` : c'est le cadrage qui force la décision, l'opportunité n'existe qu'en réponse.
3. **Effort.** L pour deux chercheurs (intégration complète), M pour deux autres (hooks Task* seuls). Périmètres différents, les deux estimations sont probablement justes.

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> mcp-coordinator abandonne-t-il sa propre couche d'orchestration (`/api/claim-task`, `assigned_to`, poisoning, mailbox MQTT) pour devenir une **couche anti-collision branchée en hooks sur la task list d'Agent Teams** — ou garde-t-il son claim maison, au risque d'entretenir deux task lists concurrentes et deux verrous non coordonnés dans la même session Claude Code ?

### 6.2 Hypothèse

*Pré-enregistrée le 2026-08-16, **avant** toute exécution. Challenge groupé avec `D01`, verdict par fiche.*

**Ce que `C02` a déjà établi et que je réutilise :** `TaskCreated` et `TaskCompleted` tirent **sans**
le flag Agent Teams — mesuré. Le gating de la task list passe par l'activation des outils de tâche,
pas par le flag d'équipe. Les hooks d'équipe existent donc partiellement en dehors d'Agent Teams.

**Ce que je crois qu'il va se passer.**

1. La task list native est **par session ou par équipe locale**, sans notion d'org ni de multi-machine.
2. Le « file locking » d'Agent Teams sera **coopératif** — un verrou que les membres respectent — et
   non contraignant, donc de même nature que notre `working_files` : consultatif.
3. Entretenir deux task lists est le vrai risque, et il est **de produit**, pas de technique.

**Verdict pressenti :** réponse = **frontière assumée** — garder le claim maison, et documenter
précisément ce que le natif ne couvre pas, plutôt que de brancher des hooks sur une surface
`experimental`.

**Critères de mort.**

| # | Si… | …alors |
|---|---|---|
| **K1** | Agent Teams n'est pas observable ici | pas de frontière mesurée → le dire, et s'en tenir à la doc. |
| **K2** | le verrou natif est **contraignant** (il empêche réellement l'écriture) | notre `working_files` consultatif devient inférieur : à écrire sans détour, c'est le pire cas. |
| **K3** | la task list native traverse les machines ou porte une notion d'org | notre différenciation principale tombe. |
| **K4** | brancher des hooks sur la task list coûte plus de **10 fichiers** | la branche « couche anti-collision » est disqualifiée par le coût. |
| **K5** | Agent Teams reste `experimental` derrière un flag | on ne branche rien dessus : la surface peut disparaître sans préavis — trois fiches de ce corpus l'ont déjà montré (`tengu_harbor`, `tengu_harbor_permissions`, `tengu_amber_sentinel`). |
| **K6** | aucun utilisateur n'a demandé d'intégration Agent Teams | filtre YAGNI. |

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Deux points de ce protocole ne sont pas exécutables ici : les split panes (Windows Terminal explicitement non supporté, tmux/iTerm2 requis) et tout scénario scripté en `-p`/headless, où la doc précise qu'aucun teammate n'est spawné — le PoC doit être conduit en session interactive.

- [ ] Activer `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` sur le poste Windows, lancer une team de 2 sur un repo jetable, et vérifier ce qui tourne réellement : `teammateMode` étant `in-process` par défaut et le split-pane non supporté sous Windows Terminal, confirmer que l'ergonomie multi-pane est bien hors jeu ici.
- [ ] Déclarer un hook `TaskCreated` minimal (script Node lisant stdin, dump du payload sur disque) et relever **les noms de champs réels** — la fiche C02 signale une contradiction `task_title` vs `task_description`, et le `team_name` est déprécié : vérifier ce qui permet de corréler une tâche à une session.
- [ ] Reproduire le scénario que la doc dit d'éviter : deux teammates édite le même fichier, sans hook. Constater l'écrasement, capturer la sortie. C'est la preuve du gap, elle doit être vue et pas citée.
- [ ] Rejouer le même scénario avec un hook `TaskCreated` qui appelle `/api/check-conflict` (`src/http/handle-rest.ts:67`) et sort en 2 quand `ConflictDetector` remonte un `file_overlap` : vérifier que la tâche est bien annulée (« rolls back the task creation ») et que le teammate reçoit un feedback exploitable, pas un échec opaque.
- [ ] Mesurer la latence ajoutée par ce hook sur 20 créations de tâche. Au-delà de ~150 ms par appel, l'option bloquante synchrone est morte telle quelle.
- [ ] Vérifier si `~/.claude/teams/{team-name}/config.json` est bien supprimé en fin de session (la doc l'affirme) : si oui, toute approche par lecture de fichiers d'état est définitivement écartée et seul le chemin hook subsiste.

### 6.4 Résultat observé

*Challenge du 2026-08-16, groupé avec `D01`. Claude Code **2.1.233**.*

#### A. 🔴 Le « file locking » d'Agent Teams **n'existe pas** — mon hypothèse était fausse par catégorie

§6.2 pariait que le verrou natif serait « coopératif, de même nature que notre `working_files` ».
**Ce n'est pas le même objet : il n'y a aucun verrou de fichier.**

Recherche exhaustive du client livré :

```
ownedFiles      0
fileOwnership   0
claimFile       0
```

**Aucune notion de propriété de fichier source.** Ce qui existe est un lockfile de la famille
`proper-lockfile` posé sur `~/.claude/tasks/<team>/<id>.json`, qui sérialise la mutation du champ
`owner` **du registre de tâches** — et rien d'autre. Deux teammates qui écrivent le même fichier
source s'écrasent exactement comme aujourd'hui.

> **K2 ne se déclenche pas, et l'inverse est vrai : `working_files` n'a pas de concurrent.** La phrase
> à écrire dans la fiche est « le file locking d'Agent Teams verrouille le **registre de tâches**, pas
> les fichiers de travail ; Anthropic n'a aucune notion de propriété de fichier ».

#### B. K5 se déclenche : opt-in local **plus** interrupteur distant

Le gate réel, lu dans le client :

```js
if (!CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS && !process.argv.includes("--agent-teams")) return false;
if (!rt("tengu_amber_flint", true)) return false;
return true;
```

Deux choses que la fiche ignore : un second chemin d'activation **`--agent-teams`**, non documenté par
elle ; et un **kill switch distant** `tengu_amber_flint`. Sa polarité est l'inverse de celle de `D01` —
défaut `true`, donc **Anthropic peut éteindre la feature sans livrer de release**.

C'est le quatrième flag distant rencontré dans ce corpus, après `tengu_harbor`,
`tengu_harbor_permissions` et `tengu_amber_sentinel`.

#### C. Cohérent avec l'acquis de `C02`

`C02` avait mesuré que `TaskCreated` et `TaskCompleted` tirent **sans** le flag Agent Teams. Le gate
ci-dessus l'explique : il ne conditionne que le spawn de teammates et le mode équipe — **les outils de
tâche sont généraux**. Les deux mesures concordent.

#### D. K6 se déclenche

Recherche des issues sur `teams`, `orchestration`, `coordination` : **aucune demande**. Les deux
résultats sur `teams` sont sans rapport (Discord, Postgres).

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Construire sur de l'`experimental`.** La feature est désactivée par défaut derrière un flag `CLAUDE_CODE_EXPERIMENTAL_*`, `TeamCreate`/`TeamDelete` ont déjà été supprimés, le `team_name` des payloads est déjà déprécié, le défaut de `teammateMode` a déjà changé (v2.1.179). Une intégration livrée aujourd'hui sera à réécrire ; pire, elle peut casser silencieusement chez l'utilisateur et laisser croire à une protection inexistante.
- **La base d'utilisateurs qui active ce flag est probablement proche de zéro.** Passer en L pour couvrir un mode expérimental que personne n'a activé est l'exemple type d'effort disproportionné. Le même budget mis sur `PreToolUse` (fiche C02) protège **tous** les utilisateurs Claude Code, teams ou pas.
- **Redondance avec C02.** Un `PreToolUse` sur `Write|Edit|MultiEdit` bloque déjà l'écriture conflictuelle, y compris celle d'un teammate — sans rien savoir d'Agent Teams. Si le garde-fou générique suffit, l'intégration spécifique aux hooks Task* n'apporte que de la visibilité, pas de la protection. À vérifier avant d'investir.
- **Portabilité.** Tout ce chantier est 100 % Claude Code. Le repo a déjà une sous-commande spécifique (`cli/channel.ts`) ; en ajouter une seconde ancre un serveur MCP censé être client-agnostique sur un seul client, et crée un troisième chemin de coordination (MCP déclaratif, MQTT, hooks) à maintenir en parallèle.
- **Deux task lists.** Si on garde `/api/claim-task` **et** qu'on se branche sur la task list d'Anthropic, deux verrous non coordonnés cohabitent : un `UPDATE … WHERE claimed_by IS NULL` en SQLite d'un côté, un file lock dans `~/.claude/tasks/` de l'autre. Les faire converger est du travail invisible pour l'utilisateur mais réel pour le mainteneur. Les abandonner casse le dispatch dirigé (`assigned_to`) et le poisoning, qui n'ont pas d'équivalent chez Anthropic.
- **Mode d'échec asymétrique.** Un faux positif de `ConflictDetector` était jusqu'ici un avertissement ignorable ; branché sur `TaskCreated` en exit 2, il annule une tâche. Le détecteur (module overlap + hot files sur fenêtre de 60 min, `src/conflict-detector.ts:115`) n'a jamais été évalué sous ce régime de responsabilité.
- **Complexité pour l'auto-hébergeur.** `cli/init.ts` devrait écrire dans `.claude/settings.json` — fichier partagé, versionné, souvent déjà rempli — plus un bloc `env` portant un flag expérimental. Merge, désinstallation symétrique (`cli/uninstall.ts`) et diagnostic (`cli/doctor.ts`) sont autant de surfaces nouvelles pour un mainteneur solo.
- **Le vrai différenciateur n'est peut-être pas là.** Agent Teams ne va jamais au-delà d'une session Claude Code ; le cross-outil (Cursor, Cline, Aider) et le cross-humain restent hors de portée d'Anthropic par construction. Investir dans l'intégration Agent Teams, c'est jouer sur le terrain de l'adversaire au lieu de creuser l'écart là où il ne peut pas suivre.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | **Réponse : frontière assumée** — garder le claim maison, ne brancher aucun hook. ⬜ contre-mesure technique · ⬜ recadrage · ✅ **recouvrement inexistant, frontière confirmée** |
| **Date** | 2026-08-16 |
| **Justification** | **Le recouvrement que la fiche redoutait n'existe pas.** Agent Teams n'a **aucune** notion de propriété de fichier (`ownedFiles`, `fileOwnership`, `claimFile` → 0 occurrence) : son lockfile ne protège que le JSON du registre de tâches. Notre `working_files` n'a donc **pas de concurrent**. S'y ajoutent K5 (opt-in local **et** kill switch distant `tengu_amber_flint`, défaut `true` — Anthropic peut éteindre sans release) et K6 (zéro demande). |
| **Issue / PR** | aucune |
| **Jalon visé** | aucun |

### La frontière factuelle

**Ce que le natif fait** : une task list partagée par équipe, avec un `owner` par tâche sérialisé par
un lockfile, et une mailbox entre teammates.

**Ce que le natif ne fait pas** : **il ne verrouille aucun fichier source.** Deux teammates qui
écrivent le même fichier s'écrasent. Il n'a ni org, ni multi-machine, ni chaîne d'audit.

**Ce qui reste défendable** : tout ce que la fiche craignait de perdre. Le claim maison
(`/api/claim-task`, `assigned_to`) et surtout `working_files` **n'ont pas d'équivalent natif**.

### Ce qui est refusé

**La branche « couche anti-collision branchée en hooks sur la task list d'Agent Teams »** de §6.1.
Elle brancherait notre mécanisme sur une surface `experimental`, doublement gatée, dont l'interrupteur
distant est chez Anthropic — pour remplacer un verrou qui n'existe pas.

### Ce qui est confirmé et devient décisif

Le contre-argument de §6.5 sur la **redondance avec `C02`** : puisqu'il n'existe **aucun** verrou de
fichier natif, un hook `PreToolUse` générique est la seule protection possible — équipe ou pas. C'est
le bon chemin s'il en faut un, et il est indépendant d'Agent Teams.

### Correction obligatoire

**§6.2, mon hypothèse n°2 est fausse par catégorie** et doit être corrigée avant toute réutilisation :
je pariais sur un verrou « de même nature que `working_files` ». Ce n'est pas le même objet — l'un
verrouille un enregistrement de tâche, l'autre revendique un chemin de fichier. Comparer les deux
était une erreur de catégorie, pas une erreur de degré.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : flags `cli/init.ts` corrigés, payloads de hooks ajoutés, reste confirmé doc et repo. |
| 2026-08-16 | **Challenge (groupé avec `D01`) — réponse : frontière assumée.** **Le recouvrement redouté n'existe pas** : Agent Teams n'a **aucune** notion de propriété de fichier (`ownedFiles` / `fileOwnership` / `claimFile` → 0 occurrence dans le client livré). Son lockfile ne sérialise que le champ `owner` du JSON de registre de tâches ; deux teammates qui écrivent le même fichier source s'écrasent. **`working_files` n'a donc pas de concurrent.** **Mon hypothèse §6.2-2 était fausse par catégorie** — je pariais sur un verrou « de même nature », ce n'est pas le même objet. K5 déclenché : opt-in local (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` **ou `--agent-teams`**, non documenté par la fiche) **plus** kill switch distant `tengu_amber_flint` (défaut `true`) — quatrième flag distant du corpus. K6 déclenché : zéro demande. Cohérent avec `C02` : le gate ne conditionne que le spawn de teammates, les outils de tâche sont généraux. Refusé : brancher des hooks sur la task list. Confirmé et devenu décisif : un `PreToolUse` générique est la seule protection possible, équipe ou pas. |
