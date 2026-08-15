# A09 — Organiser 26 outils : extensions, primitive grouping, skills-over-MCP

| Champ | Valeur |
|---|---|
| **ID** | `extensions-grouping-skills` |
| **Surface** | mcp-spec |
| **Statut** | mixte — framework d'extensions **GA** (2026-07-28), Primitive Grouping IG **experimental**, Skills Over MCP / SEP-2640 **experimental (In Review)** |
| **Disponible depuis** | Extensions : spec `2026-07-28` (SEP-2133) · Grouping IG : charte 2026-06-18 · Skills Over MCP : IG 2026-02-01 → WG 2026-04-16 |
| **Tier** | T2-fort-levier |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — PoC local oui, aucun client ne négocie `extensions` |
| **Statut du challenge** | ✅ **tranché** (2026-08-15) — `refuser` (a) et (b), `adopter partiellement` (c) |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §1(a) — les repos `experimental-ext-*` sont rattachés à « a Working Group **or Interest Group** », pas seulement à un WG (source : `docs/extensions/overview`, section *Experimental Extensions*).
- §2 — marqueur **(à vérifier)** sur la règle de réservation : **tranché**. La règle canonique est celle des clés `_meta` (`specification/draft/basic/index#meta`) : « Any prefix where the second label is `modelcontextprotocol` or `mcp` is **reserved** ». Les deux formulations du bundle disaient la même chose : `com.mcp.tools/` est réservé *parce que* son second label est `mcp`, et `com.example.mcp/` ne l'est pas. Les deux identifiants candidats de la fiche (`dev.swoofer.coordinator/coordination`, `io.github.swoofer/coordination`) ont pour second label `swoofer` et `github` — aucun n'est réservé, les deux sont valides.
- §2 — marqueur **(à vérifier)** sur le schéma de l'objet `extensions` : **tranché**. La doc dit littéralement « Each extension specifies the schema of its settings object; an empty object indicates no settings » — la fiche avait juste.
- §2 — marqueur **(à vérifier)** sur le SDK TypeScript : **tranché par lecture des types installés**, pas par la doc. `node_modules/@modelcontextprotocol/sdk` est en **1.30.0** (et non 1.29.0 ; `package.json` déclare `^1.29.0`). `dist/esm/types.d.ts` porte `extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>` à la fois dans `ClientCapabilitiesSchema` (l. 614) et dans `ServerCapabilitiesSchema` (l. 811). Le champ est donc bien exposé par la version installée. Aucune méthode SDK dédiée n'existe : c'est un champ de l'objet `capabilities`, pas une API.
- §2 — ajout du fait que `docs/approaches.md` du repo `experimental-ext-grouping` est aujourd'hui un **stub** (273 octets, uniquement la barre de navigation). Le contenu comparatif des trois stratégies n'y est pas encore rédigé.
- §5 — la mention « le support de `ServerCapabilities.extensions` dans la version du SDK installée est à vérifier » est remplacée par le fait établi ci-dessus.

**Faits re-confirmés sans changement** (contrôlés un par un) : statut GA du framework d'extensions dans la spec `2026-07-28` (changelog, *Minor changes* §1 : « Add `extensions` field to `ClientCapabilities` and `ServerCapabilities` ») ; SEP-2133 comme SEP de référence ; `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` côté client et `capabilities.extensions` dans la réponse `server/discover` côté serveur (exemples JSON verbatim dans la doc) ; « Extensions are always disabled by default » ; charte Primitive Grouping du 2026-06-18, statut *Active Exploration*, facilitateurs University of Washington + GitHub, trois stratégies `grouping` / `tool-search` / `code-mode`, livrable « MCP Grouping Convention v0.1 » au statut *Proposed*, canal `#primitive-grouping-ig` ; Skills Over MCP converti IG→WG le 2026-04-16 (IG formée le 2026-02-01), leads Nordstrom + Core Maintainer Anthropic, SEP-2640 « Skills Extension » **PR ouverte, statut In Review** au 2026-08-11, Resources-based, Extensions Track, proposition `skills.json` côté Registry *In Progress*, origine SEP-2076. Côté repo : 26 outils exactement (4/11/3/3/3/2), 39 722 octets de `src/tools/*.ts`, `src/server-setup.ts` l. 226-249 conforme, `cli/channel.ts` l. 298-320 conforme, aucune Resource MCP nulle part dans `src/`, `cli/`, `sdk/src/`.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle

Trois des cinq points du protocole se lancent tels quels ici : mesurer le préambule `tools/list` sur les deux transports, lire les types du SDK (déjà fait — le champ existe), et monter un PoC `resources/list` + `resources/read` servant un `SKILL.md`. Ce qui ne se teste pas : **observer un vrai client négocier l'extension**. La matrice officielle `extensions/client-matrix` ne recense que trois extensions officielles et **ne liste pas Claude Code** ; aucun client documenté n'implémente aujourd'hui la négociation `extensions` pour une extension tierce. On peut donc mesurer le coût et prototyper le serveur, mais pas prouver end-to-end qu'un opt-in par extension fonctionne — ni tester la portabilité vers un agent non-Claude, faute d'un second client MCP sous la main. Le point 5 (lire `docs/approaches.md`) est également bloqué en l'état : le fichier est un stub sans contenu.

---

## 1. Ce que c'est

Trois briques de la spec MCP qui attaquent le même problème : un serveur qui expose une liste plate d'outils sature le contexte du modèle et dégrade sa sélection.

**(a) Le framework d'extensions** est GA depuis la spec `2026-07-28` (SEP-2133). Il formalise un mécanisme de capacités hors du cœur du protocole : une extension porte un identifiant en DNS inverse `{préfixe-vendeur}/{nom}` (ex. `io.modelcontextprotocol/tasks`), déclare le schéma de son objet de réglages, et est **toujours désactivée par défaut** — l'activation exige un opt-in explicite. La négociation passe par un champ `extensions` ajouté à `ClientCapabilities` et `ServerCapabilities`. Les extensions officielles vivent dans des repos `ext-*` de l'org GitHub, les incubations dans des `experimental-ext-*` rattachés à un Working Group **ou à un Interest Group**.

**(b) Le Primitive Grouping Interest Group** (statut « Active Exploration », facilitateurs University of Washington + GitHub) explore comment organiser Tools, Resources, Prompts et Tasks au-delà des listes plates. Il documente nommément trois maux : surcharge de contexte, opérations inefficaces (tokens, coût, latence), mauvaise expérience développeur. Il ne tranche volontairement pas : il maintient des extensions de référence pour **trois stratégies concurrentes** — `grouping`, `tool-search`, `code-mode` — et remonte des recommandations vers le processus SEP. Son livrable « MCP Grouping Convention v0.1 » est au statut *Proposed* et reste une convention, pas une spec.

**(c) Le Skills Over MCP Working Group** (leads Nordstrom + un Core Maintainer Anthropic) pousse SEP-2640 : une extension qui expose des *skills* via la primitive **Resources** existante, alignée sur la spec ouverte Agent Skills (format `SKILL.md` + dossier `references/`, découverte par URI well-known), avec une proposition `skills.json` côté MCP Registry. Autrement dit : sortir la doctrine d'usage des descriptions d'outils et la servir comme ressource chargée à la demande.

## 2. Surface d'API exacte

```
# (a) Extensions — GA, spec 2026-07-28 (SEP-2133)
ClientCapabilities.extensions
ServerCapabilities.extensions
_meta["io.modelcontextprotocol/clientCapabilities"].extensions   # annoncé par le client à chaque requête
capabilities                                                      # retourné par server/discover
{vendor-prefix}/{extension-name}                                  # format d'identifiant, DNS inverse

# (b) Primitive Grouping IG — experimental
repo modelcontextprotocol/experimental-ext-grouping  (docs/approaches.md — stub, 273 o, nav seule au 2026-08-14)
stratégies : grouping | tool-search | code-mode
livrable « MCP Grouping Convention v0.1 » (Proposed)
canal Discord #primitive-grouping-ig

# (c) Skills Over MCP — SEP-2640, Extensions Track, In Review
resources/list + resources/read        # représentation des skills
SKILL.md + references/                 # format (spec Agent Skills, agentskills.io)
skills.json                            # proposition côté MCP Registry
repo modelcontextprotocol/experimental-ext-skills ; origine SEP-2076
```

