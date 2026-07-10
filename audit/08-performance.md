# Audit — Performance & scalabilité

- **Projet** : mcp-coordinator v0.13.0 (broker MQTT embarqué + serveur MCP pour coordination multi-agents)
- **Date de l'audit** : 2026-07-03
- **Score** : **7 / 10**
- **Verdict global** : un vrai travail de performance délibéré pour un process Node unique, mais un plafond de scalabilité concret — l'absence de rétention sur les tables Phase 1 couplée à l'API synchrone de better-sqlite3 — dégradera de façon mesurable tout coordinateur laissé tourner plusieurs semaines avec des agents actifs.

---

## 1. Résumé exécutif

Le code témoigne d'une attention réelle et documentée à la performance dans les contraintes d'un process Node unique : pragmas SQLite corrects dès l'ouverture (WAL, `busy_timeout`, clés étrangères), index composites alignés sur les requêtes chaudes, scorer d'impact explicitement optimisé (requêtes batchées, fenêtres temporelles SQL), file d'audit bornée avec flush transactionnel, sweeper de rétention avec `DELETE ... LIMIT` et circuit-breaker, et des bornes anti-emballement posées partout où c'est bon marché (cap SSE, body HTTP 1 Mo, LRU bornés). Les benchmarks relancés lors de l'audit confirment les hypothèses de conception (`readTokenEpoch` ≈ 54 000 ops/s, p50 15 µs).

Le principal plafond de scalabilité est **l'absence totale de rétention sur les tables Phase 1** (`file_activity`, `events`, `thread_messages`, `action_summaries`, `layer_firings`), combinée à des endpoints **pollés** qui les scannent intégralement. Mesures reproduites : **~130 ms par appel `getHotFiles` à 500 K lignes** (pollé toutes les 5 s par le dashboard) et **~655 ms de blocage d'event loop par connexion SSE à 200 K events**. Le tout s'exécute sur l'API **synchrone** de better-sqlite3 : HTTP, MQTT (aedes) et SSE partagent le même processus et gèlent pendant chaque requête.

S'y ajoutent plusieurs structures mémoire non bornées (queues `MqttBridge` jamais nettoyées, buckets `RateLimiter` jamais balayés, sessions MCP jamais expirées, absence de backpressure sur le pont WebSocket) et une cardinalité Prometheus illimitée via l'usage des URLs brutes comme labels de métrique.

**Rien de critique aujourd'hui** pour un déploiement early-adopter mono-tenant, mais un coordinateur longue durée avec des agents actifs se dégradera de façon mesurable. La bonne nouvelle : la majorité des correctifs sont des efforts S, et le mécanisme de sweeper à étendre existe déjà.

---

## 2. Points forts

| # | Point fort |
|---|-----------|
| 1 | **Pragmas SQLite corrects dès l'ouverture** (WAL, `busy_timeout=5000`, `foreign_keys=ON` — `src/database.ts:340-342`), vérifiés par la commande `doctor` du CLI. |
| 2 | **Index composites alignés sur les requêtes chaudes** et posés par migrations : `file_activity(org_id, file_path, created_at)`, `events(org_id, id)`, `threads(org_id, status)`, `audit_log(action, created_at)`. |
| 3 | **`ImpactScorer` explicitement optimisé** (commentaires O1/O2/O3) : cache de `JSON.parse` par agent, index fichier→agents batché en 1 requête au lieu de N, fenêtre de récence SQL sur les threads résolus — le chemin `announce_work` est O(agents) et non O(historique). |
| 4 | **`AuditQueue` bornée** (10 000) avec flush par lots de 50 dans une transaction, comptage des drops, drain SIGTERM avec ligne d'audit de perte ; **sweeper de rétention auth** avec `DELETE LIMIT 1000`, chaînage plafonné à 3 et circuit-breaker après 5 échecs. |
| 5 | **Bornes anti-emballement partout où c'est bon marché** : cap 100 clients SSE + fanout via `setImmediate` + heartbeat `unref()`, body HTTP 1 Mo configurable, contenu tree-sitter 256 Ko / 200 symboles max, LRU memberships borné (10 K + TTL), quota cache single-flight avec cooldown 429. |
| 6 | **Suite perf/chaos dédiée** (`tests/perf/`) avec sorties `JSON_SUMMARY` parsables et doc d'interprétation ; bench token-epoch relancé : 54 500 ops/s, p50 14,8 µs — valide la décision de ne pas cacher `token_epoch` ; refresh-rotation : 471 ops/s, p50 1,36 ms. |
| 7 | **`GitCochangeBuilder` hors event loop** (spawn async) avec timeout 5 s, cap 2 000 commits, skip des commits > 200 fichiers et denylist des lockfiles/dist. |
| 8 | **Probes `/livez` `/readyz` très bon marché** (`SELECT 1`) et transactions better-sqlite3 utilisées aux bons endroits (announce, approbation consensus, `checkTimeouts`) pour éviter les courses sans coût async. |

