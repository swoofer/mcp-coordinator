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
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — refuser ; le benefice reel coute ~15 lignes ; branche lecture seule renvoyee a #281 |

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

**Contexte d'arrivée.** Le challenge de `E05` (2026-08-17) a explicitement **renvoyé ici** son angle (b) — la mémoire de repo partagée — en notant que `E10` pose la même question « en mieux et sans dépendance beta ». Cette fiche en est donc le propriétaire ; c'est ici que la question se tranche ou se ferme.

**Ce que je pense avant de mesurer.** §6.3 pose sa propre condition de fermeture, et elle est exécutable : *« Relire `src/consultation.ts` et `src/announce-workflow.ts` pour lister ce qu'une mémoire partagée ferait qui n'est pas déjà faisable — si la liste est vide, la fiche se referme ici. »* Je m'attends à ce que la liste **ne soit pas vide** — les threads sont orientés question/réponse synchrone et `action_summaries` est purgé à 30 jours — mais à ce que chaque élément soit **plus petit que ce que §4 laisse croire**.

Et je m'attends à ce que le verdict se joue ailleurs que sur le recouvrement fonctionnel : sur la **couche**. Le memory tool est une notion de la Messages API ; un serveur MCP ne voit jamais le `tools[]` d'une requête. `E08` vient de mesurer la même chose sur `defer_loading` et j'y avais tiré une conclusion fausse — je dois donc vérifier, et non déduire, s'il existe un levier côté MCP.

Hypothèse secondaire : la vraie objection n'est ni le coût de contexte ni l'effort, mais l'**injection agent-à-agent**. `E08` a produit l'issue **#355** parce que `cli/channel.ts` recopie déjà du texte d'agent non borné dans le contexte d'un autre agent. Une mémoire partagée serait la même chose en **persistant** et en **auto-lue par prompt système** — c'est-à-dire pire, à un endroit où le projet a déjà un défaut ouvert.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

Ici, « adopter » signifie **écrire une mémoire partagée en langage libre** (`/memories/shared/`) avec le daemon comme backend. Un seul critère qui se déclenche le tue.

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **La condition de fermeture de la fiche elle-même.** Si tout ce qu'une mémoire partagée apporterait est déjà faisable avec les threads, `announce` et `action_summaries`, la fiche se referme. | liste des apports non couverts **= 0** |
| **K2** | **YAGNI.** `E05` a mesuré 0 demande sur 81 issues ; le bundle n'a **qu'une** source (`n_sources: 1`, confiance `medium`). | **0** issue, discussion ou document du dépôt réclamant une mémoire partagée persistante |
| **K3** | **Mauvaise couche.** Si aucun levier MCP n'existe et que l'adaptateur doit vivre hors du dépôt, l'« adoption » se réduit à de la documentation pour un tiers. | **0** point d'accroche côté MCP, **vérifié** et non déduit |
| **K4** | **Le coût de contexte tue la mise à l'échelle.** L'API force un `view /memories` par tour ; une mémoire partagée entre N agents grossit N fois plus vite. | listing `view /memories` > **2 000** caractères à 100 entrées |
| **K5** | **Injection agent-à-agent aggravée.** Écriture libre, persistée, auto-lue par prompt système. | le dépôt a **déjà** un défaut ouvert de recopie de texte d'agent (#355) et **aucune** allowlist d'émetteur |
| **K6** | **Effort L confirmé.** Table + migration `_new` + quota + sweep + audit, dans un `database.ts` de 66 Ko. | ≥ **5** sous-systèmes à toucher pour une écriture mémoire |

**Règle que je m'impose :** §0 classe la fiche ⚠️ **partielle** — les étapes 1, 2 et 5 exigent une clé API facturable. Elles ne peuvent donc **jamais** recevoir `adopter`. Et j'applique la leçon de `E09` : **avant de publier une mesure comme découverte, grepper la doc du dépôt** pour vérifier qu'elle n'y est pas déjà.

### 6.3 Protocole de vérification

> ⚠️ Les étapes 1, 2 et 5 ne sont pas exécutables ici sans `ANTHROPIC_API_KEY` : elles exigent de vrais appels Messages API, et Claude Code n'expose aucun point d'accroche pour un handler mémoire.

Proposition d'étapes — à valider et amender pendant le challenge.

