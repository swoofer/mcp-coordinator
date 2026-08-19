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
| **Statut du challenge** | ✅ **tranché** (2026-08-16) — recadrage ; K3 ne se déclenche pas, la persistance inter-session tient |

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

*Pré-enregistrée le 2026-08-16, **avant** toute exécution.*

> ⚠️ **Position particulière de ce challenge :** je suis l'outil que la fiche instruit. Cette session
> tourne avec `ultracode` actif et a lancé une vingtaine de sous-agents adversariaux. Le risque n'est
> donc pas le manque de matière, c'est le **biais du praticien** : confondre « je m'en sers » avec
> « c'est bon pour le projet ». Les critères ci-dessous sont écrits contre ce biais.

**Ce que je crois qu'il va se passer.**

1. La prémisse de §6.1 est **exacte** : le script de workflow n'a ni FS, ni shell, ni `import()`.
   C'est écrit dans le contrat de l'outil livré, et c'est vérifiable.
2. **Mais elle ne conduit pas à la conclusion que §6.1 en tire.** Les sous-agents, eux, atteignent
   les outils MCP de la session. Le pré-check peut donc vivre dans un workflow — par les sous-agents,
   pas par le script.
3. Le vrai recouvrement n'est pas l'orchestration : c'est que le natif rend l'orchestration
   **intra-session** triviale, donc dévalue toute orchestration maison qui ne survit pas à la session.
4. Notre différenciateur restant est la **persistance inter-session**, pas le parallélisme.

**Verdict pressenti :** réponse = **recadrage** — abandonner l'idée d'un workflow de référence en
plugin, se repositionner sur ce qui survit à la fin de la session.

**Critères de mort — écrits contre mon biais de praticien.**

| # | Si… | …alors |
|---|---|---|
| **K1** | un sous-agent de workflow **ne peut pas** appeler un outil MCP du coordinateur | la branche « pré-check dans le workflow » est morte, et §6.1 a raison. |
| **K2** | le script de workflow a un accès FS ou shell | la prémisse de §6.1 est fausse et toute la question est mal posée. |
| **K3** | le natif **persiste** l'état d'orchestration entre deux sessions | notre dernier différenciateur tombe — **c'est le pire cas**, et je dois l'écrire sans l'adoucir. |
| **K4** | un workflow de référence en plugin coûte plus de **8 fichiers** | la branche « livrer un workflow » est disqualifiée par le coût. |
| **K5** | aucun utilisateur n'a demandé d'orchestration parallèle | filtre YAGNI — et mon usage personnel **ne compte pas** comme demande, cf. la leçon de `C12`. |
| **K6** | l'orchestration native est derrière un flag distant | même réserve de durabilité que `C03`/`C05`/`D02` : on ne bâtit pas dessus. |

### 6.3 Protocole de vérification

<Proposition de la veille : à confirmer ou remplacer pendant le challenge.>

- [ ] Écrire un `.claude/workflows/coord-smoke.js` minimal (`export const meta`, `pipeline()` sur 3 fichiers) et vérifier qu'un sous-agent peut réellement appeler un outil MCP mcp-coordinator sans interrompre le run — et ce qui se passe **exactement** quand l'outil n'est pas dans l'allowlist.
- [ ] Lancer un run de 16 sous-agents annonçant chacun un fichier différent, puis mesurer : nombre de lignes `layer_firings`, nombre d'events SSE `impact_scored` émis, latence de `announce_work` au 16e appel.
- [ ] Refaire le même run avec 16 agents visant **le même** fichier et vérifier que `conflictDetector.detect()` produit bien un `file_overlap` avant l'edit, et non après.
- [ ] Compter les lignes restantes dans `agents` après le run, et confirmer que le sweeper ne les retire jamais (`src/sweeper/index.ts`).
- [ ] Tuer Claude Code en plein run, relancer, et observer si le replay ré-annonce des threads déjà ouverts (doublons dans `threads`).

### 6.4 Résultat observé

*Challenge du 2026-08-16. Claude Code **2.1.233**. Un workflow réel a été lancé pour cette fiche.*

#### A. Le bac à sable du script est **total**, et contrôlé en partie **au parsing**

Mesuré en exécutant un workflow :

```
require → "ReferenceError: require is not defined"
process → undefined
fetch   → undefined
```

Et deux constructions sont rejetées **avant tout lancement** :

```
SyntaxError: import() is not available in workflow scripts.
Date.now()/Math.random()/new Date() are unavailable (breaks resume)
```

