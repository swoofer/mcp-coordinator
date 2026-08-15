# D03 — MENACE : worktrees natifs, le conflit d'écriture disparaît-il ?

| Champ | Valeur |
|---|---|
| **ID** | `threat-native-worktrees` |
| **Surface** | claude-code |
| **Statut** | GA (aucun marqueur beta/preview sur les worktrees eux-mêmes ; la surface `agent view` qui les pilote automatiquement est, elle, « research preview ») |
| **Disponible depuis** | v2.1.49 (`--worktree`/`-w`, `isolation: worktree`) ; hooks `WorktreeCreate`/`WorktreeRemove` en v2.1.50 ; correctifs worktree jusqu'à v2.1.222 (amont courant 2.1.232) |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — PoC local complet, Claude Code 2.1.219 installé |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — contre-mesure technique, voir §7 |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **§2 / §4 — input du hook `WorktreeCreate` : faux.** La fiche affirmait `worktree_path` + `base_ref` dans l'input. La doc (hooks.md, section « WorktreeCreate input ») donne, en plus des champs communs `session_id` / `transcript_path` / `cwd` / `hook_event_name`, **un seul champ propre : `name`** (slug du worktree, ex. `bold-oak-a3f2`). Le hook ne *reçoit* pas le chemin, il le **retourne** (dernière ligne non vide de stdout pour `type: "command"`, `hookSpecificOutput.worktreePath` pour `type: "http"`). Seul `WorktreeRemove` reçoit `worktree_path`. Corrigé dans §2 et dans §4 (« il porte déjà session_id + worktree_path + base_ref »).
- **§2 — `hookSpecificOutput.worktreePath` n'existe que pour `WorktreeCreate`.** `WorktreeRemove` n'a aucun contrôle de décision et sa sortie JSON est jetée. Corrigé.
- **§2 — `EnterWorktree` a deux paramètres, pas un.** `name` (nouveau worktree) et `path` (worktree existant), mutuellement exclusifs, les deux optionnels. La fiche ne citait que `path`. Corrigé (schéma du tool vérifié directement).
- **§2 nuance 3 — périmée.** `worktree.baseRef` et `worktree.bgIsolation` **figurent aujourd'hui dans settings.md** (section « Worktree settings », avec aussi `worktree.symlinkDirectories` et `worktree.sparsePaths`). Les deux issues docs amont sont **closes** (#57148 le 2026-05-12, #59580 le 2026-06-01). Corrigé en §2 ; le contre-argument correspondant en §6.5 repose sur ce fait périmé mais n'a pas été touché (section verrouillée) — à prendre en compte au challenge.
- **§2 — `worktree.symlinkDirectories` ajouté** (setting worktree documenté que la fiche omettait).
- **§5 — numéros de ligne de `src/conflict-detector.ts` faux de ~3 lignes.** `module_overlap` est l.51 (pas 48), `file_overlap` l.64 (pas 61), `dependency_chain` l.80-102 (pas 74-111), bloc « hot file » l.114-134 (pas 115 tout court). Corrigés.
- **§5 — `heartbeat` dans `src/tools/agents-tools.ts` est l.68** (pas 67). Corrigé.

**Vérifiés et exacts (non modifiés) :** `--worktree`/`-w` et `isolation: worktree` en v2.1.49, hooks `WorktreeCreate`/`WorktreeRemove` en v2.1.50, amont courant 2.1.232 (CHANGELOG) ; chemin `.claude/worktrees/<nom>/`, branche `worktree-<nom>`, `pr-<number>` pour `#1234` ; les quatre verrous et le fait que seul le contrôle du working directory s'applique à PowerShell ; `cleanupPeriodDays` (défaut 30, min 1) et ses exclusions ; `.worktreeinclude` non traité si un hook `WorktreeCreate` est configuré ; `ExitWorktree(action, discard_changes)` ; `workspace.git_worktree` (statusline.md) ; `/batch` comme skill bundled ; le statut `research preview` d'agent view. Issue amont #36205 (« EnterWorktree tool ignores WorktreeCreate/WorktreeRemove hooks ») est bien **OPEN** — la contradiction avec la doc tient. Tous les fichiers cités en §5 existent, et les autres numéros de ligne (path-normalize l.19, rest-handlers 831/874/898, working-files-tracker l.117/126, file-tracker l.128-135, agent-registry l.33, git-cochange l.66/187/190, start.ts 98/168-169/201, README:44, docs/index.html 2092 et 3127-3128) pointent bien sur ce que la fiche prétend. Les 6 worktrees natifs sous `.claude/worktrees/` sont bien présents. `git log` sans `--all` : confirmé (0 occurrence). Aucun scaffolding de hooks dans `cli/init.ts` / `cli/doctor.ts` : confirmé.

**Marqueurs `(à vérifier)` restants :** 1.
- §2 contradiction 2 : la date exacte à laquelle `EnterWorktree` a accepté un `path` existant reste **non vérifiable** — la doc ne date que le cas multi-repo (v2.1.203) et l'ajout du prompt d'approbation hors `.claude/worktrees/` (v2.1.206), jamais l'acceptation d'un path existant elle-même. Marqueur remplacé par cette mention.
- §2 contradiction 4 (`(à vérifier au PoC)`) : conservé volontairement — c'est un point de protocole, pas un fait documentaire ; l'issue #36205 est confirmée ouverte.

