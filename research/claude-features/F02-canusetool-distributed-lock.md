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
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — adopter partiellement ; (A) bloquee sur le prealable d'identite, livrable #371 |

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

**Ce que je pense avant de mesurer.** §6.5 porte déjà l'argument le plus lourd — le verrou dur n'est pas un mécanisme de sécurité, puisque `bypassPermissions` et `allowedTools` sautent le callback, et que la doc d'Anthropic **recommande explicitement** le wildcard pour les serveurs MCP. Un garde-fou qui se désarme **dans la configuration recommandée** est le motif « garde-fou fantôme » que l'audit de juillet a nommé.

Mais §2 donne une échappatoire apparente, et c'est elle qu'il faut tester : trois cas atteignent le callback **même sous `bypassPermissions`**, dont un outil MCP annoté `_meta["anthropic/requiresUserInteraction"]`. `F01` vient d'établir que le dépôt n'utilise **jamais** `_meta` — donc le coordinateur *pourrait* forcer son propre passage par le gate.

**Mon hypothèse est que cette échappatoire ne s'applique pas au cas qui compte, et que c'est là que la fiche se referme.** L'annotation force le gate **pour l'outil annoté**. Or ce que le verrou doit intercepter, c'est `Write` et `Edit` — des outils **intégrés**, pas les nôtres. Annoter les 26 outils du coordinateur ne fait donc rien pour gater une écriture de fichier. Le seul chemin resterait un `canUseTool` que l'hôte peut désactiver, dans la configuration que la doc recommande.

Second point à vérifier avant tout le reste, et il est local : §5 affirme que `handleWorkingFilesStart` renvoie `{ ok: true }` **inconditionnellement**. Si c'est vrai, l'endpoint sur lequel le verrou s'ancrerait **ne sait pas refuser** — il n'y a pas de fondation, et le chantier est plus gros que §6.1 ne le laisse croire.

Troisième point : le bénéfice documentaire de §4 est réel et **décorrélé** de toute adoption. C'est probablement le seul livrable de cette fiche.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

Trois volets adjugés séparément — leçon d'`E11`, `E14` et `E15` : (A) livrer un orchestrateur de référence à verrou dur, (B) piloter `permission_policy` par outil, (C) corriger la documentation.

| # | Volet | Critère de mort | Seuil chiffré |
|---|---|---|---|
| **K1** | (A) | **Le garde-fou se désarme dans la configuration recommandée.** Si `allowedTools` avec wildcard — que la doc Anthropic recommande pour MCP — saute le callback, le verrou n'est pas un mécanisme de sécurité. | `allowedTools`/`bypassPermissions` sautent le callback, **et** l'exception `requiresUserInteraction` ne couvre pas les outils **intégrés** `Write`/`Edit` |
| **K2** | (A) | **Il n'y a pas de fondation.** L'endpoint sur lequel le verrou s'ancre ne sait pas refuser. | `handleWorkingFilesStart` renvoie `{ ok: true }` **inconditionnellement** |
| **K3** | (A) | **Le TTL fait du deadlock une conséquence normale.** Aujourd'hui une claim mal libérée coûte un avertissement ; avec un verrou dur, c'est un agent figé. | TTL par défaut ≥ **30 min** et aucun `force_release` |
| **K4** | (A) | **Trois implémentations d'une même sémantique.** `canUseTool` (SDK), `PreToolUse` (C01), relais de permission des channels (C04) — à garder cohérentes. | ≥ **2** autres chemins déjà instruits par la veille |
| **K5** | (A)(B) | **Dépendance fournisseur nouvelle, à rythme rapide.** | `@anthropic-ai/claude-agent-sdk` absent de `package.json`, et ≥ **3** versions distinctes citées pour cette seule feature |
| **K6** | (B) | **`permission_policy` ne couvre pas nos transports.** | limité aux entrées de serveur **distant (http/sse)**, valeurs admises **non documentées** |
| **K7** | (C) | **Le bénéfice documentaire n'existe pas.** | ≥ **1** mention de `permissionMode`/`acceptEdits`/`allowedTools` déjà présente dans `README.md` ou `docs/` |

**Règle que je m'impose :** §0 classe la fiche ✅ **testable**, mais les PoC à deux agents exigent d'installer le SDK et une session authentifiée. Je mesure d'abord tout ce qui est local et décisif ; si l'installation devient nécessaire pour trancher, je le fais — et si je ne la fais pas, je le dis, sans conclure sur du raisonnement là où une exécution était possible. J'applique aussi les leçons : grepper la doc du dépôt avant de parler de manque (`E09`), vérifier une absence plutôt que la supposer (`E08`, `E10`, `E12`, `F01`), distinguer dérive de dépendance et défaut de vérification (`E13`, `E14`), et **réduire le périmètre plutôt que d'argumenter un seuil atteint** (`E15`).

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

