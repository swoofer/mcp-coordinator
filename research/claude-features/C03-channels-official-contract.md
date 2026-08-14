# C03 — Channels : aligner `cli/channel.ts` sur le contrat officiel `claude/channel`

| Champ | Valeur |
|---|---|
| **ID** | `channels-official-contract` |
| **Surface** | claude-code |
| **Statut** | research-preview — les deux pages de doc portent l'encart « Channels are in research preview » ; déploiement progressif ; la syntaxe de `--channels` et le contrat protocolaire peuvent encore changer |
| **Disponible depuis** | aucune date officielle publiée. Le seul jalon versionné cité par la doc est `v2.1.211` (assainissement des champs relayés). Les chercheurs ne datent que leur propre observation (août 2026). |
| **Tier** | T1-incontournable |
| **Nature** | replace-homemade-code (avec une composante `threat` réelle sur la distribution — voir §4) |
| **Effort estimé** | M (les cinq fiches brutes divergent entre S et M ; le S sous-estime les écarts documentaires listés en §5) |
| **Confiance veille** | high |
| **Vérification** | CONFIRMED |
| **Vérifiée le** | 2026-08-14 |
| **Testabilité** | ⚠️ partielle — verrous org et allowlist officielle hors de portée locale |
| **Statut du challenge** | ⬜ à faire |

---

## 0. Vérification du 2026-08-14

**État de la fiche :** 🟡 corrigée

**Corrections apportées :**

- §2 — `claude --channels server:<nom>` n'est **pas** une forme documentée : la doc ne montre `server:<nom>` que derrière `--dangerously-load-development-channels`, et précise que pendant la preview `--channels` n'accepte que des **plugins** de l'allowlist. Ligne rectifiée.
- §5 `docs/operating-modes.md` — le « v2.1.80+ » non sourcé apparaît en **l. 11** (ligne « Claude Code version » du tableau comparatif), troisième occurrence que la fiche ne listait pas à côté de `README.md` l. 119 et `docs/usage.md` l. 156. La citation « l. 12 » désignait en fait la ligne « Special flag ».
- §5 `docs/operating-modes.md` l. 108 — la valeur attendue de `source` est tranchée par la doc : l'attribut est renseigné depuis le **nom sous lequel le serveur est enregistré** (la clé de `.mcp.json` : l'exemple officiel `"webhook": {…}` produit `<channel source="webhook">` ; un plugin produit un nom scopé du type `plugin:fakechat:fakechat`). La valeur attendue ici est donc `coordinator-channel`, ni `mcp-coordinator` (doc) ni `mcp-coordinator-channel` (`serverInfo.name`, l. 299).
- §5 l. 109 — marqueur `(à vérifier)` sur l'attribut vide résolu en `(non vérifiable)`.

Le reste de §2 est confirmé mot pour mot par `channels-reference` et `channels` : capability `claude/channel` / `claude/channel/permission` toujours `{}`, `capabilities.tools` « two-way only », `instructions`, méthode `notifications/claude/channel` avec `content` + `meta`, contrainte « keys must be identifiers… keys containing hyphens or other characters are silently dropped », tag `<channel source="…">`, les quatre champs `request_id` / `tool_name` / `description` / `input_preview`, l'ID de 5 lettres sans `l`, la regex `/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`, le seuil v2.1.211 et les 3 500 code points, `channelsEnabled` / `allowedChannelPlugins` (page `claude.ai/admin-settings/claude-code`, rôle Owner, tableau vide vs clé non définie), le bypass par entrée, l'absence de flags dans `claude --help`, l'auth Anthropic obligatoire et l'indisponibilité sur Amazon Bedrock / Google Cloud Agent Platform / Microsoft Foundry. Statut **research preview** toujours affiché ce jour sur les deux pages. §5 relue fichier par fichier : tous les chemins existent, tous les numéros de ligne pointent bien sur ce que la fiche décrit (repo à `mcp-coordinator@2.0.1`, `cli/doctor.ts` toujours à zéro occurrence de « channel »).

