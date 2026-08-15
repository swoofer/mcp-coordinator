# A07 — Elicitation (modes `form` et `url`) : arbitrer un conflit sans passer par un thread

| Champ | Valeur |
|---|---|
| **ID** | `elicitation` |
| **Surface** | mcp-spec · claude-code · agent-sdk |
| **Statut** | GA (mode `form`) · mode `url` : introduit en 2025-11-25, la spec 2026-07-28 le marque encore comme « new feature, design may change » |
| **Disponible depuis** | `form` : MCP 2025-06-18 · `url` : MCP 2025-11-25 (SEP-1036) · Claude Code ≈ v2.1.76 (mars 2026) · hooks + `SDKElicitationCompleteMessage` : Agent SDK 0.2.76 · refonte MRTR : MCP 2026-07-28 |
| **Tier** | T1-incontournable |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | medium |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — mode `url` 2026-07-28 absent du SDK installé |
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Non exécutable ici : le mode `url` dans sa forme 2026-07-28 (le SDK 1.30.0 installé impose encore `elicitationId` et ignore `requestState`/`inputResponses`) et tout le chemin Agent SDK headless (`@anthropic-ai/claude-agent-sdk` n'est pas installé dans ce repo).

- [ ] Figer la signature réelle : relire `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts` et `types.d.ts` de la version épinglée, confirmer si `elicitationId` est requis en mode `url` et si `requestState` / `inputResponses` existent (ils sont absents en 1.30.0).
- [ ] PoC derrière un flag env (`COORDINATOR_ELICIT=1`) : brancher `server.server.elicitInput({ mode: "form", … })` dans `announce_work` quand `conflicts.length > 0`, lancer Claude Code contre le daemon en stdio, observer si le dialogue s'affiche et quelle `action` revient.
- [ ] Cas dégradé : appeler `announce_work` depuis un client MCP qui **ne** déclare **pas** `capabilities.elicitation` (SDK headless sans hook ni `onElicitation`, ou client tiers). Vérifier que l'appel décline immédiatement et n'attend pas — sinon le flux se fige pour tout non-Claude-Code.
- [ ] Mesurer le coût du blocage : pendant qu'un dialogue est ouvert, vérifier que les autres sessions MCP, le flux SSE et le broker MQTT restent servis, et qu'un `cancel` laisse la ligne `threads` cohérente (pas de thread orphelin, `layer_firings` non pollué).
- [ ] Mode `url` : pointer une élicitation sur `verification_uri_complete` de `src/auth/device-flow.ts`, confirmer que l'URL est atteignable depuis la machine du client et qu'aucun secret ne transite par une query string exposée au contexte du modèle.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **La cible naturelle du bénéfice n'est pas joignable.** Le bénéfice vanté par le bundle — « interrompre l'agent B au milieu d'un appel de tool » — suppose que le coordinateur puisse initier une élicitation vers une session qu'il n'est pas en train de servir. Rien dans la surface d'API ne le permet : `elicitInput` s'adresse au client de la requête en cours. Le scénario réaliste se réduit à « éliciter l'annonceur », nettement moins ambitieux.
- **Blocage synchrone sur un chemin chaud.** `announce_work` écrit la ligne `threads`, insère dans `layer_firings`, émet `impact_scored` pour chaque agent scoré et publie sur MQTT. Y insérer une attente humaine indéterminée transforme la primitive la plus appelée du produit en point d'arrêt. Claude Code garantit explicitement de **ne pas** mettre l'appel en arrière-plan tant que le dialogue est ouvert : la session de l'agent gèle.
- **Le silence vaut refus.** En session Agent SDK headless, sans hook `Elicitation` ni `onElicitation`, la requête est automatiquement `decline`. Un coordinateur qui traiterait `decline` comme « ne pas continuer » bloquerait toutes les escouades pilotées par SDK. Le chemin non bloquant actuel doit donc être conservé intégralement : on **ajoute** du code, on n'en retire pas.
- **Divergence MCP/REST.** `runCommonAnnounceFlow()` a précisément été extrait pour que le tool MCP et l'endpoint REST se comportent pareil. L'élicitation n'existe que côté MCP : on réintroduit volontairement l'asymétrie qu'on a payé pour supprimer.
- **Instabilité de spec déjà constatée.** `elicitationId` et `notifications/elicitation/complete` sont apparus en 2025-11-25 et, d'après une des sources, supprimés en 2026-07-28 — alors que le SDK 1.30.0 installé les exige encore. Un mode `url` écrit aujourd'hui sera à réécrire.
- **Quatrième canal d'interruption.** Le projet a déjà SSE (dashboard), MQTT (agents), et les Channels (`cli/channel.ts`). Ajouter un canal bloquant, à sémantique différente, avec sa propre gestion de timeout et d'annulation, alourdit une surface déjà large pour un mainteneur solo.
- **Coût pour l'auto-hébergeur, en mode `url` surtout.** Il faut une page d'arbitrage authentifiée sous `/dashboard`, atteignable depuis la machine du client MCP — ce qui n'est pas acquis en Docker, en tunnel SSH ou derrière un reverse-proxy. Rien de tout ça n'existe dans `dashboard/public/`.
- **YAGNI sur la partie coordination.** Le produit assume aujourd'hui un modèle consultatif (`severity: "warning" | "info"`, jamais bloquant). Passer à un gate synchrone est un changement de philosophie produit, pas une fonctionnalité de plus. Le mode `url` sur `src/auth/device-flow.ts`, lui, est un gain net à effort S et sans changement de philosophie — c'est peut-être la seule partie de cette fiche qui mérite d'être adoptée.

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
| 2026-08-14 | Vérification des faits : API et lignes confirmées ; statut nuancé, hook ElicitationResult corrigé, marqueurs tranchés. |
