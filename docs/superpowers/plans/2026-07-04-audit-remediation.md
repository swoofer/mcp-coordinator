# Remédiation de l'audit v0.13.0 — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fermer les 119 constats de l'audit (13 high, 46 medium, 42 low, 18 info) en 7 PRs thématiques, chaque constat validé par 5 rounds de vérification et coché dans `audit/TRACKING.md`.

**Architecture :** Programme décomposé en 7 sous-plans (PR 1–7) + un socle (PR 0). Chaque PR est mergeable seule ; conventional commits → release-please. Les PRs 2–7 sont enumérées ici en tâches (une par constat) et **détaillées en pas bite-sized au démarrage de chaque PR** via writing-plans — c'est la stratégie « un plan par sous-système » de la skill. PR 0 et les 3 tâches phares de PR 1 sont déjà détaillés en code réel ci-dessous.

**Tech Stack :** TypeScript ESM (Node ≥ 20), pnpm 9, vitest 4 (+ fast-check, msw), Playwright, better-sqlite3, aedes, @modelcontextprotocol/sdk ^1.12, jose, zod, pino.

## Global Constraints

- **Node ≥ 20** (`engines`), mais la CI teste **Node 22** ; toute syntaxe doit tourner sur les deux.
- **pnpm 9.15.9** épinglé via `packageManager`/Corepack — ne pas migrer vers npm/yarn.
- **Environnement de référence pour la vérification R4 = CI Linux (Node 22).** Le mainteneur est sous Windows où `pnpm test` échoue aujourd'hui (exit 127, `maintenabilite-04`) ; ce fix est dans PR 7. En attendant, exécuter la suite via `pnpm vitest run` (contourne les scripts bash) localement.
- **Gate de couverture 100 % par fichier** (vitest.config.ts) : tout code touché sur les ~50 fichiers sécurité doit rester à 100 % de branches, sinon R4 échoue. C'est voulu.
- **Suite sérialisée** (singletons de module) : ne pas introduire de parallélisme cassant l'isolation (`tests-10`).
- **Conventional commits** obligatoires (release-please) : `fix(scope):`, `feat(scope):`, `ci:`, `docs:`, `refactor(scope):`, `test(scope):`, `chore:`.
- **5 lints bash custom** doivent rester verts : `lint-no-direct-env-in-auth`, `html-escape`, `no-audit-mutation`, `no-current-timestamp`, `no-users-org-id`.

## Protocole de vérification — 5 rounds par tâche

Défini en détail dans le spec (`docs/superpowers/specs/2026-07-04-audit-remediation-design.md` §4). Rappel court, **appliqué à CHAQUE tâche** :