Contrainte de nommage **(vérifiée 2026-08-14)** : un identifiant d'extension suit les mêmes règles qu'une clé `_meta`, préfixe obligatoire. La règle normative (`specification/draft/basic/index#meta`) est : « Any prefix where the second label is `modelcontextprotocol` or `mcp` is **reserved** for MCP use ». Les motifs `com.mcp.tools/` et `dev.mcp/` sont donc réservés — non par un motif spécial, mais parce que leur second label est `mcp` ; `com.example.mcp/` ne l'est pas. Un tiers doit utiliser son propre domaine inversé. Les deux identifiants candidats pour ce projet, `dev.swoofer.coordinator/coordination` et `io.github.swoofer/coordination`, ont pour second label `swoofer` et `github` : **aucun n'est réservé, les deux sont valides**.

Schéma de l'objet `extensions` **(vérifié 2026-08-14)** : clé = identifiant d'extension, valeur = objet de réglages défini par l'extension elle-même — « Each extension specifies the schema of its settings object; an empty object indicates no settings ». Côté SDK TypeScript, **il n'existe aucune méthode dédiée** : `extensions` est un champ optionnel de l'objet `capabilities`. La version réellement installée dans ce repo (`@modelcontextprotocol/sdk` **1.30.0**, résolue depuis `^1.29.0`) l'expose déjà dans `dist/esm/types.d.ts`, dans `ClientCapabilitiesSchema` (l. 614) et `ServerCapabilitiesSchema` (l. 811) :

```ts
extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<object, object>>>;
```

## 3. Sources

- https://modelcontextprotocol.io/docs/extensions/overview
- https://modelcontextprotocol.io/specification/2026-07-28/changelog
- https://modelcontextprotocol.io/extensions/client-matrix
- https://modelcontextprotocol.io/community/interest-groups/primitive-grouping.md
- https://github.com/modelcontextprotocol/experimental-ext-grouping
- https://modelcontextprotocol.io/community/working-groups/skills-over-mcp.md
- https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640
- https://github.com/modelcontextprotocol/experimental-ext-skills
- https://modelcontextprotocol.io/docs/2026-07-28/develop/build-with-agent-skills.md

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**

Le serveur expose aujourd'hui exactement 26 outils, répartis en 6 familles (`agents` 4, `consultation` 11, `dependencies` 3, `files` 3, `mqtt` 3, `status` 2), tous enregistrés à plat dans `createMcpServer()`. Les fichiers `src/tools/*.ts` pèsent ~39,7 Ko dont une bonne part est du texte envoyé au modèle : descriptions d'outils et `.describe()` Zod sur chaque paramètre. Ce texte est chargé **à chaque session, intégralement**, y compris pour un agent qui ne fera qu'un `announce_work` puis un `heartbeat`.

Trois gains concrets, dans l'ordre de maturité :

1. **Extensions (GA)** — c'est la voie officielle pour qu'un client négocie « je veux la coordination multi-agents » plutôt que de deviner à partir de 26 noms d'outils. Le repo a déjà un précédent : `cli/channel.ts` déclare `capabilities.experimental["claude/channel"]` en dur pour se faire reconnaître par l'hôte Channels. Le framework d'extensions remplacerait ce bricolage par un mécanisme spécifié, et donnerait un chemin de graduation vers la spec si la coordination multi-agents intéresse au-delà du projet.
2. **Grouping IG (experimental)** — l'IG cherche explicitement des retours de mainteneurs de gros serveurs MCP. Le découpage en 6 familles déjà réalisé fait de ce projet un cas d'usage prêt à l'emploi. Intérêt tactique : le *tool search* (traité dans d'autres fiches) n'est **qu'une des trois stratégies en lice**. Bâtir toute la stratégie de réduction de surface sur le tool search revient à parier sur un cheval avant l'arrivée.
3. **Skills over MCP (experimental)** — la doctrine de coordination (quand annoncer, comment lire un rapport de conflit, comment mener une consultation jusqu'à `approve_resolution`) vit aujourd'hui dispersée entre les descriptions d'outils, `docs/ARCHITECTURE.md` et `docs/usage.md`. La servir comme skills via `resources/list` / `resources/read` la rendrait chargeable à la demande, et **portable vers les agents non-Claude** — ce que ni les Claude Code Skills ni les Agent Skills de la Messages API ne permettent.

Utilisateur qui en profite : l'auto-hébergeur qui branche un essaim de 5+ agents et paie le préambule de 26 outils sur chaque session ; et tout intégrateur non-Claude Code qui doit aujourd'hui lire la doc pour comprendre le protocole d'annonce.

**Risque si on ne fait rien :** faible à court terme, réel à moyen terme. Le serveur reste une liste plate de 26 outils au moment où la spec se dote d'un mécanisme officiel de structuration. Si la Grouping Convention se stabilise et que les clients l'implémentent, un serveur non conforme sera pénalisé à la sélection d'outils. Second risque, spécifique : `cli/channel.ts` s'appuie sur `capabilities.experimental["claude/channel"]`, une clé non spécifiée ; le framework d'extensions étant désormais GA, cette clé est un candidat naturel à la dépréciation côté hôte.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/server-setup.ts` (l. 226-249) | Construction de `new McpServer({ name: "io.github.swoofer/mcp-coordinator", version })` — aucun objet `capabilities` ni `instructions` n'est passé aujourd'hui. C'est le point unique où déclarer `ServerCapabilities.extensions`. Les 6 appels `register*Tools` y sont chaînés : c'est aussi le point où conditionner un groupe d'outils à l'opt-in d'une extension. |
| `src/tools/consultation-tools.ts` | 11 outils sur 26, 18 Ko — la famille la plus lourde (`announce_work`, `post_to_thread`, `propose_resolution`, `approve_resolution`, `contest_resolution`, `close_thread`, `cancel_thread`, `get_thread`, `get_thread_updates`, `list_threads`, `log_action_summary`). Premier candidat au groupement et au déport de doctrine vers une skill. |
| `src/tools/agents-tools.ts` | 4 outils (`register_agent`, `list_agents`, `heartbeat`, `agent_activity`). Famille noyau : à garder toujours chargée quelle que soit la stratégie retenue. |
| `src/tools/files-tools.ts`, `src/tools/dependencies-tools.ts`, `src/tools/mqtt-tools.ts`, `src/tools/status-tools.ts` | 3+3+3+2 outils. Familles périphériques, candidates au chargement conditionnel / à la mise derrière une extension opt-in. |
| `cli/channel.ts` (l. 298-320) | Déclare déjà `capabilities: { experimental: { "claude/channel": {}, tools: {} }, tools: {} }` avec un commentaire assumant le caractère expérimental. Précédent direct de négociation par capability, et premier code à migrer si `extensions` remplace `experimental`. |
| `src/index.ts` / `src/serve-http.ts` | Les deux transports (stdio et HTTP) instancient le serveur via `createMcpServer()`. Toute négociation d'extension doit être vérifiée sur les deux chemins, pas seulement stdio. |
| `package.json` | `mcpName: "io.github.swoofer/mcp-coordinator"`, SDK `@modelcontextprotocol/sdk ^1.29.0`. Le préfixe d'extension doit rester cohérent avec `mcpName`. **Vérifié 2026-08-14** : la version résolue dans `node_modules` est **1.30.0** et expose déjà `extensions` dans `ClientCapabilitiesSchema` et `ServerCapabilitiesSchema` — pas de bump de SDK requis. |
| `sdk/src/client.ts` | Client TypeScript maison. Si des skills sont servies via `resources/read`, il faut décider s'il les expose ou les ignore. |
| `docs/ARCHITECTURE.md`, `docs/usage.md` | Contiennent la doctrine de coordination en prose. Source de contenu directe pour des `SKILL.md`, et à mettre à jour si la surface d'outils change. |
| `src/announce-workflow.ts`, `src/conflict-detector.ts`, `src/consultation.ts` | Portent la logique dont la doctrine décrit l'usage. Aucune modification de comportement attendue : le déport concerne le texte explicatif, pas le code. |

Vérification négative utile : `grep` sur `registerResource` / `resources/list` / `ResourceTemplate` dans `src/` et `cli/` ne retourne **rien**. Le serveur n'expose aujourd'hui aucune Resource MCP — servir des skills via Resources est donc un ajout net de primitive, pas une extension d'un existant.

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Faut-il parier sur une seule stratégie de réduction de surface (le tool search), ou déclarer une extension `{préfixe}/coordination` qui gate les 3 familles périphériques (`files`, `dependencies`, `mqtt` = 9 outils sur 26) derrière un opt-in, en gardant `agents` + `consultation` toujours chargées et en déportant la doctrine d'annonce vers une skill servie par `resources/read` ?

### 6.2 Hypothèse

> Pré-enregistrée le 2026-08-15, **avant** toute exécution.

**Hypothèse.** Les trois volets s'effondrent pour trois raisons différentes, et le volet (a) —
le seul GA — s'effondre sur une mesure déjà faite ailleurs :

- **(a) Extensions.** Le bénéfice annoncé est le contexte économisé en gatant 9 outils sur 26.
  Or [`C06`](C06-tool-search-defer-loading.md) a mesuré le 2026-08-15 que Claude Code **diffère déjà
  les 26 schémas** : le préambule est **à zéro** dans une session standard. Gater 9 outils
  économiserait donc une fraction d'un nombre déjà nul, au prix d'un opt-in que personne ne sait
  émettre. Je m'attends à ce que déclarer `capabilities.extensions` soit *ignoré silencieusement*
  par Claude Code 2.1.233 (qui négocie `2025-11-25` sur le fil, mesuré en §2 de la synthèse).
- **(b) Grouping IG.** Trois stratégies concurrentes, un livrable *Proposed*, un `docs/approaches.md`
  stub. Rien à implémenter ; au mieux une contribution de retour d'expérience.
- **(c) Skills over MCP.** `C06` a déjà tranché que la surface de découverte qui marche est le champ
  **`instructions`** du serveur (5/5). Une skill servie par `resources/read` ne bat `instructions`
  que si le client la charge **spontanément**. Je m'attends à ce que Claude Code exige un
  `@`-mention explicite de l'humain — auquel cas la skill n'est jamais lue par un agent d'essaim,
  et le volet est mort.

**Verdict attendu :** `refuser` sur (a) et (b), `refuser` ou `reporter` sur (c).

**Critères de refus, chiffrés (pré-enregistrés) :**

| # | Volet | Le résultat qui tue |
|---|---|---|
| K1 | (a) | Le préambule mesuré des 9 outils périphériques (`files`+`dependencies`+`mqtt`) est **< 2 500 tokens**, ou son coût réel dans une session Claude Code est **0** parce que le harnais défère déjà. |
| K2 | (a) | Claude Code 2.1.233 **n'émet aucun** `ClientCapabilities.extensions` sur le fil → l'opt-in est inobservable, donc le gate ne peut jamais s'ouvrir. |
| K3 | (a) | Gater les 9 outils casse un consommateur existant sans opt-in : `sdk/src/client.ts`, les routes REST, l'essaim, ou les tests. Si ≥ 1 casse, l'opt-in est une régression, pas une option. |
| K4 | (c) | Claude Code ne charge **pas** spontanément une ressource MCP dans le contexte de l'agent (0/3 sur une tâche où la ressource contiendrait la réponse) → la skill ne bat pas `instructions`, déjà adopté par `C06`. |
| K5 | (c) | Ajouter `registerResource` fait apparaître une régression sur un client qui n'attend aucune Resource (erreur `-32601`, capability fantôme façon `A04`), ou impose un chemin d'org-scoping neuf non couvert par les tests. |
| K6 | tous | L'effort réel dépasse **10 fichiers touchés** pour un bénéfice non mesurable en tokens dans une session Claude Code réelle. |

**Critère d'adoption (ce qu'il faudrait pour dire oui) :** au moins un client qui **émet** un
opt-in `extensions` observable sur le fil, **ou** une ressource `SKILL.md` que l'agent lit sans
qu'un humain la mentionne — et un gain de contexte mesuré > 0 dans une session réelle.

