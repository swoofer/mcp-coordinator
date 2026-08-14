# D05 — MENACE : agent view, le dashboard natif dans le terminal

| Champ | Valeur |
|---|---|
| **ID** | `threat-agent-view` |
| **Surface** | claude-code |
| **Statut** | research-preview |
| **Disponible depuis** | lancée v2.1.139 (~11 mai 2026, source tierce) ; version history de la doc jusqu'à v2.1.227 ; CHANGELOG amont v2.1.232 |
| **Tier** | T2-fort-levier |
| **Nature** | threat |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — Claude Code 2.1.219 installé, daemon présent, tout est local |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**
- §1 — les groupes d'état affichés par agent view sont **Pinned / Ready for review / Needs input / Working / Completed**. `Idle` est un *état de session* (icône atténuée), pas un groupe : retiré de la liste des groupes.
- §2 — le schéma JSON de `claude agents --json` **est documenté** ; le marqueur `(à vérifier)` est levé et le schéma reporté dans la fiche (`id`, `sessionId`, `state`, `status`, `waitingFor`, `pid`, `cwd`, `kind`, `name`, `startedAt`).
- §2 — ajout de l'alias documenté `claude kill` pour `claude stop <id>`, et des chemins `~/.claude/daemon.lock` et `~/.claude/jobs/<id>/tmp/`.
- §2 — la mention « `/agents` n'ouvre plus de panneau depuis v2.1.198 » n'est pas confirmable : la v2.1.198 n'apparaît nulle part dans `agent-view.md`. Requalifiée `(non vérifiable — non documenté)`.
- §2 — `/subtask` : la doc le décrit comme « v2.1.211 or earlier with agent view off », pas comme « devient /fork ». Formulation alignée sur la doc.
- Vérifications sans correction : `ANTHROPIC_DEFAULT_HAIKU_MODEL` (bon préfixe, confirmé verbatim), `CLAUDE_CODE_DISABLE_AGENT_VIEW`, `CLAUDE_JOB_DIR`, `CLAUDE_CONFIG_DIR`, `CLAUDE_DISABLE_ADOPT`, `CLAUDE_CODE_DISABLE_BG_EXIT_HANDOFF`, `FORCE_HYPERLINK=0`, `disableAgentView`, `leftArrowOpensAgents`, `worktree.bgIsolation`, statut **research preview** (toujours affiché tel quel), CHANGELOG amont bien à **v2.1.232**.
- §5 — les 14 fichiers cités existent tous. Numéros de ligne revérifiés : `src/serve-http.ts` l. 583-600 (`/dashboard`) ✅, l. 732 (`/api/events`) ✅, `cli/channel.ts` l. 343 (`post_to_thread`) ✅. `dashboard.js` fait 49 079 octets (~48 Ko) ✅. `coordinator_status` renvoie bien `agents_online`, `agents[]`, `open_threads`, `resolving_threads`, `hot_files`, `mqtt_connected` (`src/tools/status-tools.ts` l. 44-60) ✅. Les blocs `agents-list`, `hot-files`, `timeline`, `threads-list`, `metrics`, `token-total`, `quota-widget`, `conflict-signals` sont tous présents dans `index.html` ✅. `MAX_SSE_CLIENTS` / `COORDINATOR_MAX_SSE_CLIENTS` ✅, `getHotFiles()` est dans `src/file-tracker.ts` (l. 43) et non dans `working-files-tracker.ts` — la ligne du tableau reste juste telle qu'elle est écrite. Aucune ligne retirée.

**Marqueurs `(à vérifier)` restants :** aucun. Un `(non vérifiable — non documenté)` subsiste en §2 sur la v2.1.198.

**Testabilité :** ✅ testable
Claude Code **2.1.219** est installé sur ce poste (agent view lancée en 2.1.139) et `~/.claude/daemon/` existe déjà. Tout le protocole §6.3 s'exécute en local sans credentials API ni header beta : `claude --bg`, `claude agents`, `claude agents --json [--all]`, dashboard maison via `mcp-coordinator dashboard`, et `coordinator_status` sur l'instance locale du daemon.

## 1. Ce que c'est

