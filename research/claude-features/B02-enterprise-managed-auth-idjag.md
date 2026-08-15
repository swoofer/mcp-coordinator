# B02 — Enterprise-Managed Authorization (ID-JAG) et OAuth Client Credentials

| Champ | Valeur |
|---|---|
| **ID** | `enterprise-managed-auth-idjag` |
| **Surface** | mcp-spec |
| **Statut** | mixte : EMA **stable côté spec MCP** (`ext-auth/specification/stable/`, SEP-990) mais **beta + waitlist côté Claude** (Team/Enterprise, `claude.com/docs/connectors/building/enterprise-managed-auth`) · OAuth Client Credentials **draft** (`specification/draft/`, `Protocol Revision: draft`) |
| **Disponible depuis** | EMA : 2026-06-18 · durcissement du cœur auth : spec 2026-07-28 · Client Credentials : non daté |
| **Tier** | ~~T2-fort-levier~~ **T3** (challenge 2026-08-15 : aucun IdP déployable n'émet, 0 demande, socle IETF expirant) |
| **Nature** | opportunity (volet EMA) · ~~replace-homemade-code~~ **opportunity** (volet M2M — challenge 2026-08-15 : on n'enlève rien, cf. §7.3) |
| **Effort estimé** | L |
| **Confiance veille** | high (EMA) · medium (Client Credentials) |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — bout-en-bout EMA bloqué par la waitlist beta Claude |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — `reporter` EMA, `refuser` le volet Client Credentials |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **Statut** précisé : la spec MCP EMA est bien en `specification/stable/`, mais l'implémentation Claude est en **beta + waitlist**, réservée aux plans Team/Enterprise (`claude.com/docs/connectors/building/enterprise-managed-auth`). La fiche disait « GA/stable » sans distinguer les deux plans.
- **§2 — `grant_profile` (marqueur `(à vérifier)` tranché)** : ce n'est **pas** un paramètre de la requête de token-exchange. `urn:ietf:params:oauth:grant-profile:id-jag` est une valeur annoncée par l'AS de la ressource dans sa métadonnée de discovery, sous le champ **`authorization_grant_profiles_supported`** (spec `ext-auth/specification/stable/enterprise-managed-authorization.mdx`). Corrigé dans le bloc.
- **§2 — chemin du SDK TypeScript faux.** `ClientCredentialsProvider` / `PrivateKeyJwtProvider` ne viennent pas d'un paquet `@modelcontextprotocol/client` (qui n'existe pas) mais de `@modelcontextprotocol/sdk/client/auth-extensions.js` — vérifié dans `node_modules`. Une troisième classe, `StaticPrivateKeyJwtProvider`, y est aussi exportée.
- **§2 / §5 — révision de protocole du SDK installé tranchée** : `@modelcontextprotocol/sdk@^1.29.0` expose `LATEST_PROTOCOL_VERSION = "2025-11-25"` (supportées : 2025-11-25 → 2024-10-07). **Pas** de 2026-07-28, **pas** de `server/discover`, et la chaîne littérale `io.modelcontextprotocol/clientCapabilities` est absente du `dist/`. La négociation d'extension n'est donc pas implémentable avec le SDK actuellement en dépendance.
- **§2 — requête réellement émise par Claude ajoutée** (source Anthropic) : `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=…&client_id=…&scope=…&resource=…`, et l'AS doit lister le grant `jwt-bearer` dans `grant_types_supported` pour que la feature soit proposée. Aucun token-exchange RFC 8693 ne frappe notre AS — il n'existe qu'entre le client et l'IdP.
- **§2 — divergence « adoption client » précisée** : la matrice `/extensions/client-matrix` ne coche EMA que pour Archestra.AI et ne coche `oauth-client-credentials` pour **aucun** client, mais la matrice indique elle-même que le support des extensions auth « est suivi séparément » des colonnes affichées. Anthropic documente sa propre implémentation EMA en beta. « Non coché » ≠ « non implémenté ».
- **§2 — noms Python confirmés verbatim** dans `python-sdk/src/mcp/client/auth/extensions/client_credentials.py` : `ClientCredentialsOAuthProvider`, `SignedJWTParameters`, `PrivateKeyJWTOAuthProvider`.
- **§5 — `oidc.ts` : `listMemberships` throw ligne 269** (la 270 est la chaîne du message), corrigé.
- **§5 — ligne `package.json`** : le « à vérifier » est levé (voir ci-dessus).
- Ajout d'une ligne à §6.3 signalant la partie non exécutable ici, et de deux sources Anthropic à §3.

**Vérifié et exact, non modifié :** identifiants d'extension `io.modelcontextprotocol/enterprise-managed-authorization` et `io.modelcontextprotocol/oauth-client-credentials` ; les trois URN du token-exchange (`token-exchange`, `id-jag`, `id_token`) et le `jwt-bearer` de redemption ; le modèle de capabilities par requête `params._meta["io.modelcontextprotocol/clientCapabilities"].extensions` ; le mapping `sub` avec repli `email` ; les quatre points du durcissement 2026-07-28 (`iss`/RFC 9207, `application_type`, credentials liés à l'AS, DCR déprécié au profit de CIMD, rétrocompatible) ; la contradiction Anthropic sur `client_credentials` pur (« A pure machine-to-machine `client_credentials` grant … is **not supported** »). Côté repo : `src/discovery.ts` lignes 21-25 / 28 et absence de `registration_endpoint`, `switch (grantType)` à `src/auth/oauth-token.ts:424` avec `unsupported_grant_type` par défaut, `jwtVerify` `oidc.ts:194` (`issuer`/`audience`/RS256), cross-check discovery 300-306, `createRemoteJWKSet` ligne 320, `authenticateRequest` `src/auth.ts:477`, `serve-http.ts:695`, `oauth-callback.ts:448` sans aucune lecture d'un `iss` de query, `sdk/src/client.ts` 58-61, HS256 + kids `hs256-v1`/`hs256-v0`, plafond 90 j et `service_account: true` des service tokens. Tous les fichiers cités en §5 existent.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
Exécutable ici tout de suite : l'inspection du SDK (déjà faite, verdict négatif), l'audit RFC 9207 de `oauth-callback.ts` pour les 4 providers, et surtout le PoC — une branche `urn:ietf:params:oauth:grant-type:jwt-bearer` dans le `switch` de `src/auth/oauth-token.ts` qui valide une assertion signée par un Keycloak local via `createRemoteJWKSet`/`jwtVerify` puis appelle `mintAccessJWT`, plus l'ajout du grant dans `grant_types_supported`. Cela suffit à mesurer le volume de code réel, qui est le cœur de la question de §6.1.
Non exécutable ici : le bout-en-bout EMA passant par Claude, qui exige une organisation Claude Team/Enterprise avec EMA activé — feature **en beta sur waitlist** — et un IdP émetteur d'ID-JAG (Okta Cross App Access). Le playground `xaa.dev` d'Okta permet théoriquement de pointer sur notre propre AS sans org Claude, mais dépend d'un service tiers externe non provisionné ici.

---

## 1. Ce que c'est

Deux extensions officielles du dépôt `modelcontextprotocol/ext-auth`, plus un durcissement du cœur auth livré avec la révision de protocole 2026-07-28.