### 6.3 Protocole de vérification

> Ce que la §0 déclarait non exécutable : « observer un vrai client négocier l'extension ».
> Un client **qui ne négocie pas** est un résultat mesurable — un proxy d'écoute sur le fil le
> montre. Ce qui reste vraiment hors de portée : prouver end-to-end qu'un opt-in *fonctionne*
> (il faudrait un client qui l'implémente), et tester un second client MCP non-Claude.

- [x] **P1 — Coût réel, famille par famille.** Capturer la réponse `tools/list` complète (stdio et
      HTTP) et compter les tokens du préambule des 26 outils par famille. Sans ce chiffre, K1 est
      indécidable.
- [x] **P2 — Types du SDK.** Déjà tranché en §0 (1.30.0 expose `extensions` dans les deux schémas).
      Re-vérifier seulement si `McpServer` accepte de le **transporter** jusqu'au fil.
- [x] **P3 — Le fil.** Rejouer une session Claude Code 2.1.233 à travers un proxy d'écoute, contre
      un daemon qui déclare `capabilities.extensions` : le client émet-il un `extensions` en retour,
      erreur-t-il, ou l'ignore-t-il ?
- [x] **P4 — PoC skill.** Exposer un `SKILL.md` « protocole d'annonce » via `resources/list` +
      `resources/read` et mesurer si Claude Code le lit **sans** `@`-mention humain (K4), et si sa
      seule présence casse un client qui n'attend aucune Resource (K5).
- [x] **P5 — Faisabilité du gate.** Vérifier dans le code si `createMcpServer()` peut seulement
      *décider* par client : à quel moment les `register*Tools` sont appelés par rapport à
      `initialize`, sur les deux transports.
- [x] **P6 — Doc.** Re-fetcher aujourd'hui `extensions/client-matrix`, `docs/approaches.md` du repo
      `experimental-ext-grouping` et le statut de SEP-2640.

### 6.4 Résultat observé

> Exécuté le 2026-08-15. **Frontière exécuté / lu :** tout ce qui suit sous (A) à (F) a été
> *exécuté* contre un daemon réel et Claude Code **2.1.233** installé sur ce poste. (G) est de la
> preuve *documentaire* fetchée aujourd'hui. Ce qui n'a **pas** été exécuté est nommé en (H).

#### (A) P1 — Le préambule des 26 outils, famille par famille

`tools/list` capturé sur le vrai daemon en stdio (`node dist/src/index.js`, `initialize`
`2025-11-25` puis `tools/list`). Les 26 outils sont bien là, aucun non classé :

```
┌─────────┬────────────────┬────────┬────────┬────────────┬───────────┐
│ (index) │ famille        │ outils │ octets │ tokens_est │ manquants │
├─────────┼────────────────┼────────┼────────┼────────────┼───────────┤
│ 0       │ 'agents'       │ 4      │ 2068   │ 827        │ '-'       │
│ 1       │ 'consultation' │ 11     │ 8429   │ 3372       │ '-'       │
│ 2       │ 'files'        │ 3      │ 1369   │ 548        │ '-'       │
│ 3       │ 'dependencies' │ 3      │ 1422   │ 569        │ '-'       │
│ 4       │ 'status'       │ 2      │ 1047   │ 419        │ '-'       │
│ 5       │ 'mqtt'         │ 3      │ 2321   │ 928        │ '-'       │
└─────────┴────────────────┴────────┴────────┴────────────┴───────────┘
TOTAL 26 outils, 16656 octets
PERIPHERIQUES (files+dependencies+mqtt) = 9 outils, 5112 octets = 30.7% du preambule
Noms non classes: aucun
Total outils dans tools/list: 26
```

**Conversion en tokens — la méthode honnête.** La colonne `tokens_est` applique la densité
2,5 o/tok de [`C06`](C06-tool-search-defer-loading.md) et donne un total de 6 662, soit **+25 %
au-dessus** des **5 334 tokens réellement mesurés** par `C06` (différence de prefix entre deux
configurations Claude Code). L'écart s'explique : le JSON brut de `tools/list` contient des champs
(`$schema`, `execution`, `annotations`) que le harnais ne réémet pas tels quels. La colonne
absolue est donc **fausse par excès** ; ce qui est solide, c'est la **part** :

> **9 outils périphériques = 30,7 % du préambule → 0,307 × 5 334 = ~1 640 tokens.**

**K1 → déclenché**, et deux fois plutôt qu'une : 1 640 < 2 500 (seuil pré-enregistré), et surtout
`C06` a mesuré que dans une session Claude Code standard **les 26 schémas sont différés, donc
le préambule vaut 0**. Gater 9 outils économiserait 30,7 % de zéro.

#### (B) P2 / P5 — Le SDK transporte bien `extensions`, et le gate est techniquement faisable

PoC stdio (`node_modules/.a09-poc/server.mjs`, SDK 1.30.0) déclarant
`capabilities.extensions` + une Resource. Sondé par un client maison qui **émet** l'opt-in :

```
INIT RESULT: {
 "protocolVersion": "2025-11-25",
 "capabilities": {
  "extensions": { "io.github.swoofer/coordination": {} },
  "resources": { "listChanged": true },
  "tools": { "listChanged": true }
 },
 "serverInfo": { "name": "a09-poc", "version": "0.0.1" }
}
{"ev":"oninitialized","clientCapabilities":{"extensions":{"io.github.swoofer/coordination":{}}},...}
```

Donc : **rien ne bloque côté SDK**. Le champ traverse dans les deux sens sur une connexion d'ère
2025-11-25, et `server.server.getClientCapabilities()` le rend lisible. Faisabilité du gate
confirmée par lecture de types : `oninitialized` (`server/index.d.ts:84`),
`getClientCapabilities()` (`:121`) et `RegisteredTool.disable()` (`mcp.d.ts:276`) existent —
on peut enregistrer les 26 outils puis en désactiver 9 après `initialize`.
**La faisabilité n'est pas le problème.**

#### (C) P3 — Le fil, contre Claude Code 2.1.233 : K2 déclenché

Même PoC branché via `--mcp-config … --strict-mcp-config`. Message `initialize` **brut**,
intercepté avant tout traitement SDK :

```
{"ev":"RAW initialize","params":{"protocolVersion":"2025-11-25",
 "capabilities":{"roots":{"listChanged":true},"elicitation":{}},
 "clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.233",...}}}
{"ev":"oninitialized","clientCapabilities":{"elicitation":{"form":{}},"roots":{"listChanged":true}},...}
```

**Aucun champ `extensions`.** Reproduit à l'identique sur 3 sessions indépendantes (`wire.log`,
`wire2.log`, `wire3.log`). Le serveur, lui, a déclaré `extensions` : **Claude Code s'est connecté
sans erreur et l'a ignoré en silence.** C'est la bonne nouvelle et la mauvaise : déclarer
l'extension ne casse rien, et n'obtient rien.

