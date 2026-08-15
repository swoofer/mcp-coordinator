# Veille plateforme Claude — index des dossiers

> **Ce que c'est.** Un dossier par décision à trancher, issu d'un balayage de toutes les surfaces
> Claude/Anthropic (GA, beta, research preview) au **14 août 2026**. Chaque fiche porte ses sources,
> ses points d'intégration vérifiés dans le code, et une **question à trancher**.
>
> **Ce que ce n'est pas.** Rien n'a été testé. Les sections *Challenge* et *Décision* de chaque fiche
> sont vides — elles se remplissent lors d'une session dédiée par fiche.

👉 **Commencer par [00-SYNTHESE.md](00-SYNTHESE.md)** — la lecture stratégique, les trois mouvements,
la menace principale, et les deux vérifications urgentes.

Gabarit d'une fiche : [_TEMPLATE.md](_TEMPLATE.md)

---

## Comment lire les tiers

| Tier | Signification |
|---|---|
| 🔴 **T1** | Bénéfice clair, statut stable, effort raisonnable — ou menace qui demande une réponse. À instruire en premier. |
| 🟠 **T2** | Gain potentiel important mais effort ou incertitude élevés. À instruire ensuite. |
| 🟡 **T3** | Beta, research preview, ou signal faible. À suivre sans agir. |

Le classement en tiers est un **jugement**, pas un résultat de la recherche. Il est fait pour être contesté.

## Colonnes *Fiche* et *Testable*

Issues de la **passe de vérification factuelle du 2026-08-14** : chaque fiche a été confrontée
à la doc officielle et au code réel du dépôt.

| Colonne | Valeurs |
|---|---|
| **Fiche** | ✅ saine (aucune correction) · 🟡 corrigée · 🔴 **compromise** — un fait central s'effondre, à lire avant d'y consacrer une session |
| **Testable** | ✅ un PoC local suffit à trancher · ⚠️ partiellement · ⛔ rien n'est exécutable ici (accès manquant nommé dans la fiche, §0) |

Le détail par fiche est dans sa **section 0**.

---

## A. Protocole MCP