**Enterprise-Managed Authorization (EMA)** déplace la décision d'autorisation vers l'IdP de l'entreprise. Le client MCP s'authentifie une fois en SSO auprès de l'IdP et conserve l'assertion d'identité (ID Token OIDC ou assertion SAML). Il l'échange ensuite, par token-exchange RFC 8693, contre un **ID-JAG** (Identity Assertion JWT Authorization Grant, profil de `draft-ietf-oauth-identity-assertion-authz-grant`) audiencé pour un serveur MCP donné. Le client présente cet ID-JAG au `token_endpoint` du serveur d'autorisation du serveur MCP, qui valide signature (via le JWKS de l'IdP), `aud`, `iss` et `exp`, puis émet son propre access token — **sans aucune redirection navigateur vers l'AS du serveur MCP**. Concrètement : l'admin active le serveur pour l'org, les utilisateurs l'obtiennent avec leurs groupes et rôles IdP existants, et la révocation redevient centrale. Le mapping d'identité se fait sur la claim `sub` (identifiant stable), avec repli sur `email` pour l'account linking.

**OAuth Client Credentials** couvre le cas machine-to-machine sans humain dans la boucle, absent de la spec cœur. Elle ne définit aucun mécanisme d'auth propre à MCP : elle normalise l'identifiant d'extension et pointe vers RFC 7523 (JWT bearer, format recommandé) ou RFC 6749 §4.4 (client_id/client_secret, déconseillé pour la longue durée), et suppose un serveur d'autorisation OAuth complet en face.

**Durcissement du cœur (2026-07-28)** : validation obligatoire du paramètre `iss` (RFC 9207) par le client avant redemption du code, paramètre `application_type` au Dynamic Client Registration, credentials clients liés à l'AS émetteur, et DCR formellement déprécié au profit des Client ID Metadata Documents (CIMD) — mais le DCR continue de fonctionner en rétrocompatibilité.

## 2. Surface d'API exacte

```
# Identifiants d'extension (confirmés sur /extensions/client-matrix)
io.modelcontextprotocol/enterprise-managed-authorization
io.modelcontextprotocol/oauth-client-credentials

# Déclaration de support — modèle de capabilities PAR REQUÊTE (protocolVersion 2026-07-28),
# pas un objet ClientCapabilities envoyé à l'initialize :
params._meta["io.modelcontextprotocol/clientCapabilities"].extensions["<id-extension>"] = {}
# Côté serveur : réponse de server/discover → result.capabilities.extensions["<id-extension>"] = {}

# Étape 1 — client ↔ IdP d'entreprise : token-exchange RFC 8693 (ne touche PAS notre AS)
grant_type           = urn:ietf:params:oauth:grant-type:token-exchange
requested_token_type = urn:ietf:params:oauth:token-type:id-jag
subject_token_type   = urn:ietf:params:oauth:token-type:id_token   # flux OIDC

# Étape 2 — client ↔ AS du serveur MCP : redemption de l'ID-JAG (c'est CE que nous recevrions)
# Requête telle que Claude l'émet (POST form-urlencoded sur le token_endpoint) :
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
&assertion=<JWT ID-JAG signé par l'IdP>
&client_id=<client_id sous lequel Claude est enregistré chez nous>
&scope=<scopes>
&resource=<URL du serveur MCP>          # RFC 8707, optionnel selon l'IdP
# DCR est explicitement NON supporté avec EMA : le client_id doit être connu d'avance.

# Annonce de support par l'AS de la ressource — métadonnée de discovery, PAS un paramètre de requête :
authorization_grant_profiles_supported  # doit contenir urn:ietf:params:oauth:grant-profile:id-jag
grant_types_supported                   # doit contenir urn:ietf:params:oauth:grant-type:jwt-bearer

# Client Credentials — format recommandé (RFC 7523)
grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<JWT signé>   # claims iss/sub/aud/exp/iat
# Format alternatif (RFC 6749 §4.4), déconseillé en longue durée
grant_type=client_credentials&client_id=…&client_secret=…
# Transport du token émis : Authorization: Bearer <access_token>

# Métadonnées AS pertinentes
authorization_grant_profiles_supported            # annonce du profil ID-JAG (EMA)
grant_types_supported                             # doit lister le grant jwt-bearer
token_endpoint_auth_methods_supported
token_endpoint_auth_signing_alg_values_supported

# Cœur auth 2026-07-28
iss                 # RFC 9207, à valider côté client avant redemption du code
application_type    # nouveau paramètre au Dynamic Client Registration
CIMD                # Client ID Metadata Documents, remplaçant désigné du DCR

# SDK (vérifié dans node_modules et dans python-sdk le 2026-08-14)
# TypeScript — module @modelcontextprotocol/sdk/client/auth-extensions.js
#   (et NON un paquet "@modelcontextprotocol/client", qui n'existe pas) :
#   ClientCredentialsProvider, PrivateKeyJwtProvider, StaticPrivateKeyJwtProvider
#   passés via StreamableHTTPClientTransport({ authProvider })
# Python (mcp) : mcp.client.auth.extensions.client_credentials.ClientCredentialsOAuthProvider,
#   PrivateKeyJWTOAuthProvider, SignedJWTParameters
#
# Limite du SDK TS installé (@modelcontextprotocol/sdk ^1.29.0) :
#   LATEST_PROTOCOL_VERSION = "2025-11-25" — pas de 2026-07-28, pas de server/discover,
#   et la clé _meta "io.modelcontextprotocol/clientCapabilities" est absente du dist.
#   La négociation d'extension n'est donc PAS implémentable avec cette version.
```

Référence de spec : SEP-990 (`modelcontextprotocol/ext-auth`, `specification/stable/` pour EMA, `specification/draft/` pour Client Credentials). Un PR #646 « SEP-646: Enterprise-Managed Authorization Profile » existe aussi et prête à confusion ; la référence canonique tracée par les SDK est SEP-990. En réserve, non mergés au 2026-08 : SEP-1932 (DPoP) et SEP-1933 (Workload Identity Federation) — des proposals, pas du protocole livré.

