# C08 — Status line : trois autres agents sur ce repo, un conflit, à zéro token

| Champ | Valeur |
|---|---|
| **ID** | `statusline` |
| **Surface** | claude-code |
| **Statut** | GA (aucun label beta/preview sur la page `statusline`) |
| **Disponible depuis** | non daté par la doc — `refreshInterval`, `workspace.repo.*` et `workspace.git_worktree` sont documentés sans note de version |
| **Tier** | T1-incontournable |
| **Nature** | opportunity |
| **Effort estimé** | S |
| **Confiance veille** | high (mécanisme) · medium (noms de champs : une seule source de veille, non recoupée) |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — tout se joue en local, aucun accès externe requis |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** ✅ saine

**Corrections apportées :**

- §2 — les trois `(à vérifier)` sont tranchés par la doc officielle (`code.claude.com/docs/en/statusline`) : `workspace.added_dirs` est un **tableau** de répertoires ajoutés via `/add-dir` ou `--add-dir`, **tableau vide** si aucun ; `workspace.git_worktree` est le **nom** du worktree (chaîne) quand le cwd est dans un worktree lié créé par `git worktree add`, **absent** dans le working tree principal ; `workspace.repo.{host,owner,name}` est parsé depuis le remote **`origin`** — donc pas spécifique à GitHub (`host` porte le domaine) — et **absent** hors dépôt git ou sans remote `origin`.
- §2 — l'intégralité des noms de champs relevés par la veille est confirmée mot pour mot par la doc (`session_id`, `cwd`, `workspace.*`, `model.display_name`, `output_style.name`, `version`, `agent.name`, `cost.*`, `context_window.used_percentage`, `exceeds_200k_tokens`). La réserve « source unique non recoupée » est levée : la source canonique confirme. Le minimum de `1` sur `refreshInterval` et le défaut `0` de `padding` sont documentés (toujours non mesurés).
- §2 — ajout d'un fait non relevé par la veille : `subagentStatusLine` est un **second** slot de `settings.json`, distinct de `statusLine`.
- §5 — `src/serve-http.ts` : le fallback de claims synthétiques est aux lignes **421-423** (le `return { … org: "default" … }` est en 423), pas 421 seule.
- Statut **GA** confirmé : aucune mention beta/preview sur la page `statusline`.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ✅ testable
Tous les points du §6.3 s'exécutent ici : `settings.json` jetable pour capturer le stdin réel, `Measure-Command` pour le coût par tick, `curl http://localhost:3100/api/status` en profil ouvert, deux worktrees + kill pour la fenêtre TTL. Aucun credential API, header beta ni accès preview n'est requis — la status line est un mécanisme purement local du client Claude Code, déjà installé sur le poste.

## 1. Ce que c'est

Claude Code peut afficher en permanence, en bas de la session, la sortie d'un **script arbitraire** déclaré dans `settings.json` sous la clé `statusLine`. Le script est exécuté par le host, reçoit sur **stdin** un JSON décrivant la session, et tout ce qu'il imprime sur stdout devient la ligne de statut. Aucun token n'est consommé : ni l'entrée ni la sortie ne traversent le modèle — c'est un canal d'affichage vers l'**humain**, pas vers l'agent.

Le payload stdin contient déjà l'essentiel de ce dont mcp-coordinator a besoin pour se situer : `session_id`, `cwd`, `workspace.current_dir`, `workspace.project_dir`, `workspace.added_dirs`, `workspace.git_worktree`, `workspace.repo.{host,owner,name}`, `agent.name`, `model.display_name`, plus des compteurs de coût et `context_window.used_percentage`.

Deux régimes de déclenchement cohabitent. Par défaut le script est ré-exécuté sur événements (changement de tour, de cwd, etc.). Le champ `refreshInterval` (minimum 1 s) ajoute un timer, et la doc précise que ce timer est précisément ce qui couvre le cas où la session principale **attend** — pendant l'exécution de subagents en arrière-plan, les déclencheurs événementiels se taisent. C'est exactement la fenêtre pendant laquelle un autre agent peut annoncer un travail conflictuel.

Un slot, un seul : `statusLine` est un champ scalaire de `settings.json`. Installer la nôtre écrase celle de l'utilisateur.

## 2. Surface d'API exacte

