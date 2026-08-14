# E11 — Discipline de contexte : exclude_tools, PTC, compaction, task budgets, cache

> **Fiche de veille.** Les sections 1 à 5 sont remplies par la veille.
> Les sections 6 à 8 sont remplies **pendant le challenge** de la feature.

| Champ | Valeur |
|---|---|
| **ID** | `context-discipline` |
| **Surface** | claude-api |
| **Statut** | mixte — beta (context editing, compaction, task budgets, cache diagnostics) · GA (programmatic tool calling, règles de cache) |
| **Disponible depuis** | context editing : `clear_tool_uses` 2025-09-29, `clear_thinking` 2025-10-28 · PTC : beta 2025-11-24, GA 2026-02-17 · compaction : header daté 2026-01-12 · task budgets : 2026-04-16 · cache automatique : 2026-02-19 |
| **Tier** | T1-incontournable |
| **Nature** | integration |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — mesures locales oui, appels API beta non |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — `clear_thinking_20251015` : `keep` est `"all"` **ou** `{type:"thinking_turns", value:<int>}` ; `"all"` est la valeur entière du champ, pas une valeur du sous-champ `value`. La fiche écrivait `value:<int>|"all"`.
- §2 — chiffres PTC : la doc actuelle ne cite plus « −37 % (43 588 → 27 297) ». Elle donne **≈ −38 %** de tokens d'entrée facturés sur un benchmark d'agent à 75 outils (sans chiffres bruts), **20–40 %** d'économie typique en production pour 10–49 outils, et un **contre-exemple** : sur τ²-bench (1–2 appels séquentiels par tour) PTC coûte **≈ +8 %** sans gain de score. Le « +11 % de perf avec −24 % de tokens d'entrée sur BrowseComp / DeepSearchQA » est exact.
- §2 — task budgets : la liste des modèles supportés omettait **Opus 4.8 et Opus 4.7**. Confirmé non supporté : Sonnet 5, Opus 4.6, Sonnet 4.6, Haiku 4.5. Confirmé aussi : task budgets n'est **pas** supporté sur Claude Code ni Cowork.
- §2 — cache : le minimum cacheable est **512 tokens sur Opus 5 / Fable 5 / Mythos 5** et 1 024 sur Opus 4.8 (et Sonnet 5 / Sonnet 4.6). La fiche ne mentionnait que le palier 1 024 d'Opus 4.8.
- §2 — statut : `cache-diagnosis-2026-04-07` est **beta**, pas GA ; ajouté au côté « beta » du champ Statut de l'en-tête.
- §5 `src/metrics.ts` : la classe `Metrics` va de la **l. 38 à la l. 258** (pas 268 — au-delà commence `serveMetrics`), et le bloc des compteurs `recordAnnounce` / `recordThreadResolved` / `recordHttpRequest` / `recordAuthRejected` va de la **l. 181 à la l. 199** (pas 215).
- §5 `sdk/src/client.ts` : levée du doute — le fichier ne contient **aucune** référence à l'API Anthropic (`anthropic`, `api.anthropic.com`, `claude.com`). Le SDK parle bien au coordinateur seul : cette ligne est **hors périmètre** pour la configuration côté appelant.
- §5 `cli/channel.ts` : confirmé. Le commentaire dit littéralement « the project's zod-v3 surface doesn't ship a `toJSONSchema` helper » — commentaire **périmé**, `package.json` et `node_modules` donnent zod **4.4.3**, qui expose `z.toJSONSchema`.