**Divergences entre chercheurs, non tranchées :**
- Statut de `oauth-client-credentials` : un chercheur l'annonçait « beta », le vérificateur a corrigé en **draft** (répertoire `specification/draft/`, `Protocol Revision: draft`). On retient draft.
- Adoption client d'EMA : le billet de blog annonce Claude et VS Code comme implémenteurs, et la matrice officielle `/extensions/client-matrix` ne coche EMA que pour **Archestra.AI** (et `oauth-client-credentials` pour aucun client). **Nuance vérifiée le 2026-08-14** : la matrice porte elle-même une note disant que le support des extensions auth « est suivi séparément » de ses colonnes, et Anthropic documente sa propre implémentation EMA côté connecteurs (beta, waitlist, plans Team/Enterprise). « Case vide » ne vaut donc pas « non implémenté », mais ne vaut pas non plus support vérifiable par nous.
- ~~Le nom exact du paramètre portant le grant_profile~~ — **tranché** : `urn:ietf:params:oauth:grant-profile:id-jag` n'est pas un paramètre de requête ; c'est une valeur du champ de discovery `authorization_grant_profiles_supported` publié par l'AS de la ressource.
- Contradiction Anthropic : `claude.com/docs/connectors/building/authentication` indique qu'un `client_credentials` pur sans utilisateur n'est **pas** supporté pour les connecteurs du répertoire Claude (l'alternative est `oauth_anthropic_creds`, consent-gated). L'extension MCP et la politique connecteurs Anthropic ne disent donc pas la même chose.

## 3. Sources

- https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization
- https://modelcontextprotocol.io/extensions/client-matrix
- https://modelcontextprotocol.io/docs/extensions/overview
- https://github.com/modelcontextprotocol/ext-auth
- https://blog.modelcontextprotocol.io/posts/enterprise-managed-auth/
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://claude.com/docs/connectors/building/authentication
- https://claude.com/docs/connectors/building/enterprise-managed-auth
- https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.**

mcp-coordinator embarque déjà son propre serveur d'autorisation : `src/discovery.ts` publie un document RFC 8414 avec trois grants (`authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:device_code`), et `src/auth/oauth-token.ts` les dispatche dans un `switch` unique (ligne 424) qui répond `unsupported_grant_type` pour tout le reste. Ajouter EMA, c'est ajouter **une branche à ce switch** : valider un ID-JAG signé par l'IdP puis appeler la chaîne de mint existante. La brique de validation asymétrique existe déjà — `src/auth/providers/oidc.ts` fait `createRemoteJWKSet` + `jwtVerify` avec contrôle `iss`/`aud` (lignes 194-200) et cross-check du discovery doc (lignes 300-306) ; `jose@^6.2.3` est en dépendance directe.

Le gain fonctionnel est là où le projet a un trou : `OIDCProvider.listMemberships` **throw** aujourd'hui (`src/auth/providers/oidc.ts:270`, « vendor a subclass that reads the issuer-specific groups claim »). L'auto-hébergeur en OIDC générique n'a donc aucun mapping de groupes ; EMA fait porter ce mapping par l'IdP au lieu de l'allowlist maison de `src/auth/allowlist.ts` + `src/auth/membership-cache.ts`. Bénéficiaire concret : le déploiement d'équipe sous Okta ou Entra, où provisioning et révocation redeviennent centralisés — l'argument SOC 2 que la chaîne d'audit SHA-256 (`src/security/audit-chain.ts`) vise déjà, mais côté identité.

Sur le volet M2M, le code candidat au remplacement est identifiable ligne à ligne : `src/auth/service-tokens.ts` (JWT longue durée, plafond 90 jours, émission admin-only), `src/admin/handle-service-tokens.ts` et `cli/service-tokens.ts`. C'est un schéma propriétaire pour un cas — l'agent non-humain qui s'authentifie auprès du daemon — que `io.modelcontextprotocol/oauth-client-credentials` normalise. Réserve importante : l'extension n'apporte pas d'auth clef en main, elle rend seulement le champ `extensions` négociable ; le gain réel est l'interopérabilité, pas la suppression de code.

Enfin, deux points de conformité gratuits ou presque : le coordinateur **ne publie pas de `registration_endpoint`** (vérifié dans `src/discovery.ts`) — la dépréciation du DCR au profit de CIMD ne le concerne donc pas, contrairement à ce que le bundle laissait craindre. En revanche `src/auth/oauth-callback.ts` ne lit nulle part un paramètre `iss` de la query renvoyée par l'IdP amont : la validation RFC 9207 côté client semble absente, ce qui est un correctif de conformité à évaluer avant qu'un audit ne le relève.

**Risque si on ne fait rien :** modéré et différé. Rien ne casse : le DCR reste rétrocompatible et on n'en a pas ; les extensions sont optionnelles et désactivées par défaut. Le risque réel est de rester hors du chemin par lequel les entreprises activeront des serveurs MCP en 2027, et de continuer à maintenir un schéma de tokens de service maison qu'aucun client tiers ne sait négocier.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/discovery.ts` | Document RFC 8414 (vérifié). `grant_types_supported` (lignes 21-25) à étendre avec `urn:ietf:params:oauth:grant-type:jwt-bearer` — Anthropic précise que la feature n'est proposée au client que si ce grant est listé ici ; `authorization_grant_profiles_supported` serait à ajouter. `token_endpoint_auth_methods_supported: ["none"]` (ligne 28) devra accepter `private_key_jwt` pour le JWT-bearer. Aucun `registration_endpoint` : pas de DCR à déprécier — et EMA interdit de toute façon le DCR (`client_id` fixe stampé dans l'assertion). |
| `src/auth/oauth-token.ts` | Point d'entrée unique : `switch (grantType)` ligne 424. Une branche `urn:ietf:params:oauth:grant-type:jwt-bearer` s'y greffe sans toucher aux trois flux existants. |
| `src/auth/providers/oidc.ts` | Fournit déjà la validation JWKS distante (`createRemoteJWKSet` ligne 320, `jwtVerify` ligne 194). Base réutilisable pour valider un ID-JAG. `listMemberships` throw ligne 269 : c'est le trou qu'EMA comblerait. |
| `src/auth/jwt-keys.ts` | Bloquant potentiel : signature **HS256 symétrique**, kids `hs256-v1`/`hs256-v0`, aucun JWKS publiable. Valider un ID-JAG entrant reste possible (clé distante), mais tout scénario où un tiers doit vérifier nos tokens exigerait de passer à de l'asymétrique. |
| `src/auth/service-tokens.ts` · `src/admin/handle-service-tokens.ts` · `cli/service-tokens.ts` | Schéma M2M maison (TTL 90 j, `service_account: true`, scopes read/write/admin). Concurrent direct d'`oauth-client-credentials` ; candidat au remplacement ou à l'encapsulation. |
| `src/auth/allowlist.ts` · `src/auth/membership-cache.ts` | Autorisation par org côté coordinateur. EMA déplace cette décision vers l'IdP : ces modules deviennent un fallback plutôt que la source de vérité. |
| `src/auth.ts` (`authenticateRequest`, ligne 477) | Gate Bearer unique de tout le serveur HTTP. Un access token issu d'un ID-JAG doit y ressortir avec les mêmes claims minimisées que `src/auth/jwt-mint.ts` (`sub`, `active_org_id`, `role`). |
| `src/auth/oauth-callback.ts` | Consomme le code de l'IdP amont (issuer construit ligne 448). Aucune lecture d'un paramètre `iss` de la query : validation RFC 9207 à ajouter côté client. |
| `src/serve-http.ts` (ligne 695) | Route `/.well-known/oauth-authorization-server`, conditionnée à `ctx.phase2Bootstrap`. Toute métadonnée nouvelle passe par là. |
| `sdk/src/client.ts` · `sdk/src/discovery.ts` | Le SDK lit `token_endpoint` depuis le discovery doc (`client.ts` lignes 58-61). Un nouveau grant y remonte naturellement, mais l'ajout d'un `authProvider` style SDK MCP serait un chantier distinct. |
| `package.json` | `@modelcontextprotocol/sdk@^1.29.0`, `jose@^6.2.3` (vérifiés). **Vérifié le 2026-08-14 : le SDK installé expose `LATEST_PROTOCOL_VERSION = "2025-11-25"`, sans `server/discover` ni la clé `_meta` `io.modelcontextprotocol/clientCapabilities`.** La négociation d'extension est hors de portée sans montée de version du SDK. Note : le volet EMA côté AS n'en dépend pas — il ne passe que par le `token_endpoint`. |
| `docs/openapi.yaml` · `docs/idp-providers.md` · `docs/onboarding-self-host.md` | Surfaces de doc à mettre à jour si un grant est ajouté (le contrat OpenAPI décrit le token endpoint). |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Vaut-il mieux implémenter le grant ID-JAG dans l'AS embarqué de mcp-coordinator — c'est-à-dire une branche de plus dans le `switch` de `src/auth/oauth-token.ts` et l'abandon de `allowlist.ts` comme source de vérité au profit des groupes IdP — alors qu'un seul client (Archestra.AI) coche EMA dans la matrice officielle ; ou bien se limiter d'abord au volet vérifiable immédiatement, à savoir la validation RFC 9207 de `iss` dans `oauth-callback.ts` et le remplacement du schéma de service tokens maison par l'identifiant `io.modelcontextprotocol/oauth-client-credentials` ?

### 6.2 Hypothèse

> Pré-enregistrée le 2026-08-15, **avant** tout PoC. Les seuls faits déjà collectés sont trois
> lectures de code et une requête au tracker, listées ci-dessous.

**Hypothèse.** La question de §6.1 propose un repli « vérifiable immédiatement » en deux volets —
la validation RFC 9207 de `iss` et le remplacement des service tokens. Je m'attends à ce que
**les deux s'effondrent**, et que le repli soit donc vide :

- **RFC 9207 est probablement redondant chez nous.** Déjà lu : `oauth-callback.ts:74-77` ne lit
  que `state`, `code`, `error`, `error_description` — **aucun `iss`**, comme la fiche le dit. Mais
  `:154` résout le provider depuis **`row.provider`** (la ligne d'état en base), sous un commentaire
  explicite *« Per spec §6.3 mix-up defense: row.provider MUST equal the expected »* et
  *« T46: mix-up defense (V4) »*. La défense anti-mix-up que `iss` apporte semble donc **déjà
  assurée par un mécanisme plus fort**.
- **Le volet M2M n'a rien à remplacer.** L'extension `oauth-client-credentials` est en *draft*,
  n'apporte aucune auth, et Anthropic refuse le `client_credentials` pur côté connecteurs.
- **EMA est probablement inerte pour le profil de déploiement.** Zéro demande mesurée (voir
  ci-dessous), et il faut un IdP émetteur d'ID-JAG que l'auto-hébergeur n'a pas.

**Fait déjà mesuré (K4, avant pré-enregistrement) :** sur les 61 issues du dépôt —
`EMA` → 0, `ID-JAG` → 0, `SSO` → 0, `Okta` → 0, `Entra` → 0, `groups` → 0, `service token` → 2.

**Verdict attendu :** `refuser` le volet M2M, `reporter` EMA, et constater que le repli proposé
par §6.1 n'existe pas.

**Critères de refus, chiffrés (pré-enregistrés) :**

| # | Volet | Le résultat qui tue |
|---|---|---|
| **K1** | EMA | **Aucun IdP accessible à un auto-hébergeur n'émet d'ID-JAG** (Okta Cross App Access seul, ou équivalent hors de portée). La feature est alors inerte pour le profil de déploiement réel. |
| **K2** | EMA | **Aucun client ne peut l'exercer ici** : Claude est en beta sur waitlist Team/Enterprise. Si le bout-en-bout est hors de portée, `adopter` est interdit par le protocole (fiche ⚠️ partielle). |
| **K3** | EMA | Le PoC `jwt-bearer` dépasse **150 lignes ajoutées ou 4 fichiers touchés** → ce n'est plus « une branche de plus dans le switch », et l'estimation de §6.1 est fausse. |
| **K4** | tous | **Zéro demande utilisateur.** Déjà mesuré : 0 sur 61 issues pour EMA/ID-JAG/SSO/Okta/Entra/groups. |
| **K5** | repli | La validation RFC 9207 de `iss` est **redondante** avec le binding `state → row.provider` → le premier volet du repli de §6.1 s'évapore. |
| **K6** | M2M | Remplacer `service-tokens.ts` par `oauth-client-credentials` **ne supprime aucune ligne** et ajoute une dépendance à une spec *draft* → YAGNI. |

**Critère d'adoption (ce qu'il faudrait pour dire oui) :** un ID-JAG réellement validé de bout en
bout **ici**, émis par un IdP qu'un auto-hébergeur peut réellement déployer, pour un coût sous les
seuils de K3.

**Ce que je m'engage à trancher même si tout tombe :** le sort du trou `listMemberships`
(`oidc.ts:269` throw `ProviderCapabilityError`) — est-ce un vrai trou fonctionnel, ou un point
d'extension documenté ?

### 6.3 Protocole de vérification

> ⚠️ Le bout-en-bout EMA n'est pas exécutable ici : il exige une org Claude Team/Enterprise avec EMA activé (beta sur waitlist) et un IdP émetteur d'ID-JAG. Les autres points sont exécutables localement.

Proposition, pas un résultat.

- [ ] Vérifier dans `node_modules/@modelcontextprotocol/sdk` la révision de protocole embarquée et la présence effective de `server/discover` et du modèle de capabilities par requête `_meta["io.modelcontextprotocol/clientCapabilities"]` — sans quoi la négociation d'extension n'est pas implémentable telle quelle.
- [ ] Lire `specification/stable/` de `modelcontextprotocol/ext-auth` pour extraire la liste exacte des vérifications qu'un AS doit faire sur un ID-JAG (claims obligatoires, `aud` attendu, fenêtre `exp`), et la confronter à ce que fait déjà `jwtVerify` dans `src/auth/providers/oidc.ts:194`.
- [ ] PoC : ajouter une branche `jwt-bearer` dans le `switch` de `src/auth/oauth-token.ts` qui valide un JWT signé par un IdP de test (Keycloak local, déjà supporté par `OIDCProvider`) et mint un access token via `mintAccessJWT`. Mesurer le volume de code réellement ajouté.
- [ ] Vérifier par lecture de `src/auth/oauth-callback.ts` si un paramètre `iss` est renvoyé par chacun des 4 providers (`github`, `github-app`, `google`, `oidc`) et si son absence de validation est exploitable (mix-up attack) dans notre configuration.
- [ ] Tester si un client MCP réel (Claude Code) envoie quoi que ce soit sous `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` en se connectant au coordinateur — c'est la mesure qui tranche « annonce » contre « support ».

### 6.4 Résultat observé

> Exécuté le 2026-08-15. **Frontière exécuté / lu :** (A) à (D) sont exécutés ici (lecture de code
> et PoC contre un faux IdP monté pour l'occasion) ; (E) est de la preuve documentaire fetchée
> aujourd'hui ; (F) nomme ce qui n'a pas été exécuté. Le dépôt n'a pas été modifié — le PoC vit
> dans `scratchpad/b02/poc.mts`.

#### (A) §4 est réfuté sur son bénéfice principal — le mapping de groupes existe déjà

C'est le résultat le plus important de ce challenge. §4 écrit que
*« `OIDCProvider.listMemberships` **throw** aujourd'hui […] L'auto-hébergeur en OIDC générique n'a
donc aucun mapping de groupes ; EMA fait porter ce mapping par l'IdP »*. **Faux.**

```
src/auth/providers/oidc.ts:108
  this.allowlistStrategy = cfg.groupsClaim ? "id_token_groups" : "none";

src/auth/oauth-callback.ts:324    } else if (strategy === "id_token_groups") {
src/auth/oauth-token.ts:203       } else if (strategy === "id_token_groups") {
```

Dès qu'un `groupsClaim` est configuré, le provider bascule sur `id_token_groups` et le mapping se
fait depuis l'`id_token` vérifié — le fichier nomme même les vendeurs (`oidc.ts:47`) :
*« "groups" (Okta, Auth0, Authentik) »*, `realm_access.roles` pour Keycloak, en notation pointée.
**`listMemberships` n'est donc jamais atteint pour l'OIDC générique** : le commentaire de
`oauth-callback.ts:279-281` le dit explicitement — *« "none" (generic OIDCProvider): no portable
allowlist model. **Deny by default**; deployments needing OIDC allowlist vendor a subclass. »*

Le `throw` n'est pas un trou fonctionnel, c'est un **point d'extension documenté derrière un
deny-by-default**. Le mapping de groupes IdP que §4 présente comme le gain d'EMA est **déjà
disponible aujourd'hui, par configuration, sans une ligne de code**.

#### (B) K5 — La validation RFC 9207 est redondante chez nous

`src/auth/oauth-callback.ts:74-77` ne lit que `state`, `code`, `error`, `error_description` :
**aucun `iss`**, la fiche a raison. Mais la défense que `iss` apporte est déjà assurée, plus
fortement :

```
src/auth/oauth-callback.ts:62   * Per spec §6.3 mix-up defense: row.provider MUST equal the expected
                        :149   // T46: mix-up defense (V4) — verify the state's provider is one we
                        :154   const provider = ctx.providers.get(row.provider);
```

Le provider est résolu depuis la **ligne d'état en base**, pas depuis un paramètre que l'IdP
renvoie. Un attaquant ne peut pas rediriger un code d'un provider vers un autre : le `state` est
généré par nous et épinglé à son provider. **K5 est déclenché — le premier volet du repli proposé
par §6.1 s'évapore.**

#### (C) K4 — Zéro demande

```
issues du dépôt : 61
EMA -> 0     ID-JAG -> 0     SSO -> 0     Okta -> 0     Entra -> 0     groups -> 0
service token -> 2
```

**K4 déclenché.**

#### (D) K3 — Le PoC, et il **ne se déclenche pas**

Faux IdP monté ici (serveur JWKS local sur `127.0.0.1:3210`, paire RS256 générée à la volée),
ID-JAG signé, et la branche de grant écrite avec les **primitives réelles du dépôt** —
`createRemoteJWKSet` / `jwtVerify` (le patron de `oidc.ts:194`) et `mintAccessJWT` :

```
ID-JAG emis, longueur: 720
1. assertion valide          -> OK, access token de 396 car.
2. rejeu du meme jti         -> REFUS invalid_grant — Assertion replayed
3. mauvais client_id         -> REFUS invalid_grant — client_id mismatch
4. issuer non approuve       -> REFUS invalid_grant — Untrusted assertion issuer
5. aud pour un autre serveur -> REFUS invalid_grant

K3 — branche mesurée : 59 lignes (43 de code effectif)
```

**43 lignes de code effectif, très en dessous du seuil de 150 que j'avais pré-enregistré. K3 ne se
déclenche pas, et la fiche a raison sur ce point précis : c'est bien « une branche de plus dans le
`switch` ».** À comparer aux handlers existants du même fichier : `handleAuthorizationCodeGrant`
fait **213 lignes** (l. 101-313), `handleDeviceCodeGrant` **110 lignes** (l. 314-423).

**Mais ce squelette n'est pas conforme, et il faut dire ce qu'il ne fait pas.** Confronté à la
liste normative (voir E), il lui manque : le traitement de `resource` (RFC 8707), de `scope`
(RFC 6749 §3.3) et d'`authorization_details` (RFC 9396) ; l'**allowlist d'issuers par tenant**
qu'exige Anthropic ; la résolution de sujet via `sub_id` et son *Subject Identifier Format* (règles
SAML NameID incluses) ; l'audience-restriction du token émis vers la ressource ; et surtout tout
l'aval — provisioning d'un utilisateur inconnu, résolution de l'org depuis les groupes IdP,
attribution du rôle, famille de refresh, audit, tests, OpenAPI, métadonnée de discovery.

**Une erreur que le PoC a révélée, et qui vaut d'être notée** : j'avais d'abord posé
`aud = <URL du serveur MCP>`. C'est faux. Le draft dit *« The `aud` claim MUST contain the issuer
identifier of the Resource Authorization Server as defined in [RFC8414] »* — donc **notre
`issuer`**, pas l'URL de la ressource, laquelle va dans la claim `resource` (RFC 8707). Deux
champs qu'il est facile de confondre, et dont la confusion ouvrirait précisément l'attaque par
injection d'audience que la règle vise.

#### (E) Preuve documentaire fetchée le 2026-08-15 (non exécutée)

**K1 — le blocage décisif : aucun IdP qu'un auto-hébergeur peut déployer n'émet d'ID-JAG.**
Doc officielle Keycloak
(`keycloak.org/securing-apps/identity-assertion-jwt-authorization-grant`) :

> « Native, out-of-the-box support for Keycloak to act as the **Issuer** (generating the specific
> ID-JAG Identity Assertion on demand) **is not yet fully implemented**. »
> « Keycloak can currently act as the **Receiver** […] »
> « This feature is **experimental** […] **Do not use this feature in production environments.** »

Et l'issue d'émission `keycloak/keycloak#48818` est **OPEN**, ouverte le 2026-05-08, **sans
milestone**. Côté émetteurs réels (`oauth.net/cross-app-access/`) : Okta *(early access)*, Ping,
Athenz *(beta)*, Descope, Keycloak *(in progress)*. **Entra ID et Google Workspace : rien.**
Auth0 (groupe Okta) : *Early Access*, réservé Enterprise/B2B.

**K2 — le bout-en-bout est hors de portée**, bandeau de
`claude.com/docs/connectors/building/enterprise-managed-auth` :

> « Enterprise Managed Auth is **in beta** and is available on Claude **Team and Enterprise**
> plans. Organizations can join the waitlist to request access. »
> « End-to-end testing requires a Claude organization with Enterprise Managed Auth enabled and an
> identity provider tenant configured to issue assertions for your authorization server's
> audience. »

**Autres faits qui pèsent :**

| Fait | Source |
|---|---|
| **DCR est interdit avec EMA** : *« Dynamic Client Registration (DCR) is **not supported** with Enterprise Managed Auth. The identity provider stamps a fixed `client_id` into every assertion »*. Sans conséquence pour nous — nous n'avons pas de `registration_endpoint` — mais impose que Claude soit **pré-enregistré** chez nous. | doc Claude EMA |
| **Allowlist d'issuers par tenant, exigée** : *« Your authorization server is responsible for maintaining an explicit allowlist of trusted issuer URLs **per tenant** […] An assertion whose `iss` is not on the tenant's allowlist must be rejected with `invalid_grant`, even if the signature is valid. »* | doc Claude EMA |
| **Le socle IETF expire.** `draft-ietf-oauth-identity-assertion-authz-grant` est en **`-04`** (2026-05-21), *Active Internet-Draft*, **expire le 2026-11-22**. La spec MCP dite « stable » ancre ses renvois sur `-04.html#section-4.4.1`. | datatracker |
| **Aucune implémentation de référence côté serveur.** SDK TypeScript : `jwt-bearer` a **0 occurrence** sous `packages/server` (tout est client). SDK Python : un **hook abstrait** (`exchange_identity_assertion`) dont le docstring rend la checklist à l'implémenteur — *« verify the JWT signature, `iss`, and `exp`, and that `typ` is `oauth-id-jag+jwt` »*, *« reject replays — enforce `exp`, and track `jti` »*. | dépôts SDK |
| **Adoption client** : `oauth-client-credentials` → **0 client sur 11** ; EMA → **1 seul, Archestra.AI**. Claude web et Desktop n'y sont **pas** cochés alors que la doc Claude documente la beta. La note « suivi séparément » est toujours là. | `/extensions/client-matrix` |
| **`oauth-client-credentials` est toujours en `Protocol Revision: draft`**, et l'extension est *« OPTIONAL for MCP implementations »*. Le repo `ext-auth` : 30 commits, **dernier le 2026-06-18** (~2 mois d'inactivité), 153 stars. | `ext-auth` |
| **Les deux champs de discovery sont requis** — `authorization_grant_profiles_supported` contenant `urn:ietf:params:oauth:grant-profile:id-jag` (spec MCP) **et** `grant_types_supported` contenant `urn:ietf:params:oauth:grant-type:jwt-bearer` (exigence Claude : *« The grant type must be listed here for the feature to be offered to the customer, even if your token endpoint would already accept it silently. »*). | ext-auth §6 + doc Claude |

