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
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — adopter partiellement ; 4 emprunts refuses, le 5e recentre ; livrable #368 |

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

**Ce que je pense avant de mesurer.** §6.5 dit déjà la chose honnête, et personne ne l'a tirée jusqu'au bout : *« Le jitter et le journal de tentative sont les seuls emprunts vraiment bon marché … ce qui affaiblit l'argument de traiter ces cinq mécanismes comme un lot. »* Mon hypothèse est que le verdict se joue là — cinq emprunts d'ampleur incomparable, dont **un seul** ne dépend d'aucune surface Anthropic.

Et je pense que la prémisse de §6.1 est déjà fausse dans le code. Elle oppose « `consult_peer` éphémère » à « thread `propose_resolution` / `approve_resolution` persistant », en supposant que l'arbitrage **passe** par ce cycle. Or `E11` a relevé au passage que `runCommonAnnounceFlow` fait un `UPDATE threads SET status='resolved'` — il existe donc un chemin d'**auto-résolution** qui court-circuite le cycle complet. Si la majorité des threads se ferment ainsi, le « thread persistant sur-dimensionné » que §6.3 cherche à mesurer est déjà contourné par le produit lui-même, et `consult_peer` ne comble aucun manque.

**Contrainte de mesure à annoncer d'avance** (leçon d'`E06`, où un corpus pré-enregistré s'est révélé vide) : `E10` a mesuré que les bases SQLite versionnées contiennent **0 thread**. Le point 1 de §6.3 — « compter combien de threads réels se terminent en un aller-retour » — n'a donc **pas de corpus**. Je ne le remplacerai pas par un échantillon fabriqué : je mesurerai à la place ce qui est vérifiable, à savoir **si le chemin d'auto-résolution existe et sous quelle condition il se déclenche**.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

Cinq emprunts, adjugés **séparément** — leçon d'`E11` et d'`E14`, où un seuil unique décidait de plusieurs changements.

| # | Emprunt | Critère de mort | Seuil chiffré |
|---|---|---|---|
| **K1** | advisor / `consult_peer` | **Le cycle complet est déjà court-circuité.** Si le produit résout déjà des threads sans `propose_resolution`, `consult_peer` ne comble aucun manque. | un chemin d'auto-résolution existe **et** se déclenche sans intervention d'un pair |
| **K2** | advisor | **Arbitrage inauditable.** Si le variant chiffré s'applique aux modèles qu'on utiliserait, le coordinateur reçoit un verdict qu'il ne peut ni journaliser ni afficher. | `advisor_redacted_result` documenté pour Opus 5 / Fable 5 / Mythos 5 |
| **K3** | advisor | **Rupture de portabilité.** `ConflictDetector` deviendrait inutilisable hors plateforme Claude. | l'advisor n'a **aucun** équivalent dans le protocole MCP |
| **K4** | budget | **YAGNI, et un troisième mécanisme de refus.** | **0** demande, et ≥ **2** mécanismes de limitation déjà présents |
| **K5** | dreams | **Chantier `L` sans valeur démontrée.** | research preview sur demande, **0** signal que la connaissance accumulée se périme |
| **K6** | jitter + journal de tentative | **Ce n'est pas bon marché.** Si l'emprunt touche plus de quelques dizaines de lignes ou dépend d'une API, il perd son seul avantage. | > **5** fichiers à toucher, ou une dépendance externe |

**Règle que je m'impose :** §0 classe la fiche ⚠️ **partielle** — advisor et dreams exigent des accès absents. Ces deux volets ne peuvent **jamais** recevoir `adopter`. Et j'applique les leçons accumulées : mesurer le chemin réel et non le prédicat (`E04`, `E14`), vérifier une absence plutôt que la supposer (`E08`, `E10`, `E12`), grepper la doc du dépôt avant de crier à la découverte (`E09`), annoncer d'avance qu'un corpus manque plutôt que de lui substituer un échantillon fabriqué (`E06`), et distinguer une dérive de dépendance d'un défaut de vérification (`E13`, `E14`).

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

#### A. Mon hypothèse sur K1 était fausse, et je l'écris

