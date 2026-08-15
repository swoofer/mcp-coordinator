# A02 — Migration `@modelcontextprotocol/sdk` ^1.29 vers le SDK TypeScript v2

| Champ | Valeur |
|---|---|
| **ID** | `mcp-sdk-typescript-v2` |
| **Surface** | mcp-spec |
| **Statut** | GA |
| **Disponible depuis** | `2.0.0` — publié le 2026-07-27 (dist-tag npm `latest`), aligné sur la spec `2026-07-28` |
| **Tier** | T1-incontournable |
| **Nature** | ~~replace-homemade-code~~ **reduce-dependency-surface** — corrigé au challenge du 2026-08-15 : la migration ne remplace aucun code maison (voir §7.4) |
| **Effort estimé** | ~~XL~~ **M** pour le chemin retenu (renommage 1:1) ; `XL` reste juste pour `createMcpHandler`, écarté |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — PoC local complet, npm public, aucun credential requis |
| **Statut du challenge** | ✅ **tranché** — 2026-08-15, verdict `adopter partiellement` (§7) |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **§1 et §5 — fait central corrigé.** La fiche affirmait que `StreamableHTTPServerTransport` « disparaît totalement (zéro occurrence dans les paquets v2) ». Seul le **nom** disparaît : `docs/migration/upgrade-to-v2.md` documente deux successeurs directs, `NodeStreamableHTTPServerTransport` (`@modelcontextprotocol/node`) et `WebStandardStreamableHTTPServerTransport` (`@modelcontextprotocol/server`), et le codemod fait ce renommage automatiquement. Il existe donc un chemin de migration à faible effort qui ne passe pas du tout par `createMcpHandler` — ce que la fiche présentait comme une alternative inexistante. La ligne `src/serve-http.ts` de §5 liste désormais les deux cibles.
- **§2 — `createMcpHandler(factory, options?)`** : la seconde valeur de `legacy` (`'reject'`, moderne seul) était omise.
- **§2 — `ClientOptions.versionNegotiation`** : le défaut est `'legacy'` (aucune sonde, 2025 seul), non précisé.
- **§2 — `serveStdio`** vient du sous-chemin `@modelcontextprotocol/server/stdio` ; `toNodeHandler` accepte `{ onerror? }` ; `legacyStatelessFallback` est un handler *fetch-shaped*.
- **§2 — `SERVER_INFO_META_KEY`** vaut `'io.modelcontextprotocol/serverInfo'`.
- **§2 — `SSEServerTransport` ajouté** : supprimé en v2, copie v1 gelée sous `@modelcontextprotocol/server-legacy/sse`.
- **§2 — `Tasks`** : précision du mécanisme réel (retrait via SEP-2663, disparition de `taskStore` / `taskId` / `taskRequestedTtl`, diagnostic *action-required* du codemod).

**Faits revérifiés et confirmés (non modifiés) :** statut GA (`@modelcontextprotocol/server` dist-tag `latest` = `2.0.0`, publié le 2026-07-27) ; ligne v1 toujours vivante (`@modelcontextprotocol/sdk` dist-tag `latest` = `1.30.0`) — donc `^1.29.0` résout bien et la migration reste un choix ; `setupAuthServer` absent de toute la doc v2 ; liste des 10 paquets scopés ; noms auth, MRTR, `getProtocolEra()`, `PriorDiscovery`, `handler.notify.*`. Côté repo, **toutes** les citations de §5 sont exactes : `package.json:69`, `src/serve-http.ts` l.1/13/417/512/801/1324/1343, `src/index.ts` l.1/52-53, `src/server-setup.ts:207` (`createMcpServer(services, getSessionClaims)`), `src/discovery.ts:40`, `cli/channel.ts` l.36-38/298/340/350/536, les 26 `server.tool()` (consultation 11, agents 4, mqtt 3, files 3, dependencies 3, status 2), et zéro occurrence de `listChanged` / `registerResource` / `elicit` dans `src/`. Tous les fichiers cités existent.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ✅ testable
Les paquets `2.0.0` sont publics sur npm et le codemod aussi : aucun credential, aucun header beta, aucune allowlist n'est requis. L'intégralité de §6.3 se lance en local sur une branche jetable (`pnpm add @modelcontextprotocol/{server,client,node}@2`, codemod, PoC `toNodeHandler`, `tests/integration/mcp-http-session-ttl.test.ts`, `git diff --stat`). Seule nuance : le point « un client v1 legacy et un client v2 `pin` passent tous deux l'`initialize` » se teste avec deux clients issus du SDK lui-même — il ne dit rien du comportement des clients MCP tiers réels, qui eux ne sont pas disponibles ici.

---

## 1. Ce que c'est

Le SDK TypeScript MCP a été éclaté en paquets scopés versionnés ensemble : `@modelcontextprotocol/core`, `/core-internal`, `/client`, `/server`, `/server-legacy`, `/node`, `/express`, `/fastify`, `/hono` et `/codemod`, tous publiés en `2.0.0` le 2026-07-27 en même temps que la spec `2026-07-28`. Le paquet monolithique `@modelcontextprotocol/sdk` **n'est pas supprimé** : il reste publié, figé sur la ligne v1, en `1.30.0` (même date). Côté serveur, le nom `StreamableHTTPServerTransport` disparaît, mais **pas la classe** : elle est scindée en deux successeurs directs, `NodeStreamableHTTPServerTransport` (`@modelcontextprotocol/node`, pour un handler qui reçoit `IncomingMessage`/`ServerResponse` — le cas de mcp-coordinator) et `WebStandardStreamableHTTPServerTransport` (`@modelcontextprotocol/server`, pour un handler `Request`→`Response`). Le codemod se contente de ce renommage. Il existe donc **deux** chemins de migration serveur distincts : le renommage 1:1 (effort faible, modèle de session inchangé) et l'adoption de `createMcpHandler(factory, options?)`, qui construit une instance de serveur fraîche par requête et couvre les deux ères de protocole (2025 et 2026-07-28) via `legacy: 'stateless'` par défaut ; `server.connect(new StdioServerTransport())` devient `serveStdio(factory, options?)`, la fabrique étant nécessaire pour que la négociation de version se fasse après lecture du `initialize`. Côté client, la négociation devient explicite : `ClientOptions.versionNegotiation` (`mode: 'legacy' | 'auto' | { pin: '2026-07-28' }`), `client.getProtocolEra()`, et `connect(transport, { prior })` pour éviter la sonde de découverte. Le SDK v2 apporte aussi les primitives Multi Round-Trip Requests (`inputRequired`, `acceptedContent`, `createRequestStateCodec` avec scellement HMAC), les hints de cache sur les ressources, et `handler.notify.*` pour les notifications de liste. Un paquet `@modelcontextprotocol/codemod` outille la migration depuis v1, ce qui fait de cette migration un chemin assisté plutôt qu'une réécriture.