**Marqueurs `(à vérifier)` restants :** aucun.

**Testabilité :** ⚠️ partielle
Testable ici : lancer `claude --dangerously-load-development-channels server:coordinator-channel` avec le `.mcp.json.sample` du quickstart, publier un événement MQTT sur le broker du daemon local, et capturer le tag réellement injecté — cela tranche d'un coup le désaccord de nommage, la valeur exacte de `source`, le sort d'une clé `meta` non-identifiant, et le retrait de `capabilities.experimental.tools` (relance de `tests/integration/channel-smoke.test.ts`). Non testable ici : tout ce qui dépend d'un tiers — l'allowlist Anthropic (`--channels plugin:…@claude-plugins-official` sans flag `dangerously`), les managed settings `channelsEnabled` / `allowedChannelPlugins` (exigent un org Team/Enterprise et le rôle Owner), et l'indisponibilité sur Bedrock / Google Cloud Agent Platform / Microsoft Foundry.

## 1. Ce que c'est

Anthropic a documenté et figé le mécanisme que mcp-coordinator implémentait sans contrat écrit depuis la v0.12.0 : un *channel* est un serveur MCP **stdio** qui déclare `capabilities.experimental['claude/channel'] = {}` dans le constructeur `Server` du SDK, puis pousse des événements avec `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })`. Claude Code injecte `content` comme corps d'une balise `<channel source="...">` dans le contexte de la session, `source` étant dérivé du nom du serveur ; chaque clé de `meta` devient un attribut de la balise. Les clés doivent être des **identifiants** (lettres, chiffres, underscore) : une clé contenant un tiret ou tout autre caractère est **droppée silencieusement** — ce n'est pas le tiret qui est retiré, c'est l'attribut entier qui disparaît (les fiches brutes se contredisaient sur ce point, la rectification du vérificateur fait foi et a un impact code direct).

Le retour est un simple outil MCP (`capabilities.tools` + une chaîne `instructions` injectée dans le system prompt) — aucun mécanisme dédié. Nouveauté non implémentée chez nous : `capabilities.experimental['claude/channel/permission'] = {}` active le **relais de permissions**, Claude Code émettant `notifications/claude/channel/permission_request` et le serveur répondant `notifications/claude/channel/permission`. Aucun ACK n'est jamais renvoyé : si le channel n'est pas chargé ou si la policy d'org bloque, les notifications sont perdues en silence ; si Claude est occupé, les événements sont mis en file et livrés groupés au tour suivant.

L'activation est **par session** et gouvernée par une allowlist : `claude --channels plugin:<nom>@<marketplace>` n'accepte que des plugins de l'allowlist Anthropic (`claude-plugins-official`). Un channel maison — même publié sur son propre marketplace — exige `--dangerously-load-development-channels`, avec une entrée `plugin:<nom>@<marketplace>` ou `server:<nom>`, et un dialogue d'avertissement plein écran. Être déclaré dans `.mcp.json` ne suffit jamais : le serveur doit aussi être nommé sur la ligne de commande. Côté org, les managed settings `channelsEnabled` (master switch, bloqué par défaut sur claude.ai Team/Enterprise) et `allowedChannelPlugins` (qui **remplace** l'allowlist Anthropic, ne s'y ajoute pas) ferment le second verrou. Enfin, les channels exigent une authentification Anthropic (claude.ai ou clé API Console) et ne sont **pas** disponibles sur Amazon Bedrock, Google Cloud Agent Platform ni Microsoft Foundry.

## 2. Surface d'API exacte

