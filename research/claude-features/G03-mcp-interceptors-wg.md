# G03 — MCP Interceptors WG (SEP-1763) : la détection de conflit comme primitive standard

> **Fiche de veille.** Les sections 1 à 5 sont remplies par la veille.
> Les sections 6.2 à 6.5 et 7 sont remplies **pendant le challenge** (session dédiée).

| Champ | Valeur |
|---|---|
| **ID** | `mcp-interceptors-wg` |
| **Surface** | mcp-spec |
| **Statut** | experimental |
| **Disponible depuis** | Charte du groupe de travail `2026-04-21` ; SEP-1763 **clos le 2026-04-22 (`COMPLETED`)** et remplacé par **SEP-2624** (issue OPEN, ouverte le 2026-04-22) ; dans le dépôt d'expérimentation, seul le SDK **C#** est « In Progress » — Go, Python et TypeScript sont « Planned » |
| **Tier** | T1-incontournable |
| **Nature** | threat |
| **Effort estimé** | L |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — spec lisible, aucun SDK TS ni impl. Go publiée |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- **Le SEP a changé de numéro.** L'issue `modelcontextprotocol/modelcontextprotocol#1763`
  (« SEP-1763: Interceptors for Model Context Protocol », créée le 2025-11-04 par @sambhav) est
  **CLOSED, stateReason `COMPLETED`, le 2026-04-22T12:30:04Z**. Elle est remplacée par l'issue
  **#2624 — « SEP-2624: Interceptors for the Model Context Protocol », OPEN**, ouverte le
  2026-04-22T09:55:32Z. Le README du dépôt d'expérimentation référence bien SEP-2624 comme
  « the proposed interceptor extension specification », plus SEP-1763. La charte du WG, dont le
  changelog s'arrête au 2026-04-21, liste encore « SEP-1763: Interceptors — Draft » dans ses
  Active Work Items : **la charte est en retard d'un jour sur le tracker**. Le titre et l'ID de la
  fiche sont conservés tels quels (décision du mainteneur), mais §2 et §3 pointent désormais sur
  SEP-2624.
- **Le marqueur `(à vérifier)` sur le wire format est levé.** Les noms de méthodes JSON-RPC, de
  champs et d'enveloppes de résultat sont documentés dans les deux issues SEP ; §2 a été réécrit
  avec ces noms.
- **Il y a trois types d'intercepteur, pas deux.** L'enum `type` du SEP vaut
  `"validation" | "mutation" | "observability"`. La charte du WG ne mentionne que les deux
  premiers dans sa mission statement ; le SEP en ajoute un troisième.
- **La liste des points d'accrochage était incomplète.** Aux cinq opérations citées s'ajoutent
  `roots`, les complétions LLM et des motifs génériques (wildcard).
- **« Aucune implémentation de référence TypeScript » était faux dans les deux sens.** Le dépôt
  `experimental-ext-interceptors` contient bien un répertoire `typescript/sdk/`, package
  `@ext-modelcontextprotocol/interceptors` — mais au statut **`Planned`**, donc sans code. Et le
  SDK **Go y est également `Planned`**, pas « In Progress » : seul **C#**
  (`ModelContextProtocol.Interceptors`) est réellement « In Progress ». La charte, plus ancienne,
  annonçait Go et C# tous deux en cours. La conclusion pratique de la fiche ne bouge pas (aucun
  code TS consommable), mais l'item « lire l'implémentation de référence Go » de §6.3 n'a pas
  d'objet aujourd'hui.
- **§5 — un numéro de ligne faux :** `check_file_conflict` est à `src/tools/files-tools.ts:50`,
  pas 49 (le `readOnlyHint: true` correspondant est à la ligne 62).

