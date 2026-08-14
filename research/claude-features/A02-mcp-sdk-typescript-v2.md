# A02 — Migration `@modelcontextprotocol/sdk` ^1.29 vers le SDK TypeScript v2

| Champ | Valeur |
|---|---|
| **ID** | `mcp-sdk-typescript-v2` |
| **Surface** | mcp-spec |
| **Statut** | GA |
| **Disponible depuis** | `2.0.0` — publié le 2026-07-27 (dist-tag npm `latest`), aligné sur la spec `2026-07-28` |
| **Tier** | T1-incontournable |
| **Nature** | replace-homemade-code |
| **Effort estimé** | XL |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — PoC local complet, npm public, aucun credential requis |
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

- [ ] Installer `@modelcontextprotocol/{server,client,node}@2` dans une branche jetable et lancer `@modelcontextprotocol/codemod` sur `src/tools/*.ts` + `src/server-setup.ts` ; compter les 26 `server.tool()` effectivement convertis et les erreurs `tsc` restantes.
- [ ] PoC minimal : un `createMcpHandler(() => createMcpServer(services, getClaims))` monté via `toNodeHandler` dans le `createServer` existant de `src/serve-http.ts`, et vérifier qu'un `Client` v2 en `versionNegotiation: { pin: '2026-07-28' }` et un client v1 legacy passent tous les deux l'`initialize` + un `list_agents`.
- [ ] Faire tourner `tests/integration/mcp-http-session-ttl.test.ts` contre le PoC : le SDK v2 gère-t-il lui-même l'expiration/éviction de session, ou faut-il conserver `sessionLastActivity` + le sweeper (l.1343+) ?
- [ ] Vérifier le chemin des claims : `AuthInfo` arrive-t-il bien en `ctx.http.authInfo` dans un handler d'outil, et peut-il remplacer la closure `getSessionClaims(sessionId)` (Task 23.5) sans réintroduire une map maison ?
- [ ] Mesurer la surface réellement supprimable : `git diff --stat` du PoC sur `src/serve-http.ts`, en lignes nettes, avant de décider si l'effort XL est justifié.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Aucune urgence réelle.** La justification la plus vendeuse de la fiche brute (« le paquet n'existe plus ») est fausse. `^1.29` résout en 1.30.0 et fonctionne. Une migration XL sans deadline, sur un projet à mainteneur unique, se reporte facilement.
- **Le repo n'utilise ni Express, ni Fastify, ni Hono.** `src/serve-http.ts` est un `node:http` `createServer` de 66 Ko avec routage maison, auth, admin, SSE, métriques. Une grande partie des helpers v2 les plus attirants (`requireBearerAuth` middleware, `mcpAuthMetadataRouter`, `createMcpExpressApp`, `originValidation`) sont Express-only et donc inutilisables sans adopter Express — ce qui transformerait une migration de SDK en réécriture de la couche HTTP.
- **Perte de contrôle sur les sessions.** Le sweeper TTL, l'éviction des claims sur `onclose` et l'ordre `onclose` avant `connect()` (commenté dans le code comme une correction de bug réelle : assigner `onclose` après `connect` écrasait le handler du SDK) sont des comportements durement acquis. Les déléguer à `createMcpHandler` sans équivalent explicite est une régression potentielle silencieuse.
- **Surface de rupture disproportionnée.** 6 fichiers d'outils, 2 entrées serveur, 1 serveur stdio de canal, ~8 fichiers de test et helpers importent le SDK. Le `codemod` couvre le mécanique, pas les décisions (Task 23.5, DNS rebinding, TTL).
- **MRTR / élicitation : YAGNI aujourd'hui.** Zéro occurrence d'`elicit` ou de `registerResource` dans `src/`. La capacité est intéressante mais aucun outil actuel ne la demande ; l'invoquer comme justification de la migration, c'est justifier par une feature qu'on n'a pas encore décidé de construire.
- **Coût pour l'auto-hébergeur.** Passer de 1 dépendance à 3+ paquets scopés versionnés ensemble augmente la surface de mise à jour et le risque de désynchronisation de versions dans les images Docker et le paquet npm.
- **Ligne v2 très jeune.** GA depuis moins de trois semaines à la date de cette fiche. Attendre une 2.1.x et quelques retours d'écosystème coûte peu, vu qu'aucune rupture ne nous presse.

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
| 2026-08-14 | Vérification des faits : GA et lignes repo confirmées ; `StreamableHTTPServerTransport` renommé, pas supprimé — corrigé. |