1. **R1 Reproduction (rouge)** — test qui échoue et démontre le défaut (ou capture de l'état défaillant pour les fix non-code).
2. **R2 Correction unitaire (vert)** — fix + le test passe + cas limites + `tsc --noEmit` propre.
3. **R3 Intégration bout-en-bout** — test au point d'entrée public réel (serveur HTTP démarré, client MCP stdio, commande CLI, run CI). **Round anti-« garde-fou fantôme ».**
4. **R4 Régression & statique** — `pnpm vitest run --coverage` + gate + `tsc --noEmit` + 5 lints bash, tous verts, sans baisse de couverture.
5. **R5 Adversarial / réel** — piloter le système réel (`/verify`) + assertion négative (prouver que ce qui doit désormais échouer, échoue).

Chaque case R1–R5 se coche dans `audit/TRACKING.md`. Une tâche n'est terminée qu'à 5/5.

---

## PR 0 — Socle (à faire en premier)

**But :** poser les fondations de vérification et de suivi avant toute correction, et débloquer le contributeur externe. Rien ici ne dépend d'un autre PR ; tout le reste dépend de PR 0.

### Task 0.1 : Committer l'audit et créer le suivi

**Files:**
- Create: `audit/TRACKING.md` (généré, voir §TRACKING plus bas)
- Add: `audit/*.md` (11 rapports + synthèse, déjà sur disque, non committés)

- [ ] **Step 1 :** Vérifier l'état : `git status --short` → attendu : `audit/` en untracked.
- [ ] **Step 2 :** Créer la branche : `git checkout -b chore/audit-remediation-socle`
- [ ] **Step 3 :** Committer l'audit + le suivi + spec + plan :
```bash
git add audit/ docs/superpowers/specs/2026-07-04-audit-remediation-*.md docs/superpowers/plans/2026-07-04-audit-remediation.md
git commit -m "docs(audit): add full audit report, remediation spec, plan and tracking matrix"
```

### Task 0.2 : Répondre à la PR externe #151 (`maintenabilite-01`, 🔴 High)

**Action process, pas du code.** Le contributeur attend depuis 6,5 semaines.

- [ ] **R1 :** Capturer l'état : `gh pr view 151 --json state,updatedAt,title,author` → prouver l'absence de réponse.
- [ ] **R2 :** Poster un accusé de réception + approuver l'exécution des workflows : `gh pr comment 151 --body "..."` puis review.
- [ ] **R3 :** La PR reçoit un statut (approuvée / changements demandés) visible : `gh pr view 151 --json reviews`.
- [ ] **R4 :** N/A (pas de code local) — noter « process ».
- [ ] **R5 :** Vérifier qu'une règle de triage 72 h est ajoutée à `CONTRIBUTING.md` (fusion avec `documentation-14`/PR 6) ou notée dans `HANDOFF.md`.
- [ ] **Commit** (si edit CONTRIBUTING) : `docs(contributing): add 72h external-PR triage rule`

### Task 0.3 : Activer le gate de couverture en CI (`tests-01`, 🔴 High)

**Files:**
- Modify: `.github/workflows/test.yml:32`
- Add script: `package.json` (`test:ci`)

- [ ] **R1 (Reproduction) :** Prouver que la CI ne mesure pas la couverture : `Grep "pnpm test" .github/workflows/test.yml` → ligne 32 lance `pnpm test` (= `vitest run`, sans `--coverage`). Les seuils de vitest.config.ts ne sont donc jamais évalués en CI.
- [ ] **R2 (Correction) :** Ajouter un script `test:ci` à `package.json` :
```json
"test:ci": "vitest run --coverage",
```
Puis modifier `.github/workflows/test.yml` ligne 32 :
```yaml
      - run: pnpm test:ci
```
- [ ] **R3 (Intégration) :** Lancer localement le run réel que la CI exécutera : `pnpm test:ci` → attendu : PASS avec un tableau de couverture, et **échec** si on abaisse volontairement un seuil (test du gate). Vérifier que le run tient dans `timeout-minutes: 15` (mesuré ~4 min 20).
- [ ] **R4 (Régression) :** `pnpm vitest run --coverage` vert + `tsc --noEmit` + 5 lints.
- [ ] **R5 (Adversarial) :** Ouvrir une PR jetable qui baisse une branche non couverte → confirmer que **le job CI échoue** (le gate mord réellement). Refermer la PR jetable.
- [ ] **Commit :** `ci: enforce coverage thresholds in CI (pnpm test:ci with --coverage)`

> Note : `tests-01` est listé dans PR 3 dans la matrice, mais **exécuté ici en PR 0** car il protège tous les PRs suivants. Le cocher dans TRACKING sous PR 3 (même ligne).

---

## PR 1 — Sécurité durcissement (17 constats, 4 High)

**But :** fermer le risque n°1 (exposition LAN par défaut) et le cluster sécurité. Branche `fix/audit-pr1-security`. Les 3 tâches phares ci-dessous sont détaillées en code ; les 14 autres suivent le protocole 5-rounds à partir de la recommandation du rapport `audit/03-securite-auth.md` / `audit/04-securite-surface.md`.

### Task 1.1 : Lier le serveur à 127.0.0.1 par défaut (`securite-surface-01` + `documentation-01`, 🔴 High)

**Files:**
- Modify: `src/serve-http.ts` (résolution du host + appel `listen`, ~ligne 660)
- Modify: `docs/usage.md:49`, `.env.example` (aligner la doc)
- Test: `tests/integration/bind-host.test.ts` (créer)

**⚠️ Vérifié contre le code réel (2026-07-04) :** `ServerHandle` (serve-http.ts:358) = `{ port, stop }` — **n'expose PAS `httpServer`**. Le test ci-dessous **exige** qu'on l'ajoute (fait en R2). `ServerOptions` (serve-http.ts:327) porte bien `port`/`mqttTcpPort`/`mqttWsPath`. `httpServer.listen` est bien appelé sans host (serve-http.ts:660) → bind sur toutes interfaces confirmé.

**Interfaces :**
- Produces : `ServerHandle` gagne un champ `httpServer: import("node:http").Server` ; `startServer` lit `COORDINATOR_BIND` (défaut `127.0.0.1`) et le passe à `httpServer.listen(port, host, cb)`.

- [ ] **R1 (Reproduction) :** Écrire le test d'intégration qui échoue :
```ts
// tests/integration/bind-host.test.ts
import { it, expect, afterEach } from "vitest";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import type { AddressInfo } from "node:net";

let handle: ServerHandle | undefined;
afterEach(async () => { await handle?.stop(); handle = undefined; delete process.env.COORDINATOR_BIND; });

it("binds to 127.0.0.1 by default (not 0.0.0.0)", async () => {
  handle = await startServer({ port: 0, mqttTcpPort: 0, mqttWsPath: "/mqtt" });
  // NB : dépend de l'ajout de `httpServer` au handle (R2). Sans lui, ce test ne compile pas — c'est voulu (rouge).
  const addr = handle.httpServer.address() as AddressInfo;
  expect(addr.address).toBe("127.0.0.1");
});
```
- [ ] **R2 (Correction) :** Deux changements dans `src/serve-http.ts`.
  1. Étendre l'interface `ServerHandle` (ligne 358) pour exposer le serveur (nécessaire au test, utile aux embedders) :
```ts
export interface ServerHandle {
  port: number;
  httpServer: import("node:http").Server;
  stop: () => Promise<void>;
}
```
  … et ajouter `httpServer` à l'objet retourné par `startServer` (le `return { port, ..., stop }`).
  2. Avant le bloc `httpServer.listen` (~656), résoudre le host et le passer en 2e argument :
```ts
const bindHost = process.env.COORDINATOR_BIND?.trim() || "127.0.0.1";
// ...
httpServer.listen(port, bindHost, () => {
  httpServer.off("error", onError);
  log.info({ port, host: bindHost, /* ...existing fields... */ }, "Coordinator v3 started");
  resolve();
});
```
`tsc --noEmit` propre.
- [ ] **R3 (Intégration) :** `pnpm vitest run tests/integration/bind-host.test.ts` → PASS. Ajouter un cas `COORDINATOR_BIND=0.0.0.0` qui vérifie que l'override fonctionne.
- [ ] **R4 (Régression) :** `pnpm vitest run --coverage` + `tsc --noEmit` + 5 lints.
- [ ] **R5 (Adversarial) :** Démarrer le vrai serveur (`pnpm dev`) sur une machine du LAN, `curl http://<ip-lan>:<port>/livez` depuis une autre machine → **connexion refusée** ; `curl http://127.0.0.1:<port>/livez` → 200. Corriger `docs/usage.md:49` et `.env.example` pour refléter le vrai défaut. `/verify`.
- [ ] **Commit :** `fix(security): bind HTTP server to 127.0.0.1 by default via COORDINATOR_BIND`

### Task 1.2 : Valider l'Origin + restreindre le CORS (`protocole-mcp-02` + `securite-surface-06`, 🔴 High)

**Files:**
- Modify: `src/serve-http.ts:421` (préflight OPTIONS) + le montage du transport `/mcp`
- Create: `src/http/origin.ts` (helper `isAllowedOrigin`)
- Test: `tests/integration/origin-cors.test.ts`

**Interfaces :**
- Produces : `isAllowedOrigin(origin: string | undefined, publicUrl: string | undefined): boolean` — true si origin absent (client non-navigateur), localhost, ou égal à `COORDINATOR_PUBLIC_URL`.

- [ ] **R1 (Reproduction) :** Test qui échoue : une requête `OPTIONS /mcp` avec `Origin: https://evil.example` reçoit aujourd'hui `Access-Control-Allow-Origin: *`.
```ts
it("rejects cross-site Origin on /mcp preflight", async () => {
  handle = await startServer({ port: 0, mqttTcpPort: 0 });
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
});
```
- [ ] **R2 (Correction) :** Créer `src/http/origin.ts` :
```ts
export function isAllowedOrigin(origin: string | undefined, publicUrl: string | undefined): boolean {
  if (!origin) return true; // non-browser client (curl, MCP SDK) — no Origin header
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") return true;
    if (publicUrl && origin === new URL(publicUrl).origin) return true;
  } catch { /* malformed Origin */ }
  return false;
}
```
Dans le préflight OPTIONS (`serve-http.ts:421`), remplacer `"*"` par l'origin reflété seulement s'il est autorisé, sinon 403. Idéalement, passer `allowedHosts`/`enableDnsRebindingProtection` au `StreamableHTTPServerTransport`.
- [ ] **R3 (Intégration) :** Test au vrai serveur : Origin localhost → autorisé ; Origin evil → 403 ; pas d'Origin → autorisé (client MCP SDK inchangé).
- [ ] **R4 (Régression) :** suite + coverage + tsc + lints ; **vérifier que le client MCP SDK sur HTTP passe toujours** (harnais d'intégration MCP existant).
- [ ] **R5 (Adversarial) :** `curl -H "Origin: https://evil.example" http://127.0.0.1:<port>/mcp` → refusé ; le vrai dashboard (`COORDINATOR_PUBLIC_URL`) → autorisé. `/verify`.
- [ ] **Commit :** `fix(security): validate Origin and restrict CORS on /mcp (MCP spec MUST)`

### Task 1.3 : Distinguer access-token et refresh-token par un claim `typ` (`securite-auth-01`, 🔴 High)

**⚠️ Vérifié contre le code réel (2026-07-04) :** `verifyPhase2SessionCookie` (auth.ts:254) est **interne (non exportée)** — un test ne peut pas l'importer. Entrée publique réelle = `authenticateRequest(req, opts)` (auth.ts:379), qui appelle `verifyPhase2SessionCookie` (auth.ts:412 pour le cookie `__Host-coordinator_session`, auth.ts:453 pour le Bearer). Le mint Phase 2 est `mintAccessJWT`/`mintRefreshJWT` (auth/jwt-mint.ts). Le contrôle `typ` doit donc être posé dans `verifyPhase2SessionCookie` (chemin accès/session) et dans le chemin de vérif refresh (refresh-rotation.ts), et testé via `authenticateRequest`.

**Files:**
- Modify: `src/auth/jwt-mint.ts` (ajouter `typ` au payload des deux mints)
- Modify: `src/auth.ts` (dans `verifyPhase2SessionCookie`, ~254-346 : rejeter `typ !== "access"`) + `src/auth/refresh-rotation.ts` (chemin de vérif refresh : rejeter `typ !== "refresh"`)
- Test: `tests/unit/token-type-confusion.test.ts` (pilote `authenticateRequest`, l'entrée publique)

**Interfaces :**
- Produces : `mintAccessJWT` émet `typ: "access"`, `mintRefreshJWT` émet `typ: "refresh"` ; `verifyPhase2SessionCookie` (via `authenticateRequest`) rejette un jeton dont `typ !== "access"`.

- [ ] **R1 (Reproduction) :** Test qui échoue via l'**entrée publique** `authenticateRequest` — minter un refresh-token, le présenter comme cookie de session, prouver qu'il est **accepté** aujourd'hui. Construire une requête `IncomingMessage` factice portant le cookie `__Host-coordinator_session=<refreshJwt>` (réutiliser le helper de forge de requête des tests auth existants ; sinon un `{ headers: { cookie: ... }, method: "GET", url: "/api/..." } as IncomingMessage`). Le claims du refresh doit être un objet réel (`{ sub, active_org_id, family_id }`, cf. `RefreshTokenClaims` dans jwt-mint.ts), et `registry`/`issuer` viennent du setup de test Phase 2 (voir `tests/` OAuth existants) :
```ts
it("rejects a refresh token presented as a session cookie", async () => {
  const { jwt } = await mintRefreshJWT({
    claims: { sub: "u1", active_org_id: "org1", family_id: "fam1" },
    registry, issuer, ttlSeconds: 3600,
  });
  const req = forgeReq({ cookie: `__Host-coordinator_session=${jwt}` }); // helper de test
  const result = await authenticateRequest(req, { authEnabled: true });
  expect(result.ok).toBe(false); // ROUGE avant le fix : actuellement accepté
});
```
- [ ] **R2 (Correction) :** Dans `jwt-mint.ts`, ajouter le claim au payload :
```ts
// mintAccessJWT
const builder = new SignJWT({ ...opts.claims, typ: "access" })
// mintRefreshJWT
const builder = new SignJWT({ ...opts.claims, typ: "refresh" })
```
Dans `auth.ts` (chemin d'accès/session, avant la dérivation du rôle ~346), rejeter si `claims.typ !== "access"` ; dans le chemin de vérification refresh, rejeter si `claims.typ !== "refresh"`. Retourner 401 `invalid_token`.
- [ ] **R3 (Intégration) :** Flow bout-en-bout via le vrai serveur : login → obtenir access + refresh ; présenter le refresh sur un endpoint protégé → 401 ; présenter l'access → 200 ; rotation refresh normale → toujours OK.
- [ ] **R4 (Régression) :** suite complète (les tests de rotation/refresh existants doivent rester verts) + coverage 100 % sur `jwt-mint.ts`/`auth.ts` + tsc + lints.
- [ ] **R5 (Adversarial) :** Confirmer les deux négatifs : refresh-as-access **rejeté**, ET un vieux token sans `typ` (émis avant le fix) — décider de la compat (grâce courte ou rejet) et le tester explicitement. `/verify`.
- [ ] **Commit :** `fix(security): add typ claim to distinguish access vs refresh tokens`

### Tâches restantes de PR 1

Chacune suit les 5 rounds ci-dessus ; détail du fix dans `audit/03-securite-auth.md` / `audit/04-securite-surface.md`. À expliciter en pas bite-sized au démarrage de PR 1.

#### Tâches PR1 (17 constats) — chaque tâche suit les 5 rounds

| ☐ | ID | Sév | Eff | Fichier ancre | Constat |
|---|----|-----|-----|---------------|---------|
| [ ] | `documentation-01` | 🔴H | S | `docs/usage.md:49` | COORDINATOR_BIND documenté mais inexistant, et le bind par défaut annoncé (127.0.0.1) est faux |
| [ ] | `protocole-mcp-02` | 🔴H | M | `src/serve-http.ts:421` | Streamable HTTP : aucune validation de l'en-tête Origin (« MUST » de la spec) + CORS wildcard avec auth désactivée par défaut |
| [ ] | `securite-auth-01` | 🔴H | M | `src/auth.ts:346` | Confusion de type de jeton : un refresh-token est accepté comme jeton de session/accès (aucun claim `typ`/`aud`) |
| [ ] | `securite-surface-01` | 🔴H | S | `src/serve-http.ts:660` | Le serveur HTTP écoute sur toutes les interfaces ; COORDINATOR_BIND (défaut documenté 127.0.0.1) n'est jamais lu |
| [ ] | `architecture-05` | 🟠M | S | `cli/server/start.ts:66` | L'allowlist env du mode daemon a dérivé : OAuth Phase 2 et rotation JWT silencieusement désactivés |
| [ ] | `protocole-mcp-04` | 🟠M | M | `src/tools/consultation-tools.ts:127` | Les outils MCP ignorent claims.sub : n'importe quel appelant authentifié peut agir au nom de n'importe quel agent_id de son org |
| [ ] | `securite-surface-02` | 🟠M | S | `src/serve-http.ts:521` | /metrics servi sans authentification ; le handler /metrics/auth (localhost+bearer) est du code mort |
| [ ] | `securite-surface-03` | 🟠M | M | `src/tools/mqtt-tools.ts:39` | Isolation inter-agents absente sur les outils MCP MQTT (lecture de la file d'un autre agent) |
| [ ] | `securite-auth-02` | 🟡L | S | `src/auth/providers/google.ts:102` | Le provider Google ne vérifie pas le nonce OIDC de l'id_token |
| [ ] | `securite-auth-03` | 🟡L | M | `src/auth.ts:389` | Transport du JWT via query-string `?token=` sur les requêtes GET (SSE) |
| [ ] | `securite-auth-04` | 🟡L | S | `src/auth/refresh-rotation.ts:817` | Le rôle n'est pas re-dérivé depuis la base lors de la rotation de refresh (codé en dur à 'member') |
| [ ] | `securite-surface-04` | 🟡L | S | `src/logger.ts:49` | Logger Phase 1 sans redaction des secrets (les deux loggers divergent) |
| [ ] | `securite-surface-05` | 🟡L | S | `src/serve-http.ts:123` | Endpoint Phase 1 /api/auth/register sans rate-limiting ni lockout |
| [ ] | `securite-surface-06` | 🟡L | S | `src/http/utils.ts:38` | CORS wildcard générique et transport du JWT via ?token= sur les GET |
| [ ] | `securite-surface-07` | 🟡L | S | `src/serve-http.ts:499` | En-têtes de sécurité absents sur le dashboard principal et les réponses API |
| [ ] | `protocole-mcp-12` | ⚪I | M | `src/http/utils.ts:58` | Auth du endpoint /mcp non conforme à la spec d'autorisation MCP : pas de resource_metadata dans WWW-Authenticate, pas de /.well-known/oauth-protected-resource |
| [ ] | `securite-auth-05` | ⚪I | S | `src/auth/cookies.ts:89` | L'échappatoire COORDINATOR_INSECURE_COOKIES est inerte pour les cookies Phase 2 (footgun latent) |

---

## PR 2 → PR 7 — Tâches enumérées

> Chaque PR ci-dessous démarre par : `git checkout -b fix/audit-prN-<thème>` sur un socle rebasé, puis **expansion en pas bite-sized via writing-plans** (lire la recommandation du rapport `audit/NN-*.md` correspondant à chaque constat). Chaque tâche = un constat = les 5 rounds = une ligne cochée dans `audit/TRACKING.md`. Décisions YAGNI déjà tranchées (spec §3) : `release-binaries` → réparer ; `/metrics/auth` → câbler ; SDK → aligner version, ne pas publier.

#### Tâches PR2 (13 constats) — chaque tâche suit les 5 rounds

| ☐ | ID | Sév | Eff | Fichier ancre | Constat |
|---|----|-----|-----|---------------|---------|
| [ ] | `architecture-01` | 🔴H | M | `src/discovery.ts:40` | Endpoints implémentés et documentés mais jamais montés sur le serveur (/.well-known/oauth-authorization-server et /metrics/auth) |
| [ ] | `documentation-02` | 🔴H | M | `README.md:217` | /metrics/auth et COORDINATOR_METRICS_BEARER documentés partout mais l'endpoint n'est jamais routé |
| [ ] | `protocole-mcp-01` | 🔴H | S | `src/logger.ts:33` | Mode stdio : logs applicatifs écrits sur stdout, en violation du transport stdio MCP (« MUST NOT ») |
| [ ] | `protocole-mcp-03` | 🔴H | S | `src/discovery.ts:40` | Endpoints documentés, testés et consommés par le SDK/doctor jamais câblés dans le routeur : /.well-known/oauth-authorization-server, /healthz, /health/ready |
| [ ] | `protocole-mcp-05` | 🟠M | S | `src/tools/dependencies-tools.ts:20` | set_dependency_map : paramètre JSON double-encodé, sans description de schéma, erreur brute non actionnable |
| [ ] | `protocole-mcp-06` | 🟠M | S | `src/mqtt-bridge.ts:278` | Mode stdio : les outils MQTT sont exposés mais mentent silencieusement (mqtt_publish répond « published » sans broker) |
| [ ] | `protocole-mcp-07` | 🟠M | M | `src/serve-http.ts:409` | Sessions Streamable HTTP jamais expirées : fuite des Maps sessions/sessionClaims quand le client disparaît sans DELETE |
| [ ] | `protocole-mcp-08` | 🟡L | S | `src/tools/consultation-tools.ts:183` | get_thread (et lectures similaires) retourne le texte « null » pour une ressource absente, sans isError ni explication |
| [ ] | `protocole-mcp-09` | 🟡L | S | `README.md:236` | README documente un outil MCP « introspection » qui n'existe pas ; commentaire « 23 tools » périmé |
| [ ] | `protocole-mcp-10` | 🟡L | M | `src/tools/agents-tools.ts:19` | Aucun outil n'a d'annotations (readOnlyHint/destructiveHint), de title ni d'outputSchema ; descriptions de paramètres majoritairement absentes |
| [ ] | `protocole-mcp-11` | 🟡L | M | `src/serve-http.ts:550` | Résumabilité Streamable HTTP absente (pas d'eventStore) et Mcp-Session-Id non exposé au CORS |
| [ ] | `protocole-mcp-14` | 🟡L | S | `src/tools/status-tools.ts:43` | Outils bloquants (wait_for_peers, wait_for_message) sans borne supérieure de timeout ni notifications de progression |
| [ ] | `protocole-mcp-13` | ⚪I | S | `package.json:4` | mcpName déclaré mais aucune trace de publication au registre MCP (pas de server.json ni workflow), et serverInfo.name incohérent |

#### Tâches PR3 (24 constats) — chaque tâche suit les 5 rounds

| ☐ | ID | Sév | Eff | Fichier ancre | Constat |
|---|----|-----|-----|---------------|---------|
| [ ] | `ci-cd-01` | 🔴H | M | `.github/workflows/release-binaries.yml:4` | release-binaries ne se déclenche plus depuis que release-please crée les tags : aucun binaire publié depuis v0.10.7 |
| [ ] | `maintenabilite-02` | 🔴H | M | `.github/workflows/release-binaries.yml:5` | Canal de distribution binaires silencieusement cassé depuis v0.11.0 |
| [ ] | `tests-01` | 🔴H | S | `.github/workflows/test.yml:32` | Les seuils de couverture 100 % ne sont pas appliqués en CI (pnpm test sans --coverage) |
| [ ] | `ci-cd-02` | 🟠M | S | `.github/workflows/release.yml:61` | Provenance npm revendiquée mais jamais activée (id-token: write inutilisé, aucune attestation sur le registre) |
| [ ] | `ci-cd-03` | 🟠M | S | `.github/workflows/test.yml:1` | Aucun status check requis sur main : les tests ne bloquent pas les merges de PR |
| [ ] | `ci-cd-04` | 🟠M | S | `.github/workflows/docker-publish.yml:84` | Le garde-fou « :latest non promu sur workflow_dispatch/workflow_call » est inopérant (latest=auto le court-circuite) |
| [ ] | `ci-cd-05` | 🟠M | S | `.github/workflows/release-binaries.yml:90` | Actions GitHub épinglées par tags mutables (pas de SHA), sans Dependabot pour les maintenir |
| [ ] | `dependances-01` | 🟠M | S | `package.json:110` | Le bloc « overrides » de package.json est silencieusement ignoré par pnpm — l'override uuid censé corriger un GHSA ne s'applique pas |
| [ ] | `dependances-02` | 🟠M | S | `pnpm-lock.yaml:42` | 10 avis pnpm audit ouverts (2 high, 7 moderate, 1 low) — tous corrigeables par un simple refresh du lockfile sans franchir de range |
| [ ] | `dependances-03` | 🟠M | S | `.github/workflows/test.yml:1` | Aucune automatisation de veille dépendances : ni Dependabot/Renovate, ni pnpm audit en CI |
| [ ] | `dependances-04` | 🟠M | M | `package.json:64` | pnpm 9 exécute les scripts d'installation de toutes les dépendances par défaut — vecteur supply-chain évitable avec pnpm 10 |
| [ ] | `tests-02` | 🟠M | S | `sdk/package.json:18` | Les 84 tests du SDK (sdk/tests) ne tournent dans aucune CI |
| [ ] | `ci-cd-06` | 🟡L | S | `.github/workflows/test.yml:27` | Node 20 déclaré supporté (engines >=20) mais jamais testé en CI |
| [ ] | `ci-cd-07` | 🟡L | S | `.github/workflows/lint.yml:3` | Déclencheurs incohérents : lint et e2e tournent en double sur chaque PR interne, test.yml ne couvre que main |
| [ ] | `ci-cd-08` | 🟡L | S | `.github/workflows/release.yml:85` | secrets: inherit transmet NPM_TOKEN au workflow Docker qui n'en a pas besoin |
| [ ] | `ci-cd-09` | 🟡L | M | `.github/workflows/release-binaries.yml:34` | Binaires compilés avec un Bun non versionné et jamais démarrés réellement avant publication |
| [ ] | `dependances-05` | 🟡L | L | `package.json:94` | Famille tree-sitter figée sur l'ABI 0.21 (début 2024) — montée de version coordonnée 15+1 packages à planifier |
| [ ] | `dependances-06` | 🟡L | M | `package.json:93` | ~292 Mo de grammaires tree-sitter installés par défaut chez chaque consommateur npm et embarqués dans l'image Docker |
| [ ] | `dependances-07` | 🟡L | M | `package.json:78` | Retards de versions majeures contrôlés mais non suivis : zod 3→4, fast-check 3→4, commander 14→15, cookie 1→2, TypeScript 5.9→6 |
| [ ] | `dependances-08` | 🟡L | S | `.github/workflows/release-binaries.yml:34` | Actions CI épinglées par tag mutable, et binaires release construits avec une version Bun non déterminée |
| [ ] | `ci-cd-10` | ⚪I | S | `Dockerfile:12` | Image de base Docker non épinglée par digest |
| [ ] | `ci-cd-11` | ⚪I | S | `.github/workflows/e2e.yml:34` | Navigateurs Playwright retéléchargés à chaque run e2e |
| [ ] | `dependances-09` | ⚪I | S | `package.json:115` | engines ">=20" autorise toujours Node 20, en fin de vie depuis avril 2026 |
| [ ] | `dependances-10` | ⚪I | S | `package.json:66` | Concentration de mainteneurs sur les briques critiques (better-sqlite3, jose, écosystème aedes) — risque assumé, surveillance passive suffisante |

#### Tâches PR4 (11 constats) — chaque tâche suit les 5 rounds

| ☐ | ID | Sév | Eff | Fichier ancre | Constat |
|---|----|-----|-----|---------------|---------|
| [ ] | `performance-01` | 🔴H | M | `src/sweeper/index.ts:10` | Aucune rétention sur les tables Phase 1 (file_activity, events, thread_messages, action_summaries, layer_firings) — dégradation mesurée sur endpoints pollés |
| [ ] | `performance-02` | 🟠M | S | `src/serve-http.ts:264` | Connexion SSE sans Last-Event-ID : chargement de TOUT l'historique events en mémoire (655 ms mesurés à 200K lignes) |
| [ ] | `performance-03` | 🟠M | S | `src/serve-http.ts:589` | Cardinalité Prometheus non bornée : l'URL brute (avec UUIDs et chemins 404 arbitraires) sert de label de métrique |
| [ ] | `performance-04` | 🟠M | M | `src/mqtt-broker.ts:16` | Pont WebSocket→MQTT sans backpressure ni maxPayload : un consommateur WS lent fait croître la mémoire sans borne |
| [ ] | `performance-05` | 🟠M | S | `src/mqtt-bridge.ts:100` | Queues de listeners MqttBridge jamais nettoyées ni bornées : fuite mémoire par agent disparu |
| [ ] | `performance-06` | 🟠M | S | `src/auth/rate-limit.ts:120` | RateLimiter.sweep() n'est jamais appelé : la Map de buckets croît sans borne (clés par IP sur endpoints non authentifiés) |
| [ ] | `performance-07` | 🟡L | M | `src/serve-http.ts:409` | Sessions MCP StreamableHTTP jamais expirées : transports + McpServer accumulés au fil du churn de clients |
| [ ] | `performance-08` | 🟡L | S | `tests/perf/bench-audit-queue.ts:26` | bench-audit-queue.ts cassé (dérive de schéma) : la suite perf a rouillé et n'est exécutée nulle part |
| [ ] | `performance-09` | 🟡L | S | `src/sweeper/index.ts:188` | Sweep audit_log sur expression non indexable strftime('%s', created_at) : scan des lignes à chaque tick de 60 s |
| [ ] | `performance-10` | ⚪I | S | `src/database.ts:340` | PRAGMA synchronous laissé à FULL en mode WAL : un fsync par écriture autonome sur les chemins chauds |
| [ ] | `performance-11` | ⚪I | S | `src/impact-scorer.ts:211` | Layer 4 du scorer : requêtes SQL par (fichier cible × agent) dans la boucle d'announce |

#### Tâches PR5 (30 constats) — chaque tâche suit les 5 rounds

| ☐ | ID | Sév | Eff | Fichier ancre | Constat |
|---|----|-----|-----|---------------|---------|
| [ ] | `architecture-02` | 🟠M | L | `src/serve-http.ts:67` | État mutable au niveau module dans serve-http.ts contredit le contrat d'embedding multi-instance documenté |
| [ ] | `architecture-03` | 🟠M | L | `src/database.ts:17` | Base de données en singleton global (service locator) — couple tout le domaine à un état de process et force les tests en série |
| [ ] | `architecture-04` | 🟠M | S | `cli/server/start.ts:122` | Les handlers SIGINT/SIGTERM du CLI en mode foreground court-circuitent le graceful shutdown du serveur |
| [ ] | `architecture-06` | 🟠M | S | `src/serve-http.ts:50` | Défauts de répertoire de données divergents entre points d'entrée, et contraires au README |
| [ ] | `architecture-07` | 🟠M | S | `src/http/handle-rest.ts:59` | Dérive comportementale entre les transports REST et MCP sur le flux d'enregistrement d'agent |
| [ ] | `architecture-08` | 🟠M | M | `src/serve-http.ts:644` | Org 'default' codé en dur aux frontières MQTT et quota alors que le multi-org est livré |
| [ ] | `qualite-code-01` | 🟠M | L | `src/auth/refresh-rotation.ts:402` | Trois fonctions géantes (390 à 505 lignes) concentrent la complexité du serveur HTTP et de la rotation de tokens |
| [ ] | `qualite-code-02` | 🟠M | M | `src/http/handle-rest.ts:60` | Couche REST : corps de requêtes castés sans validation (15 « body as {...} ») alors que zod est déjà utilisé côté MCP |
| [ ] | `qualite-code-03` | 🟠M | M | `scripts/lint-run-all.sh:10` | Aucun linter réel : le job CI « Lint » = 5 scripts bash grep + tsc ; commentaires eslint-disable vestigiaux |
| [ ] | `tests-03` | 🟠M | M | `src/tools/consultation-tools.ts:1` | Couche handlers d'outils MCP faiblement couverte : consultation-tools 33 %, status-tools 10 %, mqtt-tools 21 % |
| [ ] | `tests-04` | 🟠M | S | `tests/unit/b3-mqtt-auth.test.ts:61` | Le hook d'authentification MQTT de production n'est jamais exercé : les tests en dupliquent le code |
| [ ] | `tests-05` | 🟠M | M | `dashboard/public/index.html:1` | Le dashboard principal (index.html, ~77 fonctions JS inline) n'a aucun test, ni e2e ni unitaire |
| [ ] | `architecture-09` | 🟡L | M | `src/observability/logger.ts:51` | Double pile logger/metrics Phase 1 vs Phase 2 : la redaction Pino ne couvre pas le chemin de requêtes principal |
| [ ] | `architecture-10` | 🟡L | M | `src/serve-http.ts:402` | La Phase 2 contourne l'abstraction DatabaseAdapter par un double cast — portabilité Bun non garantie pour tout le sous-système OAuth |
| [ ] | `architecture-11` | 🟡L | S | `src/server-setup.ts:29` | Inversion de couche : src/ importe cli/version.ts |
| [ ] | `architecture-13` | 🟡L | M | `CONTRIBUTING.md:47` | Pas de carte d'architecture pour les contributeurs externes malgré 108 fichiers src et des conventions non évidentes |
| [ ] | `architecture-15` | 🟡L | M | `src/http/handle-rest.ts:60` | Posture de validation d'entrée incohérente entre transports : zod côté MCP, casts bruts côté REST |
| [ ] | `qualite-code-04` | 🟡L | S | `src/admin/handle-admin-orgs.ts:103` | Duplication verbatim des helpers admin (readJsonBody, writeJson, writeValidationError) entre les 3 handlers admin |
| [ ] | `qualite-code-05` | 🟡L | S | `src/serve-http.ts:80` | safeEqual et decodeJwtPayload dupliqués localement dans serve-http.ts alors que le module importe déjà http/utils.js qui les exporte |
| [ ] | `qualite-code-06` | 🟡L | S | `src/observability/metrics.ts:1` | Dualité Phase 1 / Phase 2 : deux modules metrics, deux loggers, auth.ts + auth/ — coût cognitif pour les nouveaux contributeurs |
| [ ] | `qualite-code-07` | 🟡L | S | `src/dependency-map.ts:31` | JSON.parse non protégé sur des colonnes SQLite dans les chemins de lecture (dependency-map, consultation, conflict-detector) |
| [ ] | `tests-06` | 🟡L | M | `src/serve-http.ts:1` | Zones serveur les moins mesurées : serve-http.ts 47,5 %, handle-rest.ts 63,7 %, mqtt-bridge.ts 60 % |
| [ ] | `tests-07` | 🟡L | S | `tests/integration/channel-smoke.test.ts:106` | Race assumée dans channel-smoke : sleep fixe de 1,5 s au lieu d'attendre le signal de readiness |
| [ ] | `tests-08` | 🟡L | S | `cli/uninstall.ts:73` | CLI : commandes exclues de la mesure de couverture et « uninstall » (destructif, rmSync) sans aucun test |
| [ ] | `tests-09` | 🟡L | S | `tests/unit/csrf.test.ts:57` | fast-check sous-exploité (2 propriétés) et propriété CSRF théoriquement auto-réfutable |
| [ ] | `architecture-12` | ⚪I | S | `src/types.ts:176` | CoordinatorConfig porte des champs de configuration morts (authEnabled, jwtSecret, jwtExpiry) |
| [ ] | `architecture-14` | ⚪I | L | `dashboard/public/index.html:238` | Dashboard principal : 63 Ko de HTML avec un unique script inline, contrastant avec les pages admin modulaires |
| [ ] | `qualite-code-08` | ⚪I | S | `src/serve-http.ts:597` | Le catch global HTTP renvoie err.message brut dans la réponse 500 |
| [ ] | `tests-10` | ⚪I | L | `vitest.config.ts:10` | Suite entièrement sérialisée à cause de singletons de module — discipline manuelle de reset entre fichiers |
| [ ] | `tests-11` | ⚪I | S | `tests/perf/README.md:3` | Scripts perf/chaos hors CI par choix documenté — pas de suivi de régression des JSON_SUMMARY |

#### Tâches PR6 (13 constats) — chaque tâche suit les 5 rounds

| ☐ | ID | Sév | Eff | Fichier ancre | Constat |
|---|----|-----|-----|---------------|---------|
| [ ] | `documentation-03` | 🟠M | S | `README.md:379` | Section « Anthropic Quota Pre-flight » du README : MAX_QUOTA_PCT inexistant, mécanisme inexact, limitation macOS-only passée sous silence |
| [ ] | `documentation-04` | 🟠M | M | `docs/usage.md:230` | usage.md : le workflow multi-instances documenté est faux (le PID file ne suit pas --data-dir) |
| [ ] | `documentation-05` | 🟠M | S | `README.md:236` | Le README promet un outil MCP « introspection » qui n'existe pas |
| [ ] | `documentation-06` | 🟠M | S | `SECURITY.md:15` | SECURITY.md : table des versions supportées périmée de trois minors |
| [ ] | `documentation-07` | 🟠M | S | `README.md:96` | README figé à v0.11.0 : tags Docker, compteurs de tests et section Support périmés |
| [ ] | `documentation-08` | 🟠M | S | `docs/usage.md:154` | usage.md « Push vs polling » contredit le README et operating-modes.md : Channels (v0.12) y est absent |
| [ ] | `documentation-09` | 🟠M | S | `.env.example:111` | Variables COORDINATOR_LOGIN_LOCKOUT_* documentées mais codées en dur (le JSDoc du module affirme lui-même le contraire) |
| [ ] | `documentation-10` | 🟠M | S | `docs/ops/backup-restore.md:1` | Les commandes `server backup` / `server restore` existent mais ne sont documentées nulle part — pas même dans le runbook backup-restore |
| [ ] | `documentation-11` | 🟡L | S | `examples/custom-idp-provider/google-provider.ts:6` | Exemple custom-idp-provider périmé et auto-contradictoire (parle de v0.9, « GitHub only », référence un fichier absent) |
| [ ] | `documentation-12` | 🟡L | S | `docs/superpowers:1` | docs/ pollué : 132 fichiers internes (superpowers) publiés sur GitHub Pages + backup HTML de 204 Ko versionné, sans index de navigation |
| [ ] | `documentation-13` | 🟡L | S | `src/server-setup.ts:179` | Petits chiffres périmés disséminés : « 23 MCP tools » en commentaire, « 16 routes » vs 17, « ~70 variables » vs 55, « 29 metrics » vs 32 |
| [ ] | `documentation-14` | 🟡L | S | `CONTRIBUTING.md:41` | CONTRIBUTING.md n'explique pas comment reproduire localement le job Lint de la CI |
| [ ] | `documentation-15` | ⚪I | S | `README.md:527` | La roadmap du README liste comme futures des features SDK déjà livrées (keytar, profils TOML) |

#### Tâches PR7 (11 constats) — chaque tâche suit les 5 rounds

| ☐ | ID | Sév | Eff | Fichier ancre | Constat |
|---|----|-----|-----|---------------|---------|
| [ ] | `maintenabilite-01` | 🔴H | S | `CONTRIBUTING.md:37` | PR d'un contributeur externe (#151) sans aucune réponse depuis 6,5 semaines |
| [ ] | `maintenabilite-03` | 🟠M | S | `package.json:3` | Release 0.13.1 bloquée depuis 7 semaines avec des correctifs utilisateurs mergés mais non publiés |
| [ ] | `maintenabilite-04` | 🟠M | S | `tests/unit/lint-scripts.test.ts:20` | pnpm test échoue sur Windows (20 tests, exit 127) quand bash résout vers WSL |
| [ ] | `maintenabilite-05` | 🟠M | M | `.github/workflows/lint.yml:33` | Aucun formatter ni linter généraliste — le style repose entièrement sur la review manuelle |
| [ ] | `maintenabilite-06` | 🟠M | M | `sdk/package.json:3` | sdk/ est un sous-paquet orphelin : jamais testé en CI, lockfile npm dans un repo pnpm, aimant à PR Dependabot |
| [ ] | `maintenabilite-07` | 🟠M | S | `src/server-setup.ts:89` | Surface Phase 2 (OAuth/multi-org/chiffrement) surdimensionnée par rapport au runtime mono-tenant réel |
| [ ] | `maintenabilite-08` | 🟡L | S | `.github/ISSUE_TEMPLATE/feature_request.md:1` | Tracker figé depuis le 23 mai : 23 issues semées sans triage ni lien avec la PR qui en résout une |
| [ ] | `maintenabilite-09` | 🟡L | S | `docs/superpowers/working/audit/04-security.md:1` | 169 artefacts de travail IA internes commités dans le dépôt public (docs/superpowers/working) |
| [ ] | `maintenabilite-10` | ⚪I | S | `.github/workflows/test.yml:5` | Déclencheurs CI incohérents entre workflows : tests absents des branches, lint/e2e exécutés en double sur les PR |
| [ ] | `maintenabilite-11` | ⚪I | S | `vitest.config.ts:30` | Seuils de couverture 100 % sur ~50 fichiers : garde-fou puissant mais friction non documentée pour les contributeurs |
| [ ] | `maintenabilite-12` | ⚪I | M | `HANDOFF.md:89` | Landing page maintenue à la main en 6 locales : toil récurrent à chaque release |

---

## Self-Review (couverture spec)

- **119/119 constats** enumérés en tâches (vérifié : PR1=17, PR2=13, PR3=24, PR4=11, PR5=30, PR6=13, PR7=11).
- **5-round protocole** défini une fois (§Protocole) et référencé par chaque tâche — pas de duplication.
- **3 forks YAGNI** tranchés et rappelés au point d'usage (PR 2/3/7).
- **Ordre** : PR 0 pose le gate avant tout ; sécurité avant refactoring (PR 5 rebase sur socle durci).
- **Gaps connus assumés** : PR 2–7 ne sont pas encore en pas bite-sized à code complet — c'est délibéré (stratégie « un plan par sous-système » de writing-plans) ; ils s'expandent au démarrage de chaque PR depuis la recommandation d'audit correspondante, qui est précise (`fichier:ligne` + reco).

## Execution Handoff

Voir la fin du message de l'assistant pour le choix du mode d'exécution.