**Vérifications faites qui n'ont rien changé :** charte datée `2026-04-21` ✓ ; 5 leads dont 3 chez
Bloomberg (Sambhav Kothari, Kurt Degiorgio, Uk-Jae Jeong), 1 Saxo Bank (Peder Holdgaard Pedersen),
1 Nordstrom (Ola Hungerford) ✓ ; sessions bimensuelles de 60 min ✓ ; problème M × N nommé verbatim
dans la mission ✓ ; modes in-process / sidecar / remote service ✓ ; mode audit et ordonnancement par
priorité ✓ ; « Client-specific hook implementation details (e.g., Claude Code's internal hook
execution engine) » explicitement **Out of Scope** ✓ ; dépôt marqué « Status: Experimental […] not
an accepted or official MCP extension » ✓. Côté repo : les 12 fichiers cités en §5 existent tous ;
`src/conflict-detector.ts` fait bien 153 lignes et n'émet que `severity: "warning" | "info"` ;
`announce_work` est bien à `consultation-tools.ts:37` ; `createMcpServer()` est bien à
`server-setup.ts:207` et enregistre bien **26** outils (4+11+3+3+3+2 via six `register*Tools`) ;
`@modelcontextprotocol/sdk: ^1.29.0` est bien à `package.json:69` ; `impact-scorer.ts` (417 lignes,
16,8 Ko) expose bien `concerned` / `gray_zone` / `pass` aux seuils ≥90 / 30–89 / <30 ;
`runCommonAnnounceFlow()` est à `announce-workflow.ts:60` ; `consultation.ts` fait bien 26,6 Ko.
Le statut d'en-tête `experimental` reste exact.

**Marqueurs `(à vérifier)` restants :** aucun. Le marqueur du §2 sur le wire format a été tranché.
Une incertitude résiduelle est signalée en §2 sur `interceptor/executeChain`, présent dans SEP-1763
mais non retrouvé dans le corps de SEP-2624 — noté comme tel, pas inventé.

**Testabilité :** ⚠️ partielle
Ce qui se lance ici : la lecture intégrale de SEP-2624 et l'extraction verbatim de son modèle d'état
(le champ `sessionId` du contexte d'invocation est le point à citer), puis l'exercice papier de
portage de `ConflictDetector.detect()` et `ImpactScorer` vers la forme `ValidationResult` — les deux
premiers et le troisième items de §6.3 sont faisables sans credential.
Ce qui est bloqué : il n'existe **aucun code d'intercepteur exécutable côté TypeScript** (le
répertoire `typescript/sdk/` est `Planned`), et le SDK Go l'est aussi — donc pas de PoC bout-en-bout,
pas de round-trip `interceptors/list` / `interceptor/invoke` contre un vrai client, et l'item
« lire la signature réelle de l'interface Go » n'a pas d'objet. L'item « assister à une session du
WG » sort du périmètre d'un test local.

---

## 1. Ce que c'est

Le MCP Interceptors Working Group est un groupe de travail de la spec MCP dont la mission est de
standardiser l'**interception, la validation et la transformation des opérations de contexte** :
appels d'outils, lectures de ressources, récupération de prompts, sampling, elicitation, et à terme
les complétions LLM et les workflows applicatifs. Le SEP-1763 introduit une primitive `interceptor`
déclinée en deux types : les **validators**, qui inspectent une opération et renvoient un verdict
pass/fail sans la modifier, et les **mutators**, qui transforment le payload avant qu'il n'atteigne
sa destination. Les intercepteurs se chaînent avec un ordonnancement par priorité et disposent d'un
**mode audit** (on observe et on journalise sans bloquer), ce qui permet un déploiement progressif.

Le modèle d'exécution est explicitement conscient des frontières de confiance et prévoit trois modes
de déploiement : **in-process**, **sidecar** et **service distant**. Le charter nomme précisément le
problème que mcp-coordinator résout aujourd'hui de façon artisanale : un paysage de sidecars, proxies
et gateways non réutilisables et non interopérables, un problème d'intégration M × N. Les leads
viennent de Bloomberg (trois personnes), Saxo Bank et Nordstrom, avec des sessions de travail
bimensuelles de 60 minutes ; le groupe est ouvert. Point important pour le périmètre : les internals
des hooks de Claude Code sont **hors scope déclaré** — l'intercepteur MCP et le hook `PreToolUse`
(fiche C01) sont deux mécanismes distincts qui ne se remplacent pas mutuellement.

## 2. Surface d'API exacte

```
SEP-2624                                     (issue OPEN, ouverte 2026-04-22)
  ← remplace SEP-1763 (issue CLOSED/COMPLETED le 2026-04-22)
namespace d'extension : io.modelcontextprotocol/interceptors
                                             (négociation de capability)

méthodes JSON-RPC :
  interceptors/list                          → découverte, filtrable par événement
  interceptor/invoke                         → invocation d'un intercepteur
  interceptor/executeChain                   → chaîne complète pour un événement/phase
                                               (présent dans SEP-1763 ; non retrouvé
                                                dans le corps de SEP-2624 — à reconfirmer
                                                à la lecture intégrale)

définition d'un intercepteur (champs) :
  name, version, description, events,
  type          : "validation" | "mutation" | "observability"   ← trois valeurs
  phase         : "request" | "response" | "both"
  priorityHint, compat, configSchema

surcharges de chaîne (InterceptorOverrides) :
  failOpen, priorityHint, mode, timeoutMs    (+ restriction du hook)

enveloppes de résultat :
  BaseInterceptorResult   : interceptor, type, phase, durationMs, info
  ValidationResult        : + valid, severity, messages, suggestions, signature
  MutationResult          : + modified, payload
  ObservabilityResult     : + observed, metrics

contexte d'invocation :
  principal { type, id, claims }
  traceId, spanId, timestamp, sessionId

points d'accrochage (événements) :
  tools/call, resources/read, prompts/get,
  sampling, elicitation, roots,
  complétions LLM, motifs wildcard

modèle d'exécution :
  ordonnancement de chaîne par priorité
  sémantique de mode audit
  déploiement in-process | sidecar | service distant
  rétrocompatible : entièrement optionnel, aucune modif du protocole existant

dépôt d'expérimentation : modelcontextprotocol/experimental-ext-interceptors
  csharp/sdk       ModelContextProtocol.Interceptors                  In Progress
  go/sdk           .../ext-interceptors/go/sdk                        Planned
  python/sdk       mcp-ext-interceptors                               Planned
  typescript/sdk   @ext-modelcontextprotocol/interceptors             Planned
  runtime sidecar commun + CLI d'invocation                           Ideating (charte)
```

Ces noms proviennent des corps de SEP-1763 et SEP-2624 et du README du dépôt. Ils sont **relevés,
pas reconstitués** : rien n'a été extrapolé. Le SEP restant à l'état de proposition, ils peuvent
changer.

Ce qui est **confirmé absent aujourd'hui** : aucun code d'intercepteur exploitable en TypeScript.
Le répertoire `typescript/sdk/` existe dans le dépôt d'expérimentation sous le nom de package
`@ext-modelcontextprotocol/interceptors`, mais au statut **`Planned`** — de même que Go et Python.
Seul **C#** est « In Progress ». Le projet dépend de `@modelcontextprotocol/sdk` `^1.29.0` (voir
`package.json:69`), qui n'expose rien de tout ceci. Toute expérimentation côté mcp-coordinator
passerait donc par une implémentation maison du brouillon, pas par une méthode SDK.

