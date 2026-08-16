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
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — `adopter partiellement` : contrôle d'origine, pas de `safeFetch` |

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

> Le durcissement doit-il passer par un unique client HTTP sortant gardé (`safeFetch` : schéma, refus des 8 plages privées, pinning DNS) imposé à tous les fetch OAuth/JWKS des 4 providers, ou rester des gardes locaux par provider sur le modèle de `parseNextLink` dans `github-shared.ts` — ~~sachant que le binding `state → row.provider` rend déjà la validation d'`iss` RFC 9207 redondante côté callback~~ ?

> ⚠️ **Prémisse réfutée le 2026-08-15 par le challenge de [`B02`](B02-enterprise-managed-auth-idjag.md) — à ne pas hériter.**
> La clause finale ci-dessus est **fausse**. `B02` §6.4 (F bis)(1) a mesuré, sources primaires à
> l'appui :
>
> - **RFC 9700 classe le binding `state → provider` parmi les *préconditions* de l'attaque
>   mix-up, pas parmi les défenses** — verbatim : *« the client stores the authorization server
>   chosen by the user in a session bound to the user's browser »* et *« uses the same redirection
>   URI for each authorization server »*. Et : *« It is important to note that **just storing the
>   authorization server URL is not sufficient** to identify mix-up attacks. »*
> - `src/auth/oauth-login.ts:125` construit **un seul** `redirect_uri` pour les 4 providers — donc
>   la seconde contre-mesure de la BCP (URI distinctes par AS) n'est pas là non plus.
> - **Google, provider réellement câblé, annonce `authorization_response_iss_parameter_supported:
>   true`** (vérifié), et `grep` sur `src/ sdk/src/ cli/` → **0 lecture d'un paramètre `iss`**.
>
> *Nuance à conserver* : l'exposition suppose ≥ 2 providers configurés dont un hostile, et nos 4
> providers sont **statiquement configurés au boot** — un attaquant ne peut pas en déclarer un.
> L'attaque-exemple de la RFC (l'attaquant déclare *son* AS) n'est donc pas transposable telle
> quelle. Mais « redondant » est faux, et le volet `iss` doit être instruit **sur ses mérites**
> par ce challenge, pas écarté d'avance.
>
> Point connexe à trancher ici : l'événement d'audit **`auth.state.mixup`**
> (`src/auth/oauth-callback.ts`) nomme une défense mix-up alors qu'il compare une valeur que le
> coordinateur a lui-même écrite en base. Candidat au motif « garde-fou fantôme » de l'audit
> v0.13.0 — à requalifier ou renommer.

### 6.2 Hypothèse

> Pré-enregistrée le 2026-08-15, **avant** tout PoC. Le seul fait déjà collecté est la lecture de
> `src/auth/providers/oidc.ts:279-322`, qui a motivé le cadrage ci-dessous.

**Hypothèse.** §6.5 et §4 partagent une erreur : ils cadrent le SSRF comme exigeant *« un opérateur
ou un IdP hostile »*, et concluent que le vecteur est théorique. Je crois que c'est faux, et que le
scénario réel est plus banal. Déjà lu :

```ts
// oidc.ts:304 — le cross-check ne porte QUE sur issuer
if (parsed.issuer !== this.cfg.issuerUrl) throw ...
// oidc.ts:311-313 — mais les endpoints sont repris VERBATIM du document distant
tokenEndpoint: parsed.token_endpoint,
jwksUri: parsed.jwks_uri,
```

Un attaquant qui contrôle le **document** (IdP compromis, DNS détourné, MITM sur un lien http)
met `issuer` à la valeur attendue — c'est trivial — et pointe `token_endpoint` où il veut. **Il
n'a pas besoin d'être l'opérateur.** Je m'attends donc à ce que le `client_secret` parte vers
l'adresse choisie par l'attaquant.

