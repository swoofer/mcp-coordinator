# E13 — Publier une skill de coordination plutôt que d'alourdir les descriptions d'outils

| Champ | Valeur |
|---|---|
| **ID** | `agent-skills-coordination` |
| **Surface** | claude-api |
| **Statut** | beta — header `anthropic-beta: skills-2025-10-02` toujours requis au 2026-08-14 |
| **Disponible depuis** | 2025-10-16 (lancement) · 2026-08-07 (skills depuis un repo GitHub pour les Managed Agents) |
| **Tier** | T2-fort-levier |
| **Nature** | opportunity |
| **Effort estimé** | M |
| **Confiance veille** | medium |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — pas de clé API skills ; skill locale testable |
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — refuser les deux volets ; la question est deja tranchee par A09(c)/#281 |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — le marqueur `(à vérifier)` sur la portabilité du dossier `SKILL.md` est tranché : un dossier de skill Claude Code est téléversable via `POST /v1/skills` **à condition** de restreindre le frontmatter aux six champs du standard Agent Skills (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`). Tout champ propre à Claude Code (`argument-hint`, etc.) provoque une erreur `Unexpected key(s) in SKILL.md frontmatter`, et les fonctions de corps propres à Claude Code (injection de contexte dynamique) ne fonctionnent pas via l'API. Le dépôt `anthropics/skills` fournit `package_skill.py` pour l'empaquetage.
- §5 — `cli/init.ts` : la logique de fusion sentinelle court en réalité des **lignes 259 à 291** (le `SENTINEL` est déclaré ligne 259), et non 258-290.

