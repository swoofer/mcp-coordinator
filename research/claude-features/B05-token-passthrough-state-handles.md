# B05 — Token passthrough interdit, binding RFC 8707 et state handle hijacking

| Champ | Valeur |
|---|---|
| **ID** | `token-passthrough-state-handles` |
| **Surface** | mcp-spec |
| **Statut** | GA |
| **Disponible depuis** | `2026-07-28` |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — SDK installé encore en 2025-11-25, sessions présentes |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — `adopter partiellement` : la documentation seule ; le code est reporté |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** ✅ saine

**Corrections apportées :**

- §2 — ajout d'un fait normatif manquant et directement pertinent : la spec `2026-07-28` §Overview point 4 pose que **les serveurs MCP MUST implémenter RFC 9728** (Protected Resource Metadata) et que les clients MUST s'en servir pour la découverte de l'AS. La fiche ne listait `/.well-known/oauth-protected-resource` que comme surface d'API, sans en signaler le caractère obligatoire.
- §4 — `src/quota/quota.ts:62` renumérotée : la lecture du token via le `CredentialReader` est à la **ligne 55** (`reader.readClaudeOAuthToken()`) ; la ligne 62 est le `fetch`, l'en-tête `Authorization: Bearer` étant à la 64. La conclusion (credential propre au serveur, aucun passthrough) est inchangée et confirmée.
- §6.3 — une ligne d'avertissement ajoutée en tête sur ce qui n'est pas exécutable ici (3ᵉ puce du protocole).

Tout le reste a été confronté aux sources et au code, sans écart :

- Statut **GA** confirmé : `/specification/versioning` désigne `2026-07-28` comme *current protocol version* au 2026-08-14.
- §2 vérifié mot à mot contre `/specification/2026-07-28/basic/authorization` : `resource` MUST dans `/authorize` **et** `/token` ; « MCP clients MUST send this parameter regardless of whether authorization servers support it » ; `WWW-Authenticate: Bearer resource_metadata=…, scope=…, error="insufficient_scope", error_description=…` ; 401/403/400 ; URI canonique = « most specific URI you can », exemples valides avec chemin et port, invalides seulement *sans schéma* et *avec fragment*, slash final = SHOULD. Les deux rectifications déjà portées par un vérificateur précédent sont exactes.
- Ancrage normatif de l'audience confirmé : « MUST validate access tokens as described in OAuth 2.1 Section 5.2 … issued specifically for them as the intended audience, according to RFC 8707 Section 2 ». RFC 9068 n'apparaît que dans *Security Best Practices* sous la forme « for example, via the audience claim, as mentioned in RFC9068 » — non normatif, comme l'affirme la fiche.
- §1 (b) confirmé : la section *State Handle Hijacking* existe bien dans *Security Best Practices* `2026-07-28`, avec les MUST (vérifier toute requête entrante, ne pas traiter la possession d'un handle comme une authentification), les SHOULD (handles non déterministes, expiration) et le pattern `<user_id>:<handle>` « where the user ID is derived from the verified token rather than supplied by the client ». La source reste bien une page de guidance sous `/docs/…/tutorials/security/`, pas la spec normative.
- §5 — les 17 fichiers cités existent tous, et chaque numéro de ligne pointe sur ce que la fiche annonce : `src/auth.ts` `verifyPhase2SessionCookie` l. 319, `jwtVerify` l. 324, options `algorithms`/`issuer`/`clockTolerance` l. 338-342 sans `audience` ; `src/auth/jwt-mint.ts` sans `aud` ni `setAudience()` ; `src/discovery.ts` (51 l.) ne sert que RFC 8414 ; `serve-http.ts` l. 695-701 / 751 / 761 / 769 / 823 / 835 / 847 / 1327-1381 ; `response-contract.ts` `bearerAuthHeader(err, description, scope)` sans `resource_metadata` ; `agents-tools.ts:44,85` ; `consultation-tools.ts:111-112,218-219` ; `consultation.ts:137,237,657` ; `agent-registry.ts` tout en `(orgId, agentId)` ; `announce-workflow.ts:101,114` ; `github-shared.ts:95-101` ; `sdk/src/discovery.ts:6` ; `cli/channel.ts:536`.
- Le « 26 outils » du risque n°3 est exact : 26 occurrences de `getSessionClaims(extra.sessionId` dans `src/tools/`.
- Aucun `/.well-known/oauth-protected-resource` ni aucun `audience` dans `src/` ou `sdk/src/` (les seuls `audience` sont dans `src/auth/providers/google.ts:170` et `oidc.ts:196`, pour vérifier l'ID token de l'IdP entrant — pas les tokens émis par le coordinateur).

**Marqueurs `(à vérifier)` restants :** aucun (la fiche n'en contenait aucun).

**Testabilité :** ⚠️ partielle
Trois des cinq puces de §6.3 se lancent telles quelles sur le poste : l'usurpation intra-org (daemon local + deux appels d'outils avec un seul token, puis lecture de `src/security/audit-chain.ts`), le JWT HS256 forgé sans `aud` (script `jose` + `JWT_SECRET` local), et le chiffrage de l'effort `aud` (`pnpm test` après avoir ajouté `setAudience`). En revanche la sortie de session ne peut pas être tranchée ici : le SDK installé est `@modelcontextprotocol/sdk@1.30.0`, dont `LATEST_PROTOCOL_VERSION = "2025-11-25"` (`SUPPORTED_PROTOCOL_VERSIONS` s'arrête à `2024-10-07` en bas, plus une constante expérimentale `DRAFT-2026-v1`) — aucun transport sessionless `2026-07-28` n'est livré, donc `extra.sessionId` existe toujours et le risque n°3 reste prospectif, non reproductible. La 4ᵉ puce (client MCP réel émettant `resource`) demande en plus un flow OAuth complet avec `COORDINATOR_PUBLIC_URL` joignable, hors PoC rapide.

## 1. Ce que c'est

Deux exigences de la révision MCP `2026-07-28`, liées par la même cause : la disparition des sessions protocole (SEP-2567 supprime `Mcp-Session-Id`).

**(a) Interdiction du token passthrough.** Un client MCP MUST envoyer le paramètre `resource` (RFC 8707) dans la requête d'autorisation *et* dans la requête de token, avec l'URI du serveur MCP visé — et ce même si l'AS ne supporte pas le paramètre. Le serveur MCP MUST vérifier que le token lui était destiné, MUST rejeter tout token dont il n'est pas le destinataire, et MUST NOT accepter ni transiter d'autre token. S'il appelle une API amont, il agit comme client OAuth de cette API avec un token distinct et MUST NOT repasser celui reçu du client. Cinq risques sont documentés : contournement des contrôles (rate limiting, validation), rupture de la piste d'audit, franchissement de frontière de confiance, usage du serveur comme proxy d'exfiltration, et *Future Compatibility Risk*.

