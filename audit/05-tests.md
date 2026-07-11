# Audit — Dimension 5 : Tests & couverture

**Projet** : mcp-coordinator v0.13.0 (Embedded MQTT broker + MCP server for multi-agent coordination)
**Date de l'audit** : 2026-07-03
**Score** : **8 / 10**

> **Verdict global** : suite de tests d'une qualité rare pour un projet solo — integration-first, 2 337 tests verts, 88 % de lignes couvertes, seuils 100 % tenus sur les fichiers de sécurité — mais dont les garde-fous les plus précieux (seuils de couverture, tests SDK) ne sont pas branchés en CI, précisément au moment où les contributeurs externes arrivent.

---

## 1. Résumé exécutif

Le run complet `pnpm vitest run --coverage` a été exécuté et vérifié pendant l'audit : **709 suites, 2 337 tests, 0 échec, ~4 min 20**, pour une couverture mesurée de **88,3 % lignes / 80,8 % branches** (115 fichiers instrumentés). Plus de 40 fichiers auth/sécurité sont réellement verrouillés à **100 % de branches** par des seuils par fichier (`vitest.config.ts:29-116`) qui tiennent lors du run.

Le style est résolument **integration-first** : vraie SQLite, vrai broker aedes avec de vrais clients mqtt.js, vrai client MCP SDK exercé sur les deux transports de production (stdio et HTTP), msw pour simuler l'IdP avec injection de pannes. `vi.mock` n'apparaît que dans 3 fichiers, aucun test n'est skippé, aucune assertion tautologique n'a été relevée.

Les lacunes sont **structurelles plutôt que qualitatives** :

- les seuils de couverture ne sont **pas appliqués en CI** (`test.yml` lance `pnpm test` sans `--coverage`) — le maillon manquant le plus rentable de tout le dispositif (tests-01, confirmé) ;
- les **84 tests du SDK** ne tournent dans aucun workflow (tests-02) ;
- la **couche des handlers d'outils MCP** (consultation-tools 33 %, status-tools 10 %, mqtt-tools 21 %) et le **dashboard principal** (index.html, 63 Ko de JS inline) sont peu ou pas testés (tests-03, tests-05).

S'y ajoutent quelques risques ciblés de flakiness (sleep fixe de 1,5 s dans channel-smoke qui « race » le SUBSCRIBE) et un fast-check sous-exploité (2 propriétés). Les scripts perf/chaos sont volontairement hors CI et documentés comme tels — un arbitrage raisonnable à ce stade.

---

## 2. Points forts

| # | Point fort |
|---|-----------|
| 1 | **Run complet vérifié** : 2 337 tests / 709 suites, 0 échec, ~4 min 20 avec coverage — 88,3 % lignes et 80,8 % branches au global (115 fichiers instrumentés). |
| 2 | **Politique de seuils 100 % branches/lignes réellement tenue** sur 40+ fichiers critiques auth/sécurité (`vitest.config.ts:29-116`) : refresh-rotation, csrf, oauth-*, audit-chain, encryption… tous verts lors du run. |
| 3 | **Style integration-first avec très peu de mocks** : vraie SQLite, vrai broker aedes + vrais clients mqtt.js (`tests/unit/mqtt-org-scoping.test.ts` teste SUBACK 128 et déconnexion cross-org), vrai client MCP SDK sur les deux transports production via `tests/helpers/mcp-client-harness.ts`. `vi.mock` dans 3 fichiers seulement, zéro test skippé, zéro assertion tautologique. |
| 4 | **Mock IdP centralisé sur msw avec injection de pannes** (`tests/helpers/idp.ts`), réutilisé par les 4 suites de providers (github, google, oidc, github-app) + scripts chaos dédiés. |
| 5 | **Fixture Playwright exemplaire** (`tests/e2e/helpers/coordinator-fixture.ts`) : sous-processus réel, ports OS-assignés, polling `/livez`, capture stdout/stderr en cas d'échec, teardown SIGTERM→SIGKILL, astuce localhost pour les cookies `__Host-`. |
| 6 | **Tests « méta » rares à ce niveau** : lint-scripts testés, validation du Dockerfile, suite backcompat phase1, matrice d1-d10 ciblant explicitement les coutures d'intégration (47 Ko), self-tests de harnais. |
| 7 | **Discipline anti-flakiness dans les zones chaudes** : Clock injectable/FakeClock dans les tests de sécurité, `vi.waitFor` avec polling au lieu de sleeps fixes (`mqtt-org-scoping.test.ts:92`), ports systématiquement alloués par l'OS (`listen(0)`). |

