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
| **Nature** | ~~threat~~ → **opportunity** (reclassé au challenge du 2026-08-15 : le tool search n'a rien cassé, voir §7.3) |
| **Effort estimé** | S |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED (3 chercheurs indépendants, tous CONFIRMED) |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ✅ testable — daemon local + Claude Code suffisent, aucun accès fermé requis |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — adopter partiellement, voir §7 |

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

> 🛠 **Corrigé au challenge du 2026-08-15.** Le paragraphe ci-dessous impute la rupture du workflow
> au deferral. **C'est faux, et mesuré comme tel** : avec `ENABLE_TOOL_SEARCH=false` et les 26
> schémas pleinement chargés, l'agent n'annonce pas davantage (§6.4 (C), et bras A5). Le workflow
> n'a jamais fonctionné ; le tool search n'a fait que rendre l'absence de contrainte visible.
> Le reste du paragraphe — les trois aggravants — reste exact. Voir §7.3.

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

**Pré-enregistré le 2026-08-15, avant toute exécution.** Environnement du challenge :
Claude Code **2.1.219**, Node 22.21.0, Windows 11, `@modelcontextprotocol/sdk` 1.30.0.

**Hypothèse.** La régression est réelle mais son correctif est asymétrique : le champ
`instructions` du serveur — absent de `createMcpServer()` — est la seule surface qui survit au
deferral, et l'écrire suffit à restaurer la découverte du workflow d'annonce. Le renommage des
26 outils (option a intégrale) et `alwaysLoad` (option b) sont tous deux disproportionnés :
le premier est un breaking change de surface publique pour un gain non mesuré, le second est une
clé dans la config **de l'utilisateur**, qu'on ne contrôle pas.

**Critères de refus, chiffrés, posés avant de mesurer :**

| # | Ce qui tue quoi | Seuil |
|---|---|---|
| K1 | Si les 26 schémas coûtent **< 3 000 tokens**, la prémisse « on mange le contexte » de §4 s'effondre : le seuil `auto` (10 % de la fenêtre) n'est jamais atteint, et l'argument bénéfice de la fiche tombe. | 3 000 tokens |
| K2 | Si, **sans CLAUDE.md** et avec le tool search actif, l'agent appelle malgré tout `announce_work` spontanément, la régression annoncée par la synthèse §4 est **réfutée** → verdict « refuser » sur le volet menace. | 1 essai propre suffit à réfuter ; l'inverse demande 2 essais concordants |
| K3 | Si ajouter `instructions` ne change **pas** le comportement de K2, le « correctif en deux lignes » est mort et il faut basculer sur `alwaysLoad` ou sur le hook de `C01`. | comportement identique |
| K4 | Si `alwaysLoad: true` dans un `.mcp.json` est **rejeté ou silencieusement ignoré** par Claude Code 2.1.219, l'option (b) est morte et ne doit pas être documentée. | rejet de schéma ou absence d'effet observable |
| K5 | Si porter `"anthropic/alwaysLoad": true` dans le `_meta` d'un outil impose de migrer les 26 `server.tool()` vers `registerTool()`, l'effort n'est plus S → le levier serveur est écarté de ce challenge et renvoyé à `A06`. | > 10 fichiers touchés |
| K6 | Si le tool search ne s'applique **pas** aux serveurs MCP locaux/HTTP dans cette version, toute la fiche est hors sujet → « refuser ». | observation directe |

### 6.3 Protocole de vérification

Amendé le 2026-08-15. Cinq étapes, exécutées dans cet ordre, sortie brute en §6.4.

- [x] **T0 — Observation de la session courante.** Cette session Claude Code est elle-même un cas
      d'usage : relever quels serveurs MCP y sont différés, et vérifier si leur champ
      `instructions` survit au deferral (c'est la question centrale, observable sans rien lancer).
- [x] **T1 — Mesure.** Démarrer le serveur en stdio, parler JSON-RPC (`initialize` + `tools/list`),
      compter les 26 outils, mesurer les octets et estimer les tokens. Tranche K1.
- [x] **T2 — Régression.** Daemon lancé, répertoire temporaire **sans** CLAUDE.md, session
      `claude -p` headless avec le coordinateur en `.mcp.json`, demande d'édition de fichier :
      `announce_work` est-il appelé ? Tranche K2/K6.
- [x] **T3 — Correctif.** Ajouter `instructions` à `createMcpServer()` (PoC jetable dans le
      scratchpad, jamais commité), rejouer T2. Tranche K3.
- [x] **T4 — `alwaysLoad`.** Poser `alwaysLoad: true` sur l'entrée `coordinator` du `.mcp.json` et
      vérifier acceptation / effet. Tranche K4. Puis lire le SDK pour K5.

### 6.4 Résultat observé

Exécuté le 2026-08-15. Environnement : Claude Code **2.1.219**, Node 22.21.0, Windows 11,
`@modelcontextprotocol/sdk` **1.30.0**, serveur en **stdio**. Tous les runs `claude -p` :
répertoire temporaire du scratchpad, **aucun CLAUDE.md de coordination**, `--strict-mcp-config`
(le coordinateur est le seul serveur MCP), `--output-format stream-json --verbose`.

**Frontière exécuté / lu.** Tout ce qui suit sauf le point (F) a été **exécuté**. Le point (F)
(`_meta` côté serveur) est une lecture de types du SDK, non exécutée.

---

**(A) T1 — le vrai `tools/list`, mesuré.** Sonde JSON-RPC maison sur le serveur stdio :

```
=== initialize result ===
{
  "protocolVersion": "2025-06-18",
  "capabilities": { "tools": { "listChanged": true } },
  "serverInfo": { "name": "io.github.swoofer/mcp-coordinator", "version": "2.0.1" }
}
instructions present in InitializeResult? -> false

=== tools/list ===
tool count: 26
wire bytes (compact JSON): 15719
rough tokens (bytes/3.6): 4366

total description bytes: 1056
names-only bytes: 464
_meta present on any tool? false
```

Les 26 noms sont exactement ceux de §5. Les descriptions vont de **3 à 9 mots**, sauf
`wait_for_peers` (29 mots) — §4 disait « 3 à 8 mots », c'est vérifié. Le corps du coût est le
**JSON Schema**, pas la description : 1 056 octets de descriptions pour 15 719 octets au total.

**Correction à §4 :** la fiche annonce « ~10K tokens de schémas par agent et par session ». La
mesure donne **15 719 octets**, soit de l'ordre de 3 500–5 000 tokens selon la méthode de comptage.
Le chiffre de la fiche est **surestimé d'un facteur ~2**.

---

**(B) T2 — la régression, avec le tool search par défaut.** Tâche : renommer `computeTotal` en
`computeSum` dans `src/billing.ts`.

```
[init] mcp_servers: [{"name":"coordinator","status":"pending"}]
[init] tools: ["Task","Artifact","Bash",…,"ToolSearch","WebFetch","WebSearch","Workflow","Write"]
        (34 outils — AUCUN mcp__coordinator__*)
[tool_use] Glob   {"pattern":"**/billing.ts"}
[tool_use] Grep   {"pattern":"computeTotal",…}
[tool_use] Read   …/src/billing.ts
[tool_use] Bash   ls -R …
[tool_use] Read   …/src/billing.ts
[tool_use] Edit   …/src/billing.ts
[tool_use] Edit   …/src/billing.ts
[tool_use] Grep   {"pattern":"computeTotal|computeSum",…}
[result] success turns: 9
```

Le fichier est édité. **Zéro appel au coordinateur.** Le serveur est encore `pending` au démarrage
de la session : le tool search n'attend pas les serveurs MCP (`WaitForMcpServers` est absent).
K6 est levé : le tool search s'applique bien aux serveurs MCP locaux.

---

**(C) T2-contrôle — `ENABLE_TOOL_SEARCH=false`, même tâche.** C'est le résultat qui retourne la
fiche.

```
[init] total tools: 59
[init] mcp tools: ["mcp__coordinator__agent_activity","mcp__coordinator__announce_work",
                   … 26 entrées …,"mcp__coordinator__wait_for_peers"]
[init] ToolSearch present? false | WaitForMcpServers? false
[init] mcp_servers: [{"name":"coordinator","status":"connected"}]
[tool_use] Bash
[tool_use] Read
[tool_use] Grep
[tool_use] Edit
[tool_use] Edit
[tool_use] Grep
[result] success turns: 7
```

Les **26 schémas sont intégralement chargés dans le contexte**, le serveur est `connected` — et
l'agent édite quand même sans annoncer.

> ⚠️ **Ceci contredit frontalement la synthèse §4** (« Le tool search a peut-être déjà cassé le
> workflow d'annonce ») **et le §4 de cette fiche** (« Le workflow d'annonce est silencieusement
> cassé en production » *par le deferral*). Le workflow ne marchait **pas non plus avant** le tool
> search. Le tool search n'est pas la cause : il n'a fait que rendre visible une absence de
> contrainte préexistante. Charger les schémas ne fait pas annoncer.

---

**(D) T3 — ajout d'`instructions`.** PoC jetable : `dist/src/server-setup.js` patché en place
(`dist/` est gitignoré, sauvegarde prise, **restauré à l'identique** en fin de challenge), texte de
**1 031 octets** (< la troncature à 2 Ko), passé en **second argument** du constructeur.

> **Correction à §5 :** la fiche écrit « `new McpServer({ name, version })` sans `instructions` ».
> `instructions` n'appartient pas à l'objet `Implementation` (1er argument) mais à `ServerOptions`
> (2e argument, `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts:15`). Le correctif
> est `new McpServer({name, version}, { instructions })`, la forme que `cli/channel.ts:318` utilise déjà.

Vérification que le champ traverse bien le protocole :

```
instructions present in InitializeResult? -> true
```

Même tâche, même répertoire, tool search toujours actif :

```
[init] total: 34 | mcp tools: [] | ToolSearch? true
[init] mcp_servers: [{"name":"coordinator","status":"pending"}]
[tool_use] Glob        {"pattern":"**/billing.ts"}
[tool_use] Read        …/src/billing.ts
[tool_use] Grep        {"pattern":"computeTotal",…}
[tool_use] ToolSearch  {"query":"select:mcp__coordinator__register_agent,
                                  mcp__coordinator__announce_work,
                                  mcp__coordinator__check_file_conflict","max_results":5}
[tool_use] mcp__coordinator__register_agent  {"agent_id":"claude-t2-rename",…}
   [result] {"id":"claude-t2-rename","org_id":"default","status":"online",…}
[tool_use] mcp__coordinator__announce_work   {"subject":"Rename computeTotal -> computeSum…"}
   [result] {"thread":{"id":"84effbd7-b0d0-4fac-9305-19c13c14a1bd",…}}
[tool_use] Edit
[tool_use] Edit
[tool_use] Grep
[result] success turns: 10
```

**`announce_work` est appelé AVANT les deux `Edit`**, alors que les schémas restent différés :
l'agent a lu `instructions`, appelé `ToolSearch` pour matérialiser exactement les trois outils
nommés dans le texte, puis annoncé. C'est la preuve directe que **`instructions` survit au
deferral** et constitue bien la surface de découverte restante.

**Réplication (T3-bis)**, autre tâche, autre répertoire (ajout de `cartTotalWithTax` dans
`src/cart.ts`) :

```
[init] mcp tools: [] | ToolSearch? true
Glob → Read → ToolSearch → mcp__coordinator__register_agent → mcp__coordinator__announce_work
     → ToolSearch → mcp__coordinator__agent_activity → Edit
[result] success turns: 9
```

2 runs sur 2 avec `instructions` → annonce avant écriture. 3 runs sur 3 sans → aucune annonce.

---

**(E) T4 — `alwaysLoad: true`.** Le champ est **accepté et effectif** sur une entrée `stdio` :

```
[init] total: 60
[init] mcp count: 26
[init] ToolSearch? true | WaitForMcpServers? false
[init] mcp_servers: [{"name":"coordinator","status":"connected"}]
```

26 outils chargés dès l'init, serveur passé de `pending` à `connected`, et `ToolSearch` reste
présent pour les autres serveurs. **K4 n'est pas déclenché : le champ n'est ni rejeté ni ignoré.**

Mais le run décisif est celui de l'option (b) **seule** — `alwaysLoad: true`, `instructions`
retiré (dist restauré), même tâche de renommage :

```
[init] mcp count: 26 | ToolSearch? true | status: [{"name":"coordinator","status":"connected"}]
[tool_use] Glob
[tool_use] Read
[tool_use] Grep
[tool_use] Edit
[result] success turns: 5
```

**`alwaysLoad` fonctionne techniquement et ne restaure rien.** Il résout un problème de coût de
contexte, pas le problème de découverte du workflow. L'option (b) de §6.1 est réfutée par
l'expérience.

---

**(F) K5 — le levier `_meta` côté serveur (lu, non exécuté).** Dans
`@modelcontextprotocol/sdk@1.30.0`, `_meta` n'existe sur **aucune** des 7 surcharges de
`server.tool()` ; il n'apparaît que dans l'objet `config` de `registerTool()`
(`server/mcp.d.ts:150-157`). Les 26 outils du dépôt utilisent tous `server.tool()`
(`grep -c "\.tool(" src/tools/*.ts` → 26 sur 6 fichiers). Porter
`"anthropic/alwaysLoad": true` impose donc la migration `tool()` → `registerTool()` sur les
6 modules de `src/tools/`. Note annexe pour `A06` : dans le SDK 1.30, **toutes** les surcharges de
`server.tool()` portent `@deprecated Use registerTool instead`.

Ce point est de toute façon rendu sans objet par (E) : puisque charger les schémas ne restaure pas
le workflow, un levier serveur qui charge les schémas ne le restaure pas non plus.

---

---

### 6.4-bis — Second tour, après passage au feu adversarial

Le verdict formé au premier tour a été soumis à trois sous-agents chargés de le **réfuter**. Deux
d'entre eux ont marqué des points qui ont **changé le protocole**, pas seulement la rédaction. Ce
qui suit est le résultat des expériences qu'ils ont rendues nécessaires. Total : **30 sessions
`claude -p`**, chacune avec un répertoire et une base SQLite neufs.

**Ce que les réfutateurs ont cassé :**

1. *« La comparaison est confondue »* — au premier tour, le bras `instructions` portait un texte
   **impératif** (« MANDATORY ») tandis que le bras concurrent portait les descriptions natives de
   3 à 9 mots, purement nominales (« Open a consultation thread before starting work »). On ne
   comparait donc pas deux **canaux**, on comparait « un ordre » à « aucun ordre ». La conclusion
   « `alwaysLoad` ne restaure rien » n'était pas soutenue par le protocole exécuté.
2. *« `instructions` arrive en delta, pas au premier tour »* — le serveur est `pending` à l'init ;
   le texte n'entre en contexte qu'à la connexion. Une tâche qui écrit vite peut le devancer. La
   course n'avait jamais été stressée.
3. *« L'estimation octets/3,6 n'est pas défendable pour du JSON Schema »* — et le renvoi de
   `alwaysLoad` à la fiche `A06` était infondé (vérifié :
   `grep -ci alwaysload A06-*.md` → **0**).

**Matrice complète.** Variable indépendante isolée par deux interrupteurs d'environnement lus par
le serveur (`C06_INSTR`, `C06_IMPDESC`), donc **la même build** dans tous les bras. Tâche
« exploratoire » = renommer `computeTotal` (identique mot pour mot dans tous les runs).

| Bras | `instructions` | description `announce_work` | schémas | annonce **avant** écriture |
|---|---|---|---|---|
| A1 baseline | ✗ | native (7 mots) | différés | **0 / 3** |
| A4 | ✗ | **impérative** (« MANDATORY… ») | différés | **0 / 3** |
| A5 | ✗ | **impérative** | **chargés** (`alwaysLoad`) | **0 / 3** |
| A3 | ✔ | native (7 mots) | différés | **3 / 3** |

Plus les runs du premier tour : sans `instructions` **0/12** (dont un avec
`ENABLE_TOOL_SEARCH=false`, schémas pleinement chargés), avec `instructions` **5/5**.
Séparation parfaite sur 17 essais — Fisher exact unilatéral, p ≈ 1,6 × 10⁻⁴.

> **A4 et A5 lèvent le soupçon de tautologie.** Le même impératif, mot pour mot, placé dans la
> **description** de `announce_work` au lieu d'`instructions`, ne déclenche rien — ni différé (A4),
> ni **chargé en contexte** (A5). Ce n'est donc pas « on a dit au modèle de faire X, il a fait X » :
> le **canal** est la variable. `instructions` atterrit dans le prompt système ; une description
> d'outil n'est lue qu'au moment où le modèle envisage déjà cet outil. **L'option (b) de §6.1 est
> maintenant réfutée à armes égales.**

**La course, quantifiée.** Tâche « écriture immédiate » (fichier nommé, contenu donné, consigne
explicite de ne rien lire d'autre) :

```
RACE-1   Read@2.3s  Edit@5.2s                                                   -> pas d'annonce
RACE-2   Read@2.2s  Edit@5.3s  ToolSearch@12.3s  register_agent@15.1s
                               announce_work@18.8s                              -> annonce APRES l'edit
RACE-3   Read@1.9s  Edit@5.2s                                                   -> pas d'annonce
```

À comparer au bras A3, où la phase d'exploration laisse au delta le temps d'arriver :

```
A3-1     Glob@0.0s Bash@2.3s Read@21.7s Grep@21.7s ToolSearch@26.9s
         register_agent@31.6s  announce_work@33.9s  Edit@38.5s                  -> annonce avant
```

**`instructions` seul : 0/3 sur la tâche d'écriture immédiate.** La frontière est nette — si l'agent
atteint sa première écriture en moins de ~10 s, le texte n'est pas encore arrivé et le correctif ne
se déclenche pas.

**Les deux façons de fermer la course, et leur prix.** La doc officielle
(`code.claude.com/docs/en/mcp.md`, fetchée le 2026-08-15) donne le mécanisme :
*« Setting `alwaysLoad: true` also makes startup wait for the server's tools, capped at the standard
5-second connect timeout, since they must be present when the first prompt is built. Other servers
connect in the background by default; set `MCP_CONNECTION_NONBLOCKING=0` to make startup wait for
them too. »* Les deux ont été testés sur la tâche d'écriture immédiate, prefix du premier tour
mesuré (somme `input + cache_creation + cache_read` du premier message assistant) :

| Configuration | prefix 1er tour | Δ vs baseline | course gagnée |
|---|---|---|---|
| baseline (différé, sans `instructions`) | 34 775 | — | — |
| différé + `instructions` (connexion non bloquante) | **34 775** | **+0** | **0 / 3** |
| `MCP_CONNECTION_NONBLOCKING=0` + `instructions` | 35 453 | **+678** | **3 / 3** |
| `alwaysLoad: true` + `instructions` | 40 416 | **+5 641** | **3 / 3** |
| `alwaysLoad: true`, sans `instructions` | 40 109 | +5 334 | 0 / 3 |

Bruit entre trois baselines : **5 tokens**. La mesure est propre.

> **Deux résultats que la fiche n'anticipait pas.**
> **(1)** `instructions` coûte **0 token au premier tour** — parce qu'au premier tour le serveur
> n'est pas encore connecté. Son coût réel (~288 tokens) n'apparaît qu'une fois la connexion faite.
> **(2)** `MCP_CONNECTION_NONBLOCKING=0` obtient **exactement le même comportement**
> qu'`alwaysLoad` pour **+678 tokens au lieu de +5 641** — un facteur **8,3**. Il fait entrer les
> 26 **noms** (~390 tokens) et l'`instructions` (~288) dans le premier prompt, tout en laissant les
> **schémas** différés. C'est la configuration à documenter ; `alwaysLoad` ne doit pas l'être.

**Le coût réel des 26 schémas : 5 334 tokens** (`alwaysLoad` 40 109 − baseline 34 775, sur runs
neufs). Densités déduites : **2,5 octets/token** pour le JSON Schema, **3,6** pour la prose de
l'`instructions`. L'estimation octets/3,6 du premier tour était donc fausse de −22 % sur les
schémas ; elle était juste pour le texte en prose.

**Corrections chiffrées à porter :**

| Affirmation | Statut | Remplacement |
|---|---|---|
| §4 « ~10K tokens de schémas par agent et par session » | **faux ×1,9** | **5 334 tokens**, mesurés |
| §6.4 (A) « rough tokens 4 366 » (octets/3,6) | **faux −22 %** | 5 334 |
| §6.2 K1 « le seuil `auto` de 10 % n'est jamais atteint » | **non-sequitur, retiré** | le défaut n'est pas `auto` ; et la doc dit que le déferrement des outils MCP est inconditionnel, sans seuil de taille |
| §6.4 (E) « `alwaysLoad` ne restaure rien » | **requalifié** | vrai, et maintenant établi **à armes égales** par A5 (impératif chargé en contexte : 0/3) |
| §6.4 (F) « `_meta` renvoyé à `A06` » | **motif corrigé** | `A06` ne mentionne pas `alwaysLoad` (0 occurrence). Le vrai motif est A5, pas le coût de migration — K5 avait mesuré 6 fichiers, **sous** son propre seuil |

**Effets de bord vérifiés dans le dépôt** (greps refaits ici, pas repris sur parole) :

- `src/mqtt-bridge.ts:259-262` — `registerAgent()` publie `{"status":"online"}` avec
  **`retain: true`**. `publishAgentOffline()` (l. 342) n'a **aucun appelant en production**
  (`grep -rn publishAgentOffline src/ cli/` → la définition, un commentaire, un harness de test).
  Le LWT (l. 124-127) publie `retain: false`. Un texte qui prescrit `register_agent` à chaque
  session dépose donc un « online » retenu que rien ne retire.
- `src/agent-registry.ts:63` — « Agent ids are **globally unique** in this release, not per-org ».
  Un agent qui s'auto-nomme (observé : `claude-t2-rename`) peut faire échouer durement
  `register_agent` sur collision, à l'étape même que le texte déclare obligatoire.
- `docs/ARCHITECTURE.md:287-298` — la checklist « ajouter un outil MCP » a **3 étapes**, aucune ne
  parle d'`instructions`. Sans 4ᵉ étape, la dérive du texte est garantie par construction.
- `createMcpServer()` n'a que **2 appelants** (`src/index.ts:43`, `src/serve-http.ts:807`) : les
  deux transports héritent du champ gratuitement. **Aucun test ne le couvre.**
- Configuration push documentée (`docs/operating-modes.md:87` et `:157` — « use both ») : le daemon
  **et** `cli/channel.ts` exposent tous deux un outil nommé `post_to_thread`. Or A3 montre que
  l'agent appelle `ToolSearch` en mode `select:` avec les noms **littéraux** lus dans
  `instructions` — un nom ambigu est exactement le cas qui casse.

**Portabilité — l'argument du premier tour était surévalué.** La spec MCP `2025-11-25`
(fetchée aujourd'hui) ne décrit `instructions` que comme *« Optional instructions for the client »*
dans l'`InitializeResult` : aucun `MUST` n'oblige un client à l'injecter. Claude Code l'injecte
(tronqué à 2 Ko) — c'est mesuré ici. Le relevé des autres clients (VS Code oui ; Zed, Cline,
Continue non ; Cursor inconnu) provient de la passe adversariale et **n'a pas été revérifié
ici** : à traiter comme indicatif. Conclusion prudente : `instructions` est standard **à écrire**,
il n'est pas garanti **à lire**.

---

**Synthèse des critères de mort :**

| Critère | Résultat |
|---|---|
| K1 (< 3 000 tokens ⇒ prémisse coût morte) | **non déclenché** — 5 334 tokens mesurés. Mais K1 visait à côté : le déferrement des outils MCP ne dépend d'aucun seuil de taille. Le chiffre de §4 est corrigé de ~10K à 5 334. |
| K2 (annonce spontanée ⇒ menace réfutée) | **non déclenché** — 0 annonce sur **12** runs sans `instructions` |
| K3 (`instructions` sans effet ⇒ correctif mort) | **non déclenché** — 5/5 sur tâche exploratoire… mais **0/3 sur tâche d'écriture immédiate** sans connexion bloquante. Le correctif est conditionnel. |
| K4 (`alwaysLoad` rejeté ⇒ option b morte) | **non déclenché** — le champ marche. L'option (b) est tuée par A5 (impératif chargé : 0/3), pas par K4. |
| K5 (`_meta` > 10 fichiers) | **non déclenché** (6 fichiers) — et le renvoi à `A06` motivé par l'effort était **infondé** ; le motif valide est A5 |
| K6 (tool search hors sujet) | **non déclenché** — s'applique bien, serveur `pending` à l'init |

### 6.5 Contre-arguments

Repris après l'expérience du 2026-08-15. ✅ = tient et renforcé · ❌ = tombe · ➕ = révélé par l'expérience.

- ✅ **`alwaysLoad` est une béquille qui rend le problème invisible sans le résoudre.** Renforcé
  au-delà de ce que la veille imaginait, et cette fois **à armes égales** : le bras A5 charge les
  26 schémas *et* met l'impératif « MANDATORY » dans la description d'`announce_work` — 0/3.
  `alwaysLoad` ne rend même pas le problème invisible. Et quand il *sert* à quelque chose (fermer
  la course de connexion), `MCP_CONNECTION_NONBLOCKING=0` obtient le même résultat pour
  **+678 tokens au lieu de +5 641**. Il n'y a aucune configuration où `alwaysLoad` est le bon outil
  pour ce problème.
- ✅ **Renommer 26 outils casse tout ce qui les appelle.** Tient intégralement, et l'expérience
  lui retire son dernier prétexte : le matching BM25 n'a jamais été le maillon faible. Dans les
  runs (D), l'agent n'a pas eu besoin de *chercher* par mots-clés — il a appelé `ToolSearch` en
  mode `select:` avec les trois noms **littéraux** lus dans `instructions`. Des noms génériques
  comme `heartbeat` ou `hot_files` ne coûtent rien tant que le texte d'instructions les nomme.
- ⚠️ **Le mécanisme est spécifique à Claude Code / à l'API Anthropic.** Tient, mais la
  contre-attaque du premier tour (« `instructions` est standard, donc portable ») est **à moitié
  fausse** et doit être retirée sous cette forme. La spec MCP `2025-11-25` ne dit qu'*« Optional
  instructions for the client »* : aucun client n'est **obligé** de l'injecter. C'est standard à
  écrire, pas garanti à lire. L'argument correct est plus modeste : `instructions` est le seul des
  trois leviers qui ne coûte rien à un client qui l'ignore, alors qu'`alwaysLoad` est une clé de
  config purement Claude Code et le renommage BM25 une optimisation pour un seul moteur.
- ✅ **C'est du comportement mouvant.** Tient, et impose une conséquence de rédaction : le texte
  d'`instructions` ne doit décrire **aucune** heuristique de version de Claude Code (ni seuils,
  ni `auto:N`, ni noms d'outils clients). Il ne parle que du domaine du coordinateur, donc il ne
  périme pas quand Anthropic bouge.
- ✅ **YAGNI sur la partie API.** Tient sans réserve. `defer_loading`, regex/BM25, `limit`,
  `tool_reference` sont du contexte : mcp-coordinator est un serveur, il n'envoie pas de catalogue
  d'outils à l'API. §1 et §2 restent utiles à lire, elles ne sont pas une surface d'intégration.
- ✅ **Le vrai correctif tient peut-être en deux lignes.** Confirmé par (D), avec la nuance de
  forme : c'est un second argument au constructeur, pas une clé dans le premier.
- ❌ **« Le tool search a cassé le workflow d'annonce » — le postulat de §4 et de la synthèse §4.**
  Tombe. Le run (C) le réfute directement : sans tool search, 26 schémas en contexte, l'agent
  n'annonce pas davantage. Le tool search n'a rien cassé ; il a rendu visible qu'il n'y a jamais
  eu de contrainte. **Reclasser cette fiche de « menace » vers « opportunité ».**
- ➕ **La vraie menace est ailleurs, et cette fiche ne la traite pas.** Ce que l'expérience
  démontre, c'est que la promesse « les conflits sont détectés avant qu'une ligne soit écrite »
  repose entièrement sur la bonne volonté du modèle. `instructions` améliore fortement cette bonne
  volonté (0/3 → 2/2) mais ne la contraint pas. La contrainte structurelle est le sujet de
  [`C01`](C01-hook-mcp-tool-gate.md) (hook `PreToolUse`) et de [`F02`](F02-canusetool-distributed-lock.md).
  `C06` livre un plancher, pas une garantie — et ne doit pas être vendu comme telle.
- ➕ **Le texte d'`instructions` est un artefact à maintenir, injecté chez tous les utilisateurs.**
  ~1 Ko dans chaque session de chaque utilisateur, à vie, plafonné à 2 Ko. Il énumère des noms
  d'outils en dur : il dérivera si un outil est renommé. Le dépôt a déjà trois textes de ce genre
  (`CLAUDE_MD_TEMPLATE` dans `cli/init.ts`, `INSTRUCTIONS` dans `cli/channel.ts`,
  `docs/operating-modes.md`) — c'est un quatrième.
- ➕ **Effet de bord observé : `register_agent` avec un `agent_id` inventé.** Dans les runs (D),
  l'agent s'est auto-attribué `claude-t2-rename`, un identifiant qu'il a fabriqué. Le texte
  d'instructions crée donc des lignes dans le registre à chaque session, avec des identifiants non
  contrôlés. À arbitrer avec [`C13`](C13-agent-roster-reconciliation.md).
- ➕ **`docs/operating-modes.md:47` est factuellement faux et le reste après le correctif.**
  « That's it. Claude now has all 26 tools available » — le run (B) montre 0 outil MCP à l'init.
  Vrai seulement avec `alwaysLoad: true` ou `ENABLE_TOOL_SEARCH=false`.
- ➕ **Le correctif perd la course sur les tâches courtes.** 0/3 quand l'agent écrit en moins de
  ~10 s. `instructions` seul est un correctif **conditionnel**, et cette condition doit être écrite
  dans la fiche produit, pas découverte par un utilisateur. La refermer coûte
  `MCP_CONNECTION_NONBLOCKING=0`, c'est-à-dire un démarrage de session bloquant pour **tous** les
  serveurs MCP de l'utilisateur — un coût qui n'est pas le nôtre à payer et qu'on ne peut que
  documenter.
- ➕ **On ne peut pas éteindre `instructions`, alors qu'on reproche à `alwaysLoad` d'être chez
  l'utilisateur.** Le texte part chez tout le monde, dans toutes les sessions, y compris celles qui
  ne toucheront jamais une ligne de code. Un interrupteur côté opérateur
  (`COORDINATOR_MCP_INSTRUCTIONS=off`) est le minimum de cohérence.
- ➕ **Le texte amplifie deux défauts réels du registre.** Vérifiés ici : `register_agent` publie
  un `{"status":"online"}` **retenu** que `publishAgentOffline()` — sans aucun appelant en
  production — ne retire jamais ; et les `agent_id` sont **globalement uniques**, donc un agent qui
  s'auto-nomme peut échouer durement sur collision à l'étape même qu'on déclare obligatoire.
  Prescrire `register_agent` à chaque session multiplie les deux.
- ➕ **`post_to_thread` est ambigu dans la configuration push que la doc prescrit.**
  `docs/operating-modes.md` recommande le daemon **et** `cli/channel.ts` côte à côte ; les deux
  exposent `post_to_thread`. Or A3 montre que l'agent résout les outils en `select:` sur les noms
  **littéraux** de l'`instructions`. Le namespacing, écarté ici, n'est donc pas indépendant de
  cette décision — il redevient nécessaire dès qu'on cite un nom ambigu dans le texte.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-15 |
| **Justification** | Voir ci-dessous. 30 sessions `claude -p` headless, matrice à 4 bras, mesure du prefix au token près, puis passage au feu de trois réfutateurs. |
| **Issue / PR** | [#271](https://github.com/swoofer/mcp-coordinator/issues/271) — périmètre en §7.1 / §7.2 |
| **Jalon visé** | prochaine mineure |

### 7.1 Ce qui est retenu

1. **Écrire un champ `instructions` dans `createMcpServer()`** — `src/server-setup.ts`, en
   **second argument** du constructeur (`ServerOptions`, pas `Implementation`), ≤ 2 Ko, sur le
   gabarit de `cli/channel.ts:318`. Contenu : ce que le serveur couvre, **quand** chercher ses
   outils, et l'obligation d'annonce. Aucune heuristique de version de Claude Code dans le texte.
2. **Un test de cohérence `instructions` ↔ `tools/list`** : tout nom d'outil cité dans le texte doit
   exister. C'est le seul garde-fou contre la dérive, et le dépôt a déjà perdu ce pari deux fois
   (`audit/09-protocole-mcp.md` : un outil `introspection` documenté qui n'a jamais existé, un
   compte « 23 outils » faux). `createMcpServer()` n'a aujourd'hui **aucune** couverture.
3. **Une 4ᵉ étape à la checklist `docs/ARCHITECTURE.md:287-298`** : « si l'outil appartient au
   workflow d'annonce, mettre à jour `instructions` ».
4. **Un interrupteur opérateur** (`COORDINATOR_MCP_INSTRUCTIONS=off`), par cohérence avec le
   reproche fait à `alwaysLoad` d'être hors de notre contrôle.
5. **Documenter `MCP_CONNECTION_NONBLOCKING=0`** — et **pas** `alwaysLoad` — comme la façon de
   fermer la course de connexion, avec ses deux coûts nommés : **+678 tokens** et un démarrage de
   session bloquant pour tous les serveurs MCP de l'utilisateur.
6. **Corriger `docs/operating-modes.md:47`** (« Claude now has all 26 tools available » — faux par
   défaut) et la formulation « 26 outils MCP » partout où elle sous-entend un chargement au
   démarrage.

### 7.2 Ce qui est écarté, et pourquoi

- **Le renommage / namespacing des 26 outils** — réfuté par la mesure : en A3, l'agent résout les
  outils via `ToolSearch` en mode `select:` sur les noms **littéraux** lus dans `instructions`.
  Le matching BM25 n'a jamais été le maillon faible. Breaking change de surface publique pour un
  gain nul. *Réserve nommée :* `post_to_thread` est ambigu dans la configuration push à deux
  serveurs — à traiter le jour où l'`instructions` cite ce nom, ou dans `C03`/`C05`.
- **L'enrichissement BM25 des descriptions** — réfuté deux fois : différées, elles ne sont pas lues
  au premier tour (A4 : 0/3) ; **chargées**, elles ne déclenchent rien non plus (A5 : 0/3).
- **`alwaysLoad`, sous toutes ses formes** (config client et `_meta` serveur) — réfuté par A5 à
  armes égales, et dominé par `MCP_CONNECTION_NONBLOCKING=0` d'un facteur 8,3 en tokens quand il
  s'agit de fermer la course. La migration `server.tool()` → `registerTool()` reste une dette SDK
  réelle (les 7 surcharges sont `@deprecated` en 1.30, aucun lint ne le signale) mais elle est
  **découplée** de cette fiche : elle ne sert pas `alwaysLoad`, qui ne sert à rien ici. À porter
  dans `A06` **en y ajoutant ce périmètre**, qui n'y figure pas aujourd'hui.
- **Toute la moitié API** (`defer_loading`, regex/BM25, `limit`, `tool_reference`) — YAGNI confirmé :
  mcp-coordinator est un serveur, il n'envoie pas de catalogue d'outils à l'API.
- **Les checks `doctor`** — rien à détecter côté client qui soit actionnable, et ça engagerait le
  projet à suivre les paliers de version de Claude Code.

### 7.3 Le recadrage, qui est le vrai résultat de ce challenge

**Cette fiche n'est pas une menace, et la synthèse se trompe sur ce point.**
`00-SYNTHESE.md` §4 la classe parmi les « régressions possibles en production aujourd'hui » :
*« Le tool search a peut-être déjà cassé le workflow d'annonce. »* La mesure dit le contraire.
Avec `ENABLE_TOOL_SEARCH=false`, 26 schémas pleinement en contexte, serveur `connected` :
l'agent édite sans annoncer. **Le workflow ne marchait pas non plus avant.** Le tool search n'a
rien cassé — il a rendu visible qu'il n'y a jamais eu de contrainte. Ce que `C06` livre n'est donc
pas la réparation d'une régression, c'est **une capacité comportementale neuve**, et c'est à ce
titre qu'il faut en peser le coût permanent.

Deux conséquences :

- **`C06` est un plancher, pas une garantie.** 5/5 sur tâche exploratoire, **0/3** sur tâche
  d'écriture immédiate. Le README ne peut pas s'appuyer là-dessus pour promettre que « les conflits
  sont détectés avant qu'une ligne soit écrite ». La contrainte structurelle reste le sujet de
  [`C01`](C01-hook-mcp-tool-gate.md) et [`F02`](F02-canusetool-distributed-lock.md) — et ce
  challenge **renforce** leur priorité au lieu de la réduire.
- **L'argument commercial « nos 26 outils ne mangent pas votre contexte » est déjà vrai sans nous.**
  Le harnais défère les outils MCP par défaut : les 5 334 tokens sont déjà à zéro dans une session
  Claude Code standard. Il n'y a rien à revendiquer là.

### 7.4 Ce qui reste ouvert et n'est pas dans le périmètre

Deux défauts du registre, vérifiés pendant ce challenge, que le texte d'`instructions`
**amplifie** sans les créer : le `{"status":"online"}` MQTT **retenu** que
`publishAgentOffline()` — sans appelant en production — ne retire jamais
(`src/mqtt-bridge.ts:259-262` et `:342`), et l'unicité **globale** des `agent_id`
(`src/agent-registry.ts:63`) face à des agents qui s'auto-nomment. Ils appartiennent à
[`C13`](C13-agent-roster-reconciliation.md). À traiter avant, ou en même temps que, la mise en
production du texte — pas après.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : divergence §2 tranchée (noms + `instructions` seuls), `_meta` alwaysLoad ajouté, §5 intact. |
| 2026-08-15 | **Challenge tranché : adopter partiellement.** 30 sessions `claude -p`, matrice à 4 bras (`instructions` × description impérative × `alwaysLoad`). `instructions` : 5/5 sur tâche exploratoire ; le même impératif placé dans une description d'outil : 0/3 différé **et** 0/3 chargé — le canal est la variable, pas le texte. `alwaysLoad` réfuté à armes égales. Course de connexion découverte (0/3 sur écriture immédiate), refermable par `MCP_CONNECTION_NONBLOCKING=0` pour +678 tokens contre +5 641 avec `alwaysLoad`. Coût réel des 26 schémas mesuré : **5 334 tokens** (fiche : « ~10K » — faux ×1,9). **Recadrage : le tool search n'a rien cassé, le workflow ne marchait pas non plus avant — la fiche passe de « menace » à « opportunité », et `C01`/`F02` gagnent en priorité.** Verdict passé au feu de 3 réfutateurs, qui ont invalidé la première version de la conclusion et imposé la moitié des expériences. |