**K2 → déclenché.** Un gate d'outils derrière cet opt-in ne pourrait **jamais s'ouvrir** avec le
client cible du projet. Ce n'est pas « peu de clients le supportent » : c'est zéro, sur le fil.

#### (D) P4 — Skills over MCP : la Resource est invisible pour le modèle (K4 déclenché)

Trois bras, 3 runs chacun, `claude -p` headless, `--allowedTools
"ListMcpResourcesTool,ReadMcpResourceTool,mcp__a09__a09_ping"`. Question posée :
*« Quel est le code d'autorisation du coordinateur pour cette session ? »* La réponse
(`ZORGLUB-4417`) n'existe qu'à **un seul** endroit selon le bras.

| Bras | Où vit le canari | Résultat | Tours | `resources/read` sur le fil |
|---|---|---|---|---|
| **A** | dans la Resource (`SKILL.md` via `resources/read`) | **0 / 3** | 1, 6, 8 | **0** |
| **B** | dans le champ **`instructions`** du serveur | **3 / 3** | 1, 1, 1 | 0 |
| **C** | `instructions` **pointe vers l'URI** de la Resource | **3 / 3** | 3, 3, 3 | **2 par run** |

Bras A, réponses verbatim :

```
run1: "Je n'ai aucun code d'autorisation de coordinateur — il n'en existe pas pour cette
       session, et je n'en inventerai pas."
run2: "Il n'y en a pas. Aucun « code d'autorisation du coordinateur » n'existe dans cette
       session : ni dans mes instructions, ni dans le serveur MCP `a09` (qui n'expose qu'un
       outil `a09_ping`), ni dans les fichiers du répertoire de travail"
run3: "Rien dans mon contexte (instructions système, serveur MCP `a09` — dont les instructions
       se limitent à « PoC A09. » — ni les fichiers du répertoire de travail)"
```

Le wire log du bras A explique pourquoi, et c'est le résultat le plus net du challenge :

```
{"ev":"RAW tools/list"}
{"ev":"RAW resources/list"}     <-- le CLIENT liste les ressources au demarrage
{"ev":"RAW tools/call"}          <-- run2 : l'agent sonde a09_ping...
{"ev":"tools/call","tool":"a09_ping","msg":"hello"}
                                 <-- ...mais AUCUN resources/read, jamais
```

**Le harnais appelle `resources/list`, l'agent ne voit pas le résultat.** Au run 2, l'agent a
cherché pendant 6 tours, a sondé le serveur avec `a09_ping`, et a conclu qu'il *« n'expose qu'un
outil »* — alors que la Resource était listée sur le fil quelques millisecondes plus tôt.

Bras B et C, résultats verbatim :

```
--- B1 --- RESULT: "ZORGLUB-4417" | turns: 1
--- B2 --- RESULT: "ZORGLUB-4417" | turns: 1
--- B3 --- RESULT: "ZORGLUB-4417" | turns: 1
--- C1 --- RESULT: "ZORGLUB-4417" | turns: 3   resources/read dans le wire: 2
--- C2 --- RESULT: "ZORGLUB-4417" | turns: 3   resources/read dans le wire: 2
--- C3 --- RESULT: "ZORGLUB-4417" | turns: 3   resources/read dans le wire: 2
```

**La conclusion que ce tableau impose : Skills-over-MCP n'est pas un remplaçant d'`instructions`,
c'en est un dépendant.** Le bras C marche — la ressource *est* lue, réellement — mais uniquement
parce qu'`instructions` la nomme. Sans `instructions`, la primitive Resources est un canal mort
côté Claude Code. Et `instructions` est précisément ce que [`C06`](C06-tool-search-defer-loading.md)
a déjà adopté le 2026-08-15.

Corollaire de coût : le bras C paie **2 tours de plus** (3 vs 1) et un aller-retour réseau pour
livrer un contenu que le bras B livre dans le prompt système.

#### (E) K5 — Le coût de la primitive Resources est plus faible que la fiche ne le craint

§6.5 avance qu'un `resources/read` devrait « faire pareil » que les handlers d'outils sur le
scoping `claims.org`, et compte ça comme un coût net. Vérifié par lecture de types : le callback
reçoit le même `extra` que les outils —

```ts
// node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:302
export type ReadResourceCallback = (uri: URL,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => ReadResourceResult | ...
```