**K2 ne se déclenche pas** : la prémisse de §6.1 est confirmée. Mais elle est **plus forte que ce que
la fiche énonce**, et pour une raison qu'elle n'avait pas identifiée : l'interdiction de `Date.now()`
n'est pas défensive, c'est un **contrat de déterminisme** — le moteur rejoue le préfixe inchangé des
appels d'agents à la reprise, donc le script doit être reproductible.

#### B. 🔴 K1 tombe — mais **par le contrat**, pas par ma mesure

Ma sonde n'a **pas** pu tester K1 : **aucun serveur mcp-coordinator n'est connecté à cette session**
(les serveurs présents sont `claude-in-chrome`, `computer-use`, `mcp-registry`, etc.). Le sous-agent
l'a signalé lui-même, et il a aussi noté que `Bash` figurait déjà dans sa liste avant mon
`ToolSearch` — mon test ne prouvait donc pas le chargement différé.

La réponse vient du contrat de l'outil, verbatim :

> « Workflow agents can reach all session-connected MCP tools via ToolSearch — schemas load on demand
> per agent. **Caveat: interactively-authenticated MCP servers (e.g. claude.ai) may be absent in
> headless/cron runs.** »

**K1 ne se déclenche pas.** Mais deux réserves à écrire honnêtement :

1. **C'est une chaîne de contrat, pas un run.** Plus fort que rien, moins fort qu'une mesure.
2. **Le caveat nous vise directement.** `mcp-coordinator` s'authentifie en OAuth. S'il tombe dans la
   classe « interactively-authenticated », les sous-agents le **perdent en run headless ou cron** —
   c'est-à-dire précisément dans les runs non supervisés. Point de protocole absent de §6.3.

#### C. 🔴 K3 ne se déclenche pas — le différenciateur tient, et c'est écrit dans le contrat

Mon critère du pire cas demandait si le natif persiste l'état d'orchestration entre deux sessions.
Le contrat de `resumeFromRunId` répond :

> « Completed agent() calls with unchanged (prompt, opts) return their cached results instantly […]
> **Same-session only.** »

Vérifié sur disque : les journaux vivent sous `…/projects/<projet>/<UUID-de-session>/workflows/`.
L'UUID **est** celui de la session. Les fichiers survivent — ce sont des artefacts forensiques — mais
**l'état résumable est verrouillé sur la session courante**.

**La persistance inter-session reste notre différenciateur.** Une fissure à surveiller, non instruite
par la fiche : le mode `remote: true` dispatche vers l'infrastructure cloud, et c'est le seul endroit
où le handle de reprise est une **URL de session cloud** — donc de l'état qui survit à la session.

#### D. 🔴 Mon argument se retourne contre le produit, et je dois l'écrire

J'allais qualifier le pré-check par sous-agent de « garde-fou fantôme ». **Deux erreurs.**

**Le label est faux.** `audit/00-SYNTHESE.md` réserve ce terme à un contrôle « écrit, testé, documenté,
mais **jamais vérifié en intégration réelle** » — un défaut de *câblage*. `announce_work` est
parfaitement câblé ; l'audit le loue même.

**Et l'argument, correctement nommé, condamne d'abord notre propre produit.** Le bon cadrage est celui
de notre synthèse, `00-SYNTHESE.md` l. 62 : *« Un projet qui détecte les conflits mais ne peut pas les
empêcher vend un rapport. »* Reprocher au natif qu'un pré-check dépende du bon vouloir de l'agent
décrit `announce_work` **à la virgule près** — et c'est mesuré chez nous : `C06` a relevé
**0 annonce spontanée sur 12 runs** sans `instructions`, et **0 sur 3** même avec, sur une tâche à
écriture immédiate. Vérifié en outre : `src/http/rest-handlers.ts` contient **zéro** appel à
`detect()` — le chemin REST d'annonce n'exécute même pas la détection.

La seule asymétrie réelle qui subsiste : dans un workflow, le pré-check est écrit **une fois dans le
script**, que l'humain voit dans le dialogue de permission **avant** lancement. C'est plus
déterministe qu'une supplique adressée à chaque agent. Cela nuance l'argument ; cela ne le sauve pas.

#### E. 🔴 L'argument central de §4 est mort : la primitive « manquante » existe

§4 affirme qu'il n'y a « aucune détection de conflit côté runtime » et que le dépôt « a déjà exactement
la primitive qui manque ». **Faux depuis la version installée.** Le contrat expose, **par appel
`agent()`** :