- [ ] Écrire un handler mémoire minimal (100 lignes, SQLite direct, hors repo) et lancer deux sessions Claude API concurrentes qui écrivent dans `/memories/shared/` : mesurer si le modèle relit réellement ce que l'autre a écrit sans instruction explicite.
- [ ] Mesurer le coût en tokens du `view /memories` automatique injecté à chaque tour, sur une arborescence de 5, 20 et 100 entrées — c'est le vrai plafond de scalabilité de l'approche.
- [ ] Tester les vecteurs de traversal (`/memories/../../secrets.env`, `%2e%2e`, `\0`, chemins Windows `..\\`) contre le garde envisagé, en réutilisant les cas de test de `src/path-guard.ts`.
- [ ] Relire `src/consultation.ts` et `src/announce-workflow.ts` pour lister ce qu'une mémoire partagée ferait qui n'est pas déjà faisable — si la liste est vide, la fiche se referme ici.
- [ ] Vérifier qu'un client MCP non-Claude (ou Claude Code sans clé API directe) reste fonctionnel : l'outil mémoire est une notion API Messages, pas MCP.

### 6.4 Résultat observé

#### A. La condition de fermeture de la fiche : ma liste tombe de 4 apports à 1

J'avais dressé quatre apports non couverts. **Trois sont faux**, et la passe adversariale les a démolis un par un.

**Apport 1 — « survivre à 30 jours » : FAUX, deux fois.** D'abord la rétention est configurable (`getOrgSetting` → `COORDINATOR_*_RETENTION_DAYS`). Mais surtout, mesuré :

```
$ grep 'DELETE FROM' src/sweeper/index.ts   (tables distinctes)
  action_summaries  audit_log  device_auth_requests  events  file_activity
  layer_firings  oauth_state  refresh_tokens  thread_messages

$ grep -c 'DELETE FROM threads' src/sweeper/index.ts
0
```

**La table `threads` n'est pas balayée.** `threads.plan` et `threads.resolution_summary` — les **décisions** — persistent indéfiniment, comme `dependency_map`, `working_files` et `agents`. Ce qui part à 30 jours est la *conversation* (`thread_messages`) et le *journal d'action* (`action_summaries`), pas la conclusion. **§4 se trompe donc quand elle écrit que les threads sont « orientés question/réponse synchrone, pas capitalisation »** : un `resolution_summary` sur une table jamais purgée *est* de la capitalisation.

**Apport 2 — « adressabilité par sujet » : FAUX.** `listThreads(orgId, {module, status})` existe (`src/consultation.ts:511`) avec une correspondance **exacte** par module (`:563`) :

```sql
AND EXISTS (SELECT 1 FROM json_each(target_modules) WHERE value = ?)
```

C'est exposé comme l'outil MCP `list_threads` avec les filtres `module` et `status`, et il rend les lignes complètes — `plan` et `resolution_summary` inclus. Et `dependency_map` est indexé par `module_id`.

