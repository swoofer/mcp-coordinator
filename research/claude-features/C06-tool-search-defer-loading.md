# C06 — Tool search et defer_loading : que faire des 26 outils MCP

> **Fiche de veille.** Sections 1 à 5 remplies par la veille. Sections 6 à 8 remplies
> **pendant le challenge** de la feature (une session dédiée par fiche).

| Champ | Valeur |
|---|---|
| **ID** | `tool-search-defer-loading` |
| **Surface** | claude-code · agent-sdk · claude-api |
| **Statut** | GA (les trois surfaces) |
| **Disponible depuis** | API : beta 2025-11-24 (header `advanced-tool-use-2025-11-20`), GA 2026-02-17 (plus de header). Claude Code / Agent SDK : activé **par défaut**, comportement affiné jusqu'à v2.1.214+ ; override managed-settings en v2.1.227 |
| **Tier** | T1-incontournable |
| **Nature** | threat (accessoirement : opportunity) |
| **Effort estimé** | S |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED (3 chercheurs indépendants, tous CONFIRMED) |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — daemon local + Claude Code suffisent, aucun accès fermé requis |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — la divergence entre chercheurs est **tranchée** par `code.claude.com/docs/en/mcp.md` :
  « Only tool names and server instructions load at session start ». Les **descriptions
  d'outils ne sont pas visibles au premier tour** ; elles ne servent qu'à l'indexation pour la
  recherche. Le marqueur `(à vérifier)` est retiré.
- §2 — ajout d'un levier **côté serveur** que la fiche ne mentionnait pas : un serveur MCP peut
  marquer un outil individuel comme toujours chargé via `"anthropic/alwaysLoad": true` dans le
  `_meta` de l'outil. Ce n'est donc pas uniquement un champ de config client.
