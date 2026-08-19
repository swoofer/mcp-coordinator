# C11 — Observabilité : traceparent, OTel multi-agents, APIs Analytics

| Champ | Valeur |
|---|---|
| **ID** | `otel-traceparent-analytics` |
| **Surface** | claude-code · claude-api |
| **Statut** | mixte — GA (métriques/événements OTel, APIs Analytics) · beta (traces/spans, propagation `traceparent`) |
| **Disponible depuis** | métriques/événements OTel et les deux APIs Analytics : GA ; spans + `traceparent` sortant : beta derrière `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` ; SEP-414 (`_meta.traceparent`) : Final côté protocole MCP |
| **Tier** | T2-fort-levier |
| **Nature** | replace-homemade-code |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — APIs Analytics hors de portée, faute de clés org |
| **Statut du challenge** | ✅ **tranché** (2026-08-16) — `reporter` : réveil sur l'émission de clés SEP-414 |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §1 / §2 (a) — précision majeure sur le déclenchement de `traceparent`. La doc dit : les requêtes MCP HTTP sortantes portent `traceparent` **quand le tracing est actif** (donc derrière la beta spans), et **par défaut seulement** si `ANTHROPIC_BASE_URL` est absent ou pointe sur l'API Anthropic ; `CLAUDE_CODE_PROPAGATE_TRACEPARENT=1` sert à forcer l'envoi derrière un proxy custom. La variable `TRACEPARENT` transmise aux sous-processus suit le même interrupteur. L'en-tête n'est pas envoyé aux fournisseurs tiers.
- §2 (b) — `query_source` n'est pas l'énumération fermée `main | subagent | auxiliary`. La doc décrit un attribut ouvert (« le sous-système qui a émis la requête »), citant aussi `repl_main_thread`, `compact`, ou un nom de subagent.
- §2 (c) — l'URL de création de la clé Analytics était fausse : ce n'est pas `claude.ai/analytics/api-keys` mais **claude.ai > Organization settings > API** (`https://claude.ai/admin-settings/api-access`), par le Primary Owner.
- §2 (c) — champs de la Claude Code Analytics API remis dans leur imbrication réelle : `core_metrics.{num_sessions, lines_of_code.{added,removed}, commits_by_claude_code, pull_requests_by_claude_code}`, `tool_actions.{edit_tool,multi_edit_tool,write_tool,notebook_edit_tool}.{accepted,rejected}`, `model_breakdown[].estimated_cost.{amount,currency}` (montant **en cents USD**). `terminal_type`, `customer_type`, `organization_id` et `actor` sont au niveau racine ; `actor` vaut soit `{type:"user_actor", email_address}` soit `{type:"api_actor", api_key_name}` — `actor.email_address` n'est donc pas toujours présent.
- §2 (c) — Enterprise Analytics : `group_by[]` et `products[]` s'écrivent en notation crochets ; `cost_type` / `token_type` ne valent que pour `cost_report` ; `slack_channel_id` existe aussi. `starting_at` est borné : pas avant `2026-01-01T00:00:00Z`, plage de 31 jours max (366 pour `summaries`). Les limites de `limit` dépendent de l'endpoint et du `bucket_width` (pas un « max 1000 » uniforme).
- §2 — la phrase « Fraîcheur des données Analytics : ~1 h » ne vaut que pour la Claude Code Analytics API. L'Enterprise Analytics a un modèle différent : ~1 jour de décalage sur l'engagement/adoption, ~4 h à 24 h sur coût/usage avec révision jusqu'à 30 jours. Corrigé.
- §2 — l'indisponibilité Bedrock / Foundry / Google Cloud / Claude Platform on AWS est documentée pour la **Claude Code** Analytics API ; côté Enterprise, seule la limitation Bedrock est documentée. Corrigé.
- Les 6 métriques, les 5 événements et les 12 attributs cités en §2 (b) existent tous tels quels dans la doc — aucune correction de nom nécessaire. `claude_code.mcp_server_connection` porte bien `status`, `transport_type`, `server_scope`.
- SEP-414 : statut **Final** confirmé, clés `traceparent` / `tracestate` / `baggage` dans `params._meta` confirmées, exception à la convention de préfixage DNS confirmée. Le payload d'exemple de la fiche est conforme.
- §5 : les 15 fichiers cités existent tous et **tous les numéros de ligne sont exacts** (`request-id.ts:42`, `serve-http.ts:527` et `:751`, `types.ts:112`, `handle-rest.ts:71` et `:101`, `rest-handlers.ts:330`, `rest-schemas.ts:99`, `dashboard.js:17/284/654`, `agent-registry.ts` TTL 900 s). Le grep « aucune occurrence de `traceparent` dans `src/` » est confirmé, et aucune lecture de `params._meta` n'existe non plus. Les deux routes `/metrics` (l.702) et `/metrics/auth` (l.719) existent bien.