Vérifiés exacts, sans changement : les 4 headers beta ; tous les champs et défauts de `clear_tool_uses_20250919` (`trigger` 100 000, `keep` 3, `clear_tool_inputs` false, `clear_at_least`, `exclude_tools`) ; l'ordre imposé `clear_thinking` en premier ; `applied_edits[]` / `cleared_tool_uses` / `cleared_input_tokens` ; `compact_20260112` (seul `input_tokens`, minimum 50 000, défaut 150 000, `pause_after_compaction`, `instructions`, bloc `compaction`, `compaction_delta`, `stop_reason:"compaction"`, `usage.iterations[]`) et sa liste de 9 modèles ; `allowed_callers` (`"direct"` / `"code_execution_20260120"`, « pas une frontière de sécurité », 400 sur `tool_choice`), `Circular $ref detected`, `code_execution_tool_result`, champ `caller` ; `task_budget` (`type`/`total`/`remaining`, minimum 20 000 → 400, aucun champ dans `usage`, indice mou, avertissement refus, combinaison avec `effort`) ; `cache_control` sur le dernier outil et sur l'entrée `mcp_toolset`, la hiérarchie `tools` → `system` → `messages` et la table complète des invalidateurs, `cache_creation.ephemeral_5m_input_tokens`, `diagnostics.previous_message_id` + `cache_miss_reason`. Côté repo : les 16 fichiers cités existent, les 26 outils sont confirmés, et **tous les autres numéros de ligne du §5 sont exacts** (vérifiés un à un, y compris `createMcpServer` l. 207-250 et les six `register*Tools` l. 242-247).

**Marqueurs `(à vérifier)` restants :** 2, tous deux tranchés en `(non vérifiable)`.

- §2, point central : la forme du nom d'un outil servi via `mcp_toolset` dans `exclude_tools` → **non vérifiable par la doc** — la page context-editing ne documente aucune convention de nommage pour les outils MCP, elle se contente de « tool names » correspondant au champ `name`. Seul un appel réel tranchera (voir Testabilité).
- En-tête « Disponible depuis », task budgets `2026-04-16` → **non vérifiable** — la page task-budgets ne donne aucune date de lancement, seulement le header daté `task-budgets-2026-03-13`. Même situation que la divergence déjà signalée sur la compaction.

**Testabilité :** ⚠️ partielle
Se lance ici, sans credentials : les étapes 1, 2 et 4 du §6.3 — instrumenter les 26 handlers pour mesurer `JSON.stringify(...).length` à 1/5/10 agents, dumper le JSON Schema de `tools/list` sur un serveur stdio local et y chercher tout `$ref`, et écrire le test d'invariant « même 26 noms sous toutes les configs ».
Ne se lance pas ici : les étapes 3 et 5. Elles exigent une clé API Anthropic avec les headers `context-management-2025-06-27` / `compact-2026-01-12`, **et** un endpoint mcp-coordinator joignable depuis l'API pour l'entrée `mcp_toolset` (une instance locale stdio ne convient pas). Sans ça, la question du nommage dans `exclude_tools` et la mesure de la perte post-compaction restent ouvertes.

---

## 1. Ce que c'est

Cinq mécanismes distincts de l'API Claude qui déterminent **ce que le modèle voit encore** d'une longue boucle agentique, et **combien ça coûte**. (1) *Context editing* : deux stratégies serveur qui suppriment du contenu avant que le prompt n'atteigne le modèle — `clear_tool_uses_20250919` efface les résultats d'outils les plus anciens au-delà d'un seuil, `clear_thinking_20251015` fait de même pour les blocs de raisonnement. L'historique complet reste côté client ; le champ `exclude_tools` protège nommément certains outils de l'effacement. (2) *Programmatic tool calling* : Claude écrit du code dans le conteneur `code_execution` et appelle vos outils depuis ce code ; les résultats intermédiaires n'entrent jamais dans l'historique de conversation. (3) *Compaction serveur* `compact_20260112` : quand la conversation dépasse un seuil, l'API produit un bloc `{type:"compaction"}` qu'on réinjecte, puis laisse tomber tout ce qui précède. (4) *Task budgets* : un compte à rebours de tokens injecté côté serveur, que le modèle voit et utilise pour prioriser — les **résultats d'outils comptent dedans**. (5) Les *règles d'invalidation du cache* : la hiérarchie `tools` → `system` → `messages` fait qu'un changement du tableau `tools` invalide l'intégralité du préfixe caché.