---

## 3. Constats détaillés

Aucun constat de sévérité **critical**. Aucun constat n'a été réfuté par la contre-vérification (voir annexe).

### Sévérité HIGH

#### tests-01 — Les seuils de couverture 100 % ne sont pas appliqués en CI (`pnpm test` sans `--coverage`)

- **Sévérité** : high — **Statut** : ✅ confirmé par contre-vérification — **Effort** : S
- **Localisation** : `.github/workflows/test.yml:32`

**Preuve** : `test.yml:32` contient `- run: pnpm test` ; `package.json` définit `"test": "vitest run"` ; aucune occurrence de « coverage » dans `.github/workflows/` ni `scripts/` (grep vide). Les seuils par fichier (`vitest.config.ts:29-116`, ~50 entrées à 100 % couvrant auth/security/encryption/admin/cli) ne sont évalués que si `--coverage` est passé — `coverage.enabled: true` n'est pas défini. Aucune mitigation : `lint.yml` ne lance pas de tests, pas de hooks husky/pre-push. Le dépôt reconnaît lui-même ce gap (`docs/superpowers/working/v0.10.5-idp-encryption/round2/03-test-coverage.md:35` : « GAP — no CI-level test that runs vitest --coverage »).

**Explication** : le projet a bâti toute sa politique de non-régression sécurité sur des seuils 100 % branches/lignes par fichier pour 40+ fichiers auth/encryption/audit — mais la CI exécute vitest sans coverage. Concrètement, un PR externe supprimant des tests de `src/auth/refresh-rotation.ts` ou ajoutant des branches non couvertes dans `csrf.ts` passe la CI verte. Le run local avec `--coverage` passe aujourd'hui (vérifié, exit 0, ~4 min 20), donc le correctif est indolore. Avec l'arrivée de contributeurs externes depuis la v0.11, c'est **le maillon manquant le plus rentable de tout le dispositif** — garde de non-régression sécurité inopérante, sans exploitabilité directe toutefois.

**Recommandation** : remplacer `pnpm test` par `pnpm vitest run --coverage` dans `test.yml` (ou ajouter un script `test:ci`). Runtime mesuré ~4 min 20 en local, largement dans le budget `timeout-minutes: 15` du job (`test.yml:19`).

---

### Sévérité MEDIUM

#### tests-02 — Les 84 tests du SDK (`sdk/tests`) ne tournent dans aucune CI

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié — **Effort** : S
- **Localisation** : `sdk/package.json:18`

**Preuve** : `sdk` est un package privé séparé avec son propre `"test": "vitest run"` ; grep « sdk » dans `.github/workflows/*.yml` ne retourne rien ; l'include racine de vitest (`tests/**/*.test.ts`) ne matche pas `sdk/tests/`. Run manuel : PASS (84), FAIL (0).

**Explication** : les 7 fichiers de tests du SDK TypeScript (client, discovery, profiles, refresh-strategy, single-flight, storage, keytar-store) passent en local mais ne sont exécutés par aucun workflow. Le SDK peut donc régresser silencieusement — d'autant qu'il rejoue le contrat OAuth du serveur (refresh-on-401, single-flight) et que la spec e2e refresh-on-401 dépend de ce comportement.

**Recommandation** : ajouter un job (ou une step) au workflow Tests : `cd sdk && npm ci && npm test`. Coût CI ~1 min.

#### tests-03 — Couche handlers d'outils MCP faiblement couverte : consultation-tools 33 %, status-tools 10 %, mqtt-tools 21 %

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié — **Effort** : M
- **Localisation** : `src/tools/consultation-tools.ts:1`