**Marqueurs `(à vérifier)` restants :** aucun dans §2. La note de §1 « à confirmer lors du challenge » sur le découpage GA/beta est désormais **tranchée par la doc** : métriques et événements sont GA, spans/traces sont beta derrière `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`. Le statut du tableau d'en-tête est donc exact et reste inchangé.

**Testabilité :** ⚠️ partielle
Testable ici : les trois premières lignes du protocole §6.3 (log des `req.headers` du daemon face à une session Claude Code réelle en HTTP, log de `params._meta` sur le chemin stdio, collecteur OTLP local avec `CLAUDE_CODE_ENABLE_TELEMETRY=1`), plus le comptage des appelants de `POST /api/token-usage` — tout tient sur le poste Windows avec Node 22, le daemon local et Claude Code installé. Non testable : les deux APIs Analytics, qui exigent respectivement une clé Admin d'organisation et une clé Analytics créée par un Primary Owner d'une org Claude Enterprise — aucune des deux n'est disponible dans ce profil de déploiement. Attention aussi : `traceparent` n'étant émis que lorsque le tracing est actif, la première mesure risque de ne rien voir sans `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, ce qui est précisément ce que §6.3 cherche à établir.

---

## 1. Ce que c'est

Trois surfaces d'observabilité distinctes, toutes situées **en amont** de mcp-coordinator.

**(a) Propagation de contexte de trace.** Quand le tracing est actif, Claude Code pose un en-tête W3C `traceparent` sur ses requêtes HTTP sortantes vers les serveurs MCP (et sur ses requêtes modèle), et hérite d'un `TRACEPARENT` entrant (sessions Agent SDK, `claude -p`) pour rattacher ses spans à la trace de l'appelant. Côté protocole, la SEP-414 est **Final** et normalise `traceparent` / `tracestate` / `baggage` directement dans `params._meta` d'une requête JSON-RPC MCP — explicitement en exception à la convention de préfixage DNS des clés `_meta`. Concrètement, un serveur MCP n'a qu'à lire l'en-tête (ou le `_meta`) et le réémettre pour que ses propres événements deviennent des enfants de la trace de la session appelante.

**(b) Export OTLP de Claude Code.** Avec `CLAUDE_CODE_ENABLE_TELEMETRY=1`, le client exporte métriques et événements en OTLP, déjà porteurs de l'attribution MCP et multi-agents : `mcp_server.name`, `mcp_tool.name`, `agent.name`, `query_source` (`main` | `subagent` | `auxiliary`), plus `session.id`, `prompt.id`, `tool_use_id`. L'événement `claude_code.mcp_server_connection` expose `status`, `transport_type`, `server_scope`. Les métriques/événements sont GA ; les **spans** restent beta.

**(c) APIs Analytics.** Deux APIs REST séparées, avec deux systèmes de clés différents : la *Claude Code Analytics API* (clé Admin, un enregistrement par utilisateur et par jour) et la *Claude Enterprise Analytics API* (scope `read:analytics`, agrégats par produit dont `claude_code_*`). Elles fournissent sessions, lignes ajoutées/supprimées, taux d'acceptation par outil d'édition, coût par modèle — sans instrumenter les postes.

Note de divergence entre chercheurs : la fiche (a) qualifie l'ensemble de « beta » ; la fiche (b) précise que seules les traces le sont, les métriques et événements étant GA. Les deux affirmations sont compatibles si l'on sépare les signaux ; la fiche retient ce découpage — **confirmé par la doc le 2026-08-14** (métriques et événements GA, spans/traces beta).

## 2. Surface d'API exacte

```
# (a) contexte de trace
en-tête HTTP : traceparent            # W3C Trace Context, requêtes MCP HTTP sortantes de Claude Code,
                                      # émis uniquement quand le tracing est actif ; par défaut seulement
                                      # si ANTHROPIC_BASE_URL est absent ou pointe sur l'API Anthropic.
                                      # Jamais envoyé aux fournisseurs tiers.
variables    : TRACEPARENT, TRACESTATE  # héritées par les sous-processus (même interrupteur) ; lues en
                                        # entrée par l'Agent SDK et les sessions `claude -p`
JSON-RPC     : params._meta.traceparent / .tracestate / .baggage   # SEP-414 (Final)
env          : CLAUDE_CODE_PROPAGATE_TRACEPARENT=1   # force l'envoi derrière un ANTHROPIC_BASE_URL custom
env          : CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 # (alias ENABLE_ENHANCED_TELEMETRY_BETA=1) — spans

