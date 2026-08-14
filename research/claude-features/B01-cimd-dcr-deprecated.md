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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

*Proposition de protocole, à valider et amender en session. Rien n'a été exécuté.*

> ⚠️ Les étapes impliquant Claude.ai / Desktop / mobile / Cowork ne sont pas exécutables ici : elles exigent un domaine HTTPS public joignable depuis l'egress Anthropic `160.79.104.0/21`.

- [ ] Lire de bout en bout le chemin `/auth/login` → cookie → `/api/auth/oauth/token` et écrire noir sur blanc où un client tiers pourrait recevoir un code d'autorisation : est-ce un ajout ou une réécriture ?
- [ ] Ajouter `client_id_metadata_document_supported: true` dans `buildDiscoveryDoc()` sur une branche jetable, lancer un coordinateur avec `COORDINATOR_PUBLIC_URL` public (tunnel), et tenter une connexion réelle depuis Claude Code puis depuis Claude.ai. Noter l'erreur exacte renvoyée à chaque étape (discovery / autorisation / token).
- [ ] Vérifier que le matching loopback port-agnostique est possible dans `oauth-state.ts` sans casser la validation stricte de `redirect_uri` en place (`src/auth/oauth-callback.ts:175`).
- [ ] Mesurer le coût du chemin alternatif : `/.well-known/oauth-protected-resource` (RFC 9728) + `resource_metadata` dans `WWW-Authenticate`, en déléguant l'autorisation à l'IdP existant. Est-ce suffisant pour que Claude se connecte, sans devenir AS ?
- [ ] Trancher le statut de `sdk/src/profiles.ts:7` (`client_id` inutilisé) : URL CIMD ou suppression.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : §2 confirmée mot à mot, ligne du schéma `DiscoveryDoc` corrigée (1234 → 1193). |