Les cinq se combinent : `context_management.edits[]` accepte à la fois les entrées de context editing et l'entrée de compaction, et task budgets vit sous `output_config`. Ordre imposé : quand `clear_thinking_20251015` et `clear_tool_uses_20250919` cohabitent, `clear_thinking` doit être listé **en premier**. Effet de bord documenté : l'effacement de résultats d'outils invalide le cache (d'où `clear_at_least`, qui amortit) tandis que l'effacement du thinking le préserve.

## 2. Surface d'API exacte

Headers beta :

```
context-management-2025-06-27      # context editing
compact-2026-01-12                 # compaction serveur
task-budgets-2026-03-13            # task budgets
cache-diagnosis-2026-04-07         # diagnostic de cache miss
```

Context editing + compaction (même tableau) :

```json
{
  "context_management": {
    "edits": [
      { "type": "clear_thinking_20251015",
        "keep": { "type": "thinking_turns", "value": 2 } },
      { "type": "clear_tool_uses_20250919",
        "trigger":  { "type": "input_tokens", "value": 100000 },
        "keep":     { "type": "tool_uses", "value": 3 },
        "clear_at_least": { "type": "input_tokens", "value": 5000 },
        "exclude_tools": ["announce_work", "check_file_conflict", "coordinator_status"],
        "clear_tool_inputs": false },
      { "type": "compact_20260112",
        "trigger": { "type": "input_tokens", "value": 150000 },
        "pause_after_compaction": false,
        "instructions": null }
    ]
  }
}
```

