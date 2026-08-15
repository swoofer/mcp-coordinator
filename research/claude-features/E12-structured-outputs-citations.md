# E12 — Qualité des payloads : strict tools, structured outputs, blocs `search_result`

| Champ | Valeur |
|---|---|
| **ID** | `structured-outputs-citations` |
| **Surface** | claude-api |
| **Statut** | GA (les deux mécanismes). `strict` / `output_config.format` : GA aussi sur Amazon Bedrock et Google Cloud ; sur Microsoft Foundry, support limité aux déploiements « Hosted on Anthropic » |
| **Disponible depuis** | Structured outputs : beta 2025-11-14, GA Claude API 2026-01-29. Blocs `search_result` : GA sur tous les modèles actifs sauf Claude Haiku 3 |
| **Tier** | T2-fort-levier |
| **Nature** | integration |
| **Effort estimé** | M |
| **Confiance veille** | medium (high sur structured outputs, medium sur `search_result` via MCP) |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — pas de credentials API pour tester `strict` |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **Fait central corrigé** — l'issue `anthropics/claude-agent-sdk-python#574` est **fermée** (COMPLETED, 2026-03-24), pas ouverte. Elle a été fermée en référence à la PR #650 (passthrough des blocs MCP non reconnus) ; un commentaire ultérieur signale que la PR n'était pas mergée au moment de la fermeture et décrit un **troisième blocage** non couvert : le CLI `claudecode` bundlé, par lequel le SDK parle à l'API, perd les citations en aval. Le drop reste donc plausible, mais la fiche ne peut plus s'appuyer sur « issue ouverte » comme preuve.
- Statut plateforme corrigé dans l'en-tête : la doc donne `structured outputs` / `strict` **GA sur Amazon Bedrock et Google Cloud** ; seul **Microsoft Foundry** est limité (déploiements « Hosted on Anthropic » uniquement). L'affirmation « beta publique sur Bedrock et Microsoft Foundry » était fausse. *(Le §6.5 étant gelé, il conserve cette formulation périmée — à corriger lors du challenge.)*
- §2 : marqueur `(à vérifier)` sur `mcp_tool_result` tranché en `(non vérifiable — …)`.
- §2 : `client.messages.parse()` existe aussi en TypeScript (avec `zodOutputFormat()` / `jsonSchemaOutputFormat()`), pas seulement en Python.
- §2 : ajout de la règle « citations désactivées par défaut, et tous les `search_result` d'une même requête doivent partager le même réglage ».
- §4 : « 32 occurrences vérifiées » → **21** retours `{type:"text", text: JSON.stringify(...)}` dans `src/tools/*.ts`.
- §5 : `announce_work` l. 36 → **l. 37** ; `check_file_conflict` l. 49 → **l. 50** ; « 12 sorties `JSON.stringify` » dans `consultation-tools.ts` → **8** retours de ce motif (10 `JSON.stringify` au total).

Faits confirmés sans changement : `output_config.format = {type:"json_schema", schema}`, `tools[].strict`, indisponibilité de `strict` sur `mcp_toolset`, absence de header beta (`structured-outputs-2025-11-13` maintenu en transition), cache de grammaire 24 h, schéma complet du bloc `search_result` (`source`/`title`/`content` requis, `citations`/`cache_control` optionnels), texte uniquement, règle du « tout ou rien » dans un `tool_result`, citations obligatoires si le web search tool est actif, GA sur tous les modèles actifs sauf Claude Haiku 3. Tous les fichiers cités en §5 existent, ainsi que `consultation-tools.ts` l. 122-125 et `cli/channel.ts` l. 340.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
La moitié « citations » se teste ici : on peut faire renvoyer au serveur MCP local un bloc `search_result` bien formé (via `cli/channel.ts` en stdio, ou le serveur principal) et observer depuis Claude Code si le bloc traverse, est droppé, ou lève une erreur — c'est le test direct de l'issue #574. La moitié « strict » ne se teste pas : elle exige des appels Messages API directs avec credentials Anthropic, ainsi qu'un accès au connecteur MCP distant (`mcp_toolset`) pour vérifier qu'il ignore bien `strict`. La mesure du surcoût de compilation de grammaire tombe dans le même trou.

## 1. Ce que c'est