#### A. Le critère de mort que je n'avais pas pré-enregistré, et il est décisif

**`AuthClaims` ne porte aucun `agent_id`.** Mesuré (`src/auth.ts:39-51`) :

```ts
export interface AuthClaims {
  sub: string; user_id: string; org: string; role: AuthRole; jti: string;
  active_org_id?: string; family_id?: string; service_account?: boolean;
}
```

Et les deux endpoints l'exigent dans le **corps** de la requête (`rest-handlers.ts:1001`, `:1025`) : rien ne lie une session MCP à un agent enregistré. **Un gate `canUseTool` n'a donc aucune identité avec laquelle réclamer un verrou.** C'est local, mesuré, et ça bloque le volet (A) avant que K1 à K5 n'aient à se prononcer.

Ce préalable n'est pas une découverte de ma part : **`C01` l'a identifié le 2026-08-15 et l'a explicitement remis à F02.** Son §7 : *« Jalon visé | après résolution du **préalable d'identité** (§7.3), **partagé avec `F02`** »*, et son journal : *« Préalable identifié et **sorti du périmètre** : d'où vient l'`agent_id`, question partagée avec `F02`. »*

#### B. Mon K4 inversait le texte de C01 — correction

J'allais écrire que « `C01` a déjà adopté un chemin de gate, donc F02 serait une deuxième implémentation ». **C'est l'inverse de ce que C01 dit.** Son §7.3 désigne F02 comme le **successeur** et nomme `working_files` comme son magasin :

> « Le successeur, une fois l'identité résolue : un outil **dédié** (`gate_file_write`) qui renvoie un `hookSpecificOutput` conforme, adossé à **`working_files`** — qui a un propriétaire et un TTL. »

F02 n'est donc pas un doublon : c'est le successeur désigné, **bloqué sur le même préalable**. Le seuil de K4 est littéralement atteint (deux autres chemins instruits : `C01` tranchée, `C04` encore ⬜) mais **la justification que j'allais publier était fausse**.

#### C. K2 : ma conclusion tient, mon mécanisme était un homme de paille

J'allais écrire que « l'endpoint ne sait pas refuser » et en conclure qu'il n'y a pas de fondation. **Deux erreurs.**

D'abord, `{ ok: true }` **est le contrat voulu**, pas un défaut : `docs/superpowers/specs/2026-05-10-v0.6-semantic-conflict-design.md:87-88` le spécifie tel quel, et l. 84 précise « **no new MCP tool** — keeps surface small ». Décrire une spécification comme un bug est exactement la faute que la leçon d'`E09` vise.

Ensuite, **« donc une migration de schéma » est faux.** `withTransaction` existe déjà (`src/db-adapter.ts:49`), documenté pour « any read-modify-write block where multiple statements must be atomic », et le coordinateur est mono-process par contrat. Un `start()` capable de refuser est un INSERT conditionnel dans une transaction plus un changement de type de retour `void → résultat`. J'aurais surestimé le coût.

**Ce qui reste vrai, et c'est plus dur que ce que j'avais trouvé** : le manque n'est pas le refus, c'est la **lecture**. `getIndex()` (`working-files-tracker.ts:125`) a **un seul appelant en production** — `src/impact-scorer.ts:86` — et **aucune surface de lecture n'existe** : la table de routage (`src/http/handle-rest.ts:63-140`) ne comporte aucune route lisant `working_files`. Pire, `check_file_conflict` (`files-tools.ts:59`) et `/api/check-conflict` lisent **`file_activity`**, pas `working_files` — le même piège que `C01` §7.2 avait déjà documenté. **Un gate ne peut donc pas décider seul : il lui faut un endpoint de lecture qui n'existe pas.**

Défaut annexe relevé au passage : `start()` fait un SELECT (l. 33-35) puis un INSERT (l. 36-42) **hors de toute transaction**, alors que la spec elle-même dit « Wrapped in `withTransaction` » (l. 110-111). Aujourd'hui la seule conséquence est une métrique mal étiquetée (l. 43).

#### D. Une erreur factuelle de la fiche que je n'avais pas vue

