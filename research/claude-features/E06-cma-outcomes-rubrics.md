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
| **Statut du challenge** | ✅ **tranché** (2026-08-17) — adopter partiellement : rendre le verdict à l'agent (4 lignes), refuser la refonte (#351) |

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

**Ce que je pense avant de mesurer.** `assessPlanQuality()` (48 lignes, `src/plan-quality.ts`) est un « garde-fou fantôme » en puissance : trois regex dont deux sont manifestement fragiles à la lecture.

- `mentions_files` = `/\w+\/\w+|\.\w{2,4}\b/` — n'importe quel `mot/mot` (`read/write`, `et/ou`, une date `12/03`) ou n'importe quel point suivi de 2 à 4 caractères (`Node.js`, `v0.11.0`) déclenche « mentionne des fichiers ». **Faux positifs attendus.**
- `concrete_approach` = une liste de 15 stems FR/EN codés en dur. `refactor`, `fix`, `update`, `rename`, `corrig`, `modifi`, `test`, `document`, `renomm` en sont **absents**, alors que `wrap` y est. **Faux négatifs attendus.**
- `sufficient_detail` = plus de 20 mots. Muet sur la qualité.

Le mode bascule à `score >= 2`, donc **deux checks sur trois suffisent** — et comme `sufficient_detail` est quasi-gratuit pour un plan sérieux, la décision se joue en pratique entre les deux regex fragiles.

Hypothèse principale : **le problème n'est pas la forme du verdict, c'est l'instrument.** La fiche propose de remplacer un entier opaque par un verdict typé et une explication ; mais si l'instrument se trompe, un verdict typé ne fait que rendre l'erreur plus lisible et plus crédible. Et la valeur réelle du modèle outcome — la **boucle d'itération** (`needs_revision` → révision → réévaluation) — n'existe pas chez nous et ne peut pas exister tant que le verdict ne revient pas à l'agent.

Hypothèse secondaire : le juge LLM est disqualifié sans mesure, parce qu'il mettrait un appel réseau sortant payant sur le chemin synchrone d'`announce_work` dans un serveur qui fonctionne aujourd'hui hors ligne.

### 6.2b Critères de mort — pré-enregistrés avant toute mesure

Écrits **avant** d'exécuter quoi que ce soit. Un seul qui se déclenche tue `adopter`.

**Méthode de mesure de K1, fixée d'avance pour ne pas pouvoir choisir l'échantillon après coup :** je n'ai pas de base de production avec de vrais `threads.plan`. J'utiliserai donc l'échantillon le moins contestable qui existe — **les plans que le projet lui-même donne en exemple** dans son `README.md`, `cli/init.ts`, `docs/` et ses specs, c'est-à-dire ce qu'il dit à ses utilisateurs d'écrire. Si les exemples officiels du projet échouent à son propre contrôle, la mesure ne peut pas m'être reprochée comme biaisée. J'y ajouterai les 8 cas de `tests/unit/plan-quality.test.ts` comme témoin.

