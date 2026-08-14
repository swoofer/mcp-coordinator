# E15 — Emprunts de design mineurs : budgets de session, advisor, dreams, deployments

| Champ | Valeur |
|---|---|
| **ID** | `cma-design-borrowings` |
| **Surface** | managed-agents · claude-api |
| **Statut** | mixte — beta (budgets, advisor roster, advisor tool, deployments) · research-preview (dreams) |
| **Disponible depuis** | `managed-agents-2026-04-01` ; budgets + advisor roster : `2026-08-07` ; advisor tool : beta publique `2026-04-09` (header `advisor-tool-2026-03-01`) ; dreams : header `dreaming-2026-04-21`, annonce `2026-05-19` |
| **Tier** | T3-à-surveiller |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high (sauf « advisor tool » : medium) |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — advisor et dreams exigent des accès API absents |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2, bloc « Advisor — entrée de roster » : le commentaire `// bloc de contenu possible: { "type": "redacted" }` laissait croire à un bloc propre à l'advisor. Il s'agit en réalité de `BetaManagedAgentsRedactedBlock`, un bloc de contenu générique des Managed Agents (« placeholder for content withheld by Anthropic model policy »), disponible dans le `content` de tout `user.message` — sessions comme déploiements. Reformulé.
- §2, même bloc : ajout du fait, absent de la fiche, qu'un roster n'accepte **au plus qu'une seule** entrée `advisor`, et qu'un roster listant à la fois une entrée advisor et un membre nommé `anthropic.advisor` est rejeté en 400.

Tout le reste de §2 a été confronté à la doc officielle et tient **au mot près** : forme du `budget` (cents entiers en chaîne, `USD` seul, `"25.00"` rejeté), application entre deux requêtes modèle avec dépassement borné à une requête par thread, `stop_reason: budget_reached` + événement `session.usage` + webhook `session.budget_reached` (le webhook existe bien sous ce nom), asymétrie « attachable seulement à la création, jamais re-ajoutable après retrait » (400 documenté) ; entrée de roster `{"type":"advisor","model":…}`, nom réservé `anthropic.advisor` porté comme `agent_name` puis `from_agent_name`, invisible à `list_agents`, non joignable par `send_to_agent`, exempté de la limite de 25 threads concurrents, thread auto-terminant, retrait par `"multiagent": null` ; outil `advisor_20260301` derrière `advisor-tool-2026-03-01`, `server_tool_use` à `input` vide, union `advisor_result` / `advisor_redacted_result` / `advisor_tool_result_error` avec les **sept** `error_code` cités exactement, `max_tokens` minimum 1024, variant chiffré pour Opus 5 / Fable 5 / Mythos 5, advisor sans outils ni context management et blocs de thinking supprimés ; dreams derrière `dreaming-2026-04-21` (le header `managed-agents-2026-04-01` seul ne suffit pas), 1 à 100 sessions, `instructions` ≤ 4096 caractères, les cinq statuts et les quatre erreurs citées ; déploiements avec jitter jusqu'à 15 % de l'intervalle (min 5 s, max 9 min), plafond de 1 000 par organisation, `trigger_context.type: schedule | manual`, `has_error=true`, webhooks `deployment.*` et `deployment_run.started|succeeded|failed`. La note « `system.message` accepté dans les `initial_events` d'un déploiement mais **pas** d'une session » est exacte : la référence de `POST /v1/sessions` limite explicitement les `initial_events` à `user.message` et `user.define_outcome`.

Statut d'en-tête inchangé : beta pour budgets, advisor (roster et outil) et déploiements ; dreams reste bien annoncé comme research preview par la doc.

§5 : les 14 fichiers cités existent tous, et **chaque numéro de ligne est exact** — `RateLimiter` ligne 51, `ImpactScorer` ligne 42, `SseEmitter` ligne 33, `ConflictDetector.detect()` ligne 20 (combine bien `Consultation`, `DependencyMapper`, `FileTracker`), `setInterval` du sweeper ligne 126 (avec `MAX_CHAINED_RUNS = 3` et la passe de 11 `DELETE … LIMIT 1000`), `startScheduler()` ligne 288 avec le `log.warn` ligne 294 et la première passe à 5 000 ms ligne 300, `timeoutSweeperHandle` ligne 45, `sweeperHandle` ligne 96, heartbeat SSE ligne 384 et sweep de sessions MCP ligne 1372. Les décomptes d'outils sont bons (4 dans `agents-tools.ts`, 11 dans `consultation-tools.ts`, tous vérifiés nominativement). L'affirmation de §4 « aucune occurrence de `jitter` dans `src/` » est vérifiée : zéro occurrence.

