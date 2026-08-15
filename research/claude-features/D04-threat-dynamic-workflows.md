# D04 — Dynamic workflows, `ultracode` et `/batch` : l'orchestration parallèle native

| Champ | Valeur |
|---|---|
| **ID** | `threat-dynamic-workflows` |
| **Surface** | claude-code · agent-sdk |
| **Statut** | **GA** — disponible sur tous les plans payants (opt-in via `/config` sur Pro), API Anthropic, Bedrock, Google Agent Platform, Microsoft Foundry. Voir §2 pour la contradiction entre chercheurs sur ce point. |
| **Disponible depuis** | Claude Code `v2.1.154` · mot-clé `ultracode` depuis `v2.1.160` (avant : `workflow`) · résolution monorepo `v2.1.178` · `workflowSizeGuideline` via `/config` `v2.1.202`, via fichier settings + défaut `medium` `v2.1.219` · `/effort ultracode` `v2.1.203` · déclenchement bloqué hors prompt humain depuis `v2.1.210` · outil `Workflow` dans le TS Agent SDK `v0.3.149+` |
| **Tier** | T1-incontournable |
| **Nature** | threat (avec un volet opportunity assumé en §4) |
| **Effort estimé** | M (L si on livre un workflow de référence packagé en plugin) |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — Claude Code v2.1.219 local, aucun accès fermé requis |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** ✅ saine

**Corrections apportées :**
- §2 — le marqueur `(à vérifier)` sur les options du tool `Workflow` du SDK TS est tranché **partiellement** : la référence documente qu'au moins un de `script`, `name` ou `scriptPath` est requis, et confirme la disponibilité en `v0.3.149+`. Le tableau complet des champs n'est pas récupérable (page `agent-sdk/typescript.md` tronquée à la récupération) → marqué `(non vérifiable — page tronquée)`.
- §2 — précision de provenance : les six patterns (`classify-and-act`, `fan-out-and-synthesize`, adversarial verification, `generate-and-filter`, tournament, loop-until-done) viennent du **billet de blog**, pas de `workflows.md`. Les six noms et leurs définitions sont confirmés mot pour mot.
- §2 / §5 — ajout de la porte de sortie `origin: { kind: "human" }` du SDK TS : le blocage hors prompt humain n'est pas absolu, une application Agent SDK qui estampille son entrée comme humaine déclenche bien un workflow. La ligne `cli/channel.ts` disait « fermé côté Anthropic » sans cette réserve.