#### (F bis) Ce que la passe adversariale a démoli dans mes propres mesures

**(1) K5 est RÉFUTÉ — la validation RFC 9207 n'est pas redondante, et c'est le résultat le plus
lourd de ce challenge.** J'avais conclu que le binding `state → row.provider` rendait `iss`
inutile. **RFC 9700 dit l'inverse : ce binding est une *précondition* de l'attaque, pas une
défense.** Fetchée et vérifiée par moi :

> **Préconditions** : *« the client stores the authorization server chosen by the user in a session
> bound to the user's browser »* et *« uses the same redirection URI for each authorization
> server »*.
> **Contre-mesures** : *« It is important to note that **just storing the authorization server URL
> is not sufficient** to identify mix-up attacks. »*

C'est mot pour mot notre architecture — et `src/auth/oauth-login.ts:125` construit bien **un seul**
`redirect_uri` pour les quatre providers, donc la seconde contre-mesure (URI distinctes par AS)
n'est pas là non plus. Mesure empirique qui achève le point :

```
$ curl -s https://accounts.google.com/.well-known/openid-configuration | ...
authorization_response_iss_parameter_supported: true

$ grep -rn 'searchParams.get("iss")|authorization_response_iss' src/ sdk/src/ cli/
(0 occurrence)
```