Deux points de désaccord entre les fiches brutes, tranchés par les vérificateurs et signalés ici plutôt que masqués : (a) un chercheur affirmait que « le paquet cible n'existe plus sous ce nom en v2 » — c'est **faux**, `@modelcontextprotocol/sdk@1.30.0` est bien publié sur `latest` de la ligne v1, donc épingler `^1.29` continue de fonctionner et la migration est un choix, pas une contrainte de disponibilité ; (b) les dates diffèrent (2026-07-27 pour les releases npm/GitHub, 2026-07-28 pour la spec) — la date de publication retenue est le 2026-07-27. Enfin, `setupAuthServer` cité par une fiche **n'existe dans aucun paquet v2** (c'était un helper d'exemple v1) ; l'API réelle est `mcpAuthMetadataRouter`.

## 2. Surface d'API exacte

```
# Paquets 2.0.0
@modelcontextprotocol/core, /core-internal, /client, /server, /server-legacy,
@modelcontextprotocol/node, /express, /fastify, /hono, /codemod
(ligne v1 maintenue : @modelcontextprotocol/sdk@1.30.0)

# Serveur
createMcpHandler(factory, options?)  # legacy: 'stateless' (défaut, sert 2025 + 2026-07-28) | 'reject' (moderne seul)
handler.notify.toolsChanged() | .promptsChanged() | .resourcesChanged() | .resourceUpdated(uri)
serveStdio(factory: McpServerFactory, options?: ServeStdioOptions)   # @modelcontextprotocol/server/stdio
legacyStatelessFallback(factory)     # handler fetch-shaped, 2025 stateless autonome
toNodeHandler(handler, { onerror? }) # @modelcontextprotocol/node
NodeStreamableHTTPServerTransport    # @modelcontextprotocol/node — successeur direct 1:1 de
WebStandardStreamableHTTPServerTransport  # @modelcontextprotocol/server — StreamableHTTPServerTransport v1
                                     # (le codemod fait ce renommage ; chemin de migration à faible effort,
                                     #  distinct de l'adoption de createMcpHandler)
SSEServerTransport                   # SUPPRIMÉ ; copie v1 gelée dans @modelcontextprotocol/server-legacy/sse
ServerOptions.cacheHints ; registerResource({ cacheHint })   # défauts ttlMs: 0, cacheScope: 'private'
fromJsonSchema()                     # @modelcontextprotocol/server

# Multi Round-Trip Requests (MRTR)
inputRequired({ inputRequests: { <key>: inputRequired.elicit({ ... }) } })
inputRequired.elicit() | inputRequired.elicitUrl()
acceptedContent(ctx.mcpReq.inputResponses, key, schema) | inputResponse()
createRequestStateCodec({ key, ttlSeconds?, bind? }) -> { mint, verify }   # scellement HMAC
InputRequiredSpec

# Client
ClientOptions.versionNegotiation     # 'legacy' (DÉFAUT, aucune sonde, 2025 seul) | 'auto' (sonde + repli)
                                     # | { pin: '2026-07-28' } (moderne seul)
VersionNegotiationOptions, VersionNegotiationMode
client.getProtocolEra()              # 'modern' | 'legacy'
client.connect(transport, { prior })
PriorDiscovery                       # { kind: 'modern'; discover } | { kind: 'legacy' }
ClientOptions.listChanged | client.listen(filter)
client.getServerVersion() ; SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo'

# Auth / sécurité HTTP
requireBearerAuth                    # DEUX variantes : middleware Express (@modelcontextprotocol/express)
                                     # et variante web-standard fetch (@modelcontextprotocol/server)
verifyBearerToken, oauthMetadataResponse, isJsonContentType(header)   # @modelcontextprotocol/server
buildOAuthProtectedResourceMetadata, getOAuthProtectedResourceMetadataUrl
validateHostHeader, hostHeaderValidationResponse
OAuthTokenVerifier, AuthInfo         # AuthInfo attaché à req.auth, puis forwardé par toNodeHandler en ctx.http.authInfo
mcpAuthMetadataRouter, hostHeaderValidation(), localhostHostValidation(),
createMcpExpressApp, originValidation                                  # @modelcontextprotocol/express
```

Le vocabulaire `Tasks` reste importable mais est marqué `@deprecated` et sorti des maps typées : la feature expérimentale « tasks » est retirée (SEP-2663), les propriétés de contexte `taskStore` / `taskId` / `taskRequestedTtl` disparaissent, et le codemod pose un diagnostic *action-required* sur chaque `setRequestHandler(GetTaskRequestSchema, …)`.

## 3. Sources

- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/migration/support-2026-07-28.md
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28
- `docs/migration/upgrade-to-v2.md` du repo typescript-sdk (porte l'essentiel des preuves auth et la liste des paquets ; attention, `docs/migration/v1-to-v2.md` est un 404)
- https://github.com/modelcontextprotocol/typescript-sdk/releases
- https://registry.npmjs.org/@modelcontextprotocol/sdk
- https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/ — daté du 2026-06-29, annonce la **beta**, ne prouve pas la GA
- https://ts.sdk.modelcontextprotocol.io/v2/functions/_modelcontextprotocol_express.auth_bearerAuth.requireBearerAuth.html — source faible (SPA typedoc, 404 en fetch direct)

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
`src/serve-http.ts` porte aujourd'hui tout le câblage Streamable HTTP à la main : instanciation d'un `StreamableHTTPServerTransport` par session (l.801), `Map<string, StreamableHTTPServerTransport>` (l.512 / l.1324), `transport.onclose` qui évince trois maps parallèles (`sessions`, `sessionClaims`, `sessionLastActivity`), et un sweeper TTL maison qui ferme les transports inactifs (l.1343+). Le modèle « une instance de serveur par requête » de `createMcpHandler` est exactement la forme que `createMcpServer(services, getSessionClaims)` a déjà — la fabrique existe. Ce qui disparaîtrait : la gestion manuelle du cycle de vie transport/session, et une partie du travail Phase 2 sur le bearer (`verifyBearerToken` / `oauthMetadataResponse` / `buildOAuthProtectedResourceMetadata` recouvrent une partie de `authenticateMcpRequest` et de `src/discovery.ts`). Ce qui apparaîtrait : le support de la spec `2026-07-28` sans écrire une ligne de négociation, l'élicitation MRTR (`inputRequired` + `createRequestStateCodec`) — qui donnerait au serveur le droit de redemander une information à l'agent en cours d'appel, aujourd'hui impossible, et qui intéresse directement `announce`/`consultation` — et les hints de cache sur les ressources. Le `codemod` réduit le coût mécanique de la migration des 26 `server.tool()` et des imports de test.

**Risque si on ne fait rien :**
Faible à court terme, et c'est le point important : la ligne v1 reste publiée en `1.30.0`, donc `"@modelcontextprotocol/sdk": "^1.29.0"` (package.json:69) continue de résoudre et de fonctionner. Le risque est un décrochage progressif : la ligne v1 est figée, elle ne recevra pas la spec `2026-07-28`, et les clients qui négocient en `mode: 'auto'` ou `{ pin: '2026-07-28' }` retomberont sur l'ère legacy face à mcp-coordinator. À terme, les correctifs de sécurité (le repo a déjà encaissé un GHSA sur `hono` transité par le SDK) ne remonteront que sur la ligne v2.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `package.json` (l.69) | `"@modelcontextprotocol/sdk": "^1.29.0"` → à remplacer par `@modelcontextprotocol/server` + `/client` + `/node` (le serveur HTTP est du `node:http` brut, pas Express/Fastify/Hono). Résolution actuelle : 1.30.0 dans `pnpm-lock.yaml`. |
| `src/serve-http.ts` (l.1 `createServer`, l.13 import, l.801-834, l.512 / l.1324, l.1343+) | Cœur de la migration. **Deux cibles possibles** : (a) renommage 1:1 `new StreamableHTTPServerTransport({ … })` → `new NodeStreamableHTTPServerTransport({ … })` de `@modelcontextprotocol/node` (ce que fait le codemod ; maps de session et sweeper conservés tels quels), ou (b) `createMcpHandler(factory)` + `toNodeHandler`, où les trois maps de session et le sweeper TTL deviennent en partie redondants. `enableDnsRebindingProtection` a un équivalent v2 : `validateHostHeader` / `hostHeaderValidationResponse`. |
| `src/serve-http.ts` (l.417 `authenticateMcpRequest`) | Recouvrement avec `verifyBearerToken` / `OAuthTokenVerifier` / `AuthInfo`. Attention : la variante `requireBearerAuth` d'`@modelcontextprotocol/express` est inutilisable ici (pas d'Express) ; seule la variante web-standard de `@modelcontextprotocol/server` est envisageable. |
| `src/discovery.ts` (`buildDiscoveryDoc`, `handleDiscovery`) | Document RFC 8414 construit à la main. `oauthMetadataResponse` / `buildOAuthProtectedResourceMetadata` / `getOAuthProtectedResourceMetadataUrl` couvrent une partie du besoin — mais le doc maison est très spécifique (device flow, `token_endpoint_auth_methods_supported: ["none"]`), à vérifier avant de le jeter. |
| `src/index.ts` (l.1 import, l.52-53) | `const transport = new StdioServerTransport(); await server.connect(transport)` → `serveStdio(() => createMcpServer(...))`. Le mode stdio synthétise déjà des claims dans une closure : compatible avec le modèle fabrique. |
| `src/server-setup.ts` (l.1 `McpServer`, `createMcpServer`) | La fabrique attendue par `createMcpHandler` / `serveStdio` existe déjà sous la forme `createMcpServer(services, getSessionClaims)`. Import `McpServer` à repointer sur `@modelcontextprotocol/server`. |
| `src/tools/*.ts` (26 appels `server.tool(...)` : consultation 11, agents 4, mqtt 3, files 3, dependencies 3, status 2) | Tous utilisent l'ancienne surcharge `server.tool(name, description, zodShape, handler)`. Cible v2 : `registerTool` / `fromJsonSchema()`. Candidat n°1 au `codemod`. |
| `cli/channel.ts` (l.36-38, l.298 `new Server`, l.340/350 `setRequestHandler`, l.536 `StdioServerTransport`) | Serveur stdio bas niveau des Claude Code Channels. Migration séparée et plus simple : `serveStdio(factory)`. |
| `src/sse-emitter.ts` | Push maison (SSE + MQTT via `src/mqtt-bridge.ts`). À confronter à `handler.notify.{toolsChanged,resourcesChanged,resourceUpdated}` et `client.listen(filter)` : le SDK v2 ne remplace pas le bus métier, mais il standardise les notifications de liste que le projet n'émet aujourd'hui pas du tout (zéro occurrence de `listChanged` / `sendToolListChanged` / `registerResource` dans `src/`). |
| `tests/helpers/mcp-client-harness.ts`, `tests/helpers/channel-test-harness.ts` | Importent `Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`. À migrer sur `@modelcontextprotocol/client` ; occasion d'ajouter `versionNegotiation` pour tester les deux ères. |
| `tests/integration/mcp-http-session-ttl.test.ts`, `tests/integration/stdio-log-purity.test.ts`, `tests/integration/channel-smoke.test.ts`, `tests/unit/fixtures/channel-stub-server.ts`, `tests/unit/mcp-tool-*.test.ts`, `tests/unit/mqtt-tools.test.ts` | Imports SDK dispersés (`RequestHandlerExtra`, `ServerRequest`, `ServerNotification`, `LATEST_PROTOCOL_VERSION`, `NotificationSchema`). Le TTL de session est testé contre le comportement du transport actuel : ce test est le premier à casser. |
| `sdk/src/client.ts` | **Pas** un client MCP : `McpCoordinatorClient` parle REST/OAuth au coordinateur en `fetch`. Hors périmètre de la migration. |
| `docs/ARCHITECTURE.md` | Décrit le câblage transport actuel ; à mettre à jour si la migration passe. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Puisque la ligne v1 reste publiée (`@modelcontextprotocol/sdk@1.30.0`) et qu'aucune rupture ne nous force la main : est-ce qu'on bascule `src/serve-http.ts` sur `createMcpHandler` + `toNodeHandler`, en abandonnant la `Map` de sessions et le sweeper TTL maison au modèle « une instance de serveur par requête » du SDK — ou est-ce qu'on reste sur la ligne v1 en n'empruntant à v2 que les briques isolables (`createRequestStateCodec` pour MRTR, `validateHostHeader`) sans toucher au transport ?

