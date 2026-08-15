# A07 — Elicitation (modes `form` et `url`) : arbitrer un conflit sans passer par un thread

| Champ | Valeur |
|---|---|
| **ID** | `elicitation` |
| **Surface** | mcp-spec · claude-code · agent-sdk |
| **Statut** | GA (mode `form`) · mode `url` : introduit en 2025-11-25, la spec 2026-07-28 le marque encore comme « new feature, design may change » |
| **Disponible depuis** | `form` : MCP 2025-06-18 · `url` : MCP 2025-11-25 (SEP-1036) · Claude Code ≈ v2.1.76 (mars 2026) · hooks + `SDKElicitationCompleteMessage` : Agent SDK 0.2.76 · refonte MRTR : MCP 2026-07-28 |
| **Tier** | ~~T1-incontournable~~ **T2** — déclassée au challenge du 2026-08-15 : le volet `url` est refusé (spec `MUST NOT`), le volet `form` est reporté sur la même question produit qu'`A03` |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | medium |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — mode `url` 2026-07-28 absent du SDK installé |
| **Statut du challenge** | ✅ **tranché** — 2026-08-15 : `refuser` le volet `url`, `reporter` le volet `form` (§7) |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**
- Statut d'en-tête nuancé : `form` est GA, mais la spec 2026-07-28 marque toujours le mode `url` comme « new feature… may change ».
- §2 hook `ElicitationResult` : la doc (`hooks.md`) liste `mcp_server_name`, `tool_name`, `elicitation_message` **et** `user_response`, pas seulement `user_response`. Ajout aussi des champs `hookSpecificOutput.decision` (`deny`/`allow` pour `Elicitation`, `accept`/`decline` pour `ElicitationResult`).
- §2 : `mode` est **optionnel** en mode form (défaut `"form"`) d'après la spec 2026-07-28 — la fiche le présentait comme requis.
- §2 marqueur `requestState` / `inputResponses` **tranché** : les deux existent bien dans la spec 2026-07-28 (mécanisme MRTR — `InputRequiredResult.inputRequests` / `inputResponses`, `requestState` échangé sur le retry), et sont bien **absents** du SDK 1.30.0. La contradiction relevée par la fiche est donc confirmée, pas une erreur de veille.
- §2 marqueur `onElicitation` **tranché** : la signature est explicitement documentée dans `agent-sdk/typescript.md`, avec la phrase « Called when an MCP server requests user input and no hook handles it first » et « When not provided, unhandled elicitation requests are declined automatically » — la priorité des hooks et le decline automatique sont confirmés par la doc.
- §5 : `announce_work` va de la l. 36 à la l. 187 (la fiche disait 186).

**Faits revérifiés sans changement :** `elicitInput` à `server/index.d.ts:158` ✓ ; `createElicitationCompletionNotifier` à `:167` ✓ ; `ElicitRequestURLParamsSchema` (`types.d.ts:5067`) exige bien `elicitationId: z.ZodString` ✓ ; `requestState`/`inputResponses` introuvables dans `types.d.ts` ✓ ; `grep -ri elicit src/ cli/ sdk/` ne retourne rien ✓ ; noms de hooks `Elicitation` / `ElicitationResult` et les 4 matchers `Notification` (`elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`) ✓ ; « un appel bloqué sur un dialogue d'élicitation n'est pas mis en arrière-plan » est littéralement dans `mcp.md` ✓ ; interdiction des secrets en mode `form` ✓ ; `createMcpServer` l. 207 ✓ ; 26 outils via 6 modules (4+11+3+3+3+2) ✓ ; `conflictDetector.detect()` l. 105 ✓ ; `conflict-detector.ts` n'émet que `warning`/`info` ✓ ; `runCommonAnnounceFlow` partagé avec `src/http/rest-handlers.ts:233` ✓ ; `device-flow.ts:84-85` et `:190-191` ✓ ; `serve-http.ts:583-601` + `safeJoinUnderRoot` ✓ ; `cli/channel.ts` l. 298 / 340 / 350 ✓ ; `@modelcontextprotocol/sdk` `^1.29.0`, 1.30.0 installé ✓ ; `dashboard/public/` ne contient aucune page d'arbitrage ✓.

**Marqueurs `(à vérifier)` restants :** un seul, requalifié en `(non vérifiable)` — les types `ElicitationRequest` / `ElicitationResult` de l'Agent SDK ne sont définis nulle part dans la doc publique et le package `@anthropic-ai/claude-agent-sdk` n'est **pas** installé dans ce repo, donc aucun `.d.ts` à lire ici.

**Testabilité :** ⚠️ partielle
Le mode `form` est entièrement testable ici : le SDK 1.30.0 installé expose `elicitInput`, Claude Code est présent, le daemon tourne en local — on peut brancher un `elicitInput({ mode: "form", … })` derrière un flag dans `announce_work` et observer le dialogue. Ce qui ne se teste pas : le mode `url` dans sa forme 2026-07-28 (le SDK installé impose encore `elicitationId` et ignore `requestState`/`inputResponses`, donc on testerait la forme 2025-11-25, pas celle de la spec courante), et le chemin Agent SDK headless (`onElicitation`, hooks, `SDKElicitationCompleteMessage`) qui exigerait d'installer `@anthropic-ai/claude-agent-sdk`, absent du repo.

## 1. Ce que c'est

L'élicitation permet à un serveur MCP de demander une information à l'utilisateur **pendant** le traitement d'un appel d'outil, au lieu de renvoyer un résultat et d'espérer que le modèle relance. Le client déclare la capacité dans `_meta['io.modelcontextprotocol/clientCapabilities'].elicitation`, avec les sous-clés `form` et/ou `url` (objet vide = `form` seul, pour compatibilité). Le serveur émet alors une requête `elicitation/create` portant `mode`, `message`, et selon le mode soit un `requestedSchema` (JSON Schema **plat**, types primitifs uniquement : `string`, `number`, `integer`, `boolean`, enums via `enum`/`oneOf`+`const`+`title`, `default` supporté partout), soit une `url`. Le client répond un `ElicitResult` à trois actions : `accept` (avec `content`), `decline`, `cancel`. La spec interdit de demander un secret en mode `form` — le mode `url` est obligatoire pour ça, ce qui en fait le chemin propre pour un device flow OAuth.