`claude agents` ouvre un écran unique dans le terminal qui liste toutes les sessions Claude Code lancées en arrière-plan sur la machine. Les sessions sont groupées par état — **Pinned / Ready for review / Needs input / Working / Completed** (`Idle` est un état de session, pas un groupe) — et l'écran permet de dispatcher une nouvelle session, de *peek* sans s'attacher, de s'attacher, renommer, épingler, stopper. Un daemon superviseur maintient les process vivants et survit au redémarrage du CLI (`claude daemon status`), avec un état persisté sous `~/.claude/daemon/roster.json` et `~/.claude/jobs/<id>/state.json`.

Les sessions background travaillent dans un worktree isolé, commitent et poussent automatiquement leur travail, suivent le `CLAUDE.md` du repo, et ouvrent une draft PR quand la tâche s'y prête. La doc pose des garde-fous : jamais de push sur `main`/`master`, jamais de force-push, jamais de merge, et « your git instructions take precedence » — donc un `CLAUDE.md` peut désactiver le comportement. La feature est **research preview**, pas GA, et corrigée en continu (v2.1.200 handover du daemon, v2.1.205 affichage de statut, v2.1.213 `/fork`, v2.1.222 commit/push/CLAUDE.md).

Deux points aggravent la menace au-delà du terminal : la doc renvoie vers une vue desktop de toutes les sessions (`/docs/en/desktop#work-in-parallel-with-sessions`), et le cross-session messaging permet déjà de lister et de messager les sessions Claude sur cette machine, sur une autre machine et sur Claude Code on the web. Enfin, `claude agents --json` expose l'état complet de façon scriptable — c'est aussi une source d'ingestion gratuite, pas seulement un concurrent.

## 2. Surface d'API exacte

```
# CLI
claude agents [--cwd <dir>] [--json] [--json --all] [--model] [--permission-mode]
              [--effort] [--agent <name>] [--settings <file>] [--add-dir]
claude --bg "<task>" [--name] [--model] [--exec '<cmd>']
claude attach <id> | claude logs <id> | claude stop <id>   (alias : claude kill <id>)
claude respawn <id> | claude respawn --all | claude rm <id>
claude daemon status | claude daemon stop --any [--keep-workers]

# In-session
/bg  (alias /background)     /bg "<next task>"
/fork        (copie la conversation courante dans une session background ; v2.1.213)
/subtask     (subagent forké — doc : « v2.1.211 or earlier with agent view off »)
/model  /resume (ou /continue ; picker agent view, v2.1.212+)
# /tasks : doc = « Run /tasks to see everything that's running » (session courante).
# /agents (≠ `claude agents`) affiche la liste des subagents.
#   « n'ouvre plus de panneau depuis v2.1.198 » : (non vérifiable — la v2.1.198
#   n'est mentionnée nulle part dans agent-view.md).

# Variables d'environnement
CLAUDE_CODE_DISABLE_AGENT_VIEW   CLAUDE_JOB_DIR   CLAUDE_CONFIG_DIR
CLAUDE_DISABLE_ADOPT=1           CLAUDE_CODE_DISABLE_BG_EXIT_HANDOFF
ANTHROPIC_DEFAULT_HAIKU_MODEL    FORCE_HYPERLINK=0

# Settings
disableAgentView   leftArrowOpensAgents   worktree.bgIsolation  (ex. "none")

# État sur disque
~/.claude/daemon.log
~/.claude/daemon.lock
~/.claude/daemon/roster.json
~/.claude/jobs/<id>/state.json
~/.claude/jobs/<id>/tmp/
```

Le **schéma du JSON** rendu par `claude agents --json` est documenté dans `agent-view.md` (marqueur *(à vérifier)* levé le 2026-08-14) — un tableau d'objets :

```json
[
  {
    "cwd": "/path/to/project",
    "kind": "background|interactive",
    "startedAt": 1234567890000,
    "id": "short-id",
    "state": "working|blocked|done|failed|stopped",
    "pid": 12345,
    "status": "running|waiting",
    "waitingFor": "permission prompt|input needed|sandbox request|worker request|dialog open",
    "sessionId": "full-uuid",
    "name": "session-name"
  }
]
```

L'`id` court est bien celui consommé par `attach`/`logs`/`stop`. La feature restant en research preview, ce schéma n'est pas un contrat stable : à reconfirmer par exécution réelle avant tout ingesteur.