### 6.2 Hypothèse

*Pré-enregistré le 2026-08-15, AVANT toute exécution. Challenge groupé avec [`A01`](A01-mcp-2026-07-28-stateless.md).*

**Hypothèse.** Les paquets v2 s'installent sans conflit (`zod ^4.4.3` ici vs `zod ^4.2.0` requis par
`@modelcontextprotocol/server@2.0.0`, `engines.node >= 20` vs `>= 22` ici : compatibles sur le
papier). Le codemod fait le renommage mécanique. La vraie question n'est pas « v1 ou v2 » mais
**quel chemin v2** : le renommage 1:1 (`NodeStreamableHTTPServerTransport`) ne rapporte rien, et
`createMcpHandler` ne rapporte quelque chose que s'il résout le problème réel du dépôt — faire
arriver les claims jusqu'aux 26 handlers sans `Map` de sessions.

**Critères de refus (ce qui me ferait conclure « non bénéfique maintenant ») :**

- **A02-R1 — installation.** Si `pnpm add @modelcontextprotocol/{server,client,node}@2` échoue,
  duplique `zod`, ou impose Express/Fastify/Hono (le repo est du `node:http` brut) → `refuser` ou
  `reporter`.
- **A02-R2 — le codemod ne tient pas sa promesse.** Si après codemod il reste **plus de 20 erreurs
  `tsc`** qui demandent une décision humaine (et non un import à repointer), alors « migration
  assistée » est un slogan : c'est une réécriture.
- **A02-R3 — le bénéfice principal n'existe pas.** Si `AuthInfo` n'arrive **pas** jusqu'au handler
  d'outil (`ctx.http.authInfo` ou équivalent), alors `createMcpHandler` ne supprime pas la `Map`
  de claims maison, et il ne reste plus qu'un renommage : → `reporter`.
- **A02-R4 — surface supprimée trop faible.** Si le `git diff --stat` du PoC sur `src/serve-http.ts`
  ne supprime pas au moins ~80 lignes nettes de plomberie de session, l'effort XL n'est pas payé.
- **A02-R5 — ligne trop jeune.** Si `2.0.0` n'a reçu **aucun** patch depuis le 2026-07-27 et reste
  la seule version stable, l'attente coûte moins que l'essuyage de plâtres — d'autant qu'aucune
  rupture ne nous presse (la ligne v1 est publiée en `1.30.0`, même jour).

### 6.3 Protocole de vérification

*Amendé en session le 2026-08-15 : le protocole de la veille est conservé, exécuté sur une copie
jetable du dépôt dans le scratchpad plutôt que sur une branche.*

- [ ] Installer `@modelcontextprotocol/{server,client,node}@2` dans une branche jetable et lancer `@modelcontextprotocol/codemod` sur `src/tools/*.ts` + `src/server-setup.ts` ; compter les 26 `server.tool()` effectivement convertis et les erreurs `tsc` restantes.
- [ ] PoC minimal : un `createMcpHandler(() => createMcpServer(services, getClaims))` monté via `toNodeHandler` dans le `createServer` existant de `src/serve-http.ts`, et vérifier qu'un `Client` v2 en `versionNegotiation: { pin: '2026-07-28' }` et un client v1 legacy passent tous les deux l'`initialize` + un `list_agents`.
- [ ] Faire tourner `tests/integration/mcp-http-session-ttl.test.ts` contre le PoC : le SDK v2 gère-t-il lui-même l'expiration/éviction de session, ou faut-il conserver `sessionLastActivity` + le sweeper (l.1343+) ?
- [ ] Vérifier le chemin des claims : `AuthInfo` arrive-t-il bien en `ctx.http.authInfo` dans un handler d'outil, et peut-il remplacer la closure `getSessionClaims(sessionId)` (Task 23.5) sans réintroduire une map maison ?
- [ ] Mesurer la surface réellement supprimable : `git diff --stat` du PoC sur `src/serve-http.ts`, en lignes nettes, avant de décider si l'effort XL est justifié.

### 6.4 Résultat observé

*Session du 2026-08-15, poste Windows 11 / Node 22.21.0 / pnpm 10.34.5. Challenge groupé avec
[`A01`](A01-mcp-2026-07-28-stateless.md), dont la §6.4 porte les mesures côté protocole.*
**Tout ce qui suit a été exécuté.** L'expérience s'est faite dans un `git worktree` détaché
(`scratchpad/wt-a02`), pas sur une branche du dépôt.

---

#### (1) A02-R1 — installation : aucun frein

```
$ corepack pnpm install --ignore-scripts        # baseline v1.30.0
$ corepack pnpm exec tsc --noEmit
erreurs: 0
```

Puis, après codemod :

```
dependencies:
+ @modelcontextprotocol/client 2.0.0
+ @modelcontextprotocol/core   2.0.0
+ @modelcontextprotocol/node   2.0.0
- @modelcontextprotocol/sdk    1.30.0
+ @modelcontextprotocol/server 2.0.0
Done in 2.9s using pnpm v10.34.5
```

`zod ^4.4.3` (dépôt) satisfait `zod ^4.2.0` (exigé par `@modelcontextprotocol/server@2.0.0`) ;
`engines.node >= 20` contre `>= 22` ici. **A02-R1 non déclenché.**

---

#### (2) A02-R2 — le codemod tient sa promesse, et largement

```
$ mcp-codemod v1-to-v2 . --dry-run
Changes: 108 across 21 file(s)
Warnings (5):
  tests/helpers/channel-test-harness.ts:198 - setNotificationHandler(Schema,…) → forme 3 arguments
  tests/unit/mcp-tool-{ergonomics,handlers,org-scoping}.test.ts, tests/unit/mqtt-tools.test.ts
      - RequestHandlerExtra renommé ServerContext, arguments génériques supprimés
Info (27): 26 × « Raw object literal wrapped with z.object() » (les 26 outils) + 1 sur un import partagé
package.json : Removed @modelcontextprotocol/sdk ; Added client, core, node, server
```

Appliqué :