**Apport 4 — « contenir plus qu'une ligne » : FAUX.** `summary: z.string()` (`consultation-tools.ts:506`) n'a **aucun `.max()`**. « One-liner » est de la prose de description, pas un contrat. (Cohérent avec ce que #355 a compté : 12 `z.string()` non bornés.)

**Apport 3 — « être lu sans appel explicite » : à moitié faux.** `announce_work` renvoie `context: contextForInitiator` (`consultation-tools.ts:197-217`), construit par `contextProvider.getRelevantContext()`, que l'initiateur n'a pas demandé — et `src/mcp-instructions.ts:29` impose d'appeler `announce_work` avant toute édition. **La livraison automatique existe déjà**, adossée à un appel obligatoire. Ce qui manque est seulement la **cadence par tour**.

**Bilan : K1 = 1 apport, pas 4.** Et il se formule précisément : *durable* et *auto-livré* existent sur **deux chemins différents**. Durable = `threads` (jamais purgée, mais il faut appeler `list_threads`). Auto-livré = `action_summaries` via le `context` d'`announce_work` (mais purgé à 30 j). **Rien ne combine les deux.**

#### B. Et ce seul apport survivant coûte ~15 lignes, pas un sous-système

`SummaryContextProvider.getRelevantContext()` (`src/context-provider.ts:42`) reçoit déjà `Consultation` par injection (`:13`). Y ajouter `listThreads(orgId, {module, status: 'resolved'})` fait remonter automatiquement les décisions durables du module concerné, dans le `context` que l'initiateur reçoit déjà sans le demander.

Aucun memory tool, aucune table, aucun garde de traversal, aucun quota, aucun sweep, aucune clé API. **C'est la mesure qui tue la fiche** : son bénéfice réel est atteignable par un ajout de ~15 lignes dans un fournisseur existant, contre un effort annoncé `L`.

#### C. Mon argument central était trop fort — le daemon *peut* forcer une lecture, mais par session

J'allais écrire que mcp-coordinator ne peut **structurellement pas** fournir de lecture forcée. C'est faux comme formulé. `createMcpServer()` est documenté « one per MCP session » (`src/server-setup.ts:193`) et passe `{ instructions: MCP_INSTRUCTIONS }` (`:244`) avec `services` — donc tout le store — déjà en portée (`:212-224`). Le daemon **peut** calculer des `instructions` par session portant un instantané de mémoire partagée **dans le prompt système**.

La formulation juste est donc : il peut forcer une lecture **par session**, pas **par tour**. Et deux choses la condamnent quand même :

```
MCP_INSTRUCTIONS            : 1 348 caracteres
troncature Claude Code      : 2 048  (tests/unit/mcp-instructions.test.ts:125)
budget restant              :   700 octets  (~175 tokens)
```

Et surtout — c'est le point qui aggrave K5 — `instructions` est **la seule chaîne qui atteint le prompt système** (établi par le challenge `C03`, cité dans le corps de #355). Y router de la prose d'agent lui donnerait l'**autorité opérateur**, c'est-à-dire **strictement pire que #355**, qui note explicitement que le contenu de channel atterrit dans un corps `<channel>` et « n'acquiert donc pas d'autorité opérateur ». Le seul canal de lecture forcée que MCP offre fait 700 octets, et le dépenser en prose d'agent est la seule escalade que le projet a jusqu'ici évitée.

Note factuelle vérifiée au passage : le SDK MCP installé **supporte bien** `registerResource`, `registerPrompt`, `resources/list`, `resources/subscribe` et `sendResourceListChanged`. **K3 ne se déclenche donc pas** — mon critère supposait à tort qu'aucun point d'accroche n'existait. Mais aucun de ces mécanismes ne provoque une lecture par tour : une notification `resources/updated` peut être ignorée du client, et #281 a mesuré que Claude Code n'appelle jamais `resources/subscribe`.

#### D. Le coût de contexte, et pourquoi il est pire que mon seuil

```
  5 entrees :   212 car.  (~59 tokens estimes)
 20 entrees :   764 car.  (~212 tokens estimes)
100 entrees : 3 666 car.  (~1 018 tokens estimes)
```

**K4 se déclenche** (seuil 2 000 caractères à 100 entrées). Mais je le sous-estimais : c'est **par tour**, et chaque résultat de `view` reste dans le transcript. Vingt tours sur une mémoire de 100 entrées ≈ 20 000 tokens de listings répétés — et ça croît avec le nombre d'agents, puisque c'est précisément le partage qui fait grossir l'arbre. **C'est le cumulé qui passe mal à l'échelle, pas l'unitaire.**

#### E. Deux erreurs de la fiche à corriger, et un motif à nommer

`sdk/src/client.ts` (329 lignes) est **intégralement** de la plomberie OAuth/token — `deviceCodeStart/Poll`, `refresh`, `whoami`, `logout`, `revoke`, magasin de jetons. **Zéro méthode de données de coordination.** Il n'y a donc aucun store à exposer, et le « en quelques lignes » de §5 est faux d'une API de données entière.

Et §0 affirme « **tous** les fichiers cités existent et toutes les affirmations tiennent ». Au moins cinq de ses chiffres sont faux :

| Affirmation de la fiche | Réel |
|---|---|
| `src/database.ts` **66 Ko / 1697 lignes** | **96,8 Ko / 2370 lignes** |
| migrations `_new` lignes ~1186-1478 | `threads_new` à **1502**, dernière à **2254** |
| `handleAnnounce` à `rest-handlers.ts:189` | **204** |
| `handleWorkingFilesStart` à `:863` | **994** |
| « schéma courant lignes 90-326 » | la constante `SCHEMA` oui, mais 23 `CREATE TABLE` vont jusqu'à **1058** |

Tiennent en revanche : 28 handlers exportés (« ~30 » est juste), `cli/channel.ts` = `mcp-coordinator-channel` v0.2.0 n'exposant que `post_to_thread`, les 6 signatures `registerXTools(server, services, mcpLog, getSessionClaims)`, les 26 outils, et le sweeper à 11 `DELETE` / 60 s / `getOrgSetting`.

**Le motif mérite d'être nommé** : c'est la troisième fiche d'affilée (`E08`, `E09`, `E10`) dont la §0 se déclare vérifiée alors que ses références ont dérivé. La passe du 2026-08-14 a vérifié un HEAD qui a bougé depuis, et rien ne le signale au lecteur.

#### F. Adjudication des six critères pré-enregistrés

| # | Seuil | Mesure | Verdict |
|---|---|---|---|
| **K1** | liste des apports non couverts = 0 | **1** (et non 4) : rien ne combine *durable* et *auto-livré* — mais l'écart coûte ~15 lignes dans `context-provider.ts` | **NE SE DÉCLENCHE PAS** — la fiche ne se referme pas sur sa propre condition, mais de justesse et pour un enjeu minuscule |
| **K2** | 0 demande | 0 mention dans `README.md` / `docs/` ; 0 sur 81 issues (mesuré en `E05`) ; `n_sources: 1`, confiance `medium` | **SE DÉCLENCHE** |
| **K3** | 0 point d'accroche MCP, vérifié | **faux** : `registerResource`, `registerPrompt`, `resources/subscribe`, `sendResourceListChanged` existent dans le SDK installé | **NE SE DÉCLENCHE PAS** — mon critère supposait l'absence ; la formulation juste porte sur la **cadence**, pas sur l'existence |
| **K4** | listing > 2 000 car. à 100 entrées | **3 666 car.** (~1 018 tokens), **par tour**, cumulatif dans le transcript | **SE DÉCLENCHE**, et je le sous-estimais |
| **K5** | défaut ouvert de recopie + aucune allowlist | **#355 ouverte**, aucune allowlist d'émetteur sur le bus. Aggravé : le seul canal de lecture forcée passe par `instructions`, donc par le **prompt système** — l'autorité opérateur que #355 note comme *non* atteinte aujourd'hui | **SE DÉCLENCHE, en pire** |
| **K6** | ≥ 5 sous-systèmes à toucher | table + migration `_new` (26 occurrences du pattern) + garde de traversal + quota + sweep + audit = **6**, dans un `database.ts` de **97 Ko** (et non 66) | **SE DÉCLENCHE**, la fiche sous-estimait sa propre estimation |

**Quatre critères sur six se déclenchent.** Les deux qui ne se déclenchent pas le font **contre moi** : K1 parce que mes trois apports étaient faux, K3 parce que je supposais une absence sans vérifier — exactement la faute que `E08` m'avait déjà values.

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** |
| **Date** | 2026-08-17 |
| **Justification** | Cette fiche est propriétaire de la question depuis que `E05` lui a renvoyé son angle (b). Elle se ferme ici. ⭑ **Refusé — la mémoire partagée en langage libre avec le daemon comme backend.** Quatre critères sur six se déclenchent : K2 (aucune demande, `n_sources: 1`), K4 (**3 666 caractères** de listing à 100 entrées, **par tour** et cumulatif dans le transcript), K5 (**en pire** : le seul canal de lecture forcée que MCP offre passe par `instructions`, donc par le **prompt système** — l'autorité opérateur que #355 note comme *non* atteinte aujourd'hui), K6 (**6** sous-systèmes dans un `database.ts` de **97 Ko** — la fiche annonçait 66). ⭑ **Mais ce qui tue vraiment la fiche est une mesure, pas un critère.** Son bénéfice réel se réduit à **un** apport non couvert : rien ne combine *durable* et *auto-livré*. Durable = `threads`, qui n'est **pas balayée par le sweeper** — les décisions (`plan`, `resolution_summary`) persistent indéfiniment. Auto-livré = `action_summaries` via le `context` qu'`announce_work` renvoie sans qu'on le demande. **Et l'écart entre les deux coûte ~15 lignes** : ajouter `listThreads(orgId, {module, status:'resolved'})` à `SummaryContextProvider.getRelevantContext` (`src/context-provider.ts:42`), où `Consultation` est déjà injecté. Aucune table, aucun garde de traversal, aucun quota, aucune clé API — contre un effort annoncé `L`. ⭑ **Renvoyé — la seconde branche de §6.1** (exposer l'état structuré comme une arborescence en lecture seule) **appartient à #281**, « Resources MCP : instruire une couche `coord://` », ouverte, cadrée et **sans propriétaire dans la veille**. E10 ne doit pas la pré-trancher. ⭑ **Corrections de méthode.** Trois de mes quatre apports K1 étaient **faux** : la rétention à 30 j ne touche pas les décisions (`threads` n'est pas balayée), l'adressabilité par sujet existe (`list_threads` avec `module`, correspondance exacte par `json_each`), et le « one-liner » de `summary` n'a aucun `.max()`. Le quatrième était à moitié faux (la livraison automatique existe déjà, adossée à un appel obligatoire). **K3 ne se déclenche pas non plus** : le SDK MCP supporte bel et bien `registerResource` / `resources/subscribe` — mon critère supposait une absence sans la vérifier, la faute même que `E08` m'avait déjà value. Et mon argument central était trop fort : le daemon **peut** forcer une lecture **par session** via des `instructions` calculées, avec **700 octets** de budget avant la troncature à 2 048 — pas par tour. **Erreurs de la fiche corrigées :** `sdk/src/client.ts` est intégralement de la plomberie OAuth (zéro méthode de données), donc le « en quelques lignes » de §5 est faux ; et §0 se déclare vérifiée alors qu'au moins **cinq** de ses chiffres ont dérivé — troisième fiche d'affilée (`E08`, `E09`, `E10`) dans ce cas. |
| **Issue / PR** | **#359** — l'historique de coordination est supprimé à 30 jours en silence : la doc annonce **6** buckets de rétention, le code en lit **7** et n'en documente que **2**, et l'asymétrie `threads` (jamais purgée) / `thread_messages` (30 j) n'est écrite nulle part. À noter aussi sur **#281** : ses mesures visent `sdk@1.30.0`, plus une dépendance directe — j'ai re-vérifié contre `server@2.0.0` que le manque tient toujours. |
| **Jalon visé** | Aucun pour le memory tool. Les ~15 lignes de `context-provider.ts` sont un candidat autonome, sans rapport avec cette fiche — à instruire seulement si quelqu'un demande de la capitalisation inter-agents. #359 est de la doc, sans urgence. **#281 reprend la main** sur la branche lecture seule. |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : API, dates et §5 exacts ; portée des helpers SDK précisée ; testabilité partielle. |
| 2026-08-17 | **Challenge — verdict `refuser` ; la fiche se ferme et son bénéfice réel coûte ~15 lignes.** Propriétaire de la question depuis que `E05` lui a renvoyé son angle (b). **Ma liste K1 tombe de 4 apports à 1**, trois étant faux : (1) la rétention à 30 j **ne touche pas les décisions** — `threads` n'est **pas** dans les 9 tables balayées, donc `plan` et `resolution_summary` persistent indéfiniment, ce qui contredit §4 (« pas capitalisation ») ; (2) l'adressabilité par sujet **existe** — `listThreads(orgId, {module, status})` avec correspondance exacte `json_each(target_modules)` (`consultation.ts:563`), exposée comme `list_threads` ; (4) le « one-liner » de `summary` n'a **aucun `.max()`**. Le troisième apport était à moitié faux : `announce_work` renvoie déjà `context` sans qu'on le demande, adossé à un appel imposé par `mcp-instructions.ts:29` — seule la **cadence par tour** manque. **Le seul apport survivant : rien ne combine *durable* et *auto-livré*** — et l'écart coûte **~15 lignes** (`listThreads(..., status:'resolved')` dans `SummaryContextProvider.getRelevantContext`, où `Consultation` est déjà injecté), contre un effort annoncé `L`. **K2, K4, K5, K6 se déclenchent** : aucune demande (`n_sources: 1`) ; listing **3 666 car.** à 100 entrées, **par tour** et cumulatif ; **6** sous-systèmes dans un `database.ts` de **97 Ko** (la fiche annonçait 66) ; et K5 **en pire** — le seul canal de lecture forcée passe par `instructions`, donc par le **prompt système**, soit l'autorité opérateur que #355 note comme *non* atteinte aujourd'hui, avec **700 octets** de budget avant la troncature à 2 048. **K3 ne se déclenche pas** : le SDK MCP supporte `registerResource`/`resources/subscribe` — mon critère supposait une absence sans la vérifier, la faute même que `E08` m'avait déjà value ; et mon argument central était trop fort (le daemon peut forcer une lecture **par session**, pas par tour). **Seconde branche de §6.1 renvoyée à #281** (`coord://` en Resources, ouverte et sans propriétaire) — E10 ne doit pas la pré-trancher. **Erreurs de la fiche corrigées** : `sdk/src/client.ts` est intégralement de la plomberie OAuth, donc le « en quelques lignes » de §5 est faux ; et §0 se déclare vérifiée alors qu'au moins cinq de ses chiffres ont dérivé (`database.ts` 66 Ko → **96,8 Ko / 2370 lignes**, migrations `_new` → **1502-2254**, `handleAnnounce` 189 → **204**, `handleWorkingFilesStart` 863 → **994**) — troisième fiche d'affilée dans ce cas après `E08` et `E09`. Livrable : **#359**. |