Vérifiés et exacts, sans changement : statut beta (`anthropic-beta: skills-2025-10-02` toujours requis au 2026-08-14) ; dates 2025-10-16 (lancement) et 2026-08-07 (skills chargées depuis `.claude/skills` d'un dépôt GitHub monté par une session Managed Agents) ; `container.skills[]`, max 8, types `anthropic`/`custom`, versions `20251013` / epoch / `latest` ; obligation d'un outil `code_execution` ; les sept endpoints `/v1/skills` ; le chemin `bash_code_execution_tool_result` → `bash_code_execution_result` → `content[].file_id` → `GET /v1/files/{file_id}/content`. Côté repo : `cli/init.ts:10`, `cli/channel.ts:152` et `:318`, `package.json:41-47`, et l'ensemble des fichiers cités existent ; aucune occurrence de `skill` dans `src/`, `cli/`, `sdk/`.

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
La partie qui compte le plus se teste ici : extraire `CLAUDE_MD_TEMPLATE` en `.claude/skills/coordination/SKILL.md`, retirer la section sentinelle du `CLAUDE.md`, lancer une session Claude Code contre un daemon local et observer si `register_agent` puis `announce_work` sont bien appelés avant une écriture de fichier. Le comptage de tokens peut se faire hors ligne (tokenizer local ou approximation) faute de garantie d'accès à l'endpoint de comptage. Ce qui bloque : le volet Messages API — `POST /v1/skills`, `container.skills[]`, header `skills-2025-10-02` et outil `code_execution` — exige une clé API Anthropic avec accès beta et facturation du conteneur d'exécution, non disponible sur le poste.

## 1. Ce que c'est

Une *skill* est un dossier d'instructions, de scripts et de ressources que Claude charge dynamiquement. Le mécanisme repose sur la divulgation progressive : seules les métadonnées (nom + description, quelques dizaines de tokens) sont présentes en permanence dans le contexte ; le corps des instructions n'est injecté que lorsque la tâche en cours correspond à la description.

Sur la Messages API, l'activation passe par le paramètre `container` : `container.skills[]` liste jusqu'à 8 skills, chacune de type `anthropic` (les quatre skills maison : `pptx`, `xlsx`, `docx`, `pdf`) ou `custom` (téléversée par l'utilisateur). Un outil `code_execution` dans `tools` est **obligatoire** — les skills s'exécutent dans le conteneur. Les skills personnalisées se gèrent via les endpoints `/v1/skills` (création, versions, suppression) ; le `skill_id` est généré par l'API (préfixe `skill_`), il n'est pas choisi. Les fichiers produits par une skill remontent dans un bloc `bash_code_execution_tool_result` et se récupèrent par `file_id` via la Files API.

Pour mcp-coordinator, l'angle n'est pas la génération de documents mais la **distribution du protocole** : « quand annoncer, comment lire un conflit, quel outil appeler dans quel ordre » est aujourd'hui du texte figé dans un `CLAUDE.md` généré par le CLI. Le même contenu, packagé en `SKILL.md`, ne coûte plus de contexte tant qu'il n'est pas pertinent. À noter : cette fiche est complémentaire de A09 (tool search / skills-over-MCP) — le tool search attaque le coût des **définitions d'outils**, la skill attaque le coût du **protocole d'usage**.

## 2. Surface d'API exacte

```
# Messages API
container.skills[] = [{ type: "anthropic" | "custom", skill_id, version }]
  - max 8 skills par requête
  - skill_id anthropic : pptx | xlsx | docx | pdf   (version "20251013" ou "latest")
  - skill_id custom    : "skill_01AbCd…" (généré par l'API), version = timestamp epoch ou "latest"
  - un outil code_execution dans `tools` est OBLIGATOIRE
    (code_execution_20260521 | code_execution_20260120 | code_execution_20250825)

# Headers
anthropic-beta: skills-2025-10-02            # obligatoire
anthropic-beta: files-api-2025-04-14         # pour télécharger les fichiers produits
anthropic-beta: code-execution-2025-08-25    # UNIQUEMENT avec code_execution_20250825
                                             # (les versions 2026 sont GA, sans header)

# Skills API
GET    /v1/skills            (param `source=anthropic` pour filtrer)
POST   /v1/skills
GET    /v1/skills/{skill_id}
DELETE /v1/skills/{skill_id}
GET    /v1/skills/{skill_id}/versions
POST   /v1/skills/{skill_id}/versions
DELETE /v1/skills/{skill_id}/versions/{version}

# Récupération des fichiers produits
bloc `bash_code_execution_tool_result` → `bash_code_execution_result` → content[].file_id
GET /v1/files/{file_id}/content
```

Payload minimal :

```json
{
  "model": "…",
  "container": { "skills": [{ "type": "custom", "skill_id": "skill_01AbCd…", "version": "latest" }] },
  "tools": [{ "type": "code_execution_20260521", "name": "code_execution" }]
}
```

Portabilité du dossier `SKILL.md` entre Claude Code et l'API (vérifié le 2026-08-14) : le même dossier est téléversable en skill custom **si son frontmatter se limite aux six champs du standard Agent Skills** — `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`. Un champ propre à Claude Code (`argument-hint`, `arguments`, …) fait échouer la validation avec `Unexpected key(s) in SKILL.md frontmatter`. Les fonctionnalités de corps propres à Claude Code (injection de contexte dynamique, `${CLAUDE_SKILL_DIR}`) ne fonctionnent pas via l'API. Contraintes de frontmatter côté API : `name` ≤ 64 caractères, minuscules/chiffres/tirets ; `description` non vide, ≤ 1024 caractères. Le téléversement se fait en multipart en préservant un répertoire racine commun dans les chemins (`files[]=@dossier/SKILL.md;filename=dossier/SKILL.md`) ; `anthropics/skills` fournit `package_skill.py` pour l'empaquetage.

## 3. Sources

- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/quickstart
- https://platform.claude.com/docs/en/release-notes/overview

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :** la doctrine de coordination est aujourd'hui distribuée par `mcp-coordinator init --claude-md`, qui écrit ou fusionne une section d'environ 90 lignes (`CLAUDE_MD_TEMPLATE`, `cli/init.ts:10`) dans le `CLAUDE.md` du dépôt de l'utilisateur. Ce texte est payé en tokens à **chaque tour de chaque session**, qu'il s'agisse d'annoncer un changement ou de corriger une typo. Packagé en skill, il ne coûte que sa description tant qu'aucune tâche ne le déclenche. Second bénéfice : la mise à jour. Aujourd'hui, faire évoluer le protocole (nouvel outil, nouvel ordre d'appel) suppose que chaque utilisateur relance `init` et accepte le remplacement de la section sentinelle ; une skill versionnée (`/v1/skills/{id}/versions`) se met à jour côté serveur. Troisième bénéfice : la même source de vérité pourrait alimenter le `CLAUDE.md`, les `description` Zod de `src/tools/*.ts` et le champ `instructions` du serveur channel (`cli/channel.ts:318`), qui divergent aujourd'hui sans garde-fou. Le contenu existe déjà (`announce-workflow`, `plan-quality`, `INSTRUCTIONS`) : c'est essentiellement du packaging.

**Risque si on ne fait rien :** faible et indirect. Le `CLAUDE.md` reste fonctionnel. Le risque réel est la dérive : trois copies du protocole (CLAUDE.md, descriptions d'outils, instructions du channel) évoluent séparément et finissent par se contredire pour l'agent.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `cli/init.ts` (`CLAUDE_MD_TEMPLATE`, ligne 10 ; logique de fusion sentinelle, lignes 259-291) | Source du contenu à extraire en `SKILL.md`. Le flag `--claude-md` deviendrait soit une alternative, soit un stub pointant vers la skill. |
| `cli/channel.ts` (`INSTRUCTIONS`, ligne 152 ; passé au serveur MCP ligne 318) | Deuxième copie du protocole, à réconcilier avec la même source. |
| `src/tools/agents-tools.ts`, `status-tools.ts`, `consultation-tools.ts`, `files-tools.ts`, `dependencies-tools.ts`, `mqtt-tools.ts` | Les `.describe()` Zod portent aujourd'hui une partie de la doctrine d'usage. Ce qui migre vers la skill peut être allégé ici. |
| `src/announce-workflow.ts`, `src/plan-quality.ts` | Contenu métier du protocole (ordre d'appel, critères de qualité de plan) que la skill doit refléter fidèlement. |
| `package.json` (champ `files`, lignes 41-47) | Un dossier `skills/` devrait y être ajouté pour être publié avec le paquet npm. |
| `docs/usage.md`, `README.md` | Documentation de l'installation de la skill à côté de celle du `.mcp.json`. |
| `research/claude-features/A09-extensions-grouping-skills.md` | Fiche voisine : skills servies via MCP Resources (SEP-2640). Les deux voies doivent être arbitrées ensemble, pas séparément. |

Aucune occurrence de `skill` n'existe aujourd'hui dans `src/`, `cli/` ou `sdk/` : le sujet est vierge.

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> La doctrine de coordination doit-elle être distribuée comme skill Agent Skills (dossier `SKILL.md` livré dans le paquet npm, plus publication optionnelle via `/v1/skills`) en remplacement de la section écrite par `mcp-coordinator init --claude-md`, ou bien servie via MCP Resources façon SEP-2640 (fiche A09) pour rester lisible par tout client MCP et pas seulement par le runtime Anthropic ?

### 6.2 Hypothèse

**Le contexte a changé depuis l'écriture de la fiche, et il tranche déjà la moitié de §6.1.** Celle-ci demande d'arbitrer « skill Agent Skills » **contre** « MCP Resources façon SEP-2640 (fiche A09) » — et **`A09` a été tranchée le 2026-08-15**, trois jours avant ce challenge :

> **Verdict** — `refuser` (a) et (b), **`adopter partiellement` (c)**. « (c) **Retenu**, mais dépouillé de tout ce qui est expérimental : `registerResource` + `resources/list` + `resources/read` sont du **MCP cœur, GA, déjà dans le SDK installé**. Mesuré 3/3 avec un amorçage de **150 octets** dans `instructions` qui ne nomme même pas l'URI. » Périmètre versé dans **#281**.

Autrement dit : la branche concurrente est **déjà adoptée**, sur du MCP cœur GA et portable, avec une mesure à l'appui, et elle a un propriétaire. E13 n'arbitre donc pas deux options ouvertes — elle doit dire si les skills apportent quelque chose que la voie déjà retenue n'apporte pas.

**Ce que je pense avant de mesurer.** Non, et pour une raison que §4 énonce à l'envers. §4 affirme que le `CLAUDE.md` est « payé en tokens à **chaque tour de chaque session** ». Je m'attends à ce que ce soit **faux** : un `CLAUDE.md` occupe une position de **préfixe caché**, donc payé une fois par conversation, pas par tour. C'est la même erreur qu'`E08` avait produite sur `defer_loading` — promettre une économie que personne ne dépense.

Hypothèse secondaire : la fiche **sous-compte les copies de la doctrine**. §4 en annonce trois (CLAUDE.md, descriptions d'outils, `INSTRUCTIONS` du channel) mais `src/mcp-instructions.ts` existe et n'apparaît **nulle part** dans la fiche — vérifié, 0 occurrence de « mcp-instructions ». Il y en a donc **quatre**, et une skill en ajouterait une **cinquième** tant que le `CLAUDE.md` n'est pas supprimé.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **Le coût n'est pas payé par tour.** Si la doctrine occupe une position de préfixe caché, l'économie annoncée par §4 n'existe pas. | la doctrine est en position **cacheable** (préfixe), pas réinjectée par tour |
| **K2** | **Le bénéfice absolu est petit.** Une skill n'a d'intérêt que si le texte qu'elle diffère pèse assez. | `CLAUDE_MD_TEMPLATE` < **2 000** tokens estimés |
| **K3** | **La skill ajoute une copie au lieu d'en retirer une.** | ≥ **4** copies existantes de la doctrine, et aucune supprimée sans travail supplémentaire |
| **K4** | **La branche concurrente est déjà adoptée.** Si `A09(c)` couvre le besoin en MCP cœur GA et portable, les skills n'ajoutent que du verrouillage. | `A09(c)` adoptée et dotée d'un propriétaire — **vérifié** |
| **K5** | **`code_execution` obligatoire pour une skill purement textuelle.** | la doc exige un outil `code_execution` dans `tools`, confirmé |
| **K6** | **Non livrable comme artefact.** Publier une skill custom exige une clé API et un compte côté utilisateur. | `POST /v1/skills` exige des credentials utilisateur |

**Règle que je m'impose :** §0 classe la fiche ⚠️ **partielle** — le volet Messages API n'est pas exécutable. Il ne peut **jamais** recevoir `adopter`. Et j'applique les leçons accumulées : **vérifier que le coût est réellement payé avant d'annoncer une économie** (`E08`), **grepper la doc du dépôt avant de crier à la découverte** (`E09`), **vérifier une absence plutôt que la supposer** (`E10`, `E12`), et **ne pas laisser un seuil décider de plusieurs changements** (`E11`).

### 6.3 Protocole de vérification

> ⚠️ Le volet Messages API (`POST /v1/skills`, `container.skills[]`, outil `code_execution`) n'est pas exécutable ici : pas de clé API Anthropic avec accès beta `skills-2025-10-02`.

Proposition d'étapes (non exécutées) :

- [ ] Mesurer le coût actuel : compter les tokens de `CLAUDE_MD_TEMPLATE` (`cli/init.ts:10`) et de `INSTRUCTIONS` (`cli/channel.ts:152`) avec l'endpoint de comptage de tokens, et les rapporter au contexte d'un tour typique.
- [ ] Extraire le protocole en un `SKILL.md` unique et vérifier qu'un agent Claude Code muni de cette skill (et sans la section CLAUDE.md) appelle bien `register_agent` puis `announce_work` avant une modification de fichier — sur le vrai serveur, pas en théorie.
- [ ] Vérifier que le dossier `SKILL.md` est téléversable tel quel via `POST /v1/skills`, et si l'exécution en Messages API impose réellement un outil `code_execution` alors que notre skill ne contient aucun script.
- [ ] Tester le cas dégradé : un client MCP non-Anthropic (SDK maison, `sdk/src/client.ts`) qui ne connaît ni skills ni `CLAUDE.md` — la coordination reste-t-elle utilisable avec les seules descriptions d'outils ?
- [ ] Comparer, sur le même scénario, la variante MCP Resources de A09, pour trancher les deux fiches d'un seul mouvement.

### 6.4 Résultat observé

#### A. La question de §6.1 est déjà tranchée, et par le même contenu source

`A09` §7.2 ne se contente pas d'adopter « des Resources » : elle **nomme le contenu de E13**.

> « 1. **Servir la doctrine d'annonce comme Resource lecture seule** sous `coord://`, via `registerResource` … **Contenu source : le `CLAUDE_MD_TEMPLATE` de `cli/init.ts` (3 921 octets, mesurés).** … **C'est le périmètre de #281**, qui cherchait un propriétaire — A09 le lui apporte.
> 2. **L'amorcer depuis `instructions`** — une phrase générique de **150 octets** suffit (bras D, **3/3**) …
> 3. **Réduire le `CLAUDE.md` écrit par `init` à un pointeur. Non négociable** … une ressource servie par le daemon est **verrouillée sur sa version**, là où un `CLAUDE.md` est **figé à l'init**. »

Donc : même contenu, même objectif (retirer la doctrine du `CLAUDE.md`), tranché le 2026-08-15 sur du **MCP cœur GA et portable**, avec un amorçage mesuré à **150 octets** et un propriétaire. **K4 se déclenche.**

*Nuance à ne pas rater :* le **corps** de #281 ne parle que d'exposition d'**état** (`coord://<org>/agents`, `/working-files`, `/threads/<id>`) et dit même qu'« A09 ne parle de `resources/read` que comme véhicule de skills ». La couche doctrine a été ajoutée par le **commentaire** d'A09 sur l'issue, pas par l'issue telle que déposée. C'est le commentaire qu'il faut citer.

#### B. Le refus doit être scindé — et les deux moitiés meurent pour des raisons différentes

§6.1 empaquette deux choses : (a) un dossier `SKILL.md` **livré dans le paquet npm**, et (b) une publication via `POST /v1/skills`. Elles n'ont pas les mêmes coûts.

**(b) meurt sur ses prérequis** : header beta `skills-2025-10-02` toujours requis dix mois après le lancement, outil `code_execution` **obligatoire** pour une skill purement textuelle, verrouillage plateforme, et une clé API **de l'utilisateur** pour publier. **K5 et K6 ne s'appliquent qu'à (b).**

**(a) meurt sur un point que je n'avais pas vu, et qui est plus fort que mes critères.** Claude Code découvre les skills dans `~/.claude/skills/`, à la racine du projet, dans les sous-dossiers imbriqués, les plugins et la politique d'entreprise — **jamais dans `node_modules/`**. Un dossier `skills/` livré par npm n'est donc **pas un emplacement de découverte** : il faut que quelque chose le recopie dans `.claude/`. Et ce quelque chose, c'est `mcp-coordinator init`.

**Autrement dit, (a) a exactement le même véhicule et exactement le même défaut que le `CLAUDE.md` qu'elle prétend remplacer** : figée à l'init, condamnée à dériver du daemon qui tourne, et Claude-only jusque dans le nom du répertoire. C'est précisément ce qu'A09 §7.2 point 3 appelle le seul gain durable de la voie Resources — « verrouillée sur sa version par construction » contre « figé à l'init ».

Corollaire : **le bénéfice « mise à jour » de §4 appartient uniquement à (b)** (`/v1/skills/{id}/versions`). La moitié npm hérite du problème que §4 dénonce.

Pour être juste, le coût permanent de (a) est faible : seules les descriptions sont préchargées, le corps n'est injecté qu'à l'invocation. La cherté n'est pas le problème — **le canal l'est.**

#### C. L'argument le plus fort est dans le fichier que la fiche ne mentionne pas

`src/mcp-instructions.ts:10-13` porte la mesure verbatim :

> « the same imperative wording, **word for word, fires 0/3 from a tool DESCRIPTION** (deferred or fully loaded) **and 5/5 from here**. **The channel is the variable, not the prose.** Making the sentences louder is not the lever. »

Et `C06` a mesuré `instructions` seul à 0/3 sur l'écriture immédiate, le remède étant `MCP_CONNECTION_NONBLOCKING=0` + `instructions` = **3/3 pour +678 tokens**.

Une skill est un **quatrième canal**, et il est **plus loin du modèle** qu'`instructions` — qui est préchargé, là où le corps d'une skill n'est injecté que si le modèle **décide** de l'invoquer. Sur l'axe de mesure du dépôt lui-même, la skill se déplace donc **dans le mauvais sens**. C'est l'argument décisif contre E13, et il ne figure pas dans la fiche.

Note : `tests/unit/mcp-instructions.test.ts:125` épingle `MCP_INSTRUCTIONS ≤ 2048` octets ; à 1 350 octets il reste **698** octets, donc les 150 octets d'amorçage d'A09 rentrent avec 548 de marge.

#### D. Le poids réel de la doctrine — et il y a six surfaces, pas trois

```
cli/init.ts CLAUDE_MD_TEMPLATE               3 895 car. (3 921 octets) |  80 lignes
src/tools/*.ts  66 .describe()               4 578 car.                | ~1 145 tokens
src/tools/*.ts  26 description: (niveau outil) 1 520 car.              |   ~380 tokens
src/mcp-instructions.ts MCP_INSTRUCTIONS     1 348 car. (1 350 octets) |  14 lignes
cli/channel.ts INSTRUCTIONS                  1 194 car.                |  22 entrées
docs/usage.md l.134-136                      protocole numéroté en 5 étapes
```

**K2 se déclenche** : `CLAUDE_MD_TEMPLATE` pèse ~1 000 tokens (**1 089** au ratio de 3,6 o/token que `C06` a mesuré pour de la prose). **K3 se déclenche** : six surfaces.

**Correction de mon propre comptage :** j'avais mesuré les `.describe()` à **3 989** caractères — sous-compté de ~589, mon motif ratant les appels multilignes. Le chiffre juste est **4 578**. Et j'avais oublié entièrement les 26 `description:` de niveau outil. Par ailleurs A09 et #281 citent « 3 921 **octets** » pour le même texte que je mesure à 3 895 **caractères** : le fichier est en CRLF, ce n'est pas une contradiction mais une différence d'unité — à ne pas présenter comme un écart.

#### E. Ce que je retire — deux accusations infondées

J'allais reprocher deux choses à la fiche. Les deux sont **injustes**, et la vérification par les dates le montre :

- **« La fiche oublie `src/mcp-instructions.ts` »** — faux. `git log --diff-filter=A` : le fichier a été **créé le 2026-08-15 à 18:42** par « feat(mcp): declare server instructions so the announce workflow is discoverable (#297) », soit **un jour après** la vérification §0 du 2026-08-14. La fiche ne l'a pas manqué : il n'existait pas.
- **« `cli/channel.ts:152` et `:318` sont faux »** — faux aussi. `git show 4f62056^:cli/channel.ts` donne `const INSTRUCTIONS = [` en **152** et `instructions: INSTRUCTIONS,` en **318**, exactement comme la fiche l'écrit. Le commit `4f62056` du 2026-08-15 (migration vers `@modelcontextprotocol/{core,server,node,client}@2`) les a déplacés en **151** et **321**. C'est une dérive de dépendance en 24 heures, pas un défaut de vérification — et confondre les deux serait refaire la sur-affirmation d'`E12`.

**Les erreurs qui restent, elles, sont réelles :**

| §4 / §5 affirme | Réel |
|---|---|
| le flag `--claude-md` | **`--write-claude-md`** (`cli/init.ts:105`, utilisé `:253`, `:254`, `:294`) |
| `CLAUDE_MD_TEMPLATE` « environ 90 lignes » | **80** — et `C01` §0 avait **déjà corrigé cette ancre exacte** (« s'étend de la ligne 10 à la ligne 89 »), sans que E13 la reprenne |

**Et une victime de §0 que personne n'avait relevée**, qui touche `A09` plus fort qu'E13 : le paquet monolithique `@modelcontextprotocol/sdk` **n'existe plus**. `package.json:82-85` déclare désormais `@modelcontextprotocol/{server,node,client,core}: ^2.0.0`. Vérifié : `registerResource` survit dans `server@2.0.0`, donc la base technique d'`A09(c)` tient — mais **toutes les citations `sdk/dist/esm/…` d'A09 §6.4/§7.2 et du commentaire #281 pointent vers un paquet qui n'est plus installé.**

#### F. Adjudication des six critères

| # | Seuil | Mesure | Verdict |
|---|---|---|---|
| **K1** | la doctrine est en position cacheable, pas réinjectée par tour | **conclusion juste, mécanisme faux.** Un `CLAUDE.md` n'est **pas** un préfixe système caché : il est « delivered as a **user message after the system prompt** ». Il **est** réinjecté depuis le disque après un `/compact`. Formulation honnête : **payé une fois par session, en position cacheable de message user, plus une fois par compaction — pas par tour** | **SE DÉCLENCHE** — §4 a tort en écrivant « chaque tour », mais pas pour la raison que j'avais avancée |
| **K2** | `CLAUDE_MD_TEMPLATE` < 2 000 tokens | **~1 000** (1 089 au ratio mesuré par `C06`) | **SE DÉCLENCHE** |
| **K3** | ≥ 4 copies existantes | **six surfaces** | **SE DÉCLENCHE** |
| **K4** | `A09(c)` adoptée, avec propriétaire | adoptée le **2026-08-15**, nommant `CLAUDE_MD_TEMPLATE` comme contenu source, périmètre dans **#281** | **SE DÉCLENCHE — c'est le critère décisif** |
| **K5** | `code_execution` obligatoire | confirmé par §2/§0 — **mais ne vaut que pour (b)** | **SE DÉCLENCHE pour (b) seulement** |
| **K6** | credentials utilisateur requis | `POST /v1/skills` — **(b) seulement**. Pour **(a)**, le blocage est différent et pire : `node_modules/` **n'est pas un emplacement de découverte** de skills | **SE DÉCLENCHE pour les deux, pour deux raisons distinctes** |

**Six critères sur six se déclenchent**, dont deux avec une portée à scinder entre (a) et (b).

### 6.5 Contre-arguments

- **Dépendance à une beta qui dure.** Le header `anthropic-beta: skills-2025-10-02` est toujours requis dix mois après le lancement. Une surface beta durable est une surface qui peut encore bouger, et le projet devrait suivre ces changements sans contrepartie fonctionnelle.
- **Verrouillage plateforme.** mcp-coordinator se veut serveur MCP portable (voir C12, matrice de portabilité). Les skills Messages API sont une primitive Anthropic ; les distribuer comme canal principal de la doctrine dégrade l'expérience de tout client non-Claude. La variante SEP-2640 (A09) est plus alignée avec ce positionnement, mais elle est *experimental*, donc moins mûre.
- **Exigence de `code_execution` disproportionnée.** Sur la Messages API, activer une skill impose un outil d'exécution de code dans le conteneur. Pour une skill purement textuelle, c'est une dépendance lourde et une surface d'exécution supplémentaire que beaucoup d'auto-hébergeurs refuseront.
- **Coût de maintenance réel.** Une quatrième représentation du protocole s'ajoute aux trois existantes tant que le `CLAUDE.md` n'est pas supprimé. Sans génération à partir d'une source unique, on aggrave le problème de dérive au lieu de le résoudre.
- **YAGNI.** Le gain est un gain de tokens de contexte, pas une capacité nouvelle. Personne n'a signalé que la section `CLAUDE.md` posait problème. Le bénéfice mesurable doit être établi (étape 6.3.1) avant d'engager le travail.
- **Distribution.** Publier une skill custom suppose une clé API et un compte Anthropic côté utilisateur ; ce n'est pas un artefact que le projet peut livrer une fois pour toutes comme il livre un paquet npm.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** (les deux volets, pour deux raisons distinctes) |
| **Date** | 2026-08-17 |
| **Justification** | **Six critères sur six se déclenchent, et le refus doit être scindé.** ⭑ **K4 est décisif : la question de §6.1 est déjà tranchée, par le même contenu source.** `A09` §7.2 (2026-08-15) adopte « servir la doctrine d'annonce comme Resource lecture seule sous `coord://` », en nommant explicitement **« Contenu source : le `CLAUDE_MD_TEMPLATE` de `cli/init.ts` (3 921 octets, mesurés) »**, avec un amorçage mesuré à **150 octets** dans `instructions` (bras D, **3/3**) et la réduction du `CLAUDE.md` à un pointeur déclarée **« non négociable »**. Périmètre versé dans **#281**. C'est du **MCP cœur, GA, portable** — là où les skills sont une primitive Anthropic sous header beta. ⭑ **Refusé — (b) la publication via `POST /v1/skills`** : header beta `skills-2025-10-02` toujours requis dix mois après le lancement, outil `code_execution` **obligatoire** pour une skill purement textuelle, verrouillage plateforme, et une clé API **de l'utilisateur** pour publier. ⭑ **Refusé — (a) le `SKILL.md` livré dans le paquet npm**, pour une raison que je n'avais pas vue et qui est plus forte : Claude Code découvre les skills dans `~/.claude/skills/`, à la racine du projet, les sous-dossiers, les plugins et la politique d'entreprise — **jamais dans `node_modules/`**. Le seul véhicule de livraison est donc `mcp-coordinator init` écrivant dans `.claude/`, **c'est-à-dire exactement le mécanisme et exactement le défaut du `CLAUDE.md` qu'elle prétend remplacer** : figée à l'init, condamnée à dériver du daemon. Et le bénéfice « mise à jour » de §4 appartient **uniquement à (b)**. ⭑ **L'argument le plus fort est dans le fichier que la fiche ne mentionne pas.** `src/mcp-instructions.ts:10-13` : « the same imperative wording, **word for word, fires 0/3 from a tool DESCRIPTION** and **5/5 from here**. **The channel is the variable, not the prose.** » Une skill est un **quatrième canal, plus loin du modèle** qu'`instructions` — préchargé, là où le corps d'une skill n'arrive que si le modèle **décide** de l'invoquer. Sur l'axe de mesure du dépôt lui-même, elle se déplace **dans le mauvais sens**. **Corrections de méthode.** **Mon mécanisme sur K1 était faux** : un `CLAUDE.md` n'est pas un préfixe système caché mais « delivered as a **user message after the system prompt** », et il **est** réinjecté depuis le disque après un `/compact`. La conclusion tient (§4 a tort d'écrire « chaque tour ») mais la formulation juste est : **une fois par session, en position cacheable, plus une fois par compaction**. **Mon comptage des `.describe()` était sous-compté** de ~589 caractères (3 989 → **4 578**, mon motif ratant les appels multilignes), et j'avais oublié les **26 `description:`** de niveau outil (1 520 car.). ⭑ **Et je retire deux accusations infondées contre la fiche** : `src/mcp-instructions.ts` a été **créé le 2026-08-15 à 18:42**, un jour *après* la vérification §0 — la fiche ne l'a pas manqué, il n'existait pas ; et `cli/channel.ts:152`/`:318` étaient **exacts** le 2026-08-14, déplacés en 151/321 par la migration `@modelcontextprotocol/*@2` du lendemain. Confondre une dérive de dépendance avec un défaut de vérification serait refaire la sur-affirmation d'`E12`. |
| **Issue / PR** | Aucune issue neuve — le périmètre appartient à **#281**, qu'`A09` a déjà doté d'un propriétaire. **Signalé sur #281 :** ses citations et celles d'`A09` §6.4/§7.2 pointent vers `@modelcontextprotocol/sdk`, paquet **désinstallé** depuis la migration vers `@modelcontextprotocol/{core,server,node,client}@2.0.0` (`package.json:82-85`) ; `registerResource` survit dans `server@2.0.0`, donc la base technique d'`A09(c)` tient, mais les chemins cités sont périmés. |
| **Jalon visé** | Aucun pour les skills. **La suite appartient à `A09(c)` / #281**, derrière `C06`/#271 dont elle dépend. Erreurs de la fiche à recaler : le flag est `--write-claude-md` (pas `--claude-md`), et `CLAUDE_MD_TEMPLATE` fait **80** lignes (pas « environ 90 ») — ancre que `C01` §0 avait déjà corrigée sans qu'E13 la reprenne. |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : API et statut beta confirmés ; marqueur portabilité SKILL.md tranché ; lignes `init.ts` corrigées. |
| 2026-08-17 | **Challenge — verdict `refuser` les deux volets, pour deux raisons distinctes ; six critères sur six se déclenchent.** **K4 est décisif : §6.1 est déjà tranchée, par le même contenu source.** `A09` §7.2 (2026-08-15) adopte « servir la doctrine d'annonce comme Resource lecture seule sous `coord://` » en nommant explicitement **« Contenu source : le `CLAUDE_MD_TEMPLATE` de `cli/init.ts` (3 921 octets, mesurés) »**, avec un amorçage mesuré à **150 octets** dans `instructions` (bras D, 3/3) et la réduction du `CLAUDE.md` à un pointeur déclarée **« non négociable »**. Périmètre dans **#281**. Nuance : le *corps* de #281 ne parle que d'état (`coord://<org>/agents`…) — la couche doctrine a été ajoutée par le **commentaire** d'A09, c'est lui qu'il faut citer. **Refusé (b)** — `POST /v1/skills` : header beta toujours requis dix mois après, `code_execution` **obligatoire** pour une skill textuelle, verrouillage plateforme, clé API de l'utilisateur. **Refusé (a)** — le `SKILL.md` livré par npm, pour une raison que je n'avais pas vue : Claude Code découvre les skills dans `~/.claude/skills/`, la racine du projet, les sous-dossiers, les plugins et la politique d'entreprise — **jamais dans `node_modules/`**. Le seul véhicule est donc `init` écrivant dans `.claude/`, **exactement le mécanisme et le défaut du `CLAUDE.md` qu'elle remplace** : figée à l'init, condamnée à dériver. Et le bénéfice « mise à jour » de §4 appartient **uniquement à (b)**. **L'argument le plus fort est dans le fichier que la fiche ne mentionne pas** : `src/mcp-instructions.ts:10-13` — « the same imperative wording, word for word, **fires 0/3 from a tool DESCRIPTION and 5/5 from here. The channel is the variable, not the prose.** » Une skill est un quatrième canal, **plus loin du modèle** qu'`instructions` (préchargé) : sur l'axe de mesure du dépôt, elle va dans le mauvais sens. **Poids réel : six surfaces, pas trois** — `CLAUDE_MD_TEMPLATE` 3 895 car./3 921 o/80 lignes, 66 `.describe()` **4 578** car., 26 `description:` 1 520 car., `MCP_INSTRUCTIONS` 1 348 car., `INSTRUCTIONS` 1 194 car., et le protocole numéroté de `docs/usage.md:134-136`. **Corrections de méthode :** mon **mécanisme** sur K1 était faux — un `CLAUDE.md` n'est pas un préfixe système caché mais « delivered as a **user message after the system prompt** », et il **est** réinjecté après un `/compact` ; la formulation juste est « une fois par session, en position cacheable, plus une fois par compaction » (la conclusion tient : §4 a tort d'écrire « chaque tour »). Mon comptage des `.describe()` était **sous-compté de ~589 car.** (motif ratant les appels multilignes) et j'avais oublié les 26 `description:`. **Et je retire deux accusations infondées** : `src/mcp-instructions.ts` a été **créé le 2026-08-15 18:42**, un jour *après* §0 — la fiche ne l'a pas manqué, il n'existait pas ; et `cli/channel.ts:152`/`:318` étaient **exacts** le 2026-08-14, déplacés par la migration `@modelcontextprotocol/*@2` du lendemain. Erreurs réelles restantes : le flag est **`--write-claude-md`**, et le template fait **80** lignes — ancre que `C01` §0 avait déjà corrigée sans qu'E13 la reprenne. **Victime de §0 signalée sur #281** : le paquet `@modelcontextprotocol/sdk` n'est plus installé, donc toutes les citations `sdk/dist/esm/…` d'`A09` et de #281 sont périmées ; `registerResource` survit dans `server@2.0.0`, la base technique tient. |