**Marqueurs `(à vérifier)` restants :** aucun — la fiche n'en contenait aucun.

**Testabilité :** ⚠️ partielle
Trois des cinq pistes se challengent intégralement en local, sans aucun accès Anthropic : le comptage des threads qui se terminent en un aller-retour (lecture de la base de test via `src/tools/consultation-tools.ts`), le jitter sur `git-cochange-builder.startScheduler` et le `setInterval` du sweeper avec cinq instances lancées en parallèle, et le prototype de budget en cents-chaîne sur `register_agent` (aller-retour SQLite + distinction pause / rejet `RateLimiter.check`). Les deux autres sont bloquées : la comparaison `ImpactScorer` contre `advisor_20260301` demande une clé API Anthropic autorisée sur le header beta `advisor-tool-2026-03-01`, et la question du variant `advisor_redacted_result` ne se tranche qu'avec cette même clé et un modèle Opus 5 / Fable 5 / Mythos 5. Dreams n'est pas testable du tout : research preview sur demande d'accès.

---

## 1. Ce que c'est

Cette fiche regroupe cinq mécanismes de la plateforme Claude qui ne sont pas des features à adopter telles quelles, mais des **patrons de conception** directement transposables au coordinateur.

**Budgets de session.** Un objet `budget` optionnel, posé à la création d'une session, plafonne son coût liste. Le montant est un entier de cents US écrit en **chaîne** (jamais un nombre flottant), `USD` est la seule devise. Le plafond s'applique **entre deux requêtes modèle** : la requête qui franchit le seuil se termine d'abord, donc le coût final peut légèrement dépasser. Atteint, le budget met la session en pause `idle` avec le stop reason `budget_reached` — un état explicite, pas un échec. Asymétrie notable : un budget ne peut être **attaché** qu'à la création ; on peut ensuite le modifier ou le retirer, jamais le rajouter après retrait.

**Advisor.** Deux surfaces distinctes du même concept. (a) Une entrée de roster `{"type":"advisor","model":…}` en Managed Agents : un conseiller consultable en plein tour, invisible pour `list_agents`, non joignable par `send_to_agent`, exempté de la limite de 25 threads concurrents, et qui tourne comme un thread éphémère auto-terminant. (b) Un outil serveur `advisor_20260301` sur l'API Messages : l'exécuteur émet un `server_tool_use` dont l'`input` est **toujours vide** — c'est le serveur qui construit la vue du conseiller à partir de la transcription complète.

**Dreams.** Un job asynchrone qui lit un memory store **plus** 1 à 100 transcripts de sessions passées et produit un **nouveau** store réorganisé (doublons fusionnés, entrées périmées remplacées). L'entrée n'est jamais mutée, donc la sortie est relisable et jetable.

**Scheduled deployments.** Un cron hébergé, avec deux détails de conception utiles : la **tentative** (`deployment_run`) est enregistrée séparément du **résultat** (la session), et un jitter allant jusqu'à 15 % de l'intervalle (min 5 s, max 9 min) est appliqué systématiquement pour répartir la charge.

## 2. Surface d'API exacte

```jsonc
// Budget de session — POST /v1/sessions, POST /v1/deployments
{ "budget": { "type": "limit",
              "max_list_cost": { "amount": "2500", "currency": "USD" } } }
// UpdateSession accepte  "budget": null  pour retirer
// stop reason: budget_reached | event: session.usage | webhook: session.budget_reached
```

```jsonc
// Advisor — entrée de roster Managed Agents
{ "type": "advisor", "model": "claude-opus-5" }
// nom de thread réservé: anthropic.advisor
//   (porté comme agent_name sur les events de cycle de vie, from_agent_name à la livraison)
// "multiagent": null pour retirer l'advisor s'il est seul
// au plus UNE entrée advisor par roster ; un roster qui liste à la fois
//   une entrée advisor et un membre nommé "anthropic.advisor" -> 400
// { "type": "redacted" } n'est PAS propre à l'advisor : c'est un bloc de contenu
//   générique des Managed Agents (contenu retenu par la politique de modèle),
//   admis dans le content de tout user.message (session comme déploiement)
```

