# B01 — CIMD : la fin du Dynamic Client Registration

| Champ | Valeur |
|---|---|
| **ID** | `cimd-dcr-deprecated` |
| **Surface** | mcp-spec · claude-api |
| **Statut** | GA côté spec MCP — mais la couche OAuth sous-jacente est un draft IETF `-00` (voir §1) |
| **Disponible depuis** | CIMD normatif depuis la révision MCP `2025-11-25` ; dépréciation formelle de RFC 7591 datée `2026-07-28` |
| **Tier** | T1-incontournable |
| **Nature** | `integration` — le bundle annonce `replace-homemade-code`, la §5 montre qu'il n'y a rien à remplacer chez nous |
| **Effort estimé** | M pour le seul flag de metadata · L si on va jusqu'à un vrai endpoint d'autorisation |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — pas de domaine HTTPS public joignable depuis l'egress Anthropic |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — `refuser` le flag CIMD, `reporter` le fait de devenir AS |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- `docs/openapi.yaml` : le schéma `DiscoveryDoc` est à la **ligne 1193**, pas 1234 (§5). Le bloc de chemin `/.well-known/oauth-authorization-server` commence bien l. 901.
- Aucune autre correction : tous les autres numéros de ligne et toutes les affirmations sur le code ont été rouverts et sont exacts (`src/discovery.ts` l. 16/27/28, `src/serve-http.ts` l. 695 et 740, `src/auth/oauth-token.ts` l. 101 et 133, `src/auth/device-flow.ts` l. 124, `sdk/src/profiles.ts` l. 7, `sdk/src/discovery.ts` l. 6 et 18, `cli/doctor.ts` l. 196-279). L'absence de `registration_endpoint`, de `/.well-known/oauth-protected-resource` et de `resource_metadata` dans les `WWW-Authenticate` est confirmée par grep sur `src/`, `sdk/`, `cli/`.

**Surface d'API (§2) — vérifiée mot à mot contre les sources officielles :** `client_id_metadata_document_supported`, le couple exigé avec `"none"` dans `token_endpoint_auth_methods_supported`, les champs requis `client_id` / `client_name` / `redirect_uris`, `token_endpoint_auth_method: "none"` avec `private_key_jwt` en MAY, l'appartenance d'`application_type` à la section DCR, la taxonomie `oauth_dcr · oauth_cimd · oauth_anthropic_creds · custom_connection · static_headers (beta) · none`, `https://claude.ai/api/mcp/auth_callback`, `https://claude.ai/oauth/claude-code-client-metadata` déclarant `http://localhost/callback` et `http://127.0.0.1/callback` avec matching port-agnostique, PKCE S256 systématique, 10 s discovery/registration/token et 30 s refresh, egress `160.79.104.0/21`, `mcp-review@anthropic.com` — tout est exact. Le registre `/specification/2026-07-28/deprecated` liste bien DCR (PR #2858), déprécié en `2026-07-28`, retrait éligible « first revision released on or after 2027-07-28 ». Statut d'en-tête inchangé : correct.

**Marqueurs `(à vérifier)` restants :** aucun.

**Remarque hors périmètre d'édition :** en §6.3, `src/auth/oauth-callback.ts:175` est présenté comme « la validation stricte de `redirect_uri` en place » ; la ligne 175 se contente de rejouer le `redirect_uri` stocké en base vers l'IdP. La canonicalisation stricte est en fait dans `src/auth/oauth-login.ts:124`. Laissé tel quel, à amender en session.

**Testabilité :** ⚠️ partielle
Testable ici : ajouter `client_id_metadata_document_supported: true` dans `buildDiscoveryDoc()` sur une branche jetable, lancer le daemon local et vérifier le document via `curl /.well-known/oauth-authorization-server` puis `pnpm doctor`, puis tenter `claude mcp add --transport http` vers le coordinateur local et lire l'erreur exacte à l'étape autorisation. Non testable ici : le parcours depuis Claude.ai / Desktop / mobile / Cowork, qui exige un domaine HTTPS public joignable depuis l'egress `160.79.104.0/21` (donc un tunnel + certificat), et de toute façon un `authorization_endpoint` émettant nos propres codes — qui n'existe pas dans le repo.

## 1. Ce que c'est

MCP a basculé sa mécanique d'enregistrement client sur les OAuth *Client ID Metadata Documents* (`draft-ietf-oauth-client-id-metadata-document-00`). Le principe : le `client_id` **est** une URL HTTPS avec composant de chemin, qui déréférence un document JSON auto-référentiel décrivant le client. Le serveur d'autorisation fetch cette URL, vérifie que le champ `client_id` du document correspond exactement à l'URL demandée, valide les `redirect_uris`, et met en cache selon les en-têtes HTTP de la réponse. Conséquence directe : un `client_id` CIMD est **portable entre AS**, là où des credentials DCR doivent être clés par identifiant d'issuer et re-enregistrés dès que l'AS change.

