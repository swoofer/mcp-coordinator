# B04 — Scope minimal, step-up 403 et lazy authentication par outil

| Champ | Valeur |
|---|---|
| **ID** | `scope-step-up-lazy-auth` |
| **Surface** | mcp-spec · claude-api |
| **Statut** | GA |
| **Disponible depuis** | step-up : déjà normatif en spec MCP `2025-11-25`, repris en `2026-07-28` (la page lazy-authentication pointe encore ses ancres vers `2025-11-25`) ; lazy authentication : *(non vérifiable — la page Anthropic ne date pas la fonctionnalité et ne porte aucun marqueur beta)* |
| **Tier** | T1-incontournable |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — caches et carte Connect exigent l'infra Claude |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — `adopter partiellement` ; le vrai défaut est le rejet Bearer |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- `Disponible depuis` : le marqueur *(à vérifier)* est tranché. Le **step-up** n'est pas nouveau en `2026-07-28` — la page Anthropic lazy-authentication renvoie ses ancres vers `/specification/2025-11-25/basic/authorization#step-up-authorization-flow`. La date d'apparition du **lazy authentication** reste non vérifiable (aucune date ni marqueur beta sur la page).
- §1 : « relance une autorisation avec l'**union** » était présenté comme un MUST. La spec dit **SHOULD** (« Clients **SHOULD** compute the union… »). Seuls sont MUST : « clients **MUST** treat the scopes provided in the challenge as authoritative » et « servers **MUST** account for scope hierarchies ». Corrigé.
- §2 : les comportements de cache ne viennent pas d'« une seule des deux sources à re-vérifier » — ils sont écrits noir sur blanc sur `claude.com/docs/connectors/building/lazy-authentication` (discovery caché globalement par URL, fenêtre ≈5 min ; `scope` du `403` caché **par utilisateur et par serveur** jusqu'à 15 min, écrasé par un nouveau `403`, vidé après usage). Caveat retiré, précision ajoutée.
- §2 : ajout de la précision spec sur `offline_access` (les serveurs protégés **SHOULD NOT** l'inclure dans le `scope` du `WWW-Authenticate` ni dans `scopes_supported`) et de l'avertissement Anthropic : les scopes gagnés lors d'un step-up antérieur **ne sont pas fiablement reportés** — le serveur doit les réémettre dans le `403`.
- §5 : `cli/doctor.ts:193-241` → `cli/doctor.ts:196-280` (`probeDiscoveryDoc` commence à la 196 et se termine à la 280).
- §5 : `src/http/response-contract.ts:16-27` → `:17-27` et `src/http/utils.ts:68-77` → `:68-76` (bornes exactes des fonctions).

Tous les autres noms d'API et numéros de ligne ont été confrontés aux sources et au code : `insufficient_scope`, `scope`, `resource_metadata`, `error_description`, `invalid_token`, `scopes_supported`, `resource`, `authorization_servers`, `bearer_methods_supported`, `/.well-known/oauth-protected-resource[/<path>]`, la règle `200 + isError:true` vs `401` transport, le gate avant `transport.handleRequest` — tous exacts. Côté repo : `authenticateMcpRequest` (`serve-http.ts:417`), branche `/mcp` (`:740`), well-known (`:695`), `AuthClaims` (`auth.ts:39-51`, sans champ `scope`), claims construits sans `scope` (`:450-462`), `ADMIN_ONLY_ROUTES` (`:243`), `AuthResult` (`:245-247`), `applyRouteGuards` (`:261-273`, `403` sans `WWW-Authenticate`), `ServiceTokenScope` (`service-tokens.ts:24`, validé `:85`), `scope?` (`jwt-mint.ts:13`), 26 outils / 6 modules (`server-setup.ts:237-247`), les 4 `isError: true` cités, `sdk/src/discovery.ts:6`, `sdk/src/client.ts:276`, `cli/channel.ts` en stdio — tous vérifiés exacts. La PRM est bien **absente** du code source (`grep` sur `*.ts` hors `node_modules` : zéro occurrence).

**Marqueurs `(à vérifier)` restants :** aucun. Un `(non vérifiable)` subsiste sur la date d'apparition du lazy authentication.

**Testabilité :** ⚠️ partielle
Testable localement, sans credentials : le point 1 (minter un service token `scope: "read"` via `cli/service-tokens.ts` — le fichier existe — puis appeler `mqtt_publish` sur `/mcp` avec `AUTH_ENABLED=true`), le point 3 (PoC de bufferisation du corps dans `src/serve-http.ts`) et la moitié serveur du point 4 (servir une PRM et vérifier sa forme, y compris via une probe `cli/doctor.ts`).
Non testable ici : les points 2, 5 et la moitié cliente du point 4. Vérifier que Claude suit `resource_metadata`, réagit à un `403 insufficient_scope`, et respecter les fenêtres de cache 5 min / 15 min suppose un connecteur custom atteignable depuis l'infra Anthropic (la doc précise que `localhost` n'est pas joignable — il faut un tunnel HTTPS public), plus un serveur d'autorisation OAuth 2.1 réel côté coordinateur. Le comportement Enterprise Managed Auth demande en plus un compte entreprise avec la config activée.

## 1. Ce que c'est

Deux mécanismes complémentaires qui remplacent une autorisation « tout ou rien » par une autorisation progressive, pilotée par le serveur et comprise nativement par les clients MCP conformes.