**Google, provider réellement câblé, annonce le paramètre `iss` — et nous ne le lisons pas.**

*Nuance que je maintiens, pour ne pas surcorriger :* l'exposition suppose ≥ 2 providers configurés
dont un hostile, et nos 4 providers sont **statiquement configurés au boot** depuis des variables
d'environnement — un attaquant ne peut pas en déclarer un. L'attaque-exemple de la RFC (l'attaquant
déclare *son* AS) n'est donc pas directement transposable. Mais **« redondant » est faux**, et je
ne peux plus l'affirmer. Ce point sort du périmètre de B02 : il appartient à
[`B03`](B03-auth-hardening-ssrf.md) — dont **la question porte aujourd'hui la même erreur** («
le binding `state → row.provider` rend déjà la validation d'`iss` RFC 9207 redondante côté
callback »). À ne pas hériter telle quelle.

**(2) K2 était trop fort.** J'ai écrit « aucun client ne peut l'exercer ici ». La doc d'Anthropic,
que j'avais fetchée sans lire jusqu'au bout, décrit un chemin de test documenté :

> *« Okta's cross-app access playground lets you exercise the flow **without a Claude
> organization**. […] **Point it at your own authorization server** to check that it accepts an
> identity assertion over the JWT bearer grant, mints a scoped access token, and serves its
> metadata for discovery »*

