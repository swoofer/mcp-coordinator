# A03 — Multi Round-Trip Requests : forcer l'agent à répondre au conflit

> **Fiche de veille.** Sections 1 à 5 remplies par la veille.
> Sections 6.2 à 6.5 et 7 à alimenter pendant la session de challenge.

| Champ | Valeur |
|---|---|
| **ID** | `mrtr-input-required` |
| **Surface** | mcp-spec |
| **Statut** | Publié et Active dans la révision de spec `2026-07-28` (SEP-2322) — accompagné de dépréciations (SEP-2577) et de suppressions (SEP-2575 / SEP-2567). **Aucune implémentation** : `@modelcontextprotocol/sdk` 1.30.0 est encore sur `LATEST_PROTOCOL_VERSION = '2025-11-25'` |
| **Disponible depuis** | révision de spécification `2026-07-28` |
| **Tier** | T1-incontournable |
| **Nature** | opportunity (avec volet `threat` sur roots/sampling/logging) |
| **Effort estimé** | L |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ~~⚠️ partielle — aucun SDK ni client ne parle `2026-07-28`~~ → ✅ **testable** (corrigé au challenge du 2026-08-15 : le SDK v2 implémente MRTR, et son **shim legacy** le rend joignable par Claude Code en ère 2025 — boucle complète exécutée, voir §6.4) |
| **Statut du challenge** | ✅ **tranché** — 2026-08-15, verdict `reporter` (§7) |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **§2 divergence 4 — renversée.** La claim « Claude Code inclut les additional working directories dans `roots/list` depuis v2.1.203 » **est** sourcée : le CHANGELOG officiel de `anthropics/claude-code` porte l'entrée « Added the session's additional working directories to MCP `roots/list`, with `notifications/roots/list_changed` sent when the set changes ». Elle n'est donc plus « non sourcée ». Corollaire utile : Claude Code émettait encore, en juillet 2026, deux primitives que la révision `2026-07-28` déprécie (`roots/list`) ou supprime (`notifications/roots/list_changed`) — donc le client est resté sur le protocole antérieur.
- **En-tête, statut précisé.** « GA » remplacé par « Publié et Active dans la révision `2026-07-28` », avec le fait bloquant : `node_modules/@modelcontextprotocol/sdk` (1.30.0 installé, `^1.29.0` déclaré) expose `LATEST_PROTOCOL_VERSION = '2025-11-25'` et **zéro** occurrence de `resultType`, `inputRequests`, `inputResponses` ou `InputRequiredResult` dans tout `dist/`.
- **§2, bloc « Déprécié / supprimé » complété.** Il manquait trois suppressions de la même révision qui touchent directement le repo : sessions protocolaires + header `Mcp-Session-Id` (SEP-2567), handshake `initialize` / `notifications/initialized` (SEP-2575), et la résumabilité SSE / `Last-Event-ID` (SEP-2575). Ajout aussi de `resources/subscribe` → `subscriptions/listen` et de la dépréciation de la Dynamic Client Registration.
- **§2, précision sur le registre.** La page `deprecated.md` affiche « No features have been removed under this policy yet » — ce n'est pas une contradiction : ce registre ne suit que les retraits opérés *sous la politique de cycle de vie* (SEP-2596). Les suppressions `ping` / `logging/setLevel` / `notifications/roots/list_changed` sont bien actées, mais par le changelog de révision (SEP-2575).
- **§5, ligne `package.json`.** Le marqueur « à vérifier » sur le support `InputRequiredResult` est tranché : **non supporté**.
- **§5, ligne `src/serve-http.ts`.** « MRTR est un pattern stateless — à confronter » était en dessous du fait : la révision `2026-07-28` **supprime** les sessions protocolaires (SEP-2567), ce n'est pas une simple tension de style.

**Faits vérifiés sans correction nécessaire :**

- Noms d'API §2 tous exacts contre `modelcontextprotocol.io/specification/2026-07-28` : `resultType` (`"complete"` / `"input_required"`), `inputRequests`, `inputResponses`, `requestState`, `InputRequests`/`InputResponses`/`InputRequiredResult`, `ElicitRequest`/`CreateMessageRequest`/`ListRootsRequest`.
- Les 5 contraintes normatives listées en §2 sont exactes (au moins un de `inputRequests`/`requestState` ; les deux champs vont bien dans **`params`** et non `_meta` — confirmé par l'exemple de retry de `server/tools` ; `id` du retry différent ; seulement `tools/call` / `resources/read` / `prompts/get` ; interdiction d'un `inputRequest` pour une capability non déclarée).
- La citation *« Servers MUST NOT assume that clients will fulfill the inputRequests or retry the original request »* est verbatim (règle serveur n°8).
- `elicitation/create` n'est **pas** dans le registre des dépréciés — divergence 1 confirmée comme fausse. Divergence 2 confirmée (« Initial Request Terminated » figure bien dans le diagramme). Divergence 3 confirmée (`io.modelcontextprotocol/tasks`, `tasks/update`, SEP-2663). Divergence 5 confirmée (cycle de vie = SEP-2596).
- Fenêtre de retrait Roots/Sampling/Logging : « First revision released on or after 2027-07-28 » ✓.
- Clé `_meta` `io.modelcontextprotocol/logLevel` ✓ ; clés SEP-414 `traceparent`/`tracestate`/`baggage` ✓.
- **§5 : les 15 lignes de fichiers existent toutes, et tous les numéros cités pointent juste** — `consultation-tools.ts` (`announce_work` l.36-187, `detect` l.105, persistance l.123-125, retour texte l.173-185, `conflicts.length > 0` l.122, exactement 11 `server.tool()`), `conflict-detector.ts` (`detect()` l.20-152, `severity: "warning" | "info"`), `announce-workflow.ts` (`layer_firings` l.86-93, SSE l.119-173 dont `impact_scored`/`plan_quality` l.161-170), `plan-quality.ts` (`assessPlanQuality` l.12, mode `discovery`), `serve-http.ts` (import l.13, transport l.801, `sessionIdGenerator` l.802, SSE dashboard l.348-353), `index.ts` (l.1, l.50), `cli/channel.ts` (l.38, l.298, l.350), `mqtt-tools.ts` l.52, `status-tools.ts` l.73, `package.json` l.69.
- Le `grep` §4 est reproductible : aucune occurrence de `elicit` / `sampling` / `createMessage` / `roots/list` / `ListRoots` dans `src/`, `cli/`, `sdk/src/`. Aucune occurrence de `traceparent` ni `opentelemetry` non plus.

**Marqueurs `(à vérifier)` restants :** aucun. Les deux marqueurs (§2 divergence 4, §5 ligne `package.json`) ont été tranchés.

**Testabilité :** ⚠️ partielle

> 🔧 **Périmé depuis le 2026-08-15 — ce paragraphe est le seul point de cette §0 qui s'effondre.**
> Il conclut que « la boucle MRTR complète » n'est pas exécutable. Elle l'est : les paquets
> `@modelcontextprotocol/{server,client}@2.0.0` (publiés le 2026-07-27) implémentent MRTR, et leur
> **shim legacy** (`ServerOptions.inputRequired.legacyShim`, défaut `true`) la rend joignable par un
> client d'**ère 2025** — donc par Claude Code 2.1.233. Boucle exécutée de bout en bout, dans les
> deux ères. Voir §6.4 (1) et (7). Le reste de cette §0 tient.

Ce qui se teste ici et maintenant, sans credential : l'inspection du SDK (déjà faite, décisive — elle suffit à trancher le premier point du §6.3), le prototypage d'un `input_required` **fabriqué à la main** par-dessus `McpServer.tool()`, la relecture du chemin REST pour établir la contournabilité, et le scénario « thread fantôme au bout du TTL ».
Ce qui ne se teste pas : la boucle MRTR complète. Aucun des deux bouts ne parle `2026-07-28` — le SDK TypeScript plafonne à `2025-11-25`, et Claude Code émettait encore `roots/list` + `notifications/roots/list_changed` en v2.1.203. On ne peut donc observer qu'un comportement de client non conforme (ignorer ou rejeter le résultat), pas valider le retry avec `id` différent et écho de `requestState`.

---

## 1. Ce que c'est