- §2 — ajout de la **troncature à 2 Ko** des descriptions d'outils et des `instructions` serveur
  par Claude Code (contrainte de dimensionnement pour le futur texte d'`instructions`).
- §2 — `alwaysLoad` est disponible sur **tous** les types de serveurs (la fiche ne citait que
  `ws` et `http`) ; il fait aussi **attendre le démarrage**, plafonné au timeout de connexion de
  5 s. Ajout de `permissions.deny: ["ToolSearch"]` comme second moyen de désactivation.
- §2 — précision de la désactivation GCP : il s'agit de **Google Cloud Agent Platform**, pour les
  modèles antérieurs à la génération 4.5 ; avant v2.1.221 c'était **tous** les modèles GCP.
- §5 — aucun fichier retiré, aucun numéro de ligne faux. Les 15 entrées du tableau ont été
  ouvertes et vérifiées une par une (voir détail ci-dessous).

Vérifié sans correction : les noms d'API `defer_loading`, `tool_search_tool_regex_20251119`,
`tool_search_tool_bm25_20251119` (+ alias non datés), `limit` (défaut 5, plage 1..10 000),
`server_tool_use`, `tool_search_tool_result` → `tool_search_tool_search_result` →
`tool_references[].tool_reference.tool_name`, les quatre `error_code`, le plafond de 10 000 outils
déférés, l'interdiction `defer_loading` + `cache_control` (400), les limites 200 car. regex /
500 car. BM25, le fait que la recherche matche noms + descriptions + noms et descriptions
d'arguments, les valeurs de `ENABLE_TOOL_SEARCH`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`,
`ToolSearch` et `WaitForMcpServers`. **Statut GA confirmé** sur les trois surfaces
(« Tool search is generally available on the Claude API » ; « Tool search is enabled by default »
côté Claude Code).

Côté repo, vérifié ligne à ligne : `createMcpServer()` l. 207-250 sans `instructions`, commentaire
« all 26 MCP tools registered » l. 237, `announce_work` l. 37 avec la description « Open a
consultation thread before starting work », `coordinator_status` l. 33 (« Full system status »),
`wait_for_peers` l. 74, `INSTRUCTIONS` l. 152-175 de `cli/channel.ts` passé en `instructions:`
l. 318, `post_to_thread` l. 343, `CLAUDE_MD_TEMPLATE` l. 10 et sa règle `announce_work` l. 23,
`snippet` l. 195-202 avec `type: "http"` l. 198, `docs/operating-modes.md` l. 47,
`docs/ARCHITECTURE.md` l. 18, `docs/index.html` l. 1913 / 2060 / 2143 / 2619 (20 occurrences
« 26 outils MCP » toutes langues confondues). `cli/doctor.ts` : zéro occurrence de `tools` —
l'affirmation « aucun contrôle lié aux outils » tient. `sdk/src/client.ts` et
`sdk/src/discovery.ts` : zéro occurrence de `tools/list`, `listTools` ou `McpServer` — le SDK est
bien hors chemin. `@modelcontextprotocol/sdk` déclaré `^1.29.0`, **1.30.0 installé**, et
`instructions` est bien un champ optionnel de l'`InitializeResult` du SDK.

**Marqueurs `(à vérifier)` restants :** aucun. Le seul marqueur de la fiche (§2, divergence sur ce
que voit le modèle au premier tour) est tranché par la doc officielle.

**Testabilité :** ✅ testable
Les cinq étapes du §6.3 se lancent ici : daemon local + une session Claude Code sur un répertoire
sans CLAUDE.md de coordination, puis comparaison `ENABLE_TOOL_SEARCH=false` vs. défaut pour
chiffrer les 26 schémas, puis ajout de `instructions` dans `createMcpServer()` et rejeu du test 1,
puis `alwaysLoad: true` dans un `.mcp.json`. Aucun header beta ni accès fermé n'est requis : la
feature est GA et activée par défaut dans le Claude Code installé. Seule nuance sur l'étape 2 : on
n'inspecte pas directement le préfixe système, on l'infère par différence entre les deux modes et
par `/context`.

## 1. Ce que c'est

Le *tool search* déplace les définitions d'outils hors du préfixe système : au lieu de charger les schémas JSON complets de tous les outils au démarrage, le modèle ne voit qu'un index compact et matérialise à la demande ceux dont il a besoin, via un outil serveur dédié. Côté API, on envoie **toutes** les définitions dans `tools` en marquant `defer_loading: true` sur celles qui doivent rester hors du préfixe (au moins un outil, typiquement le tool search lui-même, doit rester non-déféré) ; l'API renvoie des blocs `tool_reference` qu'elle expanse elle-même **inline dans la conversation**, ce qui préserve le cache de prompt. Deux variantes de recherche : regex (Claude écrit un pattern Python `re.search`, 200 car. max) et BM25 (langage naturel, 500 car. max) ; la recherche matche les noms d'outils, leurs descriptions, **et les noms et descriptions des arguments**. Côté Claude Code et Agent SDK, le mécanisme est **activé par défaut** et s'applique aux serveurs MCP : Claude reçoit une liste de noms plus le champ `instructions` du serveur, et appelle `ToolSearch` pour obtenir les schémas. La doc chiffre le problème que ça résout : ~50 outils = 10-20K tokens de définitions, et la précision de sélection se dégrade au-delà de 30-50 outils chargés ; elle recommande le tool search dès 10 outils ou 10K tokens. Un serveur peut être exempté avec `alwaysLoad: true`, auquel cas ses schémas sont présents dès le premier tour et Claude Code attend sa connexion au démarrage.

Le point qui fait de cette fiche une menace et pas une opportunité : ce n'est **pas** une option à activer, c'est un changement de comportement déjà en production chez tous les utilisateurs de Claude Code.

## 2. Surface d'API exacte

Côté API Claude :

```
tools[].defer_loading            # bool
tool_search_tool_regex_20251119  # type d'outil serveur (alias non daté : tool_search_tool_regex)
tool_search_tool_bm25_20251119   # type d'outil serveur (alias non daté : tool_search_tool_bm25)
limit                            # nb de tool_reference retournés, défaut 5, plage 1..10000

# blocs de réponse
server_tool_use
tool_search_tool_result -> tool_search_tool_search_result
  -> tool_references[].tool_reference.tool_name

# erreurs
invalid_tool_input | unavailable | too_many_requests | execution_time_exceeded
```

Contraintes API : max 10 000 outils déférés par requête ; un outil `defer_loading: true` ne peut pas porter `cache_control` (→ 400).

Côté Claude Code / Agent SDK :

```
ToolSearch                       # l'outil que Claude appelle pour matérialiser des schémas
WaitForMcpServers                # réapparaît uniquement quand le tool search est désactivé
ENABLE_TOOL_SEARCH               # non défini (= on) | true | auto | auto:N | false
alwaysLoad                       # bool, dans la config d'un serveur MCP — disponible sur
                                 # TOUS les types de serveurs (stdio, http, sse, ws), ou dans
                                 # les extras de tool() côté SDK
"anthropic/alwaysLoad": true     # dans le `_meta` d'un outil : le SERVEUR marque lui-même un
                                 # outil comme toujours chargé (même effet, granularité outil)
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
permissions.deny: ["ToolSearch"] # second moyen de désactivation, côté settings.json
```

`auto` active le tool search quand les définitions déferrables atteignent 10 % de la fenêtre de contexte ; `auto:N` fixe le seuil. Désactivation automatique quand `ANTHROPIC_BASE_URL` pointe hors first-party, sur les déploiements Microsoft Foundry hébergés sur Azure (rejet serveur, non contournable par `ENABLE_TOOL_SEARCH`), et sur les modèles Google Cloud Agent Platform antérieurs à la génération 4.5 (avant v2.1.221 : **tous** les modèles GCP, sauf `ENABLE_TOOL_SEARCH=true`).

Deux contraintes Claude Code à retenir pour le dimensionnement : les descriptions d'outils **et** les `instructions` serveur sont tronquées à **2 Ko chacune** (mettre l'essentiel au début) ; et `alwaysLoad: true` fait **attendre le démarrage** que le serveur ait livré ses outils, plafonné au timeout de connexion standard de 5 s (une entrée `cached` valide évite l'attente).

Exemple de config client visant mcp-coordinator (forme à confirmer sur une vraie install — voir §6.3) :

```json
{
  "mcpServers": {
    "coordinator": { "type": "http", "url": "http://localhost:3000/mcp", "alwaysLoad": true }
  }
}
```

**Divergence entre chercheurs — tranchée le 2026-08-14 :** c'est le premier chercheur qui a raison. `code.claude.com/docs/en/mcp.md` (« Scale with MCP tool search ») est explicite : *« Only tool names and server instructions load at session start »*. Les **descriptions d'outils ne sont donc pas dans le contexte au premier tour** — elles ne sont qu'indexées pour la recherche (`ToolSearch` matche noms, descriptions, noms et descriptions d'arguments). Conséquence directe pour la stratégie : au premier tour, la seule surface de découverte est **les noms + le champ `instructions` du serveur** ; les descriptions ne servent qu'à être trouvé une fois que Claude cherche déjà. La doc le dit d'ailleurs frontalement aux auteurs de serveurs : *« the server instructions field becomes more useful with tool search enabled »*, avec la recommandation d'y expliquer quelle catégorie de tâches les outils couvrent et **quand** Claude doit les chercher (« similar to how skills work »).