```
# Capabilities (constructeur Server du SDK MCP)
capabilities.experimental['claude/channel']              = {}     (toujours vide)
capabilities.experimental['claude/channel/permission']   = {}     (opt-in, relais de permissions)
capabilities.tools                                       = {}     (obligatoire pour le retour bidirectionnel)
instructions                                             : string (injectée dans le system prompt)

# Push serveur → session
notifications/claude/channel
  params.content : string                      → corps du tag <channel source="...">
  params.meta    : Record<string,string>       → attributs du tag
                   clés = identifiants (a-zA-Z0-9_) ; toute autre clé est droppée ENTIÈREMENT

# Tag injecté dans le contexte
<channel source="<nom-du-serveur>" cle1="val1" cle2="val2">…content…</channel>

# Relais de permissions (non implémenté dans le repo)
notifications/claude/channel/permission_request
  params: { request_id, tool_name, description, input_preview }
          request_id = 5 lettres minuscules a-z sans « l »
          regex de parsing documentée : /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
notifications/claude/channel/permission
  params: { request_id, behavior: 'allow' | 'deny' }
  depuis v2.1.211 : description et input_preview assainis (direction-override, caractères
  invisibles, homoglyphes de guillemets/chevrons, 3500 code points par champ top-level,
  marqueur d'élision). Clients antérieurs : description brute, input_preview coupé à 200
  unités UTF-16.

# Flags CLI (absents de `claude --help` pendant la preview — « the flags work even though
# they aren't listed »)
claude --channels plugin:<nom>@<marketplace>              (plusieurs entrées séparées par des espaces)
  → forme SEULE documentée pour --channels pendant la preview : le flag n'accepte que des
    plugins de l'allowlist. `--channels server:<nom>` n'apparaît nulle part dans la doc
    (non vérifiable — la doc ne montre `server:` que derrière le flag `dangerously`).
claude --dangerously-load-development-channels plugin:<nom>@<marketplace>
claude --dangerously-load-development-channels server:<nom>
  → le bypass est PAR ENTRÉE : combiner ce flag avec --channels n'étend pas le bypass
    aux entrées de --channels.

# Managed settings (org) — page admin https://claude.ai/admin-settings/claude-code, rôle Owner
channelsEnabled       : boolean
allowedChannelPlugins : [{ "marketplace": string, "plugin": string }]
  → remplace l'allowlist Anthropic ; exige channelsEnabled: true
  → [] bloque tous les plugins mais laisse passer le flag dev ; pour tout bloquer, laisser
    channelsEnabled non défini
```

Sémantiques annexes documentées, à ne pas perdre :

- **Aucun ACK.** « Claude Code doesn't acknowledge notifications » — drop silencieux si le channel n'est pas chargé ou si la policy bloque.
- **Mise en file.** Événements arrivés pendant un tour occupé : livrés groupés au tour suivant.
- **Relais de permissions :** le dialogue local reste ouvert en parallèle, **la première réponse gagne** ; les verdicts n'affectent pas les appels futurs ; le relais ne couvre **pas** les dialogues de confiance projet ni de consentement serveur MCP ; l'allowlist gate aussi le relais.
- **Sécurité :** la doc insiste — un channel non filtré est un vecteur de prompt injection. Le gating doit porter sur l'**identité de l'expéditeur** (`message.from.id`), pas sur la room (`message.chat.id`).
- **Distribution :** le formulaire de soumission in-app mène au *community marketplace*, qui n'est **pas** sur l'allowlist channels. La doc ne connaît qu'une voie : « If you are working with an Anthropic partner contact, reach out to them to coordinate an official-marketplace listing ».
- **État local :** `~/.claude/channels/<nom>/` (dont `.env`) est la convention des plugins de référence.

## 3. Sources

- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/channels-reference
- https://code.claude.com/docs/en/mcp *(page réelle référencée par les deux autres, mais purement contextuelle sur le protocole sous-jacent — aucun contenu spécifique aux channels)*

## 4. Pourquoi ça concerne mcp-coordinator

**Bénéfice attendu.** Le pari « Claude Code Channels » de la v0.12.0 est validé mot pour mot : `cli/channel.ts` (l. 311-318) déclare déjà `capabilities.experimental['claude/channel'] = {}` et passe `instructions`, et émet déjà `notifications/claude/channel` avec `{content, meta}` (l. 459-467). Il n'y a donc **presque aucun glue code à supprimer** — la fiche brute qui parlait d'implémentation « hors contrat » surestimait l'écart, et le vérificateur l'a rectifiée. Le bénéfice réel est ailleurs et se décompose en trois :