**(b) State Handle Hijacking.** Sans sessions, un serveur qui a besoin d'état entre appels émet un *handle* explicite (ID de thread, de panier, de workflow) rendu en résultat d'outil et repassé en argument ordinaire. L'attaque : un tiers devine ou récupère le handle et l'utilise pour lire ou modifier l'état d'un autre principal. Les serveurs MUST authentifier toutes les requêtes entrantes et MUST NOT traiter la possession d'un handle comme une authentification ; ils SHOULD utiliser des handles non déterministes issus d'un CSPRNG, et SHOULD lier le handle côté serveur au principal authentifié — le pattern donné est une clé de stockage `<user_id>:<handle>` où `user_id` est dérivé du token vérifié, jamais fourni par le client.

**Portée.** L'autorisation reste OPTIONAL pour une implémentation MCP (SHOULD pour les transports HTTP, SHOULD NOT pour stdio, qui prend ses credentials dans l'environnement). Les MUST du bloc (a) sont inconditionnels *une fois* l'autorisation implémentée sur HTTP — donc bloquants pour `src/serve-http.ts`, pas pour `cli/channel.ts`.

## 2. Surface d'API exacte

```
resource                    # RFC 8707, obligatoire dans /authorize ET /token
                            # envoyé même si l'AS ne le supporte pas
/.well-known/oauth-protected-resource   # Protected Resource Metadata, RFC 9728
WWW-Authenticate: Bearer resource_metadata="...", scope="...",
                  error="insufficient_scope", error_description="..."
HTTP 401  # token absent ou invalide
HTTP 403  # scopes insuffisants
HTTP 400  # requête malformée
```

Précision de vérification : `/.well-known/oauth-protected-resource` n'est pas optionnel. La spec `2026-07-28` (§Overview, point 4) écrit « MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata (RFC 9728). MCP clients **MUST** use OAuth 2.0 Protected Resource Metadata for authorization server discovery. » C'est donc un MUST serveur au même titre que la validation d'audience, pas seulement un confort de découverte.

Ancrage normatif de la validation d'audience : **RFC 8707 §2 + OAuth 2.1 §5.2**. Le claim `aud` / RFC 9068 n'apparaît qu'à titre d'exemple non normatif dans *Security Best Practices* — le citer comme la référence normative est une surinterprétation (rectification d'un vérificateur ; la fiche brute affirmait l'inverse).

URI canonique du `resource` : la spec demande l'URI **la plus spécifique possible**, pas « schéma + host ». Sont explicitement valides `https://mcp.example.com/mcp`, `https://mcp.example.com:8443`, `https://mcp.example.com/server/mcp` — chemin et port autorisés. Les seuls cas d'invalidité explicites sont *avec fragment* et *sans schéma* ; l'absence de slash final est un SHOULD d'interopérabilité, pas un MUST. (Ici aussi, la fiche brute disait « schéma + host, sans fragment, sans slash final » — corrigé.)

Côté state handles, **aucun champ ni méthode protocole**. Le seul artefact concret est le pattern de clé de stockage serveur :

```
<user_id>:<handle>     # user_id dérivé du token vérifié, jamais du client
```

## 3. Sources

- https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations
- https://modelcontextprotocol.io/specification/2026-07-28/changelog

Note : le changelog ne nomme jamais « State Handle Hijacking » ; il ne corrobore qu'indirectement, via SEP-2567 (« *Servers that need cross-call state use explicit, server-minted handles passed as ordinary tool arguments* »). La source primaire est la page *Security Best Practices*, qui est un document de guidance sous `/docs/.../tutorials/security/` — pas la spec normative elle-même, même si elle emploie le vocabulaire RFC 2119.

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

Sur le volet passthrough, l'état des lieux est meilleur que redouté et vaut d'être écrit noir sur blanc dans un rapport de sécurité : les deux seuls appels sortants authentifiés du coordinateur utilisent un credential **propre au serveur**, pas un token reçu d'un client MCP — `src/quota/quota.ts:55` lit le token Anthropic local via Keychain (`reader.readClaudeOAuthToken()`, `src/quota/credential-reader.ts`) avant de l'envoyer en `Bearer` l. 64, et `src/auth/providers/github-shared.ts:97` porte le token IdP obtenu par le coordinateur lors de son propre flow OAuth. Aucun chemin de passthrough à supprimer. Le gap est ailleurs : `src/auth.ts:338-342` vérifie `issuer` mais **jamais `audience`**, `src/auth/jwt-mint.ts` ne pose aucun claim `aud`, `src/discovery.ts` expose `/.well-known/oauth-authorization-server` (RFC 8414) mais il n'existe **aucun** `/.well-known/oauth-protected-resource` (RFC 9728), et `sdk/src/discovery.ts:6` ne connaît que le chemin AS. Combler ces trois points est mécanique et déverrouille la case « conforme 2026-07-28 » pour une soumission au répertoire Anthropic.

Sur le volet state handles, le bénéfice est un durcissement ciblé. Les handles sont déjà des `randomUUID()` (`src/consultation.ts:137` et `:237`) — le SHOULD CSPRNG est satisfait. Mais le liage est **org-level, pas principal-level** : `claims.user_id` existe dans `AuthClaims` (`src/auth.ts:41`) et n'est utilisé nulle part dans `src/tools/`. Chaque outil fait `getSessionClaims(extra.sessionId)` puis passe `claims.org` en premier argument, tandis que `agent_id` arrive **du client** en argument libre (`src/tools/agents-tools.ts:44,85` ; `src/tools/consultation-tools.ts:112,218-219`). Conséquence : dans une même org, n'importe quel agent authentifié peut envoyer un heartbeat au nom d'un autre `agent_id`, poster dans un thread sous une autre identité, approuver ou contester une résolution à sa place. C'est exactement la définition officielle du state handle hijacking, à ceci près que le périmètre est l'org et non l'internet.

**Risque si on ne fait rien :**

Trois risques distincts, de gravité croissante.

