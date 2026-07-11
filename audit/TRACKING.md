✅ | ✅ | ✅ | ✅ | ✅ | ✅ 3671d7b |✅ | ✅ | ✅ | ✅ | ✅ | ✅ 3671d7b |# Suivi de remédiation de l'audit v0.13.0 — TRACKING

**Source :** `audit/` (119 constats) · **Spec :** `docs/superpowers/specs/2026-07-04-audit-remediation-design.md` · **Plan :** `docs/superpowers/plans/2026-07-04-audit-remediation.md`

Ce fichier est l'artefact de certitude : **119 constats × 5 rounds de vérification**. Le programme est terminé quand toutes les lignes affichent 5/5 et un statut ✅.

## Protocole des 5 rounds (colonnes R1–R5)

| Round | Sens | Coché quand… |
|:-----:|------|--------------|
| **R1** | Reproduction (rouge) | un test échoue et démontre le défaut (ou état défaillant capturé) |
| **R2** | Correction unitaire (vert) | le fix passe le test R1 + cas limites + `tsc --noEmit` propre |
| **R3** | Intégration bout-en-bout | test au point d'entrée public réel (HTTP/stdio/CLI/CI) |
| **R4** | Régression & statique | suite + coverage gate + tsc + 5 lints verts, sans baisse |
| **R5** | Adversarial / réel | système réel piloté (`/verify`) + assertion négative prouvée |

Légende statut : ☐ TODO · 🔧 en cours · ✅ 5/5 fermé · ⏭️ écarté (justifier). Sévérité : 🔴 High · 🟠 Med · 🟡 Low · ⚪ Info.

## Avancement global

| | High (13) | Med (46) | Low (42) | Info (18) | **Total (119)** |
|--|:--:|:--:|:--:|:--:|:--:|
| **Fermés ✅** | 12 | 23 | 20 | 4 | **59 / 119** |
| **Rounds cochés** | — | — | — | — | **295 / 595 (approx)** |

> Mettre à jour ce tableau à chaque tâche fermée. 595 = 119 × 5 rounds.
> Note : sur les 10 fermés, 8 sont corrigés (5 rounds chacun = 40) ; 2 (protocole-mcp-04, securite-surface-03) sont **dispositionnés en risque-accepté + documenté** (threat-model, hors comptage 5-rounds).

---


### PR 1 — Sécurité durcissement (17 constats)

