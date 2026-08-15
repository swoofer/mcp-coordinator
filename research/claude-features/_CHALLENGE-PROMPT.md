# Prompt de challenge — un par fiche

**Usage courant :** `/challenge C01` — la commande `.claude/commands/challenge.md` résout la fiche,
charge ce protocole et choisit la variante d'après le préfixe. `/challenge A01 A02` pour un
challenge groupé, `/challenge` seul pour reprendre au prochain ⬜ de l'ordre suggéré.

> ⚠️ `.claude/` est dans le `.gitignore` du projet : la commande est **locale et non versionnée**.
> Pour la partager avec des contributeurs, ajouter `!.claude/commands/` au `.gitignore`.

**Usage manuel :** remplacer `<FICHE>` par l'identifiant du dossier (`C01`, `D03`, `E11`…) et coller
le bloc ci-dessous dans une session dédiée, ouverte à la racine du dépôt. Régler d'abord
`/model opus` et `/effort high` — la commande le fait automatiquement, pas le copier-coller.

**Réglages.** Opus et `high` par défaut : la partie difficile est le jugement, pas la recherche.
`xhigh` pour `D03` et `A04`, dont la conclusion recadre le produit.

**Ultracode peut rester actif.** La règle ne porte pas sur la quantité d'effort mais sur ce qui peut
être délégué : jamais l'expérience (§6.3–6.4 est un fil séquentiel, et des sous-agents concurrents se
battraient pour le port et la base), jamais le verdict (§7 engage le projet). En revanche, déléguer
les balayages mécaniques du dépôt est le bon usage — et surtout, une fois le verdict formé mais
**avant** d'écrire §7, le faire attaquer par 2 ou 3 sous-agents adversariaux à angles distincts. Si
la conclusion tombe, c'est elle qui change.

Une session = une fiche. Le challenge produit une **décision**, pas une implémentation.

---

````
Tu challenges UN dossier de veille pour mcp-coordinator.

Objectif : décider si cette feature est bénéfique POUR CE PROJET, MAINTENANT — et le prouver.
Un challenge qui conclut « non » est un bon challenge. La fiche a été écrite par une veille
documentaire qui trouvait la feature intéressante ; ton rôle est de résister à ce biais.

FICHE : research/claude-features/<FICHE>-*.md
CONTEXTE : research/claude-features/00-SYNTHESE.md (lecture stratégique, à lire une fois)
CODE : la racine du dépôt

La fiche date du 2026-08-14 et ELLE PEUT ÊTRE FAUSSE. Ses sections 1 à 5 sont des affirmations
à vérifier, pas des acquis.

## Règle cardinale

Aucun verdict sans preuve. Une preuve, c'est : une sortie de commande, un test qui passe ou
échoue, un extrait de code que tu as lu, une mesure chiffrée, ou une page de doc officielle
fetchée aujourd'hui. « C'est probable », « ça devrait marcher », « d'après la fiche » ne sont
pas des preuves.

Si aucune preuve n'est atteignable (research preview inaccessible, API qui exige des
credentials qu'on n'a pas, client MCP non installé) : dis-le explicitement et le verdict est
« reporter » avec le blocage nommé. Ne conclus JAMAIS « adopter » sur du raisonnement seul.

## Étape 1 — Lire la §0, et ne re-vérifier que ce qui reste

Une passe de vérification factuelle a eu lieu le 2026-08-14 : chaque fiche a été confrontée à la
doc officielle et au code réel du dépôt. Son résultat est en **§0 de la fiche**.

- **Lis §0 en premier.** Elle dit ce qui a été corrigé, combien de marqueurs `(à vérifier)`
  subsistent, et si la fiche est testable ici. Ne refais pas ce travail.
- **Les marqueurs `(à vérifier)` restants sont ta cible.** La doc n'y a pas répondu : ce sont
  précisément les points que seule l'expérience tranchera. Ils appartiennent à l'étape 3, pas
  à l'étape 1.
- **Ne re-vérifie un fait que si tu as une raison de le suspecter** — une incohérence entre deux
  sections, une affirmation qui contredit ce que tu vois dans le code. Sinon, fais confiance à §0.
- Si §0 porte 🔴 **compromise** : lis-la entièrement avant d'aller plus loin. Un fait central
  s'y effondre, et le challenge peut s'arrêter là sur un verdict « refuser ».

Si malgré §0 la fiche s'effondre en cours de route — feature inexistante, API imaginaire — note-le
en §6.4, verdict « refuser », et arrête-toi. C'est un résultat, pas un échec.