J'avais parié que le cycle `propose_resolution` / `approve_resolution` était déjà court-circuité par une auto-résolution. Deux chemins existent — mais **tous deux ne se déclenchent que faute d'interlocuteur** :

```
src/announce-workflow.ts:110  shouldAutoResolve = concernedIds.length === 0 && otherOnlineCount === 0
src/consultation.ts:422       if (t.status === "open" && updated.length === 0)   // handleAgentDeparture
```

Et le commentaire de `announce-workflow.ts:96-98` énonce l'intention : *« Auto-resolve only when truly alone — if peers are online but not concerned … keep the thread open »*. Le cycle persistant **est** donc le seul mécanisme d'arbitrage entre deux agents vivants. **K1 ne se déclenche pas**, et la prémisse de §6.1 tient.

**Contrainte annoncée d'avance, tenue :** le point 1 de §6.3 — « compter combien de threads réels se terminent en un aller-retour » — n'a **pas de corpus** (`E10` a mesuré 0 thread dans les bases versionnées). Je ne lui ai pas substitué d'échantillon fabriqué ; j'ai mesuré à la place la **condition de déclenchement** du chemin, ce qui répond à la question sans inventer de données.

#### B. Le volet que j'allais adopter s'effondre — sa justification est réfutée par le dépôt lui-même

**§4.4 fonde le jitter sur un scénario qui viole un contrat documenté.** Le scénario est « une flotte d'instances auto-hébergées qui tapent le disque et git en même temps ». Or `docs/ops/single-instance-constraints.md` :

> « **Run exactly one coordinator process per data directory.** Phase 5 introduces Redis-backed equivalents that lift this constraint. »

Le multi-instance n'est pas un déploiement, c'est une **mauvaise configuration**. Et le document liste la contention du verrou SQLite comme le **signal de diagnostic** de cette erreur : le circuit du sweeper s'ouvre après `CIRCUIT_BREAK_THRESHOLD = 5` échecs, et `coordinator_sweeper_circuit_open=1` est le symptôme à surveiller. **Un jitter étalerait les écritures et rendrait ce signal muet**, sans toucher aucun des vrais dangers que le jitter ne peut pas adresser (course de migration, doublement du rate-limit, doublement du lockout, course sur la lecture d'epoch).

**Le dépôt a déjà tranché la question, et il a choisi l'élection de leader.** `src/sweeper/index.ts:104-115` :

> *« Phase 5 multi-instance: optional leader-election gate (Redis `SET key NX EX` lease per single-instance-constraints.md). When provided, each tick first asks the gate; non-leaders skip their pass so only one instance issues the DELETE batches. »*

C'est une violation de la leçon d'`E09` par la fiche : **§4.4 annonce un manque que la doc et le code du dépôt avaient déjà comblé, par un autre mécanisme.**

**Et le tueur structurel : il n'y a aucun cron.** `grep -rc "cron\|crontab\|node-cron" src/` → **0**. Les 11 timers sont tous **relatifs au boot**. Anthropic a besoin de jitter parce qu'une expression `"0 9 * * 1-5"` déclenche à 09:00:00 exactement pour chacun des 1 000 déploiements d'une org — un alignement sur l'horloge murale **par construction**. Deux processus coordinateur sont déjà déphasés par leur écart de démarrage. **L'emprunt transplante un correctif d'alignement horloge-murale sur des timers qui ne sont jamais alignés sur l'horloge murale.**

**Ce qui survit, sur un tout autre motif.** Il existe un vrai convoi, et il est **intra-processus**, dans la topologie **supportée** : cinq timers armés à quelques millisecondes l'un de l'autre au boot, dont **trois écrivent en SQLite** —

| Timer | Intervalle | Écrit en base |
|---|---|---|
| `sweeper.start()` (`boot.ts:541`) | 60 s | oui — 11 `DELETE … LIMIT 1000` × jusqu'à 3 passes chaînées |
| `workingFiles.startSweeper()` (`server-setup.ts:70-72`) | 60 s | oui — `DELETE FROM working_files` |
| `consultation.startTimeoutSweeper()` (`serve-http.ts:1433`) | 30 s | oui — s'aligne un tick sur deux |
| `mcpSessionSweepHandle` (`serve-http.ts:1373`) | 60 s | non |
| `rateLimiter.startSweeper()` | 60 s | non (en mémoire) |