**Preuve** : lcov — `status-tools.ts` 3/29 lignes (10,3 %), `mqtt-tools.ts` 4/19 (21,1 %), `consultation-tools.ts` 28/85 (32,9 %). Les smoke tests (mcp-stdio-smoke, mcp-http-smoke) n'appellent que 4 outils sur 26 (`register_agent`, `announce_work`, `list_threads`, `coordinator_status`) ; `mcp-tool-org-scoping.test.ts` ne couvre que agents/files/dependencies-tools ; `consultation-tools-schema.test.ts` ne teste que le schéma zod de `list_threads`.

**Explication** : la logique métier sous-jacente est excellemment couverte (`consultation.ts` 99,5 %, `impact-scorer` 99,1 %), mais la couche wrapper MCP — celle qui lit `extra.sessionId`, résout les claims et scope par org — est justement celle qui a déjà porté un bug de production (#133 : sessionId `undefined` en stdio cassait tous les handlers). 16 des 26 outils (les 11 de consultation + 3 mqtt + 2 status) n'ont aucun test de handler in-process.

**Recommandation** : étendre le pattern éprouvé de `mcp-tool-org-scoping.test.ts` (invocation du handler via `_registeredTools` avec `fakeExtra`) à consultation-tools, status-tools et mqtt-tools — au minimum un appel nominal + un appel sans session par outil. Alternativement, élargir les smoke tests pour appeler chaque outil une fois.

#### tests-04 — Le hook d'authentification MQTT de production n'est jamais exercé : les tests en dupliquent le code

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié — **Effort** : S
- **Localisation** : `tests/unit/b3-mqtt-auth.test.ts:61`

**Preuve** : `b3-mqtt-auth.test.ts:61-70` définit un `verify` local (copie du hook) et l'appelle directement ; `mqtt-org-scoping.test.ts:22-28` injecte lui aussi son propre `authenticate`. Le hook réel vit dans `src/serve-http.ts:611-620` (branche `AUTH_ENABLED`) et aucun test ne démarre `startServer` avec auth activée pour connecter un client MQTT avec un token invalide.

**Explication** : les tests « B3 opt-in MQTT JWT auth » valident `verifyToken` (déjà couvert ailleurs) mais pas le câblage production. Si `serve-http.ts` oublie de passer `authenticate`, avale l'erreur différemment, ou si la duplication dérive (ex. `verifyToken` vs `verifyTokenStrict` — les deux copies de test diffèrent déjà sur ce point), les tests restent verts. Un broker acceptant alors des connexions anonymes serait une régression de sécurité invisible pour la suite.

**Recommandation** : ajouter un test d'intégration qui démarre `startServer({...})` avec `COORDINATOR_AUTH_ENABLED=true` et vérifie qu'un `mqtt.connect` avec mauvais password est refusé (CONNACK erreur) et qu'un JWT valide passe — le harnais de mqtt-org-scoping se réutilise presque tel quel.

#### tests-05 — Le dashboard principal (`index.html`, ~77 fonctions JS inline) n'a aucun test, ni e2e ni unitaire

- **Sévérité** : medium — **Statut** : ⚠️ non contre-vérifié — **Effort** : M
- **Localisation** : `dashboard/public/index.html:1`

**Preuve** : `index.html` = 63,2 Ko avec ~77 fonctions inline. Les 14 `goto()` des specs Playwright ne visitent que `/auth/*` et `/dashboard/admin*.html` — jamais la page dashboard principale. Contraste : `admin-common.js` / `admin-strings.js` sont couverts à 98-100 %.

**Explication** : la page qui affiche agents, consultations et flux SSE en direct — la vitrine du produit — est le plus gros bloc de code non testé du dépôt. L'historique récent confirme le risque : le commit « fix(dashboard): split Clear (UI-only) from Reset Server (destructive, gated) » corrige précisément un bug de cette page, y compris un chemin destructif. L'infrastructure Playwright existe déjà (`coordinator-fixture`) ; seul le spec manque.

**Recommandation** : ajouter un spec Playwright smoke : charger `/dashboard/`, vérifier le rendu de la liste d'agents après un `register_agent` via l'API, vérifier qu'un événement SSE met à jour le DOM, et pinner le gating du bouton Reset Server. 3-4 tests suffisent.

---

### Sévérité LOW / INFO

#### tests-06 — Zones serveur les moins mesurées : `serve-http.ts` 47,5 %, `handle-rest.ts` 63,7 %, `mqtt-bridge.ts` 60 %

- **Sévérité** : low — **Statut** : ⚠️ non contre-vérifié — **Effort** : M
- **Localisation** : `src/serve-http.ts:1`

**Preuve** : lcov — `serve-http.ts` 155/326 lignes, `http/handle-rest.ts` 163/256, `mqtt-bridge.ts` 57/95, `quota/credential-reader.ts` 6/27, `src/index.ts` 0/12.

**Explication** : une partie de ce déficit est un **angle mort de mesure** plutôt qu'une absence de tests : les e2e Playwright et les smoke stdio lancent ces fichiers en sous-processus (tsx), dont la couverture V8 n'est pas collectée — `src/index.ts` affiche 0 % alors que mcp-stdio-smoke l'exerce réellement. Restent néanmoins de vraies zones non testées : branches d'erreur de handle-rest, reconnexion mqtt-bridge, chemins 503 du quota. `credential-reader` est macOS-only (intestable en CI Windows/Linux), acceptable.

**Recommandation** : ne pas viser 100 % ici ; cibler les branches d'erreur de `handle-rest.ts` (payloads invalides, 404/409) via le serveur in-process déjà utilisé par `rest-context-auth-threading.test.ts`, et un test de reconnexion pour mqtt-bridge. Documenter que `index.ts`/`serve-http.ts` sont partiellement couverts hors-process.

#### tests-07 — Race assumée dans channel-smoke : sleep fixe de 1,5 s au lieu d'attendre le signal de readiness

- **Sévérité** : low — **Statut** : ⚠️ non contre-vérifié — **Effort** : S
- **Localisation** : `tests/integration/channel-smoke.test.ts:106`

**Preuve** : commentaire dans le test lui-même — « Wait for the subprocess to wire up its MQTT subscriptions before we publish — without this we race the SUBSCRIBE packet. The CLI prints "[channel] subscriptions active" on stderr once ready; we just sleep a beat » → `setTimeout(resolve, 1500)` (et un second sleep de 1 500 ms ligne 305).

**Explication** : le commentaire documente lui-même la course : sous charge CI (runner partagé, premier spawn tsx froid), 1,5 s peut ne pas suffire et le PUBLISH partirait avant le SUBSCRIBE, faisant échouer le test par intermittence. Le signal de readiness existe déjà (« [channel] subscriptions active » sur stderr) mais n'est pas consommé. C'est le seul sleep « direction dangereuse » repéré dans la suite CI.

**Recommandation** : attendre la ligne « [channel] subscriptions active » sur le stderr du sous-processus (avec timeout 10 s) au lieu du sleep fixe ; garder le sleep en fallback si besoin.

#### tests-08 — CLI : commandes exclues de la mesure de couverture et `uninstall` (destructif, `rmSync`) sans aucun test

- **Sévérité** : low — **Statut** : ⚠️ non contre-vérifié — **Effort** : S
- **Localisation** : `cli/uninstall.ts:73`

**Preuve** : `cli/uninstall.ts` fait `rmSync(target)` lignes 73, 109 et 139 ; grep « uninstall » dans `tests/` ne retourne rien. L'include coverage (`vitest.config.ts:14-24`) ne couvre que `cli/lib/**` et `cli/encryption/**` — `doctor.ts` (28,6 Ko), `init.ts` (26,4 Ko), `channel.ts` (21,2 Ko) sont testés mais non mesurés ; `uninstall.ts`, `logs.ts`, `stop.ts`, `cli/service-tokens.ts`, `version.ts`, `dashboard.ts` n'ont aucun test.

**Explication** : la plupart des commandes CLI importantes ont des tests in-process (init, doctor, config, channel, backup/restore, rotate-jwt-secret), mais leur couverture n'est pas mesurée, et la seule commande qui **supprime les données utilisateur** n'a aucun filet : une régression dans la résolution du répertoire cible d'uninstall supprimerait le mauvais dossier sans qu'aucun test ne le voie. Le pattern sandbox HOME/USERPROFILE existe déjà dans `backup-restore.test.ts`.

**Recommandation** : 1) ajouter `cli/**/*.ts` à `coverage.include` pour rendre les angles morts visibles ; 2) écrire un test sandboxé d'uninstall (réutiliser `makeSandbox` de `backup-restore.test.ts`) vérifiant que seuls les chemins attendus sous le faux HOME sont supprimés.