## Étape 2 — Pré-enregistrer les critères de mort

AVANT de tester, écris en §6.2 :

- L'hypothèse : ce que tu crois qu'il va se passer.
- Les critères de refus : quel résultat te ferait conclure « non bénéfique ». Précis et
  chiffré quand c'est possible — « si ça ajoute plus de 200 ms à chaque Edit », « si ça ne
  marche pas sur Windows », « si ça casse le mode stdio », « si ça oblige à toucher plus de
  10 fichiers ».

Ce n'est pas de la cérémonie : c'est ce qui t'empêche de rationaliser après coup un résultat
décevant.

## Étape 3 — L'expérience

Amende §6.3, puis exécute-la. Le protocole dépend de la nature de la fiche :

- Feature testable localement → fais-la marcher pour de vrai. Écris la config, lance le
  daemon, appelle l'outil, regarde ce qui sort. PoC jetable dans le scratchpad, pas une branche.
- Feature qui touche le protocole → écris un test qui échoue contre le comportement actuel,
  ou fais parler un vrai client MCP.
- Feature non testable (API hébergée, preview fermée) → preuve documentaire de premier niveau
  (spec, changelog, code source du SDK) et dis clairement que rien n'a été exécuté.
- Fiche « menace » (blocs D et G) → l'expérience est différente : reproduis ce que fait le
  natif, et mesure ce qu'il NE fait PAS. Le livrable est une frontière factuelle, pas un PoC.

Colle les sorties brutes en §6.4. Pas de paraphrase.

## Étape 4 — La contre-épreuve

§6.5 est déjà remplie par la veille. Reprends-la :

- Chaque contre-argument tient-il après l'expérience ? Barre ceux qui tombent, renforce ceux
  qui tiennent.
- Ajoute ceux que l'expérience a révélés.
- Filtre YAGNI : un utilisateur réel a-t-il demandé ça, ou est-ce qu'on l'imagine ? Le profil
  de déploiement actuel (dev solo, petite équipe, auto-hébergeur) en a-t-il vraiment besoin ?
- Maintenance : qui maintient ça dans six mois, et que se passe-t-il si la beta bouge ou
  disparaît ?
- Portabilité : qu'est-ce que ça coûte aux utilisateurs hors Claude Code (Cursor, Cline,
  Aider) et hors macOS/Linux ?

## Étape 5 — Trancher

Remplis §7. Décide, ne demande pas.

Fiche d'opportunité / intégration :
- adopter — bénéfice prouvé, effort tenable, contre-arguments surmontés
- adopter partiellement — nomme exactement le sous-ensemble retenu ET ce qui est écarté
- reporter — nomme la condition de réveil (« quand X passe GA », « au premier utilisateur qui
  le demande »)
- refuser — nomme la raison précise qui l'a tuée

Fiche « menace » : le verdict porte sur la RÉPONSE, pas sur l'adoption — contre-mesure
technique, recadrage du positionnement et de la doc, ou acceptation assumée du recouvrement.

Puis, dans l'ordre :
1. En-tête de la fiche : « Statut du challenge » → ✅ tranché.
2. §8 Journal : une ligne datée.
3. research/claude-features/README.md : la colonne Challenge de cette ligne.
4. Si le verdict est « adopter » ou « adopter partiellement » : propose une issue GitHub avec
   le périmètre exact et DEMANDE avant de la créer. Note son numéro en §7.

## Interdits

- Ne réécris pas les sections 1 à 5 pour les faire coller au verdict. Corrige-les si elles
  sont fausses, en signalant la correction.
- Ne remplis pas §6.4 avec du raisonnement. §6.4 = ce qui s'est réellement passé.
- N'implémente pas la feature. Le challenge produit une décision et au plus un PoC jetable.
- Ne conclus pas « adopter » parce que la feature est élégante. La question est « bénéfique
  pour mcp-coordinator, maintenant », pas « intéressante ».
- Si le résultat contredit la fiche ou la synthèse, écris-le noir sur blanc. C'est
  l'information la plus utile que ce challenge puisse produire.

## Sortie

Un résumé court : le verdict, la preuve qui l'a emporté, et ce qui a changé dans la fiche.
Le détail vit dans la fiche, pas dans ta réponse.
````

---

## Variantes

**Fiche « menace » (blocs D et G).** Ajouter au prompt :