```
$ git diff --stat
 cli/channel.ts                     |   9 +-      src/tools/consultation-tools.ts | 760 +++----
 package.json                       |   7 +-      src/tools/dependencies-tools.ts | 144 +--
 src/index.ts                       |   2 +-      src/tools/files-tools.ts        |  92 +-
 src/serve-http.ts                  |   9 +-      src/tools/mqtt-tools.ts         | 124 +--
 src/server-setup.ts                |   2 +-      src/tools/status-tools.ts       | 210 +--
 src/tools/agents-tools.ts          | 166 +--      (+ 11 fichiers de tests/helpers)
 22 files changed, 719 insertions(+), 885 deletions(-)

$ corepack pnpm exec tsc --noEmit
erreurs: 6
  error TS2352 x4  error TS2345 x1  error TS2322 x1
  1  cli/channel.ts                      1  tests/unit/mcp-tool-handlers.test.ts
  1  tests/helpers/channel-test-harness.ts  1  tests/unit/mcp-tool-org-scoping.test.ts
  1  tests/unit/mcp-tool-ergonomics.test.ts 1  tests/unit/mqtt-tools.test.ts
```

**6 erreurs, dont ZÉRO dans `src/`.** Les 4 `TS2352` sont le même patron répété : les tests
fabriquent un faux `extra` `{ signal, sessionId }` que `ServerContext` refuse désormais
(`Property 'mcpReq' is missing in type … but required in type 'BaseContext'`). Les 2 autres sont
`cli/channel.ts` (les `setRequestHandler(Schema, …)` du canal Claude Code, qui passent à une forme
à 3 arguments) et son harnais de test. **A02-R2 non déclenché** — et de loin (seuil : 20).

---

#### (3) Le résultat qui recadre la fiche : le codemod migre tout, et ne change RIEN

Le daemon migré démarre et sert ses 26 outils (`scratchpad/probe-wt.mjs`, port 39413) :

```
=== /health ===                     HTTP 200 {"status":"alive","version":"2.0.1",...}
=== initialize protocolVersion=2025-11-25 === HTTP 200 → "protocolVersion":"2025-11-25"
=== initialize protocolVersion=2026-07-28 === HTTP 200 → "protocolVersion":"2025-11-25"   ← rétrogradé
=== POST stateless 2026-07-28 (sans initialize) ===
HTTP 400 {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}
=== POST server/discover ===
HTTP 400 {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}
=== tools/list dans une session 2025-11-25 (serveur migre v2) ===
HTTP 200 | outils listes : 26
"name":"register_agent", "name":"list_agents", "name":"heartbeat", "name":"agent_activity", "name":"announce_work"
```

Et le diff de `src/serve-http.ts` tient en **5 lignes utiles** :

```diff
+import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
-import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
-  sessions: Map<string, StreamableHTTPServerTransport>;
+  sessions: Map<string, NodeStreamableHTTPServerTransport>;
-            const transport = new StreamableHTTPServerTransport({
+            const transport = new NodeStreamableHTTPServerTransport({
```

**Les trois Maps, le `transport.onclose`, le sweeper TTL et la branche `/mcp` à trois cas sont
intacts.** Le chemin « renommage 1:1 » livre les paquets v2 **sans aucun gain de protocole ni de
plomberie** : même négociation 2025-11-25, même `-32000` sur une requête stateless, même absence de
`server/discover`. C'est une information que la fiche ne portait pas : sa §0 disait qu'il existe
« un chemin de migration à faible effort » — c'est vrai, et ce chemin **n'achète rien**.

---

#### (4) A02-R3 — `AuthInfo` atteint bien le handler, et sur les DEUX lignes