1. **Conformité vérifiable plutôt que devinée.** On peut enfin écrire un test qui assert le contrat officiel au lieu du contrat reconstitué depuis l'étude des plugins de référence (`docs/superpowers/working/channels-reference-plugins-study.md`). Les six clés `meta` émises (`event_type`, `org`, `thread_id`, `agent_id`, `message_type`, `status`) sont toutes des identifiants valides, donc rien ne casse aujourd'hui — mais `buildChannelNotification` n'a **aucun garde-fou** : le jour où un nouvel événement introduit une clé `target-modules` ou `parent.id`, l'attribut disparaît sans erreur ni log. C'est exactement le pattern « garde-fou fantôme » déjà relevé à l'audit.
2. **Le relais de permissions devient une capacité de coordination inédite.** `claude/channel/permission` permettrait à mcp-coordinator de router les demandes d'approbation d'outil d'une session vers le dashboard, un autre agent, ou une politique d'org — la seule feature de la plateforme qui exploiterait réellement le fait d'avoir un bus MQTT partagé entre agents. C'est aujourd'hui délibérément différé (`HANDOFF.md` l. 65 : le modèle de confiance MQTT-loopback n'a pas d'allowlist d'expéditeur, ce que la doc exige précisément).
3. **Nettoyage documentaire non trivial.** Voir §5 : la doc du repo et le code divergent sur au moins quatre points concrets, dont un qui empêche purement et simplement le quickstart de fonctionner.

**Risque si on ne fait rien.** Réel et à deux étages.

- *Distribution.* `--channels` sans flag `dangerously` n'accepte que l'allowlist `claude-plugins-official`. Aucun chemin public n'y mène : le formulaire in-app va au community marketplace, hors allowlist. La seule voie documentée est un contact partenaire Anthropic. En Team/Enterprise, un Owner doit en plus activer `channelsEnabled`. Un solo Pro/Max échappe au verrou org mais **pas** au verrou plugin : il devra toujours accepter l'écran d'avertissement plein écran. La formulation « aucun utilisateur ne peut la lancer » d'une fiche brute est donc trop absolue — la bonne formulation est : personne ne peut la lancer sans flag `dangerously`, et les orgs sont bloquées par défaut en plus.
- *Portabilité.* Les channels exigent une auth Anthropic et sont indisponibles sur Bedrock, Google Cloud Agent Platform et Microsoft Foundry. Pour un déploiement entreprise multi-cloud, c'est une restriction **plus dure que l'allowlist** : elle ne se lève par aucune décision d'admin. Toute la surface push « Claude Code » de mcp-coordinator est structurellement inaccessible à ces déploiements.
- *Contrat mouvant.* La doc annonce que « the `--channels` flag syntax and protocol contract may change ». Chaque ligne de doc du repo qui grave la syntaxe actuelle est une dette à réviser.

## 5. Points d'intégration dans le repo

Tous les chemins et numéros de ligne ci-dessous ont été lus dans le repo à la date de la fiche (`mcp-coordinator@2.0.1`).

