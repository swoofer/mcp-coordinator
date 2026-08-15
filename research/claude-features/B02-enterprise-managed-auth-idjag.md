# B02 — Enterprise-Managed Authorization (ID-JAG) et OAuth Client Credentials

| Champ | Valeur |
|---|---|
| **ID** | `enterprise-managed-auth-idjag` |
| **Surface** | mcp-spec |
| **Statut** | mixte : EMA **stable côté spec MCP** (`ext-auth/specification/stable/`, SEP-990) mais **beta + waitlist côté Claude** (Team/Enterprise, `claude.com/docs/connectors/building/enterprise-managed-auth`) · OAuth Client Credentials **draft** (`specification/draft/`, `Protocol Revision: draft`) |
| **Disponible depuis** | EMA : 2026-06-18 · durcissement du cœur auth : spec 2026-07-28 · Client Credentials : non daté |
| **Tier** | T2-fort-levier |
| **Nature** | opportunity (volet EMA) · replace-homemade-code (volet M2M) |
| **Effort estimé** | L |
| **Confiance veille** | high (EMA) · medium (Client Credentials) |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — bout-en-bout EMA bloqué par la waitlist beta Claude |
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

> ⚠️ Le bout-en-bout EMA n'est pas exécutable ici : il exige une org Claude Team/Enterprise avec EMA activé (beta sur waitlist) et un IdP émetteur d'ID-JAG. Les autres points sont exécutables localement.

Proposition, pas un résultat.

- [ ] Vérifier dans `node_modules/@modelcontextprotocol/sdk` la révision de protocole embarquée et la présence effective de `server/discover` et du modèle de capabilities par requête `_meta["io.modelcontextprotocol/clientCapabilities"]` — sans quoi la négociation d'extension n'est pas implémentable telle quelle.
- [ ] Lire `specification/stable/` de `modelcontextprotocol/ext-auth` pour extraire la liste exacte des vérifications qu'un AS doit faire sur un ID-JAG (claims obligatoires, `aud` attendu, fenêtre `exp`), et la confronter à ce que fait déjà `jwtVerify` dans `src/auth/providers/oidc.ts:194`.
- [ ] PoC : ajouter une branche `jwt-bearer` dans le `switch` de `src/auth/oauth-token.ts` qui valide un JWT signé par un IdP de test (Keycloak local, déjà supporté par `OIDCProvider`) et mint un access token via `mintAccessJWT`. Mesurer le volume de code réellement ajouté.
- [ ] Vérifier par lecture de `src/auth/oauth-callback.ts` si un paramètre `iss` est renvoyé par chacun des 4 providers (`github`, `github-app`, `google`, `oidc`) et si son absence de validation est exploitable (mix-up attack) dans notre configuration.
- [ ] Tester si un client MCP réel (Claude Code) envoie quoi que ce soit sous `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` en se connectant au coordinateur — c'est la mesure qui tranche « annonce » contre « support ».

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : statut EMA beta côté Claude, `grant_profile` tranché, chemin SDK TS corrigé, lignes repo confirmées. |