| # | Critère de mort | Seuil chiffré |
|---|---|---|
| **K1** | **L'instrument est sain.** Si l'heuristique classe correctement les plans que le projet documente lui-même, il n'y a pas de défaut à corriger et la refonte est cosmétique. | taux d'erreur (faux `discovery` + faux `with_plan`) **< 20 %** sur l'échantillon documenté |
| **K2** | **Aucun consommateur décisionnel.** Si `mode`/`score` ne change le comportement de rien côté serveur, refondre le verdict est un investissement sans bénéficiaire — le contre-argument YAGNI de §6.5 l'emporte. | **0** site où `planQuality.mode` ou `.score` conditionne un comportement (hors émission d'événement) |
| **K3** | **L'itération est inatteignable.** Le cœur de la valeur des outcomes est la boucle révision. Si le verdict ne revient pas à l'agent dans la réponse d'`announce_work`, aucune révision n'est possible, et « verdict typé + explication » se réduit à de la cosmétique de dashboard. | `announce_work` ne renvoie **pas** `plan_quality` dans son résultat d'outil |
| **K4** | **Le juge LLM est une régression produit.** Si aucun appel réseau sortant vers un tiers n'existe aujourd'hui sur le chemin d'annonce, en ajouter un (clé API, latence, coût par annonce, dégradation hors ligne) est une régression nette pour l'auto-hébergeur. | **0** appel HTTP sortant vers un service tiers dans le chemin `announce_work` |
| **K5** | **Contrat public déjà figé.** Si `plan_quality` est exposé dans ≥ 2 payloads publics et lu par un client, changer sa forme est un *breaking change* pour des consommateurs qu'on ne contrôle pas — et le vocabulaire à copier est encore en **beta**. | `plan_quality` présent dans ≥ **2** payloads publics distincts |
| **K6** | **L'effort annoncé est un plancher.** Si le nombre de fichiers réellement impactés dépasse les 9 recensés en §5, l'estimation `M` ment. | > **9** fichiers à modifier |
| **K7** | **La rubrique paramétrable est de la surface de support.** Si aucun mécanisme de configuration par org n'existe déjà pour y ranger une rubrique, il faut en créer un (stockage, validation, absence, migration) — coût récurrent pour un mainteneur solo. | aucun emplacement de config par org réutilisable en l'état |

**Règle que je m'impose :** §0 classe cette fiche ⚠️ **partielle** — l'API outcomes n'est pas atteignable. L'angle « appeler l'API » ne peut donc jamais recevoir `adopter`. Seul le **modèle de conception** appliqué à notre code local est jugeable ici.

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

#### A. Ma première mesure était biaisée — je la retire

La méthode pré-enregistrée en §6.2b (« les plans que le projet documente lui-même ») s'est révélée **sans objet** : le dépôt ne contient **aucun** exemple de `plan`. L'exemple canonique d'`announce_work` de `docs/usage.md:176-183` ne passe **que** `target_files`. Le `CLAUDE_MD_TEMPLATE` de `cli/init.ts:40-45` liste `subject`, `target_files`, `depends_on_files`, `target_modules` — **pas `plan`**. Le SDK n'a aucune occurrence d'`announce`. Et les bases SQLite versionnées contiennent **0** ligne `threads.plan` non vide.

J'ai donc substitué les messages de commit. **C'était une mauvaise substitution, et la passe adversariale l'a démontée** : le dépôt est un **clone shallow de 40 commits couvrant 4 jours** (2026-08-13 → 2026-08-16), c'est-à-dire ma propre semaine de veille, en style *conventional commit* uniforme. Mon `git log -n 120 … .slice(0, 100)` annonçait 100 enregistrements et en traitait 40, sans le dire. Les trois chiffres que j'en avais tirés — « `concrete_approach` décisif dans 3 % des cas », « 3 faux positifs `mentions_files` », « 93 % de `with_plan` » — sont des **artefacts de ce corpus**, et je les retire.

#### B. Le corpus correct, et le résultat qui tranche

Il existe dans le dépôt un corpus de plans **prospectifs** — écrits avant le travail, citant des chemins réels : `docs/superpowers/plans/*.md`, 11 fichiers, **83 blocs `## Task N:`**. Mesure sur ce corpus, plus trois témoins :

```
A. plans prospectifs (repo)     n= 83  files  98%  concret  88%  detail 100%  WITH_PLAN 100%  concret-decisif   2%
B. temoin : plans MAUVAIS       n= 20  files   0%  concret   0%  detail  25%  WITH_PLAN   0%  concret-decisif  25%
C. temoin : plans BONS          n= 10  files 100%  concret  50%  detail  30%  WITH_PLAN  80%  concret-decisif  70%
D. commits (TRONQUE, 4 jours)   n= 40  files  98%  concret  78%  detail  93%  WITH_PLAN  93%  concret-decisif  10%
```

