# G02 — Orchestrateurs worktree-par-tâche (Conductor, Nimbalyst, Vibe Kanban, Claude Squad)

| Champ | Valeur |
|---|---|
| **ID** | `worktree-orchestrators` |
| **Surface** | ecosystem |
| **Statut** | mixte — GA hétérogène : Conductor GA (API HTTP **beta**), Vibe Kanban GA mais abandonné par son éditeur (communautaire), Claude Squad GA, Crystal **deprecated** (→ Nimbalyst), Terragon **mort** |
| **Disponible depuis** | catégorie stabilisée 2025-2026 ; consolidation du marché en 2026 (Terragon coupé le 2026-02-09, Vibe Kanban annoncé en arrêt éditeur le 2026-04-10, Crystal déprécié en février 2026) |
| **Tier** | T2-fort-levier |
| **Nature** | threat |
| **Effort estimé** | S (veille + positionnement) — M si adaptateur réel |
| **Confiance veille** | low → medium (un champ structurant de la fiche brute — `api_surface` — était faux et a été corrigé par le vérificateur) |
| **Vérification** | PLAUSIBLE |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — Vibe Kanban testable en local, API Conductor nécessite une clé |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — contre-mesure technique : leurs worktrees vivent hors dépôt et notre normalisation les refuse |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** ✅ saine

**Corrections apportées :**
- §2 Conductor : pagination précisée sur doc primaire — les endpoints de liste renvoient `{ data, offset, hasMore }` (et non un simple « flag `hasMore` »).
- §2 Conductor : liste des opérations Workspaces complétée d'après la doc — `create / get / rename / archive / unarchive / sleep / status`.
- §2 : marqueur `(à vérifier)` sur Claude Squad / Nimbalyst tranché en `(non vérifiable)`.
- Aucune autre correction : le statut d'en-tête, la base `https://api.conductor.build/v0`, l'auth `Authorization: Bearer <api key>`, la mention beta (« The API is in beta. Request and response shapes may change. »), le snippet MCP `npx -y vibe-kanban@latest --mcp` et les 33 noms d'outils de §2 sont confirmés mot pour mot sur `conductor.build/docs/api` et `vibekanban.mintlify.dev`. La date d'arrêt commercial de Vibe Kanban (2026-04-10, bascule communautaire + services distants coupés à 30 jours) est confirmée sur `vibekanban.com/blog/shutdown`.
- §5 : tous les fichiers cités existent et toutes les lignes citées pointent bien sur ce que la fiche prétend — `register_agent` l. 21, `announce_work` l. 37, snippet `.mcp.json` l. 195-196 et merge l. 225-236 et clients listés l. 306 dans `cli/init.ts`, `faq.q1` l. 2455 et bloc JSON-LD l. 2517-2524 dans `docs/index.html`, `post_to_thread` l. 343 dans `cli/channel.ts`, les 6 familles d'outils enregistrées l. 242-247 de `src/server-setup.ts`. Absence de toute mention de « worktree » dans `docs/ARCHITECTURE.md` re-vérifiée. Aucun numéro de ligne n'a dû être corrigé.

**Marqueurs `(à vérifier)` restants :** aucun. Le seul marqueur de la fiche (API publique Claude Squad / Nimbalyst) est devenu `(non vérifiable — aucune doc d'API publique trouvée)`.

**Testabilité :** ⚠️ partielle
Testable ici et maintenant : `npx -y vibe-kanban@latest --mcp` puis un `tools/list` pour confirmer les 33 outils et les schémas d'entrée ; la cohabitation des deux serveurs dans un `.mcp.json` et le coût en tokens du `tools/list` cumulé ; le scénario à 3 worktrees sur ce repo avec et sans coordinateur.
Non testable ici : l'API Conductor `v0` (clé d'API délivrée depuis l'app Conductor, qui est macOS-only, sur un poste Windows), et donc la vérification runtime de la pagination et du suivi d'état des sessions.

## 1. Ce que c'est