RFC 7591 (Dynamic Client Registration) est désormais formellement *Deprecated* — inscrit au registre `/specification/2026-07-28/deprecated` (PR #2858), conservé pour rétrocompatibilité, éligible au retrait à partir de la première révision publiée après le 2027-07-28. L'ordre de préférence énoncé par la spec est un **SHOULD**, pas un MUST : pré-enregistrement > CIMD > DCR > saisie manuelle.

Côté Claude, la taxonomie d'auth des connecteurs distants est explicite et partagée par Claude.ai, Desktop, mobile, Claude Code et Cowork : `oauth_dcr`, `oauth_cimd`, `oauth_anthropic_creds`, `custom_connection`, `static_headers` (beta), `none`. Claude sélectionne CIMD **uniquement** si la metadata RFC 8414 de l'AS annonce à la fois `client_id_metadata_document_supported: true` **et** `"none"` dans `token_endpoint_auth_methods_supported` ; sinon il retombe sur `registration_endpoint`. Pour les serveurs à fort trafic, la doc recommande explicitement CIMD ou `oauth_anthropic_creds` plutôt que DCR, qui crée un client par connexion.

**Nuances à ne pas perdre (corrections des vérificateurs)** : (a) le `since: 2026-07-28` du bundle est faux pour CIMD — le même texte et le même flag figurent déjà dans la révision `2025-11-25` ; seule la dépréciation de RFC 7591 date du 2026-07-28. (b) `application_type` (`"native" | "web"`) appartient à la section *Dynamic Client Registration*, **pas** à la surface CIMD. (c) « GA » est à nuancer : la révision MCP est marquée *Current*, mais la spec OAuth référencée est un draft IETF `-00`, pas une RFC.

## 2. Surface d'API exacte

```
── Metadata AS (RFC 8414), à ajouter dans /.well-known/oauth-authorization-server ──
client_id_metadata_document_supported: true
token_endpoint_auth_methods_supported: ["none"]     ← les deux sont requis pour que
                                                       Claude sélectionne CIMD

── Document CIMD (servi à l'URL qui est le client_id) ──
client_id           (URL https AVEC composant de chemin, auto-référentielle)  ── requis
client_name                                                                   ── requis
redirect_uris       (array)                                                   ── requis
client_uri, logo_uri, grant_types, response_types
token_endpoint_auth_method: "none"    (private_key_jwt possible — MAY — avec JWKS)

── Fallback DCR (déprécié) ──
registration_endpoint
application_type: "native" | "web"    ← section DCR, PAS CIMD

── Taxonomie d'auth des connecteurs Claude ──
oauth_dcr · oauth_cimd · oauth_anthropic_creds · custom_connection
static_headers (beta) · none

── Constantes côté Claude ──
Redirect URI surfaces hébergées : https://claude.ai/api/mcp/auth_callback
CIMD de Claude Code             : https://claude.ai/oauth/claude-code-client-metadata
                                  (loopback RFC 8252, port éphémère ; déclare
                                   http://localhost/callback et http://127.0.0.1/callback)
PKCE                            : code_challenge S256, toujours envoyé
Timeouts                        : 10 s discovery / registration / token — 30 s refresh
Egress Anthropic                : 160.79.104.0/21
oauth_anthropic_creds           : sur demande à mcp-review@anthropic.com
```

Exigences complémentaires côté AS pour être connectable depuis toutes les surfaces Claude : refresh token rotatif, erreurs `invalid_grant` conformes, token endpoint acceptant `application/x-www-form-urlencoded`, et **matching port-agnostique** des redirect URIs loopback (Claude Code tire un port éphémère à chaque fois).

## 3. Sources

- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://claude.com/docs/connectors/building/authentication
- https://claude.com/docs/connectors/building/lazy-authentication

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

La bonne nouvelle d'abord : `src/discovery.ts:28` annonce déjà `token_endpoint_auth_methods_supported: ["none"]` et `code_challenge_methods_supported: ["S256"]` (ligne 27), et `cli/doctor.ts:254-273` en fait déjà une assertion dure (`severity: "fail"` si ce n'est pas exactement `["none"]` / `["S256"]`, sous le libellé « V4 FIX 12 »). La moitié du couple exigé par Claude est donc en place et testée. Le geste minimal est d'ajouter une ligne — `client_id_metadata_document_supported: true` — dans `buildDiscoveryDoc()`.

La mauvaise nouvelle ensuite, et c'est elle qui reclasse la fiche : **il n'y a rien à remplacer**. Le bénéfice annoncé par le bundle (« supprime tout besoin de base de clients dynamiques et de `/register` maison ») ne correspond pas au repo. Il n'existe aucune implémentation de RFC 7591 : pas de `registration_endpoint` dans le document de discovery, pas de table de clients, pas de route `/register` OAuth (le `/api/register` qu'on trouve dans les tests est l'enregistrement d'*agent*, un objet métier sans rapport). Le `client_id` est explicitement ignoré : `src/auth/device-flow.ts:124` fait littéralement `void body.client_id; // documented Phase 2 no-op; Phase 4 wires validation`, et `sdk/src/profiles.ts:7` déclare un champ `client_id?: string` qui n'est consommé nulle part dans le SDK. La dépréciation de DCR est donc, pour nous, un non-événement en termes de code à supprimer.

Ce qui apparaîtrait vraiment, c'est une **capacité** : être un serveur MCP distant connectable depuis Claude.ai, Desktop, mobile et Cowork sans que l'auto-hébergeur ait à pré-enregistrer un client à la main. Aujourd'hui le coordinateur expose bien `/mcp` (`src/serve-http.ts:740`) en Streamable HTTP, mais son `authorization_endpoint` pointe sur `/auth/login` (`src/discovery.ts:16`), c'est-à-dire un écran de login navigateur qui pose des cookies — pas un endpoint d'autorisation OAuth qui émet un code au bénéfice d'un client tiers. Et le `grant_type=authorization_code` du token endpoint (`src/auth/oauth-token.ts:101-133`) n'échange pas un code émis par nous : il échange un code **IdP** (GitHub/Google/OIDC) via `provider.exchangeCode()`. Le coordinateur n'est donc pas encore un AS au sens où CIMD l'entend ; ajouter le flag sans construire l'endpoint d'autorisation ferait mentir la metadata.

**Risque si on ne fait rien :**

Modéré mais réel. Tant que la discovery n'annonce ni `client_id_metadata_document_supported` ni `registration_endpoint`, Claude n'a aucun chemin d'auth automatique vers un coordinateur auto-hébergé : l'utilisateur reste sur `custom_connection` ou sur un header statique, et le déploiement « serveur MCP distant partagé par une équipe » n'est pas accessible sans travail manuel. À l'horizon de la fenêtre de retrait (première révision après 2027-07-28), tout serveur qui n'aura ni pré-enregistrement ni CIMD sera hors des deux seuls chemins restants.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/discovery.ts` | `buildDiscoveryDoc()` — ajouter `client_id_metadata_document_supported: true`. `token_endpoint_auth_methods_supported: ["none"]` (l. 28) et `["S256"]` (l. 27) sont déjà conformes. `authorization_endpoint` (l. 16) pointe sur `/auth/login`, un login cookie : à revoir si on veut un vrai flux code. |
| `src/serve-http.ts:695` | Route `/.well-known/oauth-authorization-server`, gardée par `ctx.phase2Bootstrap` : la discovery n'existe pas quand OAuth est off. Toute exigence CIMD hérite de cette condition. |
| `src/serve-http.ts:740` | Route `/mcp` (Streamable HTTP) — c'est la ressource que Claude voudrait consommer. Il manque `/.well-known/oauth-protected-resource` (RFC 9728) ; aucun `resource_metadata` n'est émis dans les `WWW-Authenticate` (cf. `src/http/response-contract.ts`). |
| `src/auth/oauth-token.ts:101-133` | `handleAuthorizationCodeGrant` échange un code **IdP** via `provider.exchangeCode()`, pas un code émis par nous. Aucun contrôle de `client_id`. C'est le cœur du chantier si on va au bout. |
| `src/auth/device-flow.ts:124` | `void body.client_id; // documented Phase 2 no-op; Phase 4 wires validation` — le point d'accroche naturel d'une validation de `client_id` CIMD, déjà identifié comme dette. |
| `src/auth/oauth-state.ts` | Table `oauth_state` (`state`, `code_verifier`, `redirect_uri`, `provider`, TTL). Réutilisable pour porter le `client_id` CIMD et le `redirect_uri` validé si on émet nos propres codes. |
| `cli/doctor.ts:196-279` | `probeDiscoveryDoc` — ajouter une sonde `client_id_metadata_document_supported`, et une sonde de fetch + validation auto-référentielle du document CIMD. La discipline « fail dur sur la metadata » existe déjà. |
| `sdk/src/discovery.ts:6,18` | `DISCOVERY_PATH` + type de la metadata AS : le champ `client_id_metadata_document_supported` doit y être ajouté pour que le SDK le voie. |
| `sdk/src/profiles.ts:7` | `client_id?: string` déclaré mais jamais consommé. Devient soit l'URL CIMD du profil, soit du code mort à supprimer. |
| `docs/openapi.yaml:901-940` + schéma `DiscoveryDoc` (l. 1193) | L'exemple et le schéma de la discovery sont figés dans l'OpenAPI : toute modification du document se répercute ici. |
| `docs/ARCHITECTURE.md`, `docs/idp-providers.md`, `docs/onboarding-self-host.md` | Le récit « 4 IdP + device flow » doit dire si le coordinateur est un AS pour clients tiers ou seulement un RP devant des IdP. |
| `cli/channel.ts` | **Non concerné** : le serveur MCP stdio des Channels parle MQTT (`buildChannelServer`, `username`/`password`), il ne fait pas d'OAuth. Ne pas l'inclure dans le périmètre. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le coordinateur doit-il devenir un véritable *authorization server* OAuth pour clients MCP tiers — c'est-à-dire construire l'endpoint d'autorisation et l'émission de codes qui n'existent pas aujourd'hui (`authorization_endpoint` = écran de login cookie, `grant_type=authorization_code` = proxy de code IdP) — ou reste-t-il un *relying party* devant 4 IdP, auquel cas `client_id_metadata_document_supported: true` serait une metadata mensongère et CIMD sort du périmètre ?