Et c'est là que le vrai résultat apparaît. Le réfuteur, en extrayant les mêmes blocs plus courts, obtenait `concret-décisif` à **47 %** ; moi, en les tronquant à 600 caractères, à **2 %**. Quinze à vingt fois d'écart **sur le même texte**. J'ai donc fait varier la seule chose qui différait :

```
Le MEME corpus (83 plans), tronque a differentes longueurs :

  mots gardes | detail | WITH_PLAN | concret decisif
            8 |   0%   |   2%      |  12%
           12 |   0%   |  11%      |  29%
           16 |   0%   |  31%      |  61%
           20 |   0%   |  36%      |  69%
           25 | 100%   |  87%      |  24%
           30 | 100%   |  89%      |  16%
           40 | 100%   |  90%      |  16%
           60 | 100%   |  96%      |   6%
          100 | 100%   | 100%      |   2%
```

**Sur les mêmes 83 plans, le verdict passe de 2 % à 100 % de `with_plan` selon le nombre de mots conservés — et la bascule tient en 5 mots : 36 % à 20 mots, 87 % à 25.** C'est le seuil `wordCount > 20` de `src/plan-quality.ts:37`.

**Conclusion : `assessPlanQuality` n'est pas un détecteur de qualité de plan, c'est un détecteur de longueur avec une décoration lexicale.** Mon désaccord avec le réfuteur n'était pas un désaccord : nous échantillonnions deux longueurs du même texte, et l'instrument ne mesure que ça.

#### C. Le trou de vocabulaire est réel, et **sans effet** — c'est le point qui tue la fiche

C'est le chiffre que j'allais publier de travers. Les deux mesures :

```
CONTRE-TEST vocabulaire :
  verbes non reconnus par le check ISOLE        : 34/40
  verbes qui BASCULENT le mode en plan realiste :  0/40
  accent : "creer"=false  "créer"=true  |  "implementer"=true
```

34 verbes d'action courants sur 40 (`refactor`, `fix`, `corriger`, `update`, `rename`, `test`, `document`, `modifier`, `optimiser`, `rewrite`, `aligner`…) ne sont pas reconnus par `concrete_approach` **pris isolément**. Mais placés dans un plan réaliste (un chemin de fichier + 25 mots), **zéro sur quarante** fait basculer le mode : `mentions_files` + `sufficient_detail` donnent déjà 2 points. Le trou de vocabulaire — précisément ce que la fiche veut remplacer par une rubrique — **est masqué en pratique par le seuil de longueur**.

Publier « 34/40 » sans ce contre-test aurait été malhonnête : c'est le chiffre d'un check, présenté comme le chiffre de l'instrument.

**Correction d'une erreur de ma part :** j'affirmais que `cré` **et** `implémen` exigeaient l'accent. Faux — `implement` (stem anglais) est aussi dans la regex, donc `implementer` passe. **Seul `cré` est piégé** : `creer` échoue, `créer` passe, et aucun stem ne couvre la forme non accentuée.

#### D. Ce que l'instrument fait correctement

Témoin B — 20 plans délibérément mauvais, dont **5 pièges verbeux** de plus de 20 mots et vides de contenu (« Je vais commencer par regarder un peu ce qui se passe… ») : **0/20 classés `with_plan`**. Aucun faux négatif. L'heuristique rejette la bouillie, y compris la bouillie longue — parce qu'elle ne cite aucun fichier.

Témoin C — 10 bons plans prospectifs de longueur réaliste : **8/10 passent, 2 sont recalés**, tous deux courts-mais-bons. ~20 % d'erreur sur le seul corpus étiqueté à la main.

#### E. Adjudication des sept critères pré-enregistrés