## 3. Sources

- https://code.claude.com/docs/en/mcp.md
- https://code.claude.com/docs/en/tools-reference.md
- https://code.claude.com/docs/en/agent-sdk/tool-search.md
- https://code.claude.com/docs/en/agent-sdk/mcp.md
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context
- https://www.anthropic.com/engineering/advanced-tool-use

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
L'argument « votre serveur expose trop d'outils, il mange mon contexte » disparaît. Les 26 outils (vérifiés : 4 agents + 11 consultation + 3 files + dépendances + status + mqtt) ne coûtent plus rien au démarrage d'une session Claude Code, ce qui débloque la possibilité d'en ajouter (Phase 5, quota, admin) sans arbitrage token. Aucun code serveur n'est à supprimer : c'est du renommage, de la description et **un champ `instructions` à écrire**. Bénéficiaire direct : l'auto-hébergeur solo qui lance 3-4 agents Claude Code sur un même repo et qui payait jusqu'ici ~10K tokens de schémas par agent et par session.

**Risque si on ne fait rien :**
Le workflow d'annonce est **silencieusement cassé en production**. Tout le contrat du projet repose sur « avant d'éditer un fichier, appelle `announce_work` » — une instruction qui n'existe nulle part dans le protocole MCP du serveur : elle vit uniquement dans le `CLAUDE_MD_TEMPLATE` de `cli/init.ts`, que l'utilisateur doit avoir installé via `init --write-claude-md`. Sans ce CLAUDE.md, un agent dont les schémas sont différés ne voit plus, au premier tour, la description « Open a consultation thread before starting work » : il édite d'abord, il découvre le coordinateur ensuite — ou jamais. Trois aggravants vérifiés dans le repo :