Déclaration (`settings.json`) :

```json
{
  "statusLine": {
    "type": "command",
    "command": "mcp-coordinator statusline",
    "padding": 0,
    "refreshInterval": 5
  }
}
```

Commande interactive de configuration : `/statusline`.

Payload JSON reçu sur **stdin** (champs relevés par la veille) :

```
session_id
cwd
workspace.current_dir
workspace.project_dir
workspace.added_dirs
workspace.git_worktree
workspace.repo.{host,owner,name}
model.display_name
output_style.name
version
agent.name
cost.{total_cost_usd,total_duration_ms,total_api_duration_ms,total_lines_added,total_lines_removed}
context_window.used_percentage
exceeds_200k_tokens
```

Réglage voisin mentionné par la même source : `footerLinksRegexes` (settings). Slot voisin **distinct** : `subagentStatusLine` (même forme `{type:"command",command:…}`) personnalise les lignes du panneau de subagents — il ne concurrence pas `statusLine`.

**Sémantique des champs sensibles (vérifiée le 2026-08-14 sur la doc officielle) :**

- `workspace.added_dirs` — **tableau** des répertoires ajoutés par `/add-dir` ou `--add-dir` ; **tableau vide** si aucun.
- `workspace.git_worktree` — **nom** du worktree (chaîne) quand le cwd est dans un worktree lié créé par `git worktree add` ; **absent** dans le working tree principal. À distinguer de l'objet `worktree.*`, qui n'existe que pendant les sessions `--worktree`.
- `workspace.repo.{host,owner,name}` — identité parsée depuis le remote **`origin`** (ex. `"github.com"`, `"anthropics"`, `"claude-code"`) ; donc **non spécifique à GitHub**, `host` porte le domaine. **Absent** hors dépôt git ou sans remote `origin` configuré.
- `refreshInterval` — minimum documenté : `1`. `padding` — défaut documenté : `0`. Aucun des deux n'a été mesuré.
- `context_window.used_percentage` peut être `null` en début de session ; plusieurs champs sont optionnels — un consommateur doit tolérer l'absence.

**Réserve de veille levée.** Le relevé initial reposait sur une source unique non recoupée. Les noms de champs du bloc ci-dessus ont été confrontés un à un à `code.claude.com/docs/en/statusline` : aucun n'est erroné.

**Correction apportée au relevé source.** Le relevé affirme que `workspace.repo.*` fournit « l'identité de repo canonique que le projet calcule aujourd'hui à la main ». C'est faux : `rg 'repo_id|repoId|project_id|projectId'` sur `src/`, `cli/` et `sdk/src/` ne renvoie **aucune** occurrence. Le projet ne calcule pas cette identité — il n'en a pas du tout. Voir §4.

## 3. Sources

- https://code.claude.com/docs/en/statusline
- https://code.claude.com/docs/en/settings

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.**

1. *Un canal d'information à zéro token, aujourd'hui inexistant.* Le seul moyen pour un humain de savoir « qui d'autre travaille » est soit `coordinator_status` (outil MCP, `src/tools/status-tools.ts:32`, consommé par l'agent et facturé en tokens), soit le dashboard, qui suppose un navigateur ouvert à côté. La status line est le troisième canal : permanent, passif, gratuit. `GET /api/status` renvoie déjà exactement les quatre chiffres à afficher (`online`, `open_threads`, `hot_files`, `mqtt`) et est explicitement traité comme un endpoint de polling — il est listé dans `isPoll` (`src/http/handle-rest.ts:161-165`) et loggé en `debug`, donc un `refreshInterval` de quelques secondes ne pollue pas les logs.

2. *En profil ouvert, l'intégration est triviale.* `COORDINATOR_AUTH_ENABLED` non défini ⇒ `AUTH_ENABLED = false` (`src/serve-http.ts:101`) et le serveur fabrique des claims synthétiques `org='default'` (`src/serve-http.ts:421`). Un `curl http://localhost:3100/api/status` suffit, sans token. Aucun code nouveau côté serveur pour la version v1.

