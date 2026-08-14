# C13 — Réconcilier l'agent-registry avec le réel : roster.json, Remote Control, /rewind

| Champ | Valeur |
|---|---|
| **ID** | `agent-roster-reconciliation` |
| **Surface** | claude-code |
| **Statut** | mixte — GA (agent view / daemon, checkpointing, Claude Tag) · research-preview (Remote Control, Routines) · **en retrait** : « Claude Code in Slack » (version historique) est retirée sur Team/Enterprise au profit de Claude Tag, et reste le chemin de setup sur Pro/Max |
| **Disponible depuis** | `/subtask` v2.1.212, `/code-review` en subagent bg v2.1.218, push+draft PR v2.1.198 (resserré en v2.1.221 : draft PR seulement « quand la tâche le demande ») ; Routines ≈ avril 2026 (header `experimental-cc-routine-2026-04-01`, date d'annonce publique non sourcée) ; Claude Tag enrichi août 2026 |
| **Tier** | T2-fort-levier |
| **Nature** | integration (avec une composante `threat` sur /rewind) |
| **Effort estimé** | M |
| **Confiance veille** | medium |
| **Vérification** | CONFIRMED (sauf le volet Routines : PLAUSIBLE, corrigé par le vérificateur) |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — Linux et les surfaces cloud (Routines, Slack) hors de portée |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **§2 / rewind — marqueur tranché.** Aucun hook n'expose un rewind : la liste documentée compte 31 événements (`SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, `SessionEnd`) et aucun ne concerne rewind / checkpoint / restore. Le fait est établi, pas seulement « non confirmé ».
- **§2 / checkpointing — noms d'API ajoutés.** La fiche ne citait qu'une « API de checkpointing fichier » sans nom. Les noms réels ont été ajoutés (`enableFileCheckpointing` / `enable_file_checkpointing`, `rewindFiles()` / `rewind_files()`, `--rewind-files`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `extraArgs: { "replay-user-messages": null }`).
- **§2 / roster — marqueur tranché.** La doc `agent-view` nomme bien les fichiers et leur rôle mais ne publie aucun schéma de champs : le marqueur devient un constat documenté, pas une question ouverte.
- **§4 / Slack — marqueur tranché.** La doc est explicite : une session lancée depuis Slack est créée **sur Claude Code on the web** (infrastructure Anthropic). Un serveur MCP stdio local est donc inatteignable ; seuls les connecteurs claude.ai ou un `.mcp.json` committé sont en jeu. Ce n'était pas « à vérifier », c'est tranché : non.
- **En-tête / statut.** « Slack & Claude Tag » en GA était trop plat : la version historique « Claude Code in Slack » est en cours de retrait sur Team/Enterprise au profit de Claude Tag, et ne reste le chemin de setup que sur Pro/Max.
- **En-tête / versions.** « push+draft PR v2.1.221 » était faux : le comportement a été introduit en **v2.1.198** (« commit, push, and open a draft PR ») ; v2.1.221 l'a au contraire **resserré** (draft PR seulement quand la tâche le demande).
- **§4 / dashboard.** `dashboard/public/dashboard.js:76` pointait sur `displayName()`, un simple lecteur de `state.agents`. Corrigé vers `:629`, où la liste d'agents est réellement rendue.
- **§5 / dashboard.** La plage `244-252` ne couvre que `agent_online` / `agent_offline` ; `agent_activity` est en `255-259`. Plage corrigée en `244-259`.

**Faits vérifiés sans correction nécessaire :** l'intégralité du bloc Routines de §2 (endpoint `POST /v1/claude_code/routines/{routine_id}/fire`, header `anthropic-beta: experimental-cc-routine-2026-04-01` obligatoire sous peine de `400 invalid_request_error`, token `sk-ant-oat01-`, champ `text` freeform non parsé, 65 536 caractères, réponse `routine_fire` / `claude_code_session_id` / `claude_code_session_url`, pas de SDK, pas d'idempotency key, cadence minimale 1 h, `/schedule` alias `/routines` avec `list`/`update`/`run`, enveloppe `<routine-fire-payload>`) ; les **deux seules** catégories d'événements GitHub (Pull request, Release) et les 8 filtres PR avec leurs 6 opérateurs — la correction de la passe de veille était juste, la liste de 8 événements et le filtre `from-fork` n'existent effectivement pas ; toute la surface daemon / agent view (chemins `~/.claude/daemon/roster.json`, `~/.claude/daemon.log`, `~/.claude/jobs/<id>/state.json`, `~/.claude/jobs/<id>/tmp/`, `CLAUDE_JOB_DIR`, réglages `disableAgentView` et `worktree.bgIsolation`, filtres `a:` / `s:working` / `s:blocked` / `#1234`, commandes `attach|logs|stop|respawn|rm` et `daemon status|stop --any`) ; Remote Control en research preview, désactivé par défaut sur Team/Enterprise jusqu'à activation par un Owner, exécution locale du filesystem et des serveurs MCP ; `slack_channel_id` bien présent en `group_by` de `GET /v1/organizations/analytics/usage_report` ; le correctif `ultracode` sur input non humain en v2.1.210 ; `/subtask` en v2.1.212 et `/code-review` en subagent d'arrière-plan en v2.1.218.