## 3. Sources

- https://modelcontextprotocol.io/community/working-groups/interceptors.md
- https://github.com/modelcontextprotocol/experimental-ext-interceptors
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1763 — **CLOSED (`COMPLETED`) le 2026-04-22**, conservée comme motivation historique
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2624 — **SEP-2624, OPEN**, la spec vivante à lire

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
`ConflictDetector.detect()` (`src/conflict-detector.ts`, 153 lignes) et l'outil `check_file_conflict`
(`src/tools/files-tools.ts:49`) sont, sémantiquement, déjà un **validator sur `tools/call`** : on
prend une intention d'écriture, on la confronte à l'état partagé, on renvoie un verdict. Aujourd'hui
ce verdict n'arrive à l'agent que si l'agent pense à appeler l'outil — c'est du volontariat. Si la
primitive est ratifiée, ce même code se branche sur `tools/call` de **n'importe quel client MCP**,
et le verdict devient structurel au lieu d'être conditionné à la discipline du prompt. Le mode audit
correspond exactement au besoin d'adoption progressive : un utilisateur peut brancher le validator en
observation avant de l'armer en blocage. Le mode de déploiement sidecar est déjà celui du daemon
(`src/serve-http.ts`), donc l'architecture ne change pas — c'est le contrat d'entrée qui change.

Bénéficiaire concret : l'auto-hébergeur qui fait tourner plusieurs agents sur un même repo et qui,
aujourd'hui, doit à la fois installer mcp-coordinator dans chaque session **et** compter sur le
CLAUDE.md pour que les agents appellent `announce_work`. Avec un intercepteur standard, la
coordination cesse d'être opt-in par agent.

**Risque si on ne fait rien :**
Double, et c'est là que la fiche est classée `threat`.

1. **Banalisation du cœur.** Une fois la primitive standard, la partie visible de mcp-coordinator —
   « prévenir avant d'écrire sur un fichier que quelqu'un d'autre touche » — devient un validator de
   quelques centaines de lignes que n'importe qui écrit sur l'exemple du SDK. Ce qui reste
   différenciant est ce qui est *au-dessus* : le scoring d'impact multi-couches
   (`src/impact-scorer.ts`, L0 à L4, 16,8 Ko), le protocole de consultation avec quorum et
   résolution (`src/consultation.ts`, 26,6 Ko), le co-change git (`src/git-cochange-builder.ts`), le
   bus MQTT. La détection brute, elle, ne défend rien.