#### tests-09 — fast-check sous-exploité (2 propriétés) et propriété CSRF théoriquement auto-réfutable

- **Sévérité** : low — **Statut** : ⚠️ non contre-vérifié — **Effort** : S
- **Localisation** : `tests/unit/csrf.test.ts:57`

**Preuve** : seulement 2 `fc.assert` dans toute la suite (`csrf.test.ts:58`, `oauth-state.test.ts:225`). La propriété csrf génère deux `fc.uint8Array` indépendants et affirme `verifyCsrfToken(a,b) === false` — si fast-check (qui biaise vers les valeurs extrêmes, ex. tout-zéros) produit `a === b`, la propriété échoue à tort.

**Explication** : fast-check est installé et bien utilisé là où il est présent, mais son potentiel est inexploité sur les cibles idéales du projet : path-normalize/path-guard (traversée de chemins, séparateurs Windows), html-escape, parsing de topics MQTT org-scopés. Par ailleurs la propriété « deux tokens différents ne matchent jamais » ne garantit pas que les deux tableaux générés diffèrent — flake improbable mais gratuit à éliminer.

**Recommandation** : ajouter `fc.pre(!a.every((v,i)=>v===b[i]))` dans la propriété csrf. Opportuniste : 3-4 propriétés sur path-normalize/path-guard et html-escape (invariants « jamais de `..` résiduel », « aucun caractère `<` `>` non échappé »), zones où le fuzzing paie le plus.