1. **Absence de validation d'audience.** Un JWT HS256 émis par une *autre* instance mcp-coordinator partageant le même `JWT_SECRET` et le même `COORDINATOR_PUBLIC_URL` est accepté sans distinction. C'est un MUST de la spec non tenu sur le chemin HTTP, signalable en revue.
2. **Usurpation intra-org.** Un agent compromis, ou simplement bogué, peut clore un thread ou poster une résolution au nom d'un autre agent. La piste d'audit (`src/security/audit-chain.ts`) enregistre alors une identité fausse — le rapport d'audit v0.13.0 parle déjà de « garde-fou fantôme », et c'en est un cas d'école.
3. **Dépendance à un mécanisme supprimé par la spec.** `src/serve-http.ts:751,769,835,1327` fait reposer *toute* la résolution d'identité sur la `Map<sessionId, AuthClaims>` indexée par `mcp-session-id`. Or `2026-07-28` supprime les sessions protocole. Le jour où le SDK MCP suit la spec, `extra.sessionId` disparaît et **les 26 outils lèvent `Session has no captured claims (auth bug)`** — panne totale, pas dégradation. Le liage `<user_id>:<handle>` n'est pas seulement une bonne pratique de sécurité : c'est le remplaçant fonctionnel de la session.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/auth.ts` (l. 319-343, `verifyPhase2SessionCookie`) | `jwtVerify` passe `algorithms` + `issuer` + `clockTolerance`. Ajouter `audience`. Point d'entrée unique de la validation Bearer/cookie. |
| `src/auth/jwt-mint.ts` | `AccessTokenClaims` n'a pas de champ `aud` et `mintAccessJWT` n'appelle jamais `setAudience()`. Prérequis à toute vérification d'audience. |
| `src/discovery.ts` | Ne sert que `buildDiscoveryDoc` (RFC 8414). Ajouter un `buildProtectedResourceDoc` + handler `/.well-known/oauth-protected-resource` (RFC 9728). |
| `src/serve-http.ts` (l. 695-701, 740-847, 1327-1381) | Route les `.well-known`, dispatche `/mcp`, et détient `sessionClaims: Map<string, AuthClaims>` indexée par `mcp-session-id`. Cœur du chantier « sortie de session ». |
| `src/http/response-contract.ts` | `bearerAuthHeader` construit le `WWW-Authenticate` RFC 6750. À étendre avec `resource_metadata=` et `scope=`. |
| `src/tools/agents-tools.ts` | `register_agent` / `heartbeat` acceptent `agent_id` du client et n'utilisent que `claims.org`. Site principal du liage principal↔handle. |
| `src/tools/consultation-tools.ts` | `post_to_thread`, `propose_resolution`, `approve_resolution`, `contest_resolution`, `close_thread`, `cancel_thread` : tous prennent `thread_id` + `agent_id` en arguments libres. Surface d'usurpation la plus large. |
| `src/consultation.ts` (l. 137, 237, 657) | `randomUUID()` pour thread et message — SHOULD CSPRNG déjà tenu. `getThreadCrossOrg` (privé, l. 657) est le seul contournement du scope org ; usage interne uniquement (`emitResolution`, `checkTimeouts`), à documenter dans l'audit plutôt qu'à corriger. |
| `src/agent-registry.ts` | `register/get/heartbeat/setOnline/setOffline` sont tous `(orgId, agentId)`. C'est ici que se poserait un contrôle `user_id` ↔ `agent_id`. |
| `src/announce-workflow.ts` | `UPDATE ... WHERE id = ? AND org_id = ?` : scope org appliqué, scope principal absent. |
| `src/quota/quota.ts` (l. 62-67) + `src/quota/credential-reader.ts` | Credential propre au serveur (Keychain macOS), pas un token client. **Conforme** — à citer comme preuve dans le rapport. |
| `src/auth/providers/github-shared.ts` (l. 95-101, `apiHeaders`) | Token IdP obtenu par le coordinateur comme client OAuth de GitHub. **Conforme** — pas de passthrough. |
| `sdk/src/discovery.ts` (l. 6) | `DISCOVERY_PATH = "/.well-known/oauth-authorization-server"`. Côté client, c'est ici qu'il faudrait émettre `resource` sur `/authorize` et `/token`. |
| `cli/channel.ts` (l. 536, `StdioServerTransport`) | Transport stdio : la spec dit SHOULD NOT pour l'autorisation. **Hors périmètre** des MUST du bloc (a). |
| `src/security/audit-chain.ts`, `src/security/audit-events.ts` | Les événements portent l'identité déclarée par le client. Un liage principal↔`agent_id` change la fiabilité de la chaîne d'audit. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Faut-il faire du couple `(user_id du token vérifié, agent_id)` la clé d'identité de tous les outils — c'est-à-dire remplacer la `Map<mcp-session-id, AuthClaims>` de `serve-http.ts` par un liage persisté `<user_id>:<agent_id>` posé à `register_agent` et revérifié à chaque appel — ou bien conserver le scope org actuel et se contenter d'ajouter la validation `aud` + le endpoint RFC 9728, en assumant que l'usurpation intra-org est un risque accepté ?

### 6.2 Hypothèse

> Pré-enregistrée le 2026-08-15, **avant** tout PoC. Seul fait déjà collecté : `main` a migré vers
> le **SDK v2** depuis la rédaction de la §0, et `LATEST_PROTOCOL_VERSION` y vaut toujours
> **`2025-11-25`** — donc la prémisse de la §0 (pas de transport sessionless, `extra.sessionId`
> existe) **survit à la migration**. Le risque n°3 reste prospectif.

**Hypothèse.** Les trois risques de §4 n'ont ni la même réalité ni la même urgence :

1. **L'usurpation intra-org (risque 2) est probablement réelle et reproductible.** Chaque outil
   prend `agent_id` **du client** en argument libre et ne scope que sur `claims.org`. Je m'attends
   à ce qu'un seul token permette d'agir sous n'importe quelle identité d'agent de l'org — et à ce
   que la chaîne d'audit enregistre l'identité **usurpée**.
2. **L'absence de validation `aud` (risque 1) est réelle mais peu exploitable** : elle suppose une
   seconde instance partageant `JWT_SECRET` **et** `COORDINATOR_PUBLIC_URL`. C'est un MUST non
   tenu, pas une porte ouverte.
3. **La sortie de session (risque 3) est prospective** et le reste sous SDK v2.

**Verdict attendu :** `adopter partiellement` — le liage principal↔`agent_id`, ou au minimum sa
traçabilité ; `reporter` la sortie de session ; le volet `resource`/RFC 9728 dépend de ce que
`B03`/`B04` ont déjà tranché.

**Critères de refus, chiffrés (pré-enregistrés) :**