### 6.2 Hypothèse

> Pré-enregistrée le 2026-08-15, **avant** toute exécution. Le seul fait déjà collecté est la
> lecture de `src/auth/oauth-login.ts:61-150`, qui a motivé le cadrage ci-dessous.

**Hypothèse.** La question de §6.1 est un faux dilemme, parce qu'elle suppose que l'état actuel est
neutre. Il ne l'est pas : `src/discovery.ts` annonce déjà
`response_types_supported: ["code"]` et `grant_types_supported: ["authorization_code"]` avec un
`authorization_endpoint` qui pointe sur `/auth/login`. Or `handleAuthLogin()` **ne lit que
`?provider=`** : il jette `client_id`, `redirect_uri`, `state` et `code_challenge` de l'appelant,
génère son **propre** PKCE et force `redirect_uri` sur notre `/api/auth/oauth/callback`. Un client
tiers ne peut donc structurellement jamais recevoir de code.

Je m'attends donc à ce que la metadata soit **déjà mensongère aujourd'hui**, avant toute question
CIMD — et que le livrable de ce challenge soit ce constat, pas une décision d'adoption.

**Verdict attendu :** `refuser` CIMD (le flag ferait mentir davantage une metadata qui ment déjà),
avec la correction de la metadata existante comme vrai résultat.

**Critères de refus, chiffrés (pré-enregistrés) :**

| # | Le résultat qui tue |
|---|---|
| **K1** | `/auth/login` ignore les paramètres OAuth de l'appelant (prouvé par le code **et** par une requête réelle) → le coordinateur n'est pas un AS, et `client_id_metadata_document_supported: true` serait une metadata mensongère. CIMD sort du périmètre. |
| **K2** | Devenir un AS exige de créer l'émission de codes, l'écran de consentement, la validation de `redirect_uri` par client et la révocation par client — soit **> 6 fichiers** et une surface d'attaque neuve. Rédhibitoire pour un mainteneur unique. |
| **K3** | Le chemin alternatif (RFC 9728 `/.well-known/oauth-protected-resource` + `resource_metadata` dans `WWW-Authenticate`) **ne suffit pas** à faire connecter un client Claude sans devenir AS → aucun chemin bon marché n'existe → `reporter`, pas `adopter`. |
| **K4** | **YAGNI** : aucune demande utilisateur pour « connecter mon coordinateur auto-hébergé depuis Claude.ai ». À mesurer sur le tracker d'issues, pas à supposer. |
| **K5** | La seule preuve de bénéfice exige un domaine HTTPS public joignable depuis l'egress `160.79.104.0/21` → **non atteignable ici**, donc `adopter` est interdit par le protocole quoi qu'il arrive. |
| **K6** | Le socle est toujours un draft IETF `-00` et non une RFC → cible mouvante. |

**Critère d'adoption (ce qu'il faudrait pour dire oui) :** une connexion réelle réussie d'un client
Claude vers le coordinateur, **exécutée ici**, obtenue par un changement borné (≤ 2 fichiers) —
c'est-à-dire sans construire d'AS.

**Ce que je m'engage à trancher même si CIMD tombe :** le sort de `sdk/src/profiles.ts:7`
(`client_id` déclaré, jamais consommé) et l'honnêteté de `buildDiscoveryDoc()`.

### 6.3 Protocole de vérification

*Proposition de protocole, à valider et amender en session. Rien n'a été exécuté.*

> ⚠️ Les étapes impliquant Claude.ai / Desktop / mobile / Cowork ne sont pas exécutables ici : elles exigent un domaine HTTPS public joignable depuis l'egress Anthropic `160.79.104.0/21`.

- [ ] Lire de bout en bout le chemin `/auth/login` → cookie → `/api/auth/oauth/token` et écrire noir sur blanc où un client tiers pourrait recevoir un code d'autorisation : est-ce un ajout ou une réécriture ?
- [ ] Ajouter `client_id_metadata_document_supported: true` dans `buildDiscoveryDoc()` sur une branche jetable, lancer un coordinateur avec `COORDINATOR_PUBLIC_URL` public (tunnel), et tenter une connexion réelle depuis Claude Code puis depuis Claude.ai. Noter l'erreur exacte renvoyée à chaque étape (discovery / autorisation / token).
- [ ] Vérifier que le matching loopback port-agnostique est possible dans `oauth-state.ts` sans casser la validation stricte de `redirect_uri` en place (`src/auth/oauth-callback.ts:175`).
- [ ] Mesurer le coût du chemin alternatif : `/.well-known/oauth-protected-resource` (RFC 9728) + `resource_metadata` dans `WWW-Authenticate`, en déléguant l'autorisation à l'IdP existant. Est-ce suffisant pour que Claude se connecte, sans devenir AS ?
- [ ] Trancher le statut de `sdk/src/profiles.ts:7` (`client_id` inutilisé) : URL CIMD ou suppression.

### 6.4 Résultat observé

> Exécuté le 2026-08-15. Daemon réel lancé avec **`COORDINATOR_OAUTH_ENABLED=true` +
> `COORDINATOR_AUTH_ENABLED=true`**, contre **Claude Code 2.1.233** installé sur ce poste.
> **Frontière exécuté / lu :** (A) à (F) sont exécutés ; (G) est documentaire ; (H) nomme ce qui
> ne l'a pas été. Le dépôt n'a **pas** été modifié : le flag CIMD a été injecté par un proxy
> jetable, pas par une édition de `src/discovery.ts`.

#### (A) L'état de départ, mesuré

Document de discovery servi par le daemon (`/.well-known/oauth-authorization-server`) :

```json
{ "issuer": "http://localhost:3170",
  "authorization_endpoint": "http://localhost:3170/auth/login",
  "grant_types_supported": ["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:device_code"],
  "response_types_supported": ["code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"], … }
```

