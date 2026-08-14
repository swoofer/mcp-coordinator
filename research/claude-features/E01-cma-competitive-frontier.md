# E01 — MENACE : Claude Managed Agents et l'orchestration multi-agents hébergée

> **Gabarit de fiche.** Une fiche = une feature de la plateforme Claude/Anthropic.
> Les sections 1 à 5 sont remplies par la veille. Les sections 6 à 8 sont remplies
> **pendant le challenge** de la feature (une session dédiée par fiche).

| Champ | Valeur |
|---|---|
| **ID** | `cma-competitive-frontier` |
| **Surface** | managed-agents |
| **Statut** | **mixte** : beta publique (Managed Agents, multiagent orchestration, Vaults, `github_repository`) · **research preview** sur demande d'accès (MCP tunnels, dreaming) — aucun GA au 2026-08-14 |
| **Disponible depuis** | Managed Agents : beta publique **8 avril 2026** · multiagent orchestration + Outcomes : **6 mai 2026** · entrée `advisor` du roster : ~7 août 2026 (non horodaté dans la doc primaire) · header `managed-agents-2026-04-01` |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | L |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — collision testable en local, session CMA non |
| **Statut du challenge** | ⬜ à faire |

> **Divergence entre chercheurs, non tranchée.** Trois dates circulent pour la beta publique de la brique multiagent : 6 mai 2026, 19 mai 2026 (billet blog Anthropic), et une confusion avec la conférence Code with Claude à San Francisco. Le consensus des vérificateurs : Managed Agents est en beta publique depuis le **8 avril 2026** (d'où le header daté `2026-04-01`), la conférence n'a **pas** annoncé le produit mais l'a démontré, et la brique multiagent est arrivée en mai. La date du **7 août 2026** pour l'`advisor` n'est attestée que par des sources secondaires. Ces dates n'engagent aucune décision technique.

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §1 — les outils de délégation `list_agents` / `send_to_agent` n'appartiennent **pas** au toolset `agent_toolset_20260401`. La page `managed-agents/tools` donne la liste exhaustive de ce toolset : `bash`, `read`, `write`, `edit`, `glob`, `grep`, `web_fetch`, `web_search`. Les deux outils de délégation sont conférés par la déclaration `multiagent` sur le coordinateur. Formulation corrigée. (Le nom des deux outils est lui exact : attesté sur `multiagent-orchestration`, section « Advisor threads ».)
- §2 — `budget.max_list_cost.amount` est une **chaîne** de cents US (`"2500"` = $25.00), pas un nombre ; la doc précise que le type string évite tout arrondi flottant. Exemple corrigé.
- §2 — `environment_id` est requis dans le corps de `POST /v1/sessions` et manquait au bloc. Ajouté.
- §5 — `src/tools/files-tools.ts` : la citation « l. 8-9 » pointait sur le commentaire d'en-tête. Les trois enregistrements sont aux lignes 20, 35 et 50. Corrigé.

Vérifiés et **exacts, sans changement** : header `managed-agents-2026-04-01` (+ `agent-memory-2026-07-22` pour les memory stores) ; `agent_toolset_20260401` et `BetaManagedAgentsAgentToolset20260401Params` ; les trois formes de roster (`agent` / `self` / `advisor`), max 1 advisor, nom réservé `anthropic.advisor`, contrainte de capacité modèle→advisor (400), contrainte `model.inference_geo` homogène (400) ; 20 agents uniques, 25 threads concurrents (advisor exempté), un seul niveau de délégation, roster snapshotté ; `multiagent: null` vide le roster ; endpoints threads / archive (idle seulement) / streams / `event_deltas[]` ; les cinq noms d'événements multiagent et leurs champs (`from_session_thread_id`, `from_agent_name`, `to_session_thread_id`, `to_agent_name`) ; `agent_with_overrides` et le piège « overrides = coordinateur + copies `self` uniquement » ; `initial_events` max 50 limité à `user.message` / `user.define_outcome` ; `stop_reason: budget_reached` ; `resources[{type:"github_repository"}]` avec `mount_path` optionnel par défaut `/workspace/<repo-name>`, jeu de dépôts figé, ids `sesrsc_01...`, `POST .../resources/{id}` = rotation de token seulement ; `github_repository` non supporté en sandbox self-hosted (attesté sur `managed-agents/skills`) ; layout de skills exactement `.claude/skills/<nom>/SKILL.md` un seul niveau, découverte dépendante de l'outil `read` ; toute la surface Vaults / Credentials (endpoints, `auth.type`, `refresh`, `token_endpoint_auth.type`, `networking`, `injection_location`, `mcp_oauth_validate` → `vault_credential_validation`, 5 webhooks, max 20 credentials, write-only, clés immuables) ; workspace-scoped ; credentials non validés avant le runtime de session ; en multiagent les credentials s'appliquent à tous les threads ; premier vault qui matche gagne ; normalisation d'URL MCP (schéma/hôte minusculés, port par défaut et slash final ignorés) ; `mcp_connection_failed_error` et `mcp_authentication_failed_error` sur `session.error` ; les 7 flags `ant beta:worker` et les deux variables d'environnement ; 300 req/min en création et 1200 req/min en lecture ; non éligible ZDR ni HIPAA BAA ; branding guidelines interdisant « Claude Code » / « Claude Cowork ».

**Statut :** toujours exact. La page `managed-agents/overview` du 2026-08-14 dit littéralement « Claude Managed Agents is in beta », header obligatoire, avec MCP tunnels et dreaming en research preview sur demande d'accès. Aucun GA. Les dates de la note de divergence n'ont pas été retranchées : elles restent hors du périmètre de cette passe et n'engagent aucune décision.

**Points d'intégration §5 :** les 21 fichiers cités existent tous. Numéros de ligne revérifiés et exacts pour `agents-tools.ts` (21, 50), `consultation-tools.ts` (37, et bien 11 outils enregistrés), `serve-http.ts` (13, 801, 239-256, 788-796), `cli/channel.ts` (37, 536), `sdk/src/client.ts` (37 — `export class McpCoordinatorClient`), `README.md` (7, 26, 141, 243 « All 26 tools »), `docs/ARCHITECTURE.md` (266). Seul `files-tools.ts` était faux (corrigé ci-dessus). La collision de nom `list_agents` est réelle : `src/tools/agents-tools.ts:50` enregistre bien un outil MCP de ce nom.

**Marqueurs `(à vérifier)` restants :** aucun en §2. Il subsiste une mention « à vérifier » en §6.5 (branding vs README et `docs/index.html`) — c'est une tâche du challenge, pas un fait non résolu, et elle n'a pas été touchée.

**Testabilité :** ⚠️ partielle
Testable ici et maintenant : la collision de nom (monter le daemon local et un second serveur MCP exposant `list_agents`, puis lire ce que renvoie `tools/list` au client), et le chiffrage du coût du chemin d'intégration par lecture de code. Non testable ici : tout ce qui exige une **session CMA réelle** — la race sur le filesystem partagé, le piège des overrides, le handshake MCP depuis un sandbox Anthropic. Il y faudrait une clé d'API Anthropic avec le header beta `managed-agents-2026-04-01`, une instance mcp-coordinator joignable depuis Internet (tunnel + `COORDINATOR_PUBLIC_URL`), et du temps de sandbox facturé.

---

## 1. Ce que c'est

Anthropic vend désormais le harness d'agent lui-même : boucle d'agent, exécution d'outils, sandbox (cloud Anthropic ou `self_hosted` sur l'infra du client), checkpointing, prompt caching, compaction, tracing. Le modèle objet compte une douzaine de ressources — Agent, Environment, Session, Events, Session Resources, Session Threads, Outcomes, Multiagent, Vaults, Credentials, Memory Stores, Deployments — exposées sur `/v1/agents`, `/v1/environments`, `/v1/sessions`, avec un flux d'événements SSE typé `{domain}.{action}`. Le message affiché par Anthropic est explicite : « infrastructure, rather than intelligence, is now the bottleneck for production agents ».

