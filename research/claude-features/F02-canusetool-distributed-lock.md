# F02 — `canUseTool` et `requestId` : la primitive exacte du verrou distribué

| Champ | Valeur |
|---|---|
| **ID** | `canusetool-distributed-lock` |
| **Surface** | agent-sdk |
| **Statut** | GA |
| **Disponible depuis** | `permission_policy` par outil dans `mcp_set_servers` : 0.2.111 · `requestId` hors bande + retour `null` : 0.3.199 · `system/permission_denied` en headless : 0.3.223 |
| **Tier** | T1-incontournable |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — tout tourne en local, aucun header beta requis |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **Signature de `canUseTool` précisée.** La doc « Handle approvals and user input » confirme trois arguments : `(toolName, input, options)`. `requestId` vit dans le 3ᵉ argument `options`, aux côtés de `signal: AbortSignal` et `suggestions?: PermissionUpdate[]`. La page de référence TypeScript présente une forme condensée `(request: PermissionRequest, options: { signal })` qui contredit ses propres exemples — la forme à trois arguments est celle de tous les exemples de code.
- **`requestId` et le retour `null` ne sont documentés nulle part** sur docs.claude.com / code.claude.com : la seule source est le CHANGELOG 0.3.199, dont le libellé exact est « Added `requestId` to `canUseTool` callback options for correlating out-of-band permission responses, and support for returning `null` to suppress the SDK's automatic control response ». La primitive existe, mais elle est hors doc publique.
- **Marqueur `permission_policy` tranché.** CHANGELOG 0.2.111 : « `mcp_set_servers` control request: remote (http/sse) server entries can now carry per-tool `permission_policy` values, which are applied to the session's allow/deny rules ». Donc : **par outil**, mais **uniquement sur les entrées de serveur distant (http/sse)** — pas sur stdio ni sur les serveurs SDK in-process. Les valeurs admises ne sont pas documentées.
- **`requiresUserInteraction` était mal rangé** (listé comme champ du hook `PermissionDenied`). C'est en réalité une annotation d'outil MCP, `_meta["anthropic/requiresUserInteraction"]`, exposée par le serveur. Corrigé en §2.
- **Le court-circuit `bypassPermissions` n'est pas total.** La doc « How permissions are evaluated » précise que les règles `ask` explicites, les outils de connecteur mis à `ask` par l'organisation, et les outils MCP annotés `requiresUserInteraction` **atteignent quand même le callback, y compris en `bypassPermissions` et même quand une règle `allow` matche**. Ajouté en §2 : un serveur MCP peut donc forcer son propre passage par le gate.
- **Liste des modes de permission complétée** : `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto`. `bypassPermissions` exige `allowDangerouslySkipPermissions: true` côté SDK, et le SDK TypeScript émet un warning process `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` quand un `canUseTool` fourni ne peut jamais être atteint.
- **Ajout d'une alternative documentée** : la décision de hook `defer` (« Defer a tool call for later »), qui laisse le processus se terminer et reprendre depuis la session persistée. C'est le seul mécanisme d'attente longue effectivement documenté ; le retour `null` ne l'est pas.
- **Le piège `acceptEdits` est confirmé verbatim** par la doc MCP : « `permissionMode: "acceptEdits"` does not auto-approve MCP tools (only file edits and filesystem Bash commands) », avec recommandation explicite du wildcard `allowedTools`.
- **§5 : numéros de ligne vérifiés.** `rest-handlers.ts` l.863/l.887 ✅ · `handle-rest.ts` l.116-117 ✅ · `mqtt-tools.ts` l.52 (`server.tool(`, nom en l.53) ✅ · `cli/channel.ts` l.311-313 ✅ · `files-tools.ts` l.49 (`server.tool(`, nom `check_file_conflict` en l.50) — précisé. Tous les fichiers cités existent. Les 26 `server.tool()` (4+11+3+3+3+2) et l'absence de `@anthropic-ai/claude-agent-sdk` dans `package.json` sont confirmés, de même que l'absence totale de `permissionMode`/`acceptEdits`/`allowedTools` dans `README.md` et `docs/`, et le plafond `severity: warning|info` de `conflict-detector.ts`.