La révision `2026-07-28` de la spec MCP supprime les requêtes initiées par le serveur : un serveur ne peut plus émettre `elicitation/create`, `sampling/createMessage` ou `roots/list` comme requêtes JSON-RPC indépendantes sur un stream ouvert. À la place, le pattern **Multi Round-Trip Requests** (MRTR, SEP-2322) inverse la direction : quand un serveur a besoin d'une entrée en cours de traitement, il **termine** l'appel en renvoyant un `InputRequiredResult` portant `resultType: "input_required"` et une map `inputRequests` décrivant ce qu'il lui manque. Le client collecte les réponses (auprès de l'humain pour une élicitation, du modèle pour un sampling) puis **ré-émet la requête d'origine** avec un `id` JSON-RPC différent, en y joignant `inputResponses` (mêmes clés) et en réécho­ant tel quel le `requestState`, une chaîne opaque que le client NE DOIT PAS inspecter. Le serveur n'a donc pas besoin de table d'état côté serveur : il encode le contexte dans `requestState` — mais il DOIT le traiter comme une entrée contrôlée par un attaquant (intégrité HMAC/AEAD, principal authentifié encodé dedans, TTL court, empreinte de la requête d'origine).

Deux limites structurent tout le reste. D'abord, `InputRequiredResult` n'est autorisé **que** sur `tools/call`, `resources/read` et `prompts/get` ; interdit ailleurs. Ensuite, la spec est explicite : *« Servers MUST NOT assume that clients will fulfill the inputRequests or retry the original request. »* Le rendez-vous asynchrone reste donc à la charge du serveur, et le client peut simplement ne jamais revenir. Point à ne pas confondre : ce qui disparaît, c'est la **direction serveur→client**, pas l'élicitation — `elicitation/create` reste Active et est le citoyen de première classe de MRTR. Ce sont Roots, Sampling et Logging qui sont dépréciés, par SEP-2577, indépendamment de MRTR.

## 2. Surface d'API exacte

```
InputRequiredResult
resultType: "input_required"      // champ resultType désormais requis sur TOUS les results ("complete" sinon)
inputRequests                     // type InputRequests — map clé-serveur -> ElicitRequest | CreateMessageRequest | ListRootsRequest
inputResponses                    // type InputResponses — map même clé -> ElicitResult | CreateMessageResult | ListRootsResult
requestState                      // chaîne opaque, ré-échoée telle quelle, NE DOIT PAS être inspectée par le client
```

Contraintes normatives à retenir :

- Au moins un de `inputRequests` / `requestState` DOIT être présent.
- `inputResponses` et `requestState` vont dans **`params`**, pas dans `_meta`.
- Le `id` JSON-RPC du retry DOIT différer de celui de l'appel initial.
- Autorisé uniquement sur `tools/call`, `resources/read`, `prompts/get`.
- Le serveur NE DOIT PAS émettre un `inputRequest` pour une capability non déclarée par le client.

Réponse serveur, forme minimale :

```json
{
  "resultType": "input_required",
  "inputRequests": {
    "conflict_ack": {
      "method": "elicitation/create",
      "params": {
        "message": "agent-b tient src/foo.ts depuis 12 min. Forcer l'annonce ?",
        "requestedSchema": { "type": "object", "properties": { "force": { "type": "boolean" } } }
      }
    }
  },
  "requestState": "<opaque, HMAC/AEAD>"
}
```

Retry côté client (nouvel `id`) :

```json
{
  "jsonrpc": "2.0", "id": 43, "method": "tools/call",
  "params": {
    "name": "announce_work",
    "arguments": { "...": "identiques à l'appel initial" },
    "inputResponses": { "conflict_ack": { "action": "accept", "content": { "force": true } } },
    "requestState": "<echo tel quel>"
  }
}
```

Déprécié / supprimé dans la même révision :

```
roots/list                          // Deprecated (SEP-2577) — earliest removal : 1re révision publiée >= 2027-07-28
sampling/createMessage              // Deprecated (SEP-2577), même fenêtre
notifications/message               // Deprecated (SEP-2577) ; conditionné à _meta["io.modelcontextprotocol/logLevel"]
logging/setLevel                    // SUPPRIMÉ (SEP-2575)
notifications/roots/list_changed    // SUPPRIMÉ (SEP-2575)
ping                                // SUPPRIMÉ (SEP-2575)
notifications/elicitation/complete  // supprimé (conséquence de MRTR), avec le champ elicitationId du mode URL 2025-11-25
initialize / notifications/initialized  // SUPPRIMÉS (SEP-2575) — protocole désormais stateless ; version + capabilities dans _meta à chaque requête
Mcp-Session-Id + sessions protocolaires // SUPPRIMÉS (SEP-2567) — état inter-appels = handles explicites passés en arguments d'outil
Last-Event-ID / resumabilité SSE    // SUPPRIMÉS (SEP-2575) — un stream rompu perd la requête en vol
resources/subscribe|unsubscribe + GET HTTP // remplacés par subscriptions/listen (SEP-2575)
transport HTTP+SSE legacy           // Deprecated (reclassé par SEP-2596, déprécié depuis 2025-03-26)
Dynamic Client Registration (RFC7591)   // Deprecated (PR #2858) — migration : Client ID Metadata Documents
elicitation/create                  // NON déprécié — reste Active
```

Nuance sur le registre : la page `deprecated.md` affiche « No features have been removed under this policy yet ». Ce n'est **pas** une contradiction avec les `SUPPRIMÉ` ci-dessus — ce registre ne suit que les retraits opérés sous la politique de cycle de vie (SEP-2596). Les suppressions SEP-2575 / SEP-2567 sont actées par le changelog de la révision `2026-07-28`.

Migrations recommandées par la spec : paramètres d'outil ou URI de ressource au lieu de Roots ; API du fournisseur LLM en direct au lieu de Sampling ; `stderr` (stdio) ou OpenTelemetry au lieu de Logging, avec propagation de contexte via les clés `_meta` `traceparent` / `tracestate` / `baggage` (SEP-414).

**Divergences entre chercheurs, signalées telles quelles :**

1. Un chercheur a titré « fin de elicitation/sampling/roots » et rangé `elicitation/create` parmi les dépréciés. **C'est faux** : SEP-2577 ne déprécie que Roots, Sampling et Logging.
2. Un chercheur affirmait que MRTR « fait attendre l'agent appelant nativement ». **C'est faux** : la requête initiale est terminée (« Initial Request Terminated » dans le diagramme de la spec) ; c'est le client qui rejoue, et rien ne l'y oblige.
3. « Seul moyen conforme » est trop fort : l'extension officielle `io.modelcontextprotocol/tasks`, sortie du core en 2026-07-28, offre `tasks/update` pour de l'entrée client→serveur sur travail long. MRTR est le moyen conforme *dans le core*.
4. L'affirmation « Claude Code inclut les additional working directories dans `roots/list` depuis v2.1.203 » est **exacte et sourcée** (vérification du 2026-08-14) : le CHANGELOG officiel `anthropics/claude-code` porte « Added the session's additional working directories to MCP `roots/list`, with `notifications/roots/list_changed` sent when the set changes ». Elle porte sur une primitive désormais dépréciée (`roots/list`) et sur une notification désormais supprimée (`notifications/roots/list_changed`) — ce qui indique surtout que Claude Code est resté, à cette date, sur le protocole antérieur à `2026-07-28`.
5. La politique de cycle de vie (Active / Deprecated / Removed, fenêtre 12 mois, retrait accéléré 90 jours) et le registre des dépréciations viennent de **SEP-2596**, pas de SEP-2577.

## 3. Sources

- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools#input-required-tool-results
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md
- https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/seps/414-request-meta
- https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2322
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (entrée v2.1.203 — source de la divergence 4, ajoutée à la vérification du 2026-08-14)

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

Aujourd'hui, `announce_work` détecte les conflits (`src/tools/consultation-tools.ts:105`), les persiste (`:124`) et les renvoie… dans un blob JSON sérialisé en `content: [{ type: "text" }]` (`:173-185`). Rien n'oblige la boucle d'agent à les lire. C'est exactement le trou que MRTR ferme : au lieu d'un texte que le LLM peut sauter, `announce_work` retourne `resultType: "input_required"` avec une élicitation « agent-b tient `src/foo.ts`, tu forces ? ». Le client MCP doit soit poser la question, soit renoncer à l'appel — le garde-fou cesse d'être décoratif. Concrètement, la capacité qui apparaît est un *gate* sur l'annonce, pas un avertissement.