> « `opts.isolation: 'worktree'` runs the agent in a fresh git worktree — EXPENSIVE (~200-500 ms setup
> + disk per agent), **use ONLY when agents mutate files in parallel and would otherwise conflict** »

Ce n'est pas une option de `/batch` : c'est une option de premier rang sur chaque agent, avec une
consigne explicite au modèle sur *quand* la prendre. La prémisse porteuse de §4 perd son objet.

#### F. L'hypothèse inverse — instruite, puis écartée

J'ai fait instruire l'hypothèse que `ultracode` et les workflows, en lançant N agents en parallèle sur
le même dépôt, **renforceraient** la valeur du coordinateur au lieu de la menacer. Mécaniquement elle
est vraie : arbre partagé, `acceptEdits`, jusqu'à 16 concurrents — la surface de conflit grandit.

Elle ne se convertit pas en valeur, pour trois raisons :

1. **Le remède natif est in-band et moins cher** : 200-500 ms et un flag dans le script, contre un
   daemon + SQLite + MQTT et un aller-retour d'annonce par item.
2. **Les conflits créés sont intra-session, un humain, une machine** — exactement le segment que
   `D01` vient de concéder. L'hypothèse renforce un terrain déjà cédé.
3. **La décision se prend à l'écriture du script**, visible avant lancement. Un pré-check par
   sous-agent est strictement pire pour le même résultat.

#### G. K5 se déclenche · K6 se déclenche, mais **plus faiblement** qu'ailleurs

- **K5 :** 79 issues, 76 du mainteneur, 3 externes. Recherches `orchestration`, `subagent`,
  `ultracode`, `swarm`, `pipeline` → **0**. **Et le détail vaut mieux que le compte** : les trois
  seuls signaux externes portent sur la **persistance et la fiabilité de l'état partagé**. Nos
  utilisateurs ont déjà voté pour le repositionnement.
- **K6 :** l'orchestration est gouvernée par `tengu_workflows_enabled` — mais son défaut est **`true`**.
  C'est un **kill switch**, pas un gate de déploiement progressif. La réserve de durabilité est donc
  **réelle mais plus faible** que sur `C03`, `C05` ou `D02`, où le défaut était fermé. L'écrire au même
  niveau serait surinterpréter.

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
| **Verdict** | **Réponse : recadrage** — abandonner le workflow de référence, se repositionner sur ce qui survit à la session. ⬜ contre-mesure technique · ✅ **recadrage** · ⬜ recouvrement assumé |
| **Date** | 2026-08-16 |
| **Justification** | **K3 ne se déclenche pas** : la reprise de workflow est **`Same-session only`** par contrat, et les journaux sont séquestrés sous l'UUID de session. **La persistance inter-session tient donc comme différenciateur**, et c'est le résultat le plus important de la fiche. K1 tombe **par le contrat** — les sous-agents atteignent les outils MCP de la session — mais avec un caveat qui nous vise : les serveurs **authentifiés interactivement** peuvent être absents en run headless ou cron. K5 se déclenche (0 demande externe sur 79 issues), et l'argument central de §4 est **mort** : `isolation: 'worktree'` existe comme option de premier rang. |
| **Issue / PR** | aucune |
| **Jalon visé** | réécriture de §4 avant réutilisation |

### La frontière factuelle

**Ce que le natif fait** : orchestration parallèle jusqu'à 16 agents concurrents, script déterministe
et intégralement bacs-à-sable, sous-agents atteignant les outils MCP de la session, isolation par
worktree en option par agent, et **reprise d'un run interrompu**.

**Ce que le natif ne fait pas** : rien ne survit à la session. La reprise est `Same-session only`,
l'état vit sous l'UUID de session, et il n'existe ni notion d'organisation, ni d'humain tiers, ni de
chaîne d'audit.