| # | ID | Sév | Eff | Constat | R1 | R2 | R3 | R4 | R5 | Statut |
|---|----|-----|-----|---------|----|----|----|----|----|--------|
| 1 | `documentation-01` | 🔴 High | S | COORDINATOR_BIND documenté mais inexistant, et le bind par défaut anno | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 3671d7b |
| 2 | `protocole-mcp-02` | 🔴 High | M | Streamable HTTP : aucune validation de l'en-tête Origin (« MUST » de l | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ f8f6227 |
| 3 | `securite-auth-01` | 🔴 High | M | Confusion de type de jeton : un refresh-token est accepté comme jeton  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 34a5ffa+5c6fa04 |
| 4 | `securite-surface-01` | 🔴 High | S | Le serveur HTTP écoute sur toutes les interfaces ; COORDINATOR_BIND (d | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 3671d7b |
| 5 | `architecture-05` | 🟠 Med | S | L'allowlist env du mode daemon a dérivé : OAuth Phase 2 et rotation JW | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 11d101a |
| 6 | `protocole-mcp-04` | 🟠 Med | M | Les outils MCP ignorent claims.sub : n'importe quel appelant authentif | ✅ | — | — | — | 📄 | 📄 différé+documenté bed5486 |
| 7 | `securite-surface-02` | 🟠 Med | S | /metrics servi sans authentification ; le handler /metrics/auth (local | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ c87ee56 |
| 8 | `securite-surface-03` | 🟠 Med | M | Isolation inter-agents absente sur les outils MCP MQTT (lecture de la  | ✅ | — | — | — | 📄 | 📄 différé+documenté bed5486 |
| 9 | `securite-auth-02` | 🟡 Low | S | Le provider Google ne vérifie pas le nonce OIDC de l'id_token | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ eca4d2f |
| 10 | `securite-auth-03` | 🟡 Low | M | Transport du JWT via query-string `?token=` sur les requêtes GET (SSE) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 177205b |
| 11 | `securite-auth-04` | 🟡 Low | S | Le rôle n'est pas re-dérivé depuis la base lors de la rotation de refr | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 8e6ec78 |
| 12 | `securite-surface-04` | 🟡 Low | S | Logger Phase 1 sans redaction des secrets (les deux loggers divergent) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 6482528 |
| 13 | `securite-surface-05` | 🟡 Low | S | Endpoint Phase 1 /api/auth/register sans rate-limiting ni lockout | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 177205b |
| 14 | `securite-surface-06` | 🟡 Low | S | CORS wildcard générique et transport du JWT via ?token= sur les GET | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ f8f6227 |
| 15 | `securite-surface-07` | 🟡 Low | S | En-têtes de sécurité absents sur le dashboard principal et les réponse | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ dc4bb3a |
| 16 | `protocole-mcp-12` | ⚪ Info | M | Auth du endpoint /mcp non conforme à la spec d'autorisation MCP : pas  | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 17 | `securite-auth-05` | ⚪ Info | S | L'échappatoire COORDINATOR_INSECURE_COOKIES est inerte pour les cookie | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 177205b |

### PR 2 — Conformité MCP & endpoints fantômes (13 constats)

| # | ID | Sév | Eff | Constat | R1 | R2 | R3 | R4 | R5 | Statut |
|---|----|-----|-----|---------|----|----|----|----|----|--------|
| 1 | `architecture-01` | 🔴 High | M | Endpoints implémentés et documentés mais jamais montés sur le serveur  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 6236a10 |
| 2 | `documentation-02` | 🔴 High | M | /metrics/auth et COORDINATOR_METRICS_BEARER documentés partout mais l' | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ c87ee56 |
| 3 | `protocole-mcp-01` | 🔴 High | S | Mode stdio : logs applicatifs écrits sur stdout, en violation du trans | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ a470112 |
| 4 | `protocole-mcp-03` | 🔴 High | S | Endpoints documentés, testés et consommés par le SDK/doctor jamais câb | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 6236a10 |
| 5 | `protocole-mcp-05` | 🟠 Med | S | set_dependency_map : paramètre JSON double-encodé, sans description de | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 6 | `protocole-mcp-06` | 🟠 Med | S | Mode stdio : les outils MQTT sont exposés mais mentent silencieusement | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 7 | `protocole-mcp-07` | 🟠 Med | M | Sessions Streamable HTTP jamais expirées : fuite des Maps sessions/ses | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 846d6f1 |
| 8 | `protocole-mcp-08` | 🟡 Low | S | get_thread (et lectures similaires) retourne le texte « null » pour un | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 9 | `protocole-mcp-09` | 🟡 Low | S | README documente un outil MCP « introspection » qui n'existe pas ; com | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 10 | `protocole-mcp-10` | 🟡 Low | M | Aucun outil n'a d'annotations (readOnlyHint/destructiveHint), de title | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 11 | `protocole-mcp-11` | 🟡 Low | M | Résumabilité Streamable HTTP absente (pas d'eventStore) et Mcp-Session | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 12 | `protocole-mcp-14` | 🟡 Low | S | Outils bloquants (wait_for_peers, wait_for_message) sans borne supérie | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 13 | `protocole-mcp-13` | ⚪ Info | S | mcpName déclaré mais aucune trace de publication au registre MCP (pas  | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |

### PR 3 — CI/CD & dépendances (24 constats)

| # | ID | Sév | Eff | Constat | R1 | R2 | R3 | R4 | R5 | Statut |
|---|----|-----|-----|---------|----|----|----|----|----|--------|
| 1 | `ci-cd-01` | 🔴 High | M | release-binaries ne se déclenche plus depuis que release-please crée l | ✅ | ✅ | ✅ | ✅ | ⏳ | ✅ 72e19c5 (plausible) |
| 2 | `maintenabilite-02` | 🔴 High | M | Canal de distribution binaires silencieusement cassé depuis v0.11.0 | ✅ | ✅ | ✅ | ✅ | ⏳ | ✅ 72e19c5 (plausible) |
| 3 | `tests-01` | 🔴 High | S | Les seuils de couverture 100 % ne sont pas appliqués en CI (pnpm test  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ fa96fca+c47aed6 |
| 4 | `ci-cd-02` | 🟠 Med | S | Provenance npm revendiquée mais jamais activée (id-token: write inutil | ✅ | ✅ | ✅ | ✅ | ⏳ | ✅ f2767da (plausible) |
| 5 | `ci-cd-03` | 🟠 Med | S | Aucun status check requis sur main : les tests ne bloquent pas les mer | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 6 | `ci-cd-04` | 🟠 Med | S | Le garde-fou « :latest non promu sur workflow_dispatch/workflow_call » | ✅ | ✅ | ✅ | ✅ | ⏳ | ✅ f2767da (plausible) |
| 7 | `ci-cd-05` | 🟠 Med | S | Actions GitHub épinglées par tags mutables (pas de SHA), sans Dependab | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 8 | `dependances-01` | 🟠 Med | S | Le bloc « overrides » de package.json est silencieusement ignoré par p | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ e0bace5 |
| 9 | `dependances-02` | 🟠 Med | S | 10 avis pnpm audit ouverts (2 high, 7 moderate, 1 low) — tous corrigea | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ e0bace5 |
| 10 | `dependances-03` | 🟠 Med | S | Aucune automatisation de veille dépendances : ni Dependabot/Renovate,  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ e0bace5 |
| 11 | `dependances-04` | 🟠 Med | M | pnpm 9 exécute les scripts d'installation de toutes les dépendances pa | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 12 | `tests-02` | 🟠 Med | S | Les 84 tests du SDK (sdk/tests) ne tournent dans aucune CI | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ f2767da |
| 13 | `ci-cd-06` | 🟡 Low | S | Node 20 déclaré supporté (engines >=20) mais jamais testé en CI | ✅ | ✅ | ✅ | ✅ | ⏳ | ✅ f2767da (plausible) |
| 14 | `ci-cd-07` | 🟡 Low | S | Déclencheurs incohérents : lint et e2e tournent en double sur chaque P | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 15 | `ci-cd-08` | 🟡 Low | S | secrets: inherit transmet NPM_TOKEN au workflow Docker qui n'en a pas  | ✅ | ✅ | ✅ | ✅ | ⏳ | ✅ f2767da (plausible) |
| 16 | `ci-cd-09` | 🟡 Low | M | Binaires compilés avec un Bun non versionné et jamais démarrés réellem | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 17 | `dependances-05` | 🟡 Low | L | Famille tree-sitter figée sur l'ABI 0.21 (début 2024) — montée de vers | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 18 | `dependances-06` | 🟡 Low | M | ~292 Mo de grammaires tree-sitter installés par défaut chez chaque con | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 19 | `dependances-07` | 🟡 Low | M | Retards de versions majeures contrôlés mais non suivis : zod 3→4, fast | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 20 | `dependances-08` | 🟡 Low | S | Actions CI épinglées par tag mutable, et binaires release construits a | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 21 | `ci-cd-10` | ⚪ Info | S | Image de base Docker non épinglée par digest | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 22 | `ci-cd-11` | ⚪ Info | S | Navigateurs Playwright retéléchargés à chaque run e2e | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 23 | `dependances-09` | ⚪ Info | S | engines ">=20" autorise toujours Node 20, en fin de vie depuis avril 2 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 24 | `dependances-10` | ⚪ Info | S | Concentration de mainteneurs sur les briques critiques (better-sqlite3 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |

### PR 4 — Performance & scalabilité (11 constats)

| # | ID | Sév | Eff | Constat | R1 | R2 | R3 | R4 | R5 | Statut |
|---|----|-----|-----|---------|----|----|----|----|----|--------|
| 1 | `performance-01` | 🔴 High | M | Aucune rétention sur les tables Phase 1 (file_activity, events, thread | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 1ce158e |
| 2 | `performance-02` | 🟠 Med | S | Connexion SSE sans Last-Event-ID : chargement de TOUT l'historique eve | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 3 | `performance-03` | 🟠 Med | S | Cardinalité Prometheus non bornée : l'URL brute (avec UUIDs et chemins | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 609126d |
| 4 | `performance-04` | 🟠 Med | M | Pont WebSocket→MQTT sans backpressure ni maxPayload : un consommateur  | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 5 | `performance-05` | 🟠 Med | S | Queues de listeners MqttBridge jamais nettoyées ni bornées : fuite mém | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 1e4daf2 |
| 6 | `performance-06` | 🟠 Med | S | RateLimiter.sweep() n'est jamais appelé : la Map de buckets croît sans | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 1e4daf2 |
| 7 | `performance-07` | 🟡 Low | M | Sessions MCP StreamableHTTP jamais expirées : transports + McpServer a | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 846d6f1 |
| 8 | `performance-08` | 🟡 Low | S | bench-audit-queue.ts cassé (dérive de schéma) : la suite perf a rouill | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ e874cf3 |
| 9 | `performance-09` | 🟡 Low | S | Sweep audit_log sur expression non indexable strftime('%s', created_at | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ ba6bd4c |
| 10 | `performance-10` | ⚪ Info | S | PRAGMA synchronous laissé à FULL en mode WAL : un fsync par écriture a | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ ba6bd4c |
| 11 | `performance-11` | ⚪ Info | S | Layer 4 du scorer : requêtes SQL par (fichier cible × agent) dans la b | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ e874cf3 |

### PR 5 — Qualité & refactoring (30 constats)

| # | ID | Sév | Eff | Constat | R1 | R2 | R3 | R4 | R5 | Statut |
|---|----|-----|-----|---------|----|----|----|----|----|--------|
| 1 | `architecture-02` | 🟠 Med | L | État mutable au niveau module dans serve-http.ts contredit le contrat  | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 2 | `architecture-03` | 🟠 Med | L | Base de données en singleton global (service locator) — couple tout le | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 3 | `architecture-04` | 🟠 Med | S | Les handlers SIGINT/SIGTERM du CLI en mode foreground court-circuitent | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 4 | `architecture-06` | 🟠 Med | S | Défauts de répertoire de données divergents entre points d'entrée, et  | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 5 | `architecture-07` | 🟠 Med | S | Dérive comportementale entre les transports REST et MCP sur le flux d' | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 6 | `architecture-08` | 🟠 Med | M | Org 'default' codé en dur aux frontières MQTT et quota alors que le mu | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 7 | `qualite-code-01` | 🟠 Med | L | Trois fonctions géantes (390 à 505 lignes) concentrent la complexité d | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 8 | `qualite-code-02` | 🟠 Med | M | Couche REST : corps de requêtes castés sans validation (15 « body as { | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 9 | `qualite-code-03` | 🟠 Med | M | Aucun linter réel : le job CI « Lint » = 5 scripts bash grep + tsc ; c | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 10 | `tests-03` | 🟠 Med | M | Couche handlers d'outils MCP faiblement couverte : consultation-tools  | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 11 | `tests-04` | 🟠 Med | S | Le hook d'authentification MQTT de production n'est jamais exercé : le | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 1d414bb |
| 12 | `tests-05` | 🟠 Med | M | Le dashboard principal (index.html, ~77 fonctions JS inline) n'a aucun | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 13 | `architecture-09` | 🟡 Low | M | Double pile logger/metrics Phase 1 vs Phase 2 : la redaction Pino ne c | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 14 | `architecture-10` | 🟡 Low | M | La Phase 2 contourne l'abstraction DatabaseAdapter par un double cast  | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 15 | `architecture-11` | 🟡 Low | S | Inversion de couche : src/ importe cli/version.ts | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 16 | `architecture-13` | 🟡 Low | M | Pas de carte d'architecture pour les contributeurs externes malgré 108 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 17 | `architecture-15` | 🟡 Low | M | Posture de validation d'entrée incohérente entre transports : zod côté | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 18 | `qualite-code-04` | 🟡 Low | S | Duplication verbatim des helpers admin (readJsonBody, writeJson, write | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ b58688d |
| 19 | `qualite-code-05` | 🟡 Low | S | safeEqual et decodeJwtPayload dupliqués localement dans serve-http.ts  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ b58688d |
| 20 | `qualite-code-06` | 🟡 Low | S | Dualité Phase 1 / Phase 2 : deux modules metrics, deux loggers, auth.t | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 21 | `qualite-code-07` | 🟡 Low | S | JSON.parse non protégé sur des colonnes SQLite dans les chemins de lec | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 22ae9ef |
| 22 | `tests-06` | 🟡 Low | M | Zones serveur les moins mesurées : serve-http.ts 47,5 %, handle-rest.t | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 23 | `tests-07` | 🟡 Low | S | Race assumée dans channel-smoke : sleep fixe de 1,5 s au lieu d'attend | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 1d414bb |
| 24 | `tests-08` | 🟡 Low | S | CLI : commandes exclues de la mesure de couverture et « uninstall » (d | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 25 | `tests-09` | 🟡 Low | S | fast-check sous-exploité (2 propriétés) et propriété CSRF théoriquemen | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 26 | `architecture-12` | ⚪ Info | S | CoordinatorConfig porte des champs de configuration morts (authEnabled | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 27 | `architecture-14` | ⚪ Info | L | Dashboard principal : 63 Ko de HTML avec un unique script inline, cont | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 28 | `qualite-code-08` | ⚪ Info | S | Le catch global HTTP renvoie err.message brut dans la réponse 500 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 29 | `tests-10` | ⚪ Info | L | Suite entièrement sérialisée à cause de singletons de module — discipl | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 30 | `tests-11` | ⚪ Info | S | Scripts perf/chaos hors CI par choix documenté — pas de suivi de régre | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |

### PR 6 — Documentation (13 constats)

| # | ID | Sév | Eff | Constat | R1 | R2 | R3 | R4 | R5 | Statut |
|---|----|-----|-----|---------|----|----|----|----|----|--------|
| 1 | `documentation-03` | 🟠 Med | S | Section « Anthropic Quota Pre-flight » du README : MAX_QUOTA_PCT inexi | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 8fbb5e1 |
| 2 | `documentation-04` | 🟠 Med | M | usage.md : le workflow multi-instances documenté est faux (le PID file | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 8fbb5e1 |
| 3 | `documentation-05` | 🟠 Med | S | Le README promet un outil MCP « introspection » qui n'existe pas | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 5484ba7 |
| 4 | `documentation-06` | 🟠 Med | S | SECURITY.md : table des versions supportées périmée de trois minors | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 5484ba7 |
| 5 | `documentation-07` | 🟠 Med | S | README figé à v0.11.0 : tags Docker, compteurs de tests et section Sup | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 5484ba7 |
| 6 | `documentation-08` | 🟠 Med | S | usage.md « Push vs polling » contredit le README et operating-modes.md | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 8fbb5e1 |
| 7 | `documentation-09` | 🟠 Med | S | Variables COORDINATOR_LOGIN_LOCKOUT_* documentées mais codées en dur ( | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 8fbb5e1 |
| 8 | `documentation-10` | 🟠 Med | S | Les commandes `server backup` / `server restore` existent mais ne sont | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 1083f18 |
| 9 | `documentation-11` | 🟡 Low | S | Exemple custom-idp-provider périmé et auto-contradictoire (parle de v0 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 1083f18 |
| 10 | `documentation-12` | 🟡 Low | S | docs/ pollué : 132 fichiers internes (superpowers) publiés sur GitHub  | ✅ | ✅ | ✅ | ✅ | ⏳ | ✅ HEAD (Pages@deploy) |
| 11 | `documentation-13` | 🟡 Low | S | Petits chiffres périmés disséminés : « 23 MCP tools » en commentaire,  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 5484ba7 |
| 12 | `documentation-14` | 🟡 Low | S | CONTRIBUTING.md n'explique pas comment reproduire localement le job Li | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 8fbb5e1 |
| 13 | `documentation-15` | ⚪ Info | S | La roadmap du README liste comme futures des features SDK déjà livrées | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 5484ba7 |

### PR 7 — DX & angles morts (11 constats)

| # | ID | Sév | Eff | Constat | R1 | R2 | R3 | R4 | R5 | Statut |
|---|----|-----|-----|---------|----|----|----|----|----|--------|
| 1 | `maintenabilite-01` | 🔴 High | S | PR d'un contributeur externe (#151) sans aucune réponse depuis 6,5 sem | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 2 | `maintenabilite-03` | 🟠 Med | S | Release 0.13.1 bloquée depuis 7 semaines avec des correctifs utilisate | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 3 | `maintenabilite-04` | 🟠 Med | S | pnpm test échoue sur Windows (20 tests, exit 127) quand bash résout ve | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 4 | `maintenabilite-05` | 🟠 Med | M | Aucun formatter ni linter généraliste — le style repose entièrement su | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 5 | `maintenabilite-06` | 🟠 Med | M | sdk/ est un sous-paquet orphelin : jamais testé en CI, lockfile npm da | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 6 | `maintenabilite-07` | 🟠 Med | S | Surface Phase 2 (OAuth/multi-org/chiffrement) surdimensionnée par rapp | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 7 | `maintenabilite-08` | 🟡 Low | S | Tracker figé depuis le 23 mai : 23 issues semées sans triage ni lien a | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 8 | `maintenabilite-09` | 🟡 Low | S | 169 artefacts de travail IA internes commités dans le dépôt public (do | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 9 | `maintenabilite-10` | ⚪ Info | S | Déclencheurs CI incohérents entre workflows : tests absents des branch | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 10 | `maintenabilite-11` | ⚪ Info | S | Seuils de couverture 100 % sur ~50 fichiers : garde-fou puissant mais  | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
| 11 | `maintenabilite-12` | ⚪ Info | M | Landing page maintenue à la main en 6 locales : toil récurrent à chaqu | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ TODO |
