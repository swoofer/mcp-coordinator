# Audit — Dimension 2 : Qualité du code

**Projet :** mcp-coordinator v0.13.0 — Embedded MQTT broker + MCP server for multi-agent coordination
**Date de l'audit :** 2026-07-03
**Score : 8 / 10**

> **Verdict global :** une base de code exceptionnellement disciplinée pour un projet solo early-stage — typage strict irréprochable, couverture 100 % imposée sur les modules sensibles, dette localisée et cartographiée — dont les faiblesses réelles se résument à trois fonctions géantes, une couche REST sans validation d'entrée et l'absence d'un vrai linter.

---

## 1. Résumé exécutif

La qualité du code de mcp-coordinator est remarquable au regard de son contexte (mainteneur solo, projet jeune, premiers contributeurs externes depuis la v0.11) :

- **TypeScript strict activé partout** (racine et SDK), `pnpm exec tsc --noEmit` passe sans erreur — vérifié pendant l'audit et exécuté en CI.
- **Hygiène de typage quasi parfaite** : 2 occurrences réelles de `as any` dans `src/` (toutes deux justifiées), zéro `@ts-ignore` / `@ts-expect-error`, 5 assertions non-null toutes triviales et sûres.
- **Seuils de couverture de branches à 100 %** imposés fichier par fichier sur ~60 modules critiques (auth/, security/, admin/, sweeper/) via `vitest.config.ts` — une rigueur rare, même en entreprise.
- **Gestion d'erreurs délibérée** : les catch « vides » sont systématiquement commentés (migrations idempotentes, fall-through documentés), les 12 TODO sont tous tracés avec un identifiant de tâche.

Les faiblesses sont concentrées et bien identifiées :

1. **Trois fonctions géantes** — `refreshTokenGrant` (~450 lignes), `handleRest` (~505 lignes), `startServer` (~390 lignes) — concentrent la complexité sur les fichiers les plus sensibles du projet (rotation refresh-token, routage HTTP).
2. **La couche REST caste les corps de requête sans validation** (15 `body as {...}`), alors que zod est déjà utilisé côté MCP pour les mêmes payloads.
3. **Absence d'un vrai linter** : le job CI « Lint » est constitué de 5 scripts bash grep + `tsc`, ce qui laisse des commentaires `eslint-disable` vestigiaux et aucune détection des promesses flottantes.
4. Quelques **duplications verbatim** (helpers admin, `safeEqual`/`decodeJwtPayload`), dont l'une porte sur du code de sécurité (comparaison timing-safe).

Rien de critique ni d'exploitable côté qualité : il s'agit de dette localisée, connue, et déjà attaquée incrémentalement (refactorings S1/S2 documentés dans le code).

---

## 2. Points forts