---

## 3. Constats détaillés

Aucun constat critique. 1 high, 5 medium, 3 low, 2 info. Aucun constat n'a été réfuté par la contre-vérification adversariale.

### Sévérité HIGH

#### performance-01 — Aucune rétention sur les tables Phase 1 (`file_activity`, `events`, `thread_messages`, `action_summaries`, `layer_firings`) : dégradation mesurée sur endpoints pollés

- **Sévérité** : High — **Statut** : ✅ confirmé (contre-vérifié point par point, benchmark reproduit)
- **Fichier** : `src/sweeper/index.ts:10`
- **Effort** : M

**Preuve.** Le sweeper (`src/sweeper/index.ts:10-20`, `sweepAll` lignes 126-206) ne couvre que 6 tables auth (`oauth_state`, `device_auth_requests`, `refresh_tokens` ×2, `audit_log` ×2). `file_activity` reçoit 1 ligne par édition de fichier de chaque agent (`src/file-tracker.ts:17`), `events` 1 ligne par événement SSE (`src/sse-emitter.ts:48`), dont un `impact_scored` **par agent en ligne** à chaque announce (`src/announce-workflow.ts:107`). Le seul `DELETE` sur ces tables dans `src/` est `/api/reset` (`src/http/handle-rest.ts:364-368`), et `layer_firings` n'est purgé nulle part. Mesuré : `getHotFiles` ≈ 130 ms/appel à 500 K lignes — endpoint pollé toutes les 5 s par le dashboard (`dashboard/public/index.html:908` → `handle-rest.ts:260`) et appelé aussi par les outils MCP (`src/tools/status-tools.ts:30`, `files-tools.ts:24`).

**Explication.** better-sqlite3 est synchrone : chaque appel `getHotFiles` (`src/file-tracker.ts:41-57`) bloque intégralement l'event loop (HTTP, MQTT/aedes, SSE) pendant toute sa durée. La requête `GROUP BY file_path` scanne tout l'index de l'org quelle que soit la fenêtre de 30 min — `EXPLAIN QUERY PLAN` montre que l'index `idx_file_activity_org_path_time` n'est utilisé que sur le préfixe `org_id`, donc le coût croît linéairement avec un historique jamais purgé. La contre-vérification indépendante (better-sqlite3 du projet, schéma et index exacts, 500 K lignes) reproduit le chiffre : **médiane 109,6 ms/appel** (min 98,9, max 127,0) contre 2,1 ms à 5 K lignes. À raison de quelques milliers d'éditions par jour de swarm actif, on atteint 500 K lignes en quelques semaines : des pics de latence visibles sur les publications MQTT et les requêtes MCP à chaque poll. **C'est le plafond de scalabilité concret n° 1 du projet.** Aucune mitigation en place : pas de LIMIT temporel exploitable par l'index, pas de cache, pas de rétention configurée.

**Recommandation.** Étendre le Sweeper existant (le mécanisme `DELETE ... LIMIT` + circuit-breaker est déjà là) aux 5 tables Phase 1 avec des rétentions par défaut courtes (ex. `file_activity`/`events` 7 j, `thread_messages`/`action_summaries`/`layer_firings` 30 j), configurables via `getOrgSetting` comme les autres. Ajouter un index `file_activity(org_id, created_at)` pour que le DELETE et `getHotFiles` profitent d'une plage bornée.

---

### Sévérité MEDIUM

#### performance-02 — Connexion SSE sans Last-Event-ID : chargement de TOUT l'historique events en mémoire (655 ms mesurés à 200 K lignes)