Deux mécanismes distincts de la Messages API, réunis ici parce qu'ils concernent tous deux la **qualité du payload** échangé entre Claude et un serveur d'outils.

**(1) Sampling contraint par grammaire.** `output_config.format = {type:"json_schema", schema:{...}}` garantit que la réponse texte du modèle respecte un JSON Schema. Symétriquement, `strict: true` sur une définition d'outil garantit que le **nom** de l'outil appelé et ses **inputs** respectent le schéma déclaré — la contrainte s'applique pendant le sampling, donc avant que le serveur ne voie l'appel. La grammaire compilée est mise en cache 24 h : la première requête paie la latence de compilation, et un changement de structure de schéma réinitialise ce cache. La grammaire du mode strict se construit à partir du toolset complet, donc `strict` et `defer_loading` (tool search, cf. A06) composent sans recompilation.

**Limite qui décide de tout ici :** `strict` est disponible sur tous les types d'outils **sauf `mcp_toolset`**. Un agent qui atteint mcp-coordinator via le connecteur MCP ne bénéficie donc d'aucune garantie de forme ; un agent qui déclare les mêmes outils en direct (SDK, pont maison) en bénéficie.

**(2) Blocs `search_result`.** Un type de bloc de contenu qui permet à Claude de citer *votre* contenu avec attribution de source, exactement comme il cite les résultats de recherche web. Deux voies : renvoyé dans le `content` d'un `tool_result` d'outil personnalisé (RAG dynamique), ou fourni directement comme contenu top-level d'un message user. Les citations apparaissent automatiquement sur les blocs de texte qui s'appuient dessus, sans prompting particulier.

## 2. Surface d'API exacte

```
# Sampling contraint
output_config.format = { type: "json_schema", schema: {...} }
tools[].strict = true                      # indisponible sur mcp_toolset
client.messages.parse()                    # helper SDK Python ET TypeScript
zodOutputFormat() / jsonSchemaOutputFormat()   # fabriques de schéma, SDK TypeScript
# aucun header beta requis (l'ancien structured-outputs-2025-11-13 est en transition)

# Bloc de contenu search_result (Messages API, aucun header beta)
{ type: "search_result",
  source: "<url ou identifiant>",           # requis
  title: "<string>",                        # requis
  content: [ { type: "text", text: "..." } ],  # requis, TEXTE uniquement
  citations: { enabled: true },             # optionnel
  cache_control: { type: "ephemeral" } }    # optionnel
```

Contraintes de validation vérifiées :

- Dans un `tool_result`, si **un** bloc est `search_result`, **tous** doivent l'être — sinon erreur de validation. Le texte d'accompagnement doit être glissé dans le `content[]` d'un `search_result`.
- `content[]` n'accepte que des blocs `text` : pas d'image, pas de média.
- Si le web search tool est actif dans la même requête, `citations` doit être activé sur **tous** les blocs `search_result`.
- `citations` est **désactivé par défaut**, et tous les `search_result` d'une même requête doivent partager le même réglage.
- Les blocs `search_result` ne peuvent apparaître que dans des messages **user** (y compris à l'intérieur d'un `tool_result`) ; en message assistant ils sont rejetés.
- Le passage par un `mcp_tool_result` reste **non documenté** *(non vérifiable — la page `search-results` ne mentionne ni MCP ni `mcp_tool_result`)*. L'issue `anthropics/claude-agent-sdk-python#574` documentait un **drop silencieux** des blocs `search_result` par le handler de tool result MCP ; elle a été **fermée le 2026-03-24** en référence à la PR #650 (passthrough des types de blocs non reconnus), mais un commentaire ultérieur conteste la fermeture (PR non mergée à ce moment) et décrit un troisième blocage, en aval : le CLI `claudecode` bundlé par lequel le SDK parle à l'API. Le statut réel de la moitié « citations » de cette fiche est donc **à établir empiriquement**, pas à déduire de l'issue.

## 3. Sources

- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- https://platform.claude.com/docs/en/build-with-claude/search-results
- https://platform.claude.com/docs/en/release-notes/overview

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