PoC `createMcpHandler` + `toNodeHandler` (`scratchpad/v2probe/poc-handler.mjs`, détail en §6.4 d'A01) :

```
=== 3. tools/call whoami stateless 2026-07-28 -> ctx.http.authInfo ? ===
"httpAuthInfo": { "token":"poc-token", "clientId":"poc-client", "scopes":["coordinator:write"],
                  "extra": {"sub":"agent-alpha","org":"acme","role":"admin","jti":"j-1"} }
"sessionId": null
=== 1. server/discover === HTTP 200 {"supportedVersions":["2026-07-28"],"resultType":"complete","ttlMs":0,"cacheScope":"private",…}
=== 4. initialize 2025-11-25 === HTTP 200 (le MÊME handler sert l'ère legacy)
=== 5. GET === HTTP 405 (ce que la révision demande en SHOULD)
```

**A02-R3 non déclenché.** Mais — et c'est le point qui change la décision — **le même mécanisme
existe déjà sur la ligne v1 installée** : `RequestHandlerExtra.authInfo` est déclaré dans
`protocol.d.ts:181` de `@modelcontextprotocol/sdk@1.30.0`, alimenté par `req.auth`
(`streamableHttp.js:131`), et un PoC avec un vrai client MCP v1 le confirme (§6.4 (3) d'A01).
Le bénéfice « faire arriver les claims aux 26 handlers sans Map » **n'est donc pas un bénéfice de la
migration** : il est disponible sans elle.

---

#### (5) A02-R4 — la surface supprimable est réelle, mais elle appartient à `createMcpHandler`

| Bloc de `src/serve-http.ts` | Lignes | Supprimé par le codemod ? | Supprimé par `createMcpHandler` ? |
|---|---|---|---|
| Branche `/mcp` à 3 cas (session existante / nouvelle / 404) | 751-851 (~101) | ❌ | ✅ (réduite à ~20) |
| 3 Maps + TTL + `sweepIdleMcpSessions` | 1323-1375 (~53) | ❌ | ✅ |
| Champs `HttpHandlerCtx` + `handlerCtx` | 512-514, 1377-1383 | ❌ | ✅ |
| `tests/integration/mcp-http-session-ttl.test.ts` | fichier entier | ❌ | ✅ (devient sans objet) |

Le PoC a montré `mcp-session-id: null` **y compris sur l'`initialize` legacy** : sous
`createMcpHandler`, il n'y a plus de session à balayer dans aucune des deux ères. Le seuil des
80 lignes nettes est franchi (**> 130**) — mais **uniquement** par le chemin (b), celui que le
codemod ne fait pas.

---

#### (6) A02-R5 — la ligne v2 n'a reçu aucun correctif depuis sa sortie

```
$ npm view @modelcontextprotocol/server versions --json
["2.0.0-alpha.1","2.0.0-alpha.2","2.0.0-alpha.3","2.0.0-alpha.4",
 "2.0.0-beta.1","2.0.0-beta.2","2.0.0-beta.3","2.0.0-beta.4","2.0.0-beta.5","2.0.0"]
$ npm view @modelcontextprotocol/sdk dist-tags --json
{ "latest": "1.30.0" }   # publié le 2026-07-27T17:56:01Z, le MÊME jour que la v2
```

Aucune `2.0.1`. La ligne v1 et la ligne v2 sont sorties le même jour ; ni l'une ni l'autre n'a bougé
depuis 19 jours. **A02-R5 déclenché** au sens littéral du critère.

---

#### (7) Le fait que ni la fiche ni moi n'avions vu : −74 paquets de production

*Mesure ajoutée en fin de session, après qu'un sous-agent adversarial a attaqué la justification du
verdict. C'est elle qui l'a fait basculer.*

`@modelcontextprotocol/sdk@1.30.0` déclare **17 dépendances directes**, dont une pile web complète
que ce dépôt n'utilise nulle part (`src/serve-http.ts` est un `node:http` `createServer` nu) :

```
$ npm view @modelcontextprotocol/sdk@1.30.0 dependencies --json
{ "ajv":"^8.17.1", "zod":"^3.25 || ^4.0", "cors":"^2.8.5", "hono":"^4.11.4", "jose":"^6.1.3",
  "express":"^5.2.1", "raw-body":"^3.0.0", "ajv-formats":"^3.0.1", "cross-spawn":"^7.0.5",
  "eventsource":"^3.0.2", "content-type":"^1.0.5", "pkce-challenge":"^5.0.0",
  "@hono/node-server":"^1.19.9 || ^2.0.5", "json-schema-typed":"^8.0.2",
  "eventsource-parser":"^3.0.0", "express-rate-limit":"^8.2.1", "zod-to-json-schema":"^3.25.1" }

$ npm view @modelcontextprotocol/{core,server,node}@2.0.0 dependencies --json
core   -> { "zod": "^4.2.0" }
server -> { "zod": "^4.2.0", "@modelcontextprotocol/core": "2.0.0" }
node   -> { "@hono/node-server": "^1.19.9" }
```

Mesure de la **fermeture de production réelle**, `pnpm ls --prod --depth Infinity`, dépôt actuel
contre worktree migré :

```
DEPOT ACTUEL (sdk 1.30.0) : 189 paquets prod (closure)
WORKTREE MIGRE (sdk v2)   : 120 paquets prod (closure)

=== presents en v1, ABSENTS apres migration : 74 paquets ===
@modelcontextprotocol/sdk accepts ajv ajv-formats body-parser bytes call-bind-apply-helpers
call-bound content-disposition content-type cookie-signature cors depd dunder-proto ee-first
encodeurl es-define-property es-errors es-object-atoms escape-html etag express express-rate-limit
fast-deep-equal fast-uri finalhandler forwarded fresh function-bind get-intrinsic get-proto gopd
has-symbols hasown http-errors iconv-lite ipaddr.js is-promise json-schema-traverse
json-schema-typed math-intrinsics media-typer merge-descriptors mime-db mime-types negotiator
object-assign object-inspect on-finished once parseurl path-to-regexp proxy-addr qs range-parser
raw-body require-from-string router safer-buffer send serve-static setprototypeof side-channel
side-channel-list side-channel-map side-channel-weakmap statuses toidentifier type-is unpipe vary
wrappy zod-to-json-schema

=== ajoutes par la migration : 4 ===
@modelcontextprotocol/{client,core,node,server}
```

**−74 / +4, soit 189 → 120 paquets de production : −36 %.** Toute la pile Express 5 (`express`,
`body-parser`, `router`, `send`, `serve-static`, `finalhandler`, `qs`, `path-to-regexp`,
`proxy-addr`, `type-is`…), `cors`, `express-rate-limit`, `ajv` + `ajv-formats` + `fast-uri`, et
`zod-to-json-schema` sortent de l'image Docker et du paquet npm — pour du code que le dépôt
**n'importe nulle part**.

Ce gain :

- est **immédiat** et **indépendant de la révision 2026-07-28** ;
- est livré par le **chemin bon marché** — le renommage 1:1 du codemod, celui dont la §6.4 (3)
  vient de montrer qu'il n'apporte rien sur le protocole. Il n'apporte rien sur le protocole
  **et** il enlève 36 % de l'arbre de production ;
- compte pour ce projet en particulier : il publie un **paquet npm** et une **image GHCR** chez des
  auto-hébergeurs, et son `package.json` porte déjà un `pnpm.overrides.ip-address` posé en réponse
  à un GHSA (`CHANGELOG.md`). Moins de paquets = moins d'avis à traiter.

*Non retenu faute de vérification propre :* le sous-agent affirmait aussi qu'`express-rate-limit`
réintroduit une **seconde copie** d'`ip-address`. Ma mesure dédoublonne par nom et ne peut ni
confirmer ni infirmer une seconde *version* ; `ip-address` n'apparaît pas dans le diff ci-dessus.
Affirmation écartée — le chiffre de 74 paquets suffit et il est mesuré.

#### (8) Les tests du dépôt contre le worktree migré : 48/49

`better-sqlite3` reconstruit (`pnpm rebuild better-sqlite3`), puis les cinq suites qui touchent
directement le SDK :

```
$ corepack pnpm exec vitest run tests/integration/mcp-http-session-ttl.test.ts \
    tests/unit/mcp-tool-handlers.test.ts tests/unit/mqtt-tools.test.ts \
    tests/integration/mcp-stdio-smoke.test.ts tests/unit/mcp-tool-org-scoping.test.ts

 ❯ tests/integration/mcp-stdio-smoke.test.ts (4 tests | 1 failed) 4332ms
     × rejects an unknown tool with a structured error (not a crash) 5ms
⎯⎯⎯ Failed Tests 1 ⎯⎯⎯
 FAIL  tests/integration/mcp-stdio-smoke.test.ts > MCP stdio transport — smoke
       > rejects an unknown tool with a structured error (not a crash)
ProtocolError: Tool this_tool_definitely_does_not_exist not found

 Test Files  1 failed | 4 passed (5)
      Tests  1 failed | 48 passed (49)
```

Deux enseignements, tous deux contre la fiche :

- **`tests/integration/mcp-http-session-ttl.test.ts` PASSE.** §5 de cette fiche l'annonçait comme
  « le premier à casser » ; il ne casse pas. Le TTL de session reste géré par notre sweeper, que le
  renommage ne touche pas.
- **Le seul échec est un changement de comportement réel :** en v2, un outil inconnu lève
  `ProtocolError` au lieu de rendre un résultat structuré. Un test existant l'attrape. C'est une
  décision à prendre (exception vs `isError: true`), pas un test à supprimer.

#### (9) Frontière exécuté / lu

Tout ci-dessus est exécuté. **Non exécuté :**

- La **campagne de tests complète** du dépôt contre le worktree migré. Cinq suites ciblées ont été
  lancées (49 tests), pas les ~700 du dépôt : `pnpm install --ignore-scripts` a été utilisé pour
  éviter la reconstruction native complète (tree-sitter), donc les suites qui en dépendent
  n'auraient rien dit d'interprétable. **C'est la principale réserve du verdict**, et elle est
  portée en condition dans §7.2.
- Le comportement de **clients MCP tiers réels** (Cursor, Cline, VS Code) face à un serveur v2 —
  la §0 le signalait déjà comme la limite du test, et elle reste entière.

**Levé en fin de session :** le poste a été mis à jour en **Claude Code 2.1.233** et la session
rejouée à travers un proxy d'écoute contre le daemon (trace complète en §6.4 (5 bis) d'`A01`) :
`initialize` en `2025-11-25`, **aucun `server/discover`**, 26 outils, `tools/call` réussi en 9 s.
Les clients éprouvés pour ce challenge sont donc : les clients du SDK **v1** et **v2** (dans les
trois modes de négociation) et **Claude Code 2.1.233**.

### 6.5 Contre-arguments

*Repris le 2026-08-15 après l'expérience et après une passe adversariale. Barré = tombé.
Deux se sont retournés en arguments **pour** la migration.*

- **Aucune urgence réelle** → **tient pour la révision `2026-07-28`, tombe pour les paquets.**
  `^1.29` résout bien en 1.30.0 et fonctionne. Mais « pas d'urgence » ne veut pas dire « pas de
  bénéfice » : le changement de paquets retire **74 paquets de production** (§6.4 (7)), aujourd'hui,
  sans rien devoir à la révision.
- ~~**Le repo n'utilise ni Express, ni Fastify, ni Hono** (donc les helpers v2 sont inutilisables).~~
  → **SE RETOURNE.** C'est exact et c'est précisément le problème : le repo n'utilise pas Express,
  mais `@modelcontextprotocol/sdk@1.30.0` **le lui livre quand même** — `express@^5.2.1`, `cors`,
  `express-rate-limit`, `ajv`, `ajv-formats`, `raw-body`, `zod-to-json-schema`… en dépendances
  directes. Le fait que le dépôt soit du `node:http` nu n'est pas une raison de **rester** sur v1,
  c'est la meilleure raison d'en **sortir**.
- ~~**Perte de contrôle sur les sessions.**~~ → **TOMBE pour le chemin retenu.** Le codemod ne
  touche **ni** le sweeper TTL, **ni** l'éviction sur `onclose`, **ni** l'ordre `onclose`-avant-
  `connect()` : le diff de `src/serve-http.ts` fait **5 lignes utiles**, toutes des renommages de
  type (§6.4 (3)). Et `tests/integration/mcp-http-session-ttl.test.ts` — que la fiche annonçait
  comme « le premier à casser » — **passe** (§6.4 (9)). Ce contre-argument ne vaut que pour
  `createMcpHandler`, qui est écarté.
- **Surface de rupture disproportionnée** → **mesurée, et elle ne l'est pas.** 21 fichiers touchés,
  108 changements automatiques, **6 erreurs `tsc` dont 0 dans `src/`**, **48/49 tests passent**.
  Le reste est nommé et borné (§7.2).
- **MRTR / élicitation : YAGNI aujourd'hui** → **tient intégralement.** Zéro `elicit`, zéro
  `registerResource` dans `src/`. Ces capacités ne justifient rien et ne sont pas invoquées dans
  le verdict.
- ~~**Coût pour l'auto-hébergeur : passer de 1 dépendance à 3+ paquets augmente la surface.**~~
  → **SE RETOURNE, et c'est l'argument décisif.** Mesuré `pnpm ls --prod --depth Infinity` :
  **189 → 120 paquets de production, −74 / +4** (§6.4 (7)). La surface de mise à jour ne grossit
  pas, elle **fond de 36 %** — dans l'image GHCR comme dans le paquet npm. Le risque de
  désynchronisation reste réel mais les 4 paquets sont versionnés **à l'identique** (`2.0.0` exact,
  `@modelcontextprotocol/core` épinglé sans caret par `server`).
