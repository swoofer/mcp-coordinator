# B03 — Durcissement auth 2026 : RFC 9207, application_type, SSRF sur la découverte

| Champ | Valeur |
|---|---|
| **ID** | `auth-hardening-ssrf` |
| **Surface** | mcp-spec |
| **Statut** | GA (spec `2026-07-28`, révision « Current ») |
| **Disponible depuis** | `2026-07-28` |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | S |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — faux IdP local oui, client MCP tiers indisponible |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §1 — l'annonce de `authorization_response_iss_parameter_supported` n'est pas un SHOULD adossé à l'émission : la spec dit « Authorization servers that include the `iss` parameter **MUST** advertise this by setting `authorization_response_iss_parameter_supported` to `true` ». Le SHOULD ne porte que sur l'émission d'`iss`.
- §2 — le marqueur `(à vérifier)` sur le niveau normatif des trois SEP est tranché (voir la note réécrite en fin de §2). Aucun n'était faux, mais aucun n'était établi.
- §2 — précision de provenance : la liste des 8 plages IP, `stripe/smokescreen`, le TOCTOU DNS et le renvoi RFC 9728 §7.7 viennent de `docs/2026-07-28/tutorials/security/security_best_practices` (§ Server-Side Request Forgery), **pas** de la page normative `basic/authorization/security-considerations`, qui ne contient sur ce sujet qu'un « Authorization servers fetching metadata documents **SHOULD** consider SSRF risks ». Les deux URLs figuraient déjà en §3 ; l'attribution est désormais explicite.
- §2 — ajout de deux faits établis de la révision `2026-07-28` qui contextualisent SEP-837 : DCR est **déprécié** au profit des Client ID Metadata Documents, annoncés via `client_id_metadata_document_supported`.
- §5 — `src/auth/providers/github-shared.ts` : les appels à `parseNextLink` sont aux lignes **221 et 269**, pas 206 et 254 (206 et 254 ne pointent sur rien de pertinent ; la ligne 201 est le commentaire « SSRF-guarded via `parseNextLink` »). Corrigé.
- §5 — `cli/doctor.ts` : `probeDiscoveryDoc` s'étend de **196 à 280**, pas 196-253. Les contrôles `token_endpoint_auth_methods_supported` (254) et `code_challenge_methods_supported` (264) que la fiche revendique tombaient hors de la plage citée. Corrigé.

Tous les autres numéros de ligne cités en §5 ont été ouverts et vérifiés : `src/discovery.ts:12-33`, `src/serve-http.ts:695-701`, `src/auth/oauth-callback.ts:73-77` et `104-116, 154-165`, `src/auth/providers/oidc.ts:69-76 / 279-316 / 318-322`, `src/boot.ts:344-358`, `src/auth/oauth-token.ts:101-133`, `src/auth/oauth-login.ts:113-146`, `sdk/src/discovery.ts:119-125` — exacts, descriptions d'impact conformes au code. L'affirmation « aucun listener loopback n'existe dans `cli/` » est vérifiée (aucun `http.createServer` sous `cli/`). `tests/e2e/helpers/mock-github-server.ts` existe bien. Le statut d'en-tête est confirmé : la page `modelcontextprotocol.io/specification/versioning` désigne `2026-07-28` comme **Current**.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
Quatre des cinq puces du §6.3 se lancent ici : un faux IdP OIDC local (serveur Node servant un document de découverte dont `issuer` égale `COORDINATOR_OIDC_ISSUER_URL` — sinon le cross-check `oidc.ts:304` coupe avant le fetch) avec `token_endpoint` sur `169.254.169.254` et `jwks_uri` sur `10.0.0.1`, puis un `/auth/login` réel contre le daemon local, suffit à trancher si le `client_secret` part et si `createRemoteJWKSet` suit. Le callback forgé avec `iss` et le chronométrage d'un `safeFetch` sont également locaux.
Ce qui bloque : la puce 3 exige un **client MCP tiers réel** pour vérifier qu'annoncer `authorization_response_iss_parameter_supported: true` sans jamais émettre `iss` ne casse pas le flux — aucun autre client MCP n'est disponible sur ce poste, et c'est précisément le point où la fiche redoute d'« annoncer une conformité mensongère ». La puce 2 (TOCTOU DNS) n'est reproductible qu'au prix d'un résolveur custom monté à la main ; faisable, mais ce n'est plus un PoC.

