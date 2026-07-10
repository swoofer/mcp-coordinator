# Audit — Sécurité : authentification & tokens

- **Projet** : mcp-coordinator v0.13.0 (embedded MQTT broker + MCP server for multi-agent coordination)
- **Date de l'audit** : 2026-07-03
- **Score** : **7/10**
- **Verdict global** : sous-système d'authentification globalement solide et manifestement conçu en connaissance des pièges classiques, mais entaché d'une confusion de type de jeton (refresh accepté comme access) qui permet à un refresh-token volé de contourner l'intégralité des contrôles de révocation et de rotation.

---

## 1. Résumé exécutif

Le sous-système d'authentification de mcp-coordinator est nettement au-dessus de la moyenne pour un projet early-stage porté par un mainteneur solo. Les fondamentaux sont en place et bien exécutés : PKCE S256, liaison HMAC-SHA-256 du `state` OAuth à un cookie (avec séparateur de domaine `'state-v1'\x00`), nonce OIDC, vérification stricte des `id_token` IdP (RS256 épinglé + `iss` + `aud` contrôlés contre le JWKS distant), comparaisons à temps constant systématiques, échappement HTML généralisé avec CSP verrouillée, chiffrement enveloppe AES-256-GCM des jetons IdP au repos avec AAD liant org/colonne/utilisateur, rotation des refresh-tokens avec détection de réutilisation par famille, et `token_epoch` comme kill-switch admin.

La faille principale (securite-auth-01, **high**, confirmée par contre-vérification adversariale) est une **confusion de type de jeton** : rien — ni claim `typ`, ni `aud` — ne distingue un access-token d'un refresh-token à la vérification. Un refresh-token volé (durée de vie 30 jours) peut être présenté comme cookie de session (ou comme Bearer en déploiement OAuth-only) et est accepté comme credential d'accès avec le rôle `member` par défaut. Ce chemin ne consulte jamais la table `refresh_tokens` : il contourne donc l'intégralité du dispositif anti-vol de la rotation (revoked_at, fingerprint, idle-timeout, détection de réutilisation, re-check d'allowlist IdP) et survit à `/api/auth/logout` comme à `/api/auth/revoke` — seul `/logout-all` (bump de `token_epoch`) le neutralise.

Les autres constats sont mineurs : nonce OIDC non vérifié côté Google (défense en profondeur manquante), JWT accepté en query-string pour le SSE (surface de fuite via logs/Referer), rôle non re-dérivé depuis la base à la rotation (fail-safe mais régression fonctionnelle pour les admins), et une échappatoire `COORDINATOR_INSECURE_COOKIES` inerte (footgun documentaire plus que faille). Aucun constat n'a été réfuté à la contre-vérification.

---

## 2. Points forts

| # | Point fort | Références |
|---|-----------|------------|
| 1 | Défense CSRF/mix-up/replay des flux OAuth robuste : PKCE S256, cookie de state lié par HMAC-SHA-256 avec séparateur de domaine `'state-v1'\x00`, CAS atomique one-time-use sur `oauth_state`, nonce OIDC vérifié pour le provider générique | `pkce.ts`, `oauth-login.ts:27`, `oauth-callback.ts:30`, `oidc.ts:233` |
| 2 | Vérification des `id_token` IdP dans les règles : RS256 épinglé, `issuer` et `audience` (= client_id) contrôlés contre le JWKS distant, cross-check de l'issuer du document de découverte OIDC | `oidc.ts:204-219,315`, `google.ts:170-188` |
| 3 | Comparaisons à temps constant systématiques, avec pré-vérification de longueur pour éviter le throw de `timingSafeEqual` | `csrf.ts:15-24`, `oauth-callback.ts:43-48`, `serve-http.ts:88-91` |
| 4 | Chiffrement au repos des jetons IdP par enveloppe AES-256-GCM : DEK aléatoire par valeur, wrap par la clé maître, AAD liant `org_id`+colonne+`user_id` (empêche tout swap de ciphertext entre lignes/colonnes) ; empreinte de clé + validation d'entropie Shannon au décodage | `envelope-encryption.ts`, `master-key.ts` |
| 5 | Cookies durcis : préfixe `__Host-` imposé (rejet à la création si absent), `Secure` codé en dur, `HttpOnly` sur la session, `SameSite=Strict` pour session/CSRF et `Lax` justifié pour le state de redirection | `cookies.ts:51-67`, `oauth-finalize.ts:316-343` |
| 6 | Rotation de refresh-tokens complète : détection de réutilisation par famille avec fenêtre de grâce, liaison au fingerprint (ip\|ua), CAS atomique de révocation, seuil de replay, re-check d'allowlist IdP au refresh, `token_epoch` monotone comme kill-switch admin immédiat | `refresh-rotation.ts`, `token-epoch.ts` |
| 7 | Jetons de service plafonnés à 90 jours **en dur** (non configurable) et validés en base par `jti` à chaque requête : la révocation admin l'emporte immédiatement sur la confiance-signature | `service-tokens.ts:19,267-278` |
| 8 | Validation d'entropie des secrets au boot (rejet all-same-byte, dictionnaire, entropie faible) pour `COORDINATOR_JWT_SECRET` et sa version PREV ; garde SSRF sur la pagination `Link` de l'API GitHub | `entropy.ts`, `boot.ts:104-128`, `github-shared.ts:73-91` |
| 9 | Échappement HTML sur toutes les valeurs non fiables des pages d'auth + CSP `script-src 'none'` / `frame-ancestors 'none'` / `X-Frame-Options: DENY` : surface XSS bien fermée | `html.ts:45-55`, `device-confirm.html.ts` |