```jsonc
// Advisor tool — anthropic-beta: advisor-tool-2026-03-01 · POST /v1/messages (SDK beta)
{ "tools": [ { "type": "advisor_20260301",        // requis
               "name": "advisor",                 // requis
               "model": "claude-opus-5",          // requis
               "max_uses": 3,                     // défaut illimité
               "max_tokens": 1024,                // min 1024, plafonne thinking + texte
               "caching": { "type": "ephemeral", "ttl": "5m" } } ] }
// + propriétés génériques d'outil: cache_control, allowed_callers, defer_loading, strict
// Réponse: server_tool_use (name "advisor", input TOUJOURS vide)
//          puis advisor_tool_result dont content est une union discriminée:
//            advisor_result            { text, stop_reason }
//            advisor_redacted_result   { encrypted_content, stop_reason }
//            advisor_tool_result_error { error_code: max_uses_exceeded | too_many_requests
//                                        | overloaded | prompt_too_long
//                                        | execution_time_exceeded | model_not_found | unavailable }
// stop_reason n'est présent que si max_tokens est défini sur la définition d'outil.
// Variant chiffré: Opus 5, Fable 5, Mythos 5. Les autres (ex. claude-opus-4-8) renvoient le texte clair.
// Le conseiller tourne sans outils ni context management ; ses blocs de thinking sont supprimés.
```

```jsonc
// Dreams — anthropic-beta: managed-agents-2026-04-01,dreaming-2026-04-21
POST /v1/dreams
{ "inputs": [ { "type": "memory_store", "memory_store_id": "…" },
              { "type": "sessions", "session_ids": [ "…" ] } ],   // 1 à 100
  "model": "claude-opus-5",
  "instructions": "…" }                                            // max 4096 car.
GET  /v1/dreams/{id} -> { status, outputs:[{type:"memory_store", memory_store_id}],
                          session_id, usage, error }
     // status: pending | running | completed | failed | canceled
POST /v1/dreams/{id}/cancel · /archive
// erreurs: input_memory_store_unavailable, input_session_unavailable,
//          input_memory_store_too_large, memory_store_org_limit_exceeded
```

```jsonc
// Scheduled deployments
POST /v1/deployments { name, agent, environment_id, initial_events,
                       schedule: { type:"cron", expression:"0 9 * * 1-5", timezone:"Europe/Paris" },
                       budget }
// initial_events accepte user.message | user.define_outcome | system.message
//   (system.message n'est PAS accepté dans les initial_events d'une session)
// Réponse: schedule.upcoming_runs_at, schedule.last_run_at, status, paused_reason
POST /v1/deployments/{id}/pause|unpause|archive|run
GET  /v1/deployment_runs?deployment_id=&has_error=true
//   -> trigger_context.type: schedule | manual ; session_id ou error.type
// erreurs: environment_archived_error, agent_archived_error, session_rate_limited_error
// webhooks: deployment.*, deployment_run.started|succeeded|failed
// Max 1000 déploiements par organisation.
```

## 3. Sources

- https://platform.claude.com/docs/en/managed-agents/sessions
- https://platform.claude.com/docs/en/managed-agents/session-operations
- https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration
- https://platform.claude.com/docs/en/managed-agents/dreams
- https://platform.claude.com/docs/en/managed-agents/scheduled-deployments
- https://platform.claude.com/docs/en/managed-agents/webhooks
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- https://platform.claude.com/docs/en/release-notes/overview
- https://claude.com/blog/new-in-claude-managed-agents
- https://releasebot.io/updates/anthropic/claude-developer-platform

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