## 1. Ce que c'est

La révision `2026-07-28` de la spec MCP ajoute trois durcissements normatifs à l'autorisation, plus une section de sécurité entière sur le SSRF. **SEP-2468** : les serveurs d'autorisation SHOULD renvoyer `iss` dans la réponse d'autorisation (RFC 9207), et ceux qui le renvoient MUST l'annoncer via `authorization_response_iss_parameter_supported: true` ; le client MCP doit valider un `iss` présent par comparaison de chaîne simple (RFC 3986 §6.2.1 — pas de normalisation de casse, de port ni de slash final) avant d'envoyer le code au token endpoint, y compris sur les réponses d'erreur. **SEP-837** : lors d'un enregistrement dynamique (DCR), le client doit préciser `application_type` — `native` pour un CLI en redirection loopback — sinon OIDC applique `web` par défaut et rejette les redirect URIs loopback. **SEP-2352** : les credentials client sont clés par identifiant d'issuer, jamais réutilisés avec un autre AS ; changement d'AS ⇒ ré-enregistrement.

La partie SSRF traite la découverte OAuth comme une surface d'attaque : un serveur MCP hostile contrôle l'URL `resource_metadata` du header `WWW-Authenticate`, les URLs `authorization_servers` de la Protected Resource Metadata et les `token_endpoint` / `authorization_endpoint` de la metadata AS. Un client MCP déployé côté serveur **MUST** considérer le risque SSRF et implémenter des mitigations ; les mitigations elles-mêmes sont des **SHOULD** : HTTPS en production, blocage des plages privées, validation des cibles de redirection, proxy d'egress. La symétrie est explicite : un serveur d'autorisation qui accepte CIMD fetche une URL fournie par un client inconnu et SHOULD considérer le même risque. La doc recommande de ne pas écrire la validation d'IP à la main (encodages octal, hex, IPv4-mapped IPv6).

## 2. Surface d'API exacte

```
iss                                            # param de la réponse d'autorisation (RFC 9207)
authorization_response_iss_parameter_supported # AS Metadata, booléen
code_challenge_methods_supported               # AS Metadata — absence ⇒ le client refuse de continuer
application_type                               # requête DCR : "native" | "web"
state, S256                                    # inchangés, PKCE S256 reste obligatoire
resource_metadata                              # paramètre du header WWW-Authenticate (RFC 9728)
authorization_servers                          # Protected Resource Metadata
token_endpoint, authorization_endpoint         # Authorization Server Metadata
client_id_metadata_document_supported          # AS Metadata — annonce du support CIMD
```

Contexte de révision établi : dans `2026-07-28`, le **Dynamic Client Registration (RFC 7591) est déprécié** au profit des Client ID Metadata Documents, et conservé pour compatibilité ascendante. `application_type` (SEP-837) ne concerne donc qu'un chemin d'enregistrement en voie de retrait.

Plages IP à refuser côté fetch OAuth sortant (liste exacte, issue de `docs/2026-07-28/tutorials/security/security_best_practices` § « Server-Side Request Forgery », qui renvoie à RFC 9728 §7.7 — et non de la page normative `basic/authorization/security-considerations`) :

```
10.0.0.0/8   172.16.0.0/12   192.168.0.0/16   127.0.0.0/8   ::1
169.254.0.0/16   fc00::/7   fe80::/10
```

Outil nommé explicitement dans la doc pour l'egress : `stripe/smokescreen` (même page). Le TOCTOU DNS (résolution au contrôle ≠ résolution au fetch) est cité, avec pinning DNS comme mitigation.

Niveaux normatifs exacts, relevés dans la spec `2026-07-28` (vérification du 2026-08-14) :