**Points d'intégration §5 :** les 15 fichiers cités existent tous, et tous les numéros de ligne vérifiés pointent bien sur ce qui est annoncé — `agent-registry.ts` l. 12 et 91-102, `agent-activity.ts` l. 105-111, `working-files-tracker.ts` l. 64 et 84, `serve-http.ts` l. 1004 (confirmé **unique** appelant de `clearForAgent` hors tests), `handle-rest.ts` l. 64 et 116-117, `mqtt-bridge.ts` l. 123 (`will:`), `server-setup.ts` l. 133, la famille `phase2.*` de `cli/doctor.ts` (9 checks, aucun sur les agents), `idleAfterMinutes: 5` bien câblé en dur dans `agents-tools.ts`, `file_activity` bien en `INSERT` seul, et `credential-reader.ts` bien réduit à macOS avec `NotImplementedError` sur Linux et Windows. Seule la plage dashboard était fausse.

**Marqueurs `(à vérifier)` restants :** aucun. Les trois marqueurs (schéma `roster.json`, hook de rewind, MCP stdio depuis Slack) sont tranchés ci-dessus.

**Testabilité :** ⚠️ partielle
Trois des cinq items du protocole §6.3 tournent intégralement sur le poste : dispatcher deux `claude --bg`, relever `claude agents --json` et dumper `~/.claude/daemon/roster.json` (volet Windows), rejouer le scénario `/rewind` contre une instance locale du daemon via `POST /api/working-files/start`, et tuer un process d'agent sans LWT pour chronométrer sa survie dans `listOnline()` — c'est assez pour trancher la question de §6.1.
Ne sont pas exécutables ici : le volet Linux du relevé de schéma (poste Windows unique), et tout scénario Routines ou Slack, qui exige un compte claude.ai Pro/Max/Team avec Claude Code on the web activé, un accès à la research preview et un token de routine — non couvert par des credentials d'API Anthropic ordinaires.
Les items 4 et 5 du protocole n'ont plus besoin d'être exécutés : la doc y répond (aucun hook de rewind ; session Slack en cloud, donc pas de stdio local).

---

## 1. Ce que c'est

Claude Code a maintenant son propre superviseur multi-sessions, exactement au même niveau d'abstraction que le daemon de mcp-coordinator. Un daemon vit dans `~/.claude/daemon`, tient l'inventaire des sessions d'arrière-plan dans `~/.claude/daemon/roster.json`, écrit ses logs dans `~/.claude/daemon.log`, et matérialise chaque job shell dans `~/.claude/jobs/<id>/state.json` avec un répertoire de travail exposé aux hooks via `$CLAUDE_JOB_DIR`. Il préchauffe un worker, arrête les sessions inactives après environ une heure sauf si elles sont épinglées, relance celles qui sont sorties inopinément et se met à jour seul. Côté CLI, `claude agents` ouvre une vue plein-terminal, `claude agents --json` en donne une version machine, et `claude --bg "<prompt>"` / `claude --bg --exec '<cmd>'` dispatchent du travail ; `claude attach|logs|stop|respawn|rm <id>` et `claude daemon status|stop --any` complètent le cycle de vie.