- `clear_tool_uses_20250919` : `trigger` par défaut 100 000 tokens d'entrée, `keep` par défaut les 3 derniers tool uses, `clear_tool_inputs` par défaut `false`.
- `clear_thinking_20251015` : `keep` vaut soit la chaîne `"all"`, soit `{type:"thinking_turns", value:<int>}` (défaut spécifique au modèle). `"all"` est la valeur entière du champ, pas une valeur de `value`.
- `compact_20260112` : seul `input_tokens` accepté comme `trigger`, **minimum 50 000**, défaut 150 000. `instructions` remplace *entièrement* le prompt de résumé.
- Réponse : `context_management.applied_edits[]` avec `cleared_tool_uses` / `cleared_input_tokens` ; bloc `{type:"compaction", content}` (delta streaming `compaction_delta`, un seul `content_block_delta`) ; `stop_reason:"compaction"` si `pause_after_compaction:true`.
- Comptabilité de la compaction : les `usage.input_tokens` / `usage.output_tokens` de haut niveau **excluent** son coût ; il faut sommer `usage.iterations[]`, dont les entrées sont `{type:"compaction"|"message", input_tokens, output_tokens}`.
- Modèles supportant la compaction : `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-mythos-5`, `claude-mythos-preview`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`.
- Côté SDK, `compaction_control` (Python/TS/Ruby) est **déprécié** avec warning au profit de cette voie serveur.

Programmatic tool calling :

```json
{
  "tools": [
    { "type": "code_execution_20260120", "name": "code_execution" },
    { "name": "get_blast_radius",
      "input_schema": { "...": "..." },
      "allowed_callers": ["code_execution_20260120"] }
  ]
}
```

- `allowed_callers: ["direct" | "code_execution_20260120"]`. Omettre `"direct"` guide Claude à n'appeler l'outil que depuis le code — ce **n'est pas une frontière de sécurité**, le client doit rester prêt à recevoir un `tool_use` direct.
- `tool_choice` ne peut pas nommer un outil dont `allowed_callers` omet `"direct"` → 400.
- Un `input_schema` contenant un `$ref` récursif est refusé (`Circular $ref detected`).
- Blocs de réponse : `code_execution_tool_result` ; champ `caller` sur `tool_use`.
- Chiffres cités par la doc : +11 % de perf avec −24 % de tokens d'entrée sur BrowseComp / DeepSearchQA ; ≈ −38 % de tokens d'entrée facturés sur un benchmark d'agent à 75 outils, à précision de tâche inchangée (pas de chiffres bruts dans la doc) ; 20–40 % d'économie typique en trafic de production pour un tableau `tools` de 10 à 49 outils. **Contre-exemple documenté :** sur τ²-bench (1 à 2 appels d'outils séquentiels par tour), PTC laisse les scores inchangés et coûte ≈ +8 % — « les workflows séquentiels à appel unique n'en bénéficient pas ».

Task budgets :

```json
{ "output_config": { "task_budget": { "type": "tokens", "total": 60000, "remaining": 41000 } } }
```

- `total` : minimum **20 000** sur tous les modèles supportés (en dessous : 400). `remaining` optionnel, pour reprendre après une compaction.
- Le compte à rebours n'est **pas** exposé dans la réponse : aucun champ dans `usage`, aucun accesseur SDK.
- Indice mou, pas un plafond dur — `max_tokens` reste la vraie limite. Avertissement documenté : un budget trop petit provoque des comportements proches du refus.
- Supporté par Opus 5 / Fable 5 / Mythos 5 / Opus 4.8 / Opus 4.7 ; **pas** Sonnet 5, ni Opus 4.6, Sonnet 4.6, Haiku 4.5. Se combine avec `output_config.effort`. Non disponible sur Claude Code ni Cowork — uniquement via la Messages API.

Cache :

```
tools[].cache_control = {"type":"ephemeral"}   # sur le DERNIER outil du tableau
cache_control sur l'entrée `mcp_toolset`       # l'API l'applique au dernier outil expansé
usage.cache_creation.ephemeral_5m_input_tokens
diagnostics.previous_message_id  +  header cache-diagnosis-2026-04-07  → cache_miss_reason
```

Hiérarchie du préfixe : `tools` → `system` → `messages`. Toute modification des définitions d'outils invalide le cache **entier**. Autres invalidateurs documentés : activation/désactivation de web search ou citations (system + messages), changement de `tool_choice` (messages), de `disable_parallel_tool_use` (messages), présence/absence d'images (messages), changement des paramètres de thinking et de `output_config.effort` (messages — et aussi tools + system sur les modèles qui rendent la config de thinking en amont). Minimum cacheable : **512 tokens** sur Opus 5 / Fable 5 / Mythos 5 ; 1 024 sur Opus 4.8, Sonnet 5, Sonnet 4.6 ; 4 096 sur Opus 4.6 et Haiku 4.5.

**Point non vérifié :** sous quelle forme exacte un outil servi via `mcp_toolset` doit être nommé dans `exclude_tools` (nom nu `announce_work` ou nom namespacé par le serveur) — *(non vérifiable — la page context-editing ne documente aucune convention de nommage pour les outils MCP ; elle dit seulement que `exclude_tools` contient des noms correspondant au champ `name` de la définition d'outil)*. C'est la première chose à trancher avant d'écrire quoi que ce soit dans la doc du projet, et seul un appel réel le tranchera.

**Divergence entre chercheurs signalée :** le champ `since` de la compaction mélangeait deux dates (header daté 2026-01-12 vs Opus 4.6 le 2026-02-05, qui n'est que le plus ancien modèle supporté) ; la page de doc ne donne elle-même aucune date de lancement. Idem pour la liste de modèles, plus large que le « jusqu'à Opus 5 » initialement rapporté. Les deux points ont été rectifiés par le vérificateur et sont repris ci-dessus.

## 3. Sources

- https://platform.claude.com/docs/en/build-with-claude/context-editing
- https://platform.claude.com/docs/en/build-with-claude/compaction
- https://platform.claude.com/docs/en/build-with-claude/task-budgets
- https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
- https://www.anthropic.com/engineering/advanced-tool-use
- https://platform.claude.com/docs/en/release-notes/overview

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.**

1. **`exclude_tools` est le levier direct.** mcp-coordinator existe pour qu'un agent sache ce que font les autres. Or au-delà de 100 000 tokens d'entrée (le défaut), les résultats de `announce_work`, `check_file_conflict`, `list_agents` sont effacés comme n'importe quelle lecture de fichier : l'agent perd silencieusement la conscience des réservations en cours et se remet à écrire dans un fichier déjà tenu par un pair. C'est un mode de défaillance *silencieux* — aucune erreur, aucun log, juste un conflit qui refait surface. La recommandation à publier est concrète et testable : une liste d'outils de coordination à mettre dans `exclude_tools`, à documenter dans `docs/usage.md` et à générer depuis le code (le serveur connaît ses 26 noms d'outils).

2. **Les résultats d'outils consomment le budget de la tâche principale.** Aujourd'hui `announce_work` renvoie `{thread, conflicts, context, impact}` où `impact` est le `CategorizedImpact` complet — `concerned` + `gray_zone` **+ `pass`**, chacun avec `agent_id`, `agent_name`, `score`, `reasons[]` et `reason`. Avec dix agents en ligne dont un seul concerné, on renvoie neuf entrées `pass` que personne ne lira. Task budgets transforme cette verbosité en coût mesurable : sortie compacte par défaut, détail sur demande, et un chiffre « tokens par appel de coordination » qu'on peut mettre dans le README.

3. **Post-compaction, l'agent perd ses propres annonces** — c'est une capacité nouvelle à servir, pas seulement un risque. Un outil de réhydratation (`get_my_working_set` : mes fichiers réservés, mes threads ouverts, en une réponse courte) devient le complément naturel de la compaction serveur. Le champ `instructions` de `compact_20260112` permet en plus de dire au résumeur de préserver les réservations de fichiers.

4. **PTC change ce qu'un bon schéma d'outil doit être.** Les outils qui renvoient des listes volumineuses (`get_blast_radius`, `hot_files`, `get_session_files`, `list_agents`, `get_queued_messages`) sont exactement le profil où PTC gagne : le modèle écrit un script qui interroge, filtre, et n'expose que les trois fichiers en conflit. Deux conditions : sorties JSON stables — c'est déjà le cas, tous les handlers font `JSON.stringify(...)` — et aucun `$ref` récursif dans les `input_schema`. Les schémas zod du projet sont plats (chaînes, booléens, tableaux de chaînes) : a priori compatibles, à confirmer sur le JSON Schema effectivement émis par zod 4.

**Risque si on ne fait rien.**

Deux risques distincts. Le premier est fonctionnel et documenté ci-dessus : la coordination s'évapore silencieusement au-delà du seuil de context editing, et le projet n'a rien à dire à l'utilisateur qui le découvre. Le second est un **bug de coût invisible** : si le serveur venait à faire varier sa liste d'outils selon la config, les capacités détectées ou l'état d'auth, il ferait exploser le cache de tout l'historique de chaque agent connecté à chaque variation. Vérification faite dans le repo, ce risque **n'est pas réalisé aujourd'hui** — `createMcpServer` enregistre les six groupes inconditionnellement (`src/server-setup.ts:242-247`), donc 26 outils identiques pour toute session. C'est un invariant qui n'est écrit nulle part et que rien ne teste : il peut se casser à la première feature « outils selon le plan tarifaire ».

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/server-setup.ts` | `createMcpServer` (l. 207-250) enregistre les 6 groupes **inconditionnellement** — l'ensemble d'outils est stable par construction, donc pas d'invalidation de cache aujourd'hui. À transformer en invariant explicite + test de non-régression (« la liste des 26 noms d'outils ne dépend d'aucune config »). |
| `src/tools/consultation-tools.ts` | `announce_work` (l. 36-187) renvoie `{thread, conflicts, context, impact}` : le plus gros payload du serveur. Candidat n°1 à un paramètre `verbosity` / `include_pass`. C'est aussi l'outil le plus critique à mettre dans `exclude_tools`. |
| `src/announce-workflow.ts` | `runCommonAnnounceFlow` (l. 60-184) produit le `CategorizedImpact` renvoyé tel quel au client. Le filtrage « ne pas renvoyer `pass` » se fait ici ou au bord MCP — à trancher, car `serve-http.ts` consomme le même retour. |
| `src/impact-scorer.ts` | `CategorizedImpact` (l. 16-20) = `concerned` + `gray_zone` + `pass`, chacun `ImpactScore` (l. 8-14) avec `reasons[]` **et** `reason` redondant. Source de la verbosité. |
| `src/context-provider.ts` | `SummaryContextProvider.getRelevantContext` (l. 18-53) renvoie `action_summaries` complets, non tronqués — multiplié par le nombre de respondents dans la réponse d'`announce_work`. |
| `src/tools/agents-tools.ts` | `list_agents` (l. 49-65) fait `JSON.stringify(agents)` sans projection : lignes de registre entières. Profil PTC ou projection explicite. |
| `src/tools/dependencies-tools.ts` | `get_blast_radius` (l. 73-88) et `get_module_info` (l. 90-103) renvoient le résultat brut du `DependencyMapper`. Sur un gros repo, c'est le cas d'usage PTC canonique. |
| `src/tools/files-tools.ts` | `hot_files` (l. 19-32) et `get_session_files` (l. 34-47) : listes non bornées, aucun `limit`. |
| `src/tools/mqtt-tools.ts` | `get_queued_messages` (l. 79-93) vide la file entière dans le contexte ; `wait_for_message` (l. 52-77) renvoie un message court — asymétrie à documenter. |
| `src/tools/status-tools.ts` | `coordinator_status` (l. 32-71) est déjà compact (compteurs + ids/noms/modules). Sert de modèle de référence pour la règle « compact par défaut ». |
| `src/metrics.ts` | La classe `Metrics` (l. 38-258) n'a **aucune** métrique de taille de réponse par outil (`recordAnnounce`, `recordThreadResolved`, `recordHttpRequest`, `recordAuthRejected` — l. 181-199). Ajouter un histogramme d'octets/tokens par outil est le préalable à toute affirmation chiffrée. |
| `cli/channel.ts` | `POST_TO_THREAD_INPUT_SCHEMA` (l. 251-270) est un JSON Schema **écrit à la main**, plat, sans `$ref` : PTC-compatible tel quel. Le commentaire y parle de la « surface zod-v3 » du projet qui « ne fournit pas `toJSONSchema` » : **commentaire périmé**, `package.json` déclare zod `^4.4.3` (4.4.3 installé), qui expose `z.toJSONSchema`. |
| `package.json` | `zod: ^4.4.3`, `@modelcontextprotocol/sdk: ^1.29.0` — le JSON Schema effectivement émis pour les 26 outils doit être inspecté pour la contrainte « pas de `$ref` récursif » de PTC. |
| `docs/usage.md`, `docs/ARCHITECTURE.md` | Où publier la recommandation `exclude_tools` et la règle « ensemble d'outils stable ». |
| `sdk/src/client.ts` | **Hors périmètre, vérifié :** le fichier ne contient aucune référence à l'API Anthropic. Le SDK parle au coordinateur, pas à l'API Claude — il ne peut poser ni `context_management`, ni `output_config`, ni `cache_control`. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> mcp-coordinator doit-il se contenter de **documenter** une configuration `exclude_tools` / `task_budget` que l'utilisateur applique lui-même côté appelant (le serveur ne contrôle pas la requête API), ou doit-il rendre ses sorties structurellement compactes — `announce_work` sans la liste `pass`, listes bornées, plus un outil de réhydratation post-compaction — au prix d'un changement de contrat de réponse pour les consommateurs existants (essaim, dashboard, `serve-http.ts`) ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