*Côté entrée.* Les 26 outils MCP du serveur valident leurs arguments avec zod côté serveur (`src/tools/*.ts`). Cette validation arrive après coup : quand `announce_work` reçoit un `files_to_modify` mal formé ou un `plan` vide, l'agent a déjà brûlé des tokens à mal formuler, et `assessPlanQuality()` (`src/plan-quality.ts`) le rétrograde en mode `discovery`. Avec `strict: true`, la contrainte remonte dans le sampling : le modèle **ne peut pas** produire un appel hors schéma. Le code de validation défensive ne disparaît pas (le serveur reste exposé à des clients non-Claude), mais le taux d'annonces dégradées baisse sans travail de prompting.

*Côté sortie.* Les six fichiers d'outils renvoient tous la même chose : `{ content: [{ type: "text", text: JSON.stringify(x) }] }` (21 occurrences vérifiées dans `src/tools/*.ts`). Or mcp-coordinator produit des **affirmations qui demandent des preuves** : « ce fichier est en conflit » (`src/conflict-detector.ts`), « cette dépendance existe » (`src/dependency-map.ts`), « cet agent a annoncé ceci » (`src/consultation.ts`). En les renvoyant en blocs `search_result` — `source` = chemin de fichier ou id de thread, `title` = nature du conflit — Claude **cite** l'évidence au lieu de l'affirmer. Dans un contexte multi-agents où l'agent doit convaincre son humain d'arrêter d'éditer un fichier, l'attribution vaut plus que la formulation.

*Bénéficiaire concret.* L'utilisateur qui lit le dashboard ou la sortie de son agent et veut savoir *d'où sort* une alerte de conflit, sans relire les logs du coordinateur.

**Risque si on ne fait rien :** aucun risque de rupture. Le coût est un coût d'occasion : les payloads restent des blobs JSON opaques, et la qualité des inputs continue de dépendre du prompting des agents clients.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/tools/consultation-tools.ts` | 11 outils (`announce_work` → `log_action_summary`). Le plus gros gisement : `announce_work` (l. 37) a le schéma d'entrée le plus riche et donc le plus à gagner de `strict` ; les 8 sorties `{type:"text", text: JSON.stringify(...)}` sont candidates à `search_result` (thread comme source citable). |
| `src/tools/files-tools.ts` | `check_file_conflict` (l. 50) renvoie un verdict de conflit en texte brut ; candidat n°1 pour `search_result` avec `source` = `file_path`. |
| `src/tools/dependencies-tools.ts` | `get_blast_radius` / `get_module_info` : réponses factuelles adossées à une carte de dépendances, donc citables par module. |
| `src/tools/agents-tools.ts`, `src/tools/status-tools.ts`, `src/tools/mqtt-tools.ts` | 9 outils restants, mêmes retours `{type:"text"}`. Impact faible côté citations, mais concernés si on change le contrat de sortie globalement. |
| `src/conflict-detector.ts` | Produit les objets `conflicts` persistés en base (`consultation-tools.ts` l. 122-125). C'est la source de vérité qu'il faudrait enrichir d'un `source` / `title` exploitables. |
| `src/announce-workflow.ts` | Orchestration partagée MCP + REST. Tout changement de forme de payload doit passer par ici pour ne pas re-diverger entre les deux transports (le fichier documente déjà que les payloads `thread_opened` MCP et REST diffèrent). |
| `src/plan-quality.ts` | `assessPlanQuality()` compense aujourd'hui l'absence de contrainte à la saisie. `strict` ne le remplace pas (il contraint la forme, pas la qualité sémantique) mais réduit le nombre de plans vides. |
| `src/http/rest-schemas.ts` | 16 schémas zod côté REST. Si on exporte des JSON Schema pour usage `strict` en direct, c'est le point où les deux surfaces doivent rester alignées. |
| `sdk/src/client.ts` | `McpCoordinatorClient` : seul endroit d'où l'on pourrait exposer les schémas d'outils en JSON Schema exportable, pour les agents qui déclarent les outils en direct et veulent `strict` (impossible via `mcp_toolset`). |
| `cli/channel.ts` | Serveur MCP stdio des Channels — enregistre ses outils via `setRequestHandler(ListToolsRequestSchema)` (l. 340) et non `server.tool()`. Surface distincte : toute décision doit être répliquée ici manuellement. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Étant donné que `strict` est indisponible sur `mcp_toolset` et que les blocs `search_result` sont apparemment droppés par le handler de tool result MCP, mcp-coordinator doit-il exporter ses schémas d'outils et ses payloads « citables » via `sdk/src/client.ts` pour les agents en connexion directe — au prix d'un second contrat à maintenir en parallèle des 26 outils MCP — ou rester strictement MCP et considérer ces deux mécanismes comme hors de portée tant qu'ils ne traversent pas le connecteur ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Non exécutable ici : tout ce qui touche `strict` (déclaration directe en Messages API, vérification que `mcp_toolset` l'ignore, mesure de la latence de compilation de grammaire) exige des credentials API Anthropic et un accès au connecteur MCP distant, dont on ne dispose pas sur ce poste.