Côté Claude Code, le dialogue s'affiche automatiquement, sans configuration : un appel d'outil bloqué sur une élicitation n'est **pas** mis en arrière-plan tant que le dialogue est ouvert. Côté Agent SDK, le flux est programmable : un callback `onElicitation` et deux hooks (`Elicitation`, `ElicitationResult`) permettent de répondre sans humain. Point de conception critique relevé par la vérification : **les hooks ont la priorité sur `onElicitation`, et si ni hook ni callback ne traite la requête, elle est automatiquement `decline`** — le silence vaut refus.

## 2. Surface d'API exacte

```
# Spec MCP
elicitation/create
  params.mode              : "form" | "url"  (optionnel en mode form : défaut "form")
  params.message           : string
  params.requestedSchema   : JSON Schema plat (mode form)
  params.url               : string (mode url)
ElicitRequest / ElicitResult
  result.action            : "accept" | "decline" | "cancel"
  result.content           : objet plat (mode form, action=accept)
capabilities.elicitation.form
capabilities.elicitation.url
_meta['io.modelcontextprotocol/clientCapabilities'].elicitation

# Claude Code — hooks
Elicitation        (input : mcp_server_name, tool_name, elicitation_message ; matcher = nom de serveur MCP ;
                    exit 2 = refuse ; alternative JSON : hookSpecificOutput.decision = "deny" | "allow")
ElicitationResult  (input : mcp_server_name, tool_name, elicitation_message, user_response ;
                    exit 2 = bloque la réponse (action devient decline) ;
                    alternative JSON : hookSpecificOutput.decision = "accept" | "decline")
# Sur les deux événements, un hook sortant en code 2 voit son hookSpecificOutput ignoré.
Notification matchers : elicitation_dialog | elicitation_url_dialog | elicitation_complete | elicitation_response

# Agent SDK (TypeScript)
onElicitation: (request: ElicitationRequest, options: { signal: AbortSignal }) => Promise<ElicitationResult>
SDKElicitationCompleteMessage
# En session SDK headless, seuls elicitation_complete et elicitation_response se déclenchent.
```

Côté serveur, l'API concrète est déjà présente dans le SDK **installé dans ce repo** (`@modelcontextprotocol/sdk` 1.30.0, épinglé `^1.29.0`) —
`node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts:158` :

```ts
elicitInput(
  params: ElicitRequestFormParams | ElicitRequestURLParams,
  options?: RequestOptions,
): Promise<ElicitResult>;
```

Payload minimal, mode `form`, pour un arbitrage de conflit :

```ts
await server.server.elicitInput({
  mode: "form",
  message: "agent-B a annoncé src/auth.ts il y a 40 s. Comment procéder ?",
  requestedSchema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        title: "Décision",
        oneOf: [
          { const: "proceed", title: "Continuer quand même" },
          { const: "wait",    title: "Attendre la résolution du thread" },
          { const: "consult", title: "Ouvrir une consultation" },
        ],
        default: "consult",
      },
    },
    required: ["decision"],
  },
});
```

**Contradiction à signaler entre les sources du bundle.** Le chercheur `mcp-spec` affirme que `notifications/elicitation/complete` et le champ `elicitationId` (introduits en 2025-11-25) sont **supprimés** en 2026-07-28, la corrélation passant désormais par `requestState` / les Multi Round-Trip Requests. Or le SDK 1.30.0 réellement installé ici expose toujours `createElicitationCompletionNotifier(elicitationId, …)` (`server/index.d.ts:167`) et son `ElicitRequestURLParamsSchema` rend **`elicitationId` obligatoire** en mode `url` (`types.d.ts`, bloc `ElicitRequestURLParamsSchema`). Autrement dit : le mode `url` implémentable aujourd'hui avec nos dépendances suit la forme 2025-11-25, pas la forme 2026-07-28. Toute implémentation écrite maintenant devra être retouchée à la montée de version qui apportera MRTR. **Vérification 2026-08-14 :** la contradiction est réelle et tranchée dans les deux sens — la spec 2026-07-28 ne liste plus `elicitationId` dans les paramètres du mode `url` (seul `url` s'ajoute à `mode`/`message`) et fait passer la corrélation par MRTR (`InputRequiredResult.inputRequests`, `inputResponses` sur le retry, `requestState` échangé) ; le SDK 1.30.0 installé, lui, exige toujours `elicitationId: z.ZodString` (`types.d.ts:5067`, `ElicitRequestURLParamsSchema`) et ne connaît ni `requestState` ni `inputResponses`.

Les types `ElicitationRequest` / `ElicitationResult` de l'Agent SDK sont référencés dans `typescript.md` mais **non définis** dans la doc publique, et `@anthropic-ai/claude-agent-sdk` n'est pas installé dans ce repo : schéma exact `(non vérifiable — types non documentés, package absent du repo)`. En revanche `onElicitation` **est** documenté dans `typescript.md`, avec la signature ci-dessus, la priorité des hooks (« called when… no hook handles it first ») et le decline automatique (« when not provided, unhandled elicitation requests are declined automatically »).

## 3. Sources

- https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation.md
- https://modelcontextprotocol.io/specification/2025-11-25/changelog
- https://modelcontextprotocol.io/specification/2025-06-18/changelog
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://code.claude.com/docs/en/mcp.md
- https://code.claude.com/docs/en/hooks.md
- https://code.claude.com/docs/en/agent-sdk/typescript.md
- https://code.claude.com/docs/en/agent-sdk/hooks.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.** Aujourd'hui la détection de conflit est purement consultative : `ConflictDetector.detect()` (`src/conflict-detector.ts`) ne produit que des `ConflictReport` de `severity: "warning" | "info"`, sérialisés dans la colonne `threads.conflicts` et renvoyés dans le texte de réponse de `announce_work`. Rien ne bloque, rien ne demande d'arbitrage : c'est au modèle de décider s'il lit le rapport, et à l'humain de regarder le dashboard. L'élicitation ajoute un point d'arrêt synchrone au moment exact où le conflit est détecté — un formulaire à trois choix plutôt qu'un paragraphe JSON que le modèle peut ignorer. Le bénéficiaire direct est le mainteneur qui pilote une escouade de 3 à 6 agents et qui, actuellement, découvre le chevauchement après coup dans le journal de threads.

