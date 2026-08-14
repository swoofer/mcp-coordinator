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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

- [ ] Lancer deux sessions `claude --worktree a` et `claude --worktree b` sur ce dépôt, faire éditer `src/types.ts` par les deux, et observer ce que reçoit réellement `POST /api/working-files/start` : chemin brut, chemin après `normalizePath`, et si `check_file_conflict` remonte quoi que ce soit.
- [ ] Vérifier le comportement de `normalizePath` avec un worktree placé **hors** de `COORDINATOR_REPO_ROOT` : confirmer le 400 et mesurer si l'agent le voit ou l'avale.
- [ ] Écrire un hook `WorktreeCreate` minimal qui appelle `POST /api/register` avec `worktree_path` et vérifier qu'un exit non-zéro avorte bien la création — et vérifier si `EnterWorktree` déclenche le hook (issue amont #36205).
- [ ] Instrumenter `FileTracker.fileToModule` sur un chemin de worktree réel et confirmer l'agrégation parasite sur le module `.claude/worktrees`.
- [ ] Monter le scénario sémantique complet : agent A change une signature exportée dans le worktree `a`, agent B consomme l'ancienne dans `b` ; mesurer si `impact-scorer` + `dependency-map` catégorisent B en `concerned` **sans** aucun signal de chevauchement de fichier.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

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
| 2026-08-14 | Vérification des faits : input `WorktreeCreate` corrigé (`name`, pas `worktree_path`/`base_ref`), settings.md à jour, lignes conflict-detector recalées. Testable. |
