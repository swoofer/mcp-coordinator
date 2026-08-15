# C08 — Status line : trois autres agents sur ce repo, un conflit, à zéro token

| Champ | Valeur |
|---|---|
| **ID** | `statusline` |
| **Surface** | claude-code |
| **Statut** | GA (aucun label beta/preview sur la page `statusline`) |
| **Disponible depuis** | non daté par la doc — `refreshInterval`, `workspace.repo.*` et `workspace.git_worktree` sont documentés sans note de version |
| **Tier** | ~~T1-incontournable~~ → **T3** (déclassé au challenge du 2026-08-15, voir §7.1) |
| **Nature** | opportunity |
| **Effort estimé** | S |
| **Confiance veille** | high (mécanisme) · medium (noms de champs : une seule source de veille, non recoupée) |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — tout se joue en local, aucun accès externe requis |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — refuser en tant que feature, voir §7 |

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

**Pré-enregistré le 2026-08-15, avant toute exécution.** Claude Code **2.1.219**, Node 22.21.0,
Windows 11.

**Hypothèse.** Le mécanisme marchera et le payload sera conforme — la §0 a déjà tout confirmé sur
doc. Le vrai enjeu est ailleurs : le **coût par tick sous Windows** et le **slot unique**. Je
m'attends à ce que le démarrage d'un CLI Node dépasse largement le seuil de 300 ms que la fiche
se donne, ce qui disqualifie la forme « `mcp-coordinator statusline` » à `refreshInterval: 1` — et
donc à ce que le verdict porte sur *quelle forme* de status line, pas sur *si*.

**Critères de refus, posés avant de mesurer :**

| # | Ce qui tue quoi | Seuil |
|---|---|---|
| K1 | Si le payload stdin réel ne porte **pas** `workspace.repo.*`, l'argument §4.3 (« l'identité de repo, gratuite ») meurt. | absence dans le JSON capturé |
| K2 | Si un tick CLI Node coûte **> 300 ms** en p50, la forme « commande Node » est disqualifiée à `refreshInterval` court (seuil que la fiche se donne elle-même en §6.3). | p50 mesuré |
| K3 | Si `GET /api/status` exige un token en profil ouvert, le « zéro code serveur » de §4.2 tombe. | code HTTP |
| K4 | Si le TTL de 900 s fait effectivement mentir la ligne, l'affichage **permanent** devient un passif — un chiffre faux en continu est pire qu'un chiffre absent. | lecture du code + calcul |
| K5 | Si écrire `statusLine` écrase une ligne existante chez un utilisateur réel, `init --write-statusline` est inacceptable et l'adoption retombe sur « documenter un snippet ». | inspection d'un poste réel |
| K6 | Si la ligne ne peut pas nommer le fichier en conflit sans nouvel endpoint, la branche « quatre entiers » de §6.1 livre un bénéfice très faible. | shape de `/api/status` |

### 6.3 Protocole de vérification

*Proposition de la veille — rien n'a encore été exécuté.*

- [ ] Confirmer le payload stdin réel : câbler dans un `settings.json` jetable un `statusLine.command` qui recopie son stdin dans un fichier, ouvrir une session, et vérifier la présence effective de `workspace.repo.{host,owner,name}`, `workspace.git_worktree` et `agent.name` — les noms de §2 viennent d'une source unique.
- [ ] Mesurer le coût d'un tick sous Windows : `Measure-Command { node dist/cli/index.js statusline }` × 20, daemon local démarré. Seuil de disqualification proposé : p50 > 300 ms à `refreshInterval: 1`, auquel cas la piste « commande Node » cède devant un one-liner shell.
- [ ] Vérifier le contrat serveur en profil ouvert : `COORDINATOR_AUTH_ENABLED` non défini, `curl -s http://localhost:3100/api/status` → attendre un 200 sans token et le shape `{ online, open_threads, hot_files, mqtt }` (`src/http/rest-handlers.ts:970`).
- [ ] Mesurer la fenêtre de mensonge : deux sessions sur deux worktrees du même dépôt, enregistrées comme deux agents ; `kill -9` sur l'une, chronométrer combien de temps la ligne de l'autre continue d'afficher `online: 2`. Attendu ≈ 900 s (TTL de `listOnline`).
- [ ] Vérifier la dégradation daemon éteint : la ligne doit rester vide ou afficher un état neutre, sans stack trace ni délai perceptible en bas de la session.