§4 affirme que le gate tiendrait le `requestId` jusqu'à la libération « signalée par le SSE ou MQTT que le serveur **émet déjà** ». **Faux.** `handleWorkingFilesStop` (`rest-handlers.ts:1018-1038`) appelle `stop()` puis renvoie `{ ok: true }` — **il n'émet rien**. Et aucun des types d'événements déclarés ne correspond à une libération de claim (le seul `*_claimed` est `task_claimed`, sans rapport). §5 porte la même faille sur sa ligne `sse-emitter.ts` / `mqtt-bridge.ts` : **les canaux existent, l'événement n'existe pas.**

#### E. K1 tient, mais il ne discrimine pas entre les deux chemins

Vérifié : **aucun des 26 outils n'écrit de fichier.** Les annoter `_meta["anthropic/requiresUserInteraction"]` ne peut donc pas gater une écriture — et « exiger un `announce_work` avant `post_to_thread` » est un ordonnancement de workflow, pas un verrou : ça n'empêche pas B d'écrire.

Donc K1 se déclenche : `bypassPermissions` et `allowedTools` sautent le callback, la doc recommande le wildcard pour MCP, et l'échappatoire ne couvre pas les outils intégrés.

**Mais je dois noter une asymétrie non mesurée.** `C01`, déjà adoptée, gate par `PreToolUse` — et son journal dit : *« **Fail-open confirmé à l'exécution** (erreur de validation et serveur arrêté : l'écriture passe) — donc la garantie est **molle**, contrairement à ce que promet §4. »* La garantie est donc molle **des deux côtés**. K1 ne départage pas `canUseTool` de `PreToolUse` : il condamne l'idée de « verrou dur » sur **les deux** chemins.

#### F. Le volet documentaire est le seul livrable, et il est double

**K7 ne se déclenche pas** — dans le bon sens : **0** mention de `permissionMode`, `acceptEdits` ou `allowedTools` dans `README.md` et tout `docs/`. Le piège est donc réel et non documenté.

Et la passe adversariale en a trouvé une seconde moitié : **le caractère consultatif des claims n'est documenté nulle part côté utilisateur.** Recherche de « advisory », « not a lock », « does not prevent » : aucun résultat pertinent, et `working_files` n'apparaît dans **aucune** doc utilisateur — seulement dans des specs internes. Or `README.md` parle de « coordination » aux lignes 76, 108 et 162 sans jamais dire que les claims n'empêchent rien. → **#371**

#### G. §0 était exacte — et mon commit de référence était le mauvais

J'avais relevé `handleWorkingFilesStart` en **994** contre 863 en §0, et j'allais parler de dérive. C'est de la dérive, mais **j'avais choisi le mauvais point de comparaison** : `605c082` est **deux commits après** l'arbre que §0 a réellement vérifié. À `5010c1a` (2026-08-14 13:24), **chaque citation est exacte** — `handleWorkingFilesStart` @863, `handleWorkingFilesStop` @887, `mqtt-tools.ts` @52, `files-tools.ts` @49, `handle-rest.ts` 116-117, `cli/channel.ts` 311-313. Trajectoire : `7d0224d`(860) → **`5010c1a`(863)** → `293a1a7`(953) → `db8cb27`(994).

**Zéro défaut de vérification. Quatrième fiche propre d'affilée** après `E14`, `E15` et `F01`. Seule dérive cosmétique : l'API est aujourd'hui `server.registerTool(` — `server.tool(` a 0 occurrence depuis la migration `4f62056`.

#### H. Adjudication