1. **Budget par agent.** Le projet a `src/quota/` (lecture de l'utilisation OAuth Anthropic, en lecture seule) et `src/auth/rate-limit.ts` (token bucket par clé). Il n'existe **aucune** notion de plafond de coût par agent ou par thread. Le design du budget est reprenable tel quel : montant en cents sous forme de chaîne (pas de flottant en base), application entre deux opérations et non au milieu, état de **pause explicite** plutôt qu'un rejet 429 — ce qui change tout pour un agent qui boucle sur `announce_work` / `post_to_thread`. L'auto-hébergeur qui laisse tourner 6 agents la nuit gagne un garde-fou dur.
2. **`consult_peer` distinct de la délégation.** Les 11 outils de `src/tools/consultation-tools.ts` font de la consultation **agent-à-agent** (threads persistants, `propose_resolution` / `approve_resolution` / `contest_resolution`). L'advisor fait de la consultation **modèle-à-modèle** dans un seul tour. Ce sont deux primitives différentes et complémentaires — un lecteur pressé les confondra, donc c'est un point de positionnement à écrire noir sur blanc. Application directe : l'arbitrage « qui doit céder sur ce fichier ? » est aujourd'hui une heuristique maison dans `src/impact-scorer.ts` (16,8 Ko de scoring) ; un appel advisor déplacerait ce jugement vers un modèle plus capable, avec `max_uses` comme garde-fou de coût.
3. **Consolidation non destructive de l'historique.** `src/git-cochange-builder.ts`, `src/consultation.ts` et `src/sweeper/index.ts` accumulent puis **suppriment** (11 `DELETE … LIMIT 1000` par tick). Le modèle « dreams » propose l'inverse : produire un **nouveau** jeu de connaissances repo, laisser l'ancien intact, faire relire avant adoption. Ça élimine la classe entière de bugs de compaction destructive que le sweeper actuel peut provoquer.
4. **Jitter et journal de tentative.** Vérifié : aucune occurrence de `jitter` dans `src/`. `git-cochange-builder.startScheduler` (ligne 288) et le `setInterval` du sweeper (ligne 126) se déclenchent à intervalle fixe ; sur une flotte d'instances auto-hébergées, tous les coordinateurs tapent le disque et git en même temps. Et un échec de build n'est journalisé qu'en `log.warn` (ligne 294) : il n'y a pas d'enregistrement de tentative interrogeable, l'équivalent de `GET /v1/deployment_runs?has_error=true`.

**Risque si on ne fait rien :** faible — aucune de ces cinq choses n'est une menace. Le coût de l'inaction est diffus : pas de plafond de dépense par agent (l'auto-hébergeur découvre la facture après coup), un scoring de conflit maison qui restera une heuristique, et des tâches périodiques non observables.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/quota/quota.ts` | Extension : aujourd'hui pur wire protocol vers `/api/oauth/usage` (3 buckets 5h/7d/7d-sonnet), lecture seule. Un budget par agent est une notion **nouvelle**, pas une extension de ce module — à placer à côté, pas dedans. |
| `src/auth/rate-limit.ts` | `RateLimiter` (token bucket, `check`/`peek`, ligne 51) est le point d'ancrage le plus proche d'un plafond. Différence de sémantique à trancher : un rate limit rejette, un budget met en **pause**. |
| `src/agent-registry.ts` | Porterait l'état `budget` et l'état de pause d'un agent, à côté de l'enregistrement et du heartbeat. |
| `src/tools/agents-tools.ts` | 4 outils (`register_agent`, `list_agents`, `heartbeat`, `agent_activity`). `register_agent` accueillerait le `budget` optionnel à la création — même asymétrie « attachable seulement à la création » à décider. |
| `src/tools/consultation-tools.ts` | 11 outils (`announce_work`, `post_to_thread`, `propose_resolution`, `approve_resolution`, `contest_resolution`, `close_thread`, `cancel_thread`, `get_thread`, `get_thread_updates`, `list_threads`, `log_action_summary`). Un `consult_peer` éphémère s'y ajouterait, ou pas — c'est la question de §6.1. |
| `src/impact-scorer.ts` | `ImpactScorer` (classe, ligne 42) + `ImpactScore` / `CategorizedImpact`. Candidat au remplacement partiel par un appel advisor pour l'arbitrage de conflit. |
| `src/conflict-detector.ts` | `ConflictDetector.detect()` combine `Consultation`, `DependencyMapper`, `FileTracker`. C'est le site d'appel naturel d'un arbitre externe. |
| `src/sweeper/index.ts` | `setInterval` 60 s (ligne 126), passe chaînée de 11 `DELETE … LIMIT 1000`, `MAX_CHAINED_RUNS`. Cible du jitter et du journal de tentative. |
| `src/git-cochange-builder.ts` | `startScheduler()` (ligne 288) : `setTimeout(tick, refreshMs)` / `retryMs`, première passe à 5 s. Aucun jitter ; échec réduit à un `log.warn`. Cible directe de l'emprunt « deployment_run ». |
| `src/consultation.ts` | `timeoutSweeperHandle` (`setInterval`, ligne 45). Même remarque de jitter. |
| `src/working-files-tracker.ts` | `sweeperHandle` (`setInterval`, ligne 96). Idem. |
| `src/sse-emitter.ts` | `SseEmitter` (ligne 33) : canal de diffusion d'un événement `budget_reached` vers le dashboard. |
| `src/serve-http.ts` | Heartbeat SSE (ligne 384) et sweep de sessions MCP (ligne 1372) — deux autres timers à intervalle fixe. |
| `src/metrics.ts` / `src/observability/metrics.ts` | Exposition d'un compteur de budgets atteints et de tentatives de tâches périodiques échouées. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Un `consult_peer` éphémère (un tour, auto-terminant, hors des 11 outils de thread) est-il une **primitive manquante** de mcp-coordinator, ou l'arbitrage de conflit doit-il rester un thread `propose_resolution` / `approve_resolution` persistant, l'appel modèle-à-modèle étant alors relégué à un détail d'implémentation interne de `ImpactScorer` que le protocole MCP n'expose jamais ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Les deux points « advisor » ne sont pas exécutables ici : il faut une clé API Anthropic autorisée sur le header beta `advisor-tool-2026-03-01` ; dreams demande en plus un accès à la research preview.

- [ ] Relire les 11 outils de `src/tools/consultation-tools.ts` et compter combien de threads réels, dans une base de test, se terminent en un seul aller-retour sans `propose_resolution` — si la majorité, le thread persistant est sur-dimensionné et `consult_peer` a sa place.
- [ ] Instrumenter `ImpactScorer` sur un jeu de conflits réels du repo, comparer son verdict à celui d'un appel `advisor_20260301` (header `advisor-tool-2026-03-01`, `max_uses: 1`) et mesurer le taux de désaccord ainsi que le coût par arbitrage.
- [ ] Ajouter un jitter de 15 % (min 5 s, max 9 min) sur `git-cochange-builder.startScheduler` et le `setInterval` du sweeper, puis lancer 5 instances en parallèle et observer l'étalement des pics d'I/O.
- [ ] Prototyper un budget en cents-chaîne sur `register_agent` : vérifier qu'il survit à l'aller-retour SQLite sans arrondi et que l'état de pause est bien distinct d'un rejet de `RateLimiter.check`.
- [ ] Vérifier si le variant `advisor_redacted_result` (Opus 5) rend l'arbitrage inexploitable côté coordinateur — le texte du verdict ne serait pas lisible, seul un modèle appelant le verrait.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Dépendance à des surfaces instables.** Quatre des cinq mécanismes sont en beta derrière des headers datés (`advisor-tool-2026-03-01`, `managed-agents-2026-04-01`), le cinquième (dreams) est en research preview derrière `dreaming-2026-04-21`. Coder contre eux, c'est signer pour des breaking changes non annoncés.
- **Portabilité.** L'advisor tool passe par `client.beta.messages.create` chez Anthropic. Un arbitre de conflit qui en dépend rend `ConflictDetector` inutilisable hors plateforme Claude — alors que le coordinateur est aujourd'hui un serveur MCP neutre, utilisable par n'importe quel client.
- **Coût opaque pour l'auto-hébergeur.** Un arbitrage advisor sur Opus 5 par conflit détecté est un coût récurrent invisible dans une installation self-hosted. `max_uses` plafonne le nombre d'appels, pas la facture.
- **Le variant chiffré peut tuer l'usage.** Si Opus 5 renvoie `advisor_redacted_result`, le coordinateur reçoit un `encrypted_content` qu'il ne peut ni journaliser, ni afficher au dashboard, ni auditer. Un arbitrage non auditable est un arbitrage inacceptable dans un outil de coordination.
- **YAGNI sur le budget.** Le projet a déjà `RateLimiter` et la lecture de quota OAuth. Personne n'a demandé un plafond de dépense par agent. Ajouter un troisième mécanisme de limitation, avec sa propre sémantique de pause, c'est trois façons différentes de dire non à un agent.
- **Effort disproportionné pour « dreams ».** Un pipeline de consolidation hors ligne de l'historique repo est un chantier `L` complet (nouveau schéma, nouveau job, revue humaine) pour une valeur non démontrée : rien n'indique aujourd'hui que la connaissance accumulée par le coordinateur se périme au point de nuire.
- **Le jitter et le journal de tentative sont les seuls emprunts vraiment bon marché.** Ils ne dépendent d'aucune API Anthropic, coûtent quelques dizaines de lignes, et pourraient être adoptés en ignorant complètement le reste de la fiche — ce qui affaiblit l'argument de traiter ces cinq mécanismes comme un lot.
- **Point non tranché dans le bundle.** Les chercheurs décrivent deux « advisor » homonymes (l'entrée de roster Managed Agents ajoutée le 2026-08-07, et l'outil serveur `advisor_20260301`). Même concept, surfaces API différentes et statuts d'évolution indépendants. Aucune source ne dit laquelle convergera ; choisir la mauvaise, c'est une réécriture.

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
| 2026-08-14 | Vérification des faits : §2 et §5 confirmés au mot près ; bloc `redacted` reclassé comme générique. |