La partie qui touche directement mcp-coordinator est **multiagent orchestration**. Un agent déclare `multiagent: {type: "coordinator", agents: [...]}` ; la plateforme lui donne alors deux outils de délégation, `list_agents` et `send_to_agent` — conférés par la déclaration `multiagent` elle-même, et **non** par le toolset `agent_toolset_20260401`, dont la liste exhaustive est `bash`/`read`/`write`/`edit`/`glob`/`grep`/`web_fetch`/`web_search` —, et gère le fan-out, le cycle de vie des child threads et l'observabilité par thread. Chaque agent délégué tourne dans son propre *session thread* (historique, outils, `mcp_servers` et contexte isolés), mais **tous partagent le même sandbox, le même système de fichiers et les mêmes credentials de vault**. Une session peut monter un dépôt via `resources[{type:"github_repository"}]`, et charge alors automatiquement les skills trouvées dans `.claude/skills/<nom>/SKILL.md`.

Les limites dessinent la frontière : 20 agents **uniques** au roster (mais plusieurs copies du même agent sont possibles, donc le fan-out réel est borné par les **25 threads concurrents**), **un seul niveau de délégation** (référencer un agent qui a lui-même un roster échoue à la validation), roster **snapshotté** aux versions épinglées au moment du create/update. Une seule topologie : hiérarchique, fermée, mono-sandbox. Rien pour des sessions hétérogènes indépendantes (Claude Code local + Cursor + Cline sur le même checkout), rien pour la détection de conflit fichier, aucun registre pair-à-pair.