Le mode `url` a une seconde cible, plus immédiate : `src/auth/device-flow.ts` implémente déjà RFC 8628 avec `verification_uri` / `verification_uri_complete` (`device-flow.ts:84-85`, `:190-191`), et `src/serve-http.ts:583` sert déjà `/dashboard` en statique. Une élicitation `mode: "url"` pointant sur `verification_uri_complete` remplacerait l'instruction en texte libre « ouvre cette URL et tape ce code » par un dialogue natif — sans faire transiter le code par le contexte du modèle, ce que la spec interdit précisément en mode `form`.

Aucun code n'est supprimé par cette feature : elle ajoute un canal, elle n'en remplace aucun. C'est une opportunité, pas un remplacement de code maison.

**Risque si on ne fait rien :** aucun. Le protocole n'oblige à rien, et `capabilities.elicitation` est optionnelle des deux côtés.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/server-setup.ts` | `createMcpServer()` (l. 207) instancie le `McpServer` et enregistre les 26 outils via 6 modules. `server.server.elicitInput()` n'est aujourd'hui référencé nulle part — `grep -ri elicit src/ cli/ sdk/` ne retourne **rien**. C'est ici qu'on exposerait un helper partagé (ou dans `CoordinatorServices`). |
| `src/tools/consultation-tools.ts` | `announce_work` (l. 36-187) : appelle `conflictDetector.detect()` (l. 105) **avant** `consultation.announceWork()`. C'est le seul endroit du code où le conflit est connu avant que la ligne `threads` soit écrite — le point d'insertion naturel d'une élicitation bloquante. |
| `src/conflict-detector.ts` | Produit `ConflictReport[]` avec `severity: "warning" \| "info"` uniquement. Adopter l'élicitation impose d'ajouter une notion de « conflit bloquant » qui n'existe pas dans le type actuel (`src/types.ts`). |
| `src/announce-workflow.ts` | `runCommonAnnounceFlow()` est partagé entre le tool MCP et l'endpoint REST de `serve-http.ts`. L'élicitation n'existe **que** sur le chemin MCP : le chemin REST resterait non bloquant, ce qui crée deux comportements divergents pour la même action. |
| `src/tools/files-tools.ts` | `check_file_conflict` est déclaré `readOnlyHint: true` et ne fait que renvoyer un JSON. Le passer en outil interactif change son contrat d'annotation. |
| `src/auth/device-flow.ts` | RFC 8628 déjà implémenté ; `verification_uri` + `verification_uri_complete` sont les candidats directs d'un `elicitation/create` `mode: "url"`. |
| `src/serve-http.ts` | Sert `/dashboard` depuis `dashboard/public/` (l. 583-601, avec `safeJoinUnderRoot` contre le path traversal). Un écran d'arbitrage servi ici serait la cible d'une élicitation `url`. |
| `dashboard/public/index.html`, `dashboard.js` | Le dashboard existant n'a aucune page d'arbitrage ; le mode `url` en exigerait une, authentifiée. |
| `cli/channel.ts` | Serveur MCP stdio séparé, construit sur le `Server` bas-niveau (l. 298) avec `setRequestHandler(ListToolsRequestSchema…)` (l. 340) et `CallToolRequestSchema` (l. 350). Il expose un seul outil, `post_to_thread`. Il pourrait éliciter, mais il n'a **pas** de contexte de conflit — celui-ci vit dans le daemon, atteint par MQTT. |
| `src/sse-emitter.ts`, `src/mqtt-bridge.ts` | Canaux d'interruption existants (SSE vers le dashboard, MQTT vers les agents). L'élicitation serait un troisième canal, avec une sémantique différente (bloquant, synchrone, une seule session). |
| `package.json` | `@modelcontextprotocol/sdk` épinglé `^1.29.0`, 1.30.0 installé — `elicitInput` est déjà disponible, aucune montée de dépendance requise pour un PoC. |
| `docs/ARCHITECTURE.md` | À mettre à jour si un point d'arrêt synchrone entre dans le flux `announce_work`. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> `elicitation/create` ne peut remonter que dans la session MCP qui a déclenché l'appel d'outil : `announce_work` appelé par l'agent A ne peut donc éliciter que A, jamais l'agent B concurrent dont on veut arracher la décision. Faut-il alors (a) éliciter l'annonceur A en mode `form` pour qu'il tranche lui-même son conflit avant l'écriture du thread, (b) passer en mode `url` vers un écran d'arbitrage servi par `/dashboard` pour que l'humain tranche, ou (c) renoncer à l'élicitation pour la coordination et garder MQTT/SSE comme seul canal d'interruption vers B, en réservant l'élicitation au seul device flow OAuth ?

### 6.2 Hypothèse

*Pré-enregistré le 2026-08-15, AVANT toute exécution propre à cette fiche.*

> 🔧 **Trois faits déjà mesurés aujourd'hui, sur cette même surface, par le challenge
> [`A03`](A03-mrtr-input-required.md) (§6.4 (7) et (8)) :**
> 1. Claude Code 2.1.233 **déclare bien** `elicitation: {}` dans ses `clientCapabilities`
>    (capture au proxy, [`A01`](A01-mcp-2026-07-28-stateless.md) §6.4 (5 bis)).
> 2. Le **shim legacy** du SDK v2 émet de vraies requêtes `elicitation/create` serveur→client sur
>    une connexion d'ère 2025 — le canal fonctionne de bout en bout, mesuré.
> 3. **En `claude -p`, la réponse est `{"action":"cancel"}`** — le client annule sans consulter le
>    modèle. 3 exécutions sur 3.
>
> Le point 3 est le fait central de cette fiche, et il est déjà acquis. Ce challenge doit donc
> porter sur ce qu'`A03` n'a pas couvert : le **cas dégradé** (client sans la capacité), le
> **mode `url`**, et surtout le **point d'insertion réel** du lot de consolation OAuth.