1. `createMcpServer()` ne passe **pas** `instructions` au constructeur `McpServer` (seulement `name` et `version`). Or c'est précisément la surface de découverte qui survit au deferral. Le SDK MCP l'accepte (`ServerOptions.instructions`, présent dans `@modelcontextprotocol/sdk@^1.29.0`), et `cli/channel.ts` s'en sert déjà — le daemon, non.
2. Les descriptions d'outils font 3 à 8 mots (`"List files modified by multiple agents"`, `"Full system status"`, `"Log a one-liner summary of an action"`). Sous BM25, c'est une surface de matching maigre. Seul `wait_for_peers` a une description qui explique *quand* l'appeler.
3. Les noms sont génériques et sans namespace : `heartbeat`, `hot_files`, `get_thread`, `close_thread`. En session multi-serveurs, ils entrent en collision de vocabulaire avec d'autres MCP (git, issue trackers) au moment de la recherche.

Effet de bord documentaire : `docs/operating-modes.md:47` affirme « Claude now has all 26 tools available », et `docs/index.html` répète « 26 outils MCP » dans 6 langues. Ce n'est plus exact par défaut.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/server-setup.ts` | `createMcpServer()` (l. 207-250) instancie `new McpServer({ name, version })` sans `instructions` — c'est **le** point de correction n°1. Le commentaire l. 237 (« all 26 MCP tools registered ») documente le compte. |
| `src/tools/consultation-tools.ts` | 11 outils (`announce_work`, `post_to_thread`, `propose_resolution`, `approve_resolution`, `contest_resolution`, `close_thread`, `cancel_thread`, `get_thread`, `get_thread_updates`, `list_threads`, `log_action_summary`). `announce_work` (l. 37) : description « Open a consultation thread before starting work » — à réécrire pour le matching BM25 et pour porter l'obligation. |
| `src/tools/agents-tools.ts` | 4 outils (`register_agent`, `list_agents`, `heartbeat`, `agent_activity`). `heartbeat` est le nom le plus collisionnable du lot. |
| `src/tools/files-tools.ts` | 3 outils (`hot_files`, `get_session_files`, `check_file_conflict`). Descriptions de 5-8 mots ; `check_file_conflict` est candidat au sous-ensemble non-déféré. |
| `src/tools/status-tools.ts` | `coordinator_status` (« Full system status », l. 33) et `wait_for_peers` (l. 74) — seule description du repo qui explique le *quand* ; sert de modèle. |
| `src/tools/dependencies-tools.ts`, `src/tools/mqtt-tools.ts` | `get_blast_radius`, `get_module_info`, `set_dependency_map`, `mqtt_publish`, `get_queued_messages`, `wait_for_message` — le reste des 26. Candidats naturels au deferral. |
| `cli/channel.ts` | Précédent interne : `INSTRUCTIONS` (l. 152-175) passé au serveur via `instructions:` (l. 318). Serveur stdio à **1 outil** (`post_to_thread`, l. 343) — non concerné par le problème de volume, mais son texte d'instructions est le gabarit à reproduire côté daemon. |
| `cli/init.ts` | `CLAUDE_MD_TEMPLATE` (l. 10 sq.) porte aujourd'hui **seul** la règle « avant toute modif de source, appelle `announce_work` » (l. 23). Le `snippet` `.mcp.json` généré (l. 195-202) est `{ type: "http", url }` — c'est là qu'un `alwaysLoad` irait, et là qu'il faudrait le documenter. |
| `cli/doctor.ts` | Aucun contrôle lié aux outils aujourd'hui (vérifié : pas de `tools/list`, pas de compte). Emplacement naturel pour un check « le client differe-t-il les schémas ? ». |
| `docs/operating-modes.md` | L. 47 : « Claude now has all 26 tools available » — devenu faux par défaut. |
| `docs/index.html` | 4 chaînes i18n × 6 langues mentionnent « 26 MCP tools / 26 outils MCP » (l. 1913, 2060, 2143, 2619 + blocs de traduction). Cohérence documentaire à revoir si le discours change. |
| `docs/ARCHITECTURE.md` | L. 18 décrit `src/tools/*.ts` ; à compléter si un sous-ensemble « toujours chargé » est formalisé. |
| `sdk/src/client.ts`, `sdk/src/discovery.ts` | Le SDK TypeScript est un client REST/MCP maison : il ne passe pas par le tool search de Claude Code, donc **non impacté**. À vérifier avant de généraliser une décision « on renomme tout ». |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Puisque les schémas sont différés par défaut et que la seule surface de découverte restante est `instructions` + les noms d'outils, faut-il (a) réécrire noms et descriptions des 26 outils pour le matching BM25 et pousser toute la contrainte d'annonce dans un `instructions` serveur — ou (b) documenter `alwaysLoad: true` sur l'entrée `coordinator` du `.mcp.json` et assumer de rester le serveur qui charge 26 schémas au démarrage ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