Conséquence à formuler comme **déduction, pas comme fait documenté** : la doc décrit un filesystem partagé entre threads concurrents et ne documente ni lock, ni annonce d'intention, ni garde-fou d'écriture. Deux agents CMA qui éditent le même fichier en parallèle n'ont, dans la doc, rien qui les en empêche.

## 2. Surface d'API exacte

```
anthropic-beta: managed-agents-2026-04-01        # tous les endpoints Managed Agents…
anthropic-beta: agent-memory-2026-07-22          # …SAUF les endpoints memory store
                                                  # (les SDK posent le bon header)
```

**Multiagent (POST /v1/agents · `client.beta.agents.create`)**

```jsonc
{
  "multiagent": {
    "type": "coordinator",
    "agents": [
      { "type": "agent", "id": "<agent_id>", "version": "<optionnel, épinglé>" },
      { "type": "self" },
      { "type": "advisor", "model": "<model id>" }   // max 1, nom réservé anthropic.advisor
    ]
  },
  "tools": [{ "type": "agent_toolset_20260401" }]     // BetaManagedAgentsAgentToolset20260401Params
}
// "multiagent": null  → vide le roster
```

Outils exposés au coordinateur : `list_agents`, `send_to_agent` — conférés par la déclaration `multiagent`, pas par `agent_toolset_20260401` (ce toolset ne contient que `bash`, `read`, `write`, `edit`, `glob`, `grep`, `web_fetch`, `web_search`).
L'`advisor` **n'est pas** un agent du roster : invisible à `list_agents`, injoignable par `send_to_agent`, consultable seulement par le primary thread, ses threads sont exemptés de la limite de 25. Contraintes : le modèle de l'agent ne doit pas être plus capable que celui de l'advisor (400) ; tous les `model.inference_geo` du coordinateur et du roster doivent être identiques ou tous absents (400).

**Threads et streaming**

```
GET  /v1/sessions/{session_id}/threads
POST /v1/sessions/{session_id}/threads/{thread_id}/archive   # n'aboutit que si le thread est `idle`
GET  /v1/sessions/{session_id}/events/stream                 # = primary thread
GET  /v1/sessions/{session_id}/threads/{thread_id}/stream
    ?event_deltas[]=...                                      # deltas stream-only event_start / event_delta
```

Événements du primary thread : `session.thread_created`, `session.thread_status_running|idle|terminated`, `agent.thread_message_received` (`from_session_thread_id`, `from_agent_name`), `agent.thread_message_sent` (`to_session_thread_id`, `to_agent_name`). `session_thread_id` figure sur `user.interrupt`.