---

## 3. Constats détaillés

### Sévérité HIGH

#### securite-auth-01 — Confusion de type de jeton : un refresh-token est accepté comme jeton de session/accès (aucun claim `typ`/`aud`)

| | |
|---|---|
| **Sévérité** | 🔴 High |
| **Vérification** | ✅ Confirmé (contre-vérification adversariale) |
| **Localisation** | `src/auth.ts:346` |
| **Effort** | M |

**Preuve** :

```ts
const role: AuthRole = rawRole === "admin" || ... ? rawRole : "member";
// refresh-token (sans role) -> accepté comme member ;
// verifyPhase2SessionCookie ne consulte jamais refresh_tokens.revoked_at
```

**Explication.** Les access-tokens et les refresh-tokens sont signés par la même clé (registry `hs256-v1`), avec le même issuer, et ne portent **aucun** claim distinctif (`typ`, `token_use` ou `aud`) : `mintAccessJWT` (`jwt-mint.ts:37-54`) et `mintRefreshJWT` (`jwt-mint.ts:83-100`) utilisent tous deux le même registre et le même issuer via `mintTokenPair` (`oauth-finalize.ts:239-273`). Le vérificateur de session `verifyPhase2SessionCookie` (`src/auth.ts:254`) n'exige qu'une signature valide, un `kid` sur l'allowlist, l'issuer, un `sub` et un `iat >= token_epoch` ; en l'absence de claim `role` — que les refresh-tokens ne portent jamais (`RefreshTokenClaims`, `jwt-mint.ts:57`) — il applique par défaut le rôle `member` (`src/auth.ts:346-350`).