Point de vocabulaire relevé par le vérificateur : la formule « Local only: sessions run on your machine » n'est **pas** littérale. La doc dit « Sessions are local: background sessions run on your machine. They are preserved across sleep but stop if the machine shuts down. » L'argument tient, la citation non.

## 3. Sources

- https://code.claude.com/docs/en/agent-view.md
- https://code.claude.com/docs/en/agents.md
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
Le bénéfice n'est pas d'adopter agent view mais de **recadrer le dashboard maison**. Aujourd'hui `dashboard/public/index.html` expose `agents-list`, `hot-files`, `timeline`, `threads-list`, `conflict-signals`, `metrics`, `token-total`, `quota-widget`. Les blocs `agents-list` et `timeline` — « qui tourne, dans quel état » — sont exactement ce que `claude agents` fait mieux, gratuitement, sans serveur, sans port, sans auth. Les blocs `hot-files`, `conflict-signals` et `threads-list` sont ce qu'agent view ne fait pas et ne fera pas : la vue **repo** (qui touche quel fichier, quel conflit se prépare, quelle consultation est ouverte) au lieu de la vue **process**. Recentrer le dashboard sur ces trois blocs supprimerait du code de rendu de statut dans `dashboard/public/dashboard.js` et donnerait une raison d'exister claire au serveur.
Deuxième bénéfice, opportuniste : `claude agents --json` est une source d'ingestion d'états de sessions locales qu'on obtient sans écrire d'agent-side reporting — une passerelle possible vers `src/agent-registry.ts`.

**Risque si on ne fait rien :**
Le dashboard devient un doublon dégradé d'un écran natif déjà installé chez l'utilisateur. Un mainteneur solo qui a le choix entre `claude agents` (zéro config) et `mcp-coordinator server start` + navigateur + port + auth choisira le premier, et l'ensemble de la valeur de mcp-coordinator sera jugé sur un composant où il perd. Trois axes différenciants restent solides, mais l'un des trois s'érode :
- **Multi-vendeur** — solide. La doc est explicite : « In every approach the workers are Claude sessions ». Cursor, Cline, Aider n'apparaîtront jamais dans `claude agents`.
- **Vue repo plutôt que vue process** — solide. Agent view ne connaît pas les fichiers chauds ni les conflits inter-agents.
- **Multi-utilisateur / non-local** — **en érosion**. Le cross-session messaging couvre déjà d'autres machines et Claude Code on the web ; la vue desktop couvre déjà « toutes mes sessions ». L'argument « nous, on est multi-poste » ne suffit plus seul.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `dashboard/public/index.html` | Blocs `agents-list` et `timeline` en concurrence frontale avec agent view ; `hot-files`, `conflict-signals`, `threads-list`, `token-total` sont le différenciant à mettre en avant. Cible d'un recentrage. |
| `dashboard/public/dashboard.js` | 48 Ko de rendu ; c'est ici que disparaîtrait le code de statut de session si on cède ce terrain. |
| `cli/dashboard.ts` | Ouvre `http://localhost:<port>/dashboard` via `loadConfig().server.port`. Point de comparaison UX direct avec `claude agents` (une commande, zéro serveur). |
| `src/serve-http.ts` | Sert `/dashboard` et `/dashboard/*` (l. 583-600) et l'endpoint SSE `/api/events` (l. 732). Toute la chaîne de push du dashboard passe par là. |
| `src/sse-emitter.ts` | Diffusion d'événements aux clients dashboard, plafonnée par `MAX_SSE_CLIENTS` / `COORDINATOR_MAX_SSE_CLIENTS`. Inchangé si on recentre ; à revoir si on ingère `claude agents --json`. |
| `src/tools/status-tools.ts` | `coordinator_status` renvoie `agents_online`, `agents[]`, `open_threads`, `resolving_threads`, `hot_files`, `mqtt_connected` — c'est le même contrat que le panneau statut d'agent view, côté multi-vendeur et org-scopé. |
| `src/agent-registry.ts` + `src/agent-activity.ts` | `listOnline()` et le heartbeat (`currentFile`, `currentThread`) sont la source du bloc « qui tourne ». Point d'entrée naturel si on ingérait `claude agents --json`. |
| `src/file-tracker.ts` · `src/working-files-tracker.ts` · `src/conflict-detector.ts` | Le différenciant réel : `getHotFiles()` et la détection de conflit n'ont aucun équivalent dans agent view. |
| `cli/channel.ts` | Serveur MCP stdio des Channels (`post_to_thread`, l. 343). Une session background lancée par `--bg` n'est pas enregistrée auprès du coordinateur : trou de couverture à documenter. |
| `cli/doctor.ts` | Endroit logique pour détecter la présence de `claude agents` / du daemon et avertir sur le doublon, plutôt que de l'ignorer. |
| `sdk/src/client.ts` | Le SDK ne couvre aujourd'hui que l'auth (`whoami`, `refresh`, `deviceCode*`). Aucun accès aux états d'agents : rien à casser côté SDK. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le dashboard de mcp-coordinator abandonne-t-il le panneau « qui tourne / dans quel état » à `claude agents` pour se recentrer sur la vue repo (fichiers chauds, conflits, threads), ou garde-t-il la vue process en l'alimentant par ingestion de `claude agents --json` aux côtés des agents non-Claude ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille — non exécutée.>

