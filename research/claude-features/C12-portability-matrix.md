# C12 — Matrice de portabilité : ce que le natif ne couvre pas (Windows, Bedrock, conteneurs)

| Champ | Valeur |
|---|---|
| **ID** | `portability-matrix` |
| **Surface** | claude-code (matrice de disponibilité par méthode de déploiement) |
| **Statut** | GA — la page de comparaison est publiée et stable ; les features qu'elle exclut sont, elles, en research preview |
| **Disponible depuis** | page `code.claude.com/docs/en/feature-availability`, en ligne et à jour au 2026-08-14 (date de mise en ligne exacte *non vérifiable — la page ne porte ni date ni historique*) |
| **Tier** | T1-incontournable |
| **Nature** | opportunity |
| **Effort estimé** | S |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — exclusions backend invérifiables sans credentials Bedrock/GCAP/Foundry |
| **Statut du challenge** | ✅ **tranché** (2026-08-16) — `refuser` les deux branches de §6.1 ; §1/§2 à réécrire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §1 et §2 — un **cinquième** provider existe et manquait : **Claude Platform on AWS** (`CLAUDE_CODE_USE_ANTHROPIC_AWS`). Channels et cross-session messaging y sont ✗ aussi. L'outil Monitor, lui, n'y est **pas** exclu (sa page ne cite que Bedrock, GCAP, Foundry) : l'affirmation « Monitor a les mêmes exclusions que Channels » est donc fausse au sens strict.
- §1 et §2 — attribution des variables de coupure corrigée. Les **quatre** variables (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `DISABLE_GROWTHBOOK`) éteignent le cross-session messaging via l'évaluation de feature flags ; seules les **deux premières** éteignent Monitor. La fiche répartissait 2/2.
- §2 — les deux cases `(à vérifier)` « Windows » (Channels, Monitor) sont tranchées : aucune restriction d'OS n'est documentée pour ces deux features, contrairement au cross-session messaging qui exclut explicitement Windows natif.
- §2 — ajout des noms exacts des variables de sélection de backend, confirmés par la doc (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE`).
- §2 — cross-session messaging exige **Claude Code v2.1.224+** ; ce prérequis de version manquait.
- §5 — `README.md` : le tableau « Who is this for » est aux lignes **22-27**, pas 24-30.
- §5 — `src/quota/credential-reader.ts` : `WindowsCredentialReader` est aux lignes **74-82**, pas 74-92 (74-92 déborde sur `createCredentialReader`).
- §5 — `C03-channels-official-contract.md` : la restriction backend est aux lignes **121 et 185**, pas 99 et 160 (l. 99 = relais de permissions, l. 160 = titre `### 6.2`).
- §5 — la note « 0 occurrence » : `git grep -il "bedrock\|vertex\|foundry" -- src cli sdk` → 0 sur les fichiers suivis ; les seules occurrences sont dans `sdk/node_modules/` (typescript, lightningcss).
- Vérifiés exacts et laissés tels quels : `docs/index.html` l. 2066 (`<section id="compare">`), l. 1615 (nav), l. 2995/3372/3747/4122/4497/4872 (blocs `en`/`fr`/`es`/`de`/`zh`/`ja`), `docs/operating-modes.md` l. 141 (`### Caveats`) + puces 143-146, `docs/faq.md` l. 21 et l. 115, `README.md` l. 384 (note « macOS only »), `cli/doctor.ts` l. 9/123/498/600/657/744, `docs/sitemap.xml` (une seule URL), `docs/_config.yml` (`exclude: superpowers`).

**Marqueurs `(à vérifier)` restants :** un seul, en en-tête — la **date de mise en ligne** de `code.claude.com/docs/en/feature-availability` reste `(non vérifiable — la page ne porte aucune date de publication ni d'historique)`. Les deux marqueurs de la matrice §2 sont tranchés.

**Testabilité :** ⚠️ partielle
Testable ici, sur le poste Windows : l'absence de cross-session messaging sur Windows natif (`claude --version` puis `/list-agents`, attendu « commande non reconnue »), l'effet de `DISABLE_TELEMETRY` / `DO_NOT_TRACK` sur Monitor et le messaging, la relecture de `docs/operating-modes.md`, et le comptage exact des chaînes i18n de `compare.card6` dans les 6 blocs `translations`.
Non testable ici : la vérification empirique des exclusions Bedrock / Claude Platform on AWS / Google Cloud Agent Platform / Microsoft Foundry — chacune demande des credentials du backend concerné (compte AWS avec accès Bedrock, projet GCP, tenant Azure), qu'on n'a pas. Sur ce point la fiche reste tributaire de la doc Anthropic, désormais citée verbatim.

## 1. Ce que c'est

Ce n'est pas une feature Claude Code : c'est le **négatif** de toutes les autres fiches du bloc C. Anthropic publie désormais une page unique qui compare la disponibilité des fonctionnalités selon la méthode de déploiement (Claude.ai / Console API, Amazon Bedrock, Claude Platform on AWS, Google Cloud Agent Platform / Vertex AI, Microsoft Foundry). Le faisceau de restrictions vérifié converge sur un point : les primitives natives qui concurrencent directement mcp-coordinator sont précisément celles qui disparaissent hors du chemin Anthropic-first.

Trois axes d'exclusion, indépendants et cumulables. **Backend** : les Channels exigent une authentification Anthropic (claude.ai ou clé API Console) et ne sont disponibles ni sur Amazon Bedrock, ni sur Claude Platform on AWS, ni sur Google Cloud's Agent Platform, ni sur Microsoft Foundry ; l'outil Monitor et sa source WebSocket sont exclus sur Bedrock, Google Cloud's Agent Platform et Microsoft Foundry — mais **pas** sur Claude Platform on AWS, que sa page ne cite pas. **OS** : le cross-session messaging exige macOS ou Linux (WSL 2 compte comme Linux) et Claude Code v2.1.224+ — « Claude Code doesn't offer cross-session messaging on native Windows ». **Politique de télémétrie** : Monitor s'éteint si `DISABLE_TELEMETRY` ou `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` est posé ; le cross-session messaging dépend d'une évaluation de feature flags qu'éteignent indifféremment les **quatre** variables `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DO_NOT_TRACK` et `DISABLE_GROWTHBOOK`.

Aucune de ces restrictions ne se lève par une décision d'admin d'org : ce sont des propriétés du canal de déploiement, pas des réglages. La Claude Code Analytics API, de son côté, ne couvre que l'usage passant par l'API Claude — elle ne voit rien de ce qui transite par un backend cloud tiers.

## 2. Surface d'API exacte

Pas d'API à appeler : ce sont des pages de doc et des variables d'environnement de coupure.

```
# Page de référence
code.claude.com/docs/en/feature-availability

# Pages par backend (exclusions au cas par cas)
code.claude.com/docs/en/amazon-bedrock
code.claude.com/docs/en/claude-platform-on-aws
code.claude.com/docs/en/google-vertex-ai
code.claude.com/docs/en/microsoft-foundry

# Variables d'environnement qui désactivent les primitives natives
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC   # éteint Monitor ET le cross-session messaging
DISABLE_TELEMETRY                          # éteint Monitor ET le cross-session messaging
DO_NOT_TRACK                               # éteint l'évaluation de feature flags → cross-session messaging
DISABLE_GROWTHBOOK                         # idem

# Variables qui sélectionnent le backend (noms confirmés par feature-availability)
CLAUDE_CODE_USE_BEDROCK          # Amazon Bedrock
CLAUDE_CODE_USE_MANTLE           # endpoint Mantle, couvert par la colonne Bedrock
CLAUDE_CODE_USE_ANTHROPIC_AWS    # Claude Platform on AWS
CLAUDE_CODE_USE_VERTEX           # Google Cloud's Agent Platform
CLAUDE_CODE_USE_FOUNDRY          # Microsoft Foundry
```

Matrice consolidée, telle que vérifiée le 2026-08-14 :

| Primitive native | Bedrock | Claude Platform on AWS | GCAP / Foundry | Windows natif | Télémétrie coupée |
|---|---|---|---|---|---|
| Channels | ✗ | ✗ | ✗ | ✓ (aucune restriction d'OS documentée) | — (aucune variable citée par la page Channels) |
| Monitor + source WebSocket | ✗ | ✓ (non cité par la page Monitor) | ✗ | ✓ (aucune restriction d'OS documentée) | ✗ (`DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) |
| Cross-session messaging | ✗ | ✗ | ✗ | ✗ (macOS/Linux, WSL 2 = Linux ; v2.1.224+) | ✗ (les 4 variables) |
| Analytics dashboard + API | ✗ | ✗ | ✗ | — | — |

Channels exige en outre une auth Anthropic (claude.ai ou clé Console) et, en org Team/Enterprise, un `channelsEnabled` posé par un Owner. L'Analytics API est réservée au plan **Enterprise** côté claude.ai ; côté Console elle est disponible, mais les *contribution metrics* exigent une org claude.ai Team/Enterprise.

Les cases `—` ne sont pas des « oui » : elles signalent que la source n'a pas tranché.

## 3. Sources

- https://code.claude.com/docs/en/feature-availability
- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/cross-session-messaging
- https://code.claude.com/docs/en/tools-reference

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu :**
Aucun code n'apparaît ni ne disparaît — le gain est de positionnement, et c'est le moins cher du corpus. Le site expose déjà une section `#compare` (« Why not alternatives? ») avec cinq cartes qui répondent à *worktrees*, *subagents*, *Slack*, *CI*, *orchestrateurs*. Il manque la sixième, qui est aujourd'hui la seule objection réellement structurante : « …les primitives natives de Claude Code ? ». La réponse est factuelle et vérifiable : elles n'existent pas sur Bedrock / Google Cloud Agent Platform / Microsoft Foundry, pas sous Windows natif pour le cross-session messaging, et pas du tout quand l'org coupe la télémétrie. Ces trois profils sont surreprésentés en entreprise, et c'est exactement le terrain d'un broker MQTT auto-hébergé, neutre en vendeur, qui parle à Cursor et Cline comme à Claude Code.

Bénéficiaire précis : l'admin qui évalue le projet pour une org sur Bedrock, et le développeur Windows (profil du mainteneur lui-même). Aujourd'hui, ni le README ni `docs/faq.md` ni `docs/operating-modes.md` ne leur donnent cette information — `docs/operating-modes.md` mentionne bien la research preview et `--dangerously-load-development-channels`, mais rien sur les backends ni sur l'OS.

**Risque si on ne fait rien :**
Modéré mais réel. Deux issues distinctes. (a) Un évaluateur en entreprise conclut « Anthropic va livrer ça nativement » et écarte le projet, sans savoir que le natif ne l'atteindra pas sur son backend. (b) L'inverse : `docs/operating-modes.md` recommande aujourd'hui le mode push (Channels) sans dire qu'il est structurellement inaccessible à une partie des lecteurs — un utilisateur sur Foundry suit le guide et découvre l'impasse lui-même. C'est un bug de documentation, pas seulement un manque marketing.

## 5. Points d'intégration dans le repo

Chemins et numéros de ligne vérifiés par lecture directe.

| Fichier / module | Impact |
|---|---|
| `docs/index.html` l. 2066-2105 (`<section id="compare">`) | Cinq cartes `compare.card1` → `compare.card5`. Ajouter une `compare.card6` « …les primitives natives de Claude Code ? ». C'est le point d'insertion naturel, la section existe et est déjà liée par la nav (l. 1615). |
| `docs/index.html` l. 2995, 3372, 3747, 4122, 4497, 4872 (`translations`) | Six blocs de langue (`en`, `fr`, `es`, `de`, `zh`, `ja`). Toute nouvelle carte = 2 clés (`title` + `desc`) × 6 langues = 12 chaînes, plus le markup. C'est là que loge le vrai coût. |
| `docs/operating-modes.md` (section « Caveats », vers l. 141-146) | Liste déjà research preview, `--dangerously-load-development-channels`, l'absence de permission relay et la contrainte loopback. **Manque** : auth Anthropic obligatoire, indisponibilité Bedrock / GCAP / Foundry, et l'effet des variables de coupure télémétrie. Correction documentaire à faible coût, forte valeur. |
| `docs/faq.md` l. 21-28 (« Who is it for? ») et l. 115 (« Does it run on Bun? ») | Le FAQ a déjà le format « question d'environnement → réponse factuelle ». Ajouter « Does it work if my org runs Claude on Bedrock / Foundry? ». |
| `README.md` l. 22-27 (tableau « Who is this for ») | Quatre profils (l. 24-27). Le profil « self-hosting for a regulated org » est exactement la cible de la matrice ; la portabilité n'y est pas nommée. |
| `README.md` l. 384 | Précédent de rédaction : la note quota « **macOS only** … sur Linux/Windows le credential reader est un stub » montre que le projet documente déjà ses propres limites de plateforme sans détour. Même ton à reprendre. |
| `src/quota/credential-reader.ts` l. 74-82 | `WindowsCredentialReader` lève `NotImplementedError("win32")`. Contrainte d'honnêteté : une matrice qui vend « nous marchons là où le natif ne marche pas » doit assumer que le quota-guardrail maison est macOS-only. À citer dans la matrice, pas à cacher. |
| `cli/doctor.ts` (interface `CheckResult` l. 9 ; probes `probePublicUrl` l. 123, `probeSqlite` l. 498, `probeAuditQueueDepth` l. 600, `probeSweeperStatus` l. 657, `probePhase2AuditEvents` l. 744) | Suite de probes Phase 2 ; **aucune détection de plateforme ni de backend aujourd'hui**. Un check « environnement » (OS, backend Claude détecté, variables de coupure posées) serait une nouvelle probe, pas une modification — c'est la voie « produit » plutôt que « marketing ». |
| `docs/sitemap.xml` | Une seule URL (la racine). Une page dédiée `docs/portability.md` exigerait une entrée ici et un lien de nav. |
| `research/claude-features/C03-channels-official-contract.md` l. 121, 185 | Porte déjà la même restriction backend. Éviter la duplication : C12 est la vue transverse, C03 la vue Channels. |
| `docs/_config.yml` | `exclude: [superpowers, …]` — toute nouvelle page doc est publiée par défaut sur GitHub Pages sauf placement sous `superpowers/`. Rien à changer, mais à connaître avant d'écrire la page. |

Non concernés, vérifiés le 2026-08-14 : aucun fichier suivi de `src/`, `cli/` ou `sdk/` ne référence Bedrock, Vertex ou Foundry (`git grep -il "bedrock\|vertex\|foundry" -- src cli sdk` → 0 résultat ; les seules occurrences de l'arbre sont dans `sdk/node_modules/` — `typescript`, `lightningcss`). Cette fiche ne touche pas le runtime.

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Publie-t-on la matrice de portabilité comme **argument** (une carte `compare.card6` sur la landing, donc 12 chaînes à maintenir en 6 langues, qui se périment à chaque release Anthropic), ou comme **capacité produit** (une probe `doctor` qui détecte l'OS, le backend Claude en usage et les variables de coupure, puis recommande le mode polling ou push) — sachant que la première option est du contenu qu'on ne peut pas tester et la seconde nous engage à maintenir une base de faits versionnée sur un produit tiers ?

### 6.2 Hypothèse

*Pré-enregistrée le 2026-08-16, **avant** toute exécution.*

**Ce que je crois qu'il va se passer.**

1. **§6.1 se tranche par le point 5 du protocole, pas par un arbitrage de goût.** Si la détection du
   backend (`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` ou équivalent) est fiable, l'option
   « capacité produit » (une probe `doctor`) est nettement supérieure ; sinon elle tombe d'elle-même.
2. Les quatre variables de coupure (`DISABLE_TELEMETRY`, `DO_NOT_TRACK`,
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_GROWTHBOOK`) agissent via des **feature
   flags distants**, pas par un test en dur — c'est ce que `C03`, `C05` et `C11` ont établi
   (`tengu_harbor`, `tengu_amber_sentinel`, provider de traces).
3. **Quatre challenges de ce corpus ont déjà produit la matière de cette fiche** : la matrice n'est
   plus à écrire depuis la doc d'Anthropic, elle est en partie **mesurée**.

**Verdict pressenti :** `adopter partiellement` — la probe `doctor`, en refusant la carte `compare.card6`.

**Critères de mort.**

| # | Si… | …alors |
|---|---|---|
| **K1** | la détection du backend n'est **pas** fiable côté machine | l'option « capacité produit » tombe, et §6.1 se réduit à « publier ou non du contenu marketing ». |
| **K2** | les variables de coupure n'ont **aucun** effet observable ici | je ne peux pas documenter ce que je n'ai pas vu → `reporter` sur ce volet. |
| **K3** | le coût i18n de `compare.card6` dépasse **12 chaînes** | la branche « argument sur la landing » est disqualifiée par le coût, comme `C05`/`C07` l'ont montré pour `docs/index.html`. |
| **K4** | la matrice se périme à chaque release Anthropic **et** rien ne la teste | publier une base de faits versionnée sur un produit tiers est une dette : refuser, sauf si une probe la dérive automatiquement. |
| **K5** | le chantier dépasse **8 fichiers** | l'effort n'est plus S. |
| **K6** | aucun utilisateur n'a été bloqué par une restriction de plateforme | filtre YAGNI — **mais à peser** : le mainteneur est lui-même sur Windows, donc concerné en première personne. |

### 6.3 Protocole de vérification

> ⚠️ Non exécutable ici : la vérification empirique des exclusions Bedrock / Claude Platform on AWS / Google Cloud's Agent Platform / Microsoft Foundry — chacune exige des credentials du backend concerné (compte AWS avec accès Bedrock, projet GCP, tenant Azure). Les autres points restent exécutables sur le poste.

Proposition de veille — non exécutée.

- [ ] Sur la machine Windows du mainteneur, lancer une session Claude Code et tenter le cross-session messaging : vérifier que l'échec est bien celui annoncé (macOS/Linux/WSL2 uniquement) et capturer le message d'erreur exact — c'est la citation qui rendra la matrice crédible.
- [ ] Poser `DISABLE_TELEMETRY=1` puis `DO_NOT_TRACK=1` dans une session, et observer ce qui devient indisponible (Monitor, cross-session messaging). Consigner les sorties brutes, pas la paraphrase.
- [ ] Relire `docs/operating-modes.md` section « Caveats » et lister exactement les phrases à ajouter — mesurer le diff réel avant de décider si ça vaut une page dédiée ou trois puces.
- [ ] Chiffrer le coût de `compare.card6` : compter les chaînes à écrire dans les 6 blocs `translations` de `docs/index.html` et vérifier qu'aucune clé morte n'est introduite (le repo a déjà subi une purge de clés i18n orphelines).
- [ ] Vérifier si une probe `doctor` peut détecter le backend Claude côté machine (variables `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` ou équivalent — *nom exact à vérifier*) : si la détection n'est pas fiable, l'option « capacité produit » tombe d'elle-même.

### 6.4 Résultat observé

*Challenge du 2026-08-16. Claude Code **2.1.233**, Windows natif, sessions réelles. Méthode : lire la
liste `tools` de l'événement `init` en `--output-format stream-json`.*

#### A. 🔴 J'ai lu ma propre mesure à l'envers

J'ai d'abord vu `SendMessage` **présent** sur Windows et cru que la fiche se trompait. **C'est moi qui
me trompais.** `SendMessage` est **un seul outil avec deux espaces d'adressage** : il sert les
teammates en permanence, et gagne l'adressage cross-session (`uds:` / `bridge:`) seulement quand la
porte est ouverte — son `validateInput` refuse ces schémas sinon. Il n'a pas d'`isEnabled`.

Le vrai observable est **`ListAgents`**, dont l'`isEnabled` est exactement le prédicat de porte. Son
absence en référence **confirme** la fiche au lieu de la réfuter.

#### B. 🔴 Mais la fiche se trompe sur la **forme**, et c'est plus grave — la restriction se lève

Mesuré, même binaire, même machine Windows :

```
reference          : n=35  ListAgents=absent
HARBOR_KITE=1      : n=36  ListAgents=PRESENT  ajoutes=ListAgents
```

**Une variable d'environnement suffit.** Ce n'est donc pas un mur d'OS : c'est un **feature flag
distant**, dont le défaut est `false` sur *toutes* les plateformes — Windows en portant simplement un
second. macOS et Linux ne sont pas « ✓ » : ils sont soumis au même interrupteur.

> **La phrase la plus load-bearing de §1 est fausse :** « *Aucune de ces restrictions ne se lève par
> une décision d'admin d'org : ce sont des propriétés du canal de déploiement, pas des réglages.* »
> Celle-ci se lève, et par un simple réglage d'environnement.

#### C. 🔴 Une seule porte, pas quatre variables — et la matrice à colonnes est démentie

Diff exact contre la référence (35 outils) :

```
DISABLE_TELEMETRY=1  -> n=30, retires = Artifact, Monitor, PowerShell, PushNotification, RemoteTrigger
DO_NOT_TRACK=1       -> n=30, LES MEMES 5
DISABLE_GROWTHBOOK=1 -> n=30, LES MEMES 5
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 -> n=29, les 5 + DesignSync
```

Les trois variables ferment **exactement la même porte** : celle de l'évaluation des feature flags.
Tout `tengu_*` retombe alors sur son défaut, et les cinq outils qui disparaissent sont précisément
les flag-gated.

**Et le prédicat de porte est vrai dès que le backend n'est pas `firstParty`.** Bedrock, Vertex,
Foundry, Claude Platform on AWS, Mantle et gateway ferment donc **la même** porte que la coupure de
télémétrie. Il n'y a pas quatre colonnes avec des ✓/✗ par cellule : **il y a un prédicat unique.**

> 🔴 **La « correction » de §0 est fausse par le code.** Elle affirme que Monitor n'est *pas* exclu
> sur Claude Platform on AWS, au motif que la page de doc ne le cite pas. Or `anthropicAws` n'est pas
> `firstParty` → la porte est fermée → `Monitor` absent. **La fiche a transformé une affirmation
> vraie en affirmation fausse en faisant confiance au silence d'une page de documentation.** C'est le
> mode de défaillance de toute §2.

#### D. 🔴 La probe `doctor` de §6.1 est **structurellement aveugle** au cas gateway

Le classificateur commence par `if (Ag() || Uds()) return "gateway";` — et ces deux-là ne lisent
**aucune variable d'environnement** : ils interrogent des emplacements de credentials remplis depuis
un **fichier de settings** (`enterpriseGateway`).

Une probe qui ne lit que l'environnement classerait donc une org sur cloud gateway en `firstParty`,
et lui annoncerait que les Channels sont disponibles. **Un faux diagnostic, servi avec l'autorité
d'un diagnostic, à exactement le bénéficiaire que §4 revendique.** Deux autres angles morts :
un backend posé par le bloc `env` de `.claude/settings.json` s'applique au process de Claude Code,
pas à celui de `doctor` ; et `ANTHROPIC_BASE_URL` pointé sur un proxy ne change pas la classification.

**K1 se déclenche donc — mais pas pour la raison pré-enregistrée.** La détection *par variables* est
fiable ; c'est le **classificateur** qui ne se réduit pas à des variables. La seule version
défendable serait **comportementale** : lancer Claude Code et lire la liste `tools` — ce que fait ce
challenge. Elle ne dérive jamais, puisque c'est le binaire qui répond.

#### E. K3 ne se déclenche **pas** — et je refuse de déplacer le poteau

`compare.card5` compte 14 occurrences, mais décomposées en **2 emplacements de markup + 12 entrées de
dictionnaire**. Mon K3 disait « dépasse **12 chaînes** ». **12 n'excède pas 12.** J'avais requalifié
en « 14 éditions » pour le faire passer : c'est exactement l'ajustement post-hoc que §6.2 existe pour
empêcher, et je l'annule.

Si l'on veut refuser `compare.card6` par le coût, l'argument honnête est ailleurs : les mêmes clés
vivent aussi dans `docs/superpowers/working/translations/{de,es,fr,ja,zh}.json`, soit **22 chaînes
sur 6 fichiers** si cet arbre est maintenu. Mais ce n'est pas K3.

#### F. K5 ne se déclenche pas · K6 se déclenche · K4 se déclenche **plus fort que prévu**

- **K5 :** la probe tiendrait en **2 fichiers** (une insertion inline dans `cli/doctor.ts` + un test),
  5 avec les surfaces de release. Seuil 8 non franchi. Ce n'est pas le coût qui la tue.
- **K6 :** `bedrock`, `vertex`, `foundry`, `portability` → **0 issue** chacun. Les onze résultats
  « windows » portent tous sur le comportement de mcp-coordinator lui-même. **Et être sur Windows ne
  me qualifie pas** : j'ai 35 outils, et il m'a fallu une variable d'environnement pour obtenir le
  36ᵉ. Je ne suis pas bloqué, je suis curieux — ce n'est pas la même chose.
- **K4 :** la fiche craint qu'Anthropic « porte les Channels sur Bedrock du jour au lendemain ». Le
  risque est pire : `tengu_harbor_kite_win` est un **flag distant**. Anthropic peut activer le
  cross-session messaging sur Windows **sans livrer quoi que ce soit**. Une affirmation publiée en
  six langues sur la page d'accueil peut devenir fausse **sans qu'aucune release ne sorte**.

#### G. Le seul fait qui concerne nos utilisateurs

Couper la télémétrie — ce que fait tout utilisateur soucieux de confidentialité, et ce que la doc du
projet n'évoque nulle part — coûte **`Monitor`, `PowerShell`, `Artifact`, `PushNotification`,
`RemoteTrigger`**, plus `DesignSync` avec la variante `NONESSENTIAL_TRAFFIC`. C'est mesuré,
reproductible, et c'est la seule chose de ce dossier qui mérite d'être écrite dans notre
documentation.

#### H. §0 déclare six renvois « vérifiés exacts » qui sont tous faux

§0 affirme avoir vérifié `cli/doctor.ts` l. 9/123/498/600/657/744. Les six symboles sont ailleurs.
La même §0 qui « corrige » quatre renvois de ligne en déclare six faux comme vérifiés.

### 6.5 Contre-arguments

- **On maintient la doc d'un concurrent.** Une matrice de disponibilité d'un produit tiers se périme à chaque release. Anthropic peut porter les Channels sur Bedrock du jour au lendemain, et notre argument central devient un mensonge affiché en 6 langues sur la page d'accueil. Le contenu marketing qui dépend de l'absence d'une feature chez autrui est une dette à taux variable.
- **Coût i18n réel.** `docs/index.html` embarque 6 blocs de traduction complets. Une carte = 12 chaînes plus le markup, et le repo a déjà connu une dérive markup/dictionnaire assez sérieuse pour justifier une purge dédiée (commit `abe6d4d`). L'effort « S » du bundle est optimiste : il compte la rédaction, pas la maintenance.
- **Argument négatif = positionnement fragile.** « Nous existons parce que le natif ne marche pas partout » n'est pas une proposition de valeur, c'est un pari sur un trou. Les cinq cartes `#compare` actuelles disent ce que le projet *fait* (intent, cross-vendeur, cross-machine, avant l'écriture). Une sixième carte qui dit ce qu'Anthropic *ne fait pas* change le registre de la section.
- **On a nos propres trous de plateforme.** `src/quota/credential-reader.ts` l. 74-92 : le quota-guardrail est macOS-only, Windows et Linux renvoient 503. Pointer du doigt le Windows natif d'Anthropic tout en ayant un stub `NotImplementedError("win32")` dans notre propre arbre expose à un retour immédiat. Il faut soit boucher, soit assumer explicitement dans la même matrice.
- **YAGNI côté produit.** L'option « probe `doctor` » ajoute une surface de détection d'environnement à un CLI qui n'en a aucune aujourd'hui (`cli/doctor.ts` ne teste que des probes Phase 2 : URL publique, SQLite, file d'audit, sweeper). Pour un auto-hébergeur solo, savoir qu'il n'a pas accès aux Channels sur Bedrock n'a aucune conséquence opérationnelle : il utilise déjà le mode polling.
- **Une seule source dans le bundle.** Un chercheur, un verdict `CONFIRMED`. Pas de contradiction entre chercheurs à signaler — mais pas de recoupement non plus. Trois cases de la matrice du §2 (Windows pour Channels et Monitor) sont non renseignées, et la date de publication de la page de référence n'a pas été relevée. Publier une matrice à trous, c'est offrir la correction à quelqu'un d'autre.

---

## 7. Décision

| | |
|---|---|
| **Verdict** | ⬜ adopter · ⬜ adopter partiellement · ⬜ reporter · ✅ **refuser** |
| **Date** | 2026-08-16 |
| **Justification** | **Les deux branches de §6.1 tombent.** La carte `compare.card6` publierait, en six langues, des faits qu'**un tiers contrôle à distance** : la restriction Windows se lève par une variable d'environnement, et le flag qui la gouverne peut être basculé côté Anthropic **sans aucune release** (K4). La probe `doctor` est **structurellement aveugle au cas gateway** et servirait un faux diagnostic à l'admin d'entreprise que §4 revendique comme bénéficiaire (K1). K6 se déclenche : zéro utilisateur bloqué. Et §1/§2 doivent être réécrites avant toute publication — la matrice à quatre colonnes est démentie par un **prédicat unique**. |
| **Issue / PR** | aucune |
| **Jalon visé** | aucun |

### Ce qui est conservé — trois puces, dans `docs/operating-modes.md`

Le seul fait de ce dossier qui concerne **nos** utilisateurs, et il est mesuré :

> Couper la télémétrie de Claude Code — `DISABLE_TELEMETRY`, `DO_NOT_TRACK` ou `DISABLE_GROWTHBOOK`,
> indifféremment — retire cinq outils : **`Monitor`, `PowerShell`, `Artifact`, `PushNotification`,
> `RemoteTrigger`**. La variante `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` en retire un sixième,
> `DesignSync`. Les trois premières variables ferment **la même** porte, pas trois portes distinctes.

C'est reproductible, ça ne dépend d'aucune page de doc tierce, et ça n'est écrit nulle part dans la
documentation du projet.

### Ce qui est refusé

- **La carte `compare.card6` sur la landing.** Pas pour son coût — mon critère K3 **ne se déclenche
  pas**, voir ci-dessous — mais parce qu'elle publierait en six langues une affirmation dont le
  concurrent fixe la valeur de vérité en temps réel.
- **La probe `doctor` classificatrice de backend.** Elle réimplémenterait le classificateur d'un
  produit tiers, se tromperait précisément sur le cas gateway, et se périmerait à chaque build. Si la
  capacité est un jour voulue, la seule forme défendable est **comportementale** — lancer Claude Code
  et lire sa liste d'outils, comme ce challenge l'a fait — au prix d'une dépendance à un CLI tiers
  dans `doctor`.

### Corrections à porter avant toute réutilisation de cette fiche

- **§1 : la phrase centrale est fausse.** « Aucune de ces restrictions ne se lève par une décision
  d'admin » — celle du cross-session messaging se lève par une variable d'environnement, mesuré.
- **§1/§2 : la matrice à quatre colonnes est démentie.** Il n'y a pas une grille backend × feature,
  mais **un prédicat** : tout backend non-`firstParty` ferme la même porte que la coupure de
  télémétrie.
- **§0 : sa « correction » sur Monitor / Claude Platform on AWS est fausse par le code.** Elle a
  conclu d'un **silence** de la documentation qu'il n'y avait pas d'exclusion.
- **§0 : six renvois de `cli/doctor.ts` déclarés « vérifiés exacts » sont tous faux.**
- **§2 : les backends sont mal mappés.** `CLAUDE_CODE_USE_VERTEX` désigne Vertex AI, pas Google
  Cloud's Agent Platform — lequel a sa propre variable, absente de la fiche.

### Note de méthode — deux fautes, dont une que j'annule

**J'ai lu ma propre mesure à l'envers.** Voyant `SendMessage` présent sur Windows, j'ai cru tenir une
réfutation de la fiche et je l'ai annoncé. C'était faux : `SendMessage` est un outil unique à deux
espaces d'adressage, et le vrai observable est `ListAgents`, dont l'absence **confirmait** la fiche.
J'ai construit une conclusion sur le mauvais témoin.

**Et j'ai déplacé un poteau, ce que j'annule explicitement.** Mon K3 disait « dépasse 12 chaînes ».
La mesure donne 12 entrées de dictionnaire plus 2 emplacements de markup ; j'ai requalifié en
« 14 éditions » pour le faire se déclencher. **12 n'excède pas 12 : K3 ne se déclenche pas**, et le
refus de `compare.card6` repose sur K4, pas sur le coût. C'est précisément l'ajustement post-hoc que
le pré-enregistrement existe pour empêcher — le même que `C03` m'avait déjà reproché.

## 8. Journal

| Date | Événement |
|---|---|
| 2026-08-14 | Fiche créée par la veille plateforme. |
| 2026-08-14 | Vérification des faits : 5e provider ajouté, variables de coupure réattribuées, 4 renvois de ligne corrigés. |
| 2026-08-16 | **Challenge — verdict `refuser`.** Mesuré sur Windows natif : la restriction cross-session **se lève** avec `CLAUDE_CODE_HARBOR_KITE=1` (35 → 36 outils, `ListAgents` apparaît) — ce n'est donc pas un mur d'OS mais un **feature flag distant**, et la phrase centrale de §1 (« aucune de ces restrictions ne se lève ») est fausse. Les trois variables de coupure retirent **exactement les mêmes 5 outils** (`Artifact`, `Monitor`, `PowerShell`, `PushNotification`, `RemoteTrigger`) : **une seule porte**, pas quatre — et tout backend non-`firstParty` ferme la même. La matrice à quatre colonnes de §2 est démentie par un prédicat unique, et la « correction » de §0 sur Claude Platform on AWS est **fausse par le code** (elle a conclu d'un silence de la doc). Probe `doctor` **refusée** : aveugle au cas gateway, elle servirait un faux diagnostic à l'admin d'entreprise. Conservé : trois puces mesurées dans `docs/operating-modes.md`. **Deux fautes de ma part** : j'ai lu ma mesure à l'envers (`SendMessage` ne prouvait rien, `ListAgents` était le témoin), et j'ai déplacé le poteau de K3 — annulé, K3 ne se déclenche pas. |