Un refresh-token placé dans le cookie `__Host-coordinator_session` est donc accepté comme credential d'accès (le chemin cookie l'envoie directement au vérificateur, `src/auth.ts:411-412`) ; en déploiement OAuth-only (`COORDINATOR_AUTH_ENABLED` non défini), il l'est aussi en **Bearer** via le catch `src/auth.ts:452-453`. Or ce chemin d'accès ne consulte jamais la table `refresh_tokens` pour les jetons non-service (le seul lookup DB, `verifyServiceTokenJti`, n'a lieu que si `service_account === true`, `auth.ts:321-342`) : il ignore `revoked_at`, le fingerprint, l'idle-timeout, la détection de réutilisation et le re-check d'allowlist IdP.

**Conséquence** : un refresh-token volé (durée 30 jours) utilisé ainsi contourne l'intégralité du dispositif anti-vol T19 et **survit à `/api/auth/logout`** (révocation de famille) **et à `/api/auth/revoke`** (révocation par `jti`) — seul `/logout-all` (bump de `token_epoch`) le neutralise. Ce vecteur est plus furtif qu'un échange via `/token`, qui déclencherait la détection de réutilisation. Il n'y a pas d'élévation de privilège (le rôle retombe à `member`), mais c'est un contournement de la révocation et des contrôles de rotation qui sont au cœur de la conception : le vol de refresh-token est précisément la menace que T19 prétend couvrir.

**Recommandation.** Distinguer explicitement les deux types de jetons :
1. Ajouter un claim `typ` (`'access'` vs `'refresh'`) au mint (`jwt-mint.ts`) et le vérifier dans `verifyPhase2SessionCookie` / `verifyRefreshJwt` (rejeter tout jeton dont `typ != 'access'` sur le chemin d'accès, et `!= 'refresh'` sur le chemin de rotation).
2. Alternative peu coûteuse à effet immédiat : dans `verifyPhase2SessionCookie`, **rejeter** tout jeton sans claim `role` (les refresh-tokens n'en portent jamais) au lieu de retomber sur `member`.
3. Idéalement, ajouter aussi une `audience` distincte (ex. `coordinator:access` vs `coordinator:refresh`) et l'exiger à la vérification.

---

### Sévérité LOW

#### securite-auth-02 — Le provider Google ne vérifie pas le nonce OIDC de l'id_token

| | |
|---|---|
| **Sévérité** | 🟡 Low |
| **Vérification** | ⚠️ Non contre-vérifié (sévérité medium ou moins) |
| **Localisation** | `src/auth/providers/google.ts:102` |
| **Effort** | S |

**Preuve** :

```ts
buildAuthUrl(state: string, redirectUri: string, codeChallenge?: string): string { ... }
// pas de paramètre/usage du nonce, contrairement à oidc.ts:126-153
```

**Explication.** `oauth-login.ts` génère systématiquement un nonce (`crypto.randomBytes(32)`) et le passe en 4e argument à `buildAuthUrl`, mais `GoogleProvider.buildAuthUrl` a la signature `(state, redirectUri, codeChallenge)` : le nonce est ignoré, absent de l'URL d'autorisation, et `exchangeCode` ne compare pas `id_token.nonce`. Contrairement au provider OIDC générique (`oidc.ts:233`) qui vérifie le nonce, le flux Google repose uniquement sur PKCE + liaison HMAC du state pour la protection anti-rejeu de l'id_token. Risque résiduel faible (code d'autorisation lié au client par PKCE, id_token obtenu via le token endpoint sous TLS avec vérification RS256/iss/aud), mais défense en profondeur manquante et incohérence entre providers.

**Recommandation.** Aligner `GoogleProvider` sur `OIDCProvider` : accepter le paramètre `nonce` dans `buildAuthUrl` (l'ajouter à l'URL Google) et le vérifier contre `id_token.nonce` dans `exchangeCode`, en réutilisant le nonce déjà stocké dans `oauth_state`.

#### securite-auth-03 — Transport du JWT via query-string `?token=` sur les requêtes GET (SSE)

| | |
|---|---|
| **Sévérité** | 🟡 Low |
| **Vérification** | ⚠️ Non contre-vérifié |
| **Localisation** | `src/auth.ts:389` |
| **Effort** | M |

**Preuve** :

```ts
const qToken = parsed.searchParams.get("token");
if (qToken) { effectiveAuthHeader = `Bearer ${qToken}`; }
```

**Explication.** `authenticateRequest` accepte un JWT via le paramètre d'URL `?token=` sur les requêtes GET (`src/auth.ts:389-397`) pour permettre l'authentification EventSource/SSE. Les jetons présents dans les URL fuitent volontiers dans les logs d'accès (serveur et proxies), l'historique du navigateur et l'en-tête `Referer`. Le code atténue déjà bien le risque (GET uniquement — POST/PUT/PATCH exclus contre le smuggling CSRF ; priorité à l'en-tête `Authorization` ; access-tokens courts, 15 min), mais la surface de fuite demeure. À noter la combinaison avec `Access-Control-Allow-Origin: *` sur `/api/events` (`serve-http.ts:238,255`).

**Recommandation.** Privilégier un mécanisme sans jeton en clair dans l'URL : cookie de session HttpOnly (déjà disponible pour les navigateurs), ou jeton SSE éphémère à usage unique échangé contre un ticket. À défaut, documenter explicitement le risque et s'assurer que les logs d'accès n'enregistrent pas les query-strings sur `/api/events`.

#### securite-auth-04 — Le rôle n'est pas re-dérivé depuis la base lors de la rotation de refresh (codé en dur à `member`)

| | |
|---|---|
| **Sévérité** | 🟡 Low |
| **Vérification** | ⚠️ Non contre-vérifié |
| **Localisation** | `src/auth/refresh-rotation.ts:817` |
| **Effort** | S |

**Preuve** :

```ts
const newPair = await mintTokenPair(ctx.db, ctx.clock, {
  user: { user_id: row.user_id, primary_org_id: row.org_id, role: "member" }, ...
});
```

**Explication.** Lors de la rotation (`refresh-rotation.ts:817-819`) et du re-mint en fenêtre de grâce (`refresh-rotation.ts:313-319`), le nouvel access-token est frappé avec `role: 'member'` en dur, malgré le commentaire « T19c re-derives from users table » qui n'est pas honoré (aucune lecture de `users.role`). Conséquence : un utilisateur admin voit son access-token retomber à `member` dès la première rotation (~15 min), le privant des routes admin qui contrôlent `claims.role` (`handle-admin-*.ts`, `ADMIN_ONLY_ROUTES`). C'est fail-safe (dégradation de privilège, donc pas d'élévation exploitable), mais cela crée une divergence entre l'autorité portée par le jeton et l'autorité en base — un signal à corriger, et une régression fonctionnelle pour les sessions admin SDK/CLI.

**Recommandation.** Re-dériver le rôle depuis la table `users` au moment de la rotation (`SELECT role FROM users WHERE id = row.user_id`) et le passer à `mintTokenPair`, plutôt que de coder `member` en dur — en conservant la logique de dégradation si l'utilisateur n'existe plus.

---

### Sévérité INFO

#### securite-auth-05 — L'échappatoire `COORDINATOR_INSECURE_COOKIES` est inerte pour les cookies Phase 2 (footgun latent)

| | |
|---|---|
| **Sévérité** | ⚪ Info |
| **Vérification** | ⚠️ Non contre-vérifié |
| **Localisation** | `src/auth/cookies.ts:89` |
| **Effort** | S |

**Preuve** :

```ts
export function getCookieSecureFlag(): boolean {
  return process.env.COORDINATOR_INSECURE_COOKIES !== "true";
}
// non référencé en production ; hostCookie force secure:true
```

**Explication.** `getCookieSecureFlag()` (`cookies.ts:89`) lit `COORDINATOR_INSECURE_COOKIES` pour permettre des cookies non-Secure derrière un proxy TLS, mais cette fonction n'est utilisée nulle part dans le code de production : tous les cookies Phase 2 passent par `hostCookie()`, qui impose `secure: true` en dur et le préfixe `__Host-` (`cookies.ts:59-66`). Par ailleurs, le boot autorise un `COORDINATOR_PUBLIC_URL` en `http://` non-localhost si `COORDINATOR_INSECURE_COOKIES=true` (`boot.ts:379`) ; or les cookies `__Host-` exigent `Secure` et sont rejetés par les navigateurs en clair — la connexion par cookie échoue silencieusement en http pur. C'est secure-by-default (échec dans le bon sens, et le déploiement attendu est derrière un proxy TLS), mais l'incohérence entre l'échappatoire annoncée et le comportement réel, plus le code mort, méritent d'être clarifiés.

**Recommandation.** Soit supprimer `getCookieSecureFlag()` (code mort), soit documenter sans ambiguïté que `http://` non-localhost n'est supporté que derrière une terminaison TLS et que les cookies restent `Secure`/`__Host-` en toutes circonstances. Ajouter un avertissement de boot explicite si `PUBLIC_URL` est `http://` non-localhost.

---

## 4. Recommandations priorisées

### Quick wins (effort S/M)

| Priorité | Constat | Action | Effort |
|----------|---------|--------|--------|
| **P0** | securite-auth-01 (mitigation immédiate) | Dans `verifyPhase2SessionCookie`, rejeter tout jeton **sans claim `role`** au lieu de retomber sur `member` — ferme le vecteur refresh-comme-access en quelques lignes, en attendant le correctif de fond | S |
| **P0** | securite-auth-01 (correctif de fond) | Ajouter un claim `typ` (`access`/`refresh`) au mint dans `jwt-mint.ts` et l'exiger strictement sur chaque chemin de vérification ; idéalement compléter par une `audience` distincte (`coordinator:access` vs `coordinator:refresh`). Prévoir la transition des jetons déjà émis sans `typ` (fenêtre de tolérance courte ou bump de `token_epoch` pour forcer un re-login) | M |
| **P1** | securite-auth-04 | Re-dériver `users.role` à la rotation dans `refresh-rotation.ts` (honorer le commentaire T19c) — corrige au passage la régression admin SDK/CLI | S |
| **P2** | securite-auth-02 | Propager et vérifier le nonce OIDC dans `GoogleProvider` (alignement sur `oidc.ts`) | S |
| **P3** | securite-auth-05 | Supprimer `getCookieSecureFlag()` (code mort) ou documenter l'échappatoire ; avertissement de boot si `PUBLIC_URL` en http non-localhost | S |

### Chantiers plus structurants

| Priorité | Constat | Action | Effort |
|----------|---------|--------|--------|
| **P2** | securite-auth-03 | Remplacer `?token=` sur `/api/events` par le cookie de session HttpOnly ou un ticket SSE éphémère à usage unique ; à défaut, exclure les query-strings des logs d'accès sur cette route et documenter le risque | M |

Aucun chantier de taille L n'est requis sur cette dimension.

---

## 5. Annexe — Constats écartés après contre-vérification

Aucun constat n'a été réfuté (verdict `REFUTED`) lors de la contre-vérification adversariale. Le seul constat contre-vérifié (securite-auth-01, high) a été **confirmé sur tous les points** : même clé et même issuer pour les deux types de jetons, absence de tout claim distinctif (`typ`/`token_use`/`aud`) sur les jetons internes, fallback `role → member` en l'absence de claim, absence de consultation de `refresh_tokens` sur le chemin session, atteignabilité via cookie et via Bearer en OAuth-only, survie à `/logout` et `/revoke` — sans qu'aucune mitigation existante en amont n'ait été trouvée. Les constats de sévérité medium ou moindre n'ont pas fait l'objet d'une contre-vérification formelle et sont signalés comme tels dans le corps du rapport.