*Proposition de la veille, à amender pendant le challenge. Principe maison : on teste le vrai chemin de code, on ne théorise pas.*

> ⚠️ Les étapes 3 et 5 ne sont pas exécutables ici : elles exigent une clé API Anthropic avec les headers beta `context-management-2025-06-27` / `compact-2026-01-12`, et un endpoint mcp-coordinator joignable depuis l'API pour l'entrée `mcp_toolset`.

- [ ] Mesurer la taille réelle des payloads : instrumenter les 26 handlers pour logger `JSON.stringify(...).length`, faire tourner un scénario à 1, 5 et 10 agents en ligne, et classer les outils par octets renvoyés. Confirmer que `announce_work` domine et quantifier la part de `impact.pass`.
- [ ] Dumper le JSON Schema effectivement émis par `@modelcontextprotocol/sdk` + zod 4 pour les 26 outils (`tools/list` sur un serveur stdio local) et vérifier qu'aucun ne contient de `$ref`, récursif ou non — prérequis dur de PTC.
- [ ] Trancher le point `(à vérifier)` de la §2 : lancer un vrai appel API avec `context-management-2025-06-27` et un `mcp_toolset` pointant sur mcp-coordinator, mettre `announce_work` dans `exclude_tools`, dépasser le seuil `trigger`, et lire `context_management.applied_edits[]` pour voir si l'outil a été épargné — nom nu ou nom namespacé.
- [ ] Vérifier l'invariant « ensemble d'outils stable » : écrire un test qui construit `createMcpServer` sous plusieurs configs (stdio/HTTP, avec et sans `COORDINATOR_REPO_ROOT`, avec et sans MQTT) et assert que `tools/list` renvoie exactement les mêmes 26 noms dans le même ordre.
- [ ] Simuler la perte post-compaction : session longue, forcer une compaction, et mesurer ce qu'il faudrait comme réponse minimale pour rétablir l'état de coordination (fichiers réservés + threads ouverts). Ça dimensionne l'éventuel `get_my_working_set`.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Le serveur ne contrôle pas la requête API.** `context_management`, `output_config.task_budget`, `allowed_callers` et `cache_control` sont des champs de la requête *de l'appelant* vers l'API Claude. mcp-coordinator est à l'autre bout du tuyau : il ne peut ni les poser, ni les vérifier, ni savoir s'ils sont posés. Tout ce que le projet peut faire est documenter et compacter. C'est l'argument le plus lourd contre une intégration profonde — une bonne partie de cette fiche pourrait n'aboutir qu'à un paragraphe dans `docs/usage.md`.
- **Deux betas et un header instable.** Context editing, compaction et task budgets sont en beta, avec des headers datés qui bougent (`context-management-2025-06-27`, `compact-2026-01-12`, `task-budgets-2026-03-13`). Écrire de la doc utilisateur qui cite ces headers, c'est signer pour la maintenir à chaque révision. Et `compaction_control` côté SDK est déjà déprécié après une seule génération — le domaine bouge vite.
- **Casse la portabilité.** mcp-coordinator est un serveur MCP, pas un client Claude. Optimiser ses sorties pour les mécaniques de contexte de l'API Claude le rend moins neutre vis-à-vis des autres clients MCP (Cline, Zed, les implémentations maison), qui n'ont ni context editing ni task budgets et à qui une sortie amputée ne rend aucun service.
- **Changer le contrat de réponse d'`announce_work` a un coût réel.** Le commentaire en tête d'`announce-workflow.ts` dit explicitement que les formes MCP et REST divergent et que l'unification a été reportée parce que « essaim (et d'autres consommateurs) peuvent dépendre de ces formes exactes ». Retirer `impact.pass` casse potentiellement le dashboard et essaim pour un gain en tokens qu'on n'a pas encore mesuré. Mesurer d'abord (§6.3 étape 1), décider ensuite.
- **Task budgets ne couvre pas Sonnet 5**, et le compte à rebours n'est exposé nulle part — ni dans `usage`, ni via un accesseur SDK. Impossible de construire un chiffre vérifiable côté serveur ; toute affirmation « mcp-coordinator consomme X % de votre budget » reposerait sur une estimation maison.
- **PTC est du travail pour un bénéfice incertain ici.** Les gains cités (−37 % de tokens) viennent de charges de travail de recherche à très gros résultats intermédiaires. Les sorties de mcp-coordinator sont des dizaines de lignes JSON, pas des mégaoctets de pages web. Sur un repo de dix agents, le jeu n'en vaut peut-être pas la chandelle — YAGNI, tant que l'étape 1 du protocole n'a pas montré le contraire.
- **Complexité pour l'auto-hébergeur.** Un paragraphe de doc qui explique context editing, `exclude_tools`, la compaction et les budgets à quelqu'un qui voulait juste éviter que deux agents éditent le même fichier, c'est de la charge cognitive ajoutée à un produit dont l'argument est la simplicité de mise en route.

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
| 2026-08-14 | Vérification des faits : chiffres PTC, modèles task budgets, seuils de cache et 2 lignes du §5 corrigés. |
