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
| **Testabilité** | ⚠️ partielle — aucun SDK ni client ne parle `2026-07-28` |
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Proposition de la veille — à valider ou remplacer pendant le challenge.>

> ⚠️ La boucle MRTR complète n'est pas exécutable ici : ni le SDK TypeScript (1.30.0, plafonné à `2025-11-25`) ni Claude Code ne parlent la révision `2026-07-28`. Seul un `input_required` fabriqué à la main, la relecture du chemin REST et le scénario TTL sont testables localement.

- [ ] Vérifier dans `node_modules/@modelcontextprotocol/sdk` (v1.29.0) si `InputRequiredResult` / `resultType` / `inputRequests` existent dans `types.js` et `types.d.ts`. Si absents : la fiche s'arrête là, retour en veille jusqu'à la version qui les expose.
- [ ] Vérifier côté client : lancer Claude Code contre le serveur en stdio (`pnpm dev:stdio`) et observer si un `tools/call` retournant un `resultType: "input_required"` fabriqué à la main déclenche une relance avec un `id` JSON-RPC différent, ou une erreur de parsing.
- [ ] Prototyper le *gate* sur une branche : `announce_work` renvoie `input_required` quand `conflicts` contient au moins une `severity: "warning"`, avec `requestState` = HMAC des `{org, agent_id, thread_id, hash(params)}` + TTL 60 s. Mesurer le comportement du tour 2 sur `runCommonAnnounceFlow` — vérifier l'absence de doublons dans `layer_firings` et dans les événements SSE `impact_scored`.
- [ ] Rejouer le même scénario via le chemin REST (`src/http/rest-handlers.ts`) pour établir si le *gate* est contournable, et à quel coût on le referme.
- [ ] Tester le cas « le client ne revient jamais » : quel est l'état du thread créé (ou non créé) au bout du TTL, et est-ce que le dashboard affiche un thread fantôme.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Le blocage n'est pas garanti par la spec.** *« Servers MUST NOT assume that clients will fulfill the inputRequests or retry the original request. »* Un client conforme mais paresseux traite `input_required` comme un échec et passe à autre chose. On aurait alors payé le coût d'une architecture à deux tours pour un garde-fou toujours contournable — le même « garde-fou fantôme » que l'audit de juillet 2026 reprochait déjà au projet, avec plus de code.
- **Dépendance SDK non vérifiée.** Le projet est sur `@modelcontextprotocol/sdk ^1.29.0` et rien ne prouve aujourd'hui que ce SDK, ni le client Claude Code, implémentent MRTR. Une implémentation « à la main » par-dessus `McpServer.tool()` (dont la signature de retour est typée `CallToolResult`) serait un contournement du SDK, à ré-écrire à chaque montée de version.
- **Deux chemins de code, pas un.** `src/tools/*.ts` utilise `McpServer.tool()` ; `cli/channel.ts` utilise l'API bas niveau `Server` + `setRequestHandler`. Et `src/http/rest-handlers.ts` expose l'annonce hors MCP. Un *gate* MRTR n'est réellement un *gate* que s'il est répliqué sur les trois — sinon c'est un ralentisseur sur une seule voie.
- **Effort disproportionné pour un problème contournable autrement.** Le même effet (« l'agent doit acquitter le conflit ») s'obtient sans MRTR : renvoyer `isError: true` sur `announce_work` en cas de conflit `warning`, et exiger un paramètre `acknowledge_conflicts: string[]` au second appel. Zéro dépendance à la révision 2026-07-28, zéro `requestState`, zéro cryptographie nouvelle. C'est moins élégant et non normatif, mais c'est du code que le projet sait déjà écrire et tester.
- **Nouvelle surface de sécurité.** `requestState` est par construction une entrée contrôlée par l'attaquant qui influe sur l'autorisation. Il faut HMAC/AEAD, principal encodé, TTL, empreinte de la requête d'origine — pour un projet multi-tenant déjà lourd côté `src/auth/` et `src/security/`, c'est un nouveau secret à faire tourner et un nouveau vecteur à auditer.
- **Complexité pour l'auto-hébergeur.** Un serveur qui renvoie parfois des résultats « incomplets » est plus difficile à diagnostiquer. `cli/doctor.ts` devra apprendre à distinguer un `input_required` légitime d'une panne, sous peine de faux positifs dans le diagnostic.
- **YAGNI partiel sur le volet dépréciation.** Le projet n'utilise ni Roots, ni Sampling, ni Logging MCP (grep vide). La partie `threat` de cette fiche est déjà neutralisée par l'architecture existante — elle ne justifie à elle seule aucun travail, et surtout pas la migration OpenTelemetry, qui est un chantier indépendant.
- **Timing.** Fenêtre de retrait des primitives dépréciées : au plus tôt la première révision publiée le ou après le 2027-07-28. Rien ne casse avant. Attendre que le SDK Tier 1 et Claude Code implémentent MRTR coûte moins que d'être le premier à l'implémenter contre une cible mouvante.

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
| 2026-08-14 | Vérification des faits : §2 exacte contre la spec ; SDK 1.30.0 sans MRTR ; §5 (15 fichiers, tous numéros) juste ; divergence 4 renversée. |
| 2026-08-14 | Fiche créée par la veille plateforme. Fusion de 5 fiches brutes ; 5 divergences entre chercheurs signalées en §2 ; §5 vérifiée contre le code réel (v2.0.1, `@modelcontextprotocol/sdk ^1.29.0`). |