Trois autres surfaces attaquent le même modèle de présence par des angles différents. **Remote Control** (research preview) relie claude.ai/code ou l'app mobile à une session qui tourne localement : le filesystem, les serveurs MCP et les hooks restent exécutés sur la machine, mais l'humain peut piloter depuis trois surfaces simultanément — l'équation implicite « une session = un poste = un humain » ne tient plus. Le **checkpointing** (`/rewind` en interactif, API de checkpointing fichier côté Agent SDK) permet à un agent d'annuler des modifications de fichiers sans que quiconque en dehors de sa session le sache. Enfin, **Routines** (research preview) et **Claude Code dans Slack / Claude Tag** créent des sessions qui n'apparaissent dans aucun roster local : une routine tourne sur l'infrastructure d'Anthropic, une session Slack tourne côté serveur. La question commune aux quatre : qui fait autorité sur la liste des agents vivants et sur ce qu'ils ont réellement touché.

## 2. Surface d'API exacte

Daemon et vue agents (GA) :

```
claude agents
claude agents --json
claude --bg "<prompt>"
claude --bg --exec '<cmd>'
claude attach <id> | logs <id> | stop <id> | respawn <id> | rm <id>
claude daemon status | claude daemon stop --any
~/.claude/daemon/          ~/.claude/daemon.log
~/.claude/daemon/roster.json
~/.claude/jobs/<id>/state.json      ~/.claude/jobs/<id>/tmp/   ($CLAUDE_JOB_DIR)
commandes en session : /background  /bg  /fork  /subtask  /tasks
réglages : disableAgentView, worktree.bgIsolation
filtres de la vue : a:<name>  s:working  s:blocked  #1234 (liaison PR automatique)
```

La doc `agent-view` nomme ces fichiers et leur rôle (`roster.json` = « List of running background sessions », `state.json` = « Per-session state shown in agent view ») mais **ne publie aucun schéma champ par champ** — vérifié le 2026-08-14, ce n'est pas un oubli de la veille mais un fait documentaire. Relever le schéma réel reste donc un point du protocole (voir §6.3).

Checkpointing (GA) :

```
/rewind                                              (commande interactive)
Agent SDK TS : enableFileCheckpointing: true         + rewindFiles(<checkpoint-uuid>)
Agent SDK Py : enable_file_checkpointing=True        + rewind_files(<checkpoint-uuid>)
                extraArgs: { "replay-user-messages": null }   (requis pour recevoir les UUID)
CLI : CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true claude -p --resume <id> --rewind-files <uuid>
Résultat TS : RewindFilesResult (champ skippedLinks)
```

Portée : seuls les outils Write / Edit / NotebookEdit sont suivis — pas les écritures faites par Bash, ni les éditions d'un subagent (sauf skill `context: fork` au premier plan).

**Aucun hook n'expose un rewind** — tranché le 2026-08-14 contre la liste documentée des 31 événements de hook, dont aucun ne concerne rewind, checkpoint ou restore (les plus proches, `WorktreeCreate` / `WorktreeRemove` et `PreCompact` / `PostCompact`, portent sur autre chose). L'hypothèse « un hook nous prévient » est donc réfutée, pas seulement non confirmée.

Remote Control (research preview) :

```
claude.ai/code + apps Claude iOS/Android
toggle admin `Remote Control` sur claude.ai/admin-settings/claude-code
(désactivé par défaut sur Team et Enterprise tant qu'un Owner ne l'active pas)
```

Routines (research preview, API expérimentale) :

```
POST https://api.anthropic.com/v1/claude_code/routines/{routine_id}/fire
Authorization: Bearer sk-ant-oat01-...        (token par routine, affiché une seule fois)
anthropic-beta: experimental-cc-routine-2026-04-01   (absent => 400 invalid_request_error)
anthropic-version: 2023-06-01
Content-Type: application/json

{ "text": "<freeform, non parsé, 65 536 caractères max>" }
-> 200 { "type": "routine_fire", "claude_code_session_id": …, "claude_code_session_url": … }
```