- [ ] Lancer le daemon, brancher une session Claude Code **sans** CLAUDE.md de coordination, demander une modif de fichier, et observer si `announce_work` est appelé spontanément. C'est le test de la régression supposée, pas une théorie.
- [ ] Sur la même session, inspecter ce que le modèle voit réellement au premier tour (noms seuls ? noms + descriptions ? `instructions` ?) — tranche la divergence signalée en §2.
- [ ] Mesurer le coût en tokens des 26 schémas : comparer une session avec `ENABLE_TOOL_SEARCH=false` et une session par défaut. Chiffrer avant de décider si le problème vaut le renommage.
- [ ] Ajouter un `instructions` sur `createMcpServer()` (2 lignes), redémarrer, refaire le test 1 : le workflow d'annonce revient-il sans toucher aux noms ?
- [ ] Tester `alwaysLoad: true` dans un `.mcp.json` pointant sur l'entrée `type: "http"` du coordinateur, et vérifier que le champ est bien accepté et non ignoré silencieusement.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **`alwaysLoad` est une bequille qui rend le problème invisible sans le résoudre.** Elle règle le cas d'un utilisateur qui n'a que le coordinateur ; elle ne règle rien pour celui qui en a cinq et qui verra son contexte re-remplir. Et c'est un champ que l'utilisateur doit mettre dans **sa** config : on ne contrôle rien, on peut juste documenter.
- **Renommer 26 outils casse tout ce qui les appelle.** `CLAUDE_MD_TEMPLATE` dans `cli/init.ts` cite les noms en dur, `docs/usage.md`, `README.md`, `docs/index.html` (6 langues), les tests, le SDK et les CLAUDE.md déjà déployés chez les utilisateurs. Un préfixe `coord_*` est un breaking change de surface publique pour un gain qui n'est, à ce stade, pas mesuré.
- **Le mécanisme est spécifique à Claude Code / à l'API Anthropic.** Optimiser noms et descriptions pour BM25 revient à optimiser pour un seul client. Le projet vise le protocole MCP, pas Claude Code — et le tool search est désactivé hors first-party (`ANTHROPIC_BASE_URL` custom), sur Foundry/Azure et sur les anciens modèles GCP, donc une part des installs ne le verra jamais.
- **C'est du comportement mouvant.** Le bundle recense déjà quatre paliers de version (v2.1.214+, v2.1.227, GA API 2026-02-17, alias datés vs non datés). Coder ou documenter des heuristiques précises aujourd'hui, c'est signer pour de la maintenance documentaire à chaque release de Claude Code.
- **YAGNI sur la partie API.** `defer_loading`, les variantes regex/BM25, `limit`, les blocs `tool_reference` : mcp-coordinator est un **serveur** MCP, il n'appelle pas l'API Claude avec un catalogue d'outils. Toute cette moitié de la fiche est du contexte, pas une surface d'intégration. Seul le versant Claude Code nous concerne.
- **Le vrai correctif tient peut-être en deux lignes.** Si ajouter `instructions` à `createMcpServer()` suffit à restaurer le workflow d'annonce, tout le reste (namespace, descriptions enrichies, `alwaysLoad` documenté, checks `doctor`) est de l'effort disproportionné qui doit être justifié par une mesure, pas par la lecture d'une doc.

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
| 2026-08-14 | Vérification des faits : divergence §2 tranchée (noms + `instructions` seuls), `_meta` alwaysLoad ajouté, §5 intact. |