#### tests-10 — Suite entièrement sérialisée à cause de singletons de module — discipline manuelle de reset entre fichiers

- **Sévérité** : info — **Statut** : ⚠️ non contre-vérifié — **Effort** : L
- **Localisation** : `vitest.config.ts:10`

**Preuve** : `fileParallelism: false` (`vitest.config.ts:10`) ; `b3-mqtt-auth.test.ts:24-28` : « CRITICAL: … Reset module state to canonical values so subsequent test files in the same worker don't pick up the contaminated signing key ».

**Explication** : l'état global des modules (`initAuth`, `initDatabase`) impose l'exécution sérielle des 2 337 tests (~4 min avec coverage — encore confortable) et des `afterEach` « CRITICAL » de décontamination manuelle. Ça fonctionne aujourd'hui et le coût d'une injection systématique ne se justifie pas encore (YAGNI), mais chaque nouveau test qui oublie son reset peut empoisonner les fichiers suivants d'une manière difficile à déboguer — à garder en tête si la suite double de taille.

**Recommandation** : rien d'urgent. Si le temps de suite dépasse ~8-10 min, envisager d'isoler les fichiers contaminants dans un pool dédié ou de généraliser le seam Clock/DI déjà présent dans les tests Phase 2 (oauth-state, csrf) qui, eux, sont parallélisables.

#### tests-11 — Scripts perf/chaos hors CI par choix documenté — pas de suivi de régression des JSON_SUMMARY

- **Sévérité** : info — **Statut** : ⚠️ non contre-vérifié — **Effort** : S
- **Localisation** : `tests/perf/README.md:3`

**Preuve** : « Operator-only performance benchmarks and chaos-injection scripts … Not part of npm test; not for shared-runner CI » ; chaque script émet une ligne `JSON_SUMMARY: {...}` décrite comme « easy to grep/parse for dashboard or regression-tracking ingestion » — aucun consommateur n'existe.