# (b) OTel Claude Code
env       : CLAUDE_CODE_ENABLE_TELEMETRY=1, OTEL_METRICS_EXPORTER, OTEL_LOGS_EXPORTER,
            OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_LOG_TOOL_DETAILS, OTEL_METRICS_INCLUDE_SESSION_ID
métriques : claude_code.session.count, claude_code.cost.usage, claude_code.token.usage,
            claude_code.lines_of_code.count, claude_code.code_edit_tool.decision,
            claude_code.active_time.total
événements: claude_code.mcp_server_connection, claude_code.tool_result,
            claude_code.tool_decision, claude_code.api_request, claude_code.plugin_loaded
attributs : mcp_server.name, mcp_tool.name, agent.name, plugin.name, skill.name,
            query_source, speed, effort, session.id, prompt.id, tool_use_id, message.uuid
            # query_source est un ensemble OUVERT (« sous-système émetteur »), pas une enum fermée :
            # la doc cite main / subagent / auxiliary, mais aussi repl_main_thread, compact, nom de subagent

# (c) Analytics
GET /v1/organizations/usage_report/claude_code
    en-têtes : anthropic-version: 2023-06-01, x-api-key: <ADMIN_KEY>
    params   : starting_at=YYYY-MM-DD (jour unique, UTC), limit (défaut 20, max 1000),
               page (curseur opaque, champ next_page)
    racine   : date, actor, organization_id, customer_type, terminal_type
               actor = {type:"user_actor", email_address} | {type:"api_actor", api_key_name}
    champs   : core_metrics.{num_sessions, lines_of_code.{added,removed},
                             commits_by_claude_code, pull_requests_by_claude_code}
               tool_actions.{edit_tool,multi_edit_tool,write_tool,notebook_edit_tool}
                            .{accepted,rejected}
               model_breakdown[].{model, tokens.{input,output,cache_read,cache_creation},
                                  estimated_cost.{amount,currency}}   # amount en cents USD