**Marqueurs `(à vérifier)` restants :** un seul, converti en `(non vérifiable)` — le nom de l'API par laquelle l'hôte répond hors bande après un retour `null`. Elle n'apparaît sur aucune page de doc publique ; seuls les types du paquet npm peuvent la trancher.

**Statut :** GA maintenu. Le SDK et `canUseTool` sont GA et pleinement documentés ; c'est la primitive précise de cette fiche (`requestId` + retour `null`) qui est GA-mais-non-documentée, connue uniquement par le CHANGELOG.

**Testabilité :** ✅ testable
Tout le protocole §6.3 tourne sur le poste : `pnpm add @anthropic-ai/claude-agent-sdk` puis inspection des types de `CanUseTool` tranche le point « non vérifiable » sans réseau, et le daemon local plus deux processus SDK suffisent aux PoC un-agent / deux-agents, au test de TTL et aux vérifications de court-circuit. Aucun header beta ni allowlist d'org n'est requis ; la seule dépendance externe est une session Claude Code authentifiée sur le poste, que le SDK réutilise. Seule réserve : `permission_policy` par outil ne se teste que sur le transport HTTP du coordinateur, pas en stdio.

## 1. Ce que c'est

Le Claude Agent SDK TypeScript expose trois couches de contrôle sur l'exécution d'un outil, dont la troisième nous intéresse directement. (1) `canUseTool: CanUseTool` est un callback de gating appelé avant chaque appel d'outil : l'orchestrateur décide d'autoriser, de refuser, ou de réécrire l'input. Depuis 0.3.199, ce callback reçoit un `requestId` et peut retourner `null` — ce qui **supprime l'auto-réponse** et laisse la décision ouverte : l'hôte répond plus tard, hors bande, en référençant le `requestId`. C'est exactement la sémantique d'un verrou : suspendre l'écriture, interroger un daemon, débloquer quand le pair a libéré le fichier — sans occuper la boucle d'agent avec un `await` synchrone.

(2) `permission_policy` peut être fixée **par outil MCP** dans la requête de contrôle `mcp_set_servers` (également via `setMcpServers()`), donc à chaud, sans redémarrer la session : on peut laisser un outil de libération ouvert et basculer un outil destructif en `ask` selon l'état du système. (3) Deux hooks encadrent le cycle : `PermissionRequest` (une décision est requise) et `PermissionDenied` (le mode automatique a refusé, avec `retry: true` possible sauf refus sans verdict). En mode headless, une auto-dénégation émet un message `system/permission_denied` au lieu d'ouvrir un dialogue.

Deux court-circuits à connaître : `bypassPermissions` et `allowedTools` sautent le callback — le gate ne s'exécute pas du tout. Trois exceptions cependant, vérifiées dans la doc « How permissions are evaluated » : une règle `ask` explicite, un outil de connecteur mis à `ask` par l'organisation, et un outil MCP annoté `_meta["anthropic/requiresUserInteraction"]` atteignent le callback **même en `bypassPermissions` et même si une règle `allow` matche** — un serveur MCP peut donc forcer son propre passage par le gate. Et un piège documenté côté MCP : `permissionMode: "acceptEdits"` **n'auto-approuve pas** les outils MCP ; la doc recommande explicitement `allowedTools` avec wildcard plutôt qu'un mode de permission pour les serveurs MCP.

## 2. Surface d'API exacte