**Explication** : les 5 scripts (bench-refresh-rotation, bench-audit-queue, bench-token-epoch, chaos idp/audit) sont soignés, documentés (`docs/ops/perf-bench.md`, overrides d'env) et exécutables à la main — ce n'est pas de la lettre morte, mais un outillage opérateur assumé. Le seul écart est que le format d'ingestion promis n'est branché nulle part : les chiffres de référence ne seront comparés que si quelqu'un y pense. Pour un mainteneur solo, c'est un arbitrage défendable.

**Recommandation** : option à coût quasi nul si souhaité : un workflow manuel (`workflow_dispatch`) mensuel qui exécute les benchs et archive les JSON_SUMMARY en artefacts, pour disposer d'un historique sans bruit de runner partagé. Sinon, ne rien faire.

---

## 4. Recommandations priorisées

### Quick wins (effort S)

| Priorité | Constat | Action | Impact |
|---|---|---|---|
| 1 | tests-01 (high, ✅) | Passer `test.yml` à `pnpm vitest run --coverage` (ou script `test:ci`) | Rend enfin opérante toute la politique de seuils 100 % sur les fichiers de sécurité — protection directe contre les régressions des PR externes. ~4 min 20, dans le budget `timeout-minutes: 15`. |
| 2 | tests-02 (medium) | Ajouter une step CI `cd sdk && npm ci && npm test` | Les 84 tests du SDK cessent d'être invisibles ; protège le contrat OAuth refresh-on-401 / single-flight. ~1 min de CI. |
| 3 | tests-04 (medium) | Test d'intégration `startServer` + `COORDINATOR_AUTH_ENABLED=true` + client MQTT (rejet mauvais token / acceptation JWT valide) | Ferme un trou de régression sécurité (broker acceptant l'anonyme) que la suite actuelle ne verrait pas ; élimine la duplication du hook. |
| 4 | tests-07 (low) | Remplacer les 2 sleeps de 1,5 s de channel-smoke par l'attente de « [channel] subscriptions active » sur stderr (timeout 10 s) | Supprime la seule source de flakiness « direction dangereuse » identifiée dans la suite CI. |
| 5 | tests-08 (low) | Ajouter `cli/**/*.ts` à `coverage.include` + test sandboxé d'`uninstall` | Rend visibles les angles morts CLI ; filet sur la seule commande destructive du CLI. |
| 6 | tests-09 (low) | `fc.pre(...)` dans la propriété csrf ; 3-4 propriétés sur path-guard / html-escape | Élimine un flake théorique gratuit ; exploite fast-check là où le fuzzing paie le plus. |

### Chantiers moyens (effort M)

| Priorité | Constat | Action |
|---|---|---|
| 7 | tests-03 (medium) | Étendre le pattern `_registeredTools` + `fakeExtra` aux 16 outils MCP sans test de handler (un appel nominal + un appel sans session par outil) — c'est la couche qui a déjà porté le bug #133. |
| 8 | tests-05 (medium) | Spec Playwright smoke pour `/dashboard/` : rendu de la liste d'agents après `register_agent`, mise à jour SSE du DOM, gating du bouton Reset Server (3-4 tests, la fixture existe déjà). |
| 9 | tests-06 (low) | Cibler les branches d'erreur de `handle-rest.ts` (payloads invalides, 404/409) in-process + test de reconnexion mqtt-bridge ; documenter la couverture hors-process de `index.ts`/`serve-http.ts`. |

### Chantiers de fond (effort L) — non urgents

- **tests-10** : surveiller la durée de suite (~4 min aujourd'hui). Si elle dépasse ~8-10 min, isoler les fichiers à état de module contaminant dans un pool dédié ou généraliser le seam Clock/DI des tests Phase 2 pour rouvrir la parallélisation.
- **tests-11** (S, optionnel) : workflow `workflow_dispatch` mensuel archivant les `JSON_SUMMARY` des benchs en artefacts, pour un historique sans bruit de runner partagé.

---

## 5. Annexe — Constats écartés après contre-vérification

Aucun constat de cette dimension n'a été réfuté (verdict REFUTED) par l'agent de contre-vérification adversarial — l'annexe est donc vide.

Pour la transparence : seul le constat high (tests-01) a fait l'objet d'une contre-vérification complète (verdict **CONFIRMED**, preuve intégralement retrouvée dans le code, y compris l'aveu du gap dans la documentation interne du dépôt). Les constats de sévérité medium et inférieure n'ont pas été contre-vérifiés systématiquement et sont marqués ⚠️ dans le corps du rapport.