### 6.4 Résultat observé

Exécuté le 2026-08-15. Claude Code **2.1.219**, Node 22.21.0, Windows 11.

> **Frontière exécuté / lu.** Exécuté : K2 (coût par tick), K3/K6 (contrat serveur), K4 (TTL),
> K5 (slot occupé). **Non exécutable ici : la capture du payload stdin.** La status line ne se
> déclenche **pas** en `claude -p` — c'est une surface d'interface, pas de session headless
> (vérifié : un `statusLine.command` qui recopie son stdin n'a produit aucune capture). Les noms de
> champs de §2 restent donc sur **preuve documentaire**, déjà établie par la §0. **Correction à
> §0 :** son champ *Testabilité* affirme que « tous les points du §6.3 s'exécutent ici », dont la
> capture du stdin. C'est faux depuis une session d'agent ; il faut un TTY interactif.

**(A) K2 — le coût par tick, et il disqualifie la forme proposée.** 20 mesures de
`node dist/cli/index.js --version` (proxy du démarrage de notre CLI), plus le plancher Node :

```
CLI mcp-coordinator (node dist)    p50=  1 036 ms   p95=  1 116 ms   min= 1 009   max= 1 182
node -e 0 (plancher Node)          p50=     62 ms   p95=    101 ms   min=    56   max=    101

seuil de disqualification de la fiche : p50 > 300 ms
K2 DECLENCHE — p50 = 1 036 ms > 300 ms
```

**Le seuil que la fiche s'était donné en §6.3 est franchi d'un facteur 3,5.** Et le plancher Node
n'étant que de 62 ms, ~**975 ms sont le démarrage de notre propre CLI** — exactement ce que le
contre-argument de §6.5 anticipait (« Commander plus neuf sous-commandes avant même d'atteindre le
code utile »). À `refreshInterval: 1`, le tick ne peut pas suivre : le processus dure plus longtemps
que l'intervalle.

**(B) K3 et K6 — le serveur, lui, est gratuit et instantané.** Profil ouvert
(`COORDINATOR_AUTH_ENABLED` non défini), sans token :

```
HTTP 200  |  0.006936s
payload : {"online":0,"open_threads":0,"hot_files":0,"mqtt":true}
```

**7 ms, 200, aucun token, aucun code serveur à écrire** — §4.2 est confirmée. Et §5 est confirmée
aussi : quatre entiers, **aucun nom de fichier ni d'agent**
(`src/http/rest-handlers.ts:970-985`). « 1 conflit sur `src/auth.ts` » n'est pas atteignable sans
nouvel endpoint. **K6 est déclenché** : la branche « quatre entiers » de §6.1 livre un bénéfice
faible.

> Le rapport est écrasant : **7 ms de serveur pour 1 036 ms de client**. Le coût d'un tick est à
> **99,3 % le démarrage de notre CLI**, pas la coordination.

**(C) K5 — le slot est déjà occupé, chez le mainteneur lui-même.** `~/.claude/settings.json` :

```json
"statusLine": { "type": "command", "command": "npx -y ccstatusline@latest",
                "padding": 0, "refreshInterval": 10 }
```

Le contre-argument « un seul slot, déjà occupé » de §6.5 n'est pas théorique : **la personne qui
déciderait d'écrire cette feature l'a déjà rempli**, avec un produit tiers dédié. Un
`init --write-statusline` écraserait son propre réglage. **K5 est déclenché.**

**(D) K4 — le TTL.** `src/agent-registry.ts:12` : `DEFAULT_ONLINE_TTL_SECONDS = 900`. Un agent tué
reste compté **jusqu'à 15 minutes**. Toléré pour un appel ponctuel, ce décalage devient un passif
quand il est affiché **en permanence**.

---

**(E) Ce que la passe adversariale a corrigé, vérifié ici commande par commande.**

**K6 était faux — je le retire.** J'avais écrit que nommer le fichier en conflit exigeait un nouvel
endpoint. `/api/hot-files` (`src/http/handle-rest.ts:77`) est routé, **absent** de
`MUTATING_ROUTES` (donc joignable sans POST), présent dans `isPoll`, et
`FileTracker.getHotFiles()` renvoie déjà `{ file_path, agent_count, agents[] }`. **La ligne
pourrait nommer les fichiers sans une ligne de code serveur.** Cela ne sauve pas la fiche, mais
c'était une erreur de ma part et de la §5.

**Les deux fenêtres affichées sont arithmétiquement incohérentes.** `listOnline` filtre à
**900 s** ; `getHotFiles(org, 30)` regarde **30 minutes** et n'émet une ligne que si
`HAVING COUNT(DISTINCT agent_id) > 1` :

```sql
WHERE org_id = ? AND created_at > datetime('now','-' || ? || ' minutes')
GROUP BY file_path
HAVING COUNT(DISTINCT agent_id) > 1
```

Un « fichier chaud » exige donc **≥ 2 agents distincts**, alors qu'`online` peut être retombé à 1.
La ligne peut afficher `online: 1 · hot: 1` — un état que l'utilisateur réfute mentalement en une
seconde. C'est K4 en pire que ce que la fiche anticipait.

**Et rien ne réduit ce mensonge.** Le commentaire de `listOnline` le dit lui-même
(`src/agent-registry.ts:80-90`) : *« an MQTT last-will that real agents do not register »* et
*« This is a read-time filter, **not a sweeper**: no background job »*.

**Le dashboard domine strictement.** `dashboard/public/dashboard.js:673` rend déjà
`` `${f.file_path} … ${f.agent_count} agents` `` — les **noms** —, rafraîchi toutes les 5 s, en plus
d'un flux SSE. La status line n'apporterait qu'un sur-ensemble vide : moins d'information, moins
frais, dans une fenêtre qu'on n'a pas besoin d'ouvrir. C'est un gain d'ergonomie, pas
d'architecture.

**Le besoin de scoping par dépôt (§4.3) est réel, et pire que décrit.** Vérifié :
`wait_for_peers` (`src/tools/status-tools.ts:111`) fait
`registry.listOnline(claims.org).filter(a => a.id !== agent_id)` — **org seule, aucune notion de
dépôt**. Et comme `normalizePath` rend des chemins **repo-relatifs** et que `getHotFiles` fait
`GROUP BY file_path`, `src/index.ts` du dépôt A et `src/index.ts` du dépôt B sont **la même
ligne** : deux agents sur deux dépôts sans rapport produisent un **conflit fantôme**.

**Et « un daemon = un checkout » n'est pas atteignable aujourd'hui** : `server.pid` est écrit et lu
sur un chemin **unique**, indépendant de `--port` et `--data-dir`, en 6 endroits
(`cli/server/{start,stop,restart,status,backup}.ts`). Lancer un second daemon pour un second dépôt
écrase le PID du premier, et `server stop` tue le mauvais processus.

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

**(F) Correction de mon propre K2 — il visait la mauvaise cause.** Le second réfutateur a
identifié le coupable et je l'ai remesuré ici :

```
node -e 0 (plancher)                          61 ms
import src/boot.js                           758 ms      <-- ~697 ms de graphe serveur
import cli/init.js                           796 ms
CLI complet (--version)                    1 059 ms
node + require('http') seul                   63 ms      <-- ce que coute un chemin paresseux
```

`cli/init.ts:7` fait `import { bootPhase2 } from "../src/boot.js"`, et `cli/index.ts` importe les
11 sous-commandes **à froid**. Le graphe d'auth complet (providers GitHub/Google/OIDC, rate
limiters, audit-chain, sweeper, chiffrement) est chargé pour afficher `--version`.