Deux absences, mesurées :

```
GET /.well-known/oauth-protected-resource   -> 404      (RFC 9728 absent)
client_id_metadata_document_supported       -> absent
```

Et le comportement de `/mcp` **dépend de `COORDINATOR_AUTH_ENABLED`, pas de `OAUTH_ENABLED`** :

```
OAUTH_ENABLED=true, AUTH_ENABLED=false -> POST /mcp = 200 OK, initialize reussit sans token
OAUTH_ENABLED=true, AUTH_ENABLED=true  -> POST /mcp = 401
   WWW-Authenticate: Bearer realm="mcp-coordinator", error="invalid_token"
```

Le `WWW-Authenticate` ne porte **aucun** `resource_metadata` — conforme à ce que §5 annonçait.

#### (B) Ce que Claude Code fait, aujourd'hui, sans rien changer

`claude mcp add --scope local --transport http coordb01 http://127.0.0.1:3170/mcp` puis
`claude mcp get` (qui health-check) :

```
coordb01:
  Status: ✘ Failed to connect
  Issue: Incompatible auth server: does not support dynamic client registration
```

**C'est exactement l'erreur que §4 prédisait**, obtenue ici sans tunnel : Claude Code atteint
`localhost`, contrairement à Claude.ai.

#### (C) Le test de la ligne unique — et il marche

Proxy jetable (`scratchpad/b01/proxy.mjs`) qui forwarde tout vers le daemon **sauf** le document
de discovery, où il injecte **une seule clé** : `client_id_metadata_document_supported: true`.
Daemon relancé avec `COORDINATOR_PUBLIC_URL=http://localhost:3171` pour que l'`issuer` colle.

```
coordcimd:
  Status: ! Needs authentication          <-- au lieu de "✘ Failed to connect"
```

**Une ligne fait passer Claude Code de « incompatible » à « il ne manque plus que le login ».**
Et le fil montre la séquence de découverte exacte, qui n'était documentée nulle part dans la fiche :

```
POST /mcp                                    -> 401 + WWW-Authenticate
GET  /.well-known/oauth-protected-resource/mcp   (RFC 9728, forme avec chemin)
GET  /.well-known/oauth-protected-resource       (RFC 9728, forme racine)
GET  /.well-known/oauth-authorization-server     (RFC 8414, repli)  -> doc avec cimd:true
```

Claude Code tente donc **RFC 9728 d'abord, dans ses deux formes**, et ne retombe sur RFC 8414
qu'en dernier recours.

#### (D) Le flux d'autorisation : Claude Code joue CIMD à la lettre

`claude mcp login coordcimd` construit l'URL d'autorisation et attend le retour :

```
http://localhost:3171/auth/login
  ?response_type=code
  &client_id=https%3A%2F%2Fclaude.ai%2Foauth%2Fclaude-code-client-metadata
  &code_challenge=a0b4JutcwO4EX4ZJ22rKy-xbr20SzRoVtT5jLkKZfJo
  &code_challenge_method=S256
  &redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback
  &state=57S7VXm98QQaEU54dHifumSMCSglb4uH08F0m2hLyBk
```

`client_id` **est** l'URL du document CIMD, et le `redirect_uri` est un loopback à port éphémère
(3118) — exactement ce que §2 décrit. (Le login s'est arrêté sur
*« stdin isn't a terminal »* : il attend que l'humain colle l'URL de retour. Sans conséquence,
puisque la suite se mesure sans lui.)

#### (E) K1 — La preuve qui tue la fiche : rejeu de cette URL exacte

```
HTTP/1.1 302 Found
location: https://github.com/login/oauth/authorize?client_id=Iv1.b01challenge0000
  &redirect_uri=http%3A%2F%2Flocalhost%3A3171%2Fapi%2Fauth%2Foauth%2Fcallback
  &state=ojOBd20s5mLu7c8x1w5iHnD4w4l4E2x7pEFRDpu9eQQ
  &scope=read%3Auser+user%3Aemail+read%3Aorg
  &code_challenge=DnGpd23bpFXMRy0EORSkppjM9AlVnwRDCIIOso_9VC8&code_challenge_method=S256
```

| Paramètre | Claude Code envoie | Le serveur transmet à GitHub |
|---|---|---|
| `client_id` | `https://claude.ai/oauth/claude-code-client-metadata` | **`Iv1.b01challenge0000`** (notre app GitHub) |
| `redirect_uri` | `http://localhost:3118/callback` | **`http://localhost:3171/api/auth/oauth/callback`** (le nôtre) |
| `state` | `57S7VXm98QQaEU54dHifumSMCSglb4uH08F0m2hLyBk` | **`txPDW6mNY51tu29MHLEmk7zTd3om7bzCz4Dt-XqEUWU`** (le nôtre) |
| `code_challenge` | `a0b4JutcwO4EX4ZJ22rKy-xbr20SzRoVtT5jLkKZfJo` | **`KAhAeRPmSvOHfSvzmQyEYIv4VUPGyuk_PF3ZWHR7coU`** (le nôtre) |

**Les quatre paramètres OAuth du client tiers sont jetés et remplacés.** Le port 3118 sur lequel
Claude Code attend ne sera **jamais** appelé ; l'utilisateur finit sur une session à cookie chez
nous. Le flux ne peut pas aboutir, même avec CIMD annoncé.

**K1 est donc déclenché de bout en bout, par la mesure et pas seulement par la lecture du code.**
Et le corollaire est plus grave que la question de §6.1 : **le document de discovery ment déjà
aujourd'hui**, avant toute question CIMD. Il annonce `response_types_supported: ["code"]` et
`grant_types_supported: ["authorization_code"]` avec un `authorization_endpoint` qui ne rend
jamais de code à un appelant.

#### (F) K4 — Aucune demande utilisateur

```
issues totales du dépôt : 61
"claude.ai"            -> 0        "authorization server" -> 0        "CIMD" -> 0
"remote MCP"           -> 2   (#279 scoping dépôt, #69 flag --url du dashboard)
"oauth"                -> 2   (#104 quotas, #79 FK orgs)
```

Aucune n'est une demande de « connecter mon coordinateur auto-hébergé depuis Claude.ai ».
**K4 déclenché.**

#### (G) Preuve documentaire fetchée le 2026-08-15 (non exécutée)