3. *Une identité de repo, qui n'existe nulle part dans le schéma.* Tout est scopé par `claims.org` et rien d'autre : `registry.listOnline(org)`, `consultation.listThreads(org, …)`, `fileTracker.getHotFiles(org, …)`. Deux agents travaillant sur **deux dépôts différents** avec la même org se voient mutuellement comme des pairs, et `wait_for_peers` compte l'un pour l'autre. `workspace.repo.{host,owner,name}` + `workspace.git_worktree` fourniraient cette clé — mais gratuitement seulement pour les clients Claude Code, ce qui en fait un choix d'architecture, pas un ajout cosmétique (§6.1).

**Risque si on ne fait rien :** aucun. C'est une opportunité, pas une menace. Rien ne se dégrade si la fiche est classée sans suite ; le projet reste dans son mode actuel où l'information de coordination ne circule que quand l'agent va la chercher, ou quand un humain regarde le dashboard.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `cli/index.ts` (l. 20-28) | ajouter un `program.addCommand(createStatuslineCommand())` — même patron `createXCommand()` que `init`, `doctor`, `dashboard`, `channel` |
| `cli/statusline.ts` *(à créer)* | lit le JSON de session sur stdin, appelle le daemon, imprime une ligne ; doit sortir silencieusement (code 0, ligne vide) si le daemon est injoignable |
| `cli/config.ts` (l. 37-60) | `loadConfig().defaults.coordinator_url` — défaut `http://localhost:3100` ; résolveur d'URL déjà en place, réutilisable tel quel |
| `src/http/handle-rest.ts` (l. 84, 161-165) | route `/api/status` déjà exposée, hors `MUTATING_ROUTES`, déjà classée `isPoll` → aucune modification requise pour une v1 |
| `src/http/rest-handlers.ts` (l. 970-985) | `handleStatus` renvoie `{ online, open_threads, hot_files, mqtt }` : quatre entiers, **aucun nom de fichier ni d'agent**. « 1 conflit sur `src/auth.ts` » n'est pas atteignable sans changer ce payload |
| `src/http/rest-handlers.ts` (l. 138-157) | `handleCheckConflict` sait nommer les fichiers chauds, mais exige `{ file, agent_id }` — donc un appel par fichier, pas une vue d'ensemble |
| `src/http/utils.ts` (l. 12-38) | `parseBody` ne lit **que** le corps JSON, jamais la query-string : un endpoint paramétré ne se consomme pas en `GET ?repo=…` sans code nouveau |
| `src/tools/status-tools.ts` (l. 32-71) | `coordinator_status`, le pendant payant en tokens ; à déprécier ou non selon le verdict |
| `src/agent-registry.ts` (l. 12, 91-102) | `listOnline` filtre sur un TTL de **900 s** (`COORDINATOR_AGENT_ONLINE_TTL_SECONDS`) : un agent tué reste compté jusqu'à 15 min |
| `src/conflict-detector.ts` (l. 20-152) | `detect()` produit des `ConflictReport` nommant fichiers et modules, mais n'est appelé qu'au moment d'annoncer — jamais exposé en lecture ambiante |
| `src/serve-http.ts` (l. 101, 421-423) | `AUTH_ENABLED` et le fallback claims synthétiques : détermine si la ligne a besoin d'un secret |
| `cli/init.ts` (l. 253-299) | écrit aujourd'hui `.mcp.json` et la section `CLAUDE.md` ; **n'écrit pas** `settings.json`. Un `--write-statusline` serait une nouvelle surface d'écriture dans la config utilisateur |
| `cli/doctor.ts` | endroit naturel pour une vérification « `statusLine` pointe-t-il sur un binaire existant ? » |
| `README.md` (l. 328), `docs/usage.md` | documentation de la commande |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> La status line se contente-t-elle de `GET /api/status` — quatre entiers org-scopés, déjà servis, zéro code serveur, mais une ligne incapable de nommer le fichier en conflit — ou justifie-t-elle un endpoint dédié prenant `workspace.repo.{owner,name}` et `workspace.git_worktree` en entrée, et donc l'introduction d'un axe de scoping « repo » qui n'existe **nulle part** dans le schéma actuel (zéro occurrence de `repo_id`/`project_id`) et que seuls les clients Claude Code sauraient renseigner ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

*Proposition de la veille — rien n'a encore été exécuté.*