GET /v1/organizations/analytics/{summaries,usage_report,user_usage_report,
                                 cost_report,user_cost_report,users}
    scope    : read:analytics  (clé Analytics créée par le Primary Owner sur
               claude.ai > Organization settings > API — https://claude.ai/admin-settings/api-access)
    params   : starting_at / ending_at (RFC3339 ; pas avant 2026-01-01T00:00:00Z, plage ≤ 31 j,
               366 j pour summaries), bucket_width=1d|1h|1m,
               group_by[]=model|product|rbac_group_id|speed|inference_geo|context_window|
                          slack_channel_id  (+ cost_type|token_type sur cost_report uniquement),
               products[]=chat|claude_code|cowork|office_agent|claude_in_chrome|claude_design|
                          claude-in-slack,
               limit (défaut/max dépendant de l'endpoint et du bucket_width), page
```

Payload minimal côté serveur MCP (SEP-414) :

```json
{ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
  "params": { "name": "announce_work",
              "_meta": { "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
              "arguments": { "agent_id": "backend", "modules": ["auth"] } } }
```

Fraîcheur : ~1 h pour la **Claude Code** Analytics API (seules les données de plus d'1 h sont renvoyées, pour stabiliser la pagination) ; l'**Enterprise** Analytics API suit un autre modèle — ~1 jour de décalage sur l'engagement/adoption (agrégation à 10 h UTC le lendemain), 4 h à 24 h sur coût/usage, révisable jusqu'à 30 jours. La Claude Code Analytics API ne couvre pas Bedrock, Microsoft Foundry, Google Cloud (Vertex) ni Claude Platform on AWS ; côté Enterprise, seule la lacune Bedrock est documentée. La Claude Code Analytics API est gratuite pour toute organisation disposant de l'Admin API ; l'Enterprise Analytics API est réservée aux organisations Claude Enterprise (les endpoints coût/usage ne valent pleinement que sur les plans Enterprise usage-based). Les deux clés ne sont pas interchangeables. Rate limit Enterprise : 60 req/min par organisation.

## 3. Sources

- https://code.claude.com/docs/en/monitoring-usage
- https://code.claude.com/docs/en/analytics
- https://modelcontextprotocol.io/seps/414-request-meta.md
- https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api
- https://platform.claude.com/docs/en/api/admin/analytics

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

1. *Une clé de corrélation gratuite, standard, en amont.* Aujourd'hui le daemon fabrique son propre identifiant : `resolveRequestId()` (`src/auth/request-id.ts:42`) reprend un `X-Request-Id` entrant s'il est bien formé, sinon génère un UUID v4. C'est un identifiant maison, plat, sans parent, qui ne relie rien à la session Claude Code émettrice. Lire `traceparent` (en-tête, ou `params._meta.traceparent` côté SEP-414) donne un `trace_id` + `span_id` déjà émis par le client, et permet d'estampiller chaque `CoordinatorEvent` et chaque publication MQTT avec la trace de la session qui l'a produite. Le dashboard peut alors relier un conflit détecté à la trace exacte qui l'a causé, au lieu de recouper par nom d'agent et horodatage.

2. *Un canal de télémétrie maison devient redondant.* `POST /api/token-usage` (`src/http/handle-rest.ts:71` → `handleTokenUsage`, `src/http/rest-handlers.ts:330`) accepte un objet JSON **libre**, non validé au-delà de « c'est un objet » (`src/http/rest-schemas.ts:99`), le rediffuse en SSE `token_usage`, et le dashboard l'agrège côté navigateur (`dashboard/public/dashboard.js:284`). Chaque agent doit donc être instrumenté à la main pour alimenter ce canal. `claude_code.token.usage` et `claude_code.cost.usage`, portant déjà `agent.name`, `mcp_tool.name` et `query_source`, fournissent la même donnée en sortie standard OTLP — et de façon fiable, y compris pour un agent qui *n'appelle jamais* le coordinateur.

3. *Une capacité aujourd'hui absente : l'agent silencieux.* Le registre ne connaît la vie d'un agent qu'à travers `last_seen_at` rafraîchi par `announce_work` / `post_to_thread` (`src/agent-registry.ts`, TTL 900 s). Un agent qui travaille sans annoncer est indiscernable d'un agent mort. Un flux `claude_code.tool_result` corrélé par `session.id` distingue les deux sans sonde maison.

4. *Une jointure agent ↔ humain.* `terminal_type` et `actor.email_address` de la Claude Code Analytics API relient un agent enregistré dans `agents` à un utilisateur réellement facturé — lien que le projet ne peut pas établir seul aujourd'hui.

**Risque si on ne fait rien :**

Nature de fond : Anthropic construit le plan de données d'observabilité multi-agents **dans le client**. Si le coordinateur reste la seule source de vérité sur « qui travaille sur quoi », il se retrouve à côté d'un flux OTLP plus riche, mieux attribué et déjà branché sur les collecteurs de l'entreprise. Le canal `token_usage` maison, en particulier, est un doublon appelé à vieillir mal. Risque secondaire, plus léger : rester sans `trace_id` signifie qu'aucune intégration APM tierce ne peut relier les événements du coordinateur au reste de la chaîne.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/auth/request-id.ts` | `resolveRequestId()` (l.42) et sa regex `VALID_INBOUND_REQUEST_ID` sont l'accroche naturelle : accepter aussi `traceparent` et exposer `getTraceContext()` à côté de `getRequestId()`, via le même `AsyncLocalStorage`. |
| `src/serve-http.ts` | l.527 lit `req.headers["x-request-id"]` ; l.751 lit `mcp-session-id`. Un seul point à étendre pour capter `traceparent`. Aucune occurrence de `traceparent` dans `src/` aujourd'hui (grep). |
| `src/tools/*.ts` (`agents-`, `consultation-`, `files-`, `dependencies-`, `mqtt-`, `status-tools.ts`) | Chemin stdio : le contexte n'arrive pas par en-tête HTTP mais par `params._meta` (SEP-414). Rien ne lit `_meta` aujourd'hui, y compris dans `cli/channel.ts`. |
| `src/sse-emitter.ts` + `src/types.ts` | `CoordinatorEvent` (l.112) n'a que `id` / `type` / `payload` / `created_at`. Ajouter `trace_id` demande un champ dédié ou une convention dans le `payload` JSON — décision de schéma, pas un ajout cosmétique. |
| `src/mqtt-bridge.ts` | Republier `traceparent` sur les topics `coordinator/{org}/...` pour que les consommateurs externes héritent de la trace. |
| `src/http/handle-rest.ts` (l.71, l.101) · `src/http/rest-handlers.ts:330` · `src/http/rest-schemas.ts:99` | La route `/api/token-usage` et son schéma libre sont le candidat direct au remplacement (ou à la dépréciation) par le flux OTLP. |
| `dashboard/public/dashboard.js` (l.17, l.284, l.654) | Agrégation par agent des événements `token_usage`, et liste blanche des types d'événements SSE. À revoir si la source de coût change. |
| `src/metrics.ts` + `src/observability/metrics.ts` | Deux registres Prometheus distincts (Phase 1 `/metrics`, Phase 2 `/metrics/auth`). Introduire un exportateur OTLP est une troisième voie de sortie : à arbitrer, pas à empiler. |
| `src/quota/quota.ts` | Consomme déjà `/api/oauth/usage` d'Anthropic (credential reader → OAuth). Précédent utile : le projet sait appeler une API Anthropic, mais avec des credentials utilisateur, pas une clé Admin. |
| `src/agent-registry.ts` | `last_seen_at` / TTL 900 s est la détection de liveness actuelle ; `claude_code.tool_result` en est un complément possible. |
| `cli/doctor.ts` | Point de diagnostic naturel pour vérifier `CLAUDE_CODE_ENABLE_TELEMETRY` / réception de `traceparent`. |
| `sdk/src/client.ts` | Devrait propager `traceparent` sortant pour que les consommateurs du SDK ne cassent pas la chaîne. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le coordinateur doit-il devenir un **participant passif** d'une chaîne OTel possédée par Claude Code — lire `traceparent` / `_meta` et estampiller ses événements sans jamais exporter — ou doit-il rester **la source de vérité de la coordination** avec son identifiant `X-Request-Id` maison et son canal `/api/token-usage`, au risque de dupliquer un plan de données que le client fournit déjà en GA ?

### 6.2 Hypothèse

*Pré-enregistrée le 2026-08-16, **avant** toute exécution.*

**Ce que je crois qu'il va se passer.**

1. **Aucun `traceparent` n'arrive** sans télémétrie active. La fiche le pressent (§0) ; c'est
   précisément ce qui décide de §6.1, puisque tout le scénario « participant passif » suppose que
   l'en-tête soit là.
2. `params._meta` d'un `tools/call` ne portera **pas** les clés SEP-414 par défaut.
3. Le remplacement de `POST /api/token-usage` est donc hors sujet tant que la chaîne amont n'émet
   rien : on ne remplace pas une source de vérité par un flux absent.

**Verdict pressenti :** `reporter`, avec pour livrable la mesure de ce qui arrive réellement.

**Critères de mort.**

| # | Si… | …alors |
|---|---|---|
| **K1** | `traceparent` **arrive** sans réglage particulier | mon hypothèse est fausse et la branche « participant passif » devient réelle : je dois l'écrire et réévaluer §6.1. |
| **K2** | `traceparent` n'arrive **jamais**, même avec la télémétrie activée | la branche « participant passif » est morte pour ce déploiement, et §4 est à corriger. |
| **K3** | `params._meta` ne porte aucune clé SEP-414 | le chemin stdio ne peut pas non plus servir de porteur, et il faut le dire. |
| **K4** | le remplacement de `/api/token-usage` toucherait plus de **8 fichiers** ou casserait un appelant réel | on ne déprécie pas : le canal maison reste. |
| **K5** | les deux APIs Analytics restent non exécutables | elles sortent du périmètre décidable — `reporter` nommément sur elles, comme K7 l'a fait pour `C10`. |
| **K6** | aucun utilisateur n'a demandé d'observabilité | filtre YAGNI, à peser : le projet a déjà des métriques Prometheus, donc le besoin n'est pas nul par principe. |

> 📌 **Leçon de `C10` appliquée d'avance :** K5 ci-dessus est une **note de périmètre**, pas un
> critère — il est vrai avant l'expérience, comme K7 l'était pour `C10`. Je le marque comme tel au
> lieu de feindre de l'adjuger à la fin.

### 6.3 Protocole de vérification

> ⚠️ Les deux appels aux APIs Analytics ne sont pas exécutables ici : ils exigent une clé Admin d'organisation, respectivement une clé Analytics de Primary Owner d'une org Claude Enterprise.

- [ ] Lancer une session Claude Code réelle contre le daemon en HTTP et logguer bruts `req.headers` dans `src/serve-http.ts` : confirmer qu'un `traceparent` arrive **sans** `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, puis avec.
- [ ] Même mesure sur le chemin stdio via `cli/channel.ts` : logguer `params._meta` d'un `tools/call` et vérifier la présence des clés SEP-414.
- [ ] Activer `CLAUDE_CODE_ENABLE_TELEMETRY=1` avec un collecteur OTLP local, déclencher un `announce_work`, et vérifier que `claude_code.token.usage` porte bien `mcp_server.name` / `mcp_tool.name` / `agent.name` — la promesse d'attribution est le cœur de la fiche.
- [ ] Appeler `GET /v1/organizations/usage_report/claude_code` avec une clé Admin réelle et vérifier la présence effective de `terminal_type` et `actor.email_address` dans la réponse.
- [ ] Mesurer le coût du remplacement : compter les appelants réels de `POST /api/token-usage` (SDK, dashboard, agents de test) avant d'envisager sa dépréciation.

### 6.4 Résultat observé

*Challenge du 2026-08-16. Claude Code **2.1.233**, serveur MCP HTTP espion + collecteur OTLP local.*

#### A. `traceparent` arrive — mais au bout d'une chaîne à **cinq** conditions

Trois mesures successives, sur le même serveur espion :

| Configuration | `traceparent` |
|---|---|
| aucun réglage | **absent** |
| `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` | **absent** |
| + `OTEL_TRACES_EXPORTER=otlp` + `OTEL_EXPORTER_OTLP_ENDPOINT` + **collecteur vivant** | ✅ **présent** |

```
#1 POST /v1/traces 16774o                       ← le collecteur reçoit
"traceparent": "00-a46d81d66918c3e5ed48e010741f0960-76d854fe4da37ec1-01"
```

> 🔴 **Correction d'une erreur que j'allais commettre.** Après les deux premières mesures j'allais
> écrire que `traceparent` « n'arrive jamais, même avec la télémétrie activée ». **C'est faux**, et le
> binaire l'aurait réfuté : l'injection existe bien dans le chemin de requête MCP (wrapper `fetch`,
> requêtes non-GET). Ce qui bloquait était en aval — sans `OTEL_TRACES_EXPORTER`, aucun *trace
> provider* n'est installé, le span est non-enregistrant, le `traceId` vaut 32 zéros, et l'injection
> se retire d'elle-même sur ce test.
>
> **J'avais sauté la troisième puce de mon propre §6.3** (« collecteur OTLP local »), puis généralisé
> depuis une mesure incomplète. C'est la faute de `C03` sous une autre forme : conclure « jamais »
> à partir de « pas dans les deux cas que j'ai essayés ».

**K1 se déclenche donc, et K2 ne se déclenche pas.** La branche « participant passif » est **réelle**
— mais son coût d'activation est **entièrement à la charge de l'opérateur** : deux variables de
télémétrie, un exportateur, un endpoint, et un collecteur qui tourne. Ce n'est pas « lire un en-tête
qui est déjà là ».

Jeu complet des en-têtes **par défaut**, pour mémoire — aucun n'est lié au tracing :

```
accept · accept-encoding · content-type · user-agent
mcp-protocol-version · connection · host · content-length
user-agent: claude-code/2.1.233 (claude-desktop, agent-sdk/0.3.229)
```

#### B. 🔴 SEP-414 : **aucune clé émise**, et c'est une preuve, pas un constat

`params._meta` d'un `tools/call`, par défaut :

```json
{"claudecode/toolUseId":"toolu_01BzmP6m7m3BqeRcwPbQPdqB","progressToken":2}
```

Aucune clé SEP-414. Et la recherche du binaire le confirme : **aucune** des occurrences de
`traceparent` ne se trouve dans une construction `_meta`. **K3 se déclenche**, et le contre-argument
de §6.5 qui présentait SEP-414 comme « le seul morceau réellement portable » est **mort** : ce
morceau n'a aucune implémentation sur le seul client qui compte.

#### C. `claudecode/toolUseId` : redondant **1:1**, pas une opportunité

J'ai d'abord vu dans cette clé une corrélation gratuite. Elle ne vaut rien pour ce projet :

- Sur le chemin HTTP, **un `tools/call` = un `POST /mcp` = un `request_id`**. La clé est donc en
  correspondance **1:1** avec l'identifiant maison déjà présent (`src/serve-http.ts`,
  `resolveRequestId`) et déjà porté par la chaîne d'audit. **Aucun gain de granularité.**
- Elle est **préfixée fournisseur**, non standard, modifiable sans révision de protocole.
- Elle n'est peuplée que pour Claude Code. Cursor, Cline, l'API REST et le SDK n'en produisent
  aucune → **preuve à deux vitesses** dans une chaîne d'audit dont toute la valeur est l'uniformité.
- Coût réel non nul : `CoordinatorEvent` n'a que `id`/`type`/`payload`/`created_at` — l'ajouter
  signifie migration, contrat SSE et dashboard.

#### D. 🔴 Deux bénéfices de §4 sont **factuellement faux**

1. **§4 bénéfice 1** décrit l'existant comme « un identifiant maison, plat, sans parent, qui ne relie
   rien à la session Claude Code émettrice ». **Faux :** `ctx.sessionId` est lu dans **6 fichiers** de
   `src/tools/` et sert précisément à résoudre les claims de l'agent émetteur. La fiche sous-décrit
   l'existant pour gonfler le bénéfice.
2. **§4 bénéfice 2** parle de rendre `POST /api/token-usage` redondant. **Le canal n'a aucun
   producteur** : hors définition et dashboard, **zéro appelant** dans `src/`, `cli/`, `sdk/`,
   `examples/`, `scripts/`. Le dashboard lit des champs que rien dans le dépôt ne produit. On ne
   remplace pas un doublon — on remplacerait un tuyau vide par un tuyau vide plus coûteux.

**K4 ne se déclenche pas** : 8 fichiers exactement, pour un seuil fixé à « plus de 8 ». Mais le
décompte est sans objet, puisqu'il n'y a rien à déprécier.

#### E. K6 se déclenche — et l'observabilité existe déjà

Aucune demande : recherche sur `otel`, `telemetry`, `observability`, `metrics`, `trace` → rien
d'externe. Et le projet livre **déjà** deux registres Prometheus, un dashboard Grafana
(`docs/ops/dashboards/`) et des règles d'alerte (`docs/ops/alerts/`). La seule métrique traçable à un
utilisateur réel est un **compteur** ajouté pour l'issue #236.

Détail qui achève la branche : `docs/ops/single-instance-constraints.md` — le daemon est
**mono-nœud**. Il n'y a pas de système distribué sur lequel distribuer une trace.

#### F. Note de périmètre (et non critère) : les deux APIs Analytics

Comme annoncé en §6.2, elles exigent une clé Admin d'org et une clé Analytics de Primary Owner. Rien
n'a été exécuté sur elles ; elles sortent du périmètre décidable.

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Dépendance à une beta pour la partie la plus intéressante.** La corrélation par trace repose sur `traceparent`, gaté par `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` / `CLAUDE_CODE_PROPAGATE_TRACEPARENT=1`, et les spans sont explicitement beta. Un code de lecture conditionnelle qui ne se déclenche jamais chez l'utilisateur par défaut est du code mort payé au prix fort.
- **Casse la portabilité hors Claude Code.** mcp-coordinator n'est pas un accessoire de Claude Code : il coordonne des agents MCP quelconques. `mcp_server.name`, `agent.name`, `query_source` sont des attributs **Claude Code**. Bâtir la lisibilité du dashboard dessus crée deux qualités de service selon le client, et rend l'expérience Codex/Cursor/agent maison structurellement dégradée. La branche SEP-414 (`_meta`), elle, est neutre côté protocole — c'est le seul morceau réellement portable.
- **Les APIs Analytics sont hors de portée de l'auto-hébergeur.** La Claude Code Analytics API exige une clé Admin d'organisation ; l'Enterprise Analytics API exige un Primary Owner, est indisponible sur Teams, et les deux sont indisponibles sur Bedrock / Foundry / Vertex. Le profil de déploiement dominant du projet (un développeur, quelques agents, une machine) n'a aucune de ces clés. Une fonctionnalité qui ne s'allume que dans une entreprise Enterprise est une fonctionnalité que l'auteur maintient sans jamais s'en servir.
- **Stocker une clé Admin d'organisation dans le daemon est un durcissement de la surface de risque.** Le projet gère déjà chiffrement au repos, IdP, service tokens ; une clé Admin lisant la facturation de toute l'org est une catégorie au-dessus.
- **Empilement d'exportateurs.** Il y a déjà deux registres Prometheus (`src/metrics.ts`, `src/observability/metrics.ts`, servis sur deux routes). Ajouter OTLP sans en retirer un fait trois chemins de sortie à documenter, tester et traduire.
- **YAGNI sur le remplacement de `/api/token-usage`.** Le canal existe, il est trivial (un handler, un schéma permissif, un type d'événement SSE) et il fonctionne pour n'importe quel agent. Le remplacer par une chaîne OTLP + collecteur déporte de la complexité chez l'utilisateur pour un gain d'exactitude dont personne n'a encore fait la demande.
- **Fraîcheur ~1 h.** Les APIs Analytics ne peuvent pas alimenter le dashboard temps réel ; elles ne servent qu'à des rapports différés, ce qui restreint fortement le bénéfice affiché.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** · ⬜ refuser |
| **Date** | 2026-08-16 |
| **Justification** | `traceparent` **arrive bien** sur le chemin MCP (K1) — mais au bout d'une chaîne à **cinq conditions**, toutes à la charge de l'opérateur. Aucune n'est réunie chez un utilisateur du profil de déploiement actuel, et **K6 se déclenche** : aucune demande, alors que deux registres Prometheus, un dashboard Grafana et des règles d'alerte sont **déjà livrés** — pour un daemon **mono-nœud**, donc sans système distribué à tracer. Deux bénéfices de §4 sont par ailleurs **factuellement faux**. |
| **Issue / PR** | aucune |
| **Jalon visé** | aucun |

### Condition de réveil — une seule, nommée

**Le jour où Claude Code émet des clés SEP-414 dans `params._meta`.** C'est le seul déclencheur qui
change la donne, parce que c'est le seul qui rendrait le contexte de trace disponible **sans** exiger
qu'un opérateur monte une chaîne OTLP complète — et le seul qui soit **portable** hors Claude Code.
Aujourd'hui, mesuré : **aucune clé SEP-414 n'est émise**.

Déclencheur secondaire, plus faible : un utilisateur qui exploite déjà OTLP et demande la jointure.
Il n'en existe aucun.

### Ce qui est refusé

**Exploiter `claudecode/toolUseId` comme clé de corrélation.** C'était mon « adopter partiellement »
projeté ; il n'a pas de substance (§6.4-C). La clé est en correspondance **1:1** avec le `request_id`
déjà porté par la chaîne d'audit, elle est préfixée fournisseur, et elle n'est peuplée que pour un
client — ce qui introduirait une **preuve à deux vitesses** dans une chaîne d'audit dont toute la
valeur tient à son uniformité.

**Déprécier `POST /api/token-usage`** n'a pas de sens non plus : le canal **n'a aucun producteur**.
Ce n'est pas un doublon à retirer, c'est un tuyau vide — et le vrai constat, hors périmètre de cette
fiche, est qu'un lecteur dashboard complet fait face à un émetteur inexistant.

### Corrections à porter dans la fiche

- **§4 bénéfice 1 est faux** : `ctx.sessionId` relie déjà chaque appel d'outil à la session MCP
  émettrice, dans 6 fichiers de `src/tools/`.
- **§4 bénéfice 2 est faux** : le canal `token_usage` n'a aucun producteur.
- **§6.5, ligne « dépendance à une beta » : à réécrire.** Le coût réel n'est pas « un flag beta » mais
  **cinq conditions** — `CLAUDE_CODE_ENABLE_TELEMETRY`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`,
  `OTEL_TRACES_EXPORTER=otlp`, un endpoint, et un collecteur vivant.
- **§6.5, ligne SEP-414 : morte.** Le « seul morceau réellement portable » n'a aucune implémentation.
- **§1/§2** : ajouter que `params._meta` porte `claudecode/toolUseId` et `progressToken` par défaut —
  fait absent de la fiche, même si la conclusion est de ne pas s'en servir.

### Note de méthode

**J'allais écrire une affirmation fausse, et la passe adversariale l'a arrêtée.** Après deux mesures
négatives, j'étais prêt à conclure que `traceparent` « n'arrive jamais, même avec la télémétrie
activée ». Le binaire dit le contraire : l'injection existe dans le chemin MCP, et c'est un maillon
en aval qui manquait. **J'avais sauté la troisième puce de mon propre §6.3** — le collecteur OTLP —
puis généralisé depuis une mesure incomplète.

C'est la même faute qu'en `C03`, sous une autre forme : conclure « jamais » à partir de « pas dans
les deux configurations que j'ai essayées ». La parade n'est pas de mesurer plus, c'est de **dérouler
le protocole que j'ai moi-même écrit avant de conclure**.

Bonne nouvelle méthodologique en revanche : le critère K5 avait été explicitement marqué **note de
périmètre** dès §6.2, en application de la leçon de `C10`. Il n'a donc pas été présenté comme un
résultat.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : noms OTel exacts, §5 exact ; corrigés traceparent conditionnel, query_source, champs et URL Analytics. |
| 2026-08-16 | **Challenge — verdict `reporter`.** Mesuré sur un serveur MCP espion : `traceparent` **arrive bien** sur le chemin MCP, mais seulement au bout de **cinq conditions** (`ENABLE_TELEMETRY` + `ENHANCED_TELEMETRY_BETA` + `OTEL_TRACES_EXPORTER=otlp` + endpoint + collecteur vivant) — sans exportateur, aucun trace provider n'est installé, le `traceId` vaut 32 zéros et l'injection se retire. **J'allais écrire « n'arrive jamais » après deux mesures négatives ; c'était faux**, la passe adversariale l'a arrêté — j'avais sauté la 3e puce de mon propre §6.3. **Aucune clé SEP-414 n'est émise** (preuve, pas constat) : la ligne de §6.5 qui en faisait « le seul morceau portable » est morte. `params._meta` porte en revanche `claudecode/toolUseId` + `progressToken` par défaut — **refusé** : correspondance 1:1 avec le `request_id` existant, clé préfixée fournisseur, et preuve à deux vitesses dans la chaîne d'audit. **Deux bénéfices de §4 sont factuellement faux** : `ctx.sessionId` relie déjà l'appel à la session émettrice (6 fichiers de `src/tools/`), et `POST /api/token-usage` **n'a aucun producteur**. K6 déclenché : deux registres Prometheus, un dashboard Grafana et des alertes sont déjà livrés, pour un daemon mono-nœud. |