> **K2 ne disqualifie donc pas « une commande Node » — il disqualifie `dist/cli/index.js` tel
> qu'écrit aujourd'hui.** Un chemin paresseux coûte **63 ms**, soit 5× sous le seuil de 300 ms.
> Mon attribution était fausse.

Et ce défaut dépasse largement cette fiche : **toute** invocation de `mcp-coordinator` —
`doctor`, `channel`, `server status`, complétion shell — paie ~700 ms pour un graphe qu'elle
n'utilise pas.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** (en tant que feature) |
| **Date** | 2026-08-15 |
| **Justification** | Bénéfice net ≈ 0, mesuré : dominé par le dashboard, incohérent avec lui-même, et vide dans le profil dominant. Voir §7.1. |
| **Issue / PR** | aucune pour la feature (refusée). Deux constats **extraits** : [#278](https://github.com/swoofer/mcp-coordinator/issues/278) (taxe CLI ~700 ms) et [#279](https://github.com/swoofer/mcp-coordinator/issues/279) (scoping par dépôt) |
| **Jalon visé** | aucun |

### 7.1 Pourquoi refuser

Quatre raisons mesurées, pas une seule d'opinion :

1. **Le dashboard domine strictement.** `dashboard/public/dashboard.js:673` affiche déjà
   `` `${f.file_path} … ${f.agent_count} agents` `` — **les noms** — rafraîchi toutes les 5 s, plus
   un flux SSE. La status line offrirait moins d'information, moins fraîche. Le seul gain réel est
   « pas de seconde fenêtre » : de l'ergonomie, pas de l'architecture.
2. **La ligne serait incohérente avec elle-même.** `listOnline` filtre à 900 s ; `getHotFiles`
   regarde 30 min avec `HAVING COUNT(DISTINCT agent_id) > 1`. `online: 1 · hot: 1` est donc
   affichable — et absurde. Et rien ne corrige la dérive : le code dit lui-même *« not a sweeper »*
   et *« an MQTT last-will that real agents do not register »*.
3. **Elle est vide chez son lecteur type.** Profil solo : `online = 1`, `open_threads = 0`. Pour
   éviter d'afficher du bruit permanent, tout snippet raisonnable filtre sur `online > 1` — donc
   n'affiche **rien**.
4. **Elle ne parle pas à l'agent.** « Zéro token » signifie littéralement « aucun effet sur le
   comportement du modèle ». La contrainte est le sujet de [`C01`](C01-hook-mcp-tool-gate.md), dont
   ce challenge vient de prouver qu'il peut, lui, bloquer un `Write`.

**Le classement T1-incontournable / effort S ne tient pas** — et la fiche s'auto-neutralise en §4 :
*« Risque si on ne fait rien : aucun »*. Un T1 « incontournable » sans risque d'inaction est une
contradiction.

**Condition de réveil :** si un utilisateur le demande, la bonne forme n'est ni notre commande ni un
snippet collé dans `statusLine`, mais le widget `custom-command` de **`ccstatusline`** — l'outil que
le mainteneur a déjà installé dans ce slot. Il compose au lieu d'écraser, ce qui contourne K5 au
lieu de le subir. À condition d'avoir d'abord réglé §7.3 (1) : `ccstatusline` applique un `timeout`
d'1 s par widget, et notre CLI à 1 059 ms afficherait `[Timeout]`.

### 7.2 Ce que j'ai eu faux, et qui est corrigé dans la fiche

- **K6 était faux.** J'ai écrit que nommer le fichier en conflit exigeait un nouvel endpoint.
  `/api/hot-files` est joignable, hors `MUTATING_ROUTES`, et renvoie déjà
  `{file_path, agent_count, agents[]}`. La §5 de la fiche portait la même erreur.
- **K2 visait la mauvaise cause** (§6.4 F) : le coût n'est pas « une commande Node », c'est notre
  graphe d'imports.
- **La §0 surestime la testabilité** : la capture du payload stdin **n'est pas** exécutable ici, la
  status line ne se déclenchant pas en `claude -p`.
- **La §2 présente `subagentStatusLine` comme une piste à exploiter.** Vérification faite : c'est un
  formateur de lignes du panneau de subagents, avec un payload différent, qui ne rend rien quand
  aucun subagent ne tourne. Ce n'est pas un emplacement d'affichage libre.

### 7.3 Les deux constats à extraire — c'est le vrai livrable

Ni l'un ni l'autre n'appartient à la status line ; tous deux ont été trouvés en la challengeant.

1. **Le CLI paie ~700 ms de graphe serveur à chaque invocation.** `cli/init.ts:7` importe
   `../src/boot.js` (758 ms mesurés contre 61 ms de plancher), et `cli/index.ts` charge ses 11
   sous-commandes à froid. `doctor`, `channel`, `server status` et la complétion shell paient tous
   cette taxe. Correctif plausible : import paresseux par sous-commande.
2. **Le scoping par dépôt n'existe pas, et produit des faux positifs aujourd'hui.** Zéro occurrence
   de `repo_id`/`project_id` dans tout le dépôt ; `wait_for_peers`
   (`src/tools/status-tools.ts:111`) ne filtre que sur l'org ; et comme `normalizePath` rend des
   chemins **repo-relatifs** et que `getHotFiles` fait `GROUP BY file_path`, `src/index.ts` de deux
   dépôts distincts fusionnent en une seule ligne → **conflit fantôme**. Aggravant : « un daemon =
   un checkout » n'est pas atteignable, `server.pid` étant écrit sur un chemin **unique**,
   indépendant de `--port` et `--data-dir` (6 sites dans `cli/server/`).
   **La clé doit venir de `register_agent`/SDK — jamais de `workspace.repo.*`**, qui est
   mono-vendor, absent sans remote `origin`, identique pour deux worktrees du même dépôt (le cas
   [`D03`](D03-threat-native-worktrees.md)), et qu'une status line — canal stdout vers l'humain —
   ne peut de toute façon pas transmettre au serveur. À rapprocher de
   [`C13`](C13-agent-roster-reconciliation.md).

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : noms de champs tous confirmés, 3 `(à vérifier)` tranchés, statut GA maintenu, fiche testable. |
| 2026-08-15 | **Challenge tranché : refuser en tant que feature.** Bénéfice net ≈ 0, mesuré : le dashboard affiche déjà les **noms** de fichiers toutes les 5 s via SSE ; la ligne serait incohérente avec elle-même (`online` à 900 s vs `hot_files` à 30 min avec `HAVING agent_count > 1`, donc `online:1 · hot:1` affichable) ; elle est **vide** en profil solo ; et « zéro token » veut dire « aucun effet sur l'agent ». Le classement T1/S ne tient pas — la fiche dit elle-même « Risque si on ne fait rien : aucun ». Serveur confirmé gratuit (`/api/status` : **200 sans token en 7 ms**). Slot déjà occupé chez le mainteneur (`ccstatusline`). **Deux de mes propres conclusions corrigées** : K6 était faux (`/api/hot-files` nomme déjà les fichiers, sans code serveur), et K2 visait la mauvaise cause — les 1 059 ms sont ~700 ms de `src/boot.js` importé par `cli/init.ts`, pas une fatalité de Node (chemin paresseux : **63 ms**). **Deux constats extraits**, qui sont le vrai livrable : la taxe de ~700 ms sur **toute** invocation du CLI, et l'absence de scoping par dépôt qui produit des **conflits fantômes** entre dépôts distincts (`GROUP BY file_path` sur des chemins repo-relatifs) — clé à faire venir de `register_agent`, jamais de `workspace.repo.*`. Verdict passé au feu de 2 réfutateurs. |