**Hypothèse.** Les options (a) et (b) de §6.1 sont mortes avant d'être instruites : (a) parce que
l'agent non surveillé annule, (b) parce qu'il n'existe aucune page d'arbitrage et que la servir
suppose une accessibilité réseau qui n'est pas acquise. Je m'attends à ce que le verdict se joue sur
l'option (c) — et surtout sur le « lot de consolation » que §6.5 présente comme *« la seule partie
de cette fiche qui mérite d'être adoptée »* : le mode `url` sur le device flow OAuth. **Je m'attends
à ce que celui-là s'effondre aussi**, pour une raison que la fiche ne voit pas : une élicitation ne
peut remonter que **dans une session MCP en cours de traitement d'un appel d'outil**, et je doute
que le device flow soit jamais déclenché depuis un handler d'outil MCP.

**Critères de refus (ce qui me ferait conclure « non bénéfique maintenant ») :**

- **A07-R1 — l'agent non surveillé annule.** Déjà mesuré en `A03` : `claude -p` répond `cancel`.
  Si un `announce_work` élicitant traite `cancel` comme « ne pas continuer », toute escouade
  headless se bloque. → tue l'option (a) pour le profil d'usage central.
- **A07-R2 — le cas dégradé fige.** Si un client qui **ne déclare pas** `capabilities.elicitation`
  voit l'appel **attendre** au lieu de décliner immédiatement, alors ajouter une élicitation gèle
  tous les clients non-Claude-Code. Seuil : toute attente > 2 s est disqualifiante.
- **A07-R3 — le lot de consolation n'a pas de point d'insertion.** Si `src/auth/device-flow.ts`
  n'est **jamais** atteint depuis un handler d'outil MCP, il n'existe aucune session dans laquelle
  éliciter, et le mode `url` sur OAuth est inapplicable — quel que soit son intérêt théorique.
- **A07-R4 — toute implémentation `url` est jetable.** Si le SDK 1.30.0 impose `elicitationId`
  alors que la spec 2026-07-28 l'a retiré, le code écrit aujourd'hui est à réécrire à la bump.
- **A07-R5 — changement de philosophie non demandé.** Si passer d'un modèle consultatif
  (`warning`/`info`) à un gate synchrone impose de diverger entre le chemin MCP et le chemin REST
  — que `runCommonAnnounceFlow` a précisément été extrait pour unifier — c'est un choix produit,
  pas une feature.

### 6.3 Protocole de vérification

*Amendé en session le 2026-08-15. Le point 2 de la veille (PoC `form` derrière un flag) est
**remplacé** : `A03` l'a déjà exécuté de bout en bout, avec un vrai `elicitation/create` servi par
le shim et une mesure du comportement client. Le refaire ici serait redondant. Deux points sont
ajoutés — (3 bis) et (6) — parce qu'ils portent les critères que la veille ne pouvait pas anticiper.*

> ⚠️ Reste non exécutable : le mode `url` dans sa forme **2026-07-28** (le SDK 1.30.0 impose encore
> `elicitationId`), et le chemin **Agent SDK headless** (`@anthropic-ai/claude-agent-sdk` n'est pas
> installé). Ces deux points seront traités par lecture de types et de doc, et marqués comme tels.

- [ ] **(1)** Figer la signature réelle du SDK installé : `elicitInput`, `ElicitRequestURLParams`,
      présence ou non de `requestState` / `inputResponses`. → A07-R4.
- [ ] **(2)** *(déjà exécuté en [`A03`](A03-mrtr-input-required.md))* comportement de Claude Code
      face à une vraie élicitation. → A07-R1.
- [ ] **(3)** **Cas dégradé** : un client MCP qui ne déclare **pas** `capabilities.elicitation`.
      L'appel décline-t-il immédiatement, ou attend-il ? → A07-R2, le point le plus dangereux.
- [ ] **(3 bis) NOUVEAU** : et un client qui **déclare** la capacité mais **n'installe aucun
      handler** ? C'est le cas d'un intégrateur distrait, et il est plus probable que le précédent.
- [ ] **(4)** Coût du blocage : pendant qu'une élicitation est en vol, les autres sessions MCP, le
      SSE et le broker restent-ils servis ?
- [ ] **(5)** Mode `url` : forme réellement émise par le SDK 1.30.0, et écart avec la spec courante.
- [ ] **(6) NOUVEAU — le lot de consolation a-t-il un point d'insertion ?** Recenser tous les
      appelants de `src/auth/device-flow.ts` : le device flow est-il jamais déclenché depuis un
      handler d'outil MCP ? → A07-R3. **C'est ce point qui décide du verdict**, puisque §6.5
      désigne ce volet comme le seul adoptable.

- [ ] Figer la signature réelle : relire `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts` et `types.d.ts` de la version épinglée, confirmer si `elicitationId` est requis en mode `url` et si `requestState` / `inputResponses` existent (ils sont absents en 1.30.0).
- [ ] PoC derrière un flag env (`COORDINATOR_ELICIT=1`) : brancher `server.server.elicitInput({ mode: "form", … })` dans `announce_work` quand `conflicts.length > 0`, lancer Claude Code contre le daemon en stdio, observer si le dialogue s'affiche et quelle `action` revient.
- [ ] Cas dégradé : appeler `announce_work` depuis un client MCP qui **ne** déclare **pas** `capabilities.elicitation` (SDK headless sans hook ni `onElicitation`, ou client tiers). Vérifier que l'appel décline immédiatement et n'attend pas — sinon le flux se fige pour tout non-Claude-Code.
- [ ] Mesurer le coût du blocage : pendant qu'un dialogue est ouvert, vérifier que les autres sessions MCP, le flux SSE et le broker MQTT restent servis, et qu'un `cancel` laisse la ligne `threads` cohérente (pas de thread orphelin, `layer_firings` non pollué).
- [ ] Mode `url` : pointer une élicitation sur `verification_uri_complete` de `src/auth/device-flow.ts`, confirmer que l'URL est atteignable depuis la machine du client et qu'aucun secret ne transite par une query string exposée au contexte du modèle.

### 6.4 Résultat observé

*Session du 2026-08-15, Windows 11 / Node 22.21.0 / Claude Code 2.1.233. Frontière exécuté / lu
au (5).*

---

#### (1) Le canal marche — et l'agent non surveillé l'annule

*Mesuré au challenge [`A03`](A03-mrtr-input-required.md) §6.4 (7) et (8), sur cette même surface.
Repris ici parce que c'est le fait central d'A07.*