Le rôle que B02 implémenterait — l'AS de ressource — est donc **exerçable sans org Claude**. Ma §0
avait repéré `xaa.dev` et l'avait écarté ; Anthropic en fait le chemin de développement supporté.
**Je ne l'ai pas exercé** (service tiers non provisionné ici), donc `adopter` reste interdit par
le protocole — mais le motif honnête est « non exécuté », pas « impossible ».

**(3) K1 est affaibli, pas annulé.** Ma formulation « aucun IdP qu'un auto-hébergeur déploie
n'émet d'ID-JAG » est trop absolue. Sur `oauth.net/cross-app-access/` : **Descope est
*Generally available*** (SaaS, inscription self-serve, palier gratuit) et **Athenz est
open-source, en *beta* comme émetteur**. Ce qui tient sans réserve, et que j'ai vérifié
verbatim : **Keycloak — l'IdP de référence de l'auto-hébergeur — ne sait pas émettre**
(*« not yet fully implemented »*, *« experimental »*, *« Do not use this feature in production
environments »*, issue d'émission `#48818` **OPEN sans milestone**), et **Entra ID comme Google
Workspace n'ont rien**.

**(4) K3 est une DISJONCTION, et je n'en ai testé qu'un terme.** Je l'avais écrit « **150 lignes
ajoutées ou 4 fichiers touchés** » et j'ai conclu « non déclenché » sur la seule mesure des lignes.
Le second terme se déclenche, lui, sèchement — accounting sur la §5 de la fiche et sur ce que le
PoC laisse en TODO : `oauth-token.ts` + `discovery.ts` (les 3 grants en dur l. 21-25, plus
`authorization_grant_profiles_supported`) + `boot.ts` (allowlist d'issuers) + `database.ts` (table
anti-rejeu `jti`) + `sweeper` + `docs/openapi.yaml` → **≥ 6 fichiers avant les tests**.

**Et le compte de lignes lui-même mesurait la mauvaise chose.** Mon PoC mesure le *prologue* : dans
`handleAuthorizationCodeGrant`, le prologue remplaçable est ~49 lignes (l. 101-149), mais **l'aval
partagé — lockout, allowlist, provisioning, `mintTokenPair`, réponse — fait 164 lignes
(l. 150-313)** et un handler jwt-bearer en a besoin **intégralement**. Dupliqué : ~183 lignes
effectives, **au-dessus du seuil de 150**. Extrait en helper : c'est un refactor du chemin de login
principal.

Trois raccourcis du PoC qui ne survivent pas à la production, à dire aussi : le chemin JWKS est
**codé en dur** (`issuer + "/.well-known/jwks.json"` — aucun IdP réel ne l'utilise ; Keycloak est
en `/realms/X/protocol/openid-connect/certs`, Okta en `/oauth2/v1/keys`, donc il faut le discovery
et `jwks_uri`) ; l'anti-rejeu est un `Set` **en mémoire** qui ne survit pas au redémarrage ; et
`mintAccessJWT` seul ne produit **aucun refresh token**.

**K3 doit donc être scoré « déclenché sur la clause fichiers, non tranché sur la clause lignes »**
— et non « non déclenché ».

**(5) Un fait que j'avais manqué, et qui rend §6.1 fausse dans les deux sens.** La branche
`id_token_groups` ne se passe pas de l'allowlist : elle mappe les groupes IdP **vers elle** —

```
src/auth/oauth-callback.ts:325-330
  // T58: OIDC groups from the id_token. Treats groups as
  // memberships against allowlist_github_org -- operators put
  // OIDC group names there.
      memberships = exchange.user.groups.map((g) => g.toLowerCase());
      allowlistMatch = resolveOrgFromMemberships(ctx.db, memberships);
```

`resolveOrgFromMemberships` matche contre **`orgs.allowlist_github_org`**. Donc l'allowlist reste
la source de vérité du mapping groupe → org — et **EMA ne la supprimerait pas non plus** : il
faudrait toujours une table qui associe un groupe IdP à une org locale. La seconde moitié de la
question de §6.1 (« l'abandon de `allowlist.ts` comme source de vérité au profit des groupes
IdP ») décrit donc une chose **déjà à moitié faite, et qu'EMA n'achève pas**.

**(6) Trois critères sur six étaient décoratifs, et un n'a jamais été évalué.**
**K2** reformule le champ *Testabilité* de la §0, écrit le 2026-08-14 — son propre texte dit
« `adopter` est interdit par le protocole », donc il énonce une règle, pas une mesure.
**K4** : j'écris moi-même en §6.2 « fait déjà mesuré, **avant pré-enregistrement** ».
**K5** : ma §6.2 citait déjà `oauth-callback.ts:74-77`, `:154` et les deux commentaires ; §6.4 (B)
reproduisait les mêmes trois références — rien n'avait été appris entre les deux (et il est en
plus réfuté).
**K6 n'a jamais été évalué** — voir §7.3.
**Seuls K1 et K3 portaient de l'information.** K1 s'est déclenché ; K3 est celui que j'ai mal
mesuré.