Trois précisions correctives importantes, issues de la vérification :

- Le corps n'accepte qu'un champ `text` **freeform non parsé** : on ne peut pas envoyer de payload JSON structuré, il arrivera comme chaîne littérale, enveloppée dans un bloc `<routine-fire-payload>` explicitement étiqueté comme donnée non fiable. La routine ne l'exploite que si son prompt sauvegardé y fait référence.
- Déclencheurs GitHub réellement documentés : **deux catégories seulement**, « Pull request » et « Release ». Les événements `push`, `issue`, `check_run`, `workflow_run`, `discussion` et `merge_queue` annoncés par la fiche brute **n'existent pas**. Filtres PR : Author, Title, Body, Base branch, Head branch, Labels, Is draft, Is merged (opérateurs equals / contains / starts with / is one of / is not one of / matches regex). Le filtre `from-fork` annoncé **n'existe pas**.
- Pas de SDK, pas d'idempotency key. CLI : `/schedule` (alias `/routines`), sous-commandes `list` / `update` / `run` ; cadence minimale 1 heure.

Slack et Claude Tag : pages de doc dédiées ; la dimension `slack_channel_id` est bien disponible en `group_by` sur `GET /v1/organizations/analytics/usage_report` (aux côtés de `context_window`, `inference_geo`, `model`, `product`, `rbac_group_id`, `speed`) — vérifié. Nuance de statut relevée le 2026-08-14 : la page « Claude Code in Slack » documente la **version historique**, qu'Anthropic retire sur Team et Enterprise au profit de Claude Tag ; elle reste le chemin de setup sur Pro et Max.

## 3. Sources

- https://code.claude.com/docs/en/agent-view.md
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
- https://code.claude.com/docs/en/checkpointing
- https://code.claude.com/docs/en/agent-sdk/file-checkpointing
- https://code.claude.com/docs/en/remote-control
- https://code.claude.com/docs/en/claude-code-on-the-web
- https://code.claude.com/docs/en/mobile
- https://code.claude.com/docs/en/routines
- https://platform.claude.com/docs/en/api/claude-code/routines-fire
- https://code.claude.com/docs/en/slack
- https://code.claude.com/docs/en/claude-tag
- https://platform.claude.com/docs/en/api/admin/analytics
- https://www.infoq.com/news/2026/05/code-with-claude/ *(source secondaire, faible précision ; probablement à l'origine de la liste erronée de 8 événements GitHub)*

Contradiction entre chercheurs, signalée telle quelle : une fiche brute annonce 8 événements GitHub déclencheurs pour les Routines, la vérification n'en confirme que 2. La version corrigée fait foi ci-dessus. La source `code.claude.com/docs/en/agents.md` citée pour les Routines est hors sujet et a été remplacée par la référence API.

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.** `claude agents --json` et `~/.claude/daemon/roster.json` sont un inventaire d'agents lisible gratuitement, sans coopération de l'agent. Aujourd'hui `AgentRegistry.listOnline()` (`src/agent-registry.ts:91`) ne sait rien de plus que « `status = 'online'` et `last_seen_at` a moins de 900 secondes » — un filtre de lecture assumé comme approximatif dans le commentaire de l'issue #233. Croiser cette liste avec le roster local transforme une heuristique temporelle en constat : un agent inscrit dont le process n'existe plus dans le roster est un fantôme, pas un agent qui réfléchit. Cela bénéficie directement à deux surfaces : `cli/doctor.ts`, qui pourrait ajouter un check `agents.ghosts` de la même famille que ses checks `phase2.*` existants, et le dashboard, dont l'état `state.agents` (déclaré `dashboard/public/dashboard.js:5`, rendu l. 629) affiche aujourd'hui des agents que rien ne confirme. Effet de bord favorable : `WorkingFilesTracker.clearForAgent()` existe déjà (`src/working-files-tracker.ts:84`) mais n'est appelé que sur le last-will MQTT (`src/serve-http.ts:1004`) ; un agent mort qui n'a pas de LWT enregistré laisse ses revendications de fichiers jusqu'à expiration de `claim_until`. Un réconciliateur de roster lui donne un second déclencheur, plus fiable.