**Scope minimization + step-up.** La PRM (`scopes_supported`) ne publie que le jeu minimal de base, pas le catalogue complet des permissions. Quand un client authentifié appelle une opération qui demande plus, le serveur répond `HTTP 403` avec `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"`. Le client **MUST** traiter les scopes du challenge comme faisant autorité pour l'opération courante, et **SHOULD** relancer une autorisation avec l'**union** de ses scopes précédents et des scopes challengés, puis rejouer la requête (l'accumulation est une responsabilité *côté client*). Les serveurs **MUST** tenir compte des hiérarchies de scopes. Les anti-patterns explicitement listés par la spec : publier tous les scopes possibles d'entrée, les scopes omnibus (`*`, `all`, `full-access`), renvoyer tout le catalogue à chaque challenge.

**Lazy / mixed authentication.** Pattern officiel Anthropic pour exposer outils publics et outils protégés sur un même serveur MCP. Le refus DOIT être un échec de la requête **HTTP** : `401` + `WWW-Authenticate`. Un `200` contenant `isError: true` est traité comme un échec applicatif — Claude passe le texte au modèle et continue, sans jamais déclencher de flow OAuth. Conséquence d'architecture directe : la vérification doit se faire **avant** que le message JSON-RPC n'atteigne le SDK MCP, dans le handler HTTP, en inspectant le corps pour repérer un `tools/call` visant un outil protégé. `initialize`, `tools/list` et les outils publics passent au travers. Un `403` ne re-déclenche l'auth que s'il porte `error="insufficient_scope"` — sinon il est terminal.

## 2. Surface d'API exacte

```
# Refus d'un outil protégé, session non authentifiée
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token",
                  resource_metadata="https://…/.well-known/oauth-protected-resource",
                  scope="…"

# Step-up : token valide mais scope insuffisant
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope",
                  scope="coordinator:write",
                  resource_metadata="https://…/.well-known/oauth-protected-resource",
                  error_description="…"
```

Endpoints et champs de la PRM (RFC 9728) :

```
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/<path>
  resource, authorization_servers, bearer_methods_supported, scopes_supported
```

Autres éléments nommés dans les sources : `offline_access` (scope), `HTTP 403`, `error_description`. Précision spec : les serveurs protégés **SHOULD NOT** inclure `offline_access` dans le `scope` du `WWW-Authenticate` ni dans `scopes_supported` de la PRM — c'est une affaire d'AS, pas de ressource.

Comportements de cache côté Claude, énoncés explicitement sur la page lazy-authentication :
- documents de discovery (PRM + métadonnées AS) cachés **globalement par URL**, fenêtre de fraîcheur ≈ **5 minutes**, rafraîchissement paresseux et best-effort (en cas d'échec, l'entrée périmée est resservie) ;
- le `scope` d'un challenge `403` est caché **par utilisateur et par serveur** jusqu'à **15 minutes** ; un nouveau `403` écrase le précédent, et l'entrée est vidée après consommation ;
- avec Enterprise Managed Auth, le `401` déclenche un échange de token silencieux au lieu d'afficher la carte Connect.

Point d'attention documenté : les scopes obtenus lors d'un step-up **antérieur** ne sont pas fiablement reportés dans le suivant côté Claude. La doc demande donc au serveur de réémettre les scopes encore nécessaires dans le `scope` du `403`, plutôt que de compter sur la mémoire du client. Un `403 insufficient_scope` **sans** paramètre `scope` reste reconnu comme step-up : Claude retombe alors sur sa sélection normale (scope du `401` de discovery, puis `scopes_supported` de la PRM, puis celui des métadonnées AS).

Les deux fiches sources ne se contredisent pas ; la seconde précise seulement que le `403` doit porter `insufficient_scope` pour être actionnable.

## 3. Sources

- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- https://claude.com/docs/connectors/building/lazy-authentication
- https://claude.com/docs/connectors/building/authentication

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

Le coordinateur expose 26 outils MCP (`src/server-setup.ts:237`) répartis en 6 modules, et son autorisation est aujourd'hui strictement binaire : `authenticateMcpRequest` (`src/serve-http.ts:417`) rejette ou laisse passer **toute** la requête `/mcp`, `initialize` et `tools/list` compris. Il n'existe aucune vérification de rôle ou de permission au niveau outil — `grep role src/tools/*.ts` ne renvoie rien. Concrètement :

- **Une capacité apparaît** : `coordinator_status`, `list_agents`, `get_thread`, `hot_files` deviennent utilisables sans compte, pendant que `announce_work`, `post_to_thread`, `approve_resolution`, `mqtt_publish` déclenchent un vrai flow OAuth via `401`/`403`. Un développeur qui branche Claude sur un coordinateur d'équipe voit l'état du raid immédiatement et n'est challengé qu'au moment où il veut écrire.
- **Du code mort reprend du sens** : `bearerAuthHeader(err, description, scope)` (`src/http/response-contract.ts:16`) sait déjà émettre `insufficient_scope` + `scope`, mais aucun appelant en production ne passe le 3ᵉ argument — seul le test unitaire l'exerce. De même, `ServiceTokenScope = "read" | "write" | "admin"` (`src/auth/service-tokens.ts:24`) est validé au minting (`:85`) et écrit dans le JWT (`src/auth/jwt-mint.ts:13`), mais la revendication `scope` est **jetée** à la construction de `AuthClaims` (`src/auth.ts:450-462`, l'interface `:39-51` n'a pas de champ `scope`). Un service token « read » a exactement les mêmes droits qu'un « admin » côté MCP.
- **Le garde-fou existant ne couvre pas MCP** : `ADMIN_ONLY_ROUTES` (`src/auth.ts:243`) ne protège que `/api/auth/revoke` et `/api/reset`, deux routes REST.

**Risque si on ne fait rien :**

Deux risques concrets, pas hypothétiques. (1) Le « garde-fou fantôme » `ServiceTokenScope` : l'admin croit émettre un token en lecture seule, le porteur peut appeler `mqtt_publish` et `approve_resolution`. (2) Le piège documenté du `200 + isError: true` : `src/tools/consultation-tools.ts:369`, `src/tools/dependencies-tools.ts:42` et `:56`, `src/tools/mqtt-tools.ts:39` renvoient déjà ce motif. Si une future autorisation par outil est implémentée « naturellement » à cet endroit, elle ne déclenchera jamais d'OAuth côté Claude — le refus sera juste raconté au modèle, qui bouclera ou inventera un contournement. C'est exactement l'erreur que la doc lazy-authentication décrit.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/serve-http.ts:417-431` (`authenticateMcpRequest`) | Gate binaire par requête. Doit devenir : dispatch sur `initialize` / `tools/list` / outil public → pass-through, outil protégé → `401`/`403` avant le transport. |
| `src/serve-http.ts:740-851` (branche `/mcp`) | Le corps est consommé par `transport.handleRequest(req, res)`. Inspecter la méthode JSON-RPC avant impose de bufferiser et de rejouer le body — le point dur de l'implémentation. |
| `src/http/response-contract.ts:17-27` (`bearerAuthHeader`) | Supporte déjà `insufficient_scope` + `scope`. Manque `resource_metadata` dans le header produit. |
| `src/http/utils.ts:68-76` (`jsonAuthError`) | Pose `WWW-Authenticate` depuis `AuthResult` puis émet du JSON. Doit pouvoir porter un scope challengé, pas seulement un message. |
| `src/auth.ts:39-51` (`AuthClaims`) et `:450-462` | Ajouter `scope` aux claims et cesser de le jeter à la sortie de la vérification. |
| `src/auth.ts:245-247` (`AuthResult`) et `:261-273` (`applyRouteGuards`) | Le type porte déjà `status: 401 \| 403` et `wwwAuthenticate?`. Le guard `403` « Agent has been revoked » / « Admin access required » sort **sans** `WWW-Authenticate` : terminal côté Claude, à distinguer d'un vrai step-up. |
| `src/auth/service-tokens.ts:24,85` + `src/auth/jwt-mint.ts:13` | Source de vérité du vocabulaire de scopes existant (`read`/`write`/`admin`). Décider s'il devient le vocabulaire MCP ou s'il est remplacé. |
| `src/discovery.ts` (entier) | Ne sert que `/.well-known/oauth-authorization-server` (RFC 8414). La **PRM** `/.well-known/oauth-protected-resource` n'existe nulle part dans le repo (vérifié par grep sur `*.ts`) : c'est le livrable manquant n°1. |
| `src/serve-http.ts:695-701` | Routage du well-known, conditionné à `ctx.phase2Bootstrap`. Point d'ancrage pour brancher la PRM au même endroit. |
| `src/server-setup.ts:237-247` | Les 26 outils sont enregistrés par 6 `register*Tools`. C'est l'endroit naturel pour une table `outil → scope requis`. |
| `src/tools/*.ts` (6 fichiers) | Aucun contrôle de rôle/scope aujourd'hui. À laisser tel quel si la décision est de tout traiter au niveau HTTP. |
| `src/tools/consultation-tools.ts:369`, `dependencies-tools.ts:42,56`, `mqtt-tools.ts:39` | Motif `isError: true` déjà en place — ne surtout pas y greffer le refus d'autorisation. |
| `cli/doctor.ts:196-280` (`probeDiscoveryDoc`) | Probe 2 valide le doc RFC 8414. Une PRM ajoutée mérite sa propre probe, sinon elle dérivera en silence. |
| `sdk/src/discovery.ts:6` + `sdk/src/client.ts:56-78` | Le SDK résout ses endpoints via le doc RFC 8414 uniquement. Un step-up côté SDK demanderait de gérer `403 insufficient_scope` (`client.ts:276` se contente aujourd'hui de laisser remonter le `401`). |
| `cli/channel.ts` | Serveur MCP **stdio** : pas de couche HTTP, donc hors périmètre du mécanisme. À noter comme asymétrie assumée. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le step-up doit-il réutiliser le vocabulaire `ServiceTokenScope` existant (`read`/`write`/`admin`) en le propageant enfin dans `AuthClaims`, ou faut-il un vocabulaire MCP dédié (`coordinator:read` / `coordinator:announce` / `coordinator:admin`) publié dans une PRM — sachant que le premier réconcilie un garde-fou déjà à moitié écrit mais mélange service tokens et sessions utilisateur, et que le second impose de créer `/.well-known/oauth-protected-resource` et de bufferiser le corps JSON-RPC dans `/mcp` avant `transport.handleRequest` ?

### 6.2 Hypothèse

> Pré-enregistrée le 2026-08-15, **avant** tout PoC. Seuls faits déjà collectés : la lecture de
> `src/auth.ts:39-51` (l'interface `AuthClaims` n'a **pas** de champ `scope`) et de `:465-477`
> (l'objet retourné ne le porte pas non plus).

**Hypothèse.** La fiche contient **deux sujets de tailles très différentes**, et son §6.1 les traite
comme un seul :

1. **Un garde-fou fantôme, probablement réel et déjà exploitable.** `ServiceTokenScope`
   (`read`/`write`/`admin`) est validé au minting et écrit dans le JWT, mais **jeté à la
   vérification**. Je m'attends à ce qu'un token `read` puisse appeler `mqtt_publish` et
   `approve_resolution`. C'est le motif que l'audit v0.13.0 a déjà relevé ailleurs, et le dépôt
   vient d'en trouver deux autres (`A04` sur `resources.subscribe`, `B03` sur `auth.state.mixup`).
2. **Une machinerie step-up/PRM/lazy-auth disproportionnée** : bufferiser le corps JSON-RPC avant
   `transport.handleRequest`, servir une PRM, publier un vocabulaire de scopes — pour un
   comportement que **seul Claude** sait exploiter, et que je ne peux pas tester ici.

**Verdict attendu :** `adopter partiellement` — le noyau (propager `scope`, refuser l'écriture aux
tokens `read`), et **refuser** la bufferisation + PRM + step-up.

**Critères de refus, chiffrés (pré-enregistrés) :**

| # | Volet | Le résultat qui tue |
|---|---|---|
| **K1** | garde-fou | Un service token `scope: "read"` est **déjà refusé** sur `mqtt_publish` → pas de garde-fou fantôme, le noyau n'a rien à réparer. |
| **K2** | garde-fou | Propager `scope` jusqu'au refus exige **> 4 fichiers** → ce n'est plus le « correctif bien plus petit » de §6.5. |
| **K3** | lazy-auth | Le PoC de bufferisation casse `initialize`, `tools/list` ou une session SSE → le chemin n'est pas viable, indépendamment de son intérêt. |
| **K4** | step-up | Le comportement client (`403 insufficient_scope` → relance d'autorisation) **n'est pas testable ici** → `adopter` interdit par le protocole sur ce volet. |
| **K5** | tous | Zéro demande utilisateur. |
| **K6** | garde-fou | Les service tokens ne sont **pas utilisables sur `/mcp`** de toute façon → le scénario est sans objet. |

**Critère d'adoption :** pour le noyau — un token `read` qui **écrit réellement** ici, et un
correctif tenant sous le seuil de K2. Pour le step-up — un client qui **relance une autorisation**
sur `403 insufficient_scope`, exécuté ici ; à défaut, `refuser` ou `reporter`, jamais `adopter`.

**Ce que je m'engage à trancher :** si le garde-fou fantôme est confirmé, dire s'il est
**exploitable** (qui peut obtenir un token `read` ?) ou seulement **trompeur**.

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Non exécutable ici : tout ce qui dépend de l'infra Claude — carte Connect, suivi de `resource_metadata`, fenêtres de cache 5 min / 15 min, Enterprise Managed Auth. Il faudrait un connecteur custom exposé par tunnel HTTPS public (`localhost` n'est pas atteignable depuis l'infra Anthropic) et un vrai serveur d'autorisation OAuth 2.1 côté coordinateur.

- [ ] Émettre un service token `scope: "read"` via `cli/service-tokens.ts`, puis appeler `mqtt_publish` et `approve_resolution` avec ce token sur un `/mcp` réel. Confirmer (ou infirmer) que les deux passent — c'est-à-dire que le scope minté n'est jamais lu.
- [ ] Vérifier expérimentalement qu'un client MCP réel (Claude Code sur `/mcp`) réagit à un `403 + insufficient_scope` en relançant une autorisation, et qu'un `403` nu (celui d'`applyRouteGuards`) est bien terminal.
- [ ] PoC de bufferisation dans la branche `/mcp` de `src/serve-http.ts` : lire le corps, parser la méthode JSON-RPC, rejouer un stream vers `transport.handleRequest`. Mesurer que `initialize`, `tools/list` et une session SSE longue durée survivent intacts.
- [ ] Servir une PRM minimale (`resource`, `authorization_servers`, `bearer_methods_supported`, `scopes_supported` réduit) et vérifier que `resource_metadata` dans le `WWW-Authenticate` est effectivement suivi par le client.
- [ ] Mesurer la fenêtre de cache annoncée (≈5 min discovery, 15 min scope par utilisateur/serveur) : ajouter un scope au challenge et chronométrer la prise en compte.

### 6.4 Résultat observé

> Exécuté le 2026-08-15 contre le daemon réel (`AUTH_ENABLED=true` + `OAUTH_ENABLED=true`).
> **Frontière exécuté / lu :** (A) à (C) sont exécutés ; (D) nomme ce qui ne l'a pas été. Le dépôt
> n'a pas été modifié.
>
> ⚠️ **Note d'environnement :** `main` a intégré la migration SDK d'[`A02`](A02-mcp-sdk-typescript-v2.md)
> pendant cette session — `@modelcontextprotocol/sdk@1.30.0` a été remplacé par la famille
> `@modelcontextprotocol/{core,client,server,node}@2.0.0`. Les mesures ci-dessous sont donc les
> premières de cette série à porter sur le **SDK v2**.

#### (A) K1 — Le garde-fou fantôme est réel, et reproduit

Deux service tokens mintés par la **vraie** fonction de production `issueServiceToken()`, l'un
`read`, l'autre `admin` :

```
read   -> jti 88f075db | token 487 car.
admin  -> jti 8c09178e | token 488 car.

payload (read): {"sub":"u-b04","active_org_id":"default","role":"service",
                 "service_account":true,"scope":"read","typ":"access", …}
```

Le `scope` est bien **dans le JWT**. Les deux tokens, présentés en session sur `/mcp`, appellent
`mqtt_publish` :

```
--- token read : initialize -> HTTP/1.1 200 OK
    ECRITURE mqtt_publish : {"result":{"content":[{"type":"text","text":"published"}]}}
--- token admin : initialize -> HTTP/1.1 200 OK
    ECRITURE mqtt_publish : {"result":{"content":[{"type":"text","text":"published"}]}}
```

**Un token `scope: "read"` écrit. K1 ne se déclenche pas — le garde-fou fantôme est confirmé.**

La cause est lisible et tient en deux lignes : `AuthClaims` (`src/auth.ts:39-51`) **n'a pas de
champ `scope`**, et l'objet retourné par la vérification (`:465-477`) ne le porte pas non plus.
Le `scope` est validé au minting (`service-tokens.ts:85`), écrit dans le JWT
(`jwt-mint.ts:13`), puis **jeté**. Zéro lecture de `.scope` dans `src/auth.ts`, `src/tools/*.ts`
et `src/serve-http.ts`.

**Exploitabilité — l'engagement de §6.2, tranché.** Le minting est **admin-only** : il exige un
`issuedByAdminId` et passe par des routes gardées. Ce n'est donc **pas** une escalade de privilège
par un tiers, c'est un **échec de délégation** : l'admin croit déléguer un accès en lecture, il
délègue l'écriture complète. La gravité est réelle mais bornée au cercle des porteurs de tokens
émis volontairement.

#### (B) Un défaut plus grave, trouvé en chemin et absent de la fiche

Le même token `read`, présenté en **`Authorization: Bearer`** — la façon dont un client MCP
s'authentifie — est **rejeté** :

```
{"error":"v0.6 token rejected: upgrade required (AUTH_ENABLED=true)"}
```

La chaîne est lisible : `verifyTokenStrict` (`auth.ts:141`) détecte la « v0.7 » par
`typeof payload.user_id === "string" && typeof payload.org === "string"`. Or `mintAccessJWT`
produit `sub` + `active_org_id`, **jamais** `user_id` ni `org`. Le token est donc classé
`wasLegacy: true`, et `authenticateRequest` (`auth.ts:598-605`) le rejette en 401 dès que
`authEnabled`.

Le repli Phase 2 (`verifyPhase2SessionCookie`) **n'est jamais atteint** : il n'est tenté que si
`verifyTokenStrict` **lève**. Ici la signature est valide — Phase 1 et Phase 2 dérivent toutes deux
leur clé du **même** `COORDINATOR_JWT_SECRET` (`serve-http.ts:103` → `initAuth`, et
`boot.ts:152` → `buildJwtKeyRegistry`) — donc elle ne lève pas.

**Ce n'est pas un artefact de banc, et le dépôt ne le couvre pas.** Le seul test qui exerce un
service token de bout en bout passe par le **cookie**, et son commentaire le dit :

```ts
// tests/integration/d1-d10-matrix.test.ts:430-432
// Set as cookie. authenticateRequest sees no Bearer, falls into the
// Scenario 5 cookie branch → verifyPhase2SessionCookie → service-account
// branch → DB lookup → revoked_at IS NULL → success.
```

**Le chemin Bearer des service tokens n'a aucune couverture.** Conséquence pour cette fiche : §4
écrit que « le porteur peut appeler `mqtt_publish` et `approve_resolution` » — c'est vrai **en
cookie**, et faux **en Bearer**, où il ne peut rien appeler du tout.

#### (C) K5 — La demande utilisateur

```
scope -> 15     read-only -> 5     service token -> 3     step-up -> 1     lazy -> 1
```

Les 15 de « scope » sont dominés par le vocabulaire de périmètre (« hors scope »), pas par des
demandes d'autorisation fine. **K5 ne se déclenche pas** au sens strict — il y a du signal — mais
aucune issue ne demande le step-up ni la lazy auth.

#### (C bis) Ce que la passe adversariale a mesuré à ma place, et qui me contredit

**(1) K3 est mesuré, et il ne se déclenche pas.** J'avais refusé la bufférisation sans écrire le
PoC, en m'appuyant sur §6.5 (« rejouer un `IncomingMessage` synthétique », « code de plomberie
fragile »). **C'est faux depuis la migration SDK v2**, arrivée sur `main` pendant cette session :

```
// node_modules/@modelcontextprotocol/node/dist/index.d.mts:169-173
 * @param parsedBody - Optional pre-parsed body from body-parser middleware
handleRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse,
              parsedBody?: unknown): Promise<void>;
// :110  exemple documenté :  transport.handleRequest(req, res, req.body);
```

Patch jetable posé dans la branche `/mcp`, puis reverti :

```
Baseline (sans patch) :  7/7 passed
Avec bufférisation    :  149/149 passed   (tests/integration/ entier)

[B04-POC] method=initialize        tool=-              bytes=164
[B04-POC] method=tools/list        tool=-              bytes=46
[B04-POC] method=tools/call        tool=register_agent bytes=151
[B04-POC] method=ping              tool=-              bytes=50
```

`initialize`, `tools/list`, `tools/call` et les flux SSE survivent. **Aucun `IncomingMessage`
synthétique n'est nécessaire. §6.5 doit être barré sur ce point.**

**(2) La prémisse de coût de §6.1 est périmée.** §5 appelle la PRM « **le livrable manquant
n°1** ». Or `@modelcontextprotocol/server@2.0.0` — **déjà installé** — l'exporte :

```
buildOAuthProtectedResourceMetadata   getOAuthProtectedResourceMetadataUrl
oauthMetadataResponse                 bearerAuthChallengeResponse    requiredScopes
```

`bearerAuthChallengeResponse` produit `401 invalid_token` / `403 insufficient_scope` avec le
`WWW-Authenticate` et le `resource_metadata`. Le câblage manque ; le code, non.

**(3) Le refus ne peut PAS vivre dans la couche outils — et ça fusionne les deux termes de §6.1.**
Le SDK convertit tout `throw` de handler en `{ content: […], isError: true }`
(`@modelcontextprotocol/server`, `dist/mcp-*.mjs`, `createToolError`). C'est **exactement**
l'anti-motif que §4 condamne — un refus que Claude raconte au modèle sans jamais déclencher
d'OAuth. Le seul point d'application donnant la forme correcte est le **gate HTTP**, c'est-à-dire
la bufférisation que je voulais refuser. **Le noyau retenu et le volet refusé sont le même
mécanisme.**

**(4) K2, que j'avais escamoté, dépend d'une décision d'architecture que je n'avais pas prise :**
`AuthClaims` n'a pas de goulot unique côté outils — le motif `getSessionClaims(...)` est dupliqué
**26 fois sur 6 fichiers**. D'où **8 fichiers** par la voie couche-outils (K2 **déclenché**) contre
**3** par la voie point unique (K2 **non déclenché**). Et la voie à 3 fichiers est la seule
correcte, par (3).

**(5) La demande utilisateur est plus faible que je ne l'ai écrit — mais la promesse produit est
plus forte.** Les 15 « scope » sont du périmètre projet, pas de l'autorisation ; `RBAC` → 0,
`least privilege` → 0. En revanche `docs/onboarding-self-host.md:448-457` **publie déjà** la
promesse :

```
## Service tokens for CI
For non-interactive callers (CI, deploy bots, monitoring), issue a long-lived
service token instead of using OAuth:
  mcp-coordinator service-token issue … --scope read --ttl 30d …
```

**Les deux promesses de cette section sont cassées, en sens opposés** : un appelant CI, qui n'a pas
de cookie de navigateur, est **rejeté en Bearer** (B) ; et s'il passait par cookie, son `read`
**écrirait** (A).

#### (D) Ce qui n'a PAS été exécuté

- **K3, le PoC de bufferisation** du corps JSON-RPC avant `transport.handleRequest` : non écrit.
  Je ne peux donc **pas** dire si `initialize`, `tools/list` et une session SSE longue durée y
  survivent. C'est le point dur de la lazy auth, et il reste non mesuré.
- **K4, le comportement client** : qu'un client relance une autorisation sur `403
  insufficient_scope` exige un connecteur atteignable depuis l'infra Anthropic (tunnel HTTPS
  public). **Non testé** — donc `adopter` est interdit sur ce volet par le protocole.
- **Les fenêtres de cache** (≈5 min discovery, 15 min scope) : mêmes raisons.
- **La PRM** n'a pas été servie ni sondée.

### 6.5 Contre-arguments

- ❌ ~~**La bufferisation du corps `/mcp` est intrusive.** Aujourd'hui `transport.handleRequest(req, res)` reçoit le stream brut. Intercaler un parse JSON-RPC signifie lire, parser, puis rejouer un `IncomingMessage` synthétique — sur un chemin qui gère aussi les sessions SSE et l'`enableDnsRebindingProtection` du SDK. C'est du code de plomberie fragile pour un bénéfice qui n'est pas fonctionnel.~~ — **barré le 2026-08-15.** Mesuré **149/149** avec la bufferisation, et le SDK v2 accepte un corps pré-parsé en 3ᵉ argument (`handleRequest(req, res, parsedBody?)`, exemple documenté `transport.handleRequest(req, res, req.body)`). **Aucun `IncomingMessage` synthétique n'est nécessaire.** Voir §6.4 (C bis)(1).
- **YAGNI sur le profil de déploiement dominant.** Le coordinateur tourne majoritairement en local, mono-utilisateur, `AUTH_ENABLED=false` (le mode « open-coordinator » a son propre chemin dans `authenticateMcpRequest`). Le lazy auth n'apporte rien à ce profil : il n'y a personne à challenger.
- **Portabilité.** Le comportement décrit (carte Connect, échange silencieux en Enterprise Managed Auth, caches 5 min / 15 min) est spécifique à Claude/Claude Code. Un client MCP tiers, ou `cli/channel.ts` en stdio, ne verra rien de tout ça. On ajoute une complexité que seul un client sait exploiter.
- **Complexité pour l'auto-hébergeur.** Aujourd'hui il choisit entre « auth » et « pas d'auth ». Demain il devra comprendre PRM, `scopes_supported`, hiérarchie de scopes et table outil→scope. C'est une nouvelle surface de mauvaise configuration, et une mauvaise configuration ici est une faille.
- **Le `403` non challengeable devient un piège.** Une fois `insufficient_scope` en place, chaque `403` du repo qui ne le porte pas (Origin refusé, agent révoqué, `ADMIN_ONLY_ROUTES`) devient une incohérence à documenter et à tester. On multiplie les cas limites.
- **Un correctif bien plus petit couvre le risque principal.** Propager `scope` de `jwt-mint.ts` jusqu'à `AuthClaims` et refuser les outils d'écriture aux tokens `read` supprime le garde-fou fantôme sans PRM, sans bufferisation et sans dépendance au comportement d'un client. Le step-up complet est peut-être un effort disproportionné par rapport à ce noyau.

---

### 6.4 ter — Bilan des six critères

| # | Statut | Ce qui l'établit |
|---|---|---|
| **K1** | ❌ non déclenché · ⚠️ **acquis d'avance** | Le token `read` écrit (A). Mais §4 l'affirmait déjà le 2026-08-14, et §6.2 admet avoir lu le code avant. **Confirmation, pas découverte.** |
| **K2** | ⚠️ **escamoté, puis mesuré par la passe** | **8 fichiers** par la couche outils (déclenché) · **3** par le point unique (non déclenché). Je n'avais pas tranché la voie — c'était pourtant la décision. |
| **K3** | ❌ **mesuré, non déclenché** | 149/149 avec la bufférisation. Je l'avais refusé **sans le mesurer**, sur une prémisse fausse. |
| **K4** | ✅ déclenché · ⚠️ **acquis d'avance** | La §0 du 2026-08-14 déclarait déjà la moitié cliente non testable. K4 la recopie. |
| **K5** | ❌ non déclenché | 15 « scope » = périmètre projet ; `RBAC` → 0. Aucune demande. |
| **K6** | ✅ **pleinement déclenché sur `/mcp`** | Les service tokens visent CI/bots (doc), donc Bearer, donc **rejetés**. Le garde-fou fantôme n'est atteignable par aucun porteur réaliste du cas documenté. |

**Sur six critères, deux étaient décoratifs (K1, K4), un escamoté (K2), un refusé sans mesure et
faux une fois mesuré (K3). Un seul a porté de l'information neuve : K6.**

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | **Le challenge trouve un défaut qui dépasse la fiche : tout token Phase 2 est rejeté en `Authorization: Bearer` dès que `AUTH_ENABLED=true`.** `verifyTokenStrict` détecte la « v0.7 » par `user_id` **et** `org` ; `mintAccessJWT` produit `sub` + `active_org_id`. Le repli Phase 2 n'est jamais atteint car la signature est valide — Phase 1 et Phase 2 dérivent du **même** `COORDINATOR_JWT_SECRET`. Le SDK maison (`sdk/src/client.ts:266`) et la CLI envoient du Bearer : **ils ne peuvent pas s'authentifier**. Et le test censé couvrir ce chemin est **vert pour la mauvaise raison** — le banc utilise deux secrets distincts, ce qui fait *lever* la vérification et ouvre un repli que la production n'atteint jamais. À côté, le garde-fou fantôme de §4 est réel (un token `read` publie) mais **inatteignable par le cas d'usage documenté**, qui est du CI en Bearer. |
| **Issue / PR** | Aucune créée. Trois périmètres en §7.2, **à confirmer avec le mainteneur**. |
| **Jalon visé** | prochaine mineure pour (1) ; le reste ensuite |

### 7.1 La réponse à la question de §6.1

**§6.1 oppose un terme « bon marché » à un terme « cher ». Les deux prémisses sont fausses, et les
deux termes fusionnent.**

*Terme 1 — « réutiliser `ServiceTokenScope` en le propageant enfin dans `AuthClaims` ».* Tenable
sur le vocabulaire, **mais pas sur le point d'application** : un refus posé dans la couche outils
devient `{ isError: true }` par construction du SDK — précisément l'anti-motif que §4 condamne.
Le seul endroit qui produit un `403 + WWW-Authenticate` correct est le **gate HTTP**.

*Terme 2 — « un vocabulaire MCP dédié publié dans une PRM », réputé cher parce qu'il « impose de
créer `/.well-known/oauth-protected-resource` et de bufériser le corps ».* **Les deux coûts ont
disparu avec la migration `A02`** : le SDK v2 exporte `buildOAuthProtectedResourceMetadata`,
`bearerAuthChallengeResponse` et `requiredScopes`, et `handleRequest(req, res, parsedBody)` rend la
bufférisation native — mesurée à **149/149**.

**Réponse : le dilemme n'existe plus.** Le terme 1 a besoin du mécanisme du terme 2, et le terme 2
ne coûte plus ce que §6.1 lui prête. La vraie décision n'est pas « quel vocabulaire », c'est **où
poser le gate** — et la réponse est : au niveau HTTP, une fois.

### 7.2 Périmètre retenu, dans cet ordre

**(1) Priorité absolue — réparer le rejet Bearer.** C'est le défaut qui casse le cas d'usage
**documenté** (`docs/onboarding-self-host.md:448` : « For non-interactive callers (CI, deploy bots,
monitoring) »). Il touche **tous** les tokens Phase 2, pas seulement les service tokens. Le
correctif porte sur la détection de `verifyTokenStrict` (`auth.ts:141`) ou sur l'ordre d'essai des
vérificateurs dans `authenticateRequest`. **Et il faut corriger le banc** :
`tests/integration/d1-d10-matrix.test.ts:56-57` utilise `PHASE1_SECRET` ≠ `SIGNING_SECRET`, ce qui
rend le test vert alors que la production est cassée. Un test qui ment est pire qu'un test absent.

**(2) Ensuite — le garde-fou de scope, au gate HTTP.** Propager `scope` dans `AuthClaims` et
refuser les outils d'écriture aux porteurs `read`, **via le gate HTTP** (voie « point unique »,
3 fichiers), en utilisant `requiredScopes` / `bearerAuthChallengeResponse` du SDK v2 pour obtenir
la forme `403 insufficient_scope` correcte. **Surtout pas dans `src/tools/*.ts`.**

**(3) Corriger la doc, ou le code, mais pas ni l'un ni l'autre.**
`docs/onboarding-self-host.md:457` publie `--scope read` : tant que (2) n'est pas fait, cette ligne
promet une garantie qui n'existe pas.

### 7.3 Ce qui est reporté

**Le step-up côté client et la surface produit de la lazy auth.** K4 tient : vérifier qu'un client
relance une autorisation sur `403 insufficient_scope` exige un connecteur atteignable depuis
l'infra Anthropic. **Non testé ici → `adopter` interdit par le protocole.** Les arguments de §6.5
qui survivent sont **YAGNI** (profil local mono-utilisateur, personne à challenger) et
**portabilité** (carte Connect, caches 5/15 min : spécifiques à Claude). Ceux qui ne survivent pas
sont ceux que j'invoquais : « bufférisation intrusive » et « point dur de l'implémentation ».

**Condition de réveil :** le jour où un client MCP tiers se connecte réellement au coordinateur —
ce que [`B01`](B01-cimd-dcr-deprecated.md) a montré impossible aujourd'hui sans header statique.

### 7.4 Corrections à porter dans les sections 1 à 5

1. **§5 — « la PRM est le livrable manquant n°1 » est périmé** depuis `A02`. Le SDK v2 exporte
   `buildOAuthProtectedResourceMetadata`, `getOAuthProtectedResourceMetadataUrl`,
   `oauthMetadataResponse`, `bearerAuthChallengeResponse` et `requiredScopes`.
2. **§5 — « bufériser […] le point dur de l'implémentation »** : faux sous SDK v2, `handleRequest`
   prend un `parsedBody`.
3. **§4 — « le porteur peut appeler `mqtt_publish` et `approve_resolution` »** : vrai **en cookie**,
   faux **en Bearer**, où il est rejeté avant d'atteindre le moindre outil.
4. **§6.5 — barrer** le contre-argument sur l'`IncomingMessage` synthétique.

### 7.5 Ce que ce challenge a corrigé chez moi

- **J'ai refusé un volet sans le mesurer** (K3), sur une prémisse technique périmée par une
  migration que ma propre §6.4 signalait en note d'environnement — sans aller regarder ce qu'elle
  apportait.
- **J'ai escamoté K2** : il n'apparaissait ni comme mesuré ni comme non mesuré. C'était pourtant la
  décision d'architecture centrale.
- **J'ai sous-déclenché K6** et priorisé le mauvais des deux défauts : le garde-fou fantôme est
  spectaculaire, le rejet Bearer est celui qui casse un usage documenté.
- **J'ai présenté K1 comme une découverte** alors que §4 l'affirmait depuis le 2026-08-14.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : API et lignes repo exactes ; step-up daté 2025-11-25, MUST/SHOULD et bornes doctor corrigés. |
| 2026-08-15 | Challenge, premier de la série sur **SDK v2** (`main` a intégré `A02` en cours de session). **Verdict : `adopter partiellement`.** Mesuré : un service token `scope:"read"` **publie** via `mqtt_publish` en session cookie — garde-fou fantôme confirmé, le `scope` est jeté à la vérification. **Mais le défaut qui compte est ailleurs et dépasse la fiche** : tout token Phase 2 est **rejeté en `Authorization: Bearer`** (`401 v0.6 token rejected`) dès `AUTH_ENABLED=true`, SDK maison et CLI compris — et le test censé le couvrir est **vert pour la mauvaise raison** (`d1-d10-matrix.test.ts:56-57` utilise deux secrets distincts, ce qui ouvre un repli que la production n'atteint jamais). **Quatre corrections imposées par la passe adversariale :** (1) K3 refusé sans mesure et **faux une fois mesuré** — la bufférisation passe 149/149, `handleRequest(req,res,parsedBody)` est natif au SDK v2 ; (2) K2 escamoté — 8 fichiers par la couche outils, 3 par le point unique, et seule cette dernière est correcte car un `throw` de handler devient `{isError:true}`, l'anti-motif que §4 condamne ; (3) K6 sous-déclenché — les service tokens visent le CI, donc Bearer, donc le garde-fou fantôme est inatteignable par le cas documenté ; (4) K1 présenté comme une découverte alors que §4 l'affirmait déjà. **§6.1 est dissoute** : ses deux termes fusionnent, et la prémisse de coût du second est périmée — le SDK v2 exporte déjà la PRM et le challenge bearer. Corrections : §5 (« PRM = livrable manquant n°1 » et « bufériser = point dur ») périmées ; §4 (« le porteur peut appeler `mqtt_publish` ») vraie en cookie, fausse en Bearer. |
