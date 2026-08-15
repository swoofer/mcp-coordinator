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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

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

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **La bufferisation du corps `/mcp` est intrusive.** Aujourd'hui `transport.handleRequest(req, res)` reçoit le stream brut. Intercaler un parse JSON-RPC signifie lire, parser, puis rejouer un `IncomingMessage` synthétique — sur un chemin qui gère aussi les sessions SSE et l'`enableDnsRebindingProtection` du SDK. C'est du code de plomberie fragile pour un bénéfice qui n'est pas fonctionnel.
- **YAGNI sur le profil de déploiement dominant.** Le coordinateur tourne majoritairement en local, mono-utilisateur, `AUTH_ENABLED=false` (le mode « open-coordinator » a son propre chemin dans `authenticateMcpRequest`). Le lazy auth n'apporte rien à ce profil : il n'y a personne à challenger.
- **Portabilité.** Le comportement décrit (carte Connect, échange silencieux en Enterprise Managed Auth, caches 5 min / 15 min) est spécifique à Claude/Claude Code. Un client MCP tiers, ou `cli/channel.ts` en stdio, ne verra rien de tout ça. On ajoute une complexité que seul un client sait exploiter.
- **Complexité pour l'auto-hébergeur.** Aujourd'hui il choisit entre « auth » et « pas d'auth ». Demain il devra comprendre PRM, `scopes_supported`, hiérarchie de scopes et table outil→scope. C'est une nouvelle surface de mauvaise configuration, et une mauvaise configuration ici est une faille.
- **Le `403` non challengeable devient un piège.** Une fois `insufficient_scope` en place, chaque `403` du repo qui ne le porte pas (Origin refusé, agent révoqué, `ADMIN_ONLY_ROUTES`) devient une incohérence à documenter et à tester. On multiplie les cas limites.
- **Un correctif bien plus petit couvre le risque principal.** Propager `scope` de `jwt-mint.ts` jusqu'à `AuthClaims` et refuser les outils d'écriture aux tokens `read` supprime le garde-fou fantôme sans PRM, sans bufferisation et sans dépendance au comportement d'un client. Le step-up complet est peut-être un effort disproportionné par rapport à ce noyau.

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
| 2026-08-14 | Vérification des faits : API et lignes repo exactes ; step-up daté 2025-11-25, MUST/SHOULD et bornes doctor corrigés. |