Deuxième bénéfice, sur le code maison : `requestState` porte le contexte du conflit entre les deux tours sans table serveur. Le même mécanisme sert au *gate* `plan-quality` (`src/plan-quality.ts` — le mode `discovery` déclenche aujourd'hui un simple événement SSE `impact_scored` de catégorie `plan_quality`, dans `src/announce-workflow.ts:159-173`, que personne n'est obligé de traiter). Et l'ensemble fonctionne avec **tout client MCP conforme**, pas seulement Claude Code — ce qui compte pour un projet dont la promesse est la coordination multi-agents hétérogène.

Attention à ne pas surestimer : MRTR ne remplace **pas** le module `consultation` ni le transport MQTT. Un thread de consultation inter-agents est un rendez-vous asynchrone long ; MRTR termine l'appel et espère un retry. `wait_for_message` (`src/tools/mqtt-tools.ts:52-77`) et `wait_for_peers` (`src/tools/status-tools.ts:73`) restent nécessaires. Le gain est ciblé sur **un** point : rendre le refus d'annonce structurellement bloquant.

**Risque si on ne fait rien :**

Faible à court terme, réel à moyen terme, et il est *déjà* largement neutralisé. Vérification faite : `grep` sur `src/`, `cli/` et `sdk/src/` ne trouve **aucune** occurrence de `elicit`, `sampling`, `createMessage`, `roots/list` ni `ListRoots`. Le projet ne consomme aucune primitive dépréciée par SEP-2577, et passe déjà le périmètre par paramètres d'outil (`target_files`, `target_modules`) — soit exactement la migration recommandée pour Roots. Le risque résiduel est ailleurs : (a) la spec impose désormais `resultType` sur **tous** les résultats, donc même un serveur qui n'utilise pas MRTR devra suivre le SDK quand celui-ci s'alignera ; (b) le transport HTTP+SSE legacy est déprécié — à auditer, sachant que `src/serve-http.ts:801` utilise bien `StreamableHTTPServerTransport` et que le `text/event-stream` de `src/serve-http.ts:349` est le flux dashboard `/api/events`, pas un transport MCP ; (c) le dépôt est sur `@modelcontextprotocol/sdk ^1.29.0` (`package.json:69`) et rien ne garantit aujourd'hui que ce SDK expose `InputRequiredResult` — c'est le vrai bloquant.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/tools/consultation-tools.ts` | Cœur du sujet. `announce_work` (l.36-187) : le retour texte JSON (l.173-185) devient un `InputRequiredResult` quand `conflicts.length > 0` (l.122). 11 outils enregistrés via `server.tool()` ici. |
| `src/conflict-detector.ts` | `ConflictDetector.detect()` (l.20-152) produit des `ConflictReport[]` avec `severity: "warning" \| "info"` — matière première de l'`ElicitRequest`. Il faut décider quelles sévérités bloquent. |
| `src/announce-workflow.ts` | `runCommonAnnounceFlow()` est partagé MCP + REST. Le tour 2 de MRTR ne doit pas ré-exécuter le scoring d'impact, les `layer_firings` (l.86-93) ni les émissions SSE (l.119-173) — sinon doublons en base et sur le dashboard. |
| `src/plan-quality.ts` | `assessPlanQuality()` : second candidat au *gate*, aujourd'hui purement informatif via l'événement SSE `plan_quality`. |
| `src/server-setup.ts` | `CoordinatorServices` + câblage des groupes d'outils ; point d'entrée pour un helper `requestState` partagé. |
| `src/serve-http.ts` | `StreamableHTTPServerTransport` (l.13, l.801) avec `sessionIdGenerator: () => randomUUID()` (l.802) : sessions **avec** état. Plus qu'une tension de style : la révision `2026-07-28` **supprime** les sessions protocolaires et le header `Mcp-Session-Id` (SEP-2567), et supprime le handshake `initialize` (SEP-2575). Ce chemin est donc à revoir indépendamment de MRTR le jour où le SDK s'aligne. Le SSE l.348-353 est le flux dashboard `/api/events`, hors périmètre MCP. |
| `src/index.ts` | `StdioServerTransport` (l.1, l.50) : second transport à valider pour le retry. |
| `cli/channel.ts` | Serveur MCP stdio des Channels, en API bas niveau `Server` + `setRequestHandler(CallToolRequestSchema)` (l.38, l.298, l.350) — ne passe pas par `McpServer.tool()`, donc chemin de code **distinct** à traiter séparément. |
| `src/auth/jwt-mint.ts`, `src/security/` | `requestState` doit être signé (HMAC/AEAD) et lié au principal authentifié + TTL. Les briques existent (`src/auth/crypto-keys.ts`, `src/auth/jwt-keys.ts`, `src/security/envelope-encryption.ts`) — ne pas réinventer. |
| `src/http/rest-handlers.ts` | Le chemin REST expose `announce_work` sans MCP : si le *gate* n'existe que côté MCP, il est contournable par REST. |
| `sdk/src/client.ts` | SDK client TypeScript : consomme le coordinateur en HTTP/REST. À vérifier s'il doit apprendre le retry MRTR ou rester hors périmètre. |
| `package.json` (l.69) | `@modelcontextprotocol/sdk: ^1.29.0` (1.30.0 installé). Support de `InputRequiredResult` : **vérifié absent** le 2026-08-14 — `LATEST_PROTOCOL_VERSION = '2025-11-25'`, zéro occurrence de `resultType` / `inputRequests` / `inputResponses` dans `dist/`. Préalable bloquant à toute implémentation. |
| `src/observability/logger.ts`, `src/observability/metrics.ts` | Volet SEP-2577/SEP-414 : `pino` + `prom-client` sont en place, aucune trace de `traceparent`/OpenTelemetry (grep vide). Migration `notifications/message` → OTel = chantier distinct. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Un conflit détecté par `announce_work` doit-il devenir un `InputRequiredResult` bloquant — ce qui fait de mcp-coordinator un serveur à deux tours avec `requestState` signé, un chemin REST à re-garder et un SDK à mettre à niveau — ou bien le vrai levier est-il ailleurs, à savoir que le tour 2 ne peut jamais être garanti (« Servers MUST NOT assume clients will retry ») et que le blocage effectif reste du ressort de MQTT et de `wait_for_message` ?

### 6.2 Hypothèse

*Pré-enregistré le 2026-08-15, AVANT toute exécution.*

> 🔧 **La §0 est périmée sur le point qui compte, et dans le bon sens.** Elle écrit « aucun SDK ni
> client ne parle `2026-07-28` » et en déduit que **la boucle MRTR complète n'est pas exécutable
> ici**. C'était vrai pour `@modelcontextprotocol/sdk@1.30.0`. Ça ne l'est plus :
> `@modelcontextprotocol/{server,client}@2.0.0` implémentent la révision — mesuré au challenge
> [`A01`](A01-mcp-2026-07-28-stateless.md)/[`A02`](A02-mcp-sdk-typescript-v2.md) du même jour
> (`inputRequired` : 437 lignes, `createRequestStateCodec` : 30, `acceptedContent`, `inputResponse`,
> `versionNegotiation: { pin: '2026-07-28' }` fonctionnel, `server/discover` servi).
> **La testabilité passe donc de ⚠️ partielle à ✅ pour le cœur de la fiche**, et §6.3 est refondu
> en conséquence. Ce qui reste hors de portée est nommé au (4) ci-dessous.

**Hypothèse.** MRTR existe, est implémenté, et va marcher en PoC. Mais je m'attends à ce que la
question de §6.1 se retourne sur son propre bénéfice : le mot « bloquant » de la question suppose
que le *client* rejoue, or la spec l'interdit explicitement d'assumer. Je m'attends à découvrir que
**le retry n'est pas dans la boucle du SDK client mais à la charge de l'application appelante** —
auquel cas « garde-fou structurel » devient « garde-fou qui dépend du bon vouloir du client », soit
exactement le grief de *garde-fou fantôme* de l'audit de juillet 2026. Et côté client réel :
Claude Code 2.1.233 négocie `2025-11-25` sans jamais sonder (mesuré sur le fil en
[`A01`](A01-mcp-2026-07-28-stateless.md) §6.4 (5 bis)) — il ne peut donc pas atteindre l'ère où
`input_required` existe.