**Ce qui reste défendable** : **la persistance inter-session et inter-humaine.** Rien d'autre — et
c'est exactement ce que les trois seuls retours utilisateurs externes du projet demandent
(persistance, fiabilité de l'état partagé).

### Ce qui est abandonné

**Le workflow de référence livré en plugin.** Non pas parce qu'il serait techniquement impossible —
K1 montre qu'il l'est — mais parce que : personne ne l'a demandé (K5), la primitive qu'il devait
apporter existe désormais nativement (`isolation: 'worktree'`, §6.4-E), et le pré-check qu'il porterait
ne contraindrait rien de plus que ce que nous avons déjà.

### 🔴 Ce que ce challenge établit **contre** le projet

Mon reproche au natif — « un pré-check qui dépend du bon vouloir de l'agent est un espoir, pas une
garantie » — **décrit `announce_work` à la virgule près**. Et c'est mesuré chez nous : `C06` a relevé
**0 annonce spontanée sur 12 runs**, et 0 sur 3 même avec `instructions`. Le chemin REST d'annonce
n'appelle même pas `detect()`.

Notre propre synthèse l'avait déjà écrit : *« un projet qui détecte les conflits mais ne peut pas les
empêcher vend un rapport »*. Ce challenge le confirme par la mesure, et il en tire la conséquence :
**le vrai chantier n'est pas d'orchestrer, c'est de contraindre** — donc `PreToolUse` (`C01`), déjà
identifié, et déjà confirmé comme seule protection possible par `D02`.

### Corrections obligatoires

- **§4 : l'argument central est mort.** « Aucune détection de conflit côté runtime » et « le dépôt a
  déjà exactement la primitive qui manque » sont faux depuis `isolation: 'worktree'`.
- **§6.3 : ajouter un point de protocole** — mesurer si un serveur MCP authentifié en OAuth reste
  atteignable par un sous-agent en run headless/cron. C'est le seul risque opérationnel réel.
- **§1/§2 : la menace structurelle est mal située.** Ce n'est pas l'orchestration : c'est qu'Anthropic
  construit un **canal de distribution** (champ `workflows` du manifeste plugin) et un **mode de
  verrouillage entreprise**. Aucun des deux ne nous menace aujourd'hui, mais c'est la direction.

### Note de méthode — le biais du praticien, et une étiquette fausse

J'avais pré-enregistré que le risque de cette fiche était **le biais du praticien** : je suis l'outil
qu'elle instruit, cette session tourne avec `ultracode` et a lancé une vingtaine de sous-agents. Ce
garde-fou a servi — mon critère K5 disait explicitement que mon usage personnel ne compte pas comme
demande, et K5 s'est déclenché.

Mais j'ai commis deux fautes que la passe adversariale a corrigées. **J'ai emprunté une étiquette qui
ne s'appliquait pas** — « garde-fou fantôme » désigne un défaut de câblage dans l'audit du projet, pas
un défaut de contrainte. Et **je n'avais pas vu que mon argument se retournait contre le produit** :
c'est la faute la plus utile de ce challenge, parce qu'elle transforme une fiche « menace » en
confirmation d'un chantier interne déjà identifié.

Enfin, **j'ai failli présenter comme mesuré ce qui relève du contrat** : K1 n'a pas été testé — aucun
serveur mcp-coordinator n'était connecté à la session. Quatrième fois de ce corpus que je dois
distinguer ce que j'ai exécuté de ce que j'ai lu.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : statut GA et §5 confirmés ligne à ligne ; options SDK `Workflow` partiellement tranchées ; testable localement. |
| 2026-08-16 | **Challenge — réponse : recadrage.** Workflow réellement lancé. Bac à sable du script **total** et contrôlé en partie **au parsing** (`require` → ReferenceError, `process`/`fetch` undefined, `import()` et `Date.now()` rejetés avant lancement) : la prémisse de §6.1 tient, et l'interdiction de `Date.now()` est un **contrat de déterminisme**, pas une mesure défensive. **K3 ne se déclenche pas** — la reprise est `Same-session only` par contrat, journaux séquestrés sous l'UUID de session : **la persistance inter-session tient comme différenciateur**. K1 tombe **par le contrat** et non par ma mesure (aucun serveur mcp-coordinator n'était connecté), avec un caveat qui nous vise : les serveurs authentifiés interactivement peuvent être absents en headless/cron. **L'argument central de §4 est mort** : `isolation: 'worktree'` existe comme option de premier rang par agent. K5 déclenché (0 demande externe sur 79 issues ; les 3 signaux externes portent sur la persistance — les utilisateurs ont déjà voté pour le repositionnement). K6 déclenché mais **plus faiblement** qu'ailleurs : `tengu_workflows_enabled` a pour défaut `true`, c'est un kill switch et non un gate de déploiement. **Et l'argument se retourne contre nous** : mon reproche au natif décrit `announce_work` à la virgule près — `C06` a mesuré 0 annonce spontanée sur 12 runs, et le chemin REST n'appelle même pas `detect()`. Étiquette « garde-fou fantôme » retirée : elle désigne un défaut de câblage, pas de contrainte. Hypothèse inverse (les workflows renforceraient le coordinateur) instruite puis écartée. |
