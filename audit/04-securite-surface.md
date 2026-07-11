# Audit — Sécurité : surface d'attaque

- **Projet** : mcp-coordinator v0.13.0 (embedded MQTT broker + MCP server for multi-agent coordination)
- **Date de l'audit** : 2026-07-03
- **Score** : **7 / 10**
- **Verdict global** : Fondations sécurité solides et manifestement réfléchies (SQL paramétré, anti-path-traversal, JWT épinglé, ACL MQTT), mais ternies par deux contrôles de sécurité « fantômes » — dont un bind réseau qui expose toute la surface sur le LAN en contradiction directe avec la documentation.

---

## 1. Résumé exécutif

La surface d'attaque de mcp-coordinator repose sur des fondations visiblement pensées pour la sécurité : requêtes SQL entièrement paramétrées (les rares identifiants dynamiques sont validés contre une allowlist ou le schéma), défense anti-path-traversal robuste (`safeJoinUnderRoot` : décodage percent, rejet des octets nuls, vérification stricte de confinement), JWT en HS256 épinglé (pas de confusion d'algorithme possible), ACL MQTT par organisation avec déconnexion sur violation quand l'authentification est active, broker MQTT TCP borné au loopback, plafonds anti-DoS (corps 1 Mo, body admin 4 Ko, rate-limit sur les mutations admin), et endpoints admin protégés par auth + rôle + CSRF double-submit. Aucune injection SQL, injection de commande ni zip-slip exploitable n'a été identifiée.

Le problème principal est un **contrôle de sécurité fantôme de sévérité haute** : le serveur HTTP écoute sur toutes les interfaces alors que la variable `COORDINATOR_BIND` (défaut documenté : 127.0.0.1) **n'est jamais lue par le code**. Combiné au défaut `AUTH_ENABLED=false` (qui injecte des claims admin synthétiques), toute la surface — MCP, REST, SSE, dashboard, MQTT-over-WS — est joignable sans authentification par n'importe quel hôte du réseau local, en contradiction directe avec la promesse « sûr par défaut » de la documentation.