Sur le volet `iss` : `B02` a réfuté la clause « redondant » de §6.1 et de §6.5. Je m'attends à ce
que le gain réel reste **faible en posture** (nos 4 providers sont statiquement configurés, donc
l'attaquant ne peut pas en déclarer un) mais **réel en conformité** — et surtout à ce que le
MUST du tableau §2 ligne 79 (« rejeter une réponse sans `iss` quand le flag AS vaut `true` ») soit
**violé aujourd'hui contre Google**.

**Verdict attendu :** `adopter partiellement` — le garde sur le chemin OIDC sortant, pas le
`safeFetch` généralisé aux 4 providers.

**Critères de refus, chiffrés (pré-enregistrés) :**

| # | Volet | Le résultat qui tue |
|---|---|---|
| **K1** | SSRF | Le `client_secret` **ne part pas** vers le `token_endpoint` du document distant (un garde existant que je n'aurais pas vu l'intercepte) → il n'y a rien à garder. |
| **K2** | SSRF | Le cross-check `parsed.issuer === cfg.issuerUrl` **suffit** à bloquer l'attaque → le garde n'a rien à ajouter. |
| **K3** | SSRF | Le surcoût d'un garde sur le chemin sortant dépasse **50 ms** à froid ou **5 ms** à chaud. |
| **K4** | SSRF | Bloquer les 8 plages privées **casse les tests e2e ou le self-hosting** sans échappatoire praticable (Docker Compose résout souvent l'IdP en `172.x`). |
| **K5** | `iss` | Le MUST du tableau §2 (rejeter sans `iss` quand le flag vaut `true`) **n'est pas violé** en pratique, ou aucun de nos providers réels n'annonce le flag. |
| **K6** | SEP-837 / CIMD | Sans `registration_endpoint` ni DCR ni listener loopback, ces volets n'ont **rien à toucher** → hors périmètre. |
| **K7** | tous | Zéro demande utilisateur, et le profil de déploiement (mono-poste, IdP de l'opérateur) rend le vecteur inatteignable. |

**Critère d'adoption :** une fuite de credential **reproduite ici**, et un garde dont le coût
mesuré tient sous les seuils de K3 sans déclencher K4.

**Ce que je m'engage à trancher même si tout tombe :** le sort de l'audit `auth.state.mixup`
(garde-fou fantôme ou pas), et l'honnêteté de `buildDiscoveryDoc` sur le flag `iss`.

### 6.3 Protocole de vérification

> ⚠️ Non exécutable ici : la puce 3 requiert un client MCP tiers réel, indisponible sur ce poste ; la puce 2 (TOCTOU DNS) exige un résolveur custom monté à la main.

Proposition de protocole — non exécuté.

- [ ] Monter un faux IdP OIDC local dont le document de découverte annonce un `token_endpoint` sur `http://169.254.169.254/…` (métadonnées cloud) et un `jwks_uri` sur `http://10.0.0.1/…`, puis lancer un `/auth/login` réel : observer si le coordinateur émet la requête sortante et si le `client_secret` part dans le POST.
- [ ] Rejouer le même scénario avec une réponse DNS qui pointe d'abord vers une IP publique puis vers `127.0.0.1` (TOCTOU) pour mesurer ce qu'un contrôle d'IP hors `undici` laisse passer.
- [ ] Ajouter `authorization_response_iss_parameter_supported: true` à `buildDiscoveryDoc`, puis vérifier avec un client MCP tiers réel que l'absence effective d'`iss` dans la réponse d'autorisation ne casse pas le flux (le champ ne doit pas mentir).
- [ ] Forger un callback `/auth/callback?state=…&code=…&iss=https://evil.example` avec un cookie de state valide et confirmer par lecture de l'audit que `auth.state.mixup` se déclenche déjà via `row.provider`, ou pas.
- [ ] Chronométrer le surcoût d'un `safeFetch` (résolution DNS explicite + vérification) sur le chemin `getDiscovery` + `createRemoteJWKSet`, cache froid puis chaud.

### 6.4 Résultat observé

> Exécuté le 2026-08-15. **Frontière exécuté / lu :** (A) à (D) sont exécutés ici ; (E) nomme ce
> qui ne l'a pas été. Le dépôt n'a pas été modifié — le PoC vit dans `scratchpad/b03/poc.mts`.

#### (A) K1 et K2 — La fuite de credential est réelle, reproduite ici

Faux IdP local (`127.0.0.1:3220`) servant un document de découverte **dont l'`issuer` vaut
exactement la valeur configurée** — donc le cross-check `oidc.ts:304` passe — mais dont le
`token_endpoint` pointe sur un collecteur que l'attaquant contrôle (`127.0.0.1:3221`).
`OIDCProvider.exchangeCode()` réel, non simulé :

```
--- echange du code aupres de l'IdP (compromis) ---
exchangeCode a leve: IdP access token revoked

*** LE SECRET EST PARTI ***
  destination : http://127.0.0.1:3221/steal -> recu sur /steal
  client_id      : coordinator-client
  client_secret  : SUPER-SECRET-DU-COORDINATEUR
  code           : code-from-idp
  code_verifier  : verifier
```

**Ni K1 ni K2 ne se déclenchent.** Le `client_secret`, le code d'autorisation et le
`code_verifier` PKCE partent vers l'adresse choisie par l'attaquant. Le cross-check sur `issuer`
ne protège de rien ici : **celui qui contrôle le document contrôle aussi son champ `issuer`**, et
le mettre à la valeur attendue est trivial.

> ⚠️ **Correction de mon propre cadrage, imposée par la passe adversariale.** J'avais écrit ici que
> « le modèle de menace de la fiche est trop étroit, et c'est la correction principale ».
> **C'est une dramatisation, et elle est fausse** : §4 décrit **déjà** ce scénario mot pour mot —
> *« une **metadata OIDC compromise** ou un issuer mal saisi peut faire fetcher au coordinateur une
> adresse du réseau interne **avec le `client_secret` en POST** »* — et §4 ajoute *« Le vecteur
> exige aujourd'hui soit un **IdP compromis**, soit une variable d'environnement hostile »*.
> Mon PoC **confirme** la fiche, il ne la réfute pas. **§6.5 puce 1 n'est pas barrée : elle tient.**
>
> Et sur le fond, pour un auto-hébergeur mono-poste, l'IdP compromis n'ajoute presque rien : si
> c'est **son propre Keycloak** sur la même machine, le compromettre suppose déjà de posséder la
> boîte ; si c'est un **IdP SaaS en https**, un attaquant qui le contrôle peut déjà forger des
> `id_token`, ce qui est **pire** que voler un secret.

**Ce que le PoC apporte réellement se réduit à deux points, et ils sont plus étroits :**

1. **Le cross-check `parsed.issuer === cfg.issuerUrl` (`oidc.ts:304`) n'est pas une atténuation.**
   §5 le présente comme telle (*« Contrôle croisé `parsed.issuer === cfg.issuerUrl` déjà présent
   (ligne 304) »*). Le PoC prouve que **celui qui contrôle le document contrôle aussi ce champ**.
   C'est une correction factuelle à porter en §5, et c'est la vraie contribution de la mesure.
2. **`boot.ts:344-358` accepte `http://` pour l'issuer.** C'est le **seul** chemin qui donne à
   l'attaquant une capacité qu'il n'a pas déjà : MITM réseau ou DNS détourné, **sans compromettre
   l'IdP ni être l'opérateur**. Celui-là sort du « opérateur ou IdP hostile » de §6.5.

Deux aggravants lus dans le code :

Deux aggravants lus dans le code :

- `oidc.ts:311-313` reprend `token_endpoint` **et** `jwks_uri` verbatim du document ; `jwks_uri`
  part ensuite dans `createRemoteJWKSet` (`:320`), donc un second fetch non gardé.
- `boot.ts:344-358` ne valide que le **schéma** (`http:`/`https:`) de l'issuer — `http://` est
  accepté, donc un simple MITM suffit à réécrire le document.

#### (B) K3 — Le coût d'un garde est négligeable

Résolution DNS explicite + classification de plage, sur les hôtes réellement utilisés :

```
accounts.google.com    froid  9.2242 ms | chaud  0.528 ms | 64.233.178.84 ok
github.com             froid   0.441 ms | chaud  0.374 ms | 140.82.113.4 ok
```

Très en dessous des seuils pré-enregistrés (50 ms à froid, 5 ms à chaud). **K3 ne se déclenche
pas.** Et le `getDiscovery()` du coordinateur cache déjà son résultat pour la vie du process
(`oidc.ts:280`), donc le coût réel est payé **une fois**.

#### (C) K4 — Le blocage des plages privées casse bien quelque chose

```
   169.254.169.254  -> BLOQUE      10.0.0.1  -> BLOQUE
   172.17.0.2       -> BLOQUE      127.0.0.1 -> BLOQUE      8.8.8.8 -> autorise
```

`172.17.0.2` est le bridge Docker par défaut et `127.0.0.1` le loopback. Quatre fichiers de test
pointent des IdP sur du loopback — `tests/e2e/helpers/coordinator-fixture.ts`,
`tests/e2e/helpers/mock-github-server.ts`, `tests/unit/boot.test.ts`,
`tests/unit/cli-server-start-env-forwarding.test.ts` — et le self-hosting en Docker Compose résout
couramment l'IdP en `172.x`.

> ⚠️ **Correction de ma propre mesure, imposée par la passe adversariale et re-vérifiée par moi.**
> J'avais écrit que ces quatre fichiers « pointent des IdP sur loopback » et conclu **K4 déclenché**.
> **La preuve était fausse.** Vérifié fichier par fichier :
>
> | Fichier | Ce qu'il contient réellement | Touché par un garde sur le chemin OIDC ? |
> |---|---|---|
> | `coordinator-fixture.ts:117-118` | `mockGithub.authBaseUrl` / `apiBaseUrl` — chemin **GitHub** | **non** |
> | `mock-github-server.ts` | listener `127.0.0.1` servant des endpoints **GitHub** | **non** |
> | `boot.test.ts:1129` | `https://idp.example.test/realms/main` — **non-loopback, jamais fetché** | **non** |
> | `cli-server-start-env-forwarding.test.ts:42` | la **chaîne `"COORDINATOR_OIDC_ISSUER_URL"`**, une liste de noms de variables | **non** |
>
> **Zéro test ne pointe un IdP OIDC sur du loopback.** **K4 ne se déclenche donc pas sur le
> périmètre adopté.** Il se déclenche sur la **généralisation aux 4 providers** — et c'est ce qui
> la tue, pas ce qui empêche le garde OIDC.
>
> Le seul membre de K4 qui survive est le self-hosting Docker Compose (`http://keycloak:8080`
> → 172.x), et **je ne l'ai pas mesuré** : c'est un raisonnement, pas une preuve. Il devient sans
> objet avec le design retenu (D bis), qui ne bloque aucune plage.

#### (D) Le volet `iss` — et l'audit `auth.state.mixup` est un garde-fou fantôme

**L'engagement de §6.2 est tranché : `auth.state.mixup` ne détecte aucun mix-up.** Il n'est émis
qu'à un seul endroit, et sa condition est que le provider **stocké dans notre propre base** ne
soit pas enregistré :

```ts
// src/auth/oauth-callback.ts:154-159
const provider = ctx.providers.get(row.provider);
if (!provider) {
  audit("auth.state.mixup", { tier: 1, metadata: { observed_provider: row.provider, … } });
```

`row.provider` est une valeur que le coordinateur a lui-même écrite à `/auth/login`. **Un
attaquant ne peut pas la faire varier** : l'événement ne se déclenche que si l'opérateur retire un
provider pendant qu'un flux est en vol. Le nom promet une défense mix-up que le mécanisme ne
fournit pas — motif « garde-fou fantôme » de l'audit v0.13.0.

Le commentaire d'en-tête est en plus périmé (`oauth-callback.ts:62-63`) : *« row.provider MUST
equal the expected **"github"** »* — rédigé à l'époque mono-provider, alors que le dépôt en a
quatre.

**Sur `iss` lui-même**, ce qui était déjà établi par [`B02`](B02-enterprise-managed-auth-idjag.md)
et re-vérifié : Google annonce `authorization_response_iss_parameter_supported: true`, le dépôt
n'a **0 lecture** d'un paramètre `iss`, et `oauth-login.ts:125` construit un **seul**
`redirect_uri` pour les 4 providers. Le tableau §2 ligne 79 qualifie de **MUST** le rejet d'une
réponse sans `iss` quand le flag AS vaut `true`.

**Réserve de cadrage que je maintiens, et qui n'est pas dans la fiche :** ce MUST est adressé au
*client MCP* dans sa relation à un *AS MCP*. Notre relation à Google est celle d'un client OAuth
ordinaire vers un IdP — c'est RFC 9207 qui s'y applique, pas le MUST de la spec MCP. L'écart est
réel, mais le qualifier de « violation d'un MUST de la spec MCP » serait une extrapolation.

#### (D bis) Le design qui échappe à K4 — et il est déjà dans le dépôt

K4 porte sur *« bloquer les 8 plages privées »*. Un **contrôle d'origine** ne bloque aucune plage :
il exige que `token_endpoint` et `jwks_uri` soient sur la **même origine** que l'issuer configuré.
C'est exactement le patron `parseNextLink` de `github-shared.ts:69-80` — dont le commentaire nomme
déjà la même menace :

> *« SSRF guard: requires the next URL's origin to match `expectedOrigin`. **A compromised
> upstream (or MITM in a GHES deployment) could otherwise point pagination at an
> attacker-controlled host, leaking the OAuth Bearer token** carried by `apiHeaders`. »*

**Le dépôt raisonne donc déjà sur cette menace exacte — pour GitHub. Le chemin OIDC ne l'a
simplement pas.** Testé sur les sept cas qui comptent :

```
  BLOQUE   attaque du PoC (port different)    -> http://127.0.0.1:3221/steal
  BLOQUE   metadonnees cloud                  -> http://169.254.169.254/latest/meta-data/
  BLOQUE   reseau interne                     -> http://10.0.0.1/token
  AUTORISE IdP legitime                       -> https://idp.example.com/oauth2/token
  AUTORISE test e2e loopback                  -> http://127.0.0.1:8080/token
  AUTORISE Docker Compose bridge              -> http://172.17.0.2:8080/token
  AUTORISE Keycloak realm (sous-chemin)       -> https://kc.example.com/realms/x/protocol/...
```

**Les trois formes d'attaque tombent, et aucun des montages légitimes ne casse** — ni le loopback
des tests e2e, ni le bridge Docker, ni le sous-chemin de realm Keycloak. **Aucune échappatoire de
configuration n'est nécessaire**, donc le contre-argument de §6.5 (« l'échappatoire devient
elle-même le point faible ») ne s'applique pas à ce design.

#### (D ter) K7 — Zéro demande

```
SSRF -> 0     client_secret -> 0     egress -> 1     hardening -> 3     security -> 2     OIDC -> 2
```

Dépouillées, les correspondances sont **incidentes** : #273 (bind du daemon en CLI), #91 (unit
systemd), #102 (epic de release), #75 (tree-sitter). **Aucune demande d'un durcissement SSRF.**
La première moitié de K7 se déclenche. La seconde (« vecteur inatteignable ») **ne se déclenche
pas** : (A) l'a reproduit.

#### (D quater) L'inventaire qui répond à §6.1 — 2 URLs sur 16, toutes deux dans `oidc.ts`

Toutes les sorties réseau de `src/` (`await fetch` · `createRemoteJWKSet` · `fetchWithRetry`),
classées par **origine de l'URL** :

| Site | D'où vient l'URL ? |
|---|---|
| `oidc.ts:164` (`disco.tokenEndpoint`) | **document distant** ⚠️ |
| `oidc.ts:320` (`disco.jwksUri`) | **document distant** ⚠️ |
| `oidc.ts:284` (`this.discoveryUrl`) | env opérateur (`COORDINATOR_OIDC_ISSUER_URL`) |
| `google.ts:90, 134` | **constantes en dur** — `DEFAULT_TOKEN_URL`, `DEFAULT_JWKS_URL` (l. 47-49) |
| `github.ts:82,110,131` · `github-app.ts:112,160` · `github-shared.ts:165,175` | env opérateur, validé au boot |
| `github-shared.ts:209, 257` | `Link: rel="next"` distant — **déjà gardé** par `parseNextLink` |
| `quota/quota.ts:62` | constante `USAGE_URL` |

**Il y a exactement deux URLs sortantes dérivées d'un document distant dans tout le dépôt, et les
deux sont dans `oidc.ts`.** Trois providers sur quatre n'ont rien à garder, et le seul autre
chemin exposé l'est déjà. **§6.1 est donc mal posée** : elle oppose « `safeFetch` unique imposé aux
4 providers » à « gardes locaux par provider », alors que la question réelle ne porte que sur un
seul fichier.

*Limite à nommer :* certains AS séparent l'origine de l'issuer et celle du token endpoint — Google
en est l'exemple (`accounts.google.com` vs `oauth2.googleapis.com`). Mais **Google ne passe pas par
`OIDCProvider`** (classe dédiée, URLs en dur), et Keycloak, Okta et Entra servent leurs endpoints
sur l'origine de l'issuer. Le compromis reste à instruire pour les AS multi-origines ; il ne l'a
pas été ici.

#### (F) Bilan des sept critères

| # | Statut | Ce qui l'établit |
|---|---|---|
| **K1** | ❌ **non déclenché** | Le `client_secret`, le `code` et le `code_verifier` partent — PoC (A). Vrai critère : un garde non repéré aurait pu l'intercepter. |
| **K2** | ❌ **non déclenché** | Le cross-check `issuer` passe trivialement — PoC (A). |
| **K3** | ❌ **non déclenché** | 9,2 ms à froid / 0,5 ms à chaud (B) — **mais** voir la réserve ci-dessous. |
| **K4** | ❌ **non déclenché sur le périmètre adopté** | Ma preuve initiale était fausse (C) : zéro test ne pointe un IdP OIDC sur du loopback. K4 tue la **généralisation**, pas le garde OIDC. |
| **K5** | ⚠️ **contesté** | Google annonce le flag, nous ne lisons pas `iss` — mais le MUST invoqué vise la relation client MCP ↔ AS MCP, pas la nôtre vers un IdP (D). |
| **K6** | ⚠️ **acquis d'avance** | §5 l. 109/122 et §6.5 puce 3, écrites le **2026-08-14**, contenaient déjà « pas de `registration_endpoint`, pas de DCR, pas de listener loopback » — vérifié en §0. **Il n'a rien apporté.** |
| **K7** | ❌ **non déclenché** (conjonction) | Zéro demande sur 62 issues (D ter) — mais le second membre, « vecteur inatteignable », est **falsifié** par (A). |

**Réserve sur K3, qui borne ce qui peut être adopté :** ce que j'ai chronométré est une résolution
DNS + une classification de plage — **un proxy du garde, pas le garde**. Et §6.4 (E) le dit :
aucun `safeFetch` n'a été construit. Le design finalement retenu (D bis) n'a d'ailleurs **pas
besoin** de cette mesure : un contrôle d'origine ne résout aucun DNS.

#### (E) Ce qui n'a PAS été exécuté

- **La puce 3** (annoncer le flag `iss` et vérifier avec un client MCP tiers que ça ne casse
  rien) : aucun autre client MCP sur ce poste. Inchangé depuis la §0.
- **La puce 2** (TOCTOU DNS) : exige un résolveur custom monté à la main. Non fait — donc je ne
  peux **pas** affirmer ce qu'un contrôle d'IP hors `undici` laisserait passer, et le pinning DNS
  reste une exigence lue, pas mesurée.
- **Aucun `safeFetch` n'a été implémenté ni branché** : (B) mesure le coût d'une résolution + d'une
  classification, pas celui d'un dispatcher `undici` complet.

### 6.5 Contre-arguments

- **Le vecteur suppose un opérateur ou un IdP hostile.** `COORDINATOR_OIDC_ISSUER_URL` vient du fichier `.env` de l'auto-hébergeur, pas d'un tiers non authentifié. Un opérateur qui veut faire fetcher une IP interne au coordinateur a des moyens plus simples. Le scénario réellement visé par la spec — client MCP suivant un `resource_metadata` fourni par un serveur distant — n'existe pas dans ce repo : le coordinateur n'est client d'aucun serveur MCP tiers.
- ❌ ~~**`iss` est redondant ici.** La défense mix-up canonique repose sur le fait qu'un même redirect URI serve plusieurs AS. Le coordinateur lie déjà le `state` à un `provider` en base, avec CAS atomique et audit Tier 1. Ajouter `iss` améliore la conformité formelle, pas la posture réelle.~~ — **barré le 2026-08-15.** RFC 9700 classe ce binding parmi les **préconditions** de l'attaque, pas parmi les défenses (*« just storing the authorization server URL is not sufficient »*), et l'audit Tier 1 invoqué ici ne détecte aucun mix-up (§6.4 D). Voir §7.4 pour l'instruction sur les mérites.
- **SEP-837 et CIMD sont hors périmètre.** Pas de `registration_endpoint`, pas de DCR, pas de CIMD, pas de listener loopback dans `cli/`. Deux des trois durcissements normatifs ne s'appliquent qu'à du code qui n'existe pas. Implémenter par anticipation, c'est du YAGNI.
- **Le blocage d'IP privées casse les tests et le self-hosting.** Les tests e2e s'appuient sur `mock-github-server.ts` en loopback ; le Docker Compose d'un auto-hébergeur résout souvent l'IdP sur une IP `172.x` interne. Toute liste noire a besoin d'une échappatoire de configuration, qui devient elle-même le point faible.
- **La doc dit de ne pas coder la validation d'IP à la main, mais Node n'offre rien de prêt.** Un garde correct implique un dispatcher `undici` avec `lookup` custom pour tenir le pinning DNS — code réseau bas niveau, difficile à tester, à maintenir sur les montées de version de Node. Smokescreen est un composant d'infrastructure, pas une dépendance npm : le recommander déplace le coût vers l'opérateur.
- **Le rapport effort/bénéfice est meilleur ailleurs.** Annoncer une conformité partielle (`authorization_response_iss_parameter_supported: true` sans jamais émettre `iss`) serait pire que le silence actuel. La version honnête et minimale — documenter la limitation, ajouter une sonde `doctor` — ne pèse presque rien mais ne coche aucune case de conformité non plus.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | **La fuite est réelle et reproduite par la vraie chaîne de handlers — mais ce n'est pas le SSRF que la fiche décrit, et le remède qu'elle propose ne l'arrêterait pas.** Ce que le PoC démontre est une **substitution d'endpoint** dans le document de découverte : l'attaquant met `issuer` à la valeur attendue (le cross-check `oidc.ts:304` passe), pointe `token_endpoint` où il veut, et récolte `client_secret` + `code` + `code_verifier`. Son collecteur est sur une **IP publique** — un garde par plages privées ne le bloque pas, et la propre mesure de §6.4 (C) l'affiche (`8.8.8.8 -> autorise`). Le remède retenu est donc un **contrôle d'origine** sur le modèle de `parseNextLink` déjà présent dans le dépôt : ~15 lignes, **0 dépendance, 0 ms, aucune liste noire**. Écartés : le `safeFetch` à plages IP + pinning DNS (il ajouterait `undici` en dépendance de production sur le chemin d'auth, **et ne bloque pas l'attaque démontrée**), sa généralisation aux 4 providers (3 sur 4 n'ont aucune URL dérivée d'un document distant), et SEP-837/CIMD (rien à toucher). |
| **Issue / PR** | Aucune créée. Périmètre en §7.2, **à confirmer avec le mainteneur**. |
| **Jalon visé** | prochaine mineure |

### 7.1 La réponse à la question de §6.1

**§6.1 est mal posée, et l'inventaire du code le montre.** Elle oppose « un `safeFetch` unique
imposé aux 4 providers » à « des gardes locaux par provider ». Or, sur les **16 sorties réseau** de
`src/` (§6.4 D quater), **exactement deux** dérivent d'un document distant — `oidc.ts:164`
(`disco.tokenEndpoint`) et `oidc.ts:320` (`disco.jwksUri`). Les autres viennent de l'environnement
opérateur, sont des constantes en dur (`google.ts:47-49`), ou sont **déjà gardées**
(`github-shared.ts:209,257` via `parseNextLink`).

**Il n'y a donc pas 4 providers à garder : il y en a un, et un seul fichier.** Le dilemme
« unique vs local » n'a pas d'objet — la réponse est un garde local, parce qu'il n'existe qu'un
seul site à garder.

**Et la question se trompe aussi de menace.** Elle parle de SSRF (plages privées, pinning DNS).
Le défaut mesuré est une **substitution d'endpoint** : l'attaquant n'a pas besoin d'une IP interne,
il lui suffit d'une IP à lui. Les deux menaces se recouvrent partiellement, mais **le garde que
§6.1 propose ne couvre pas celle qui est prouvée**.

### 7.2 Ce qui est retenu — périmètre exact

1. **Contrainte d'origine dans `getDiscovery()`** (`src/auth/providers/oidc.ts:298-315`) :
   `authorization_endpoint`, `token_endpoint` et `jwks_uri` doivent partager l'origine de
   `cfg.issuerUrl`. C'est le patron `parseNextLink` (`github-shared.ts:69-80`), dont le commentaire
   nomme déjà **la même menace** — *« A compromised upstream (or MITM…) could otherwise point
   pagination at an attacker-controlled host, leaking the OAuth Bearer token »*. Mesuré (§6.4
   D bis) : bloque les trois formes d'attaque, laisse passer l'IdP légitime, le loopback des tests,
   le bridge Docker et le sous-chemin de realm Keycloak.
   **Échappatoire nécessaire, déclarative et non une liste noire** : une liste d'origines
   supplémentaires autorisées par l'opérateur. **Google est un contre-exemple réel et mesuré**
   (`accounts.google.com` → `oauth2.googleapis.com`, `www.googleapis.com`) ; il ne passe pas par
   `OIDCProvider` aujourd'hui, mais rien n'empêche un opérateur de configurer un AS multi-origines.
2. **Exiger `https:` pour `COORDINATOR_OIDC_ISSUER_URL` hors loopback** (`src/boot.ts:344-358`,
   qui n'impose aujourd'hui que « http ou https »). **C'est le seul chemin qui donne à l'attaquant
   une capacité qu'il n'a pas déjà** : MITM réseau ou DNS détourné, sans compromettre l'IdP ni être
   l'opérateur.
3. **Déplacer l'audit, pas seulement le renommer.** `auth.state.mixup`
   (`oauth-callback.ts:156`) porte sur `row.provider`, une valeur **que nous avons écrite** —
   infalsifiable par un tiers, donc aucun mix-up détecté. Pendant ce temps
   `oauth-token.ts:118-128` prend `body.provider` **du client**, sur un endpoint annoncé
   `token_endpoint_auth_methods_supported: ["none"]`, et un nom inconnu ne produit **aucun audit**
   (vérifié : 0 appel à `audit()` dans ce bloc). L'action juste est donc : **renommer** côté
   callback (`auth.state.provider_unregistered`, qui décrit ce qu'il détecte vraiment — un provider
   retiré en cours de flux) **et émettre** un audit côté token endpoint. Corriger au passage le
   commentaire périmé `oauth-callback.ts:62-63` (« must equal the expected **"github"** », écrit à
   l'ère mono-provider).
4. **Corriger §5** : le cross-check `parsed.issuer === cfg.issuerUrl` y est présenté comme une
   atténuation existante. Il n'en est pas une — celui qui contrôle le document contrôle ce champ.

### 7.3 Ce qui est écarté, et sur quelle mesure

- **Le `safeFetch` à plages IP + pinning DNS.** Deux raisons, la seconde décisive :
  `undici` **n'est pas une dépendance** du projet (vérifié) — un pinning anti-TOCTOU exigerait
  `new Agent({connect:{lookup}})`, donc une dépendance de production **sur le chemin
  d'authentification**. Et surtout **il ne bloque pas l'attaque démontrée** : le collecteur de
  l'attaquant est sur une IP publique. Ma propre mesure de §6.4 (C) l'affiche déjà
  (`8.8.8.8 -> autorise`) — j'avais chiffré un garde qui répond à une autre menace que celle que
  j'avais prouvée.
- **La généralisation aux 4 providers** — 3 sur 4 n'ont aucune URL dérivée d'un document distant
  (§7.1). C'est aussi là, et là seulement, que **K4 se déclenche** : un blocage de plages casserait
  les mocks GitHub en loopback des tests e2e.
- **SEP-837 et CIMD** — pas de `registration_endpoint`, pas de DCR, aucun listener loopback dans
  `cli/`. **K6 était acquis d'avance** : §5 et §6.5, écrites le 2026-08-14, le disaient déjà.
- **Ajouter `authorization_response_iss_parameter_supported: true` à `buildDiscoveryDoc`** tant que
  la réponse d'autorisation ne porte pas `iss` — ce serait exactement le mensonge que §6.5 redoute,
  et §6.5 a raison sur ce point.

### 7.4 Le volet `iss` — ce qui reste ouvert, et pourquoi ce n'est pas adopté ici

Le challenge de [`B02`](B02-enterprise-managed-auth-idjag.md) a réfuté la clause « `iss` est
redondant » que portaient §6.1 et §6.5 : RFC 9700 classe le binding `state → provider` parmi les
**préconditions** de l'attaque mix-up, pas parmi les défenses. **§6.5 puce 2 est donc barrée.**

Mais l'instruire sur ses mérites, comme l'exigeait l'annotation, donne un résultat nuancé :

- **Côté client** (nous vers GitHub/Google) : le MUST invoqué par le tableau §2 ligne 79 s'adresse
  aux *MCP clients* dans leur relation à un *AS MCP* découvert via RFC 9728 — pas à notre relation
  d'OAuth client ordinaire vers un IdP. **L'écart est réel** (Google annonce le flag, nous ne
  lisons pas `iss`) **mais le qualifier de violation d'un MUST de la spec MCP serait une
  extrapolation.**
- **Côté serveur** (nous comme AS) : le SHOULD *« MCP authorization servers SHOULD include the
  `iss` parameter in authorization responses »* **n'est pas satisfait** — `/auth/login` est
  l'`authorization_endpoint` annoncé et ne renvoie jamais `iss`. C'est l'écart le plus net, et il
  est en amont du champ de metadata que la fiche voulait ajouter.

**Non adopté ici** parce que c'est un changement de comportement de l'endpoint d'autorisation, pas
un durcissement de fetch — un périmètre distinct, à instruire pour lui-même. **Condition de
réveil** : le jour où un client MCP tiers se connecte réellement au coordinateur (ce que
[`B01`](B01-cimd-dcr-deprecated.md) a montré impossible aujourd'hui sans un header statique).

### 7.5 Ce que ce challenge a corrigé chez moi

Trois erreurs, toutes rattrapées par la passe adversariale et re-vérifiées :

1. **Ma preuve pour K4 était fausse.** J'avais écrit que 4 fichiers de test « pointent des IdP sur
   loopback ». Vérifié : deux pointent un mock **GitHub**, un utilise
   `https://idp.example.test/...` jamais résolu, et le quatrième ne contient que le **nom** de la
   variable. **Zéro test ne pointe un IdP OIDC sur du loopback** — K4 ne se déclenche pas sur le
   périmètre adopté, et mon critère d'adoption redevient satisfait.
2. **« Le modèle de menace de la fiche est trop étroit » était une dramatisation.** §4 décrivait
   déjà *« une metadata OIDC compromise […] avec le `client_secret` en POST »*. Mon PoC **confirme**
   la fiche. §6.5 puce 1 n'est pas barrée.
3. **J'ai chiffré un garde qui ne répond pas à la menace que j'avais prouvée** — le point le plus
   important. §6.4 (A) démontre une substitution d'endpoint ; §6.4 (B)/(C) mesurent un garde
   anti-SSRF-vers-le-réseau-interne. Mon critère d'adoption avait agrafé les deux.

Deux aggravants trouvés par la passe et absents de la fiche : `/auth/login` renvoie le **navigateur
de l'utilisateur** vers l'`authorization_endpoint` de l'attaquant (donc phishing du mot de passe
IdP, pas seulement vol du secret), et `getDiscovery` **cache pour la vie du process**
(`oidc.ts:280`) — un seul empoisonnement réussi persiste jusqu'au redémarrage.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : niveaux normatifs tranchés, 2 plages de lignes corrigées (github-shared, doctor), statut Current confirmé. |
| 2026-08-15 | Challenge. PoC de fuite de credential contre un faux IdP, mesure du coût d'un garde, inventaire des 16 sorties réseau, 2 réfutateurs adversariaux. **Verdict : `adopter partiellement`** — contrôle d'origine sur les endpoints du document de découverte (~15 lignes, 0 dépendance, 0 ms), `https:` exigé hors loopback, et l'audit `auth.state.mixup` **déplacé** vers l'endroit où le provider est réellement fourni par le client (`oauth-token.ts:118`, aujourd'hui **sans aucun audit**). Écartés : le `safeFetch` à plages IP + pinning DNS, sa généralisation aux 4 providers, SEP-837/CIMD. **Trois erreurs de ma part, rattrapées par la passe adversariale :** (1) ma preuve pour K4 était fausse — zéro test ne pointe un IdP OIDC sur du loopback ; (2) « le modèle de menace de la fiche est trop étroit » était une dramatisation, §4 décrivait déjà le scénario ; (3) **j'avais chiffré un garde qui ne bloque pas la menace que j'avais prouvée** — l'attaquant est sur une IP publique, ce que ma propre mesure affichait (`8.8.8.8 -> autorise`). Corrections à la fiche : §5 présente à tort le cross-check `issuer` comme une atténuation ; §6.5 puce 2 (« `iss` est redondant ») barrée par `B02` ; §6.1 mal posée — 2 URLs sur 16 dérivent d'un document distant, toutes deux dans `oidc.ts`. **K6 était acquis d'avance.** |