| Fichier / module | Impact |
|---|---|
| `cli/channel.ts` l. 311-318 | Déclare `capabilities: { experimental: { "claude/channel": {}, tools: {} }, tools: {} }`. La sous-clé **`experimental.tools` n'existe pas dans le contrat officiel** — le commentaire du code l'assume comme « déclaration symbolique ». À confronter à la doc : soit c'est inoffensif, soit c'est du bruit à retirer. `instructions` est bien passée, conforme. |
| `cli/channel.ts` l. 67-144 (`buildChannelNotification`) | Construit `meta` à la main pour 3 types d'événements. Les 6 clés émises sont des identifiants valides, mais **aucune normalisation ni validation** n'existe. Point d'insertion d'un helper `assertIdentifierKeys()` qui échoue bruyamment plutôt que de laisser Claude Code dropper en silence. Note secondaire : les valeurs peuvent être des chaînes vides (`strField` l. 147-150) — comportement de l'hôte sur un attribut vide *(non vérifiable — ni `channels` ni `channels-reference` ne spécifient le rendu d'une valeur d'attribut vide ; seule la forme des **clés** est contrainte)*. |
| `cli/channel.ts` l. 458-472 | Émet `notifications/claude/channel` avec `params` = `{content, meta}` — conforme au contrat. Fire-and-forget, cohérent avec « aucun ACK ». |
| `cli/channel.ts` l. 5 (commentaire d'en-tête) | Dit que Claude Code spawne le serveur « when the user passes `--channels mcp-coordinator` ». **Syntaxe invalide** : le contrat impose `server:<nom>` ou `plugin:<nom>@<marketplace>`. Commentaire à corriger. |
| `cli/channel.ts` l. 239-242 (`POST_TO_THREAD_TOOL_DESCRIPTION`) et l. 158 (`INSTRUCTIONS`) | Annoncent au modèle un attribut `event_type="consultation_opened"`, alors que le code émet `event_type: "consultation_new"` (l. 97). La chaîne d'instructions gère l'ambiguïté par un « a.k.a. » ; la description d'outil, non. Un seul nom doit survivre. |
| `cli/channel.ts` l. 298-320 + `capabilities.experimental` | Point d'ajout de `'claude/channel/permission': {}` et des deux handlers de notification, **si** Phase 3 est un jour dégelée. Nécessite d'abord un gating par identité d'expéditeur, absent du modèle MQTT-loopback. |
| `examples/channels-quickstart/.mcp.json.sample` | La clé du serveur est `coordinator-channel`. |
| `examples/channels-quickstart/README.md` l. 80-86 | Lance `claude --dangerously-load-development-channels server:mcp-coordinator-channel` et affirme que cet argument « matches the MCP server name in `.mcp.json` ». **Il ne correspond pas** au `.mcp.json.sample` du même dossier (`coordinator-channel`). Le quickstart ne peut pas fonctionner tel quel. |
| `examples/channels-quickstart/README.md` l. 109 | Montre le tag injecté sous la forme `<channel name="coordinator-channel">`. L'attribut officiel est **`source`**, pas `name`. |
| `docs/operating-modes.md` l. 108 | Montre `<channel source="mcp-coordinator" event_type="consultation_opened" …>` — nom d'attribut `source` correct, mais **valeur** et `event_type` tous deux faux. La doc tranche la valeur : `source` est renseigné depuis le nom d'enregistrement du serveur, c'est-à-dire la clé de `.mcp.json` (l'exemple officiel `"webhook": {…}` donne `<channel source="webhook">`), donc `coordinator-channel` ici — ni `mcp-coordinator`, ni `mcp-coordinator-channel` (`serverInfo.name`, l. 299 du code). Contredit le quickstart. |
| `docs/operating-modes.md` l. 11 | Tableau comparatif, ligne « Claude Code version » : **troisième occurrence** du « v2.1.80+ » non sourcé, à corriger en même temps que `README.md` l. 119 et `docs/usage.md` l. 156. |
| `docs/operating-modes.md` l. 12, 100, 141-146 | L. 12 = ligne « Special flag » du tableau ; l. 100 = commande de lancement ; l. 141-146 = section « Caveats », qui mentionne déjà research preview, le flag `dangerously` et l'allowlist. **Manquent** : `channelsEnabled` / `allowedChannelPlugins` (recherche sur tout le repo : **zéro occurrence**), l'auth Anthropic obligatoire, et l'indisponibilité sur Bedrock / Google Cloud Agent Platform / Microsoft Foundry. C'est le trou documentaire le plus coûteux pour un admin d'org. |
| `README.md` l. 114-119 | Ligne de lancement correcte (`server:mcp-coordinator-channel`) mais affirme « Channels-capable Claude Code (**v2.1.80+**) ». Aucune source du bundle ne mentionne v2.1.80 ; le seul numéro documenté est v2.1.211 (assainissement du relais). Claim de version à sourcer ou à retirer. |
| `docs/usage.md` l. 156 | Reprend le même « v2.1.80+ ». Même correction. |
| `cli/doctor.ts` | **Aucune** mention de « channel » (grep insensible à la casse : 0 résultat). Emplacement naturel d'un check « le nom `.mcp.json` correspond-il à ce qu'on documente dans `--channels server:<nom>` ? » — précisément le bug ci-dessus. |
| `tests/unit/cli-channel.test.ts` l. 133-149 | Assert déjà `experimental['claude/channel'] = {}`, `experimental.tools` et `tools` top-level. À étendre : assertion sur la forme des clés `meta`, et décision sur le sort de `experimental.tools`. |
| `tests/integration/channel-smoke.test.ts`, `tests/helpers/channel-test-harness.ts`, `tests/unit/channel-harness-self-test.ts` | Harnais existant qui capture les `notifications/claude/channel` d'un vrai client MCP. Suffisant pour tester le contrat côté serveur ; **ne teste rien** du côté hôte (allowlist, flags, rendu du tag). |
| `docs/superpowers/working/channels-reference-plugins-study.md` | Étude interne des plugins officiels (telegram, discord, imessage, fakechat), antérieure à la doc publique. Contient déjà la matrice de conformité (l. 245-250) et la recommandation de ne déclarer `claude/channel/permission` qu'avec authentification du répondeur (l. 396). À réconcilier avec la doc officielle : c'est la source de vérité *reverse-engineered* qu'on peut maintenant retirer ou marquer comme historique. |
| `docs/index.html`, `CHANGELOG.md`, `SECURITY.md` | Mentionnent les channels. Surfaces à réviser si la syntaxe de lancement ou le statut de disponibilité changent (rappel : `docs/index.html` porte plusieurs langues inline). |