2. **Fenêtre de design manquée.** Le SEP est encore Draft et le groupe est ouvert. mcp-coordinator a
   deux ans de cas limites documentés sur exactement ce problème (fichiers chauds, rayon d'explosion
   des dépendances, zone grise et introspection, plan quality). Si personne ne porte ces cas dans la
   discussion, la primitive risque d'être conçue pour le cas « politique de sécurité d'entreprise »
   — le profil de Bloomberg et Saxo Bank — avec un modèle sans état par appel, incapable de porter
   la notion d'un **travail en cours annoncé** qui s'étale sur plusieurs appels d'outils. Dans ce
   cas la primitive standard ne remplace pas mcp-coordinator mais devient un rail sur lequel il ne
   se branche pas proprement.

Il n'y a rien à implémenter aujourd'hui : le SEP est Draft, sans wire format stable ni SDK TS. Ce qui
est actionnable maintenant est une décision de **posture** (observer / participer / ignorer).

## 5. Points d'intégration dans le repo

| Fichier / module | Impact |
|---|---|
| `src/conflict-detector.ts` | Le candidat direct au rôle de **validator** sur `tools/call`. `detect()` prend `{org_id, agent_id, target_modules, target_files}` et renvoie `ConflictReport[]` — la forme est déjà celle d'un verdict, mais elle est *informative* (`severity: "warning" \| "info"`), jamais bloquante. Passer en validator impose de choisir ce qui vaut un `fail`. |
| `src/tools/files-tools.ts` | `check_file_conflict` (ligne 50 ; son `readOnlyHint: true` ligne 62) est un validator déguisé en outil que l'agent doit appeler lui-même. Premier candidat à l'exposition sous forme d'intercepteur. |
| `src/tools/consultation-tools.ts` | `announce_work` (ligne 37) est un **mutator** dans l'esprit du SEP : il transforme l'état partagé et change le contexte des appels suivants. C'est aussi ce qui ne rentre PAS dans un validator sans état — le point de friction à porter dans la discussion du groupe. |
| `src/announce-workflow.ts` | `runCommonAnnounceFlow()` factorise déjà l'orchestration entre les transports MCP et REST (voir le commentaire de tête). Un troisième appelant « intercepteur » se brancherait ici, pas dans les handlers. |
| `src/server-setup.ts` | `createMcpServer()` (ligne 207) enregistre les 26 outils via `register*Tools`. C'est le point où un enregistrement d'intercepteur viendrait s'ajouter si le SDK TS le supporte un jour. |
| `src/serve-http.ts` | Le transport HTTP du daemon : c'est déjà le mode de déploiement **sidecar / service distant** décrit par le SEP. Rien à refaire côté topologie. |
| `src/impact-scorer.ts` | Le scoring L0–L4 et la catégorisation `concerned / gray_zone / pass`. Ce qui reste différenciant si la détection brute se standardise — et ce qui n'a aucun équivalent dans le SEP tel que décrit. |
| `src/working-files-tracker.ts` | État « fichiers en vol », intrinsèquement inter-appels. Test décisif de savoir si le modèle d'exécution d'un intercepteur peut porter de l'état de session ou seulement une décision par appel. |
| `package.json` (ligne 69) | `@modelcontextprotocol/sdk: ^1.29.0`. Dans le dépôt d'expérimentation, seul C# est « In Progress » ; Go, Python et TypeScript sont « Planned ». Un répertoire `typescript/sdk/` est prévu (`@ext-modelcontextprotocol/interceptors`) mais vide de code : pas de chemin de mise à niveau côté TS aujourd'hui. |
| `cli/channel.ts` | Serveur MCP stdio des Claude Code Channels. **Hors scope** du WG (les internals de hooks Claude Code sont explicitement exclus) — à ne pas confondre avec les fiches C01/C02. |
| `docs/ARCHITECTURE.md` | Le document qui devrait dire si mcp-coordinator se positionne comme intercepteur standardisé ou comme serveur d'outils. Aujourd'hui il ne tranche pas. |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Le modèle d'exécution du SEP-1763 peut-il porter un intercepteur **avec état inter-appels** (le travail annoncé via `announce_work` + les fichiers en vol de `working-files-tracker`), ou est-il structurellement limité à une décision par appel — auquel cas mcp-coordinator n'expose comme validator que `conflict-detector.detect()` et garde le protocole de consultation en propre, en dehors de la spec ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