**Faits re-confirmés sans changement :** statut GA (aucune mention *preview*/*beta* sur `workflows.md`, plans payants + API + Bedrock + Google Agent Platform + Microsoft Foundry) ; toutes les versions de l'en-tête ; tool `Workflow` présent dans `tools-reference` ; `agent()`/`pipeline()`/`args`/`export const meta` ; 16 concurrents / 1000 par run / pas d'`import()` / pas de FS ni shell / `acceptEdits` ; seuil advisory 25 agents ou 1,5 M tokens ; `workflowSizeGuideline` défaut `medium` ; `disableWorkflows`, `CLAUDE_CODE_DISABLE_WORKFLOWS`, `CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS` (5000), `CLAUDE_CODE_SUBAGENT_MODEL`, `disableBundledSkills` (retire bien skills **et** workflows bundlés) ; `/batch` (5–30 agents worktree, une PR chacun) ; redémarrage à zéro après sortie de session.

**§5 — points d'intégration :** les 12 lignes ont été rouvertes une à une. Tous les fichiers existent, tous les numéros de ligne pointent juste : `consultation-tools.ts` `server.tool("announce_work")` l. 36 et `conflictDetector.detect()` l. 105 ; `mqtt-tools.ts` `wait_for_message` l. 52-77 (défaut 15 s, capé) ; `rest-handlers.ts:739` `DELETE FROM agents` ; `cli/init.ts` l. 225 écrit/fusionne `.mcp.json` et **aucune** occurrence de `permissions` dans tout le fichier ; `agent-registry.ts:12` `DEFAULT_ONLINE_TTL_SECONDS = 900` ; `database.ts:593` `CREATE UNIQUE INDEX idx_agents_id ON agents(id)` sans portée org (marqué LOAD-BEARING) ; sweeper 11 tables, `file_activity` 7 j, `agents` absente ; `quota-cache.ts` `DEFAULT_TTL_MS = 120_000` et cooldown 429 de 5 min, fail-open ; `conflict-detector.ts` balaie bien tous les threads non `cancelled` + un `checkFileConflict` par fichier, sans batching ; `announce-workflow.ts` insère par agent scoré dans `layer_firings` et émet un SSE `impact_scored` par agent. Aucun répertoire `workflows/` ni manifeste de plugin à la racine — confirmé.

**Marqueurs `(à vérifier)` restants :** un seul, requalifié en `(non vérifiable — page tronquée)` : le jeu complet des champs du tool `Workflow` dans la référence Agent SDK TypeScript.

**Testabilité :** ✅ testable
Le poste a Claude Code **v2.1.219**, exactement la version qui porte tout ce que la fiche affirme (défaut `medium`, `/effort ultracode`, blocage hors prompt humain, résolution monorepo). Les cinq items du protocole §6.3 sont exécutables tels quels : écrire à la main `.claude/workflows/coord-smoke.js`, lancer le daemon local, et compter côté SQLite (`layer_firings`, `agents`, `threads`) plus les SSE. Aucun header beta, aucune research preview, aucun accès org n'est requis. Seule réserve, non bloquante : un run à 16 agents consomme du quota réel, et le plafond « 16 concurrents » dépend du nombre de CPU de la machine — mesurer la concurrence effective avant d'interpréter les latences.

---

## 1. Ce que c'est

Un *dynamic workflow* est un script JavaScript que Claude écrit à la volée et qu'un runtime exécute **en arrière-plan, hors du contexte de conversation**, pour orchestrer des dizaines à des centaines de sous-agents. Le corps du script est du JS simple avec `top-level await` ; deux globals font tout le travail : `agent(prompt, opts)` spawne un sous-agent, `pipeline(items, fn)` en lance un par élément d'une liste. Les résultats intermédiaires restent dans des variables de script et ne polluent donc jamais le contexte du modèle qui a écrit le plan.

Le runtime pose des contraintes dures : jusqu'à **16 agents concurrents** (« *fewer when Claude Code has fewer CPUs available* » — c'est un plafond, pas une garantie), **1000 agents par run**, pas d'`import()` (le script échoue *avant* démarrage), **aucun accès filesystem ni shell depuis le script lui-même**, et aucun input utilisateur en cours de run. Les sous-agents tournent **toujours en `acceptEdits`** et héritent de la tool allowlist de la session ; les commandes shell, web fetches et outils MCP hors allowlist peuvent malgré tout demander une permission en plein run.

Le déclenchement est opt-in : mot-clé `ultracode` dans un prompt **tapé par un humain**, `/effort ultracode`, ou une commande sauvegardée. Depuis `v2.1.210` le mot-clé est volontairement inerte via `-p`, tâche planifiée, webhook ou commentaire de PR. Les scripts se rangent dans `.claude/workflows/` (projet) ou `~/.claude/workflows/`, et se distribuent via le champ `workflows` d'un manifeste de plugin (namespace `/<plugin>:<meta.name>`).

Un skill livré, `/batch`, découpe un gros changement en 5 à 30 sous-agents **isolés en worktree**, chacun ouvrant sa propre PR. La garde anti-emballement est **advisory** : un avertissement `Large workflow` au-delà de ~25 agents ou ~1,5 M tokens projetés, sans pause. Au reprise (`resume`), le replay repart du premier agent non terminé — et si l'utilisateur quitte Claude Code pendant un run, la session suivante **redémarre le workflow de zéro**.

## 2. Surface d'API exacte

```
Workflow                                  # nom du tool, s'ajoute à allowedTools
agent(prompt, { schema?, label? })        # → null si stoppé ou erreur API irrécupérable
pipeline(items, fn)                       # un sous-agent par item
args                                      # global d'entrée ; undefined si omis
export const meta = { name, description } # en tête du script
```

```
.claude/workflows/          # projet (résolution monorepo depuis v2.1.178)
~/.claude/workflows/        # perso, respecte CLAUDE_CONFIG_DIR
<plugin>/workflows/         # champ `workflows` du manifeste → /<plugin>:<meta.name>
```

```
/workflows                  # liste + sauvegarde d'un run (touche `s`)
/deep-research
ultracode                   # mot-clé prompt (littéral `workflow` avant v2.1.160)
/effort ultracode           # et claude --effort ultracode (v2.1.203+) = xhigh + orchestration auto
```

Réglages et variables d'environnement :

```
workflowSizeGuideline = unrestricted | small | medium | large   # défaut `medium` depuis v2.1.219
disableWorkflows                                                # settings utilisateur ou managed
CLAUDE_CODE_DISABLE_WORKFLOWS
CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS                          # 5000 par défaut, 0 pour désactiver
CLAUDE_CODE_SUBAGENT_MODEL
disableBundledSkills / CLAUDE_CODE_DISABLE_BUNDLED_SKILLS       # retire aussi les workflows bundlés
```

Patterns documentés — les six noms sont confirmés, mais leur source est le **billet de blog Anthropic**, pas `workflows.md` : `classify-and-act`, `fan-out-and-synthesize`, `adversarial verification`, `generate-and-filter`, `tournament`, `loop-until-done`.

Entrée `Workflow` de la référence Agent SDK TypeScript (`v0.3.149+`) : **au moins un** de `script`, `name` ou `scriptPath` est requis. Le jeu complet des champs n'a pas pu être relevé *(non vérifiable — la page `agent-sdk/typescript.md` est tronquée à la récupération, la section « Tool input schemas » n'est pas atteignable)*.

Point de sortie du blocage « prompt humain » : le mot-clé reste actif dans une application Agent SDK qui estampille l'entrée clavier avec `origin` = `{ kind: "human" }` (type `SDKMessageOrigin`). Le blocage `-p` / tâche planifiée / webhook / commentaire de PR n'est donc pas une impossibilité technique absolue.

**Contradictions entre chercheurs, à ne pas masquer :**
1. **Statut** — deux fiches brutes normalisent le statut en `research-preview`. Les vérificateurs l'ont explicitement infirmé : la doc ne porte aucune mention *preview*/*beta*, la feature est GA. On retient **GA**.
2. **« Allowlist par défaut »** — un chercheur affirme qu'on peut positionner les outils mcp-coordinator comme allowlistés-par-défaut pour ne pas casser un run de 1000 agents. Le vérificateur le réfute : aucun mécanisme documenté ne permet ça, l'utilisateur doit ajouter les outils à sa propre allowlist avant le run. Le levier réel est **un guide de configuration**, pas une propriété acquise.
3. **`since`** — la date du 28 mai 2026 et le lien avec Opus 4.8 ne sont pas dans la doc officielle (presse secondaire seulement). Seules les versions listées dans l'en-tête sont confirmées.

## 3. Sources

- https://code.claude.com/docs/en/workflows.md
- https://code.claude.com/docs/en/tools-reference.md
- https://code.claude.com/docs/en/agents.md
- https://code.claude.com/docs/en/agent-sdk/subagents.md
- https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code
- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- https://code.claude.com/docs/en/env-vars · https://code.claude.com/docs/en/settings

*(Source écartée par la vérification : `https://platform.claude.com/docs/en/release-notes/api` — redirige vers les release notes plateforme et ne mentionne ni dynamic workflows ni ultracode.)*

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
C'est le seul endroit où le pitch du projet se vérifie tout seul : jusqu'à 16 sous-agents concurrents, **tous en `acceptEdits`**, sur le même working tree, sans **aucune** détection de conflit côté runtime — la doc se contente de recommander « *working on each file in its own isolated copy* ». Le repo a déjà exactement la primitive qui manque : `conflictDetector.detect()` (`src/conflict-detector.ts`) appelé dans le handler `announce_work` (`src/tools/consultation-tools.ts:105`), plus `check_file_conflict` et `hot_files` (`src/tools/files-tools.ts`). Un workflow de référence distribué en plugin — qui annonce chaque item avant de spawner l'agent et ne laisse `pipeline()` avancer que sur les items non conflictuels — est un livrable autonome, et surtout la démonstration que le maintainer n'a pas encore : « voilà le run de 30 agents qui ne s'écrase pas ». Aucun code existant ne disparaît ; c'est du nouveau packaging (répertoire `workflows/` + manifeste plugin, absents du repo à ce jour).

**Risque si on ne fait rien :**
Le risque n'est pas frontal, il est **de cadrage**. `/batch` fait déjà « plusieurs agents modifient le même repo en parallèle » avec isolation worktree et une PR par agent, gratuitement, sans serveur, sans daemon, sans MQTT, sans SQLite. Pour la migration de masse — le cas d'usage vitrine de mcp-coordinator — Anthropic a une réponse native et plus simple, et le lecteur de la README conclura que le daemon n'apporte rien. Ce que les workflows **ne** font pas doit donc être écrit noir sur blanc, sinon personne ne le devinera : rien ne survit à la sortie de session (« *the next session starts the workflow fresh* »), rien n'est partagé entre humains ou entre postes, les agents ne peuvent pas se parler (c'est le script qui tient le plan, il n'y a pas de canal latéral), et le garde-fou d'emballement est purement advisory. Le positionnement défendable est « coordination **inter**-session et inter-humain persistante », pas « parallélisme intra-session ». Risque secondaire, plus opérationnel : un run de 1000 agents qui annoncerait son travail ferait entrer dans le coordinateur un ordre de grandeur d'agents éphémères que le registre n'a jamais vu (§5).

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/tools/consultation-tools.ts` (l. 36-110) | `announce_work` est le seul point où `conflictDetector.detect()` tourne avant écriture. C'est l'appel que chaque itération de `pipeline()` devrait faire via son sous-agent — il n'y a pas d'appel en lot. |
| `src/conflict-detector.ts` | `detect()` balaie **tous** les threads non annulés (`consultation.listThreads`) plus une passe `checkFileConflict` par fichier cible. 16 annonces concurrentes = 16 balayages complets ; aucun batching. |
| `src/announce-workflow.ts` | `runCommonAnnounceFlow()` score l'impact contre **tous les agents en ligne**, insère une ligne `layer_firings` par agent scoré et émet un SSE `impact_scored` par agent. Coût O(agents en ligne) par annonce — à 16 pairs, chaque annonce émet ≥16 events. |
| `src/tools/files-tools.ts` | `check_file_conflict`, `hot_files`, `get_session_files` : le pré-check naturel dans un `pipeline()`, moins cher qu'une annonce complète. Nom exact `check_file_conflict` (pas `check_conflicts`). |
| `src/agent-registry.ts` | `DEFAULT_ONLINE_TTL_SECONDS = 900` (agent « en ligne » 15 min sans signe de vie) et index UNIQUE **global** sur `agents.id`. 16 à 1000 sous-agents éphémères ⇒ collisions d'ID probables et registre saturé d'agents fantômes pendant 15 min. |
| `src/sweeper/index.ts` | Balaie 11 tables dont `file_activity` (7 j) — **pas** `agents`. Le seul `DELETE FROM agents` du repo est le reset admin (`src/http/rest-handlers.ts:739`). Les agents d'un run de 1000 restent en base indéfiniment. |
| `src/tools/mqtt-tools.ts` (l. 52-77) | `wait_for_message` bloque (défaut 15 s, capé). Dans un sous-agent de workflow, aucun input utilisateur n'est possible : une attente de coordination ne peut être débloquée que par un autre agent, jamais par un humain. |
| `cli/channel.ts` | Les Channels poussent les events de coordination dans une session. Mais `ultracode` est inerte hors prompt humain (v2.1.210+) : **un event de channel relayé dans la conversation ne peut pas déclencher un workflow**. Réserve vérifiée : une application Agent SDK qui estampille son entrée avec `origin: { kind: "human" }` déclenche, elle, bel et bien. Le couplage push → orchestration est fermé pour le CLI, pas pour un intégrateur SDK. |
| `cli/init.ts` (l. ~225) | Écrit/fusionne `.mcp.json` mais n'écrit **aucune** entrée `permissions.allow`. Les outils du coordinateur ne sont donc pas allowlistés d'office et peuvent interrompre un run à mi-parcours. C'est l'endroit où un guide de configuration deviendrait exécutable. |
| `src/quota/quota-cache.ts` | Cache la quota OAuth Anthropic (TTL 120 s, cooldown 429 de 5 min, fail-open). Un run de 1000 agents est précisément le scénario où le signal quota devient actionnable côté orchestrateur. |
| `dashboard/public/dashboard.js` | Tient une map `state.agents` alimentée par SSE. Non dimensionnée pour des centaines d'agents éphémères apparaissant et disparaissant en rafale. |
| `package.json` / racine du repo | Aucun manifeste de plugin, aucun répertoire `workflows/`. Livrer un workflow de référence est un ajout de packaging, pas une modification de l'existant. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le pré-check de conflit peut-il vivre **dans** un workflow — c'est-à-dire uniquement via des appels `announce_work` / `check_file_conflict` que les sous-agents font eux-mêmes, puisque le script JS n'a ni FS, ni shell, ni `import()`, donc ne peut ni lire le repo ni appeler le SDK — ou bien le seul point d'accroche réellement fiable est-il un hook `PreToolUse` posé **hors** du script, auquel cas on abandonne le workflow de référence en plugin et on repositionne mcp-coordinator sur la persistance inter-session ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille : à confirmer ou remplacer pendant le challenge.>

- [ ] Écrire un `.claude/workflows/coord-smoke.js` minimal (`export const meta`, `pipeline()` sur 3 fichiers) et vérifier qu'un sous-agent peut réellement appeler un outil MCP mcp-coordinator sans interrompre le run — et ce qui se passe **exactement** quand l'outil n'est pas dans l'allowlist.
- [ ] Lancer un run de 16 sous-agents annonçant chacun un fichier différent, puis mesurer : nombre de lignes `layer_firings`, nombre d'events SSE `impact_scored` émis, latence de `announce_work` au 16e appel.
- [ ] Refaire le même run avec 16 agents visant **le même** fichier et vérifier que `conflictDetector.detect()` produit bien un `file_overlap` avant l'edit, et non après.
- [ ] Compter les lignes restantes dans `agents` après le run, et confirmer que le sweeper ne les retire jamais (`src/sweeper/index.ts`).
- [ ] Tuer Claude Code en plein run, relancer, et observer si le replay ré-annonce des threads déjà ouverts (doublons dans `threads`).

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Le script ne peut rien faire lui-même.** Pas de FS, pas de shell, pas d'`import()` : le workflow ne peut ni lire `.mcp.json`, ni appeler le SDK client (`sdk/src/client.ts`), ni interroger le daemon en HTTP. Toute la coordination passe par ce que les *sous-agents* veulent bien appeler — on n'a aucun point de contrôle dur, seulement de la persuasion par prompt. Un hook `PreToolUse` (fiche C01/C02) est structurellement plus fiable et ne dépend pas des workflows.
- **Le levier « allowlist » n'existe pas.** Vérifié et réfuté : rien ne permet à un serveur MCP d'être allowlisté d'office. Si l'utilisateur n'a pas configuré son allowlist, nos outils interrompent son run — on devient un *irritant* dans un run de 1000 agents, pas le canal de coordination.
- **Portabilité.** Un workflow est un artefact Claude Code exclusif. Le projet vise aussi les clients MCP tiers et les consommateurs MQTT (`examples/go-mqtt`, `python-mqtt`, `node-mqtt`, `github-actions-mqtt-bridge`). Un livrable non portable dilue le message « broker neutre ».
- **Pas d'automatisation possible.** `ultracode` inerte via `-p`, webhook, tâche planifiée ou commentaire de PR : impossible de déclencher un workflow coordonné depuis la CI ou depuis un event de channel. Le scénario « le daemon orchestre » est fermé par design.
- **YAGNI face à `/batch`.** L'isolation worktree + une PR par agent supprime le conflit d'écriture à la source. Si le problème est déjà résolu par la séparation physique, une détection de conflit sémantique est une solution à un problème que l'utilisateur n'a plus.
- **Le run est jetable, le daemon est persistant — mismatch.** Un workflow ne survit pas à la session. Le vrai différenciateur du projet (état partagé entre humains, entre postes, entre jours) n'est pas ce que le workflow demande. On risque d'optimiser pour la vitrine plutôt que pour la valeur.
- **Coût d'entrée non nul côté serveur.** Avant d'accepter des rafales d'agents éphémères, il faudrait au minimum une rétention/TTL sur `agents` (absente du sweeper), un chemin d'annonce en lot dans `conflict-detector.ts`, et une borne sur les émissions SSE par annonce. C'est un chantier `M`→`L` déclenché par une feature qu'on ne contrôle pas.
- **Cible mouvante.** Trois changements de comportement en moins de 70 versions (mot-clé, défaut `workflowSizeGuideline`, blocage hors prompt humain). Un workflow de référence publié devient de la dette de documentation à chaque release Claude Code.

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
| 2026-08-14 | Vérification des faits : statut GA et §5 confirmés ligne à ligne ; options SDK `Workflow` partiellement tranchées ; testable localement. |
