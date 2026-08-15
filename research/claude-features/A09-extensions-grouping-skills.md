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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

> ⚠️ Non exécutable ici : aucun client MCP connu ne négocie `extensions` pour une extension tierce (Claude Code est absent de `extensions/client-matrix`), et `docs/approaches.md` est un stub vide.

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

- [ ] Mesurer le coût réel : capturer la réponse `tools/list` complète du serveur (stdio et HTTP) et compter les tokens du préambule des 26 outils, famille par famille. Sans ce chiffre, tout le reste est de la théorie.
- [ ] Vérifier que `@modelcontextprotocol/sdk ^1.29.0` (version installée) expose bien `ServerCapabilities.extensions` — lire les types du SDK dans `node_modules`, pas la doc.
- [ ] Ajouter un `capabilities.extensions` expérimental dans `createMcpServer()` et observer ce que fait un vrai client (Claude Code) : ignoré silencieusement, erreur, ou négocié ?
- [ ] PoC skill : exposer un `SKILL.md` « protocole d'annonce » via `resources/list` + `resources/read` et vérifier qu'un client le découvre sans casser les clients qui n'attendent aucune Resource.
- [ ] Lire `docs/approaches.md` de `experimental-ext-grouping` et confronter les trois stratégies au découpage en 6 familles déjà en place — laquelle demande le moins de code neuf ?

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Deux briques sur trois ne sont pas de la spec.** Le Grouping IG est en « Active Exploration » et sa convention v0.1 est *Proposed* — une convention, pas une norme. SEP-2640 est « In Review » sur l'Extensions Track. Bâtir dessus maintenant, c'est s'engager à suivre des cibles mouvantes pour un mainteneur solo.
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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. Fusion de 3 fiches brutes (extensions-framework GA, Primitive Grouping IG, Skills Over MCP WG / SEP-2640). |
| 2026-08-14 | Vérification des faits : 3 marqueurs tranchés, SDK 1.30.0 confirmé, lignes repo exactes, testabilité partielle. |