<Comment on tranche : PoC, lecture de code, mesure, test avec un vrai client MCP, benchmark de tokens…
Le principe maison : on teste le vrai chemin de code, on ne théorise pas.>

> ⚠️ Non exécutable ici : aucun code d'intercepteur n'existe en TypeScript ni en Go (statut `Planned` des deux côtés), donc pas de PoC bout-en-bout ni de lecture de la signature Go ; et la participation aux sessions du WG sort du périmètre d'un test local. Lire SEP-2624 (et non plus SEP-1763, close) reste faisable.

- [ ] Lire le SEP-1763 en entier et en extraire le modèle d'état : un intercepteur a-t-il accès à un identifiant de session, à un stockage persistant entre deux `tools/call` ? Consigner le verbatim, pas une paraphrase.
- [ ] Lire l'implémentation de référence Go dans `modelcontextprotocol/experimental-ext-interceptors` et relever la signature réelle de l'interface validator/mutator (le bundle ne la donne pas).
- [ ] Écrire à la main la version validator de `ConflictDetector.detect()` sur le brouillon et compter les lignes réellement portables : mesurer la part de `src/conflict-detector.ts` + `src/impact-scorer.ts` qui tient dans le modèle sans état.
- [ ] Vérifier si un intercepteur peut déclencher une **elicitation** vers l'utilisateur (le SEP liste `elicitation` comme opération interceptée — peut-il aussi en émettre une ?). C'est ce qui déciderait si le protocole de consultation est représentable.
- [ ] Assister à une session de travail bimensuelle et y poser le cas « travail annoncé multi-appels » ; noter si le groupe le considère dans le périmètre.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Rien n'est ratifié.** SEP au statut Draft, dépôt marqué `experimental`, runtime sidecar et CLI au statut « Ideating ». Un SEP Draft peut être abandonné, refondu ou fusionné. Construire dessus aujourd'hui, c'est construire sur un document qui n'a pas de wire format stable.
- **Pas de SDK TypeScript.** Les implémentations de référence sont Go et C#. Le projet est intégralement TS (`@modelcontextprotocol/sdk ^1.29.0`). Toute expérimentation implique de réimplémenter le brouillon à la main, puis de la maintenir à chaque itération du SEP, pour une fonctionnalité que zéro client MCP ne sait consommer aujourd'hui.
- **Le profil des leads n'est pas le nôtre.** Bloomberg, Saxo Bank, Nordstrom : le cas d'usage moteur est la politique de sécurité et de conformité en entreprise (bloquer un appel d'outil qui viole une règle), pas la coordination entre agents pairs. La primitive peut très bien être ratifiée dans une forme sans état qui ne porte rien du protocole de consultation — auquel cas l'investissement de participation n'a rien produit d'actionnable.
- **Coût de participation réel.** Sessions bimensuelles de 60 minutes, plus la lecture des SEP et des revues. Sur un projet à mainteneur unique, c'est du temps qui ne va pas dans les 13 findings « high » de l'audit v0.13.0.
- **YAGNI sur le déploiement actuel.** Le déploiement réel du projet est un daemon local qui coordonne des agents Claude Code sur un repo. Ces agents n'ont pas de client MCP capable de charger un intercepteur, et n'en auront pas avant la ratification. Le bénéfice est entièrement conditionnel à un futur incertain.
- **La menace est peut-être surestimée.** L'argument « n'importe qui réimplémente le cœur en 200 lignes » vaut déjà aujourd'hui sans intercepteur : rien n'empêche d'écrire un serveur MCP de détection de conflit. Ce qui coûte cher dans mcp-coordinator, ce n'est pas la détection, c'est le scoring multi-couches, le bus MQTT, l'auth Phase 2 et la résolution avec quorum. La primitive standard ne réduit aucun de ces coûts pour un concurrent.
- **Risque de confusion de périmètre.** Les hooks Claude Code sont hors scope du WG. Un lecteur pressé pourrait fusionner cette fiche avec C01 (`PreToolUse` / `mcp_tool`) et conclure qu'un seul chantier couvre les deux ; ce sont deux mécanismes disjoints, avec deux niveaux de portabilité différents.

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
| 2026-08-14 | Vérification des faits : SEP-1763 clos, remplacé par SEP-2624 ; wire format relevé ; TS/Go « Planned » ; ligne 50. |