Le précédent technique existe déjà dans le repo : `src/quota/credential-reader.ts` lit un artefact déposé par la CLI Claude Code (le secret « Claude Code-credentials »), avec une implémentation macOS réelle et des stubs Linux/Windows qui lèvent `NotImplementedError`. Lire `roster.json` suivrait le même patron, en plus simple — c'est un fichier JSON, pas un trousseau — et serait donc portable sur les trois plateformes, contrairement au lecteur de quota.

**Risque si on ne fait rien.** Trois risques distincts, de gravité décroissante.

1. **`/rewind` produit des faux conflits persistants.** Un agent annonce `src/auth.ts`, l'édite, puis rembobine. Le contenu est restauré mais la ligne `working_files` reste, `file_activity` (`src/file-tracker.ts`) garde une trace append-only d'une modification qui n'existe plus, et le `ConflictDetector` continue d'avertir les autres agents à propos d'un fichier redevenu intact. Ce n'est pas une feature à adopter, c'est un bug à vérifier.
2. **Remote Control invalide le modèle de présence.** Une session peut être active sans aucune frappe locale, pilotée depuis un téléphone. Le TTL de 900 s de `listOnline` et le `idleAfterMinutes: 5` câblé en dur dans `agent_activity` (`src/tools/agents-tools.ts`) mesurent tous deux une chose — la fraîcheur des appels d'outils — dont on déduit une autre — la présence d'un humain. La déduction devient fausse.
3. **Deux daemons concurrents sur la même machine.** Deux notions de session, deux nettoyages de worktree (`worktree.bgIsolation` côté Claude Code), deux cycles de vie qui peuvent se contredire. Ne pas trancher qui fait autorité, c'est laisser l'auto-hébergeur découvrir la contradiction en production.

Les Routines et Slack sont, eux, des opportunités et non des risques : une routine déclenchée sur `pull_request` peut interroger mcp-coordinator pour comparer l'empreinte fichiers d'une PR aux revendications des agents locaux — c'est le pont cloud↔local qui manque au projet ; et Slack est un canal de notification de conflit avec des identités humaines déjà résolues, là où le projet n'a qu'un dashboard statique et un bus MQTT. Deux réserves : le champ `text` non parsé affaiblit le scénario « le coordinator déclenche une routine de résolution » (il faut concevoir le prompt sauvegardé pour cela), et il est désormais **établi** (vérification du 2026-08-14) qu'une session Claude Code lancée depuis Slack ne peut pas charger un serveur MCP stdio local : la doc indique qu'une mention `@Claude` crée une session **sur Claude Code on the web**, donc sur l'infrastructure Anthropic. Les serveurs ajoutés localement par `claude mcp add` ne sont pas visibles depuis ces sessions ; seuls comptent les connecteurs claude.ai ou un `.mcp.json` committé dans le dépôt cloné. La cible réaliste est donc le transport HTTP joignable depuis Internet, ou un webhook sortant depuis le bridge MQTT.