S'y ajoutent : un `/metrics` non authentifié doublé d'un handler protégé jamais câblé (second contrôle fantôme), une isolation inter-agents absente sur les outils MCP MQTT (un agent peut drainer la file d'un autre), une absence de redaction sur le logger Phase 1, un `/api/auth/register` sans rate-limiting, un CORS wildcard, et des en-têtes de sécurité manquants hors pages admin.

**Posture globale : solide, avec des lacunes de durcissement ciblées — la plupart corrigeables en effort S.**

---

## 2. Points forts

| # | Point fort |
|---|-----------|
| 1 | **SQL entièrement paramétré** sur tout le routeur REST et les modules DB ; les deux seuls identifiants dynamiques (`UPDATE orgs`, `getOrgSetting`) sont construits depuis une allowlist de colonnes / le schéma et validés par regex — aucune injection SQL. |
| 2 | **Anti-path-traversal exemplaire** (`src/path-guard.ts`, `safeJoinUnderRoot`) : décodage du percent-encoding, rejet des octets nuls, strip des slashs de tête, résolution puis vérification stricte de confinement sous la racine avec séparateur. |
| 3 | **JWT robuste** : HS256 épinglé (`algorithms: ["HS256"]` partout, pas d'`alg=none`), routes admin-only gérées (`ADMIN_ONLY_ROUTES`), liste de révocation vérifiée à chaque requête, comparaison à temps constant (`timingSafeEqual`) des secrets d'enregistrement. |
| 4 | **Isolation MQTT par org quand l'auth est active** : `authenticate` par CONNECT (JWT en password), `authorizeSubscribe` refuse les topics hors `coordinator/<org>/`, `authorizePublish` déconnecte le client sur tentative cross-org ; broker TCP borné explicitement à 127.0.0.1. |
| 5 | **Protections anti-DoS présentes** : `parseBody` plafonne le corps à 1 Mo (413), lecture de body admin bornée à 4 Ko, plafond de 256 Ko sur file-activity, rate-limit par IP sur les mutations admin appliqué **avant** l'auth. |
| 6 | **Endpoints admin correctement verrouillés** : `requireAdmin` (auth + rôle admin) + CSRF double-submit sur les mutations, validation stricte (rejet des octets de contrôle, longueur, champs inconnus) et messages d'erreur qui n'échoent jamais l'entrée utilisateur. |
| 7 | **Aucune injection de commande** : git via `spawn("git", args[])` sans shell avec arguments constants/numériques, credentials via `execFile` sans shell ; extraction tar via node-tar (assainissement des chemins par défaut) sur une commande CLI locale. |
| 8 | **Observabilité et gouvernance sécurité matures pour le stade du projet** : logger Phase 2 avec redaction de 17 chemins sensibles (authorization, cookie, access_token, refresh_token, client_secret, code_verifier…), chaîne d'audit hash-chainée, politique de divulgation coordonnée et modèle de menace STRIDE documentés (`SECURITY.md`, `docs/security/threat-model.md`). |

---

## 3. Constats détaillés

### Sévérité HIGH

#### securite-surface-01 — Le serveur HTTP écoute sur toutes les interfaces ; `COORDINATOR_BIND` (défaut documenté 127.0.0.1) n'est jamais lu

- **Sévérité** : High — **Statut** : ✅ Confirmé (contre-vérification adversariale)
- **Localisation** : `src/serve-http.ts:660`
- **Effort** : S

**Preuve.** `httpServer.listen(port, () => { ... })` — aucun argument host. Or `.env.example:250` annonce : « *Bind address (default 127.0.0.1). Use 0.0.0.0 to expose on LAN.* » et `docker-compose.yml:35` positionne `COORDINATOR_BIND: "0.0.0.0"`. Un grep du dépôt entier confirme : **zéro occurrence de `COORDINATOR_BIND` dans `src/` ou `cli/`** — la variable n'apparaît que dans `.env.example`, `docker-compose.yml`, `docs/` et un test (`dockerfile-validation.test.ts`) qui vérifie le texte du compose, pas le comportement.

**Explication.** `listen(port)` sans hôte fait binder Node sur l'adresse non spécifiée (`::` / `0.0.0.0`), donc sur toutes les interfaces réseau. Un opérateur qui définit `COORDINATOR_BIND=127.0.0.1` en croyant restreindre l'accès au loopback reste en réalité exposé sur le LAN. Combiné au défaut `AUTH_ENABLED=false` (`serve-http.ts:54` : activé uniquement si `COORDINATOR_AUTH_ENABLED === "true"`), pour lequel `auth.ts:418-429` injecte des claims synthétiques `role: "admin"` sur toute requête sans Bearer, **toute la surface** (MCP `/mcp`, REST `/api/*`, SSE `/api/events`, dashboard, MQTT-over-WS `/mqtt`) est joignable en admin, sans authentification, par n'importe quel hôte du réseau local. C'est un contrôle de sécurité fantôme qui contredit directement le comportement « sûr par défaut » documenté.

La contre-vérification n'a trouvé **aucune mitigation compensatoire** : pas de validation Host/Origin dans `serve-http.ts` — au contraire, `Access-Control-Allow-Origin: *` est posé sur les réponses (lignes 238, 255, 423, 501), ce qui facilite aussi le cross-origin/DNS-rebinding. L'incohérence est d'autant plus visible que le broker MQTT TCP, lui, binde correctement 127.0.0.1 (`mqtt-broker.ts:164`). Sévérité High (pas Critical) : pas d'exposition Internet par défaut, exploitation limitée au réseau local, profil early-adopters.

**Recommandation.** Lire `COORDINATOR_BIND` (défaut `127.0.0.1`) et le passer en deuxième argument : `httpServer.listen(port, host, cb)`. Aligner la valeur par défaut sur ce que promet `.env.example`. Ajouter un test vérifiant que `listen` reçoit bien l'hôte. Correctif d'une ligne à fort impact.

---

### Sévérité MEDIUM

#### securite-surface-02 — `/metrics` servi sans authentification ; le handler `/metrics/auth` (localhost + bearer) est du code mort

- **Sévérité** : Medium — **Statut** : ⚠️ Non contre-vérifié
- **Localisation** : `src/serve-http.ts:521`
- **Effort** : S

**Preuve.** `serve-http.ts:521-522` : `else if (url === "/metrics" ...) await serveMetrics(...)` — `serveMetrics` (`src/metrics.ts:266`) n'effectue aucun contrôle d'accès. `src/http/metrics.ts:61` (`handleMetrics`) implémente pourtant localhostOnly + bearer en comparaison timing-safe, mais un grep confirme qu'il n'est câblé nulle part. `.env.example:138` : « *Bearer token for /metrics/auth. If unset, /metrics/auth is reachable only from localhost.* »

**Explication.** Le endpoint Prometheus réellement routé n'a ni restriction loopback ni token : il expose les compteurs opérationnels (agents en ligne, threads ouverts, requêtes HTTP par route/statut, rejets d'auth, publications MQTT) à quiconque atteint le port. Le handler correctement protégé (allowlist loopback 127.0.0.0/8, comparaison constante) existe mais est du code mort, et `COORDINATOR_METRICS_BEARER` n'est lu par aucun fichier de `src/`. C'est un **second contrôle fantôme** : la documentation promet un `/metrics/auth` localhost-only alors que le `/metrics` exposé est ouvert. Impact amplifié par le constat -01 (bind toutes interfaces). Fuite d'information opérationnelle, pas de secrets.

**Recommandation.** Câbler `handleMetrics` sur `/metrics` (ou sur `/metrics/auth` en supprimant l'ancien `/metrics` non protégé), lire `COORDINATOR_METRICS_BEARER` au boot et le passer en option, conserver `localhostOnly=true` par défaut. Supprimer le code mort si `/metrics/auth` n'est pas conservé.

#### securite-surface-03 — Isolation inter-agents absente sur les outils MCP MQTT (lecture/drainage de la file d'un autre agent)

- **Sévérité** : Medium — **Statut** : ⚠️ Non contre-vérifié
- **Localisation** : `src/tools/mqtt-tools.ts:39`
- **Effort** : M

**Preuve.** `get_queued_messages` / `wait_for_message` prennent `agent_id: z.string()` en argument et appellent `mqttBridge.getQueuedMessages(agent_id)` / `waitForMessage(agent_id)` sans confronter `agent_id` aux claims. `mqtt-bridge.ts:270` : `getQueuedMessages(agentId)` renvoie **et vide** la file de cet agentId. Le commentaire `mqtt-tools.ts:12-16` reconnaît que le bridge est « keyed by agent_id, not by org ».

**Explication.** Un agent authentifié peut passer l'`agent_id` d'un autre agent et drainer (les messages sont retirés après lecture) les messages MQTT de consultation destinés à cet autre agent. Aucun rattachement entre l'`agent_id` fourni en argument et l'identité (`claims.sub`) de la session MCP. `mqtt_publish` force le préfixe `coordinator/default/` (`mqtt-bridge.ts:282`), donc pas de publication cross-org par ce chemin, mais tous les agents partagent l'espace de noms « default » sans cloisonnement. Périmètre limité au mono-tenant Phase 1 (report documenté en Task 22 dans le code), mais c'est une vraie faille d'isolation intra-processus exploitable dès aujourd'hui entre agents d'un même déploiement.

**Recommandation.** Dériver l'`agent_id`/l'org depuis les claims de session plutôt que de le prendre en argument non vérifié, ou au minimum vérifier que l'`agent_id` demandé appartient au sujet authentifié. Composer la clé de file d'attente avec `claims.org + claims.sub`.

---

### Sévérité LOW

#### securite-surface-04 — Logger Phase 1 sans redaction des secrets (les deux loggers divergent)

- **Sévérité** : Low — **Statut** : ⚠️ Non contre-vérifié
- **Localisation** : `src/logger.ts:49`
- **Effort** : S

**Preuve.** `createPinoLogger` appelle `pino({ level, transport })` sans option `redact` ; `createConsoleLogger` sérialise brut via `JSON.stringify`. À l'inverse, `src/observability/logger.ts:54` configure `redact` avec 17 chemins (authorization, cookie, access_token, refresh_token, client_secret, etc.).

**Explication.** Le logger principal utilisé par `createServices` et tout le chemin HTTP/REST/MQTT Phase 1 n'a aucune redaction, alors que le logger Phase 2 en a une complète. Le code Phase 1 est aujourd'hui prudent (il journalise `agent_name` et IP, pas le `registration_secret` ni le password MQTT) : pas de fuite avérée, mais une lacune de défense en profondeur. Un futur log de debug d'un header `Authorization` ou d'un body contenant un token atterrirait en clair, sans filet. La divergence entre les deux loggers rend l'erreur facile à commettre.

**Recommandation.** Ajouter une liste de redaction (authorization, cookie, token, password, secret) au logger Phase 1, ou faire converger les deux loggers sur la même configuration de redaction.

#### securite-surface-05 — Endpoint Phase 1 `/api/auth/register` sans rate-limiting ni lockout

- **Sévérité** : Low — **Statut** : ⚠️ Non contre-vérifié
- **Localisation** : `src/serve-http.ts:123`
- **Effort** : S

**Preuve.** `handleAuth` (`/api/auth/register`) compare `registration_secret`/`ADMIN_SECRET` via `safeEqual` timing-safe (lignes 132-134) mais sans limite de tentatives (grep rate/lockout dans `serve-http.ts` : aucun résultat). Un limiteur par IP existe pourtant ailleurs (`auth-routes.ts` `checkAdminMutationRateLimit`, `login-lockout.ts`) mais n'est pas appliqué ici.

**Explication.** Quand `AUTH_ENABLED=true`, `/api/auth/register` permet un nombre illimité de tentatives pour deviner le `registration_secret` ou l'`admin_secret`. La comparaison est à temps constant (bien), mais sans throttling ni verrouillage, un attaquant réseau peut brute-forcer le secret. Risque atténué par l'exigence de secrets à forte entropie (responsabilité opérateur) et par le fait que l'auth est optionnelle — d'où la sévérité basse.

**Recommandation.** Appliquer le `rateLimiter` par IP déjà présent sur `/api/auth/register`, avec back-off et log d'audit sur échecs répétés.

#### securite-surface-06 — CORS wildcard générique et transport du JWT via `?token=` sur les GET

- **Sévérité** : Low — **Statut** : ⚠️ Non contre-vérifié
- **Localisation** : `src/http/utils.ts:38`
- **Effort** : S

**Preuve.** `json()` pose systématiquement `Access-Control-Allow-Origin: *` (`utils.ts:38`, repris sur SSE `serve-http.ts:255` et le preflight CORS 421-427). `auth.ts:389-397` accepte `?token=<JWT>` sur les requêtes GET (pour EventSource).

**Explication.** Le modèle Bearer limite l'impact du wildcard CORS : un site tiers ne peut pas lire le token (pas de cookie auto-envoyé, et les navigateurs interdisent `ACAO: *` avec credentials) ; les mutations admin sont en plus protégées par CSRF double-submit. Le point résiduel est le token en query string : il peut fuiter via les logs d'accès, l'en-tête Referer ou l'historique navigateur. Friction de durcissement mineure, pas de faille exploitable en l'état.

**Recommandation.** Restreindre `Access-Control-Allow-Origin` à une allowlist d'origines configurables. Documenter que `?token=` est réservé à EventSource et privilégier l'en-tête `Authorization` partout ailleurs ; s'assurer que les query strings ne sont pas journalisées avec le token.

#### securite-surface-07 — En-têtes de sécurité absents sur le dashboard principal et les réponses API

- **Sévérité** : Low — **Statut** : ⚠️ Non contre-vérifié
- **Localisation** : `src/serve-http.ts:499`
- **Effort** : S

**Preuve.** Seuls les assets admin (`/dashboard/admin*.{html,js,css}`) reçoivent CSP + `X-Frame-Options: DENY` + nosniff + Referrer-Policy (`serve-http.ts:488-497`). La branche `else` (499-503) sert `index.html` et les autres assets avec uniquement `Access-Control-Allow-Origin: *` ; `json()` n'ajoute aucun en-tête de sécurité.

**Explication.** Le dashboard legacy et les réponses JSON de l'API n'ont ni `X-Content-Type-Options: nosniff`, ni `X-Frame-Options`/CSP `frame-ancestors`, ni `Referrer-Policy`. Le dashboard affiche des données de coordination (noms d'agents, fichiers, plans) : l'absence de protection anti-clickjacking et anti-MIME-sniffing est une lacune de durcissement. Sévérité basse car aucune injection HTML évidente identifiée et projet early-stage, mais l'incohérence avec le durcissement déjà en place sur les pages admin est facile à corriger.

**Recommandation.** Appliquer au minimum `X-Content-Type-Options: nosniff` et `X-Frame-Options: DENY` (ou CSP `frame-ancestors 'none'`) à tout le dashboard et, si possible, une CSP à `index.html`. Factoriser un helper d'en-têtes de sécurité partagé.

---

## 4. Recommandations priorisées

### Quick wins (effort S)

| Priorité | Constat | Action | Impact |
|----------|---------|--------|--------|
| 1 | -01 (High) | Lire `COORDINATOR_BIND` et le passer à `httpServer.listen(port, host, cb)`, défaut `127.0.0.1` + test | Ferme l'exposition LAN non authentifiée de toute la surface — correctif d'une ligne |
| 2 | -02 (Medium) | Câbler `handleMetrics` (localhost-only + `COORDINATOR_METRICS_BEARER`) à la place du `/metrics` ouvert ; supprimer le code mort | Élimine le second contrôle fantôme et la fuite d'infos opérationnelles |
| 3 | -05 (Low) | Réutiliser le rate-limiter par IP existant sur `/api/auth/register` + back-off + audit log | Coupe le brute-force du secret d'enregistrement |
| 4 | -04 (Low) | Ajouter la config `redact` au logger Phase 1 (converger avec le logger Phase 2) | Filet anti-fuite de secrets dans les logs |
| 5 | -07 (Low) | Helper d'en-têtes de sécurité partagé (nosniff, X-Frame-Options/CSP, Referrer-Policy) appliqué à tout le dashboard et à `json()` | Durcissement homogène à faible coût |
| 6 | -06 (Low) | Allowlist CORS configurable ; cantonner `?token=` à EventSource et ne pas journaliser les query strings | Réduction de surface résiduelle |

### Chantier M

| Priorité | Constat | Action |
|----------|---------|--------|
| 7 | -03 (Medium) | Dériver l'`agent_id` des claims de session dans les outils MCP MQTT (`get_queued_messages`, `wait_for_message`) et composer la clé de file avec `claims.org + claims.sub` — à articuler avec le chantier multi-tenant (Task 22), mais la vérification `agent_id == claims.sub` peut être livrée dès maintenant |

Aucun chantier L identifié pour cette dimension.

---

## 5. Annexe — Constats écartés après contre-vérification

Aucun constat n'a été réfuté (REFUTED) lors de la contre-vérification adversariale de cette dimension. Le seul constat de sévérité haute (-01) a été confirmé point par point (absence d'argument host à `listen`, zéro lecture de `COORDINATOR_BIND` dans le code, claims admin synthétiques quand l'auth est désactivée, absence de mitigation Host/Origin, contraste avec le bind loopback du broker MQTT TCP). Les constats de sévérité medium et low n'ont pas fait l'objet d'une contre-vérification systématique et sont signalés comme tels (⚠️) dans le corps du rapport.
