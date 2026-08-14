# E10 — Memory tool : le daemon comme backend de mémoire partagée entre agents

| Champ | Valeur |
|---|---|
| **ID** | `memory-tool-shared-repo-memory` |
| **Surface** | claude-api |
| **Statut** | GA (helpers SDK encore dans le namespace `beta`) |
| **Disponible depuis** | beta 2025-09-29 · GA 2026-02-17 · tous modèles Claude 4 et ultérieurs |
| **Tier** | T2-fort-levier |
| **Nature** | opportunity |
| **Effort estimé** | L |
| **Confiance veille** | medium |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — handler + garde testables, boucle multi-agents exige une clé API |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** ✅ saine

**Corrections apportées :**
- §2 — attribution des helpers SDK précisée (la liste laissait croire qu'ils existent partout) : `BetaAbstractMemoryTool` = Python et C# uniquement ; `betaMemoryTool` = TypeScript ; `BetaMemoryToolHandler` = Java ; `BetaLocalFilesystemMemoryTool` = Python et TypeScript seulement ; `tool_runner` / `toolRunner` = surface beta de chaque SDK. Aucune erreur de nom, seulement une imprécision de portée.
- §2 — ajout de la mention explicite « aucun header beta requis » (fait établi par la doc, absent de la fiche).

Faits re-confirmés sans changement, contre la doc officielle et le repo :
- `{"type": "memory_20250818", "name": "memory"}`, pas d'`input_schema`, GA sur la Messages API sans header beta, tous modèles Claude 4 et ultérieurs.
- Les 6 commandes et **tous** leurs champs (`view`/`path`+`view_range`, `create`/`file_text`, `str_replace`/`old_str`+`new_str` optionnel, `insert`/`insert_line`+`insert_text`, `delete`/`path`, `rename`/`old_path`+`new_path`) sont exacts.
- Le prompt système auto-injecté (« ALWAYS VIEW YOUR MEMORY DIRECTORY… ASSUME INTERRUPTION ») et l'exemple de traversal `/memories/../../secrets.env` sont bien dans la doc, mot pour mot.
- Dates du tableau d'en-tête exactes : release notes API du **29 septembre 2025** (lancement beta) et du **17 février 2026** (« now generally available (no beta header required) »).
- Types : `MemoryTool20250818Param` (Go), `MemoryTool20250818` (C#/Java/PHP), `BetaMemoryTool20250818` (namespace beta Java/PHP) — tous vérifiés dans les exemples de code de la doc.
- §5 — **tous** les fichiers cités existent et toutes les affirmations tiennent : `src/database.ts` fait bien 66 Ko (1697 lignes), schéma courant lignes 90-326, migrations `_new` lignes 1186-1478 ; les 6 modules `src/tools/` suivent bien la signature `registerXTools(server, services: CoordinatorServices, mcpLog, getSessionClaims)` ; `CoordinatorServices` est bien déclaré `src/server-setup.ts:32` ; `safeJoinUnderRoot` gère bien `\0`, le percent-encoding et le piège `/var/data-evil` ; le sweeper annonce bien 11 `DELETE … LIMIT 1000` avec `SWEEP_INTERVAL_MS = 60_000` et `getOrgSetting` ; `GENESIS_HASH`/`canonicalRowFields`/`TIER1_EVENTS`/`TIER2_EVENTS` existent ; `handleAnnounce` (rest-handlers.ts:189) et `handleWorkingFilesStart` (:863) existent, 28 handlers exportés (« ~30 » tient) ; `cli/channel.ts` déclare bien `mcp-coordinator-channel` v0.2.0 et n'expose que `post_to_thread`.

**Marqueurs `(à vérifier)` restants :** aucun — la fiche n'en contenait aucun.

**Testabilité :** ⚠️ partielle
Testable ici sans rien de plus : les cases 3 et 4 du protocole (vecteurs de traversal contre `src/path-guard.ts` via `pnpm test`, et la relecture d'écart `src/consultation.ts` / `src/announce-workflow.ts`), plus un handler mémoire mock en SQLite pour mesurer hors-ligne la taille du listing `view /memories` à 5/20/100 entrées.
Bloqué : les cases 1, 2 et 5 exigent des appels réels à la Messages API (deux sessions concurrentes, comptage de tokens), donc un `ANTHROPIC_API_KEY` facturable — aucun header beta ni accès preview n'est nécessaire, seulement la clé. Claude Code n'expose pas de point d'accroche pour un handler mémoire : la boucle applicative doit être écrite à la main avec le SDK.

## 1. Ce que c'est

Le *memory tool* est un outil dont Anthropic définit le schéma mais dont l'exécution est **côté client** : Claude émet des `tool_use` décrivant des opérations de fichiers sous le préfixe `/memories`, et c'est l'application appelante qui les applique sur le stockage de son choix. La déclaration est minimale — `{"type": "memory_20250818", "name": "memory"}` — sans `input_schema` à fournir, comme les autres outils serveur-définis. Six commandes couvrent le cycle de vie : `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. Point structurant pour nous : **le préfixe `/memories` est purement logique** ; le handler est libre de le mapper sur un système de fichiers, une base de données, un service distant — rien n'impose un stockage local par session.

L'API injecte automatiquement dans le prompt système une consigne du type « TOUJOURS consulter le répertoire mémoire avant toute chose » et « ASSUME INTERRUPTION » : le modèle va donc spontanément faire un `view` de `/memories` au début de chaque tour, sans qu'on ait à l'instruire. La documentation place explicitement la responsabilité sécurité chez l'implémenteur : protection contre le path traversal (l'exemple cité est `/memories/../../secrets.env`), plafonnement de taille et expiration des entrées. La fonctionnalité se combine avec le *context editing* (nettoyage des anciens résultats d'outils) documenté sur la même surface.

## 2. Surface d'API exacte

```jsonc
// Déclaration de l'outil — le name DOIT valoir "memory"
"tools": [
  { "type": "memory_20250818", "name": "memory" }
]
```

Commandes et champs de `input` :

| `command` | Champs |
|---|---|
| `view` | `path`, `view_range` (`[start, end]`, `[start, -1]`) |
| `create` | `path`, `file_text` |
| `str_replace` | `path`, `old_str`, `new_str` (optionnel → suppression) |
| `insert` | `path`, `insert_line`, `insert_text` |
| `delete` | `path` |
| `rename` | `old_path`, `new_path` |

```jsonc
// tool_use émis par Claude
{ "type": "tool_use", "name": "memory",
  "input": { "command": "create", "path": "/memories/shared/decisions.md",
             "file_text": "..." } }

// réponse renvoyée par l'application
{ "type": "tool_result", "tool_use_id": "...", "content": "File created" }
// erreur : ajouter "is_error": true
```

Aucun header beta n'est requis : l'outil est GA sur la Messages API.

Helpers SDK — **tous encore dans le namespace `beta`** malgré le statut GA de l'outil, et **inégalement répartis** : `BetaAbstractMemoryTool` (Python et C# uniquement, à sous-classer), `betaMemoryTool` (TypeScript), `BetaMemoryToolHandler` (Java, à implémenter), `BetaLocalFilesystemMemoryTool` (implémentation filesystem prête à l'emploi, Python et TypeScript seulement), `tool_runner` / `toolRunner` (surface beta de chaque SDK). PHP passe par le `BetaRunnableTool` générique ; **Go et Ruby n'ont aucun helper** et exigent une implémentation manuelle de la boucle tool-use. Types : `MemoryTool20250818Param` (Go), `MemoryTool20250818` (C#/Java/PHP), `BetaMemoryTool20250818` (namespace beta Java/PHP).

## 3. Sources

- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://platform.claude.com/docs/en/build-with-claude/context-editing

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.** Aujourd'hui la mémoire d'un agent est isolée : chaque session Claude Code repart de zéro ou d'un `CLAUDE.md` statique, et la seule coordination durable passe par les threads de consultation (`src/consultation.ts`) qui sont orientés question/réponse synchrone, pas capitalisation. mcp-coordinator est déjà **le** daemon partagé par toutes les sessions d'un repo : le brancher comme backend du memory tool ferait de `/memories/shared/` un canal de coordination asynchrone durable et multi-agents — l'agent A écrit « le module `auth/refresh-rotation.ts` a une invariante d'epoch, ne pas toucher sans lire X », l'agent B le lit automatiquement au tour suivant parce que l'API l'y force par prompt système. On récupère gratuitement le scoping org (`src/auth.ts`), le quota (`src/quota/quota.ts`), la chaîne d'audit SHA-256 (`src/security/audit-chain.ts`) et l'expiration (`src/sweeper/index.ts`) déjà en place.

C'est une **capacité nouvelle, pas un remplacement** : aucun code existant ne disparaît. La contrepartie est qu'il faut implémenter la protection path-traversal sur l'espace `/memories`, distincte de `safeJoinUnderRoot` de `src/path-guard.ts` qui travaille sur des chemins d'URL et un root filesystem, pas sur un espace de noms logique en base.

**Risque si on ne fait rien.** Faible et indirect. Le risque réel est de commodité : si Anthropic ou un tiers publie un backend de mémoire partagée « repo-wide », il occupe exactement la niche que mcp-coordinator revendique (l'état partagé entre agents d'un même dépôt), et le daemon se retrouve cantonné à la détection de conflits.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/tools/` (nouveau `memory-tools.ts`) | Les 6 domaines existants (`agents-tools.ts`, `consultation-tools.ts`, `files-tools.ts`, `dependencies-tools.ts`, `status-tools.ts`, `mqtt-tools.ts`) suivent tous le pattern `registerXTools(server, services, mcpLog, getSessionClaims)` — un 7e module exposerait `memory_view` / `memory_write` côté MCP. |
| `src/server-setup.ts` | Câblage : `CoordinatorServices` est le conteneur passé à chaque `registerXTools` ; il faudrait y ajouter le store mémoire. |
| `src/database.ts` | Nouvelle table (`CREATE TABLE IF NOT EXISTS`, lignes ~90-326 pour le schéma courant) + une migration `_new`/copy comme celles des lignes ~1186-1478. Fichier de 66 Ko : le point de friction principal. |
| `src/path-guard.ts` | `safeJoinUnderRoot(root, urlPath)` existe déjà et gère `\0`, le percent-encoding et le préfixe-piège `/var/data` vs `/var/data-evil`. **Ne convient pas tel quel** pour `/memories` (espace logique, pas filesystem) : il faut un garde jumeau, pas une réutilisation. |
| `src/security/audit-chain.ts`, `src/security/audit.ts`, `src/security/audit-events.ts` | Chaîne append-only SHA-256 (`GENESIS_HASH`, `canonicalRowFields`) : chaque écriture mémoire devient un événement auditable. Nécessite de classer les nouveaux events en `TIER1_EVENTS` / `TIER2_EVENTS`. |
| `src/sweeper/index.ts` | Le sweeper balaie déjà 11 tables par `DELETE ... LIMIT 1000` toutes les 60 s. L'expiration exigée par la doc mémoire s'y branche comme une 12e table, avec rétention par org via `getOrgSetting`. |
| `src/quota/quota.ts`, `src/quota/quota-cache.ts` | Le plafonnement de taille demandé par la doc s'appuie sur l'infrastructure quota existante plutôt que sur une limite ad hoc. |
| `src/http/rest-handlers.ts`, `src/http/handle-rest.ts` | Surface REST parallèle (le fichier route déjà ~30 handlers : `handleAnnounce`, `handleWorkingFilesStart`…) pour les clients non-MCP. |
| `src/sse-emitter.ts`, `src/mqtt-bridge.ts` | Notifier les autres agents qu'une entrée `/memories/shared/` a changé — sinon la mémoire partagée n'est lue qu'au tour suivant de chaque agent. |
| `sdk/src/client.ts` | Le SDK TypeScript devrait exposer le store pour qu'une app tierce implémente `BetaAbstractMemoryTool` contre le daemon en quelques lignes. |
| `cli/channel.ts` | Serveur MCP stdio des Claude Code Channels (`mcp-coordinator-channel` v0.2.0) : décider s'il relaie les outils mémoire ou reste sur `post_to_thread`. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Une mémoire partagée `/memories/shared/` écrite en langage libre par les agents apporte-t-elle quelque chose que les threads de consultation (`src/consultation.ts`) et `announce` ne couvrent pas déjà — ou bien mcp-coordinator doit-il seulement **exposer** son état structuré existant (agents, working files, dependency map) comme une arborescence `/memories` en lecture seule, et laisser l'écriture libre aux fichiers du repo ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

> ⚠️ Les étapes 1, 2 et 5 ne sont pas exécutables ici sans `ANTHROPIC_API_KEY` : elles exigent de vrais appels Messages API, et Claude Code n'expose aucun point d'accroche pour un handler mémoire.

Proposition d'étapes — à valider et amender pendant le challenge.

- [ ] Écrire un handler mémoire minimal (100 lignes, SQLite direct, hors repo) et lancer deux sessions Claude API concurrentes qui écrivent dans `/memories/shared/` : mesurer si le modèle relit réellement ce que l'autre a écrit sans instruction explicite.
- [ ] Mesurer le coût en tokens du `view /memories` automatique injecté à chaque tour, sur une arborescence de 5, 20 et 100 entrées — c'est le vrai plafond de scalabilité de l'approche.
- [ ] Tester les vecteurs de traversal (`/memories/../../secrets.env`, `%2e%2e`, `\0`, chemins Windows `..\\`) contre le garde envisagé, en réutilisant les cas de test de `src/path-guard.ts`.
- [ ] Relire `src/consultation.ts` et `src/announce-workflow.ts` pour lister ce qu'une mémoire partagée ferait qui n'est pas déjà faisable — si la liste est vide, la fiche se referme ici.
- [ ] Vérifier qu'un client MCP non-Claude (ou Claude Code sans clé API directe) reste fonctionnel : l'outil mémoire est une notion API Messages, pas MCP.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Mauvaise couche.** Le memory tool est un concept de la **Messages API**, pas du protocole MCP. mcp-coordinator est un serveur MCP : il ne voit jamais le bloc `tools[]` d'une requête Messages. L'intégration exige donc un adaptateur côté application appelante (Claude Code ne l'expose pas), ce qui déplace une partie du travail hors du repo et hors de notre contrôle.
- **Recouvrement fonctionnel.** Threads de consultation, `announce`, `working_files` et `dependency_map` couvrent déjà « qui fait quoi, où, et ce qui a été décidé », en **structuré**. Une mémoire en markdown libre est plus expressive mais moins vérifiable, et rien ne garantit qu'elle ne devienne pas un dépotoir non maintenu — un `CLAUDE.md` qui grossit sans être relu.
- **Coût de contexte.** L'API force un `view` du répertoire mémoire à chaque tour. Une mémoire partagée entre N agents grossit N fois plus vite qu'une mémoire individuelle : le mécanisme même qui la rend utile la rend coûteuse, et le remède (context editing) est une deuxième dépendance à intégrer.
- **Surface de sécurité nouvelle.** On ouvre une écriture arbitraire de contenu, cross-agent, persistée et lue automatiquement par d'autres modèles : c'est un vecteur d'injection de prompt agent-à-agent que le projet n'a pas aujourd'hui. Le path traversal n'est que la moitié du problème.
- **Effort L sur `src/database.ts`.** Le fichier fait 66 Ko et le pattern de migration (table `_new` + copie) est lourd. Une table de plus, avec quota, sweep et audit, n'est pas un après-midi de travail.
- **Helpers SDK en `beta`.** L'outil est GA mais `BetaAbstractMemoryTool` & co. restent dans le namespace beta, et Go/Ruby n'ont aucun helper — la portabilité annoncée est partielle.
- **YAGNI.** Aucun utilisateur n'a demandé ça. Le bundle ne contient qu'**une seule** source de recherche pour cette fiche (`n_sources: 1`), avec une confiance `medium` : le signal d'usage réel est faible.

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
| 2026-08-14 | Vérification des faits : API, dates et §5 exacts ; portée des helpers SDK précisée ; testabilité partielle. |