`extra.sessionId` est donc disponible, et le patron `getSessionClaims(extra.sessionId)` déjà
utilisé par les 26 outils s'applique tel quel. **K5 ne se déclenche pas sur ce point.** Le PoC
n'a par ailleurs produit aucune régression : Claude Code s'est connecté sans erreur à un serveur
exposant une Resource. (Le piège `-32601` de [`A04`](A04-subscriptions-listen.md) concerne la
déclaration d'une capability *sans* handler ; `registerResource` installe le handler.)

#### (F) K3 — Requalifié, et il faut le dire

K3 tel que pré-enregistré (« gater casse ≥ 1 consommateur existant ») est **partiellement
déclenché seulement**, et l'honnêteté oblige à le noter :

- `sdk/src/*.ts` (10 fichiers) : **0 occurrence** des 9 noms d'outils périphériques — c'est un
  client REST, pas MCP. **Non impacté.**
- `tests/unit/mcp-tool-ergonomics.test.ts` et `mcp-tool-org-scoping.test.ts` appellent
  `register*Tools()` **directement**, pas `createMcpServer()` (`grep -rl createMcpServer tests/`
  → aucun résultat). Un gate posé dans `createMcpServer()` serait **contourné** par les tests.
- Seul `cli/init.ts:82-83` casse : le `CLAUDE_MD_TEMPLATE` nomme `hot_files` et
  `check_file_conflict` comme outils à appeler.

**Mais le vrai résultat n'est pas là.** Combiné à (C), le gate ne casse pas « un » consommateur :
comme **aucun client n'émet l'opt-in**, la porte reste fermée pour **tous**. Une extension dont
la porte ne peut pas s'ouvrir n'a que deux états possibles — soit on la câble « ouverte par
défaut » et ce n'est plus une extension (la spec dit *« Extensions are always disabled by default
and require explicit opt-in »*), soit on la câble fermée et 9 outils disparaissent pour tout le
monde. Il n'y a pas de troisième état.

#### (F bis) Le conjoint « gain de contexte > 0 » — mesuré, et **il est atteint**

Le critère d'adoption de §6.2 exigeait *« et un gain de contexte mesuré > 0 dans une session
réelle »*. Ce conjoint n'était pas couvert par les bras A/B/C. Il l'est maintenant.

Deux bras, doctrine synthétique de **1 752 octets** (sous le plafond de 2 Ko), tâche qui
**n'a pas besoin** de la doctrine (`"Dis simplement: OK."`), prefix du premier tour =
`input + cache_creation + cache_read` du premier message assistant :

| Bras | `instructions` | Doctrine | prefix 1er tour | tours |
|---|---|---|---|---|
| **B2** | doctrine entière (1 752 o) | en ligne | 36 536 / 36 535 | 1 / 1 |
| **C2** | pointeur seul (182 o) | dans la Resource | 35 988 / 35 994 | 1 / 1 |

Bruit intra-bras : **1 et 6 tokens**. Écart inter-bras : **−544 tokens** en faveur de la
divulgation progressive.

**Il faut l'écrire noir sur blanc : mon critère d'adoption pré-enregistré est atteint.** Le
second disjoint (*« une ressource `SKILL.md` que l'agent lit sans qu'un humain la mentionne »*)
est satisfait **3/3** par le bras C — ce n'est pas un humain qui nomme l'URI, c'est le **serveur**,
via `instructions`. Et le conjoint (*« gain de contexte mesuré > 0 »*) est satisfait à **544
tokens**. Sur la lettre de §6.2, le volet (c) **qualifie pour l'adoption**.

**Ce que la mesure dit vraiment, et pourquoi ça ne suffit pas** — trois faits qui bornent ce gain :

1. **544 tokens sur un prefix de 36 500, soit 1,5 %.** À l'échelle où le projet vit, ce n'est pas
   un levier de contexte, c'est du bruit budgétaire.
2. **Le gain est le gain de *ne pas livrer* la doctrine.** Il n'existe que dans les sessions où
   l'agent ne la lit pas. Dans celles où il la lit (bras C), on paie le pointeur **plus** le
   contenu **plus** 2 tours — donc davantage que le bras B.
3. **Et surtout, le sens de la doctrine est comportemental, pas informationnel.** `C06` a mesuré
   **0/3** sur tâche d'écriture immédiate avec la doctrine **entièrement en contexte**. Éloigner
   ce texte derrière une lecture que l'agent doit décider de faire ne peut pas améliorer ce
   0/3 — au mieux le laisser inchangé. Le critère que j'avais pré-enregistré mesurait
   « est-ce que ça économise des tokens », pas « est-ce que ça aide ». **Il était mal calibré**,
   et c'est la mesure qui le révèle.

#### (G) P6 — Preuve documentaire fetchée le 2026-08-15 (non exécutée)