| # | Le résultat qui tue |
|---|---|
| **K1** | L'usurpation intra-org **échoue** — un garde existant que je n'ai pas vu lie déjà l'appelant à `agent_id`. Le risque 2 s'évapore. |
| **K2** | L'usurpation réussit **mais la chaîne d'audit enregistre l'identité réelle** (le porteur du token), pas l'usurpée → le risque est de confort, pas d'intégrité. |
| **K3** | Le liage `<user_id>:<agent_id>` casse un usage légitime **mesurable dans le dépôt** (tests, essaim, exemples) → §6.5 a raison, le remède est pire que le mal. |
| **K4** | Le JWT forgé sans `aud` est **rejeté** → le risque 1 n'existe pas. |
| **K5** | Ajouter `aud` casse **> 10 tests** ou impose une fenêtre de grâce dans `refresh-rotation.ts` → disproportionné. |
| **K6** | Zéro demande utilisateur **et** le profil mono-utilisateur rend l'usurpation sans objet (un seul `user_id` dans l'org). |

**Critère d'adoption :** une usurpation **reproduite ici**, avec une trace d'audit **fausse**, et
un remède dont le coût tient sous K3/K5.

**Ce que je m'engage à trancher :** si l'usurpation marche, dire si le liage est **applicable**
(y a-t-il plusieurs `user_id` par org dans un déploiement réel ?) ou si la seule action honnête
est de **documenter la limite** et de corriger la chaîne d'audit.

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ La 3ᵉ puce n'est pas exécutable ici : le SDK installé (`@modelcontextprotocol/sdk@1.30.0`) a `LATEST_PROTOCOL_VERSION = "2025-11-25"` et ne livre aucun transport sessionless `2026-07-28` ; `extra.sessionId` existe toujours, donc le risque n°3 ne peut qu'être constaté comme prospectif. La 4ᵉ puce demande un flow OAuth complet avec `COORDINATOR_PUBLIC_URL` joignable, hors PoC rapide.

- [ ] Reproduire l'usurpation intra-org : avec un seul token valide, appeler `register_agent` en `agent_id=alpha`, puis `post_to_thread` et `approve_resolution` en `agent_id=beta` sur un thread ouvert par beta. Vérifier si ça passe et ce que la chaîne d'audit enregistre comme identité.
- [ ] Forger un JWT HS256 avec le même `JWT_SECRET` et le même `iss` mais destiné à un autre service, le présenter en Bearer sur `/mcp`, et confirmer que `src/auth.ts:324` l'accepte (démonstration de l'absence de contrôle d'audience).
- [ ] Mesurer le coût de la sortie de session : instrumenter `src/serve-http.ts:769` pour compter les requêtes `/mcp` sans `mcp-session-id`, puis vérifier ce que `extra.sessionId` vaut dans un outil quand le client n'envoie pas l'en-tête. Confirme ou infirme le risque n°3 sur le SDK MCP réellement installé (`package.json`).
- [ ] Vérifier le comportement d'un client MCP réel (Claude Code) face à un `/.well-known/oauth-protected-resource` servi en dur : émet-il bien `resource` sur `/authorize` et `/token` ? Sinon, l'ajout côté `sdk/src/discovery.ts` est un chantier isolé sans bénéfice immédiat.
- [ ] Chiffrer l'effort d'ajout de `aud` : combien de tests de `src/auth.ts` / `src/auth/refresh-rotation.ts` cassent si `mintAccessJWT` pose un `aud` et si `jwtVerify` l'exige ? Un token émis avant la migration doit-il rester accepté pendant une fenêtre de grâce ?

### 6.4 Résultat observé

> Exécuté le 2026-08-15 contre le daemon réel (`AUTH_ENABLED=true` + `OAUTH_ENABLED=true`),
> **sur SDK v2** (`main` a intégré `A02`). Frontière exécuté / lu marquée en (D).

#### (A) K1 et K2 — L'usurpation intra-org est complète, et la trace est fausse

**Un seul token**, présenté sur une seule session MCP. Il enregistre **deux agents distincts** :

```
1. UN SEUL token enregistre DEUX agents distincts
   alpha : {"id":"alpha","org_id":"default","name":"Alpha","status":"online", …}
   beta  : {"id":"beta","org_id":"default","name":"Beta","status":"online", …}
```

Puis il ouvre un thread **au nom de beta**, et y poste sous **deux identités différentes** :

```
thread ouvert par beta : ff1bcf8e-… | initiator: beta

>>> Le MEME token poste SOUS L IDENTITE DE BETA :
    {"agent_id":"beta","type":"context","content":"message signe beta", …}

>>> ... puis sous l identite d ALPHA, dans le thread de beta :
    {"agent_id":"alpha","type":"warning","content":"message signe alpha", …}

>>> Ce que le thread a enregistre :
    agent_id = "beta"  | message signe beta
    agent_id = "alpha" | message signe alpha
```

**K1 ne se déclenche pas** : aucun garde ne lie l'appelant à l'`agent_id`. La trace persistée
enregistre l'identité **usurpée**, pas le porteur du token.