Enfin, une note de sécurité transverse confirmée par le vérificateur : depuis v2.1.210 Claude Code refuse de laisser un payload de webhook ou un commentaire de PR relayé déclencher `ultracode`, et le bloc `<routine-fire-payload>` est marqué non fiable par construction. mcp-coordinator devrait appliquer la même règle à tout ce qui entre par MQTT.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/agent-registry.ts` | Cœur du sujet. `listOnline()` (l. 91-102) filtre sur `status='online'` + TTL `COORDINATOR_AGENT_ONLINE_TTL_SECONDS` (défaut 900 s, l. 12). C'est là que se brancherait une réconciliation avec le roster, ou rien du tout si on décide que le roster n'est pas notre affaire. |
| `src/agent-activity.ts` | `getActivity()` déclasse `working` → `idle` après `idleAfterMinutes` (l. 105-111). Sémantique à revoir sous Remote Control : « pas d'appel d'outil depuis 5 min » ≠ « personne au clavier ». |
| `src/tools/agents-tools.ts` | Les 4 outils MCP `register_agent` / `list_agents` / `heartbeat` / `agent_activity`. `agent_activity` câble `idleAfterMinutes: 5` en dur ; `list_agents` expose directement `listOnline`/`listAll`. Point d'ajout naturel d'un champ « confirmé par le roster ». |
| `src/working-files-tracker.ts` | `claim_until` + `sweepExpired()` (l. 64) sont la seule protection contre les revendications orphelines. `clearForAgent()` (l. 84) est le point d'accroche d'une libération déclenchée par la disparition d'un agent du roster ou par un rewind. |
| `src/serve-http.ts:1004` | Unique appelant actuel de `clearForAgent`, sur le chemin last-will MQTT. À élargir si la réconciliation devient une source d'événements « agent mort ». |
| `src/file-tracker.ts` | `file_activity` est un journal append-only. Un `/rewind` n'y écrit rien : le journal enregistre une modification qui a été défaite. Décider si on compense (marqueur de rewind) ou si on assume le caractère historique du journal. |
| `src/conflict-detector.ts` | Consommateur final : c'est lui qui transforme des revendications périmées en avertissements faux. Le coût du « ne rien faire » se paie ici. |
| `src/http/handle-rest.ts` | Routes `"/api/register"` (l. 64), `"POST /api/working-files/start"` et `"/stop"` (l. 116-117) — le chemin par lequel les hooks Claude Code alimentent le tracker. Une éventuelle route de rewind s'ajouterait dans la même table. |
| `src/register-workflow.ts` | Flux partagé MCP + REST : `registry.register` + SSE `agent_online` + publication de statut retenu MQTT. Tout enrichissement du modèle d'agent passe par là une seule fois. |
| `src/mqtt-bridge.ts:123` | Le `will:` du client MQTT — l'unique mécanisme de détection de mort aujourd'hui. À comparer honnêtement au roster avant d'ajouter une seconde source. |
| `src/sse-emitter.ts` + `src/server-setup.ts:133` | Les événements `agent_online` / `agent_offline` pilotent aussi le rafraîchissement du cache de quota. Toute nouvelle transition d'état (fantôme détecté) a un effet de bord ici. |
| `dashboard/public/dashboard.js:244-259` | Le dashboard maintient `state.agents` à partir de `agent_online` (l. 244-249), `agent_offline` (l. 250-253) et `agent_activity` (l. 255-259) ; le rendu de la liste est l. 629. C'est la surface où « agent fantôme » deviendrait visible pour l'humain. |
| `cli/doctor.ts` | Aucun check ne regarde aujourd'hui l'état des agents : la famille existante est `phase2.public_url`, `phase2.discovery_doc`, `phase2.sqlite`, `phase2.sweeper`, `phase2.audit_queue`, `phase2.audit_events`, `phase2.jwt_secret_entropy`, `phase2.github_creds`, `phase2.google_creds`. Un check `agents.roster` s'insérerait sans refonte. |
| `src/quota/credential-reader.ts` | Précédent d'architecture : lecture d'un artefact déposé par la CLI Claude Code, avec `NotImplementedError` par plateforme. Modèle à reprendre — ou contre-exemple, puisqu'il n'a jamais été implémenté ailleurs que sur macOS. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Qui fait autorité sur « quels agents sont vivants » : le registre MCP alimenté par les agents eux-mêmes (heartbeat + TTL 900 s + last-will MQTT), ou `~/.claude/daemon/roster.json` lu à froid sur la machine — et si c'est le roster, que devient le modèle multi-machines / multi-transports du coordinator, qui ne peut lire aucun fichier local sur les postes distants ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Non exécutable ici : le volet Linux du relevé de schéma (poste Windows unique), et tout scénario Routines ou Slack, qui exige un compte claude.ai avec Claude Code on the web, l'accès à la research preview et un token de routine.

- [ ] Lancer deux sessions d'arrière-plan (`claude --bg`), exécuter `claude agents --json` et dumper `~/.claude/daemon/roster.json` sur Windows et sur Linux : relever le schéma réel (identifiants, statuts, timestamps, PID ou non), sa stabilité entre deux versions de la CLI, et si le fichier existe seulement quand le daemon tourne.
- [ ] Reproduire le scénario `/rewind` de bout en bout : enregistrer un agent, `POST /api/working-files/start` sur un fichier, l'éditer, faire `/rewind`, puis interroger `list_agents`, `agent_activity` et le `ConflictDetector` — vérifier concrètement si une revendication survit à la restauration et pendant combien de temps (`claim_until`).
- [ ] Tuer brutalement un process d'agent enregistré sans LWT MQTT, puis mesurer combien de temps il reste dans `listOnline()` et combien de temps ses lignes `working_files` restent visibles dans `getIndex()`. C'est la mesure du coût réel du problème que la réconciliation prétend résoudre.
- [ ] Établir si un événement de rewind est exposé à un hook Claude Code (aujourd'hui non confirmé). Si non, le scénario « libération automatique des verrous » tombe et il faut se rabattre sur une réconciliation périodique.
- [ ] Vérifier si une session Claude Code lancée depuis Slack peut charger un serveur MCP stdio local, ou si seul le transport HTTP est atteignable — cela décide de la faisabilité du canal de notification d'équipe.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **`roster.json` est un fichier interne non documenté.** Aucun schéma publié, aucune garantie de stabilité, et le daemon « se met à jour tout seul » — donc le format peut changer sous nos pieds entre deux mises à jour silencieuses de la CLI. Construire un check `doctor` dessus, c'est signer pour une maintenance de rattrapage permanente. `claude agents --json` est un contrat un peu plus défendable, mais c'est une sortie CLI, pas une API versionnée.
- **Ça casse la portabilité hors Claude Code.** mcp-coordinator est un serveur MCP : ses clients peuvent être Claude Code, mais aussi tout autre client MCP. Un registre dont la vérité dépend d'un fichier déposé par un vendeur précis dégrade les autres clients au statut de citoyens de seconde zone, dont les agents seront systématiquement classés « non confirmés ».
- **Le modèle distribué s'y oppose frontalement.** Le coordinator sert des agents via HTTP et MQTT, potentiellement depuis plusieurs machines. Lire `~/.claude/daemon/roster.json` ne fonctionne que pour les agents co-localisés avec le serveur. On obtiendrait une réconciliation partielle — donc un signal ambigu, potentiellement pire qu'aucun signal.
- **Le précédent interne est décourageant.** `src/quota/credential-reader.ts` a exactement cette forme (lire un artefact de la CLI Claude Code) et n'a jamais dépassé macOS : Linux et Windows lèvent `NotImplementedError`, et le mainteneur développe sous Windows. Rien ne garantit qu'un lecteur de roster connaisse un meilleur sort.
- **YAGNI sur le profil de déploiement réel.** Le TTL de 900 s est déjà décrit dans le code comme « généreux à dessein » ; l'issue #233 a été fermée par un filtre de lecture volontairement simple, sans sweeper ni élection de leader. Le vrai coût des agents fantômes n'a jamais été mesuré. Il faut mesurer avant d'ajouter une seconde source de vérité.
- **Routines : dépendance à une research preview doublée d'une API expérimentale.** Header beta daté, endpoint hors du namespace habituel, pas de SDK, pas d'idempotency key, corps limité à un `text` non parsé, cadence minimale d'une heure, et l'avertissement explicite de la doc que le comportement et la surface d'API peuvent changer. Deux catégories d'événements GitHub seulement, ce qui exclut le déclencheur `push` sur lequel reposerait le scénario le plus intéressant.
- **Remote Control est aussi une research preview**, désactivée par défaut sur Team et Enterprise. Redéfinir la sémantique de présence du produit pour s'aligner sur une surface que la majorité des utilisateurs Team n'a pas activée est prématuré.
- **Le volet `/rewind` n'est pas une feature à adopter mais un bug à confirmer.** Il ne justifie ni chantier ni jalon : un test reproduisant le scénario, puis soit une correction de quelques lignes, soit le constat que le TTL absorbe déjà le problème. Le mélanger au chantier « roster » gonflerait artificiellement l'effort.

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
| 2026-08-14 | Vérification des faits : 3 marqueurs tranchés, statut Slack et version draft-PR corrigés, lignes dashboard rectifiées. |