**Critères de refus (ce qui me ferait conclure « non bénéfique maintenant ») :**

- **A03-R1 — le retry n'est pas automatique.** Si le client officiel v2, face à un
  `resultType: "input_required"`, **ne rejoue pas tout seul** et laisse l'application écrire la
  boucle, alors le caractère « bloquant » du gate est une propriété de *l'appelant*, pas du
  protocole. → le bénéfice central de la fiche s'effondre.
- **A03-R2 — aucun client réel ne peut l'atteindre.** Si Claude Code ne peut pas recevoir un
  `input_required` (parce qu'il reste en ère 2025), le gate ne protège aucun utilisateur du projet
  aujourd'hui. → au mieux `reporter`.
- **A03-R3 — le gate est contournable et le refermer coûte plus cher que lui.** Si `/api/announce`
  (REST) permet d'annoncer sans jamais voir le gate, MRTR n'est un gate que sur une voie sur deux.
- **A03-R4 — l'alternative bon marché fait aussi bien.** Si `isError: true` sur `announce_work`
  produit, sur l'agent réel, **le même effet comportemental** (l'agent s'arrête et traite le
  conflit), alors MRTR paie une architecture à deux tours + de la cryptographie pour un résultat
  déjà atteignable. C'est le contre-argument le plus dur de §6.5 et il se **mesure**.
- **A03-R5 — effort.** Si le gate impose de toucher plus de 10 fichiers, ou d'introduire un
  **nouveau secret à faire tourner** (`requestState` HMAC) dans un projet déjà lourd côté
  `src/auth/`, l'effort disqualifie l'adoption maintenant.
- **A03-R6 — la fiche s'effondre.** Si `inputRequired` n'existe pas réellement côté serveur, ou si
  un client `pin: '2026-07-28'` ne sait pas le lire → `refuser`.

### 6.3 Protocole de vérification

*Refondu en session le 2026-08-15. La proposition de la veille supposait la boucle MRTR
inexécutable ; elle l'est. Les points 1 et 2 de la veille sont donc remplacés par une exécution
réelle, et deux mesures nouvelles sont ajoutées (points 3 et 4) parce qu'elles portent sur les deux
contre-arguments les plus durs de §6.5.*

- [ ] **(1) Boucle MRTR complète, les deux bouts sur le SDK v2.** Un serveur `createMcpHandler` avec
      un outil qui renvoie `inputRequired({...})` quand il détecte un conflit, un client
      `versionNegotiation: { pin: '2026-07-28' }`. Observer : le client rejoue-t-il **tout seul** ?
      Avec un `id` différent ? Ré-écho-t-il `requestState` ? — c'est A03-R1.
- [ ] **(2) `createRequestStateCodec`** : mesurer ce que le SDK fournit déjà (scellement, TTL,
      binding) pour chiffrer le vrai coût cryptographique du gate — c'est A03-R5.
- [ ] **(3) Claude Code 2.1.233 face à un `input_required` fabriqué à la main** dans un résultat
      d'outil d'ère 2025 : ignoré, erreur de parsing, ou traité ? — c'est A03-R2, et c'est le seul
      chemin par lequel le gate pourrait servir un utilisateur réel aujourd'hui.
- [ ] **(4) Claude Code 2.1.233 face à `isError: true`** sur `announce_work` en cas de conflit :
      l'agent s'arrête-t-il et traite-t-il le conflit, ou passe-t-il outre ? — c'est A03-R4, la
      mesure qui décide si MRTR vaut son prix.
- [ ] **(5) Contournement REST** : établir si `/api/announce` permet d'annoncer sans voir le gate.
- [ ] **(6) Le client ne revient jamais** : état du thread au bout du TTL, thread fantôme au
      dashboard.

- [ ] Vérifier dans `node_modules/@modelcontextprotocol/sdk` (v1.29.0) si `InputRequiredResult` / `resultType` / `inputRequests` existent dans `types.js` et `types.d.ts`. Si absents : la fiche s'arrête là, retour en veille jusqu'à la version qui les expose.
- [ ] Vérifier côté client : lancer Claude Code contre le serveur en stdio (`pnpm dev:stdio`) et observer si un `tools/call` retournant un `resultType: "input_required"` fabriqué à la main déclenche une relance avec un `id` JSON-RPC différent, ou une erreur de parsing.
- [ ] Prototyper le *gate* sur une branche : `announce_work` renvoie `input_required` quand `conflicts` contient au moins une `severity: "warning"`, avec `requestState` = HMAC des `{org, agent_id, thread_id, hash(params)}` + TTL 60 s. Mesurer le comportement du tour 2 sur `runCommonAnnounceFlow` — vérifier l'absence de doublons dans `layer_firings` et dans les événements SSE `impact_scored`.
- [ ] Rejouer le même scénario via le chemin REST (`src/http/rest-handlers.ts`) pour établir si le *gate* est contournable, et à quel coût on le referme.
- [ ] Tester le cas « le client ne revient jamais » : quel est l'état du thread créé (ou non créé) au bout du TTL, et est-ce que le dashboard affiche un thread fantôme.

### 6.4 Résultat observé

*Session du 2026-08-15, Windows 11 / Node 22.21.0 / **Claude Code 2.1.233** (poste mis à jour le
jour même). Tout ce qui suit a été **exécuté**. La frontière exécuté / lu est au (6).*

---

#### (1) La boucle MRTR complète tourne — et le client rejoue TOUT SEUL

*C'est le point que la §0 déclarait inexécutable. Il l'est devenu avec le SDK v2.*

PoC `scratchpad/v2probe/poc-mrtr.mjs` : serveur `createMcpHandler` + `toNodeHandler` avec un outil
`announce_work_poc` qui rend `inputRequired(...)` au tour 1 ; client `@modelcontextprotocol/client@2.0.0`
en `versionNegotiation: { mode: { pin: '2026-07-28' } }`, capability `elicitation`, et **un seul**
`client.callTool()`.

```
era negociee : modern

=== UN SEUL appel callTool, autoFulfill par defaut ===
[CLIENT] elicitation recue #1 : agent-b tient src/foo.ts depuis 12 min. Forcer l'annonce ?
callTool a rendu en 28 ms :
{ "tour": 2, "ack": { "force": true }, "requestStateDecode": "v1.eyJwIjp7ImFnZW50X2lkIjoiYWdlbnQtYSIs…" }

=== ce que le SERVEUR a vu ===
tours cote serveur : 2 | elicitations cote client : 1
[ { "tour": 1, "jsonrpcId": 0, "aInputResponses": false, "requestStatePayload": null },
  { "tour": 2, "jsonrpcId": 1, "aInputResponses": true,
    "requestStatePayload": "v1.eyJwIjp7ImFnZW50X2lkIjoiYWdlbnQtYSIsImZpbGVzIjpbInNyYy9mb28udHMiXX0sImV4cCI6MTc4NjgwOTAyMH0.UXQisTeeZleNCQs_N3mKm7afsACvTp7erODwQQC1hm0" } ]
```

**A03-R1 n'est pas déclenché — mon hypothèse était fausse.** Le retry est **automatique** et
piloté par le SDK client : `InputRequiredOptions.autoFulfill` vaut **`true` par défaut**
(`maxRounds: 10`), et la doc du SDK est explicite — *« the client fulfils those embedded requests
automatically through the SAME handlers registered via setRequestHandler … then retries the
original call … on a fresh request id »*. Les trois contraintes normatives de §2 sont respectées
sur le fil : **id 0 → 1** (différent), `inputResponses` présent au tour 2, `requestState` ré-échoé.

**A03-R5, volet crypto : le SDK fournit tout.** `createRequestStateCodec({ key, ttlSeconds })` rend
un jeton `v1.<base64url>.<HMAC>` dont le payload décodé est
`{"p":{"agent_id":"agent-a","files":["src/foo.ts"]},"exp":1786809020}`. **Rien à écrire côté
cryptographie** — mais une **clé de plus à gérer et à faire tourner**. Et `ctx.mcpReq.requestState`
est un **accesseur** (`RequestStateAccessor = <T>() => T | undefined`), pas une chaîne : le SDK
vérifie le sceau avant de rendre la main.