**Et je dois corriger mon propre seuil plutôt que de l'argumenter.** K6 disait « > 5 fichiers ⇒ pas bon marché » et j'avais mesuré **8 fichiers**, donc le seuil était **atteint**. J'allais écrire « seuil atteint mais inférence faible, un helper partagé rend le coût quasi constant » — c'est une rationalisation après coup. La bonne réponse est de **réduire le périmètre**, pas d'argumenter le coût à la baisse : recentré sur les timers qui se percutent réellement (`sweeper/index.ts`, `working-files-tracker.ts`, `consultation.ts`, `serve-http.ts:1373`), c'est **4 fichiers**, honnêtement sous le seuil.

Trois sites sont exclus **au fond**, pas par commodité :

- `serve-http.ts:385` — le heartbeat SSE. `SSE_HEARTBEAT_MS` accepte **n'importe quel entier positif sans borne haute** ; un opérateur à 55 000 ms plus 15 % de jitter obtient 63,25 s et perd la connexion que le heartbeat existe précisément pour préserver. **Y mettre du jitter est une régression.**
- `boot-encryption.ts:436` — un rappel toutes les 24 h qui n'écrit qu'un log. Rien ne contend.
- `quota/quota-cache.ts:215` — sa contention est avec une API **externe**, et elle a déjà été diagnostiquée et corrigée autrement (`DEFAULT_429_COOLDOWN_MS` + dédoublonnage single-flight), pas par étalement.

**Correction de conception :** pour un convoi de boot, le remède juste est un **décalage de phase fixe** sur l'armement initial, pas un aléa par tick. Une ligne par site, déterministe, et ça ne casse pas les tests qui comptent les ticks. Anthropic a besoin d'aléa parce qu'il a 1 000 locataires indépendants ; nous avons cinq timers que nous contrôlons.

#### C. Et la seconde moitié du volet adopté n'a aucun trou à combler — §4.4 est factuellement fausse

§4.4 affirme : *« un échec de build n'est journalisé qu'en `log.warn` : il n'y a pas d'enregistrement de tentative interrogeable, l'équivalent de `GET /v1/deployment_runs?has_error=true` »*. **C'est faux.** `build()` instrumente déjà chaque chemin d'échec :

```
src/git-cochange-builder.ts:70,77,88,95,155  metrics.gitCochangeBuilds.inc({ outcome: … })
                                              outcomes: failed | shallow_skipped | timeout | success
src/git-cochange-builder.ts:86-87             setMeta("available","false") + setMeta("last_error", …)
src/database.ts:242                           CREATE TABLE git_cochange_meta
src/http/handle-health.ts:38,76,108           remonte sur /health/ready
```

C'est **exactement** un enregistrement de tentative interrogeable en SQL, avec une colonne d'erreur, déjà exposé sur l'endpoint de santé. Le sweeper de son côté a **quatre** métriques (`src/observability/metrics.ts:193-230`). « Les échecs de tâches périodiques ne sont pas observables » est faux **pour les deux sites que §4.4 nomme**.

**Le vrai trou est bien plus étroit, et c'est un garde-fou fantôme, pas un emprunt.** `src/git-cochange-builder.ts:298-311` : le `catch` du **scheduler** ne contient qu'un `log.warn`. Or `build()` rattrape ses propres erreurs git et retourne normalement — donc ce `catch` ne se déclenche que sur ce que `build()` **ne** gère pas : `getDb()` et les écritures SQLite. Les échecs **les plus graves** n'ont donc **ni métrique, ni `setMeta`, ni circuit breaker**, et le scheduler se réarme à `retryMs` (défaut **300 000 ms**), pouvant tourner indéfiniment sans autre trace. À comparer au `CIRCUIT_BREAK_THRESHOLD = 5` du sweeper.

Et `last_error` est **write-only** : `grep -rn "last_error" src/ | grep -v setMeta` → **rien**. Écrit à la ligne 87, jamais relu — `handle-health.ts:112` ne sélectionne que `available`. → **#368**

