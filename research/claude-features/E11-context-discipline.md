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
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — adopter partiellement : borner le contexte auto-livre (#361) |

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

**Ce que je pense avant de mesurer.** §6.5 porte son propre argument le plus lourd : *« Le serveur ne contrôle pas la requête API. »* C'est vrai des quatre champs cités — `context_management`, `output_config.task_budget`, `allowed_callers`, `cache_control` vivent tous dans la requête de l'appelant vers l'API Claude. Mais `E08` m'a appris à ne **pas** conclure de là que le serveur est impuissant : j'y avais écrit « ce n'est pas notre couche » et le SDK MCP exposait `disable()` / `sendToolListChanged`. Je dois donc **vérifier** s'il existe un levier serveur, et non le déduire.

Ce qui reste, et qui est entièrement de notre côté, est le point 2 de §4 : **la verbosité de nos propres réponses**. Et c'est là que la fiche avance un chiffre qu'elle n'a pas mesuré — « avec dix agents en ligne dont un seul concerné, on renvoie neuf entrées `pass` que personne ne lira ». C'est la première chose à mesurer, parce que tout le reste en dépend : si `impact.pass` est marginal, §6.1 se réduit à un paragraphe de doc.

Hypothèse principale : `announce_work` domine bien, mais **la part de `pass` sera plus petite que la fiche ne le suggère**, et le vrai poids sera ailleurs — dans `context` (les `action_summaries` non tronqués, que `E10` a mesurés comme le seul canal auto-livré) ou dans `thread`. Si c'est le cas, la recommandation change de cible.

Hypothèse secondaire : le risque nommé en §4 — un ensemble d'outils qui varierait selon la config et invaliderait tout le cache — est un invariant **réel mais non testé**, et c'est le livrable le moins cher de la fiche.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

Ici, « adopter » signifie **rendre les sorties structurellement compactes** (retirer `impact.pass`, borner les listes, ajouter un outil de réhydratation). Un seul critère qui se déclenche le tue.

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **La verbosité dénoncée n'est pas là où la fiche la place.** Si `impact.pass` est marginal dans le payload d'`announce_work`, le changement de contrat de réponse se fait pour rien. | `impact.pass` < **30 %** des octets d'`announce_work` à 10 agents en ligne |
| **K2** | **Aucun levier serveur.** Si rien de ce que le serveur contrôle n'influence la discipline de contexte, la fiche se réduit à de la documentation. | **0** levier côté serveur, **vérifié** et non déduit |
| **K3** | **PTC est hors de portée.** Un `$ref` dans un `input_schema` émis suffit à disqualifier le profil PTC. | ≥ **1** `$ref` dans le JSON Schema effectivement émis pour les 26 outils |
| **K4** | **Le changement de contrat casse un consommateur.** `announce-workflow.ts` dit explicitement que les formes MCP et REST divergent volontairement. | ≥ **1** consommateur (dashboard, SDK, tests, REST) lit `impact.pass` |
| **K5** | **L'invariant d'ensemble d'outils stable est déjà cassé.** | `tools/list` ne rend **pas** les mêmes 26 noms sous deux configs différentes |
| **K6** | **Aucune métrique pour étayer un chiffre.** Toute affirmation publiée serait une estimation maison. | **0** histogramme de taille de réponse par outil dans `src/metrics.ts` |

**Règle que je m'impose :** §0 classe la fiche ⚠️ **partielle** — les étapes 3 et 5 exigent une clé API et un endpoint joignable. Elles ne peuvent **jamais** recevoir `adopter`, et le point `(non vérifiable)` de §2 sur le nommage dans `exclude_tools` doit rester marqué comme tel. Et j'applique la leçon de `E09` : **grepper la doc du dépôt avant de publier une mesure comme découverte.**

### 6.3 Protocole de vérification

*Proposition de la veille, à amender pendant le challenge. Principe maison : on teste le vrai chemin de code, on ne théorise pas.*

> ⚠️ Les étapes 3 et 5 ne sont pas exécutables ici : elles exigent une clé API Anthropic avec les headers beta `context-management-2025-06-27` / `compact-2026-01-12`, et un endpoint mcp-coordinator joignable depuis l'API pour l'entrée `mcp_toolset`.

- [ ] Mesurer la taille réelle des payloads : instrumenter les 26 handlers pour logger `JSON.stringify(...).length`, faire tourner un scénario à 1, 5 et 10 agents en ligne, et classer les outils par octets renvoyés. Confirmer que `announce_work` domine et quantifier la part de `impact.pass`.
- [ ] Dumper le JSON Schema effectivement émis par `@modelcontextprotocol/sdk` + zod 4 pour les 26 outils (`tools/list` sur un serveur stdio local) et vérifier qu'aucun ne contient de `$ref`, récursif ou non — prérequis dur de PTC.
- [ ] Trancher le point `(à vérifier)` de la §2 : lancer un vrai appel API avec `context-management-2025-06-27` et un `mcp_toolset` pointant sur mcp-coordinator, mettre `announce_work` dans `exclude_tools`, dépasser le seuil `trigger`, et lire `context_management.applied_edits[]` pour voir si l'outil a été épargné — nom nu ou nom namespacé.
- [ ] Vérifier l'invariant « ensemble d'outils stable » : écrire un test qui construit `createMcpServer` sous plusieurs configs (stdio/HTTP, avec et sans `COORDINATOR_REPO_ROOT`, avec et sans MQTT) et assert que `tools/list` renvoie exactement les mêmes 26 noms dans le même ordre.
- [ ] Simuler la perte post-compaction : session longue, forcer une compaction, et mesurer ce qu'il faudrait comme réponse minimale pour rétablir l'état de coordination (fichiers réservés + threads ouverts). Ça dimensionne l'éventuel `get_my_working_set`.

### 6.4 Résultat observé

#### A. Ma première mesure était un plancher, et l'argument que j'en tirais est faux d'un facteur 20

J'avais mesuré l'anatomie du payload d'`announce_work` avec 3 résumés d'action par pair, obtenu **2,7 ko à 10 agents (~700 tokens)**, et j'allais en conclure qu'un appel représente **0,7 %** du `trigger` par défaut de 100 000 tokens — donc qu'il faudrait ~140 appels pour l'atteindre, donc que la verbosité est négligeable en magnitude.

**C'était un artefact de mon banc.** `getActionSummaries` (`src/consultation.ts:630-640`) n'a **aucun `LIMIT`**, et son unique appelant (`src/context-provider.ts:42`) ne passe **pas** de `since`. Avec une rétention de 30 jours, la seule variable qui compte est le nombre de résumés accumulés par le pair concerné. Remesuré en ne faisant varier que ça :

```
resumes/pair | total  | ~tokens | ctx% | impact% | pass% | K1(<30%)
           0 |   1886 |     472 |   5% |  59%    |  49%  | ne se declenche pas
           3 |   2730 |     683 |  34% |  41%    |  34%  | ne se declenche pas
           8 |   4140 |    1035 |  57% |  27%    |  22%  | SE DECLENCHE
          40 |  13254 |    3314 |  86% |   8%    |   7%  | SE DECLENCHE
         200 |  59154 |   14789 |  97% |   2%    |   2%  | SE DECLENCHE
```

**À 200 résumés — un mois de rétention sur un seul pair — une réponse `announce_work` fait 59 ko, soit ~14 800 tokens : 15 % du seuil de 100 000.** Sept appels suffisent, pas 140. **Je retire le « 0,7 % » et le « ~140 appels ».**

Et la verbosité n'est **pas** là où §4 la place : à 200 résumés, `context` pèse **97 %** et `impact.pass` **2 %**. Le coupable est le canal auto-livré non borné, pas la liste `pass`.

C'est d'autant plus mordant que le mécanisme s'auto-alimente : la verbosité non bornée du chemin de coordination **accélère le déclenchement du context editing**, qui efface justement les annonces des pairs. → **#361**

#### B. K1 était mal calibré, et je le déclare tel

Mon seuil faisait décider par **une** mesure sur `impact.pass` le sort de **trois** changements indépendants — retirer `pass`, borner les listes, ajouter un outil de réhydratation. Or la mesure bascule à **8 résumés** (22 % < 30 %) et vaut 34 % à 3 : la réponse dépend entièrement de l'historique du pair, pas d'une propriété du produit. Pire, **la mesure qui déclenche K1 est simultanément la meilleure preuve en faveur du deuxième volet** (borner).

Je l'adjuge donc **mal calibré** et je tranche les trois volets séparément, plutôt que de publier un refus global adossé à un critère qui prouve le contraire de l'un d'eux.

Structurellement, `pass` est d'ailleurs minimal par construction : chaque `reasons.push` de `src/impact-scorer.ts` est apparié à un score ≥ 30, donc `score < 30 ⟹ reasons: []`, soit ~92 octets fixes par entrée.

#### C. Mon livrable « invalidation de cache » était surdéclaré — portée corrigée

Ce qui tient, verbatim de la doc du jour : *« The `tools` array sits even earlier in the hashed request prefix than the top-level `system` field, so editing it invalidates the prompt cache for the entire conversation »*, et la raison d'être de la beta `tool_removal` : *« The `tools` array itself never changes, so the cached prefix stays intact. »* Donc **la tension avec `E08` est réelle** : j'y ai écrit que `disable()` + `sendToolListChanged` était « la même capacité, en mieux » que `tool_removal` — sur l'axe précis que `tool_removal` a été construit pour protéger.

Ce qui ne tient pas, c'est ma portée. Mesuré : `createMcpServer` est **une instance par session** (`src/server-setup.ts:193-208`), les objets outil ne sont pas partagés entre instances, et `src/serve-http.ts:513` ne retient que `sessions: Map<string, NodeStreamableHTTPServerTransport>` — **aucune instance `McpServer` n'est conservée**. Un `disable()` à l'échelle de la flotte est donc **inatteignable** sans plomberie nouvelle. Portée réelle : **un agent, son propre préfixe.**

Et un chaînon reste **non documenté** : MCP dit que le serveur *« SHOULD send a notification »* et place le `tools/list` du client dans un bloc **`opt`** — rien n'oblige un client à reconstruire son `tools[]`. La forme honnête est donc conditionnelle : *si* le client reconstruit `tools[]`, tout le préfixe part.

Enfin, `grep -rn "\.disable(\|sendToolListChanged" src/ cli/ sdk/src/` rend **0** : c'est prospectif. Le bon format n'est pas une issue mais un **caveat croisé sur `A02` / `E08`** — quand on fera l'inventaire par agent via `disable()`, chaque transition d'état de verrou coûtera une invalidation complète du préfixe **de cet agent**, et c'est exactement le prix que `tool_removal` évite.

#### D. PTC : bon refus, mauvais argument

Le profil séquentiel est confirmé par le produit lui-même : `src/mcp-instructions.ts:29` (« Register once … **then**, BEFORE you edit … call `announce_work` »), `cli/init.ts:39-57` (workflow numéroté, « Read the response carefully. If `thread_id` is present … DO NOT proceed »), `cli/init.ts:65-68` (« **one extra call** »), `docs/usage.md:180-191` (pire tour documenté : **4 appels, tous chaînés**). Et les tableaux d'`announce_work` sont l'**anti**-fan-out : N fichiers en un appel.

**Mais mon argument était mal ciblé.** Le contre-exemple τ²-bench porte sur l'amortissement d'un **fan-out** ; le cas PTC que §4.4 défend est du **fan-in** (un appel, résultat volumineux) — et mes mesures le *renforcent* plutôt que de le réfuter.

Le vrai tueur est ailleurs et il est plus propre : **PTC garde les résultats intermédiaires hors de la conversation.** Pour `announce_work`, c'est le mode de défaillance du produit, pas son optimisation — tout l'intérêt est que le modèle **voie** le conflit. Et `allowed_callers` est un champ de l'appelant : le serveur ne peut pas le poser.

**K3 ne se déclenche pas** : 26 outils, **0 `$ref`, 0 `$defs`** dans les schémas effectivement émis. Mais c'est une condition nécessaire sur laquelle le serveur n'a aucune prise.

#### E. `exclude_tools` : la doc est écrivable, mais son audience est vide

Le point `(non vérifiable)` de §2 est plus étroit qu'annoncé. `io.github.swoofer/mcp-coordinator` (`src/server-setup.ts:235`) n'est **pas** ce qui apparaît côté client : la veille l'a déjà mesuré en session réelle (`C06:312`) —

```
[init] mcp tools: ["mcp__coordinator__agent_activity","mcp__coordinator__announce_work", … ]
[init] mcp_servers: [{"name":"coordinator","status":"connected"}]
```

Le préfixe est `mcp__<clé .mcp.json>__<outil>`, donc une chaîne que **l'utilisateur** choisit. Seule la forme sous `mcp_toolset` (expansion côté API) reste inconnue. La doc est donc écrivable : nommer les outils de coordination, dire que le préfixe appartient au client, et rappeler qu'`exclude_tools` prend une **liste** — on peut y mettre les deux formes sans coût.

**Mais l'attaque que je ne m'étais pas faite est décisive** : `context_management` est un champ de la Messages API. `E08` a mesuré, et j'ai écrit moi-même, qu'**aucun intégrateur ne pilote la boucle Messages API**. Et §2 documente que task budgets n'existe ni sur Claude Code ni sur Cowork. **La population qui peut appliquer `exclude_tools` est exactement la population vide qui a servi à tuer la recette d'`E08`** — tandis que la population qui subit le mode de défaillance (Claude Code, qui compacte de lui-même) ne peut pas appliquer le remède.

Cela **inverse ma partition** : le volet qui sert la population attestée est le **point 3 (réhydratation)**, que j'allais refuser. Et le trou est réel, vérifié : `coordinator_status` (`status-tools.ts:34-75`) ne renvoie que des **compteurs** ; `get_session_files` exige un `session_id` que l'agent compacté a perdu ; et **aucun outil ne prend un `agent_id` pour rendre les fichiers que cet agent tient**.

#### F. Le test que j'allais adopter renverse un choix commenté

« Rien ne teste l'invariant » est exagéré. `tests/integration/mcp-stdio-smoke.test.ts:34` et `mcp-http-smoke.test.ts:30` assertent `>= 20` plus un sous-ensemble nommé, sur les **deux** transports. Ce qui n'est pas testé : exactement 26, l'ordre, et l'invariance aux variables d'environnement.

Et la borne lâche est **volontaire**, commentée à `mcp-stdio-smoke.test.ts:32-33` :

> `// 26 tools per README — allow drift (>= 20) so add/remove of one tool`
> `// doesn't cascade into red CI from a smoke test.`

Donc « mêmes 26 noms, même ordre » n'est pas un test manquant, c'est le **renversement d'un choix explicite** — et `E08` a déjà chiffré la collatérale (2 fichiers smoke cassent avec `disable()`). **K5 ne se déclenche pas** : mesuré, les 26 mêmes noms dans le même ordre sous 3 configs.

#### G. Adjudication des six critères

| # | Seuil | Mesure | Verdict |
|---|---|---|---|
| **K1** | `pass` < 30 % à 10 agents | **34 %** à 3 résumés, **22 %** à 8, **2 %** à 200 — la réponse dépend de l'historique du pair, pas du produit | **MAL CALIBRÉ** — un seuil sur `pass` décidait trois changements indépendants, et la mesure qui le déclenche prouve le contraire de l'un d'eux |
| **K2** | 0 levier serveur, vérifié | `disable`, `enable`, `update`, `sendToolListChanged` sont tous des `function` | **NE SE DÉCLENCHE PAS** — mais la portée est **un agent**, pas la flotte |
| **K3** | ≥ 1 `$ref` | **0** `$ref`, **0** `$defs` sur les 26 schémas émis | **NE SE DÉCLENCHE PAS** |
| **K4** | ≥ 1 consommateur lit `impact.pass` | uniquement `announce-workflow.ts:120` (usage interne) et 2 tests unitaires ; **aucun** consommateur externe | **NE SE DÉCLENCHE PAS** |
| **K5** | `tools/list` diffère entre configs | **26 mêmes noms, même ordre**, sous 3 configs | **NE SE DÉCLENCHE PAS** |
| **K6** | 0 histogramme de taille par outil | **0** (`grep "Histogram\|buckets"` sur `src/metrics.ts` → aucun) | **SE DÉCLENCHE** |

**Un seul critère se déclenche proprement (K6), quatre ne se déclenchent pas, et un était mal calibré.** Ce qui a tranché cette fiche n'est donc pas un critère de mort mais une **remesure** — celle que mon premier banc avait manquée.

#### H. Dérive des références de §5 : exactes le 14, périmées depuis le 15

§0 affirme les avoir « vérifiés un à un ». C'était vrai le 2026-08-14 ; les commits du **2026-08-15** ont déplacé la plupart :

| §5 dit | réel aujourd'hui |
|---|---|
| `createMcpServer` 207-250 | **208-260** |
| six `register*Tools` 242-247 | **252-257** |
| `announce_work` 36-187 | **39-222** |
| `hot_files` 19-32 | **22-40** |
| `get_session_files` 34-47 | **42-57** |
| `list_agents` 49-65 | **58-76** |
| `get_blast_radius` 73-88 | **77-94** |
| `get_module_info` 90-103 | **96-111** |
| `wait_for_message` 52-77 | **54-82** |
| `get_queued_messages` 79-93 | **84-106** |
| `coordinator_status` 32-71 | **34-75** |

Restent exacts : `runCommonAnnounceFlow` 60-184, `CategorizedImpact` 16-20, `ImpactScore` 8-14, `getRelevantContext` 18-53, `Metrics` 38-258. **Quatrième fiche d'affilée** (`E08`, `E09`, `E10`, `E11`) dont la §0 se déclare vérifiée sur des références qui ont bougé — et le challenge d'`E08` avait utilisé 252-257 sans signaler la dérive.

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
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-17 |
| **Justification** | ⭑ **Adopté — borner le contexte auto-livré.** C'est le seul volet avec une justification **mesurée**, il est côté serveur et neutre vis-à-vis du client. `getActionSummaries` (`consultation.ts:630-640`) n'a **aucun `LIMIT`** et son unique appelant ne passe **pas** de `since` ; avec 30 jours de rétention, une réponse `announce_work` atteint **59 ko ≈ 14 800 tokens (15 % du seuil de 100 000)** dont **97 % en `context`**. Sept appels suffisent à déclencher le context editing — qui efface alors les annonces des pairs. **La verbosité non bornée du chemin de coordination accélère la perte de la coordination.** → **#361** ⭑ **Refusé — retirer `impact.pass`.** Dès qu'un pair a ~8 résumés, `pass` tombe sous 30 % (22 %, puis 2 % à 200) : structurellement minimal (~92 octets fixes par entrée, car `score < 30 ⟹ reasons: []`). Aucun consommateur externe ne le lit. Le changement de contrat achèterait très peu. ⭑ **Refusé — PTC**, mais pas pour la raison que la fiche avance : le contre-exemple τ²-bench porte sur du **fan-out**, or le cas défendu ici est du **fan-in**. Le vrai motif est que **PTC garde les résultats intermédiaires hors de la conversation** — pour `announce_work` c'est le mode de défaillance du produit, pas son optimisation : tout l'intérêt est que le modèle **voie** le conflit. ⭑ **Rouvert — la réhydratation** (point 3 de §4), que j'allais refuser. Vérifié : `coordinator_status` ne rend que des **compteurs**, `get_session_files` exige un `session_id` que l'agent compacté a perdu, et **aucun outil ne prend un `agent_id` pour rendre les fichiers que cet agent tient**. C'est le seul volet qui serve la population **attestée** — Claude Code, qui compacte de lui-même. ⭑ **Documenter `exclude_tools` : oui, mais en caveat, pas en tête.** La doc est écrivable (`C06:312` a mesuré le préfixe réel `mcp__<clé .mcp.json>__<outil>`, choisi par l'utilisateur ; seule la forme sous `mcp_toolset` reste inconnue). Mais `context_management` est un champ de la Messages API, et `E08` a mesuré qu'**aucun intégrateur ne pilote cette boucle** : la population qui peut appliquer le remède est vide, celle qui subit le défaut ne peut pas l'appliquer. **Corrections de méthode.** **Mon argument porteur était faux d'un facteur 20** : j'avais mesuré 2,7 ko avec 3 résumés par pair et conclu « 0,7 % du seuil, ~140 appels » — un artefact de banc, retiré. **K1 était mal calibré** : un seuil sur `pass` décidait trois changements indépendants, et la mesure qui le déclenche prouve le contraire de l'un d'eux. Et mon livrable « invalidation de cache » était **surdéclaré** : la portée est **un agent, son propre préfixe** (une instance `McpServer` par session, aucune retenue), et le chaînon client est **non documenté** (MCP dit *« SHOULD send a notification »*, le `tools/list` du client est un bloc `opt`). Requalifié en **caveat croisé sur `A02`/`E08`** : la tension est réelle — j'ai écrit en `E08` que `disable()` était « la même capacité, en mieux » que `tool_removal`, sur l'axe précis que `tool_removal` protège. Enfin, le test d'invariant que j'allais adopter **renverse un choix commenté** (`mcp-stdio-smoke.test.ts:32-33`, borne lâche volontaire) : à ne faire qu'en le disant. |
| **Issue / PR** | **#361** — `announce_work` peut renvoyer 59 ko en une réponse : `getActionSummaries` sans `LIMIT` ni `since`, rétention 30 j, `context` à 97 % ; plus les six champs non bornés du même trajet et l'observation que le remède (réhydratation) n'a aucun outil. |
| **Jalon visé** | #361 avant la prochaine mineure — c'est le chemin le plus chaud du serveur et le défaut s'auto-aggrave. La réhydratation est un candidat autonome, à instruire après #361. Aucun jalon pour PTC ni pour le retrait de `impact.pass`. Le caveat cache appartient à **`A02`**. §5 de cette fiche : **onze** plages de lignes à recaler (périmées depuis le 2026-08-15). |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : chiffres PTC, modèles task budgets, seuils de cache et 2 lignes du §5 corrigés. |
| 2026-08-17 | **Challenge — verdict `adopter partiellement` ; mon argument porteur était faux d'un facteur 20.** J'avais mesuré le payload d'`announce_work` avec 3 résumés par pair (**2,7 ko**) et j'allais conclure « 0,7 % du seuil de 100 000 tokens, ~140 appels pour l'atteindre ». **Artefact de banc, retiré.** `getActionSummaries` (`consultation.ts:630-640`) n'a **aucun `LIMIT`** et son unique appelant (`context-provider.ts:42`) ne passe **pas** de `since` ; la seule variable qui compte est l'historique du pair, retenu **30 jours**. Remesuré : 0/3/8/40/200 résumés → **1 886 / 2 730 / 4 140 / 13 254 / 59 154 octets**, avec `context` passant de 5 % à **97 %**. **Une réponse à 59 ko = ~14 800 tokens = 15 % du seuil ; sept appels suffisent.** Et le défaut s'auto-aggrave : la verbosité non bornée du chemin de coordination **accélère** le context editing, qui efface justement les annonces des pairs. → **#361**. **K1 était mal calibré** : un seuil sur `impact.pass` faisait décider trois changements indépendants, et la mesure qui le déclenche (à 8 résumés, `pass` tombe à 22 %) est la **meilleure preuve en faveur** du bornage. Adjugé mal calibré, les trois volets tranchés séparément. **Refusé** : retirer `impact.pass` (structurellement minimal, ~92 o fixes car `score < 30 ⟹ reasons: []`, et aucun consommateur externe) ; et **PTC**, mais pas par τ²-bench — celui-ci porte sur du **fan-out** alors que le cas défendu est du **fan-in**. Le vrai motif : PTC garde les résultats intermédiaires **hors** de la conversation, or pour `announce_work` c'est le mode de défaillance du produit, pas son optimisation. **Rouvert** : la réhydratation, que j'allais refuser — vérifié, `coordinator_status` ne rend que des compteurs, `get_session_files` exige un `session_id` perdu à la compaction, et **aucun outil ne prend un `agent_id` pour rendre ses fichiers**. C'est le seul volet servant la population **attestée**. **`exclude_tools` en caveat, pas en tête** : la doc est écrivable (`C06:312` a mesuré le préfixe réel `mcp__<clé .mcp.json>__<outil>`), mais la population qui peut l'appliquer est celle-là même — vide — qui a servi à tuer la recette d'`E08`. **Livrable cache surdéclaré, corrigé** : portée = **un agent, son propre préfixe** (une instance `McpServer` par session, `serve-http.ts:513` ne retient que les transports), et le chaînon client est **non documenté** (MCP : *« SHOULD send a notification »*, `tools/list` en bloc `opt`). Requalifié en caveat croisé sur `A02`/`E08` — la tension est réelle, j'y avais écrit que `disable()` était « la même capacité, en mieux » que `tool_removal`, sur l'axe précis que `tool_removal` protège. **K2/K3/K4/K5 ne se déclenchent pas** (levier serveur existant mais de portée agent ; **0** `$ref` sur 26 schémas ; aucun consommateur externe de `pass` ; 26 mêmes noms même ordre sous 3 configs). **Un seul critère se déclenche (K6, aucun histogramme de taille).** Le test d'invariant que j'allais adopter **renverse un choix commenté** (`mcp-stdio-smoke.test.ts:32-33`). Et §5 a **onze** plages de lignes périmées depuis le 2026-08-15 — quatrième fiche d'affilée dans ce cas après `E08`, `E09`, `E10`. |