```
# Callback de gating (Agent SDK TypeScript) — 3 arguments
canUseTool : CanUseTool
  (toolName, input, options) => PermissionResult          # documenté
  options = { signal: AbortSignal,
              suggestions?: PermissionUpdate[],
              requestId }                                 # requestId : CHANGELOG 0.3.199 uniquement
  retour null   -> supprime l'auto-réponse du SDK, décision hors bande via requestId
                   (CHANGELOG 0.3.199 uniquement ; absent de la doc publique)
PermissionResult = { behavior: "allow",  updatedInput, updatedPermissions? }
                 | { behavior: "deny",   message }

# Alternative documentée pour une attente longue (page hooks)
permissionDecision: 'defer'      # hook PreToolUse ; le processus peut sortir et
                                 # reprendre depuis la session persistée
                                 # priorité : deny > defer > ask > allow

# Court-circuits (le callback n'est PAS appelé)
permissionMode : 'default' | 'plan' | 'acceptEdits' | 'dontAsk'
               | 'bypassPermissions'   # exige allowDangerouslySkipPermissions: true
               | 'auto'
allowedTools   : string[]        # wildcard recommandé pour les serveurs MCP
                                 # glob autorisé seulement après mcp__<server>__
# EXCEPTIONS : atteignent le callback même sous bypassPermissions / règle allow
règles `ask` explicites (settings.json)
outils de connecteur mis à `ask` par l'organisation
outils MCP annotés _meta["anthropic/requiresUserInteraction"]
# En mode dontAsk, ces trois cas sont refusés au lieu d'être présentés.
# Si le canUseTool fourni ne peut jamais être atteint, le SDK TS émet un
# process warning de code CLAUDE_SDK_CAN_USE_TOOL_SHADOWED.

# Politique par outil MCP, pilotable à chaud
mcp_set_servers                  # requête de contrôle
setMcpServers(servers)           # méthode SDK ; streaming input mode seulement
  permission_policy              # par outil, sur les entrées de serveur DISTANT
                                 # (http/sse) uniquement — pas stdio, pas SDK in-process ;
                                 # appliqué aux règles allow/deny de la session

# Hooks
PermissionRequest                # une décision de permission est requise
PermissionDenied                 # le mode `auto` a refusé ; on peut dire au modèle
                                 # qu'il peut réessayer, mais `retry: true` est ignoré
                                 # pour les refus sans verdict de classifieur

# Headless
system/permission_denied         # stream event émis quand un appel d'outil est
                                 # auto-refusé sans canUseTool (CHANGELOG 0.3.223)
```

Le marqueur sur `permission_policy` est tranché (CHANGELOG 0.2.111) : la politique est bien **par outil**, portée par les entrées de serveur **distant (http/sse)** de `mcp_set_servers`. Les **valeurs admises** ne sont documentées nulle part **(non vérifiable — absentes de la doc et du changelog)**.

La forme exacte de l'API de réponse différée côté hôte (la fonction qui consomme le `requestId` après un retour `null`) n'est nommée sur aucune page de doc publique **(non vérifiable — hors doc ; à établir en lisant les types du paquet npm)** — c'est le premier point à établir sur le vrai chemin de code.

Une seule fiche brute alimente ce dossier (`n_sources: 1`) : pas de contradiction entre chercheurs à signaler, mais aussi pas de recoupement croisé.

## 3. Sources

- https://code.claude.com/docs/en/agent-sdk/typescript.md
- https://code.claude.com/docs/en/agent-sdk/mcp.md
- https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

Aujourd'hui, le projet n'a **aucun verrou** — il a un système de claims consultatives. `src/working-files-tracker.ts` pose un `claim_until` avec TTL (30 min par défaut, `COORDINATOR_WORKING_FILES_TTL_MIN`) et `src/conflict-detector.ts` produit des `ConflictReport` dont la `severity` ne dépasse jamais `warning`. Rien n'empêche deux agents d'écrire le même fichier : le second est informé, pas arrêté. Le seul mécanisme bloquant du serveur est `wait_for_message` (`src/tools/mqtt-tools.ts:52`), un long-poll plafonné à `MAX_WAIT_TIMEOUT_SECONDS` que **l'agent doit choisir d'appeler** — un agent qui ne coopère pas écrase.

`canUseTool` + retour `null` + `requestId` déplace le point de décision hors de la bonne volonté du modèle : c'est l'orchestrateur qui suspend l'appel `Write`/`Edit`, interroge `POST /api/working-files/start` (déjà implémenté, `src/http/rest-handlers.ts:863`), et ne relâche le `requestId` qu'à la libération — signalée par le SSE ou MQTT que le serveur émet déjà. La capacité nouvelle : un **verrou d'exclusion réel avec file d'attente**, sans polling et sans immobiliser l'agent en attente. Le code qui pourrait maigrir : la mécanique de « ré-annonce et rappel » du côté agent, et à terme l'usage de `wait_for_message` comme substitut de barrière.