#### D. Le refus du budget est correct, mais mes motifs étaient faibles

`quota-cache` **ne peut pas** servir de base, et le rend plus cher, pas moins :

```
src/quota/quota.ts:13   utilization: number;      // 0.0 – 100.0
```

`QuotaInfo` porte trois buckets de **pourcentages**, `resetsAt`, `minutesUntilReset` — **aucun décompte de tokens, aucun montant**. `quota-cache.ts:20-22` le dit : « the quota endpoint moves in percentage points, not token counts ». Un budget en cents n'a donc **aucune source de données** dans le dépôt : il faudrait toute une comptabilité de tokens par agent, plus une table de prix.

Et **#341** documente que `/api/token-usage` et les panneaux `token-total` / `token-agents` ont **zéro producteur** — ~134 lignes de code de budget de tokens mort, dont la recommandation est le **retrait**. Adopter un budget ressusciterait ce que le projet est sur le point de supprimer.

Enfin, le signal de coût existe — et il argumente dans l'autre sens. **#357** chiffre qu'un agent facturé au tour paie un aller-retour par message ; **#361** qu'une réponse peut faire 59 ko ; **#366** que `detect()` prend 1,5 s. **Dans les trois cas le remède du projet est de corriger à la source, jamais de plafonner la dépense en aval.** C'est un K4 beaucoup plus fort que « 0 demande + 4 mécanismes déjà là » : le budget n'est pas seulement non demandé, il est **étranger au style** de ce projet.

#### E. K2 ne porte pas — le refus de l'advisor tient sur autre chose

Le variant chiffré est **opt-in par choix de modèle** : §2 dit que « les autres (ex. `claude-opus-4-8`) renvoient le texte clair », et `model` est un champ requis de la définition d'outil. K2 est donc satisfait comme **fait documentaire** mais n'établit qu'une contrainte de sélection de modèle, pas une impossibilité d'audit. **Je l'adjuge « déclenché, inférence faible »** et ne le présente pas comme porteur.

Ce qui porte :

1. **K3, inentamé.** Aucun équivalent MCP ; `ConflictDetector` deviendrait Anthropic-only, pour un serveur dont tout le positionnement est la neutralité client.
2. **Ma propre règle pré-enregistrée** : §0 classe la fiche ⚠️ partielle, et §6.2b s'engageait à ce qu'advisor et dreams ne reçoivent **jamais** `adopter`.
3. **Un argument neuf, plus propre que K2** : éviter le variant chiffré impose de se fixer sur `claude-opus-4-8`, un modèle **plus ancien**, précisément pour garder l'arbitrage auditable. Or §4.2 justifie l'advisor par le fait de « déplacer ce jugement vers un modèle **plus capable** ». **Le bénéfice annoncé et l'exigence d'auditabilité sont mutuellement exclusifs** — et tenir cette ligne suppose d'épingler un identifiant de modèle derrière un header beta daté.

#### F. §0 était exacte — dérive de dépendance, zéro défaut de vérification

J'avais relevé quatre écarts de lignes (`git-cochange-builder` 302/305/310 contre 288/294/300 ; `working-files-tracker` 104 contre 96 ; heartbeat 385 contre 384 ; sweep MCP 1373 contre 1372). Vérifié à `605c082`, dernier commit du **2026-08-14** — la date de vérification :

```
git-cochange-builder.ts  288 startScheduler | 294 log.warn | 300 setTimeout(tick, 5000)
working-files-tracker.ts  96 sweeperHandle
serve-http.ts            384 heartbeat | 1372 mcpSessionSweepHandle
sweeper/index.ts         126 | consultation.ts 45 | rate-limit.ts 154
boot-encryption.ts       436 | quota-cache.ts 215
```

**Chaque numéro de §0 était juste quand il a été écrit**, y compris `log.warn` 294 et la première passe 300. Seuls 4 des 11 ont dérivé, à cause de quatre commits du 2026-08-15. **Dérive de dépendance, pas défaut de vérification** — la leçon d'`E13`/`E14` s'applique en faveur de la fiche, et c'est la **deuxième** fiche propre d'affilée après `E14`.