> ⚠️ **Deux corrections de ma part, imposées par la passe adversariale et re-vérifiées.**
>
> **(1) L'étiquette `from_agent` était la mienne, pas celle du dépôt.** `grep -rn "from_agent"`
> sur `src/`, `sdk/src/`, `cli/` → **0 occurrence** ; mon script affichait
> `m.from_agent || m.agent_id` et c'est le repli qui parlait. La vraie colonne est
> **`thread_messages.agent_id`** (`src/database.ts:128`). Sorties ci-dessus corrigées.
>
> **(2) « La chaîne d'audit enregistre une identité fausse » est FAUX, et c'est plus grave.**
> `grep -rn "audit" src/tools/` → **0 résultat**. `src/agent-registry.ts` et
> `src/announce-workflow.ts` non plus. **Aucun outil n'écrit jamais dans la chaîne d'audit**, et
> `src/security/audit-events.ts` ne contient aucun événement `thread.*`, `agent.*` ou `tool.*` —
> uniquement `auth.*`, `admin.*`, `config.*`, `recovery.*`, `system.*`, `migration.*`. Quand la
> chaîne enregistre quelque chose, l'acteur vient de `getCurrentActor()`
> (`src/security/audit.ts:101`), alimenté par le **token vérifié**, jamais par le client.
>
> **La chaîne d'audit n'enregistre donc rien de ces appels — ni l'identité réelle, ni la fausse.**
> Ce qui porte l'identité usurpée est une **donnée métier** (`thread_messages.agent_id`), pas la
> piste d'audit chaînée. **K2 n'est ni déclenché ni non-déclenché : sa prémisse est vide.**
>
> **Conséquences sur la fiche, à corriger :** §4 risque 2 (« La piste d'audit
> (`src/security/audit-chain.ts`) enregistre alors une identité fausse ») et §5 dernière ligne
> (« Les événements portent l'identité déclarée par le client ») sont **toutes deux fausses**.
> J'en avais hérité sans les vérifier, alors que le protocole dit que les sections 1 à 5 sont des
> affirmations à vérifier. Le défaut reste réel — fausse attribution dans les données de
> coordination — mais ce **n'est pas** une compromission de la piste d'audit de sécurité, et
> l'analogie « garde-fou fantôme » est mal placée.

Détail qui aggrave : `initiator_id` du thread est lui aussi entièrement fourni par le client.

**Le serveur le dit désormais lui-même.** Le champ `instructions` livré par `C06` (#271, arrivé
dans `main` pendant cette session) écrit : *« registering an id another agent already holds
**takes it over silently** »*. La prise de contrôle silencieuse est donc **documentée au client**
sans être empêchée côté serveur.

#### (B) K4 — Aucun contrôle d'audience

Token forgé avec le **même** `JWT_SECRET` et le **même** `iss`, mais explicitement destiné à un
autre service :

```
aud = https://un-autre-service.example/mcp  ->  HTTP 200  ACCEPTE (aucun controle d audience)
```

**K4 ne se déclenche pas.** `src/auth.ts` passe `algorithms` + `issuer` + `clockTolerance` à
`jwtVerify`, jamais `audience`, et `mintAccessJWT` ne pose aucun `aud`. Le MUST de la spec
(RFC 8707 §2 + OAuth 2.1 §5.2) n'est pas tenu.

**Portée réelle, à ne pas exagérer :** l'attaquant doit déjà posséder `JWT_SECRET`. Un token
« destiné ailleurs » n'existe que si une **seconde instance** partage ce secret. C'est un MUST non
tenu et un défaut de défense en profondeur, **pas** une porte ouverte depuis l'extérieur.

#### (B bis) §6.5 puce 1 est falsifiée — le multi-utilisateur intra-org est vendu publiquement

§6.5 argumente que le liage est sans objet parce qu'il n'y aurait « **qu'un seul `user_id` par
org**, ce qui n'est le cas d'aucun auto-hébergeur connu ». **Faux, et c'est le profil que le
projet met en avant :**

```
README.md:25
| **A small team where everyone runs their own AI agent on the same repo** |
  One shared coordinator over LAN. Real-time conflict detection across teammates' agents. |
```

Et le code porte un garde qui **n'a de sens qu'en multi-utilisateur** : `LAST_ADMIN`
(`src/admin/handle-admin-users.ts`) refuse de retirer le dernier admin. S'ajoutent la table
`user_orgs`, l'allowlist par org IdP qui mappe tous les membres d'une org GitHub vers le même
`org_id`, et `docs/onboarding-self-host.md` (« *Subsequent users land as `member`* »).

**Conséquence : K6 se déclenche sur sa première moitié (zéro demande) et est falsifié sur la
seconde.** Et l'usurpation compte **plus** que §6.5 ne le prétend : dans le profil équipe vendu au
README, chaque coéquipier a son propre `user_id`, et n'importe lequel peut poster sous l'`agent_id`
d'un autre.

*Réserve d'équité :* la **seconde** puce de §6.5 (un humain pilotant dix agents depuis un seul
token) reste debout et **non testée** — K3 n'est pas mesuré. Le multi-utilisateur rend le liage
*pertinent*, pas *gratuit*.

#### (C) K6 — La demande utilisateur

```
usurpation -> 0     impersonat -> 0     audience -> 1
agent_id -> 6       multi-user -> 3     tenant -> 9
```

Aucune demande ne porte sur l'usurpation. Les `tenant` / `multi-user` relèvent du multi-org, pas de
l'identité d'agent. **K6 se déclenche sur sa première moitié.**

#### (C bis) K3 et K5, mesurés par la passe adversariale — les deux se déclenchent

**K5 — ajouter `aud` casse 66 tests, six fois le seuil.** Branche jetable,
`.setAudience(opts.issuer)` + `audience:` dans `jwtVerify`, suite complète :

```
BASELINE   18 failed | 3092 passed | 6 skipped   (3116)
WITH AUD   66 failed | 3050 passed               (3116)
```

Les 18 d'origine étaient des flakes de port-binding et repassent au vert ; les deux ensembles sont
quasi disjoints. Attribuables à `aud` : **66 tests sur 6 fichiers** (`device-approve` 20, `logout`
19, `auth-scenario5` 11, `userinfo` 10, `d1-d10-matrix` 4, `token-type-confusion` 2). Seuil
pré-enregistré : 10. **K5 se déclenche largement.**

Nature : surtout des fixtures qui forgent leurs JWT à la main sans `setAudience` — réparable.
**Mais le vrai danger n'est pas là où §6.5 le plaçait.** Ce n'est pas `refresh-rotation.ts` (il ne
vérifie que des refresh tokens, sans `audience`, et le re-mint déterministe survit) : ce sont les
**service tokens**. `verifyPhase2SessionCookie` est aussi le fallback Bearer, donc activer `aud`
**401 tous les service tokens en circulation** jusqu'à re-mint manuel — des credentials CI de
longue durée. Le blast radius n'est pas la fenêtre de 15 min des sessions navigateur.

**K3 — le remède ne bloque pas l'attaque que j'ai démontrée.** C'est la mesure la plus utile de
cette passe, et elle est pire que le critère que j'avais pré-enregistré. Mon PoC n'a **qu'un seul
`user_id`** (`u-solo`) qui enregistre légitimement `alpha` **et** `beta`. Sous un liage
`<user_id>:<agent_id>`, `u-solo` **possède les deux** — poster sous l'un puis sous l'autre
**passerait toujours**. Le liage ne mord qu'avec 2+ `user_id` distincts dans l'org.

Et il n'a aucune table sur laquelle s'appuyer : la table `agents` est
`id, name, modules, status, registered_at, last_seen_at` (+ `org_id`) — **aucune colonne
propriétaire** ; `user_orgs` lie users↔orgs, jamais users↔agents. Surface : **16 outils** prennent
`agent_id` en argument, 26 sites `getSessionClaims`, 34 fichiers de test utilisant 2+ `agent_id`.
Plus un contre-exemple **déjà livré** : `cli/channel.ts` utilise `CHANNEL_REPLY_AGENT_ID = "channel"`,
un `agent_id` synthétique qui n'est **pas** un agent enregistré.

**Le scénario reste confirmé sous `role: "member"`**, pas seulement `admin` — donc ma réserve
sur le rôle tombe : `grep claims.role src/tools/` → **0**, et `ADMIN_ONLY_ROUTES` ne couvre pas
`/mcp`.

#### (C ter) Deux réfutations qui vont plus loin que ce que j'avais écrit

**(1) L'audit est encore plus absent que je ne l'ai dit.** `withAuditContext` n'est appelé
**nulle part** dans `src/` (uniquement dans `tests/`), alors que `handle-admin-users.ts:27`
invoque « the outer withAuditContext established by the route dispatcher ». Sonde runtime, appel
`audit()` à l'identique de la production :