| # | Volet | Seuil | Mesure | Verdict |
|---|---|---|---|---|
| **K0** *(non pré-enregistré)* | (A) | — | **`AuthClaims` n'a pas d'`agent_id`** ; rien ne lie une session MCP à un agent | **BLOQUANT** — et déjà nommé par `C01`, qui l'a remis à F02 |
| **K1** | (A) | callback sautable + exception hors périmètre | confirmé ; aucun des 26 outils n'écrit de fichier | **SE DÉCLENCHE** — mais ne discrimine pas : `C01` a mesuré un **fail-open** sur son propre chemin |
| **K2** | (A) | endpoint inconditionnel | **conclusion juste, mécanisme faux** : `{ ok: true }` est la **spec** ; le vrai manque est l'**absence de surface de lecture** (`getIndex()` = 1 appelant, 0 route) ; et « migration de schéma » était **surestimé** (`withTransaction` existe) | **SE DÉCLENCHE, reformulé** |
| **K3** | (A) | TTL ≥ 30 min, aucun `force_release` | TTL `"30"` par défaut ; **0** occurrence de `force_release` dans `src/`, `cli/`, `sdk/`, `docs/`, `README` | **SE DÉCLENCHE** |
| **K4** | (A) | ≥ 2 autres chemins instruits | `C01` tranchée, `C04` ⬜ — **mais C01 délègue à F02**, elle ne le préempte pas | **SE DÉCLENCHE au seuil, justification corrigée** |
| **K5** | (A)(B) | SDK absent, ≥ 3 versions | absent de `package.json` et `sdk/package.json` ; 0.2.111 / 0.3.199 / 0.3.223 | **SE DÉCLENCHE** |
| **K6** | (B) | limité à http/sse, valeurs non documentées | confirmé par §0 contre le CHANGELOG | **SE DÉCLENCHE** |
| **K7** | (C) | ≥ 1 mention existante | **0** mention | **NE SE DÉCLENCHE PAS** — le bénéfice documentaire est réel |

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
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-17 |
| **Justification** | Trois volets adjugés séparément. ⭑ **(A) l'orchestrateur de référence à verrou dur : `reporter`, sur un préalable que je n'avais pas pré-enregistré et qui est décisif.** **`AuthClaims` ne porte aucun `agent_id`** (`src/auth.ts:39-51`) et les deux endpoints l'exigent dans le corps de la requête : rien ne lie une session MCP à un agent enregistré, donc **un gate `canUseTool` n'a aucune identité avec laquelle réclamer un verrou**. Ce préalable n'est pas ma trouvaille — **`C01` l'a identifié le 2026-08-15 et l'a explicitement remis à F02** (« préalable d'identité … partagé avec `F02` », « sorti du périmètre »). D'où `reporter` et non `refuser` : le mécanisme est prouvé (C01 a mesuré qu'un `permissionDecision: "deny"` **bloque** l'écriture) et le successeur est nommé (`gate_file_write`, adossé à `working_files`). Ce qui manque est nommé et hors périmètre. ⭑ **Mais « verrou dur » doit être abandonné comme promesse, sur les deux chemins.** K1 se déclenche — `bypassPermissions` et `allowedTools` sautent le callback, la doc Anthropic **recommande** le wildcard pour MCP, et l'échappatoire `requiresUserInteraction` ne couvre pas `Write`/`Edit` puisque **aucun des 26 outils n'écrit de fichier**. Et il ne discrimine pas : `C01` a mesuré un **fail-open** sur son propre chemin. La garantie est molle des deux côtés. ⭑ **(B) `permission_policy` par outil : `refuser`.** Limité aux entrées de serveur **distant (http/sse)**, valeurs admises **non documentées**. ⭑ **(C) la correction documentaire : `adopter`.** **0** mention de `permissionMode`/`acceptEdits`/`allowedTools` dans `README.md` et tout `docs/` — et la passe adversariale a trouvé une seconde moitié : **le caractère consultatif des claims n'est documenté nulle part côté utilisateur**, alors que `README.md` parle de « coordination » trois fois. → **#371** **Corrections de méthode — la passe adversariale a démoli quatre de mes justifications.** **Mon K4 inversait le texte de C01** : j'allais écrire qu'elle « a déjà un propriétaire, donc F02 serait un doublon », alors que son §7.3 **désigne F02 comme le successeur**. **Mon K2 attaquait un homme de paille** : `{ ok: true }` **est le contrat spécifié** (`design-spec:87-88`), pas un défaut — décrire une spec comme un bug est la faute que la leçon d'`E09` vise ; et « donc une migration de schéma » était **surestimé**, `withTransaction` existant déjà. Le vrai manque est l'**absence de surface de lecture** : `getIndex()` a **un seul** appelant en production et **aucune route** ne lit `working_files` — tandis que `check_file_conflict` lit `file_activity`, le piège que `C01` §7.2 avait déjà documenté. **Et mon commit de référence était le mauvais** : `605c082` est deux commits après l'arbre que §0 a vérifié ; à **`5010c1a`** chaque citation est exacte. **Zéro défaut de vérification — quatrième fiche propre d'affilée** après `E14`, `E15` et `F01`. ⭑ **Erreur factuelle de la fiche, que je n'avais pas vue :** §4 affirme que la libération est « signalée par le SSE ou MQTT que le serveur émet déjà ». **Faux** — `handleWorkingFilesStop` n'émet **rien**, et aucun type d'événement ne correspond à une libération de claim. Les canaux existent, l'événement n'existe pas. |
| **Issue / PR** | **#371** — deux silences de la doc, mesurés et corrigeables en deux paragraphes : `acceptEdits` n'auto-approuve **pas** les outils MCP (0 mention dans le dépôt, wildcard `allowedTools` recommandé par Anthropic), et les claims `working_files` **n'empêchent rien** (`PRIMARY KEY (agent_id, file_path)` donc multi-détenteur assumé, `start(): void`, TTL 30 min, aucun `force_release`) sans que ce soit écrit dans aucune doc utilisateur. |
| **Jalon visé** | **#371** immédiatement : décorrélé de toute adoption, coût quasi nul, et il ferme deux surprises utilisateur symétriques. **(A) est en attente du préalable d'identité**, partagé avec `C01` — c'est lui qu'il faut instruire, pas F02. Deux prérequis à ajouter au périmètre du successeur quand il viendra : une **surface de lecture** de `working_files` (aucune route n'en lit aujourd'hui) et un **événement de libération** (aucun n'existe). Aucun jalon pour (B). |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : signature à 3 args, `permission_policy` limité aux serveurs http/sse, `requestId`/`null` hors doc publique. |
| 2026-08-17 | **Challenge — verdict `adopter partiellement` ; le critère décisif n'était pas dans mes critères.** **`AuthClaims` ne porte aucun `agent_id`** (`src/auth.ts:39-51`), et les deux endpoints l'exigent dans le corps : rien ne lie une session MCP à un agent enregistré, donc **un gate `canUseTool` n'a aucune identité avec laquelle réclamer un verrou**. Ce préalable n'est pas ma trouvaille — **`C01` l'a identifié le 2026-08-15 et remis à F02** (« préalable d'identité … partagé avec `F02` », « sorti du périmètre »). D'où **`reporter` sur (A)** et non `refuser` : le mécanisme est prouvé (C01 a mesuré qu'un `permissionDecision: "deny"` bloque l'écriture) et le successeur est nommé (`gate_file_write`). **Mais « verrou dur » doit être abandonné comme promesse sur les deux chemins** : K1 se déclenche — callback sautable par `bypassPermissions`/`allowedTools`, wildcard **recommandé** par Anthropic pour MCP, et l'échappatoire `requiresUserInteraction` ne couvre pas `Write`/`Edit` puisque **aucun des 26 outils n'écrit de fichier** — et il ne discrimine pas, `C01` ayant mesuré un **fail-open** sur son propre chemin. **(B) refusé** : `permission_policy` limité aux serveurs http/sse, valeurs non documentées. **(C) adopté** : **0** mention de `permissionMode`/`acceptEdits`/`allowedTools` dans `README.md` et `docs/`, plus une seconde moitié trouvée par la passe adversariale — **le caractère consultatif des claims n'est documenté nulle part côté utilisateur**, alors que `README.md` parle de « coordination » trois fois. → **#371**. **La passe adversariale a démoli quatre de mes justifications.** **Mon K4 inversait le texte de C01** : son §7.3 **désigne F02 comme le successeur**, elle ne le préempte pas. **Mon K2 attaquait un homme de paille** : `{ ok: true }` **est le contrat spécifié** (`design-spec:87-88`, « no new MCP tool — keeps surface small »), donc décrire une spec comme un bug ; et « donc une migration de schéma » était **surestimé** puisque `withTransaction` existe déjà (`db-adapter.ts:49`) et que le coordinateur est mono-process. Le vrai manque est l'**absence de surface de lecture** : `getIndex()` a **un seul** appelant en production (`impact-scorer.ts:86`) et **aucune route** de `handle-rest.ts` ne lit `working_files`, tandis que `check_file_conflict` lit `file_activity` — le piège que `C01` §7.2 avait déjà documenté. **Et mon commit de référence était le mauvais** : `605c082` est deux commits après l'arbre vérifié par §0 ; à **`5010c1a`** (2026-08-14 13:24) chaque citation est exacte (start@863, stop@887, mqtt@52, files@49). **Zéro défaut de vérification — quatrième fiche propre d'affilée** après `E14`, `E15`, `F01`. **Erreur factuelle de la fiche que je n'avais pas vue** : §4 dit la libération « signalée par le SSE ou MQTT que le serveur émet déjà » — **faux**, `handleWorkingFilesStop` n'émet **rien** et aucun type d'événement ne correspond ; les canaux existent, l'événement non. Défaut annexe : `start()` fait SELECT puis INSERT **hors transaction**, alors que la spec dit « Wrapped in `withTransaction` ». |