#### G. Adjudication des six critères

| # | Emprunt | Seuil | Mesure | Verdict |
|---|---|---|---|---|
| **K1** | advisor / `consult_peer` | un chemin d'auto-résolution se déclenche sans intervention d'un pair | les deux chemins exigent **zéro interlocuteur** (`otherOnlineCount === 0`, `updated.length === 0`) | **NE SE DÉCLENCHE PAS** — mon hypothèse était fausse |
| **K2** | advisor | variant chiffré documenté | documenté — **mais opt-in par choix de modèle** | **SE DÉCLENCHE, inférence faible** |
| **K3** | advisor | aucun équivalent MCP | confirmé | **SE DÉCLENCHE** |
| **K4** | budget | 0 demande, ≥ 2 mécanismes | 0 issue ; 4 mécanismes ; **et aucune source de données en cents** (`QuotaInfo` = pourcentages) ; **et #341 propose de supprimer la comptabilité de tokens** | **SE DÉCLENCHE, renforcé** |
| **K5** | dreams | research preview, 0 signal de péremption | confirmé ; **#341** ajoute qu'un daemon vivant à 26 h d'uptime a `orgs = 1` et toutes les autres tables à zéro — il n'y a **aucune** connaissance accumulée à consolider | **SE DÉCLENCHE** |
| **K6** | jitter + journal | > 5 fichiers, ou dépendance externe | **8 fichiers** sur le périmètre annoncé → **seuil atteint**. Recentré sur les 4 fichiers qui se percutent réellement, il passe dessous — mais **par réduction de périmètre, pas par argumentation** | **SE DÉCLENCHE sur le périmètre de §4.4**, ne se déclenche pas sur le périmètre corrigé |

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
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-17 |
| **Justification** | Cinq emprunts, adjugés séparément. **Quatre refusés, et le seul que j'allais adopter s'est effondré sous la mesure — il ne survit que recentré, et sur un tout autre motif.** ⭑ **Refusé — advisor.** K3 : aucun équivalent MCP, `ConflictDetector` deviendrait Anthropic-only pour un serveur dont tout le positionnement est la neutralité client. Et un argument neuf, plus propre que celui de la fiche : éviter le variant chiffré impose de se fixer sur `claude-opus-4-8`, un modèle **plus ancien**, alors que §4.2 justifie l'advisor par le passage à un modèle « plus capable » — **le bénéfice annoncé et l'exigence d'auditabilité sont mutuellement exclusifs**. ⭑ **Refusé — `consult_peer` comme outil MCP.** 0 demande, et `consultation-tools.ts` est déjà le plus gros bloc (11 des 26 outils). **Mais K1 ne se déclenche pas** : mon hypothèse d'un cycle déjà court-circuité était **fausse** — les deux chemins d'auto-résolution exigent **zéro interlocuteur**, donc le thread persistant est bien le seul mécanisme d'arbitrage. Le point de positionnement de §4.2 (consultation agent-à-agent ≠ modèle-à-modèle) mérite d'être écrit. ⭑ **Refusé — budget, sur des motifs bien plus forts que les miens.** `QuotaInfo` ne porte que des **pourcentages** (`utilization: 0.0-100.0`), aucun décompte de tokens, aucun montant : un budget en cents n'a **aucune source de données** dans le dépôt. **#341** propose de **supprimer** les ~134 lignes de comptabilité de tokens morte. Et #357/#361/#366 montrent que **le projet corrige le coût à la source, jamais en plafonnant la dépense en aval** : le budget n'est pas seulement non demandé, il est **étranger au style** du projet. ⭑ **Refusé — dreams.** Research preview, chantier `L`, et #341 mesure qu'un daemon vivant à 26 h d'uptime a `orgs = 1` et toutes les autres tables à zéro : il n'y a **aucune** connaissance accumulée à consolider. ⭑ **Adopté — le décalage de phase, mais pas pour la raison de §4.4, et sur 4 fichiers au lieu de 8.** §4.4 fonde le jitter sur une flotte multi-instance ; or `docs/ops/single-instance-constraints.md` dit **« Run exactly one coordinator process per data directory »** — ce n'est pas un déploiement, c'est une mauvaise configuration, dont la contention SQLite est précisément le **signal de diagnostic** que le jitter rendrait **muet**. Le dépôt a déjà tranché autrement : le `leaderGate` de `sweeper/index.ts:104-115`. Et `grep -rc "cron"` sur `src/` → **0** : les 11 timers sont **relatifs au boot**, donc l'emprunt transplante un correctif d'alignement horloge-murale là où il n'y a aucun alignement. **Ce qui survit est un autre constat** : un convoi **intra-processus**, dans la topologie **supportée** — trois écrivains SQLite armés à quelques millisecondes au boot, sur 60 s (et un quatrième à 30 s qui s'aligne un tick sur deux). **Correction de méthode :** mon seuil K6 (« > 5 fichiers ») était **atteint** à 8, et j'allais écrire « inférence faible, un helper rend le coût constant » — une rationalisation après coup. J'ai **réduit le périmètre** au lieu d'argumenter le coût : 4 fichiers, sous le seuil, avec trois sites exclus **au fond** — le heartbeat SSE (`SSE_HEARTBEAT_MS` sans borne haute : 55 s + 15 % = 63 s, donc le jitter y est une **régression**), le rappel 24 h, et `quota-cache` dont la contention est externe et déjà traitée autrement. Et un **décalage de phase fixe** à l'armement vaut mieux qu'un aléa par tick : déterministe, une ligne par site, sans casser les tests qui comptent les ticks. ⭑ **La seconde moitié du volet adopté est supprimée : §4.4 est factuellement fausse.** Elle affirme qu'« il n'y a pas d'enregistrement de tentative interrogeable » ; il y en a un — `git_cochange_meta` avec `available` et `last_error` (`database.ts:242`), le compteur `gitCochangeBuilds{outcome}` sur cinq chemins, et la remontée sur `/health/ready`. Le sweeper a en plus **quatre** métriques. **Le vrai trou est bien plus étroit** et c'est un garde-fou fantôme, pas un emprunt → **#368**. ⭑ **Et §0 était exacte** : les quatre écarts de lignes que j'avais relevés sont de la **dérive de dépendance** (vérifié à `605c082`, dernier commit du 2026-08-14), imputable à quatre commits du lendemain. **Deuxième fiche propre d'affilée** après `E14`. |
| **Issue / PR** | **#368** — le `catch` du scheduler de `git-cochange-builder` (`:298-311`) ne contient qu'un `log.warn` : il ne se déclenche que sur ce que `build()` ne rattrape pas (`getDb()`, les écritures SQLite), donc sur les échecs **les plus graves**, et ceux-là n'ont ni métrique, ni `setMeta`, ni circuit breaker — avec un réarmement à **300 000 ms** qui peut tourner indéfiniment. Plus : `last_error` est **write-only**, jamais relu. Famille des garde-fous fantômes (#313, #317, #353), indépendante de cette fiche. |
| **Jalon visé** | **#368** est petit et borné (le builder est opt-in, `null` sans `COORDINATOR_REPO_ROOT`) — à traiter avec les autres garde-fous fantômes. Le décalage de phase sur les 4 sweepers SQLite est un candidat autonome, à instruire **après** #368 puisque c'est le même fichier de départ. Aucun jalon pour advisor, budget, dreams ni `consult_peer`. |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : §2 et §5 confirmés au mot près ; bloc `redacted` reclassé comme générique. |
| 2026-08-17 | **Challenge — verdict `adopter partiellement` ; le seul volet que j'allais adopter s'est effondré sous la mesure.** **§4.4 fonde le jitter sur un scénario qui viole un contrat documenté** : `docs/ops/single-instance-constraints.md` dit **« Run exactly one coordinator process per data directory »**. Le multi-instance n'est pas un déploiement mais une mauvaise configuration, dont la contention SQLite est le **signal de diagnostic** que le jitter rendrait **muet**. Le dépôt a déjà tranché autrement — le `leaderGate` de `sweeper/index.ts:104-115`, cité dans le même document. Et `grep -rc "cron"` sur `src/` → **0** : les 11 timers sont **relatifs au boot**, donc l'emprunt transplante un correctif d'alignement horloge-murale là où rien n'est aligné. Violation de la leçon d'`E09` par la fiche : elle annonce un manque que la doc et le code avaient déjà comblé. **Ce qui survit est un autre constat** : un convoi **intra-processus** dans la topologie **supportée** — trois écrivains SQLite armés à quelques ms au boot sur 60 s (`sweeper`, `working-files-tracker`, `consultation` à 30 s qui s'aligne un tick sur deux), plus le sweep de sessions MCP. **Correction de méthode : mon seuil K6 était atteint (8 fichiers > 5) et j'allais écrire « inférence faible, un helper rend le coût constant » — une rationalisation après coup.** J'ai **réduit le périmètre** au lieu d'argumenter le coût : **4 fichiers**, avec trois exclusions **au fond** — le heartbeat SSE (`SSE_HEARTBEAT_MS` sans borne haute : 55 s + 15 % = 63,25 s, le jitter y est une **régression** face au kill proxy à ~60 s), le rappel 24 h qui n'écrit qu'un log, et `quota-cache` dont la contention est **externe** et déjà traitée par `DEFAULT_429_COOLDOWN_MS`. Et un **décalage de phase fixe** à l'armement vaut mieux qu'un aléa par tick : déterministe, une ligne par site, sans casser les tests qui comptent les ticks. **La seconde moitié du volet est supprimée — §4.4 est factuellement fausse** : elle affirme qu'« il n'y a pas d'enregistrement de tentative interrogeable » alors que `git_cochange_meta` (`available`, `last_error`, `database.ts:242`) plus `gitCochangeBuilds{outcome}` sur cinq chemins plus la remontée `/health/ready` constituent exactement cela ; le sweeper a en plus **quatre** métriques. **Le vrai trou est plus étroit** : le `catch` du scheduler (`git-cochange-builder.ts:298-311`) ne contient qu'un `log.warn`, et il ne se déclenche que sur ce que `build()` ne rattrape pas — `getDb()` et les écritures SQLite, donc les échecs **les plus graves** — sans métrique, sans `setMeta`, sans circuit breaker, avec réarmement à **300 000 ms**. Et `last_error` est **write-only**. → **#368**. **K1 ne se déclenche pas et mon hypothèse était fausse** : les deux chemins d'auto-résolution exigent **zéro interlocuteur** (`otherOnlineCount === 0` ; `updated.length === 0` dans `handleAgentDeparture`), le commentaire de `announce-workflow.ts:96-98` l'énonçant explicitement — le thread persistant **est** le seul mécanisme d'arbitrage. **K2 est déclenché mais d'inférence faible** : le variant chiffré est **opt-in par choix de modèle**. Le refus de l'advisor porte sur K3 plus un argument neuf : éviter le chiffrement impose `claude-opus-4-8`, un modèle **plus ancien**, alors que §4.2 justifie l'advisor par un modèle « plus capable » — **bénéfice annoncé et auditabilité sont mutuellement exclusifs**. **K4 renforcé** : `QuotaInfo` ne porte que des **pourcentages**, donc un budget en cents n'a **aucune source de données** ; **#341** propose de supprimer les ~134 lignes de comptabilité de tokens morte ; et #357/#361/#366 montrent que le projet **corrige le coût à la source, jamais en plafonnant en aval** — le budget est *étranger au style* du projet. **K5** : #341 mesure un daemon à 26 h d'uptime avec `orgs = 1` et tout le reste à zéro — aucune connaissance à consolider. **Contrainte annoncée d'avance, tenue** : le point 1 de §6.3 n'a **pas de corpus** (0 thread dans les bases versionnées, mesuré en `E10`) ; je n'y ai pas substitué d'échantillon fabriqué, j'ai mesuré la condition de déclenchement. **Et §0 était exacte** : les quatre écarts de lignes relevés sont de la **dérive de dépendance**, vérifiée à `605c082` (dernier commit du 2026-08-14) — deuxième fiche propre d'affilée après `E14`. |
