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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

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

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Le modèle de menace ne correspond pas.** Le profil de déploiement dominant est une équipe d'agents pilotée par un seul humain sur une seule machine. « Un agent usurpe un autre `agent_id` » suppose un agent hostile *déjà authentifié dans l'org* — c'est-à-dire un attaquant qui possède déjà le token. Le liage `<user_id>:<agent_id>` ne le bloque que s'il y a plusieurs `user_id` distincts dans l'org, ce qui n'est le cas d'aucun auto-hébergeur connu aujourd'hui. YAGNI applicable au volet (b), pas au volet (a).
- **Le liage casse un usage légitime.** Un agent lead qui clôture un thread pour le compte d'un worker mort, un script de reprise après crash, ou simplement un même utilisateur pilotant dix agents Claude Code depuis le même token : tous ces cas passent aujourd'hui et échoueraient sous `<user_id>:<agent_id>` strict. Il faudrait une notion de délégation, donc du code neuf, donc une nouvelle surface de bug.
- **La source du volet (b) n'est pas normative.** *Security Best Practices* vit sous `/docs/.../tutorials/security/` — c'est de la guidance, pas la spec. Les MUST y sont rédigés en RFC 2119 mais n'engagent pas la conformité protocole. Refactorer 26 outils sur cette base est disproportionné tant qu'aucun client MCP réel ne rejette le serveur.
- **La sortie de session est un chantier XL déguisé en M.** `sessionClaims` n'est pas une ligne à changer : c'est le point de vérité d'identité de tout le serveur, avec éviction sur `onclose` (`serve-http.ts:823`), CORS `Access-Control-Expose-Headers: mcp-session-id` (`:761`), et le message d'erreur « Session not found » (`:847`). Tant que le SDK MCP installé expose encore `extra.sessionId`, migrer maintenant, c'est écrire deux fois le même code.
- **`aud` ajouté trop tôt casse les tokens en vol.** Poser un `aud` obligatoire invalide tous les access tokens et refresh tokens déjà émis. `src/auth/refresh-rotation.ts` fait 36 Ko et gère déjà une fenêtre de grâce de 10 s pour la rotation ; y greffer une fenêtre de grâce d'audience est exactement le genre de complexité qui produit des trous de sécurité.
- **`resource` côté SDK ne sert à rien seul.** mcp-coordinator est son propre AS *et* sa propre ressource (`src/discovery.ts` : `issuer` = `token_endpoint` = même base URL). Le paramètre `resource` protège contre un AS tiers qui émettrait un token réutilisable ailleurs — scénario inexistant dans l'architecture actuelle. Le bénéfice est déclaratif (cocher une case de conformité), pas défensif.
- **Le coût pour l'auto-hébergeur.** Un `/.well-known/oauth-protected-resource` de plus, un `aud` à configurer, un `COORDINATOR_PUBLIC_URL` qui doit désormais matcher exactement l'URI canonique du `resource` : autant de façons supplémentaires de casser une installation derrière un reverse-proxy mal configuré. Le `doctor.ts` devrait absorber ces nouveaux modes d'échec.

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
| 2026-08-14 | Vérification des faits : fiche saine, statut GA confirmé, RFC 9728 est un MUST, une ligne renumérotée. |