- **Sévérité** : Medium — **Statut** : ⚠️ non contre-vérifié (mesures directes de l'auditeur)
- **Fichier** : `src/serve-http.ts:264`
- **Effort** : S

**Preuve.** `services.sseEmitter.getEventsSince(orgId, 0).slice(-50)` — `getEventsSince` exécute `SELECT * FROM events WHERE org_id = ? AND id > ? ORDER BY id` (`src/sse-emitter.ts:79`), puis le JS ne conserve que les 50 dernières lignes.

**Explication.** Chaque ouverture du dashboard (ou reconnexion SSE sans `Last-Event-ID`) matérialise **toutes** les lignes `events` de l'org en objets JS pour n'en garder que 50. Mesuré : 26 ms à 20 K events, 381 ms à 100 K, **655 ms à 200 K** — blocage synchrone de l'event loop à chaque chargement de page, aggravé par l'absence de rétention (performance-01). Le chemin de reprise avec `Last-Event-ID` est, lui, parfaitement indexé (0,08 ms).

**Recommandation.** Remplacer par `SELECT * FROM events WHERE org_id = ? ORDER BY id DESC LIMIT 50` puis inverser le tableau. Une ligne à changer dans `SseEmitter` (ajouter un paramètre `limit`) — l'index `(org_id, id)` existe déjà.

#### performance-03 — Cardinalité Prometheus non bornée : l'URL brute (avec UUIDs et chemins 404 arbitraires) sert de label de métrique

- **Sévérité** : Medium — **Statut** : ⚠️ non contre-vérifié
- **Fichier** : `src/serve-http.ts:589`
- **Effort** : S

**Preuve.** `services.metrics.recordHttpRequest((url.split("?")[0] || ""), res.statusCode || 0)` — idem ligne 592 pour les 404. Or les routes REST incluent des IDs : `/api/consultation/<uuid>/status` et `/api/agent-status/<id>` (`src/http/handle-rest.ts:239,402`).

**Explication.** prom-client conserve une série par valeur de label distincte, sans éviction. Chaque thread consulté crée une série permanente ; chaque URL 404 inédite aussi (sous `AUTH_ENABLED=false`, n'importe quel client anonyme peut en générer à volonté). Résultat : croissance mémoire du Registry non bornée et payload `/metrics` de plus en plus lourd à scraper — le rendu `registry.metrics()` est refait à chaque scrape.

**Recommandation.** Normaliser la route avant incrémentation : remplacer les segments dynamiques par un motif (`/api/consultation/:id/status`, `/api/agent-status/:id`) et regrouper tout chemin inconnu sous un label unique `unmatched`. Une petite fonction `routeLabel(url)` suffit.

#### performance-04 — Pont WebSocket→MQTT sans backpressure ni maxPayload : un consommateur WS lent fait croître la mémoire sans borne

- **Sévérité** : Medium — **Statut** : ⚠️ non contre-vérifié
- **Fichier** : `src/mqtt-broker.ts:16`
- **Effort** : M

**Preuve.** `write(chunk, _encoding, callback) { ws.send(chunk); callback(); }` — le callback est acké immédiatement sans consulter `ws.bufferedAmount` ; `ws.on("message", (data) => duplex.push(data))` ignore la valeur de retour de `push()`. `new WebSocketServer({ noServer: true })` (ligne 183) sans `maxPayload` (défaut ws : 100 MiB).

**Explication.** Côté sortie : aedes croit que chaque paquet est écrit et continue d'alimenter le stream ; les octets s'accumulent dans le buffer interne de ws pour tout abonné lent ou gelé (dashboard sur machine en veille, lien réseau saturé). Côté entrée : aucun signal de pause vers le client. De plus, l'absence de `maxPayload` autorise des trames de 100 MiB par connexion WS. À l'échelle actuelle (agents locaux, messages JSON de quelques Ko) le risque est faible, mais c'est le mécanisme classique d'OOM d'un broker embarqué.

**Recommandation.** Dans `wsToDuplex` : différer le callback quand `ws.bufferedAmount` dépasse un seuil (ex. 1 Mo) via le callback de `ws.send(data, cb)`, et couper la connexion au-delà d'un plafond dur (ex. 8 Mo). Passer `maxPayload: 1 << 20` au `WebSocketServer` — les payloads MQTT du coordinateur font quelques Ko.

#### performance-05 — Queues de listeners MqttBridge jamais nettoyées ni bornées : fuite mémoire par agent disparu

- **Sévérité** : Medium — **Statut** : ⚠️ non contre-vérifié
- **Fichier** : `src/mqtt-bridge.ts:100`
- **Effort** : S

**Preuve.** `listener.queue.push(msg)` sans borne, dupliqué dans **chaque** listener enregistré (boucle ligne 94). `registerListener` est appelé par `waitForMessage`/`getQueuedMessages` (tools MCP, `src/tools/mqtt-tools.ts:32,44`) mais `removeListener` n'a **aucun appelant** dans `src/`.

**Explication.** Dès qu'un agent appelle une fois `wait_for_message` ou `get_queued_messages`, un listener permanent est créé ; chaque message consultations/broadcast ultérieur est empilé dans sa queue. Un agent qui se déconnecte définitivement laisse une queue qui grossit au rythme du trafic MQTT de tout le swarm, indéfiniment. Avec N agents historiques, chaque message est retenu N fois.

**Recommandation.** Borner la queue (ex. 1 000 messages, drop du plus ancien + compteur) et appeler `mqttBridge.removeListener(agentId)` depuis le handler `onOffline` existant (`serve-http.ts:639`) qui nettoie déjà registry/consultation/workingFiles.

#### performance-06 — RateLimiter.sweep() n'est jamais appelé : la Map de buckets croît sans borne (clés par IP sur endpoints non authentifiés)

- **Sévérité** : Medium — **Statut** : ⚠️ non contre-vérifié
- **Fichier** : `src/auth/rate-limit.ts:120`
- **Effort** : S

**Preuve.** Le commentaire dit « T28 sweeper wires it to the 60s tick » mais le Sweeper (`src/boot.ts:309`) ne reçoit que `(db, clock)` et ne référence jamais `rateLimiter` ; un grep sur `src/` ne trouve aucun appel à `.sweep()`.

**Explication.** Chaque clé distincte (`device-auth-min:${ip}`, `auth-login:${ip}`, `userinfo:${user_id}`…) crée une entrée `BucketState` jamais évincée. Sur un déploiement OAuth exposé publiquement, un scan d'IPs (ou simplement le churn NAT) fait croître la Map indéfiniment — fuite lente mais certaine sur un process longue durée. Ne concerne que `COORDINATOR_OAUTH_ENABLED=true`.

**Recommandation.** Passer le `RateLimiter` au Sweeper (ou un `setInterval` `unref()` de 60 s dans `boot.ts`) et appeler `sweep()` à chaque tick — la méthode existe et est testée, il ne manque que le câblage.

---

### Sévérité LOW / INFO

#### performance-07 — Sessions MCP StreamableHTTP jamais expirées : transports + McpServer accumulés au fil du churn de clients (Low)

- **Statut** : ⚠️ non contre-vérifié — **Fichier** : `src/serve-http.ts:409` — **Effort** : M

**Preuve.** `const sessions = new Map<string, StreamableHTTPServerTransport>()` + `sessionClaims` ; seule éviction : `transport.onclose` (ligne 555), qui suppose que le client termine proprement sa session (`DELETE /mcp`).

**Explication.** Un agent qui crashe ou disparaît sans clore sa session laisse en mémoire un `StreamableHTTPServerTransport` et un `McpServer` complet (23 tools enregistrés) pour toujours. Avec des agents Claude Code relancés fréquemment (nouveau session-id à chaque run), la Map croît de façon monotone. Impact modéré à l'échelle actuelle (quelques dizaines de Ko par session), mais c'est une fuite structurelle sur un serveur longue durée.

**Recommandation.** Ajouter un horodatage last-seen par session (mis à jour à chaque `handleRequest`) et un balayage périodique `unref()` qui `close()` les transports inactifs depuis plus de N heures (ex. 24 h).

#### performance-08 — bench-audit-queue.ts cassé (dérive de schéma) : la suite perf a rouillé et n'est exécutée nulle part (Low)

- **Statut** : ⚠️ non contre-vérifié (mais échec reproduit à l'exécution) — **Fichier** : `tests/perf/bench-audit-queue.ts:26` — **Effort** : S

**Preuve.** Exécution réelle : « `SqliteError: table audit_log has no column named prev_hash` » — l'`AUDIT_SCHEMA` embarqué du bench date d'avant la chaîne de hachage T50 (v0.9.1), alors qu'`AuditQueue` prépare l'INSERT avec `prev_hash`/`row_hash` (`src/security/audit-queue.ts:61`).

**Explication.** Le bench principal du chemin d'écriture le plus chaud (file d'audit Tier 2) ne se lance plus, ce qui prouve que la suite perf n'a pas tourné depuis au moins la v0.9.1. Les chiffres de référence de `docs/ops/perf-bench.md` sont donc antérieurs à l'ajout du calcul SHA-256 par ligne dans `writeBatchSync` — le coût réel actuel de la file est inconnu.

**Recommandation.** Ajouter les colonnes `prev_hash`/`row_hash` au schéma du bench (2 lignes), puis ajouter un smoke-run des 3 benchs (avec N réduits via les variables `BENCH_*`) dans le workflow CI hebdomadaire ou en job manuel, pour détecter la dérive de schéma.

#### performance-09 — Sweep audit_log sur expression non indexable `strftime('%s', created_at)` : scan des lignes à chaque tick de 60 s (Low)

- **Statut** : ⚠️ non contre-vérifié — **Fichier** : `src/sweeper/index.ts:188` — **Effort** : S

**Preuve.** `DELETE FROM audit_log WHERE strftime('%s', created_at) < ? AND action IN (...) LIMIT ?` ×2 par tick — l'expression sur `created_at` empêche d'utiliser la partie `created_at` de l'index `idx_audit_action(action, created_at)`.

**Explication.** SQLite peut restreindre par `action` via l'index, mais doit évaluer `strftime` sur chaque ligne candidate de ces actions à chaque tick. Avec une rétention Tier 1 de 365 j et un déploiement OAuth actif, `audit_log` atteint facilement des centaines de milliers de lignes : deux scans partiels par minute, en synchrone sur l'event loop. `created_at` est du texte ISO-8601 UTC (`CURRENT_TIMESTAMP`) qui se compare lexicographiquement — la conversion est inutile.

**Recommandation.** Comparer directement `created_at < ?` en liant le cutoff au format `'YYYY-MM-DD HH:MM:SS'` (dérivé de l'epoch), ce qui rend l'index `(action, created_at)` pleinement exploitable en plage. Garder un test qui vérifie l'équivalence des deux prédicats.

#### performance-10 — PRAGMA synchronous laissé à FULL en mode WAL : un fsync par écriture autonome sur les chemins chauds (Info)

- **Statut** : ⚠️ non contre-vérifié — **Fichier** : `src/database.ts:340` — **Effort** : S

**Preuve.** `raw.pragma("journal_mode = WAL"); raw.pragma("busy_timeout = 5000"); raw.pragma("foreign_keys = ON");` — pas de réglage `synchronous` (défaut SQLite : FULL).

**Explication.** En WAL, `synchronous=NORMAL` est le réglage recommandé : il ne fsync qu'au checkpoint tout en garantissant l'intégrité (seule la durabilité des toutes dernières transactions est perdue sur coupure courant). Beaucoup d'écritures chaudes du coordinateur sont des `.run()` autonomes (`file_activity`, `events`, `agent_activity_status` : 3 commits/fsyncs par `/api/log-file`), chacune payant un fsync WAL sous FULL.

**Recommandation.** Ajouter `pragma("synchronous = NORMAL")` à l'ouverture (et l'assertion correspondante dans `cli/doctor.ts`). Gain de latence d'écriture quasi gratuit pour un log de coordination où perdre < 1 s d'événements sur coupure courant est acceptable.

#### performance-11 — Layer 4 du scorer : requêtes SQL par (fichier cible × agent) dans la boucle d'announce (Info)

- **Statut** : ⚠️ non contre-vérifié — **Fichier** : `src/impact-scorer.ts:211` — **Effort** : S

**Preuve.** `for (const targetFile of params.target_files) { const layer4Results = this._layer4Score(params.org_id, targetFile, agent.id); ... }` dans le `.map()` sur `onlineAgents` — `_layer4Score` fait 1 requête `git_cochange` + jusqu'à 1 requête `file_activity` par paire trouvée.

**Explication.** Contrairement aux layers 0-2 qui ont été batchés (O1/O3), le layer 4 reste O(agents × fichiers) allers-retours SQL par `announce_work`. Avec 20 agents × 10 fichiers = 200+ requêtes point (indexées, ~10-20 µs chacune) — négligeable aujourd'hui, mais c'est la prochaine marche si les swarms grossissent, et la requête `git_cochange` par fichier est répétée à l'identique pour chaque agent.

**Recommandation.** Au minimum, hisser la requête `git_cochange` hors de la boucle agents (elle ne dépend que du fichier) et la mémoïser par `targetFile` au sein d'un appel `score()`. Batching complet façon `getFileToAgentsIndex` seulement si les mesures le justifient (YAGNI).

---

## 4. Recommandations priorisées

### Quick wins (effort S)

| Priorité | Constat | Action | Gain |
|---|---|---|---|
| 1 | performance-02 | `ORDER BY id DESC LIMIT 50` dans `SseEmitter.getEventsSince` (paramètre `limit`) | Supprime jusqu'à 655 ms de gel par ouverture de dashboard ; une ligne |
| 2 | performance-05 | Borner les queues MqttBridge (1 000 msg) + appeler `removeListener` depuis `onOffline` | Ferme une fuite mémoire proportionnelle au trafic × agents historiques |
| 3 | performance-06 | Câbler `RateLimiter.sweep()` sur le tick 60 s (méthode existante, testée) | Ferme la fuite de buckets sur déploiement OAuth exposé |
| 4 | performance-03 | Fonction `routeLabel(url)` : segments dynamiques → motif, chemins inconnus → `unmatched` | Borne la cardinalité Prometheus et le poids de `/metrics` |
| 5 | performance-09 | Prédicat `created_at < ?` (texte ISO) au lieu de `strftime` dans le sweep audit | Rend l'index `(action, created_at)` exploitable en plage, supprime 2 scans/min |
| 6 | performance-10 | `pragma("synchronous = NORMAL")` + assertion `doctor` | ~3 fsyncs économisés par `/api/log-file`, quasi gratuit |
| 7 | performance-08 | Réparer le schéma de `bench-audit-queue.ts` + smoke-run CI des 3 benchs | Restaure la capacité à mesurer le chemin d'écriture le plus chaud |
| 8 | performance-11 | Mémoïser `git_cochange` par `targetFile` dans `score()` | Prépare la montée en agents sans sur-ingénierie |

### Chantiers moyens (effort M)

| Priorité | Constat | Action | Gain |
|---|---|---|---|
| 1 | **performance-01** (high) | Étendre le Sweeper aux 5 tables Phase 1 (rétentions configurables via `getOrgSetting`) + index `file_activity(org_id, created_at)` | Lève le plafond de scalabilité n° 1 : `getHotFiles` repasse de ~130 ms à quelques ms, et le reste durablement |
| 2 | performance-04 | Backpressure `bufferedAmount` dans `wsToDuplex` + plafond dur + `maxPayload: 1 << 20` | Élimine le mécanisme classique d'OOM d'un broker embarqué |
| 3 | performance-07 | TTL last-seen + balayage des sessions MCP inactives (ex. 24 h) | Ferme la fuite structurelle liée au churn d'agents Claude Code |

**Ordre suggéré** : traiter performance-01 en premier — c'est le seul high, il est confirmé, et il conditionne l'ampleur de performance-02 et performance-09. Puis dérouler les quick wins S. Aucun chantier L n'est nécessaire : tous les correctifs s'appuient sur des mécanismes déjà présents dans le code (Sweeper, handler `onOffline`, ticks périodiques).

---

## 5. Annexe — Constats écartés après contre-vérification

**Aucun constat n'a été réfuté (REFUTED)** lors de la passe de contre-vérification adversariale ; il n'y a donc rien à écarter.

Pour transparence : le seul constat de sévérité high (performance-01) a été **confirmé point par point** — absence des 5 tables dans le sweeper vérifiée dans le code, chemins d'insertion tracés, `EXPLAIN QUERY PLAN` confirmant le scan linéaire malgré la fenêtre de 30 min, et benchmark reproduit indépendamment (médiane 109,6 ms/appel à 500 K lignes contre 2,1 ms à 5 K, avec le better-sqlite3, le schéma et les index exacts du projet). La sévérité high a été jugée correctement calibrée : dégradation progressive de performance sans perte de données ni faille, mais plafond de scalabilité réel atteignable en quelques semaines de swarm actif. Les constats medium et moins n'ont pas fait l'objet d'une contre-vérification et sont signalés comme tels (⚠️) dans le corps du rapport.
