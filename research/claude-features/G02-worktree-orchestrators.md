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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition, non exécutée. Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ L'API Conductor n'est pas exécutable ici : la clé d'API se génère depuis l'app Conductor, macOS-only.

- [ ] Lancer `npx -y vibe-kanban@latest --mcp` et lister réellement `tools/list` : vérifier les 33 noms d'outils annoncés, leurs schémas d'entrée, et si `create_session` expose un identifiant stable réutilisable comme `agent_id`.
- [ ] Brancher `vibe_kanban` **et** `coordinator` dans le même `.mcp.json` (le merge est déjà géré par `cli/init.ts` l. 225-236), ouvrir une session Claude Code et mesurer le coût en tokens du `tools/list` cumulé (33 outils + les nôtres) — la cohabitation peut être disqualifiée par le seul budget de contexte.
- [ ] Vérifier si un workspace Vibe Kanban / Conductor expose son chemin de worktree et sa branche : sans cela, `target_files` de `announce_work` ne se corrèle pas entre agents (chemins absolus divergents — voir `src/path-normalize.ts`).
- [ ] Tester l'API Conductor `v0` en lecture seule (`GET /workspaces`) avec une clé de test : confirmer le statut beta, la pagination `limit`/`offset` + `hasMore`, et si un webhook ou un polling est le seul moyen de suivre l'état des sessions.
- [ ] Scénario réel à 3 agents dans 3 worktrees sur ce repo, sans coordinateur puis avec : compter les conflits d'intention effectivement produits. Si le compte est zéro sans coordinateur, la menace comme le bénéfice sont surestimés.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

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
| 2026-08-14 | Fiche créée par la veille plateforme. Fiche brute `orchestrateurs-worktree-tiers` **réfutée** sur deux points (absence d'API publique, statut de « client potentiel » de Vibe Kanban) ; corrections du vérificateur intégrées. |
| 2026-08-14 | Vérification des faits : §2 et §5 confirmés sur doc primaire et sur le code ; pagination Conductor précisée, marqueur restant tranché. |
