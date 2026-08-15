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
| **Statut du challenge** | ⬜ à faire |

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

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

> ⚠️ Le volet Messages API (`POST /v1/skills`, `container.skills[]`, outil `code_execution`) n'est pas exécutable ici : pas de clé API Anthropic avec accès beta `skills-2025-10-02`.

Proposition d'étapes (non exécutées) :

- [ ] Mesurer le coût actuel : compter les tokens de `CLAUDE_MD_TEMPLATE` (`cli/init.ts:10`) et de `INSTRUCTIONS` (`cli/channel.ts:152`) avec l'endpoint de comptage de tokens, et les rapporter au contexte d'un tour typique.
- [ ] Extraire le protocole en un `SKILL.md` unique et vérifier qu'un agent Claude Code muni de cette skill (et sans la section CLAUDE.md) appelle bien `register_agent` puis `announce_work` avant une modification de fichier — sur le vrai serveur, pas en théorie.
- [ ] Vérifier que le dossier `SKILL.md` est téléversable tel quel via `POST /v1/skills`, et si l'exécution en Messages API impose réellement un outil `code_execution` alors que notre skill ne contient aucun script.
- [ ] Tester le cas dégradé : un client MCP non-Anthropic (SDK maison, `sdk/src/client.ts`) qui ne connaît ni skills ni `CLAUDE.md` — la coordination reste-t-elle utilisable avec les seules descriptions d'outils ?
- [ ] Comparer, sur le même scénario, la variante MCP Resources de A09, pour trancher les deux fiches d'un seul mouvement.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

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
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ⬜ refuser |
| **Date** | |
| **Justification** | |
| **Issue / PR** | |
| **Jalon visé** | |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : API et statut beta confirmés ; marqueur portabilité SKILL.md tranché ; lignes `init.ts` corrigées. |