**Testabilité :** ✅ testable
Les cinq points du protocole §6.3 sont exécutables ici : Claude Code 2.1.219 et Node v22.21.0 sont installés, le dépôt contient déjà six worktrees natifs, et toute la surface worktree est GA (aucun header beta, aucune allowlist d'org, aucun credential API requis). Concrètement : lancer `claude --worktree a` et `claude --worktree b`, faire éditer `src/types.ts` des deux côtés avec le daemon local en écoute, et lire ce qui arrive sur `POST /api/working-files/start`. Seule réserve mineure : les scénarios qui passent par les sessions background d'`agent view` (research preview) et le skill `/batch` sont hors du protocole écrit — s'ils y entraient, ils resteraient testables mais sur une surface instable.

## 1. Ce que c'est

Claude Code crée et gère lui-même des git worktrees isolés : `claude --worktree <nom>` produit `.claude/worktrees/<nom>/` sur une branche `worktree-<nom>`. En cours de session, les outils built-in `EnterWorktree` / `ExitWorktree` permettent de basculer ; un subagent peut être épinglé en permanence par le frontmatter `isolation: worktree` ; les sessions d'arrière-plan d'`agent view` sont isolées automatiquement. Au-delà du flag, Claude Code applique **quatre verrous d'isolation** côté outils : blocage des `Edit`/`Write`/`NotebookEdit` visant le main checkout, blocage du working directory d'une commande qui résout vers le main checkout, blocage des redirections git (`git -C`, `--git-dir`, `GIT_DIR`, `GIT_WORK_TREE`, `cd` préalable), et refus de toute commande shell non traçable statiquement (brace expansion, heredocs à délimiteur non quoté) — ce quatrième contrôle n'est **pas désactivable**. La doc officielle cadre explicitement la feature comme la réponse d'Anthropic aux collisions d'écriture entre sessions parallèles : « Worktrees give each session a separate git checkout, so parallel sessions never edit the same files » (agents.md). Les hooks `WorktreeCreate` (exit non-zero avorte la création) et `WorktreeRemove` (exit code ignoré, suppression inconditionnelle) permettent de remplacer intégralement la logique git — c'est le point d'accroche pour un système tiers.

La menace est structurelle : le produit vend « les conflits sont détectés **avant** qu'une ligne soit écrite » (`README.md:44`, `docs/index.html:2092`), et `--worktree` répond « il n'y a plus rien à détecter, chacun a son checkout ». Ce qui reste intact : les worktrees **ne résolvent rien au merge**. Anthropic ne promet nulle part de résolution de conflit sémantique, et concède que les **agent teams n'isolent pas** les teammates (agent-teams.md#avoid-file-conflicts : « partition the work so each teammate owns a different set of files ») — ce partitionnement est aujourd'hui laissé à l'humain.

## 2. Surface d'API exacte

```
# CLI
claude --worktree <nom>            # alias -w ; accepte aussi "#1234" ou une URL de PR GitHub
                                   #   -> .claude/worktrees/pr-<number>
# chemin par défaut : .claude/worktrees/<nom>/   branche : worktree-<nom>
# nom auto-généré si omis (forme "bright-running-fox")

# Outils built-in
EnterWorktree      # deux paramètres, tous deux optionnels et MUTUELLEMENT EXCLUSIFS :
                   #   `name` (nouveau worktree, nom auto-généré si absent)
                   #   `path` (bascule vers un worktree existant, doit figurer dans
                   #          `git worktree list` du dépôt)
                   #   sans path = création + bascule ; avec path = bascule seule.
                   #   Depuis un worktree ou un subagent à cwd épinglé, SEULE la forme
                   #   avec `path` est disponible, et la cible doit être sous
                   #   .claude/worktrees/ du dépôt de la session.
                   #   Hors .claude/worktrees/ : approbation obligatoire, non supprimable
                   #   par permission rule ni « don't ask again » — seul bypassPermissions la saute.
ExitWorktree       # action: "keep" | "remove", discard_changes: true

# Settings
worktree.baseRef            # "fresh" (défaut) | "head"
worktree.bgIsolation        # "worktree" (défaut) | "none" pour désactiver l'isolation
                            #   des sessions background — requiert v2.1.143+
worktree.sparsePaths        # sparse-checkout en monorepo
worktree.symlinkDirectories # ex. ["node_modules", ".cache"] — aucun par défaut
cleanupPeriodDays       # défaut 30, min 1 — sweep des worktrees de SUBAGENTS et de sessions
                        #   background uniquement ; ne touche jamais un worktree --worktree
                        #   ni un worktree contenant du travail non commité/non poussé

# Fichiers
.worktreeinclude   # syntaxe .gitignore ; copie les fichiers GITIGNORÉS (.env, …)
                   # NON traité si un hook WorktreeCreate est configuré (le hook remplace tout)

# Frontmatter subagent
isolation: worktree     # worktrees éphémères, slug `agent-a<hex>`

# Hooks
WorktreeCreate   # input: champs communs (session_id, transcript_path, cwd,
                 #   hook_event_name) + `name` = slug du worktree (ex. "bold-oak-a3f2").
                 #   ATTENTION : le hook NE REÇOIT PAS le chemin, il le RETOURNE —
                 #     type "command" : dernière ligne non vide de stdout
                 #     type "http"    : hookSpecificOutput.worktreePath (chemin absolu)
                 #   tout exit non-zero (ou aucun chemin retourné) AVORTE la création
WorktreeRemove   # input: champs communs + `worktree_path` (absolu) — exit code et
                 #   sortie JSON IGNORÉS, aucun contrôle de décision
CwdChanged (input: … previous_cwd), DirectoryAdded (input: … directory_path, added_via)
# les deux hooks worktree supportent type: "http" ; hookSpecificOutput.worktreePath
#   n'existe QUE pour WorktreeCreate

# Status line
workspace.git_worktree

# Skill
/batch           # découpe un gros changement en 5 à 30 subagents isolés par worktree,
                 # chacun ouvrant une PR
```

Nuances vérifiées, à ne pas gommer :

- Les quatre verrous ne sont **pas uniformes** : ils s'appliquent à `Bash` **et** `Monitor` ; pour **PowerShell, seul le contrôle du working directory s'applique**.
- Skips documentés de l'isolation background (agent-view.md) : déjà dans un worktree lié, répertoire non-git sans hook `WorktreeCreate`, écriture hors du working directory.
- ~~`worktree.baseRef` et `worktree.bgIsolation` ne figurent pas dans settings.md~~ — **corrigé le 2026-08-14** : settings.md a désormais une section « Worktree settings » listant `worktree.baseRef`, `worktree.symlinkDirectories`, `worktree.sparsePaths` et `worktree.bgIsolation`. Les deux issues docs amont sont closes (#57148 le 2026-05-12, #59580 le 2026-06-01). L'argument « surface documentaire mal découvrable » ne tient plus.

**Contradictions entre chercheurs, tranchées ou signalées :**

1. Deux fiches présentaient `path` d'`EnterWorktree` comme obligatoire ; le vérificateur tranche : **optionnel**, et sa présence/absence change la sémantique (bascule vs création).
2. Une fiche datait « `EnterWorktree` accepte un path existant depuis v2.1.203 ». **Faux** : v2.1.203 ne concerne que le cas multi-repo (worktree d'un dépôt imbriqué, auparavant rejeté). La date exacte de l'acceptation d'un `path` existant est *(non vérifiable — la doc ne date que le cas multi-repo en v2.1.203 et l'ajout du prompt d'approbation hors `.claude/worktrees/` en v2.1.206, jamais l'acceptation elle-même)*.
3. Statut : deux chercheurs disent GA sans réserve, le troisième normalise en `research-preview` — mais son propre texte réserve ce label à `agent view`, pas aux worktrees. Retenu : **worktrees GA, `agent view` research preview**.
4. Issue amont #36205 rapporte qu'`EnterWorktree` ignorerait les hooks `WorktreeCreate`/`WorktreeRemove`. La doc affirme l'inverse. Issue confirmée **OPEN** au 2026-08-14 (ouverte le 2026-03-19). **Non tranché** *(à vérifier au PoC)*.

## 3. Sources

- https://code.claude.com/docs/en/worktrees.md
- https://code.claude.com/docs/en/agent-view.md
- https://code.claude.com/docs/en/agents.md
- https://code.claude.com/docs/en/tools-reference.md
- https://code.claude.com/docs/en/agent-teams.md
- https://code.claude.com/docs/en/hooks.md
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

Le bénéfice n'est pas une feature à ajouter, c'est une **re-narration** appuyée par du code déjà écrit. Les worktrees suppriment le conflit d'écriture au niveau *inode* ; ils ne voient rien du conflit *sémantique* : l'agent A refactore une signature dans son worktree, l'agent B code contre l'ancienne dans le sien, les deux tests passent, le merge explose. Ce trou est exactement l'aire de `src/dependency-map.ts`, `src/impact-scorer.ts`, `src/tree-sitter-extractor.ts` et `src/git-cochange-builder.ts`. Anthropic elle-même documente que les agent teams exigent un partitionnement **manuel** des fichiers — c'est le partitionnement automatique que le coordinator peut fournir. Côté intégration concrète : le hook `WorktreeCreate` est le point d'enregistrement naturel d'un agent auprès de `AgentRegistry.register()`. Attention toutefois : son input ne porte que `session_id`, `transcript_path`, `cwd`, `hook_event_name` et `name` (le slug) — **pas le chemin du worktree**, que le hook doit au contraire *produire*. Un enregistrement portant le `worktree_path` doit donc soit le calculer lui-même (le hook remplace intégralement la logique git), soit passer par `WorktreeRemove` / la statusline (`workspace.git_worktree`) / une détection côté client.

**Risque si on ne fait rien :**

Trois risques distincts, du plus concret au plus stratégique.

1. **Le tracking décroche silencieusement.** `normalizePath(repoRoot, input)` (`src/path-normalize.ts:19`) rend un chemin relatif à `COORDINATOR_REPO_ROOT`. Un worktree vit sous `.claude/worktrees/<nom>/` : le même fichier logique devient `.claude/worktrees/a/src/types.ts` pour l'agent A et `.claude/worktrees/b/src/types.ts` pour l'agent B. `WorkingFilesTracker.getIndex()` matche par **égalité exacte de chaîne** (`file_path IN (…)`) et `ConflictDetector` idem (`src/conflict-detector.ts:61`) : **zéro chevauchement détecté**, alors que la collision sémantique est maximale. Pire, si le worktree est déplacé hors du repo root, `normalizePath` **throw** et les handlers REST renvoient un 400 (`src/http/rest-handlers.ts:836,879,903`) — la claim disparaît sans que l'agent ne le sache. Ce n'est pas théorique : ce dépôt contient déjà six worktrees natifs sous `.claude/worktrees/` (`agent-a75517e54a2ee66af`, `docs-i18n-v07-alignment`, …).
2. **Le module devient faux.** `FileTracker.fileToModule()` (`src/file-tracker.ts:128`) fait `split("/").slice(0,2)`. Tout fichier vu depuis un worktree s'agrège dans un module unique `.claude/worktrees` — le scoring d'impact et le `module_overlap` du conflict-detector reposent dessus.
3. **Le pitch se fait périmer.** `docs/index.html:3127-3128` répond encore « les worktrees isolent les systèmes de fichiers, mcp-coordinator coordonne l'intention ». La réponse est juste, mais elle est écrite comme une objection à `git worktree add` manuel, pas à `--worktree` intégré au produit. Un lecteur qui vient de lire worktrees.md n'y verra pas de différenciation.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/path-normalize.ts` (`normalizePath`, l.19-44) | Cœur du problème. Rend un chemin relatif à `repoRoot` ; un chemin de worktree garde son préfixe `.claude/worktrees/<nom>/`. Il faut une canonicalisation « worktree-relative » (retirer le préfixe worktree avant de normaliser) — ou décider explicitement de ne pas le faire. Throw si le worktree est hors `repoRoot`. |
| `src/http/rest-handlers.ts` (l.831, 874, 898) | `repoRoot = process.env.COORDINATOR_REPO_ROOT` lu **par requête**, une seule valeur globale pour tous les agents. Aucun moyen d'exprimer « cet agent est dans le worktree X ». Les trois endpoints file-activity / working-files start / stop convertissent tous par ce chemin. |
| `src/working-files-tracker.ts` (clé `(org_id, agent_id, file_path)`) | Clé purement textuelle. Deux worktrees = deux clés distinctes pour le même fichier logique. `getIndex()` (l.117) ne peut rien matcher. |
| `src/conflict-detector.ts` (l.64 `file_overlap`, l.114-134 hot files) | Détection par intersection de tableaux de chaînes. Devient inopérante dès que les agents rapportent des chemins préfixés par leur worktree. Les branches `module_overlap` (l.51) et `dependency_chain` (l.80-102) survivent, elles — c'est le noyau à mettre en avant. |
| `src/file-tracker.ts` (`fileToModule`, l.128-136) | `slice(0,2)` sur le chemin : tous les fichiers d'un worktree collapse sur le module `.claude/worktrees`. Casse le scoring d'impact en amont. |
| `src/agent-registry.ts` (`register`, l.33) | Table `agents` : `id, org_id, name, modules, status, registered_at, last_seen_at`. **Aucune colonne** `worktree_path` / `branch` / `base_ref`. Un hook `WorktreeCreate` n'aurait aujourd'hui nulle part où poser `worktree_path`. |
| `src/tools/agents-tools.ts` (`register_agent`, l.20-47) | Schéma zod = `agent_id`, `name`, `modules`. Pas de champ worktree/branche. `heartbeat` (l.68) accepte `current_file` mais rien sur le checkout. |
| `src/git-cochange-builder.ts` (l.66, l.180-190) | `git log … --name-only -z` **sans `--all`**, `cwd: this.repoRoot`. La Layer 4 ne voit que l'historique atteignable depuis HEAD du main checkout : le travail vivant sur les branches `worktree-*` est invisible jusqu'au merge. Note : `existsSync(repoRoot + "/.git")` (l.66) reste vrai dans un worktree (`.git` y est un fichier), donc la garde ne protège de rien. |
| `cli/channel.ts` | Le serveur MCP stdio des Channels **n'a aucune notion de cwd, de branche ou de worktree** (0 occurrence). C'est le composant le mieux placé pour détecter qu'il tourne dans `.claude/worktrees/` et le déclarer au coordinator. |
| `cli/server/start.ts` (l.98, l.169, l.201) | `--repo-root` / `COORDINATOR_REPO_ROOT` : une valeur unique, fixée au démarrage du daemon. C'est l'hypothèse « un serveur = un checkout » qu'il faudra assumer ou casser. |
| `cli/init.ts`, `cli/doctor.ts` | Aucun code de génération de hooks aujourd'hui (0 occurrence de `PreToolUse`/`hooks`). Si on veut brancher `WorktreeCreate`, c'est ici que la scaffolding devra naître, et `doctor` devra diagnostiquer « session dans un worktree, repoRoot pointe ailleurs ». |
| `README.md:44`, `docs/index.html` (l.2092, l.3127-3128 + traductions es/fr/de/ja/zh) | Le pitch « conflicts detected before a single line is written » et la FAQ « …git worktrees ? ». À re-narrer autour du **conflit sémantique inter-worktree**. Rappel : 6 langues inline, ~8 éditions par chaîne. |
| `src/dependency-map.ts`, `src/impact-scorer.ts`, `src/tree-sitter-extractor.ts` | Ce qui **survit** intact à la menace et devient l'argument principal. Aucune modification nécessaire, mais leur mise en avant est le vrai livrable de cette fiche. |

Point de vigilance opérationnel : le 4e verrou (« command shape ») refuse les heredocs à délimiteur non quoté et la brace expansion, et n'est pas désactivable. Tout hook ou collecteur qui shell-out avec un heredoc **cassera silencieusement dans un worktree**.

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Puisque `--worktree` supprime le conflit d'écriture au niveau fichier, faut-il faire du worktree une entité de première classe du modèle de données — colonne `worktree_path` sur `agents`, canonicalisation worktree-relative dans `normalizePath`, enregistrement via le hook `WorktreeCreate` — ou au contraire acter que `working_files` et `file_overlap` deviennent du bruit sous worktrees et recentrer le produit (et son pitch) exclusivement sur le conflit sémantique inter-worktree porté par `dependency-map` + `impact-scorer` + `tree-sitter-extractor` + `git-cochange` ?

### 6.2 Hypothèse

**Pré-enregistré le 2026-08-15, avant toute exécution.** Claude Code **2.1.219**, Node 22.21.0,
Windows 11. Fiche « menace » : le verdict portera sur la **réponse**, pas sur une adoption.

**Découverte de lecture, faite avant de poser les critères** (elle les oriente, donc elle est
déclarée) : les trois branches de `src/conflict-detector.ts` opèrent sur `params.target_modules` et
`params.target_files` — c'est-à-dire sur ce que l'agent **déclare** dans `announce_work`, jamais sur
ce qu'il fait. Aucune n'inspecte le disque. Le sort de la détection sous worktree ne dépend donc pas
de git : il dépend **du format de chemin que l'agent transmet**.

**Hypothèse.** La fiche suppose que les agents rapportent `.claude/worktrees/<nom>/src/types.ts`.
Or `normalizePath` (`src/path-normalize.ts:29`) ne retire le préfixe `repoRoot` que pour les chemins
**absolus** ; un chemin **relatif** traverse inchangé. Si un agent lancé dans un worktree déclare
`src/types.ts` — la forme naturelle, relative à son cwd — alors `file_overlap` **fonctionne
normalement entre worktrees**, et le risque n° 1 de §4 (« le tracking décroche silencieusement »)
est faux. Je m'attends à ce que ce soit le cas, et donc à ce que la menace soit **plus petite que
la fiche ne le dit sur le plan technique, et plus grande sur le plan narratif**.

**Critères de refus, posés avant de mesurer :**

| # | Ce qui tue quoi | Seuil |
|---|---|---|
| K1 | Si les agents en worktree déclarent des chemins **relatifs**, le risque n° 1 de §4 est **faux** et la canonicalisation worktree-relative de §6.1 est inutile — pire, elle serait nuisible. | observation directe de ce qui arrive au daemon |
| K2 | Si les agents déclarent des chemins **absolus** préfixés worktree, le risque n° 1 est confirmé et il faut une réponse technique. | idem |
| K3 | Si le noyau sémantique (`module_overlap`, `dependency_chain`) ne repose que sur des **déclarations** d'agent et jamais sur une observation du dépôt, alors la position de repli « nous tenons le conflit sémantique » est une promesse, pas une capacité — et le recadrage de la synthèse §3 doit le dire. | lecture + exécution |
| K4 | Si `git-cochange` ne voit pas les branches `worktree-*`, la Layer 4 est aveugle exactement là où la menace se joue. | `git log` sans `--all` → à confirmer par exécution |
| K5 | Si `--worktree` n'est **pas** le défaut d'une session interactive normale, la menace de la synthèse §3 (« deux agents ne travaillent plus jamais sur le même checkout ») est surestimée. | comportement observé |
| K6 | Si le hook `WorktreeCreate` ne peut pas porter `worktree_path` sans le recalculer lui-même, le coût de « enregistrement via hook » de §6.1 est sous-estimé. | doc + PoC hook |

**Verdict interdit d'avance :** si aucune des deux branches de §6.1 ne survit, le verdict doit le
dire au lieu d'en choisir une par défaut.

### 6.3 Protocole de vérification

Amendé le 2026-08-15. Ordre choisi pour que les tests les moins chers tranchent les critères les
plus lourds.

- [x] **T1 — Unitaire, déterministe.** `normalizePath` et `fileToModule` sur des chemins de worktree
      réels, en relatif **et** en absolu, plus le cas « worktree hors `repoRoot` ». Tranche K1/K2 sur
      le plan mécanique avant d'engager des sessions.
- [x] **T2 — Le vrai chemin.** Daemon lancé, deux worktrees natifs créés par Claude Code lui-même,
      deux sessions `claude` qui annoncent puis éditent le **même fichier logique**. Lire ce qui
      arrive réellement dans `working_files` et ce que renvoie `check_file_conflict`. Tranche
      K1/K2 pour de bon.
- [x] **T3 — Le noyau sémantique sous worktree.** Le scénario que le produit revendique : A change
      une signature exportée dans le worktree `a`, B consomme l'ancienne dans `b`. Mesurer si
      `dependency_chain` / `get_blast_radius` remontent quoi que ce soit, et **d'où** vient
      l'information. Tranche K3.
- [x] **T4 — `git-cochange` et les branches worktree.** Rejouer la commande exacte du builder et
      compter ce qu'elle voit du travail vivant sur `worktree-*`. Tranche K4.
- [x] **T5 — Le défaut.** Vérifier si une session interactive ordinaire crée un worktree. Tranche K5.
- [x] **T6 — Le hook.** `WorktreeCreate` minimal : vérifier le contrat d'entrée/sortie réel
      (le hook reçoit-il `name` seul ? doit-il retourner le chemin ?) et si un exit non-zéro avorte
      la création. Tranche K6. Le sous-point #36205 (`EnterWorktree` déclenche-t-il les hooks) est
      traité s'il reste du budget.

### 6.4 Résultat observé

Exécuté le 2026-08-15. Claude Code **2.1.219**, Node 22.21.0, Windows 11.
**Tout s'est passé dans un clone jetable** (`scratchpad/d03repo`) avec un daemon dédié
(`COORDINATOR_REPO_ROOT` = ce clone, base neuve) : le dépôt de travail n'a pas été touché.
Trois worktrees natifs ont été créés **par Claude Code lui-même** via `claude --worktree`.

---

**(A) T1 — unitaire, déterministe.** `normalizePath` + `fileToModule` sur des chemins de worktree :

```
cas                              normalizePath                            fileToModule
--------------------------------------------------------------------------------------
RELATIF depuis le worktree a     src/types.ts                             src/types.ts
RELATIF depuis le worktree b     src/types.ts                             src/types.ts
ABSOLU worktree a                .claude/worktrees/a/src/types.ts         .claude/worktrees
ABSOLU worktree b                .claude/worktrees/b/src/types.ts         .claude/worktrees
ABSOLU main checkout             src/types.ts                             src/types.ts

--- worktree HORS repoRoot ---
THROW: path is outside repoRoot: C:/ailleurs/wt-a/src/types.ts

si les agents declarent RELATIF -> overlap detecte ? true (src/types.ts)
si les agents declarent ABSOLU  -> overlap detecte ? false
module_overlap en ABSOLU (faux positif ?) : true   (les deux -> .claude/worktrees)
```

`normalizePath` ne retire le préfixe `repoRoot` que pour les chemins **absolus**
(`src/path-normalize.ts:29-38`) : un chemin relatif traverse inchangé. **Tout dépend donc de la
forme déclarée**, et le comportement est asymétrique — en absolu, `file_overlap` devient aveugle
*pendant que* `fileToModule` collapse les deux worktrees sur le même module `.claude/worktrees`.

**(B) T2 — le vrai chemin, trois worktrees natifs.** Worktrees créés par Claude Code :

```
.../d03repo/.claude/worktrees/d03a  [worktree-d03a] locked
.../d03repo/.claude/worktrees/d03b  [worktree-d03b] locked
```

`agent-A`, cwd = `…\.claude\worktrees\d03a` :

```
[tool_use] mcp__coordinator__register_agent {"agent_id":"agent-A","modules":["src"]}
[tool_use] mcp__coordinator__announce_work  {"target_modules":["src"],"target_files":["src/types.ts"]}
[tool_use] Edit  …\.claude\worktrees\d03a\src\types.ts
```

`agent-B`, cwd = `…\.claude\worktrees\d03b`, annonce le même fichier logique — **réponse brute du
serveur** :

```json
[
  { "type": "module_overlap", "severity": "warning", "agent_id": "agent-A",
    "description": "Module overlap on: src" },
  { "type": "file_overlap",   "severity": "warning", "agent_id": "agent-A",
    "description": "File overlap on: src/types.ts" }
]
```

> **Le conflit EST détecté entre deux worktrees natifs isolés.** Le risque n° 1 de §4 (« zéro
> chevauchement détecté ») est **faux**. La raison est mécanique : l'agent déclare `src/types.ts`,
> un chemin **relatif à son cwd**, et `normalizePath` le laisse passer tel quel — la clé est donc
> identique des deux côtés.

**(C) ~~Confondant levé~~ — confondant DÉPLACÉ, pas levé.** Les prompts de A et B nommaient
`src/types.ts`. Troisième run, prompt qui ne dicte **ni** le chemin **ni** sa forme (« ajoute un
commentaire en tête du fichier qui définit les types TypeScript du projet, choisis toi-même comment
remplir les champs ») :

```
[register_agent]  {"agent_id":"agent-C","name":"Agent C","modules":["src/types.ts"]}
[announce_work]   target_files = ["src/types.ts"] | target_modules = ["src/types.ts"]
   [conflits vus par C] 2 -> file_overlap vs agent-B | file_overlap vs agent-A
```

Relatif à nouveau, et **deux** conflits remontés à travers trois worktreesisolés. Trois agents sur
trois déclarent relatif.

*Note incidente :* C a rempli `target_modules` avec un **fichier** (`src/types.ts`) là où A et B
avaient mis `src`. Le champ n'est contraint par rien — d'où l'absence de `module_overlap` pour C.
La déclaration de module est libre et incohérente d'un agent à l'autre.

> ⚠️ **Ce que la passe adversariale a trouvé et que j'avais manqué.** Le prompt ne dictait plus la
> forme, mais **la description de l'outil, si** — `src/tools/consultation-tools.ts:49-53` :
>
> ```
> target_files: z.array(z.string()).describe(
>   "Repo-relative file paths (forward-slash, e.g. 'src/foo.ts'). Absolute paths are not accepted in team-mode.")
> ```
>
> Et j'avais mis `alwaysLoad: true` dans le `.mcp.json` du PoC — donc, d'après le résultat établi en
> [`C06`](C06-tool-search-defer-loading.md), les schémas **étaient** chargés en contexte et les trois
> agents ont lu cette phrase, exemple `src/foo.ts` compris. L'expérience établit donc « Opus 5, via
> le client MCP de Claude Code, suit une `.describe()` » — **pas** « les agents déclarent relatif ».
> La dérive observée sur le champ voisin `target_modules` (1 run sur 3) montre d'ailleurs que le
> respect de la consigne n'est pas acquis.
>
> Pire, la phrase est un **garde-fou fantôme** : le schéma est un `z.array(z.string())` nu, sans
> `refine` ni normalisation. « Absolute paths are not accepted » est **faux** — ils sont acceptés,
> stockés tels quels, et rediffusés en SSE/MQTT.

**(D) Ce qui casse vraiment — le chemin *observé*.** Toujours pour B :

```
[tool_use] mcp__coordinator__check_file_conflict {"file_path":"src/types.ts"}
   [RESULT] {"conflict":false,"agents":[]}
```

et `GET /api/hot-files` → `[]`. `check_file_conflict` et les hot files lisent `file_activity`, que
**rien n'alimente** ici : il n'existe aucun hook de collecte livré (`cli/init.ts` : zéro
scaffolding, déjà vérifié en §0). Et s'il en existait un, il tournerait *dans* le worktree et
enverrait vraisemblablement des chemins absolus — cas où T1 montre que le match échoue **et** que
`fileToModule` pollue. Le seul consommateur de `fileToModule` est `src/file-tracker.ts:16`, qui
écrit la colonne `module` de `file_activity`.

**(E) T4 — `git-cochange` est structurellement aveugle aux branches worktree.** Mesure propre, sur
un commit créé exprès dans le worktree `d03a` :

```
commit cree sur worktree-d03a: 2b9c126
git log (commande exacte du builder, cwd=repoRoot, SANS --all) voit-il ce commit ? NON
avec --all il le verrait ?                                                        OUI
```

> ⚠️ **Correction d'une mesure que j'avais failli retenir.** J'avais d'abord comparé
> `git rev-list --count HEAD` (15) à `--all` (743) et j'allais en conclure « 728 commits
> invisibles ». **Faux** : ce dépôt est un **clone shallow** (`.git/shallow` existe), ce qui
> explique l'essentiel de l'écart. La mesure ci-dessus, sur un commit contrôlé, est la bonne.

Et sur clone shallow, le daemon coupe la couche entièrement :

```
{"component":"gitcc","msg":"Layer 4 unavailable: shallow clone"}
```

**(F) K3 — la « position de repli » est déclarative, pas observationnelle.** `setMap()` n'a
**qu'un seul appelant** dans tout le dépôt :

```
src/dependency-map.ts:118:  setMap(orgId: string, map: DependencyMap): void {
src/tools/dependencies-tools.ts:68:      depMap.setMap(claims.org, parsed as DependencyMap);
```

C'est-à-dire l'outil MCP `set_dependency_map` : **la carte de dépendances doit être uploadée par un
client**. Aucun builder automatique côté serveur. Combiné au fait que `module_overlap` et
`dependency_chain` comparent `params.target_modules` — ce que l'agent **déclare** —, il n'existe
aujourd'hui **aucun chemin par lequel le coordinateur observe le contenu de deux worktrees et en
déduit un conflit sémantique**. Le noyau que §4 et la synthèse §3 présentent comme le
différenciateur est alimenté par des déclarations d'agents et un upload client.

**(F-bis) Le cas « worktree hors du repo root » n'est pas théorique — il est déjà là.** Inventaire
du dépôt de travail réel, après l'expérience :

```
C:/Users/gagno/projet/mcp-coordinator-new                              [docs/veille-claude-features]
C:/Users/gagno/AppData/Local/Temp/claude/wt-99                         [fix/99-auth-claims-error]   <-- HORS repoRoot
C:/…/mcp-coordinator-new/.claude/worktrees/agent-a75517e54a2ee66af     [fix/78-status-exit-code]
C:/…/mcp-coordinator-new/.claude/worktrees/docs-i18n-v07-alignment     [worktree-docs-i18n-v07-alignment]
```

`wt-99` vit sous `Temp/`, hors de `COORDINATOR_REPO_ROOT`. Un agent y travaillant et déclarant un
chemin **absolu** déclencherait le `THROW: path is outside repoRoot` de (A) — donc un **400** sur
`/api/working-files/start` (`src/http/rest-handlers.ts:836,879,903`), et la claim disparaît. Ce
n'est pas un scénario inventé pour le challenge : c'est l'état actuel du dépôt du mainteneur.

**(G) T5 — ~~`--worktree` n'est pas le défaut~~ : MESURE INVALIDE, retirée.** J'avais écrit que sur
les ~30 sessions `claude -p` des challenges `C06` et `C09`, aucune n'avait créé de worktree, et j'en
concluais « opt-in ». **La mesure ne prouve rien** : `claude -p` est précisément le mode où l'app
desktop, `/bg`, agent view, `/fork` et `/batch` n'existent pas. Mesurer l'auto-création de worktrees
en `-p`, c'est mesurer la pluie à l'intérieur — le 0/30 était structurellement garanti.

Ce que je peux affirmer de première main : dans **cette session-ci**, l'outil `Agent` expose un
paramètre `isolation: "worktree"`, et `EnterWorktree` / `ExitWorktree` figurent dans la liste
d'outils. **Le modèle peut donc créer un worktree sans qu'aucun humain ne tape quoi que ce soit.**
La §0 de cette fiche (vérifiée le 2026-08-14) confirme par ailleurs les autres chemins automatiques :
subagents `isolation: worktree`, isolation des sessions background (`worktree.bgIsolation`, défaut
`"worktree"`), `/batch`. **`--worktree` est un chemin sur plusieurs, et le seul qui exige un flag.**

---

**(H) Le défaut le plus grave n'a rien à voir avec les worktrees : la jointure déclaré ↔ observé
est cassée.** Vérifié fichier par fichier :

| Voie | Normalisation |
|---|---|
| `announce_work` (MCP) — `src/tools/consultation-tools.ts` | **aucune** |
| `announce-workflow.ts`, `consultation.ts` | **aucune** |
| `check_file_conflict` (MCP) — `src/tools/files-tools.ts` | **aucune** |
| `POST /api/announce` — `src/http/rest-schemas.ts:67` | **aucune** (`z.array(z.string())`, même pas de `.describe()`) |
| `POST /api/file-activity` — `rest-handlers.ts:834` | `normalizePath` |
| `POST /api/working-files/{start,stop}` — `rest-handlers.ts:877,901` | `normalizePath` |

Et `src/impact-scorer.ts:74` joint les deux côtés en passant `params.target_files` **brut** à
`fileTracker.getFileToAgentsIndex` et `workingFiles.getIndex` — qui interrogent des colonnes
normalisées par **égalité SQL exacte**. Mesure :

```
declare              | cle DECLAREE (brute)  | cle OBSERVEE (normalisee) | match
--------------------------------------------------------------------------------
"src/types.ts"       | src/types.ts          | src/types.ts              | OUI
"src/Types.ts"       | src/Types.ts          | src/types.ts              | *** NON ***
"./src/types.ts"     | ./src/types.ts        | src/types.ts              | *** NON ***
"SRC/Types.ts"       | SRC/Types.ts          | src/types.ts              | *** NON ***
```

`normalizePath` **passe tout en minuscules** dès que `repoRoot` porte une lettre de lecteur
(`src/path-normalize.ts:20-23,41`) — c'est-à-dire **sur Windows, la plateforme du mainteneur**. Un
agent qui annonce `src/Types.ts` ou `./src/types.ts` ne matchera jamais sa propre activité
observée. **Ce défaut existe sans aucun worktree**, et il touche le signal le plus fort du scoring.

La symétrie observée en (B) et (C) n'existe que parce que les deux côtés comparés étaient
*tous deux non normalisés* (`announce` ∩ `announce`). C'est une symétrie **par absence de
traitement**, pas par correction.

---

**Frontière factuelle — ce que le natif fait, ce qu'il ne fait pas :**

| | Constat mesuré |
|---|---|
| Le natif **isole réellement** | 3 worktrees créés, `.claude/worktrees/<nom>/`, branches `worktree-<nom>`, `locked`. Deux agents n'écrivent physiquement jamais le même inode. |
| Le natif **ne supprime pas** la détection d'intention | `file_overlap` + `module_overlap` remontent entre worktrees isolés, parce que les agents déclarent relatif. **Contredit §4 risque n° 1.** |
| Ce qui décroche vraiment (1) | Le chemin **observé** : `file_activity` / `check_file_conflict` / hot files. Vide ici, et cassé en absolu. |
| Ce qui décroche vraiment (2) | **`git-cochange`** : `git log` sans `--all` ne voit pas les branches `worktree-*` — mesuré. C'est la couche qui compterait le plus, puisque le travail en worktree y vit jusqu'au merge. |
| Ce qui n'existe pas | Une **observation** du conflit sémantique. Tout est déclaré par l'agent ou uploadé par un client. |

---

### 6.4-bis Ce que la passe adversariale a retourné

Deux réfutateurs, deux angles. **Les deux ont gagné**, et le second a inversé le verdict que
j'allais écrire. Ce qui suit est vérifié ici, commande par commande, pas repris sur parole.

**(I) Le coordinateur n'observe jamais le dépôt. Aucune couche d'observation n'existe.**

```
# tous les readFileSync de src/ (hors tests) :
src/serve-http.ts:611   -> assets du dashboard
src/version.ts:24       -> package.json
# fs.watch / chokidar : AUCUN

# appelants de treeSitter.extract() en production : UN SEUL
src/http/rest-handlers.ts:848:  symbols = ctx.services.treeSitter.extract(filePath, body.content, null);
#                                                                                  ^^^^^^^^^^^^
#                                    le buffer vient du CLIENT, et body.content est OPTIONNEL

# setDependencies(...) : defini l.11, AUCUN appelant de production
# setMap(...)          : un seul appelant -> l'outil MCP set_dependency_map
```

Le serveur **n'ouvre jamais un fichier source du dépôt**. L'AST n'est calculé que sur un buffer que
le client a bien voulu pousser. Le graphe de dépendances est intégralement uploadé. Les quatre
signaux de `ConflictDetector.detect()` sont donc **tous** déclarés ou uploadés — y compris la
branche « hot file », dont le commentaire l.114 (« *from actual file activity, not just declared
files* ») est trompeur : « actual » y désigne ce qu'un hook a bien voulu POSTer.

La seule observation autonome est `git-cochange` — et elle ne sauve pas la position : `--name-only`
ne rend que des **noms de fichiers** (jamais un diff, jamais un symbole), c'est un **prior
historique sur du commité** alors que deux agents en worktree n'ont justement **rien commité**, et
elle est **désactivée par défaut** dans tout ce qui est livré :

```
COORDINATOR_REPO_ROOT :  .env.example 1 (exemple)  |  Dockerfile 0  |  docker-compose.yml 0
```

> **Correction de mon propre diagnostic.** J'avais écrit en (E) que `git-cochange` « est aveugle aux
> branches `worktree-*` », ce qui laisse croire à un bug réparable par `--all`. C'est un mauvais
> diagnostic : `--all` déplacerait le prior à la marge, il ne ferait **jamais** observer au
> coordinateur le travail en cours du pair, puisque ce travail n'est pas commité. Le fait mesuré en
> (E) reste vrai ; l'inférence « donc il suffit d'ajouter `--all` » est fausse.

**(J) Le site du projet recommande la configuration qui casse son propre chemin observé.**

```
docs/index.html:2264  (+ 3171 en, 3543 fr, 3917 es, … — 6 langues)
  "git worktree add ../feature-x main and run each agent in its own worktree"
```

`../feature-x` est **hors** de `COORDINATOR_REPO_ROOT`. C'est exactement le cas où `normalizePath`
lève, et où `/api/working-files/start` et `/api/file-activity` renvoient **400**
(`rest-handlers.ts:836,879,903`). La page d'accueil prescrit la disposition qui met la voie observée
en erreur, dans six langues.

**(K) Le recadrage que la synthèse propose est déjà écrit — ce n'est pas ce qui manque.**

```
docs/index.html:2077 (+ 3128) : "Worktrees isolate filesystems. mcp-coordinator coordinates
                                 intent. A clean merge of two i[ndependent worktrees]…"
```

La réponse « worktrees isolent les fichiers, nous coordonnons l'intention » est **déjà sur la page
produit**. Ce qui manque n'est donc pas le positionnement : c'est l'implémentation derrière.

**(L) Deux formulations du dépôt ne survivent pas à ce qui précède.**

- `README.md:44` — « conflicts are detected **before a single line is written** ». Suppose que
  l'agent *veuille* annoncer — mesuré **0/3 sans `instructions`** dans
  [`C06`](C06-tool-search-defer-loading.md) — **et** qu'il déclare juste, ce que rien ne valide.
- `README.md:197` — « tree-sitter extracts symbols **server-side** from 15 languages ».
  Littéralement vrai (le parse tourne dans le daemon) mais se lit comme une observation, alors que
  les octets viennent de `body.content`, champ **optionnel** qu'aucun hook livré ne remplit.

### 6.5 Contre-arguments

- **La menace peut être surestimée sur le terrain.** Les worktrees ne sont le défaut que pour les sessions background d'`agent view` (research preview) et les subagents `isolation: worktree`. Une session interactive normale reste dans le main checkout, et l'isolation background est désactivable (`worktree.bgIsolation: "none"`). Beaucoup d'utilisateurs ne verront jamais un worktree.
- **Les agent teams — le mode de travail parallèle que le produit vise — n'utilisent pas de worktrees du tout.** Si c'est le segment principal, le conflit d'écriture reste entier et il n'y a rien à changer.
- **Coût de couplage à Claude Code.** `worktree_path`, hooks `WorktreeCreate`, slug `agent-a<hex>`, chemin `.claude/worktrees/` : tout cela est du vocabulaire propriétaire Claude Code. mcp-coordinator est un serveur MCP censé servir aussi Cline, Aider, Cursor. Une colonne `worktree_path` dans `agents` est morte pour eux.
- **Surface documentaire instable.** `worktree.baseRef` et `worktree.bgIsolation` ne sont pas dans settings.md ; deux issues docs amont sont ouvertes ; un bug (#36205) contredit peut-être la doc sur le déclenchement des hooks. Coder contre cette surface aujourd'hui, c'est accepter du rework.
- **YAGNI sur la canonicalisation.** Réécrire `normalizePath` pour retirer le préfixe worktree introduit une ambiguïté réelle : deux agents éditant `src/types.ts` dans deux worktrees **ne se marchent pas dessus** — les fusionner sous une même clé transforme une non-collision en fausse alerte. Le comportement actuel (zéro détection) est peut-être le bon.
- **Effort disproportionné pour l'auto-hébergeur.** Faire suivre le worktree demande soit un hook installé côté client (scaffolding à écrire dans `cli/init.ts`, aujourd'hui inexistant), soit un `COORDINATOR_REPO_ROOT` par agent — c'est-à-dire casser l'hypothèse « un daemon = un checkout » sur laquelle repose `cli/server/start.ts`.
- **Le vrai livrable est peut-être uniquement éditorial.** Si le noyau technique (dependency-map, impact-scorer, tree-sitter, git-cochange) répond déjà au trou, la réponse à cette menace pourrait n'être que ~8 éditions dans `docs/index.html` et une ligne de README — pas de code du tout.

---

## 7. Décision

Fiche « menace » : le verdict porte sur la **réponse**, pas sur une adoption.

| | |
|---|---|
| **Verdict** | ✅ **contre-mesure technique** — et **rejet** des deux branches de §6.1, qui posaient la mauvaise question |
| **Date** | 2026-08-15 |
| **Justification** | Voir §7.1 à §7.4. La menace n'est pas surestimée : elle est **sous-spécifiée**. |
| **Issue / PR** | à créer — périmètre en §7.3 |
| **Jalon visé** | prochaine mineure pour §7.3 (1) et (3) ; à cadrer pour (2) |

### 7.1 Le résultat principal

**La menace de la synthèse §3 n'est pas « le conflit d'écriture disparaît ». C'est que la position
de repli annoncée n'a pas d'implémentation.**

La synthèse écrit : *« un worktree évite la collision d'écriture, pas le conflit sémantique […]
C'est ce que mesurent déjà `dependency-map`, `impact-scorer`, `git-cochange-builder` et
`conflict-detector`. Cette reformulation est un travail de positionnement, pas de code. »*

Les deux moitiés sont fausses.

- **« C'est ce que mesurent déjà… »** — non. Vérifié en §6.4 (I) : le serveur n'ouvre jamais un
  fichier source du dépôt, `treeSitter.extract()` n'a qu'un appelant alimenté par un `body.content`
  **optionnel** venu du client, le graphe de dépendances est **intégralement uploadé**
  (`setMap` ← `set_dependency_map`, `setDependencies` sans aucun appelant de production), et les
  quatre signaux de `ConflictDetector` comparent des **déclarations**. La seule observation
  autonome, `git-cochange`, ne rend que des **noms de fichiers commités** et est désactivée par
  défaut dans tout ce qui est livré. **mcp-coordinator est un agrégateur de déclarations.**
- **« un travail de positionnement, pas de code »** — non plus : le positionnement est **déjà
  écrit** (`docs/index.html:2077`, en 6 langues). Ce qui manque est exactement le code.

C'est un résultat plus grave que celui que la fiche annonçait, et **plus actionnable** : il ne
dépend d'aucune décision d'Anthropic.

### 7.2 Ce que le natif fait vraiment, et ce que j'avais mal mesuré

- **`--worktree` n'est pas « opt-in ».** Ma mesure « 0 worktree sur ~30 sessions » était **invalide**
  (§6.4 (G)) : `claude -p` est le seul mode où l'app desktop, `/bg`, agent view, `/fork` et
  `/batch` n'existent pas. De première main dans cette session : l'outil `Agent` porte
  `isolation: "worktree"` et `EnterWorktree` est disponible — **le modèle crée des worktrees sans
  intervention humaine**.
- **Le natif ne supprime pas la détection d'intention** — `file_overlap` + `module_overlap` sont bien
  remontés entre trois worktrees isolés (§6.4 (B)/(C)). Mais **pas pour la raison que je croyais** :
  les agents ont déclaré relatif parce que la `.describe()` de `target_files` le leur disait, et
  parce que `alwaysLoad: true` la rendait visible. Le risque n° 1 de §4 n'est donc **pas faux** :
  il est **conditionnel à une convention que rien n'impose**.
- **Et la phrase qui l'impose est un garde-fou fantôme** : « Absolute paths are not accepted in
  team-mode » alors que le schéma est un `z.array(z.string())` nu.

### 7.3 La réponse — contre-mesure technique, par ordre de levier

1. **Normaliser `target_files` à l'entrée d'`announce_work` (MCP et REST) et de
   `check_file_conflict`.** C'est le défaut mesuré en §6.4 (H) : le côté **déclaré** n'est jamais
   normalisé, le côté **observé** l'est (et passe en minuscules sur Windows), et
   `impact-scorer.ts:74` joint les deux en brut. Résultat : `src/Types.ts`, `./src/types.ts` et
   `SRC/Types.ts` ne matchent jamais l'activité observée du même fichier. **Ce bug existe sans
   aucun worktree**, il touche le signal le plus fort du scoring, et il rend la détection
   inter-worktree robuste au passage. Effort S, aucun couplage à Claude Code.
2. **Décider ce que devient le conflit sémantique : capacité ou déclaration assumée.** Soit un
   builder de dependency-map côté serveur (le `--repo-root` promet déjà un « FS fallback » qui
   n'existe pas — `cli/server/start.ts:169`), soit on **documente honnêtement** que la carte est
   uploadée par le client. Ce qui n'est pas tenable, c'est l'état actuel : une capacité annoncée
   dans le pitch et absente du code. **C'est la vraie question de cadrage de cette fiche**, et elle
   mérite sa propre instruction.
3. **Corriger deux textes faux.** `docs/index.html:2264` (6 langues) recommande
   `git worktree add ../feature-x main`, c'est-à-dire hors `repoRoot` — la disposition qui met
   `/api/file-activity` et `/api/working-files/start` en **400**. Et `README.md:44` (« conflicts
   are detected before a single line is written ») n'est pas tenable : `C06` a mesuré **0/3**
   annonces spontanées, et rien ne valide ce qui est déclaré. Le mot juste est déjà employé
   ailleurs sur le site — *« scores every **claim** »*.

### 7.4 Ce qui est explicitement rejeté

- **Les deux branches de §6.1.** Ni « faire du worktree une entité de première classe »
  (`worktree_path` sur `agents`, canonicalisation worktree-relative, enregistrement par hook
  `WorktreeCreate`) — c'est du vocabulaire propriétaire Claude Code, mort pour Cursor/Cline/Aider,
  et le hook ne **reçoit** même pas le chemin (§0). Ni « acter que `working_files` et `file_overlap`
  deviennent du bruit » — ils fonctionnent, c'est mesuré. La question posée en §6.1 opposait deux
  réponses à un problème mal identifié.
- **Ajouter `--all` à `git-cochange`.** §6.4 (E) mesure bien la cécité, mais §6.4-bis (I) montre que
  le correctif est illusoire : Layer 4 est un prior sur du **commité**, et le travail en worktree ne
  l'est pas. À ne pas inscrire au périmètre en croyant réparer quelque chose.
- **Le recadrage éditorial comme réponse principale.** Il est déjà écrit
  (`docs/index.html:2077`). Le répéter ne comble pas le trou.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : input `WorktreeCreate` corrigé (`name`, pas `worktree_path`/`base_ref`), settings.md à jour, lignes conflict-detector recalées. Testable. |
| 2026-08-15 | **Challenge tranché : contre-mesure technique, et rejet des deux branches de §6.1.** PoC réel dans un clone jetable : 3 worktrees natifs créés par Claude Code, daemon dédié. `file_overlap` + `module_overlap` **sont** remontés entre worktrees isolés — mais parce que la `.describe()` de `target_files` dicte le format relatif et qu'`alwaysLoad` la rendait visible ; le risque n° 1 de §4 est **conditionnel**, pas faux, et la phrase « Absolute paths are not accepted » est un **garde-fou fantôme**. Défaut plus grave découvert, indépendant des worktrees : le côté **déclaré** n'est jamais normalisé alors que le côté **observé** l'est et passe en minuscules sur Windows — `src/Types.ts` et `./src/types.ts` ne matchent jamais leur propre activité (`impact-scorer.ts:74` joint du brut). **Résultat principal : la position de repli du produit n'a pas d'implémentation** — zéro lecture de fichier source côté serveur, `treeSitter.extract()` alimenté par un `body.content` optionnel du client, dependency-map intégralement uploadée, `git-cochange` limitée à des noms de fichiers commités et désactivée par défaut. La synthèse §3 se trompe deux fois : ce n'est pas « ce que mesurent déjà » ces modules, et ce n'est pas « un travail de positionnement, pas de code » — le positionnement est déjà écrit, c'est le code qui manque. Deux mesures de ma part corrigées en cours de route : le comptage git contaminé par le clone shallow, et le « 0 worktree sur 30 sessions » invalide car mesuré en `claude -p`. Verdict retourné par 2 réfutateurs. |