| Source | Fait |
|---|---|
| `modelcontextprotocol.io/extensions/client-matrix` | 3 extensions officielles seulement (`/ui`, `/oauth-client-credentials`, `/enterprise-managed-authorization`), 11 clients listés. **Claude Code n'y figure pas** (Claude web et Claude Desktop, oui). La colonne OAuth Client Credentials est **vide pour tous**. Verbatim : *« Extensions are always opt-in: a client only uses an extension if both client and server declare support in the `extensions` field of their capabilities. »* |
| `docs/extensions/overview` (source `.mdx`) | **Aucune règle normative** sur le sort des primitives gatées : zéro occurrence de `tools/list`, `conditional`, `hide`, `omit`. Le seul texte proche est *Graceful Degradation*, non normatif : *« a server offering UI-enhanced tools should still return meaningful text content for clients that don't support the UI extension »* — le repli recommandé est de **dégrader le contenu**, pas de **retirer l'outil**. La stratégie de gate d'A09 n'a donc aucun appui dans la spec. |
| `github.com/modelcontextprotocol/experimental-ext-grouping` | **7 commits au total.** Dernier : `07e546d`, **2026-03-04** — plus de 5 mois d'inactivité. `docs/approaches.md` toujours un stub de 273 octets ; les 5 autres docs sont des stubs de 258 octets. 8 stars. |
| `github.com/modelcontextprotocol/experimental-ext-skills` | **Vivant** : 177 stars, dernier commit **2026-08-11**, 13 docs substantiels (`sep-draft-skills-extension.md` = 64 856 o, `threat-model.md` = 41 331 o). **Aucune implémentation de référence dans le repo** (pas de `sdk/`) ; les implémentations sont tierces (C#, Go, TS, Python/FastMCP 3.0). |
| PR `modelcontextprotocol#2640` (SEP-2640) | **Ouverte**, label `draft`, `mergeable_state: "blocked"`, créée le 2026-04-23, **dernière activité 2026-08-15 (aujourd'hui)**, 31 commentaires + 130 de revue = **161**. À noter : son ancêtre **SEP-2076 est closed sans merge** (2026-02-24) et SEP-2093 **rejected**. |
| `code.claude.com/docs/en/mcp.md` | *« MCP servers can expose resources that you can reference using @ mentions »* et *« Resources are automatically fetched and included as attachments **when referenced** »*. Le « automatically » ne porte que sur la résolution après référencement. **Cohérent avec la mesure (D).** |

**Asymétrie à retenir :** les deux volets expérimentaux ne sont pas dans le même état. `grouping`
est gelé depuis mars et entièrement en stub ; `skills` est actif, documenté, et sa SEP a bougé
aujourd'hui même. Les traiter comme un bloc serait une erreur.

#### (H) Ce qui n'a PAS été exécuté

- **Un second client MCP non-Claude** (Cursor, Cline, Goose, VS Code Copilot). L'affirmation de §4
  selon laquelle des skills servies par Resources seraient « portables vers les agents non-Claude »
  **n'a pas été testée**. Elle reste une hypothèse.
- ~~**Le transport HTTP** pour le test du fil (C).~~ **Comblé** : un second PoC
  (`StreamableHTTPServerTransport`, `127.0.0.1:3199`, entrée `.mcp.json` `type: "http"`) donne
  exactement le même résultat, l'outil ayant bien été appelé de bout en bout :

  ```
  {"ev":"RAW initialize HTTP","params":{"protocolVersion":"2025-11-25",
   "capabilities":{"roots":{"listChanged":true},"elicitation":{}},
   "clientInfo":{"name":"claude-code","version":"2.1.233",...}}}
  ```

  **K2 est donc établi sur les deux transports du projet**, pas seulement stdio.
- **K6 (effort > 10 fichiers)** : rien n'a été implémenté, conformément à l'interdit du protocole.
  Le chiffre reste une estimation et n'a pas servi à trancher.

### 6.4 bis — Synthèse des critères de mort, et ce que la passe adversariale a corrigé

**Les 6 critères de §6.2, statut honnête :**

| # | Statut | Ce qui a été mesuré |
|---|---|---|
| **K1** | ✅ **déclenché** | Mesure directe par différence de prefix, **sans densité** : 9 outils périphériques = **1 719 tokens** sous `alwaysLoad`, et **147 tokens** en config Claude Code par défaut (seuls les noms chargent). Sous le seuil de 2 500 par un facteur 1,5 à 17. *Réserve : le seuil serait franchi en gatant `consultation` (**2 952 tok**) — précisément la famille que §6.1 garde toujours chargée.* |
| **K2** | ✅ **déclenché** | Aucun `extensions` émis par Claude Code 2.1.233, sur **stdio et HTTP**. |
| **K3** | ⚠️ **déclenché sur 1 terme / 4** | `sdk/src/*.ts` : client OAuth/device-code, n'appelle **aucun** outil MCP → intact. Routes REST : passent par `src/http/handle-rest.ts`, indépendant → intact. Tests : appellent `register*Tools()` directement → contournent un gate posé dans `createMcpServer()` → intacts. **Seule la documentation casse** : `cli/init.ts:82-83` et `README.md:275-284` prescrivent `hot_files`, `check_file_conflict`, `set_dependency_map`, `get_blast_radius`. |
| **K4** | ⚠️ **déclenché sur sa lettre, son implication est falsifiée** | 0/3 sans mention. Mais voir ci-dessous — la barre pré-enregistrée était plus haute que ce que quiconque proposait. |
| **K5** | ➖ **non déclenché, périmètre limité** | Rien n'a cassé sur PoC ; `ReadResourceCallback` reçoit `extra` → `getSessionClaims` réutilisable tel quel. **Non exécuté contre le vrai daemon.** |
| **K6** | ➖ **sans objet** | Rien n'a été implémenté (interdit du protocole). N'a pas servi à trancher. |

**Trois corrections que la passe adversariale a imposées, et que j'accepte :**

**(1) K3 ne doit pas être requalifié.** J'avais reformulé K3 en « casse 100 % des clients puisque
aucun ne peut ouvrir le gate ». C'est un **corollaire de K2**, pas une mesure indépendante — et
réécrire un critère pour le faire tomber plus fort est exactement ce que le pré-enregistrement
doit empêcher. K3 reste tel qu'écrit, déclenché sur un terme sur quatre, et le corollaire est
versé sous K2.

**(2) Le motif de (a) était mal choisi.** Dire « Claude Code n'émet pas `extensions` dans
`initialize` » mesure un handshake que la révision `2026-07-28` **supprime**. Le chemin normatif
d'opt-in y est `server/discover` + `_meta["io.modelcontextprotocol/clientCapabilities"]` sur
chaque requête. Vérifié dans le SDK **réellement installé** (1.30.0, `dist/esm/`) :
`server/discover` → **0 occurrence**, `io.modelcontextprotocol/clientCapabilities` → **0
occurrence**. Le champ `extensions` est bien dans les deux schémas, et mon PoC prouve qu'il
**traverse** sur une connexion 2025-11-25 — mais aucun véhicule normatif ne l'achemine.
**Conséquence de cadrage : (a) n'est pas refusable sur ses mérites, il est un sous-produit de
[`A01`](A01-mcp-2026-07-28-stateless.md), déjà verdicté `reporter`.**

**(3) K4 mesurait une barre que personne ne proposait — et le bras D le prouve.**
Ma conclusion « la Resource n'est lisible que si `instructions` **nomme l'URI** » est **fausse**.
Bras **D** : `instructions` = une phrase générique de 150 octets, *« ce serveur publie sa doctrine
de coordination sous forme de ressources MCP, consulte-les »*, **sans jamais nommer l'URI**, et
**sans aucun `--allowedTools`** :

```
D1  turns= 4  result= "ZORGLUB-4417"    resources/read sur le fil: 2
D2  turns= 4  result= "ZORGLUB-4417"    resources/read sur le fil: 2
D3  turns= 4  result= "ZORGLUB-4417"    resources/read sur le fil: 2
```

**3/3.** L'agent trouve la ressource seul, via `ListMcpResourcesTool` → `ReadMcpResourceTool`
(Claude Code expose aussi `ReadMcpResourceDirTool`, que je n'avais pas inventorié). Résultat
reproduit indépendamment après que la passe adversariale l'a signalé.

**La frontière exacte est donc :**

| `instructions` contient… | Résultat |
|---|---|
| rien sur les ressources (bras A) | **0 / 3** |
| une phrase générique « il y a des ressources » (bras D, 150 o) | **3 / 3** |
| l'URI exacte (bras C) | **3 / 3** |
| la doctrine elle-même (bras B) | **3 / 3** |

`instructions` est un **amorçage de 150 octets**, pas un concurrent de la Resource. Les traiter
comme un duel à somme nulle — ce que ma §6.2 a fait — était l'erreur de cadrage de ce challenge.

### 6.5 Contre-arguments

> Repris et arbitrés le 2026-08-15 après l'expérience. ✅ tient · ➖ affaibli · ❌ tombe

- ❌ **« Deux briques sur trois ne sont pas de la spec »** — **tombe pour (c), tient pour (b).**
  Le périmètre retenu en §7 n'utilise **rien** de SEP-2640 : `registerResource`,
  `resources/list` et `resources/read` sont du **MCP cœur, GA, présents dans le SDK 1.30.0
  installé**. On n'attend aucune extension.
- ✅ **« L'IG entretient trois stratégies concurrentes »** — **tient, et se durcit** : les repos
  frères `experimental-ext-tool-search` et `experimental-ext-code-mode` **n'existent pas** dans
  l'org. Il n'y a pas trois chevaux, il y en a un, à l'arrêt depuis mars.
- ✅ **« 26 outils n'est pas 200 »** — **tient, désormais chiffré** : le seuil de dégradation cité
  par Anthropic est *« once you exceed 30–50 available tools »*, et le gate proposé rapporte
  **147 tokens** en config réelle. YAGNI confirmé par la mesure.
- ✅ **« Opt-in par défaut = régression silencieuse »** — **tient**, et le bilan K3 le précise :
  ce n'est pas le code qui casse, c'est la documentation expédiée à chaque utilisateur.
- ➖ **« Ajouter la primitive Resources est un coût net »** — **affaibli**. `registerResource`
  installe lui-même les deux handlers et la capability ; le callback reçoit `extra`, donc
  l'org-scoping réutilise `getSessionClaims` sans chemin neuf. Le coût réel est un fichier et des
  tests, pas une couche.
- ✅ **« Doctrine dupliquée »** — **tient, et devient la condition de l'adoption.** C'est le
  contre-argument le plus fort de la fiche. Il n'est neutralisé que si le `CLAUDE.md` écrit par
  `init` est **réduit à un pointeur** en même temps. Sans ça, on crée une troisième copie et le
  contre-argument gagne. Inscrit en §7.1 comme livrable non négociable.
- ✅ **« La participation à l'IG n'est pas gratuite »** (Python + TS exigés, projet TS-only) —
  **tient**, et rend (b) sans appel.
- ➖ **« Effort probablement mal réparti »** — **affaibli** : c'est l'inverse qui est mesuré. La
  déclaration d'extension, présentée comme le seul travail borné, est celle qui ne rapporte rien
  (147 tokens, aucun client). Le volet skills, présenté comme M-à-L, se réduit à un
  `registerResource` en MCP cœur.

**Contre-arguments révélés par l'expérience, à ajouter :**

- ✅ **Le gain de contexte de (c) est réel mais dérisoire** — 544 tokens sur un prefix de 36 500,
  soit **1,5 %**, et seulement dans les sessions où l'agent ne lit pas la ressource. Ce n'est pas
  l'argument d'adoption ; il ne faut pas s'en servir comme tel.
- ✅ **(c) n'améliore pas le comportement, et il ne faut pas le laisser croire.** `C06` a mesuré
  **0/3** sur tâche d'écriture immédiate avec la doctrine **entièrement en contexte**. Éloigner ce
  texte derrière une lecture à la demande ne peut pas améliorer ce 0/3. La contrainte reste le
  sujet de [`C01`](C01-hook-mcp-tool-gate.md) et [`F02`](F02-canusetool-distributed-lock.md).
- ✅ **La portabilité annoncée en §4 est surévaluée** — aucun client MCP n'injecte
  automatiquement une Resource autonome dans le contexte, et l'issue amont demandant de rendre
  l'auto-inclusion normative a été **fermée sans rien livrer**. Ce qui existe est l'appel
  *par le modèle* (`ListMcpResources`/`ReadMcpResource`), présent chez plusieurs clients.
  **Non vérifié ici sur un second client** — voir §6.4 (H). À ne pas transformer en argument
  produit tant que ce n'est pas mesuré.
- ✅ **Le canal de distribution actuel de la doctrine est le maillon faible, et c'est mesurable.**
  Elle part dans un `CLAUDE.md` écrit par `mcp-coordinator init` : Claude-only jusque dans le nom
  du fichier, et **figé à l'instant de l'init**, donc condamné à dériver du serveur qui tourne.
  Le dépôt a déjà payé cette dérive deux fois (essaim désabonné du bus depuis la v0.7.0 ; un outil
  `introspection` documenté qui n'a jamais existé). Une ressource servie par le daemon est
  verrouillée sur sa version par construction.
- ➖ **Effet de bord trouvé en séance, hors périmètre** : `src/index.ts:52` log
  *« no MQTT broker in stdio mode »*, et `src/tools/mqtt-tools.ts:34` porte
  `MQTT_NOT_CONNECTED_MESSAGE`. **3 outils sur 26 sont listés et décrits au modèle alors qu'ils
  sont garantis en échec sur stdio.** C'est la seule réduction de surface de cette fiche qui ait
  un bénéficiaire réel — et elle se fait par un `if` sur `mqttBridge.isConnected()`, pas par le
  framework d'extensions. À ouvrir séparément. Le Grouping IG est en « Active Exploration » et sa convention v0.1 est *Proposed* — une convention, pas une norme. SEP-2640 est « In Review » sur l'Extensions Track. Bâtir dessus maintenant, c'est s'engager à suivre des cibles mouvantes pour un mainteneur solo.
- **L'IG entretient délibérément trois stratégies concurrentes.** `grouping`, `tool-search` et `code-mode` ne convergeront pas toutes. Implémenter la mauvaise coûte deux fois : le travail initial, puis la migration.
- **26 outils n'est pas 200.** Le problème que l'IG décrit vise les serveurs à surface massive. Rien dans le repo ne prouve aujourd'hui que 26 outils dégradent la sélection — le point 6.3.1 pourrait très bien montrer un coût négligeable, auquel cas c'est du YAGNI pur.
- **Opt-in par défaut = régression silencieuse.** Les extensions sont désactivées par défaut. Gater 9 outils derrière un opt-in casse tout client existant qui ne le connaît pas, y compris le SDK maison `sdk/src/client.ts` et l'essaim déjà déployé. Le gain contextuel se paie en compatibilité.
- **Ajouter la primitive Resources est un coût net.** Le serveur n'en expose aucune aujourd'hui (vérifié). Servir des skills implique un nouveau chemin de code, sa surface d'auth/multi-org (les handlers actuels scopent tout par `claims.org` — un `resources/read` devrait faire pareil), et ses tests.
- **Doctrine dupliquée.** Déporter la doctrine vers des `SKILL.md` sans la retirer de `docs/ARCHITECTURE.md`, `docs/usage.md` et des descriptions d'outils crée une troisième copie à maintenir en cohérence — le projet a déjà un historique de dérive documentaire multi-surfaces.
- **La participation à l'IG n'est pas gratuite.** L'IG demande que chaque extension supporte au moins Python et TypeScript avec des démos end-to-end. Le projet est TypeScript only.
- **Effort probablement mal réparti.** Sur les trois briques, seule la déclaration d'extension est un travail borné (S). Le grouping et les skills sont chacun M-à-L pour un bénéfice non mesuré.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** (volet `c`) · ⬜ reporter · ✅ **refuser** (volets `a` et `b`) |
| **Date** | 2026-08-15 |
| **Justification** | **Les deux volets « spec » meurent, le volet « experimental » survit — l'inverse exact de ce que la fiche pariait.** (a) Le framework d'extensions est GA mais **inerte** : Claude Code 2.1.233 n'émet aucun `extensions` (mesuré sur stdio **et** HTTP), le véhicule normatif de l'opt-in (`server/discover` + `_meta[...clientCapabilities]`) est à **0 occurrence** dans le SDK 1.30.0 installé, et le gate proposé rapporte **147 tokens** en config Claude Code réelle. (b) Le Primitive Grouping IG est gelé : 7 commits, dernier le 2026-03-04, tous les docs en stub, aucun repo frère pour deux des trois stratégies, et l'IG s'interdit lui-même tout mandat. (c) **Retenu**, mais dépouillé de tout ce qui est expérimental : `registerResource` + `resources/list` + `resources/read` sont du **MCP cœur, GA, déjà dans le SDK installé**. Mesuré 3/3 avec un amorçage de **150 octets** dans `instructions` qui ne nomme même pas l'URI. |
| **Issue / PR** | Aucune issue neuve. Périmètre versé le 2026-08-15 dans [#281](https://github.com/swoofer/mcp-coordinator/issues/281#issuecomment-5304147122) (couche `coord://` — elle avait besoin d'un propriétaire, A09 le lui donne) et [#271](https://github.com/swoofer/mcp-coordinator/issues/271#issuecomment-5304148809) (les 150 octets d'amorçage à ajouter au texte `instructions`). |
| **Jalon visé** | prochaine mineure, derrière `C06`/#271 dont (c) dépend |

### 7.1 La réponse à la question de §6.1

**La question repose sur une prémisse fausse et il faut le dire.** §6.1 oppose « parier sur une
seule stratégie de réduction de surface (**le tool search**) » à « déclarer une extension qui gate
9 outils ». Or **personne n'a parié sur le tool search** : le challenge de
[`C06`](C06-tool-search-defer-loading.md) a adopté le champ **`instructions`** et **rejeté
explicitement** les optimisations propres au tool search (renommage des 26 outils, enrichissement
BM25 des descriptions — *« le matching BM25 n'a jamais été le maillon faible »*). Le premier terme
du OU décrit un pari que le dépôt n'a pas pris.

Et le second terme est mort à la mesure. La réponse, terme par terme :

1. **Non au gate d'outils derrière une extension.** Pas parce que c'est infaisable — c'est
   faisable, `oninitialized` + `getClientCapabilities()` + `RegisteredTool.disable()` existent
   dans le SDK installé — mais parce que la porte ne peut pas s'ouvrir (K2) et que ce qu'elle
   garderait vaut **147 tokens**.
2. **Non à la participation au Grouping IG.** Rien à implémenter, rien à quoi contribuer.
3. **Oui au déport de la doctrine vers `resources/read`** — mais comme **couche MCP cœur**, pas
   comme skill SEP-2640, et à la condition expresse de **supprimer la copie** existante.

### 7.2 Ce qui est retenu (volet `c`), périmètre exact

Entièrement en MCP cœur. **Aucune dépendance à SEP-2640, au Grouping IG, ni au framework
d'extensions.**

1. **Servir la doctrine d'annonce comme Resource lecture seule** sous `coord://`, via
   `registerResource` (le SDK 1.30.0 installe lui-même `resources/list` + `resources/read` et
   enregistre la capability). Contenu source : le `CLAUDE_MD_TEMPLATE` de `cli/init.ts` (**3 921
   octets**, mesurés). Scoping par `claims.org` via `extra.sessionId`, patron identique aux 26
   outils. **C'est le périmètre de [#281](https://github.com/swoofer/mcp-coordinator/issues/281)**,
   qui cherchait un propriétaire — A09 le lui apporte.
2. **L'amorcer depuis `instructions`** — l'apport propre de ce challenge. Une phrase générique de
   **150 octets** suffit (bras D, 3/3) ; il n'est **pas** nécessaire de nommer l'URI. À ajouter au
   texte de ≤ 2 Ko de [#271](https://github.com/swoofer/mcp-coordinator/issues/271), dont il
   consomme 7 % du budget.
3. **Réduire le `CLAUDE.md` écrit par `init` à un pointeur.** **Non négociable** : sans ça on crée
   une troisième copie de la doctrine et le contre-argument « doctrine dupliquée » de §6.5 —
   le plus fort de la fiche — l'emporte. C'est aussi le seul gain durable du volet : une ressource
   servie par le daemon est verrouillée sur sa version, là où un `CLAUDE.md` est figé à l'init.
4. **Ne pas déclarer `resources.subscribe`.** Le piège `-32601` documenté par
   [`A04`](A04-subscriptions-listen.md) et #281 ne concerne **que** l'abonnement.

### 7.3 Ce qui est écarté, et pourquoi

- **Le gate des 9 outils derrière `{préfixe}/coordination`** — 147 tokens en config réelle, aucun
  client capable d'ouvrir la porte, et la spec n'offre **aucun** appui : `docs/extensions/overview`
  n'a zéro occurrence de `tools/list`, `hide` ou `omit`, et son repli recommandé est de *dégrader
  le contenu*, pas de *retirer l'outil*.
- **Déclarer `capabilities.extensions` « pour se préparer »** — déjà écarté par
  [`A05`](A05-mcp-tasks-extension.md) §7.3. A09 le confirme avec une nuance mesurée : contrairement
  à `resources.subscribe`, déclarer une extension ne produit **pas** de `-32601` (Claude Code se
  connecte sans erreur et l'ignore). Le motif n'est donc pas le garde-fou fantôme, c'est
  l'inertie pure — et la doc est explicite : *« SDKs can choose to implement extensions, but it's
  not required for protocol conformance »*.
- **Tout le volet (b)** — Grouping IG, `MCP Grouping Convention v0.1`, contribution de retour
  d'expérience.
- **SEP-2640 lui-même**, `skills.json`, l'URI well-known, le format `references/`, et
  l'identifiant d'extension. La capacité recherchée est disponible **aujourd'hui** en MCP cœur ;
  attendre l'experimental serait attendre pour rien. À reconsidérer si SEP-2640 est mergée — mais
  rien n'en dépend.
- **Migrer `capabilities.experimental["claude/channel"]` de `cli/channel.ts` vers une extension**
  (promesse du §4, point 1) — **impossible unilatéralement** : la clé est définie par l'hôte
  Anthropic, pas par ce projet. §4 surpromet, correction portée en §7.5.

### 7.4 Le retournement, qui est le vrai résultat de ce challenge

**Mon verdict de travail était `refuser` sur (a) et (b), `reporter` sur (c). La passe
adversariale a retourné (c), et c'est elle qui avait raison.** Trois choses l'ont fait basculer :

1. **Le bras D.** J'avais conclu que la Resource n'était lisible que si `instructions` **nommait
   l'URI** — donc qu'elle était subordonnée. Faux : une phrase générique de 150 octets suffit,
   3/3, l'agent trouve seul via `ListMcpResourcesTool`. Ma §6.2 traitait `instructions` et
   Resources comme un duel à somme nulle ; ce sont deux étages d'un même dispositif.
2. **Mon propre critère d'adoption était atteint, et j'allais l'écrire comme non atteint.**
   §6.2 exigeait *« une ressource `SKILL.md` que l'agent lit sans qu'un humain la mentionne — et
   un gain de contexte mesuré > 0 »*. Dans les bras C et D ce n'est pas un humain qui la
   mentionne, c'est le **serveur** : disjoint satisfait 3/3. Et le conjoint a été mesuré à
   **544 tokens**. Le pré-enregistrement a fait exactement son travail : il m'a empêché de
   rationaliser un résultat que je n'attendais pas.
3. **La contribution propre d'A09 sur (a) est plus faible que je ne l'ai présentée.** K1 et K2
   étaient déjà établis ailleurs — `C06` pour le déferrement, `A01` et `A05` pour l'absence
   d'`extensions` sur le fil de Claude Code 2.1.233. Les re-mesurer était honnête ; les compter
   comme trois découvertes de ce challenge ne l'était pas.

**Une contradiction apparente à désamorcer dans le corpus.** La lecture rapide de ce challenge
(« K4 : Claude Code ne lit pas les ressources ») semble contredire
[`A04`](A04-subscriptions-listen.md) §6.4 et #281 (« Claude Code **lit** les ressources »,
`resources/read` → 1). **Il n'y a pas de contradiction, et les deux sont vraies :** A04 et #281
mesurent la lecture **sollicitée**, A09 mesure la lecture **spontanée**. La frontière que A09
ajoute est le seuil exact entre les deux — **150 octets dans `instructions`**.

### 7.5 Corrections à porter dans les sections 1 à 5

Trois affirmations de la fiche sont fausses et ne sont pas corrigées par le verdict :

1. **§4, point 2 — « si la Grouping Convention se stabilise et que les clients l'implémentent, un
   serveur non conforme sera pénalisé à la sélection d'outils »** — **à supprimer**. L'IG écrit
   lui-même en *Out of Scope* : *« Implementation mandates: We can document patterns but not
   require specific client or server behavior »*. Il n'existe aucun mécanisme de pénalité.
2. **§4, point 1 — « le framework d'extensions remplacerait ce bricolage »** (à propos de
   `capabilities.experimental["claude/channel"]`) — **surpromesse**. La clé appartient à l'hôte
   Anthropic ; le projet ne peut pas la migrer seul.
3. **§4, point 3 — « portable vers les agents non-Claude »** — **non vérifié, et probablement
   surévalué**. Aucun client MCP connu n'injecte automatiquement une Resource autonome dans le
   contexte. Ce qui existe est l'appel *par le modèle*. Non testé ici sur un second client
   (§6.4 (H)) : à ne pas utiliser comme argument produit en l'état.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. Fusion de 3 fiches brutes (extensions-framework GA, Primitive Grouping IG, Skills Over MCP WG / SEP-2640). |
| 2026-08-14 | Vérification des faits : 3 marqueurs tranchés, SDK 1.30.0 confirmé, lignes repo exactes, testabilité partielle. |
| 2026-08-15 | Challenge. 21 sessions Claude Code 2.1.233 (5 bras A/B/C/D + mesure de contexte), 3 PoC MCP (stdio, HTTP, sondes de fil), `tools/list` découpé famille par famille sur le vrai daemon, 6 pages de doc fetchées. **Verdict : `refuser` (a) le framework d'extensions et (b) le Primitive Grouping IG ; `adopter partiellement` (c) Skills-over-MCP — mais en MCP cœur, sans SEP-2640.** Mesuré : aucun `extensions` émis par Claude Code sur **stdio et HTTP** ; `server/discover` et `_meta[...clientCapabilities]` à **0 occurrence** dans le SDK 1.30.0 ; le gate des 9 outils vaut **147 tokens** en config réelle ; `ext-grouping` gelé depuis le 2026-03-04 ; une Resource seule **0/3**, amorcée par 150 octets d'`instructions` **3/3**. **La passe adversariale a retourné le verdict sur (c)** — le bras D a falsifié ma conclusion « la Resource est subordonnée à `instructions` », et mon propre critère d'adoption pré-enregistré était atteint alors que j'allais l'écrire comme non atteint. Trois corrections portées aux §4 (pénalité de sélection inexistante, migration `claude/channel` impossible, portabilité non vérifiée). |