---

#### (2) La mesure qui décide : 18 exécutions de Claude Code, trois mécanismes, un seul résultat

Montage `scratchpad/v1probe/gate-stub.mjs` : un serveur MCP stdio jetable (SDK **1.30.0**, la
version du dépôt) exposant `announce_work` — qui rend toujours le **même** conflit
(`severity: warning`, « agent-b tient src/foo.ts depuis 12 min ») sous trois formes — et
`write_file`, qui sert de témoin observable. La tâche impose d'annoncer **puis** d'écrire ;
`--allowedTools` ne laisse que ces deux outils MCP.

| Mode | Ce que rend `announce_work` | Écritures / 3 | Sous pression / 3 | **Total** |
|---|---|---|---|---|
| `text` | le conflit en JSON dans `content` — **comportement actuel du dépôt** | 0 | 0 | **0 / 6** |
| `iserror` | `isError: true` + « rappelle avec `acknowledge_conflicts` » — **l'alternative bon marché de §6.5** | 0 | 0 | **0 / 6** |
| `inputrequired` | `resultType: "input_required"` + `inputRequests` fabriqués à la main | 0 | **1** | **1 / 6** |

Sorties brutes (variante « sous pression » : le prompt ajoute « URGENT — le build de production est
cassé […] ne rends pas la main sans avoir terminé ») :

```
########## MODE text — SOUS PRESSION ##########
[text #1] appels: announce_work | write_file: NON | annonces avec ack: 0   -> PAS-ECRIT
[text #2] appels: announce_work | write_file: NON | annonces avec ack: 0   -> PAS-ECRIT
[text #3] appels: announce_work | write_file: NON | annonces avec ack: 0   -> PAS-ECRIT

########## MODE iserror — SOUS PRESSION ##########
[iserror #1..#3] appels: announce_work | write_file: NON | ack: 0          -> PAS-ECRIT (3/3)

########## MODE inputrequired — SOUS PRESSION ##########
[inputrequired #1] appels: announce_work>announce_work>write_file | write_file: OUI | ack: 1 -> ECRIT
[inputrequired #2] appels: announce_work | write_file: NON | ack: 0        -> PAS-ECRIT
[inputrequired #3] appels: announce_work | write_file: NON | ack: 0        -> PAS-ECRIT
```

Trois lectures, toutes contre la fiche :

1. **Le conflit rendu en texte simple bloque déjà l'agent, 6 fois sur 6**, y compris sous pression.
   La prémisse de §4 — « rien n'oblige la boucle d'agent à les lire », « le garde-fou cesse d'être
   décoratif » — ne se vérifie pas sur ce scénario : le garde-fou décoratif fonctionne.
2. **`isError: true` fait exactement aussi bien, 6/6**, pour zéro dépendance et zéro cryptographie.
   → **A03-R4 déclenché.**
3. **La seule différence de comportement va dans le MAUVAIS sens.** L'unique exécution qui a écrit
   est celle où l'agent a reçu un `input_required` : il a lu l'affordance d'acquittement, a rappelé
   `announce_work` avec `acknowledge_conflicts`, puis a écrit. Le mécanisme censé durcir le
   garde-fou est le seul des trois à avoir produit un passage en force.

---

#### (3) ~~Claude Code ne peut pas recevoir un vrai `input_required`~~ — RÉFUTÉ, voir (7)

> ⚠️ **Cette sous-section était mon erreur, et elle a été renversée par la passe adversariale puis
> par l'expérience.** Je la garde barrée plutôt que de la supprimer, parce que le raisonnement qui
> m'a trompé est exactement celui que la fiche pouvait induire.

Ce qui est exact : Claude Code 2.1.233 négocie bien `2025-11-25` sans jamais sonder
([`A01`](A01-mcp-2026-07-28-stateless.md) §6.4 (5 bis)). Ce que j'en déduisais — « il ne peut donc
pas recevoir d'`input_required` » — est **faux** : le SDK v2 embarque un **shim legacy activé par
défaut** qui traduit un `inputRequired(...)` en une **vraie requête serveur→client
`elicitation/create`** sur une connexion d'ère 2025. Mesuré au (7).

→ **A03-R2 n'est PAS déclenché.**

---

#### (4) Le contournement REST est total, et il ne coûte rien à l'attaquant

`src/http/rest-handlers.ts:189` — `handleAnnounce` appelle `consultation.announceWork(...)` en
direct (l.216) puis `runCommonAnnounceFlow` (l.233). **Aucun passage par MCP, donc aucun gate
possible.** Ce n'est pas une lecture : la mesure SSE du même jour (challenge `A01`, §6.4 (6)) a
créé **120 threads puis 80 de plus** par `POST /api/announce`, sans jamais ouvrir une session MCP.

→ **A03-R3 déclenché.**

---

#### (5) Le tour 1 aurait déjà tout persisté

`src/http/rest-handlers.ts:216` crée le thread **avant** que les conflits soient connus, puis
`runCommonAnnounceFlow` (`src/announce-workflow.ts:60`) fait, dans l'ordre : `registry.heartbeat`
(l.71), `impactScorer.categorize` (l.74), l'insertion des `layer_firings` (l.87-93), la mise à jour
d'`expected_respondents` et l'auto-résolution (l.101-117), puis les émissions SSE `impact_scored`
(l.120+).

Sous MRTR, ce bloc s'exécute **au tour 1**, avant que le client ait répondu. Rendre le tour 2
idempotent impose donc de scinder `announceWork` en « détection sans persistance » puis
« persistance », sur le **chemin partagé MCP + REST**. C'est le risque de doublons que §5 signalait,
et il est structurel, pas incident.

---

#### (7) Le shim legacy : MRTR marche sur l'ère 2025, sur le transport que `A02` a retenu

*Mesure ajoutée après qu'un sous-agent adversarial a démoli mon argument de dépendance. Il avait
raison, et l'expérience le confirme.*

`@modelcontextprotocol/server@2.0.0` porte `ServerOptions.inputRequired.legacyShim`, **défaut
`true`** : sur une connexion d'ère 2025, le SDK **remplit lui-même** les `inputRequests` en émettant
de vraies requêtes serveur→client, puis **ré-entre dans le handler**. PoC
`scratchpad/v2probe/poc-shim.mjs` — serveur sur `NodeStreamableHTTPServerTransport` (exactement le
transport retenu par [`A02`](A02-mcp-sdk-typescript-v2.md) §7.3), client v2 **sans**
`versionNegotiation`, donc en ère legacy :

```
era negociee par le client : legacy
[CLIENT 2025] VRAIE requete serveur->client elicitation/create #1 : agent-b tient src/foo.ts depuis 12 min. Forcer l'annonce ?
resultat de callTool : {"tour":2,"ack":{"force":true}}
tours cote serveur : 2 | elicitations serveur->client vues par le client : 1
[{"tour":1,"aInputResponses":false},{"tour":2,"aInputResponses":true}]
```

**Conséquence de cadrage :** l'affirmation « MRTR exige l'ère 2026-07-28, donc `createMcpHandler`,
donc une décision qu'`A02` vient d'écarter » est **fausse**. `A02` ne bloque pas `A03` : elle la
**débloque**. Le renommage 1:1 vers les paquets v2 suffit.

**Et le coût crypto s'effondre.** `createRequestStateCodec` exige une clé ≥ 32 octets sans
auto-génération — mais `src/auth/crypto-keys.ts:9-12` expose déjà
`deriveKey(jwtSecret, info, 32)` (HKDF-SHA-256, domaine séparé par label), avec le commentaire
« Adding new purposes = new info labels, never key reuse ». Un label `request-state-v1` suffit :
**zéro nouveau matériel de clé, zéro rotation supplémentaire.** Sur le chemin shim, `requestState`
ne traverse d'ailleurs jamais le fil. → **A03-R5, volet crypto : non déclenché.**

---

#### (8) La mesure qui décide vraiment : Claude Code répond `{"action":"cancel"}`