**Session**

```jsonc
POST /v1/sessions
{
  "agent": { "type": "agent_with_overrides", "id": "...", "version": "...",
             "model": "...", "system": "...", "tools": [], "mcp_servers": [], "skills": [] },
  "environment_id": "...",        // REQUIS
  "initial_events": [],           // max 50, seulement user.message et user.define_outcome
  "budget": { "type": "limit",
              "max_list_cost": { "amount": "2500", "currency": "USD" } },
                                  // amount = cents US en CHAÎNE ("2500" = $25.00), USD seul supporté
                                  // stop reason: budget_reached
  "vault_ids": [],
  "resources": [{ "type": "github_repository", "url": "...", "authorization_token": "...",
                  "mount_path": "/workspace/<repo-name>",        // OPTIONNEL, absolu
                  "checkout": { "type": "branch", "name": "..." } }]   // ou {type:"commit", sha}
}
```

**Piège d'intégration** : les overrides de session ne s'appliquent **qu'au coordinateur et à ses copies `{"type":"self"}"`**, pas aux entrées référencées par `id`. On ne peut donc pas injecter un `mcp_servers` commun à tout un roster par override — il faut le définir agent par agent à la création.

Le jeu de dépôts montés est **figé pour la durée de la session** (`GET /v1/sessions/{id}/resources` liste, ids `sesrsc_01...` ; `POST .../resources/{resource_id}` ne sert qu'à la **rotation du token**, pas à ajouter un dépôt). `github_repository` **n'est pas supporté sur les sandboxes self-hosted**. La découverte de skills exige que l'outil `read` de l'`agent_toolset_20260401` soit actif, et le layout doit être exactement `.claude/skills/<nom>/SKILL.md` (un seul niveau).

**Vaults / Credentials**

```
POST /v1/vaults · GET /v1/vaults?include_archived=true · POST /v1/vaults/{id}/archive · DELETE /v1/vaults/{id}
POST /v1/vaults/{id}/credentials
  auth.type ∈ mcp_oauth | static_bearer | environment_variable
  refresh: { token_endpoint, client_id, scope, refresh_token,
             token_endpoint_auth.type ∈ none | client_secret_basic | client_secret_post }
  networking: { type: "limited", allowed_hosts } | { type: "unrestricted" }
  injection_location: { header, body }
POST /v1/vaults/{id}/credentials/{cid}                       # update, merge par champ
POST /v1/vaults/{vid}/credentials/{cid}/mcp_oauth_validate   # → vault_credential_validation
                                                              #   { status, mcp_probe, refresh, has_refresh_token }
Webhooks: vault.archived, vault.deleted, vault_credential.archived,
          vault_credential.deleted, vault_credential.refresh_failed
Erreurs session: mcp_connection_failed_error, mcp_authentication_failed_error (event session.error)
```

Points qui affaiblissent l'argument « Anthropic fait déjà tout » : les vaults sont **workspace-scoped** (toute clé API du même workspace peut les référencer à la création de session ; le rattachement à un utilisateur final est une convention `display_name`/`metadata`, **pas** une frontière de sécurité), les credentials **ne sont pas validés** à la création de session (un credential cassé ne surface qu'en erreur pendant la session), en multiagent ils s'appliquent à **tous** les threads, et si plusieurs vaults matchent, le premier gagne. Appariement MCP par `mcp_server_url` normalisée (schéma/hôte en minuscules, port par défaut et slash final ignorés ; path, sous-domaine ou port différent ne matchent pas). Max 20 credentials par vault, valeurs write-only, clés immuables après création (`mcp_server_url`, `secret_name`, `token_endpoint`, `client_id`).

**Worker self-hosted**

```
ant beta:worker --environment-id --environment-key --workdir --on-work
                --unrestricted-paths --max-idle --log-format
env: ANTHROPIC_ENVIRONMENT_ID / ANTHROPIC_ENVIRONMENT_KEY      # environment de type `self_hosted`
```