---

## 6. ⚔️ Challenge

> Section à alimenter lors de la session de challenge dédiée à cette fiche.

### 6.1 La question à trancher

> Faut-il empaqueter le channel en **plugin sur un marketplace** (`plugin:<nom>@<marketplace>`) pour viser une entrée `allowedChannelPlugins` chez les admins clients et, à terme, l'allowlist Anthropic via un contact partenaire — ou assumer définitivement l'entrée `server:<nom>` derrière `--dangerously-load-development-channels` et investir l'effort équivalent dans un chemin de push **indépendant de Claude Code** (le bus MQTT existant, ou une inbox), sachant que ni l'un ni l'autre ne débloque Bedrock / Google Cloud Agent Platform / Microsoft Foundry ?

### 6.2 Hypothèse

<Ce qu'on pense avant de tester.>

### 6.3 Protocole de vérification

*Proposition de la veille, pas un résultat. On teste le vrai chemin de code, on ne théorise pas.*

> ⚠️ Non exécutable ici : l'allowlist Anthropic (`--channels` sans flag `dangerously`) et les managed settings `channelsEnabled` / `allowedChannelPlugins` (org Team/Enterprise, rôle Owner requis), ainsi que l'indisponibilité Bedrock / Google Cloud Agent Platform / Microsoft Foundry. Les cinq points ci-dessous restent tous exécutables sur le poste.

- [ ] Lancer une vraie session `claude --dangerously-load-development-channels server:<nom>` avec le `.mcp.json.sample` du quickstart tel quel, publier un événement MQTT, et constater si le channel se charge — cela tranche en une manipulation le désaccord `coordinator-channel` / `mcp-coordinator-channel` entre le sample et son README.
- [ ] Dans la même session, capturer le tag réellement injecté et comparer littéralement à `docs/operating-modes.md` l. 108 et au quickstart l. 109 : `source` ou `name` ? quelle valeur exacte pour `source` (nom du serveur `.mcp.json` ou `serverInfo.name` = `mcp-coordinator-channel`) ?
- [ ] Émettre volontairement une clé `meta` non-identifiant (ex. `target-modules`) et vérifier si c'est l'attribut entier qui disparaît (contrat officiel) ou le tiret qui est retiré (affirmation contredite entre chercheurs, §1). En déduire la forme exacte du garde-fou à ajouter dans `buildChannelNotification`.
- [ ] Retirer `capabilities.experimental.tools` du constructeur et relancer le smoke test : le channel se charge-t-il toujours et `post_to_thread` reste-t-il invocable ? Si oui, c'est du bruit inventé maison à supprimer.
- [ ] Vérifier si `claude --version` de l'environnement de dev satisfait la contrainte réelle, et retrouver d'où vient le « v2.1.80+ » de `README.md` l. 119 et `docs/usage.md` l. 156 — sinon retirer le numéro plutôt que de le laisser non sourcé.