| Exigence | Niveau | Emplacement |
|---|---|---|
| AS inclut `iss` dans la réponse d'autorisation, erreurs comprises | **SHOULD** (la spec annonce un passage futur à MUST) | `basic/authorization` § Authorization Response Validation |
| AS qui inclut `iss` → annonce `authorization_response_iss_parameter_supported: true` | **MUST** | idem |
| Client valide un `iss` présent (comparaison de chaîne simple RFC 3986 §6.2.1, sans normalisation) | **MUST** | idem |
| Client rejette une réponse sans `iss` quand le flag AS vaut `true` | **MUST** | idem (tableau) |
| Client refuse de continuer si `code_challenge_methods_supported` est absent (OAuth AS Metadata **et** OIDC Discovery) | **MUST** | `basic/authorization/security-considerations` § Authorization Code Protection |
| Client précise un `application_type` approprié en DCR | **MUST** (le choix `native` / `web` est un **SHOULD**) | `basic/authorization/client-registration` § Application Type and Redirect URI Constraints |
| Client associe les credentials à l'`issuer` émetteur, ne les réutilise pas ailleurs, se ré-enregistre au changement d'AS | **MUST / MUST NOT / MUST** | idem § Authorization Server Binding |
| Client MCP déployé côté serveur considère le risque SSRF et implémente des mitigations | **MUST** | `security_best_practices` § SSRF Mitigation |
| Mitigations individuelles (HTTPS, blocage plages privées, validation des redirections, proxy d'egress) | **SHOULD** | idem |
| AS acceptant CIMD considère le risque SSRF | **SHOULD** | `basic/authorization/security-considerations` § Authorization Server Abuse Protection |

## 3. Sources

- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations
- https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :** le coordinateur occupe les deux rôles visés par la section. Il est **serveur d'autorisation** (`src/discovery.ts` sert la metadata RFC 8414, `oauth-token.ts` expose `authorization_code` + `device_code`) et **client OAuth** vers quatre IdP (github, github-app, google, oidc). Deux écarts sont mesurables et peu coûteux :

1. La metadata AS n'annonce pas `authorization_response_iss_parameter_supported`, et le callback (`oauth-callback.ts`) ne lit jamais `iss`. Le mix-up est déjà couvert autrement — binding HMAC cookie↔state puis vérification `row.provider` avec audit `auth.state.mixup` — donc l'ajout est un alignement de conformité, pas un colmatage de trou.
2. Côté client, le seul garde SSRF existant est local : `parseNextLink` dans `github-shared.ts` vérifie que l'origine du `Link: rel="next"` correspond à `apiBaseUrl`. Les trois autres surfaces sortantes (discovery OIDC, JWKS via `createRemoteJWKSet`, token endpoint OIDC) suivent des URLs sans filtre au-delà d'un contrôle de schéma http/https au boot. Généraliser ce garde en un client HTTP sortant unique fait disparaître un pattern dupliqué et donne à `doctor` une sonde de conformité vérifiable.

Le bénéficiaire direct est l'auto-hébergeur qui branche un OIDC d'entreprise : aujourd'hui, une metadata OIDC compromise ou un issuer mal saisi peut faire fetcher au coordinateur une adresse du réseau interne avec le `client_secret` en POST.

**Risque si on ne fait rien :** faible mais réel et croissant. Le vecteur exige aujourd'hui soit un IdP compromis, soit une variable d'environnement hostile — l'URL d'issuer vient de l'opérateur, pas d'un tiers. Il change de nature si le coordinateur devient consommateur de serveurs MCP tiers (URLs `resource_metadata` alors contrôlées par le serveur distant) ou s'il accepte CIMD côté AS. Second risque, non technique : sur un déploiement Phase 2 exposé, l'audit de conformité d'un client MCP tiers relèvera l'absence d'`authorization_response_iss_parameter_supported`, l'absence de `/.well-known/oauth-protected-resource` et l'absence de `resource_metadata` dans le `WWW-Authenticate` des 401 de `/mcp`.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/discovery.ts:12-33` | `buildDiscoveryDoc` : ajouter `authorization_response_iss_parameter_supported`. Contient déjà `code_challenge_methods_supported: ["S256"]` et `token_endpoint_auth_methods_supported: ["none"]`. Aucun `registration_endpoint` ⇒ pas de DCR ⇒ SEP-837 sans effet côté serveur. |
| `src/serve-http.ts:695-701` | Route `/.well-known/oauth-authorization-server` montée, gatée sur `ctx.phase2Bootstrap`. Point d'ancrage si on ajoute `/.well-known/oauth-protected-resource`. |
| `src/auth/oauth-callback.ts:73-77` | Lit `state`, `code`, `error`, `error_description` — jamais `iss`. C'est ici qu'irait la comparaison RFC 3986 §6.2.1. |
| `src/auth/oauth-callback.ts:104-116, 154-165` | Défense mix-up existante : HMAC cookie↔state (`recomputeStateHmac`) puis `ctx.providers.get(row.provider)` + audit `auth.state.mixup`. À confronter au gain marginal de `iss`. |
| `src/auth/providers/oidc.ts:279-316` | `getDiscovery()` : `fetch(this.discoveryUrl)` sans filtre d'IP, timeout 5 s, cache process-lifetime. Contrôle croisé `parsed.issuer === cfg.issuerUrl` déjà présent (ligne 304). Cible principale du garde SSRF. |
| `src/auth/providers/oidc.ts:69-76` | `DiscoveryResponseSchema` ne lit pas `code_challenge_methods_supported` : le coordinateur ne peut pas refuser un AS qui ne l'annonce pas. |
| `src/auth/providers/oidc.ts:318-322` | `createRemoteJWKSet(new URL(disco.jwksUri))` : URL issue du document distant, fetch délégué à `jose` — un garde d'egress devrait couvrir ce chemin aussi. |
| `src/auth/providers/github-shared.ts:63-80, 221, 269` | Garde SSRF existant (`next.origin !== expectedOrigin → null`). Précédent maison à généraliser plutôt qu'à dupliquer. |
| `src/boot.ts:344-358` | Validation de `COORDINATOR_OIDC_ISSUER_URL` : schéma http/https uniquement, pas de rejet des plages privées. Emplacement naturel d'un refus au boot (avec échappatoire loopback pour les tests e2e). |
| `src/auth/oauth-token.ts:101-133` | `grant_type=authorization_code` : le client détient un code IdP et un `redirect_uri`, échangé côté serveur. C'est le chemin où `application_type: native` compterait si l'enregistrement passait un jour par DCR. |
| `src/auth/pkce.ts` + `src/auth/oauth-login.ts:113-146` | PKCE S256 déjà systématique sur le flux navigateur (`generateVerifier` / `computeChallenge`, challenge toujours passé à `buildAuthUrl`). Rien à changer. |
| `cli/doctor.ts:196-280` | `probeDiscoveryDoc` vérifie déjà `issuer` (245), `token_endpoint_auth_methods_supported` (254) et `S256` (264). Endroit pour une sonde « conformité 2026-07-28 ». `cli/doctor.ts:425` utilise `redirect_uri: "http://localhost"` dans sa sonde du token endpoint. |
| `sdk/src/discovery.ts:119-125` | `fetchFromNetwork()` : le SDK consomme la metadata sans vérifier `code_challenge_methods_supported`. Rôle client à durcir symétriquement. |
| `src/auth/device-flow.ts` | Flux device (RFC 8628) : pas de redirect URI, donc hors périmètre SEP-837. Aucun listener loopback n'existe dans `cli/`. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le durcissement doit-il passer par un unique client HTTP sortant gardé (`safeFetch` : schéma, refus des 8 plages privées, pinning DNS) imposé à tous les fetch OAuth/JWKS des 4 providers, ou rester des gardes locaux par provider sur le modèle de `parseNextLink` dans `github-shared.ts` — sachant que le binding `state → row.provider` rend déjà la validation d'`iss` RFC 9207 redondante côté callback ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

> ⚠️ Non exécutable ici : la puce 3 requiert un client MCP tiers réel, indisponible sur ce poste ; la puce 2 (TOCTOU DNS) exige un résolveur custom monté à la main.

Proposition de protocole — non exécuté.

- [ ] Monter un faux IdP OIDC local dont le document de découverte annonce un `token_endpoint` sur `http://169.254.169.254/…` (métadonnées cloud) et un `jwks_uri` sur `http://10.0.0.1/…`, puis lancer un `/auth/login` réel : observer si le coordinateur émet la requête sortante et si le `client_secret` part dans le POST.
- [ ] Rejouer le même scénario avec une réponse DNS qui pointe d'abord vers une IP publique puis vers `127.0.0.1` (TOCTOU) pour mesurer ce qu'un contrôle d'IP hors `undici` laisse passer.
- [ ] Ajouter `authorization_response_iss_parameter_supported: true` à `buildDiscoveryDoc`, puis vérifier avec un client MCP tiers réel que l'absence effective d'`iss` dans la réponse d'autorisation ne casse pas le flux (le champ ne doit pas mentir).
- [ ] Forger un callback `/auth/callback?state=…&code=…&iss=https://evil.example` avec un cookie de state valide et confirmer par lecture de l'audit que `auth.state.mixup` se déclenche déjà via `row.provider`, ou pas.
- [ ] Chronométrer le surcoût d'un `safeFetch` (résolution DNS explicite + vérification) sur le chemin `getDiscovery` + `createRemoteJWKSet`, cache froid puis chaud.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Le vecteur suppose un opérateur ou un IdP hostile.** `COORDINATOR_OIDC_ISSUER_URL` vient du fichier `.env` de l'auto-hébergeur, pas d'un tiers non authentifié. Un opérateur qui veut faire fetcher une IP interne au coordinateur a des moyens plus simples. Le scénario réellement visé par la spec — client MCP suivant un `resource_metadata` fourni par un serveur distant — n'existe pas dans ce repo : le coordinateur n'est client d'aucun serveur MCP tiers.
- **`iss` est redondant ici.** La défense mix-up canonique repose sur le fait qu'un même redirect URI serve plusieurs AS. Le coordinateur lie déjà le `state` à un `provider` en base, avec CAS atomique et audit Tier 1. Ajouter `iss` améliore la conformité formelle, pas la posture réelle.
- **SEP-837 et CIMD sont hors périmètre.** Pas de `registration_endpoint`, pas de DCR, pas de CIMD, pas de listener loopback dans `cli/`. Deux des trois durcissements normatifs ne s'appliquent qu'à du code qui n'existe pas. Implémenter par anticipation, c'est du YAGNI.
- **Le blocage d'IP privées casse les tests et le self-hosting.** Les tests e2e s'appuient sur `mock-github-server.ts` en loopback ; le Docker Compose d'un auto-hébergeur résout souvent l'IdP sur une IP `172.x` interne. Toute liste noire a besoin d'une échappatoire de configuration, qui devient elle-même le point faible.
- **La doc dit de ne pas coder la validation d'IP à la main, mais Node n'offre rien de prêt.** Un garde correct implique un dispatcher `undici` avec `lookup` custom pour tenir le pinning DNS — code réseau bas niveau, difficile à tester, à maintenir sur les montées de version de Node. Smokescreen est un composant d'infrastructure, pas une dépendance npm : le recommander déplace le coût vers l'opérateur.
- **Le rapport effort/bénéfice est meilleur ailleurs.** Annoncer une conformité partielle (`authorization_response_iss_parameter_supported: true` sans jamais émettre `iss`) serait pire que le silence actuel. La version honnête et minimale — documenter la limitation, ajouter une sonde `doctor` — ne pèse presque rien mais ne coche aucune case de conformité non plus.

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
| 2026-08-14 | Vérification des faits : niveaux normatifs tranchés, 2 plages de lignes corrigées (github-shared, doctor), statut Current confirmé. |