Rate limits par org : 300 req/min en création, 1200 req/min en lecture. **Non éligible ZDR ni HIPAA BAA.** Disponible aussi sur Claude Platform on AWS, avec des différences de features et de comportement de session. La doc impose des **branding guidelines** interdisant aux intégrateurs d'employer « Claude Code » / « Claude Cowork ».

## 3. Sources

- https://platform.claude.com/docs/en/managed-agents/overview.md
- https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration
- https://platform.claude.com/docs/en/managed-agents/agent-setup
- https://platform.claude.com/docs/en/managed-agents/github
- https://platform.claude.com/docs/en/managed-agents/skills#load-skills-from-a-github-repository
- https://platform.claude.com/docs/en/managed-agents/vaults
- https://platform.claude.com/docs/en/managed-agents/mcp-connector
- https://platform.claude.com/docs/en/release-notes/api
- https://platform.claude.com/docs/en/release-notes/overview
- https://claude.com/blog/claude-managed-agents
- https://claude.com/blog/new-in-claude-managed-agents
- https://www.infoq.com/news/2026/05/code-with-claude/

> Une source `releasebot.io` figurait dans le bundle brut ; elle n'a pas été vérifiée et n'est pas officielle — remplacée ci-dessus par les pages `managed-agents/skills` et `managed-agents/multiagent-orchestration`.

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :** deux choses concrètes, aucune n'étant du code à écrire tout de suite.

1. **Un positionnement précis, nommable.** Le README dit aujourd'hui « Building a multi-agent orchestrator → a drop-in conflict layer » (ligne 26). Cette case est désormais occupée par un produit Anthropic. La frontière vérifiée est nette et défendable : CMA orchestre **des agents qu'il héberge lui-même**, tous descendants d'un unique coordinateur, dans **un** sandbox, avec un roster figé ; mcp-coordinator coordonne **des sessions hétérogènes indépendantes** (Claude Code, Cursor, Cline, Aider — README ligne 7) sur un **vrai checkout local**, en pair-à-pair, avec un registre ouvert. Ce n'est plus « fonctionne avec ou sans orchestrateur », c'est « CMA n'est pas un concurrent, c'est un déploiement de plus à couvrir ».

2. **Une place à prendre à l'intérieur de CMA.** Chaque agent d'un roster accepte sa propre liste `mcp_servers`. `src/serve-http.ts` expose déjà un `StreamableHTTPServerTransport` protégé par Bearer, avec un `COORDINATOR_PUBLIC_URL` pour l'origine publique. Un déploiement CMA où N agents partagent un filesystem sans aucun arbitrage documenté est exactement le cas d'usage de `announce_work` / `check_file_conflict` / `ConflictDetector`. L'utilisateur qui en profite : l'équipe qui fait tourner un roster CMA sur son monorepo et voit deux agents s'écraser silencieusement.

**Risque si on ne fait rien :**