### 6.4 Résultat observé

<Ce qu'on a réellement mesuré/vu. Coller les sorties, pas les paraphraser.>

### 6.5 Contre-arguments

- **Le gain technique est mince.** Le vérificateur est explicite : `cli/channel.ts` est déjà conforme sur l'essentiel (capability, `instructions`, forme des `params`). Le travail réel se réduit à un garde-fou sur les clés `meta` et à un nettoyage de documentation. Vendre ça comme une mise en conformité de fond serait malhonnête.
- **On s'aligne sur une cible mouvante.** La doc prévient elle-même que la syntaxe de `--channels` et le contrat protocolaire peuvent changer. Chaque assertion de test et chaque ligne de doc gravant la syntaxe actuelle devra être révisée. Un contrat *research preview* n'est pas un contrat.
- **Le plafond de distribution ne se lève pas par du code.** Aucun refactor n'ouvre l'allowlist ; la seule voie documentée est relationnelle (contact partenaire Anthropic), et le formulaire public mène à un marketplace hors allowlist. Investir dans l'empaquetage plugin peut n'acheter strictement rien.
- **Le verrou multi-cloud est définitif à notre échelle.** Auth Anthropic obligatoire, indisponible sur Bedrock, Google Cloud Agent Platform et Microsoft Foundry. Pour un projet dont l'argument est la coordination d'agents hétérogènes, faire du channel la surface de push principale, c'est amputer une partie de la cible sans recours.
- **Portabilité hors Claude Code.** `notifications/claude/channel` est un contrat propriétaire. La fiche A04 (`subscriptions/listen`) décrit la voie standard MCP ; renforcer l'investissement channel avant d'avoir tranché A04, c'est risquer d'entretenir deux chemins de push concurrents pour le même événement.
- **Complexité pour l'auto-hébergeur.** Un flag nommé `dangerously`, un écran d'avertissement plein écran, un `.mcp.json` à éditer, un nom de serveur à faire correspondre à la lettre, et un master switch d'org invisible depuis la machine du développeur. Le chemin d'onboarding est déjà le plus fragile du projet — et il est aujourd'hui cassé dans l'exemple officiel (§5).
- **YAGNI sur le relais de permissions.** C'est la partie séduisante, et c'est aussi celle qui exige un gating par identité d'expéditeur qu'un bus MQTT loopback anonyme ne sait pas fournir. Le `HANDOFF.md` l. 65 met déjà en garde contre une re-spike accidentelle « sans demande concrète d'un opérateur ». Aucune demande de ce type n'est arrivée.
- **Un channel mal filtré est un vecteur de prompt injection**, et la doc le dit explicitement. Ajouter des sources d'événements sans allowlist d'expéditeur transforme le bus de coordination en canal d'injection vers toutes les sessions abonnées.

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
| 2026-08-14 | Fiche créée par la veille plateforme. Fusion de 5 fiches brutes (`claude-code-channels-native`, `cc-native-channels-protocol`, `claude-channel-protocol-contract`, `claude-code-channels-contract`, `claude-channels-allowlist-gate`), toutes CONFIRMED. §5 vérifiée ligne à ligne contre le repo à `mcp-coordinator@2.0.1`. |
| 2026-08-14 | Vérification des faits : `--channels server:` non documenté, `source` = clé `.mcp.json`, 3e occurrence v2.1.80. |