- **Ligne v2 très jeune** → **tient à moitié, et il faut regarder l'autre ligne.** Aucune `2.0.1`
  en 19 jours, c'est vrai. Mais : 9 préversions publiques sur 4 mois (`2.0.0-alpha.1` le
  2026-04-01 → `2.0.0-beta.5`), et surtout la ligne v1 est **gelée** — `1.29.0` (2026-03-30) puis
  `1.30.0` publiée le **2026-07-27 à 17h56**, six heures avant la v2 du même jour. Ce n'est pas un
  signe de vie, c'est une release d'adieu. Rester sur v1 n'est pas « attendre que ça se stabilise »,
  c'est s'installer sur une branche morte.

**Ajouté par l'expérience :**

- **Le chemin bon marché n'achète rien sur le protocole — et c'est démontré, pas supposé.** Le
  daemon migré par codemod négocie toujours `2025-11-25`, rejette une requête stateless
  `2026-07-28` avec `-32000`, et n'a pas `server/discover` (§6.4 (3)). Quiconque justifierait cette
  migration par « on se met à jour sur la spec » se tromperait. La seule justification valable est
  l'arbre de dépendances.
- **Un vrai changement de comportement, attrapé par un test existant.** `vitest` sur le worktree
  migré : `tests/integration/mcp-stdio-smoke.test.ts > rejects an unknown tool with a structured
  error (not a crash)` échoue — v2 lève `ProtocolError: Tool … not found` là où v1 rendait un
  résultat structuré. C'est exactement ce que ce test existe pour attraper, mais il faut le traiter
  (décider si l'erreur remonte en exception ou en `isError: true`), pas le supprimer.
- **`cli/channel.ts` demande une vraie décision, pas un renommage.** `setRequestHandler(Schema, …)`
  passe à une forme à 3 arguments (`setRequestHandler('method/name', { params, result? }, handler)`),
  et le harnais `channel-test-harness.ts:198` suit. C'est 2 des 6 erreurs `tsc`, et le seul endroit
  du chantier où il faut réfléchir.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | **Retenu : le changement de paquets seul**, par le codemod — mesuré à 6 erreurs `tsc` (0 dans `src/`), 48/49 tests, daemon fonctionnel servant ses 26 outils, et **189 → 120 paquets de production (−74)**, dont toute la pile Express 5, `cors`, `express-rate-limit`, `ajv` et `zod-to-json-schema` que ce dépôt n'importe nulle part. **Écarté : `createMcpHandler` et la révision `2026-07-28`** — ils n'ont aucun client qui les exige (voir [`A01`](A01-mcp-2026-07-28-stateless.md) §7). |
| **Issue / PR** | [#286](https://github.com/swoofer/mcp-coordinator/issues/286) — périmètre en §7.3 |
| **Jalon visé** | Prochaine release mineure |

### 7.1 La réponse à la question de §6.1

La question opposait « basculer sur `createMcpHandler` + `toNodeHandler` » à « rester sur v1 en
n'empruntant que des briques isolables ». **Les deux termes sont mauvais.** Il existe une troisième
option que la fiche décrivait sans en voir la valeur : **changer de paquets sans changer
d'architecture**.

- `createMcpHandler` **marche** et livre toute la révision gratuitement (§6.4 (4)) — mais personne
  ne la demande, et il impose de réécrire la branche `/mcp`, la façon dont les claims atteignent
  les 26 handlers, et 43 sites de test (détail en §6.5 d'`A01`).
- « N'emprunter que des briques isolables » **ne rapporte rien** : le dépôt n'est pas un *resource
  server* mais un serveur d'autorisation OAuth complet (`src/auth.ts` + `src/auth/`), et
  `src/discovery.ts` émet un document **RFC 8414** là où le helper v2 émet du **RFC 9728** — ce ne
  sont pas les mêmes documents. `validateHostHeader` ne remplace pas le check d'`Origin` maison
  (deux en-têtes différents), et `enableDnsRebindingProtection: true` est déjà passé au transport.
- **Le renommage 1:1, lui, ne rapporte rien sur le protocole — et retire 36 % de l'arbre de
  production.** C'est le seul bénéfice mesuré, il est immédiat, et il est indépendant de tout ce
  qu'Anthropic fera de la révision.

### 7.2 Ce qui reste à faire avant de fusionner — nommé, pas balayé

| # | Point | État |
|---|---|---|
| 1 | **Campagne `vitest` complète** (avec builds natifs), pas les 5 suites ciblées | ⚠️ **non fait — condition bloquante** |
| 2 | `tests/integration/mcp-stdio-smoke.test.ts` : outil inconnu → `ProtocolError` au lieu d'un résultat structuré | Décision à prendre (exception vs `isError: true`) |
| 3 | `cli/channel.ts` : `setRequestHandler(Schema,…)` → forme à 3 arguments (+ `channel-test-harness.ts:198`) | 2 des 6 erreurs `tsc` ; seule vraie réflexion du chantier |
| 4 | 4 fichiers de test : faux `extra` `{signal, sessionId}` refusé par `ServerContext` (`mcpReq` manquant) | 4 des 6 erreurs `tsc`, mécanique |
| 5 | `docs/ARCHITECTURE.md` : le câblage transport cité par son ancien nom | Documentaire |

### 7.3 Périmètre exact de l'issue proposée

> **Migrer `@modelcontextprotocol/sdk@1.30.0` vers `@modelcontextprotocol/{core,server,node,client}@2.0.0`
> par renommage 1:1 (codemod), sans changer d'architecture de transport.**
>
> **Inclus :** `pnpm dlx @modelcontextprotocol/codemod v1-to-v2` (108 changements sur 21 fichiers),
> résolution des 6 erreurs `tsc` (§7.2 points 3 et 4), décision sur le changement de comportement
> « outil inconnu » (§7.2 point 2), campagne `vitest` complète verte, mise à jour de
> `docs/ARCHITECTURE.md`.
>
> **Exclu explicitement :** `createMcpHandler`, `toNodeHandler`, `serveStdio`, `server/discover`,
> `subscriptions/listen`, MRTR/`inputRequired`, `registerTool`/`outputSchema`, la suppression des
> Maps de session et du sweeper TTL, et tout changement de la façon dont les claims atteignent les
> 26 handlers. Le transport reste `NodeStreamableHTTPServerTransport` avec `sessionIdGenerator`,
> la négociation reste `2025-11-25`.
>
> **Critère d'acceptation :** `pnpm build` et `pnpm test` verts, et `pnpm ls --prod --depth Infinity`
> passant de **189 à ~120 paquets**.

### 7.4 Corrections apportées à la fiche par ce challenge

1. **Le tag `Nature: replace-homemade-code` est faux** — la migration ne remplace **aucun** code
   maison : ni l'AS OAuth (`src/auth.ts` + `src/auth/`), ni `src/discovery.ts` (RFC 8414 ≠ RFC 9728),
   ni le check d'`Origin`. Elle **réduit une surface de dépendances**. Corrigé en en-tête.
2. **§4 « Risque si on ne fait rien : faible à court terme » est faux** — il est chiffrable et non
   nul : 74 paquets de production inutiles, dont Express 5 et `cors`, sur une ligne v1 qui n'a rien
   reçu entre le 2026-03-30 et sa release d'adieu du 2026-07-27.
3. **§5 « `tests/integration/mcp-http-session-ttl.test.ts` est le premier à casser » est faux** —
   il passe (§6.4 (8)).
4. **§4 invoquait MRTR/élicitation comme bénéfice** — écarté : YAGNI confirmé, zéro `elicit` et zéro
   `registerResource` dans `src/`. Le bénéfice réel est ailleurs et la fiche ne le mentionnait pas.
5. **Effort `XL` est surévalué pour le chemin retenu.** Le renommage est un **M** au plus. `XL`
   reste juste pour `createMcpHandler`, qui est écarté.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : GA et lignes repo confirmées ; `StreamableHTTPServerTransport` renommé, pas supprimé — corrigé. |
| 2026-08-15 | Challenge groupé avec `A01`. Codemod appliqué dans un worktree jetable, daemon migré démarré et sondé, 49 tests lancés, arbre de dépendances mesuré, 1 passe adversariale. **Verdict : adopter partiellement** — le changement de paquets (−74 paquets prod), pas la révision. Corrections : `Nature` erroné, « risque faible » erroné, `mcp-http-session-ttl` ne casse pas, effort `XL` → `M` pour le chemin retenu. |