- [ ] Appeler `check_file_conflict` depuis un vrai client Claude via le connecteur MCP, en faisant renvoyer au serveur un `content[]` contenant un bloc `search_result` bien formé ; observer si le bloc arrive au modèle, est droppé silencieusement, ou déclenche une erreur de validation (test direct de l'issue `claude-agent-sdk-python#574`).
- [ ] Même test via `cli/channel.ts` (stdio) pour savoir si le comportement diffère entre transport HTTP/connecteur et stdio.
- [ ] Vérifier empiriquement qu'un client passant par `mcp_toolset` ignore bien tout `strict` déclaré côté serveur : déclarer un schéma volontairement restrictif sur `announce_work` et tenter un appel hors schéma.
- [ ] Depuis `sdk/src/client.ts`, exporter le JSON Schema de `announce_work` et le déclarer en direct avec `strict: true` dans une requête Messages API ; mesurer le taux de plans rétrogradés par `assessPlanQuality()` avec et sans, sur un échantillon d'annonces.
- [ ] Mesurer le surcoût de latence de la première requête (compilation de grammaire) et vérifier la persistance du cache 24 h sur un schéma stable.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Le chemin d'accès principal est justement celui qui n'en bénéficie pas.** mcp-coordinator est un serveur MCP ; ses utilisateurs arrivent par `mcp_toolset` ou par un client MCP. Or `strict` est explicitement indisponible sur `mcp_toolset`, et les blocs `search_result` sont documentés comme droppés par le handler de tool result MCP. Les deux moitiés de la fiche ne s'appliquent donc, en l'état, qu'à un usage *hors* MCP.
- **Ça pousse à créer un second contrat.** Exposer des schémas JSON Schema depuis le SDK pour contourner la limite `mcp_toolset` revient à maintenir deux définitions des mêmes outils (zod dans `src/tools/*.ts`, JSON Schema exporté dans `sdk/src/`), plus une troisième surface dans `cli/channel.ts`. Le repo a déjà payé ce prix avec la divergence MCP/REST documentée dans `src/announce-workflow.ts`.
- **Casse la portabilité.** Les blocs `search_result` sont un type de contenu propre à la Messages API d'Anthropic. Un serveur MCP censé parler à n'importe quel client (Cline, Zed, un agent maison) qui renverrait des blocs `search_result` produirait du bruit non interprétable ailleurs — sauf à conditionner le format de sortie au client, ce qui est une nouvelle branche à tester.
- **Divergence de statut selon la plateforme.** GA sur la Claude API, mais `strict` / `output_config.format` restent en beta publique sur Bedrock et Microsoft Foundry. Un auto-hébergeur derrière Bedrock n'a pas les mêmes garanties.
- **YAGNI sur les citations.** Personne n'a demandé que les alertes de conflit soient citables. Le bénéfice est réel mais spéculatif ; les 32 retours `{type:"text", text: JSON.stringify(...)}` fonctionnent et sont lisibles.
- **Coût de compilation de grammaire.** Sur 26 outils déclarés, la première requête après tout changement de schéma paie une latence de compilation. Pour un coordinateur dont l'argument est la réactivité (SSE, MQTT, `wait_for_peers`), ce n'est pas neutre et doit être mesuré avant adoption.
- **Contradiction entre chercheurs :** aucune sur les faits. Le seul point non résolu est la compatibilité `search_result` × MCP — un chercheur la donne comme « à vérifier empiriquement, la doc du connecteur ne le dit pas », le vérificateur la donne comme *plus* pessimiste encore (issue upstream ouverte documentant un drop silencieux). La fiche retient la version pessimiste sans la traiter comme définitive.

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
| 2026-08-14 | Vérification des faits : issue #574 fermée (pas ouverte), statut Bedrock corrigé, 3 numéros de ligne rectifiés. |