- [ ] Confirmer le payload stdin réel : câbler dans un `settings.json` jetable un `statusLine.command` qui recopie son stdin dans un fichier, ouvrir une session, et vérifier la présence effective de `workspace.repo.{host,owner,name}`, `workspace.git_worktree` et `agent.name` — les noms de §2 viennent d'une source unique.
- [ ] Mesurer le coût d'un tick sous Windows : `Measure-Command { node dist/cli/index.js statusline }` × 20, daemon local démarré. Seuil de disqualification proposé : p50 > 300 ms à `refreshInterval: 1`, auquel cas la piste « commande Node » cède devant un one-liner shell.
- [ ] Vérifier le contrat serveur en profil ouvert : `COORDINATOR_AUTH_ENABLED` non défini, `curl -s http://localhost:3100/api/status` → attendre un 200 sans token et le shape `{ online, open_threads, hot_files, mqtt }` (`src/http/rest-handlers.ts:970`).
- [ ] Mesurer la fenêtre de mensonge : deux sessions sur deux worktrees du même dépôt, enregistrées comme deux agents ; `kill -9` sur l'une, chronométrer combien de temps la ligne de l'autre continue d'afficher `online: 2`. Attendu ≈ 900 s (TTL de `listOnline`).
- [ ] Vérifier la dégradation daemon éteint : la ligne doit rester vide ou afficher un état neutre, sans stack trace ni délai perceptible en bas de la session.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Mono-client.** La status line n'existe que dans Claude Code. Le projet se positionne explicitement comme cross-vendor (« Cursor et Claude Code sur deux laptops différents partagent un même thread ») ; investir dans un affichage qu'aucun autre client ne sait rendre déséquilibre cet argument, et crée une expérience à deux vitesses selon l'éditeur.
- **Informe, ne bloque pas.** La ligne s'adresse à l'humain. Elle n'empêche aucun `Write`, ne retarde aucun `announce_work`. La valeur de coordination réelle est dans les hooks (C01/C02), qui peuvent, eux, sortir en code 2. Le risque est de dépenser un budget de veille sur le canal le moins contraignant.
- **Un seul slot, déjà occupé.** `statusLine` est un champ scalaire de `settings.json`. Beaucoup d'utilisateurs ont déjà la leur (branche git, modèle, coût). Écrire la nôtre depuis `mcp-coordinator init` écraserait ce réglage — comportement inacceptable, ce qui repousse l'intégration vers « on documente un snippet à copier », soit une adoption bien plus faible que le bénéfice annoncé.
- **Coût par tick, aggravé sous Windows.** À `refreshInterval: 1`, un process Node par seconde. Le démarrage de `cli/index.ts` charge Commander plus neuf sous-commandes avant même d'atteindre le code utile. L'alternative — `curl … | jq` — ajoute une dépendance `jq` et casse sur la plateforme principale du mainteneur (PowerShell).
- **Affichage permanent d'un chiffre potentiellement faux.** Le TTL de 900 s (`src/agent-registry.ts:12`) autorise `listOnline` à compter un agent mort pendant un quart d'heure. Toléré pour un appel ponctuel à `coordinator_status`, ce mensonge devient corrosif affiché en continu : l'utilisateur cesse de croire la ligne, et par extension le coordinateur.
- **Secret en clair dès le profil authentifié.** Avec `COORDINATOR_AUTH_ENABLED=true`, la ligne a besoin d'un token. Soit un token de service en clair dans un `settings.json` potentiellement versionné, soit brancher `sdk/src/keytar-store.ts` dans un chemin qui doit répondre en moins d'une seconde. Aucune des deux options n'est confortable.
- **YAGNI en déploiement solo.** Dans le profil dominant (un mainteneur, une machine), `online` vaut 1 et `open_threads` vaut 0 la plupart du temps. La ligne affiche alors du bruit constant pour une information nulle, et le dashboard couvre déjà le besoin humain quand il y a vraiment plusieurs agents.
- **Le bénéfice le plus fort n'est pas dans la ligne.** Ce qui manque réellement au projet, c'est le scoping par dépôt (§4.3). La status line ne fait qu'en révéler l'absence — elle ne le résout pas, et le résoudre par un champ que seul Claude Code sait fournir serait le mauvais point d'entrée pour une décision de schéma.

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
| 2026-08-14 | Vérification des faits : noms de champs tous confirmés, 3 `(à vérifier)` tranchés, statut GA maintenu, fiche testable. |