| # | Dossier | Tier | Statut | Nature | Effort | Fiche | Testable | Challenge |
|---|---|---|---|---|---|---|---|---|
| `A01` | [MCP 2026-07-28 : cœur stateless, HTTP+SSE déprécié, `server/discover`](A01-mcp-2026-07-28-stateless.md) | 🔴 T1 | GA | menace | XL | 🟡 | ✅ | ⬜ |
| `A02` | [Migration @modelcontextprotocol/sdk ^1.29 vers le SDK TypeScript v2](A02-mcp-sdk-typescript-v2.md) | 🔴 T1 | GA | remplace du code maison | XL | 🟡 | ✅ | ⬜ |
| `A03` | [Multi Round-Trip Requests : forcer l'agent à répondre au conflit](A03-mrtr-input-required.md) | 🔴 T1 | GA | opportunité | L | 🟡 | ⚠️ | ⬜ |
| `A04` | [`subscriptions/listen` : le push standardisé face à `sse-emitter` et `mqtt-bridge`](A04-subscriptions-listen.md) | 🔴 T1 | GA | remplace du code maison | L | ✅ | ⚠️ | ⬜ |
| `A05` | [Extension MCP Tasks : la consultation inter-agents comme opération longue](A05-mcp-tasks-extension.md) | 🟠 T2 | experimental | remplace du code maison | L | 🟡 | ⚠️ | ⬜ |
| `A06` | [Surface d'outils moderne : outputSchema, annotations, ttlMs, progress](A06-tool-metadata-modern-surface.md) | 🔴 T1 | GA | opportunité | M | 🟡 | ⚠️ | ⬜ |
| `A07` | [Elicitation (modes `form` et `url`) : arbitrer un conflit sans passer par un thread](A07-elicitation.md) | 🔴 T1 | GA | opportunité | M | 🟡 | ⚠️ | ⬜ |
| `A08` | [MCP Apps (`ui://`) : le dashboard rendu dans la conversation](A08-mcp-apps-ui.md) | 🟠 T2 | GA | remplace du code maison | L | ✅ | ⚠️ | ⬜ |
| `A09` | [Organiser 26 outils : extensions, primitive grouping, skills-over-MCP](A09-extensions-grouping-skills.md) | 🟠 T2 | mixte | opportunité | M | ✅ | ⚠️ | ⬜ |
| `A10` | [Identité et découverte : mcpName, server.json, /server-card, Inspector en CI](A10-registry-servercard-conformance.md) | 🔴 T1 | mixte | opportunité | M | 🟡 | ✅ | ⬜ |

## B. Securite et auth

| # | Dossier | Tier | Statut | Nature | Effort | Fiche | Testable | Challenge |
|---|---|---|---|---|---|---|---|---|
| `B01` | [CIMD : la fin du Dynamic Client Registration](B01-cimd-dcr-deprecated.md) | 🔴 T1 | GA | intégration | M | 🟡 | ⚠️ | ⬜ |
| `B02` | [Enterprise-Managed Authorization (ID-JAG) et OAuth Client Credentials](B02-enterprise-managed-auth-idjag.md) | 🟠 T2 | mixte | opportunité | L | 🟡 | ⚠️ | ⬜ |
| `B03` | [Durcissement auth 2026 : RFC 9207, application_type, SSRF sur la découverte](B03-auth-hardening-ssrf.md) | 🔴 T1 | GA | menace | S | 🟡 | ⚠️ | ⬜ |
| `B04` | [Scope minimal, step-up 403 et lazy authentication par outil](B04-scope-step-up-lazy-auth.md) | 🔴 T1 | GA | opportunité | M | 🟡 | ⚠️ | ⬜ |
| `B05` | [Token passthrough interdit, binding RFC 8707 et state handle hijacking](B05-token-passthrough-state-handles.md) | 🔴 T1 | GA | menace | M | ✅ | ⚠️ | ⬜ |

## C. Claude Code (integration)

| # | Dossier | Tier | Statut | Nature | Effort | Fiche | Testable | Challenge |
|---|---|---|---|---|---|---|---|---|
| `C01` | [Hooks de type `mcp_tool` : rendre l'annonce obligatoire au lieu de l'espérer](C01-hook-mcp-tool-gate.md) | 🔴 T1 | GA | opportunité | S | 🟡 | ✅ | ⬜ |
| `C02` | [Les 31 hook events de Claude Code et le pack @mcp-coordinator/hooks](C02-hooks-coordination-events.md) | 🔴 T1 | mixte | intégration | M | 🟡 | ✅ | ⬜ |
| `C03` | [Channels : aligner `cli/channel.ts` sur le contrat officiel `claude/channel`](C03-channels-official-contract.md) | 🔴 T1 | research-preview | remplace du code maison | M | 🟡 | ⚠️ | ⬜ |
| `C04` | [Relais de permission : le dashboard devient console d'approbation](C04-channel-permission-relay.md) | 🔴 T1 | research-preview | opportunité | M | 🟡 | ⚠️ | ⬜ |
| `C05` | [Outil `Monitor` et transport MCP `ws` : le plan B du push, sans allowlist](C05-monitor-websocket-push.md) | 🔴 T1 | mixte | opportunité | M | 🟡 | ⚠️ | ⬜ |
| `C06` | [Tool search et defer_loading : que faire des 26 outils MCP](C06-tool-search-defer-loading.md) | 🔴 T1 | GA | ~~menace~~ opportunité | S | 🟡 | ✅ | ✅ |
| `C07` | [Distribution : plugin Claude Code, marketplace et bundles .mcpb](C07-plugin-marketplace-mcpb.md) | 🔴 T1 | GA | opportunité | M | 🟡 | ⚠️ | ⬜ |
| `C08` | [Status line : trois autres agents sur ce repo, un conflit, à zéro token](C08-statusline.md) | 🔴 T1 | GA | opportunité | S | ✅ | ✅ | ⬜ |
| `C09` | [Sandbox Bash et egress : l'échec d'onboarding silencieux à corriger](C09-bash-sandbox-egress.md) | 🔴 T1 | GA | menace | ~~S~~ M | 🟡 | ⚠️ | ✅ |
| `C10` | [Déploiement entreprise : managed-mcp.json, gateway, self-hosted runners](C10-enterprise-deployment.md) | 🟠 T2 | mixte | intégration | M | 🟡 | ⚠️ | ⬜ |
| `C11` | [Observabilité : traceparent, OTel multi-agents, APIs Analytics](C11-otel-traceparent-analytics.md) | 🟠 T2 | mixte | remplace du code maison | M | 🟡 | ⚠️ | ⬜ |
| `C12` | [Matrice de portabilité : ce que le natif ne couvre pas (Windows, Bedrock, conteneurs)](C12-portability-matrix.md) | 🔴 T1 | GA | opportunité | S | 🟡 | ⚠️ | ⬜ |
| `C13` | [Réconcilier l'agent-registry avec le réel : roster.json, Remote Control, /rewind](C13-agent-roster-reconciliation.md) | 🟠 T2 | mixte | intégration | M | 🟡 | ⚠️ | ⬜ |

## D. Menaces Claude Code

| # | Dossier | Tier | Statut | Nature | Effort | Fiche | Testable | Challenge |
|---|---|---|---|---|---|---|---|---|
| `D01` | [MENACE : cross-session messaging natif (SendMessage / ListAgents)](D01-threat-cross-session-messaging.md) | 🔴 T1 | GA | menace | M | 🟡 | ⚠️ | ⬜ |
| `D02` | [MENACE : Agent Teams (task list partagée, mailbox, file locking)](D02-threat-agent-teams.md) | 🔴 T1 | experimental | menace | L | 🟡 | ⚠️ | ⬜ |
| `D03` | [MENACE : worktrees natifs, le conflit d'écriture disparaît-il ?](D03-threat-native-worktrees.md) | 🔴 T1 | GA | menace | M | 🟡 | ✅ | ✅ |
| `D04` | [Dynamic workflows, `ultracode` et `/batch` : l'orchestration parallèle native](D04-threat-dynamic-workflows.md) | 🔴 T1 | GA | menace | M | ✅ | ✅ | ⬜ |
| `D05` | [MENACE : agent view, le dashboard natif dans le terminal](D05-threat-agent-view.md) | 🟠 T2 | research-preview | menace | M | 🟡 | ✅ | ⬜ |

## E. Claude API et Managed Agents

| # | Dossier | Tier | Statut | Nature | Effort | Fiche | Testable | Challenge |
|---|---|---|---|---|---|---|---|---|
| `E01` | [MENACE : Claude Managed Agents et l'orchestration multi-agents hébergée](E01-cma-competitive-frontier.md) | 🔴 T1 | research-preview | menace | L | 🟡 | ⚠️ | ⬜ |
| `E02` | [MCP tunnels : rendre le daemon privé joignable par les agents hébergés](E02-mcp-tunnels.md) | 🟠 T2 | research-preview | opportunité | M | 🟡 | ⚠️ | ⬜ |
| `E03` | [Brancher mcp-coordinator sur CMA : mcp_toolset, custom tools, worker self-hosted](E03-cma-integration-paths.md) | 🟠 T2 | beta | intégration | S | 🟡 | ⚠️ | ⬜ |
| `E04` | [Modèle d'API à copier : session threads et sémantique de reconnexion SSE](E04-cma-session-threads-sse.md) | 🟠 T2 | beta | opportunité | M | ✅ | ✅ | ⬜ |
| `E05` | [Memory stores : modèle pour la chaîne d'audit et la mémoire de repo partagée](E05-cma-memory-stores-audit.md) | 🟠 T2 | beta | remplace du code maison | L | 🟡 | ⚠️ | ⬜ |
| `E06` | [Outcomes et rubriques : remplacer le score opaque de plan-quality](E06-cma-outcomes-rubrics.md) | 🟡 T3 | beta | remplace du code maison | M | ✅ | ⚠️ | ⬜ |
| `E07` | [Webhooks sortants signés : pousser vers CI, Slack et dashboards tiers](E07-cma-webhooks.md) | 🟠 T2 | beta | opportunité | M | 🟡 | ✅ | ⬜ |
| `E08` | [Push et outils conditionnels côté Messages API (system messages, tool_addition)](E08-mid-conversation-system-and-tools.md) | 🟠 T2 | mixte | opportunité | M | 🟡 | ⚠️ | ⬜ |
| `E09` | [MENACE : le MCP connector ne voit que les tool calls, tout le temps réel est invisible](E09-threat-mcp-connector-tools-only.md) | 🔴 T1 | beta | menace | M | ✅ | ⚠️ | ⬜ |
| `E10` | [Memory tool : le daemon comme backend de mémoire partagée entre agents](E10-memory-tool-shared-repo-memory.md) | 🟠 T2 | GA | opportunité | L | ✅ | ⚠️ | ⬜ |
| `E11` | [Discipline de contexte : exclude_tools, PTC, compaction, task budgets, cache](E11-context-discipline.md) | 🔴 T1 | mixte | intégration | M | 🟡 | ⚠️ | ⬜ |
| `E12` | [Qualité des payloads : strict tools, structured outputs, blocs search_result](E12-structured-outputs-citations.md) | 🟠 T2 | GA | intégration | M | 🟡 | ⚠️ | ⬜ |
| `E13` | [Publier une skill de coordination plutôt que d'alourdir les descriptions d'outils](E13-agent-skills-coordination.md) | 🟠 T2 | beta | opportunité | M | 🟡 | ⚠️ | ⬜ |
| `E14` | [Entreprise : inference hooks, Compliance API, annuaire de connecteurs](E14-enterprise-audit-directory.md) | 🟡 T3 | mixte | menace | M | 🟡 | ⚠️ | ⬜ |
| `E15` | [Emprunts de design mineurs : budgets de session, advisor, dreams, deployments](E15-cma-design-borrowings.md) | 🟡 T3 | mixte | opportunité | M | 🟡 | ⚠️ | ⬜ |

## F. Claude Agent SDK

| # | Dossier | Tier | Statut | Nature | Effort | Fiche | Testable | Challenge |
|---|---|---|---|---|---|---|---|---|
| `F01` | [Serveur MCP in-process : le paquet @mcp-coordinator/agent-sdk](F01-sdk-in-process-mcp-server.md) | 🔴 T1 | GA | intégration | M | 🟡 | ✅ | ⬜ |
| `F02` | [`canUseTool` et `requestId` : la primitive exacte du verrou distribué](F02-canusetool-distributed-lock.md) | 🔴 T1 | GA | opportunité | M | 🟡 | ✅ | ⬜ |
| `F03` | [Subagents programmatiques et SessionStore : voir les transcripts, pas que les annonces](F03-sdk-subagents-sessionstore.md) | 🟠 T2 | GA | opportunité | M | 🟡 | ✅ | ⬜ |

## G. Ecosysteme

| # | Dossier | Tier | Statut | Nature | Effort | Fiche | Testable | Challenge |
|---|---|---|---|---|---|---|---|---|
| `G01` | [MCP Agent Mail : le concurrent open source le plus proche](G01-threat-mcp-agent-mail.md) | 🔴 T1 | experimental | menace | S | ✅ | ✅ | ⬜ |
| `G02` | [Orchestrateurs worktree-par-tâche (Conductor, Nimbalyst, Vibe Kanban, Claude Squad)](G02-worktree-orchestrators.md) | 🟠 T2 | mixte | menace | S | ✅ | ⚠️ | ⬜ |
| `G03` | [MCP Interceptors WG (SEP-1763) : la détection de conflit comme primitive standard](G03-mcp-interceptors-wg.md) | 🔴 T1 | experimental | menace | L | 🟡 | ⚠️ | ⬜ |
| `G04` | [MCP Triggers & Events WG : le pub/sub entre-t-il dans la spec ?](G04-mcp-triggers-events-wg.md) | 🔴 T1 | experimental | menace | S | 🟡 | ✅ | ⬜ |
| `G05` | [Signaux faibles : A2A/AGNTCY et Claude Cowork](G05-weak-signals.md) | 🟡 T3 | GA | opportunité | XL | 🟡 | ⚠️ | ⬜ |

---

## Résultat de la vérification factuelle

| | |
|---|---|
| Fiches vérifiées | 56 / 56 |
| Saines | 12 |
| Corrigées | 44 |
| **Compromises** | 0 |
| Statut de la feature corrigé | 10 — `A03`, `A07`, `B02`, `C07`, `C10`, `C13`, `E11`, `E12`, `F01`, `G05` |
| ✅ Testables localement | 17 |
| ⚠️ Partiellement testables | 39 |
| ⛔ Non testables ici | 0 |

---

## Les questions à trancher

La question de chaque fiche, en un seul endroit — pour choisir par quoi commencer.

### A. Protocole MCP

**[`A01`](A01-mcp-2026-07-28-stateless.md)** — L'identité d'agent doit-elle migrer de `getSessionClaims(extra.sessionId)` — 26 occurrences dans `src/tools/*.ts`, adossées aux Maps `sessions`/`sessionClaims`/`sessionLastActivity` de `serve-http.ts` — vers des claims portés par chaque requête (JWT + `_meta.clientInfo`), ce qui supprime la couche de session et le `McpServer`-par-session ; ou garde-t-on une couche de session maison au-dessus d'un transport devenu stateless, pour préserver le modèle `agent_id` sans réécrire les 26 handlers ?

**[`A02`](A02-mcp-sdk-typescript-v2.md)** — Puisque la ligne v1 reste publiée (`@modelcontextprotocol/sdk@1.30.0`) et qu'aucune rupture ne nous force la main : est-ce qu'on bascule `src/serve-http.ts` sur `createMcpHandler` + `toNodeHandler`, en abandonnant la `Map` de sessions et le sweeper TTL maison au modèle « une instance de serveur par requête » du SDK — ou est-ce qu'on reste sur la ligne v1 en n'empruntant à v2 que les briques isolables (`createRequestStateCodec` pour MRTR, `validateHostHeader`) sans toucher au transport ?

**[`A03`](A03-mrtr-input-required.md)** — Un conflit détecté par `announce_work` doit-il devenir un `InputRequiredResult` bloquant — ce qui fait de mcp-coordinator un serveur à deux tours avec `requestState` signé, un chemin REST à re-garder et un SDK à mettre à niveau — ou bien le vrai levier est-il ailleurs, à savoir que le tour 2 ne peut jamais être garanti (« Servers MUST NOT assume clients will retry ») et que le blocage effectif reste du ressort de MQTT et de `wait_for_message` ?

**[`A04`](A04-subscriptions-listen.md)** — Faut-il créer une couche `resources` MCP (URIs `coord://<org>/agents`, `/working-files`, `/threads/<id>`) — aujourd'hui totalement absente du repo — pour que `subscriptions/listen` ait quelque chose à quoi s'abonner, ou bien n'utiliser `listen` que pour `toolsListChanged` et garder SSE + MQTT comme unique canal d'état, en assumant que `cli/channel.ts` reste une extension propriétaire Claude Code ?

**[`A05`](A05-mcp-tasks-extension.md)** — La consultation inter-agents doit-elle devenir une MCP Task (`announce_work` → `CreateTaskResult`, `post_to_thread` → `tasks/update`/`inputResponses`), en acceptant de dépendre d'une extension expérimentale qu'aucun client MCP n'implémente aujourd'hui — ou faut-il garder le modèle propriétaire thread + MQTT/SSE et se limiter à aligner le vocabulaire de `ThreadStatus` sur les statuts Tasks pour préparer une bascule ultérieure sans coût ?

**[`A06`](A06-tool-metadata-modern-surface.md)** — Équiper les 26 outils d'un `outputSchema` impose de migrer de `server.tool()` vers `registerTool()` et de maintenir un second schéma par outil : faut-il générer ces schémas depuis `src/http/rest-schemas.ts` / `docs/openapi.yaml` pour garder une seule source de vérité par domaine, ou n'équiper que les 4 outils dont la sortie est structurée et réellement relue (`announce_work`, `coordinator_status`, `check_file_conflict`, `get_blast_radius`) et laisser les 22 autres en `content` texte ?

**[`A07`](A07-elicitation.md)** — `elicitation/create` ne peut remonter que dans la session MCP qui a déclenché l'appel d'outil : `announce_work` appelé par l'agent A ne peut donc éliciter que A, jamais l'agent B concurrent dont on veut arracher la décision. Faut-il alors (a) éliciter l'annonceur A en mode `form` pour qu'il tranche lui-même son conflit avant l'écriture du thread, (b) passer en mode `url` vers un écran d'arbitrage servi par `/dashboard` pour que l'humain tranche, ou (c) renoncer à l'élicitation pour la coordination et garder MQTT/SSE comme seul canal d'interruption vers B, en réservant l'élicitation au seul device flow OAuth ?

**[`A08`](A08-mcp-apps-ui.md)** — Vu que Claude Code n'est pas dans la matrice de support MCP Apps, porter `dashboard/public/` en ressource `ui://` sert-il un utilisateur réel de mcp-coordinator aujourd'hui — ou faut-il attendre que Claude Code apparaisse dans la matrice, et n'investir d'ici là que dans le découplage du dashboard de `/api/*` (qui bénéficierait aux deux chemins) ?

**[`A09`](A09-extensions-grouping-skills.md)** — Faut-il parier sur une seule stratégie de réduction de surface (le tool search), ou déclarer une extension `{préfixe}/coordination` qui gate les 3 familles périphériques (`files`, `dependencies`, `mqtt` = 9 outils sur 26) derrière un opt-in, en gardant `agents` + `consultation` toujours chargées et en déportant la doctrine d'annonce vers une skill servie par `resources/read` ?

**[`A10`](A10-registry-servercard-conformance.md)** — Est-ce que mcp-coordinator publie une identité **remote** — `server.json` avec des `remotes[]` et un `/server-card` annonçant une URL de coordinateur — ou reste-t-il un serveur **purement local** dont le `server.json` ne déclare qu'un `packages[]` npm/GHCR, sachant qu'aucun déploiement mono-poste n'a d'URL publique stable à annoncer et que le seul namespace vérifiable sans nom de domaine est `io.github.swoofer/*` ?

### B. Securite et auth

**[`B01`](B01-cimd-dcr-deprecated.md)** — Le coordinateur doit-il devenir un véritable *authorization server* OAuth pour clients MCP tiers — c'est-à-dire construire l'endpoint d'autorisation et l'émission de codes qui n'existent pas aujourd'hui (`authorization_endpoint` = écran de login cookie, `grant_type=authorization_code` = proxy de code IdP) — ou reste-t-il un *relying party* devant 4 IdP, auquel cas `client_id_metadata_document_supported: true` serait une metadata mensongère et CIMD sort du périmètre ?

**[`B02`](B02-enterprise-managed-auth-idjag.md)** — Vaut-il mieux implémenter le grant ID-JAG dans l'AS embarqué de mcp-coordinator — c'est-à-dire une branche de plus dans le `switch` de `src/auth/oauth-token.ts` et l'abandon de `allowlist.ts` comme source de vérité au profit des groupes IdP — alors qu'un seul client (Archestra.AI) coche EMA dans la matrice officielle ; ou bien se limiter d'abord au volet vérifiable immédiatement, à savoir la validation RFC 9207 de `iss` dans `oauth-callback.ts` et le remplacement du schéma de service tokens maison par l'identifiant `io.modelcontextprotocol/oauth-client-credentials` ?

**[`B03`](B03-auth-hardening-ssrf.md)** — Le durcissement doit-il passer par un unique client HTTP sortant gardé (`safeFetch` : schéma, refus des 8 plages privées, pinning DNS) imposé à tous les fetch OAuth/JWKS des 4 providers, ou rester des gardes locaux par provider sur le modèle de `parseNextLink` dans `github-shared.ts` — sachant que le binding `state → row.provider` rend déjà la validation d'`iss` RFC 9207 redondante côté callback ?

**[`B04`](B04-scope-step-up-lazy-auth.md)** — Le step-up doit-il réutiliser le vocabulaire `ServiceTokenScope` existant (`read`/`write`/`admin`) en le propageant enfin dans `AuthClaims`, ou faut-il un vocabulaire MCP dédié (`coordinator:read` / `coordinator:announce` / `coordinator:admin`) publié dans une PRM — sachant que le premier réconcilie un garde-fou déjà à moitié écrit mais mélange service tokens et sessions utilisateur, et que le second impose de créer `/.well-known/oauth-protected-resource` et de bufferiser le corps JSON-RPC dans `/mcp` avant `transport.handleRequest` ?

**[`B05`](B05-token-passthrough-state-handles.md)** — Faut-il faire du couple `(user_id du token vérifié, agent_id)` la clé d'identité de tous les outils — c'est-à-dire remplacer la `Map<mcp-session-id, AuthClaims>` de `serve-http.ts` par un liage persisté `<user_id>:<agent_id>` posé à `register_agent` et revérifié à chaque appel — ou bien conserver le scope org actuel et se contenter d'ajouter la validation `aud` + le endpoint RFC 9728, en assumant que l'usurpation intra-org est un risque accepté ?

### C. Claude Code (integration)

**[`C01`](C01-hook-mcp-tool-gate.md)** — Le hook `PreToolUse` doit-il appeler `check_file_conflict` en veto dur (`deny` sur conflit, ce qui casse l'écriture d'un agent solo mal enregistré et exige de résoudre l'absence d'`agent_id` interpolable), ou rester un signal `allow` + `permissionDecisionReason` qui injecte le contexte de conflit dans le fil de l'agent sans jamais bloquer ?

**[`C02`](C02-hooks-coordination-events.md)** — Le pack de hooks doit-il être un garde-fou bloquant (`PreToolUse` → `deny` + `TaskCreated` → exit 2), qui rend `announce_work` obligatoire mais couple mcp-coordinator au chemin critique de chaque édition et à une surface Agent Teams encore expérimentale — ou un capteur passif (`FileChanged`, `PostToolBatch`, `SubagentStart` en `async: true`), qui enrichit le registry sans jamais bloquer et reste vrai si Anthropic change les contrats de blocage ?

**[`C03`](C03-channels-official-contract.md)** — Faut-il empaqueter le channel en **plugin sur un marketplace** (`plugin:<nom>@<marketplace>`) pour viser une entrée `allowedChannelPlugins` chez les admins clients et, à terme, l'allowlist Anthropic via un contact partenaire — ou assumer définitivement l'entrée `server:<nom>` derrière `--dangerously-load-development-channels` et investir l'effort équivalent dans un chemin de push **indépendant de Claude Code** (le bus MQTT existant, ou une inbox), sachant que ni l'un ni l'autre ne débloque Bedrock / Google Cloud Agent Platform / Microsoft Foundry ?

**[`C04`](C04-channel-permission-relay.md)** — Le verdict d'auto-deny doit-il être rendu localement par le processus `cli/channel.ts` (sans état, latence quasi nulle, mais il ne voit que MQTT et n'a pas le `working_files` du daemon), ou par le daemon via un aller-retour MQTT corrélé sur `request_id` (politique complète : working_files + conflict-detector + audit, mais on perd la course contre le dialogue terminal dès que l'humain est plus rapide) — et si c'est le daemon, que fait-on du fait que `src/mqtt-bridge.ts` ne sait aujourd'hui que publier des événements, jamais attendre une réponse ?

**[`C05`](C05-monitor-websocket-push.md)** — Faut-il remplacer `cli/channel.ts` par un chemin WebSocket sur le daemon — et si oui lequel : un `type: "ws"` dans `.mcp.json`, qui unifie outils et push mais fait perdre OAuth et donc la Phase 2, ou un endpoint `/events/ws` texte consommé par l'outil `Monitor`, qui préserve l'auth HTTP mais n'est pas prouvé fonctionnel en loopback et exige une approbation humaine à chaque connexion ?

**[`C06`](C06-tool-search-defer-loading.md)** — Puisque les schémas sont différés par défaut et que la seule surface de découverte restante est `instructions` + les noms d'outils, faut-il (a) réécrire noms et descriptions des 26 outils pour le matching BM25 et pousser toute la contrainte d'annonce dans un `instructions` serveur — ou (b) documenter `alwaysLoad: true` sur l'entrée `coordinator` du `.mcp.json` et assumer de rester le serveur qui charge 26 schémas au démarrage ?

**[`C07`](C07-plugin-marketplace-mcpb.md)** — Le plugin `mcp-coordinator` doit-il embarquer le daemon complet (broker MQTT + HTTP + SQLite, lancé depuis `${CLAUDE_PLUGIN_ROOT}` avec `${CLAUDE_PLUGIN_DATA}` comme `data_dir`), ce qui donne un coordinateur par poste et casse le modèle « un daemon, N agents » qui fait tout l'intérêt du projet — ou se limiter à un plugin *client* qui ne déclare que `channels` et un `mcpServers` pointant, via `userConfig`, vers un daemon installé séparément par npm ou Docker ?

**[`C08`](C08-statusline.md)** — La status line se contente-t-elle de `GET /api/status` — quatre entiers org-scopés, déjà servis, zéro code serveur, mais une ligne incapable de nommer le fichier en conflit — ou justifie-t-elle un endpoint dédié prenant `workspace.repo.{owner,name}` et `workspace.git_worktree` en entrée, et donc l'introduction d'un axe de scoping « repo » qui n'existe **nulle part** dans le schéma actuel (zéro occurrence de `repo_id`/`project_id`) et que seuls les clients Claude Code sauraient renseigner ?

**[`C09`](C09-bash-sandbox-egress.md)** — Faut-il que `doctor` devienne prescripteur de la configuration Claude Code (détecter le sandbox, lire `settings.json` et dicter l'entrée `allowedDomains` à ajouter), ou faut-il supprimer le problème à la source côté transport — exposer un socket Unix en plus du bind `127.0.0.1` de `src/serve-http.ts:1397`, en pariant sur `sandbox.allowUnixSockets` — sachant que le socket Unix ne résout ni le cas WSL2/Windows ni le MQTT TCP de `cli/channel.ts` ?

**[`C10`](C10-enterprise-deployment.md)** — Puisque `serverName` n'est pas un contrôle de sécurité et qu'un serveur distant doit matcher un `serverUrl` dès qu'une règle d'URL existe, faut-il faire du daemon HTTP à URL stable le **seul** profil supporté en org (et donc déclasser le mode local-first `http://localhost:<port>/mcp` de `cli/init.ts` en profil solo), ou maintenir deux profils avec deux entrées `allowedMcpServers` distinctes — `serverUrl` pour le daemon partagé, `serverCommand` exact pour le lancement local — au prix d'une matrice de support doublée ?

**[`C11`](C11-otel-traceparent-analytics.md)** — Le coordinateur doit-il devenir un participant passif d'une chaîne OTel possédée par Claude Code — lire `traceparent` / `_meta` et estampiller ses événements sans jamais exporter — ou doit-il rester la source de vérité de la coordination avec son identifiant `X-Request-Id` maison et son canal `/api/token-usage`, au risque de dupliquer un plan de données que le client fournit déjà en GA ?

**[`C12`](C12-portability-matrix.md)** — Publie-t-on la matrice de portabilité comme **argument** (une carte `compare.card6` sur la landing, donc 12 chaînes à maintenir en 6 langues, qui se périment à chaque release Anthropic), ou comme **capacité produit** (une probe `doctor` qui détecte l'OS, le backend Claude en usage et les variables de coupure, puis recommande le mode polling ou push) — sachant que la première option est du contenu qu'on ne peut pas tester et la seconde nous engage à maintenir une base de faits versionnée sur un produit tiers ?

**[`C13`](C13-agent-roster-reconciliation.md)** — Qui fait autorité sur « quels agents sont vivants » : le registre MCP alimenté par les agents eux-mêmes (heartbeat + TTL 900 s + last-will MQTT), ou `~/.claude/daemon/roster.json` lu à froid sur la machine — et si c'est le roster, que devient le modèle multi-machines / multi-transports du coordinator, qui ne peut lire aucun fichier local sur les postes distants ?

### D. Menaces Claude Code

**[`D01`](D01-threat-cross-session-messaging.md)** — Faut-il traiter le cross-session messaging natif comme un transport à absorber — un hook installé par `init` capture `CLAUDE_CODE_MESSAGING_SOCKET` et le coordinateur y pousse ses alertes de conflit, MQTT devenant optionnel en mono-poste — ou comme un concurrent à ignorer, en assumant que MQTT reste le seul bus et en reportant tout l'effort sur la différenciation sémantique (schéma d'annonce, audit, multi-org, cross-vendor) dans README / faq / landing ?

**[`D02`](D02-threat-agent-teams.md)** — mcp-coordinator abandonne-t-il sa propre couche d'orchestration (`/api/claim-task`, `assigned_to`, poisoning, mailbox MQTT) pour devenir une **couche anti-collision branchée en hooks sur la task list d'Agent Teams** — ou garde-t-il son claim maison, au risque d'entretenir deux task lists concurrentes et deux verrous non coordonnés dans la même session Claude Code ?

**[`D03`](D03-threat-native-worktrees.md)** — Puisque `--worktree` supprime le conflit d'écriture au niveau fichier, faut-il faire du worktree une entité de première classe du modèle de données — colonne `worktree_path` sur `agents`, canonicalisation worktree-relative dans `normalizePath`, enregistrement via le hook `WorktreeCreate` — ou au contraire acter que `working_files` et `file_overlap` deviennent du bruit sous worktrees et recentrer le produit (et son pitch) exclusivement sur le conflit sémantique inter-worktree porté par `dependency-map` + `impact-scorer` + `tree-sitter-extractor` + `git-cochange` ?

**[`D04`](D04-threat-dynamic-workflows.md)** — Le pré-check de conflit peut-il vivre **dans** un workflow — c'est-à-dire uniquement via des appels `announce_work` / `check_file_conflict` que les sous-agents font eux-mêmes, puisque le script JS n'a ni FS, ni shell, ni `import()`, donc ne peut ni lire le repo ni appeler le SDK — ou bien le seul point d'accroche réellement fiable est-il un hook `PreToolUse` posé **hors** du script, auquel cas on abandonne le workflow de référence en plugin et on repositionne mcp-coordinator sur la persistance inter-session ?

**[`D05`](D05-threat-agent-view.md)** — Le dashboard de mcp-coordinator abandonne-t-il le panneau « qui tourne / dans quel état » à `claude agents` pour se recentrer sur la vue repo (fichiers chauds, conflits, threads), ou garde-t-il la vue process en l'alimentant par ingestion de `claude agents --json` aux côtés des agents non-Claude ?

### E. Claude API et Managed Agents

**[`E01`](E01-cma-competitive-frontier.md)** — mcp-coordinator doit-il devenir un serveur MCP déclarable dans le `mcp_servers` de chaque agent d'un roster CMA — URL publique, bearer `static_bearer` de vault, arbitre du filesystem partagé de la session — ou assumer que sa cible est le checkout local hors CMA et se contenter, côté CMA, de résoudre la collision de nom sur `list_agents` ?

**[`E02`](E02-mcp-tunnels.md)** — Le mode tunnel doit-il être un chemin de déploiement supporté (services `cloudflared` + `mcp-proxy` dans `docker-compose.yml`, check `doctor`, `COORDINATOR_PUBLIC_URL` documenté sur `<subdomain>.<tunnel-domain>`), ou reste-t-il une recette externe non versionnée, au motif qu'une research preview « as-is » ne peut pas porter une surface de support dans un projet auto-hébergé ?

**[`E03`](E03-cma-integration-paths.md)** — Parmi les trois chemins, lequel mcp-coordinator supporte-t-il officiellement : le MCP connector seul (documenter une recette HTTPS + allowlist `configs`, zéro code), ou faut-il livrer un paquet `@mcp-coordinator/cma-worker` fondé sur `EnvironmentWorker` — seul montage où l'agent CMA partage le checkout et où `conflict-detector.ts` garde un sens — en acceptant d'ajouter une dépendance à `@anthropic-ai/sdk` en beta ?

**[`E04`](E04-cma-session-threads-sse.md)** — Faut-il aligner le vocabulaire d'événements et le curseur de mcp-coordinator sur le modèle CMA (messages dirigés `from_agent`/`to_agent`, curseur `(event_id, index)` au lieu du `since` ISO de `get_thread_updates`, troncature SSE explicitement signalée), sachant que cela casse l'API de `get_thread_updates` et l'union `EventType` — ou bien se limite-t-on à documenter notre contrat SSE existant, qui rejoue déjà via `Last-Event-ID` là où CMA ne rejoue pas du tout ?

**[`E05`](E05-cma-memory-stores-audit.md)** — Adopte-t-on le patron `redact` d'Anthropic dans notre propre sweeper — caviarder les lignes d'`audit_log` expirées au lieu de les `DELETE`, pour que `verify-audit-chain.ts` distingue enfin une purge légitime d'une suppression malveillante — ou accepte-t-on que la chaîne reste trouée et compense-t-on par l'attestation externe de tip déjà décrite dans l'en-tête de `audit-chain.ts` ?

**[`E06`](E06-cma-outcomes-rubrics.md)** — La rubrique de qualité de plan doit-elle devenir un document markdown fourni par l'utilisateur (par org, versionné dans le repo, à la manière de `rubric: {type:"file"}`), ou reste-t-elle une liste de critères codés en dur dans `plan-quality.ts` — et si elle devient paramétrable, qui l'évalue : des règles déterministes lisibles côté serveur, ou un juge LLM appelé par le coordinateur, ce qui introduirait une dépendance API sortante dans un serveur MCP jusqu'ici hors ligne ?

**[`E07`](E07-cma-webhooks.md)** — Le dispatcher webhook doit-il se brancher sur `sseEmitter.addListener()` — donc consommer un slot du plafond `MAX_SSE_CLIENTS` et hériter du fan-out best-effort en `setImmediate` sans persistance de la tentative — ou faut-il d'abord extraire un EventBus/outbox lisant la table `events` par curseur, seul moyen d'avoir un retry jitté et une auto-désactivation qui survivent à un redémarrage du coordinateur ?

**[`E08`](E08-mid-conversation-system-and-tools.md)** — mcp-coordinator doit-il se contenter de documenter une recette d'orchestrateur (le client insère lui-même les messages système et les tool_addition à partir du flux SSE), ou doit-il exposer côté serveur un endpoint d'inventaire d'outils dérivé de l'état des verrous — c'est-à-dire assumer une dépendance à une beta Messages API et à un modèle non-Sonnet dans son propre code ?

**[`E09`](E09-threat-mcp-connector-tools-only.md)** — Assume-t-on que la Messages API restera en polling forcé — en faisant de `wait_for_message` (long-poll, cap 300 s) le contrat officiel côté API et en requalifiant explicitement le claim « temps réel » comme réservé aux clients MCP complets — ou code-t-on un chemin de première classe basé sur le tool runner client-side du SDK (`mcpTools` + `toolRunner()`), qui suppose de maintenir un second client MCP et un injecteur d'événements MQTT en messages mid-conversation, en doublon fonctionnel de `cli/channel.ts` ?

**[`E10`](E10-memory-tool-shared-repo-memory.md)** — Une mémoire partagée `/memories/shared/` écrite en langage libre par les agents apporte-t-elle quelque chose que les threads de consultation (`src/consultation.ts`) et `announce` ne couvrent pas déjà — ou bien mcp-coordinator doit-il seulement **exposer** son état structuré existant (agents, working files, dependency map) comme une arborescence `/memories` en lecture seule, et laisser l'écriture libre aux fichiers du repo ?

**[`E11`](E11-context-discipline.md)** — mcp-coordinator doit-il se contenter de **documenter** une configuration `exclude_tools` / `task_budget` que l'utilisateur applique lui-même côté appelant (le serveur ne contrôle pas la requête API), ou doit-il rendre ses sorties structurellement compactes — `announce_work` sans la liste `pass`, listes bornées, plus un outil de réhydratation post-compaction — au prix d'un changement de contrat de réponse pour les consommateurs existants (essaim, dashboard, `serve-http.ts`) ?

**[`E12`](E12-structured-outputs-citations.md)** — Étant donné que `strict` est indisponible sur `mcp_toolset` et que les blocs `search_result` sont apparemment droppés par le handler de tool result MCP, mcp-coordinator doit-il exporter ses schémas d'outils et ses payloads « citables » via `sdk/src/client.ts` pour les agents en connexion directe — au prix d'un second contrat à maintenir en parallèle des 26 outils MCP — ou rester strictement MCP et considérer ces deux mécanismes comme hors de portée tant qu'ils ne traversent pas le connecteur ?

**[`E13`](E13-agent-skills-coordination.md)** — La doctrine de coordination doit-elle être distribuée comme skill Agent Skills (dossier `SKILL.md` livré dans le paquet npm, plus publication optionnelle via `/v1/skills`) en remplacement de la section écrite par `mcp-coordinator init --claude-md`, ou bien servie via MCP Resources façon SEP-2640 (fiche A09) pour rester lisible par tout client MCP et pas seulement par le runtime Anthropic ?

**[`E14`](E14-enterprise-audit-directory.md)** — mcp-coordinator doit-il devenir un endpoint d'inference hook Anthropic — c'est-à-dire accepter d'être dans le chemin critique de chaque inférence d'une organisation Enterprise, avec un budget de 5 s et un mode `block` en cas de panne — ou bien se limiter à consommer la Compliance API en lecture pour enrichir sa chaîne d'audit, en assumant que la détection de conflit reste opt-in côté agent ?

**[`E15`](E15-cma-design-borrowings.md)** — Un `consult_peer` éphémère (un tour, auto-terminant, hors des 11 outils de thread) est-il une **primitive manquante** de mcp-coordinator, ou l'arbitrage de conflit doit-il rester un thread `propose_resolution` / `approve_resolution` persistant, l'appel modèle-à-modèle étant alors relégué à un détail d'implémentation interne de `ImpactScorer` que le protocole MCP n'expose jamais ?

### F. Claude Agent SDK

**[`F01`](F01-sdk-in-process-mcp-server.md)** — Le serveur in-process doit-il embarquer les services (createServices() → SQLite, registry, MQTT bridge) dans le process de l'orchestrateur SDK, ou n'être qu'un proxy mince de 26 tool() qui rappellent un daemon via McpCoordinatorClient — sachant que docs/ARCHITECTURE.md établit un coordinateur par process OS, et donc qu'un serveur embarqué ne coordonne rien au-delà de son propre process ?

**[`F02`](F02-canusetool-distributed-lock.md)** — mcp-coordinator doit-il sortir de son rôle de serveur passif pour livrer un orchestrateur de référence basé sur `canUseTool` (dépendance au Claude Agent SDK, verrou dur avec file d'attente sur `working_files`), ou rester un serveur MCP portable qui n'expose que les endpoints et laisse à chaque hôte le soin d'écrire son propre gate ?

**[`F03`](F03-sdk-subagents-sessionstore.md)** — Un arbre de subagents doit-il apparaître dans `agents` comme N lignes reliées par `parent_agent_id` (le conflict-detector devant alors apprendre à ignorer les conflits intra-sous-arbre), ou comme UNE seule ligne « session » dont les subagents ne sont qu'un attribut d'activité — et dans ce cas, qui déclare quoi quand deux subagents frères éditent le même fichier ?

### G. Ecosysteme

**[`G01`](G01-threat-mcp-agent-mail.md)** — Faut-il ajouter au-dessus de `thread_messages` une couche d'inspection humaine à la agent-mail — index FTS5 plus export d'artefacts Markdown versionnés dans Git — ou assumer que la chaîne d'audit SHA-256 de `src/security/audit-chain.ts` et le dashboard sont la seule surface de lecture, et concentrer 100 % de l'effort sur la détection sémantique que le concurrent n'a pas ?

**[`G02`](G02-worktree-orchestrators.md)** — Vibe Kanban expose déjà un serveur MCP local (`create_session`, `start_workspace`, `run_session_prompt`, `link_workspace_issue`) : mcp-coordinator doit-il se poser explicitement **sous** ces orchestrateurs — un adaptateur mince, sur le modèle de `cli/channel.ts`, qui mappe `workspace_id` → `agent_id` et pousse `announce_work` / conflits vers leur UI — ou renoncer à l'intégration et se contenter de documenter la cohabitation de deux serveurs MCP dans `cli/init.ts`, au risque de rester invisible pour les utilisateurs déjà équipés ?

**[`G03`](G03-mcp-interceptors-wg.md)** — Le modèle d'exécution du SEP-1763 peut-il porter un intercepteur avec état inter-appels (le travail annoncé via `announce_work` + les fichiers en vol de `working-files-tracker`), ou est-il structurellement limité à une décision par appel — auquel cas mcp-coordinator n'expose comme validator que `conflict-detector.detect()` et garde le protocole de consultation en propre, en dehors de la spec ?

**[`G04`](G04-mcp-triggers-events-wg.md)** — Faut-il regrouper dès maintenant les trois chemins de push (SSE `/api/events`, topics MQTT, `notifications/claude/channel`) derrière un registre d'événements unique adossé aux 16 valeurs d'`EventType`, pour pouvoir brancher une future primitive `Events` sans toucher au métier — ou est-ce une abstraction spéculative pour un WG à 1 commit dont le SEP est encore *Ideating*, auquel cas la seule action justifiée est d'aller porter `docs/mqtt-topics.md` au WG comme retour d'expérience sur l'ordre de livraison ?

**[`G05`](G05-weak-signals.md)** — L'identité d'agent de mcp-coordinator (`agents.id`, chaîne opaque globalement unique, sans URL ni clé, `src/types.ts` + `src/agent-registry.ts`) doit-elle migrer vers une Agent Card A2A adressable et signée servie depuis `src/discovery.ts` — sachant que c'est ce même choix d'identité qui conditionne la capacité à coordonner des sessions Claude Cowork, où il n'y a ni processus local ni chemin repo-relatif ?

---

## Suivi des challenges

Mettre à jour la colonne *Challenge* ci-dessus et la section 7 de la fiche concernée.

| État | Signification |
|---|---|
| ⬜ | à faire |
| 🟡 | en cours |
| ✅ | tranché — voir §7 de la fiche |
| ❌ | abandonné |

---

## Traçabilité de la veille

| | |
|---|---|
| Date | 2026-08-14 |
| Surfaces balayées | 8 (Claude Code, spec MCP, MCP auth/registre, Agent SDK, API agentique, Managed Agents, chronologie jan→août 2026, écosystème) + 1 passe de complétude |
| Fiches brutes produites | 161 |
| Fiches passées au vérificateur adversarial | 66 → 59 CONFIRMED, 6 PLAUSIBLE, 1 REFUTED |
| Identifiants uniques après dédup | 151 |
| Dossiers de décision | 56 |

**Limite connue :** le cutoff du modèle est mai 2026. Les trois derniers mois ont été couverts par
recherche web uniquement — c'est la zone où la confiance est la plus faible.
