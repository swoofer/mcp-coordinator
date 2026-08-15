# E06 — Outcomes et rubriques : remplacer le score opaque de plan-quality

| Champ | Valeur |
|---|---|
| **ID** | `cma-outcomes-rubrics` |
| **Surface** | managed-agents |
| **Statut** | beta (public beta, pas de GA au 2026-08-14) |
| **Disponible depuis** | `2026-05-19` (annonce blog ; plusieurs sources tierces datent la mise en dispo du 2026-05-06) |
| **Tier** | T3-à-surveiller |
| **Nature** | replace-homemade-code |
| **Effort estimé** | M |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — API outcomes hors de portée ; heuristique locale rejouable |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** ✅ saine

**Corrections apportées :**
- §2 : le payload du webhook `session.outcome_evaluation_ended` ne se limite pas à `{type, id}` — le bloc
  `data` porte aussi `organization_id` et `workspace_id` (la fiche avait raison sur le fond : ce n'est pas
  l'objet complet, il faut refetcher).
- §5 : le commentaire « forme volontairement divergente » de `src/http/rest-handlers.ts` est aux
  lignes **250-251**, pas 251-252.

Tout le reste de §2 est confirmé mot pour mot par `platform.claude.com/docs/en/managed-agents/define-outcomes`,
`/reference` et `/webhooks` : header `managed-agents-2026-04-01` (memory store = `agent-memory-2026-07-22`),
événement `user.define_outcome`, `rubric` obligatoire en `{type:"text"|"file"}`, `max_iterations` défaut 3 /
max 20, les trois `span.outcome_evaluation_*`, les cinq valeurs de `result` (seul `needs_revision` non
terminal), `failed` = « la rubrique ne s'applique pas aux livrables », `iteration` 0-indexé,
`outcome_evaluation_start_id` vide sur interruption précoce, polling `GET /v1/sessions/{id}` →
`outcome_evaluations[].result` (`pending|running|evaluating`), livrables via `/mnt/session/outputs/` puis
`GET /v1/files?scope_id=`, et les noms de types SDK `BetaManagedAgentsUserDefineOutcomeEventParams`,
`BetaManagedAgentsTextRubricParams`, `BetaManagedAgentsFileRubricParams`. L'ordre de livraison non garanti
entre `session.status_idled` et `session.outcome_evaluation_ended` est bien documenté tel quel. Statut
**beta** confirmé au 2026-08-14 : aucune mention de GA dans la doc.

Côté repo, les 9 points de §5 ont été rouverts un par un : tous les fichiers existent et, à l'exception
corrigée ci-dessus, tous les numéros de ligne pointent sur ce que la fiche décrit —
`plan-quality.ts` fait bien 48 lignes avec les regex en l.25 / l.32-33 / l.37,
`announce-workflow.ts:159` / `:183` / `:210`, `consultation-tools.ts:42-45` / `:154-156`,
`rest-handlers.ts:269-271`, `types.ts:94-110` (pas de variante `plan_quality` dans `EventType`),
`dashboard.js:165-172`, `12-code-quality.md:44`, 8 tests dans `plan-quality.test.ts`,
`s2-announce-workflow.test.ts:148` et `:175`, et A03 désigne bien `assessPlanQuality()` comme second
candidat au gate (l.177).

**Marqueurs `(à vérifier)` restants :** aucun

**Testabilité :** ⚠️ partielle
Les trois premiers points du protocole §6.3 sont exécutables ici sans rien d'autre que le repo : rejouer
`pnpm vitest run tests/unit/plan-quality.test.ts` et passer un échantillon de `threads.plan` (base SQLite
locale) dans `assessPlanQuality()` pour mesurer le taux de faux `discovery`, puis tracer `planQuality` sur
les deux transports. En revanche l'API outcomes elle-même n'est pas atteignable : elle exige une clé API
Anthropic avec le beta `managed-agents-2026-04-01`, plus un agent et un environnement provisionnés côté
Anthropic — donc ni le comportement réel du grader, ni le coût/latence d'un juge LLM (4ᵉ point) ne peuvent
être mesurés sur ce poste.

---

## 1. Ce que c'est

Les *outcomes* de Claude Managed Agents formalisent la notion de « travail fini » : on envoie à une session
un événement `user.define_outcome` qui porte une `description` (lue par l'agent qui produit) et une `rubric`
(lue par un **grader séparé**, exécuté dans un contexte isolé auto-provisionné par le harness). La rubrique
est un document markdown : chaque critère y est noté indépendamment, et le grader renvoie un verdict typé
plus une `explanation` en texte libre. Si le verdict est `needs_revision`, l'agent révise et le cycle
recommence jusqu'à satisfaction ou épuisement de `max_iterations` (défaut 3, max 20). La rubrique peut être
passée inline (`{type:"text", content}`) ou référencée via la Files API (`{type:"file", file_id}`) pour être
réutilisée d'une session à l'autre. Un seul outcome est actif à la fois, mais on peut les chaîner en
renvoyant un `user.define_outcome` après le span terminal. La progression est observable soit par span events
(`span.outcome_evaluation_start` / `_ongoing` / `_end`), soit en pollant `GET /v1/sessions/{id}` et en lisant
`outcome_evaluations[].result`. C'est structurellement le même pattern que `assessPlanQuality()` dans
mcp-coordinator — une définition de « fini » évaluée par un juge séparé — sauf que le juge y est trois
regex et le verdict un entier 0-3 sans explication.

## 2. Surface d'API exacte

```
header beta          : anthropic-beta: managed-agents-2026-04-01
                       (les endpoints memory store utilisent agent-memory-2026-07-22)
événement            : POST /v1/sessions/{session_id}/events   type = "user.define_outcome"
                       (ou dans initial_events à la création de session)
champs               : description (string), rubric (OBLIGATOIRE), max_iterations (défaut 3, max 20)
rubric               : {type:"text", content:"..."} | {type:"file", file_id:"file_01..."}
span events          : span.outcome_evaluation_start | _ongoing | _end
result ∈            : satisfied | needs_revision | max_iterations_reached | failed | interrupted
polling              : GET /v1/sessions/{session_id} → outcome_evaluations[].outcome_id / .result
                       (.result transitoire : pending | running | evaluating)
webhook              : session.outcome_evaluation_ended
                       (data = {type, id, organization_id, workspace_id} — pas l'objet complet)
SDK                  : client.beta.sessions.events.send(...) / client.beta.sessions.retrieve(...)
                       client.beta.files.upload(...) pour la rubrique réutilisable
types SDK            : BetaManagedAgentsUserDefineOutcomeEventParams
                       BetaManagedAgentsTextRubricParams / BetaManagedAgentsFileRubricParams
livrables            : /mnt/session/outputs/ → GET /v1/files?scope_id={session_id}
```

```json
{
  "type": "user.define_outcome",
  "description": "Produire le rapport trimestriel",
  "rubric": { "type": "text", "content": "# Critères\n- [ ] cite les fichiers touchés\n- [ ] ..." },
  "max_iterations": 5
}
```

`span.outcome_evaluation_end` porte `id`, `outcome_evaluation_start_id`, `outcome_id`, `result`,
`explanation`, `iteration`, `usage`, `processed_at`. `iteration` est **0-indexé** (0 = première évaluation).
Seul `needs_revision` est non terminal ; les quatre autres valeurs terminent le cycle. Sémantique de `failed`
plus étroite qu'il n'y paraît : « la rubrique ne s'applique pas aux livrables » (description et rubrique
se contredisent, par exemple), pas « l'agent a échoué ». `user.interrupt` produit `result: "interrupted"`
et un `outcome_evaluation_start_id` vide si aucune évaluation n'avait démarré. Le webhook ne transporte que
le type et l'id, sans garantie d'ordre de livraison (`session.status_idled` peut arriver avant) : il faut
refetcher la ressource.

## 3. Sources

- https://platform.claude.com/docs/en/managed-agents/define-outcomes
- https://platform.claude.com/docs/en/managed-agents/reference
- https://claude.com/blog/new-in-claude-managed-agents

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
`src/plan-quality.ts` fait 48 lignes et produit un `score: 0-3` calculé par trois regex : présence d'un
chemin de fichier, présence d'un verbe d'action dans une liste FR/EN codée en dur
(`/\b(ajout|cré|creat|add|split|extract|replac|…)/i`), et « plus de 20 mots ». Un plan en espagnol, ou un
plan précis qui n'emploie aucun de ces stems, tombe en `mode: "discovery"` sans que l'agent sache pourquoi
autrement que par la chaîne bricolée de `planDowngradeReason()` (`"plan downgraded: score 2/3 — no files
vague approach"`). Le modèle outcome fournit trois choses transposables directement, **sans appeler l'API
Anthropic** : (a) une rubrique markdown **fournie par l'utilisateur** au lieu d'heuristiques codées en dur —
chaque équipe définit ce qu'est un bon plan pour son repo ; (b) un verdict typé et une `explanation` en
langage naturel à la place d'un entier opaque, ce qui rend le `mode: "discovery"` actionnable pour l'agent
qui vient d'appeler `announce_work` ; (c) un compteur d'itérations borné, absent aujourd'hui — un plan
dégradé n'est jamais re-soumis, l'événement SSE est purement informatif et le workflow continue.

Le bénéficiaire direct est l'agent appelant `announce_work` (il apprend *quoi corriger*) et le lead qui lit
le dashboard : `dashboard/public/dashboard.js:165-172` affiche aujourd'hui `✓ fichiers, ✗ approche vague,
✗ trop court` — trois booléens gravés dans le HTML du dashboard, qui deviendraient une liste de critères
paramétrable. Un point de vocabulaire à ne pas copier tel quel : `failed` chez Anthropic signifie « rubrique
inapplicable », pas « plan mauvais » ; le reprendre littéralement dans mcp-coordinator serait un contresens.

**Risque si on ne fait rien :** faible. `plan-quality` est informatif, aucun *gate* n'en dépend
(cf. A03). Le risque réel est la stagnation : le score 0-3 est déjà cité par la fiche A03 comme
candidat au *gate* `input_required` ; le promouvoir en garde-fou alors qu'il repose sur une liste de
verbes FR/EN codée en dur serait un « garde-fou fantôme » de plus.

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/plan-quality.ts` | Cœur de la refonte. `PlanQualityResult` (`mode`, `score: 0-3`, `checks{3 booléens}`, `original_plan`) devient un verdict typé + critères nommés + explication. Les trois regex (l.25, l.32-33, l.37) disparaissent au profit de critères déclaratifs. |
| `src/announce-workflow.ts` | `assessPlanQuality(params.plan)` l.159 ; `planDowngradeReason()` l.210-216 construit la chaîne de raison à partir des trois booléens — à réécrire sur la nouvelle forme. `planQuality` est retourné par `runCommonAnnounceFlow()` (l.183) donc les deux transports suivent. |
| `src/tools/consultation-tools.ts` | `announce_work` : description du paramètre `plan` l.42-45 (« used for plan-quality scoring ») ; `mode: planQuality.mode` et `plan_quality: planQuality` dans l'événement SSE `thread_opened` l.154-156. Le verdict n'est pas renvoyé dans la réponse de l'outil aujourd'hui — c'est un manque à combler si on veut que l'agent puisse réviser. |
| `src/http/rest-handlers.ts` | Chemin REST `/api/announce` : même `plan_quality` dans le `thread_opened` l.269-271, forme volontairement divergente du chemin MCP (commentaire l.250-251). Toute évolution du type doit toucher les deux. |
| `src/types.ts` | `EventType` (l.94-110) ne contient pas de variante `plan_quality` : `announce-workflow.ts:162-170` émet un `impact_scored` avec `category: "plan_quality"` via double cast `as`. Déjà signalé par l'audit interne (`docs/superpowers/working/audit/code/12-code-quality.md:44`). Une refonte est l'occasion d'ajouter un vrai `EventType`. |
| `dashboard/public/dashboard.js` | l.165-172 : rendu des trois booléens en dur (`✓ fichiers` / `✓ approche concrète` / `✓ détaillé`) et de `q.score/3`. À rendre générique sur une liste de critères. |
| `tests/unit/plan-quality.test.ts` | 8 tests, tous écrits contre `score` et les trois clés de `checks`. Réécriture complète. |
| `tests/unit/s2-announce-workflow.test.ts` | l.148 et l.175 : assertion sur l'émission de l'événement de dégradation et sur `parsed.category === "plan_quality"`. |
| `research/claude-features/A03-mrtr-input-required.md` | Fiche voisine : y désigne `assessPlanQuality()` comme second candidat au *gate* `input_required`. Les deux décisions sont couplées. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> La rubrique de qualité de plan doit-elle devenir un document markdown fourni par l'utilisateur
> (par org, versionné dans le repo, à la manière de `rubric: {type:"file"}`), ou reste-t-elle une liste
> de critères codés en dur dans `plan-quality.ts` — et si elle devient paramétrable, qui l'évalue :
> des règles déterministes lisibles côté serveur, ou un juge LLM appelé par le coordinateur, ce qui
> introduirait une dépendance API sortante dans un serveur MCP jusqu'ici hors ligne ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

> ⚠️ L'API outcomes n'est pas exécutable ici : clé API + beta `managed-agents-2026-04-01` + agent et
> environnement provisionnés côté Anthropic. Seuls les points portant sur le code local sont jouables.

Proposition de protocole (non exécuté) :

- [ ] Rejouer les 8 cas de `tests/unit/plan-quality.test.ts` et un échantillon de plans réels
      (extraits de la table `threads`, colonne `plan`) contre `assessPlanQuality()` pour mesurer
      le taux de faux `discovery` — combien de plans corrects tombent à cause des seuls stems FR/EN.
- [ ] Écrire à la main une rubrique markdown de 4-6 critères pour ce repo et vérifier, sur le même
      échantillon, si un jugement humain contre cette rubrique diverge du score 0-3 actuel.
- [ ] Tracer le chemin de `planQuality` de `runCommonAnnounceFlow()` jusqu'au dashboard sur les DEUX
      transports (MCP `consultation-tools.ts` et REST `rest-handlers.ts`) et lister ce qui casse si
      `PlanQualityResult.checks` change de forme.
- [ ] Mesurer le coût d'un verdict par juge LLM (latence ajoutée à `announce_work`, tokens) avant de
      décider s'il peut se trouver sur le chemin synchrone de l'annonce.
- [ ] Vérifier avec A03 si un verdict typé change quelque chose au *gate* `input_required`, ou si le
      couplage est illusoire.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Ce n'est pas une API qu'on peut appeler.** Le champ `relevance: replace-homemade-code` du bundle est
  trompeur et le vérificateur le dit explicitement : les outcomes sont liés aux sessions Managed Agents
  hébergées (sandbox, environnement, agent provisionné par Anthropic). mcp-coordinator ne peut pas
  « remplacer `plan-quality` par cette API » — au mieux il en copie le modèle de design. La fiche est donc
  plus proche d'un `opportunity` que d'un `replace-homemade-code`.
- **Beta, sans GA.** Header `managed-agents-2026-04-01` toujours en public beta au 2026-08-14. Copier
  aujourd'hui un vocabulaire (`needs_revision`, `max_iterations_reached`) qui peut bouger avant GA fige un
  contrat public — `plan_quality` est déjà exposé dans deux payloads SSE et lu par le dashboard.
- **Dépendance API sortante.** Si la refonte va jusqu'au juge LLM, mcp-coordinator cesse d'être un serveur
  local sans réseau sortant : clé API à configurer, latence sur le chemin d'`announce_work`, coût par
  annonce, comportement dégradé hors ligne. Pour un auto-hébergeur c'est une régression nette.
- **YAGNI.** `plan-quality` est purement informatif : aucun *gate* n'en dépend, aucun workflow ne bloque
  sur `mode: "discovery"`, et l'itération/révision — le cœur de la valeur des outcomes — n'existe pas
  côté coordinateur. Refondre le verdict d'un signal que personne ne consomme pour décider est un
  investissement difficile à justifier avant que A03 ne tranche l'usage en *gate*.
- **Effort sous-estimé.** L'effort `M` du bundle vaut pour « refonte d'API interne inspirée du modèle ».
  Le tableau §5 liste 9 points de contact, dont deux transports à contrat divergent assumé, un dashboard
  avec les critères en dur et deux fichiers de tests à réécrire. `M` est un plancher, pas une estimation.
- **Une rubrique paramétrable, c'est de la configuration à maintenir.** Aujourd'hui `plan-quality` marche
  sans réglage. Une rubrique par org signifie : où la stocker, comment la valider, que faire si elle est
  absente ou incohérente, comment la migrer. C'est de la surface de support pour un solo maintainer.

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
| 2026-08-14 | Vérification des faits : §2 confirmée par la doc, 2 corrections mineures (payload webhook, ligne 250-251). |