| Fait | Source |
|---|---|
| **CIMD n'est jamais obligatoire.** *« Authorization servers and MCP clients **SHOULD** support OAuth Client ID Metadata Documents »*. Le registre de dépréciation ne liste CIMD que comme *migration path* de DCR. | `/specification/2026-07-28/basic/authorization` |
| **L'ordre de préférence est un SHOULD, et le pré-enregistrement est n°1**, au-dessus de CIMD. | `/basic/authorization/client-registration` |
| **Un serveur MCP n'a pas à être un AS** : *« It may be hosted with the resource server or **a separate entity** »*. | idem |
| **Mais RFC 9728 est un MUST** : *« MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata (RFC9728) »* et le document *« **MUST** include the `authorization_servers` field »*. | `/basic/authorization/authorization-server-discovery` |
| **Anthropic documente explicitement le montage sans AS** : *« Point `authorization_servers` in the PRM at your real issuer and **delete the stub `/authorize` and `/token` handlers** »*. | `claude.com/docs/connectors/building/lazy-authentication` |
| **Condition de sélection CIMD confirmée** : *« Claude selects CIMD only when your authorization server metadata advertises **both** … If either is missing, Claude falls back to DCR. »* | `claude.com/docs/connectors/building/authentication` |
| **DCR : pas de date de retrait ferme.** *« Earliest removal: First revision released on or after 2027-07-28 »*, et *« No features have been removed under this policy yet. »* | `/specification/2026-07-28/deprecated` |
| **Le draft IETF est passé à `-02`** (2026-07-06, actif, expire le **2027-01-07**) — alors que la spec MCP référence normativement **`-00`**. Écart de version que la fiche ne mentionne pas. | datatracker (vérifié par moi : `rev: 02 | expires: 2027-01-07`) |

**Le blocage qui tue le chemin bon marché, vérifié par moi et non repris sur parole :**

```
https://github.com/.well-known/oauth-authorization-server        -> HTTP 404
https://accounts.google.com/.well-known/openid-configuration :
   registration_endpoint                        -> ABSENT
   client_id_metadata_document_supported        -> ABSENT
   token_endpoint_auth_methods_supported        -> ["client_secret_post","client_secret_basic"]
```

**Aucun de nos IdP ne peut figurer dans `authorization_servers`** : GitHub ne publie pas de
metadata RFC 8414 du tout, et Google n'a ni `registration_endpoint`, ni le flag CIMD, ni `"none"`.
Le montage « je délègue à mon IdP » — que la doc d'Anthropic présente comme la voie propre —
**ne fonctionne pas avec les 4 IdP du projet**. Il exigerait un vrai AS tiers (Keycloak, Auth0).

#### (H) Ce qui n'a PAS été exécuté

- **Le parcours depuis Claude.ai / Desktop / mobile / Cowork.** Il exige un domaine HTTPS public
  joignable depuis l'egress `160.79.104.0/21`. **K5 tient** : la seule preuve de bénéfice pour ces
  surfaces est hors de portée ici, donc `adopter` est interdit pour elles quoi qu'il arrive.
- **Le flux de login complet jusqu'au token**, faute de terminal interactif et d'une vraie app
  GitHub. Sans conséquence : (E) prouve que le flux ne peut pas aboutir de toute façon.
- **Aucun test avec un AS tiers réel** (Keycloak/Auth0) devant le coordinateur.

#### (J) Ce que la passe adversariale a corrigé dans mes propres mesures

**(1) Le chemin bon marché existe, il marche aujourd'hui, et il ne passe pas par CIMD.**
C'est la correction la plus importante de ce challenge. Signalé par un réfutateur, **re-exécuté
et confirmé par moi**, sur le daemon réel avec `COORDINATOR_AUTH_ENABLED=true`, **zéro ligne de
code modifiée** :

```
$ claude mcp add --scope local --transport http b01hdr http://127.0.0.1:3170/mcp \
      --header "Authorization: Bearer <JWT HS256 minté avec COORDINATOR_JWT_SECRET>"
$ claude mcp get b01hdr
  Status: ✔ Connected
  Type: http
```

Et les outils répondent réellement de bout en bout :

```
$ claude -p "Appelle l'outil coordinator_status…"  --allowedTools mcp__coord__coordinator_status
RESULT: "Coordinateur inactif mais sain : 0 agent en ligne, 0 thread ouvert ou en résolution,
         0 fichier chaud, MQTT connecté."     turns: 3
```