| # | Point fort | Preuve |
|---|-----------|--------|
| 1 | **Type-check strict, propre, en CI** | `tsconfig` `strict: true` (racine et sdk) ; `pnpm exec tsc --noEmit` passe sans erreur (vérifié pendant l'audit) ; le type-check est un job CI (`lint.yml`) |
| 2 | **Hygiène de typage exceptionnelle** | 2 `as any` réels dans `src/` (`mqtt-broker.ts:86` avec justification, `working-files-tracker.ts:65` sur un `COUNT` SQLite) ; 0 `@ts-ignore`/`@ts-expect-error` ; 5 assertions non-null toutes triviales (ex. `src/auth/html.ts:17`) |
| 3 | **Couverture 100 % branches/lignes/fonctions imposée fichier par fichier** | `vitest.config.ts` : ~60 modules sécurité (auth/, security/, admin/, sweeper/), avec un pattern de « pré-stub commenté » pour éviter les conflits de merge — rare même en entreprise |
| 4 | **Gestion d'erreurs délibérée** | Tous les catch vides sont commentés avec la raison (migrations `ALTER TABLE` idempotentes dans `src/database.ts:400-451`, URL attaquant-contrôlée dans `src/auth.ts:398`, retry fall-through dans `github-shared.ts:43`) ; fire-and-forget en `void` explicite avec gestion interne des erreurs (`quota-cache.ts:206` → `refresh()` catch interne) |
| 5 | **Commentaires à très haute densité informationnelle** | Chaque module référence sa spec (V2/V3/V4 §…), son numéro de tâche et le *pourquoi* (en-tête de `src/sweeper/index.ts`, notes de migration de `src/database.ts`) — atout majeur pour l'onboarding des contributeurs externes |
| 6 | **Refactorings déjà engagés et documentés** | `handle-rest.ts` extrait d'un `serve-http.ts` de 382 lignes (S1) ; tools MCP découpés par domaine (`consultation-tools.ts`) ; helpers OAuth partagés dans `oauth-finalize.ts` (« pure functions, no env reads ») — la dette est connue et attaquée incrémentalement |
| 7 | **Nommage cohérent, zéro code mort détecté** | Fichiers kebab-case, classes PascalCase, fonctions camelCase ; tous les petits modules `src/` sont importés par du code de prod ou des tests |
| 8 | **Observabilité disciplinée** | 0 `console.log` dans `src/` ; logger pino structuré avec redaction des secrets (17 chemins redactés dans `observability/logger.ts`) ; 12 TODO seulement, tous annotés d'un ID de tâche (`TODO(Task 22)`, `TODO(T07)`…) |
| 9 | **Repo propre** | `data/`, `*.db`, `test-results/`, `scan.pdf` gitignorés ; `parseBody` borné à 1 Mo avec 413 (`http/utils.ts:10-25`) ; SDK séparé, privé, typé strict |

---

## 3. Constats détaillés

Aucun constat de sévérité **critical** ou **high** : la dimension qualité de code ne présente aucun risque immédiat.

> Note sur les statuts : conformément au protocole d'audit, seuls les constats de sévérité high/critical font l'objet d'une contre-vérification adversariale systématique. Tous les constats ci-dessous (medium ou moins) sont donc marqués ⚠️ non contre-vérifié ; leurs preuves citent néanmoins des fichiers et lignes précis, relisibles dans le dépôt.

### Sévérité : medium

---

#### qualite-code-01 — Trois fonctions géantes (390 à 505 lignes) concentrent la complexité du serveur HTTP et de la rotation de tokens

- **Sévérité :** medium — **Statut :** ⚠️ non contre-vérifié
- **Localisation :** `src/auth/refresh-rotation.ts:402` (et `src/http/handle-rest.ts:35`, `src/serve-http.ts:363`)
- **Effort :** L

**Preuve.** `export async function refreshTokenGrant(...)` — lignes 402 à 854 (~450 lignes). Idem `handleRest` (`src/http/handle-rest.ts:35-541`, ~505 lignes de chaîne if/else sur l'URL) et `startServer` (`src/serve-http.ts:363-752`, ~390 lignes).

**Explication.** `refreshTokenGrant` enchaîne ~10 étapes numérotées (parse, verify JWT, epoch, SELECT, idle-timeout, reuse-detection, grace window, rotation, audit) dans un seul corps ; `handleRest` est un dispatcheur if/else de ~25 endpoints ; `startServer` est la racine de composition entière du serveur. Les commentaires étape-par-étape atténuent le problème de lisibilité, mais la complexité cyclomatique rend chaque modification risquée et les tests de branche coûteux — précisément sur les deux fichiers les plus sensibles du projet (rotation refresh-token, routage HTTP). Le projet a déjà démontré sa capacité à extraire (refactorings S1/S2) ; ces trois fonctions sont les restes.

**Recommandation.** Sans tout réécrire :
- extraire chaque étape numérotée de `refreshTokenGrant` en helper nommé retournant un résultat discriminé (le fichier contient déjà `handleReuseBranch` comme modèle, lignes 214-396) ;
- remplacer la chaîne if/else de `handleRest` par une table `Record<string, handler>` (les corps de 5-15 lignes deviennent des fonctions) ;
- découper `startServer` en `createHttpHandler()` + `wireMqtt()` + `wireShutdown()`.

À faire de manière opportuniste, un fichier par PR.

---

#### qualite-code-02 — Couche REST : corps de requêtes castés sans validation (15 `body as {...}`) alors que zod est déjà utilisé côté MCP

- **Sévérité :** medium — **Statut :** ⚠️ non contre-vérifié
- **Localisation :** `src/http/handle-rest.ts:60`
- **Effort :** M

**Preuve.** `const { agent_id, name, modules } = body as { agent_id: string; name: string; modules: string[] };` — 15 casts de ce type dans `handle-rest.ts` (lignes 60, 77, 85, 94, 103…).

**Explication.** Les tools MCP valident leurs entrées avec zod (`src/tools/*.ts`), mais les endpoints REST équivalents castent le JSON brut vers des types présumés. Un champ manquant ou mal typé traverse le cast et explose en aval (`TypeError` dans registry/consultation), rattrapé par le catch global de `serve-http.ts:595-598` qui renvoie un 500 générique au lieu d'un 400 explicite. Pour des early adopters qui scriptent contre l'API REST, le diagnostic est pénible et le contrat d'API est invisible dans le code.

**Recommandation.** Réutiliser les schémas zod existants des tools MCP (mêmes payloads pour `/api/announce`, `/api/register`, etc.) : un `z.object` par endpoint, `parse` au début du handler, 400 avec le message zod en cas d'échec. Peut se faire endpoint par endpoint, en commençant par les 4-5 plus utilisés.

---

#### qualite-code-03 — Aucun linter réel : le job CI « Lint » = 5 scripts bash grep + tsc ; commentaires eslint-disable vestigiaux

- **Sévérité :** medium — **Statut :** ⚠️ non contre-vérifié
- **Localisation :** `scripts/lint-run-all.sh:10`
- **Effort :** M

**Preuve.** `LINTS=("lint-no-users-org-id.sh" "lint-no-current-timestamp.sh" …)` — ESLint est absent de `package.json` ; pourtant `src/mqtt-broker.ts:86`, `cli/encryption/migrate.ts:247/308`, `src/auth/providers/github.ts:174` et `dashboard/public/admin-orgs.js:74` contiennent des `eslint-disable-next-line`.

**Explication.** Les scripts grep maison sont astucieux (invariants projet ciblés : `org_id`, `CURRENT_TIMESTAMP`, échappement HTML), mais rien ne détecte les promesses flottantes (`no-floating-promises` exige typescript-eslint), les imports/variables inutilisés (`tsc --noEmit` ne les signale pas sans `noUnusedLocals`), ou les comparaisons douteuses. Les commentaires `eslint-disable` laissent croire aux contributeurs externes — qui arrivent depuis la v0.11 — qu'ESLint tourne, et normalisent l'ajout de nouveaux `disable` sans effet. La discipline actuelle tient au mainteneur seul ; elle ne survivra pas mécaniquement aux PRs externes.

**Recommandation.** Ajouter une eslint flat config + typescript-eslint en mode `recommended-type-checked` sur `src/`, `cli/`, `sdk/` avec `no-floating-promises` activé (le codebase est déjà propre, le coût de mise en conformité initial sera faible), et l'intégrer au job `lint.yml` existant. A minima : activer `noUnusedLocals`/`noUnusedParameters` dans le tsconfig et supprimer les commentaires `eslint-disable` vestigiaux.

---

### Sévérité : low / info

---

#### qualite-code-04 — Duplication verbatim des helpers admin (readJsonBody, writeJson, writeValidationError) entre les 3 handlers admin

- **Sévérité :** low — **Statut :** ⚠️ non contre-vérifié
- **Localisation :** `src/admin/handle-admin-orgs.ts:103`
- **Effort :** S

**Preuve.** `async function readJsonBody<T = unknown>(…)` (~50 lignes identiques) présent à la fois dans `handle-admin-orgs.ts:103-146` et `handle-admin-users.ts:115-158` ; `writeJson` dupliqué (orgs:46, users:62) ; `handle-service-tokens.ts:91-101` réimplémente une troisième variante inline du parse JSON.

**Explication.** Le bloc complet de lecture/validation du corps JSON (limite de taille, body vide, non-objet, JSON invalide → 400 `appError`) est copié-collé entre les trois handlers admin. Toute correction (changement de limite, nouveau code d'erreur) devra être appliquée trois fois, et les variantes divergeront silencieusement — la version service-tokens diverge déjà.

**Recommandation.** Extraire `readJsonBody`/`writeJson`/`writeValidationError` vers un `src/admin/http-helpers.ts` (ou les fusionner avec `src/http/utils.ts` en acceptant le format `appError`) et importer depuis les trois handlers. Diff mécanique, couvert par les tests admin existants.

---

#### qualite-code-05 — safeEqual et decodeJwtPayload dupliqués localement dans serve-http.ts alors que le module importe déjà http/utils.js qui les exporte

- **Sévérité :** low — **Statut :** ⚠️ non contre-vérifié
- **Localisation :** `src/serve-http.ts:80`
- **Effort :** S

**Preuve.** `function decodeJwtPayload(token: string)…` (ligne 80) et `function safeEqual(a, b)…` (ligne 88) — copies exactes de `src/http/utils.ts:48` et `:53` ; `serve-http.ts:22` importe déjà `json as jsonShared, jsonAuthError as jsonAuthErrorShared` depuis ce même `./http/utils.js`.

**Explication.** Reste du refactoring S1 : les deux fonctions ont été déplacées vers `http/utils.ts` (le commentaire de `serve-http.ts:73` le dit) mais les copies locales n'ont pas été supprimées. Deux implémentations d'une comparaison timing-safe qui peuvent diverger, c'est exactement le genre de code sécurité qu'on ne veut qu'à un seul endroit.

**Recommandation.** Supprimer les deux définitions locales (lignes 80-91) et ajouter `decodeJwtPayload`/`safeEqual` à l'import existant de la ligne 22. Cinq minutes, zéro risque, tests existants suffisants.

---

#### qualite-code-06 — Dualité Phase 1 / Phase 2 : deux modules metrics, deux loggers, auth.ts + auth/ — coût cognitif pour les nouveaux contributeurs

- **Sévérité :** low — **Statut :** ⚠️ non contre-vérifié
- **Localisation :** `src/observability/metrics.ts:1`
- **Effort :** S

**Preuve.** « this is a SEPARATE Registry from Phase 1's src/metrics.ts to avoid namespace coupling » — coexistent : `src/metrics.ts` (279 l.) / `src/observability/metrics.ts` (284 l.) / `src/http/metrics.ts`, et `src/logger.ts` / `src/observability/logger.ts` (deux `createLogger` exportés).

**Explication.** La séparation est délibérée, documentée et défendable (registres Prometheus isolés, `/metrics` vs `/metrics/auth`), mais trois fichiers `metrics.ts` et deux `logger.ts` avec des exports homonymes (`createLogger`, `Logger`) obligent chaque lecteur à connaître l'historique Phase 1/Phase 2 pour choisir le bon import. Le même schéma existe pour `src/auth.ts` (502 l.) vs `src/auth/` (41 fichiers). Pour un contributeur externe, c'est le principal piège de navigation du dépôt.

**Recommandation.** Pas de refactoring lourd : renommer pour désambiguïser (ex. `src/metrics.ts` → `src/coordinator-metrics.ts`, `src/logger.ts` → `src/console-logger.ts`) ou, moins invasif, ajouter une section « Carte des modules : Phase 1 vs Phase 2 » dans CONTRIBUTING.md listant quel fichier sert quoi et lequel importer.

---

#### qualite-code-07 — JSON.parse non protégé sur des colonnes SQLite dans les chemins de lecture (dependency-map, consultation, conflict-detector)

- **Sévérité :** low — **Statut :** ⚠️ non contre-vérifié
- **Localisation :** `src/dependency-map.ts:31`
- **Effort :** S

**Preuve.** `depends_on: JSON.parse(row.depends_on || "[]"),` — idem `consultation.ts:132` (`JSON.parse(agent.modules)`), `conflict-detector.ts:33-34`, `context-provider.ts:31`, `announce-workflow.ts:146`.

**Explication.** Les colonnes JSON (`modules`, `target_files`, `depends_on`…) sont écrites par l'application elle-même, donc le risque de corruption est faible ; mais une seule ligne malformée (édition manuelle du `.db`, bug d'écriture, downgrade) fait exploser de façon répétée tous les endpoints de liste qui la traversent, avec un 500 générique dont la cause racine est masquée par le catch global. Le pattern est répandu dans ~6 modules.

**Recommandation.** Ajouter un helper `safeJsonArray(raw: string | null): string[]` (try/catch → `[]` + log warn avec l'id de la ligne) dans un module partagé et remplacer les appels dans les chemins de lecture. Laisser tels quels les `JSON.parse` des chemins d'écriture/validation.

---

#### qualite-code-08 — Le catch global HTTP renvoie err.message brut dans la réponse 500

- **Sévérité :** info — **Statut :** ⚠️ non contre-vérifié
- **Localisation :** `src/serve-http.ts:597`
- **Effort :** S

**Preuve.**
```ts
} catch (err) { httpLog.error({ err }, "HTTP request error"); json(res, { error: (err as Error).message }, 500); }
```

**Explication.** Côté qualité, ce filet de sécurité est bien placé (aucune requête ne crashe le process) ; mais il sérialise le message d'exception interne vers le client (chemins de fichiers, messages SQLite, détails better-sqlite3). Couplé au constat qualite-code-02 (casts non validés → TypeErrors), les clients REST reçoivent des messages internes au lieu d'erreurs de contrat. Le volet divulgation d'information relève de la dimension sécurité ; ici c'est surtout un contrat d'erreur incohérent avec le format `appError` structuré utilisé par les handlers admin.

**Recommandation.** Renvoyer un message générique + `request_id` en 500 (le format `appError` de `src/http/response-contract.ts` existe déjà) et garder le détail uniquement dans `httpLog.error`.

---

## 4. Recommandations priorisées

### Quick wins (effort S)

| Priorité | Action | Constat | Pourquoi d'abord |
|---|---|---|---|
| 1 | Supprimer les copies locales de `safeEqual`/`decodeJwtPayload` dans `serve-http.ts` et importer depuis `http/utils.js` | qualite-code-05 | 5 minutes, zéro risque, élimine une duplication de code *sécurité* (comparaison timing-safe) |
| 2 | Factoriser `readJsonBody`/`writeJson`/`writeValidationError` dans un module partagé des handlers admin | qualite-code-04 | Diff mécanique couvert par les tests existants ; la 3e variante diverge déjà |
| 3 | Catch global HTTP : message générique + `request_id` au lieu de `err.message` brut | qualite-code-08 | Petit fix qui aligne le contrat d'erreur sur `appError` et coupe la fuite de détails internes |
| 4 | Helper `safeJsonArray` pour les `JSON.parse` des chemins de lecture SQLite | qualite-code-07 | Évite qu'une ligne corrompue rende des endpoints de liste durablement indisponibles |
| 5 | Documenter la carte Phase 1 / Phase 2 (metrics, logger, auth) dans CONTRIBUTING.md | qualite-code-06 | Le piège de navigation n°1 pour les contributeurs externes, résolu sans refactoring |

### Chantiers moyens (effort M)

| Priorité | Action | Constat |
|---|---|---|
| 6 | Introduire eslint flat config + typescript-eslint (`recommended-type-checked`, `no-floating-promises`) dans le job `lint.yml` ; a minima `noUnusedLocals`/`noUnusedParameters` + purge des `eslint-disable` vestigiaux | qualite-code-03 |
| 7 | Valider les corps REST avec les schémas zod déjà écrits côté MCP, endpoint par endpoint (400 explicite au lieu de 500 générique) | qualite-code-02 |

Le point 6 est le plus structurant : c'est lui qui transforme une discipline personnelle du mainteneur en garde-fou mécanique face aux PRs externes.

### Chantier de fond (effort L)

| Priorité | Action | Constat |
|---|---|---|
| 8 | Découper les trois fonctions géantes, un fichier par PR : `refreshTokenGrant` (helpers par étape numérotée, sur le modèle de `handleReuseBranch`), `handleRest` (table de routage), `startServer` (`createHttpHandler` / `wireMqtt` / `wireShutdown`) | qualite-code-01 |

À mener de façon opportuniste — idéalement en combinant le découpage de `handleRest` avec l'ajout de la validation zod (point 7), puisque les deux touchent le même fichier, et de préférence après le point 6 pour refactorer sous filet de linter.

---

## 5. Annexe — Constats écartés après contre-vérification

Aucun constat de cette dimension n'a été réfuté (REFUTED) lors de la passe adversariale : l'annexe est vide. Pour transparence : aucun constat n'a non plus reçu de verdict CONFIRMED explicite, la contre-vérification systématique étant réservée aux sévérités high/critical (absentes ici) ; les constats medium et moins sont donc tous marqués ⚠️ non contre-vérifié. Les éléments transverses du résumé (mode strict, `tsc --noEmit` sans erreur, comptages `as any`/`@ts-ignore`) ont, eux, été vérifiés directement pendant l'audit.