```json
{ "action": "auth.login.success", "actor_user_id": null, "actor_org_id": null }
```

Et après tout le scénario d'usurpation : `audit_log` → **0 ligne**. La chaîne n'enregistre donc
pas seulement *rien* pour les outils — quand elle enregistre, l'acteur est **NULL**. C'est un
garde-fou fantôme de plus, et il appartient à un périmètre distinct.

**(2) Mon volet `aud` est encore plus faible que je ne l'ai concédé.** `mintAccessJWT` reçoit
`issuer: COORDINATOR_PUBLIC_URL`, et c'est **la même valeur** qui servirait d'`aud`. Donc
`aud === iss`, et `iss` est **déjà validé**. Mon scénario « une seconde instance partageant le
secret **et** l'URL » s'auto-annule : même URL ⇒ même `aud` ⇒ `aud` ne discrimine rien ; URL
différente ⇒ `iss` rejette déjà. Le mode multi-instance livré (`COORDINATOR_REDIS_URL`) réplique le
**même** service derrière la **même** URL. **Delta défensif nul dans cette architecture** — §6.5
puce 6 le disait, et j'ai été trop indulgent en parlant de « défense en profondeur ».

**(3) M4 est réfuté : la sortie de session n'est PAS prospective.** Le mode sessionless est une
**option de constructeur**, orthogonale à `LATEST_PROTOCOL_VERSION`. Preuve runtime sur le
`@modelcontextprotocol/node@2.0.0` **installé** :

```
tool ctx sous sessionIdGenerator: undefined ->
[{ "sessionIdType": "undefined", "hasHttp": true, "httpKeys": ["req","closeSSE",…] }]
```

`ctx.sessionId` vaut **`undefined`**, donc `getSessionClaims(ctx.sessionId ?? "")` → `null` → **les
26 outils lèvent**. Reproductible **aujourd'hui**, en changeant un mot. Trois aggravations :
`BaseContext.sessionId` est typé **optionnel** ; `createMcpHandler` du SDK v2 sert le trafic 2025
en `'stateless'` **par défaut** ; et le remplaçant est **déjà livré** — `BaseContext.http.authInfo`.
Le contre-argument §6.5 (« migrer maintenant, c'est écrire deux fois le même code ») **s'inverse** :
c'est *reporter* qui fait écrire le code deux fois. Enfin, c'est déjà cassé en pratique :
`sessionClaims` est une `Map` in-process alors que le multi-instance Redis a shippé — une session
ouverte sur l'instance A est un 404 sur l'instance B.

#### (D) Ce qui n'a PAS été exécuté

- **Le risque n°3 (sortie de session) reste prospectif**, et la migration SDK v2 **ne l'a pas
  changé** : vérifié, `LATEST_PROTOCOL_VERSION = "2025-11-25"` dans
  `@modelcontextprotocol/core@2.0.0`. `extra.sessionId` existe toujours. La §0 reste exacte malgré
  le changement de SDK.
- **La 4ᵉ puce** (client MCP réel émettant `resource` face à une PRM servie) : non exécutée.
- **K3 et K5 non mesurés** : je n'ai ni implémenté le liage `<user_id>:<agent_id>` ni ajouté `aud`,
  donc je ne peux pas dire combien de tests cassent ni quel usage légitime serait bloqué. **Ces
  deux critères restent ouverts et ne portent pas le verdict.**

### 6.5 Contre-arguments

- **Le modèle de menace ne correspond pas.** Le profil de déploiement dominant est une équipe d'agents pilotée par un seul humain sur une seule machine. « Un agent usurpe un autre `agent_id` » suppose un agent hostile *déjà authentifié dans l'org* — c'est-à-dire un attaquant qui possède déjà le token. Le liage `<user_id>:<agent_id>` ne le bloque que s'il y a plusieurs `user_id` distincts dans l'org, ce qui n'est le cas d'aucun auto-hébergeur connu aujourd'hui. YAGNI applicable au volet (b), pas au volet (a).
- **Le liage casse un usage légitime.** Un agent lead qui clôture un thread pour le compte d'un worker mort, un script de reprise après crash, ou simplement un même utilisateur pilotant dix agents Claude Code depuis le même token : tous ces cas passent aujourd'hui et échoueraient sous `<user_id>:<agent_id>` strict. Il faudrait une notion de délégation, donc du code neuf, donc une nouvelle surface de bug.
- **La source du volet (b) n'est pas normative.** *Security Best Practices* vit sous `/docs/.../tutorials/security/` — c'est de la guidance, pas la spec. Les MUST y sont rédigés en RFC 2119 mais n'engagent pas la conformité protocole. Refactorer 26 outils sur cette base est disproportionné tant qu'aucun client MCP réel ne rejette le serveur.
- **La sortie de session est un chantier XL déguisé en M.** `sessionClaims` n'est pas une ligne à changer : c'est le point de vérité d'identité de tout le serveur, avec éviction sur `onclose` (`serve-http.ts:823`), CORS `Access-Control-Expose-Headers: mcp-session-id` (`:761`), et le message d'erreur « Session not found » (`:847`). Tant que le SDK MCP installé expose encore `extra.sessionId`, migrer maintenant, c'est écrire deux fois le même code.
- **`aud` ajouté trop tôt casse les tokens en vol.** Poser un `aud` obligatoire invalide tous les access tokens et refresh tokens déjà émis. `src/auth/refresh-rotation.ts` fait 36 Ko et gère déjà une fenêtre de grâce de 10 s pour la rotation ; y greffer une fenêtre de grâce d'audience est exactement le genre de complexité qui produit des trous de sécurité.
- **`resource` côté SDK ne sert à rien seul.** mcp-coordinator est son propre AS *et* sa propre ressource (`src/discovery.ts` : `issuer` = `token_endpoint` = même base URL). Le paramètre `resource` protège contre un AS tiers qui émettrait un token réutilisable ailleurs — scénario inexistant dans l'architecture actuelle. Le bénéfice est déclaratif (cocher une case de conformité), pas défensif.
- **Le coût pour l'auto-hébergeur.** Un `/.well-known/oauth-protected-resource` de plus, un `aud` à configurer, un `COORDINATOR_PUBLIC_URL` qui doit désormais matcher exactement l'URI canonique du `resource` : autant de façons supplémentaires de casser une installation derrière un reverse-proxy mal configuré. Le `doctor.ts` devrait absorber ces nouveaux modes d'échec.

---

### 6.4 bis — Bilan des six critères

| # | Statut | Ce qui l'établit |
|---|---|---|
| **K1** | ❌ non déclenché · ⚠️ **acquis d'avance** | L'usurpation réussit (A). Mais §4 l. 95 l'affirmait déjà le 2026-08-14. **Confirmation, pas découverte.** |
| **K2** | ⚫ **prémisse vide** | La chaîne d'audit n'enregistre **rien** de ces appels. Le critère opposait deux issues dont aucune n'existe. |
| **K3** | ✅ **déclenché** (mesuré par la passe) | Le liage **ne bloquerait pas l'attaque démontrée** : un seul `user_id` possède les deux agents. Et aucune table ne relie users↔agents. |
| **K4** | ❌ non déclenché · ⚠️ **acquis d'avance** | Token `aud` étranger accepté (B). Mais §4 l. 101, §5 et la §0 du 2026-08-14 le disaient déjà. |
| **K5** | ✅ **déclenché** (mesuré par la passe) | **66 tests** cassent, six fois le seuil de 10. Et `aud === iss` : delta défensif nul. |
| **K6** | ◑ **moitié déclenchée, moitié falsifiée** | Zéro demande, oui. Mais « un seul `user_id` par org » est **faux** (B bis). |

**Aucun critère n'a produit d'information neuve décisive.** K1 et K4 confirment par exécution ce
que la fiche affirmait déjà par lecture — ce qui a de la valeur, mais n'est pas une découverte.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** (documentation seule) · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | **L'usurpation intra-org est reproduite de bout en bout** — un seul token enregistre deux agents, ouvre un thread au nom de l'un et poste sous les deux identités, la trace persistant l'identité usurpée. **Et elle compte plus que §6.5 ne le prétend** : le profil « équipe, chacun son agent » est vendu au `README.md:25`, avec un multi-utilisateur intra-org implémenté, testé et gardé (`LAST_ADMIN`). **Mais l'item que j'allais adopter n'a pas d'objet** : « corriger la chaîne d'audit » repose sur une affirmation de §4/§5 que j'avais héritée sans la vérifier et qui est **fausse** — aucun outil n'écrit dans la chaîne d'audit. Ce qu'il faudrait est du code **neuf**, dont le coût tombe dans mon angle mort (K3 et K5 non mesurés). **Seul le volet documentaire a un coût nul par construction et est donc adopté** ; tout ce qui est du code est reporté avec conditions de réveil. |
| **Issue / PR** | Aucune créée. Périmètres en §7.2 et §7.3, **à confirmer avec le mainteneur**. |
| **Jalon visé** | prochaine mineure pour la doc |

### 7.1 La réponse à la question de §6.1

**§6.1 pose un OU entre deux termes. Je réponds aux deux, et je refuse le troisième que j'allais
substituer.**

*Terme 1 — « faire du couple `(user_id, agent_id)` la clé d'identité de tous les outils ».*
**Pertinent — §6.5 avait tort de le déclarer sans objet** (B bis) — mais **le remède ne bloque pas
l'attaque que j'ai démontrée**, et c'est mesuré (C bis) : mon PoC n'a qu'**un seul `user_id`** qui
possède légitimement `alpha` et `beta`, donc le liage le laisserait passer. Il ne mord qu'avec 2+
utilisateurs distincts, et il n'a **aucune table** sur laquelle s'appuyer — `agents` n'a pas de
colonne propriétaire. **Reporté**, et pour un bien meilleur motif que « trop cher ».

*Terme 2 — « conserver le scope org et se contenter d'ajouter `aud` + RFC 9728 ».* Deux faits
mesurés le tuent. D'abord **`aud` ne corrige pas l'usurpation** : l'attaquant du scénario (A)
présente un token parfaitement valide. Ensuite **`aud` ne corrige rien du tout ici** :
`mintAccessJWT` reçoit `issuer: COORDINATOR_PUBLIC_URL`, et c'est la même valeur qui servirait
d'`aud` — donc `aud === iss`, et `iss` est **déjà validé**. Pour **66 tests cassés** (K5 mesuré,
six fois le seuil) et un risque de 401 sur tous les service tokens en circulation. **Reporté**,
avec un delta défensif qualifié de **nul dans cette architecture**.