Quand `headers.Authorization` est posé, **Claude Code ne fait aucune découverte OAuth** — la
question CIMD ne se pose même plus. Côté Claude.ai l'équivalent est `static_headers`
(`authorization` est sur l'allowlist des en-têtes acceptés), en **beta sur demande**.
Coûts à documenter, pas des bloqueurs : le jeton a une TTL (24 h par défaut pour un token
d'agent, **plafond 90 j en dur** pour un service token — `SERVICE_TOKEN_MAX_TTL_S`), donc
rotation périodique manuelle.

**Conséquence sur K3, et il faut l'écrire :** K3 était pré-enregistré comme *« … → **aucun chemin
bon marché n'existe** → `reporter`, pas `adopter` »*. Sa **prémisse est fausse** : un chemin bon
marché existe. Sa première moitié (RFC 9728 ne suffit pas sans AS) reste vraie et confirmée.

**(2) `/.well-known/oauth-protected-resource` renvoie 401, pas 404.** Mon 404 de (A) a été mesuré
**auth désactivée** — incohérent avec le reste de §6.4. Re-mesuré par moi sous
`AUTH_ENABLED=true` :

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="mcp-coordinator", error="invalid_token"
{"component":"auth","reason":"Missing or invalid Authorization header",
 "url":"/.well-known/oauth-protected-resource","msg":"Auth rejected"}
```

Mécanisme : le chemin n'est pas routé, il tombe dans le garde d'auth (`serve-http.ts:855-871`)
**avant** le 404 — alors que `/.well-known/oauth-authorization-server`, lui, est routé et répond
**200** sans auth. Conséquence non cosmétique : RFC 9728 exige le document PRM joignable **sans
authentification** ; le jour où il serait implémenté, il devra être exempté du garde. Et
aujourd'hui un client sondeur reçoit une boucle d'auth apparente, pas une absence propre.

**(3) « Aucun de nos 4 IdP ne peut figurer dans `authorization_servers` » est indémontrable tel
qu'écrit.** Les quatre providers sont `GitHubProvider`, `GitHubAppProvider`, `GoogleProvider` et
**`OIDCProvider`** — ce dernier est une **classe** d'IdP (`src/auth/providers/oidc.ts` :
« Verified against Okta, Auth0, Azure AD, Keycloak, and Authentik »), pas un IdP. Un Keycloak
publierait très bien RFC 8414. **Le vrai blocage est ailleurs et il est structurel** : notre
resource server ne sait valider que **nos propres** jetons —

```ts
// src/auth.ts:339-341
algorithms: ["HS256"],
issuer: ctx.publicUrl.replace(/\/$/, ""),
```

HS256 **symétrique**, issuer = nous. Un access token RS256 émis par un AS tiers est
structurellement rejeté. Déléguer imposerait de réécrire la validation (RS256, JWKS distant,
allowlist d'issuers, audience) — sans commune mesure avec « ≤ 2 fichiers ».
**GitHub reste néanmoins inutilisable** : 404 sur `/.well-known/oauth-authorization-server` **et**
sur `/.well-known/openid-configuration` (vérifié par moi).

**(4) « Needs authentication » est un verdict purement syntaxique.** Un serveur bidon exposant
**uniquement** un document RFC 8414 avec le flag CIMD — sans `/auth/login`, sans token endpoint,
sans rien — obtient lui aussi `! Needs authentication`. L'étiquette ne dit **rien** de la capacité
du flux à aboutir. Cela **renforce** (E) : poser le flag ne fait que changer le libellé, et
`claude mcp login` affiche alors `Waiting for authorization…` sur un AS mort.

**(5) K2 est chiffré au lieu d'être estimé — et il se déclenche.** La table `oauth_state`
(`src/database.ts:906-915`) stocke `state, code_verifier, redirect_uri, provider, org_id, …` où
`redirect_uri` est **le nôtre vers l'IdP**. Porter les paramètres d'un client tiers impose une
**migration de schéma**, plus `oauth-login.ts`, `oauth-callback.ts`, `oauth-finalize.ts`,
`oauth-token.ts`, `discovery.ts`, un fetcher CIMD neuf avec garde SSRF, `cli/doctor.ts`,
`docs/openapi.yaml` → **≥ 8 fichiers + migration**. Seuil de 6 franchi.
Deux corrections d'honnêteté : l'**écran de consentement existe déjà**
(`src/auth/pages/device-confirm.html.ts`), et le créneau `grant_type=authorization_code` est
**déjà occupé** par une sémantique incompatible — ce n'est donc pas un ajout, c'est une
réécriture.

**(6) « La metadata ment » était trop large — deux champs sur trois seulement.**
Vérifié par moi : `grant_types_supported: ["authorization_code"]` est **vrai**. Le grant est
dispatché (`oauth-token.ts:425`), documenté (`docs/openapi.yaml:200` : « `authorization_code` —
CLI code-grant (RFC 6749 §4.1.3) »), et **complétable** — `providers/github.ts` transmet le
`redirectUri` **de l'appelant** à GitHub, donc un CLI dont le callback est enregistré sur l'app
GitHub de l'auto-hébergeur boucle le flux. Ne mentent que :

- **`authorization_endpoint`** — RFC 8414 le définit comme l'authorization endpoint RFC 6749 ;
  `/auth/login` n'en est pas un ((E) le mesure) ;
- **`response_types_supported: ["code"]`** — ce sont les `response_type` que l'authorization
  endpoint honore ; le nôtre n'en honore aucun.

Et la preuve la mieux localisée n'est pas dans la discovery mais dans `docs/openapi.yaml:1021`,
qui documente un chemin **impossible** : *« PKCE verifier (REQUIRED when `/auth/login` was used…) »*
— or `/auth/login` génère le verifier lui-même (`oauth-login.ts:113`) et le range dans
`oauth_state` ; un client passé par là ne détient ni le code ni le verifier.

**Coût de la correction, à ne pas sous-estimer** : `tests/unit/discovery.test.ts:43` verrouille
`authorization_endpoint`, `:78` verrouille `response_types_supported === ["code"]`, et
`docs/openapi.yaml` les déclare `required` dans le schéma `DiscoveryDoc`. C'est un contrat publié.

**(7) K5 était décoratif.** Il ne reformule que le champ *Testabilité* de la §0, écrit le
2026-08-14 — la veille du pré-enregistrement — et la variante « ⚠️ partielle » du protocole, qui
interdit déjà `adopter` sur la partie non exécutée. De plus il n'arbitre pas entre `refuser` et
`reporter`. Sur 6 critères, **1 était décoratif**.

**(8) Le socle normatif bouge : le draft est à `-02`, pas `-00`.** Vérifié par moi
(`rev: 02 | expires: 2027-01-07`, actif). Et le diff `-00` → `-02` change précisément les règles
qu'un AS implémenteur devrait coder : comparaison des Client Identifier URL en *simple string
comparison*, plafond de lecture recommandé à **5 Ko**, `private_key_jwt` renvoyé à RFC 7523 §2.2,
exception loopback interdite en production, nouvelle §4.1 interdisant tout matériel de clé privée.
Un AS codé contre `-00` serait **non conforme aujourd'hui**. Le contre-argument §6.5 « socle
en draft `-00` » est donc à **réécrire, pas à barrer** : le problème n'est pas l'immaturité, c'est
que **MCP référence `-00` pendant que l'IETF est à `-02`** — un implémenteur ne sait pas laquelle
des deux satisfaire.

#### (I) Trois défauts trouvés en séance, hors périmètre

1. **Le log de démarrage perd le message d'erreur.** `serve-http.ts:1461` fait
   `log.fatal({ err }, "Fatal startup error")` et pino sérialise `err: {}` — vide. Il a fallu
   instrumenter `startServer()` pour apprendre que le vrai message était
   `secret entropy: contains dictionary word "secret"`. Un auto-hébergeur qui se trompe de secret
   voit un échec **sans motif**. (Deux autres échecs de boot, eux, ont un message clair :
   `COORDINATOR_REGISTRATION_SECRET is required when auth is enabled`, puis `..._ADMIN_SECRET`.)
2. **`/mcp` est ouvert quand `COORDINATOR_OAUTH_ENABLED=true` mais `COORDINATOR_AUTH_ENABLED=false`.**
   Activer OAuth seul ne protège pas l'endpoint MCP. C'est cohérent avec le code, mais c'est un
   piège de configuration pour qui croit qu'« OAuth activé » suffit.
3. **`docs/openapi.yaml:1021` documente un chemin impossible** — voir (J)(6). Un client qui suit
   la doc à la lettre ne peut pas exister.

### 6.5 Contre-arguments

- **Le bénéfice annoncé n'existe pas dans ce repo.** Le bundle vend la suppression d'un `/register` maison et d'une base de clients dynamiques. Ni l'un ni l'autre n'existent (§5). La fiche est classée `replace-homemade-code` par le bundle ; c'est en réalité de l'`integration`, avec un coût net positif, pas une simplification.

- **Le socle normatif est un draft IETF `-00`.** `draft-ietf-oauth-client-id-metadata-document-00` n'est pas une RFC. Adopter maintenant, c'est s'exposer à une renumérotation de champs ou à un changement de règle de validation avant stabilisation — pour un projet dont la surface d'auth est déjà l'une des plus coûteuses à maintenir (`src/auth/refresh-rotation.ts` fait 36 Ko à lui seul).

- **Devenir un AS complet est un changement de nature du projet.** Aujourd'hui le coordinateur délègue toute l'identité à GitHub / Google / OIDC. Émettre ses propres codes d'autorisation pour des clients tiers, c'est assumer la validation de `redirect_uri`, le consentement utilisateur, la révocation par client, et l'écran de consentement. C'est une surface d'attaque nouvelle, dans un projet à mainteneur unique.

- **Fetch sortant déclenché par un attaquant.** Valider un CIMD signifie que le coordinateur fait un `GET` HTTPS vers une URL fournie par le client. C'est une primitive SSRF à cadrer (allowlist ? résolution DNS ? timeouts ? taille max ? redirections ?) et un vecteur d'amplification. Pour un auto-hébergeur derrière un réseau d'entreprise, ce n'est pas neutre.

- **Le cache CIMD est un état distribué de plus.** La spec impose de respecter les en-têtes HTTP de cache. Ça ajoute un cache à invalider, à observer, à purger — dans un projet qui gère déjà `membership-cache.ts`, `token-epoch.ts` et un sweeper.

- **YAGNI sur le profil de déploiement actuel.** Le mode dominant est un coordinateur local ou d'équipe, où les agents s'authentifient par device flow ou service token. Personne n'a demandé « connecter mon coordinateur auto-hébergé depuis Claude.ai ». Tant que ce besoin n'est pas exprimé, c'est de l'ingénierie spéculative.

- **La fenêtre est longue.** DCR reste utilisable jusqu'à la première révision publiée après 2027-07-28, et nous n'implémentons pas DCR de toute façon — donc l'échéance ne nous met sous pression sur *rien*. Attendre que le draft OAuth devienne une RFC coûte peu.

- **Chemin moins cher disponible.** `oauth_anthropic_creds` (credentials côté Anthropic, sur demande à `mcp-review@anthropic.com`) et le pré-enregistrement manuel restent des options conformes qui n'exigent pas de devenir un AS. À comparer sérieusement avant de coder quoi que ce soit.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** (devenir AS / chemin remote) · ✅ **refuser** (le flag CIMD) |
| **Date** | 2026-08-15 |
| **Justification** | **La capacité que CIMD achèterait, on l'a déjà — mesurée aujourd'hui, à zéro ligne de code.** `claude mcp add --header "Authorization: Bearer <JWT>"` donne `✔ Connected` et les 26 outils répondent. CIMD passe donc de « cher pour une capacité absente » à « cher pour une capacité qu'on a déjà ». Et poser le flag seul est **strictement pire que rien** : mesuré, il fait passer Claude Code d'une erreur claire (`Incompatible auth server`) à un `Waiting for authorization…` qui ne peut jamais aboutir — le rejeu de l'URL exacte de `claude mcp login` montre que `/auth/login` **ne lit jamais** les paramètres OAuth de l'appelant et transmet les siens à GitHub. Devenir un vrai AS coûte **≥ 8 fichiers + une migration de schéma** et se heurte à un créneau `grant_type=authorization_code` déjà occupé par une sémantique incompatible. |
| **Issue / PR** | Aucune créée. Deux périmètres proposés en §7.4, **à confirmer avec le mainteneur**. |
| **Jalon visé** | — |

### 7.1 La réponse à la question de §6.1

**§6.1 pose un dilemme à deux termes, et il en manque un troisième qui est l'état réel.**

La question demande : *AS pour clients tiers, ou RP devant 4 IdP ?* La mesure répond : **ni l'un
ni l'autre — nous sommes un RP qui s'annonce AS.** `/.well-known/oauth-authorization-server`
publie `authorization_endpoint`, `response_types_supported: ["code"]` et
`grant_types_supported: ["authorization_code"]`, mais l'endpoint annoncé
(`/auth/login`) **ne lit aucun paramètre OAuth** : (E) montre les quatre paramètres de Claude Code
remplacés par les nôtres dans le 302 vers GitHub. Ce troisième terme n'est pas une nuance : c'est
lui qui rend le flag CIMD nuisible, parce que le flag est précisément ce qui fait *croire* à
Claude Code que l'endpoint est utilisable.

**Réponse aux deux termes posés :**

- **Devenir AS : non, et le chiffre le dit.** ≥ 8 fichiers + migration de `oauth_state`, un
  fetcher CIMD avec garde SSRF, et surtout un créneau `authorization_code` **déjà occupé** par
  l'échange d'un code IdP (`oauth-token.ts:133`) — donc une réécriture, pas un ajout. C'est
  exactement la question que §6.3 posait (« est-ce un ajout ou une réécriture ? ») : **c'est une
  réécriture.**
- **Rester RP : oui, mais ce n'est pas suffisant comme réponse**, parce que §6.1 suppose qu'un RP
  n'est pas connectable depuis Claude. **Faux, et mesuré** : le montage `service token +
  --header` est connecté aujourd'hui, sans OAuth du tout.

**Et §6.1 laisse hors champ une non-conformité que ce challenge a trouvée** : la spec
`2026-07-28` dit *« MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata
(RFC 9728) »*. Grep : **0 occurrence** de `oauth-protected-resource` ou `resource_metadata` dans
`src/`, `sdk/src/`, `cli/`. C'est un MUST violé, indépendant de CIMD, et il appartient à
[`B04`](B04-scope-step-up-lazy-auth.md) autant qu'à cette fiche.

### 7.2 Ce qui est refusé : le flag `client_id_metadata_document_supported`

Trois mesures, dans l'ordre de force :

1. **Poser le flag dégrade l'expérience au lieu de l'améliorer.** Sans lui :
   `✘ Failed to connect — Incompatible auth server: does not support dynamic client registration`
   — un message actionnable. Avec lui : `! Needs authentication`, puis
   `Waiting for authorization…` sur un flux qui ne peut pas aboutir. Et l'étiquette
   « Needs authentication » est **purement syntaxique** : un serveur bidon n'exposant qu'un
   document de découverte l'obtient aussi (J)(4).
2. **Le flux ne peut pas aboutir** : (E), rejeu de l'URL exacte de `claude mcp login`. Les quatre
   paramètres sont remplacés ; le port loopback 3118 n'est jamais appelé.
3. **K4 : zéro demande** sur 61 issues (`claude.ai` → 0, `authorization server` → 0, `CIMD` → 0).

### 7.3 Ce qui est reporté : devenir AS et le chemin remote

**Je m'écarte ici de la conséquence que j'avais pré-enregistrée, et je le dis.** K3 était écrit
*« … → aucun chemin bon marché n'existe → `reporter`, pas `adopter` »*. Sa **prémisse est fausse**
— un chemin bon marché existe (J)(1) — mais sa conclusion `reporter` reste la bonne pour le volet
« devenir AS », pour un motif **neuf et mesuré** : ce n'est plus « aucun chemin n'existe », c'est
« le chemin qui existe rend le chantier inutile ». Le verdict est donc scindé, au précédent
[`A07`](A07-elicitation.md) / [`A09`](A09-extensions-grouping-skills.md) / [`A10`](A10-registry-servercard-conformance.md).

**Conditions de réveil, nommées et falsifiables :**

1. **Un auto-hébergeur demande la connexion depuis Claude.ai** (issue sur le tracker). C'est la
   seule surface que le montage `--header` ne couvre pas sans la beta `static_headers`.
2. **La beta `static_headers` de Claude.ai ferme** ou reste inaccessible à un auto-hébergeur.
3. **Le montage « AS tiers en façade » est testé** — Keycloak ou Auth0 devant le coordinateur.
   **Jamais exécuté ici** (§6.4 H). C'est le montage qu'Anthropic documente (*« Point
   `authorization_servers` in the PRM at your real issuer and delete the stub `/authorize` and
   `/token` handlers »*), et il suppose de réécrire la validation de jeton (aujourd'hui HS256 +
   issuer = nous, `src/auth.ts:339-341`) pour accepter du RS256 d'un issuer tiers.

**Ce qui n'est pas une condition de réveil : la dépréciation de DCR.** Nous n'implémentons pas
DCR, la fenêtre est *« first revision released on or after 2027-07-28 »*, et le registre précise
*« No features have been removed under this policy yet. »* L'échéance ne nous met sous pression
sur rien.

### 7.4 Les deux vrais livrables — de la doc et une correction, pas une feature

**(a) Documenter le montage qui marche.** C'est le résultat le plus utile de ce challenge, et il
ne demande aucune ligne de code applicatif : `docs/onboarding-self-host.md` devrait dire comment
connecter un client Claude à un coordinateur auto-hébergé — émettre un service token, le poser en
`--header "Authorization: Bearer …"` (Claude Code, non gaté) ou en `static_headers` (Claude.ai,
beta sur demande) — avec la rotation (TTL 24 h par défaut, **plafond 90 j** pour un service token)
et l'avertissement d'Anthropic sur les tunnels (*« Keep authentication enabled on your server
while tunneling »*). Et dire noir sur blanc que **le coordinateur est un relying party, pas un
authorization server**.

**(b) Cesser d'annoncer ce qu'on ne fait pas.** Deux champs de `buildDiscoveryDoc()` sont faux —
`authorization_endpoint` et `response_types_supported` — plus `docs/openapi.yaml:1021` qui
documente un chemin impossible. **Attention au coût** : `tests/unit/discovery.test.ts:43` et `:78`
les verrouillent, et le schéma `DiscoveryDoc` de l'OpenAPI les déclare `required`. C'est un
contrat publié, donc ≥ 4 fichiers et un changement de surface. À noter aussi qu'**aucune victime
n'est mesurée aujourd'hui** : Claude Code sans le flag échoue en amont sans jamais toucher
l'`authorization_endpoint`, et le SDK maison n'utilise que `refresh_token` et `device_code`. Le
mensonge est **latent** — il ne mord que si on pose le flag, ce que §7.2 refuse. À traiter comme
de l'hygiène de contrat, pas comme la réparation d'une panne en cours.

### 7.5 Impasses vérifiées, pour qu'on ne les rouvre pas

- **Le device flow ne mène nulle part.** Le dépôt a un device flow complet et annoncé
  (`device_authorization_endpoint`), mais RFC 8628 est **absent** de toute la surface MCP/Claude :
  zéro occurrence de `device_code` / `8628` sur les quatre pages d'autorisation de la spec
  `2026-07-28`, sur `claude.com/docs/connectors/building/authentication` et sur
  `code.claude.com/docs/en/mcp` ; le CIMD de Claude Code déclare
  `"grant_types": ["authorization_code","refresh_token"]`. **Aucun client Claude ne sait le
  consommer.** C'est l'impasse la plus tentante, parce que le code existe déjà.
- **Le pré-enregistrement (`--client-id` / `--callback-port`) ne résout rien.** Il saute l'étape
  d'enregistrement ; la redirection et l'émission de code restent identiques. Notre problème n'est
  pas l'enregistrement du client, c'est qu'on n'émet jamais de code.
- **`client_credentials` est explicitement refusé** par Anthropic : *« A pure machine-to-machine
  `client_credentials` grant … is **not supported**. Every connection requires user consent. »*
- **Le mode authless derrière un tunnel** marche (`✔ Connected`) mais exposerait 26 outils
  d'écriture sans authentification. Dominé sur tous les axes par le montage `--header`, à coût
  identique.

### 7.6 Corrections à porter dans les sections 1 à 5

1. **En-tête, §1 (c) et §6.5** — « draft IETF `-00` » : le draft est à **`-02`** (2026-07-06,
   actif, expire le 2027-01-07). Le contre-argument reste valide mais change de nature : le
   problème n'est pas l'immaturité, c'est que **MCP référence normativement `-00` pendant que
   l'IETF est à `-02`**, avec des règles de validation qui ont changé entre les deux.
2. **§4 « Risque si on ne fait rien » : *modéré* → *faible*.** L'affirmation « le déploiement
   *serveur MCP distant partagé par une équipe* n'est pas accessible sans travail manuel » est
   **fausse** : mesurée à `✔ Connected` avec un header statique.
3. **§5, `src/auth/device-flow.ts:124`** — décrit comme « dette déjà identifiée ». Le code dit
   `documented Phase 2 no-op; Phase 4 wires validation` et les lignes 112-114 justifient le no-op
   par le déploiement mono-client. C'est un **choix documenté**, pas une dette.
4. **§6.3** — la mention de `src/auth/oauth-callback.ts:175` comme « validation stricte de
   `redirect_uri` en place » est inexacte (déjà signalé en §0) : la canonicalisation est en
   `src/auth/oauth-login.ts:125`.

### 7.7 L'engagement de §6.2 sur `sdk/src/profiles.ts:7`

**Tranché : à supprimer.** Vérifié — `client_id` est déclaré ligne 7, et
`grep -rn "client_id" sdk/src/` ne remonte **que cette déclaration** : il n'est lu nulle part dans
le SDK. Il est en revanche parsé et asserté par les tests de profils, donc c'est de la
**configuration morte sous test**. Ce n'est pas une URL CIMD en puissance : puisque CIMD est
refusé, le champ n'a pas de futur. À retirer avec ses assertions, dans le lot (b) de §7.4.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : §2 confirmée mot à mot, ligne du schéma `DiscoveryDoc` corrigée (1234 → 1193). |
| 2026-08-15 | Challenge. Daemon réel avec `OAUTH_ENABLED` + `AUTH_ENABLED`, Claude Code 2.1.233, proxy jetable injectant le flag CIMD, 3 réfutateurs adversariaux. **Verdict : `refuser` le flag CIMD, `reporter` le fait de devenir AS.** Mesuré : sans flag `✘ Failed to connect — Incompatible auth server` ; avec flag `! Needs authentication` puis un login qui pend ; et le rejeu de l'URL exacte de `claude mcp login` montre les **4 paramètres OAuth du client remplacés** par les nôtres dans le 302 vers GitHub. **La passe adversariale a produit le résultat central : le chemin bon marché existe déjà** — `claude mcp add --header "Authorization: Bearer <JWT>"` donne `✔ Connected` et les 26 outils répondent, **zéro ligne de code** ; re-exécuté et confirmé par moi. Trois de mes mesures corrigées : le PRM renvoie **401 et non 404** (il tombe dans le garde d'auth avant le 404) ; « aucun de nos 4 IdP » est indémontrable (le 4ᵉ est une classe OIDC — le vrai blocage est HS256 + issuer = nous, `src/auth.ts:339`) ; et « la metadata ment » ne vaut que pour **2 champs sur 3** (`grant_types_supported` est vrai, le grant est vivant et documenté). Impasses vérifiées et consignées : device flow (RFC 8628 absent de toute la surface MCP/Claude), pré-enregistrement, `client_credentials`, mode authless. |