#### (F) Ce qui n'a PAS été exécuté

- **Le bout-en-bout EMA** : impossible ici (K2). Aucun ID-JAG réel n'a été validé — seulement un
  ID-JAG **fabriqué par moi** avec une paire de clés locale. La forme est fidèle au draft, mais
  aucun IdP réel n'a émis quoi que ce soit.
- **Le volet M2M** n'a pas été prototypé : l'extension n'apporte aucune auth à prototyper, elle ne
  normalise qu'un identifiant.
- **La refonte du modèle d'autorisation** (allowlist → groupes IdP) n'a pas été chiffrée en
  fichiers touchés. C'est le poste de coût dominant, et il reste une estimation.

### 6.5 Contre-arguments

- **L'adoption client est un mirage documenté.** La matrice officielle ne coche EMA que pour Archestra.AI. Implémenter le côté serveur d'un flux dont aucun client majeur ne fait la moitié cliente, c'est écrire du code que personne n'exerce — et donc du code qui pourrira sans qu'on le sache.
- **EMA suppose un IdP d'entreprise capable d'émettre des ID-JAG.** Cross App Access d'Okta est la première implémentation. L'auto-hébergeur typique de mcp-coordinator tourne sur GitHub OAuth ou un Keycloak, qui n'émettent pas d'ID-JAG : la feature serait inerte pour la majorité des déploiements actuels.
- **`oauth-client-credentials` est en draft et n'apporte pas d'auth.** L'extension pointe vers RFC 6749/7523 et exige un AS complet en face. Nos service tokens (`src/auth/service-tokens.ts`) fonctionnent, sont audités et plafonnés à 90 jours. Remplacer du code qui marche par une spec draft pour gagner la négociabilité d'un champ `extensions` que personne ne lit encore, c'est du YAGNI.
- **Contradiction dans l'écosystème Anthropic lui-même.** Les connecteurs du répertoire Claude refusent le `client_credentials` pur sans utilisateur. Adopter l'extension ne débloque donc pas l'intégration côté Anthropic.
- **HS256 symétrique.** `src/auth/jwt-keys.ts` est bâti sur un secret partagé. Toute évolution qui exigerait de publier un JWKS oblige à une migration de clés — procédure de rotation à réécrire (`docs/ops/key-rotation.md`, `cli/rotate-jwt-secret.ts`), invalidation de sessions, et documentation. Coût sans rapport avec le bénéfice immédiat.
- **Effort mal calibré dans le bundle.** Un chercheur donne « M » pour Client Credentials, un vérificateur le juge sous-estimé faute d'AS existant. Nous, on a un AS — mais l'estimation « L » d'EMA ne compte que la branche du grant, pas la refonte du modèle d'autorisation (allowlists → groupes IdP), qui touche `membership-cache.ts`, les rôles admin/member et toute la surface `/api/admin`.
- **Le durcissement du cœur 2026-07-28 est moins urgent qu'annoncé.** Le DCR reste rétrocompatible et nous n'en avons pas. Seule la validation de `iss` mérite d'être traitée, et elle n'a rien à voir avec EMA — la mélanger à cette fiche risque de bloquer un correctif simple derrière une décision d'architecture lourde.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** (EMA) · ✅ **refuser** (OAuth Client Credentials) |
| **Date** | 2026-08-15 |
| **Justification** | **La fiche se trompe sur son bénéfice principal, et la question de §6.1 est fausse dans ses deux termes.** §4 annonce qu'EMA comblerait l'absence de mapping de groupes en OIDC générique : **faux**, `oidc.ts:108` bascule sur `id_token_groups` dès qu'un `groupsClaim` est configuré, testé et documenté par vendeur. Et l'« abandon d'`allowlist.ts` » que §6.1 prête à EMA n'aurait pas lieu : `id_token_groups` mappe déjà les groupes **vers** l'allowlist, et EMA aurait besoin de la même table. EMA est reporté parce que **Keycloak ne sait pas émettre d'ID-JAG** (« experimental », « do not use in production », issue d'émission OPEN sans milestone), que le socle IETF **expire le 2026-11-22**, qu'**aucun SDK n'offre d'implémentation serveur**, et qu'Anthropic déconseille explicitement d'écrire sa propre vérification — ce qu'un AS embarqué serait pourtant obligé de faire. Le volet Client Credentials est refusé : *draft*, **0 client sur 11**, n'apporte aucune auth, et Anthropic refuse le `client_credentials` pur. |
| **Issue / PR** | Aucune. Un renvoi à faire vers [`B03`](B03-auth-hardening-ssrf.md) — voir §7.4. |
| **Jalon visé** | — |

### 7.1 La réponse à la question de §6.1

**Les deux termes du OU sont faux, et pour des raisons différentes.**

**Premier terme — « implémenter le grant ID-JAG […] et l'abandon d'`allowlist.ts` au profit des
groupes IdP ».** La partie *grant* est correctement estimée par la fiche : le noyau de validation
tient réellement en **43 lignes**, mesurées sur un PoC qui valide un vrai ID-JAG signé RS256 et
refuse le rejeu, le mauvais `client_id`, l'issuer non approuvé et le mauvais `aud`. **La fiche a
raison là-dessus, et il faut le dire.** Mais la partie *abandon d'`allowlist.ts`* est fausse dans
les deux sens : les groupes IdP pilotent **déjà** la décision (`id_token_groups`), et ils le font
**via** l'allowlist, qu'EMA ne supprimerait pas davantage.

**Second terme — le « repli vérifiable immédiatement ».** Il est **plus petit qu'annoncé sur une
moitié, et plus gros sur l'autre** :

- *Remplacer les service tokens par `oauth-client-credentials`* : vide de valeur (§7.3).
- *La validation RFC 9207 de `iss`* : **j'ai d'abord conclu qu'elle était redondante, et j'avais
  tort** (§6.4 F bis (1)). Ce n'est pas un repli commode, c'est un vrai sujet de sécurité — et il
  n'appartient pas à cette fiche.

**Réponse nette : ni l'un ni l'autre.** EMA se reporte sur son écosystème, pas sur son coût de
grant ; et le repli proposé n'est pas un repli — c'est une autre fiche.

### 7.2 Pourquoi pas `adopter partiellement`, alors que la branche est bon marché

Il faut le poser franchement, parce que **K3 ne s'est pas déclenché sur la clause qui compte pour
§6.1** : le noyau de grant est effectivement petit. Trois raisons le tuent quand même, et aucune
n'est le coût du grant :

1. **Rien ne peut l'alimenter chez l'utilisateur cible.** Keycloak, l'IdP de l'auto-hébergeur, est
   *receiver* seulement — l'émission est expérimentale et explicitement interdite en production.
   Écrire la branche, c'est livrer du code que le déploiement de référence ne peut pas exercer.
2. **Le livrable n'est pas la branche.** K3 se déclenche sur sa **clause fichiers** (≥ 6 avant les
   tests), et le compte de lignes que j'avais fait mesurait le *prologue* : l'aval partagé fait
   **164 lignes** dont un handler jwt-bearer a besoin intégralement. Plus la table anti-rejeu, le
   discovery `jwks_uri`, l'allowlist d'issuers **par tenant**, le refresh.