*Le troisième terme que j'allais substituer — « corriger la chaîne d'audit » — est retiré :* il
n'a pas d'objet (§6.4 A, correction 2).

**Ce qui reste, et qui est le seul terme dont le coût est trivialement nul : dire la limite là où
la promesse est faite.**

### 7.2 Ce qui est adopté : documenter la limite là où le profil équipe est vendu

Le champ `instructions` du serveur (livré par [`C06`](C06-tool-search-defer-loading.md), #271,
arrivé dans `main` pendant cette session) dit déjà au **client** : *« registering an id another
agent already holds **takes it over silently** »*. Mais la **documentation de déploiement**, qui
vend le profil équipe, n'en dit rien.

- [ ] `README.md:25` (« A small team where everyone runs their own AI agent ») et
      `docs/onboarding-self-host.md` : écrire que l'`agent_id` est **déclaratif**, que le scope
      d'isolation est l'**org** et non l'utilisateur, et qu'un coéquipier authentifié peut agir
      sous l'`agent_id` d'un autre.
- [ ] `docs/ops/access-review.md` : ajouter que `thread_messages.agent_id` est une **identité
      déclarée**, non authentifiée — pour qu'une revue d'accès ne la lise pas comme une preuve.

**Coût nul par construction** : aucune ligne de code, donc K3 et K5 sont sans objet sur ce volet.
C'est la seule branche du critère d'adoption qui soit trivialement satisfaite.

### 7.3 Ce qui est reporté, avec conditions de réveil

| Volet | Pourquoi reporté | Condition de réveil |
|---|---|---|
| Liage `<user_id>:<agent_id>` | **K3 mesuré et déclenché, sous une forme pire que prévue** : le liage **ne bloquerait pas l'attaque démontrée** (un seul `user_id` possède les deux agents), et aucune table ne relie users↔agents | Un déploiement **multi-utilisateur réel** — c'est le seul cas où le liage mord — **et** la création d'une colonne propriétaire sur `agents` |
| Événements d'audit sur les appels d'outils | Code neuf, et plus cher qu'annoncé : émission sur ~16 outils **plus** les handlers REST jumeaux, câblage de `withAuditContext` dans `serve-http.ts` (jamais appelé en prod), **et** enregistrement des noms d'action dans `TIER1_EVENTS`/`TIER2_EVENTS` — sinon le sweeper (`src/sweeper/index.ts`) ne les purge **jamais**, sur le chemin le plus chaud du produit | Une exigence de conformité qui demande l'attribution des actions de coordination |
| `aud` sur les JWT émis | **K5 mesuré et déclenché : 66 tests**, six fois le seuil. Et le delta défensif est **nul** ici (`aud === iss`, et `iss` est déjà validé) | Une architecture où `aud ≠ iss` — c'est-à-dire un AS distinct du serveur de ressource. **Et un staging mint-first / verify-later**, sinon tous les service tokens en circulation prennent 401 |
| PRM RFC 9728 servie | **MUST de la spec non tenu** — mais [`B04`](B04-scope-step-up-lazy-auth.md) §7.4 a établi que le SDK v2 l'exporte déjà (`buildOAuthProtectedResourceMetadata`), donc le coût a chuté | Livrer avec le gate de `B04` §7.2(2), **pas avant** — publier `scopes_supported` avant que le scope soit appliqué reproduirait le motif que `B03` §7.3 interdit |
| `resource` RFC 8707 côté SDK | mcp-coordinator est son propre AS **et** sa propre ressource ; le paramètre protège d'un AS tiers, scénario inexistant | Le jour où un AS tiers émet des tokens pour nous (cf. `B02` §7.3) |