- **Collision de vocabulaire immédiate.** `src/tools/agents-tools.ts` expose déjà un outil MCP nommé `list_agents` — nom exact de l'outil de délégation du coordinateur CMA. Un agent CMA équipé d'`agent_toolset_20260401` **et** du serveur mcp-coordinator aura deux `list_agents` de sémantique différente dans son contexte. C'est un bug de collision, pas une question de marketing.
- **Érosion du différenciant Phase 2.** `src/auth/` (OAuth 2.1, 4 IdP, `device-flow.ts`, `refresh-rotation.ts`) et `src/security/envelope-encryption.ts` couvrent le stockage, le refresh et le chiffrement de credentials. Vaults fait le même travail, plus la rotation propagée sans redémarrage et les webhooks. La contre-mesure existe (les vaults sont workspace-scoped, sans isolation par utilisateur final), mais elle doit être **dite**, sinon l'investissement Phase 2 passe pour du travail redondant.
- **Le fossé n'est plus hypothétique.** L'analyse antérieure posait en conditionnel « si CMA gagne une primitive de coordination inter-sessions ». Cette primitive **existe** — coordination **intra-session** multi-threads. La niche survit, mais l'écart s'est réduit d'un cran. À réévaluer trimestriellement, en surveillant en particulier une éventuelle primitive inter-sessions ou un lock de filesystem.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/tools/agents-tools.ts` | Expose `register_agent`, `list_agents`, `heartbeat`, `agent_activity` (l. 21, 50). **Collision de nom directe** avec l'outil de délégation `list_agents` du coordinateur CMA — décider d'un renommage ou d'un préfixe. |
| `src/tools/consultation-tools.ts` | `announce_work` (l. 37) et ses 10 outils de thread : la primitive d'annonce d'intention que CMA n'a pas. Argument central à documenter. |
| `src/conflict-detector.ts` · `src/file-tracker.ts` · `src/working-files-tracker.ts` | `ConflictDetector` et le suivi de fichiers : la capacité absente du filesystem partagé CMA. Cœur du différenciant, aucun changement de code attendu. |
| `src/tools/files-tools.ts` | `hot_files` (l. 20), `get_session_files` (l. 35), `check_file_conflict` (l. 50) — les 3 outils qu'un agent CMA appellerait avant d'écrire dans `/workspace/<repo>`. |
| `src/serve-http.ts` | `StreamableHTTPServerTransport` (l. 13, 801), auth Bearer (l. 238-256), `COORDINATOR_PUBLIC_URL` injecté dans `allowedOrigins` (l. 793). Point de branchement pour figurer dans un `mcp_servers` d'agent CMA. |
| `src/auth/service-tokens.ts` | JWT longue durée, plafond 90 j (`SERVICE_TOKEN_MAX_TTL_S`), scopes `read`/`write`/`admin`. Équivalent maison du `static_bearer` de vault : le chemin d'intégration le moins cher côté CMA. |
| `src/auth/oauth-token.ts` · `refresh-rotation.ts` · `device-flow.ts` | Concurrencés par `auth.type: mcp_oauth` (refresh géré par Anthropic). À confronter au fait que les vaults sont workspace-scoped, donc sans isolation par utilisateur. |
| `src/security/envelope-encryption.ts` · `master-key.ts` | Chiffrement enveloppe des tokens IdP au repos vs valeurs de vault write-only jamais renvoyées. Même objectif, deux modèles de confiance. |
| `src/mqtt-bridge.ts` · `src/sse-emitter.ts` | Push temps réel maison vs `GET /v1/sessions/{id}/events/stream` + `event_deltas[]`. Comparer les deux modèles d'événements avant d'ajouter quoi que ce soit. |
| `cli/channel.ts` | Serveur MCP stdio des Claude Code Channels (`StdioServerTransport`, l. 37, 536) — surface locale, hors de portée de CMA. À garder comme preuve de la cible « poste de travail ». |
| `sdk/src/client.ts` | `McpCoordinatorClient` (l. 37) : si on vise CMA, c'est le client à valider derrière une URL publique + bearer de vault. |
| `README.md` | Lignes 7, 26, 141 (« 26 MCP tools + DB »), 230-243 (« All 26 tools ») : le tableau « Who is this for » et la ligne « Building a multi-agent orchestrator » doivent nommer CMA. |
| `docs/index.html` | Landing avec 6 langues inline — tout changement de positionnement s'y répercute (jusqu'à 8 éditions par chaîne). |
| `docs/operating-modes.md` · `docs/ARCHITECTURE.md` (§ « How to add an endpoint or MCP tool », l. 266-313) | Où documenter un éventuel mode « monté dans une session CMA » et par où passer pour ajouter/renommer un outil. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> mcp-coordinator doit-il devenir un serveur MCP déclarable dans le `mcp_servers` de chaque agent d'un roster CMA — URL publique, bearer `static_bearer` de vault, arbitre du filesystem partagé de la session — ou assumer que sa cible est le checkout local hors CMA et se contenter, côté CMA, de résoudre la collision de nom sur `list_agents` ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Les points 2, 3 et 4 ne sont pas exécutables sur le poste : ils exigent une session CMA réelle (clé d'API avec header beta `managed-agents-2026-04-01`, instance joignable depuis Internet, temps de sandbox facturé).