Second bénéfice, moins ambitieux mais immédiat : `permission_policy` par outil MCP piloté par `mcp_set_servers`/`setMcpServers()` permettrait à un orchestrateur de durcir dynamiquement les 26 outils du coordinateur (26 `server.tool()` répartis sur les six fichiers de `src/tools/`) — laisser `heartbeat` et `post_to_thread` ouverts, passer `set_dependency_map` en `ask`.

Troisième bénéfice, gratuit : une correction de documentation. `grep` sur `README.md` et `docs/` ne trouve **aucune** occurrence de `permissionMode`, `acceptEdits` ou `allowedTools`. Les utilisateurs qui règlent `acceptEdits` en croyant avoir auto-approuvé les outils du coordinateur se trompent, et le README ne les détrompe pas.

**Risque si on ne fait rien :**

Faible sur le plan fonctionnel — le modèle consultatif reste défendable. Le risque réel est de positionnement : si un concurrent branche un vrai verrou sur `canUseTool`, la promesse « coordination multi-agents » de mcp-coordinator se réduit à « notification multi-agents ». Risque documentaire immédiat en revanche : le piège `acceptEdits` produit des tickets de support évitables.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/working-files-tracker.ts` | Le cœur. `start()`/`stop()`/`getIndex()` deviennent l'état d'un verrou et non d'une claim ; il manque une notion de file d'attente (qui attend quoi) et un événement de libération. `sweepExpired()` devient le disjoncteur anti-deadlock. |
| `src/http/rest-handlers.ts` (l.863 `handleWorkingFilesStart`, l.887 `handleWorkingFilesStop`) | Les deux endpoints existent déjà mais renvoient `{ ok: true }` inconditionnellement : `start` devrait pouvoir répondre « refusé, détenu par X » pour servir de point d'ancrage au gate. |
| `src/http/handle-rest.ts` (l.116-117) | Table de routage `POST /api/working-files/start` / `/stop`. Un éventuel endpoint d'attente ou de libération s'ajoute ici. |
| `src/conflict-detector.ts` | `detect()` ne produit que `severity: "warning"` / `"info"`. Une décision bloquante exige un niveau supplémentaire, ou un contrat séparé. |
| `src/tools/files-tools.ts` (l.49 `server.tool(`, nom `check_file_conflict` l.50) | Outil `readOnlyHint: true` que le gate appellerait — ou qu'il court-circuiterait au profit d'un appel REST direct, plus rapide. |
| `src/tools/mqtt-tools.ts` (l.52 `wait_for_message`) | Concurrent direct du mécanisme. À trancher : le gate le remplace-t-il, ou s'appuie-t-il dessus ? |
| `src/sse-emitter.ts` / `src/mqtt-bridge.ts` | Canaux de notification déjà en place — c'est par là que la libération d'un verrou remonterait à l'orchestrateur pour résoudre le `requestId`. |
| `cli/channel.ts` (l.311-313, `capabilities.experimental["claude/channel"]`) | Chemin alternatif pour Claude Code CLI (voir C04). `canUseTool` couvre le cas Agent SDK ; les deux chemins ne doivent pas diverger sémantiquement. |
| `package.json` | Aucune dépendance `@anthropic-ai/claude-agent-sdk` aujourd'hui. Toute adoption crée soit une dépendance nouvelle, soit un exemple isolé sous `examples/`. |
| `sdk/src/client.ts` | `McpCoordinatorClient` ne fait qu'OAuth/tokens (device flow, refresh, whoami). Aucune méthode de coordination : un helper de verrou serait un ajout, pas une modification. |
| `README.md`, `docs/usage.md`, `docs/troubleshooting.md` | Aucune mention de `permissionMode`/`acceptEdits`/`allowedTools` (vérifié par grep). Le piège MCP est à documenter indépendamment de toute décision d'adoption. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> mcp-coordinator doit-il sortir de son rôle de serveur passif pour livrer un orchestrateur de référence basé sur `canUseTool` (dépendance au Claude Agent SDK, verrou dur avec file d'attente sur `working_files`), ou rester un serveur MCP portable qui n'expose que les endpoints et laisse à chaque hôte le soin d'écrire son propre gate ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

- [ ] Établir la surface réelle : installer `@anthropic-ai/claude-agent-sdk`, lire les types de `CanUseTool` et confirmer que le retour `null` compile, que `requestId` est bien présent dans le contexte, et **par quelle API l'hôte répond hors bande** (point marqué « à vérifier » en §2).
- [ ] PoC minimal à un agent : orchestrateur SDK + coordinateur local ; `canUseTool` intercepte `Write`, appelle `POST /api/working-files/start`, retourne `null`, et résout le `requestId` sur réception de l'événement SSE de libération. Mesurer la latence ajoutée sur un `Write` non contesté.
- [ ] PoC à deux agents concurrents sur le même fichier : vérifier que l'agent B est réellement suspendu, qu'il repart après le `stop` de A, et que la boucle d'agent de B n'est pas bloquée (peut-il faire autre chose pendant l'attente ?).
- [ ] Cas de panne : que se passe-t-il si A meurt sans `stop` ? Vérifier que `sweepExpired()` (TTL 30 min) débloque bien B, et chronométrer le pire cas — un deadlock de 30 minutes est inacceptable.
- [ ] Vérifier les court-circuits : lancer la même session avec `permissionMode: "bypassPermissions"` puis avec `allowedTools: ["mcp__coordinator__*"]`, et confirmer que le gate est effectivement sauté (si oui, le verrou n'est pas un mécanisme de sécurité, seulement de coordination — à écrire noir sur blanc).
- [ ] Reproduire le piège `acceptEdits` : session avec `permissionMode: "acceptEdits"` et un outil MCP du coordinateur ; confirmer que la demande d'approbation apparaît quand même, et documenter le résultat exact dans le README.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Ça ne s'applique qu'aux hôtes Agent SDK.** `canUseTool` est une API du Claude Agent SDK TypeScript. Un utilisateur en Claude Code CLI, en Cursor, ou sur un client MCP tiers n'en bénéficie pas : pour eux le chemin est le hook `PreToolUse` (C01) ou le relais de permission des channels (C04). Adopter les trois, c'est trois implémentations d'une même sémantique à garder cohérentes.
- **Ça inverse la responsabilité du projet.** mcp-coordinator est un serveur : il observe et notifie. `canUseTool` vit chez l'appelant. Livrer un orchestrateur de référence, c'est prendre en charge du code que le projet ne contrôle pas, avec une dépendance nouvelle (`@anthropic-ai/claude-agent-sdk`, absente de `package.json`) et son rythme de versions — trois versions distinctes citées rien que pour cette feature (0.2.111, 0.3.199, 0.3.223).
- **Le verrou dur n'est pas un mécanisme de sécurité.** `bypassPermissions` et `allowedTools` sautent le callback. Un utilisateur qui met un wildcard sur les outils MCP — ce que la doc Anthropic recommande explicitement pour MCP — désactive le verrou sans le savoir. On aurait un garde-fou qui se désarme dans la configuration recommandée : exactement le pattern « garde-fou fantôme » relevé à l'audit de juillet.
- **Le deadlock devient possible.** Aujourd'hui la pire conséquence d'une claim mal libérée est un avertissement en trop. Avec un verrou dur, c'est un agent figé jusqu'au TTL de 30 minutes. Il faudrait un `force_release`, une file d'attente équitable, une détection de cycle — c'est-à-dire construire un gestionnaire de verrous, un projet en soi.
- **YAGNI sur le profil de déploiement réel.** Le modèle consultatif actuel (annonce, score d'impact, quorum) suppose que les agents coopèrent. Personne n'a encore signalé un cas de production où l'avertissement a été ignoré et a causé un dégât. Sans ce signal, on paierait la complexité d'un verrou distribué pour un problème théorique.
- **Le bénéfice documentaire est décorrélé.** La correction sur `acceptEdits`/`allowedTools` dans le README ne coûte presque rien et ne demande aucune adoption. Elle peut être livrée seule, et l'essentiel de la valeur immédiate de cette fiche est peut-être là.

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
| 2026-08-14 | Vérification des faits : signature à 3 args, `permission_policy` limité aux serveurs http/sse, `requestId`/`null` hors doc publique. |