> Cette fiche est une menace. Ne cherche pas à adopter quoi que ce soit. Produis une frontière
> factuelle : ce que le natif fait, ce qu'il ne fait pas, et ce qui reste défendable pour
> mcp-coordinator. Reproduis le comportement natif pour de vrai — pas de comparaison sur
> catalogue. Si la conclusion est que le natif nous rattrape, dis-le.

**Fiche marquée ⚠️ partielle en §0** (39 des 56). Ajouter :

> La §0 nomme ce qui est testable ici et ce qui ne l'est pas. Teste ce qui l'est — n'utilise pas
> la partie bloquée comme prétexte pour ne rien exécuter. Pour le reste : preuve documentaire de
> premier niveau (spec, changelog, code du SDK), puis `reporter` avec condition de réveil, ou
> `refuser`. Jamais `adopter` sur la partie non exécutée. Marque en §6.4 la frontière exacte
> entre ce qui a été mesuré et ce qui a été seulement lu.

> ⚠️ Ne déduis pas la testabilité du bloc de la fiche. La vérification du 2026-08-14 a établi
> qu'**aucune des 56 fiches n'est totalement inaccessible**, y compris dans le bloc `E` où on
> attendait des blocages de credentials. Lis le champ *Testabilité* de la §0, pas le préfixe.

**Challenge groupé.** Pour deux ou trois fiches qui se répondent — par exemple `A01` + `A02`
(la migration protocole), ou `C01` + `F02` + `A03` (les trois voies vers la contrainte) — passer
les identifiants ensemble et ajouter :

> Ces fiches se recouvrent. Traite-les ensemble mais rends un verdict PAR fiche, et dis
> explicitement laquelle rend les autres inutiles si c'est le cas.

## Ordre

**Six fiches en préambule, puis l'ordre alphabétique strict `A01` → `G05`.**

Le préambule existe pour trois raisons seulement : deux fiches sont des bugs possibles et non des
options, deux autres conditionnent la valeur de tout le reste, et deux sont des gains rapides qui
valident le processus avant d'attaquer les gros chantiers. Passé ces six, l'alphabet suffit — un
ordre qu'on suit jusqu'au bout vaut mieux qu'un ordre optimal qu'on abandonne.

| # | Fiche | Effort | Testable | Pourquoi ici |
|---|---|---|---|---|
| 1 | [`C06`](C06-tool-search-defer-loading.md) | S | ✅ | Régression possible **aujourd'hui** : le tool search diffère les définitions d'outils, l'agent peut ne jamais savoir qu'il doit annoncer. Ce n'est pas une option, c'est un bug à confirmer ou infirmer. |
| 2 | [`C09`](C09-bash-sandbox-egress.md) | S | ⚠️ | Régression possible **aujourd'hui** : le sandbox bloque l'egress vers le daemon local sans message exploitable. La vérification a corrigé trois erreurs de clés, la forme d'adresse exacte ne se tranche que par l'essai. |
| 3 | [`D03`](D03-threat-native-worktrees.md) | M | ✅ | Cadrage. Si `--worktree` fait disparaître le conflit d'écriture, tout l'effort d'enforcement (`C01`, `F02`, `A03`) perd sa valeur. À trancher **avant** eux. |
| 4 | [`C01`](C01-hook-mcp-tool-gate.md) | S | ✅ | Fort levier, effort faible, et ses deux inconnues ont été levées par la vérification. À faire juste après `D03`, dont il dépend. |
| 5 | [`C08`](C08-statusline.md) | S | ✅ | Gain visible, effort minimal, entièrement testable. Valide le processus avant les chantiers XL. |
| 6 | [`A04`](A04-subscriptions-listen.md) | L | ⚠️ | Cadrage. Garder ou tuer le broker MQTT décide de la forme du produit, et conditionne `A01`, `A05`, `C03`, `C05`, `E04`. La plus lourde des six. |

Ensuite : `A01` → `G05` dans l'ordre, en sautant les six déjà faites.

Deux exceptions à l'alphabet, gratuites parce que les fiches sont adjacentes :
`/challenge A01 A02` (la migration protocole et le SDK qui l'implémente se répondent) et
`/challenge D01 D02` (cross-session messaging et Agent Teams sont la même menace vue de deux côtés).

**Les 17 fiches entièrement testables en local**, si tu préfères enchaîner les challenges qui
aboutissent à une preuve plutôt qu'à une lecture : `A01` `A02` `A10` `C01` `C02` `C06` `C08` `D03`
`D04` `D05` `E04` `E07` `F01` `F02` `F03` `G01` `G04`. Les 39 autres sont partiellement testables —
la partie bloquée est nommée dans leur §0. Aucune n'est totalement inaccessible.