| # | Seuil | Mesure | Verdict |
|---|---|---|---|
| **K1** | erreur < 20 % ⇒ instrument sain | 0/20 faux positifs sur la bouillie ; 2/10 recalés sur les bons plans (**20 %**) ; et l'erreur dominante n'est **pas** le vocabulaire (0/40 bascules) mais la **longueur** (2 %→100 % sur le même corpus) | **SE DÉCLENCHE, mais pas comme prévu** — l'instrument n'est pas *faux*, il est **hors sujet** : il mesure la longueur. Une rubrique ne corrige pas ça, elle l'habille. |
| **K2** | 0 site décisionnel | `planQuality.mode` est lu à **3** endroits (`announce-workflow.ts:160`, `consultation-tools.ts:189`, `rest-handlers.ts:310`) mais **un seul décide** (l.160), et il ne décide que d'émettre un événement SSE. Aucun *gate*, aucun blocage. | **SE DÉCLENCHE** |
| **K3** | le verdict ne revient pas à l'agent | MCP `consultation-tools.ts:208-220` → `{thread, conflicts, context, impact}`. REST `rest-handlers.ts:317` → `{thread_id, status, impact}`. **Aucun des deux ne renvoie `plan_quality`.** | **SE DÉCLENCHE** |
| **K4** | 0 appel sortant sur le chemin d'annonce | 0 sur le chemin `announce_work` — mais **le produit n'est pas hors ligne** : `src/quota/quota.ts:62` appelle `https://api.anthropic.com/api/oauth/usage` sur un timer de fond (`serve-http.ts:1120`), et `auth/providers/*` appellent les IdP. | **SE DÉCLENCHE pour le chemin synchrone** — mais le contre-argument « serveur hors ligne » de §6.5 est **faux** et doit être corrigé |
| **K5** | ≥ 2 payloads publics | 2 : `consultation-tools.ts:191` et `rest-handlers.ts:312`, lus par `dashboard/public/dashboard.js:172-179`. Vocabulaire source encore en **beta**. | **SE DÉCLENCHE** |
| **K6** | > 9 fichiers | 9 fichiers de code + `src/types.ts` (l'`EventType` manquant) = **10**. Le 11ᵉ que j'avais compté est un rapport d'audit, pas du code. | **SE DÉCLENCHE de justesse** — l'estimation `M` est un plancher, pas un mensonge |
| **K7** | aucun emplacement de config par org | `getOrgSetting` (`src/auth/org-settings.ts:44-60`) lit des **colonnes de la table `orgs`** (`columns.has(key)` → `SELECT ${key} FROM orgs`). Ranger une rubrique markdown exige donc **une migration et une colonne**, pour un document qui n'a rien à faire dans une colonne de settings. | **SE DÉCLENCHE** — je m'étais trompé en concluant l'inverse de « `getOrgSetting` existe et sert 12 fois » |

**Sept critères sur sept se déclenchent.**

#### F. Ce qui coûte 4 lignes, et qu'il faut faire

K3 nomme le blocage réel : sans le verdict dans la réponse, aucune révision n'est possible et « verdict typé + explication » se réduit à de la cosmétique de dashboard. Or le correctif est trivial et je l'ai vérifié :

- `planQuality` est déstructuré à `consultation-tools.ts:163`, **dans la même fonction**, en portée à la l.217. Ajouter `plan_quality: planQuality,` = **1 ligne**.
- `planDowngradeReason()` est privé (`announce-workflow.ts:210-216`) et absent du retour de `runCommonAnnounceFlow()` (l.183). `export` + l'inclure = **2 lignes**.
- REST `rest-handlers.ts:317` = **1 ligne**.

Vérifié : **aucun test n'assertionne le jeu de clés** de la réponse d'`announce_work` — l'ajout est purement additif dans un blob `JSON.parse`é. Les 8 tests témoins passent (`Test Files 1 passed / Tests 8 passed / 292ms`).

#### G. Défauts d'hygiène trouvés en chemin

- **Deux imports morts** : `assessPlanQuality` est importé et jamais appelé dans `src/serve-http.ts:48` et `src/server-setup.ts:21` (exactement 1 occurrence du symbole dans chaque fichier).
- **`tests/unit/plan-quality.test.ts` est en UTF-8 double-encodé, avec BOM** (`EF BB BF` ; `améliorer` stocké `61 6d c3 83 c2 a9`). **Conséquence que je n'avais pas vue :** le test des l.22-31 croit exercer le stem `cré` via `CrÃ©er` — il ne matche rien. Le test ne passe que grâce à `Ajouter`. **Le seul stem piégé par l'accent a donc une couverture de test nulle.**
- **Trois commentaires périmés** : les deux tests intitulés `BUG:` décrivent une regex `vaguePatterns` qui a **0 occurrence** dans `src/plan-quality.ts`. Les tests **passent** — ce sont des gardes de non-régression valides ; ce sont leurs titres et commentaires qui mentent.
- **`A03` est déjà tranché** — `✅ tranché — 2026-08-15, verdict reporter`. `assessPlanQuality` n'y apparaît que dans une cellule de tableau §5 (l.185), jamais en §6 ni §7. La menace « promotion en *gate* » que j'envisageais comme livrable **n'a plus d'adversaire**. Et le §0 de cette fiche cite « A03 l.177 » — c'est **l.185** aujourd'hui.

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
| **Verdict** | ⬜ adopter · ✅ **adopter partiellement** · ⬜ reporter · ⬜ refuser |
| **Date** | 2026-08-17 |
| **Justification** | **Les sept critères pré-enregistrés se déclenchent** — mais le résultat qui compte n'est aucun de ceux que la fiche annonçait. ⭑ **Refusé — (a) la rubrique paramétrable.** K7 : `getOrgSetting` (`org-settings.ts:44-60`) lit des **colonnes de la table `orgs`** ; ranger un document markdown y exige une migration et une colonne, pour un signal dont **aucun *gate* ne dépend** (K2 : un seul site décisionnel, et il ne décide que d'émettre un événement SSE). ⭑ **Refusé — (c) la boucle d'itération.** Personne ne bloque sur `mode: "discovery"`, et `A03` — la seule fiche qui envisageait d'en faire un *gate* — est tranchée `reporter` depuis le 2026-08-15. ⭑ **Adopté — (b) rendre le verdict à l'agent.** C'est le blocage que K3 nomme : la réponse MCP (`consultation-tools.ts:208-220`) et la réponse REST (`rest-handlers.ts:317`) ne contiennent **ni l'une ni l'autre** `plan_quality`. Coût vérifié : **4 lignes, 3 fichiers**, purement additif, aucun test n'assertionne le jeu de clés. Sans lui, « verdict typé + explication » n'est que de la cosmétique de dashboard. ⭑ **Mais la découverte réelle est ailleurs, et elle invalide la prémisse de la fiche** : `assessPlanQuality` n'est **pas** un détecteur de qualité, c'est un **détecteur de longueur**. Sur les mêmes 83 plans, le verdict passe de **2 % à 100 %** de `with_plan` selon la troncature, avec une bascule de 51 points en 5 mots autour du seuil `wordCount > 20`. Et le trou de vocabulaire que la fiche veut réparer par une rubrique — 34 verbes courants sur 40 non reconnus — **ne bascule le mode dans aucun plan réaliste (0/40)** : il est masqué par le seuil de longueur. Remplacer l'entier par un verdict typé rendrait l'erreur **plus lisible et plus crédible**, pas plus juste. **Correction de méthode :** ma première mesure était biaisée et je l'ai retirée — j'avais substitué les messages de commit à un corpus pré-enregistré qui s'est révélé vide, sans voir que le dépôt est un **clone shallow de 40 commits sur 4 jours**, c'est-à-dire ma propre prose de la semaine. Trois chiffres publiés de travers, retirés. J'ai aussi conclu à tort que K7 ne se déclenchait pas, et attribué à tort un piège d'accent à `implémen` (seul `cré` l'est). |
| **Issue / PR** | **#351** — le seuil de longueur non calibré, le verdict qui ne revient pas à l'agent, le piège d'accent `creer`/`créer`, deux imports morts, le double encodage du fichier de test (qui laisse le stem `cré` sans couverture), trois commentaires périmés citant une regex disparue |
| **Jalon visé** | Le correctif (b) — 4 lignes — dans la prochaine mineure. Le reste est de l'hygiène sans urgence : aucun *gate* ne dépend de ce signal. **Aucune refonte sur le modèle des outcomes** tant que le seuil de longueur n'est pas calibré sur de vrais plans — et le dépôt n'en possède aucun. |

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : §2 confirmée par la doc, 2 corrections mineures (payload webhook, ligne 250-251). |
| 2026-08-17 | **Challenge — verdict `adopter partiellement` ; les 7 critères se déclenchent, et la prémisse de la fiche tombe.** `assessPlanQuality` n'est pas un détecteur de qualité de plan mais un **détecteur de longueur** : sur les **mêmes** 83 plans prospectifs (`docs/superpowers/plans/*.md`), le verdict passe de **2 % à 100 %** de `with_plan` selon la seule troncature, avec 51 points de bascule en 5 mots autour du seuil `wordCount > 20` (`plan-quality.ts:37`). Et le trou de vocabulaire que la fiche veut réparer par une rubrique — **34 verbes courants sur 40 non reconnus** (`refactor`, `fix`, `corriger`, `update`, `rename`, `test`, `document`…) — **ne fait basculer le mode dans aucun plan réaliste : 0/40**, masqué par le seuil de longueur. Un verdict typé rendrait donc l'erreur plus lisible, pas plus juste. Témoins : **0/20** plans délibérément mauvais passent (dont 5 pièges verbeux > 20 mots), **2/10** bons plans courts sont recalés. Piège d'accent réel : `creer` échoue, `créer` passe (seul `cré` est concerné — `implement` couvre l'anglais, ma première affirmation sur `implémen` était fausse). **Refusé** : (a) la rubrique paramétrable — K7, `getOrgSetting` lit des **colonnes de `orgs`**, il faudrait une migration ; (c) la boucle d'itération — K2, aucun *gate*, et `A03` est tranché `reporter` depuis le 2026-08-15. **Adopté** : (b) rendre le verdict à l'agent — K3, ni la réponse MCP (`consultation-tools.ts:208-220`) ni la REST (`:317`) ne portent `plan_quality` ; coût vérifié **4 lignes / 3 fichiers**, purement additif, aucun test n'assertionne le jeu de clés. Hygiène : 2 imports morts (`serve-http.ts:48`, `server-setup.ts:21`), fichier de test en **UTF-8 double-encodé avec BOM** — ce qui laisse le stem `cré` **sans aucune couverture** — et 3 commentaires périmés décrivant une regex `vaguePatterns` disparue. → **#351**. **Correction de méthode :** ma première mesure était biaisée et je l'ai retirée. Le corpus pré-enregistré (« les plans que le projet documente ») s'est révélé **vide** — 0 ligne `threads.plan`, aucun exemple dans `README`/`docs`/`cli`/`sdk`, et `docs/usage.md:176` ne passe même pas de `plan`. Je lui ai substitué les messages de commit **sans voir que le dépôt est un clone shallow de 40 commits sur 4 jours**, c'est-à-dire ma propre prose de veille : trois chiffres publiés de travers, retirés. J'avais aussi conclu à tort que K7 ne se déclenchait pas. Correction de la fiche : §0 cite « A03 l.177 » — c'est **l.185** ; et le contre-argument §6.5 « serveur local sans réseau sortant » est **faux**, `src/quota/quota.ts:62` appelle déjà `api.anthropic.com` sur un timer de fond. |