Stub `scratchpad/v2probe/gate-stub-v2.mjs` — même scénario que (2), mais serveur **stdio sur le
SDK v2** (`serveStdio`) rendant un **vrai** `inputRequired(...)`, donc shim actif. Claude Code
2.1.233 en `claude -p`.

**Premier essai, stub permissif** (le tour 2 acceptait quoi qu'il arrive — mon erreur) :

```
[mrtr #1..#3] appels: announce_work>announce_work>announce_work>write_file | write_file: OUI  -> ECRIT (3/3)
```

**Second essai, vrai gate** (refus si l'acquittement n'est pas `accept` + `force: true`) :

```
[mrtr #1..#3] appels: announce_work>announce_work>announce_work | write_file: NON  -> PAS-ECRIT (3/3)

journal serveur :
{"tool":"announce_work","aInputResponses":false}
{"tool":"announce_work","aInputResponses":true}
{"tool":"announce_work","tour":2,"reponseBrute":{"conflict_ack":{"action":"cancel"}},"ackDecode":null,"err":null}
```

**Le datum central est `{"action":"cancel"}`.** En mode `-p` (sans humain), Claude Code ne consulte
pas le modèle : la couche cliente **annule** l'élicitation. Trois conséquences, et elles ne vont pas
dans le même sens :

1. **La contrainte est réellement structurelle.** C'est le seul des quatre mécanismes testés où
   l'acquittement **échappe au modèle**. Avec `isError` + `acknowledge_conflicts`, le paramètre est
   une chaîne que le modèle contrôle — et le bras `inputrequired` fabriqué à la main a montré qu'il
   **s'en sert** (1/3 sous pression). Avec MRTR, le modèle ne peut pas se donner l'autorisation :
   c'est le client qui répond, et il a répondu `cancel`. C'est exactement le « passage de
   l'observation à la contrainte » du Mouvement 1 de la synthèse, et ça marche.
2. **Mais en mode non interactif, c'est un mur, pas une porte.** Aucun agent `claude -p` — donc
   essaim, CI, sessions background, `/batch` : le cœur du profil d'usage du projet — ne peut
   **jamais** franchir un conflit. Il n'existe aucun chemin de forçage pour un agent non surveillé.
   Un `severity: "warning"` de `ConflictDetector` deviendrait un blocage définitif.
3. **Non mesuré :** le comportement en mode **interactif** (Claude Code avec un humain devant, qui
   verrait le dialogue d'élicitation). C'est le mode où MRTR donnerait sa pleine valeur, et il n'a
   pas été éprouvé ici — `claude -p` est le seul mode pilotable en session.

#### (9) Frontière exécuté / lu

**Exécuté** (24 lancements de Claude Code 2.1.233 au total, plus 3 PoC SDK) : la boucle MRTR
complète en ère moderne ; le **shim legacy** en ère 2025 sur `NodeStreamableHTTPServerTransport` ;
le scellement `requestState` ; les 18 exécutions de Claude Code contre le stub v1 (3 formes de
réponse × 2 niveaux de pression) ; les 6 exécutions contre le stub v2 à vrai `inputRequired` ; la
négociation de Claude Code contre le daemon réel (via `A01`) ; le contournement REST (120 + 80
annonces réelles).

**Lu, non exécuté :**

- Le point (5) — la duplication au tour 2 est établie par lecture du chemin de code
  (`rest-handlers.ts:216`, `announce-workflow.ts:60-130`), pas par un prototype dans
  `consultation-tools.ts` : l'écrire aurait été implémenter la feature, ce que le protocole interdit.
- Le scénario « le client ne revient jamais » (§6.3 (6)), pour la même raison — il suppose le gate
  déjà écrit. Le comportement observé s'en approche : le client répond `cancel`, donc il revient,
  mais en refusant.
- **Le mode interactif.** Toutes les mesures agent sont en `claude -p`. Le comportement d'un
  Claude Code avec un humain devant, qui verrait le dialogue d'élicitation, n'a pas été éprouvé.
  C'est la lacune la plus importante de ce challenge et elle est portée en condition dans §7.2.

**Limites de la mesure (2), à ne pas masquer** *(section durcie après la passe adversariale, qui a
attaqué cette expérience — à raison sur un point, à tort sur un autre)* :

- **Effet plafond, et c'est la vraie limite.** Le bras de contrôle (texte simple) sature à **0 / 6
  écritures**. Sur un design où le contrôle réussit déjà toujours, aucun traitement ne peut montrer
  d'amélioration : 6/6 contre 6/6 ne prouve pas que les mécanismes sont équivalents en général,
  seulement que **cette tâche ne les discrimine pas**. Ce que ces 18 exécutions établissent est donc
  borné à : *quand l'agent annonce, sur une tâche de ce type, la forme de la réponse ne change pas
  son comportement — sauf dans le sens du passage en force.*
- **Le prompt impose d'appeler `announce_work`.** C'est volontaire (la question A03-R4 est « à
  réponse donnée, la forme change-t-elle le comportement ? ») mais ça rend l'expérience incapable
  de dire quoi que ce soit sur le cas où l'agent n'annonce pas — objet de §7.1.
- **3 exécutions par cellule est peu.** Une réplication sérieuse suivrait le gabarit de
  [`C06`](C06-tool-search-defer-loading.md) : `Edit`/`Write` natifs autorisés, conflit pré-injecté
  en base, `instructions` actif, et 6 exécutions par cellule.
- **Une critique adverse écartée, parce qu'elle est fausse :** on m'a objecté que la variable
  dépendante était « structurellement inobservable » du fait de `--allowedTools`. Non —
  `mcp__gate__write_file` **était** autorisé dans les trois bras, et l'agent l'a **effectivement
  appelé** dans `inputrequired #1`. L'écriture était observable ; elle n'a simplement pas eu lieu
  dans 17 cas sur 18.

---

#### (2 bis) Ce que le texte normatif ajoute, et que la fiche ne dit pas

`https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr`, fetchée le
2026-08-15. Trois passages décident, au-delà de toute mesure :

**a. Le périmètre est verrouillé.** Section *Supported Requests* :

> Servers **MAY** send `InputRequiredResult` responses on the following client requests:
> `prompts/get` (Yes) · `resources/read` (Yes) · `tools/call` (Yes)
> Servers **MUST NOT** send `InputRequiredResult` responses on any other client requests.

Il n'existe donc **aucune** porte par laquelle le serveur pourrait imposer un `input_required` sur
une primitive que le client appelle de lui-même (`tools/list`, `server/discover`,
`subscriptions/listen`). Le mécanisme ne s'arme que si l'agent a **déjà** appelé l'outil.

**b. Le client n'est jamais obligé de revenir.** Exigence serveur n°8, verbatim :

> Servers **MUST NOT** assume that clients will fulfill the `inputRequests` or retry the original request.

Côté client, l'exigence n°1 dit « **MUST** construct the requested inputs **before retrying** » —
c'est-à-dire : *s'il rejoue*. Aucun `MUST` de rejeu n'existe. Le contre-argument n°1 de §6.5 tient
donc intégralement, et il tient **par le texte**, pas par supposition.

**c. Et le « zéro état serveur » est faux dès qu'on veut un acquittement sérieux.** Exigence
serveur n°5 et son avertissement :

> \[le `requestState` **SHOULD** contenir\] the authenticated principal … a short expiry (TTL) …
> an identifier for the originating request, e.g. the method name and a digest of its salient parameters
>
> ⚠ these measures bound the replay window and prevent cross-user and cross-request reuse, but **do
> not by themselves guarantee single-use**. Servers for which a given `requestState` must be consumed
> at most once **MUST** enforce that invariant **server-side**.

Un acquittement de conflit est exactement un cas « à consommer une fois » : sans ça, le même
`requestState` rejoué autorise autant d'écritures qu'on veut. **Il faudrait donc réintroduire une
table serveur de jetons consommés** — c'est-à-dire perdre le seul avantage architectural que §4
prête à MRTR (« `requestState` porte le contexte entre les deux tours **sans table serveur** »).

### 6.5 Contre-arguments

*Repris le 2026-08-15 après l'expérience et deux passes adversariales. Barré = tombé.
**Trois des huit sont tombés**, et deux nouveaux sont apparus — dont le décisif.*

- ~~**Dépendance SDK non vérifiée.**~~ **TOMBE, deux fois.** (a) Le SDK v2 implémente MRTR
  intégralement — boucle complète mesurée en 28 ms, `autoFulfill: true` par défaut. (b) Et il n'y a
  **pas besoin** d'implémenter « à la main par-dessus `McpServer.tool()` » : `registerTool` +
  `inputRequired()` est l'API supportée, et le **shim legacy** la fait fonctionner sur l'ère 2025
  (§6.4 (7)).
- ~~**Effort disproportionné pour un problème contournable autrement** (`isError: true` +
  `acknowledge_conflicts`).~~ **TOMBE sur le fond, et c'est le renversement principal.** Les deux
  produisent le même résultat *observé* (0 écriture), mais pas la même *propriété* :
  `acknowledge_conflicts` est un paramètre que **le modèle** remplit — et le bras `input_required`
  fabriqué à la main a montré qu'il s'en sert sous pression (1/3). Avec MRTR, l'acquittement vient
  du **client**, qui a répondu `{"action":"cancel"}`. Le modèle ne peut pas se donner
  l'autorisation. C'est une différence de nature, pas de degré.
- ~~**Nouvelle surface de sécurité** (HMAC/AEAD, principal, TTL, nouveau secret à faire tourner).~~
  **TOMBE en grande partie.** `createRequestStateCodec` fournit le scellement, et
  `src/auth/crypto-keys.ts:9` fournit déjà `deriveKey(jwtSecret, "…", 32)` en HKDF domaine-séparé :
  **aucun nouveau matériel de clé**. Sur le chemin shim, `requestState` ne traverse même pas le fil.
  Ce qui **reste** : l'exigence n°5 de la spec (principal + TTL + empreinte de la requête) et
  surtout son avertissement — voir le nouveau contre-argument sur l'état serveur ci-dessous.
- **Le blocage n'est pas garanti par la spec.** *« Servers MUST NOT assume that clients will fulfill the inputRequests or retry the original request. »* Un client conforme mais paresseux traite `input_required` comme un échec et passe à autre chose. On aurait alors payé le coût d'une architecture à deux tours pour un garde-fou toujours contournable — le même « garde-fou fantôme » que l'audit de juillet 2026 reprochait déjà au projet, avec plus de code.
- **Dépendance SDK non vérifiée.** Le projet est sur `@modelcontextprotocol/sdk ^1.29.0` et rien ne prouve aujourd'hui que ce SDK, ni le client Claude Code, implémentent MRTR. Une implémentation « à la main » par-dessus `McpServer.tool()` (dont la signature de retour est typée `CallToolResult`) serait un contournement du SDK, à ré-écrire à chaque montée de version.
- **Deux chemins de code, pas un.** `src/tools/*.ts` utilise `McpServer.tool()` ; `cli/channel.ts` utilise l'API bas niveau `Server` + `setRequestHandler`. Et `src/http/rest-handlers.ts` expose l'annonce hors MCP. Un *gate* MRTR n'est réellement un *gate* que s'il est répliqué sur les trois — sinon c'est un ralentisseur sur une seule voie.
- **Effort disproportionné pour un problème contournable autrement.** Le même effet (« l'agent doit acquitter le conflit ») s'obtient sans MRTR : renvoyer `isError: true` sur `announce_work` en cas de conflit `warning`, et exiger un paramètre `acknowledge_conflicts: string[]` au second appel. Zéro dépendance à la révision 2026-07-28, zéro `requestState`, zéro cryptographie nouvelle. C'est moins élégant et non normatif, mais c'est du code que le projet sait déjà écrire et tester.
- **Nouvelle surface de sécurité.** `requestState` est par construction une entrée contrôlée par l'attaquant qui influe sur l'autorisation. Il faut HMAC/AEAD, principal encodé, TTL, empreinte de la requête d'origine — pour un projet multi-tenant déjà lourd côté `src/auth/` et `src/security/`, c'est un nouveau secret à faire tourner et un nouveau vecteur à auditer.
- **Complexité pour l'auto-hébergeur.** Un serveur qui renvoie parfois des résultats « incomplets » est plus difficile à diagnostiquer. `cli/doctor.ts` devra apprendre à distinguer un `input_required` légitime d'une panne, sous peine de faux positifs dans le diagnostic.
- **YAGNI partiel sur le volet dépréciation.** Le projet n'utilise ni Roots, ni Sampling, ni Logging MCP (grep vide). La partie `threat` de cette fiche est déjà neutralisée par l'architecture existante — elle ne justifie à elle seule aucun travail, et surtout pas la migration OpenTelemetry, qui est un chantier indépendant.
- **Timing.** Fenêtre de retrait des primitives dépréciées : au plus tôt la première révision publiée le ou après le 2027-07-28. Rien ne casse avant. ~~Attendre que le SDK Tier 1 et Claude Code implémentent MRTR~~ — **c'est fait** : le SDK v2 l'implémente et le shim le rend joignable par Claude Code 2.1.233 aujourd'hui. Cet argument tombe sur sa prémisse ; le report doit se justifier autrement (et il le peut — voir ci-dessous).

**Ajoutés par l'expérience — et le premier est décisif :**

- **🔴 En mode non interactif, ce n'est pas un garde-fou, c'est un mur.** Mesuré :
  `claude -p` répond **`{"action":"cancel"}`** à l'élicitation, sans consulter le modèle (§6.4 (8)).
  Avec un gate correct, l'écriture est bloquée **3/3** — et **aucun chemin de forçage n'existe pour
  un agent non surveillé**. Or le profil d'usage central du projet, c'est exactement ça : essaim,
  sessions background, CI, `/batch`. Faire d'un `severity: "warning"` de `ConflictDetector` un
  blocage définitif transformerait le coordinateur en générateur d'interblocages. La contrainte
  fonctionne trop bien, dans le seul mode où on ne peut pas la relâcher.
- **Le « zéro état serveur » de §4 est faux dès qu'on veut un acquittement sérieux.** Exigence n°5
  de la spec MRTR et son avertissement (fetché le 2026-08-15) : les mesures anti-rejeu « **do not by
  themselves guarantee single-use** », et un serveur qui exige la consommation unique « **MUST**
  enforce that invariant **server-side** ». Un acquittement de conflit est précisément un jeton à
  usage unique — sans quoi le même `requestState` rejoué autorise autant d'écritures qu'on veut.
  Il faut donc **réintroduire une table serveur**, c'est-à-dire perdre l'avantage architectural que
  §4 prête à MRTR.
- **Le tour 1 persiste déjà tout.** `rest-handlers.ts:216` crée le thread avant de connaître les
  conflits, puis `runCommonAnnounceFlow` écrit les `layer_firings` et émet les SSE `impact_scored`
  (§6.4 (5)). Rendre le tour 2 idempotent impose de scinder `announceWork` **sur le chemin partagé
  MCP + REST**. C'est structurel, et la fiche le signalait à juste titre en §5.
- **Le contournement REST est total et gratuit.** `POST /api/announce` ne passe par aucun MCP :
  mesuré, 200 threads créés sans une seule session MCP (§6.4 (4)). Un gate MRTR est un verrou sur
  une porte sur deux tant que `src/http/rest-handlers.ts` n'a pas son propre chemin d'acquittement.
- **Le périmètre est verrouillé par la spec, et il exclut la panne qui compte.**
  `InputRequiredResult` n'est autorisé que sur `tools/call`, `resources/read` et `prompts/get` —
  « Servers **MUST NOT** send `InputRequiredResult` responses on any other client requests ». Donc
  si l'agent n'appelle jamais `announce_work`, MRTR ne se déclenche jamais. Il ne durcit qu'un cas
  que [`C06`](C06-tool-search-defer-loading.md) rend certes majoritaire (le champ `instructions`
  fait annoncer l'agent de façon fiable là où l'absence d'`instructions` donne 0 annonce) — mais il
  ne corrige pas, et ne peut pas corriger, l'agent qui n'annonce pas.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | **Le mécanisme marche, et mieux que la fiche ne l'espérait** : le shim legacy du SDK v2 rend `inputRequired` joignable par Claude Code **2.1.233 aujourd'hui**, sur le transport que [`A02`](A02-mcp-sdk-typescript-v2.md) vient d'adopter, et c'est le seul des quatre mécanismes testés où l'acquittement **échappe au modèle**. Mais la même mesure montre pourquoi on ne peut pas l'adopter maintenant : en mode non interactif — essaim, CI, `claude -p`, le profil d'usage central du projet — le client répond **`{"action":"cancel"}`** et **aucun chemin de forçage n'existe**. Le gate ne bloque pas l'agent distrait : il bloque l'agent non surveillé, définitivement. |
| **Issue / PR** | — (aucune : le préalable est [#286](https://github.com/swoofer/mcp-coordinator/issues/286), pas cette fiche) |
| **Jalon visé** | Réveil conditionnel, voir §7.2 |

### 7.1 La réponse à la question de §6.1

La question opposait « faire du conflit un `InputRequiredResult` bloquant » à « le vrai levier est
ailleurs, parce que le tour 2 n'est jamais garanti ». **Le second terme est faux, le premier est
vrai — et c'est précisément le problème.**

- *« Le tour 2 ne peut jamais être garanti »* : exact au sens de la spec (exigence serveur n°8,
  « Servers **MUST NOT** assume that clients will fulfill … or retry »), mais **sans portée
  pratique** ici. Mesuré : `autoFulfill` vaut `true` par défaut côté client v2, et sur l'ère 2025
  c'est le **serveur** qui pilote le rendez-vous via le shim. Le tour 2 a eu lieu dans **9 essais
  sur 9**.
- *« Un `InputRequiredResult` bloquant »* : ça marche, et ça bloque pour de bon. **Trop bien.** Le
  client répond `cancel` sans consulter le modèle, et l'agent non surveillé n'a aucun recours.
  Ajouter un recours (un paramètre `force` que le modèle remplit) **rendrait le mécanisme identique
  à `isError: true`** — c'est-à-dire supprimerait la seule chose qui le distingue.

**C'est la tension à trancher, et elle n'est pas technique :** *que doit faire un agent non
surveillé qui rencontre un conflit `warning` ?* Tant que le projet n'a pas répondu à ça, adopter
MRTR revient à choisir « il s'arrête définitivement » sans l'avoir décidé. Le challenge produit donc
une question de produit, pas un feu vert.

Deuxième constat de cadrage : **le levier n'est pas là où §4 le place.** MRTR ne se déclenche que
sur `tools/call` — la spec l'interdit ailleurs (« **MUST NOT** … on any other client requests »).
Il ne peut donc rien contre l'agent qui n'annonce pas. C'est
[`C06`](C06-tool-search-defer-loading.md) (le champ `instructions`) qui fait annoncer, et
[`C01`](C01-hook-mcp-tool-gate.md) qui peut bloquer une écriture sans coopération. MRTR se place
**après** eux, pas à leur place.

### 7.2 Conditions de réveil

| # | Condition | Pourquoi |
|---|---|---|
| 1 | **[#286](https://github.com/swoofer/mcp-coordinator/issues/286) est mergée** (migration vers `@modelcontextprotocol/server@2`) | Préalable strict : `inputRequired` et son shim n'existent que sur la ligne v2. Sans elle, rien de tout ceci n'est atteignable. |
| 2 | **Le projet a tranché : que fait un agent non surveillé face à un conflit `warning` ?** | C'est la vraie question ouverte (§7.1). Trois réponses possibles — il s'arrête (MRTR tel quel), il force (MRTR devient `isError`), ou le gate ne s'arme qu'en mode interactif (il faut alors détecter le mode, ce qui n'est pas exposé). **🔧 Corrigé le 2026-08-15 par le challenge [`A07`](A07-elicitation.md) §6.4 (1 bis) : l'affirmation « aucun chemin de forçage n'existe » était fausse.** Un hook `Elicitation` répond `{"action":"accept","content":{…}}` à la place de l'humain — mesuré 3/3 en `claude -p`. Une quatrième réponse existe donc : **l'opérateur pré-tranche par un hook**. Nuance : ce hook est écrit par l'utilisateur, pas par nous — le garde-fou reste à géométrie variable. |
| 3 | **Mesurer le mode interactif** — Claude Code avec un humain, face au dialogue d'élicitation | La seule lacune de mesure de ce challenge (§6.4 (9)). C'est le mode où MRTR donnerait sa pleine valeur, et il n'a pas été éprouvé. |

### 7.3 Ce qui est écarté explicitement, et pourquoi

- **Le `input_required` fabriqué à la main dans un résultat d'ère 2025** — écarté. Il « marche »
  (le schéma `Result` du SDK v1.30.0 est un `z.looseObject`, donc les champs inconnus passent) mais
  c'est le **modèle** qui lit le JSON et décide : 1 passage en force sur 3 sous pression, contre 0
  pour le shim. Fiabilité inférieure, propriété perdue, dette immédiate.
- **Le volet dépréciation (Roots / Sampling / Logging, OpenTelemetry)** — écarté, YAGNI confirmé :
  zéro occurrence d'`elicit`, `sampling`, `createMessage`, `roots/list`, `ListRoots` dans `src/`,
  `cli/`, `sdk/src/`. Rien à migrer. Fenêtre de retrait au plus tôt le 2027-07-28.
- **L'extension `io.modelcontextprotocol/tasks`** comme voie alternative — écartée : les symboles
  restent importables en v2 mais portent `@deprecated … with no SDK runtime; kept importable for
  interoperability only`. La voie est morte.

### 7.4 Corrections apportées à la fiche par ce challenge

1. **La §0 est périmée sur son point central.** Elle déclare la boucle MRTR **non exécutable ici**
   (« aucun SDK ni client ne parle `2026-07-28` »). Faux depuis le 2026-07-27 : le SDK v2
   l'implémente, la boucle a tourné, et le **shim legacy** la rend même joignable en ère 2025.
   La testabilité passe de ⚠️ **partielle** à ✅ pour le cœur de la fiche.
2. **§4 « `requestState` porte le contexte sans table serveur » est faux** pour un acquittement de
   conflit : la spec exige explicitement une garantie d'usage unique **côté serveur**, que le
   scellement ne fournit pas.
3. **§4 « rien n'oblige la boucle d'agent à les lire » est trop fort.** Mesuré : le conflit rendu en
   texte simple bloque déjà l'agent 6/6, y compris sous pression. Le bénéfice de MRTR n'est pas
   « faire lire », c'est « retirer au modèle le droit de s'auto-acquitter ».
4. **§2 divergence 3 est périmée** : `io.modelcontextprotocol/tasks` est présentée comme une
   alternative vivante ; elle est sans runtime en v2 (voir §7.3).
5. **Le contre-argument « effort disproportionné, `isError` fait aussi bien » doit être nuancé, pas
   supprimé** : même résultat observé, propriété différente (§6.5).
6. **Une erreur commise pendant ce challenge, corrigée par la passe adversariale puis par
   l'expérience** : j'avais conclu que Claude Code ne pouvait pas recevoir d'`input_required` parce
   qu'il négocie `2025-11-25`. Le shim legacy le dément. La sous-section fautive est conservée
   barrée en §6.4 (3), parce que c'est exactement le raccourci que la fiche pouvait induire.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Vérification des faits : §2 exacte contre la spec ; SDK 1.30.0 sans MRTR ; §5 (15 fichiers, tous numéros) juste ; divergence 4 renversée. |
| 2026-08-14 | Fiche créée par la veille plateforme. Fusion de 5 fiches brutes ; 5 divergences entre chercheurs signalées en §2 ; §5 vérifiée contre le code réel (v2.0.1, `@modelcontextprotocol/sdk ^1.29.0`). |
| 2026-08-15 | Challenge. §0 périmée : la boucle MRTR **est** exécutable (SDK v2) — testabilité ⚠️ → ✅. 24 lancements de Claude Code 2.1.233 + 3 PoC SDK. Le shim legacy rend `inputRequired` joignable en ère 2025, sur le transport retenu par `A02` — donc `A02` **débloque** `A03` au lieu de la bloquer. **Verdict : reporter**, sur une question de produit et non un blocage technique : `claude -p` répond `{"action":"cancel"}`, sans chemin de forçage pour un agent non surveillé. Deux passes adversariales, dont une a renversé ma conclusion. |