- Claude Code 2.1.233 **déclare** `capabilities.elicitation` — capture au proxy :
  `"capabilities":{"roots":{"listChanged":true},"elicitation":{}}`.
- Une vraie requête `elicitation/create` serveur→client lui parvient bien (via le shim legacy du
  SDK v2, sur une connexion d'ère 2025) : le canal est fonctionnel de bout en bout.
- **En `claude -p`, la réponse est `{"conflict_ack":{"action":"cancel"}}` — 3 fois sur 3.** Le
  client annule **sans consulter le modèle**.

> ⚠️ **J'ai d'abord conclu ici que l'option (a) était morte. C'était faux, deux fois** — la passe
> adversariale l'a montré et l'expérience du (1 bis) le confirme. Le paragraphe fautif est conservé
> barré, parce que c'est le raccourci que la fiche invite à prendre.

~~→ **A07-R1 déclenché.** L'option (a) de §6.1 ne peut pas fonctionner pour un agent non surveillé :
il n'y a personne pour trancher, et le client ne demande pas au modèle de le faire. Or essaim, CI et
sessions background sont le profil d'usage central du produit.~~

**Deux erreurs dans ce raisonnement :**

1. **« Essaim, CI et background sont le profil central » est faux pour ce produit.** `README.md:24`
   donne comme persona **n°1 sur 4** : « **A solo dev running 2-3 Claude Code sessions in
   parallel** », et n°2 « A small team where everyone runs their own AI agent on the same repo ».
   Deux personas sur quatre sont des **humains devant un terminal** — exactement ceux que §4 nomme
   comme bénéficiaires directs. Or **100 % de mes mesures sont en `claude -p`**. La lacune est
   nommée en (5).
2. **`cancel` est le défaut sans hook, pas un plafond** — voir (1 bis).

#### (1 bis) 🔴 Un hook `Elicitation` répond à la place de l'humain — mesuré, 3/3

Montage `scratchpad/a07-hook/` : le stub d'élicitation d'`A03`, plus un `.claude/settings.json`
portant un hook qui répond sans humain :

```json
{ "hooks": { "Elicitation": [ { "matcher": "gate", "hooks": [ { "type": "command",
  "command": "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'Elicitation',action:'accept',content:{force:true}}}))\"" } ] } ] } }
```

`claude -p`, 3 exécutions :

```
[hook #1] write_file: OUI | verdict: ECRIT
         reponse elicitation : {"conflict_ack":{"action":"accept","content":{"force":true}}},"ackDecode":{"force":true}
[hook #2] write_file: OUI | verdict: ECRIT   (idem)
[hook #3] write_file: OUI | verdict: ECRIT   (idem)
```

Le `content` du hook **traverse** jusqu'au serveur, `acceptedContent` le décode, l'outil se termine
normalement et l'agent poursuit. → **A07-R1 NON déclenché.**

**Deux conséquences, dont une hors de cette fiche :**

- L'option (a) est **techniquement viable**, en interactif *et* en headless.
- **Correction à apporter à [`A03`](A03-mrtr-input-required.md) :** son §7.2 condition 2 affirme
  qu'« aucun chemin de forçage n'existe » pour un agent non surveillé. **C'est faux** — le hook
  `Elicitation` est ce chemin. Nuance qui compte : ce n'est pas « l'agent tranche », c'est
  « l'opérateur a pré-tranché », et le hook est écrit par l'utilisateur, pas par nous.

---

#### (2) Le cas dégradé ne fige rien — la crainte de §6.3 est infondée

`scratchpad/v1probe/a07-degrade.mjs` — un serveur qui élicite dans `announce_work`, trois clients :

```
=== que fait un serveur qui elicite, selon le client en face ? ===

A. capacite declaree + handler installe    -> 12 ms | ELICIT OK en 10 ms : {"action":"accept","content":{"decision":"wait"}}
B. capacite declaree, AUCUN handler        ->  1 ms | ELICIT ECHEC en 1 ms : McpError — MCP error -32601: Method not found
C. capacite NON declaree (client tiers)    ->  1 ms | ELICIT ECHEC en 0 ms : Error — "Client does not support form elicitation."
```

→ **A07-R2 non déclenché.** Aucun gel : tout échoue en **≤ 1 ms**. Le cas C est même refusé
**côté serveur, avant tout trafic** — le SDK vérifie les capacités déclarées et lève localement.
La crainte de §6.3 (« sinon le flux se fige pour tout non-Claude-Code ») est **infondée**.

**Mais une nuance que la fiche ne voit pas :** le cas B rend un `-32601 Method not found`, qui n'est
**aucune** des trois actions documentées (`accept` / `decline` / `cancel`). Une implémentation
devrait donc traiter **trois** modes d'échec distincts — l'exception locale, l'erreur de protocole,
et le `cancel` — pas seulement « gérer `decline` » comme le suggère §6.5.

---

#### (3) 🔴 Le mode `url` est inutilisable avec le seul client réel du projet

`scratchpad/v1probe/a07-url.mjs` :

```
=== mode url : ce que le SDK 1.30.0 exige, et ce que le client accepte ===

A. url + capabilites {}  (CE QUE CLAUDE CODE ENVOIE)   -> ECHEC en 0 ms : "Client does not support url elicitation."
B. url + capabilites { url: {} }                       -> OK en 1 ms : {"action":"accept"}
C. url SANS elicitationId (forme spec 2026-07-28)      -> ECHEC : MCP error -32603 invalid_union
D. form + capabilites {}                               -> OK en 4 ms : {"action":"accept"}
```

Deux faits, et le premier est décisif :

1. **Claude Code déclare `elicitation: {}` — un objet vide.** Or la spec dit qu'un objet vide vaut
   `form` **seul**, pour compatibilité. Résultat mesuré : une élicitation `mode: "url"` est
   **refusée** face à ce client. Le mode `url` n'est donc pas « une feature à instabilité de
   spec » — il est **indisponible aujourd'hui** avec le seul client que ce projet sert réellement.
2. **La forme de la spec courante n'est pas implémentable** : sans `elicitationId`, le SDK 1.30.0
   rejette en `-32603 invalid_union`. Il n'accepte que la forme **2025-11-25**.
   → **A07-R4 déclenché** : tout code `url` écrit aujourd'hui est à réécrire à la bump.

**Conséquence :** le « lot de consolation » que §6.5 désigne comme *« la seule partie de cette fiche
qui mérite d'être adoptée »* — le mode `url` sur le device flow OAuth — est mort **avant même** la
question de son point d'insertion.

---

#### (4) 🔴 …et il n'a de toute façon aucun point d'insertion

Recensement mécanique du chemin d'appel du device flow, **vérifié ligne à ligne** :

```
$ grep -n "device-flow\.js|dispatchAuthRoutes"  {src,cli,sdk}/**/*.ts
src\http\auth-routes.ts:6    import { handleDeviceAuthorization, handleDeviceApprove } from "../auth/device-flow.js";
src\http\auth-routes.ts:69   export async function dispatchAuthRoutes(
src\serve-http.ts:57         import { dispatchAuthRoutes } from "./http/auth-routes.js";
src\serve-http.ts:569        const handled = await dispatchAuthRoutes(req, res, ctx.phase2Bootstrap.context);
```

`src/auth/device-flow.ts` n'exporte que deux fonctions — `handleDeviceAuthorization` (l.87) et
`handleDeviceApprove` (l.245) — et son **unique** import de production est
`src/http/auth-routes.ts:6`. La chaîne complète :

```
POST /api/auth/oauth/device_authorization  ou  POST /auth/device/approve
  └─ serve-http.ts:569  dispatchAuthRoutes(...)
       └─ serve-http.ts:570  if (handled) return;     <-- COURT-CIRCUITE ICI
            …
            serve-http.ts:740  else if (url === "/mcp")   <-- jamais atteint pour ces routes
```

Et dans l'autre sens : aucun des 6 fichiers de `src/tools/` n'importe `auth-routes.js`,
`serve-http.js` ni `device-flow.js`. Leur seul lien vers l'auth est
`import type { AuthClaims } from "../auth.js"` — un **type**, effacé à la compilation, qui ne peut
porter aucun appel à l'exécution.

Or une élicitation ne peut remonter que **dans une session MCP en train de traiter un `tools/call`**.
Le device flow est un chemin **purement HTTP**, dont les deux extrémités sont un client REST et un
humain dans un navigateur (`/auth/device`, `/auth/device/confirm`, servies par
`src/auth/pages/device.html.ts:60` et `device-confirm.html.ts:104`). **Il n'existe aucune session
MCP dans laquelle éliciter.**

→ **A07-R3 déclenché.** L'option (c) de §6.1 — « réserver l'élicitation au seul device flow
OAuth » — n'est pas un repli prudent : c'est une impossibilité structurelle.

**Et il y a plus grave que l'absence de plomberie : la spec l'interdit.**
`modelcontextprotocol.io/specification/2026-07-28/client/elicitation`, fetchée le 2026-08-15,
section *URL Mode Elicitation for OAuth Flows* :

> Authorization with external APIs enabled by URL mode elicitation is separate from MCP
> authorization. **MCP servers MUST NOT rely on URL mode elicitation to authorize users for
> themselves.**

Et l'encadré du mode `url` :

> **Important**: URL mode elicitation is *not* for authorizing the MCP client's access to the MCP
> server (that's handled by MCP authorization). Instead, it's used when the MCP server needs to
> obtain sensitive information **or third-party authorization on behalf of the user**.

Or `src/discovery.ts:16-24` publie `authorization_endpoint`, `token_endpoint`,
`device_authorization_endpoint` et `urn:ietf:params:oauth:grant-type:device_code` **du coordinateur
lui-même** : mcp-coordinator **est** son propre serveur d'autorisation, et son device flow autorise
l'utilisateur **à lui-même**. Un outil qui éliciterait `verification_uri_complete` tomberait donc
sous un **MUST NOT** explicite.

**Conséquence pour la fiche :** §4 (« le chemin propre pour un device flow OAuth ») et §6.5
(« gain net à effort S et sans changement de philosophie ») sont **faux sur la spec**, pas seulement
impraticables. La seule ouverture légitime du mode `url` serait un **tiers** que le coordinateur
appellerait *pour le compte* de l'utilisateur — un cas d'usage que ce projet n'a pas.

*Confirmation annexe, conforme à la fiche :* `grep -ri elicit src/ cli/` → **0 occurrence**.
Et aucune commande de `cli/` ne déclenche de device flow ; le seul client device flow réel du projet
est le **SDK JS** (`sdk/src/client.ts:213` `deviceCodeStart`, `:224` `deviceCodePoll`), qui parle
REST et n'est importé ni par `src/` ni par `cli/`.

---

#### (5) Frontière exécuté / lu

**Exécuté :** les trois cas dégradés (≤ 1 ms chacun), les quatre configurations du mode `url`,
le hook `Elicitation` contre Claude Code 2.1.233 (3 lancements), et — via
[`A03`](A03-mrtr-input-required.md) — le comportement par défaut sans hook (3 lancements) et le
transport d'une vraie `elicitation/create` par le shim.

**Fetché aujourd'hui :** la page `client/elicitation` de la spec 2026-07-28 (mode `url`,
capacités, `MUST NOT` sur l'auto-autorisation).

**Lu, non exécuté :** le recensement du chemin d'appel du device flow (imports et chaînes vérifiés
ligne à ligne, mais aucun appel joué) ; le chemin **Agent SDK headless** (`onElicitation`,
`SDKElicitationCompleteMessage`), puisque `@anthropic-ai/claude-agent-sdk` n'est pas installé.

**🔴 Lacune assumée, et elle est centrale :** **le mode interactif n'a pas été mesuré.** Toutes les
mesures agent sont en `claude -p`. Or les personas n°1 et n°2 du `README.md:24-25` sont des humains
qui pilotent plusieurs sessions Claude Code — c'est-à-dire précisément le profil où le dialogue
d'élicitation aurait sa pleine valeur, et le seul que ce challenge n'a pas éprouvé. `claude -p` est
le seul mode pilotable depuis une session. C'est porté en condition de réveil en §7.2.

### 6.5 Contre-arguments

*Repris le 2026-08-15 après l'expérience et une passe adversariale. Barré = tombé.*

- ~~**Le silence vaut refus** — « un coordinateur qui traiterait `decline` comme "ne pas continuer"
  bloquerait toutes les escouades pilotées par SDK ».~~ **TOMBE.** Mesuré : un hook `Elicitation`
  répond `accept` **avec le contenu du formulaire**, 3/3, en `claude -p` (§6.4 (1 bis)). Le silence
  vaut refus **par défaut**, pas par nature. Ce qui reste vrai : le hook est écrit par
  l'**opérateur**, pas par nous.
- ~~**Blocage synchrone : « la session de l'agent gèle »** — pour les clients qui ne peuvent pas
  répondre.~~ **TOMBE sur le cas dégradé.** Mesuré : capacité déclarée sans handler → `-32601` en
  **1 ms** ; capacité non déclarée → refus **local**, côté serveur, en **0 ms**, avant tout trafic.
  Rien ne gèle. Ce qui reste vrai : en interactif, un dialogue ouvert bloque bien **la session
  concernée** — c'est documenté, et c'est le comportement voulu.
- **La cible naturelle du bénéfice n'est pas joignable.** Le bénéfice vanté par le bundle — « interrompre l'agent B au milieu d'un appel de tool » — suppose que le coordinateur puisse initier une élicitation vers une session qu'il n'est pas en train de servir. Rien dans la surface d'API ne le permet : `elicitInput` s'adresse au client de la requête en cours. Le scénario réaliste se réduit à « éliciter l'annonceur », nettement moins ambitieux.
- **Blocage synchrone sur un chemin chaud.** `announce_work` écrit la ligne `threads`, insère dans `layer_firings`, émet `impact_scored` pour chaque agent scoré et publie sur MQTT. Y insérer une attente humaine indéterminée transforme la primitive la plus appelée du produit en point d'arrêt. Claude Code garantit explicitement de **ne pas** mettre l'appel en arrière-plan tant que le dialogue est ouvert : la session de l'agent gèle.
- **Le silence vaut refus.** En session Agent SDK headless, sans hook `Elicitation` ni `onElicitation`, la requête est automatiquement `decline`. Un coordinateur qui traiterait `decline` comme « ne pas continuer » bloquerait toutes les escouades pilotées par SDK. Le chemin non bloquant actuel doit donc être conservé intégralement : on **ajoute** du code, on n'en retire pas.
- **Divergence MCP/REST.** `runCommonAnnounceFlow()` a précisément été extrait pour que le tool MCP et l'endpoint REST se comportent pareil. L'élicitation n'existe que côté MCP : on réintroduit volontairement l'asymétrie qu'on a payé pour supprimer.
- **Instabilité de spec déjà constatée.** `elicitationId` et `notifications/elicitation/complete` sont apparus en 2025-11-25 et, d'après une des sources, supprimés en 2026-07-28 — alors que le SDK 1.30.0 installé les exige encore. Un mode `url` écrit aujourd'hui sera à réécrire.
- **Quatrième canal d'interruption.** Le projet a déjà SSE (dashboard), MQTT (agents), et les Channels (`cli/channel.ts`). Ajouter un canal bloquant, à sémantique différente, avec sa propre gestion de timeout et d'annulation, alourdit une surface déjà large pour un mainteneur solo.
- **Coût pour l'auto-hébergeur, en mode `url` surtout.** Il faut une page d'arbitrage authentifiée sous `/dashboard`, atteignable depuis la machine du client MCP — ce qui n'est pas acquis en Docker, en tunnel SSH ou derrière un reverse-proxy. Rien de tout ça n'existe dans `dashboard/public/`.
- **YAGNI sur la partie coordination.** Le produit assume aujourd'hui un modèle consultatif (`severity: "warning" | "info"`, jamais bloquant). Passer à un gate synchrone est un changement de philosophie produit, pas une fonctionnalité de plus. ~~Le mode `url` sur `src/auth/device-flow.ts`, lui, est un gain net à effort S et sans changement de philosophie — c'est peut-être la seule partie de cette fiche qui mérite d'être adoptée.~~ → **La seconde phrase TOMBE, et durement** : le mode `url` sur le device flow du coordinateur tombe sous un **MUST NOT** de la spec (§6.4 (4)), il est refusé par les capacités que Claude Code déclare, et il n'a aucun point d'insertion MCP. Le « lot de consolation » de cette fiche était le volet le **moins** adoptable des trois.

**Ajoutés par l'expérience :**

- **🔴 Le mode `url` est interdit ici par la spec, pas seulement impraticable.** « MCP servers
  **MUST NOT** rely on URL mode elicitation to authorize users for themselves » — or
  `src/discovery.ts:16-24` fait du coordinateur son propre serveur d'autorisation.
- **Le mode `url` est de toute façon refusé par le seul client réel.** Claude Code déclare
  `elicitation: {}`, ce qui vaut `form` seul selon la spec ; une élicitation `url` échoue en 0 ms.
  *Nuance à ne pas masquer :* la doc de Claude Code annonce par ailleurs implémenter le mode `url`
  (dialogue navigateur, matcher `elicitation_url_dialog`). L'écart est donc une **sous-déclaration
  de capacité**, pas une absence de fonctionnalité — ce qui en fait une condition de réveil, pas un
  mur définitif.
- **Trois modes d'échec, pas un.** La spec n'en prévoit que trois *actions* (`accept`/`decline`/
  `cancel`), mais la réalité en ajoute un quatrième : `-32601 Method not found` quand le client
  déclare la capacité sans installer de handler. Une implémentation doit traiter l'exception locale,
  l'erreur de protocole **et** les trois actions.
- **Le gate est configurable par l'utilisateur, donc à géométrie variable.** Puisque c'est un hook
  qui décide en headless, le comportement d'une escouade dépend d'un fichier que nous ne
  contrôlons pas. C'est un garde-fou dont la fermeté est déléguée à l'opérateur.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ✅ **reporter** (volet `form`) · ✅ **refuser** (volet `url`) |
| **Date** | 2026-08-15 |
| **Justification** | **Le volet `url` est refusé, définitivement** : la spec dit « MCP servers **MUST NOT** rely on URL mode elicitation to authorize users for themselves », or le coordinateur est son propre serveur d'autorisation ; le mode est en outre refusé par les capacités que Claude Code déclare, et n'a aucun point d'insertion MCP. **Le volet `form` est reporté, pas refusé** : il fonctionne — y compris en headless, via un hook `Elicitation` qui répond `accept` avec le contenu du formulaire, mesuré 3/3 — mais il pose exactement la même question produit qu'[`A03`](A03-mrtr-input-required.md), tranchée `reporter` le même jour : *passe-t-on d'un modèle consultatif à un gate synchrone ?* Et il n'a pas été éprouvé dans le seul mode où il aurait sa pleine valeur : l'interactif. |
| **Issue / PR** | — (aucune : rien à coder) |
| **Jalon visé** | Réveil conditionnel, voir §7.2 |

### 7.1 La réponse à la question de §6.1

Les trois options, dans l'ordre inverse de ce que la fiche suggère :

- **(c) « réserver l'élicitation au device flow OAuth » — refusée, et c'est le renversement principal
  de ce challenge.** §6.5 la présentait comme *« la seule partie de cette fiche qui mérite d'être
  adoptée »*. C'est la **moins** adoptable des trois : la spec l'**interdit** pour un serveur qui
  s'autorise lui-même, le mode est refusé par le client réel, et le device flow est un chemin
  purement HTTP sans aucune session MCP dans laquelle éliciter (§6.4 (3) et (4)).
- **(b) « mode `url` vers un écran d'arbitrage » — refusée aujourd'hui, pour des raisons moins
  définitives.** Claude Code déclare `elicitation: {}` = `form` seul, donc l'élicitation `url` est
  refusée ; et la forme implémentable avec le SDK 1.30.0 est celle de 2025-11-25, pas celle de la
  spec courante. S'y ajoute qu'aucune page d'arbitrage n'existe dans `dashboard/public/`.
- **(a) « éliciter l'annonceur en mode `form` » — la seule vivante, et la fiche la sous-estime.**
  Elle marche en interactif, et en headless via un hook. Ce n'est pas une impasse technique : c'est
  une **décision produit**, la même qu'`A03`.

**Ce que ce challenge établit et qui n'était nulle part :** le canal d'élicitation est **sûr par
défaut**. Les trois cas dégradés échouent en ≤ 1 ms, et le cas « client tiers sans la capacité » est
refusé **localement par le SDK serveur, avant tout trafic**. La crainte de §6.3 — « sinon le flux se
fige pour tout non-Claude-Code » — est infondée. Adopter le volet `form` ne met donc **aucun** client
en danger ; c'est le seul point où la fiche était trop pessimiste.

### 7.2 Conditions de réveil — volet `form`

| # | Condition | Pourquoi |
|---|---|---|
| 1 | **La question produit d'[`A03`](A03-mrtr-input-required.md) §7.2 est tranchée** : passe-t-on d'un modèle consultatif à un gate synchrone, et que fait un agent non surveillé ? | `A03` et `A07` sont **la même décision vue de deux côtés** : le shim du SDK v2 transforme un `inputRequired` en `elicitation/create`. Les trancher séparément produirait deux réponses contradictoires. |
| 2 | **Mesurer le mode interactif** — un humain devant Claude Code, face au dialogue | C'est la lacune de ce challenge (§6.4 (5)) **et** le profil des personas n°1 et n°2 du `README.md:24-25`. Sans cette mesure, on ne sait pas ce que le volet `form` vaut pour son bénéficiaire principal. |
| 3 | *(volet `url` seulement, et pour un usage tiers)* Claude Code déclare `"elicitation":{"form":{},"url":{}}` | Sa doc annonce déjà implémenter le mode `url` : l'écart est une sous-déclaration. Se re-mesure en 5 minutes avec `scratchpad/wire-proxy.mjs`. **Ne rouvre pas** l'usage OAuth interne, qui reste sous `MUST NOT`. |

### 7.3 Corrections apportées à la fiche par ce challenge

1. **§4 et §6.5 — le « lot de consolation » OAuth est non conforme, pas seulement impraticable.**
   « Le chemin propre pour un device flow OAuth » et « gain net à effort S » sont faux : la spec
   l'interdit pour l'auto-autorisation.
2. **§6.5 « le silence vaut refus … bloquerait toutes les escouades pilotées par SDK » est faux** :
   un hook `Elicitation` répond `accept` avec le contenu, mesuré 3/3.
3. **§6.3 « sinon le flux se fige pour tout non-Claude-Code » est faux** : ≤ 1 ms sur les trois cas
   dégradés, dont un refus local avant tout trafic.
4. **Fait absent de la fiche** : le mode `url` est **indisponible** face à ce que Claude Code
   déclare (`elicitation: {}` = `form` seul), indépendamment de l'instabilité de spec que §6.5
   signalait.
5. **Fait absent de la fiche** : il existe un **quatrième** mode d'échec, `-32601`, quand le client
   déclare la capacité sans installer de handler — hors des trois actions prévues par la spec.
6. **Correction à porter dans [`A03`](A03-mrtr-input-required.md)** : son §7.2 condition 2 affirme
   qu'« aucun chemin de forçage n'existe » pour un agent non surveillé. Le hook `Elicitation` **est**
   ce chemin.
7. **Une erreur commise pendant ce challenge, corrigée** : j'ai d'abord écrit que « essaim, CI et
   sessions background sont le profil d'usage central du produit ». `README.md:24-25` dit l'inverse —
   les personas n°1 et n°2 sont des humains qui pilotent plusieurs sessions. Le passage fautif est
   conservé barré en §6.4 (1).

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : API et lignes confirmées ; statut nuancé, hook ElicitationResult corrigé, marqueurs tranchés. |
| 2026-08-15 | Challenge. **Verdict : `refuser` le volet `url`, `reporter` le volet `form`.** Le « lot de consolation » OAuth de §6.5 est le volet le moins adoptable : la spec dit « MUST NOT rely on URL mode elicitation to authorize users for themselves ». Mesuré : mode `url` refusé par les capacités déclarées de Claude Code (0 ms) ; device flow sans aucun point d'insertion MCP (`auth-routes.ts:6` est son unique import, `serve-http.ts:570` court-circuite avant `/mcp`) ; cas dégradés ≤ 1 ms, aucun gel ; **hook `Elicitation` répondant `accept` + `content`, 3/3**. Deux erreurs personnelles corrigées en séance (profil d'usage, et « option (a) morte »). |