- [ ] Reproduire la collision : monter une session MCP sur `src/serve-http.ts` avec un client qui expose aussi un outil `list_agents`, et vérifier ce que voit réellement le modèle (deux entrées ? écrasement ? erreur du SDK ?).
- [ ] Créer un agent CMA avec `mcp_servers` pointant sur une instance mcp-coordinator joignable (tunnel ou `COORDINATOR_PUBLIC_URL`), authentifiée par un service token de `src/auth/service-tokens.ts` posé en `static_bearer` de vault — mesurer si le handshake MCP passe et si `announce_work` est appelable.
- [ ] Vérifier expérimentalement l'inférence non documentée : deux agents d'un même roster écrivant le même fichier du `github_repository` monté — y a-t-il écrasement silencieux, ou un garde-fou non documenté ?
- [ ] Confirmer le piège des overrides : tenter d'injecter `mcp_servers` par `agent_with_overrides` sur une entrée `{"type":"agent","id":...}` du roster et constater qu'il est ignoré.
- [ ] Chiffrer le coût du chemin « monté dans CMA » : combien de fichiers touchés entre `src/serve-http.ts`, `src/auth/service-tokens.ts` et la doc, hors renommage d'outil ?

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Tout est en beta, rien n'est GA.** Header `managed-agents-2026-04-01` obligatoire, SDK sous `client.beta.*`, CLI `ant beta:*`. MCP tunnels et dreaming sont en research preview sur demande d'accès. Construire une surface d'intégration sur une API qui n'a pas de contrat de stabilité, c'est signer pour de la maintenance à chaque itération de la beta.
- **Le chemin d'intégration est structurellement pénible.** Les overrides de session ne s'appliquent qu'au coordinateur et à ses copies `{"type":"self"}` : pour que tout un roster voie mcp-coordinator, il faut le déclarer **agent par agent à la création**. Le roster est en plus snapshotté aux versions épinglées. Ce n'est pas un branchement, c'est une procédure.
- **Ça casse la portabilité qui est l'argument du projet.** mcp-coordinator est vendu comme fonctionnant avec Claude Code, Cursor, Cline, Aider. Un mode « CMA-aware » ajoute un chemin de code lié à un seul fournisseur, dans une seule topologie hébergée.
- **Exposer le daemon publiquement est un coût de sécurité réel pour l'auto-hébergeur.** Aujourd'hui la cible est localhost/LAN, et `allowedOrigins` est verrouillé sur `localhost`/`127.0.0.1`/`[::1]` sauf `COORDINATOR_PUBLIC_URL`. Rendre l'instance joignable par un sandbox Anthropic élargit la surface d'attaque pour un public dont on n'a aucune preuve qu'il existe.
- **Un dépôt monté fait partie de la trust boundary de l'agent**, et les skills `.claude/skills/` sont chargées sans revue : si mcp-coordinator recommande ce montage, il hérite d'un avertissement de sécurité qu'il n'a pas écrit.
- **Le différenciant n'est pas si menacé qu'il en a l'air.** La coordination CMA est intra-session (multi-threads d'un même coordinateur, un sandbox), pas inter-sessions ni inter-postes. Les vaults sont workspace-scoped, donc n'isolent pas par utilisateur final. CMA n'est éligible ni ZDR ni HIPAA BAA — exactement le public que vise l'Auth Phase 2. Le YAGNI est solide : zéro utilisateur connu de mcp-coordinator sur CMA.
- **L'effort le plus rentable est peut-être le plus petit.** Renommer `list_agents` et écrire trois paragraphes de positionnement coûte S ; construire et maintenir un mode CMA coûte L. Les deux ne se valent pas et ne répondent pas à la même urgence.
- **Contrainte de forme non négligeable** : les branding guidelines interdisent aux intégrateurs d'employer « Claude Code » / « Claude Cowork » — à vérifier contre la formulation actuelle du README et de `docs/index.html`.

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
| 2026-08-14 | Vérification des faits : 4 corrections (origine des outils de délégation, budget, environment_id, lignes files-tools). Statut beta confirmé. |