3. **Anthropic déconseille ce qu'on serait obligé de faire.** *« If you need to inspect assertions
   in your own code, use the validation library or token introspection endpoint provided by your
   authorization server vendor **rather than writing custom verification logic**. »* Nous **sommes**
   notre propre AS : nous n'avons pas de vendeur derrière qui nous abriter. La note d'Anthropic
   dit d'ailleurs que pour une plateforme hébergée *« there is typically no code to write »* — le
   cas mcp-coordinator est précisément celui qui n'en bénéficie pas.

**Conditions de réveil, nommées et falsifiables :**

1. **`keycloak/keycloak#48818` se ferme** (émission d'ID-JAG livrée et non expérimentale) — c'est
   la condition qui rend la feature atteignable pour le profil de déploiement réel.
2. **Un utilisateur le demande** (0 sur 61 issues aujourd'hui).
3. **Le draft IETF devient RFC.** Il est en `-04` et **expire le 2026-11-22** ; la spec MCP dite
   « stable » ancre ses renvois sur `-04.html#section-4.4.1`.

### 7.3 Ce qui est refusé : le volet OAuth Client Credentials — et K6, que je n'avais pas évalué

**K6 n'a jamais été mesuré pendant l'expérience, et sa lettre est fausse.** Il posait « remplacer
`service-tokens.ts` ne supprime **aucune** ligne ». C'est inexact : la validation TTL/scope, le
parsing du handler admin et la sous-commande CLI `issue` — de l'ordre de **~140 lignes** —
disparaîtraient bien.

**Mais l'intention de K6 est confirmée, et le solde est une addition nette.** Ce qui ne peut pas
partir : `verifyServiceTokenJti` et sa branche dans `src/auth.ts` (aucun grant OAuth ne donne la
**révocation vérifiée à chaque requête**), le `list`, le `revoke`, les gates admin et l'audit. Et
ce qu'il faudrait **ajouter** : un registre de clients (`client_id` → JWKS ou secret haché), sa
migration, son handler d'enregistrement, son CLI — les ~140 lignes reviennent sous un autre nom —
plus la branche du switch et `private_key_jwt` dans `src/discovery.ts:28`.

**Et la valeur en face est nulle, mesurée :** `Protocol Revision: draft`, **0 client sur 11** dans
la matrice officielle, l'extension *« n'apporte aucun mécanisme d'auth propre à MCP »*, le repo
`ext-auth` est inactif depuis le **2026-06-18**, et Anthropic refuse par ailleurs le
`client_credentials` pur côté connecteurs. **Refuser.**

### 7.4 Ce qui sort de cette fiche et doit être renvoyé

**La validation RFC 9207 de `iss` appartient à [`B03`](B03-auth-hardening-ssrf.md), et sa question
porte aujourd'hui une prémisse que ce challenge a réfutée.** §6.1 de B03 affirme que *« le binding
`state → row.provider` rend déjà la validation d'`iss` RFC 9207 redondante côté callback »*. RFC
9700 classe ce binding parmi les **préconditions** de l'attaque, pas parmi les défenses, et Google
— provider réellement câblé — annonce `authorization_response_iss_parameter_supported: true` alors
que le dépôt n'a **aucune** lecture d'`iss`. **B03 ne doit pas hériter de cette prémisse.**

Point connexe relevé en séance et non tranché ici : l'événement d'audit `auth.state.mixup`
(`oauth-callback.ts`) nomme une défense mix-up alors qu'il compare une valeur que le coordinateur a
lui-même écrite. À requalifier ou renommer — sinon c'est un garde-fou fantôme de plus, au sens de
l'audit v0.13.0.

### 7.5 L'engagement de §6.2 sur `listMemberships`

**Tranché : ce n'est pas un trou, c'est un point d'extension derrière un deny-by-default assumé.**
`OIDCProvider.listMemberships` n'est **jamais atteint** — la stratégie est `id_token_groups` quand
un `groupsClaim` est configuré, `"none"` sinon, et le commentaire de `oauth-callback.ts:279-281`
l'écrit : *« no portable allowlist model. **Deny by default**; deployments needing OIDC allowlist
vendor a subclass. »* Rien à corriger.

### 7.6 Corrections à porter dans les sections 1 à 5 et dans l'en-tête

1. **En-tête — `Nature`** : `replace-homemade-code (volet M2M)` → **`opportunity`**. §7.3 montre
   qu'on n'enlève rien : le solde est une addition nette.
2. **En-tête — `Tier`** : `T2-fort-levier` → **`T3`**. Aucun IdP déployable n'émet, zéro demande,
   socle IETF expirant.
3. **§4 est faux sur son bénéfice central** : *« L'auto-hébergeur en OIDC générique n'a donc aucun
   mapping de groupes »* — le mapping existe, par configuration (`COORDINATOR_OIDC_GROUPS_CLAIM`),
   documenté par vendeur dans `docs/idp-providers.md`.
4. **§6.1, seconde moitié** : « l'abandon d'`allowlist.ts` au profit des groupes IdP » est faux
   dans les deux sens (§6.4 F bis (5)).
5. **§2 / §5** : ajouter que le `jwks_uri` doit venir du **discovery de l'IdP** — le chemin
   `/.well-known/jwks.json` que suppose une lecture naïve n'est utilisé par aucun IdP réel.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : statut EMA beta côté Claude, `grant_profile` tranché, chemin SDK TS corrigé, lignes repo confirmées. |
| 2026-08-15 | Challenge. PoC ID-JAG contre un faux IdP monté ici (JWKS + assertion RS256), lecture du chemin d'autorisation, 2 réfutateurs adversariaux. **Verdict : `reporter` EMA, `refuser` le volet Client Credentials.** **§4 est réfuté sur son bénéfice principal** : le mapping de groupes en OIDC générique existe déjà (`oidc.ts:108` → `id_token_groups`), documenté par vendeur ; le `throw` de `listMemberships` n'est jamais atteint. Le PoC mesure **43 lignes** pour le noyau de grant — la fiche a raison sur ce point. **Quatre corrections que la passe adversariale m'a imposées** : (1) **K5 est réfuté** — RFC 9700 classe le binding `state → provider` parmi les *préconditions* de l'attaque mix-up, pas parmi les défenses, et Google annonce `authorization_response_iss_parameter_supported: true` alors que le dépôt ne lit aucun `iss` ; le sujet est renvoyé à `B03`, **dont la question porte la même prémisse fausse** ; (2) K2 était trop fort — le playground `xaa.dev` permet d'exercer le rôle d'AS **sans org Claude**, je ne l'ai simplement pas exercé ; (3) K3 est une disjonction dont je n'avais testé qu'un terme — la clause fichiers se déclenche (≥ 6), et mon compte de lignes mesurait le prologue en ignorant 164 lignes d'aval partagé ; (4) `id_token_groups` retombe sur `orgs.allowlist_github_org`, donc l'« abandon d'`allowlist.ts` » de §6.1 est faux dans les deux sens. Sur 6 critères, **3 étaient décoratifs** (K2, K4, K5) et **K6 n'avait jamais été évalué** — sa lettre est fausse (~140 lignes supprimables), son intention tient (solde = addition nette). Reclassements : Tier T2 → **T3**, Nature `replace-homemade-code` → **opportunity**. |