- [ ] Lancer `claude --bg "<tâche triviale>"` puis `claude agents` sur ce repo, et capturer l'écran : quels états sont réellement affichés, quelle latence de rafraîchissement.
- [ ] Exécuter `claude agents --json` et `claude agents --json --all`, coller la sortie brute et relever le schéma exact (noms de champs, valeurs d'état, identifiant de session) — l'inconnue signalée en §2.
- [ ] Ouvrir le dashboard maison en parallèle (`mcp-coordinator dashboard`) et lister, bloc par bloc, ce qu'agent view couvre déjà et ce qu'il ne couvre pas.
- [ ] Vérifier qu'une session lancée par `claude --bg` n'apparaît PAS dans `coordinator_status` (`agents_online`), pour mesurer le trou de couverture réel.
- [ ] Tester `CLAUDE_CODE_DISABLE_AGENT_VIEW` / `disableAgentView` : la feature est-elle désactivable proprement chez un utilisateur qui préfère notre vue.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **C'est une research preview, pas une GA.** Construire une ingestion de `claude agents --json` revient à dépendre d'un format non stabilisé, corrigé à chaque patch (v2.1.200 → v2.1.232 en quelques semaines). Le coût de maintenance retomberait entièrement sur un mainteneur solo.
- **Ça casse la portabilité.** Toute lecture de `~/.claude/daemon/roster.json` ou de `claude agents --json` couple mcp-coordinator à Claude Code, alors que l'argument multi-vendeur (Cursor/Cline/Aider) est justement le différenciant le plus solide. On affaiblirait le seul axe qu'aucune évolution d'Anthropic ne menace.
- **Ingestion locale seulement.** Le daemon et le roster vivent sur la machine de l'utilisateur. Un coordinateur déployé sur un serveur (le cas Phase 2 : `src/auth/`, `src/admin/`, `src/quota/`) n'aurait accès à aucun de ces fichiers. La feature ne se déploie pas là où mcp-coordinator est censé tourner.
- **YAGNI sur la réaction.** Personne n'a signalé que le dashboard fait doublon. Réécrire `dashboard.js` par anticipation d'une menace concurrentielle est un chantier de type M-L sans demande utilisateur derrière.
- **La menace peut être surestimée.** Agent view suppose que l'utilisateur lance ses agents *par* Claude Code en background. Le cas d'usage principal de mcp-coordinator — plusieurs sessions interactives ouvertes dans plusieurs terminaux, éventuellement par plusieurs personnes — n'est pas ce que `claude agents` couvre.
- **Contradiction non tranchée dans le bundle.** La fiche brute présente le multi-utilisateur / non-local comme un axe différenciant solide ; le vérificateur montre que le cross-session messaging et la vue desktop l'entament déjà. La fiche retient la lecture du vérificateur, mais l'ampleur réelle de l'érosion n'a pas été mesurée.

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
| 2026-08-14 | Vérification des faits : schéma `--json` documenté, groupes d'état corrigés, §5 revérifié, fiche testable localement. |