Une catégorie d'outils tiers a convergé sur le même pattern : une UI (app native ou web) qui crée un `git worktree` par tâche, y lance un agent CLI (Claude Code, Codex, Cursor, OpenCode), et présente l'ensemble sous forme de kanban ou de liste de sessions avec revue de diff et gestion des branches. L'isolation est physique — chaque agent a son propre répertoire de travail, donc son propre inode par fichier — et la coordination se fait par l'humain qui regarde le tableau et merge dans l'ordre qu'il veut. Conductor (Melty Labs) est une app Mac gratuite adossée à une série A de 22 M$, avec une offre cloud (agents qui continuent laptop fermé) et une API HTTP publique versionnée. Vibe Kanban est un CLI + UI web multi-plateforme, distribué par `npx`, qui expose **son propre serveur MCP** avec un modèle issues / workspaces / sessions. Claude Squad est plus rudimentaire : tmux + un worktree par agent, AGPL-3.0. Le marché se consolide brutalement — Terragon (orchestrateur d'agents *cloud*, pas local) a fermé en février 2026, Bloop a annoncé l'arrêt commercial de Vibe Kanban en avril 2026 avec bascule 100 % locale, Crystal a été gelé et remplacé par Nimbalyst chez le même éditeur.

Le point qui compte pour mcp-coordinator : ces outils ne s'arrêtent pas à l'UI. Vibe Kanban occupe déjà la couche protocolaire — un serveur MCP local, ~33 outils, avec `create_session`, `start_workspace`, `run_session_prompt`, `link_workspace_issue`. C'est de la coordination d'agents exposée en MCP, distribuée en `npx`, exactement le canal et le mode d'installation de mcp-coordinator.

## 2. Surface d'API exacte

**Conductor — API HTTP publique (beta déclarée : « Request and response shapes may change »)**

```
Base   : https://api.conductor.build/v0
Auth   : Authorization: Bearer <api key>
Spec   : OpenAPI publiée
Ressources : Projects (list / get / list workspaces)
             Workspaces (create / get / rename / archive / unarchive / sleep / status)
             Sessions (create / get / rename / send messages / read transcript /
                       status / cancel) · Messages (get)
             SQL search (requête sur les transcripts de l'organisation)
Pagination : limit / offset  →  réponse { data, offset, hasMore }
```

**Vibe Kanban — serveur MCP local (stdio)**

```jsonc
{
  "mcpServers": {
    "vibe_kanban": {
      "command": "npx",
      "args": ["-y", "vibe-kanban@latest", "--mcp"]
    }
  }
}
```

Outils exposés (liste issue de la doc officielle) :

```
get_context · list_organizations · list_org_members · list_projects
list_issues · create_issue · get_issue · update_issue · delete_issue
list_issue_priorities · list_issue_assignees · assign_issue · unassign_issue
list_tags · list_issue_tags · add_issue_tag · remove_issue_tag
create_issue_relationship · delete_issue_relationship
list_repos · get_repo · update_setup_script · update_cleanup_script · update_dev_server_script
list_workspaces · update_workspace · delete_workspace · link_workspace_issue · start_workspace
create_session · list_sessions · run_session_prompt · get_execution
```

**Claude Squad / Nimbalyst** : aucune API publique documentée *(non vérifiable — recherche 2026-08-14 : aucune doc d'API exposée côté `smtg-ai/claude-squad` ni côté Nimbalyst)*. La primitive commune reste `git worktree add <path> <branch>` par tâche, Claude Squad ajoutant une session tmux par agent.

> Contradiction interne au bundle, signalée explicitement : la fiche brute affirmait `api_surface: "unknown (aucune API publique vérifiée)"` et concluait qu'aucun de ces outils n'expose de protocole de coordination. Le vérificateur a **réfuté** les deux points sur doc primaire. La version ci-dessus est celle du vérificateur. Le champ `relevance: low` de la fiche brute découlait de l'erreur et doit être lu comme `medium`.

## 3. Sources

- https://www.conductor.build/docs/api
- https://www.conductor.build/blog/series-a
- https://vibekanban.mintlify.dev/docs/integrations/vibe-kanban-mcp-server
- https://www.vibekanban.com/blog/shutdown
- https://github.com/BloopAI/vibe-kanban
- https://github.com/smtg-ai/claude-squad
- https://github.com/stravu/crystal
- https://docs.terragonlabs.com/docs/resources/shutdown
- https://nimbalyst.com/blog/best-agent-management-tools-2026/ *(contenu marketing d'un acteur de la liste)*
- https://aq.dev/alternatives/vibe-kanban/ *(se vend lui-même comme alternative)*
- https://www.augmentcode.com/tools/open-source-agent-orchestrators
- https://rustman.org/wiki/conductor-parallel-agents/

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
Ces outils sont des sources d'agents parallèles qui n'ont, aujourd'hui, aucune notion de « qui édite `types.ts` » ni de conflit d'intention : ils isolent les fichiers et laissent l'humain arbitrer au merge. Un utilisateur de Conductor qui lance quatre workspaces sur le même repo obtient quatre branches propres et, potentiellement, quatre designs incompatibles — précisément le problème que `announce_work` et `conflict-detector.ts` traitent. Le bénéfice concret n'est pas d'écrire du code en moins mais de gagner une population de clients déjà équipés : un adaptateur qui mappe `workspace_id` → `agent_id` et publie les événements de coordination vers leur UI éviterait à mcp-coordinator de développer sa propre gestion de worktrees et son propre kanban (que le dashboard statique n'a pas). Côté Vibe Kanban, le chemin est en principe symétrique : deux serveurs MCP stdio dans la même session Claude Code, l'un fournissant les sessions/workspaces, l'autre la coordination d'intention.

**Risque si on ne fait rien :**
Trois risques distincts, à ne pas confondre.
1. **Occupation de la couche.** La position que le projet revendique — « la couche protocolaire sous les UI » — est déjà partiellement prise. Vibe Kanban n'est pas un client potentiel : c'est un serveur MCP avec un modèle issues/workspaces/sessions et une distribution `npx`. Si un utilisateur a déjà `vibe_kanban` branché, l'argument « ajoute un second serveur MCP pour la coordination » devient un argument à défendre, pas une évidence.
2. **Le marché achète l'isolation visible.** Un worktree par tâche est compréhensible en une phrase et vérifiable à l'œil ; la détection de conflit d'intention est invisible tant qu'elle marche. Ces outils lèvent des fonds pendant que le protocole reste de niche. Le FAQ du site (`docs/index.html`, « Does this replace git worktrees? ») répond déjà à la question, mais dans le sens défensif : « utilisez les deux ». Il n'existe aucune démonstration d'usage conjoint.
3. **Fragilité de la couche UI.** La contrepartie : Terragon est mort, Vibe Kanban a perdu son éditeur, Crystal a été gelé. Miser sur un adaptateur propriétaire vers l'un d'eux, c'est risquer de maintenir du code mort dans les douze mois. Terragon, cela dit, était un orchestrateur d'agents *cloud* — sa mort illustre la fragilité du SaaS d'agents, pas celle de l'outillage worktree local.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/server-setup.ts` | `createMcpServer()` enregistre les 6 familles d'outils (`registerConsultationTools`, `registerAgentTools`, `registerFilesTools`, `registerDependenciesTools`, `registerStatusTools`, `registerMqttTools`). Point d'entrée si un adaptateur doit exposer des outils supplémentaires (ou, à l'inverse, si on décide de ne rien ajouter). |
| `src/tools/agents-tools.ts` | `register_agent` (l. 21) prend `agent_id`, `name`, `modules`. Un workspace Conductor ou Vibe Kanban devrait s'y mapper : c'est la seule identité d'agent du système. Aucun champ `worktree` / `branch` aujourd'hui. |
| `src/tools/consultation-tools.ts` | `announce_work` (l. 37) porte `subject`, `target_modules`, `target_files`, `assigned_to`. C'est la donnée qu'un kanban tiers voudrait afficher ; rien ne l'exporte vers un système externe. |
| `src/conflict-detector.ts`, `src/working-files-tracker.ts`, `src/file-tracker.ts` | Cœur de la valeur non couverte par les worktrees : conflit d'intention et fichiers en cours d'édition. Inchangés par une intégration, mais ce sont eux qu'un adaptateur exposerait. |
| `cli/channel.ts` | Serveur MCP stdio séparé (Claude Code Channels, MQTT → `notifications/claude/channel`, outil `post_to_thread`). Modèle architectural exact d'un futur « adaptateur worktree » : un processus mince à côté du daemon, sans coupler le daemon au format d'un tiers. |
| `cli/init.ts` | Génère le snippet `.mcp.json` (l. 196, l. 225-236 pour le merge) et annonce déjà « Claude Code, Cursor, Cline, … » (l. 306). C'est là qu'une doc de cohabitation avec `vibe_kanban` s'insérerait, le merge de `mcpServers` étant déjà géré. |
| `src/index.ts`, `src/serve-http.ts` | Les deux transports (stdio et HTTP `/mcp`). Un orchestrateur tiers qui pilote plusieurs agents sur une même machine consommerait plutôt le HTTP partagé que N stdio. |
| `sdk/src/client.ts` | SDK client TypeScript (OAuth/device code). Chemin d'intégration pour un orchestrateur qui voudrait parler au coordinateur sans passer par MCP. |
| `docs/index.html` | FAQ `faq.q1` « Does this replace git worktrees? » (l. 2455) et carte `compare.card1` — déclinées en 6 langues inline + un bloc JSON-LD (l. 2524). Toute reformulation du positionnement face à ces outils est un edit multiplié par 7 à 8. |
| `docs/ARCHITECTURE.md` | Aucune mention de worktrees ni d'orchestrateurs tiers (vérifié par grep). Le document ne dit pas où s'arrête le périmètre du projet côté cycle de vie des agents. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Vibe Kanban expose déjà un serveur MCP local (`create_session`, `start_workspace`, `run_session_prompt`, `link_workspace_issue`) : mcp-coordinator doit-il se poser explicitement **sous** ces orchestrateurs — un adaptateur mince, sur le modèle de `cli/channel.ts`, qui mappe `workspace_id` → `agent_id` et pousse `announce_work` / conflits vers leur UI — ou renoncer à l'intégration et se contenter de documenter la cohabitation de deux serveurs MCP dans `cli/init.ts`, au risque de rester invisible pour les utilisateurs déjà équipés ?

### 6.2 Hypothèse

**Terrain vérifié avant de commencer.** Branches listées en entier — aucune fiche voisine n'a pré-décidé ce sujet. Deux fiches tranchées mordent dessus, et la première désarme un contre-argument central :

- **`E08`** a mesuré que Claude Code **défère** les définitions d'outils MCP par défaut : seuls les *noms* et les `instructions` du serveur entrent dans le contexte du premier tour. Le contre-argument « budget de contexte » de §6.5 — *« 33 outils `vibe_kanban` en plus des nôtres… la cohabitation peut être disqualifiée par le seul budget de contexte »* — repose donc peut-être sur un mécanisme qui n'existe plus.
- **`G01`**, tranchée à l'instant, a relevé que le concurrent le plus proche s'est doté d'un **filtre d'outils par profil**. Une grosse surface d'outils est un problème que l'écosystème traite déjà côté serveur.

**Ce que je pense avant de mesurer.** Que le §4 confond deux menaces de natures très différentes et n'en garde qu'une. « Occupation de la couche » suppose que Vibe Kanban occupe la **même fonction** ; le §6.5 le dit lui-même en dernière ligne — *« ils occupent la couche MCP mais pas la fonction »*. Si c'est vrai, la menace n'est pas protocolaire, elle est attentionnelle, et une réponse en code serait hors sujet.

Je m'attends aussi à ce que la question §6.1 soit mal posée sur son second terme : elle oppose « adaptateur mince » à « documenter la cohabitation dans `cli/init.ts` », comme si documenter était le repli par défaut. Or documenter une cohabitation qui coûte cher ou qui ne marche pas serait pire que de ne rien faire.

Fiche **menace** : le verdict porte sur la **réponse** (`_CHALLENGE-PROMPT.md:126-127`) — *contre-mesure technique*, *recadrage*, ou *acceptation assumée du recouvrement*. Et §0 classe la testabilité ⚠️ **partielle** : **jamais `adopter`** sur la moitié non exécutable, frontière tracée explicitement en §6.4.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **Le serveur MCP de Vibe Kanban n'est pas ce que la fiche décrit.** Éditeur commercial arrêté en avril 2026 : le paquet `npx` peut avoir cessé de fonctionner, ou sa surface avoir changé. | `tools/list` réel : si le compte s'écarte de **33**, ou si le serveur ne démarre pas, le §2 est à corriger |
| **K2** | **Le contre-argument « budget de contexte » de §6.5 est nul.** | si seuls les **noms** d'outils entrent en contexte (`E08`), le surcoût de cohabitation se mesure en centaines d'octets, pas en milliers de tokens ⇒ l'argument tombe |
| **K3** | **La corrélation est impossible.** Sans chemin de worktree ni branche exposés, `target_files` ne se corrèle pas entre agents. | **0** champ de chemin ou de branche dans les schémas de `create_session` / `start_workspace` ⇒ l'adaptateur du §6.1 est **inconstructible** |
| **K4** | **YAGNI.** | **0** issue mentionnant worktree, Conductor, Vibe Kanban ou un orchestrateur |
| **K5** | **La menace est de l'attention, pas de la capacité.** | si aucun de ces outils ne détecte un conflit d'intention, « occupation de la couche » ne décrit pas une perte de fonction |
| **K6** | **L'API Conductor est hors de portée.** Clé délivrée depuis une app macOS. | non exécutable ⇒ **inmesurable**, et aucun verdict ne s'y appuie |
| **K7** | **Ce qui reste défendable est-il non vide ?** | s'il ne reste rien que ces outils ne fassent, la fiche annonce une défaite et non une frontière |

**Ce que je m'interdis**, leçons des quatre passes précédentes : publier un chiffre que je n'ai pas produit moi-même (`G01`) ; conclure sur la capacité d'un tiers depuis son absence sur mon poste plutôt que depuis son code (`D02`) ; comparer deux objets de natures différentes et en tirer un rapport de force (`G01`, `D02`) ; et déclarer « inmesurable » ce qui est seulement « non exécutable » alors que le source ou le protocole répondent.

### 6.3 Protocole de vérification

<Proposition, non exécutée. Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ L'API Conductor n'est pas exécutable ici : la clé d'API se génère depuis l'app Conductor, macOS-only.

- [ ] Lancer `npx -y vibe-kanban@latest --mcp` et lister réellement `tools/list` : vérifier les 33 noms d'outils annoncés, leurs schémas d'entrée, et si `create_session` expose un identifiant stable réutilisable comme `agent_id`.
- [ ] Brancher `vibe_kanban` **et** `coordinator` dans le même `.mcp.json` (le merge est déjà géré par `cli/init.ts` l. 225-236), ouvrir une session Claude Code et mesurer le coût en tokens du `tools/list` cumulé (33 outils + les nôtres) — la cohabitation peut être disqualifiée par le seul budget de contexte.
- [ ] Vérifier si un workspace Vibe Kanban / Conductor expose son chemin de worktree et sa branche : sans cela, `target_files` de `announce_work` ne se corrèle pas entre agents (chemins absolus divergents — voir `src/path-normalize.ts`).
- [ ] Tester l'API Conductor `v0` en lecture seule (`GET /workspaces`) avec une clé de test : confirmer le statut beta, la pagination `limit`/`offset` + `hasMore`, et si un webhook ou un polling est le seul moyen de suivre l'état des sessions.
- [ ] Scénario réel à 3 agents dans 3 worktrees sur ce repo, sans coordinateur puis avec : compter les conflits d'intention effectivement produits. Si le compte est zéro sans coordinateur, la menace comme le bénéfice sont surestimés.

### 6.4 Résultat observé

**Frontière entre ce qui a tourné et ce qui n'a pas pu.** Exécuté : le lancement réel du serveur MCP de Vibe Kanban et sa sonde `initialize` / `tools/list`. **Non exécuté** : l'API Conductor (clé délivrée depuis une app macOS) et le scénario à 3 worktrees. **Volontairement non exécuté** : lancer l'application Vibe Kanban complète — c'est un démon web tiers, et le protocole n'autorise qu'un PoC jetable ; je dis plus bas ce que cela laisse ouvert.

#### K1 — le serveur existe, mais ce n'est pas un serveur (se déclenche, autrement que prévu)

Le paquet est bien vivant : `npx -y vibe-kanban@latest` télécharge un binaire de 7,2 Mio et démarre en **v0.1.44**, quatre mois après l'arrêt commercial. Mais il ne répond à rien :

```
serveur demarre (signal stderr vu) : true
octets recus sur stdout : 0
initialize : AUCUNE REPONSE
tools/list : AUCUNE REPONSE

stderr :
  [vibe-kanban-mcp] Starting Vibe Kanban MCP server version 0.1.44...
  utils::port_file: Reading port from "C:\Users\gagno\AppData\Local\Temp\vibe-kanban\vibe-kanban.port"
  Error: Le chemin d'accès spécifié est introuvable. (os error 3)
```

Le répertoire `%TEMP%\vibe-kanban` **n'existe pas**, et le processus meurt. Le `--help` du binaire donne la clé :

```
Commands:
  [...args]         Launch the local vibe-kanban app
  review [...args]  Run the review CLI
  mcp [...args]     Run the MCP server
```

**`vibe-kanban --mcp` n'est pas un serveur MCP autonome : c'est une façade stdio qui lit un fichier de port et se connecte à l'application Vibe Kanban déjà lancée.** Sans l'app, la surface MCP n'existe pas.

C'est le fait le plus important de ce challenge, et il n'est **écrit nulle part** — j'ai posé la question à leur documentation d'intégration, qui décrit le serveur comme « local-only », « runs on your computer », et **n'énonce aucun prérequis** de démon. Le snippet `.mcp.json` que le §2 reprend fidèlement de cette doc **ne fonctionne pas** tel quel.

Le décompte, lui, est confirmé : la doc énumère **33** outils, exactement la liste du §2. Je n'ai pas pu le vérifier par `tools/list` — cela aurait exigé de lancer leur application ; je le note et je ne prétends pas l'avoir mesuré.

**Ce que K1 change pour le §4.** Le §4 écrit : *« C'est de la coordination d'agents exposée en MCP, distribuée en `npx`, exactement le canal et le mode d'installation de mcp-coordinator. »* C'est faux sur le mode d'installation. `mcp-coordinator` est un serveur autonome — stdio (`src/index.ts`) ou HTTP (`src/serve-http.ts`) — qui tourne sans qu'aucune interface ne soit ouverte. Vibe Kanban expose une surface MCP **à ses propres utilisateurs déjà équipés**. Ce n'est pas le même produit sur le même canal, c'est une intégration d'app.

#### K2 — le contre-argument « budget de contexte » est nul (se déclenche)

`E08` a mesuré que Claude Code **défère** les définitions d'outils MCP : seuls les *noms* entrent dans le contexte du premier tour, les schémas se chargent à la demande. Je n'ai pas à le prendre sur parole — la session qui écrit ces lignes en est une démonstration : son propre prompt système liste une centaine d'outils différés **par nom seul**, avec l'instruction d'aller chercher leurs schémas.

Coût réel d'une cohabitation, calculé sur la liste documentée :

```
outils vibe_kanban documentes : 33
taille des seuls NOMS, prefixes mcp__vibe_kanban__ : 1132 caracteres
longueur moyenne d'un nom : 15,3
```

**≈ 1,1 kio**, soit quelques centaines de tokens — à comparer aux **16 064 caractères** que `E08` a mesurés pour le seul `tools/list` de nos 26 outils. **K2 se déclenche : l'argument tombe.** Le §6.5 écrivait que « la cohabitation peut être disqualifiée par le seul budget de contexte » ; elle ne peut pas, et sa solution proposée (`--strict-mcp-config`) répond à un problème qui n'existe plus.

#### K3 — la corrélation reste ouverte (ne se déclenche pas, faute de mesure)

Je voulais lire dans les schémas de `create_session` / `start_workspace` s'il existe un champ de chemin de worktree ou de branche. **Impossible sans `tools/list`, donc sans lancer leur app.** Je ne tranche pas, et je ne déduis rien des noms d'outils.

**Non déclenché ≠ non mesuré**, et c'est ici « non mesuré ». Le §7 ne s'appuie pas sur K3.

#### K4 — YAGNI (se déclenche)

```
"worktree"     -> 0 issue        "conductor"    -> 0 issue
"vibe kanban"  -> 0 issue        "orchestrator" -> 0 issue
```

**K4 se déclenche.** *Correction mineure au §6.5, qui écrit « le repo n'a pas une seule mention de "worktree" hors du site marketing » : il y en a deux, `cli/dependency-error.ts` et `docs/troubleshooting.md`, toutes deux incidentes et sans rapport avec les orchestrateurs. La conclusion tient, la formulation non.*

#### K5 — la menace porte sur l'attention, pas sur la capacité (se déclenche)

Aucun de ces outils ne détecte un conflit d'intention : ils isolent physiquement (un worktree par tâche, donc un inode par fichier) et délèguent l'arbitrage à l'humain au merge. Le §6.5 le dit déjà en dernière ligne — *« ils occupent la couche MCP mais pas la fonction »* — et rien dans ce que j'ai observé ne le contredit. **K5 se déclenche**, et il vide le risque n° 1 du §4 : « occupation de la couche » décrit une concurrence d'installation et d'attention, pas une perte de capacité.

#### K6 — l'API Conductor (inmesurable)

La clé se génère depuis l'app Conductor, macOS-only ; le poste est sous Windows. **Déclaré inmesurable**, aucun verdict ne s'y appuie. Je note seulement ce que la doc primaire dit déjà et que le §0 a vérifié : l'API se déclare **beta**, « Request and response shapes may change ».

#### K7 — ce qui reste défendable (ne se déclenche pas)

Non vide, et la mesure l'élargit plutôt qu'elle ne le rétrécit. Ces outils isolent des **fichiers** ; ils n'ont aucune notion d'intention partagée, aucune détection de chevauchement, et — sur le plan de la distribution — aucun ne fournit une surface MCP qui tourne sans son interface. `mcp-coordinator` est un serveur autonome, multi-transport, utilisable par un client MCP quelconque sans installer d'application. **K7 ne se déclenche pas.**

**Réserve d'honnêteté sur la consolidation du marché.** Le §1 et le §6.5 s'appuient lourdement sur trois disparitions (Terragon mort, Vibe Kanban sans éditeur, Crystal gelé) pour conclure à la fragilité de la catégorie. Je n'ai vérifié aucune de ces trois dates moi-même — elles viennent du §0 du 2026-08-14. Ce que j'ai vérifié, c'est que le paquet Vibe Kanban **fonctionne encore** et publie une v0.1.44 : l'abandon éditorial n'a pas tué l'outil.

#### Ce que la passe adversariale a corrigé — quatre rétractations

**1. « Sans l'app, la surface MCP n'existe pas » était une surinterprétation.** Ma sonde était bonne — l'échec est réel et reproductible — mais j'ai conclu trop large. Refait par moi avec une simple variable d'environnement, sans app, sur un port **mort** :

```
MCP_PORT=59998, aucun listener, aucun fichier de port
  initialize     : REPOND
  tools/list     : 33 outils, 17 900 caracteres
```

La dépendance n'est pas à l'application en marche, elle est à une **URL de backend résolvable**. Sans elle le processus meurt au démarrage ; avec elle — même morte — la surface MCP est servie intégralement, et seuls les `tools/call` échouent. La formulation corrigée est là. Le fait que le snippet publié par leur doc ne fonctionne pas tel quel reste vrai ; la raison, non.

**2. La liste d'outils du §2 est fausse, et le compte est juste par accident.** Mon `tools/list` réel :

```
update_session present ? true      <- absent de la liste du §2
get_context     present ? false    <- present dans la liste du §2
```

`get_context` est retiré du routeur quand le contexte Vibe Kanban est absent. Le §2 compte donc 33 parce que deux erreurs s'annulent. J'avais écrit « le décompte est confirmé » sur la foi de leur doc, sans l'avoir mesuré — exactement ce que je m'étais interdit en §6.2.

**3. K3 était mesurable, et il ne se déclenche pas.** J'avais écrit « impossible sans lancer leur app ». Faux : la même sonde le donne.

```
champs "branch" dans les schemas : 3
```

Il y a une branche par workspace, requise à la création et filtrable à la liste. Le seuil de K3 était « **0** champ de chemin ou de branche ⇒ adaptateur inconstructible ». **L'adaptateur du §6.1 est constructible.** Refuser reste possible — mais alors faute de besoin, pas faute de moyen, et c'est une tout autre phrase.

**4. Mon arithmétique de K2 comparait deux natures.** J'opposais 1 132 caractères **déférés** à 16 064 caractères **non déférés**. Le bon dénominateur est l'empreinte de premier tour des deux serveurs, et `E08` — tranchée le 2026-08-17, **sur une branche non fusionnée**, ce que j'aurais dû préciser — donne la formule : *« ≈ 26 noms + `MCP_INSTRUCTIONS` (1 348 caractères) — pas 16 064 caractères »*. Les `instructions` comptent, et celles de Vibe Kanban relistent ses noms d'outils. Ordre de grandeur corrigé : ≈ 2,2 kio contre ≈ 1,9 kio, soit une cohabitation qui **quasi double** l'empreinte MCP du premier tour. **K2 se déclenche quand même** — « disqualifiée par le seul budget de contexte » reste faux à 4 kio — mais ma démonstration était fausse d'un ordre de grandeur.

**Et une erreur de fait sur K4.** J'ai écrit « 0 issue » sur quatre termes. Vrai pour trois. Sur `worktree` il y en a **six** : #279, #275, #377, #282, #286, #258 — dont **#279 et #377 ouvertes**, et #279 porte précisément *« identique pour deux worktrees du même dépôt »*. **K4 ne se déclenche pas au seuil que j'avais pré-enregistré.**

#### Le fait que je n'avais pas cherché, et qui décide

Les worktrees de Vibe Kanban vivent sous le répertoire temporaire du système, hors de tout dépôt. Or notre normalisation refuse durement un chemin absolu hors racine :

```js
// src/path-normalize.ts:33
if (!lowerP.startsWith(lowerRoot + "/") && lowerP !== lowerRoot) {
  throw new Error(`path is outside repoRoot: ${input}`);
}
```

et `src/tools/consultation-tools.ts:117-124` transforme cette levée en refus d'`announce_work`. `COORDINATOR_REPO_ROOT` est une **valeur globale unique**. Un utilisateur qui lance quatre agents dans quatre worktrees d'orchestrateur et déclare des chemins absolus est donc **rejeté**, avec un message qui dit « path is outside repoRoot » et non « déclarez en relatif ».

C'est le cas d'usage que le §4 décrit, et il échoue chez nous — pas chez eux.

### 6.5 Contre-arguments

- **Dépendance à des surfaces instables ou mourantes.** L'API Conductor est explicitement beta (« shapes may change »). Vibe Kanban a perdu son éditeur commercial en avril 2026 et vit en communautaire. Crystal est gelé, Terragon est mort. Écrire un adaptateur, c'est parier sur un survivant dans une catégorie qui a enterré trois acteurs en un an.
- **Coût de maintenance non amorti.** Chaque orchestrateur a son propre modèle (workspaces/sessions chez Conductor, issues/workspaces/sessions chez Vibe Kanban, rien du tout chez Claude Squad). Il n'y a pas de format commun à cibler : un adaptateur = un adaptateur par outil, plus les ruptures de schéma d'une beta.
- **Rupture de portabilité.** Conductor est une app **Mac** et son cloud est un SaaS ; le mainteneur travaille sous Windows PowerShell. L'auto-hébergeur qui installe mcp-coordinator pour rester chez lui n'a aucune raison d'ajouter un chemin vers `api.conductor.build`.
- **YAGNI.** Aucune demande utilisateur connue. Le repo n'a pas une seule mention de « worktree » hors du site marketing — le sujet est un argument de vente, pas un besoin remonté.
- **Budget de contexte.** 33 outils `vibe_kanban` en plus des nôtres dans le même `tools/list` : la cohabitation peut être plus coûteuse en tokens que la valeur ajoutée de la coordination, et se régler par un simple `--strict-mcp-config`.
- **Risque de brouiller le positionnement.** Si mcp-coordinator se met à parler de workspaces et de sessions, il devient un demi-orchestrateur, moins bon que ceux qui en font leur métier. La réponse actuelle du FAQ (« les worktrees isolent les fichiers, nous coordonnons l'intention, utilisez les deux ») est défendable telle quelle et coûte zéro ligne de code.
- **Menace peut-être surévaluée.** Aucun de ces outils ne fait de détection de conflit d'intention ; ils occupent la couche MCP mais pas la fonction. La concurrence est sur l'attention et l'installation, pas sur la capacité.

---

## 7. Décision

Fiche menace : le verdict porte sur la **réponse** (`_CHALLENGE-PROMPT.md:126-127`).

| | |
|---|---|
| **Verdict** | **Réponse : contre-mesure technique — la nôtre, pas la leur.** ✅ **contre-mesure technique** · ⬜ recadrage · ⬜ acceptation assumée |
| **Date** | 2026-08-17 |
| **Justification** | La menace n'est pas qu'ils occupent notre couche : **c'est que leur population nous casse**. Les worktrees d'orchestrateur vivent hors dépôt, et `src/path-normalize.ts:33` refuse durement tout chemin absolu hors `COORDINATOR_REPO_ROOT` — valeur **globale unique**. L'utilisateur que le §4 décrit est rejeté chez nous. Le livrable est de notre côté, indépendant de tout tiers. |
| **Issue / PR** | à ouvrir sur la racine par agent ; amendement de `compare.card5` en second |
| **Jalon visé** | prochain jalon pour la contre-mesure ; adaptateur : condition de réveil en §7.3 |

### 7.1 Pourquoi pas « recadrage », que j'allais rendre

J'avais formé un verdict `recadrage` : corriger le §4, ne rien construire. La passe adversariale l'a démoli par un précédent nominatif.

`00-SYNTHESE.md` écrit, dans le paragraphe qui pointe **explicitement vers `D03` et `G02` ensemble** : *« Cette reformulation est un travail de positionnement, pas de code. »* Or `D03` §7.4, tranchée le 2026-08-15 **sur `main`**, a rayé cette phrase par son nom :

> *« Le recadrage éditorial comme réponse principale. Il est déjà écrit (`docs/index.html:2077`). **Le répéter ne comble pas le trou.** »*

Rendre `recadrage` pour `G02`, c'est rendre pour la fiche jumelle la conclusion que le corpus vient d'annuler pour l'autre. Et le trou que `D03` nommait — aucun moyen d'exprimer « cet agent est dans le worktree X » — est **exactement** celui que les worktrees hors dépôt de ces orchestrateurs font tomber en refus.

### 7.2 La contre-mesure retenue

**Traiter le worktree hors racine.** Trois formes possibles, à trancher à l'implémentation, par ordre de coût croissant : un message d'erreur qui **nomme la convention** (« déclarez des chemins relatifs à la racine du dépôt ») au lieu de « path is outside repoRoot » ; une racine **par agent** plutôt qu'une globale ; une canonicalisation worktree-relative.

Ce livrable a trois propriétés qui le distinguent d'un adaptateur :

1. **Il ne couple à aucun tiers.** Il sert les worktrees natifs de `D03` autant que Conductor, Vibe Kanban ou Claude Squad, et il survit à la mort de n'importe lequel d'entre eux — ce que le §6.5 reproche à juste titre à un adaptateur.
2. **Il rouvre ce que `D03` avait fermé, pour un motif qui ne tient plus.** `D03` §7.4 écartait le worktree comme entité de première classe au motif que c'est du *« vocabulaire propriétaire Claude Code, mort pour Cursor/Cline/Aider »*. Ce motif s'effondre ici : ces orchestrateurs sont **multi-vendeurs** par construction. La même correction, vue depuis `G02`, n'est plus propriétaire.
3. **Il a une demande enregistrée.** #279 est ouverte et dit *« identique pour deux worktrees du même dépôt »*.

### 7.3 Ce qui est refusé, et à quelle condition ça se rouvre

**L'adaptateur du §6.1 — refusé, en connaissance de cause.** Il est **constructible** : `branch` est requis à la création d'un workspace et filtrable à la liste, et l'identifiant de session est stable. Je le refuse sur la fragilité de la catégorie (trois acteurs enterrés en un an, une API beta qui annonce ses ruptures) et sur l'absence de demande nommant ces produits — `conductor`, `vibe kanban`, `orchestrator` : **0 issue**. Faute de besoin, pas faute de moyen.

**Condition de réveil :** le premier utilisateur qui déclare piloter mcp-coordinator depuis un de ces orchestrateurs. À ce moment-là, K3 étant déjà mesuré, l'adaptateur se chiffre sans nouvelle enquête.

**Documenter la cohabitation dans `cli/init.ts` — refusé aussi**, et le second terme de §6.1 est mal énoncé : le merge de `mcpServers` est **déjà implémenté**, et le snippet que `cli/init.ts` émet est `type: "http"`, pas stdio. Il n'y a jamais eu de doc de cohabitation à écrire. S'y ajoute que le snippet publié par leur propre doc ne fonctionne pas seul : documenter une cohabitation reviendrait à livrer une instruction cassée.

### 7.4 Le recadrage, borné et chiffré

En second, pas en principal. `docs/index.html` porte déjà `compare.card5` sur les orchestrateurs — mais ses exemples sont `essaim`, AutoGen, CrewAI, c'est-à-dire des **frameworks de boucle d'agent**. La catégorie de cette fiche (un worktree par tâche, une UI kanban) n'est couverte par aucune des cinq cartes. **Amender `card5`** plutôt que créer une septième carte : c'est deux fois moins cher, et **#377** a déjà réservé la sixième pour un autre concurrent. Coût : 7 éditions par chaîne modifiée (markup + six langues). Ne pas toucher `faq.q1`/`a1`, déjà juste.

### 7.5 Corrections à porter à la fiche, hors verdict

1. **§2 : la liste d'outils est fausse.** `update_session` manque, `get_context` n'est pas exposé hors contexte Vibe Kanban. Le total de 33 n'est pas un invariant — il dépend du mode.
2. **§4 : « exactement le canal et le mode d'installation »** est faux, mais pas comme je l'avais d'abord écrit. Le mode d'installation `npx` dans `mcpServers` est bien identique ; ce qui diffère est l'**autonomie**. Et notre propre snippet documenté est `type: "http"` vers un daemon, pas du stdio npx.
3. **§4, risque n° 1 « occupation de la couche » :** à retirer comme risque protocolaire. Ils occupent la couche MCP sans occuper la fonction — aucun ne détecte un conflit d'intention. La concurrence est sur l'installation et l'attention.
4. **§6.5, « budget de contexte » :** nul, mais l'ordre de grandeur correct est ≈ 2 kio par serveur au premier tour, pas « 33 outils dans le `tools/list` ».
5. **§6.5, « le repo n'a pas une seule mention de worktree hors du site marketing » :** faux — 6 issues et une fiche entière (`D03`) y sont consacrées.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. Fiche brute `orchestrateurs-worktree-tiers` **réfutée** sur deux points (absence d'API publique, statut de « client potentiel » de Vibe Kanban) ; corrections du vérificateur intégrées. |
| 2026-08-14 | Vérification des faits : §2 et §5 confirmés sur doc primaire et sur le code ; pagination Conductor précisée, marqueur restant tranché. |
| 2026-08-17 | Challenge. **Réponse : contre-mesure technique.** Sonde réelle du serveur MCP de Vibe Kanban : `npx vibe-kanban mcp` meurt sans URL de backend résolvable (`os error 3` sur le fichier de port), mais un simple `MCP_PORT` vers un port **mort** suffit à servir les **33** outils (17 900 caractères) — ma première conclusion « sans l'app la surface n'existe pas » était une surinterprétation, retirée. Le §2 se trompe de liste : `update_session` manque, `get_context` n'est pas exposé. K3 était **mesurable** et ne se déclenche pas (3 champs `branch`) : l'adaptateur est constructible, refusé faute de besoin et non faute de moyen. K2 se déclenche mais mon arithmétique comparait du déféré à du non déféré (ordre de grandeur faux). K4 ne se déclenche pas : **6** issues mentionnent `worktree`, dont #279 et #377 ouvertes. **Le fait décisif, que je n'avais pas cherché :** leurs worktrees vivent hors dépôt et `path-normalize.ts:33` refuse durement tout chemin absolu hors `COORDINATOR_REPO_ROOT`, valeur globale unique — la population que le §4 décrit est rejetée chez nous. Verdict `recadrage` abandonné : `D03` §7.4 a rayé le recadrage éditorial comme réponse principale pour le paragraphe de synthèse qui nomme `D03` et `G02` ensemble. |