> ⚠️ **Une ligne de ce tableau est à requalifier, et c'est la plus importante : la sortie de
> session n'est pas reportable — sa condition de réveil est déjà remplie.**
> §6.4 (C ter)(3) le mesure : le mode sessionless est une **option de constructeur** du SDK v2
> **installé**, `ctx.sessionId` y vaut `undefined`, et les 26 outils lèvent. Ce n'est plus un
> risque prospectif conditionné à une révision de protocole — c'est une panne **déclenchable
> aujourd'hui**, déjà réelle en multi-instance (la `Map` in-process contre Redis). Et le
> remplaçant (`BaseContext.http.authInfo`) est **déjà livré**.
>
> **Je ne le tranche pas ici** : c'est le chantier d'identité de tout le serveur, il appartient à
> [`A01`](A01-mcp-2026-07-28-stateless.md) (verdict `reporter`) dont c'est le sujet, et le trancher
> dans une fiche « menace » du bloc B serait un débordement. **Mais `A01` doit savoir que sa
> prémisse a changé** : elle a été reportée en partie parce que « le repli fonctionne » et que rien
> ne pressait. La panne est désormais à un mot de distance.

**Renvoi explicite pour éviter une décision contradictoire :** le `403 insufficient_scope`, le
`scope=` dans `WWW-Authenticate` et surtout **le point d'application du gate** appartiennent à
[`B04`](B04-scope-step-up-lazy-auth.md) §7.2(2), qui les a déjà tranchés — « via le gate HTTP,
**surtout pas dans `src/tools/*.ts`** ». B05 ne re-choisit pas.

### 7.4 Ce que ce challenge a corrigé chez moi

1. **J'ai hérité de deux affirmations de §4/§5 sans les vérifier**, alors qu'elles sont fausses :
   les outils n'écrivent **jamais** dans la chaîne d'audit. Mon item central était bâti dessus.
2. **J'ai lu ma propre sortie de travers** : `from_agent` n'existe pas dans le dépôt — c'était le
   repli de mon script. La vraie colonne est `thread_messages.agent_id`.
3. **J'ai laissé K3 et K5 non mesurés** et j'allais conclure quand même sur un item dont c'est
   précisément le coût. La passe les a mesurés à ma place, et **les deux se déclenchent** — K5 à
   66 tests, K3 sous une forme que je n'avais pas anticipée : **le remède ne bloque pas l'attaque
   que j'avais démontrée**. Ne pas les avoir mesurés est l'économie la moins défendable de ce
   challenge ; ils changent les *motifs* du verdict, pas son dispositif.
4. **J'ai qualifié le volet `aud` de « défense en profondeur ». C'est trop indulgent** :
   `aud === iss` par construction, donc le contrôle ne rejetterait rien que `iss` ne rejette déjà.
   Mon propre §6.5 puce 6 le disait, et je ne l'ai pas repris.
5. **J'ai déclaré la sortie de session « prospective ». C'est faux** : le mode sessionless est une
   option de constructeur du SDK **installé**, `ctx.sessionId` y vaut `undefined`, et les 26 outils
   lèvent. La panne est à un mot de distance, et déjà réelle en multi-instance.
4. **K1 et K4 étaient acquis d'avance.** Les exécuter avait de la valeur ; les présenter comme des
   découvertes, non.

### 7.5 Corrections à porter dans les sections 1 à 5

1. **§4, risque 2** — « La piste d'audit (`src/security/audit-chain.ts`) enregistre alors une
   identité fausse » : **faux**. Aucun outil n'écrit dans la chaîne d'audit. Remplacer par
   « `thread_messages.agent_id` enregistre une identité déclarée, non authentifiée ».
2. **§5, dernière ligne** — « Les événements portent l'identité déclarée par le client » : **faux**
   pour la même raison ; `audit()` prend l'acteur du token vérifié.
3. **§6.5, puce 1** — « un seul `user_id` par org, ce qui n'est le cas d'aucun auto-hébergeur
   connu » : **falsifié** par `README.md:25`, `LAST_ADMIN`, `user_orgs` et l'allowlist par org IdP.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : fiche saine, statut GA confirmé, RFC 9728 est un MUST, une ligne renumérotée. |
| 2026-08-15 | Challenge, sur **SDK v2**. **Verdict : `adopter partiellement` — la documentation seule.** Mesuré : un seul token enregistre `alpha` **et** `beta`, ouvre un thread au nom de beta, puis y poste sous les deux identités ; la trace persiste l'identité usurpée. Et un token portant `aud` d'un autre service est **accepté en 200**. **Deux corrections lourdes imposées par la passe adversariale :** (1) mon affirmation « la chaîne d'audit enregistre une identité fausse » est **fausse** — `grep -rn "audit" src/tools/` → **0**, aucun outil n'y écrit jamais, et `audit()` prend son acteur du **token vérifié** ; j'avais hérité de §4/§5 sans vérifier, et l'item que j'allais adopter n'avait donc **pas d'objet** ; (2) l'étiquette `from_agent` de mes sorties était le **repli de mon propre script** — elle n'existe pas dans le dépôt, la colonne est `thread_messages.agent_id`. **§6.5 puce 1 est falsifiée** : le multi-utilisateur intra-org est implémenté, gardé (`LAST_ADMIN`) et **vendu au `README.md:25`**, donc l'usurpation compte plus que la fiche ne le disait. K3 et K5 restent **non mesurés** — c'est ce qui interdit d'adopter le code, et K5 était mesurable en une heure. K1 et K4 étaient **acquis d'avance**. Corrections portées à §4 (risque 2), §5 (dernière ligne) et §6.5 (puce 1). |
